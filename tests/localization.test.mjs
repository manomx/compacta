// Interface language checks that run without macOS: the string tables are complete
// and consistent, every key the app uses exists, and every message the service
// reports for display has English and Simplified Chinese text.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'Resources/Localization');
const languages = ['en', 'es', 'zh-Hans'];

function parseStrings(path) {
  const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const table = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)";$/);
    if (!m) throw Error(`${path}: cannot parse ${line}`);
    const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
    const key = unescape(m[1]);
    if (key in table) throw Error(`${path}: duplicate key ${key}`);
    table[key] = unescape(m[2]);
  }
  return table;
}
const table = (lang, name) => parseStrings(join(dir, `${lang}.lproj/${name}.strings`));
const placeholders = (s) =>
  s
    .replace(/%%/g, '')
    .match(/%(?:\d+\$)?@/g)
    ?.map((p, i) => (p === '%@' ? `%${i + 1}$@` : p))
    .sort() ?? [];

const swiftDir = join(root, 'Sources/Compacta');
const swift = readdirSync(swiftDir)
  .filter((f) => f.endsWith('.swift'))
  .map((f) => readFileSync(join(swiftDir, f), 'utf8'))
  .join('\n');

describe('interface strings', () => {
  const english = table('en', 'Localizable');

  test('English is the base language of the app bundle', () => {
    const build = readFileSync(join(root, 'scripts/build.sh'), 'utf8');
    expect(build).toContain("'CFBundleDevelopmentRegion':'en'");
    expect(build).toContain("'CFBundleLocalizations':['en','es','zh-Hans']");
    expect(swift).toMatch(/private var language: AppLanguage = \.english/);
  });

  for (const lang of languages)
    test(`${lang} has every key, no extras, matching placeholders, and no empty text`, () => {
      const t = table(lang, 'Localizable');
      expect(Object.keys(t).sort()).toEqual(Object.keys(english).sort());
      for (const [key, value] of Object.entries(t)) {
        expect(value.trim().length > 0, key).toBe(true);
        expect(placeholders(value), `${lang} ${key}`).toEqual(placeholders(english[key]));
      }
      const info = table(lang, 'InfoPlist');
      expect(Object.keys(info)).toEqual(['NSAppleEventsUsageDescription']);
    });

  test('Spanish and Chinese are translated, not copies of English', () => {
    for (const lang of ['es', 'zh-Hans']) {
      const t = table(lang, 'Localizable');
      const same = Object.keys(t).filter((k) => t[k] === english[k] && /[a-z]{4,}/i.test(t[k]));
      // Product names and format-only entries may legitimately match.
      expect(
        same.filter(
          (k) =>
            !/^(status\.tooltip|breadcrumb|probe\.result|field\.tokens|unit\.tokens|auth\.key|format\.)/.test(
              k,
            ),
        ),
        lang,
      ).toEqual([]);
    }
  });

  test('every key used in Swift exists', () => {
    const used = new Set([...swift.matchAll(/\bL\(\s*"([^"]+)"(?!\s*\+)/g)].map((m) => m[1]));
    for (const page of ['overview', 'compaction', 'providers', 'activity', 'settings']) {
      expect(swift).toContain(`case ${page}\n`);
      used.add(`page.${page}`).add(`page.${page}.subtitle`);
    }
    const missing = [...used].filter((k) => !(k in english));
    expect(missing).toEqual([]);
    const unused = Object.keys(english).filter((k) => !used.has(k));
    expect(unused).toEqual([]);
  });

  test('no Spanish text is left hard-coded in the Swift interface', () => {
    const literals = [...swift.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1]);
    const spanish = literals.filter(
      (s) =>
        /[áéíóúñ¿¡]/i.test(s) ||
        /\b(?:de|para|con|sin|tu|tus|una|el|los|las)\b/.test(s.replace(/\\\(.*?\)/g, '')),
    );
    // Allowed: the language's own name, regexes for Spanish service text, and a stored data value.
    const allowed = (s) => s === 'Español' || s === 'Tarifa personalizada' || s.startsWith('^');
    expect(spanish.filter((s) => !allowed(s))).toEqual([]);
  });
});

describe('service messages', () => {
  const swiftPatterns = [...swift.matchAll(/\("(pattern\.\w+)", "((?:[^"\\]|\\.)*)"\)/g)].map(
    (m) => [m[1], new RegExp(m[2].replace(/\\\\/g, '\\'))],
  );
  const files = [
    'config.ts',
    'index.ts',
    'integrations.ts',
    'providers.ts',
    'quotas.ts',
    'vault.ts',
    'claude.ts',
  ];
  const literals = new Set();
  for (const f of files) {
    const src = readFileSync(join(root, 'service', f), 'utf8');
    for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
      const s = (m[1] ?? m[2]).trim();
      if (!s || /^[\w./:-]*$/.test(s)) continue;
      if (
        /[áéíóúñ¿¡]/i.test(s) ||
        /\b(?:de|del|para|con|sin|una?|no|se|tu|su|el|la|los|las|en)\b/.test(s)
      )
        literals.add(s);
    }
  }
  // Pieces that the service joins with values; translated through the patterns.
  const fragments = new Set([
    'respuestas completas: ',
    '${chat} · ${d.pendingItems} elementos por incorporar',
    "${chat} · ${d.reason} · elemento ${d.index ?? '?'} · ${(d.fields || []).join(', ')}",
    '${items.length} mensajes · ${policy.model}',
    '${name}: usa un valor entre ${min} y ${max}.',
    'El proveedor respondió HTTP ${r.status}.',
    'Selecciona un proveedor existente para',
    'Semana · ',
    '${Math.round(w.limit_window_seconds / 3600)} horas',
  ]);

  for (const lang of ['en', 'zh-Hans'])
    test(`${lang} translates every displayed service message`, () => {
      const t = table(lang, 'ServiceMessages');
      for (const [key] of swiftPatterns) expect(t[key], `${lang} ${key}`).toBeDefined();
      const missing = [...literals].filter(
        (s) => !(s in t) && !fragments.has(s) && !/^\$\{chat\} · \$\{/.test(s),
      );
      expect(missing).toEqual([]);
      for (const [key, value] of Object.entries(t))
        if (key.startsWith('pattern.')) {
          const captures = swiftPatterns
            .find(([k]) => k === key)[1]
            .source.match(/\((?!\?)/g).length;
          expect(placeholders(value).length, key).toBe(captures);
        }
    });

  test('patterns match the messages they translate', () => {
    const samples = {
      'pattern.valueRange': 'Retención: usa un valor entre 1 y 365.',
      'pattern.httpStatus': 'El proveedor respondió HTTP 503.',
      'pattern.selectProvider': 'Selecciona un proveedor existente para codex',
      'pattern.hours': '5 horas',
      'pattern.completedResponses': 'respuestas completas: 3',
      'pattern.pendingItems': '4 elementos por incorporar',
      'pattern.item': 'elemento 7',
      'pattern.messages': '12 mensajes',
    };
    for (const [key, re] of swiftPatterns) expect(re.test(samples[key]), key).toBe(true);
    expect(Object.keys(samples).sort()).toEqual(swiftPatterns.map(([k]) => k).sort());
  });
});
