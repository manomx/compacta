// Portable compiled-service regression. Synthetic context; no real accounts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { defaults } from '../service/config.ts';
import { codexPolicyHash } from '../service/policy.ts';
import { SnapshotStore } from '../service/native/storage.mjs';
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
  inferenceInput,
  allowInference = false,
  stderr = '';
const upstream = http.createServer((req, res) => {
  upstreamRequests++;
  let data = '';
  req.on('data', (chunk) => (data += chunk));
  req.on('end', () => {
    if (allowInference && req.url.endsWith('/responses')) {
      inferenceInput = JSON.parse(data).input;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'synthetic-continuation',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              content: [{ type: 'output_text', text: 'Continue the existing process.' }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
      return;
    }
    res.writeHead(418, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unexpected_upstream_call' } }));
  });
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
  config.codex.mode = 'threshold';
  await writeFile(join(state, 'settings.json'), JSON.stringify(config), { mode: 0o600 });
  const page = {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
      },
    ],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['additional_content.codex_apps_open_page'],
    },
  };
  const source = [
    page,
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
      content: [
        {
          type: 'output_text',
          text:
            'Synthetic result T992 remains pending. ' + 'Older completed evidence. '.repeat(100000),
        },
      ],
    },
  ];
  const image = {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Keep the exact approved diagram.' },
      { type: 'input_image', image_url: 'data:image/png;base64,U1lOVEhFVElDLUlNQUdF' },
    ],
  };
  source.push(image, {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: '<turn_aborted>Check prior effects before retrying.</turn_aborted>',
      },
    ],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['generic.turn_aborted'] },
  });
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
  const migratedStorage = await new SnapshotStore(join(state, 'codex')).optimize();
  assert.equal(migratedStorage.errors, 0);
  assert.equal(migratedStorage.migrated, 2);
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
    if (content !== undefined) replay[2].content = content;
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
  const tail = [
    {
      type: 'custom_tool_call',
      call_id: 'synthetic-correction',
      name: 'exec',
      input: 'synthetic-already-launched-correction',
    },
    {
      type: 'custom_tool_call_output',
      call_id: 'synthetic-correction',
      output:
        'Running with session_id: 12981. Check this process; do not repeat the correction. ' +
        'Recent completed evidence. '.repeat(60000),
    },
  ];
  const endpoint = `http://127.0.0.1:${runtime.codexPort}/${runtime.capability}/v1/responses`;
  const compact = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, input: [...source, ...tail, { type: 'compaction_trigger' }] }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(compact.status, 200);
  assert.deepEqual((await compact.json()).output, nativeOutput);
  assert.equal(upstreamRequests, 0);
  allowInference = true;
  const replayImage = structuredClone(image);
  replayImage.content[1].detail = 'high';
  const continuation = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, input: [source[1], replayImage, ...nativeOutput] }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(continuation.status, 200);
  await continuation.json();
  assert.deepEqual(inferenceInput, [source[1], replayImage, ...nativeOutput, ...tail]);
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/status`, {
    headers: { authorization: 'Bearer ' + runtime.adminToken },
  });
  const status = await response.json();
  assert.equal(upstreamRequests, 1);
  assert.equal(status.codex.fastCompactions, 4);
  assert.equal(status.codex.prepared, 0);
  assert.equal(status.codex.errors, 0);
  console.log(
    JSON.stringify({
      ok: true,
      syntheticData: true,
      externalRequests: 0,
      upstreamRequests,
      fastCompactions: 4,
      pendingProcessRestored: true,
      migratedStorageRecovered: true,
      generatedPageSnapshotDropped: true,
      nativeImageDetailChanged: true,
      interruptionMarkerDropped: true,
      largeRecentToolBytes: Buffer.byteLength(JSON.stringify(tail)),
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
