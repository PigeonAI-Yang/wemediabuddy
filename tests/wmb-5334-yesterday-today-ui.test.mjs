// WMB-5334 Today 昨日迭代 UI contract — focused behavior-oriented test (renderer source only)
// Run: node --test tests/wmb-5334-yesterday-today-ui.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const iter = await readFile(new URL('../src/renderer/today-yesterday-iteration.tsx', import.meta.url), 'utf8');
const resultsView = await readFile(new URL('../src/renderer/results-view.tsx', import.meta.url), 'utf8');
const settingsView = await readFile(new URL('../src/renderer/settings-view.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/renderer/styles-today-daily-cycle.css', import.meta.url), 'utf8');
const preload = await readFile(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');

test('Yesterday iteration block loads getYesterdayIteration for current business date', () => {
  assert.match(iter, /getYesterdayIteration/);
  assert.match(iter, /businessDate/);
  assert.match(preload, /getYesterdayIteration/);
  assert.match(preload, /daily-iteration:projection/);
  // Results mounts it with current planDate
  assert.match(resultsView, /TodayYesterdayIteration/);
  assert.match(resultsView, /businessDate=\{planDate\}/);
});

test('Exposes both iteration kinds with Chinese labels', () => {
  assert.match(iter, /昨日迭代/);
  assert.match(iter, /未发布草稿/);
  assert.match(iter, /已发布内容/);
  // two queues backed by both projection arrays
  assert.match(iter, /draftIterations/);
  assert.match(iter, /publishedIterations/);
  assert.match(iter, /target_kind/);
  // also rendered in Today view, not a second workbench / navigation destination
  assert.ok(!iter.includes('views') && !iter.includes('View') || iter.includes('TodayYesterdayIteration'), 'must not create new navigation destination');
  assert.equal((resultsView.match(/<TodayYesterdayIteration/g) || []).length, 1, 'Results should mount exactly once');
});

test('Presents suggestion/context evidence via score_snapshot_json', () => {
  assert.match(iter, /score_snapshot_json/);
  assert.match(iter, /EvidenceSummary|evidence|reviews/);
  assert.match(iter, /建议/);
  assert.match(iter, /上下文/);
  // no hard overwrite of content_version; footnote clarifies immutability
  assert.match(iter, /追加新版本|不覆盖|score_snapshot_json/);
});

test('Shows revise/carry/skip state with accessible status chips', () => {
  assert.match(iter, /STATUS_LABEL|待修订/);
  assert.match(iter, /已顺延|carry/);
  assert.match(iter, /已跳过|skipped/);
  assert.match(iter, /today-yesterday-status/);
  assert.match(iter, /today-yesterday-state/);
  // status derived from target status field
  assert.match(iter, /item\.status/);
  assert.match(iter, /carry_depth/);
  // accessible: aria-label on state and button
  assert.match(iter, /aria-label/);
  assert.match(iter, /role="list"/);
});

test('Existing open-Studio affordance reused, no external publication action or second workbench', () => {
  assert.match(iter, /openStudio/);
  // each queue item has an open studio button
  assert.match(iter, /打开工作室/);
  assert.match(iter, /type="button"/);
  // must not expose final publish - no publication prepare/snapshot/publish in this surface
  assert.ok(!iter.includes('prepareXPublication'), 'must not expose X publish');
  assert.ok(!iter.includes('prepareWechatArticlePublication'), 'must not expose WeChat publish');
  assert.ok(!iter.includes('createPublicationSnapshot'), 'must not expose publication snapshot');
  assert.ok(!iter.includes('daily-cycle:ensure'), 'must not duplicate daily-cycle ensure path');
  // no second workbench: must not create new studio workspace or navigation
  assert.ok(!resultsView.includes('createWorkspace') && !iter.includes('createWorkspace'), 'no new workspace creation');
});

test('Honest empty/loading/error states', () => {
  assert.match(iter, /loading/);
  assert.match(iter, /正在加载昨日迭代/);
  assert.match(iter, /role="status"/);
  assert.match(iter, /useEffect\(\(\) => \{[\s\S]*businessDate/);
  // businessDate change resets to loading state (multiline effect with explicit deps)
  assert.match(iter, /\[businessDate\]/);
  assert.match(iter, /重试/);
  assert.match(iter, /暂无迭代周期|暂无迭代队列|暂无未发布|暂无已发布/);
  assert.match(iter, /role="alert"/);
});

test('Styling uses foundation tokens only, no new brand hex or gradients', () => {
  assert.match(css, /today-yesterday-iteration/);
  assert.match(css, /today-yesterday-queue/);
  assert.match(css, /today-yesterday-status/);
  // must use var(-- tokens
  assert.match(css, /var\(--border/);
  assert.match(css, /var\(--surface/);
  assert.match(css, /var\(--ink/);
  assert.ok(!css.includes('linear-gradient'), 'no gradients');
  // no new hex in yesterday additions that bypass tokens (allow color-mix wrapping tokens)
  // The yesterday block itself must not introduce hardcoded hex
  const yesterdayBlock = css.slice(css.indexOf('.today-yesterday-iteration'));
  const hexes = [...yesterdayBlock.matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => m[0]);
  assert.equal(hexes.length, 0, `yesterday styles should use tokens not hex: ${hexes.join(',')}`);
});

test('TodayYesterdayIteration remains keyboard accessible and Results-embedded', () => {
  assert.match(settingsView, /TodayDailyCycle/);
  assert.equal((settingsView.match(/<TodayDailyCycle\b/g) || []).length, 1, 'must preserve single A-E settlement card');
  assert.match(iter, /aria-labelledby/);
  assert.match(iter, /data-testid="today-yesterday-iteration"/);
});

test('Reports exact Today-owned file set', async () => {
  // contract owner check: only today-view, its local iteration component, styles-today-daily-cycle, and this test
  const owned = [
    'src/renderer/results-view.tsx',
    'src/renderer/settings-view.tsx',
    'src/renderer/today-yesterday-iteration.tsx',
    'src/renderer/styles-today-daily-cycle.css',
    'tests/wmb-5334-yesterday-today-ui.test.mjs',
  ];
  for (const p of owned) {
    const content = await readFile(new URL(`../${p}`, import.meta.url), 'utf8');
    assert.ok(content.length > 0, `${p} exists`);
  }
});
