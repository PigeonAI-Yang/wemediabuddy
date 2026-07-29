import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('scaffold keeps the renderer sandboxed', async () => {
  const window = await readFile(new URL('../src/main/app-window.ts', import.meta.url), 'utf8');
  assert.match(window, /contextIsolation: true/);
  assert.match(window, /nodeIntegration: false/);
  assert.match(window, /sandbox: true/);
});

test('automatic final publication is not exposed through any bridge', async () => {
  const preload = await readFile(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
  const mcp = await readFile(new URL('../src/main/mcp.ts', import.meta.url), 'utf8');
  const main = await Promise.all([
    readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/main/ipc-publishing-results.ts', import.meta.url), 'utf8')
  ]).then((parts) => parts.join('\n'));
  assert.doesNotMatch(preload, /confirmPublication|publish:confirm/);
  assert.doesNotMatch(mcp, /confirmAndStartPublication|publishing\.confirm/);
  assert.doesNotMatch(main, /publish:confirm|publishXText|publishXImage|publishXVideo|publishXiaohongshuImage|publishWechatArticle/);
  assert.doesNotMatch(main, /publish:prepare-xiaohongshu|identifyXiaohongshuAccount|prepareXiaohongshuImage/);
  assert.doesNotMatch(preload, /prepareXiaohongshu/);
});
