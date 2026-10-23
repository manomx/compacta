import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, validateConfig, validateURL, atomicJSON } from '../config';
import { normalizeUsage, costFor, Ledger } from '../ledger';
import { parseCodex, parseClaude } from '../quotas';
import { Integrations, editRootString } from '../integrations';
import { safeClaudeCut, replaceClaudePrefix, ClaudeCompactor } from '../claude';

test('configuration rejects credential exfiltration, unsafe URLs and invalid limits', () => {
  const c = defaults();
  expect(validateConfig(c).codex.thresholdPercent).toBe(65);
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'file:///etc/passwd'])
    expect(() => validateURL(url)).toThrow();
  expect(validateURL('http://127.0.0.1:1234/v1')).toContain('127.0.0.1');
  c.providers[0].baseURL = 'https://evil.example';
  expect(() => validateConfig(c)).toThrow();
  const p = defaults();
  p.codex.thresholdPercent = 101;
  expect(() => validateConfig(p)).toThrow();
});
test('saved minimal effort and pasted model whitespace migrate before external compaction', () => {
  const c = defaults();
  c.codex.effort = 'minimal';
  c.codex.model = '  deepseek-v4.1-flash\n';
  c.providers.push({
    ...c.providers[0],
    id: 'external',
    auth: 'key',
    kind: 'compatible',
    baseURL: 'https://api.example.com/v1',
    model: ' deepseek-v4.1-flash ',
  });
  c.codex.providerID = 'external';
  const validated = validateConfig(c);
  expect(validated.codex.effort).toBe('low');
  expect(validated.codex.model).toBe('deepseek-v4.1-flash');
  expect(validated.providers.at(-1)!.model).toBe('deepseek-v4.1-flash');
  expect(c.codex.effort).toBe('minimal');
  for (const effort of ['low', 'medium', 'high']) {
    c.codex.effort = effort;
    expect(validateConfig(c).codex.effort).toBe(effort);
  }
  c.codex.model = ' \n ';
  expect(() => validateConfig(c)).toThrow('Escribe el identificador');
});
test('token normalization accounts for Anthropic caches without double-counting OpenAI input', () => {
  expect(
    normalizeUsage({
      input_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 20,
      output_tokens: 10,
    }),
  ).toEqual({ input: 170, output: 10, cached: 50, cacheWrite: 20, reported: true });
  expect(
    normalizeUsage({
      input_tokens: 170,
      input_tokens_details: { cached_tokens: 50 },
      output_tokens: 10,
    }).input,
  ).toBe(170);
  expect(normalizeUsage(null).reported).toBe(false);
});
test('estimated API cost charges cache rates; unknown price is not zero', () => {
  const u = normalizeUsage({
    input_tokens: 1000000,
    input_tokens_details: { cached_tokens: 500000 },
    output_tokens: 100000,
  });
  expect(
    costFor(u, { inputPrice: 2, outputPrice: 10, cachePrice: 0.2, cacheWritePrice: 2.5 }),
  ).toBeCloseTo(2.1);
  expect(costFor(u, { inputPrice: 2, outputPrice: null })).toBeNull();
  expect(costFor(normalizeUsage(null), defaults().providers[0])).toBeNull();
});
test('ledger persists deduplicated provider usage and separates background cost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compacta-ledger-'));
  let l = new Ledger(root);
  l.record({
    id: 'same',
    client: 'codex',
    kind: 'compaction',
    provider: defaults().providers[0],
    model: 'gpt-6-luna',
    usage: { input_tokens: 1000, output_tokens: 50 },
  });
  l.record({
    id: 'same',
    client: 'codex',
    kind: 'compaction',
    provider: null,
    model: 'gpt-6-luna',
    usage: { input_tokens: 1000 },
  });
  expect(l.totals().requests).toBe(1);
  expect(l.totals().models[0].kind).toBe('compaction');
  l.close();
  l = new Ledger(root);
  expect(l.totals().input).toBe(1000);
  l.close();
  await rm(root, { recursive: true });
});
test('quotas preserve unavailable versus zero and the provider reset time', () => {
  expect(parseCodex({})).toEqual([]);
  expect(parseClaude({ seven_day: null })).toEqual([]);
  expect(
    parseCodex({
      rate_limit: {
        secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1792564881 },
      },
    })[0].usedPercent,
  ).toBe(0);
  expect(
    parseClaude({ seven_day: { utilization: 52, resets_at: '2026-10-24T00:00:00Z' } })[0].resetsAt,
  ).toBe('2026-10-24T00:00:00Z');
});
test('editing Codex leaves unrelated keys, profiles and multiline content intact', () => {
  const initial =
    'model = "gpt-6-sol"\ncustom = """\n[not_a_real_table]\nopenai_base_url = ignored\n"""\n[features]\nfast = true\n';
  const changed = editRootString(initial, 'openai_base_url', 'http://127.0.0.1:4/key/v1');
  expect(changed).toContain('[not_a_real_table]');
  expect(changed).toContain('fast = true');
  expect(editRootString(changed, 'openai_base_url', null).trim()).toBe(initial.trim());
});
test('activating and disabling both clients preserves unrelated configuration changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compacta-integrations-')),
    home = join(root, 'home'),
    state = join(root, 'state');
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(state);
  await writeFile(
    join(home, '.codex/config.toml'),
    'model = "gpt-6-sol"\nopenai_base_url = "https://prior.example/v1"\n',
  );
  await atomicJSON(join(home, '.claude/settings.json'), {
    permissions: { allow: ['Read'] },
    env: { TEST: 'keep', ANTHROPIC_BASE_URL: 'https://prior.anthropic.example' },
  });
  const i = new Integrations(state, home);
  await i.init();
  await i.activateCodex('http://127.0.0.1:1234/key/codex/v1', {
    port: 1235,
    capability: 'abc',
    instance: 'id',
    version: '1',
  });
  await i.activateClaude('http://127.0.0.1:1234/key/claude');
  expect((await i.detect()).codex.active).toBe(true);
  const current = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'));
  current.permissions.allow.push('Edit');
  await atomicJSON(join(home, '.claude/settings.json'), current);
  await i.deactivateCodex();
  await i.deactivateClaude();
  expect(await readFile(join(home, '.codex/config.toml'), 'utf8')).toContain(
    'https://prior.example/v1',
  );
  const after = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'));
  expect(after.env.TEST).toBe('keep');
  expect(after.env.ANTHROPIC_BASE_URL).toBe('https://prior.anthropic.example');
  expect(after.permissions.allow).toContain('Edit');
  await rm(root, { recursive: true });
});
test('external client changes are not overwritten by deactivation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compacta-preserve-')),
    home = join(root, 'home');
  await mkdir(join(home, '.claude'), { recursive: true });
  const i = new Integrations(root, home);
  await i.init();
  await i.activateClaude('http://127.0.0.1:12/claude');
  await atomicJSON(join(home, '.claude/settings.json'), {
    env: { ANTHROPIC_BASE_URL: 'https://new.example' },
  });
  await i.deactivateClaude();
  expect(
    JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8')).env.ANTHROPIC_BASE_URL,
  ).toBe('https://new.example');
  await rm(root, { recursive: true });
});
test('legacy router can disable and re-enable without changing the Codex connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compacta-legacy-')),
    home = join(root, 'home'),
    legacy = join(home, '.codex/compactacion-anticipada');
  await mkdir(legacy, { recursive: true });
  const url = 'http://127.0.0.1:90/original/v1';
  await writeFile(join(home, '.codex/config.toml'), `openai_base_url = "${url}"\n`);
  await atomicJSON(join(legacy, 'deployment.json'), {
    localUrl: url,
    upstream: 'auto',
    originalBaseUrl: null,
  });
  await atomicJSON(join(legacy, 'route.json'), { port: 99 });
  const i = new Integrations(root, home);
  await i.init();
  const worker = { port: 100, capability: 'abc', instance: 'test', version: '1' };
  await i.activateCodex('http://ignored', worker);
  await i.deactivateCodex();
  expect(JSON.parse(await readFile(join(legacy, 'route.json'), 'utf8'))).toBeNull();
  await i.activateCodex('http://ignored', worker);
  expect(JSON.parse(await readFile(join(legacy, 'route.json'), 'utf8')).port).toBe(100);
  expect(await readFile(join(home, '.codex/config.toml'), 'utf8')).toContain(url);
  await rm(root, { recursive: true });
});
test('Claude cut never splits tool calls/results and retains the recent instructions', () => {
  const messages = [
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: '42' }] },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'Latest correction: do not publish' },
    { role: 'assistant', content: 'Understood' },
    { role: 'user', content: 'Continue' },
  ];
  expect(safeClaudeCut(messages, 4)).toBe(0);
  const cut = safeClaudeCut(messages, 2);
  expect(cut).toBe(4);
  const changed = replaceClaudePrefix({ messages, model: 'claude' }, cut, 'Prior finding');
  expect(JSON.stringify(changed)).toContain('Latest correction: do not publish');
  expect(changed.messages.at(-1)).toEqual(messages.at(-1));
});
test('Claude asynchronously prepares and applies only an exact conversation prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compacta-claude-'));
  const ledger = new Ledger(root);
  let calls = 0;
  const provider: any = {
    summarize: async () => {
      calls++;
      return { text: 'Exact evidence: row 42 is pending. Do not publish.' };
    },
  };
  const p = {
    ...defaults().claude,
    enabled: true,
    mode: 'continuous' as const,
    contextWindow: 1024,
    thresholdPercent: 1,
    keepRecent: 2,
    cooldownSeconds: 0,
    minDeltaTokens: 1,
  };
  const c = new ClaudeCompactor(join(root, 'cache'), provider, ledger, p, defaults().providers[1]);
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `Step ${i} `.repeat(20),
  }));
  const body = { messages, model: 'claude', metadata: { user_id: 'test' } };
  await c.plan(body, {});
  for (let j = 0; j < 30 && !c.prepared; j++) await Bun.sleep(5);
  expect(c.prepared).toBe(1);
  const next = await c.plan(body, {});
  expect(next.applied).toBe(true);
  expect(JSON.stringify(next.body)).toContain('row 42');
  const modified = structuredClone(body);
  modified.messages[0].content = 'Different request';
  const branch = await c.plan(modified, {});
  expect(branch.applied).not.toBe(true);
  expect(calls).toBeGreaterThan(0);
  c.close();
  for (let j = 0; j < 30 && c.active; j++) await Bun.sleep(5);
  ledger.close();
  await rm(root, { recursive: true });
});
