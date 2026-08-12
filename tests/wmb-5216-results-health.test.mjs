// WMB-5216 结果页「知识健康 · 结果回流」投影 —— renderer 聚焦合同测试。
// 覆盖：过滤准确（结果相关 issueType/affectedObjectType 全量接线）、同一 issue id 去重不复制、
// dataChanged health/knowledge/receipt scope 自动刷新、可访问性语义、
// 深链只走本页发布钻取（无额外路由）、状态/时间展示映射。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  formatHealthTime,
  mergeResultsHealthIssues,
  resolveResultsHealthIssue,
  resultsHealthStatusCls,
  shouldRefreshResultsHealth,
  RESULTS_HEALTH_AFFECTED_TYPES,
  RESULTS_HEALTH_ISSUE_TYPES,
  RESULTS_HEALTH_REFRESH_SCOPES,
} from '../src/renderer/results-health.ts';

const issue = (overrides = {}) => ({
  id: 'health-review-1',
  scope: 'global',
  issueType: 'unreturned_review',
  affectedObjectType: 'review',
  affectedObjectId: 'review-1',
  severity: 'medium',
  evidence: {},
  suggestedAction: '等待 Review 回流；回流 ChangeSet 出现后自动解决。',
  status: 'open',
  resolutionNote: null,
  resolvedChangeSetId: null,
  detectedAt: '2026-08-12T01:00:00.000Z',
  updatedAt: '2026-08-12T01:00:00.000Z',
  resolvedAt: null,
  revision: 1,
  ...overrides,
});

const page = (items) => ({ items, total: items.length, limit: 50, offset: 0, hasMore: false });

// ---------------------------------------------------------------------------
// 过滤准确：结果相关 issueType / affectedObjectType 词典
// ---------------------------------------------------------------------------

test('WMB-5216 UI: results health taxonomy covers review/publication flowback types only', () => {
  assert.deepEqual([...RESULTS_HEALTH_ISSUE_TYPES].sort(), ['underperforming_method', 'unreturned_review']);
  assert.deepEqual([...RESULTS_HEALTH_AFFECTED_TYPES].sort(), ['metric_snapshot', 'publication', 'review']);
  // 与结果无关的类型/对象不在词典内（不会误捞）
  assert.ok(!RESULTS_HEALTH_ISSUE_TYPES.includes('stale_wiki_page'));
  assert.ok(!RESULTS_HEALTH_ISSUE_TYPES.includes('duplicate_entity'));
  assert.ok(!RESULTS_HEALTH_AFFECTED_TYPES.includes('source'));
  assert.ok(!RESULTS_HEALTH_AFFECTED_TYPES.includes('wiki_page'));
});

test('WMB-5216 UI: panel queries listHealthIssues once per results-related type and affected type', async () => {
  const healthTsx = await readFile(new URL('../src/renderer/results-health.tsx', import.meta.url), 'utf8');
  // 每路查询都复用既有只读通道 listHealthIssues（不新增通道/schema）
  assert.match(healthTsx, /window\.wmb\.listHealthIssues/);
  // issueType 维度：unreturned_review + underperforming_method 各一路
  assert.match(healthTsx, /RESULTS_HEALTH_ISSUE_TYPES\.map/);
  // affectedObjectType 维度：review + publication + metric_snapshot 各一路
  assert.match(healthTsx, /RESULTS_HEALTH_AFFECTED_TYPES\.map/);
  // 查询有界（每路 limit，不倾倒全量问题队列）
  assert.match(healthTsx, /limit: RESULTS_HEALTH_QUERY_LIMIT/);
  // 合并统一按真实 issue.id 去重
  assert.match(healthTsx, /mergeResultsHealthIssues\(pages\)/);
});

// ---------------------------------------------------------------------------
// 同一 issue id 未复制：重叠查询去重 + 排序
// ---------------------------------------------------------------------------

test('WMB-5216 UI: merge dedupes the same issue id across overlapping queries', () => {
  const same = issue();
  const pages = [
    page([same]), // issueType=unreturned_review 命中
    page([{ ...same }]), // affectedObjectType=review 再次命中（同一 id）
    page([issue({ id: 'health-method-2', issueType: 'underperforming_method', affectedObjectType: 'publication', affectedObjectId: 'pub-2' })]),
  ];
  const merged = mergeResultsHealthIssues(pages);
  assert.equal(merged.length, 2);
  assert.equal(merged.filter((item) => item.id === same.id).length, 1); // 未复制
  assert.deepEqual(merged.map((item) => item.id), ['health-method-2', 'health-review-1']);
});

