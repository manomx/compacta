import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompactionEngine,
  normalize,
  hash,
  completesTurn,
  mismatchDetails,
  retainedV2Input,
} from '../native/engine.mjs';
const tick = () => new Promise((r) => setImmediate(r));
const message = (role, text) => ({
  type: 'message',
  role,
  ...(role === 'assistant' ? { phase: 'final_answer' } : {}),
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
});
const user = message('user', 'Reference A731. Only diagnosis; do not publish.'),
  first = message('assistant', 'Tool evidence T992, pending verification.');
const body = { model: 'gpt-6-astra', instructions: 'preserve facts', input: [user] },
  headers = { session_id: 'turn-chain', authorization: 'Bearer test' };
const native = (n) => ({
  nativeV2: true,
  output: [{ type: 'compaction', encrypted_content: 'opaque-' + n }],
});
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'compacta-chain-')),
    calls = [],
    events = [];
  const e = new CompactionEngine({
    root,
    everyStep: true,
    compact: (b) => new Promise((resolve, reject) => calls.push({ body: b, resolve, reject })),
    log: (event, d) => events.push({ event, ...d }),
  });
  await e.init();
  t.after(async () => {
    e.stop();
    for (const c of calls) c.resolve(native('cleanup'));
    await Promise.all(
      [...e.sessions.values()].flatMap((s) => [...s.jobs.values()].map((j) => j.done)),
    );
    await rm(root, { recursive: true, force: true });
  });
  return { e, calls, events };
}
async function observe(e, input, output, id) {
  const b = { ...body, input };
  const p = await e.plan(b, headers, 'upstream');
  await e.observe(p, { id, status: 'completed', output }, headers, 'upstream', b);
  await tick();
}
test('real Codex reasoning replay omits metadata and empty content without changing coverage', () => {
  const live = {
    type: 'reasoning',
    id: 'r1',
    metadata: { turn_id: 't1' },
    internal_chat_message_metadata_passthrough: { turn_id: 't1' },
    summary: [],
    content: [],
    encrypted_content: 'same',
  };
  const replay = {
    type: 'reasoning',
    id: 'r1',
    summary: [],
    encrypted_content: 'same',
    internal_chat_message_metadata_passthrough: { turn_id: 't1' },
  };
  assert.equal(hash(normalize(live)), hash(normalize(replay)));
  assert.equal(hash(normalize(live)), hash(normalize({ ...replay, content: null })));
  assert.notEqual(
    hash(normalize(live)),
    hash(normalize({ ...replay, encrypted_content: 'different' })),
  );
  assert.notEqual(hash(normalize(live)), hash(normalize({ ...replay, content: ['meaningful'] })));
  assert.notEqual(
    hash(normalize(live)),
    hash(normalize({ ...replay, metadata: { unknown: 'meaningful' } })),
  );
});
test('null reasoning content reuses a persisted checkpoint without another model call', async (t) => {
  for (const preparedContent of [undefined, null, []]) {
    const { e, calls, events } = await setup(t);
    const reasoning = {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'unchanged',
      ...(preparedContent !== undefined ? { content: preparedContent } : {}),
    };
    await observe(e, [user], [reasoning, first], 'null-replay');
    calls[0].resolve(native(1));
    await Promise.all(
      [...e.sessions.values()].flatMap((s) => [...s.jobs.values()].map((j) => j.done)),
    );
    const restarted = new CompactionEngine({
      root: e.root,
      everyStep: true,
      compact: async () => {
        throw Error('Unexpected model call');
      },
      log: (event, d) => events.push({ event, ...d }),
    });
    await restarted.init();
    t.after(() => restarted.stop());
    for (const replayContent of [undefined, null, []]) {
      const replay = { ...reasoning };
      delete replay.content;
      if (replayContent !== undefined) replay.content = replayContent;
      const p = await restarted.plan(
        { ...body, input: [user, replay, first, { type: 'compaction_trigger' }] },
        headers,
        'upstream',
        { isCompact: true, v2: true },
      );
      assert.deepEqual(p.fastOutput, native(1).output);
    }
    assert.equal(calls.length, 1);
    assert.equal(
      events.filter(
        (x) =>
          x.event === 'compaction_wait_started' ||
          x.event === 'checkpoint_mismatch' ||
          x.event === 'prepare_failed',
      ).length,
      0,
    );
  }
});
test('commentary, calls, partial and failed responses do not complete a turn', () => {
  for (const response of [
    { output: [{ ...first, phase: 'commentary' }] },
    { output: [first, { type: 'function_call' }] },
    { status: 'incomplete', output: [first] },
    { status: 'failed', output: [first] },
  ])
    assert.equal(completesTurn(response), false);
  assert.equal(completesTurn({ status: 'completed', output: [first] }), true);
});
test('manual compaction waits for the exact active turn once, then returns its checkpoint', async (t) => {
  const { e, calls, events } = await setup(t);
  await observe(e, [user], [first], 'r1');
  assert.equal(calls.length, 1);
  let done = false;
  const compact = e
    .plan({ ...body, input: [user, first, { type: 'compaction_trigger' }] }, headers, 'upstream', {
      isCompact: true,
      v2: true,
    })
    .then((p) => {
      done = true;
      return p;
    });
  await tick();
  assert.equal(done, false);
  assert.equal(calls.length, 1);
  calls[0].resolve(native(1));
  const p = await compact;
  assert.deepEqual(p.fastOutput, native(1).output);
  assert.equal(calls.length, 1);
  assert.equal(e.status().sessions[0].coveredTurns, 1);
  assert.equal(e.status().activeJobs, 0);
  assert.ok(events.some((x) => x.event === 'compaction_wait_finished' && x.ready));
});
test('automatic trigger waits for oversized pending turns and incorporates only their delta', async (t) => {
  const { e, calls } = await setup(t);
  await observe(e, [user], [first], 'r1');
  const correction = message('user', 'Correction: temporary 164; published 153.'),
    second = message(
      'assistant',
      'Confirmed these are staging counts, still not published. ' + 'Evidence '.repeat(9000),
    );
  const history = [user, first, correction, second];
  await observe(e, history.slice(0, -1), [second], 'r2');
  assert.equal(calls.length, 1);
  const compact = e.plan(
    { ...body, input: [...history, { type: 'compaction_trigger' }] },
    headers,
    'upstream',
    { isCompact: true, v2: true },
  );
  await tick();
  calls[0].resolve(native(1));
  await tick();
  await tick();
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.input, [user, ...native(1).output, correction, second]);
  calls[1].resolve(native(2));
  const p = await compact;
  assert.deepEqual(p.fastOutput, native(2).output);
  assert.equal(calls.length, 2);
  assert.equal(e.status().sessions[0].coveredTurns, 2);
  assert.equal(e.status().sessions[0].pendingTurns, 0);
  const ready = await e.plan({ ...body, input: history }, headers, 'upstream', {
    isCompact: true,
    v2: true,
  });
  assert.deepEqual(ready.fastOutput, p.fastOutput);
  assert.equal(calls.length, 2);
  // Continue from the actual native replay after compacting; no expanded history.
  const replay = [
      ...retainedV2Input(history),
      ...p.fastOutput,
      message('user', 'Continue diagnosis.'),
    ],
    third = message('assistant', 'The restriction remains unchanged.');
  await observe(e, replay, [third], 'r3');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body.input, [...replay, third]);
  calls[2].resolve(native(3));
});
test('duplicate completed events do not schedule another summary or advance the cursor', async (t) => {
  const { e, calls } = await setup(t);
  await observe(e, [user], [first], 'r1');
  await observe(e, [user], [first], 'r1');
  assert.equal(calls.length, 1);
  assert.equal(e.status().sessions[0].completedTurns, 1);
  calls[0].resolve(native(1));
});
test('native replay drops generated goal context without breaking the incremental chain', async (t) => {
  const { e, calls, events } = await setup(t);
  const goal = {
    ...message('user', 'Generated current goal. Progress counter 1.'),
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['goal.internal_context'] },
  };
  await observe(e, [user, goal], [first], 'r1');
  calls[0].resolve(native(1));
  for (let i = 0; i < 50 && e.status().activeJobs; i++) await new Promise((r) => setTimeout(r, 5));
  const replay = [user, ...native(1).output, message('user', 'Continue the original task.')];
  const second = message('assistant', 'Still working on the original task.');
  await observe(e, replay, [second], 'r2');
  assert.equal(calls.length, 2);
  assert.equal(events.filter((x) => x.event === 'prepare_started').at(-1).incremental, true);
  assert.deepEqual(calls[1].body.input, [...replay, second]);
  calls[1].resolve(native(2));
});
test('native replay cannot omit an ordinary user message or a mixed goal message', async (t) => {
  for (const kinds of [['user.text'], ['goal.internal_context', 'user.text']]) {
    const { e, calls, events } = await setup(t);
    const actual = {
      ...message('user', 'Actual new restriction: stop after diagnosis.'),
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    };
    await observe(e, [user, actual], [first], 'r1');
    calls[0].resolve(native(1));
    for (let i = 0; i < 50 && e.status().activeJobs; i++)
      await new Promise((r) => setTimeout(r, 5));
    await observe(e, [user, ...native(1).output], [message('assistant', 'Follow up')], 'r2');
    assert.equal(events.filter((x) => x.event === 'prepare_started').at(-1).incremental, false);
    calls[1].resolve(native(2));
  }
});
test('a real user edit records the exact changed field and never reuses the old checkpoint', async (t) => {
  const { e, calls, events } = await setup(t);
  await observe(e, [user], [first], 'r1');
  calls[0].resolve(native(1));
  for (let i = 0; i < 50 && e.status().activeJobs; i++) await new Promise((r) => setTimeout(r, 5));
  const edited = message('user', 'Different reference B211. Do not publish.');
  const compact = e.plan({ ...body, input: [edited, first] }, headers, 'upstream', {
    isCompact: true,
    v2: true,
  });
  await tick();
  assert.equal(calls.length, 2);
  const mismatch = events.find((x) => x.event === 'checkpoint_mismatch');
  assert.equal(mismatch.index, 0);
  assert.deepEqual(mismatch.fields, ['/content/0/text']);
  assert.ok(!JSON.stringify(mismatch).includes('B211'));
  calls[1].resolve(native(2));
  assert.deepEqual((await compact).fastOutput, native(2).output);
});
