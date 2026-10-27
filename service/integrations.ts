import { readFile, writeFile, mkdir, cp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import TOML from '@iarna/toml';
import { readJSON, atomicJSON } from './config';
type RecordInfo = {
  active: boolean;
  mode?: string;
  original?: any;
  installedURL?: string;
  previousRoute?: any;
  note?: string;
};
export function editRootString(
  text: string,
  key: string,
  value: string | null,
  claimRoute = false,
) {
  const before: any = TOML.parse(text || '');
  const lines = text.split(/\r?\n/);
  let root = true,
    found = false,
    multiline: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (multiline) {
      if (l.includes(multiline)) multiline = null;
      continue;
    }
    const match = l.match(/=\s*("""|''')/);
    if (match && !l.slice(l.indexOf(match[1]) + 3).includes(match[1])) multiline = match[1];
    if (/^\s*\[/.test(l)) root = false;
    if (root && new RegExp('^\\s*' + key + '\\s*=').test(l)) {
      if (found) throw Error('Clave duplicada en configuración.');
      found = true;
      lines[i] = value === null ? '' : `${key} = ${JSON.stringify(value)}`;
      if (
        claimRoute &&
        key === 'openai_base_url' &&
        value !== null &&
        i > 0 &&
        lines[i - 1].includes('# Auto-injected by opencodex')
      )
        lines[i - 1] = '# Managed by Compacta; the original provider remains upstream.';
    }
  }
  if (!found && value !== null) lines.unshift(`${key} = ${JSON.stringify(value)}`);
  const result = lines.join('\n');
  const expected = { ...before };
  if (value === null) delete expected[key];
  else expected[key] = value;
  const parsed = TOML.parse(result);
  if (JSON.stringify(sort(parsed)) !== JSON.stringify(sort(expected)))
    throw Error('No se pudo conservar la configuración original.');
  return result;
}
function sort(x: any): any {
  if (Array.isArray(x)) return x.map(sort);
  if (x && typeof x === 'object')
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, sort(x[k])]),
    );
  return x;
}
async function text(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}
export class Integrations {
  records: Record<string, RecordInfo> = { codex: { active: false }, claude: { active: false } };
  private reconcilingCodex = false;
  constructor(
    public root: string,
    public home = homedir(),
  ) {}
  async init() {
    this.records = await readJSON(join(this.root, 'integrations.json'), this.records);
  }
  async persist() {
    await atomicJSON(join(this.root, 'integrations.json'), this.records);
  }
  async detect() {
    const codexText = await text(join(this.home, '.codex/config.toml'));
    let codex: any = {};
    try {
      codex = TOML.parse(codexText);
    } catch {}
    const claude = await readJSON(join(this.home, '.claude/settings.json'), {});
    const legacy = await readJSON(
      join(this.home, '.codex/compactacion-anticipada/deployment.json'),
    );
    return {
      codex: {
        detected: !!codexText,
        active:
          this.records.codex.active &&
          codex.openai_base_url === this.records.codex.installedURL &&
          (!codex.model_provider || codex.model_provider === 'openai') &&
          !codex.model_providers?.openai?.base_url,
        legacy: !!legacy,
        model: codex.model || '',
        note: this.records.codex.note || '',
      },
      claude: {
        detected: await stat(join(this.home, '.claude'))
          .then(() => true)
          .catch(() => false),
        active: this.records.claude.active,
        model: claude.model || '',
        note: this.records.claude.note || '',
      },
    };
  }
  async codexUpstream() {
    const legacy = await readJSON(
      join(this.home, '.codex/compactacion-anticipada/deployment.json'),
    );
    if (legacy) return legacy.upstream || 'auto';
    const r = this.records.codex;
    if (r.active) return r.original?.baseURL || 'auto';
    const conf: any = TOML.parse(await text(join(this.home, '.codex/config.toml')));
    return conf.openai_base_url || 'auto';
  }
  async claudeUpstream() {
    const r = this.records.claude;
    if (r.active) return r.original?.baseURL || 'https://api.anthropic.com';
    const conf = await readJSON(join(this.home, '.claude/settings.json'), {});
    return conf.env?.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  }
  async reconcileCodexRouting() {
    const r = this.records.codex;
    if (!r.active || !r.installedURL || this.reconcilingCodex) return false;
    this.reconcilingCodex = true;
    try {
      const path = join(this.home, '.codex/config.toml');
      const original = await text(path);
      const parsed: any = TOML.parse(original || '');
      if (parsed.model_provider && parsed.model_provider !== 'openai') return false;
      if (parsed.model_providers?.openai?.base_url) return false;
      const legacy =
        r.mode === 'legacy'
          ? await readJSON(join(this.home, '.codex/compactacion-anticipada/deployment.json'))
          : null;
      const knownUpstreams = [
        r.original?.baseURL,
        legacy?.upstream,
        legacy?.originalBaseUrl,
      ].filter((value) => typeof value === 'string' && value !== 'auto');
      if (
        parsed.openai_base_url !== r.installedURL &&
        !knownUpstreams.includes(parsed.openai_base_url)
      )
        return false;
      const updated = editRootString(original, 'openai_base_url', r.installedURL, true);
      if (updated === original) return false;
      await mkdir(join(this.root, 'backups'), { recursive: true, mode: 0o700 });
      await writeFile(join(this.root, 'backups', `codex-route-${Date.now()}.toml`), original, {
        mode: 0o600,
      });
      if ((await text(path)) !== original) return false;
      await writeFile(path, updated, { mode: 0o600 });
      return true;
    } finally {
      this.reconcilingCodex = false;
    }
  }
  async activateCodex(
    url: string,
    worker: { port: number; capability: string; instance: string; version: string },
  ) {
    const r = this.records.codex;
    if (r.active) {
      await this.reconcileCodexRouting();
      if ((await this.detect()).codex.active) return;
      throw Error(
        'La conexión de Codex cambió a otro proveedor. Desconecta y vuelve a conectar Compacta para adoptar esa ruta.',
      );
    }
    const path = join(this.home, '.codex/config.toml'),
      original = await text(path),
      parsed: any = TOML.parse(original || '');
    if (parsed.model_provider && parsed.model_provider !== 'openai')
      throw Error(
        'Codex usa otro proveedor. Selecciona OpenAI en Codex antes de conectar Compacta.',
      );
    if (parsed.model_providers?.openai?.base_url)
      throw Error(
        'Codex tiene una ruta de OpenAI dentro de un perfil. Conservamos ese ajuste; revísalo antes de conectar.',
      );
    await mkdir(join(this.root, 'backups'), { recursive: true, mode: 0o700 });
    await writeFile(join(this.root, 'backups', `codex-${Date.now()}.toml`), original, {
      mode: 0o600,
    });
    const legacyRoot = join(this.home, '.codex/compactacion-anticipada');
    const legacy = await readJSON(join(legacyRoot, 'deployment.json'));
    const previousRoute = await readJSON(join(legacyRoot, 'route.json'));
    if (legacy && parsed.openai_base_url === legacy.localUrl) {
      this.records.codex = {
        active: true,
        mode: 'legacy',
        original: { baseURL: legacy.originalBaseUrl ?? null },
        installedURL: legacy.localUrl,
        previousRoute,
        note: 'Conectado sin reiniciar Codex.',
      };
      await this.persist();
      try {
        await this.reconcileCodexRouting();
        await atomicJSON(join(legacyRoot, 'route.json'), { ...worker, restart: false });
      } catch (e) {
        this.records.codex = r;
        await this.persist();
        throw e;
      }
    } else {
      await mkdir(join(this.home, '.codex'), { recursive: true, mode: 0o700 });
      this.records.codex = {
        active: true,
        mode: 'direct',
        original: { baseURL: parsed.openai_base_url ?? null },
        installedURL: url,
        note: 'Los chats nuevos usarán Compacta. Los ya abiertos conservan su conexión.',
      };
      await this.persist();
      try {
        await writeFile(path, editRootString(original, 'openai_base_url', url, true), {
          mode: 0o600,
        });
      } catch (e) {
        this.records.codex = r;
        await this.persist();
        throw e;
      }
    }
  }
  async deactivateCodex() {
    const r = this.records.codex;
    if (!r.active) return;
    if (r.mode === 'legacy') {
      await atomicJSON(
        join(this.home, '.codex/compactacion-anticipada/route.json'),
        null,
      ); /* stable gateway now forwards directly; current sockets can finish */
    } else {
      const path = join(this.home, '.codex/config.toml');
      const original = await text(path);
      const current: any = TOML.parse(original);
      if (current.openai_base_url === r.installedURL)
        await writeFile(
          path,
          editRootString(original, 'openai_base_url', r.original?.baseURL ?? null),
          { mode: 0o600 },
        );
    }
    this.records.codex = {
      ...r,
      active: false,
      note: 'Compactación desactivada. Conexión original restaurada.',
    };
    await this.persist();
  }
  async activateClaude(url: string) {
    if (this.records.claude.active) return;
    const path = join(this.home, '.claude/settings.json');
    const original = await readJSON(path, {});
    await mkdir(join(this.home, '.claude'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'backups'), { recursive: true, mode: 0o700 });
    await atomicJSON(join(this.root, 'backups', `claude-${Date.now()}.json`), original);
    const record = {
      active: true,
      original: { baseURL: original.env?.ANTHROPIC_BASE_URL ?? null },
      installedURL: url,
      note: 'Abre una sesión nueva de Claude Code para usar Compacta.',
    };
    this.records.claude = record;
    await this.persist();
    try {
      await atomicJSON(path, { ...original, env: { ...original.env, ANTHROPIC_BASE_URL: url } });
    } catch (e) {
      this.records.claude = { active: false };
      await this.persist();
      throw e;
    }
  }
  async deactivateClaude() {
    const r = this.records.claude;
    if (!r.active) return;
    const path = join(this.home, '.claude/settings.json');
    const original = await readJSON(path, {});
    if (original.env?.ANTHROPIC_BASE_URL === r.installedURL) {
      const env = { ...original.env };
      if (r.original?.baseURL == null) delete env.ANTHROPIC_BASE_URL;
      else env.ANTHROPIC_BASE_URL = r.original.baseURL;
      await atomicJSON(path, { ...original, env });
    }
    this.records.claude = {
      ...r,
      active: false,
      note: 'Desactivado. Las sesiones abiertas mantienen su ruta hasta cerrarse.',
    };
    await this.persist();
  }
  async importLegacyCache(destination: string) {
    const legacyRoot = join(this.home, '.codex/compactacion-anticipada');
    const r = await readJSON(join(legacyRoot, 'route.json'));
    if (!r?.config) return;
    const c = await readJSON(r.config);
    if (!c?.root) return;
    for (const dir of ['cache', 'archive'])
      try {
        await cp(join(c.root, dir), join(destination, dir), {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
      } catch {}
    try {
      await cp(join(legacyRoot, 'tails-v1'), join(destination, 'tails'), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    } catch {}
  }
}
