import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const zhihuViewUrl = new URL('../src/renderer/zhihu-hot-view.tsx', import.meta.url);
const cssUrl = new URL('../src/renderer/styles-workflow-library.css', import.meta.url);

test('WMB-5345 zhihu refresh has no header status text placeholder', async () => {
  const tsx = await readFile(zhihuViewUrl, 'utf8');
  const css = await readFile(cssUrl, 'utf8');
  assert.doesNotMatch(tsx, /zhihu-hot-refresh-status/);
  assert.doesNotMatch(tsx, /refreshStatus/);
  assert.doesNotMatch(tsx, /正在刷新…/);
  assert.doesNotMatch(tsx, /刷新成功 ·/);
  assert.doesNotMatch(tsx, /需要处理知乎登录/);
  assert.doesNotMatch(css, /\.zhihu-hot-refresh-status/);
});

test('WMB-5345 refresh button state machine: idle/loading/success/failure in place', async () => {
  const tsx = await readFile(zhihuViewUrl, 'utf8');
  assert.match(tsx, /RefreshState.*'idle'.*'loading'.*'success'.*'failure'/s);
  assert.match(tsx, /successTimerRef/);
  assert.match(tsx, /useRef/);
  assert.match(tsx, /refreshState.*loading/);
  assert.match(tsx, /zhihu-refresh-button/);
  assert.match(tsx, /is-\$\{refreshState\}/);
  assert.match(tsx, /disabled=\{refreshState === 'loading'\}/);
  assert.match(tsx, /aria-busy=\{refreshState === 'loading'\}/);
  assert.match(tsx, /aria-label=\{refreshButtonMeta\.label\}/);
  assert.match(tsx, /title=\{refreshButtonMeta\.title\}/);
  assert.match(tsx, /if \(refreshState === 'loading'\)/);
  assert.match(tsx, /icon: '↻'/);
  assert.match(tsx, /icon: '✓'/);
  assert.match(tsx, /icon: '!'/);
  assert.match(tsx, /setRefreshState\('success'\)/);
  assert.match(tsx, /setTimeout\(\(\) => setRefreshState\('idle'\), 1200\)/);
  assert.match(tsx, /setError\(message\)/);
  assert.match(tsx, /setRefreshState\('failure'\)/);
  assert.doesNotMatch(tsx, /refresh-status/);
  assert.match(tsx, /setRefreshState\('idle'\)/);
});

test('WMB-5345 a11y: loading disabled + aria-busy, failure has title/aria-label, success has accessible name', async () => {
  const tsx = await readFile(zhihuViewUrl, 'utf8');
  assert.match(tsx, /正在刷新知乎/);
  assert.match(tsx, /label: '刷新成功'/);
  assert.match(tsx, /title: '刷新成功'/);
  assert.match(tsx, /label: '刷新失败，请重试'/);
  assert.match(tsx, /title: '刷新失败，请重试'/);
  assert.match(tsx, /zhihu-refresh-icon/);
  assert.match(tsx, /aria-hidden="true"/);
});

test('WMB-5345 CSS 150-250ms transition, spinner sustainable, reduced-motion static alternative', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /\.zhihu-refresh-button[^}]*transition:[^}]*180ms/);
  assert.match(css, /\.zhihu-refresh-icon[^}]*transition:[^}]*180ms/);
  assert.match(css, /\.zhihu-refresh-button\.is-loading \.zhihu-refresh-icon[^}]*animation:\s*ranking-refresh-spin/);
  assert.match(css, /@keyframes ranking-refresh-spin/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  const reducedBlock = css.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\{([\s\S]*?)\}\s*\}/);
  assert.ok(reducedBlock, 'reduced-motion block exists');
  assert.match(css, /prefers-reduced-motion[\s\S]*animation:\s*none/);
  assert.match(css, /prefers-reduced-motion[\s\S]*transition:\s*none/);
});

test('WMB-5345 button keeps real error rendering in content area', async () => {
  const tsx = await readFile(zhihuViewUrl, 'utf8');
  assert.match(tsx, /读取失败/);
  assert.match(tsx, /\{error \? <section className="empty-state library-empty">/);
  assert.match(tsx, /catch \(cause\)[^}]*setError\(message\)/s);
  assert.match(tsx, /setRefreshState\('failure'\)/);
});

test('WMB-5345 ranking refresh spin keyframes remain and duration is not forced to 150-250ms', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /ranking-refresh-spin/);
  assert.doesNotMatch(css, /\.zhihu-refresh-button\.is-loading \.zhihu-refresh-icon[^}]*transition[^}]*700ms/);
});
