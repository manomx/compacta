import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const app = resolve(process.argv[2] || 'build/Compacta.app');
for (const lang of ['en', 'es', 'zh-Hans'])
  for (const name of ['Localizable', 'InfoPlist'])
    assert.ok(
      existsSync(join(app, 'Contents/Resources', `${lang}.lproj`, `${name}.strings`)),
      `missing ${lang}.lproj/${name}.strings`,
    );
const root = await mkdtemp(join(tmpdir(), 'compacta-package-'));
const home = join(root, 'home'),
  state = join(root, 'state');
let engine,
  output = '',
  runtime;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const observed = [];
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  observed.push({ path: req.url, body });
  if (req.url === '/v1/messages') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'msg-package',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
    return;
  }
  if (req.url === '/v1/chat/completions') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'api-package',
        model: body.model,
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 12, completion_tokens: 1 },
      }),
    );
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.end(
    'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp-package',
          model: body.model,
          status: 'completed',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
          ],
          usage: { input_tokens: 15, output_tokens: 3 },
        },
      }) +
      '\n\n',
  );
});
const ws = new WebSocketServer({ server: upstream });
ws.on('connection', (s) => s.on('message', (data) => s.send(data)));
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;

async function start() {
  output = '';
  engine = spawn(
    join(app, 'Contents/Helpers/compacta-engine'),
    ['--root', state, '--vault', join(app, 'Contents/Helpers/compacta-vault'), '--no-quotas'],
    { env: { ...process.env, COMPACTA_TEST_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  engine.stdout.on('data', (d) => (output += d));
  engine.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 160; i++) {
    if (engine.exitCode !== null) throw Error('Compiled service exited: ' + output.slice(0, 500));
    try {
      runtime = JSON.parse(await readFile(join(state, 'runtime.json'), 'utf8'));
      if (runtime.pid !== engine.pid) throw Error('old runtime');
      return await api('/api/status');
    } catch {}
    await sleep(50);
  }
  throw Error('Compiled service did not become ready');
}
async function stop() {
  if (!engine || engine.exitCode !== null) return;
  const done = new Promise((r) => engine.once('exit', r));
  engine.kill('SIGTERM');
  await Promise.race([
    done,
    sleep(5000).then(() => {
      if (engine.exitCode === null) engine.kill('SIGKILL');
    }),
  ]);
}
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + runtime.adminToken, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  const codexOriginal = `model = "test"\nopenai_base_url = "${upstreamURL}/v1"\n`;
  await writeFile(join(home, '.codex/config.toml'), codexOriginal);
  await writeFile(
    join(home, '.claude/settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: upstreamURL, KEEP: 'preserved' } }),
  );
  let s = await start();
  assert.equal(s.config.onboarded, false);
  assert.equal(s.codex.enabled, false);
  const base = `http://127.0.0.1:${runtime.port}`;
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal(
    (
      await fetch(base + '/api/status', {
        headers: {
          authorization: 'Bearer ' + runtime.adminToken,
          origin: 'https://untrusted.invalid',
        },
      })
    ).status,
    401,
  );
  const settings = s.config;
  settings.codex.instructions = 'Preserve custom instruction 731.';
  settings.codex.maxConcurrent = 0;
  settings.pollSeconds = 120;
  settings.providers.push({
    id: 'local-test',
    name: 'Local test',
    kind: 'compatible',
    auth: 'none',
    baseURL: upstreamURL + '/v1',
    model: 'mock-model',
    contextWindow: 200000,
    inputPrice: 1,
    outputPrice: 2,
    cachePrice: 0.1,
    cacheWritePrice: 1.25,
    priceSource: 'test fixture',
    priceDate: '2026-10-21',
    extraHeaders: {},
  });
  await api('/api/settings', settings);
  const probe = await api('/api/provider/test', { id: 'local-test' });
  assert.equal(probe.ok, true);
  const activated = await api('/api/integrations', { codex: true, claude: true });
  assert.equal(activated.ok, true);
  assert.equal(activated.snapshot.integration.codex.active, true);
  assert.equal(activated.snapshot.integration.claude.active, true);
  await api('/api/pause', { paused: true });
  const codexPath = `/${runtime.capability}/codex/v1/responses`;
  const inference = await fetch(base + codexPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-6-luna',
      input: [{ role: 'user', content: 'package smoke' }],
    }),
  });
  assert.equal(inference.status, 200);
  assert.match(await inference.text(), /response.completed/);
  const claudeResponse = await fetch(`${base}/${runtime.capability}/claude/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'package smoke' }],
    }),
  });
  assert.equal(claudeResponse.status, 200);
  assert.equal((await claudeResponse.json()).content[0].text, 'OK');
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + codexPath);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(Error('WebSocket timeout'));
    }, 5000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'ping', value: 731 })));
    socket.on('message', (data) => {
      try {
        assert.equal(JSON.parse(data).value, 731);
        clearTimeout(timer);
        socket.close();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    socket.on('error', reject);
  });
  s = await api('/api/status');
  assert.equal(s.usage.requests, 3);
  assert.equal(s.usage.input, 37);
  assert.equal(s.usage.output, 6);
  const oldPort = runtime.port;
  await stop();
  s = await start();
  assert.equal(runtime.port, oldPort);
  assert.equal(s.config.pollSeconds, 120);
  assert.equal(s.config.codex.instructions, 'Preserve custom instruction 731.');
  assert.equal(s.codex.maxConcurrent, 0);
  assert.equal(s.codex.enabled, false);
  assert.equal(s.usage.requests, 3);
  await api('/api/disable-all', {});
  assert.equal(
    (await readFile(join(home, '.codex/config.toml'), 'utf8')).trim(),
    codexOriginal.trim(),
  );
  const restored = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(restored.env.ANTHROPIC_BASE_URL, upstreamURL);
  assert.equal(restored.env.KEEP, 'preserved');
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        'compiled startup',
        'admin authentication',
        'origin protection',
        'custom API request',
        'activation both clients',
        'HTTP Codex',
        'HTTP Claude',
        'WebSocket Codex',
        'token ledger',
        'pause',
        'persistent settings',
        'restart same ports',
        'reversible deactivation',
      ],
      externalRequests: 0,
    }),
  );
} finally {
  await stop();
  for (const s of ws.clients) s.terminate();
  ws.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await rm(root, { recursive: true, force: true });
}
