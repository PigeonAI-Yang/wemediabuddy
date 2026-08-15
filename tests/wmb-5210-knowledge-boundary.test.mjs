// WMB-5210 M1 知识飞轮边界聚焦测试（本 worker：ExposeKnowledgeBoundary）。
// 覆盖：共享通道契约与冻结清单对齐；preload 方法 ↔ 通道常量一一接线（单一真源，无第二套命名）；
// preload 入参纯透传（非法/缺失参数由 main boundary 拒绝，preload 不猜测/不加默认值）；
// renderer global.d.ts 类型面与 preload 方法名对齐；不暴露内部 DB / 任意 SQL 通道。
// 不运行 formatter/linter/项目测试/typecheck；由主 Agent 集成后统一执行。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS,
  KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL
} from '../src/shared/knowledge-flywheel.ts';

const PRELOAD_PATH = new URL('../src/preload/preload.ts', import.meta.url);
const GLOBALS_PATH = new URL('../src/renderer/global.d.ts', import.meta.url);
const SHARED_PATH = new URL('../src/shared/knowledge-flywheel.ts', import.meta.url);

/** 与 ImplementWmb5210 冻结的只读通道清单（28 个；主进程注册按此消费；不得造第二套命名）。 */
const FROZEN_READ_CHANNELS = [
  'knowledge-flywheel:list-entities',
  'knowledge-flywheel:get-entity',
  'knowledge-flywheel:list-notes',
  'knowledge-flywheel:get-note',
  'knowledge-flywheel:get-note-version',
  'knowledge-flywheel:list-note-versions',
  'knowledge-flywheel:list-pages',
  'knowledge-flywheel:get-page',
  'knowledge-flywheel:get-page-version',
  'knowledge-flywheel:list-page-versions',
  'knowledge-flywheel:list-relations',
  'knowledge-flywheel:get-relation',
  'knowledge-flywheel:list-evidence',
  'knowledge-flywheel:list-annotations',
  'knowledge-flywheel:get-annotation',
  'knowledge-flywheel:list-free-notes',
  'knowledge-flywheel:get-free-note',
  'knowledge-flywheel:get-change-set',
  'knowledge-flywheel:list-change-sets',
  'knowledge-flywheel:get-receipt',
  'knowledge-flywheel:get-receipt-by-request',
  'knowledge-flywheel:list-receipts',
  'knowledge-flywheel:get-query-artifact',
  'knowledge-flywheel:get-query-artifact-by-request',
  // WMB-5214：Query 写回摘要（Artifact + 风险标记 + Receipt；面板单次调用）
  'knowledge-flywheel:get-query-writeback-summary',
  'knowledge-flywheel:list-query-artifacts',
  'knowledge-flywheel:get-health-issue',
  'knowledge-flywheel:list-health-issues',
  'knowledge-flywheel:list-relation-registry',
  // WMB-5215 M6 usage 血缘只读通道（UsageStore owner 落地；编译器只消费）
  'knowledge-flywheel:get-usage-package',
  'knowledge-flywheel:get-usage-package-by-request',
  'knowledge-flywheel:list-usage-packages',
  'knowledge-flywheel:get-usage-record',
  'knowledge-flywheel:list-usage-records'
];

test('shared channel contract matches the frozen M1 list and stays bounded', () => {
  // 冻结清单：写入通道恰一个，只读通道恰 22 个，值一一对应。
  assert.equal(KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL, 'knowledge-flywheel:change-set-apply');
  const readChannels = Object.values(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS);
  assert.equal(readChannels.length, FROZEN_READ_CHANNELS.length);
  assert.deepEqual([...readChannels].sort(), [...FROZEN_READ_CHANNELS].sort());
  assert.equal(new Set(readChannels).size, readChannels.length, '通道不得重复');

  // 不暴露内部 DB / 任意 SQL：无 execute/raw/query-raw/sql/db 语义通道。
  for (const channel of [KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL, ...readChannels]) {
    assert.match(channel, /^knowledge-flywheel:/, `通道前缀不变量: ${channel}`);
    assert.doesNotMatch(channel, /sql|raw|execute|exec|db|query-all/i, `禁止内部 SQL/DB 通道: ${channel}`);
  }
});

