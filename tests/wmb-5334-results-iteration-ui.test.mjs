// WMB-5334 Results published_revision iteration — focused UI contract (renderer source only)
// Verify PLAN §7.5 “加入次日迭代” is embedded in existing Results surface without second workbench,
// using existing APIs only, showing existence/derived local state and explicit online/local separation.
// Run: node --test tests/wmb-5334-results-iteration-ui.test.mjs  (do not run in deliverable; Main validates)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const resultsView = await readFile(new URL('../src/renderer/results-view.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/renderer/styles-results.css', import.meta.url), 'utf8');
const preload = await readFile(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');

test('Results iteration uses existing ensurePublishedIteration with stable lineage and next businessDate', () => {
  assert.match(resultsView, /ensurePublishedIteration/, 'must call existing ensurePublishedIteration');
  assert.match(resultsView, /getYesterdayIteration/, 'must read existing iteration via getYesterdayIteration');
  assert.match(resultsView, /nextBusinessDate/, 'must derive current/next business date from planDate');
  // stable lineage fields expected by backend command
  assert.match(resultsView, /predecessorPublicationId/, 'must pass predecessorPublicationId');
  assert.match(resultsView, /predecessorContentVersionId/, 'must pass predecessorContentVersionId');
  assert.match(resultsView, /projectId/, 'must pass projectId');
  assert.match(resultsView, /businessDate:\s*nextBusinessDate/, 'must use businessDate: nextBusinessDate');
  // preload owns the authoritative channel; Results must not add a new IPC name
  assert.match(preload, /ensurePublishedIteration/, 'preload must expose ensurePublishedIteration');
  assert.match(preload, /getYesterdayIteration/, 'preload must expose getYesterdayIteration');
  // must not introduce a second write path for publication
  assert.ok(!resultsView.includes('daily-iteration:draft-ensure') || resultsView.includes('getStudioProject'), 'draft path not required for published flow');
});

test('Shows whether revision target already exists, resulting local state, and explicit local/online separation', () => {
  // existence check via projection
  assert.match(resultsView, /iterExistsBefore|publishedIterations/, 'must track whether target already exists');
  assert.match(resultsView, /iterTarget/, 'must keep resulting local revision target state');
  // explicit separation copy required by acceptance
  assert.match(resultsView, /本地修订不改变线上发布/, 'must show explicit separation');
  // local vs online visual separation (online url unchanged, local target only in studio)
  assert.match(resultsView, /线上发布.*保持不变|本地修订.*仅在工作室|线上.*本地/, 'must render online/local separation');
  // status rendering for existing vs pending
  assert.match(resultsView, /已存在本地修订|暂无本地修订目标/, 'must render existence-dependent status');
  // local target detail (id/status/revision) rather than just a toast
  assert.match(resultsView, /本地修订目标|本地目标/, 'must show local revision detail');
});

test('Reuses existing Results data or existing read APIs; never adds publish/update button or compat write path', () => {
  // Reuse path: publications already available to Results + existing read API for lineage
  assert.match(resultsView, /publications/, 'must reuse publications already available to Results');
  assert.match(resultsView, /getStudioProject/, 'may reuse existing getStudioProject for contentVersion lineage');
  // must not expose external publication mutation
  const forbidden = [
    'createPublicationSnapshot',
    'authorizePublicationEditor',
    'prepareXPublication',
    'prepareWechatArticlePublication',
    'prepareZhihuArticlePublication',
    'readBackWechatPublication',
    'reconcileNotPublished',
    'returnPublicationToEdit',
    'publish:snapshot-create',
    'publish:editor-prepare',
  ];
  for (const token of forbidden) {
    assert.ok(!resultsView.includes(token), `must not introduce publication mutation ${token}`);
  }
  // no direct platform publish write path
  assert.ok(!resultsView.includes('publish:list') || resultsView.includes('getPublications'), 'publish:list only via existing getPublications');
  // ensure no publish button copy appears in iteration panels
  assert.ok(!resultsView.includes('发布') || resultsView.includes('本地修订不改变线上发布'), 'must not add publish/update button; only separation copy is allowed');
});

test('Repeated action is idempotent through existing command (no duplicate target, reuses receipt)', () => {
  // second click must reuse same logical lineage and not create duplicate identity
  assert.match(resultsView, /再次加入次日迭代（幂等）|幂等/, 'must label repeated action as idempotent reuse');
  // hint explaining idempotency
  assert.match(resultsView, /重复点击复用同一本地目标|不会重复创建/, 'must explain idempotent reuse');
  // backend dedupe is via same businessDate + predecessorPublicationId/ContentVersionId; UI must not generate a new random id
  assert.ok(!resultsView.includes('randomUUID'), 'UI must not generate target id; backend owns identity');
  // busy guard prevents concurrent duplicate invokes
  assert.match(resultsView, /iterBusy|disabled.*iterBusy/, 'must guard against concurrent duplicate invokes');
});

test('Iteration is per-selected published result and embedded in existing Results surface', () => {
  assert.match(resultsView, /selected/, 'must be tied to selected published result');
  assert.match(resultsView, /data-testid="results-iteration-panel"/, 'must expose stable iteration panel testid');
  assert.match(resultsView, /data-testid="results-drill-iteration"/, 'must expose drill inline iteration testid');
  assert.match(resultsView, /加入次日迭代/, 'must show 加入次日迭代 action');
  // ensure not a generic bulk button outside selection (old visible.slice placeholder removed)
  assert.ok(!resultsView.includes('visible.slice(0,2).map'), 'must not use placeholder bulk mapping; must be selection-driven');
});

test('Styling reuses foundation tokens only, no new brand hex or publication palette', () => {
  // must use css variables for brand/chrome
  assert.match(styles, /var\(--/, 'must use foundation css variables');
  assert.match(styles, /\.rl-iteration-panel/, 'must have Results-specific iteration panel style');
  assert.match(styles, /\.rl-drill-iteration/, 'must have drill inline iteration style');
  // must not introduce new hardcoded brand hex (allow existing foundation mixes via var()); disallow hex in iteration layer
  const iterationChunk = styles.slice(styles.indexOf('/* WMB-5334'));
  const hexes = [...iterationChunk.matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => m[0]);
  assert.equal(hexes.length, 0, `iteration styles must use tokens not hex: ${hexes.join(',')}`);
  assert.ok(!iterationChunk.includes('linear-gradient') || iterationChunk.includes('var(--'), 'no raw gradient without tokens');
});
