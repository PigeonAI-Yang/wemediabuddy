import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'src', 'renderer');
const foundationPath = path.join(rendererDir, 'styles-foundation.css');
const allowlistPath = path.join(root, 'tests', 'design-tokens-hex-allowlist.json');

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]+\)|\bhsla?\([^)]+\)/g;

function listStyleFiles() {
  return fs
    .readdirSync(rendererDir)
    .filter((name) => /^styles-.*\.css$/.test(name) && name !== 'styles-foundation.css')
    .map((name) => path.join(rendererDir, name))
    .sort();
}

function collectHits(filePath) {
  const rel = path.relative(root, filePath).split(path.sep).join('/');
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(COLOR_RE)) {
      hits.push({ file: rel, line: index + 1, match: match[0] });
    }
  });
  return hits;
}

function hitKey(hit) {
  return `${hit.file}:${hit.line}:${hit.match}`;
}

test('foundation anchors: accent, Inter, topbar 56px', () => {
  const css = fs.readFileSync(foundationPath, 'utf8');
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf(':root[data-theme="light"]'));
  assert.match(rootBlock, /--accent:\s*#8b7cff\b/i);
  assert.match(rootBlock, /--font-sans:\s*[^;]*"Inter"/);
  assert.match(rootBlock, /--topbar-height:\s*56px\b/);
});

test('page CSS color literals stay within shrink-only allowlist', () => {
  const allow = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  assert.ok(Array.isArray(allow.entries), 'allowlist.entries must be an array');
  assert.match(String(allow.comment || ''), /shrink only/i);

  const allowed = new Set(allow.entries.map(hitKey));
  const current = listStyleFiles().flatMap(collectHits);
  const unexpected = current.filter((hit) => !allowed.has(hitKey(hit)));

  assert.equal(
    unexpected.length,
    0,
    unexpected.length
      ? `New hard-coded colors outside allowlist (use var(--token) or shrink allowlist intentionally):\n${unexpected
          .slice(0, 20)
          .map((h) => `  ${h.file}:${h.line} ${h.match}`)
          .join('\n')}${unexpected.length > 20 ? `\n  … +${unexpected.length - 20} more` : ''}`
      : ''
  );
});

test('allowlist comment documents Phase 3 shrink policy', () => {
  const allow = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  assert.match(String(allow.comment), /Phase 3|shrink only/i);
});