test('preload wires every shared channel exactly once via the shared constants (single source of naming)', async () => {
  const preload = await readFile(PRELOAD_PATH, 'utf8');

  // 只读通道：每个常量键在 preload 中恰好接线一次，且必须引用共享常量（禁止内联第二套字符串）。
  for (const [key, channel] of Object.entries(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS)) {
    const reference = `ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.${key}, input)`;
    const occurrences = preload.split(reference).length - 1;
    assert.equal(occurrences, 1, `只读通道 ${channel} (${key}) 应恰好接线一次，实际 ${occurrences}`);
    assert.ok(!preload.includes(`'${channel}'`), `不得内联通道字符串（第二套命名）: ${channel}`);
  }
  // 写入通道同样引用共享常量一次。
  const writeReference = `ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL, input)`;
  assert.equal(preload.split(writeReference).length - 1, 1, '写入通道应恰好接线一次');
  assert.ok(!preload.includes(`'${KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL}'`), '不得内联写入通道字符串');

  // 无孤儿通道：共享清单之外不得出现任何 knowledge-flywheel 通道字符串。
  const orphanMatches = preload.match(/'knowledge-flywheel:[^']*'/g) ?? [];
  assert.deepEqual(orphanMatches, [], `preload 不应出现共享清单之外的 flywheel 通道: ${orphanMatches.join(', ')}`);
});

