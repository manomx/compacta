import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const paths = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const errors = [];
const prohibited = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['provider token', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{35,}\b/],
  ['personal home path', /\/(?:Users|home)\/[a-z][a-z0-9_.-]{3,}\//i],
];
for (const file of paths) {
  const path = resolve(root, file),
    s = await stat(path);
  if (s.size > 5 * 1024 * 1024) errors.push(`${file}: oversized source file`);
  if (
    /(?:^|\/)(?:runtime|deployment|integrations|settings)\.json$|\.(?:sqlite|p12|p8|pem|key)$/.test(
      file,
    )
  )
    errors.push(`${file}: runtime/credential artifact must not be tracked`);
  if (
    !['.md', '.mjs', '.ts', '.swift', '.json', '.yml', '.yaml', '.sh', '.svg', '.txt', ''].includes(
      extname(file),
    )
  )
    continue;
  const text = await readFile(path, 'utf8');
  for (const [label, pattern] of prohibited)
    if (pattern.test(text)) errors.push(`${file}: ${label}`);
  if (file.endsWith('.md')) {
    const links = [...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(
      (m) => m[1].split(/\s+["']/)[0],
    );
    links.push(...[...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]));
    for (const link of links) {
      if (/^(?:[a-z]+:|#|\/\/)/i.test(link)) continue;
      const target = decodeURIComponent(link.split('#')[0]);
      if (!target) continue;
      try {
        await stat(resolve(dirname(path), target));
      } catch {
        errors.push(`${file}: broken local link ${link}`);
      }
    }
  }
  if (file.startsWith('.github/workflows/'))
    for (const m of text.matchAll(/uses:\s*([^\s#]+)/g))
      if (!/^[^@]+@[a-f0-9]{40}$/.test(m[1]))
        errors.push(`${file}: action must use a full commit SHA`);
}
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
for (const section of ['dependencies', 'devDependencies'])
  for (const [name, v] of Object.entries(pkg[section] || {}))
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(v)) errors.push(`${name}: dependency must be pinned`);
const settings = await readFile(resolve(root, 'service/native/settings.mjs'), 'utf8');
if (!new RegExp(`VERSION\\s*=\\s*['"]${pkg.version.replaceAll('.', '\\.')}['"]`).test(settings))
  errors.push('Service and package version differ');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(
  `Repository checks passed: ${paths.length} files, local links, dependency pins, action SHAs, and sensitive-artifact patterns.`,
);
