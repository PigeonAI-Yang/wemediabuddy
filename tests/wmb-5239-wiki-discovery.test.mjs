// WMB-5239 共享 Wiki 搜索/日志纯逻辑 —— renderer 聚焦合同测试。
// 覆盖：wiki-discovery-parts.ts（统一搜索/全局日志 hooks 的纯函数面：用户语言映射、
// 相对时间、日志→深链输入、dataChanged 刷新 scope 门、事件常量、loading/error/retry 语义）
// 与 topic-search-log.ts（主题范围切片：回执重叠跳过、主题事件/对象用户语言、
// source/wiki_page_version 深链取固定版本锚、topicId 过滤真实生效）。
// 深链桥/无新路由/键盘保留等跨页契约见同批次 wmb-5239-ui-contract 测试与真实 Electron E2E。
// 不做项目级 formatter/linter/全量测试；由主 Agent 集成后统一执行。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  WIKI_LOG_PAGE_LIMIT,
  WIKI_MAINTENANCE_EVENT,
  WIKI_NAVIGATE_EVENT,
  WIKI_SEARCH_DEBOUNCE_MS,
  WIKI_SEARCH_PAGE_LIMIT,
  formatWikiWhen,
  shouldRefreshWikiDiscovery,
  wikiLogEntryDeepLinkInput,
  wikiLogEventLabel,
  wikiLogObjectLabel,
  wikiSearchObjectLabel,
} from '../src/renderer/wiki-discovery-parts.ts';
import {
  TOPIC_LOG_RECEIPT_OVERLAP,
  TOPIC_LOG_SUPPLEMENTARY_EVENT_TYPES,
  isTopicLogSupplementary,
  topicIndexStatusLabel,
} from '../src/renderer/topic-search-log.ts';

// ---------------------------------------------------------------------------
// 统一搜索：用户语言映射（六类全覆盖 + 兜底）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: wikiSearchObjectLabel covers all six object types with user language and fallback', () => {
  assert.equal(wikiSearchObjectLabel('wiki_page'), 'Wiki 页面');
  assert.equal(wikiSearchObjectLabel('knowledge_note'), '知识笔记');
  assert.equal(wikiSearchObjectLabel('entity'), '实体');
  assert.equal(wikiSearchObjectLabel('topic'), '主题');
  assert.equal(wikiSearchObjectLabel('source'), '资料');
  assert.equal(wikiSearchObjectLabel('fixed_version_reference'), '版本引用');
  assert.equal(wikiSearchObjectLabel('unknown_type'), '知识对象');
});

// ---------------------------------------------------------------------------
// 全局日志：事件/对象用户语言（九类事件 + 七类对象全覆盖 + 兜底）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: wikiLogEventLabel covers all nine event types with user language and fallback', () => {
  assert.equal(wikiLogEventLabel('change_set'), '知识更新');
  assert.equal(wikiLogEventLabel('receipt'), '更新记录');
  assert.equal(wikiLogEventLabel('compile'), '页面已生成');
  assert.equal(wikiLogEventLabel('lint_detected'), '发现健康问题');
  assert.equal(wikiLogEventLabel('lint_resolved'), '健康问题已解决');
  assert.equal(wikiLogEventLabel('maintenance_started'), '开始全库整理');
  assert.equal(wikiLogEventLabel('maintenance_completed'), '全库整理完成');
  assert.equal(wikiLogEventLabel('query'), '问答写回');
  assert.equal(wikiLogEventLabel('source'), '资料摄取');
  assert.equal(wikiLogEventLabel('unknown_event'), '知识事件');
});

test('WMB-5239 UI: wikiLogObjectLabel covers all seven object types with user language and fallback', () => {
  assert.equal(wikiLogObjectLabel('change_set'), '知识更新');
  assert.equal(wikiLogObjectLabel('receipt'), '更新记录');
  assert.equal(wikiLogObjectLabel('wiki_page_version'), 'Wiki 页面');
  assert.equal(wikiLogObjectLabel('health_issue'), '健康问题');
  assert.equal(wikiLogObjectLabel('maintenance_run'), '全库整理');
  assert.equal(wikiLogObjectLabel('query_artifact'), '问答记录');
  assert.equal(wikiLogObjectLabel('source_revision'), '资料版本');
  assert.equal(wikiLogObjectLabel('unknown_object'), '知识对象');
});

