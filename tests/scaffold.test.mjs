import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('scaffold keeps the renderer sandboxed', async () => {
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
});

test('automatic final publication is not exposed through any bridge', async () => {
  const preload = await readFile(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
  const mcp = await readFile(new URL('../src/main/mcp.ts', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(preload, /confirmPublication|publish:confirm/);
  assert.doesNotMatch(mcp, /confirmAndStartPublication|publishing\.confirm/);
  assert.doesNotMatch(main, /publish:confirm|publishXText|publishXImage|publishXVideo|publishXiaohongshuImage|publishWechatArticle/);
  assert.doesNotMatch(main, /publish:prepare-xiaohongshu|identifyXiaohongshuAccount|prepareXiaohongshuImage/);
  assert.doesNotMatch(preload, /prepareXiaohongshu/);
});
