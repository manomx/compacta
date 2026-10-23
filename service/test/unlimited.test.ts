import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactionEngine } from '../native/engine.mjs';
import { defaults, validateConfig, ConfigStore } from '../config';

const msg = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('unlimited setting survives persistence and preserves the other client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compacta-unlimited-config-'));
  try {
    const config = defaults();
    expect(config.codex.maxConcurrent).toBe(0);
    expect(config.claude.maxConcurrent).toBe(2);
    const store = new ConfigStore(root);
    await store.save(config);
    const loaded = new ConfigStore(root);
    await loaded.init();
    expect(loaded.value).toEqual(config);
    expect(() =>
      validateConfig({ ...config, codex: { ...config.codex, maxConcurrent: -1 } }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...config, claude: { ...config.claude, maxConcurrent: 0 } }),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unlimited runs 40 chats concurrently while keeping each summary chain ordered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compacta-unlimited-engine-'));
  const calls: any[] = [],
    pending: Promise<any>[] = [];
  const engine = new CompactionEngine({
    root,
    everyStep: true,
    maxConcurrent: 0,
    compact: () => new Promise((resolve) => calls.push({ resolve })),
  });
  try {
    await engine.init();
    const chats = [];
    for (let i = 0; i < 40; i++) {
      const headers = { session_id: 'unlimited-' + i },
        body = { model: 'test', input: [msg('Task ' + i)] };
      const session = await engine.session(engine.identity(body, headers, 'test'));
      chats.push({ session, headers, body });
      pending.push(engine.maybePrepare(session, body.input, headers, 'test', body));
      await tick();
    }
    expect(calls.length).toBe(40);
    expect(engine.status().activeJobs).toBe(40);
    expect(engine.status().maxConcurrent).toBe(0);
    const first = chats[0];
    pending.push(
      engine.maybePrepare(
        first.session,
        [...first.body.input, msg('Correction')],
        first.headers,
        'test',
        first.body,
      ),
    );
    await tick();
    expect(calls.length).toBe(40);
    calls[0].resolve({ output: [{ type: 'compaction', encrypted_content: 'first' }] });
    await pending[0];
    await tick();
    expect(calls.length).toBe(41);
    expect(first.session.jobs.size).toBe(1);
    expect(engine.status().activeJobs).toBe(40);
    for (const call of calls)
      call.resolve({ output: [{ type: 'compaction', encrypted_content: 'done' }] });
    await Promise.all(pending);
    expect(engine.status().activeJobs).toBe(0);
    expect(first.session.ready.prefix.length).toBe(2);
  } finally {
    engine.stop();
    for (const call of calls)
      call.resolve({ output: [{ type: 'compaction', encrypted_content: 'cleanup' }] });
    await Promise.all(pending);
    await rm(root, { recursive: true, force: true });
  }
});
