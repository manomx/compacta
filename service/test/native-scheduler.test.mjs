import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactionEngine } from '../native/engine.mjs';
const tick = () => new Promise((r) => setImmediate(r));
const msg = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const native = (n) => ({ output: [{ type: 'compaction', encrypted_content: 'synthetic-' + n }] });
const headers = { session_id: 'chat-A', authorization: 'Bearer test' };
const body = {
  model: 'gpt-6-astra',
  instructions: 'Preserve exact constraints.',
  input: [msg('NO publicar. Referencia ABC-731.')],
};
async function setup(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rapid-scheduler-')),
    calls = [];
  const e = new CompactionEngine({
    root,
    everyStep: true,
    compactionModel: 'gpt-6-luna',
    compactionEffort: 'low',
    maxConcurrent: 2,
    maxPerSession: 2,
    compact: (b) => new Promise((resolve, reject) => calls.push({ body: b, resolve, reject })),
    ...extra,
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
  return { e, calls };
}
test('completed tool results start preparation before the final assistant answer', async (t) => {
  const { e, calls } = await setup(t);
  const p = await e.plan(body, headers, 'upstream');
  await tick();
  assert.equal(calls.length, 0);
  const call = { type: 'function_call', call_id: 'read-1', name: 'read', arguments: '{}' },
    result = {
      type: 'function_call_output',
      call_id: 'read-1',
      output: 'Referencia definitiva NUEVA-82. No publicar.',
    };
  await e.observe(
    p,
    { id: 'r1', status: 'completed', output: [call], usage: { input_tokens: 10 } },
    headers,
    'upstream',
    body,
  );
  await tick();
  assert.equal(calls.length, 0);
  const next = { ...body, input: [...body.input, call, result] };
  const q = await e.plan(next, headers, 'upstream');
  await tick();
  assert.equal(calls.length, 1);
  assert.strictEqual(q.body, next);
  assert.deepEqual(calls[0].body.input, next.input);
  assert.equal(e.status().sessions[0].completedTurns, 0);
  const final = {
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    content: 'Terminado el diagnóstico.',
  };
  await e.observe(q, { id: 'r2', status: 'completed', output: [final] }, headers, 'upstream', next);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'gpt-6-luna');
  assert.deepEqual(calls[0].body.reasoning, { effort: 'low' });
  assert.equal(e.status().sessions[0].completedTurns, 1);
  calls[0].resolve(native('tools'));
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.input, [...native('tools').output, final]);
  calls[1].resolve(native('complete'));
  await tick();
});
test('one chain per chat incorporates all queued turns using the prior summary', async (t) => {
  const { e, calls } = await setup(t),
    s = await e.session(e.identity(body, headers, 'upstream'));
  const snapshots = [1, 2, 3, 4, 5].map((n) =>
    Array.from({ length: n }, (_, i) => msg('Correction ' + i)),
  );
  const promises = [];
  for (const items of snapshots) {
    promises.push(e.maybePrepare(s, items, headers, 'upstream', body));
    await tick();
  }
  assert.equal(calls.length, 1);
  assert.equal(s.pending.source.length, 5);
  assert.equal(e.stats.coalesced, 3);
  calls[0].resolve(native(1));
  await promises[0];
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.input, [native(1).output[0], ...snapshots[4].slice(1)]);
  calls[1].resolve(native(5));
  await Promise.all(promises);
  assert.equal(s.ready.prefix.length, 5);
  assert.equal(s.ready.output[0].encrypted_content, 'synthetic-5');
  assert.equal(e.stats.peakJobs, 1);
});
test('a failed background call frees its slot and queued work is not lost', async (t) => {
  const { e, calls } = await setup(t, { maxConcurrent: 1, maxPerSession: 1 }),
    s = await e.session(e.identity(body, headers, 'upstream'));
  const a = e.maybePrepare(s, body.input, headers, 'upstream', body);
  await tick();
  const b = e.maybePrepare(s, [...body.input, msg('newest')], headers, 'upstream', body);
  await tick();
  calls[0].reject(Error('temporary_error'));
  await a;
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve(native('recovered'));
  await b;
  assert.equal(e.stats.errors, 1);
  assert.equal(s.ready.prefix.length, 2);
  assert.equal(s.lastError, null);
});
test('a continuously active chat cannot starve another waiting chat', async (t) => {
  const { e, calls } = await setup(t, { maxConcurrent: 1, maxPerSession: 1 });
  const a = await e.session(e.identity(body, headers, 'upstream'));
  const bHeaders = { ...headers, session_id: 'chat-B' },
    b = await e.session(e.identity(body, bHeaders, 'upstream'));
  const first = e.maybePrepare(a, body.input, headers, 'upstream', body);
  await tick();
  const newest = e.maybePrepare(
    a,
    [...body.input, msg('A keeps generating updates')],
    headers,
    'upstream',
    body,
  );
  await tick();
  const other = e.maybePrepare(b, [msg('B must get the next slot')], bHeaders, 'upstream', body);
  await tick();
  calls[0].resolve(native('A1'));
  await first;
  await tick();
  assert.match(JSON.stringify(calls[1].body.input), /B must get the next slot/);
  calls[1].resolve(native('B'));
  await other;
  await tick();
  assert.equal(calls.length, 3);
  calls[2].resolve(native('A2'));
  await newest;
});
test('summaries from an abandoned history branch are discarded', async (t) => {
  const { e, calls } = await setup(t),
    s = await e.session(e.identity(body, headers, 'upstream'));
  const a = e.maybePrepare(s, [msg('old branch')], headers, 'upstream', body);
  await tick();
  const b = e.maybePrepare(s, [msg('corrected branch')], headers, 'upstream', body);
  await tick();
  calls[0].resolve(native('old'));
  await a;
  assert.equal(s.ready, null);
  calls[1].resolve(native('new'));
  await b;
  assert.equal(s.ready.output[0].encrypted_content, 'synthetic-new');
});
test('a changed summarizer policy cannot reuse another model or effort cache', async (t) => {
  const { e, calls } = await setup(t),
    key = e.identity(body, headers, 'upstream'),
    s = await e.session(key);
  const p = e.maybePrepare(s, body.input, headers, 'upstream', body);
  await tick();
  calls[0].resolve(native('luna'));
  await p;
  const other = new CompactionEngine({
    root: e.root,
    compactionModel: 'gpt-6-astra',
    compactionEffort: 'high',
    compact: async () => native('other'),
  });
  await other.init();
  assert.equal((await other.session(key)).ready, null);
});
test('pausing prevents queued work from starting when an active job finishes', async (t) => {
  const { e, calls } = await setup(t, { maxConcurrent: 1, maxPerSession: 1 }),
    s = await e.session(e.identity(body, headers, 'upstream'));
  const a = e.maybePrepare(s, body.input, headers, 'upstream', body);
  await tick();
  const b = e.maybePrepare(s, [...body.input, msg('queued correction')], headers, 'upstream', body);
  await tick();
  e.enabled = false;
  calls[0].resolve(native('finished'));
  await a;
  await tick();
  assert.equal(calls.length, 1);
  e.enabled = true;
  e.drain();
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve(native('resumed'));
  await b;
});
test('continuous mode honors the selected interval and coalesces the latest correction', async (t) => {
  const { e, calls } = await setup(t, { cooldownMs: 80 }),
    s = await e.session(e.identity(body, headers, 'upstream'));
  const a = e.maybePrepare(s, body.input, headers, 'upstream', body);
  await tick();
  const b = e.maybePrepare(s, [...body.input, msg('intermediate')], headers, 'upstream', body);
  await tick();
  const c = e.maybePrepare(s, [...body.input, msg('latest correction')], headers, 'upstream', body);
  await tick();
  assert.equal(calls.length, 1);
  calls[0].resolve(native('first'));
  await a;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[1].body.input), /latest correction/);
  calls[1].resolve(native('latest'));
  await Promise.all([b, c]);
});
test('continuous mode honors the minimum amount of changed context', async (t) => {
  const { e, calls } = await setup(t, { minDeltaChars: 5000 }),
    s = await e.session(e.identity(body, headers, 'upstream'));
  const a = e.maybePrepare(s, body.input, headers, 'upstream', body);
  await tick();
  calls[0].resolve(native('first'));
  await a;
  await e.maybePrepare(s, [...body.input, msg('small change')], headers, 'upstream', body);
  await tick();
  assert.equal(calls.length, 1);
  const b = e.maybePrepare(
    s,
    [...body.input, msg('meaningful update '.repeat(500))],
    headers,
    'upstream',
    body,
  );
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve(native('updated'));
  await b;
});
