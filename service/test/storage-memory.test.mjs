import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SnapshotStore } from '../native/storage.mjs';
import { CompactionEngine, hash } from '../native/engine.mjs';

const message = (role, text) => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text }],
});
const headers = { 'thread-id': 'resource-test' };
const opaque = { type: 'compaction', encrypted_content: 'SYNTHETIC-STORAGE-CHECKPOINT' };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'compacta-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new SnapshotStore(root) };
}
test('shared large strings roundtrip exactly across checkpoints, archives and a new process', async (t) => {
  const { root, store } = await setup(t);
  const image = 'data:image/png;base64,' + 'Xy25'.repeat(200000);
  const odd = 'exact \ud800 \\ " \n'.repeat(1000);
  const value = {
    items: [message('user', 'Do not deploy.'), { image, odd }],
    literal: JSON.parse('{"$compactaBlob":"user data","__proto__":null}'),
  };
  const a = join(root, 'cache', hash('a') + '.json'),
    b = join(root, 'archive', hash('b') + '.json');
  await store.write(a, value);
  await store.write(b, value);
  const wrapper = JSON.parse(await readFile(a, 'utf8'));
  assert.equal(wrapper.blobs.length, 2);
  assert.ok((await readFile(a)).length < 2000);
  const objects = (
    await Promise.all(
      (await readdir(join(root, 'objects'))).map((d) => readdir(join(root, 'objects', d))),
    )
  ).flat();
  assert.equal(objects.length, 2);
  assert.deepEqual(await new SnapshotStore(root).read(a), value);
  assert.deepEqual(await store.read(b), value);
});
test('legacy data remains readable while migration verifies a lossless replacement', async (t) => {
  const { root, store } = await setup(t);
  const path = join(root, 'archive', hash('legacy') + '.json');
  const value = {
    created: 'same',
    items: [message('user', 'Exact reference ' + 'ABCD'.repeat(4000))],
  };
  await mkdir(join(root, 'archive'));
  await writeFile(path, JSON.stringify(value));
  assert.deepEqual(await store.read(path), value);
  const result = await store.optimize();
  assert.equal(result.migrated, 1);
  assert.equal(result.errors, 0);
  assert.deepEqual(await store.read(path), value);
});
test('garbage collection keeps every referenced object and removes only abandoned data', async (t) => {
  const { root, store } = await setup(t);
  const path = join(root, 'cache', hash('gc') + '.json');
  await store.write(path, { text: 'needed'.repeat(1000) });
  await store.putString('unreferenced'.repeat(1000));
  await new Promise((r) => setTimeout(r, 2));
  const collected = await store.collectGarbage(0);
  assert.equal(collected.removed, 1);
  assert.deepEqual(await store.read(path), { text: 'needed'.repeat(1000) });
});
test('a corrupt shared object is rejected and failed migration preserves the original file', async (t) => {
  const { root, store } = await setup(t);
  const path = join(root, 'archive', hash('corruption') + '.json');
  const value = { text: 'original'.repeat(2000) };
  await mkdir(join(root, 'archive'));
  await writeFile(path, JSON.stringify(value));
  const object = await store.putString(value.text);
  await writeFile(store.objectPath(object.id), 'corrupt');
  await assert.rejects(() => store.migrate(path));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), value);
});
test('idle histories leave RAM while opaque checkpoints and incremental response IDs still continue exactly', async (t) => {
  const { root } = await setup(t);
  let calls = 0;
  const engine = new CompactionEngine({
    root,
    thresholdTokens: 1,
    cooldownMs: 0,
    minDeltaChars: 1,
    compact: async () => {
      calls++;
      return { nativeV2: true, output: [opaque] };
    },
    waitForPending: false,
  });
  await engine.init();
  t.after(() => engine.stop());
  const input = [
    message('user', 'Keep this image ' + 'XYZ'.repeat(60000)),
    message('assistant', 'Result R731; still pending.'),
  ];
  const body = { model: 'test', input };
  const plan = await engine.plan(body, headers, 'test');
  const s = await engine.session(plan.key);
  s.lastUsage = 100;
  await engine.maybePrepare(s, input, headers, 'test', body, { force: true });
  assert.equal(s.ready.output.length, 0);
  assert.equal(s.readySource, null);
  const reply = { ...message('assistant', 'Exact additional result T992.'), phase: 'commentary' };
  await engine.observe(
    plan,
    { id: 'previous-response', status: 'completed', output: [reply] },
    headers,
    'test',
    body,
  );
  const entry = engine.lastResponses.get('previous-response');
  await entry.writing;
  assert.equal(entry.items, undefined);
  engine.releaseIdleMemory(Date.now() + 60000);
  assert.equal(s.latestInput, null);
  const next = message('user', 'Continue, do not repeat the operation.');
  const resumed = await engine.plan(
    { ...body, input: [next], previous_response_id: 'previous-response' },
    headers,
    'test',
  );
  assert.deepEqual(resumed.logical, [...input, reply, next]);
  const restarted = new CompactionEngine({
    root,
    compact: async () => {
      throw Error('must not summarize');
    },
  });
  await restarted.init();
  t.after(() => restarted.stop());
  const afterRestart = await restarted.plan(
    { ...body, input: [next], previous_response_id: 'previous-response' },
    headers,
    'test',
  );
  assert.deepEqual(afterRestart.logical, [...input, reply, next]);
  const compact = await engine.plan(body, headers, 'test', { isCompact: true, v2: true });
  assert.deepEqual(compact.fastOutput, [opaque]);
  assert.equal(calls, 1);
});
test('resource housekeeping does not cap simultaneous summary jobs', async (t) => {
  const { root } = await setup(t);
  let finish;
  const gate = new Promise((r) => {
    finish = r;
  });
  const engine = new CompactionEngine({
    root,
    maxConcurrent: 0,
    everyStep: true,
    compact: async () => {
      await gate;
      return { nativeV2: true, output: [opaque] };
    },
  });
  await engine.init();
  t.after(() => engine.stop());
  const jobs = [];
  for (let i = 0; i < 12; i++) {
    const h = { 'thread-id': 'parallel-' + i },
      body = {
        model: 'test',
        input: [message('user', 'Goal ' + i), message('assistant', 'Result')],
      };
    const s = await engine.session(engine.identity(body, h, 'test'));
    jobs.push(engine.maybePrepare(s, body.input, h, 'test', body, { force: true }));
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(engine.activeJobs, 12);
  assert.equal(engine.maxConcurrent, 0);
  assert.equal(engine.releaseIdleMemory(Date.now() + 60000), 0);
  finish();
  await Promise.all(jobs);
  assert.equal(engine.stats.prepared, 12);
});
