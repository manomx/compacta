import { test, expect } from 'bun:test';
import { collectSSE, requireCompleteSummary } from '../providers';

test('truncated or failed summaries never replace conversation history', () => {
  for (const r of [
    { status: 'incomplete', output_text: 'partial' },
    { status: 'failed' },
    { error: { message: 'failed' } },
    { stop_reason: 'max_tokens', content: [] },
    { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] },
  ])
    expect(() => requireCompleteSummary(r)).toThrow();
  expect(() =>
    requireCompleteSummary({ status: 'completed', output_text: 'Complete summary' }),
  ).not.toThrow();
  expect(() => requireCompleteSummary({ stop_reason: 'end_turn', content: [] })).not.toThrow();
});

test('streaming Anthropic usage retains input and caches when output arrives later', async () => {
  const events = [
    {
      type: 'message_start',
      message: { id: 'id', usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
    },
    { type: 'content_block_delta', delta: { text: 'Summary' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ];
  const r = await collectSSE(
    new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('')),
    'anthropic',
  );
  expect(r.usage).toEqual({ input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 8 });
  expect(r.stop_reason).toBe('end_turn');
  expect(r.output_text).toBe('Summary');
});
