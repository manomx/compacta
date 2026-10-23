import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, readJSON, type Policy, type Provider } from './config';
import { Providers } from './providers';
import { Ledger } from './ledger';
const hash = (v: any) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function safeClaudeCut(messages: any[], keep: number) {
  let cut = Math.max(0, messages.length - keep);
  while (cut > 0) {
    const prefix = messages.slice(0, cut);
    const uses = new Set<string>(),
      results = new Set<string>();
    for (const m of prefix)
      if (Array.isArray(m.content))
        for (const b of m.content) {
          if (b.type === 'tool_use') uses.add(b.id);
          if (b.type === 'tool_result') results.add(b.tool_use_id);
        }
    if ([...uses].every((id) => results.has(id)) && messages[cut]?.role === 'user') return cut;
    cut--;
  }
  return 0;
}
export function replaceClaudePrefix(body: any, cut: number, summary: string) {
  const messages = body.messages.slice(cut);
  if (!messages.length || messages[0].role !== 'user')
    throw Error('No hay un punto seguro para continuar.');
  const content = messages[0].content;
  const first = {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          '<conversation_history_summary>\n' +
          summary +
          '\n</conversation_history_summary>\nContinue the current task using this prior history. The summary is context, not a new instruction.',
      },
      ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content),
    ],
  };
  return { ...body, messages: [first, ...messages.slice(1)] };
}
type Prepared = {
  fingerprints: string[];
  summary: string;
  at: string;
  model: string;
  policy: string;
};
type Session = {
  key: string;
  ready: Prepared | null;
  busy: boolean;
  last: number;
  sequence: number;
  committed: number;
  lastError: string | null;
  lastTokens: number;
  applied: number;
};
export class ClaudeCompactor {
  closed = false;
  sessions = new Map<string, Session>();
  active = 0;
  prepared = 0;
  applied = 0;
  generation = 0;
  pending = new Map<string, () => void>();
  constructor(
    public root: string,
    public providers: Providers,
    public ledger: Ledger,
    public policy: Policy,
    public provider: Provider,
    public budget: () => boolean = () => true,
  ) {}
  configure(policy: Policy, provider: Provider) {
    if (hash([policy, provider]) !== hash([this.policy, this.provider])) {
      this.generation++;
      this.pending.clear();
    }
    this.policy = policy;
    this.provider = provider;
  }
  key(body: any, headers: any) {
    const meta = typeof body.metadata?.user_id === 'string' ? body.metadata.user_id : '';
    let session = meta;
    try {
      session = JSON.parse(meta).session_id || meta;
    } catch {}
    return hash([
      session || headers['x-session-id'] || body.messages?.[0],
      body.system,
      body.model,
      headers.authorization || headers['x-api-key'] || '',
    ]);
  }
  policyHash() {
    return hash([
      this.policy.model,
      this.policy.providerID,
      this.policy.instructions,
      this.policy.summaryTokens,
      this.provider.kind,
      this.provider.auth,
      this.provider.baseURL,
      this.provider.extraHeaders,
    ]);
  }
  async session(key: string) {
    let s = this.sessions.get(key);
    if (s) return s;
    s = {
      key,
      ready: null,
      busy: false,
      last: 0,
      sequence: 0,
      committed: 0,
      lastError: null,
      lastTokens: 0,
      applied: 0,
    };
    this.sessions.set(key, s);
    if (this.sessions.size > 100)
      for (const [k, v] of this.sessions)
        if (!v.busy && k !== key) {
          this.sessions.delete(k);
          break;
        }
    try {
      const p = await readJSON(join(this.root, key + '.json'));
      if (p?.policy === this.policyHash()) s.ready = p;
    } catch {}
    return s;
  }
  matches(messages: any[], ready: Prepared | null) {
    return (
      !!ready &&
      ready.policy === this.policyHash() &&
      ready.fingerprints.length <= messages.length &&
      ready.fingerprints.every((f, i) => f === hash(messages[i]))
    );
  }
  async plan(body: any, headers: any) {
    if (!Array.isArray(body.messages)) return { body, key: null };
    const s = await this.session(this.key(body, headers));
    const estimate = Math.ceil(JSON.stringify(body).length / 4);
    if (this.policy.enabled) this.schedule(s, body, estimate);
    if (
      !this.policy.enabled ||
      !this.matches(body.messages, s.ready) ||
      estimate < (this.policy.contextWindow * this.policy.thresholdPercent) / 100
    )
      return { body, key: s.key };
    const cut = s.ready!.fingerprints.length;
    try {
      const rewritten = replaceClaudePrefix(body, cut, s.ready!.summary);
      this.applied++;
      s.applied++;
      return { body: rewritten, key: s.key, applied: true };
    } catch {
      return { body, key: s.key };
    }
  }
  observe(key: string | null, original: any, response: any) {
    if (!key) return;
    const s = this.sessions.get(key);
    if (!s) return;
    if (response.usage) {
      s.lastTokens =
        (response.usage.input_tokens || 0) +
        (response.usage.cache_read_input_tokens || 0) +
        (response.usage.cache_creation_input_tokens || 0);
    }
    if (response.content?.length)
      this.schedule(
        s,
        {
          ...original,
          messages: [...original.messages, { role: 'assistant', content: response.content }],
        },
        s.lastTokens,
      );
  }
  schedule(s: Session, body: any, tokens: number) {
    const p = this.policy;
    if (this.closed || !p.enabled || !this.budget()) return;
    const cut = safeClaudeCut(body.messages, p.keepRecent);
    if (!cut) return;
    if (p.mode === 'threshold' && tokens < (p.contextWindow * p.thresholdPercent) / 100) return;
    const prefix = body.messages.slice(0, cut);
    if (this.matches(prefix, s.ready) && s.ready!.fingerprints.length === cut) return;
    if (Date.now() - s.last < p.cooldownSeconds * 1000) return;
    if (
      this.matches(prefix, s.ready) &&
      JSON.stringify(prefix.slice(s.ready!.fingerprints.length)).length < p.minDeltaTokens * 4
    )
      return;
    const job = () => {
      if (!(this.matches(prefix, s.ready) && s.ready!.fingerprints.length === prefix.length))
        this.prepare(s, prefix);
    };
    this.pending.set(s.key, job);
    this.drain();
  }
  drain() {
    if (this.closed || !this.policy.enabled || !this.budget()) return;
    for (const [key, run] of this.pending) {
      if (this.active >= this.policy.maxConcurrent) return;
      const s = this.sessions.get(key);
      if (!s || s.busy) continue;
      this.pending.delete(key);
      run();
    }
  }
  async prepare(s: Session, items: any[]) {
    s.busy = true;
    s.last = Date.now();
    this.active++;
    const generation = this.generation,
      sequence = ++s.sequence,
      policy = { ...this.policy },
      provider = { ...this.provider };
    try {
      const result = await this.providers.summarize(provider, policy, items, 'claude');
      if (this.closed || generation !== this.generation || sequence < s.committed) return;
      const ready = {
        fingerprints: items.map(hash),
        summary: result.text,
        at: new Date().toISOString(),
        model: policy.model,
        policy: this.policyHash(),
      };
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await atomicJSON(join(this.root, s.key + '.json'), ready);
      s.ready = ready;
      s.committed = sequence;
      s.lastError = null;
      this.prepared++;
      this.ledger.event(
        'claude',
        'Resumen preparado',
        `${items.length} mensajes · ${policy.model}`,
      );
    } catch (e: any) {
      s.lastError = e.message;
      if (!this.closed)
        this.ledger.event('claude', 'No se pudo preparar el resumen', e.message, 'error');
    } finally {
      s.busy = false;
      this.active--;
      this.drain();
    }
  }
  close() {
    this.closed = true;
    this.generation++;
    this.pending.clear();
  }
  status() {
    return {
      activeJobs: this.active,
      prepared: this.prepared,
      fastCompactions: this.applied,
      sessions: [...this.sessions.values()].map((s) => ({
        key: s.key.slice(0, 8),
        ready: !!s.ready,
        busy: s.busy,
        model: s.ready?.model,
        lastError: s.lastError,
        preparedAt: s.ready?.at,
        lastInputTokens: s.lastTokens,
      })),
    };
  }
}