test('WMB-5216 UI: merge tolerates null/empty pages and sorts active first then severity then recency', () => {
  const merged = mergeResultsHealthIssues([
    null,
    undefined,
    page([]),
    page([
      issue({ id: 'a', status: 'resolved', severity: 'critical', detectedAt: '2026-08-12T03:00:00.000Z' }),
      issue({ id: 'b', status: 'repairing', severity: 'low', detectedAt: '2026-08-12T02:00:00.000Z' }),
      issue({ id: 'c', status: 'open', severity: 'critical', detectedAt: '2026-08-12T04:00:00.000Z' }),
      issue({ id: 'd', status: 'open', severity: 'medium', detectedAt: '2026-08-12T01:00:00.000Z' }),
    ]),
  ]);
  // active（open/repairing）优先 → 严重度降序 → 检测时间新→旧；resolved 殿后
  // c(open,critical) → d(open,medium) → b(repairing,low) → a(resolved,critical)
  assert.deepEqual(merged.map((item) => item.id), ['c', 'd', 'b', 'a']);
  assert.deepEqual(mergeResultsHealthIssues([]), []);
});

// ---------------------------------------------------------------------------
// dataChanged 刷新：health/knowledge/receipt scope
// ---------------------------------------------------------------------------

test('WMB-5216 UI: refresh scope gate matches lint/flowback broadcast contract', () => {
  assert.deepEqual(RESULTS_HEALTH_REFRESH_SCOPES, ['health', 'knowledge', 'receipt']);
  assert.equal(shouldRefreshResultsHealth(['health']), true);
  assert.equal(shouldRefreshResultsHealth(['knowledge']), true);
  assert.equal(shouldRefreshResultsHealth(['receipt']), true);
  assert.equal(shouldRefreshResultsHealth(['health', 'today']), true);
  assert.equal(shouldRefreshResultsHealth(['knowledge', 'topics', 'canvas', 'health', 'receipt', 'library']), true);
  assert.equal(shouldRefreshResultsHealth(['today']), false);
  assert.equal(shouldRefreshResultsHealth(['proposals', 'agent']), false);
  assert.equal(shouldRefreshResultsHealth([]), true);
  assert.equal(shouldRefreshResultsHealth(null), true);
});

test('WMB-5216 UI: panel subscribes onDataChanged and reloads only on matched scopes', async () => {
  const healthTsx = await readFile(new URL('../src/renderer/results-health.tsx', import.meta.url), 'utf8');
  assert.match(healthTsx, /window\.wmb\.onDataChanged/);
  assert.match(healthTsx, /shouldRefreshResultsHealth\(event\.scopes\)/);
  assert.match(healthTsx, /void load\(\)/);
  // 订阅在卸载时清理（effect 直接返回 onDataChanged 的退订函数；refreshNote 定时器同样清理）
  assert.match(healthTsx, /return window\.wmb\.onDataChanged/);
  assert.match(healthTsx, /return \(\) => window\.clearTimeout\(timer\)/);
});

// ---------------------------------------------------------------------------
// 可访问性语义 + 展示映射
// ---------------------------------------------------------------------------

test('WMB-5216 UI: panel exposes semantic region, live status, alert error, and list items keyed by real issue id', async () => {
  const healthTsx = await readFile(new URL('../src/renderer/results-health.tsx', import.meta.url), 'utf8');
  assert.match(healthTsx, /aria-label="知识健康 · 结果回流"/);
  assert.match(healthTsx, /role="status"/); // 加载与刷新提示为 polite live region
  assert.match(healthTsx, /role="alert"/); // 错误态可被屏幕阅读器打断
  assert.match(healthTsx, /<ul className="rl-health-list">/);
  assert.match(healthTsx, /<li className="rl-health-item" key=\{issue\.id\}>/); // key 即真实 issue id
  // 空态与错误态文案明确
  assert.match(healthTsx, /没有与结果\/复盘相关的知识健康问题/);
  assert.match(healthTsx, /健康问题读取失败/);
  assert.match(healthTsx, /重试/);
});

