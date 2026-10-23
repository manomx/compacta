// Stable data path, installed independently of replaceable compaction releases.
// A missing/unhealthy worker routes to the original provider, without editing Codex.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { readFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
export const ROUTER_PROTOCOL = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function createRouter(config) {
  const prefix = '/' + config.capability + '/v1';
  let worker = null,
    signature = '',
    live = false,
    checking = false,
    stopping = false,
    lastRestart = 0;
  const children = new Set(),
    sockets = new Set();
  const log = (event, details = {}) =>
    appendFile(
      join(config.root, 'router.events.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n',
      { mode: 0o600 },
    ).catch(() => {});
  const healthOf = async (w) => {
    try {
      const r = await fetch(`http://127.0.0.1:${w.port}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      const h = await r.json();
      return r.ok && h.instance === w.instance && h.version === w.version ? h : null;
    } catch {
      return null;
    }
  };
  const refresh = async (restart = false) => {
    if (checking || stopping) return;
    checking = true;
    try {
      let text = '';
      try {
        text = await readFile(join(config.root, 'route.json'), 'utf8');
      } catch {}
      if (text !== signature) {
        signature = text;
        const next = text ? JSON.parse(text) : null;
        if (
          next &&
          (!Number.isInteger(next.port) ||
            next.port < 1024 ||
            !next.instance ||
            !next.version ||
            !next.capability)
        )
          throw Error('invalid_route');
        worker = next;
        live = false;
      }
      if (!worker) {
        live = false;
        return;
      }
      const h = await healthOf(worker),
        was = live;
      live = !!h;
      if (live) {
        worker.pid = h.pid;
        if (!was) log('worker_ready', { pid: h.pid, version: h.version });
        return;
      }
      if (was) log('direct_fallback', { reason: 'worker_unavailable' });
      if (restart && worker.restart !== false && Date.now() - lastRestart > 3000) {
        // Every executable/config path must be in the private installation.
        const inside = (p) =>
          typeof p === 'string' && resolve(p).startsWith(resolve(config.root) + '/');
        if (![worker.node, worker.entry, worker.config].every(inside)) return;
        lastRestart = Date.now();
        const fd = fs.openSync(join(config.root, 'worker.err.log'), 'a', 0o600);
        try {
          const child = spawn(worker.node, [worker.entry, worker.config], {
            stdio: ['ignore', 'ignore', fd],
            env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
            detached: true,
          });
          children.add(child);
          child.once('error', () => children.delete(child));
          child.once('exit', () => children.delete(child));
          child.unref();
          log('worker_restart', { pid: child.pid });
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      worker = null;
      live = false;
      log('direct_fallback', { reason: 'invalid_or_missing_route' });
    } finally {
      checking = false;
    }
  };
  await refresh();
  const timer = setInterval(() => refresh(true), 500);
  timer.unref();
  function route(raw) {
    const u = new URL(raw, 'http://127.0.0.1');
    if (!u.pathname.startsWith(prefix + '/')) return null;
    const suffix = u.pathname.slice(prefix.length);
    if (!/^\/(responses(?:\/[^?#]*)?|models(?:\/[^?#]*)?|rapid\/status)$/.test(suffix)) return null;
    return suffix + u.search;
  }
  function direct(req, suffix) {
    const upstream =
      config.upstream === 'auto'
        ? req.headers['chatgpt-account-id'] || /Bearer eyJ/i.test(req.headers.authorization || '')
          ? 'https://chatgpt.com/backend-api/codex'
          : 'https://api.openai.com/v1'
        : config.upstream;
    return upstream.replace(/\/$/, '') + suffix;
  }
  function destination(req, suffix) {
    return live && worker
      ? { url: `http://127.0.0.1:${worker.port}/${worker.capability}/v1${suffix}`, optional: true }
      : { url: direct(req, suffix), optional: false };
  }
  function headers(req, ws = false) {
    const h = { ...req.headers };
    delete h.host;
    delete h['proxy-authorization'];
    delete h['proxy-authenticate'];
    if (!ws) {
      delete h.connection;
      delete h['keep-alive'];
    }
    return h;
  }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      await refresh();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          app: 'codex-compactacion-anticipada',
          protocol: ROUTER_PROTOCOL,
          version: worker?.version || null,
          pid: process.pid,
          mode: live ? 'compact' : 'direct',
          workerPid: live ? worker?.pid : null,
          socketActivation: process.env.RAPID_LISTEN_FD !== undefined,
        }),
      );
      return;
    }
    const suffix = route(req.url);
    if (!suffix) {
      res.writeHead(404);
      res.end();
      return;
    }
    await refresh();
    if (suffix === '/rapid/status' && !live) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          mode: 'direct',
          workerRunning: false,
          prepared: 0,
          activeJobs: 0,
          sessions: [],
        }),
      );
      return;
    }
    let outgoing;
    res.on('close', () => {
      if (!res.writableFinished) outgoing?.destroy();
    });
    const forward = (target) => {
      // Wait until connected before consuming the incoming body. Only a connection
      // failure BEFORE sending any bytes may be transparently retried on upstream.
      let connected = false,
        settled = false;
      const transport = target.url.startsWith('https:') ? https : http;
      outgoing = transport.request(
        target.url,
        { method: req.method, headers: headers(req), agent: false },
        (remote) => {
          settled = true;
          clearTimeout(connectTimer);
          res.writeHead(remote.statusCode, remote.headers);
          remote.pipe(res);
          remote.on('error', () => res.destroy());
        },
      );
      const connectTimer = setTimeout(
        () => {
          if (!connected) outgoing.destroy(Error('connect_timeout'));
        },
        target.optional ? 500 : 10000,
      );
      connectTimer.unref();
      outgoing.on('socket', (socket) => {
        const send = () => {
          connected = true;
          clearTimeout(connectTimer);
          req.pipe(outgoing);
        };
        if (socket.connecting)
          socket.once(target.url.startsWith('https:') ? 'secureConnect' : 'connect', send);
        else send();
      });
      outgoing.on('error', () => {
        clearTimeout(connectTimer);
        if (!connected && !settled && target.optional && !res.destroyed) {
          live = false;
          log('direct_fallback', { reason: 'worker_connect_failed' });
          forward({ url: direct(req, suffix), optional: false });
          return;
        }
        // Never replay a POST that may already have reached the model.
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: 'La solicitud se interrumpió; la siguiente usará la conexión disponible.',
                code: 'request_interrupted',
              },
            }),
          );
        } else res.destroy();
      });
    };
    forward(destination(req, suffix));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  server.on('upgrade', async (req, socket, head) => {
    const suffix = route(req.url);
    if (!suffix || !suffix.startsWith('/responses')) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    await refresh();
    const forward = (target) => {
      let connected = false,
        remoteSocket;
      const transport = target.url.startsWith('https:') ? https : http;
      const outgoing = transport.request(target.url, {
        method: 'GET',
        headers: headers(req, true),
        agent: false,
      });
      const timer = setTimeout(
        () => {
          if (!connected) outgoing.destroy(Error('connect_timeout'));
        },
        target.optional ? 500 : 10000,
      );
      timer.unref();
      outgoing.on('socket', (s) => {
        s.once(target.url.startsWith('https:') ? 'secureConnect' : 'connect', () => {
          connected = true;
          clearTimeout(timer);
        });
      });
      outgoing.on('upgrade', (response, remote, remoteHead) => {
        clearTimeout(timer);
        remoteSocket = remote;
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            Object.entries(response.headers)
              .map(([k, v]) => k + ': ' + v)
              .join('\r\n') +
            '\r\n\r\n',
        );
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket);
        remote.on('error', () => socket.destroy());
        remote.once('close', () => socket.destroy());
      });
      outgoing.on('response', (response) => {
        clearTimeout(timer);
        response.resume();
        socket.end(
          `HTTP/1.1 ${response.statusCode} WebSocket unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      });
      outgoing.on('error', () => {
        clearTimeout(timer);
        if (!connected && target.optional && !socket.destroyed) {
          live = false;
          forward({ url: direct(req, suffix), optional: false });
        } else socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      });
      socket.once('close', () => {
        outgoing.destroy();
        remoteSocket?.destroy();
      });
      socket.on('error', () => {
        outgoing.destroy();
        remoteSocket?.destroy();
      });
      outgoing.end();
    };
    forward(destination(req, suffix));
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    if (process.env.RAPID_LISTEN_FD !== undefined)
      server.listen({ fd: Number(process.env.RAPID_LISTEN_FD) }, ok);
    else server.listen(config.port, '127.0.0.1', ok);
  });
  log('router_started', {
    pid: process.pid,
    port: server.address().port,
    socketActivation: process.env.RAPID_LISTEN_FD !== undefined,
  });
  return {
    server,
    port: server.address().port,
    refresh,
    close: async () => {
      stopping = true;
      clearInterval(timer);
      for (const s of sockets) s.destroy();
      await new Promise((ok) => server.close(ok));
    },
  };
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const router = await createRouter(JSON.parse(await readFile(process.argv[2], 'utf8')));
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => router.close().then(() => process.exit(0)));
}
