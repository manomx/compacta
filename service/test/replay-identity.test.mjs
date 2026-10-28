import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompactionEngine,
  fingerprints,
  hash,
  normalize,
  preparedMatch,
  retainedReplayFingerprints,
} from '../native/engine.mjs';

const message = (role, text) => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text }],
});
const image = {
  ...message('user', 'Keep this exact diagram and approved flow.'),
  content: [
    { type: 'input_text', text: 'Keep this exact diagram and approved flow.' },
    { type: 'input_image', image_url: 'data:image/png;base64,U1lOVEhFVElDLUlNQUdF' },
  ],
};
const interrupted = {
  ...message(
    'user',
    '<turn_aborted>Check the previous process before repeating a write.</turn_aborted>',
  ),
  internal_chat_message_metadata_passthrough: { content_item_kinds: ['generic.turn_aborted'] },
};
const source = [
  message(
    'user',
    'Fix the existing voice flow; preserve Pomerado. Do not deploy before validation.',
  ),
  image,
  interrupted,
  message('assistant', 'Duplicate dispatch removed; validation is pending.'),
];
const tail = [
  message(
    'assistant',
    'Already patched voice-flow/src/Conductor.swift. Now checking the existing build.',
  ),
  {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'existing-build',
    input: 'synthetic-check-build',
  },
  {
    type: 'custom_tool_call_output',
    call_id: 'existing-build',
    output: 'Running with session_id: 12981. Follow this process; do not launch another build.',
  },
];
const opaque = { type: 'compaction', encrypted_content: 'SYNTHETIC-REPLAY-IDENTITY' };
const headers = { 'thread-id': 'synthetic-replay-chat' };
const body = { model: 'test', input: source };
const replay = (detail = 'original') => [
  source[0],
  { ...image, content: [image.content[0], { ...image.content[1], detail }] },
  opaque,
];

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'compacta-replay-identity-'));
  let calls = 0;
  const events = [];
  const engine = () =>
    new CompactionEngine({
      root,
      thresholdTokens: 1,
      cooldownMs: 0,
      minDeltaChars: 1,
      waitForPending: false,
      compact: async () => {
        calls++;
        return { nativeV2: true, output: [opaque] };
      },
      log: (event, data) => events.push({ event, ...data }),
    });
  const e = engine();
  await e.init();
  const key = e.identity(body, headers, 'test');
  const s = await e.session(key);
  s.lastUsage = 100;
  await e.maybePrepare(s, source, headers, 'test', body);
  t.after(async () => {
    e.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { e, s, key, root, events, engine, calls: () => calls };
}

test('native image serialization and omitted interruption markers preserve the exact pending work after restart', async (t) => {
  const f = await setup(t);
  const compact = await f.e.plan({ ...body, input: [...source, ...tail] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  assert.deepEqual(compact.fastOutput, [opaque]);
  const replacement = f.engine();
  await replacement.init();
  t.after(() => replacement.stop());
  for (const detail of ['original', 'high']) {
    const current = replay(detail);
    const plan = await replacement.plan({ ...body, input: current }, headers, 'test');
    assert.deepEqual(plan.body.input, [...current, ...tail]);
    assert.equal(f.calls(), 1);
    assert.ok(preparedMatch(plan.body.input, (await replacement.session(f.key)).ready));
    const repeated = await replacement.plan(plan.body, headers, 'test');
    assert.deepEqual(repeated.body.input, plan.body.input);
  }
});

test('replay recovery still rejects edited text, changed images, deleted requests and another summary', async (t) => {
  const f = await setup(t);
  await f.e.plan({ ...body, input: [...source, ...tail] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  const editedText = replay();
  editedText[0] = message('user', 'Different request: deploy immediately.');
  const editedImage = replay();
  editedImage[1] = {
    ...image,
    content: [
      image.content[0],
      { ...image.content[1], image_url: 'data:image/png;base64,RElGRkVSRU5U' },
    ],
  };
  const deletedRequest = replay().slice(1);
  const otherSummary = [
    ...replay().slice(0, -1),
    { ...opaque, encrypted_content: 'OTHER-SUMMARY' },
  ];
  for (const input of [editedText, editedImage, deletedRequest, otherSummary]) {
    const request = { ...body, input };
    assert.strictEqual((await f.e.plan(request, headers, 'test')).body, request);
  }
  assert.equal(f.calls(), 1);
});

test('authored interruption tags remain protected and recent real interruption warnings remain in the restored tail', async (t) => {
  const fake = message('user', '<turn_aborted>Do not deploy.</turn_aborted>');
  const mixed = {
    ...interrupted,
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['generic.turn_aborted', 'user.text'],
    },
  };
  assert.equal(retainedReplayFingerprints([interrupted]).length, 0);
  assert.equal(retainedReplayFingerprints([fake, mixed]).length, 2);
  const f = await setup(t);
  const recent = [interrupted, ...tail];
  await f.e.plan({ ...body, input: [...source, ...recent] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  const current = replay();
  const plan = await f.e.plan({ ...body, input: current }, headers, 'test');
  assert.deepEqual(plan.body.input, [...current, ...recent]);
});

async function legacyTail(f, corrupt = false) {
  const record = {
    version: 1,
    scope: f.e.tailScope(headers['thread-id'], 'test'),
    summary: hash(normalize(opaque)),
    retained: fingerprints(source.filter((i) => i.role === 'user')),
    prefixCount: 3,
    tail,
  };
  const id = hash({ scope: record.scope, summary: record.summary, retained: record.retained });
  await writeFile(
    join(f.root, 'tails', id + '.json'),
    JSON.stringify({ ...record, digest: corrupt ? 'INVALID' : hash(record) }),
  );
}

test('an existing 1.1.1 tail migrates only after archived source proves the complete retained history', async (t) => {
  const f = await setup(t);
  await legacyTail(f);
  const replacement = f.engine();
  await replacement.init();
  t.after(() => replacement.stop());
  const current = replay('high');
  const plan = await replacement.plan({ ...body, input: current }, headers, 'test');
  assert.deepEqual(plan.body.input, [...current, ...tail]);
  assert.ok(f.events.some((e) => e.event === 'recent_tail_migrated'));
  const records = await Promise.all(
    (await readdir(join(f.root, 'tails'))).map(async (name) =>
      JSON.parse(await readFile(join(f.root, 'tails', name), 'utf8')),
    ),
  );
  assert.ok(records.some((r) => r.version === 1));
  assert.ok(records.some((r) => r.version === 2));
  assert.equal(f.calls(), 1);
});

test('legacy migration rejects changed authored input and a corrupt saved record', async (t) => {
  const f = await setup(t);
  await legacyTail(f, true);
  const request = { ...body, input: replay() };
  assert.strictEqual((await f.e.plan(request, headers, 'test')).body, request);
  await legacyTail(f);
  const edited = replay();
  edited[0] = message('user', 'New instructions: discard the previous work.');
  const changed = { ...body, input: edited };
  assert.strictEqual((await f.e.plan(changed, headers, 'test')).body, changed);
  assert.equal(f.events.filter((e) => e.event === 'recent_tail_migrated').length, 0);
  assert.equal(f.calls(), 1);
});
