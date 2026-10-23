import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import type { Provider } from './config';
export type TokenUsage = {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reported: boolean;
};
export function normalizeUsage(u: any): TokenUsage {
  if (!u) return { input: 0, output: 0, cached: 0, cacheWrite: 0, reported: false };
  const anthropic =
    u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined;
  const cached = Number(
    u.cache_read_input_tokens ??
      u.input_tokens_details?.cached_tokens ??
      u.prompt_tokens_details?.cached_tokens ??
      0,
  );
  const cacheWrite = Number(
    u.cache_creation_input_tokens ?? u.input_tokens_details?.cache_write_tokens ?? 0,
  );
  return {
    input: Math.max(
      0,
      Number(u.input_tokens ?? u.prompt_tokens ?? 0) + (anthropic ? cached + cacheWrite : 0),
    ),
    output: Math.max(0, Number(u.output_tokens ?? u.completion_tokens ?? 0)),
    cached: Math.max(0, cached),
    cacheWrite: Math.max(0, cacheWrite),
    reported: true,
  };
}
export function costFor(u: TokenUsage, p: Partial<Provider> | null) {
  if (!p || p.inputPrice == null || p.outputPrice == null || !u.reported) return null;
  if ((u.cached && p.cachePrice == null) || (u.cacheWrite && p.cacheWritePrice == null))
    return null;
  return (
    (Math.max(0, u.input - u.cached - u.cacheWrite) * p.inputPrice +
      u.output * p.outputPrice +
      u.cached * (p.cachePrice ?? 0) +
      u.cacheWrite * (p.cacheWritePrice ?? 0)) /
    1e6
  );
}
export class Ledger {
  db: Database;
  constructor(root: string) {
    const path = join(root, 'usage.sqlite');
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, at TEXT NOT NULL, client TEXT, kind TEXT, provider TEXT, model TEXT, input INTEGER, output INTEGER, cached INTEGER, cacheWrite INTEGER, cost REAL, reported INTEGER, latency REAL); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at TEXT, client TEXT, title TEXT, detail TEXT, level TEXT);',
    );
  }
  record({
    id,
    client,
    kind,
    provider,
    model,
    usage,
    latency = 0,
  }: {
    id: string;
    client: string;
    kind: string;
    provider: Provider | null;
    model: string;
    usage: any;
    latency?: number;
  }) {
    const u = normalizeUsage(usage);
    this.db
      .query('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        new Date().toISOString(),
        client,
        kind,
        provider?.id || '',
        model,
        u.input,
        u.output,
        u.cached,
        u.cacheWrite,
        costFor(u, provider),
        Number(u.reported),
        latency,
      );
  }
  event(client: string, title: string, detail = '', level = 'info') {
    this.db
      .query('INSERT INTO events(at,client,title,detail,level) VALUES(?,?,?,?,?)')
      .run(new Date().toISOString(), client, title, detail.slice(0, 500), level);
  }
  totals(days = 1) {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - Math.max(0, days - 1));
    const clause = ' FROM usage WHERE at >= ?';
    const total: any = this.db
      .query(
        'SELECT COUNT(*) requests, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(cached),0) cached, COALESCE(SUM(cacheWrite),0) cacheWrite, COALESCE(SUM(cost),0) cost, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced' +
          clause,
      )
      .get(since.toISOString());
    const models = this.db
      .query(
        'SELECT client,kind,model,COUNT(*) requests,SUM(input) input,SUM(output) output,COALESCE(SUM(cost),0) cost,SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced' +
          clause +
          ' GROUP BY client,kind,model ORDER BY input DESC',
      )
      .all(since.toISOString());
    const chart = this.db
      .query(
        'SELECT substr(at,1,13) hour,SUM(input) input,SUM(output) output,COALESCE(SUM(cost),0) cost' +
          clause +
          ' GROUP BY hour ORDER BY hour',
      )
      .all(since.toISOString());
    return { ...total, unpriced: total.unpriced || 0, models, chart };
  }
  events() {
    return this.db.query('SELECT * FROM events ORDER BY id DESC LIMIT 100').all();
  }
  export() {
    return this.db.query('SELECT * FROM usage ORDER BY at DESC').all();
  }
  prune(days: number) {
    const before = new Date(Date.now() - days * 86400000).toISOString();
    this.db.query('DELETE FROM usage WHERE at < ?').run(before);
    this.db.query('DELETE FROM events WHERE at < ?').run(before);
  }
  close() {
    this.db.close();
  }
}
