import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompactionEngine,
  normalize,
  safeCut,
  hash,
  prefixMatches,
  preparedMatch,
  retainedV2Input,
} from '../native/engine.mjs';
const message = (role, text) => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text }],
});
const input = [
  message('user', 'No publicar; referencia EXACTA-73F2.'),
  message('assistant', 'Pendiente revisar.'),
];
const headers = { session_id: 'test-chat', authorization: 'Bearer test-only' };
const body = { model: 'test', instructions: 'same', input };
const native = {
  output: [
    { type: 'compaction', encrypted_content: 'SYNTHETIC-OPAQUE' },
    message('user', 'Retained by native backend'),
  ],
};
async function setup(t, compact = async () => native) {
  const root = await mkdtemp(join(tmpdir(), 'rapid-compact-test-'));
  const engine = new CompactionEngine({
    root,
    compact,
    waitForPending: false,
    thresholdTokens: 1,
    cooldownMs: 0,
    minDeltaChars: 1,
  });
  await engine.init();
  t.after(async () => {
    engine.stop();
    await Promise.all(
      [...engine.sessions.values()].flatMap((s) => [...s.jobs.values()].map((j) => j.done)),
    );
    await Promise.all([...engine.sessions.values()].map((s) => s.commit));
    await rm(root, { recursive: true, force: true });
  });
  return engine;
}
async function prepare(engine) {
  const key = engine.identity(body, headers, 'test');
  const s = await engine.session(key);
  s.lastUsage = 100;
  await engine.maybePrepare(s, input, headers, 'test', body);
  return s;
}
test('external handoff survives native loss, recent tails, restart and incremental preparation', async (t) => {
  const handoff = message(
    'assistant',
    'Exact external evidence A731 and tool reference T992. Pending; do not publish.',
  );
  const requests = [];
  const e = await setup(t, async (b) => {
    requests.push(b);
    return { nativeV2: true, output: [native.output[0]], externalHandoff: handoff };
  });
  const s = await prepare(e);
  const recent = [
    message('assistant', 'NEW_RESULT_44'),
    message('user', 'Latest restriction: inspect only.'),
  ];
  const compact = await e.plan({ ...body, input: [...input, ...recent] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  assert.deepEqual(compact.fastOutput, [native.output[0]]);
  const restarted = new CompactionEngine({ root: e.root, compact: async () => native });
  await restarted.init();
  t.after(() => restarted.stop());
  const next = message('user', 'Continue'),
    replay = [...retainedV2Input([...input, ...recent]), ...compact.fastOutput, next];
  const restored = await restarted.plan({ ...body, input: replay }, headers, 'test');
  assert.deepEqual(restored.body.input, [
    ...retainedV2Input(input),
    native.output[0],
    handoff,
    ...recent,
    next,
  ]);
  await e.maybePrepare(s, [...input, ...recent], headers, 'test', body);
  assert.ok(requests[1].input.some((i) => JSON.stringify(i) === JSON.stringify(handoff)));
});
test('an external handoff must persist even with no recent messages; a disk failure cannot acknowledge compaction', async (t) => {
  const handoff = message('assistant', 'Unique external evidence');
  const e = await setup(t, async () => ({
    nativeV2: true,
    output: [native.output[0]],
    externalHandoff: handoff,
  }));
  await prepare(e);
  e.saveTail = async () => {
    throw Error('disk_full');
  };
  const result = await e.plan(body, headers, 'test', { isCompact: true, v2: true });
  assert.equal(result.fastOutput, undefined);
  assert.ok(result.body.input.some((i) => JSON.stringify(i) === JSON.stringify(handoff)));
});

test('preserves canonical native output plus every new item', async (t) => {
  const e = await setup(t);
  await prepare(e);
  const tail = [
    message('user', 'Corrección: 164, no 163'),
    { type: 'function_call', call_id: 'new', name: 'x', arguments: '{}' },
  ];
  const p = await e.plan({ ...body, input: [...input, ...tail] }, headers, 'test', {
    isCompact: true,
  });
  assert.deepEqual(p.body.input, [...native.output, ...tail]);
  assert.equal(p.applied, true);
  assert.deepEqual(body.input, input);
});
test('changed prefix, model, instructions, account or chat cannot reuse cache', async (t) => {
  const e = await setup(t);
  await prepare(e);
  for (const [b, h] of [
    [{ ...body, input: [message('user', 'Changed'), input[1]] }, headers],
    [{ ...body, model: 'other' }, headers],
    [{ ...body, instructions: 'other' }, headers],
    [body, { ...headers, authorization: 'Bearer other' }],
    [body, { ...headers, session_id: 'other' }],
  ]) {
    const p = await e.plan(b, h, 'test', { isCompact: true });
    assert.equal(p.applied, undefined);
    assert.equal(p.fastOutput, undefined);
  }
});
test('v1 keeps entire native output; v2 rejects multiple native items for fast path', async (t) => {
  const e = await setup(t);
  await prepare(e);
  assert.deepEqual(
    (await e.plan(body, headers, 'test', { isCompact: true })).fastOutput,
    native.output,
  );
  const p = await e.plan(body, headers, 'test', { isCompact: true, v2: true });
  assert.equal(p.fastOutput, undefined);
  assert.deepEqual(p.body.input.at(-1), { type: 'compaction_trigger' });
});
test('exact native v2 hit does not invent usage', async (t) => {
  const e = await setup(t, async () => ({ output: [native.output[0]] }));
  await prepare(e);
  const p = await e.plan(
    { ...body, input: [...input, { type: 'compaction_trigger' }] },
    headers,
    'test',
    { isCompact: true, v2: true },
  );
  assert.deepEqual(p.fastOutput, [native.output[0]]);
  assert.equal(p.usage, undefined);
});
test('incomplete tool groups stay recent', () => {
  const call = { type: 'function_call', call_id: 'a', arguments: '{}' };
  const result = { type: 'function_call_output', call_id: 'a', output: 'ok' };
  assert.equal(safeCut([...input, call]), 2);
  assert.equal(safeCut([...input, call, result], 3), 2);
  assert.equal(safeCut([...input, call, result]), 4);
  assert.equal(safeCut([...input, result]), 2);
});
test('failed background generation leaves normal request intact', async (t) => {
  const e = await setup(t, async () => {
    throw Error('compact_http_500');
  });
  const s = await prepare(e);
  assert.equal(s.ready, null);
  assert.deepEqual((await e.plan(body, headers, 'test')).body, body);
  assert.equal(e.stats.errors, 1);
});
test('persistent cache works after restart without stored credentials', async (t) => {
  const e = await setup(t);
  const s = await prepare(e);
  const other = new CompactionEngine({ root: e.root, compact: async () => native });
  await other.init();
  assert.ok((await other.session(s.key)).ready);
  assert.deepEqual(
    (await other.plan(body, headers, 'test', { isCompact: true })).fastOutput,
    native.output,
  );
});
test('incremental preparation sends prior native window plus only new data', async (t) => {
  const requests = [];
  const e = await setup(t, async (b) => {
    requests.push(b);
    return native;
  });
  const s = await prepare(e);
  const delta = [message('user', 'New scope remains diagnosis only.')];
  await e.maybePrepare(s, [...input, ...delta], headers, 'test', body);
  assert.deepEqual(requests[1].input, [...native.output, ...delta]);
});
test('no session id means transparent passthrough', async (t) => {
  const e = await setup(t);
  await prepare(e);
  assert.deepEqual((await e.plan(body, {}, 'test')).body, body);
});
test('response ids are scoped and reconstructed before applying prepared context', async (t) => {
  const e = await setup(t);
  const s = await prepare(e);
  e.lastResponses.set('r', { key: s.key, items: input });
  const tail = [message('user', 'New')];
  const p = await e.plan({ ...body, input: tail, previous_response_id: 'r' }, headers, 'test', {
    isCompact: true,
  });
  assert.deepEqual(p.body.input, [...native.output, ...tail]);
  assert.equal(p.body.previous_response_id, undefined);
  const q = await e.plan(
    { ...body, input: tail, previous_response_id: 'unknown' },
    headers,
    'test',
    { isCompact: true },
  );
  assert.equal(q.applied, undefined);
});
test('semantic normalization ignores wire decoration, never content or call_id', () => {
  assert.equal(
    hash(
      normalize({
        ...input[0],
        id: 'm',
        status: 'completed',
        internal_chat_message_metadata_passthrough: {
          turn_id: 't',
          create_time: 1,
          content_item_kinds: ['unknown'],
        },
      }),
    ),
    hash(normalize(input[0])),
  );
  assert.notEqual(hash(normalize(input[0])), hash(normalize(message('user', 'changed'))));
  assert.equal(normalize({ type: 'function_call', call_id: 'x', id: 'f' }).call_id, 'x');
});
test('current dynamic tool declarations survive rewriting and never enter the summary', async (t) => {
  let sent;
  const e = await setup(t, async (b) => {
    sent = b;
    return native;
  });
  const key = e.identity(body, headers, 'test'),
    s = await e.session(key);
  s.lastUsage = 100;
  const extra = { type: 'additional_tools', tools: [{ name: 'old' }] };
  await e.maybePrepare(s, [extra, ...input], headers, 'test', body);
  assert.equal(s.ready.prefix.length, 2);
  assert.ok(!sent.input.some((i) => i.type === 'additional_tools'));
  const current = { type: 'additional_tools', tools: [{ name: 'current' }] };
  assert.deepEqual(
    (
      await e.plan({ ...body, input: [current, ...input] }, headers, 'test', {
        isCompact: true,
        v2: true,
      })
    ).body.input[0],
    current,
  );
});
test('assistant response turn metadata matches Codex retained history while unknown metadata is protected', () => {
  const a = {
    ...input[1],
    metadata: { turn_id: 'one' },
    internal_chat_message_metadata_passthrough: { create_time: 1, turn_id: 'one' },
  };
  const b = {
    ...input[1],
    internal_chat_message_metadata_passthrough: {
      turn_id: 'two',
      create_time: 2,
      content_item_kinds: ['unknown'],
    },
  };
  assert.equal(hash(normalize(a)), hash(normalize(b)));
  assert.notEqual(
    hash(normalize({ ...a, metadata: { important: 'different' } })),
    hash(normalize(b)),
  );
});
test('v2 keeps exact user instructions through repeated compaction and returns only native output to the v2 client', async (t) => {
  const requests = [],
    e = await setup(t, async (b) => {
      requests.push(b);
      return { nativeV2: true, output: [native.output[0]] };
    });
  const s = await prepare(e);
  const correction = message(
      'user',
      'Producción NO funciona. Pendiente: [Validar, Autorizar, Publicar].',
    ),
    ack = message('assistant', 'Recibido.');
  await e.maybePrepare(s, [...input, correction, ack], headers, 'test', body);
  assert.deepEqual((await e.store.read(join(e.root, 'cache', s.key + '.json'))).output, [
    input[0],
    correction,
    native.output[0],
  ]);
  assert.deepEqual(requests[1].input, [input[0], native.output[0], correction, ack]);
  const next = message('user', 'Conserva las dos referencias.');
  const normal = await e.plan(
    { ...body, input: [...input, correction, ack, next] },
    headers,
    'test',
  );
  assert.deepEqual(normal.body.input, [...input, correction, ack, next]);
  assert.equal(normal.applied, undefined);
  const compact = await e.plan({ ...body, input: [...input, correction, ack] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  assert.deepEqual(compact.fastOutput, [native.output[0]]);
});

test('v2 tolerates refreshed runtime instructions and uses only their current contents', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  const s = await e.session(e.identity(body, headers, 'test'));
  s.lastUsage = 100;
  await e.maybePrepare(
    s,
    [message('developer', 'Old runtime instructions'), ...input],
    headers,
    'test',
    body,
  );
  const current = [
    message('developer', 'Current runtime instructions'),
    input[0],
    message('system', 'New runtime context'),
    input[1],
  ];
  const fast = await e.plan({ ...body, input: current }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  assert.deepEqual(fast.fastOutput, [native.output[0]]);
  const regular = await e.plan({ ...body, input: current }, headers, 'test');
  assert.deepEqual(regular.body.input, current);
  assert.equal(regular.applied, undefined);
  assert.ok(!JSON.stringify(regular.body.input).includes('Old runtime instructions'));
  const v1 = await e.plan({ ...body, input: current }, headers, 'test', { isCompact: true });
  assert.deepEqual(v1.fastOutput, [current[0], input[0], current[2], native.output[0]]);
});

test('v2 still rejects another conversation branch, account, chat, model or top-level instructions', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  await prepare(e);
  for (const [b, h] of [
    [{ ...body, input: [message('user', 'A different user request'), input[1]] }, headers],
    [{ ...body, input: [input[0], message('assistant', 'An edited assistant response')] }, headers],
    [{ ...body, model: 'other' }, headers],
    [{ ...body, instructions: 'other' }, headers],
    [body, { ...headers, authorization: 'Bearer other' }],
    [body, { ...headers, session_id: 'other' }],
    [body, { ...headers, 'chatgpt-account-id': 'other' }],
  ]) {
    const p = await e.plan(b, h, 'test', { isCompact: true, v2: true });
    assert.equal(p.fastOutput, undefined);
    assert.equal(p.applied, undefined);
  }
});

test('tool wire ids may change; call ids, results and item references remain protected', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  const s = await e.session(e.identity(body, headers, 'test'));
  s.lastUsage = 100;
  const call = {
    type: 'function_call',
    id: 'generated-1',
    call_id: 'call-1',
    name: 'exec_command',
    arguments: '{"cmd":"pwd"}',
    status: 'completed',
  };
  const result = {
    type: 'function_call_output',
    id: 'generated-2',
    call_id: 'call-1',
    output: 'RESULT_91',
  };
  await e.maybePrepare(s, [...input, call, result], headers, 'test', body);
  const replay = [
    ...input,
    { ...call, id: undefined, status: undefined },
    { ...result, id: undefined },
  ];
  assert.deepEqual(
    (await e.plan({ ...body, input: replay }, headers, 'test', { isCompact: true, v2: true }))
      .fastOutput,
    [native.output[0]],
  );
  for (const changed of [
    { ...result, output: 'DIFFERENT' },
    { ...result, call_id: 'different' },
  ])
    assert.equal(preparedMatch([...input, call, changed], s.ready), null);
  assert.notEqual(
    hash(normalize({ type: 'item_reference', id: 'one' })),
    hash(normalize({ type: 'item_reference', id: 'two' })),
  );
});

test('new user instructions allow v2 fast path because Codex retains them', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  await prepare(e);
  const p = await e.plan(
    { ...body, input: [...input, message('user', 'NEW_RULE_73: do not publish')] },
    headers,
    'test',
    { isCompact: true, v2: true },
  );
  assert.deepEqual(p.fastOutput, [native.output[0]]);
});

test('native v2 drops recent assistant/tool output; the next inference recovers it without a foreground model call', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  await prepare(e);
  const tail = [
    message('user', 'Preserve this recent correction'),
    message('assistant', 'NEW_FINDING_72'),
    { type: 'function_call', call_id: 'recent', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'recent', output: 'RECENT_RESULT_33' },
  ];
  const p = await e.plan({ ...body, input: [...input, ...tail] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  assert.deepEqual(p.fastOutput, [native.output[0]]);
  assert.equal(p.applied, undefined);
  const next = message('user', 'What was the exact result?'),
    declarations = { type: 'additional_tools', tools: [{ name: 'current' }] };
  const replay = [...retainedV2Input([...input, ...tail]), ...p.fastOutput, next];
  const restored = await e.plan({ ...body, input: [declarations, ...replay] }, headers, 'test');
  assert.deepEqual(restored.body.input, [declarations, input[0], native.output[0], ...tail, next]);
  assert.equal(e.stats.prepared, 1);
  // Subsequent delta requests already include the recovered suffix in their base.
  e.lastResponses.set('response-restored', { key: restored.key, items: restored.logical });
  const delta = await e.plan(
    { ...body, previous_response_id: 'response-restored', input: [message('user', 'Continue')] },
    headers,
    'test',
  );
  assert.equal(delta.logical.filter((i) => i.call_id === 'recent').length, 2);
});

test('saved recent context survives worker replacement, model changes and refreshed credentials', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  await prepare(e);
  const tail = [message('assistant', 'Only assistant knows RESULT_96')];
  const p = await e.plan({ ...body, input: [...input, ...tail] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  const replacement = new CompactionEngine({
    root: join(e.root, 'replacement'),
    tailRoot: e.tailRoot,
    compact: async () => {
      throw Error('must not call model');
    },
  });
  await replacement.init();
  t.after(() => replacement.stop());
  const replay = [input[0], ...p.fastOutput, message('user', 'Recall the result')];
  const restored = await replacement.plan(
    { ...body, model: 'other-model', instructions: 'updated', input: replay },
    { ...headers, authorization: 'Bearer refreshed' },
    'test',
  );
  assert.deepEqual(restored.body.input, [input[0], native.output[0], ...tail, replay.at(-1)]);
});

test('tail recovery rejects another thread, upstream, edited user history or different opaque summary', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  await prepare(e);
  await e.plan(
    { ...body, input: [...input, message('assistant', 'PRIVATE_RECENT_EVIDENCE')] },
    headers,
    'test',
    { isCompact: true, v2: true },
  );
  for (const [items, h, upstream] of [
    [[input[0], native.output[0]], { ...headers, session_id: 'another-chat' }, 'test'],
    [[input[0], native.output[0]], headers, 'another-upstream'],
    [[message('user', 'Edited request'), native.output[0]], headers, 'test'],
    [[input[0], { ...native.output[0], encrypted_content: 'different' }], headers, 'test'],
  ]) {
    const request = { ...body, input: items };
    assert.strictEqual((await e.plan(request, h, upstream)).body, request);
  }
});

test('ambiguous, incomplete or oversized recent history falls back to full native compaction', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  await prepare(e);
  await e.plan(
    { ...body, input: [...input, message('assistant', 'first tail')] },
    headers,
    'test',
    { isCompact: true, v2: true },
  );
  for (const tail of [
    [message('assistant', 'different tail')],
    [{ type: 'function_call', call_id: 'unfinished', name: 'exec_command', arguments: '{}' }],
    [message('assistant', 'x'.repeat(65537))],
  ]) {
    const p = await e.plan({ ...body, input: [...input, ...tail] }, headers, 'test', {
      isCompact: true,
      v2: true,
    });
    assert.equal(p.fastOutput, undefined);
    assert.equal(p.applied, true);
    assert.deepEqual(p.body.input, [
      input[0],
      native.output[0],
      ...tail,
      { type: 'compaction_trigger' },
    ]);
  }
});

test('large completed tool results survive a fast compaction when the prepared prefix substantially shrinks the window', async (t) => {
  let calls = 0;
  const e = await setup(t, async () => {
    calls++;
    return { nativeV2: true, output: [native.output[0]] };
  });
  const source = [input[0], message('assistant', 'prior history '.repeat(180000))];
  const s = await e.session(e.identity(body, headers, 'test'));
  s.lastUsage = 100;
  await e.maybePrepare(s, source, headers, 'test', body);
  const tail = [
    {
      type: 'custom_tool_call',
      call_id: 'large-result',
      name: 'exec',
      input: 'completed-operation',
    },
    {
      type: 'custom_tool_call_output',
      call_id: 'large-result',
      output: 'RESULTS_ALREADY_OBTAINED: ' + 'evidence '.repeat(165000),
    },
  ];
  const p = await e.plan({ ...body, input: [...source, ...tail] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  assert.deepEqual(p.fastOutput, [native.output[0]]);
  const replacement = new CompactionEngine({
    root: e.root,
    compact: () => {
      throw Error('must not wait for a new summary');
    },
  });
  await replacement.init();
  t.after(() => replacement.stop());
  const next = await replacement.plan(
    { ...body, input: [input[0], ...p.fastOutput] },
    headers,
    'test',
  );
  assert.deepEqual(next.body.input, [input[0], native.output[0], ...tail]);
  assert.equal(calls, 1);
});

test('failure to persist the tail never acknowledges a lossy fast compaction', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  await prepare(e);
  e.tailRoot = join(e.root, 'missing', 'directory');
  const tail = [message('assistant', 'Must remain in the foreground request')];
  const p = await e.plan({ ...body, input: [...input, ...tail] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  assert.equal(p.fastOutput, undefined);
  assert.deepEqual(p.body.input, [
    input[0],
    native.output[0],
    ...tail,
    { type: 'compaction_trigger' },
  ]);
});

test('native Codex may move and refresh tagged AGENTS/environment user items after compacting', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  const context = (text) => ({
    ...message('user', text),
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['agents_md.instructions', 'environments.environment_context'],
    },
  });
  const old = context('Old runtime user context'),
    current = context('Updated runtime user context');
  const s = await e.session(e.identity(body, headers, 'test'));
  s.lastUsage = 100;
  await e.maybePrepare(s, [old, ...input], headers, 'test', body);
  const correction = message('user', 'Recent correction'),
    tail = [correction, message('assistant', 'Recent finding')];
  const p = await e.plan({ ...body, input: [old, ...input, ...tail] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  const restored = await e.plan(
    {
      ...body,
      input: [input[0], current, correction, ...p.fastOutput, message('user', 'Continue')],
    },
    headers,
    'test',
  );
  assert.deepEqual(restored.body.input, [
    input[0],
    current,
    native.output[0],
    ...tail,
    message('user', 'Continue'),
  ]);
  assert.ok(!JSON.stringify(restored.body.input).includes('Old runtime user context'));
});

test('dropping generated Page snapshots preserves an in-flight correction across native replay and worker replacement', async (t) => {
  let modelCalls = 0;
  const e = await setup(t, async () => {
    modelCalls++;
    return { nativeV2: true, output: [native.output[0]] };
  });
  const page = (id) => ({
    ...message(
      'user',
      `<external_codex_apps_open_page>${JSON.stringify({ page_id: id })}</external_codex_apps_open_page>`,
    ),
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['additional_content.codex_apps_open_page'],
    },
  });
  const correction = message(
    'user',
    'Reset only the 16 historical zeros; preserve current submissions.',
  );
  const source = [page(null), ...input, page('old-page'), correction];
  const s = await e.session(e.identity(body, headers, 'test'));
  s.lastUsage = 100;
  await e.maybePrepare(s, source, headers, 'test', body);
  const tail = [
    {
      type: 'custom_tool_call',
      call_id: 'apply-correction',
      name: 'exec',
      input: 'apply-approved-correction',
    },
    {
      type: 'custom_tool_call_output',
      call_id: 'apply-correction',
      output: 'Running with session_id: 12981; read this process before repeating any write.',
    },
  ];
  const compact = await e.plan({ ...body, input: [...source, ...tail] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  assert.deepEqual(compact.fastOutput, [native.output[0]]);
  const replacement = new CompactionEngine({
    root: e.root,
    compact: async () => {
      throw Error('recovery must not regenerate the summary');
    },
  });
  await replacement.init();
  t.after(() => replacement.stop());
  const replay = [input[0], correction, ...compact.fastOutput];
  const restored = await replacement.plan({ ...body, input: replay }, headers, 'test');
  assert.deepEqual(restored.body.input, [input[0], correction, native.output[0], ...tail]);
  assert.equal(modelCalls, 1);
  const mixed = {
    ...page('mixed'),
    content: [{ type: 'input_text', text: 'Do not apply the correction.' }],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['additional_content.codex_apps_open_page', 'user.text'],
    },
  };
  // Generated and authored content together must remain part of the exact history.
  const mixedSource = [input[0], mixed, input[1]];
  await e.maybePrepare(s, mixedSource, headers, 'test', body, { force: true });
  await e.plan({ ...body, input: [...mixedSource, ...tail] }, headers, 'test', {
    isCompact: true,
    v2: true,
  });
  const omitted = { ...body, input: [input[0], native.output[0]] };
  assert.strictEqual((await e.plan(omitted, headers, 'test')).body, omitted);
});

test('runtime instruction refresh while Luna is busy does not discard the completed checkpoint', async (t) => {
  let finish;
  const e = await setup(
    t,
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const s = await e.session(e.identity(body, headers, 'test'));
  s.lastUsage = 100;
  const done = e.maybePrepare(
    s,
    [message('developer', 'Runtime version A'), ...input],
    headers,
    'test',
    body,
  );
  while (!finish) await new Promise((r) => setTimeout(r, 1));
  await e.plan(
    { ...body, input: [message('developer', 'Runtime version B'), ...input] },
    headers,
    'test',
  );
  finish({ nativeV2: true, output: [native.output[0]] });
  await done;
  assert.ok(s.ready);
  assert.equal(e.stats.discarded, 0);
  assert.equal(e.status().sessions[0].upToDate, true);
});

test('prepared summaries never rewrite ordinary full or incremental inference requests', async (t) => {
  const e = await setup(t, async () => ({ nativeV2: true, output: [native.output[0]] }));
  e.everyStep = true;
  const s = await prepare(e);
  s.ready.sourceChars = 100000;
  e.lastResponses.set('preserved-response', { key: s.key, items: input });
  const tail = [
    message('assistant', 'Still pending validation'),
    { type: 'function_call', call_id: 'live', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'live', output: 'UNVERIFIED evidence' },
    message('user', 'Continue'),
  ];
  for (const request of [
    { ...body, input: [...input, ...tail] },
    { ...body, input: tail, previous_response_id: 'preserved-response' },
  ]) {
    const before = JSON.stringify(request);
    const plan = await e.plan(request, headers, 'test');
    assert.strictEqual(plan.body, request);
    assert.equal(JSON.stringify(plan.body), before);
    assert.equal(plan.applied, undefined);
    assert.equal(plan.fastOutput, undefined);
  }
  assert.equal(e.stats.applied, 0);
  const compact = await e.plan(body, headers, 'test', { isCompact: true, v2: true });
  assert.deepEqual(compact.fastOutput, [native.output[0]]);
});
