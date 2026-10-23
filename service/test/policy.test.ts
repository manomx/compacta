import { test, expect } from 'bun:test';
import { defaults } from '../config';
import { codexPolicyHash, externalCodexSummary } from '../policy';
import { hash } from '../native/engine.mjs';
import { Quotas } from '../quotas';

test('checkpoints reject old synthetic-user summaries and changes of external model', () => {
  const c = defaults(),
    p = c.codex,
    provider = c.providers[0];
  expect(codexPolicyHash(p, provider, p.model)).toBe(
    hash({ format: 6, compactionModel: p.model, compactionEffort: p.effort }),
  );
  expect(codexPolicyHash(p, provider, p.model)).not.toBe(
    hash({ format: 5, compactionModel: p.model, compactionEffort: p.effort }),
  );
  const external = {
    ...provider,
    id: 'local',
    kind: 'compatible' as const,
    auth: 'none' as const,
    baseURL: 'http://localhost:1234/v1',
  };
  const a = codexPolicyHash(p, external, provider.model);
  expect(codexPolicyHash({ ...p, model: 'another-model' }, external, provider.model)).not.toBe(a);
  expect(
    codexPolicyHash(p, { ...external, baseURL: 'http://localhost:5678/v1' }, provider.model),
  ).not.toBe(a);
  expect(a).not.toBe(
    hash({
      format: 6,
      compactionModel: provider.model,
      compactionEffort: p.effort,
      summarizer: {
        id: external.id,
        kind: external.kind,
        auth: external.auth,
        baseURL: external.baseURL,
        model: p.model,
        summaryTokens: p.summaryTokens,
        extraHeaders: external.extraHeaders,
      },
    }),
  );
});

test('external summaries preserve opaque native context and latest corrections', async () => {
  const envelope = { type: 'compaction', encrypted_content: 'opaque-context' };
  const correction = { role: 'user', content: 'Do not publish. Exact reference 731.' };
  let seen: any[] = [];
  const result = await externalCodexSummary(
    { model: 'native', input: [envelope, correction] },
    async (items) => {
      seen = items;
      return { text: 'Do not publish. Exact reference 731.' };
    },
  );
  expect(seen).toEqual([correction]);
  expect(result.input[0]).toEqual(envelope);
  expect(result.input[1]).toEqual(correction);
  expect(result.input[2].role).toBe('assistant');
  expect(result.input[2].content[0].type).toBe('output_text');
  expect(result.input[2].content[0].text).toContain('Exact reference 731');
});

test('external conversion keeps original instructions and encrypts assistant/tool evidence', async () => {
  const original = [
    { type: 'message', role: 'developer', content: 'Retain all constraints.' },
    { role: 'user', content: 'Inspect only.' },
    { type: 'compaction', encrypted_content: 'prior-state' },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Assistant evidence A731' }],
    },
    { type: 'function_call', call_id: 'read1', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'read1', output: 'Tool evidence T992' },
  ];
  let seen: any[] = [];
  const result = await externalCodexSummary({ input: original }, async (items) => {
    seen = items;
    return { text: 'Assistant A731; tool T992. Inspect only.' };
  });
  expect(result.input.slice(0, 3)).toEqual(original.slice(0, 3));
  expect(seen).toEqual(original.filter((i) => i.type !== 'compaction'));
  expect(result.input.at(-1)).toEqual({
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: 'Prior conversation handoff prepared by the selected summarizer:\nAssistant A731; tool T992. Inspect only.',
      },
    ],
  });
  expect(result.input.filter((i: any) => i.role === 'user')).toEqual(
    original.filter((i) => i.role === 'user'),
  );
  expect(result.input.some((i: any) => i.type === 'function_call')).toBe(false);
  const opaque = { input: [original[2]] };
  expect(
    await externalCodexSummary(opaque, async () => {
      throw Error('must not summarize opaque content');
    }),
  ).toBe(opaque);
});

test('quota polling obeys the configured interval without contacting accounts early', async () => {
  let attempts = 0;
  const vault: any = {
    codex: async () => {
      attempts++;
      throw Error('no account');
    },
    claude: async () => {
      attempts++;
      throw Error('no account');
    },
  };
  const q = new Quotas(vault);
  q.lastAttempt = Date.now() - 70000;
  await q.refresh(false, 120000);
  expect(attempts).toBe(0);
  await q.refresh(false, 60000);
  expect(attempts).toBe(2);
});
