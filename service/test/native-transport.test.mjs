import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as zlib from 'node:zlib';
import {
  createGateway,
  EventCollector,
  nativeHttpInput,
  nativeHTTPError,
} from '../native/server.mjs';
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');
test('native rejection identifies the invalid field without logging private provider text', () => {
  assert.equal(
    nativeHTTPError(
      'compact_v2_http_',
      400,
      JSON.stringify({
        error: {
          message: 'private conversation text',
          param: 'reasoning.effort',
          code: 'unsupported_value',
        },
      }),
    ).message,
    'compact_v2_http_400:reasoning.effort:unsupported_value',
  );
  assert.equal(
    nativeHTTPError('compact_v2_http_', 502, '<html>private gateway response</html>').message,
    'compact_v2_http_502',
  );
  assert.equal(
    nativeHTTPError(
      'compact_v2_http_',
      400,
      JSON.stringify({ error: { param: 'private text\nsecret', code: 'bad_request' } }),
    ).message,
    'compact_v2_http_400:bad_request',
  );
});
test('external summarization does not consume the native request deadline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rapid-external-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [{ type: 'compaction', encrypted_content: 'SYNTHETIC' }],
            },
          }) +
          '\n\n',
      );
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(
    () =>
      new Promise((ok) => {
        server.close(ok);
        server.closeAllConnections();
      }),
  );
  const upstream = 'http://127.0.0.1:' + server.address().port + '/v1';
  const handoff = { type: 'message', role: 'assistant', content: 'Exact external evidence' };
  const gateway = await createGateway({
    root,
    port: 0,
    capability: 'test',
    upstream,
    compactionEffort: 'low',
    nativeTimeoutMs: 200,
    transformCompaction: async (body) => {
      await new Promise((ok) => setTimeout(ok, 250));
      return { ...body, externalHandoff: handoff };
    },
  });
  t.after(() => gateway.close());
  const r = await gateway.engine.compact(
    { model: 'test', input: [{ role: 'assistant', content: 'A complete external handoff.' }] },
    {},
    upstream,
  );
  assert.equal(r.output[0].type, 'compaction');
  assert.deepEqual(r.externalHandoff, handoff);
});
test('foreground external compaction persists the literal handoff before returning native output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rapid-external-foreground-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const captured = [];
  const opaque = { type: 'compaction', encrypted_content: 'SYNTHETIC' },
    handoff = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Exact external evidence X731. Pending.' }],
    };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    captured.push(b);
    assert.equal(b.externalHandoff, undefined);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed', output: [opaque] },
        }) +
        '\n\n',
    );
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(
    () =>
      new Promise((ok) => {
        server.close(ok);
        server.closeAllConnections();
      }),
  );
  const gateway = await createGateway({
    root,
    port: 0,
    capability: 'test',
    upstream: 'http://127.0.0.1:' + server.address().port + '/v1',
    compactionEffort: 'low',
    thresholdTokens: 100000,
    transformCompaction: async (body) => ({ ...body, externalHandoff: handoff }),
  });
  t.after(() => gateway.close());
  const input = [{ role: 'user', content: 'Inspect only.' }],
    headers = { 'content-type': 'application/json', session_id: 'external-chat' },
    url = 'http://127.0.0.1:' + gateway.port + '/test/v1/responses';
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'test',
      input: [...input, { type: 'compaction_trigger' }],
      stream: false,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).output, [opaque]);
  await (
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'test',
        input: [...input, opaque, { role: 'user', content: 'Continue' }],
        stream: true,
      }),
    })
  ).text();
  assert.ok(captured.at(-1).input.some((i) => JSON.stringify(i) === JSON.stringify(handoff)));
});
test('UTF8 streaming and output events survive chunk boundaries', () => {
  let result;
  const c = new EventCollector((r) => (result = r));
  const text =
    'data: ' +
    JSON.stringify({
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', content: [{ type: 'output_text', text: 'Corrección académica' }] },
    }) +
    '\n\ndata: ' +
    JSON.stringify({ type: 'response.completed', response: { id: 'r', output: [] } }) +
    '\n\n';
  for (const b of Buffer.from(text)) c.push(Buffer.from([b]));
  assert.equal(result.output[0].content[0].text, 'Corrección académica');
});
test('HTTP and websocket forward real request bodies and require local capability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rapid-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
      return;
    }
    let text = '';
    req.on('data', (d) => (text += d));
    req.on('end', () => {
      const b = JSON.parse(text);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'r',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: b.input[0].content }],
                },
              ],
              usage: { input_tokens: 3, output_tokens: 2 },
            },
          }) +
          '\n\n',
      );
    });
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', (s) => s.on('message', (m) => s.send(m.toString())));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(
    () =>
      new Promise((ok) => {
        ws.clients.forEach((c) => c.terminate());
        ws.close();
        server.close(ok);
        server.closeAllConnections();
      }),
  );
  const gateway = await createGateway({
    root,
    port: 0,
    capability: 'private-test',
    upstream: 'http://127.0.0.1:' + server.address().port + '/v1',
    thresholdTokens: 100000,
  });
  t.after(() => gateway.close());
  const base = 'http://127.0.0.1:' + gateway.port + '/private-test/v1';
  assert.equal((await fetch(base + '/models')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:' + gateway.port + '/wrong/v1/models')).status, 404);
  const response = await fetch(base + '/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', session_id: 'test' },
    body: JSON.stringify({
      model: 'test',
      input: [{ role: 'user', content: 'No publicar' }],
      stream: true,
    }),
  });
  assert.match(await response.text(), /No publicar/);
  await new Promise((ok, fail) => {
    const c = new WebSocket(base.replace('http:', 'ws:') + '/responses');
    c.on('open', () => c.send(JSON.stringify({ type: 'ping', tag: 'exact' })));
    c.on('message', (m) => {
      assert.equal(JSON.parse(m).tag, 'exact');
      c.close();
      ok();
    });
    c.on('error', fail);
  });
});
test('native HTTP format preserves text and roles', () => {
  const items = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'No publicar' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'Pendiente' }] },
  ];
  const converted = nativeHttpInput(items);
  assert.equal(converted[1].content[0].type, 'output_text');
  assert.equal(converted[1].content[0].text, 'Pendiente');
  assert.deepEqual(converted[0], items[0]);
  assert.equal(items[1].content[0].type, 'input_text');
});
for (const [encoding, compress, contentType = 'text/event-stream'] of [
  ['identity', (x) => x],
  ['gzip', zlib.gzipSync],
  ['br', zlib.brotliCompressSync],
  ['deflate', zlib.deflateSync],
  ...(zlib.zstdCompressSync ? [['zstd', zlib.zstdCompressSync]] : []),
  ['identity', (x) => x, 'text/plain'],
  ['gzip', zlib.gzipSync, 'application/octet-stream'],
]) {
  test(
    'HTTP ' +
      encoding +
      ' ' +
      contentType +
      ' SSE preserves wire bytes and prepares the completed answer',
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'rapid-encoded-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      let expected;
      const requests = [];
      const upstreamServer = http.createServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        const body = JSON.parse(raw);
        requests.push(body);
        const compact = body.input.some((i) => i.type === 'compaction_trigger');
        const output = compact
          ? [{ type: 'compaction', encrypted_content: 'SYNTHETIC' }]
          : [
              {
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'Evidence E731; still pending.' }],
              },
            ];
        const bytes = compress(
          Buffer.from(
            'data: ' +
              JSON.stringify({
                type: 'response.completed',
                response: { id: compact ? 'summary' : 'answer', status: 'completed', output },
              }) +
              '\n\n',
          ),
        );
        if (!compact) expected = bytes;
        res.writeHead(200, { 'content-type': contentType, 'content-encoding': encoding });
        res.end(bytes);
      });
      await new Promise((ok) => upstreamServer.listen(0, '127.0.0.1', ok));
      t.after(
        () =>
          new Promise((ok) => {
            upstreamServer.close(ok);
            upstreamServer.closeAllConnections();
          }),
      );
      const gateway = await createGateway({
        root,
        port: 0,
        capability: 'encoded',
        upstream: 'http://127.0.0.1:' + upstreamServer.address().port + '/v1',
        everyStep: true,
        cooldownMs: 0,
        minDeltaChars: 1,
        compactionEffort: 'low',
      });
      t.after(() => gateway.close());
      const body = JSON.stringify({
        model: 'test',
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: 'Inspect and preserve evidence; do not publish.',
          },
        ],
      });
      const received = await new Promise((ok, fail) => {
        const req = http.request(
          'http://127.0.0.1:' + gateway.port + '/encoded/v1/responses',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', session_id: 'encoded-chat' },
          },
          (res) => {
            assert.equal(res.headers['content-encoding'], encoding);
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => ok(Buffer.concat(chunks)));
          },
        );
        req.on('error', fail);
        req.end(body);
      });
      assert.deepEqual(received, expected);
      for (let i = 0; i < 200 && !gateway.engine.status().sessions[0]?.ready; i++)
        await new Promise((r) => setTimeout(r, 5));
      const session = gateway.engine.status().sessions[0];
      assert.equal(session?.ready, true);
      assert.equal(session.completedTurns, 1);
      assert.equal(session.coveredTurns, 1);
      assert.ok(
        requests[1].input.some((i) => i.role === 'assistant' && i.content[0].text.includes('E731')),
      );
    },
  );
}
test('an unsupported upstream websocket is rejected before upgrading the client', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rapid-ws-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = http.createServer();
  server.on('upgrade', (_req, socket) =>
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'),
  );
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(
    () =>
      new Promise((ok) => {
        server.close(ok);
        server.closeAllConnections();
      }),
  );
  const gateway = await createGateway({
    root,
    port: 0,
    capability: 'test',
    upstream: 'http://127.0.0.1:' + server.address().port + '/v1',
  });
  t.after(() => gateway.close());
  await new Promise((ok, fail) => {
    const client = new WebSocket('ws://127.0.0.1:' + gateway.port + '/test/v1/responses');
    client.on('open', () => {
      client.terminate();
      fail(Error('should not upgrade'));
    });
    client.on('unexpected-response', (request, response) => {
      assert.equal(response.statusCode, 426);
      response.resume();
      request.destroy?.();
      ok();
    });
    client.on('error', () => {});
  });
});
test('native v2 fallback preserves auth, removes lite headers and receives a real-shaped compaction item', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rapid-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let captured;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url.endsWith('/responses/compact')) {
        res.writeHead(404);
        res.end();
        return;
      }
      captured = { headers: req.headers, body: JSON.parse(raw) };
      const item = { type: 'compaction', id: 'test', encrypted_content: 'FAKE-FOR-TEST-ONLY' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) +
          '\n\ndata: ' +
          JSON.stringify({
            type: 'response.completed',
            response: { id: 'native', status: 'completed', output: [item] },
          }) +
          '\n\n',
      );
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(
    () =>
      new Promise((ok) => {
        server.close(ok);
        server.closeAllConnections();
      }),
  );
  const upstream = 'http://127.0.0.1:' + server.address().port + '/v1',
    gateway = await createGateway({
      root,
      port: 0,
      capability: 'test',
      upstream,
      thresholdTokens: 1,
      cooldownMs: 0,
    });
  t.after(() => gateway.close());
  const body = {
      model: 'test',
      input: [
        { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'No publicar' }] },
        {
          role: 'assistant',
          type: 'message',
          content: [{ type: 'input_text', text: 'Pendiente' }],
        },
      ],
    },
    headers = {
      session_id: 'test',
      authorization: 'Bearer synthetic',
      'x-openai-internal-codex-responses-lite': 'true',
    };
  const key = gateway.engine.identity(body, headers, upstream),
    s = await gateway.engine.session(key);
  s.lastUsage = 100;
  await gateway.engine.maybePrepare(s, body.input, headers, upstream, body);
  assert.ok(s.ready);
  assert.equal(captured.headers.authorization, 'Bearer synthetic');
  assert.equal(captured.headers['x-openai-internal-codex-responses-lite'], undefined);
  assert.equal(captured.body.input[1].content[0].type, 'output_text');
  assert.equal(captured.body.input.at(-1).type, 'compaction_trigger');
  assert.deepEqual(
    captured.body.input.slice(0, -2),
    nativeHttpInput(body.input),
    'the original conversation must stay unchanged',
  );
  assert.equal(captured.body.input.at(-2).role, 'developer');
  assert.deepEqual(
    captured.body.input.filter((i) => i.role === 'user'),
    nativeHttpInput(body.input).filter((i) => i.role === 'user'),
    'compaction must not invent a user request',
  );
});
test('manual legacy compaction uses Luna low and retains user text; a Luna error falls back to the original route', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rapid-luna-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let failLuna = false;
  const captured = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const b = JSON.parse(raw);
      captured.push({ body: b, headers: req.headers });
      if (failLuna && b.model === 'gpt-6-luna') {
        res.writeHead(502);
        res.end('{}');
        return;
      }
      const item = { type: 'compaction', encrypted_content: 'SYNTHETIC' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: { status: 'completed', output: [item] },
          }) +
          '\n\n',
      );
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(
    () =>
      new Promise((ok) => {
        server.close(ok);
        server.closeAllConnections();
      }),
  );
  const gateway = await createGateway({
    root,
    port: 0,
    capability: 'test',
    upstream: 'http://127.0.0.1:' + server.address().port + '/v1',
    compactionModel: 'gpt-6-luna',
    compactionEffort: 'low',
  });
  t.after(() => gateway.close());
  const base = 'http://127.0.0.1:' + gateway.port + '/test/v1',
    input = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Publicación denegada.' }],
      },
    ];
  const request = (path, session = 'original-chat') =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        session_id: session,
        authorization: 'Bearer synthetic',
      },
      body: JSON.stringify({
        model: 'gpt-6-astra',
        input: path.endsWith('/compact') ? input : [...input, { type: 'compaction_trigger' }],
        stream: true,
      }),
    });
  const result = await (await request('/responses/compact')).json();
  assert.deepEqual(result.output[0], input[0]);
  assert.equal(captured[0].body.model, 'gpt-6-luna');
  assert.equal(captured[0].body.reasoning.effort, 'low');
  assert.notEqual(captured[0].headers.session_id, 'original-chat');
  assert.equal(captured[0].headers.authorization, 'Bearer synthetic');
  failLuna = true;
  const count = captured.length;
  await (await request('/responses')).text();
  assert.equal(captured.length, count, 'ready checkpoint needs no provider call');
  const fallback = await request('/responses', 'failing-chat');
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /compaction/);
  assert.equal(captured.at(-1).body.model, 'gpt-6-astra');
  assert.equal(captured.at(-1).headers.session_id, 'failing-chat');
});
