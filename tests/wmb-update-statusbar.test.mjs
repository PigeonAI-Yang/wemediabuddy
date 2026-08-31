// WMB-update-statusbar: verify top banner removal and status-bar warning contract (source-level).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const banner = await readFile(new URL('../src/renderer/app-update-banner.tsx', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
const appUpdateCss = await readFile(new URL('../src/renderer/styles-app-update.css', import.meta.url), 'utf8');
const foundation = await readFile(new URL('../src/renderer/styles-foundation.css', import.meta.url), 'utf8');

test('WMB-update-statusbar: top red banner removed from workspace', () => {
  // AppUpdateBanner must be a null passthrough — no top section rendered
  assert.match(banner, /export function AppUpdateBanner\([^)]*\)[^{]*\{[\s\S]*?return null/);
  assert.doesNotMatch(banner, /<section[^>]*app-update-banner error/);
  // main.tsx must not mount the banner at the top
  assert.doesNotMatch(main, /<AppUpdateBanner/);
  // CSS banner is hidden / removed
  assert.match(appUpdateCss, /\.app-update-banner[^}]*display:\s*none/);
});

test('WMB-update-statusbar: attention state projects as compact warning in bottom status bar', () => {
  // Status item exists and uses warning/amber tokens, not danger/red
  assert.match(banner, /export function AppUpdateStatusItem/);
  assert.match(banner, /更新未完成/);
  assert.match(banner, /status === 'error'.*lastError/);
  assert.match(banner, /status-item status-update-warn/);
  assert.match(banner, /status-dot warn/);
  assert.match(banner, /title=\{title\}/);
  assert.match(banner, /aria-label/);
  assert.match(banner, /aria-describedby/);
  // main mounts the item inside the footer status bar
  assert.match(main, /AppUpdateStatusItem/);
  assert.match(main, /<footer className="status-bar">/);
  const footer = main.slice(main.indexOf('<footer className="status-bar">'));
  assert.match(footer, /AppUpdateStatusItem/);
  assert.match(footer, /status-bar-left/);
  // warning styling uses existing amber tokens
  assert.match(foundation, /\.status-update-warn/);
  assert.match(foundation, /color:\s*var\(--amber\)/);
  assert.match(foundation, /background:\s*var\(--amber-soft\)/);
  assert.doesNotMatch(foundation, /\.status-update-warn[^}]*var\(--danger\)/);
});

test('WMB-update-statusbar: status item is actionable and opens update settings', () => {
  assert.match(banner, /onClick=\{openSettings\}/);
  assert.match(banner, /onKeyDown/);
  assert.match(banner, /Enter/);
  assert.match(main, /AppUpdateStatusItem openSettings=\{\(\) => navigate\('settings'\)\}/);
});

test('WMB-update-statusbar: idle/success states do not add noise', () => {
  assert.match(banner, /if \(!failed\) return null/);
  // No rendering for checking/available/downloaded — only failed branch renders
  assert.doesNotMatch(banner, /availableVersion.*已准备好/);
  // Banner null path ensures workspace top area stays clean even when state is null
  assert.match(banner, /if \(!state\) return null/);
});
