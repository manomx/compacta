import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { CompactionEngine, clone, cleanInput, retainedV2Input } from './engine.mjs';
import { VERSION, COMPACTION_GUIDANCE } from './settings.mjs';
import { WebSocket, WebSocketServer } from 'ws';
const LIMIT = 64 * 1024 * 1024;
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
]);
export function nativeHTTPError(prefix, status, raw) {
  // Keep structured diagnostics, never provider messages that can echo private input.
  let error;
  try {
    error = JSON.parse(raw.toString()).error;
  } catch {}
  const fields = [error?.param, error?.code].filter(
    (value) => typeof value === 'string' && /^[a-zA-Z0-9_.\[\]-]{1,64}$/.test(value),
  );
  return Error([prefix + status, ...fields].join(':'));
}
export function nativeHttpInput(items) {
  // Codex's lightweight websocket history uses input_text for assistant messages;
  // the ordinary HTTP Responses schema requires output_text for that role.
  return items.map((i) =>
    i.role === 'assistant' && Array.isArray(i.content)
      ? {
          ...i,
          content: i.content.map((b) =>
            b.type === 'input_text' ? { ...b, type: 'output_text' } : b,
          ),
        }
      : i,
  );
}
function headersFor(headers, { websocket = false } = {}) {
  const result = {};
  for (const [k, v] of Object.entries(headers))
    if (
      !HOP.has(k.toLowerCase()) &&
      !k.toLowerCase().startsWith('sec-websocket-') &&
      v !== undefined
    )
      result[k] = v;
  result['accept-encoding'] = 'identity';
  if (!websocket) result['content-type'] = 'application/json';
  return result;
}
function targetFor(config, headers) {
  if (config.upstream !== 'auto') return config.upstream.replace(/\/$/, '');
  const bearer = headers.authorization || '';
  return headers['chatgpt-account-id'] || /Bearer eyJ/i.test(bearer)
    ? 'https://chatgpt.com/backend-api/codex'
    : 'https://api.openai.com/v1';
}
function requestRaw(url, { method = 'POST', headers = {}, body, signal, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.request(url, { method, headers, signal }, (res) => resolve({ req, res }));
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(Error('upstream_timeout')));
    req.end(body);
  });
}
async function bounded(stream) {
  const chunks = [];
  let size = 0;
  for await (const c of stream) {
    size += c.length;
    if (size > LIMIT) throw Error('body_too_large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
function decode(buffer, encoding) {
  if (!encoding || encoding === 'identity') return buffer;
  const options = { maxOutputLength: LIMIT };
  if (encoding === 'gzip') return zlib.gunzipSync(buffer, options);
  if (encoding === 'deflate') return zlib.inflateSync(buffer, options);
  if (encoding === 'br') return zlib.brotliDecompressSync(buffer, options);
  if (encoding === 'zstd' && zlib.zstdDecompressSync)
    return zlib.zstdDecompressSync(buffer, options);
  throw Error('unsupported_encoding');
}
export class EventCollector {
  constructor(onEvent) {
    this.pending = '';
    this.items = [];
    this.onEvent = onEvent;
    this.decoder = new TextDecoder();
  }
  push(chunk) {
    this.pending +=
      typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.pending.length > LIMIT) {
      this.pending = '';
      return;
    }
    let i;
    while ((i = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, i).replace(/\r$/, '');
      this.pending = this.pending.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try {
        this.event(JSON.parse(line.slice(5).trim()));
      } catch {}
    }
  }
  event(event) {
    if (event.type === 'response.output_item.done' && event.item)
      this.items[event.output_index ?? this.items.length] = event.item;
    if (event.type === 'response.completed' && event.response) {
      const r = event.response;
      if (!Array.isArray(r.output) || !r.output.length) r.output = this.items.filter(Boolean);
      this.onEvent(r);
    }
  }
}
function fastEvents(output, model) {
  // Empty response id deliberately prevents a made-up server response ID from becoming delta state.
  const response = {
    id: '',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
  };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
  ];
  output.forEach((item, output_index) =>
    events.push(
      { type: 'response.output_item.added', output_index, item },
      { type: 'response.output_item.done', output_index, item },
    ),
  );
  events.push({ type: 'response.completed', response });
  return events.map((e, sequence_number) => ({ ...e, sequence_number }));
}

export async function createGateway(config) {
  await mkdir(config.root, { recursive: true, mode: 0o700 });
  const log = (event, details = {}) => {
    const row = { at: new Date().toISOString(), event, ...details };
    appendFile(join(config.root, 'events.jsonl'), JSON.stringify(row) + '\n', {
      mode: 0o600,
    }).catch(() => {});
    config.onEvent?.(event, details);
  };
  const nativeCalls = new Set();
  const engine = new CompactionEngine({
    ...config,
    log,
    compact: async (body, headers, upstream) => {
      const controller = new AbortController();
      nativeCalls.add(controller);
      let deadline;
      try {
        if (config.transformCompaction) body = await config.transformCompaction(body);
        const { externalHandoff, ...nativeBody } = body;
        body = nativeBody;
        // The external provider has its own deadline. Give the native conversion
        // its full budget after that provider has finished generating the handoff.
        deadline = setTimeout(() => controller.abort(), config.nativeTimeoutMs || 60000);
        deadline.unref();
        body = {
          ...body,
          model: config.compactionModel || body.model,
          instructions: [body.instructions, config.instructions || COMPACTION_GUIDANCE]
            .filter(Boolean)
            .join('\n\n'),
          ...(config.compactionEffort ? { reasoning: { effort: config.compactionEffort } } : {}),
        };
        const nativeHeaders = headersFor(headers);
        for (const k of Object.keys(nativeHeaders))
          if (
            k === 'accept' ||
            k === 'idempotency-key' ||
            k === 'x-client-request-id' ||
            k === 'x-request-id' ||
            k.startsWith('x-openai-internal-codex') ||
            k.startsWith('x-codex-turn-')
          )
            delete nativeHeaders[k];
        // Each background call is a separate stateless request. Do not compete with the
        // foreground chat's server-side lane or overwrite a proxy's remembered model.
        const maintenanceId = randomUUID();
        for (const k of ['session_id', 'session-id', 'thread-id', 'x-codex-thread-id'])
          if (nativeHeaders[k]) nativeHeaders[k] = maintenanceId;
        config.onNativeRequest?.({
          model: body.model,
          effort: body.reasoning?.effort,
          inputItems: body.input.length,
        });
        const chatgpt = upstream.includes('/backend-api/codex');
        if (!chatgpt && !config.compactionEffort) {
          const { res } = await requestRaw(upstream + '/responses/compact', {
            headers: nativeHeaders,
            body: JSON.stringify({ ...body, input: nativeHttpInput(body.input) }),
            timeout: 60000,
            signal: controller.signal,
          });
          const raw = await bounded(res);
          if (res.statusCode === 200) {
            try {
              const result = JSON.parse(decode(raw, res.headers['content-encoding']).toString());
              config.onNativeResponse?.({
                id: result.id,
                model: result.model || body.model,
                usage: result.usage,
              });
              return { ...result, ...(externalHandoff ? { externalHandoff } : {}) };
            } catch {
              throw Error('invalid_compact_json');
            }
          }
          if (res.statusCode !== 404 && res.statusCode !== 405) {
            config.onNativeError?.({
              status: res.statusCode,
              body: raw.toString().slice(0, 1800),
              headerNames: Object.keys(headers),
            });
            throw nativeHTTPError('compact_http_', res.statusCode, raw);
          }
        }
        // ChatGPT sign-in uses the same native v2 trigger as the Codex client, not the API-key
        // standalone endpoint. No separate account or third-party compaction service is needed.
        const compactInput = nativeHttpInput(body.input);
        // Close the completed assistant/tool input with a compaction instruction,
        // never an invented user request. Otherwise v2 can omit the last answer.
        // This private developer item is not returned in the client's history.
        if (compactInput.at(-1)?.role !== 'user')
          compactInput.push({
            type: 'message',
            role: 'developer',
            content: [
              {
                type: 'input_text',
                text: 'The preceding assistant and tool items are complete evidence for this context compaction. Preserve them with the original user request unchanged.',
              },
            ],
          });
        const payload = {
          ...body,
          instructions: body.instructions || '',
          input: [...compactInput, { type: 'compaction_trigger' }],
          stream: true,
          store: false,
          tools: [],
          tool_choice: 'auto',
          parallel_tool_calls: false,
          include: ['reasoning.encrypted_content'],
        };
        const { res } = await requestRaw(upstream + '/responses', {
          headers: nativeHeaders,
          body: JSON.stringify(payload),
          timeout: 60000,
          signal: controller.signal,
        });
        const raw = decode(await bounded(res), res.headers['content-encoding']);
        if (res.statusCode !== 200) {
          config.onNativeError?.({
            status: res.statusCode,
            body: raw.toString().slice(0, 1800),
            headerNames: Object.keys(headers),
          });
          throw nativeHTTPError('compact_v2_http_', res.statusCode, raw);
        }
        let completed;
        const collector = new EventCollector((r) => (completed = r));
        collector.push(raw);
        if (!completed) {
          config.onNativeError?.({ status: 200, body: raw.toString().slice(-1800) });
          throw Error('native_v2_incomplete');
        }
        config.onNativeResponse?.({
          id: completed.id,
          model: completed.model,
          reasoning: completed.reasoning,
          usage: completed.usage,
        });
        return { ...completed, nativeV2: true, ...(externalHandoff ? { externalHandoff } : {}) };
      } finally {
        clearTimeout(deadline);
        nativeCalls.delete(controller);
      }
    },
  });
  await engine.init();
  const foregroundCompact = async (plan, body, headers, upstream, v2 = true) => {
    const start = performance.now();
    try {
      const response = await engine.compact(
        { model: body.model, instructions: body.instructions, input: cleanInput(plan.body.input) },
        headers,
        upstream,
      );
      if (
        response.status === 'failed' ||
        response.status === 'incomplete' ||
        !response.output?.some((i) => i.type === 'compaction' && i.encrypted_content)
      )
        throw Error('native_compaction_failed');
      if (response.externalHandoff && v2) {
        const thread =
          headers['thread-id'] ||
          headers.session_id ||
          headers['session-id'] ||
          headers['x-codex-thread-id'];
        if (!thread || response.output.length !== 1)
          throw Error('external_handoff_cannot_be_preserved');
        const source = cleanInput(plan.body.input);
        await engine.saveTail(
          engine.tailScope(thread, upstream),
          plan.key,
          source,
          source.length,
          response.output[0],
          [response.externalHandoff],
        );
      }
      log('foreground_compaction_ready', {
        key: plan.key,
        model: config.compactionModel || body.model,
        effort: config.compactionEffort,
        milliseconds: Math.round(performance.now() - start),
        usedPreparedPrefix: !!plan.applied,
      });
      return response.nativeV2 && !v2
        ? [
            ...clone(retainedV2Input(plan.body.input)),
            ...response.output,
            ...(response.externalHandoff ? [response.externalHandoff] : []),
          ]
        : response.output;
    } catch (error) {
      log('foreground_compaction_failed', {
        key: plan.key,
        reason: String(error.code || error.message || 'error').slice(0, 90),
        fallback: 'original_provider',
      });
      return null;
    }
  };
  const prefix = '/' + config.capability + '/v1';
  function route(rawUrl) {
    const url = new URL(rawUrl, 'http://127.0.0.1');
    if (!url.pathname.startsWith(prefix + '/')) return null;
    const suffix = url.pathname.slice(prefix.length);
    if (!/^\/(responses(?:\/[^?#]*)?|models(?:\/[^?#]*)?|rapid\/status)$/.test(suffix)) return null;
    return { suffix, query: url.search };
  }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          app: 'codex-compactacion-anticipada',
          version: VERSION,
          pid: process.pid,
          instance: config.instance,
        }),
      );
      return;
    }
    const r = route(req.url);
    if (!r) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (r.suffix === '/rapid/status') {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(engine.status()));
      return;
    }
    const upstream = targetFor(config, req.headers);
    const started = performance.now();
    let body = null,
      plan = null,
      upstreamRequest;
    try {
      const originalBytes = await bounded(req);
      let outgoing = originalBytes;
      if (
        req.method === 'POST' &&
        (r.suffix === '/responses' || r.suffix === '/responses/compact')
      ) {
        try {
          body = JSON.parse(decode(originalBytes, req.headers['content-encoding']).toString());
        } catch {
          body = null;
          log('inspection_skipped', { reason: 'unknown_request_format' });
        }
        if (body) {
          const v2 = body.input?.some?.((x) => x.type === 'compaction_trigger');
          const isCompact = v2 || r.suffix === '/responses/compact';
          plan = await engine.plan(body, req.headers, upstream, { isCompact, v2 });
          config.onPlan?.({ body, plan, headers: req.headers, transport: 'http' });
          if (
            plan.fastOutput ||
            (isCompact &&
              !plan.preparationAttempted &&
              config.compactionEffort &&
              config.enabled !== false)
          ) {
            const output =
              plan.fastOutput || (await foregroundCompact(plan, body, req.headers, upstream, v2));
            if (output) {
              if (v2) {
                const events = fastEvents(output, body.model);
                if (body.stream === false) {
                  res.writeHead(200, { 'content-type': 'application/json' });
                  res.end(JSON.stringify(events.at(-1).response));
                } else {
                  res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                  });
                  res.end(
                    events
                      .map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n')
                      .join(''),
                  );
                }
              } else {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ output }));
              }
              if (plan.fastOutput)
                log('fast_compaction_sent', {
                  key: plan.key,
                  milliseconds: Math.round((performance.now() - started) * 100) / 100,
                  transport: 'http',
                });
              return;
            }
          }
          outgoing = Buffer.from(JSON.stringify(plan.body));
          plan.isCompact = isCompact;
        }
      }
      const h = headersFor(req.headers);
      if (!body && req.headers['content-encoding'])
        h['content-encoding'] = req.headers['content-encoding'];
      if (outgoing.length) h['content-length'] = outgoing.length;
      const result = await requestRaw(upstream + r.suffix + r.query, {
        method: req.method,
        headers: h,
        body: outgoing.length ? outgoing : undefined,
      });
      upstreamRequest = result.req;
      const remote = result.res;
      const responseHeaders = {};
      for (const [k, v] of Object.entries(remote.headers))
        if (!['connection', 'transfer-encoding', 'keep-alive'].includes(k)) responseHeaders[k] = v;
      res.writeHead(remote.statusCode, responseHeaders);
      res.on('close', () => {
        if (!res.writableFinished) remote.destroy();
      });
      let jsonChunks = [],
        jsonSize = 0;
      const observe = (response) => {
        config.onInferenceResponse?.(response);
        if (plan && !plan.isCompact)
          engine.observe(plan, response, req.headers, upstream, body).catch(() => {});
      };
      const collector = plan && !plan.isCompact ? new EventCollector(observe) : null;
      const contentType = String(remote.headers['content-type'] || '');
      // Some compatible relays return SSE as text/plain. Honor the requested
      // stream unless the server explicitly declares a JSON response.
      const isSSE =
        contentType.includes('text/event-stream') ||
        (body?.stream === true && !contentType.includes('application/json'));
      const encoding = String(remote.headers['content-encoding'] || 'identity').toLowerCase();
      const encoded = encoding !== 'identity';
      remote.on('data', (chunk) => {
        if (!res.write(chunk)) remote.pause();
        if (remote.statusCode === 200 && collector) {
          if (isSSE && !encoded) collector.push(chunk);
          else if (jsonSize <= LIMIT) {
            jsonSize += chunk.length;
            if (jsonSize <= LIMIT) jsonChunks.push(chunk);
            else jsonChunks = [];
          }
        }
      });
      res.on('drain', () => remote.resume());
      remote.on('end', () => {
        // Observe a decoded copy, while forwarding the exact upstream bytes and
        // encoding headers. Native HTTP can return compressed SSE or explicitly
        // mark an uncompressed response as identity even when requested otherwise.
        if (remote.statusCode === 200 && collector && (!isSSE || encoded) && jsonSize <= LIMIT) {
          try {
            const raw = decode(Buffer.concat(jsonChunks), encoding);
            if (isSSE) collector.push(raw);
            else observe(JSON.parse(raw.toString()));
          } catch {
            log('inspection_skipped', {
              reason: 'response_decode_failed',
              encoding,
              contentType: contentType.slice(0, 120),
            });
          }
        }
        res.end();
      });
      remote.on('error', () => res.destroy());
    } catch (error) {
      log('request_failed', {
        kind: ['body_too_large', 'unsupported_encoding', 'upstream_timeout'].includes(error.message)
          ? error.message
          : 'transport_or_parse_error',
        code: String(error.code || error.name || 'error').slice(0, 40),
        encoding: req.headers['content-encoding'] || 'none',
      });
      upstreamRequest?.destroy();
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message:
                'El puente local no pudo completar la solicitud. Reintenta; el historial original sigue en Codex.',
              type: 'api_error',
              code: 'local_gateway_error',
            },
          }),
        );
      } else res.destroy();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMIT, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const r = route(req.url);
    if (!r || r.suffix !== '/responses') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const upstream = targetFor(config, req.headers);
    const url = (upstream + r.suffix + r.query).replace(/^http/, 'ws');
    const remote = new WebSocket(url, {
      headers: headersFor(req.headers, { websocket: true }),
      maxPayload: LIMIT,
      perMessageDeflate: false,
    });
    let upgraded = false;
    // Preserve an upstream HTTP rejection before accepting the client's upgrade. Otherwise
    // Codex sees a broken established socket and retries repeatedly before its HTTP fallback.
    remote.once('unexpected-response', (_request, response) => {
      if (!upgraded) {
        response.resume();
        socket.end(
          'HTTP/1.1 ' +
            response.statusCode +
            ' WebSocket unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
      }
    });
    remote.on('error', () => {
      if (!upgraded && !socket.destroyed)
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    socket.on('close', () => {
      if (!upgraded) remote.terminate();
    });
    socket.on('error', () => remote.terminate());
    remote.once('open', () => {
      if (socket.destroyed) {
        remote.terminate();
        return;
      }
      upgraded = true;
      wss.handleUpgrade(req, socket, head, (client) => {
        let current = null,
          queue = [],
          chain = Promise.resolve();
        const sendRemote = (text) => {
          if (remote.readyState === WebSocket.OPEN) remote.send(text);
          else if (remote.readyState === WebSocket.CONNECTING && queue.length < 64)
            queue.push(text);
          else client.close(1013, 'Upstream unavailable');
        };
        remote.on('open', () => {
          for (const text of queue) remote.send(text);
          queue = [];
        });
        const collector = new EventCollector((response) => {
          config.onInferenceResponse?.(response);
          if (current && !current.plan.isCompact)
            engine
              .observe(current.plan, response, req.headers, upstream, current.body)
              .catch(() => {});
        });
        client.on('message', (data) => {
          chain = chain
            .then(async () => {
              let body;
              try {
                body = JSON.parse(data.toString());
              } catch {
                sendRemote(data);
                return;
              }
              if (body.type !== 'response.create') {
                sendRemote(data);
                return;
              }
              const v2 = body.input?.some?.((x) => x.type === 'compaction_trigger');
              const started = performance.now();
              const plan = await engine.plan(body, req.headers, upstream, { isCompact: v2, v2 });
              plan.isCompact = v2;
              current = { body, plan };
              collector.items = [];
              config.onPlan?.({ body, plan, headers: req.headers, transport: 'websocket' });
              if (
                plan.fastOutput ||
                (v2 &&
                  !plan.preparationAttempted &&
                  config.compactionEffort &&
                  config.enabled !== false)
              ) {
                const output =
                  plan.fastOutput || (await foregroundCompact(plan, body, req.headers, upstream));
                if (output) {
                  for (const e of fastEvents(output, body.model)) client.send(JSON.stringify(e));
                  if (plan.fastOutput)
                    log('fast_compaction_sent', {
                      key: plan.key,
                      milliseconds: Math.round((performance.now() - started) * 100) / 100,
                      transport: 'websocket',
                    });
                  return;
                }
              }
              sendRemote(JSON.stringify(plan.body));
            })
            .catch(() => client.close(1011, 'Local gateway error'));
        });
        remote.on('message', (data) => {
          try {
            collector.event(JSON.parse(data.toString()));
          } catch {}
          if (client.readyState === WebSocket.OPEN) client.send(data.toString());
        });
        remote.on('unexpected-response', (_request, response) => {
          log('websocket_upstream_rejected', { status: response.statusCode });
          response.resume();
          client.close(1013, 'Use HTTP fallback');
        });
        remote.on('error', () => {
          log('websocket_upstream_error');
          client.close(1013, 'Use HTTP fallback');
        });
        remote.on('close', () => {
          if (client.readyState === WebSocket.OPEN) client.close();
        });
        client.on('close', () => {
          if (remote.readyState === WebSocket.OPEN) remote.close();
          else remote.terminate();
        });
        client.on('error', () => remote.terminate());
      });
    });
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(config.port, '127.0.0.1', ok);
  });
  log('service_started', {
    port: server.address().port,
    version: VERSION,
    model: config.compactionModel,
    effort: config.compactionEffort,
    everyStep: config.everyStep,
  });
  return {
    server,
    engine,
    port: server.address().port,
    close: () =>
      new Promise((ok) => {
        engine.stop();
        for (const c of nativeCalls) c.abort();
        wss.clients.forEach((c) => c.terminate());
        wss.close();
        server.close(ok);
        server.closeAllConnections();
      }),
  };
}