// ---------------------------------------------------------------------------
// 用户语言：工程词禁令（compiled/receipt/changeset/hot-cache/index/cursor 不出现在用户映射）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: user-facing label maps never leak engineering terms', () => {
  const ENGINEERING = /compiled|receipt|changeset|hot[-_ ]?cache|index|cursor|offset|limit\b/i;
  for (const type of ['wiki_page', 'knowledge_note', 'entity', 'topic', 'source', 'fixed_version_reference']) {
    assert.doesNotMatch(wikiSearchObjectLabel(type), ENGINEERING, `搜索对象标签泄漏工程词: ${wikiSearchObjectLabel(type)}`);
  }
  for (const type of ['change_set', 'receipt', 'compile', 'lint_detected', 'lint_resolved', 'maintenance_started', 'maintenance_completed', 'query', 'source']) {
    assert.doesNotMatch(wikiLogEventLabel(type), ENGINEERING, `日志事件标签泄漏工程词: ${wikiLogEventLabel(type)}`);
  }
  for (const type of ['change_set', 'receipt', 'wiki_page_version', 'health_issue', 'maintenance_run', 'query_artifact', 'source_revision']) {
    assert.doesNotMatch(wikiLogObjectLabel(type), ENGINEERING, `日志对象标签泄漏工程词: ${wikiLogObjectLabel(type)}`);
  }
});

