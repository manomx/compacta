import http from 'node:http';
import https from 'node:https';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ConfigStore,
  validateConfig,
  atomicJSON,
  readJSON,
  type Provider,
  type Config,
  guidance,
} from './config';
import { Ledger } from './ledger';
import { Vault } from './vault';
import { Providers } from './providers';
import { Quotas } from './quotas';
import { ClaudeCompactor } from './claude';
import { Integrations } from './integrations';
import { pricing, modelSuggestions } from './prices';
import { createGateway } from './native/server.mjs';
import { codexPolicyHash, externalCodexSummary } from './policy';

async function main() {
  const version = '1.0.6';
  const args = process.argv.slice(2);
  const arg = (n: string) => args[args.indexOf(n) + 1];
  const root = args.includes('--root')
    ? arg('--root')
    : join(homedir(), 'Library/Application Support/Compacta');
  const home = process.env.COMPACTA_TEST_HOME || homedir();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const cfg = new ConfigStore(root);
  await cfg.init();
  const ledger = new Ledger(root);
  const integrations = new Integrations(root, home);
  await integrations.init();
  const oldRuntime = await readJSON(join(root, 'runtime.json'));
  const capability = oldRuntime?.capability || randomBytes(24).toString('hex'),
    adminToken = oldRuntime?.adminToken || randomBytes(32).toString('hex');
  const vault = new Vault(
    args.includes('--vault') ? arg('--vault') : join(dirname(process.execPath), 'compacta-vault'),
    home,
  );
  const providers = new Providers(vault, ledger),
    quotas = new Quotas(vault);
  const providerFor = (id: string) => {
    const p = cfg.value.providers.find((p) => p.id === id);
    if (!p) throw Error('No se encontró el proveedor.');
    return p;
  };
  const defaultCodex = () =>
    cfg.value.providers.find((p) => p.auth === 'codex') || cfg.value.providers[0];
  const canSpend = () =>
    cfg.value.dailyBudget === 0 ||
    Number(
      (
        ledger.db
          .query("SELECT COALESCE(SUM(cost),0) cost FROM usage WHERE kind='compaction' AND at>=?")
          .get(new Date(new Date().setHours(0, 0, 0, 0)).toISOString()) as any
      )?.cost || 0,
    ) < cfg.value.dailyBudget;
  const nativeRoot = join(root, 'codex');
  await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
  if (!oldRuntime) await integrations.importLegacyCache(nativeRoot);
  const codexUpstream = await integrations.codexUpstream(),
    claudeUpstream = await integrations.claudeUpstream();
  const nativeConfig: any = {
    ...cfg.value.codex,
    root: nativeRoot,
    tailRoot: join(nativeRoot, 'tails'),
    port: oldRuntime?.codexPort || 0,
    capability,
    instance: randomUUID(),
    upstream: codexUpstream,
    enabled: cfg.value.codex.enabled && !cfg.value.paused,
    everyStep: cfg.value.codex.mode === 'continuous',
    compactionModel: cfg.value.codex.model,
    compactionEffort: cfg.value.codex.effort,
    maxConcurrent: cfg.value.codex.maxConcurrent,
    maxPerSession: 1,
    thresholdTokens: Math.round(
      (cfg.value.codex.contextWindow * cfg.value.codex.thresholdPercent) / 100,
    ),
    minDeltaChars: cfg.value.codex.minDeltaTokens * 4,
    cooldownMs: cfg.value.codex.cooldownSeconds * 1000,
    onInferenceResponse: (r: any) =>
      ledger.record({
        id: r.id || randomUUID(),
        client: 'codex',
        kind: 'conversation',
        provider: pricing(defaultCodex(), r.model || ''),
        model: r.model || '',
        usage: r.usage,
      }),
    onNativeResponse: (r: any) =>
      ledger.record({
        id: r.id || randomUUID(),
        client: 'codex',
        kind: 'compaction',
        provider: pricing(defaultCodex(), r.model || nativeConfig.compactionModel),
        model: r.model || nativeConfig.compactionModel,
        usage: r.usage,
      }),
    onEvent: (event: string, d: any) => {
      const chat = d.threadId || d.key?.slice(0, 8) || '';
      if (event === 'prepare_started')
        ledger.event(
          'codex',
          'Luna preparando',
          `${chat} · ${['tool_results', 'inflight_step'].includes(d.reason) ? 'avance durante la respuesta' : d.reason === 'compaction_pending' ? 'pendiente al compactar' : 'respuesta terminada'} · ${d.incremental ? 'actualización del resumen' : 'resumen inicial'}`,
        );
      if (event === 'prepare_ready')
        ledger.event(
          'codex',
          'Resumen preparado',
          `${chat} · ${d.coveredTurns ? 'respuestas completas: ' + d.coveredTurns : 'avance de la respuesta actual'} · ${d.nativeMs} ms`,
        );
      if (event === 'compaction_wait_started')
        ledger.event(
          'codex',
          'Esperando lo pendiente',
          `${chat} · ${d.pendingItems} elementos por incorporar`,
        );
      if (event === 'fast_compaction_sent')
        ledger.event('codex', 'Compactación aplicada', `${chat} · ${d.milliseconds} ms`);
      if (event === 'checkpoint_mismatch')
        ledger.event(
          'codex',
          'Cambio de historial identificado',
          `${chat} · ${d.reason} · elemento ${d.index ?? '?'} · ${(d.fields || []).join(', ')}`,
          'warning',
        );
      if (event === 'prepare_failed')
        ledger.event('codex', 'Preparación pendiente de reintento', d.reason, 'warning');
    },
    transformCompaction: async (body: any) => {
      const p = providerFor(cfg.value.codex.providerID);
      if (p.auth === 'codex') return body;
      return externalCodexSummary(body, (items) =>
        providers.summarize(p, cfg.value.codex, items, 'codex'),
      );
    },
  };
  // A custom summarizer still needs a native Codex envelope. Keep this explicit in usage.
  if (providerFor(cfg.value.codex.providerID).auth !== 'codex')
    nativeConfig.compactionModel = defaultCodex().model;
  const gateway = await createGateway(nativeConfig);
  const claude = new ClaudeCompactor(
    join(root, 'claude-cache'),
    providers,
    ledger,
    { ...cfg.value.claude, enabled: cfg.value.claude.enabled && !cfg.value.paused },
    providerFor(cfg.value.claude.providerID),
    canSpend,
  );
  function configure() {
    const p = cfg.value.codex;
    const selected = providerFor(p.providerID);
    Object.assign(nativeConfig, {
      enabled: p.enabled && !cfg.value.paused && canSpend(),
      everyStep: p.mode === 'continuous',
      compactionModel: selected.auth === 'codex' ? p.model : defaultCodex().model,
      compactionEffort: p.effort,
      instructions: p.instructions,
      maxConcurrent: p.maxConcurrent,
      maxPerSession: 1,
      thresholdTokens: Math.round((p.contextWindow * p.thresholdPercent) / 100),
      minDeltaChars: p.minDeltaTokens * 4,
      cooldownMs: p.cooldownSeconds * 1000,
    });
    const engine: any = gateway.engine;
    const newPolicy = codexPolicyHash(p, selected, nativeConfig.compactionModel);
    if (engine.policy !== newPolicy) {
      engine.policy = newPolicy;
      for (const s of engine.sessions.values()) {
        s.ready = null;
        if (s.pending) {
          s.pending.resolve();
          s.pending = null;
        }
      }
    }
    for (const key of [
      'enabled',
      'everyStep',
      'compactionModel',
      'compactionEffort',
      'maxConcurrent',
      'maxPerSession',
      'thresholdTokens',
      'minDeltaChars',
      'cooldownMs',
    ])
      engine[key] = nativeConfig[key];
    if (!engine.enabled)
      for (const s of engine.sessions.values()) {
        s.pending?.resolve();
        s.pending = null;
      }
    engine.drain();
    claude.configure(
      { ...cfg.value.claude, enabled: cfg.value.claude.enabled && !cfg.value.paused },
      providerFor(cfg.value.claude.providerID),
    );
  }
  // Keep inherited compatible checkpoints on first launch; later policy changes invalidate them.
  configure();
  const json = (res: http.ServerResponse, value: any, status = 200) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  };
  function authorized(req: http.IncomingMessage) {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    return (
      token.length === adminToken.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(adminToken)) &&
      !req.headers.origin
    );
  }
  async function bytes(req: http.IncomingMessage, max = 32 * 1024 * 1024) {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += c.length;
      if (size > max) throw Error('La solicitud es demasiado grande.');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  const nativeURL = () => `http://127.0.0.1:${gateway.port}/${capability}/v1`;
  let port = oldRuntime?.port || 0;
  const publicURL = () => `http://127.0.0.1:${port}/${capability}`;
  async function activate(codex: boolean, anthropic: boolean) {
    const errors: string[] = [];
    try {
      if (codex)
        await integrations.activateCodex(publicURL() + '/codex/v1', {
          port: gateway.port,
          capability,
          instance: nativeConfig.instance,
          version,
        });
      else await integrations.deactivateCodex();
    } catch (e: any) {
      errors.push('Codex: ' + e.message);
    }
    try {
      if (anthropic) await integrations.activateClaude(publicURL() + '/claude');
      else await integrations.deactivateClaude();
    } catch (e: any) {
      errors.push('Claude Code: ' + e.message);
    }
    await cfg.save({
      ...cfg.value,
      onboarded: true,
      codex: { ...cfg.value.codex, enabled: integrations.records.codex.active },
      claude: { ...cfg.value.claude, enabled: integrations.records.claude.active },
    });
    configure();
    ledger.event(
      'system',
      'Integraciones actualizadas',
      errors.join(' · '),
      errors.length ? 'warning' : 'info',
    );
    return { ok: !errors.length, errors };
  }
  async function snapshot(days = 1) {
    return {
      version,
      config: cfg.value,
      integration: await integrations.detect(),
      codex: gateway.engine.status(),
      claude: claude.status(),
      quotas: quotas.values,
      usage: ledger.totals(days),
      events: ledger.events(),
      budgetReached: !canSpend(),
      updatedAt: new Date().toISOString(),
      modelSuggestions,
    };
  }
  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    body?: Buffer,
    onData?: (data: Buffer) => void,
    onEnd?: () => void,
  ) {
    const headers: any = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    delete headers['accept-encoding'];
    if (body) headers['content-length'] = body.length;
    const transport = url.startsWith('https:') ? https : http;
    const remote = transport.request(url, { method: req.method, headers }, (response) => {
      const h: any = { ...response.headers };
      delete h.connection;
      delete h['transfer-encoding'];
      res.writeHead(response.statusCode || 502, h);
      response.on('data', (data) => {
        onData?.(data);
        if (!res.write(data)) response.pause();
      });
      res.on('drain', () => response.resume());
      response.on('end', () => {
        onEnd?.();
        res.end();
      });
      response.on('error', () => res.destroy());
      res.on('close', () => {
        if (!res.writableFinished) response.destroy();
      });
    });
    remote.setTimeout(300000, () => remote.destroy());
    remote.on('error', () => {
      if (!res.headersSent)
        json(
          res,
          { error: { message: 'No se pudo conectar con el proveedor. Reintenta la solicitud.' } },
          502,
        );
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableFinished) remote.destroy();
    });
    if (body !== undefined) remote.end(body);
    else req.pipe(remote);
  }
  class ClaudeCollector {
    pending = '';
    decoder = new TextDecoder();
    message: any = null;
    blocks: any[] = [];
    partial = new Map<number, string>();
    done = false;
    constructor(public complete: (r: any) => void) {}
    push(chunk: Buffer) {
      this.pending += this.decoder.decode(chunk, { stream: true });
      let i;
      while ((i = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, i);
        this.pending = this.pending.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let e: any;
        try {
          e = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (e.type === 'message_start') this.message = e.message;
        if (e.type === 'content_block_start') this.blocks[e.index] = e.content_block;
        if (e.type === 'content_block_delta') {
          const b = this.blocks[e.index];
          if (e.delta?.text && b) b.text = (b.text || '') + e.delta.text;
          if (e.delta?.partial_json)
            this.partial.set(e.index, (this.partial.get(e.index) || '') + e.delta.partial_json);
        }
        if (e.type === 'content_block_stop' && this.partial.has(e.index)) {
          try {
            this.blocks[e.index].input = JSON.parse(this.partial.get(e.index)!);
          } catch {}
        }
        if (e.type === 'message_delta' && this.message) {
          this.message.usage = { ...this.message.usage, ...e.usage };
          this.message.stop_reason = e.delta?.stop_reason;
        }
        if (e.type === 'message_stop' && this.message) {
          this.done = true;
          this.complete({ ...this.message, content: this.blocks.filter(Boolean) });
        }
      }
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://localhost');
      if (u.pathname === '/healthz') return json(res, { app: 'compacta', version });
      if (u.pathname.startsWith('/api/')) {
        if (!authorized(req)) return json(res, { error: 'Acceso no autorizado.' }, 401);
        const route = u.pathname;
        if (route === '/api/status' && req.method === 'GET')
          return json(
            res,
            await snapshot(Math.min(365, Math.max(1, Number(u.searchParams.get('days')) || 1))),
          );
        if (route === '/api/usage/export' && req.method === 'GET')
          return json(res, ledger.export());
        if (req.method !== 'POST') return json(res, { error: 'Método no permitido.' }, 405);
        const payload = JSON.parse((await bytes(req, 512000)).toString() || '{}');
        if (route === '/api/settings') {
          const valid = validateConfig(payload);
          await cfg.save(valid);
          configure();
          ledger.prune(valid.retentionDays);
          ledger.event('system', 'Ajustes guardados');
          return json(res, await snapshot());
        }
        if (route === '/api/integrations')
          return json(res, {
            ...(await activate(!!payload.codex, !!payload.claude)),
            snapshot: await snapshot(),
          });
        if (route === '/api/pause') {
          await cfg.save({ ...cfg.value, paused: !!payload.paused });
          configure();
          ledger.event(
            'system',
            payload.paused ? 'Compactación en pausa' : 'Compactación reanudada',
          );
          return json(res, await snapshot());
        }
        if (route === '/api/credentials') {
          if (
            !cfg.value.providers.some((p) => p.id === payload.id) ||
            typeof payload.key !== 'string'
          )
            throw Error('Proveedor inválido.');
          if (payload.key) await vault.save(payload.id, payload.key);
          else await vault.remove(payload.id);
          return json(res, { ok: true });
        }
        if (route === '/api/provider/test')
          return json(res, await providers.test(providerFor(payload.id)));
        if (route === '/api/provider/models')
          return json(res, { models: await providers.models(providerFor(payload.id)) });
        if (route === '/api/quotas/refresh') {
          await quotas.refresh(true);
          return json(res, { quotas: quotas.values });
        }
        if (route === '/api/disable-all') {
          const result = await activate(false, false);
          return json(res, result);
        }
        return json(res, { error: 'Operación no encontrada.' }, 404);
      }
      const codexPrefix = `/${capability}/codex/v1`;
      if (u.pathname.startsWith(codexPrefix + '/')) {
        if (
          !/^\/(responses(?:\/[^?#]*)?|models(?:\/[^?#]*)?|rapid\/status)$/.test(
            u.pathname.slice(codexPrefix.length),
          )
        )
          return json(res, { error: 'Ruta no disponible.' }, 404);
        return forward(req, res, nativeURL() + u.pathname.slice(codexPrefix.length) + u.search);
      }
      const claudePrefix = `/${capability}/claude`;
      if (u.pathname.startsWith(claudePrefix + '/')) {
        const suffix = u.pathname.slice(claudePrefix.length);
        if (!/^\/v1\/(messages(?:\/(?:count_tokens|compact))?|models(?:\/[^?#]*)?)$/.test(suffix))
          return json(res, { error: 'Ruta no disponible.' }, 404);
        if (req.method !== 'POST' || suffix !== '/v1/messages')
          return forward(req, res, claudeUpstream + suffix + u.search);
        const data = await bytes(req);
        let original: any;
        try {
          original = JSON.parse(data.toString());
        } catch {
          return forward(req, res, claudeUpstream + suffix + u.search, data);
        }
        const plan = await claude.plan(original, req.headers);
        const started = performance.now();
        let full: Buffer[] = [];
        let fullSize = 0;
        const complete = (r: any) => {
          ledger.record({
            id: r.id || randomUUID(),
            client: 'claude',
            kind: 'conversation',
            provider: pricing(
              cfg.value.providers.find((p) => p.auth === 'claude') ||
                providerFor(cfg.value.claude.providerID),
              r.model || original.model,
            ),
            model: r.model || original.model,
            usage: r.usage,
            latency: performance.now() - started,
          });
          claude.observe(plan.key, original, r);
        };
        const collector = new ClaudeCollector(complete);
        return forward(
          req,
          res,
          claudeUpstream + suffix + u.search,
          Buffer.from(JSON.stringify(plan.body)),
          (chunk) => {
            if (original.stream) collector.push(chunk);
            else if (fullSize < 32 * 1024 * 1024) {
              full.push(chunk);
              fullSize += chunk.length;
            }
          },
          () => {
            if (!original.stream && fullSize < 32 * 1024 * 1024)
              try {
                complete(JSON.parse(Buffer.concat(full).toString()));
              } catch {}
          },
        );
      }
      json(res, { error: 'Ruta no encontrada.' }, 404);
    } catch (e: any) {
      if (!res.headersSent)
        json(res, { error: e.message || 'No se pudo completar la operación.' }, 400);
      else res.destroy();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const prefix = `/${capability}/codex/v1`;
    const u = new URL(req.url || '/', 'http://localhost');
    if (u.pathname !== prefix + '/responses') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const headers: any = { ...req.headers };
    delete headers.host;
    const remote = http.request(nativeURL() + '/responses' + u.search, { headers });
    remote.on('upgrade', (r, peer, rest) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(r.headers)
            .map(([k, v]) => k + ': ' + v)
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (rest.length) socket.write(rest);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
      peer.on('error', () => socket.destroy());
      socket.on('error', () => peer.destroy());
      socket.on('close', () => peer.destroy());
    });
    remote.on('response', (r) => {
      r.resume();
      socket.end(
        `HTTP/1.1 ${r.statusCode} WebSocket unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    });
    remote.on('error', () => socket.destroy());
    remote.end();
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  port = (server.address() as any).port;
  await atomicJSON(join(root, 'runtime.json'), {
    version,
    pid: process.pid,
    port,
    codexPort: gateway.port,
    capability,
    adminToken,
    startedAt: new Date().toISOString(),
  });
  // Refresh a previously adopted stable route after a service restart, preserving its listener.
  if (integrations.records.codex.active && integrations.records.codex.mode === 'legacy') {
    await atomicJSON(join(home, '.codex/compactacion-anticipada/route.json'), {
      port: gateway.port,
      capability,
      instance: nativeConfig.instance,
      version,
      restart: false,
    });
  }
  ledger.event('system', 'Compacta está listo');
  await integrations.reconcileCodexRouting();
  ledger.prune(cfg.value.retentionDays);
  if (!args.includes('--no-quotas')) quotas.refresh().catch(() => {});
  const tick = setInterval(() => {
    if (cfg.value.codex.enabled)
      integrations
        .reconcileCodexRouting()
        .then((changed) => {
          if (changed) ledger.event('codex', 'Conexión de Compacta recuperada');
        })
        .catch((error) =>
          ledger.event(
            'codex',
            'No se pudo recuperar la conexión',
            String(error.message || error),
            'warning',
          ),
        );
    const enabled = cfg.value.codex.enabled && !cfg.value.paused && canSpend();
    gateway.engine.enabled = enabled;
    nativeConfig.enabled = enabled;
    if (!args.includes('--no-quotas'))
      quotas.refresh(false, cfg.value.pollSeconds * 1000).catch(() => {});
  }, 10000);
  tick.unref();
  async function shutdown() {
    clearInterval(tick);
    claude.close();
    server.close();
    await gateway.close();
    ledger.close();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((error) => {
  process.stderr.write(String(error.message || error) + '\n');
  process.exit(1);
});
