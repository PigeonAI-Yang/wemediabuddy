/**
 * WMB-5239 关系画布只读轻量入口纯函数层验收（聚焦行为测试，无 DOM / 无 IPC）。
 * 覆盖：最近变化（全局日志）条目 → 画布定位决策（聚焦节点 / 本体卡 / 既有深链 / 诚实不可定位，
 * 含 Scout 风险点：source 条目 locator.id 是 revisionId，导航必须取 versionRefs.sourceId）；
 * 图谱内搜索定位候选（与 data-kc-search 同一 query 匹配语义，有界）与无匹配诚实提示；
 * 全部文案为产品语言（最近变化/搜索定位/去资料库），不暴露 changeset/receipt/hot-cache。
 * 对应实现：src/renderer/knowledge-canvas-locate.ts。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  locateLogEntry,
  logEntryNodeCandidates,
  logEntryNotLocatableReason,
  logEntrySourceTarget,
  searchEmptyHint,
  searchMatchCandidates,
  SEARCH_LOCATE_LIMIT,
} from '../src/renderer/knowledge-canvas-locate.ts';

function logEntry(overrides) {
  return {
    id: 'source:src-1',
    eventType: 'source',
    time: '2026-08-13T00:00:00.000Z',
    objectType: 'source_revision',
    objectId: 'revision-9',
    title: '资料更新：某某来源',
    summary: '摄取新版本正文',
    scope: 'global',
    workspaceId: 'ws-test',
    actor: 'ingest',
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
    refs: {
      topicIds: [],
      entityIds: [],
      sourceIds: [],
      noteIds: [],
      wikiPageIds: [],
    },
    locator: { kind: 'source_revision', id: 'revision-9' },
    ...overrides,
  };
}

function noteEntry(overrides) {
  return logEntry({
    id: 'compile:page-1',
    eventType: 'compile',
    objectType: 'wiki_page_version',
    objectId: 'page-1',
    title: '页面已生成：主题A综合页',
    locator: { kind: 'wiki_page_version', id: 'page-1-v2' },
    ...overrides,
  });
}

test('logEntryNodeCandidates：主题 → 知识结论 → 实体优先级，去重保序，空 refs 诚实空数组', () => {
  const entry = logEntry({
    refs: {
      topicIds: ['topic-1'],
      noteIds: ['note-1'],
      entityIds: ['entity-1'],
      sourceIds: [],
      wikiPageIds: [],
    },
  });
  assert.deepEqual(logEntryNodeCandidates(entry), [
    'topic:topic-1',
    'knowledge_note:note-1',
    'knowledge_entity:entity-1',
  ]);
  // 同一正式对象出现在多组 refs 时不重复（稳定节点 ID 去重）
  const dup = logEntry({
    refs: {
      topicIds: ['topic-1'],
      noteIds: [],
      entityIds: [],
      sourceIds: [],
      wikiPageIds: ['page-1'],
    },
  });
  assert.deepEqual(logEntryNodeCandidates(dup), ['topic:topic-1']);
  assert.deepEqual(logEntryNodeCandidates(logEntry()), []);
});

test('locateLogEntry：候选已在投影 → focus-node（画布内定位既有节点）', () => {
  const entry = noteEntry({
    refs: {
      topicIds: ['topic-1'],
      noteIds: ['note-1'],
      entityIds: [],
      sourceIds: [],
      wikiPageIds: [],
    },
  });
  const decision = locateLogEntry(entry, new Set(['topic:topic-1']));
  assert.equal(decision.kind, 'focus-node');
  assert.equal(decision.nodeId, 'topic:topic-1');
});

test('locateLogEntry：主题未加载 → 走既有主题深链（主题恒有正式页）', () => {
  const entry = noteEntry({
    refs: {
      topicIds: ['topic-1'],
      noteIds: ['note-1'],
      entityIds: [],
      sourceIds: [],
      wikiPageIds: [],
    },
  });
  const decision = locateLogEntry(entry, new Set([]));
  assert.equal(decision.kind, 'deep-link');
  assert.deepEqual(decision.target, { type: 'topic', id: 'topic-1', title: entry.title });
});

test('locateLogEntry：知识结论未加载 → open-card 本体卡（诚实降级，不静默）', () => {
  const entry = noteEntry({
    refs: {
      topicIds: [],
      noteIds: ['note-1'],
      entityIds: [],
      sourceIds: [],
      wikiPageIds: [],
    },
  });
  const decision = locateLogEntry(entry, new Set([]));
  assert.equal(decision.kind, 'open-card');
  assert.equal(decision.nodeId, 'knowledge_note:note-1');
});

test('locateLogEntry：source 条目导航取 versionRefs.sourceId（locator.id 是 revisionId，Scout 风险点）', () => {
  const entry = logEntry({
    versionRefs: {
      ...logEntry().versionRefs,
      sourceId: 'src-1',
      sourceRevisionId: 'revision-9',
    },
    refs: { topicIds: [], noteIds: [], entityIds: [], sourceIds: [], wikiPageIds: [] },
  });
  const decision = locateLogEntry(entry, new Set([]));
  assert.equal(decision.kind, 'deep-link');
  assert.equal(decision.target.type, 'source');
  assert.equal(decision.target.id, 'src-1');
  assert.notEqual(decision.target.id, 'revision-9');
});

test('locateLogEntry：source 兜底取 refs.sourceIds[0]', () => {
  const entry = logEntry({
    refs: { topicIds: [], noteIds: [], entityIds: [], sourceIds: ['src-2'], wikiPageIds: [] },
  });
  const decision = locateLogEntry(entry, new Set([]));
  assert.equal(decision.kind, 'deep-link');
  assert.equal(decision.target.id, 'src-2');
});

test('locateLogEntry：health_issue / maintenance_run 无定位目标 → 诚实不可定位（产品语言）', () => {
  const health = logEntry({
    eventType: 'lint_detected',
    objectType: 'health_issue',
    objectId: 'issue-1',
    title: '发现健康问题',
    locator: { kind: 'health_issue', id: 'issue-1' },
  });
  const healthDecision = locateLogEntry(health, new Set([]));
  assert.equal(healthDecision.kind, 'not-locatable');
  assert.match(healthDecision.reason, /资料库/);
  assert.doesNotMatch(healthDecision.reason, /health_issue|changeset|receipt|hot-cache/);

  const maintenance = logEntry({
    eventType: 'maintenance_completed',
    objectType: 'maintenance_run',
    objectId: 'run-1',
    title: '全库整理完成',
    locator: { kind: 'maintenance_run', id: 'run-1' },
  });
  const maintenanceDecision = locateLogEntry(maintenance, new Set([]));
  assert.equal(maintenanceDecision.kind, 'not-locatable');
  assert.match(maintenanceDecision.reason, /整理记录/);

  const empty = logEntry({
    eventType: 'receipt',
    objectType: 'receipt',
    objectId: 'receipt-1',
    title: '更新记录',
    locator: { kind: 'receipt', id: 'receipt-1' },
  });
  assert.equal(locateLogEntry(empty, new Set([])).kind, 'not-locatable');
  assert.equal(logEntryNotLocatableReason(empty), '该记录暂无法定位到具体知识');
});

test('logEntrySourceTarget：versionRefs.sourceId 优先于 refs.sourceIds；皆无 → null', () => {
  const entry = logEntry({
    versionRefs: { ...logEntry().versionRefs, sourceId: 'src-formal' },
    refs: { topicIds: [], noteIds: [], entityIds: [], sourceIds: ['src-ref'], wikiPageIds: [] },
  });
  assert.equal(logEntrySourceTarget(entry).id, 'src-formal');
  assert.equal(logEntrySourceTarget(logEntry()), null);
});

test('searchMatchCandidates：空 query 契约空数组；标题/摘要命中，大小写不敏感；有界 SEARCH_LOCATE_LIMIT', () => {
  const nodes = [
    { id: 'topic:1', objectType: 'topic', shortTitle: 'AI 内容创作', summary: '主题综合', weight: 0, updatedAt: '' },
    { id: 'knowledge_note:2', objectType: 'knowledge_note', shortTitle: '结论甲', summary: 'AI 工具选择建议', weight: 0, updatedAt: '' },
    { id: 'knowledge_entity:3', objectType: 'knowledge_entity', shortTitle: '某某公司', summary: '', weight: 0, updatedAt: '' },
  ];
  assert.deepEqual(searchMatchCandidates(nodes, '   '), []);
  const aiHit = searchMatchCandidates(nodes, 'ai');
  assert.deepEqual(aiHit.map((node) => node.id), ['topic:1', 'knowledge_note:2']);
  const summaryHit = searchMatchCandidates(nodes, '工具选择');
  assert.deepEqual(summaryHit.map((node) => node.id), ['knowledge_note:2']);
  assert.deepEqual(searchMatchCandidates(nodes, '无此词'), []);

  const many = Array.from({ length: 30 }, (_, index) => ({
    id: `topic:${index}`,
    objectType: 'topic',
    shortTitle: `命中主题${index}`,
    summary: '',
    weight: 0,
    updatedAt: '',
  }));
  const bounded = searchMatchCandidates(many, '命中');
  assert.equal(bounded.length, SEARCH_LOCATE_LIMIT);
  assert.equal(searchMatchCandidates(many, '命中', 5).length, 5);
});

test('searchEmptyHint：query 非空且零命中 → 诚实提示；有命中或空 query → null', () => {
  assert.equal(searchEmptyHint('', 0), null);
  assert.equal(searchEmptyHint('  ', 3), null);
  assert.equal(searchEmptyHint('ai', 1), null);
  const hint = searchEmptyHint('无此词', 0);
  assert.equal(hint, '没有匹配的知识节点，可去资料库搜索全部资料');
  assert.doesNotMatch(hint, /hot-cache|receipt|changeset/);
});
