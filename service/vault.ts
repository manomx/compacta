import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Provider } from './config';
export function run(exe: string, args: string[], input?: string): Promise<string> {
  return new Promise((ok, fail) => {
    const p = execFile(exe, args, { timeout: 20000, maxBuffer: 2e6 }, (e, out) =>
      e ? fail(Error('No se pudo acceder al Llavero o a la cuenta.')) : ok(out.trim()),
    );
    if (input) p.stdin?.end(input);
  });
}
export class Vault {
  cache = new Map<string, { at: number; value: string }>();
  constructor(
    public helper: string,
    public home = homedir(),
  ) {}
  async secret(id: string) {
    const c = this.cache.get(id);
    if (c && Date.now() - c.at < 60000) return c.value;
    const value = await run(this.helper, ['read', id]);
    this.cache.set(id, { at: Date.now(), value });
    return value;
  }
  async save(id: string, value: string) {
    await run(this.helper, ['write', id], value);
    this.cache.delete(id);
  }
  async remove(id: string) {
    await run(this.helper, ['delete', id]);
    this.cache.delete(id);
  }
  async codex() {
    const raw = JSON.parse(await readFile(join(this.home, '.codex/auth.json'), 'utf8'));
    const token = raw.tokens?.access_token;
    if (!token) throw Error('Inicia sesión en Codex para consultar tu suscripción.');
    return { token, account: raw.tokens?.account_id };
  }
  async claude() {
    let raw: any;
    try {
      raw = JSON.parse(await readFile(join(this.home, '.claude/.credentials.json'), 'utf8'));
    } catch {
      raw = JSON.parse(
        await run('/usr/bin/security', [
          'find-generic-password',
          '-s',
          'Claude Code-credentials',
          '-w',
        ]),
      );
    }
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken)
      throw Error('Inicia sesión en Claude Code para consultar tu suscripción.');
    return {
      token: oauth.accessToken,
      subscription: oauth.subscriptionType,
      expiresAt: oauth.expiresAt,
    };
  }
  async headers(p: Provider): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...p.extraHeaders };
    if (p.auth === 'codex') {
      const a = await this.codex();
      h.authorization = 'Bearer ' + a.token;
      if (a.account) h['chatgpt-account-id'] = a.account;
      h.originator = 'codex_cli_rs';
    } else if (p.auth === 'claude') {
      const a = await this.claude();
      h.authorization = 'Bearer ' + a.token;
      h['anthropic-beta'] = 'oauth-2025-04-20';
      h['user-agent'] = 'claude-cli/2.1.0 (external, cli)';
    } else if (p.auth === 'key') {
      const key = await this.secret(p.id);
      if (p.kind === 'anthropic') h['x-api-key'] = key;
      else h.authorization = 'Bearer ' + key;
    }
    if (p.kind === 'anthropic') h['anthropic-version'] = '2023-06-01';
    return h;
  }
}
