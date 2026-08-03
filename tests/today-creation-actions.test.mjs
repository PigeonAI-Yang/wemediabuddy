import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Today carry-over rows expose creation, not management actions', async () => {
  const source = await readFile(new URL('../src/renderer/today-view-panels.tsx', import.meta.url), 'utf8');
  assert.match(source, /CreateIconButton/);
  assert.doesNotMatch(source, />继续做</);
  assert.doesNotMatch(source, />观察</);
  assert.doesNotMatch(source, />不再显示</);
});