// ---------------------------------------------------------------------------
// 相对时间（formatWikiWhen）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: formatWikiWhen renders relative time and degrades to dash on bad input', () => {
  assert.equal(formatWikiWhen(null), '—');
  assert.equal(formatWikiWhen(undefined), '—');
  assert.equal(formatWikiWhen(''), '—');
  assert.equal(formatWikiWhen('not-a-date'), '—');
  assert.equal(formatWikiWhen(new Date().toISOString()), '刚刚');
  const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  assert.equal(formatWikiWhen(minutesAgo), '5 分钟前');
  const hoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
  assert.equal(formatWikiWhen(hoursAgo), '3 小时前');
  const daysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
  assert.equal(formatWikiWhen(daysAgo), '2 天前');
  const old = new Date(Date.now() - 40 * 86400_000);
  const expected = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`;
  assert.equal(formatWikiWhen(old.toISOString()), expected);
});

// ---------------------------------------------------------------------------
// dataChanged 刷新 scope 门（知识面写面广播全集；空 scopes 视为刷新）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: shouldRefreshWikiDiscovery gates on knowledge-facing scopes and treats empty as refresh', () => {
  assert.equal(shouldRefreshWikiDiscovery(null), true);
  assert.equal(shouldRefreshWikiDiscovery(undefined), true);
  assert.equal(shouldRefreshWikiDiscovery([]), true);
  assert.equal(shouldRefreshWikiDiscovery(['knowledge']), true);
  assert.equal(shouldRefreshWikiDiscovery(['topics']), true);
  assert.equal(shouldRefreshWikiDiscovery(['canvas']), true);
  assert.equal(shouldRefreshWikiDiscovery(['health']), true);
  assert.equal(shouldRefreshWikiDiscovery(['receipt']), true);
  assert.equal(shouldRefreshWikiDiscovery(['library']), true);
  assert.equal(shouldRefreshWikiDiscovery(['sources']), true);
  assert.equal(shouldRefreshWikiDiscovery(['today']), false);
  assert.equal(shouldRefreshWikiDiscovery(['publications']), false);
});

test('WMB-5239 UI: discovery constants match contract bounds', () => {
  assert.equal(WIKI_SEARCH_DEBOUNCE_MS, 260);
  assert.equal(WIKI_SEARCH_PAGE_LIMIT, 20);
  assert.equal(WIKI_LOG_PAGE_LIMIT, 50);
  assert.equal(WIKI_NAVIGATE_EVENT, 'wmb-navigate-wiki-object');
  assert.equal(WIKI_MAINTENANCE_EVENT, 'wmb-open-library-maintenance');
});

// ---------------------------------------------------------------------------
// 日志 → 深链输入映射（Scout 风险：source 条目 locator.id 是 revisionId，
// 导航必须取 versionRefs.sourceId；wiki_page_version 取 versionRefs.wikiPageId）
// ---------------------------------------------------------------------------

const logEntry = (overrides = {}) => ({
  id: 'source:src_1',
  eventType: 'source',
  time: new Date().toISOString(),
  objectType: 'source_revision',
  objectId: 'rev_9',
  title: '某资料',
  summary: '',
  scope: null,
  workspaceId: null,
  actor: null,
  versionRefs: {
    changeSetId: null,
    receiptId: null,
    wikiPageId: null,
    wikiPageVersionIds: [],
    noteVersionIds: [],
    healthIssueId: null,
    sourceId: null,
    sourceRevisionId: null,
    previousSourceRevisionId: null,
    maintenanceRunId: null,
    reportId: null,
  },
  refs: { topicIds: [], entityIds: [], sourceIds: [], noteIds: [], wikiPageIds: [] },
  locator: { kind: 'source_revision', id: 'rev_9' },
  ...overrides,
});

test('WMB-5239 UI: source_revision log entry deep links to versionRefs.sourceId (not locator revisionId)', () => {
  const entry = logEntry({
    locator: { kind: 'source_revision', id: 'rev_9' },
    versionRefs: { ...logEntry().versionRefs, sourceId: 'src_42', sourceRevisionId: 'rev_9' },
  });
  assert.deepEqual(wikiLogEntryDeepLinkInput(entry), { objectType: 'source', objectId: 'src_42' });
});

test('WMB-5239 UI: wiki_page_version log entry deep links to versionRefs.wikiPageId', () => {
  const entry = logEntry({
    objectType: 'wiki_page_version',
    locator: { kind: 'wiki_page_version', id: 'wpv_3' },
    versionRefs: { ...logEntry().versionRefs, wikiPageId: 'page_7', wikiPageVersionIds: ['wpv_3'] },
  });
  assert.deepEqual(wikiLogEntryDeepLinkInput(entry), { objectType: 'wiki_page', objectId: 'page_7' });
});

test('WMB-5239 UI: health/change_set/receipt/query entries deep link via first ref priority', () => {
  const base = { ...logEntry().versionRefs, wikiPageId: null };
  const entry = logEntry({
    objectType: 'health_issue',
    locator: { kind: 'health_issue', id: 'hi_1' },
    versionRefs: base,
    refs: { topicIds: ['topic_9'], entityIds: [], sourceIds: [], noteIds: ['note_2'], wikiPageIds: [] },
  });
  assert.deepEqual(wikiLogEntryDeepLinkInput(entry), { objectType: 'knowledge_note', objectId: 'note_2' });
});

test('WMB-5239 UI: maintenance_run log entry has no navigable object (null)', () => {
  const entry = logEntry({
    objectType: 'maintenance_run',
    locator: { kind: 'maintenance_run', id: 'run_1' },
  });
  assert.equal(wikiLogEntryDeepLinkInput(entry), null);
});

test('WMB-5239 UI: log entry with no refs returns null (no silent wrong navigation)', () => {
  const entry = logEntry({ locator: { kind: 'change_set', id: 'cs_1' }, versionRefs: { ...logEntry().versionRefs, wikiPageId: null } });
  assert.equal(wikiLogEntryDeepLinkInput(entry), null);
});

// ---------------------------------------------------------------------------
// 主题范围切片：回执重叠跳过 + 补充事件集合
// ---------------------------------------------------------------------------

test('WMB-5239 UI: topic log slice skips receipt-overlap events and keeps supplementary ones', () => {
  assert.equal(TOPIC_LOG_RECEIPT_OVERLAP.change_set, true);
  assert.equal(TOPIC_LOG_RECEIPT_OVERLAP.receipt, true);
  assert.equal(TOPIC_LOG_RECEIPT_OVERLAP.compile, true);
  for (const type of TOPIC_LOG_SUPPLEMENTARY_EVENT_TYPES) {
    assert.equal(TOPIC_LOG_RECEIPT_OVERLAP[type], undefined, `${type} 不应与回执时间线重叠`);
    assert.equal(isTopicLogSupplementary(logEntry({ eventType: type })), true);
  }
  assert.equal(isTopicLogSupplementary(logEntry({ eventType: 'change_set' })), false);
  assert.equal(isTopicLogSupplementary(logEntry({ eventType: 'receipt' })), false);
  assert.equal(isTopicLogSupplementary(logEntry({ eventType: 'compile' })), false);
});

// ---------------------------------------------------------------------------
// 主题索引状态提示（用户语言；topicId 过滤见主题页源码级合同测试）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: topicIndexStatusLabel uses user language for index readiness', () => {
  assert.equal(topicIndexStatusLabel(null), '全库资料检索正在建立');
  assert.equal(topicIndexStatusLabel({ updatedAt: '2026-08-13T00:00:00.000Z' }), '全库资料检索已更新至 2026-08-13T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// 源码级：共享逻辑文件自身不得把工程词写进用户可见标签映射
// ---------------------------------------------------------------------------

test('WMB-5239 UI: wiki-discovery-parts and topic-search-log keep engineering words out of label literals', async () => {
  const partsSource = await readFile(new URL('../src/renderer/wiki-discovery-parts.ts', import.meta.url), 'utf8');
  const topicSource = await readFile(new URL('../src/renderer/topic-search-log.ts', import.meta.url), 'utf8');
  // 标签映射区（const X_LABELS = Object.freeze({...})）内不允许工程词字面量。
  const labelBlocks = (src) => [...src.matchAll(/(?:const \w+_LABELS[\s\S]*?\n\};\n)/g)].map((m) => m[0]);
  const ENGINEERING = /'[^']*(compiled|receipt|changeset|hot[-_ ]?cache|index|cursor)[^']*'/i;
  for (const block of labelBlocks(partsSource)) assert.doesNotMatch(block, ENGINEERING, `标签映射泄漏工程词: ${block.slice(0, 120)}`);
  for (const block of labelBlocks(topicSource)) assert.doesNotMatch(block, ENGINEERING, `标签映射泄漏工程词: ${block.slice(0, 120)}`);
});
