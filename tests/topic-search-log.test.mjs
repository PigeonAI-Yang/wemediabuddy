import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  TOPIC_LOG_RECEIPT_OVERLAP,
  TOPIC_LOG_SUPPLEMENTARY_EVENT_TYPES,
  isTopicLogSupplementary,
  topicIndexStatusLabel,
} from '../src/renderer/topic-search-log.ts';

// WMB-5239 主题切片聚焦测试：主题范围的日志切片展示策略与索引状态提示（纯函数，无窗口依赖）。
// 用户语言映射与深链分发由 wiki-discovery-parts（共享单源）负责，本测试不重复覆盖。

function logEntry(overrides) {
  return {
    id: 'source:obj-1',
    eventType: 'source',
    time: '2026-08-13T08:00:00.000Z',
    objectType: 'source_revision',
    objectId: 'rev-99',
    title: '样本',
    summary: '样本摘要',
    scope: null,
    workspaceId: null,
    actor: null,
    versionRefs: {
      changeSetId: null, receiptId: null, wikiPageId: null, wikiPageVersionIds: [],
      noteVersionIds: [], healthIssueId: null, sourceId: 'src-1', sourceRevisionId: 'rev-99',
      previousSourceRevisionId: null, maintenanceRunId: null, reportId: null,
    },
    refs: { topicIds: ['topic-1'], entityIds: [], sourceIds: ['src-1'], noteIds: [], wikiPageIds: [] },
    locator: { kind: 'source_revision', id: 'rev-99' },
    ...overrides,
  };
}

test('主题动态切片跳过与回执重叠的日志事件（change_set/receipt/compile），保留补充事件', () => {
  for (const eventType of ['change_set', 'receipt', 'compile']) {
    assert.equal(TOPIC_LOG_RECEIPT_OVERLAP[eventType], true, `${eventType} 应视为回执重叠`);
  }
  assert.equal(isTopicLogSupplementary(logEntry({ eventType: 'change_set' })), false);
  assert.equal(isTopicLogSupplementary(logEntry({ eventType: 'receipt' })), false);
  assert.equal(isTopicLogSupplementary(logEntry({ eventType: 'compile' })), false);
  for (const eventType of TOPIC_LOG_SUPPLEMENTARY_EVENT_TYPES) {
    assert.equal(isTopicLogSupplementary(logEntry({ eventType })), true, `${eventType} 应保留`);
  }
  // 补充事件不得包含回执重叠类型，也不得包含全库整理事件（整理报告属于资料库）。
  assert.equal(TOPIC_LOG_SUPPLEMENTARY_EVENT_TYPES.includes('change_set'), false);
  assert.equal(TOPIC_LOG_SUPPLEMENTARY_EVENT_TYPES.includes('maintenance_started'), false);
  assert.equal(TOPIC_LOG_SUPPLEMENTARY_EVENT_TYPES.includes('maintenance_completed'), false);
  // 未知事件类型不得误杀（fail-open 展示，宁可多显不丢动态）。
  assert.equal(isTopicLogSupplementary(logEntry({ eventType: 'future_event' })), true);
});

test('索引状态提示：有更新时间显示覆盖范围，索引为空显示建设中（用户语言，无工程词）', () => {
  assert.equal(topicIndexStatusLabel(null), '全库资料检索正在建立');
  assert.equal(topicIndexStatusLabel({ counts: {}, total: 0, updatedAt: null, rebuiltAt: null }), '全库资料检索正在建立');
  assert.equal(
    topicIndexStatusLabel({ counts: {}, total: 10, updatedAt: '2026-08-13T08:00:00.000Z', rebuiltAt: null }),
    '全库资料检索已更新至 2026-08-13T08:00:00.000Z',
  );
  for (const label of [topicIndexStatusLabel(null), topicIndexStatusLabel({ counts: {}, total: 0, updatedAt: '2026-08-13T08:00:00.000Z', rebuiltAt: null })]) {
    for (const forbidden of ['index', 'cache', 'hot', 'cursor', 'offset', 'compiled']) {
      assert.equal(label.toLowerCase().includes(forbidden), false, `提示不应含工程词 ${forbidden}`);
    }
  }
});

test('主题视图集成：搜索与动态切片只挂当前主题 scope，四态与深链齐备（组件源断言）', async () => {
  const source = await readFile(new URL('../src/renderer/library-topics-view.tsx', import.meta.url), 'utf8');
  // 主题范围必须真实生效：scope id 派生自当前选中主题，hooks 的 topicId 来自该 scope。
  assert.match(source, /const topicScopeId = selectedTopicId \?\? undefined/);
  assert.match(source, /topicSearch = useWikiSearch\(\{[^}]*topicId: topicScopeId[^}]*enabled: topicScopeEnabled/);
  assert.match(source, /topicActivity = useKnowledgeLog\(\{[^}]*topicId: topicScopeId[^}]*enabled: topicScopeEnabled/);
  // 搜索与动态切片锚定在资料/变化页签内。
  assert.match(source, /className="topic-wiki-section topic-wiki-search" data-wiki-tab="sources"/);
  assert.match(source, /className="[^"]*topic-wiki-changes[^"]*topic-wiki-activity[^"]*" data-wiki-tab="changes"/);
  // 四态：加载/空/错误+重试 均在场（搜索与动态各一）。
  assert.ok(source.includes('正在检索本主题资料'));
  assert.ok(source.includes('没有找到相关内容'));
  assert.ok(source.includes('正在加载相关动态'));
  assert.ok(source.includes('相关动态加载失败'));
  assert.ok(source.includes('还没有与本主题相关的动态'));
  // 深链：结果点击复用共享导航桥，日志条目点击复用共享日志导航。
  assert.ok(source.includes('dispatchWikiDeepLink(result.navigation)'));
  assert.ok(source.includes('dispatchWikiLogEntry(entry)'));
  // 用户语言：切片区域不使用回执/索引等工程词做标题。
  assert.ok(source.includes('搜索本主题资料'));
  assert.ok(source.includes('相关动态'));
});
