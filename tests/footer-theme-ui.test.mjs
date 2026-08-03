import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('footer owns the X operation trigger and theme icons match current state', async () => {
  const main = await readFile(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
  const foundation = await readFile(new URL('../src/renderer/styles-foundation.css', import.meta.url), 'utf8');
  const pi = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  const left = main.slice(main.indexOf('<div className="status-bar-left">'), main.indexOf('<div className="status-bar-right">'));
  assert.match(left, /<XListOperationTray\/>/);
  assert.match(main, /theme === 'dark' \? '☾' : '☀'/);
  assert.match(foundation, /\.status-bar-left \{ overflow: hidden; \}/);
  assert.match(pi, /\.x-list-operation-trigger \{ position: static;/);
  assert.doesNotMatch(pi, /\.x-list-operation-trigger \{[^}]*position: fixed/);
});
