import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, link, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SnapshotStore } from './storage.mjs';

export const hash = (x) =>
  createHash('sha256')
    .update(typeof x === 'string' ? x : stable(x))
    .digest('hex');
export function stable(x) {
  if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
  if (x && typeof x === 'object')
    return (
      '{' +
      Object.keys(x)
        .sort()
        .filter((k) => x[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + stable(x[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(x);
}
export const clone = (x) => JSON.parse(JSON.stringify(x));
export function normalize(item) {
  const x = { ...item };
  // These fields describe transport, not conversational contents. call_id is never removed.
  delete x.status;
  // Codex strips response metadata on replay for reasoning and tools as well
  // as messages. Empty reasoning content may be absent, null, or []. Neither is a
  // change to the conversation; encrypted content and call_id stay exact.
  for (const field of ['metadata', 'internal_chat_message_metadata_passthrough']) {
    if (x[field] && typeof x[field] === 'object' && !Array.isArray(x[field])) {
      x[field] = { ...x[field] };
      for (const key of ['turn_id', 'create_time', 'content_item_kinds']) delete x[field][key];
      if (!Object.keys(x[field]).length) delete x[field];
    }
  }
  if (
    x.type === 'reasoning' &&
    (x.content === null || (Array.isArray(x.content) && x.content.length === 0))
  )
    delete x.content;
  // Codex may omit server-generated item ids when replaying a completed output.
  // An item_reference id, unlike these ids, is the actual referenced content.
  if (
    [
      'function_call',
      'custom_tool_call',
      'function_call_output',
      'custom_tool_call_output',
      'reasoning',
      'compaction',
    ].includes(x.type)
  )
    delete x.id;
  if (x.type === 'message' || x.role) {
    x.type = 'message';
    delete x.id;
    delete x.end_turn;
    if (typeof x.content === 'string') x.content = [{ type: 'input_text', text: x.content }];
    if (Array.isArray(x.content))
      x.content = x.content.map((b) => {
        if (b.type === 'output_text' || b.type === 'input_text')
          return { type: 'input_text', text: b.text };
        return { ...b };
      });
  }
  return x;
}
export const fingerprints = (items) => items.map((i) => hash(normalize(i)));
// Tool declarations are request-time capabilities, not transcript history. Reinsert the
// CURRENT declarations unchanged on every rewritten request; never summarize or reuse old ones.
export const cleanInput = (input) =>
  input.filter((i) => i?.type !== 'compaction_trigger' && i?.type !== 'additional_tools');
// Native Codex v2 compaction summarizes assistant/tool history and expects the
// client to retain user and developer messages. Its opaque item alone is NOT a
// replacement for those instructions. Keep them verbatim, in original order.
export const isRetainedV2Item = (i) =>
  (['message', undefined].includes(i.type) && ['user', 'developer', 'system'].includes(i.role)) ||
  i.type === 'agent_message';
export const retainedV2Input = (items) => items.filter(isRetainedV2Item);
const isRuntimeInstruction = (i) =>
  ['message', undefined].includes(i.type) && ['developer', 'system'].includes(i.role);
// Native Codex relocates AGENTS/environment and drops generated goal context
// when replacing history. Keep CURRENT runtime items without mistaking these
// transport changes for a different branch of the real user conversation.
const isReplayRuntime = (i) => {
  if (isRuntimeInstruction(i)) return true;
  const kinds = i.internal_chat_message_metadata_passthrough?.content_item_kinds;
  return (
    i.role === 'user' &&
    Array.isArray(kinds) &&
    kinds.length > 0 &&
    kinds.every((k) =>
      [
        'agents_md.instructions',
        'environments.environment_context',
        'goal.internal_context',
        // Codex drops these generated Page snapshots during native replay.
        // They identify the current UI, not a user instruction or history branch.
        'additional_content.codex_apps_open_page',
      ].includes(k),
    )
  );
};
// Codex removes its own interruption marker from replacement history. Keep
// the warning in saved recent steps, but do not use it as a replay cursor.
// Authored text that happens to contain the same tag is still protected.
const isReplayControl = (i) => {
  const kinds = i.internal_chat_message_metadata_passthrough?.content_item_kinds;
  return (
    i.role === 'user' &&
    Array.isArray(kinds) &&
    kinds.length > 0 &&
    kinds.every((k) => k === 'generic.turn_aborted')
  );
};
const isReplayAnchor = (i) => isRetainedV2Item(i) && !isReplayRuntime(i) && !isReplayControl(i);
export const retainedReplayFingerprints = (items) =>
  items.filter(isReplayAnchor).map((item) => {
    const x = normalize(item);
    // Replacement history adds `original` or `high` to the same image bytes.
    // Resolution is transport metadata; image contents and authored text stay exact.
    if (Array.isArray(x.content))
      for (const block of x.content) if (block.type === 'input_image') delete block.detail;
    return hash(x);
  });
export const conversationFingerprints = (items) =>
  fingerprints(items.filter((i) => !isRuntimeInstruction(i)));
export function completesTurn(response) {
  if (response.status && response.status !== 'completed') return false;
  const output = response.output || [];
  if (output.some((i) => ['function_call', 'custom_tool_call'].includes(i.type))) return false;
  const last = output.findLast((i) => i.role === 'assistant' && (i.type === 'message' || !i.type));
  return (
    !!last &&
    (last.phase === 'final_answer' || (!last.phase && (!last.channel || last.channel === 'final')))
  );
}
function changedFields(a, b, path = '') {
  if (stable(a) === stable(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object')
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .flatMap((k) => changedFields(a[k], b[k], path + '/' + k))
      .slice(0, 12);
  return [path || '/'];
}
function diagnosticValue(value) {
  if (typeof value === 'string' && value.length > 256) return '[sha256:' + hash(value) + ']';
  if (Array.isArray(value)) return value.map(diagnosticValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, diagnosticValue(v)]));
  return value;
}
export function mismatchDetails(items, prepared, source = []) {
  const current = items.filter((i) => !isRuntimeInstruction(i)),
    previous = source.filter((i) => !isRuntimeInstruction(i));
  const expected = prepared?.conversationPrefix || [];
  for (let i = 0; i < expected.length; i++) {
    if (!current[i])
      return {
        reason: 'history_shortened',
        index: i,
        expectedItems: expected.length,
        actualItems: current.length,
      };
    if (expected[i] !== hash(normalize(current[i])))
      return {
        reason: 'item_changed',
        index: i,
        type: current[i].type,
        role: current[i].role,
        fields: previous[i]
          ? changedFields(
              diagnosticValue(normalize(previous[i])),
              diagnosticValue(normalize(current[i])),
            )
          : [],
        expectedHash: expected[i],
        actualHash: hash(normalize(current[i])),
      };
  }
  return { reason: 'incomplete_tool_group', safeItems: safeCut(items), actualItems: items.length };
}
const CALLS = new Set(['function_call', 'custom_tool_call']);
const RESULTS = new Set(['function_call_output', 'custom_tool_call_output']);
export function safeCut(items, desired = items.length) {
  let cut = Math.min(desired, items.length);
  const groups = new Map();
  items.forEach((x, i) => {
    if (x.call_id && (CALLS.has(x.type) || RESULTS.has(x.type))) {
      const g = groups.get(x.call_id) || { calls: [], results: [] };
      g[CALLS.has(x.type) ? 'calls' : 'results'].push(i);
      groups.set(x.call_id, g);
    }
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of groups.values()) {
      const all = [...g.calls, ...g.results];
      const first = Math.min(...all);
      if (first >= cut) continue;
      if (
        g.calls.length !== 1 ||
        g.results.length === 0 ||
        Math.min(...g.results) < g.calls[0] ||
        all.some((i) => i >= cut)
      ) {
        if (first < cut) {
          cut = first;
          changed = true;
        }
      }
    }
  }
  return cut;
}
export function prefixMatches(items, prepared) {
  if (!prepared || prepared.prefix.length > items.length) return false;
  return prepared.prefix.every((v, i) => v === hash(normalize(items[i])));
}
// A whole-history gate can reject usable v2 summaries when Codex refreshes
// developer/system instructions. Those instructions are retained by the client,
// not replaced by the opaque summary. Compare conversation content and reinsert
// the CURRENT instructions verbatim. Changed user/assistant/tool content still
// cannot reuse a checkpoint from another history branch.
export function preparedMatch(items, prepared) {
  if (!prepared) return null;
  // After Codex applies this checkpoint, its encrypted item is the durable
  // cursor for the next turn. Continue the chain from it, with the exact retained
  // user history; the expanded transcript need not be reconstructed.
  if (prepared.nativeV2 && prepared.nativeOutput?.length === 1) {
    const summary = hash(normalize(prepared.nativeOutput[0]));
    const retained = retainedReplayFingerprints;
    for (let i = items.length - 1; i >= 0; i--)
      if (items[i].type === 'compaction' && hash(normalize(items[i])) === summary) {
        if (
          hash(retained(items.slice(0, i))) ===
          hash(prepared.retainedReplayPrefix || retained(prepared.output))
        ) {
          let cut = i + 1;
          if (
            prepared.externalHandoff &&
            items[cut] &&
            hash(normalize(items[cut])) === hash(normalize(prepared.externalHandoff))
          )
            cut++;
          return { cut };
        }
      }
  }
  if (!prepared.nativeV2 || !Array.isArray(prepared.conversationPrefix)) {
    return prefixMatches(items, prepared) &&
      safeCut(items, prepared.prefix.length) === prepared.prefix.length
      ? { cut: prepared.prefix.length }
      : null;
  }
  const expected = prepared.conversationPrefix;
  let covered = 0,
    cut = 0;
  while (cut < items.length) {
    if (isRuntimeInstruction(items[cut])) {
      cut++;
      continue;
    }
    if (covered === expected.length) break;
    if (expected[covered] !== hash(normalize(items[cut]))) return null;
    covered++;
    cut++;
  }
  return covered === expected.length && safeCut(items, cut) === cut ? { cut } : null;
}
function preparedWindow(items, prepared, cut) {
  return [
    ...clone(
      prepared.nativeV2
        ? [
            ...retainedV2Input(items.slice(0, cut)),
            ...(prepared.nativeOutput || prepared.output),
            ...(prepared.externalHandoff ? [prepared.externalHandoff] : []),
          ]
        : prepared.output,
    ),
    ...items.slice(cut),
  ];
}
export async function atomicJSON(path, data) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await rename(tmp, path);
}
function residentCheckpoint(ready) {
  if (!ready?.nativeV2 || !ready.nativeOutput) return ready;
  return {
    ...ready,
    retainedReplayPrefix: ready.retainedReplayPrefix || retainedReplayFingerprints(ready.output),
    output: [],
  };
}

export class CompactionEngine {
  constructor({
    root,
    tailRoot = join(root, 'tails'),
    compact,
    log = () => {},
    thresholdTokens = 60000,
    minDeltaChars,
    cooldownMs,
    maxSessions = 24,
    enabled = true,
    everyStep = false,
    compactionModel = null,
    compactionEffort = null,
    maxConcurrent = 0,
    maxPerSession = 1,
    waitForPending = true,
  }) {
    minDeltaChars ??= everyStep ? 1 : 50000;
    cooldownMs ??= everyStep ? 0 : 30000;
    Object.assign(this, {
      root,
      compact,
      log,
      thresholdTokens,
      minDeltaChars,
      cooldownMs,
      maxSessions,
      enabled,
      everyStep,
      compactionModel,
      compactionEffort,
      waitForPending,
    });
    this.tailRoot = tailRoot;
    this.store = new SnapshotStore(root);
    // Zero means no global limit; each chat still has one ordered summary chain.
    this.maxConcurrent =
      Number.isSafeInteger(maxConcurrent) && maxConcurrent >= 0 ? maxConcurrent : 0;
    this.maxPerSession = 1;
    // Older checkpoints contain a synthetic user instruction that could cancel
    // the real task. Rebuild them from the actual conversation after upgrading.
    this.policy = hash({ format: 6, compactionModel, compactionEffort });
    this.closed = false;
    this.sessions = new Map();
    this.activeJobs = 0;
    this.lastResponses = new Map();
    this.stats = {
      prepared: 0,
      applied: 0,
      fastCompactions: 0,
      fallbacks: 0,
      errors: 0,
      queued: 0,
      coalesced: 0,
      discarded: 0,
      peakJobs: 0,
    };
  }
  async init() {
    await mkdir(join(this.root, 'cache'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'archive'), { recursive: true, mode: 0o700 });
    await mkdir(this.tailRoot, { recursive: true, mode: 0o700 });
  }
  identity(body, headers, upstream) {
    const thread =
      headers['thread-id'] ||
      headers['session_id'] ||
      headers['session-id'] ||
      headers['x-codex-thread-id'];
    if (!thread || typeof thread !== 'string' || !body.model) return null;
    // Auth is used only in a one-way digest; raw credentials are never written to disk.
    return hash({
      thread,
      upstream,
      model: body.model,
      instructions: body.instructions || '',
      auth: headers.authorization || '',
      account: headers['chatgpt-account-id'] || '',
    });
  }
  async session(key, threadId) {
    let s = this.sessions.get(key);
    if (s) {
      if (threadId) s.threadId = threadId;
      return s;
    }
    s = {
      key,
      threadId,
      ready: null,
      readySource: null,
      busy: false,
      lastStarted: 0,
      lastUsage: null,
      seenAt: Date.now(),
      jobs: new Map(),
      pending: null,
      sequence: 0,
      committed: 0,
      step: 0,
      latestPrefix: null,
      commit: Promise.resolve(),
      lastError: null,
      completedTurns: 0,
      completedResponseIds: new Set(),
      lastCompletedTurnId: null,
      waiters: 0,
    };
    // Register before the first await so concurrent observations share one state.
    this.sessions.set(key, s);
    s.loaded = (async () => {
      try {
        const d = await this.store.read(join(this.root, 'cache', key + '.json'));
        if (
          d.version === 2 &&
          d.policy === this.policy &&
          d.key === key &&
          Array.isArray(d.prefix) &&
          Array.isArray(d.output)
        ) {
          s.completedTurns = d.coveredTurns || 0;
          s.lastCompletedTurnId = d.coveredTurnId || null;
          const a = await this.store.read(join(this.root, 'archive', key + '.json'));
          if (a.created === d.created && Array.isArray(a.items)) {
            s.readyDiagnostic = a.items.map(diagnosticValue);
            // Recompute transport-independent coverage for checkpoints from 1.0.1.
            d.prefix = fingerprints(a.items);
            d.conversationPrefix = conversationFingerprints(a.items);
          }
          s.ready = residentCheckpoint(d);
        }
      } catch {}
    })();
    await s.loaded;
    if (this.sessions.size > this.maxSessions)
      for (const [k, v] of this.sessions) {
        if (k !== key && !v.jobs.size && !v.pending) {
          this.sessions.delete(k);
          break;
        }
      }
    return s;
  }
  async logicalInput(body, key) {
    if (!Array.isArray(body.input)) return null;
    if (body.previous_response_id) {
      let prev = this.lastResponses.get(body.previous_response_id);
      if (!prev) {
        const path = join(
          this.root,
          'responses',
          hash({ key, id: body.previous_response_id }) + '.json',
        );
        try {
          const saved = await this.store.read(path);
          if (
            saved.key !== key ||
            saved.id !== body.previous_response_id ||
            !Array.isArray(saved.items)
          )
            return null;
          return [...saved.items, ...cleanInput(body.input)];
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      }
      if (!prev || prev.key !== key) return null;
      if (prev.writing) await prev.writing;
      const items = prev.items || (await this.store.read(prev.path)).items;
      return [...items, ...cleanInput(body.input)];
    }
    return cleanInput(body.input);
  }
  tailScope(thread, upstream) {
    return hash({ thread, upstream });
  }
  async plan(body, headers, upstream, { isCompact = false, v2 = false } = {}) {
    const key = this.identity(body, headers, upstream);
    if (!key) return { body, key: null, logical: null };
    let logical = await this.logicalInput(body, key);
    if (!logical) return { body, key, logical: null };
    const threadId =
      headers['thread-id'] ||
      headers['session_id'] ||
      headers['session-id'] ||
      headers['x-codex-thread-id'];
    const s = await this.session(key, threadId);
    await s.loaded;
    s.seenAt = Date.now();
    const step = ++s.step;
    const tailScope = this.tailScope(threadId, upstream);
    const recovered = await this.restoreTail(logical, tailScope, key);
    if (recovered) {
      logical = recovered;
      const declarations = body.input.filter((i) => i?.type === 'additional_tools');
      body = {
        ...body,
        input: [...declarations, ...logical, ...(v2 ? [{ type: 'compaction_trigger' }] : [])],
      };
      delete body.previous_response_id;
    }
    s.latestLength = logical.length;
    s.latestInput = logical;
    s.latestPrefix = fingerprints(logical.slice(0, safeCut(logical)));
    if (!this.enabled) return { body, key, logical, step };
    // Background preparation must not replace the live conversation on normal turns.
    // Only an explicit native compaction may consume the prepared summary.
    if (!isCompact) {
      // A tool result is already complete before the next inference starts.
      // Prepare it while Codex works, without rewriting or delaying that request.
      if (this.everyStep) {
        const cut = safeCut(logical),
          lastResult = logical.slice(0, cut).findLastIndex((i) => RESULTS.has(i.type));
        const covered = preparedMatch(logical, s.ready)?.cut || 0;
        const queued = [...s.jobs.values(), s.pending]
          .filter(Boolean)
          .some((j) => prefixMatches(logical, j) && j.prefix.length > lastResult);
        if (lastResult >= covered && !queued)
          this.prepareInBackground(s, logical, headers, upstream, body, 'tool_results');
      }
      return { body, key, logical, step };
    }
    // Consume a usable checkpoint BEFORE waiting for the next background job.
    // Native v2 needs a durable, exact tail because it drops assistant/tool items.
    const immediate = await this.fastOutput(s, logical, v2, tailScope);
    if (immediate) return { body, key, logical, step, fastOutput: immediate };
    // Both manual and automatic compaction consume the same per-chat chain.
    // Finish existing work first; never race it with a foreground copy.
    const waiting = this.waitForPending
      ? await this.prepareThrough(s, logical, headers, upstream, body, { v2, tailScope })
      : { attempted: false };
    const preparationAttempted = waiting.attempted;
    if (waiting.output)
      return { body, key, logical, step, fastOutput: waiting.output, preparationAttempted };
    const ready = s.ready;
    const match = preparedMatch(logical, ready);
    if (match) {
      const tail = logical.slice(match.cut);
      const output = await this.fastOutput(s, logical, v2, tailScope);
      if (output) return { body, key, logical, step, fastOutput: output };
      const declarations = Array.isArray(body.input)
        ? body.input.filter((i) => i?.type === 'additional_tools')
        : [];
      const input = [...declarations, ...preparedWindow(logical, ready, match.cut)];
      if (v2) input.push({ type: 'compaction_trigger' });
      const modified = { ...body, input };
      delete modified.previous_response_id;
      this.stats.applied++;
      this.log('prepared_applied', {
        key,
        covered: match.cut,
        recent: tail.length,
        beforeItems: logical.length,
        afterItems: input.length,
      });
      if (isCompact && v2 && tail.some((i) => !isRetainedV2Item(i)))
        this.log('recent_history_needs_compaction', {
          key,
          recentItems: tail.length,
          reason: 'native_client_drops_assistant_tool_tail',
        });
      return { body: modified, key, logical, step, applied: true, preparationAttempted };
    }
    if (isCompact) {
      this.stats.fallbacks++;
      const details = ready
        ? mismatchDetails(logical, ready, s.readySource || [])
        : { reason: 'not_ready' };
      this.log('native_fallback', { key, threadId, ...details });
    }
    return { body, key, logical, step, preparationAttempted };
  }
  async fastOutput(s, logical, v2, tailScope) {
    const ready = s.ready,
      match = preparedMatch(logical, ready);
    if (!match) return;
    const tail = logical.slice(match.cut),
      nativeOutput = ready.nativeOutput || ready.output;
    const tailBytes = Buffer.byteLength(JSON.stringify(tail));
    // Large completed tool results can exceed 64 KiB even when the prepared
    // prefix removes most of a long chat. Persist that exact tail when the
    // reconstructed window still shrinks substantially, rather than waiting
    // for several queued model summaries to catch up.
    const recoverableTail =
      tailBytes <= 65536 ||
      (tailBytes <= 8 * 1024 * 1024 &&
        Buffer.byteLength(
          JSON.stringify([
            ...retainedV2Input(logical.slice(0, match.cut)),
            ...nativeOutput,
            ...(ready.externalHandoff ? [ready.externalHandoff] : []),
            ...tail,
          ]),
        ) <=
          Buffer.byteLength(JSON.stringify(logical)) * 0.75);
    const clientRetainsTail = v2 && ready.nativeV2 && tail.every(isRetainedV2Item);
    let canKeepTail =
      v2 &&
      ready.nativeV2 &&
      safeCut(logical) === logical.length &&
      nativeOutput.length === 1 &&
      nativeOutput[0].type === 'compaction' &&
      recoverableTail;
    if (canKeepTail && (ready.externalHandoff || tail.some((i) => !isRetainedV2Item(i)))) {
      try {
        await this.saveTail(
          tailScope,
          s.key,
          logical,
          match.cut,
          nativeOutput[0],
          ready.externalHandoff ? [ready.externalHandoff] : [],
        );
      } catch (error) {
        canKeepTail = false;
        this.log('recent_tail_save_failed', {
          key: s.key,
          reason: String(error.code || error.message).slice(0, 90),
        });
      }
    }
    if (
      (!v2 || !ready.externalHandoff || canKeepTail) &&
      (tail.length === 0 || clientRetainsTail || canKeepTail) &&
      (!v2 ||
        (ready.nativeV2
          ? nativeOutput.filter((i) => i.type === 'compaction').length === 1
          : nativeOutput.length === 1 && nativeOutput[0].type === 'compaction'))
    ) {
      if (!prefixMatches(logical, ready))
        this.log('prepared_reused_after_runtime_refresh', { key: s.key, covered: match.cut });
      this.stats.fastCompactions++;
      this.log('fast_compaction', {
        key: s.key,
        threadId: s.threadId,
        covered: match.cut,
        coveredTurns: ready.coveredTurns || 0,
        clientRetained: tail.filter(isRetainedV2Item).length,
        savedTail: canKeepTail ? tail.length : 0,
        savedTailBytes: canKeepTail ? tailBytes : 0,
        backgroundJobs: s.jobs.size,
      });
      return clone(v2 ? nativeOutput : preparedWindow(logical, ready, match.cut));
    }
  }
  prepareInBackground(s, history, headers, upstream, body, reason) {
    this.maybePrepare(s, history, headers, upstream, body, { reason }).catch(() => {
      this.stats.errors++;
      this.log('prepare_internal_error', { key: s.key });
    });
  }
  async prepareThrough(s, history, headers, upstream, body, { v2, tailScope }) {
    const cut = safeCut(history),
      source = history.slice(0, cut);
    const match = preparedMatch(source, s.ready);
    if (
      match &&
      (match.cut === cut || (s.ready.nativeV2 && source.slice(match.cut).every(isRetainedV2Item)))
    )
      return { attempted: false };
    const start = performance.now();
    s.waiters++;
    this.log('compaction_wait_started', {
      key: s.key,
      threadId: s.threadId,
      coveredTurns: s.ready?.coveredTurns || 0,
      completedTurns: s.completedTurns,
      pendingItems: match ? cut - match.cut : cut,
      activeJobs: s.jobs.size,
    });
    try {
      let output;
      // A running update may already shrink the remaining suffix enough. Check
      // after each completion before requesting another foreground update.
      this.drain();
      while (this.enabled && !this.closed && (s.jobs.size || s.pending)) {
        await Promise.race(
          s.jobs.size ? [...s.jobs.values()].map((j) => j.done) : [s.pending.done],
        );
        output = await this.fastOutput(s, history, v2, tailScope);
        if (output) break;
      }
      if (!output)
        await this.maybePrepare(s, source, headers, upstream, body, {
          force: true,
          reason: 'compaction_pending',
        });
      const ready = preparedMatch(source, s.ready);
      this.log('compaction_wait_finished', {
        key: s.key,
        threadId: s.threadId,
        milliseconds: Math.round(performance.now() - start),
        ready: !!output || ready?.cut === cut,
        coveredTurns: s.ready?.coveredTurns || 0,
      });
      return { attempted: true, output };
    } finally {
      s.waiters--;
    }
  }
  // Native v2 drops assistant/tool messages returned beside an opaque summary.
  // Save the exact unsummarized suffix before acknowledging compaction, then
  // restore it only when the client replays that summary and retained history.
  async saveTail(scope, key, logical, cut, summary, leading = []) {
    const retained = retainedReplayFingerprints;
    const record = {
      version: 2,
      scope,
      summary: hash(normalize(summary)),
      retained: retained(logical),
      prefixCount: retained(logical.slice(0, cut)).length,
      tail: clone([...leading, ...logical.slice(cut).filter((i) => !isReplayRuntime(i))]),
    };
    const id = hash({ scope, summary: record.summary, retained: record.retained });
    const path = join(this.tailRoot, id + '.json'),
      tmp = path + '.' + randomUUID() + '.tmp';
    // Publish only complete files, without replacing a competing checkpoint.
    // A changed tail with the same replay signature must use native compaction.
    await writeFile(tmp, JSON.stringify({ ...record, digest: hash(record) }), { mode: 0o600 });
    try {
      try {
        await link(tmp, path);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = JSON.parse(await readFile(path, 'utf8'));
        const { digest, ...saved } = existing;
        if (digest !== hash(saved) || hash({ ...saved, version: 2 }) !== hash(record))
          throw Error('ambiguous_tail_checkpoint');
      }
    } finally {
      await unlink(tmp);
    }
    this.log('recent_tail_saved', { key, items: record.tail.length });
  }
  async migrateLegacyTail(scope, key, summary, retained) {
    let archive, ready;
    try {
      archive = await this.store.read(join(this.root, 'archive', key + '.json'));
      ready = await this.store.read(join(this.root, 'cache', key + '.json'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (
      !Array.isArray(archive.items) ||
      archive.created !== ready.created ||
      ready.nativeOutput?.length !== 1 ||
      hash(normalize(ready.nativeOutput[0])) !== hash(normalize(summary))
    )
      return null;
    const legacyRetained = (items) =>
      fingerprints(items.filter((i) => isRetainedV2Item(i) && !isReplayRuntime(i)));
    const prefix = legacyRetained(archive.items);
    // Old records contain only fingerprints. The archived source must prove
    // every protected item before publishing a cursor in the new format.
    for (const name of await readdir(this.tailRoot)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = JSON.parse(await readFile(join(this.tailRoot, name), 'utf8'));
      if (
        record.version !== 1 ||
        record.scope !== scope ||
        record.summary !== hash(normalize(summary))
      )
        continue;
      const { digest, ...saved } = record;
      if (
        digest !== hash(saved) ||
        record.prefixCount !== prefix.length ||
        !Array.isArray(record.tail) ||
        !Array.isArray(record.retained) ||
        hash(record.retained.slice(0, record.prefixCount)) !== hash(prefix)
      )
        continue;
      const source = [...archive.items, ...record.tail];
      if (
        hash(legacyRetained(source)) !== hash(record.retained) ||
        hash(retainedReplayFingerprints(source)) !== hash(retained)
      )
        continue;
      await this.saveTail(scope, key, source, archive.items.length, summary);
      this.log('recent_tail_migrated', { key, items: record.tail.length });
      const id = hash({ scope, summary: record.summary, retained });
      return JSON.parse(await readFile(join(this.tailRoot, id + '.json'), 'utf8'));
    }
    return null;
  }
  async restoreTail(logical, scope, key) {
    for (let pos = logical.length - 1; pos >= 0; pos--) {
      if (logical[pos]?.type !== 'compaction') continue;
      const summary = hash(normalize(logical[pos]));
      const before = logical.slice(0, pos);
      if (before.some((i) => !isRetainedV2Item(i))) return null;
      const retained = retainedReplayFingerprints(before);
      const id = hash({ scope, summary, retained });
      let record;
      try {
        record = JSON.parse(await readFile(join(this.tailRoot, id + '.json'), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        record = await this.migrateLegacyTail(scope, key, logical[pos], retained);
        if (!record) return null;
      }
      const { digest, ...saved } = record;
      if (
        ![1, 2].includes(record.version) ||
        digest !== hash(saved) ||
        record.scope !== scope ||
        record.summary !== summary ||
        hash(record.retained) !== hash(retained) ||
        !Array.isArray(record.tail) ||
        !Number.isInteger(record.prefixCount) ||
        record.prefixCount < 0 ||
        record.prefixCount > retained.length
      )
        throw Error('invalid_saved_tail');
      const suffix = logical.slice(pos + 1);
      if (
        record.tail.length <= suffix.length &&
        hash(fingerprints(suffix.slice(0, record.tail.length))) === hash(fingerprints(record.tail))
      )
        return null;
      let rank = 0;
      const prefix = before.filter((i) => {
        if (!isReplayAnchor(i)) return true;
        return rank++ < record.prefixCount;
      });
      this.log('recent_tail_restored', { key, items: record.tail.length });
      return [...prefix, logical[pos], ...clone(record.tail), ...suffix];
    }
    return null;
  }
  async observe(plan, response, headers, upstream, originalBody) {
    if (
      !plan.key ||
      !plan.logical ||
      response.status === 'failed' ||
      response.status === 'incomplete'
    )
      return;
    const s = await this.session(plan.key);
    if (response.usage?.input_tokens != null) {
      s.lastUsage = response.usage.input_tokens;
      this.log('inference_usage', {
        key: plan.key,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        prepared: !!plan.applied,
      });
    }
    const output = Array.isArray(response.output) ? response.output : [];
    const history = [...plan.logical, ...output];
    if (response.id) {
      const path = join(this.root, 'responses', hash({ key: plan.key, id: response.id }) + '.json');
      const entry = { key: plan.key, path, items: history };
      this.lastResponses.set(response.id, entry);
      entry.writing = this.store
        .write(path, { key: plan.key, id: response.id, items: history })
        .then(() => {
          delete entry.items;
        })
        .catch(() => {
          // A disk failure keeps the in-memory fallback; it must never lose a turn.
          this.log('response_snapshot_save_failed', { key: plan.key });
        })
        .finally(() => {
          delete entry.writing;
        });
      while (this.lastResponses.size > 48) {
        const id = this.lastResponses.keys().next().value,
          old = this.lastResponses.get(id);
        this.lastResponses.delete(id);
        Promise.resolve(old.writing)
          .then(() => old.path && this.store.remove(old.path))
          .catch(() => {});
      }
    }
    if (plan.step != null && plan.step !== s.step) return;
    if (completesTurn(response)) {
      if (response.id && s.completedResponseIds.has(response.id)) return;
      if (response.id) {
        s.completedResponseIds.add(response.id);
        if (s.completedResponseIds.size > 64)
          s.completedResponseIds.delete(s.completedResponseIds.values().next().value);
      }
      const last = output.findLast((i) => i.role === 'assistant');
      s.completedTurns++;
      s.lastCompletedTurnId =
        last?.metadata?.turn_id ||
        last?.internal_chat_message_metadata_passthrough?.turn_id ||
        response.id ||
        String(s.completedTurns);
      this.log('turn_completed', {
        key: s.key,
        threadId: s.threadId,
        turnId: s.lastCompletedTurnId,
        completedTurns: s.completedTurns,
        items: history.length,
      });
      this.prepareInBackground(s, history, headers, upstream, originalBody, 'turn_completed');
    } else if (
      this.everyStep &&
      response.status === 'completed' &&
      output.some((i) => CALLS.has(i.type))
    ) {
      // Summarize completed progress, never a partial stream or an open tool group.
      const source = history.slice(0, safeCut(history));
      if (source.some((i) => !isRetainedV2Item(i) && i.type !== 'compaction'))
        this.prepareInBackground(s, history, headers, upstream, originalBody, 'inflight_step');
    }
  }
  async maybePrepare(
    s,
    history,
    headers,
    upstream,
    body,
    { force = false, reason = 'turn_completed' } = {},
  ) {
    if (!this.enabled || this.closed) return;
    await s.loaded;
    history = cleanInput(history);
    const cut = safeCut(history);
    if (cut < 1) return;
    const source = history.slice(0, cut);
    const prefix = fingerprints(source),
      signature = hash(conversationFingerprints(source));
    s.latestInput = history;
    s.latestPrefix = prefix;
    s.latestLength = history.length;
    const match = preparedMatch(source, s.ready);
    if (match?.cut === source.length) return;
    for (const j of s.jobs.values()) if (j.signature === signature) return j.done;
    if (s.pending?.signature === signature) return s.pending.done;
    const matches = !!match;
    const delta = matches ? source.slice(match.cut) : source;
    const deltaChars = JSON.stringify(delta).length;
    // Character counts only schedule work. They are never reported as token usage.
    if (
      !force &&
      !this.everyStep &&
      !s.ready &&
      (s.lastUsage ?? 0) < this.thresholdTokens &&
      deltaChars < this.thresholdTokens * 4
    )
      return;
    if (!force && s.ready && matches && deltaChars < this.minDeltaChars) return;
    const job = {
      policy: this.policy,
      sequence: ++s.sequence,
      signature,
      prefix,
      source,
      headers: { ...headers },
      upstream,
      model: body.model,
      instructions: body.instructions,
      coveredTurns: s.completedTurns,
      coveredTurnId: s.lastCompletedTurnId,
      reason,
      force,
    };
    job.done = new Promise((resolve) => (job.resolve = resolve));
    if (s.pending) {
      s.pending.resolve();
      this.stats.coalesced++;
    }
    s.pending = job;
    this.stats.queued++;
    this.drain();
    return job.done;
  }
  drain() {
    clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (this.closed || !this.enabled) return;
    let nextDelay = Infinity;
    // Give the next slot to the chat that has waited longest, rather than always
    // revisiting the first busy chat in insertion order.
    for (const s of [...this.sessions.values()].sort(
      (a, b) => (b.waiters || 0) - (a.waiters || 0) || a.lastStarted - b.lastStarted,
    )) {
      if (this.maxConcurrent > 0 && this.activeJobs >= this.maxConcurrent) break;
      if (!s.pending || s.jobs.size >= 1) continue;
      const remaining =
        s.waiters || s.pending.force ? 0 : s.lastStarted + this.cooldownMs - Date.now();
      if (remaining > 0) {
        nextDelay = Math.min(nextDelay, remaining);
        continue;
      }
      const job = s.pending;
      s.pending = null;
      s.jobs.set(job.sequence, job);
      s.busy = true;
      this.activeJobs++;
      this.stats.peakJobs = Math.max(this.stats.peakJobs, this.activeJobs);
      this.runJob(s, job).catch(() => {
        this.stats.errors++;
        this.log('prepare_internal_error', { key: s.key });
      });
    }
    if (Number.isFinite(nextDelay)) {
      this.wakeTimer = setTimeout(() => this.drain(), nextDelay);
      this.wakeTimer.unref();
    }
  }
  async runJob(s, job) {
    const { source, prefix, headers, upstream, sequence } = job,
      cut = source.length;
    const match = preparedMatch(source, s.ready),
      matches = !!match;
    const input = matches ? preparedWindow(source, s.ready, match.cut) : source;
    s.lastStarted = Date.now();
    const start = performance.now();
    try {
      if (match?.cut === cut) return;
      if (s.ready && !matches) {
        this.log('checkpoint_mismatch', {
          key: s.key,
          threadId: s.threadId,
          sequence,
          ...mismatchDetails(source, s.ready, s.readyDiagnostic || []),
        });
      }
      this.log('prepare_started', {
        key: s.key,
        threadId: s.threadId,
        sequence,
        covered: cut,
        requestItems: input.length,
        incremental: matches,
        model: this.compactionModel || job.model,
        effort: this.compactionEffort,
        concurrent: s.jobs.size,
        reason: job.reason,
        fromTurn: s.ready?.coveredTurns || 0,
        throughTurn: job.coveredTurns,
        turnId: job.coveredTurnId,
      });
      const response = await this.compact(
        {
          model: this.compactionModel || job.model,
          instructions: job.instructions,
          input,
          ...(this.compactionEffort ? { reasoning: { effort: this.compactionEffort } } : {}),
        },
        headers,
        upstream,
      );
      if (
        !Array.isArray(response.output) ||
        !response.output.length ||
        !response.output.some(
          (i) =>
            i?.type === 'compaction' &&
            typeof i.encrypted_content === 'string' &&
            i.encrypted_content.length > 0,
        )
      )
        throw Error('invalid_native_output');
      if (response.error || ['failed', 'incomplete', 'cancelled'].includes(response.status))
        throw Error('native_compaction_failed');
      const output = response.nativeV2
        ? [
            ...retainedV2Input(source),
            ...clone(response.output),
            ...(response.externalHandoff ? [clone(response.externalHandoff)] : []),
          ]
        : clone(response.output);
      const ready = {
        version: 2,
        policy: this.policy,
        key: s.key,
        threadId: s.threadId,
        created: new Date().toISOString(),
        prefix,
        conversationPrefix: conversationFingerprints(source),
        output,
        nativeOutput: clone(response.output),
        nativeV2: !!response.nativeV2,
        retainedReplayPrefix: retainedReplayFingerprints(source),
        ...(response.externalHandoff ? { externalHandoff: clone(response.externalHandoff) } : {}),
        nativeMs: Math.round(performance.now() - start),
        sourceChars: JSON.stringify(source).length,
        model: this.compactionModel || job.model,
        effort: this.compactionEffort,
        coveredTurns: job.coveredTurns,
        coveredTurnId: job.coveredTurnId,
      };
      // Serialize commits. An older parallel completion must never replace a newer
      // correction, and a result from an abandoned history branch must not commit.
      s.commit = s.commit
        .catch(() => {})
        .then(async () => {
          if (
            job.policy !== this.policy ||
            this.closed ||
            sequence < s.committed ||
            !preparedMatch(s.latestInput || source, ready)
          ) {
            this.stats.discarded++;
            this.log('prepare_superseded', { key: s.key, sequence });
            return;
          }
          await this.store.write(join(this.root, 'archive', s.key + '.json'), {
            version: 1,
            created: ready.created,
            items: source,
          });
          await this.store.write(join(this.root, 'cache', s.key + '.json'), ready);
          s.ready = residentCheckpoint(ready);
          s.readySource = null;
          s.readyDiagnostic = source.map(diagnosticValue);
          s.committed = sequence;
          s.lastError = null;
          this.stats.prepared++;
          this.log('prepare_ready', {
            key: s.key,
            threadId: s.threadId,
            sequence,
            covered: cut,
            nativeMs: ready.nativeMs,
            model: ready.model,
            effort: ready.effort,
            coveredTurns: ready.coveredTurns,
            turnId: ready.coveredTurnId,
          });
        });
      await s.commit;
    } catch (error) {
      s.lastError = String(error.code || error.message || 'error').slice(0, 90);
      this.stats.errors++;
      this.log('prepare_failed', {
        key: s.key,
        threadId: s.threadId,
        sequence,
        reason: s.lastError,
      });
    } finally {
      s.jobs.delete(sequence);
      s.busy = s.jobs.size > 0;
      this.activeJobs--;
      job.resolve();
      this.drain();
      this.releaseIdleMemory();
    }
  }
  stop() {
    this.closed = true;
    this.store.stopping = true;
    clearTimeout(this.wakeTimer);
    for (const s of this.sessions.values()) {
      s.pending?.resolve();
      s.pending = null;
    }
  }
  async flush() {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.commit));
    if (this.store.optimizing) await this.store.optimizing.catch(() => {});
    while (this.store.locks.size) await Promise.allSettled([...this.store.locks.values()]);
  }
  releaseIdleMemory(now = Date.now()) {
    let released = 0;
    for (const s of this.sessions.values()) {
      if (s.jobs.size || s.pending || s.waiters || now - s.seenAt < 30000) continue;
      if (s.latestInput) {
        s.latestMatch = preparedMatch(s.latestInput, s.ready);
        s.latestInput = null;
        s.readySource = null;
        released++;
      }
    }
    return released;
  }
  maintain() {
    this.releaseIdleMemory();
    if (!this.store.optimizing)
      this.store.optimize().catch(() => {
        this.store.stats.errors++;
      });
    if (this.store.stats.complete && Date.now() - (this.lastCollection || 0) > 3600000) {
      this.lastCollection = Date.now();
      this.store.collectGarbage().catch(() => {});
    }
  }
  status() {
    return {
      enabled: this.enabled,
      everyStep: this.everyStep,
      strategy: 'progressive_turn_chain',
      model: this.compactionModel,
      reasoningEffort: this.compactionEffort,
      maxConcurrent: this.maxConcurrent,
      maxPerSession: 1,
      ...this.stats,
      storage: this.store.stats,
      responseSnapshotsInMemory: [...this.lastResponses.values()].filter((r) => r.items).length,
      residentHistories: [...this.sessions.values()].filter((s) => s.latestInput).length,
      activeJobs: this.activeJobs,
      pendingSessions: [...this.sessions.values()].filter((s) => s.pending).length,
      sessions: [...this.sessions.values()].map((s) => {
        const match = s.latestInput
            ? preparedMatch(s.latestInput, s.ready)
            : s.latestMatch !== undefined
              ? s.latestMatch
              : s.ready
                ? { cut: s.ready.prefix.length }
                : null,
          valid = !!match;
        return {
          key: s.key,
          threadId: s.threadId,
          busy: s.busy,
          activeJobs: s.jobs.size,
          queued: !!s.pending,
          ready: valid,
          upToDate: valid && match.cut === s.latestLength,
          covered: valid ? match.cut : 0,
          nativeMs: valid ? s.ready.nativeMs : null,
          preparedAt: valid ? s.ready.created : null,
          lastError: s.lastError,
          lastInputTokens: s.lastUsage,
          completedTurns: s.completedTurns,
          coveredTurns: s.ready?.coveredTurns || 0,
          pendingTurns: Math.max(0, s.completedTurns - (s.ready?.coveredTurns || 0)),
          coveredTurnId: s.ready?.coveredTurnId || null,
          waitingForCompaction: s.waiters > 0,
        };
      }),
    };
  }
}
