// Portable compiled-service regression. Synthetic context; no real accounts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { defaults } from '../service/config.ts';
import { codexPolicyHash } from '../service/policy.ts';
import {
  CompactionEngine,
  fingerprints,
  conversationFingerprints,
  retainedV2Input,
} from '../service/native/engine.mjs';

const app = resolve(process.argv[2] || 'build/Compacta.app');
const root = await mkdtemp(join(tmpdir(), 'compacta-replay-')),
  home = join(root, 'home'),
  state = join(root, 'state');
let child,
  runtime,
  upstreamRequests = 0,
  stderr = '';
const upstream = http.createServer((req, res) => {
  upstreamRequests++;
  req.resume();
  res.writeHead(418, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'unexpected_upstream_call' } }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamURL = `http://127.0.0.1:${upstream.address().port}/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(
    join(home, '.codex/config.toml'),
    `model = "synthetic"\nopenai_base_url = "${upstreamURL}"\n`,
  );
  const config = defaults();
  config.codex.enabled = true;
  await writeFile(join(state, 'settings.json'), JSON.stringify(config), { mode: 0o600 });
  const source = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Synthetic reference A731. Do not publish.' }],
    },
    { type: 'reasoning', summary: [], encrypted_content: 'SYNTHETIC_REASONING' },
    {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Synthetic result T992 remains pending.' }],
    },
  ];
  const nativeOutput = [{ type: 'compaction', encrypted_content: 'SYNTHETIC_CHECKPOINT' }];
  const headers = { 'thread-id': 'synthetic-replay', authorization: 'Bearer local-fixture' };
  const body = { model: 'synthetic-model', input: source, stream: false };
  const identity = new CompactionEngine({
    root: state,
    compact: () => {
      throw Error('unused');
    },
  });
  const key = identity.identity(body, headers, upstreamURL);
  identity.stop();
  const created = new Date().toISOString();
  const cache = {
    version: 2,
    key,
    threadId: headers['thread-id'],
    policy: codexPolicyHash(config.codex, config.providers[0], config.codex.model),
    created,
    prefix: fingerprints(source),
    conversationPrefix: conversationFingerprints(source),
    output: [...retainedV2Input(source), ...nativeOutput],
    nativeOutput,
    nativeV2: true,
    nativeMs: 0,
    coveredTurns: 1,
    coveredTurnId: 'synthetic-turn',
  };
  for (const name of ['archive', 'cache'])
    await mkdir(join(state, 'codex', name), { recursive: true });
  await writeFile(
    join(state, 'codex/archive', key + '.json'),
    JSON.stringify({ version: 1, created, items: source }),
    { mode: 0o600 },
  );
  await writeFile(join(state, 'codex/cache', key + '.json'), JSON.stringify(cache), {
    mode: 0o600,
  });
  child = spawn(
    join(app, 'Contents/Helpers/compacta-engine'),
    ['--root', state, '--vault', join(app, 'Contents/Helpers/compacta-vault'), '--no-quotas'],
    { env: { ...process.env, COMPACTA_TEST_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-1000)));
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) throw Error('Compiled service exited: ' + stderr);
    try {
      runtime = JSON.parse(await readFile(join(state, 'runtime.json'), 'utf8'));
      if (runtime.pid === child.pid) break;
    } catch {}
    await sleep(50);
  }
  assert.equal(runtime?.pid, child.pid);
  const elapsed = [];
  for (const content of [null, [], undefined]) {
    const replay = structuredClone(source);
    if (content !== undefined) replay[1].content = content;
    const started = performance.now();
    const response = await fetch(
      `http://127.0.0.1:${runtime.codexPort}/${runtime.capability}/v1/responses`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, input: [...replay, { type: 'compaction_trigger' }] }),
        signal: AbortSignal.timeout(15000),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).output, nativeOutput);
    elapsed.push(Math.round((performance.now() - started) * 100) / 100);
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/status`, {
    headers: { authorization: 'Bearer ' + runtime.adminToken },
  });
  const status = await response.json();
  assert.equal(upstreamRequests, 0);
  assert.equal(status.codex.fastCompactions, 3);
  assert.equal(status.codex.prepared, 0);
  assert.equal(status.codex.errors, 0);
  console.log(
    JSON.stringify({
      ok: true,
      syntheticData: true,
      externalRequests: 0,
      upstreamRequests,
      fastCompactions: 3,
      newSummaries: 0,
      milliseconds: elapsed,
    }),
  );
} finally {
  if (child && child.exitCode === null) {
    const ended = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([
      ended,
      sleep(5000).then(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }),
    ]);
  }
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await rm(root, { recursive: true, force: true });
}
