import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { Integrations } from '../integrations';
import { atomicJSON } from '../config';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'compacta-routing-'));
  const home = join(root, 'home'),
    state = join(root, 'state');
  const legacy = join(home, '.codex/compactacion-anticipada');
  await mkdir(legacy, { recursive: true });
  await mkdir(state);
  const upstream = 'http://127.0.0.1:10100/v1';
  const installed = 'http://127.0.0.1:61285/compacta/v1';
  const config = join(home, '.codex/config.toml');
  const original = `model = "selected-model"\nmodel_catalog_json = "/tmp/catalog.json"\n# Auto-injected by opencodex (undo: ocx restore)\nopenai_base_url = "${upstream}"\n# Auto-injected by opencodex (undo: ocx restore)\nexperimental_realtime_ws_base_url = "${upstream}"\n[features]\nvoice = true\n`;
  await writeFile(config, original);
  await atomicJSON(join(legacy, 'deployment.json'), { upstream, localUrl: installed });
  const i = new Integrations(state, home);
  i.records.codex = {
    active: true,
    mode: 'legacy',
    installedURL: installed,
    original: { baseURL: upstream },
  };
  return { root, i, config, original, upstream, installed };
}

test('active integration detects and repairs a generated upstream reset without changing model, catalog or realtime', async () => {
  const f = await fixture();
  try {
    expect((await f.i.detect()).codex.active).toBe(false);
    await f.i.activateCodex('unused', {
      port: 1,
      capability: 'test',
      instance: 'test',
      version: 'test',
    });
    const updated = await readFile(f.config, 'utf8');
    expect(TOML.parse(updated)).toEqual({
      ...TOML.parse(f.original),
      openai_base_url: f.installed,
    });
    expect(updated).toContain('# Managed by Compacta;');
    expect(updated).not.toMatch(/# Auto-injected by opencodex[^\n]*\nopenai_base_url/);
    expect(updated).toMatch(
      /# Auto-injected by opencodex[^\n]*\nexperimental_realtime_ws_base_url/,
    );
    expect((await f.i.detect()).codex.active).toBe(true);
    expect(await f.i.reconcileCodexRouting()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('routing recovery never replaces an unrelated provider or a provider-table override', async () => {
  const f = await fixture();
  try {
    for (const text of [
      'model = "other"\nopenai_base_url = "https://different.example/v1"\n',
      `model_provider = "custom"\nopenai_base_url = "${f.upstream}"\n`,
      `openai_base_url = "${f.upstream}"\n[model_providers.openai]\nbase_url = "https://different.example/v1"\n`,
    ]) {
      await writeFile(f.config, text);
      expect(await f.i.reconcileCodexRouting()).toBe(false);
      expect(await readFile(f.config, 'utf8')).toBe(text);
      expect((await f.i.detect()).codex.active).toBe(false);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('disabled integrations never reclaim a route', async () => {
  const f = await fixture();
  try {
    f.i.records.codex.active = false;
    expect(await f.i.reconcileCodexRouting()).toBe(false);
    expect(await readFile(f.config, 'utf8')).toBe(f.original);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
