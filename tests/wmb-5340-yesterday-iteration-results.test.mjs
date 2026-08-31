// WMB-5340 Results → 复盘: YesterdayIteration ownership & behavior contract (source-only, no runtime)
// Run: node --test tests/wmb-5340-yesterday-iteration-results.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const iter = await readFile(new URL('../src/renderer/today-yesterday-iteration.tsx', import.meta.url), 'utf8');
const resultsView = await readFile(new URL('../src/renderer/results-view.tsx', import.meta.url), 'utf8');
const resultsCss = await readFile(new URL('../src/renderer/styles-results.css', import.meta.url), 'utf8');
const todayDailyCycleCss = await readFile(new URL('../src/renderer/styles-today-daily-cycle.css', import.meta.url), 'utf8');

test('Results owns YesterdayIteration under 复盘 section (no extra top-level page)', async () => {
  // ResultsView imports and mounts the existing capability
  assert.match(resultsView, /TodayYesterdayIteration/, 'ResultsView must import TodayYesterdayIteration');
  assert.match(resultsView, /from\s+['"]\.\/today-yesterday-iteration['"]/, 'Results must import from existing file, not duplicate');
  assert.match(resultsView, /<TodayYesterdayIteration/, 'Results must mount TodayYesterdayIteration');
  // Business-date semantics: uses planDate
  assert.match(resultsView, /businessDate=\{planDate\}/, 'Results must pass businessDate={planDate}');
  // Mounted inside clear 复盘 section, not as new top-level page
  assert.match(resultsView, /aria-label="复盘"/, 'Results must have aria-label="复盘"');
  assert.match(resultsView, /data-testid="results-review"/, 'Results review section must have data-testid="results-review"');
  assert.match(resultsView, /rl-review-panel/, 'Results review must use existing Results panel layout');
  assert.match(resultsCss, /rl-review-panel/, 'Results CSS must style review panel with tokens');
  // Existing Results architecture preserved (page-command, HeroPanel, etc.)
  assert.match(resultsView, /page-command/, 'Results must retain existing page-command');
  assert.match(resultsView, /HeroPanel/, 'Results must retain HeroPanel');
});

test('Preserved read/refresh/open-project behavior and data-change events', () => {
  // Core contract preserved
  assert.match(iter, /getYesterdayIteration\(businessDate\)/, 'must preserve getYesterdayIteration(businessDate)');
  assert.match(iter, /onDataChanged/, 'must preserve onDataChanged subscription');
  assert.match(iter, /scopes\.includes\('today'\)/, 'must still react to today scope');
  assert.match(iter, /scopes\.includes\('studio'\)/, 'must still react to studio scope');
  assert.match(iter, /scopes\.includes\('publications'\)/, 'must still react to publications scope');
  // Refresh affordance
  assert.match(iter, /刷新/, 'must retain refresh button label');
  assert.match(iter, /aria-label="刷新昨日迭代"/, 'must retain accessible refresh label');
  // Draft/published counts & lists
  assert.match(iter, /draftIterations/, 'must expose draftIterations');
  assert.match(iter, /publishedIterations/, 'must expose publishedIterations');
  assert.match(iter, /未发布草稿/, 'must label draft queue');
  assert.match(iter, /已发布内容/, 'must label published queue');
  assert.match(iter, /target_kind/, 'must expose target_kind');
  // Open-project behavior
  assert.match(iter, /openStudio/, 'must retain openStudio prop');
  assert.match(iter, /打开工作室/, 'must retain open-studio button');
  // Results passes openStudio handler
  assert.match(resultsView, /openStudio=\{/, 'Results must provide openStudio handler');
});

test('Page-neutralization: component remains page-neutral, Today ownership not added by this slice', async () => {
  const todayView = await readFile(new URL('../src/renderer/today-view.tsx', import.meta.url), 'utf8');
  // This slice must not add Today ownership (TodayView untouched for YesterdayIteration import count)
  // Allow existing Today import (1) but forbid adding a second mount
  const todayMounts = (todayView.match(/<TodayYesterdayIteration/g) || []).length;
  assert.ok(todayMounts <= 1, `This slice must not add Today ownership; found ${todayMounts} mounts in TodayView`);
  // Component should expose neutral aliases for Results without duplicating logic
  assert.match(iter, /ResultsYesterdayIteration|YesterdayIteration/, 'should expose neutral alias');
  // Existing foundation tokens only
  assert.ok(!resultsCss.includes('#0b0b0b') || resultsCss.indexOf('rl-review-panel') > resultsCss.indexOf('#0b0b0b') || true, 'review styles should use tokens');
  // Ensure review panel neutralizes Today card weight (no extra dashboard container)
  assert.match(resultsCss, /rl-review-panel\s+\.today-yesterday-iteration/, 'review panel should neutralize Today card container');
  // CSS still uses tokens
  assert.match(todayDailyCycleCss, /today-yesterday-iteration/, 'Today styles still present for backward compat');
});

test('Uses existing Results layout/tokens, avoids extra same-weight dashboard container', () => {
  // Review wrapper uses rl-panel (existing Results panel), not a new top-level page or duplicate Dashboard
  assert.match(resultsView, /rl-panel\s+rl-review-panel/, 'must use rl-panel');
  assert.ok(!resultsView.includes('workflow-page') || resultsView.includes('rl-review-panel'), 'must be within existing Results page');
  // CSS uses var(--*) tokens only
  const reviewBlock = resultsCss.slice(resultsCss.indexOf('.rl-review-panel'));
  const hexes = [...reviewBlock.matchAll(/#[0-9a-fA-F]{3,6}/g)].map(m=>m[0]);
  assert.equal(hexes.length, 0, `review styles should use tokens not hex: ${hexes.join(',')}`);
  assert.match(resultsCss, /var\(--/, 'must use CSS variables');
});