test('WMB-5216 UI: status and time display mappings', () => {
  assert.equal(resultsHealthStatusCls('open'), 'amber');
  assert.equal(resultsHealthStatusCls('repairing'), 'blue');
  assert.equal(resultsHealthStatusCls('resolved'), 'green');
  assert.equal(resultsHealthStatusCls('false_positive'), 'green');
  assert.equal(resultsHealthStatusCls('accepted_risk'), 'amber');
  assert.equal(resultsHealthStatusCls('unknown'), 'amber');
  assert.equal(resultsHealthStatusCls(null), 'amber');
  assert.equal(formatHealthTime('2026-08-12T01:00:00.000Z').length > 0, true);
  assert.equal(formatHealthTime('not-a-date'), 'not-a-date');
  assert.equal(formatHealthTime(null), '');
});

// ---------------------------------------------------------------------------
// 深链：只走本页已有发布钻取（无额外路由）
// ---------------------------------------------------------------------------

test('WMB-5216 UI: affected objects resolve to in-page publication drill targets only', () => {
  const ctx = {
    publications: [{ id: 'pub-1', title: '测试标题' }],
    reviews: [{ id: 'review-1', publicationId: 'pub-1' }],
    snapshots: [{ id: 'snap-1', publicationId: 'pub-1' }],
  };
  // review → 经同一 review id 映射到 publicationId（本页已有钻取）
  assert.deepEqual(resolveResultsHealthIssue(issue(), ctx), {
    target: { kind: 'publication', publicationId: 'pub-1', title: '测试标题' },
    affectedLabel: '测试标题 的复盘',
  });
  // publication → 直接钻取
  assert.deepEqual(
    resolveResultsHealthIssue(issue({ affectedObjectType: 'publication', affectedObjectId: 'pub-1' }), ctx),
    { target: { kind: 'publication', publicationId: 'pub-1', title: '测试标题' }, affectedLabel: '测试标题' }
  );
  // metric_snapshot → 经快照映射到 publicationId
  assert.deepEqual(
    resolveResultsHealthIssue(issue({ affectedObjectType: 'metric_snapshot', affectedObjectId: 'snap-1' }), ctx),
    { target: { kind: 'publication', publicationId: 'pub-1', title: '测试标题' }, affectedLabel: '测试标题 的指标快照' }
  );
  // 复盘对象不在本页加载集合 → 无可钻取目标（不渲染按钮），但仍展示受影响对象
  assert.deepEqual(resolveResultsHealthIssue(issue({ affectedObjectId: 'review-missing' }), ctx), {
    target: null,
    affectedLabel: '复盘 review-m',
  });
  // 全局问题（无受影响对象）→ 无深链
  assert.deepEqual(resolveResultsHealthIssue(issue({ affectedObjectType: null, affectedObjectId: null }), ctx), {
    target: null,
    affectedLabel: '全局',
  });
  // 非结果类受影响对象（如 wiki_page）→ 无深链，标签回退「对象 + id 前缀」
  assert.deepEqual(
    resolveResultsHealthIssue(issue({ affectedObjectType: 'wiki_page', affectedObjectId: 'page-123' }), ctx),
    { target: null, affectedLabel: '对象 page-123' }
  );
});

test('WMB-5216 UI: panel never opens cross-page routes or writes; results page wires deep link to existing drill', async () => {
  const healthTsx = await readFile(new URL('../src/renderer/results-health.tsx', import.meta.url), 'utf8');
  const resultsView = await readFile(new URL('../src/renderer/results-view.tsx', import.meta.url), 'utf8');
  // 无额外路由：不调用深链解析、不做跨页导航、不访问 location/history
  assert.doesNotMatch(healthTsx, /resolveKnowledgeDeepLink/);
  assert.doesNotMatch(healthTsx, /navigate\(/);
  assert.doesNotMatch(healthTsx, /location/);
  assert.doesNotMatch(healthTsx, /history/);
  // 无写能力：只读 listHealthIssues（无 apply/change-set 写通道调用）
  assert.doesNotMatch(healthTsx, /change-set-apply|changeSetApply|startResultsReview/);
  // 结果页接线：面板接收本页 posts/reviews/snapshots，深链 = 已有 setSelectedId 钻取
  assert.match(resultsView, /<ResultsHealthPanel publications=\{posts\} reviews=\{reviews\} snapshots=\{snapshots\}/);
  assert.match(resultsView, /onOpenPublication=\{\(publicationId\) => setSelectedId\(publicationId\)\}/);
});
