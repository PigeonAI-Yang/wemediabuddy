// WMB-5337 Today orchestration UI contract — renderer source only
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cycle = await readFile(new URL('../src/renderer/today-daily-cycle.tsx', import.meta.url), 'utf8');
const preload = await readFile(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
const settingsView = await readFile(new URL('../src/renderer/settings-view.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/renderer/styles-today-daily-cycle.css', import.meta.url), 'utf8');

test('Today orchestration uses existing window.wmb daily orchestration APIs only', () => {
  assert.match(cycle, /getDailyOrchestrationSchedule/);
  assert.match(cycle, /setDailyOrchestrationSchedule/);
  assert.match(cycle, /orchestrateDailyContent/);
  assert.match(preload, /getDailyOrchestrationSchedule/);
  assert.match(preload, /setDailyOrchestrationSchedule/);
  assert.match(preload, /orchestrateDailyContent/);
  // no second execution path introduced: must not call daily-cycle:ensure directly via ensureDailyCycle in this file
  assert.ok(!cycle.includes('ensureDailyCycle'), 'must not introduce second execution path');
});

test('Today orchestration shows Asia/Shanghai schedule, enable/disable, Run Now, in-progress guard', () => {
  assert.match(cycle, /Asia\/Shanghai/);
  assert.match(cycle, /立即执行/);
  assert.match(cycle, /启用自动|停用自动|autoEnabled/);
  assert.match(cycle, /aria-busy/);
  assert.match(cycle, /disabled.*running|running.*disabled/);
  assert.match(cycle, /scheduleBusy/);
});

test('Persisted settlement with five stage rows A–E and explicit status messaging', () => {
  for (const k of ['A', 'B', 'C', 'D', 'E']) assert.ok(cycle.includes(`'${k}'`) || cycle.includes(`"${k}"`), `missing stage ${k}`);
  assert.match(cycle, /昨日迭代/);
  assert.match(cycle, /热榜扫描/);
  assert.match(cycle, /评分选题/);
  assert.match(cycle, /研究与文章/);
  assert.match(cycle, /视频文案/);
  assert.match(cycle, /needs_user/);
  assert.match(cycle, /partial/);
  assert.match(cycle, /paused/);
  assert.match(cycle, /failed/);
  assert.match(cycle, /localStorage/);
  assert.match(cycle, /counts\.gap|gap/);
  assert.match(cycle, /counts\.blocked|blocked/);
  assert.match(cycle, /counts\.skipped|skipped/);
  assert.match(cycle, /counts\.carried|carried/);
});

test('Recovery affordances use existing navigation, no final publish action', () => {
  assert.match(cycle, /openStudio/);
  assert.ok(cycle.includes('openSettings') || cycle.includes('browser'), 'should link to existing settings navigation');
  assert.ok(!cycle.includes('publish') && !cycle.includes('发布') , 'must not expose final publication action');
  // visible settlement banners for needs_user/partial/paused/failed
  assert.match(cycle, /today-orchestration-banner--needs_user/);
  assert.match(cycle, /today-orchestration-banner--partial/);
  assert.match(cycle, /today-orchestration-banner--paused/);
  assert.match(cycle, /today-orchestration-banner--failed/);
});

test('TodayDailyCycle is mounted in Settings and remains keyboard accessible', () => {
  assert.match(settingsView, /TodayDailyCycle/);
  assert.match(cycle, /aria-label/);
  assert.match(cycle, /type="button"/);
});

test('Styling uses foundation tokens only, no new brand colors or gradients', () => {
  assert.ok(!css.includes('linear-gradient'), 'no gradients');
  // must use var(-- tokens
  assert.match(css, /var\(--/);
  // ensure no hex brand colors outside palette (allow existing foundation hexes only via tokens)
  // at minimum no new hardcoded brand hex in this layer beyond foundation
  const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => m[0]);
  // css should not introduce new hex outside token indirection; allow none
  assert.equal(hexes.length, 0, `should use tokens not hex: ${hexes.join(',')}`);
});
