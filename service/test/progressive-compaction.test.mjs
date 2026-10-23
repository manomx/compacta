import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactionEngine, retainedV2Input } from '../native/engine.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const msg = (role, content, phase) => ({
  type: 'message',
  role,
  content,
  ...(phase ? { phase } : {}),
});
const user = msg('user', 'Inspect only. Do not publish. Reference BASE-731.');
const assistant = msg(
  'assistant',
  'Verified 163 temporary / 153 published. Pending approval.',
  'final_answer',
);
const call = {
  type: 'function_call',
  call_id: 'inspect',
  name: 'exec_command',
  arguments: '{"cmd":"read evidence"}',
};
const result = {
  type: 'function_call_output',
  call_id: 'inspect',
  output: 'TOOL-992. Correction: temporary=164; published=153.',
};
const headers = { session_id: 'progress-chat', authorization: 'Bearer synthetic' };
const body = {
  model: 'gpt-6-astra',
  instructions: 'Preserve factual evidence and prohibitions.',
  input: [user],
};
const native = (id) => ({
  nativeV2: true,
  output: [{ type: 'compaction', encrypted_content: 'synthetic-' + id }],
});
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'compacta-progress-')),
    calls = [],
    events = [];
  const e = new CompactionEngine({
    root,
    everyStep: true,
    compact: (b) => new Promise((resolve) => calls.push({ body: b, resolve })),
    log: (event, data) => events.push({ event, ...data }),
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
async function base(e, calls) {
  const p = await e.plan(body, headers, 'upstream');
  await e.observe(
    p,
    { id: 'initial', status: 'completed', output: [assistant] },
    headers,
    'upstream',
    body,
  );
  await tick();
  const s = await e.session(p.key),
    done = [...s.jobs.values()][0].done;
  calls[0].resolve(native('base'));
  await done;
  return s;
}
test('only complete steps prepare in the background; unfinished tool groups stay intact', async (t) => {
  const { e, calls, events } = await setup(t);
  const input = [user, call, result, { ...call, call_id: 'open' }];
  const request = { ...body, input };
  const p = await e.plan(request, headers, 'upstream');
  await tick();
  assert.strictEqual(p.body, request);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.input, [user, call, result]);
  assert.equal(e.status().sessions[0].completedTurns, 0);
  assert.equal(events.find((x) => x.event === 'prepare_started').reason, 'tool_results');
  await e.plan(request, headers, 'upstream');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(e.status().pendingSessions, 0);
});
test('completed progress before a new tool call prepares, but partial streams and stale callbacks do not', async (t) => {
  const { e, calls } = await setup(t);
  const p = await e.plan(body, headers, 'upstream');
  const note = msg('assistant', 'Finding A-829; I am checking its implementation.', 'commentary');
  for (const status of ['in_progress', 'incomplete', 'failed'])
    await e.observe(p, { id: status, status, output: [note, call] }, headers, 'upstream', body);
  await tick();
  assert.equal(calls.length, 0);
  await e.observe(
    p,
    { id: 'step', status: 'completed', output: [note, call] },
    headers,
    'upstream',
    body,
  );
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.input, [user, note]);
  await e.plan({ ...body, input: [msg('user', 'Edited branch')] }, headers, 'upstream');
  await e.observe(
    p,
    { id: 'stale', status: 'completed', output: [assistant] },
    headers,
    'upstream',
    body,
  );
  assert.equal(e.status().sessions[0].completedTurns, 0);
});
test('ready summary plus exact recent tail compacts while the next summary remains unfinished', async (t) => {
  const { e, calls, events } = await setup(t);
  const s = await base(e, calls);
  const correction = msg('user', 'New constraint: inspect only; never publish.');
  const tail = [
    correction,
    call,
    result,
    msg('assistant', 'Tool confirms TOOL-992; verification remains pending.', 'commentary'),
  ];
  const history = [user, assistant, ...tail];
  await e.plan({ ...body, input: history }, headers, 'upstream');
  await tick();
  assert.equal(calls.length, 2);
  const job = [...s.jobs.values()][0];
  let timeout;
  const p = await Promise.race([
    e.plan({ ...body, input: [...history, { type: 'compaction_trigger' }] }, headers, 'upstream', {
      isCompact: true,
      v2: true,
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error('compaction waited for Luna')), 500);
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.deepEqual(p.fastOutput, native('base').output);
  assert.equal(s.jobs.size, 1);
  assert.equal(events.filter((x) => x.event === 'compaction_wait_started').length, 0);
  assert.equal(calls.length, 2);
  const next = msg('user', 'Continue with the exact same task.');
  const replay = [...retainedV2Input(history), ...p.fastOutput, next];
  const restored = await e.plan({ ...body, input: replay }, headers, 'upstream');
  assert.deepEqual(restored.body.input, [user, ...native('base').output, ...tail, next]);
  calls[1].resolve(native('late'));
  await job.done;
  assert.ok(events.some((x) => x.event === 'recent_tail_saved'));
  assert.ok(events.some((x) => x.event === 'recent_tail_restored'));
});
test('oversized recent evidence still waits for its existing summary once, without losing evidence', async (t) => {
  const { e, calls, events } = await setup(t);
  await base(e, calls);
  const big = { ...result, output: 'é'.repeat(40000) + ' EXACT_LAST_731' };
  const history = [user, assistant, call, big];
  await e.plan({ ...body, input: history }, headers, 'upstream');
  await tick();
  assert.equal(calls.length, 2);
  let done = false;
  const pending = e
    .plan({ ...body, input: history }, headers, 'upstream', { isCompact: true, v2: true })
    .then((p) => {
      done = true;
      return p;
    });
  await tick();
  assert.equal(done, false);
  assert.equal(calls.length, 2);
  calls[1].resolve(native('large'));
  const p = await pending;
  assert.deepEqual(p.fastOutput, native('large').output);
  assert.equal(calls.length, 2);
  assert.ok(events.some((x) => x.event === 'compaction_wait_finished' && x.ready));
  assert.ok(calls[1].body.input.some((i) => i.output === big.output));
});
test('plain user follow-ups do not restart preparation of already covered tools', async (t) => {
  const { e, calls } = await setup(t);
  const s = await e.session(e.identity(body, headers, 'upstream'));
  const prep = e.maybePrepare(s, [user, call, result, assistant], headers, 'upstream', body);
  await tick();
  calls[0].resolve(native('full'));
  await prep;
  await e.plan(
    { ...body, input: [user, call, result, assistant, msg('user', 'Continue')] },
    headers,
    'upstream',
  );
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(e.status().pendingSessions, 0);
});
test('an existing update that leaves a small recent tail prevents a second foreground summary', async (t) => {
  const { e, calls, events } = await setup(t);
  await base(e, calls);
  const big = { ...result, output: 'historical evidence '.repeat(6000) };
  const preparedInput = [user, assistant, call, big];
  await e.plan({ ...body, input: preparedInput }, headers, 'upstream');
  await tick();
  assert.equal(calls.length, 2);
  const recent = [
    { ...call, call_id: 'latest' },
    { ...result, call_id: 'latest', output: 'FINAL-731. Still pending; do not publish.' },
  ];
  const history = [...preparedInput, ...recent];
  const compact = e.plan({ ...body, input: history }, headers, 'upstream', {
    isCompact: true,
    v2: true,
  });
  await tick();
  const s = [...e.sessions.values()][0];
  assert.equal(s.pending, null, 'do not queue an unnecessary full update');
  calls[1].resolve(native('large-prefix'));
  const p = await compact;
  assert.deepEqual(p.fastOutput, native('large-prefix').output);
  assert.equal(calls.length, 2);
  assert.equal(s.pending, null);
  const replay = [...retainedV2Input(history), ...p.fastOutput, msg('user', 'Continue')];
  const restored = await e.plan({ ...body, input: replay }, headers, 'upstream');
  assert.deepEqual(restored.logical, [
    user,
    ...native('large-prefix').output,
    ...recent,
    replay.at(-1),
  ]);
  assert.ok(events.some((x) => x.event === 'compaction_wait_finished' && x.ready));
});
