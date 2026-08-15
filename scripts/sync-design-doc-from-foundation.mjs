#!/usr/bin/env node
/**
 * Sync DESIGN.md token block from src/renderer/styles-foundation.css.
 * Keeps narrative intact; rewrites authority banner + DESIGN-TOKENS-SYNC block
 * immediately after YAML frontmatter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const foundationPath = path.join(root, 'src', 'renderer', 'styles-foundation.css');
const designPath = path.join(root, 'DESIGN.md');

const KEYS = [
  'app-bg', 'topbar-bg', 'sidebar-bg', 'workspace-bg', 'panel-bg',
  'surface', 'surface-raised', 'surface-hover', 'surface-selected', 'tag-bg',
  'ink', 'ink-soft', 'muted', 'muted-low', 'border', 'border-soft', 'border-strong',
  'accent', 'accent-hover', 'accent-soft', 'link', 'amber', 'success', 'warning',
  'danger', 'info', 'topbar-height', 'page-space', 'font-sans', 'mono'
];

function extractRootBlock(css, selector) {
  const idx = css.indexOf(selector);
  if (idx < 0) throw new Error(`Missing selector ${selector}`);
  const start = css.indexOf('{', idx);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error(`Unclosed block for ${selector}`);
}

function parseVars(block) {
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*--([a-z0-9-]+)\s*:\s*(.+?)\s*;\s*$/i);
    if (!m) continue;
    out[m[1]] = m[2].trim();
  }
  return out;
}

function pick(vars, keys) {
  const out = {};
  for (const key of keys) {
    if (vars[key] != null) out[key] = vars[key];
  }
  return out;
}

function yamlValue(value) {
  return JSON.stringify(String(value));
}

function toYaml(obj, indent = 2) {
  const pad = ' '.repeat(indent);
  return Object.entries(obj)
    .map(([k, v]) => `${pad}${k}: ${yamlValue(v)}`)
    .join('\n');
}

function splitFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return { front: null, body: normalized };
  return {
    front: match[1],
    body: normalized.slice(match[0].length),
    eol: match[0].includes('\r\n') ? '\r\n' : '\n'
  };
}

function stripManagedBlocks(body) {
  return body
    .replace(/<!-- DESIGN-AUTHORITY-BANNER:BEGIN -->[\s\S]*?<!-- DESIGN-AUTHORITY-BANNER:END -->\r?\n*/g, '')
    .replace(/<!-- DESIGN-TOKENS-SYNC:BEGIN -->[\s\S]*?<!-- DESIGN-TOKENS-SYNC:END -->\r?\n*/g, '')
    .replace(/^\r?\n+/, '');
}

function patchFrontmatter(front, syncedAt, dark, light) {
  let next = front.replace(/\r\n/g, '\n');
  if (!/^foundationSynced:/m.test(next)) {
    next = `foundationSynced: true\nsyncedAt: ${JSON.stringify(syncedAt)}\n# Prefer DESIGN-TOKENS-SYNC block + styles-foundation.css for token values.\n${next}`;
  } else {
    next = next.replace(/^syncedAt:.*$/m, `syncedAt: ${JSON.stringify(syncedAt)}`);
  }

  const replacements = {
    'violet:': dark.accent,
    'violet-hover:': dark['accent-hover'],
    'violet-soft:': dark['accent-soft'],
    'dark-app-bg:': dark['app-bg'],
    'dark-ink:': dark.ink,
    'day-app-bg:': light['app-bg'],
    'day-violet:': light.accent,
    'day-violet-hover:': light['accent-hover']
  };
  for (const [key, value] of Object.entries(replacements)) {
    if (!value) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(\\s*${escaped}\\s*).*$`, 'm');
    if (re.test(next)) next = next.replace(re, `$1${JSON.stringify(value)}`);
  }

  if (dark['font-sans']) {
    next = next.replace(/^(\s*fontFamily:\s*).*$/gm, `$1${JSON.stringify(dark['font-sans'])}`);
  }
  return next;
}

const css = fs.readFileSync(foundationPath, 'utf8');
const dark = pick(parseVars(extractRootBlock(css, ':root {')), KEYS);
const light = pick(parseVars(extractRootBlock(css, ':root[data-theme="light"]')), KEYS);
const syncedAt = new Date().toISOString();

const raw = fs.readFileSync(designPath, 'utf8');
let { front, body, eol = '\n' } = splitFrontmatter(raw);

// Recover if a previous run put managed blocks before frontmatter
if (!front) {
  const recovered = stripManagedBlocks(raw);
  const again = splitFrontmatter(recovered);
  front = again.front;
  body = again.body;
  eol = again.eol || '\n';
  if (!front) throw new Error('DESIGN.md: missing YAML frontmatter');
}

body = stripManagedBlocks(body);
front = patchFrontmatter(front, syncedAt, dark, light);

const banner = [
  '<!-- DESIGN-AUTHORITY-BANNER:BEGIN -->',
  '> **STALE / NOT SSOT for token values.**',
  '>',
  '> Machine SSOT: `src/renderer/styles-foundation.css` (墨夜 · Inter · accent `#8b7cff` · topbar `56px`).',
  '> Human living guide: `docs/design/living-style-guide.html` (renders foundation CSS variables).',
  '> Oh My Pi 入口 = `CLAUDE.md`. Anti-drift: **CLAUDE.md + `tests/design-tokens-drift.test.mjs`**',
  '> (mirrored in `AGENTS.md` + `.cursor/rules/design-authority.mdc`).',
  '> Frontmatter / synced block below is updated by `node scripts/sync-design-doc-from-foundation.mjs`.',
  '> `prototype/` and `.impeccable/design.json` are not execution truth.',
  '>',
  `> Last sync: \`${syncedAt}\``,
  '<!-- DESIGN-AUTHORITY-BANNER:END -->',
  ''
].join('\n');

const syncedBlock = [
  '<!-- DESIGN-TOKENS-SYNC:BEGIN -->',
  '```yaml',
  '# Synced from src/renderer/styles-foundation.css — do not hand-edit token values.',
  `# syncedAt: ${syncedAt}`,
  'foundation:',
  '  dark:',
  toYaml(dark, 4),
  '  light:',
  toYaml(light, 4),
  '```',
  '<!-- DESIGN-TOKENS-SYNC:END -->',
  ''
].join('\n');

const out = [
  '---',
  front,
  '---',
  '',
  banner,
  syncedBlock,
  body.replace(/^\uFEFF/, '').replace(/^\r?\n+/, '')
].join(eol === '\r\n' ? '\n' : '\n');

fs.writeFileSync(designPath, out.replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n'));
console.log(`Synced DESIGN.md from foundation (${syncedAt})`);
console.log(`  dark accent=${dark.accent} topbar=${dark['topbar-height']} font=${dark['font-sans']}`);
