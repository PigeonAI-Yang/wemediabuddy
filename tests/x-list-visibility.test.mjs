import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseVisibleXListIds, setListVisibility } from '../src/renderer/x-list-visibility.ts';

test('List display selection is independent, root-storable UI state', async () => {
  assert.equal(parseVisibleXListIds(null), null);
  assert.deepEqual(parseVisibleXListIds('["2","1","2",null]'), ['2', '1']);
  assert.deepEqual(setListVisibility(['1'], '2', true), ['1', '2']);
  assert.deepEqual(setListVisibility(['1', '2'], '1', false), ['2']);
  const css = await readFile(new URL('../src/renderer/styles-x-lists-timeline.css', import.meta.url), 'utf8');
  const discover = await readFile(new URL('../src/renderer/x-lists-view.tsx', import.meta.url), 'utf8');
  const ipc = await readFile(new URL('../src/main/ipc-x-lists.ts', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../src/renderer/x-list-display-settings.tsx', import.meta.url), 'utf8');
  assert.match(css, /\.x-timeline-more,[\s\S]*?align-items:\s*center/);
  assert.doesNotMatch(discover, /管理显示/);
  assert.match(settings, /List 工作台显示/);
  assert.match(settings, /不会改变今日情报来源/);
  const mountCache = discover.slice(discover.indexOf('void (async () => {'), discover.indexOf('}, []);', discover.indexOf('void (async () => {')));
  assert.match(mountCache, /getCachedXListIndex/);
  assert.doesNotMatch(mountCache, /readXListIndex/);
  const cachedIndexHandler = ipc.slice(ipc.indexOf("ipcMain.handle('x-lists:get-cached-index'"), ipc.indexOf("ipcMain.handle('x-lists:read-index'"));
  assert.match(cachedIndexHandler, /readXListIndexCache/);
  assert.doesNotMatch(cachedIndexHandler, /currentXListContext/);
});
