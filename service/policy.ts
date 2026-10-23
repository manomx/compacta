import type { Policy, Provider } from './config';
import { guidance } from './config';
import { hash, isRetainedV2Item } from './native/engine.mjs';

export function codexPolicyHash(policy: Policy, provider: Provider, nativeModel: string) {
  // Rebuild old checkpoints that included an artificial user instruction.
  const native = provider.auth === 'codex';
  return hash({
    format: 6,
    compactionModel: nativeModel,
    compactionEffort: policy.effort,
    ...(native && policy.instructions === guidance ? {} : { instructions: policy.instructions }),
    ...(native
      ? {}
      : {
          summarizer: {
            handoffFormat: 6,
            id: provider.id,
            kind: provider.kind,
            auth: provider.auth,
            baseURL: provider.baseURL,
            model: policy.model,
            summaryTokens: policy.summaryTokens,
            extraHeaders: provider.extraHeaders,
          },
        }),
  });
}

export async function externalCodexSummary(
  body: any,
  summarize: (items: any[]) => Promise<{ text: string }>,
) {
  // Another model cannot read native encrypted state. Preserve it verbatim.
  const retained = body.input.filter(
    (item: any) => item.type === 'compaction' || isRetainedV2Item(item),
  );
  const items = body.input.filter((item: any) => item.type !== 'compaction');
  if (!items.length) return body;
  const summary = await summarize(items);
  // Native v2 retains user/developer messages outside its encrypted summary.
  // A synthetic user handoff is therefore discarded when the client retains its
  // ORIGINAL user messages. Assistant evidence must enter the encrypted item.
  // Keep the handoff as assistant evidence. A synthetic user request would be
  // encoded as a new instruction and could replace the real user's task.
  const externalHandoff = {
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: 'Prior conversation handoff prepared by the selected summarizer:\n' + summary.text,
      },
    ],
  };
  return { ...body, externalHandoff, input: [...retained, externalHandoff] };
}
