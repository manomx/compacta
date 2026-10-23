import { Vault } from './vault';
import { checkedFetch } from './providers';
export type Limit = { label: string; usedPercent: number; resetsAt: string | null };
export type Quota = {
  client: string;
  available: boolean;
  fetchedAt: string | null;
  plan: string;
  limits: Limit[];
  error: string | null;
  stale: boolean;
};
export const emptyQuota = (client: string): Quota => ({
  client,
  available: false,
  fetchedAt: null,
  plan: '',
  limits: [],
  error: null,
  stale: false,
});
export function parseCodex(raw: any): Limit[] {
  const result: Limit[] = [];
  for (const [key, label] of [
    ['primary_window', 'Ventana actual'],
    ['secondary_window', 'Semana'],
  ] as const) {
    const w = raw.rate_limit?.[key];
    if (w && Number.isFinite(w.used_percent))
      result.push({
        label:
          w.limit_window_seconds >= 604800
            ? 'Semana'
            : w.limit_window_seconds
              ? `${Math.round(w.limit_window_seconds / 3600)} horas`
              : label,
        usedPercent: w.used_percent,
        resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
      });
  }
  return result;
}
export function parseClaude(raw: any): Limit[] {
  const result: Limit[] = [];
  for (const [key, label] of [
    ['five_hour', '5 horas'],
    ['seven_day', 'Semana'],
    ['seven_day_opus', 'Semana · Opus'],
    ['seven_day_sonnet', 'Semana · Sonnet'],
  ] as const) {
    const w = raw[key];
    if (w && Number.isFinite(w.utilization))
      result.push({ label, usedPercent: w.utilization, resetsAt: w.resets_at || null });
  }
  if (Array.isArray(raw.limits))
    for (const l of raw.limits) {
      const n = l.utilization ?? l.used_percent;
      if (Number.isFinite(n) && l.scope?.model)
        result.push({
          label: 'Semana · ' + (l.scope.model.display_name || l.scope.model.id || 'Modelo'),
          usedPercent: n,
          resetsAt: l.resets_at || l.reset_at || null,
        });
    }
  return result;
}
export class Quotas {
  values: Record<string, Quota> = { codex: emptyQuota('codex'), claude: emptyQuota('claude') };
  busy = false;
  lastAttempt = 0;
  constructor(public vault: Vault) {}
  async refresh(force = false, intervalMs = 300000) {
    if (this.busy || Date.now() - this.lastAttempt < (force ? 60000 : Math.max(60000, intervalMs)))
      return this.values;
    this.busy = true;
    this.lastAttempt = Date.now();
    try {
      await Promise.allSettled(
        ['codex', 'claude'].map(async (client) => {
          try {
            let raw: any,
              plan = '';
            if (client === 'codex') {
              const a = await this.vault.codex();
              const h: Record<string, string> = {
                authorization: 'Bearer ' + a.token,
                'user-agent': 'Compacta/1.0',
              };
              if (a.account) h['chatgpt-account-id'] = a.account;
              raw = await (
                await checkedFetch('https://chatgpt.com/backend-api/wham/usage', {
                  headers: h,
                  signal: AbortSignal.timeout(15000),
                })
              ).json();
              plan = raw.plan_type || 'Codex';
            } else {
              const a = await this.vault.claude();
              raw = await (
                await checkedFetch('https://api.anthropic.com/api/oauth/usage?cedar_ember=1', {
                  headers: {
                    authorization: 'Bearer ' + a.token,
                    'anthropic-beta': 'oauth-2025-04-20',
                    'user-agent': 'claude-cli/2.1.0 (external, cli)',
                  },
                  signal: AbortSignal.timeout(15000),
                })
              ).json();
              plan = a.subscription || 'Claude';
            }
            const limits = client === 'codex' ? parseCodex(raw) : parseClaude(raw);
            this.values[client] = {
              client,
              available: limits.length > 0,
              fetchedAt: new Date().toISOString(),
              plan,
              limits,
              error: limits.length ? null : 'Esta cuenta no informa límites de suscripción.',
              stale: false,
            };
          } catch (e: any) {
            const prior = this.values[client];
            this.values[client] = {
              ...prior,
              stale: prior.available,
              error: e.message || 'No se pudo consultar la cuenta.',
            };
          }
        }),
      );
    } finally {
      this.busy = false;
    }
    return this.values;
  }
}
