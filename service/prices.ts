import type { Provider } from './config';
// USD per million tokens. Source snapshots are documented in docs/PRICING.md.
const prices: Record<string, [number, number, number, number]> = {
  'gpt-6-astra': [10, 50, 1, 12.5],
  'gpt-6-luna': [0.1, 0.5, 0.01, 0.125],
  'gpt-6-sol': [2, 10, 0.2, 2.5],
  'gpt-6.1-sol': [2, 10, 0.1, 2.5],
  'gpt-5.6-sol': [4, 20, 0.4, 5],
  'gpt-5.6-terra': [2, 12, 0.2, 2.5],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-opus-4-6': [5, 25, 0.5, 6.25],
};
export function pricing(p: Provider, model: string): Provider {
  if (model === p.model) return p;
  const known = prices[model];
  return {
    ...p,
    model,
    inputPrice: known?.[0] ?? null,
    outputPrice: known?.[1] ?? null,
    cachePrice: known?.[2] ?? null,
    cacheWritePrice: known?.[3] ?? null,
  };
}
export const modelSuggestions = Object.keys(prices);