test('preload pass-through: no arg guessing/defaulting/validation on flywheel methods', async () => {
  const preload = await readFile(PRELOAD_PATH, 'utf8');
  const entries = Object.entries(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS).map(([key, channel]) => [key, channel, 'READ']).concat([[null, KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL, 'WRITE']]);
  for (const [key, channel, kind] of entries) {
    const expression = kind === 'READ'
      ? `KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.${key}`
      : 'KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL';
    const line = preload.split('\n').find((line) => line.includes(expression) && line.includes('ipcRenderer.invoke('));
    assert.ok(line, `应存在接线行: ${channel}`);
    // 严格透传：invoke 恰两参（通道常量 + 原样 input），无默认值/类型判断/清洗。
    const invoke = line.match(/=> ipcRenderer\.invoke\(([^)]*)\)/);
    assert.ok(invoke, `接线行必须直接 invoke: ${line.trim()}`);
    assert.equal(invoke[1], `${expression}, input`, `入参必须原样透传 input（main boundary 拒绝非法/缺失参数）: ${channel}`);
    assert.doesNotMatch(line, /\?\?|typeof|\.trim\(|\.filter\(|Array\.isArray/, `preload 不得猜测/校验参数: ${channel}`);
  }
});

test('renderer global.d.ts type surface stays aligned with the preload methods', async () => {
  const [preload, globals, shared] = await Promise.all([readFile(PRELOAD_PATH, 'utf8'), readFile(GLOBALS_PATH, 'utf8'), readFile(SHARED_PATH, 'utf8')]);

  // 提取 preload 中 M1 接线方法名；显式结束标记防止后续能力块污染局部契约。
  const blockStart = preload.indexOf('// WMB-5210 M1');
  assert.ok(blockStart >= 0, 'preload 应含 WMB-5210 M1 注释块');
  const blockEnd = preload.indexOf('// END WMB-5210 M1', blockStart);
  assert.ok(blockEnd > blockStart, 'preload 应含 WMB-5210 M1 结束标记');
  const block = preload.slice(blockStart, blockEnd);
  const methodNames = [...block.matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*): \(/gm)].map((match) => match[1]);

  const expectedMethods = [
    'submitKnowledgeChangeSet',
    ...Object.keys(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS).map((key) => {
      // 通道键 → preload 方法名的稳定映射（与接线实现一致）。
      const byChannel = {
        listEntities: 'listKnowledgeEntities', getEntity: 'getKnowledgeEntity',
        listNotes: 'listKnowledgeNotes', getNote: 'getKnowledgeNote',
        getNoteVersion: 'getKnowledgeNoteVersion', listNoteVersions: 'listKnowledgeNoteVersions',
        listPages: 'listWikiPages', getPage: 'getWikiPage', getPageVersion: 'getWikiPageVersion',
        listPageVersions: 'listWikiPageVersions', listRelations: 'listKnowledgeRelations',
        getRelation: 'getKnowledgeRelation', listEvidence: 'listEvidenceLinks',
        listAnnotations: 'listKnowledgeAnnotations', getAnnotation: 'getKnowledgeAnnotation',
        listFreeNotes: 'listFreeNotes', getFreeNote: 'getFreeNote',
        getChangeSet: 'getChangeSet', listChangeSets: 'listChangeSets',
        getReceipt: 'getUpdateReceipt', getReceiptByRequest: 'getUpdateReceiptByRequest',
        listReceipts: 'listUpdateReceipts', getQueryArtifact: 'getQueryArtifact',
        getQueryArtifactByRequest: 'getQueryArtifactByRequest',
        getQueryWritebackSummary: 'getQueryWritebackSummary',
        listQueryArtifacts: 'listQueryArtifacts',
        getHealthIssue: 'getHealthIssue', listHealthIssues: 'listHealthIssues',
        listRelationRegistry: 'listRelationRegistry',
        getUsagePackage: 'getKnowledgeUsagePackage', getUsagePackageByRequest: 'getKnowledgeUsagePackageByRequest',
        listUsagePackages: 'listKnowledgeUsagePackages', getUsageRecord: 'getKnowledgeUsageRecord',
        listUsageRecords: 'listKnowledgeUsageRecords'
      };
      return byChannel[key];
    })
  ];
  assert.deepEqual([...methodNames].sort(), [...expectedMethods].sort(), 'preload 方法名必须与通道清单一一对应');

  // 每个方法在 renderer 类型面声明；类型面不得内联通道字符串（只引用共享类型）。
  for (const method of expectedMethods) {
    assert.ok(globals.includes(`${method}(`), `global.d.ts 必须声明 ${method}`);
  }
  assert.doesNotMatch(globals, /knowledge-flywheel:/, '类型面不持有通道字符串');
  assert.ok(globals.includes("from '../shared/knowledge-flywheel'"), '类型面必须消费共享契约类型');

  // 公共记录类型声明齐全（receipt/change set/wiki/object/version/health/query artifact 等）。
  for (const recordType of [
    'KnowledgeChangeSetRecord', 'KnowledgeFreeNoteRecord', 'KnowledgeEntityRecord', 'KnowledgeNoteRecord',
    'KnowledgeNoteVersionRecord', 'KnowledgeWikiPageRecord', 'KnowledgeWikiPageVersionRecord',
    'KnowledgeRelationRecord', 'KnowledgeEvidenceLinkRecord', 'KnowledgeAnnotationRecord',
    'KnowledgeUpdateReceiptRecord', 'KnowledgeQueryArtifactRecord', 'KnowledgeHealthIssueRecord',
    'KnowledgeRelationRegistryEntry'
  ]) {
    assert.ok(new RegExp(`export type ${recordType} =`).test(shared), `共享契约应声明 ${recordType}`);
  }
  // 核心字段抽查：回执/健康/ChangeSet 的关键溯源字段必须在类型面。
  for (const field of ['requestId', 'changeSetId']) {
    assert.ok(shared.includes(`  ${field}: string;`), `记录类型应含 ${field}`);
  }
  assert.ok(shared.includes('issueType: KnowledgeHealthIssueType;'), '健康问题应含 issueType');
  assert.ok(shared.includes('writeBackDecision: KnowledgeQueryWriteBackDecision;'), 'QueryArtifact 应含 writeBackDecision');
  // ChangeSet 写入面：主进程 normalizeChangeSetApplyInput 只读 input（对象段），共享契约必须与其对齐（单源）。
  assert.ok(shared.includes('input: Readonly<Record<string, unknown>>;'), 'ChangeSet 写入应含 input 对象段（段形状真源 src/main/knowledge-flywheel.ts）');
  assert.ok(!shared.includes('operations: readonly KnowledgeChangeSetOperation[];'), 'ChangeSet 写入不得再声明虚构 operations 形状');
  // list* 统一分页信封（与主进程 read API 对齐）。
  assert.ok(shared.includes('export type KnowledgeFlywheelListResult<T> = Readonly<{'), '共享契约应声明分页信封类型');
  assert.ok(shared.includes('  hasMore: boolean;'), '分页信封应含 hasMore');
});
