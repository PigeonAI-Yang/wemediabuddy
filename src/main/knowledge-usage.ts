/**
 * WMB-5215 M6：创作知识调用血缘（不可变 Knowledge Usage Package/Record store）。
 * Design: docs/spark/2026-08-12-wmb-creation-knowledge-usage-protocol-design.md §2/§6/§10。
 * 要点：
 * - Usage Package 是一次任务输入快照（固定 Wiki/Note/Evidence 版本引用，不复制正式知识原文），
 *   不成为新知识真源；后续知识更新不改变历史使用包（schema v57 全表不可变、禁止硬删）。
 * - 包与记录同事务提交；transaction=false 可嵌入内容保存事务（content.ts/reviews.ts 同一
 *   BEGIN IMMEDIATE），Usage 保存失败 → 调用方 ROLLBACK → 内容版本零产物（协议 §10）。
 * - actual used vs consulted：由 usageKind 派生（六种用途 → used=1；'consulted' → used=0），
 *   不接收调用方独立 used 字段，DB CHECK 强制判别。
 * - 引用不存在版本/证据 → OBJECT_NOT_FOUND；跨 data-root（workspace）→ WORKSPACE_MISMATCH；
 *   lane scope 未注册 → SCOPE_NOT_REGISTERED；同 requestId 不同输入 → REQUEST_REPLAY_CONFLICT。
 * - 正式知识写仍只经 applyKnowledgeChangeSet（usage 表不是第二套 store/schema，只是血缘审计面）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeFlywheelError, assertScopeAllowed, assertWorkspaceMatches } from './knowledge-flywheel.ts';
import type { CreatorNature, KnowledgeScope } from './knowledge-flywheel.ts';

// ============================================================
// 领域词典（与 schema v57 CHECK 对齐）
// ============================================================

export type KnowledgeUsageStage =
  | 'source_judgment' | 'topic_proposal' | 'creative_brief'
  | 'core_draft' | 'platform_adaptation' | 'review';

export type KnowledgeUsageKind =
  | 'quoted' | 'paraphrased' | 'reasoning_basis' | 'structure_pattern'
  | 'avoided_due_to_risk' | 'rejected_by_user' | 'consulted';

export type KnowledgeUsageRiskKind =
  | 'disputed' | 'contradicted' | 'inference' | 'stale' | 'unverified' | 'scope_mismatch';

export type KnowledgeUsageCutReasonKind =
  | 'budget' | 'low_relevance' | 'superseded' | 'duplicate' | 'scope_mismatch' | 'stale';

export type KnowledgeUsageOutputType =
  | 'source_item' | 'topic_proposal' | 'creative_brief' | 'plan_item' | 'content_version' | 'platform_version' | 'review' | 'publication';

export type KnowledgeUsageVersionKind = 'note' | 'wiki_page';

const USAGE_STAGES: readonly KnowledgeUsageStage[] = [
  'source_judgment', 'topic_proposal', 'creative_brief', 'core_draft', 'platform_adaptation', 'review'
];
const USAGE_KINDS: readonly KnowledgeUsageKind[] = [
  'quoted', 'paraphrased', 'reasoning_basis', 'structure_pattern', 'avoided_due_to_risk', 'rejected_by_user', 'consulted'
];
const RISK_KINDS: readonly KnowledgeUsageRiskKind[] = [
  'disputed', 'contradicted', 'inference', 'stale', 'unverified', 'scope_mismatch'
];
const CUT_REASON_KINDS: readonly KnowledgeUsageCutReasonKind[] = [
  'budget', 'low_relevance', 'superseded', 'duplicate', 'scope_mismatch', 'stale'
];
const OUTPUT_TYPES: readonly KnowledgeUsageOutputType[] = [
  'source_item', 'topic_proposal', 'creative_brief', 'plan_item', 'content_version', 'platform_version', 'review', 'publication'
];

const USAGE_VERSION_KINDS: readonly KnowledgeUsageVersionKind[] = ['note', 'wiki_page'];

/** 产物对象存在性检查目标表（精简 fixture 缺表时跳过，full schema 下强制）。 */
const OUTPUT_TABLES: Readonly<Record<KnowledgeUsageOutputType, string>> = Object.freeze({
  source_item: 'source_items',
  topic_proposal: 'topic_maintenance_proposals',
  creative_brief: 'creative_briefs',
  plan_item: 'plan_items',
  content_version: 'content_versions',
  platform_version: 'platform_versions',
  review: 'reviews',
  publication: 'publications'
});

// ============================================================
// 错误与工具
// ============================================================

export class KnowledgeUsageError extends KnowledgeFlywheelError {}

function fail(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new KnowledgeUsageError(code, message, details);
}

/** Usage store 抛出的错误码（复用既有知识飞轮语义，不另立法新码）。 */
export const KNOWLEDGE_USAGE_ERROR_CODES = Object.freeze([
  'WORKSPACE_MISMATCH',
  'SCOPE_NOT_REGISTERED',
  'REQUEST_REPLAY_CONFLICT',
  'OBJECT_NOT_FOUND',
  'INVALID_INPUT'
] as const);

export function createKnowledgeUsageInputHash(requestId: string, input: unknown): string {
  return createHash('sha256').update(stableJson({ requestId, input })).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function bounds(input?: { limit?: number; offset?: number }): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(input?.limit ?? 50, 1), 100),
    offset: Math.max(input?.offset ?? 0, 0)
  };
}

function now(): string {
  return new Date().toISOString();
}

function parseJsonArray(value: string | null | undefined, label: string): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fail('INVALID_INPUT', `${label} 应为 JSON 数组`);
  } catch {
    return fail('INVALID_INPUT', `${label} 不是合法 JSON`);
  }
}

/** 产物/业务对象存在性（精简 fixture 缺表时放行，full schema 下强制真实引用）。 */
function outputExists(database: DatabaseSync, table: string, id: string): boolean {
  try {
    const row = database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
    return row !== undefined;
  } catch {
    return true;
  }
}

/** 知识版本/证据存在性：v56/v57 表为本 store 前置，缺表即拒绝（“使用不存在版本拒绝”）。 */
function versionExists(database: DatabaseSync, versionKind: KnowledgeUsageVersionKind, versionId: string): boolean {
  const table = versionKind === 'note' ? 'knowledge_note_versions' : 'knowledge_wiki_page_versions';
  return database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(versionId) !== undefined;
}

// ============================================================
// 写入输入类型
// ============================================================

export type KnowledgeUsageMeta = Readonly<{
  workspaceId: string;
  requestId: string;
  reason: string;
  createdBy: CreatorNature;
  /** 缺省时按 stableJson({requestId, input}) 自算；调用方（dispatcher）可传入 envelope.inputHash。 */
  inputHash?: string;
}>;

export type KnowledgeUsageRiskFlagWrite = Readonly<{
  kind: KnowledgeUsageRiskKind;
  versionKind?: KnowledgeUsageVersionKind;
  versionId?: string;
  note?: string;
}>;

export type KnowledgeUsageCutReasonWrite = Readonly<{
  kind: KnowledgeUsageCutReasonKind;
  versionKind?: KnowledgeUsageVersionKind;
  versionId?: string;
  reason?: string;
}>;

export type KnowledgeUsagePackageWrite = Readonly<{
  id?: string;
  scope: KnowledgeScope;
  stage: KnowledgeUsageStage;
  topicId?: string;
  sourceIds?: readonly string[];
  planItemId?: string;
  projectId?: string;
  platform?: string;
  audience?: string;
  format?: string;
  /** 固定的 Wiki 页面版本（不可变，后续知识更新不改历史包）。 */
  wikiPageVersionIds?: readonly string[];
  /** 固定的 Note 版本。 */
  noteVersionIds?: readonly string[];
  /** 固定的 EvidenceLink 入口。 */
  evidenceIds?: readonly string[];
  /** 用户原则/禁忌/纠正（FreeNote）。 */
  freeNoteIds?: readonly string[];
  /** disputed/stale/inference 等风险标记（协议 §7）。 */
  riskFlags?: readonly KnowledgeUsageRiskFlagWrite[];
  /** 选择原因（协议 §3 优先级说明/§4.2 为什么现在值得做）。 */
  selectionReasons?: readonly string[];
  /** 上下文裁剪原因（协议 §5：budget/low_relevance/superseded/duplicate/scope_mismatch/stale）。 */
  cutReasons?: readonly KnowledgeUsageCutReasonWrite[];
  compilerSchemaVersion: string;
}>;

export type KnowledgeUsageRecordWrite = Readonly<{
  outputObjectType: KnowledgeUsageOutputType;
  outputObjectId: string;
  versionKind: KnowledgeUsageVersionKind;
  versionId: string;
  /** 六种用途 = 实际 used；'consulted' = 仅读取未影响产物（used 由此派生）。 */
  usageKind: KnowledgeUsageKind;
  /** 可选正文 locator（协议 §6）。 */
  locator?: string;
  /** 使用理由。 */
  reason?: string;
  actor?: string;
  /** 可选：关键事实回到的 EvidenceLink。 */
  evidenceId?: string;
}>;

export type KnowledgeUsageInput = Readonly<{
  package: KnowledgeUsagePackageWrite;
  records?: readonly KnowledgeUsageRecordWrite[];
}>;

export type CreateKnowledgeUsageResult = Readonly<{
  packageId: string;
  /** true = 同 (workspaceId, requestId, inputHash) 幂等重放，零新增行。 */
  replay: boolean;
  package: KnowledgeUsagePackageRecord | null;
  recordIds: readonly string[];
}>;

export type AddKnowledgeUsageRecordsResult = Readonly<{
  recordIds: readonly string[];
}>;

// ============================================================
// 读模型记录类型
// ============================================================

export type KnowledgeUsageRiskFlagRecord = Readonly<{
  kind: KnowledgeUsageRiskKind;
  versionKind: KnowledgeUsageVersionKind | null;
  versionId: string | null;
  note: string | null;
}>;

export type KnowledgeUsageCutReasonRecord = Readonly<{
  kind: KnowledgeUsageCutReasonKind;
  versionKind: KnowledgeUsageVersionKind | null;
  versionId: string | null;
  reason: string | null;
}>;

export type KnowledgeUsagePackageRecord = Readonly<{
  id: string;
  scope: string;
  workspaceId: string;
  stage: KnowledgeUsageStage;
  requestId: string;
  inputHash: string;
  topicId: string | null;
  sourceIds: readonly string[];
  planItemId: string | null;
  projectId: string | null;
  platform: string | null;
  audience: string;
  format: string;
  wikiPageVersionIds: readonly string[];
  noteVersionIds: readonly string[];
  evidenceIds: readonly string[];
  freeNoteIds: readonly string[];
  riskFlags: readonly KnowledgeUsageRiskFlagRecord[];
  selectionReasons: readonly string[];
  cutReasons: readonly KnowledgeUsageCutReasonRecord[];
  compilerSchemaVersion: string;
  createdBy: CreatorNature;
  createdAt: string;
}>;

export type KnowledgeUsageRecordRecord = Readonly<{
  id: string;
  scope: string;
  workspaceId: string;
  packageId: string;
  outputObjectType: KnowledgeUsageOutputType;
  outputObjectId: string;
  /** 固定知识版本 id（note_version_id XOR wiki_page_version_id 之一）。 */
  knowledgeVersionId: string;
  knowledgeVersionKind: KnowledgeUsageVersionKind;
  usageKind: KnowledgeUsageKind;
  /** true = actual used（六种用途之一）；false = 仅 consulted。 */
  used: boolean;
  locator: string | null;
  reason: string;
  actor: string;
  evidenceId: string | null;
  createdBy: CreatorNature;
  createdAt: string;
}>;

// ============================================================
// 写入：createKnowledgeUsage（包 + 记录同事务）
// ============================================================

export function createKnowledgeUsage(
  database: DatabaseSync,
  meta: KnowledgeUsageMeta,
  input: KnowledgeUsageInput,
  transaction = true
): CreateKnowledgeUsageResult {
  if (!meta.workspaceId || !meta.requestId) fail('INVALID_INPUT', 'Usage 必须携带 workspaceId 与 requestId。');
  if (!meta.reason?.trim()) fail('INVALID_INPUT', 'Usage 必须有人类可读的总体原因。');
  if (!input.package?.compilerSchemaVersion?.trim()) fail('INVALID_INPUT', 'Usage 包必须携带 compilerSchemaVersion。');
  assertWorkspaceMatches(database, meta.workspaceId);
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const result = createUsageInsideTransaction(database, meta, input);
    if (transaction) database.exec('COMMIT');
    return result;
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
}

function createUsageInsideTransaction(database: DatabaseSync, meta: KnowledgeUsageMeta, input: KnowledgeUsageInput): CreateKnowledgeUsageResult {
  const inputHash = meta.inputHash ?? createKnowledgeUsageInputHash(meta.requestId, input);
  const prior = database.prepare(
    'SELECT id, input_hash AS inputHash FROM knowledge_usage_packages WHERE workspace_id = ? AND request_id = ?'
  ).get(meta.workspaceId, meta.requestId) as { id: string; inputHash: string } | undefined;
  if (prior) {
    if (prior.inputHash !== inputHash) {
      fail('REQUEST_REPLAY_CONFLICT', '相同 requestId 已绑定不同 Usage 输入。', { requestId: meta.requestId });
    }
    // 幂等重放：零新增行，返回原包（协议 §2：同一阶段输入快照只建一次）。
    return Object.freeze({
      packageId: prior.id,
      replay: true,
      package: getKnowledgeUsagePackage(database, prior.id),
      recordIds: Object.freeze([])
    });
  }

  const packageWrite = input.package;
  if (!USAGE_STAGES.includes(packageWrite.stage)) fail('INVALID_INPUT', `非法 usage stage：${String(packageWrite.stage)}。`);
  assertScopeAllowed(database, packageWrite.scope);

  const packageId = packageWrite.id ?? randomUUID();
  if (!packageId.trim()) fail('INVALID_INPUT', 'Usage 包 id 不能为空。');

  // 固定版本/证据引用必须真实存在（协议 §2/§6：使用不存在版本拒绝）。
  for (const versionId of packageWrite.wikiPageVersionIds ?? []) {
    if (!versionExists(database, 'wiki_page', versionId)) {
      fail('OBJECT_NOT_FOUND', `Usage 包引用的 Wiki 页面版本 ${versionId} 不存在。`);
    }
  }
  for (const versionId of packageWrite.noteVersionIds ?? []) {
    if (!versionExists(database, 'note', versionId)) {
      fail('OBJECT_NOT_FOUND', `Usage 包引用的 Note 版本 ${versionId} 不存在。`);
    }
  }
  for (const evidenceId of packageWrite.evidenceIds ?? []) {
    if (database.prepare('SELECT 1 FROM knowledge_evidence_links WHERE id = ?').get(evidenceId) === undefined) {
      fail('OBJECT_NOT_FOUND', `Usage 包引用的证据 ${evidenceId} 不存在。`);
    }
  }
  for (const freeNoteId of packageWrite.freeNoteIds ?? []) {
    if (database.prepare('SELECT 1 FROM knowledge_free_notes WHERE id = ?').get(freeNoteId) === undefined) {
      fail('OBJECT_NOT_FOUND', `Usage 包引用的 FreeNote（用户原则）${freeNoteId} 不存在。`);
    }
  }
  validateVersionFlagged(database, packageWrite.riskFlags ?? [], RISK_KINDS, '风险标记', (flag) => flag.kind);
  validateVersionFlagged(database, packageWrite.cutReasons ?? [], CUT_REASON_KINDS, '裁剪原因', (cut) => cut.kind);
  if (packageWrite.topicId && !outputExists(database, 'topics', packageWrite.topicId)) {
    fail('OBJECT_NOT_FOUND', `Usage 包引用的 Topic ${packageWrite.topicId} 不存在。`);
  }
  if (packageWrite.planItemId && !outputExists(database, 'plan_items', packageWrite.planItemId)) {
    fail('OBJECT_NOT_FOUND', `Usage 包引用的 PlanItem ${packageWrite.planItemId} 不存在。`);
  }
  if (packageWrite.projectId && !outputExists(database, 'content_projects', packageWrite.projectId)) {
    fail('OBJECT_NOT_FOUND', `Usage 包引用的 Project ${packageWrite.projectId} 不存在。`);
  }
  for (const sourceId of packageWrite.sourceIds ?? []) {
    if (!outputExists(database, 'source_items', sourceId)) {
      fail('OBJECT_NOT_FOUND', `Usage 包引用的 Source ${sourceId} 不存在。`);
    }
  }

  database.prepare(`INSERT INTO knowledge_usage_packages
    (id, scope, workspace_id, stage, request_id, input_hash, topic_id, source_ids_json, plan_item_id, project_id,
     platform, audience, format, wiki_page_version_ids_json, note_version_ids_json, evidence_ids_json, free_note_ids_json,
     risk_flags_json, selection_reasons_json, cut_reasons_json, compiler_schema_version, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      packageId, packageWrite.scope, meta.workspaceId, packageWrite.stage, meta.requestId, inputHash,
      packageWrite.topicId ?? null, JSON.stringify(packageWrite.sourceIds ?? []), packageWrite.planItemId ?? null,
      packageWrite.projectId ?? null, packageWrite.platform ?? null, packageWrite.audience ?? '', packageWrite.format ?? '',
      JSON.stringify(packageWrite.wikiPageVersionIds ?? []), JSON.stringify(packageWrite.noteVersionIds ?? []),
      JSON.stringify(packageWrite.evidenceIds ?? []), JSON.stringify(packageWrite.freeNoteIds ?? []),
      JSON.stringify(packageWrite.riskFlags ?? []), JSON.stringify(packageWrite.selectionReasons ?? []),
      JSON.stringify(packageWrite.cutReasons ?? []), packageWrite.compilerSchemaVersion.trim(), meta.createdBy, now()
    );

  const recordIds: string[] = [];
  for (const record of input.records ?? []) {
    const id = insertUsageRecord(database, packageId, packageWrite.scope, meta, record);
    if (id) recordIds.push(id);
  }

  return Object.freeze({
    packageId,
    replay: false,
    package: getKnowledgeUsagePackage(database, packageId),
    recordIds: Object.freeze(recordIds)
  });
}

/** riskFlags/cutReasons 共用的“可选固定版本引用”校验（在调用方事务内执行）。 */
function validateVersionFlagged<T extends { versionKind?: string; versionId?: string }>(
  database: DatabaseSync,
  items: readonly T[],
  allowed: readonly string[],
  label: string,
  kindOf: (item: T) => string
): void {
  for (const item of items) {
    if (!allowed.includes(kindOf(item))) fail('INVALID_INPUT', `${label} kind 非法：${String(kindOf(item))}。`);
    if (Boolean(item.versionId) !== Boolean(item.versionKind)) {
      fail('INVALID_INPUT', `${label} 若携带版本引用必须同时给出 versionKind 与 versionId。`);
    }
    if (item.versionId) {
      if (!USAGE_VERSION_KINDS.includes(item.versionKind as KnowledgeUsageVersionKind)) {
        fail('INVALID_INPUT', `${label} versionKind 非法：${String(item.versionKind)}。`);
      }
      if (!versionExists(database, item.versionKind as KnowledgeUsageVersionKind, item.versionId)) {
        fail('OBJECT_NOT_FOUND', `${label} 引用的版本 ${item.versionId} 不存在。`);
      }
    }
  }
}

// ============================================================
// 写入：addKnowledgeUsageRecords（追加记录，可与内容保存同事务）
// ============================================================

export function addKnowledgeUsageRecords(
  database: DatabaseSync,
  meta: KnowledgeUsageMeta,
  input: { packageId: string; records: readonly KnowledgeUsageRecordWrite[] },
  transaction = true
): AddKnowledgeUsageRecordsResult {
  if (!meta.workspaceId || !meta.requestId) fail('INVALID_INPUT', 'Usage 必须携带 workspaceId 与 requestId。');
  if (!input.packageId?.trim()) fail('INVALID_INPUT', '必须携带 packageId。');
  assertWorkspaceMatches(database, meta.workspaceId);
  const existing = database.prepare('SELECT scope, workspace_id AS workspaceId FROM knowledge_usage_packages WHERE id = ?')
    .get(input.packageId) as { scope: string; workspaceId: string } | undefined;
  if (!existing) fail('OBJECT_NOT_FOUND', `Usage 包 ${input.packageId} 不存在。`);
  if (existing.workspaceId !== meta.workspaceId) {
    fail('WORKSPACE_MISMATCH', `Usage 包 ${input.packageId} 属于工作空间 ${existing.workspaceId}，与当前 data-root 不一致。`);
  }
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const recordIds: string[] = [];
    for (const record of input.records ?? []) {
      const id = insertUsageRecord(database, input.packageId, existing.scope, meta, record);
      if (id) recordIds.push(id);
    }
    if (transaction) database.exec('COMMIT');
    return Object.freeze({ recordIds: Object.freeze(recordIds) });
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
}

function insertUsageRecord(
  database: DatabaseSync,
  packageId: string,
  packageScope: string,
  meta: KnowledgeUsageMeta,
  record: KnowledgeUsageRecordWrite
): string | null {
  if (!OUTPUT_TYPES.includes(record.outputObjectType)) {
    fail('INVALID_INPUT', `非法 outputObjectType：${String(record.outputObjectType)}。`);
  }
  if (!record.outputObjectId?.trim()) fail('INVALID_INPUT', 'Usage 记录必须携带 outputObjectId。');
  if (!USAGE_VERSION_KINDS.includes(record.versionKind)) {
    fail('INVALID_INPUT', `非法 versionKind：${String(record.versionKind)}。`);
  }
  if (!USAGE_KINDS.includes(record.usageKind)) fail('INVALID_INPUT', `非法 usageKind：${String(record.usageKind)}。`);
  if (!versionExists(database, record.versionKind, record.versionId)) {
    fail('OBJECT_NOT_FOUND', `Usage 记录引用的 ${record.versionKind} 版本 ${record.versionId} 不存在。`);
  }
  if (record.evidenceId && database.prepare('SELECT 1 FROM knowledge_evidence_links WHERE id = ?').get(record.evidenceId) === undefined) {
    fail('OBJECT_NOT_FOUND', `Usage 记录引用的证据 ${record.evidenceId} 不存在。`);
  }
  if (!outputExists(database, OUTPUT_TABLES[record.outputObjectType], record.outputObjectId)) {
    fail('OBJECT_NOT_FOUND', `Usage 记录引用的产物 ${record.outputObjectType}:${record.outputObjectId} 不存在。`);
  }

  // 同包内重复（同输出/用途/版本）幂等跳过。
  const dedupe = database.prepare(`SELECT 1 FROM knowledge_usage_records
    WHERE package_id = ? AND output_object_type = ? AND output_object_id = ? AND usage_kind = ?
      AND note_version_id IS ? AND wiki_page_version_id IS ?`)
    .get(packageId, record.outputObjectType, record.outputObjectId, record.usageKind,
      record.versionKind === 'note' ? record.versionId : null,
      record.versionKind === 'wiki_page' ? record.versionId : null);
  if (dedupe) return null;

  const id = randomUUID();
  const used = record.usageKind === 'consulted' ? 0 : 1;
  database.prepare(`INSERT INTO knowledge_usage_records
    (id, scope, workspace_id, package_id, output_object_type, output_object_id, note_version_id, wiki_page_version_id,
     usage_kind, used, locator, reason, actor, evidence_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, packageScope, meta.workspaceId, packageId, record.outputObjectType, record.outputObjectId,
      record.versionKind === 'note' ? record.versionId : null,
      record.versionKind === 'wiki_page' ? record.versionId : null,
      record.usageKind, used, record.locator ?? null, record.reason ?? '', record.actor ?? '',
      record.evidenceId ?? null, meta.createdBy, now()
    );
  return id;
}

// ============================================================
// 只读 API（有界）
// ============================================================

/** 解析后的 JSON 段 → 有界对象（运行时收窄；非法形状按 INVALID_INPUT 拒绝）。 */
function asObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', `${label} 应为对象`);
  }
  return value as Record<string, unknown>;
}

function mapRiskFlag(value: unknown): KnowledgeUsageRiskFlagRecord {
  const flag = asObject(value, 'riskFlag');
  return Object.freeze({
    kind: flag.kind as KnowledgeUsageRiskKind,
    versionKind: (flag.versionKind as KnowledgeUsageVersionKind | undefined) ?? null,
    versionId: (flag.versionId as string | undefined) ?? null,
    note: (flag.note as string | undefined) ?? null
  });
}

function mapCutReason(value: unknown): KnowledgeUsageCutReasonRecord {
  const cut = asObject(value, 'cutReason');
  return Object.freeze({
    kind: cut.kind as KnowledgeUsageCutReasonKind,
    versionKind: (cut.versionKind as KnowledgeUsageVersionKind | undefined) ?? null,
    versionId: (cut.versionId as string | undefined) ?? null,
    reason: (cut.reason as string | undefined) ?? null
  });
}

function mapPackageRow(row: Record<string, unknown>): KnowledgeUsagePackageRecord {
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), workspaceId: String(row.workspaceId), stage: row.stage as KnowledgeUsageStage,
    requestId: String(row.requestId), inputHash: String(row.inputHash),
    topicId: (row.topicId as string | null) ?? null,
    sourceIds: Object.freeze(parseJsonArray(row.sourceIds as string, 'sourceIds') as string[]),
    planItemId: (row.planItemId as string | null) ?? null,
    projectId: (row.projectId as string | null) ?? null,
    platform: (row.platform as string | null) ?? null,
    audience: String(row.audience), format: String(row.format),
    wikiPageVersionIds: Object.freeze(parseJsonArray(row.wikiPageVersionIds as string, 'wikiPageVersionIds') as string[]),
    noteVersionIds: Object.freeze(parseJsonArray(row.noteVersionIds as string, 'noteVersionIds') as string[]),
    evidenceIds: Object.freeze(parseJsonArray(row.evidenceIds as string, 'evidenceIds') as string[]),
    freeNoteIds: Object.freeze(parseJsonArray(row.freeNoteIds as string, 'freeNoteIds') as string[]),
    riskFlags: Object.freeze((parseJsonArray(row.riskFlags as string, 'riskFlags') as unknown[]).map(mapRiskFlag)),
    selectionReasons: Object.freeze(parseJsonArray(row.selectionReasons as string, 'selectionReasons') as string[]),
    cutReasons: Object.freeze((parseJsonArray(row.cutReasons as string, 'cutReasons') as unknown[]).map(mapCutReason)),
    compilerSchemaVersion: String(row.compilerSchemaVersion),
    createdBy: row.createdBy as CreatorNature,
    createdAt: String(row.createdAt)
  });
}

function mapRecordRow(row: Record<string, unknown>): KnowledgeUsageRecordRecord {
  const noteVersionId = (row.noteVersionId as string | null) ?? null;
  const wikiPageVersionId = (row.wikiPageVersionId as string | null) ?? null;
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), workspaceId: String(row.workspaceId), packageId: String(row.packageId),
    outputObjectType: row.outputObjectType as KnowledgeUsageOutputType, outputObjectId: String(row.outputObjectId),
    knowledgeVersionId: String(noteVersionId ?? wikiPageVersionId),
    knowledgeVersionKind: (noteVersionId ? 'note' : 'wiki_page') as KnowledgeUsageVersionKind,
    usageKind: row.usageKind as KnowledgeUsageKind,
    used: Number(row.used) === 1,
    locator: (row.locator as string | null) ?? null,
    reason: String(row.reason), actor: String(row.actor),
    evidenceId: (row.evidenceId as string | null) ?? null,
    createdBy: row.createdBy as CreatorNature,
    createdAt: String(row.createdAt)
  });
}

const PACKAGE_SELECT = `SELECT id, scope, workspace_id AS workspaceId, stage, request_id AS requestId, input_hash AS inputHash,
  topic_id AS topicId, source_ids_json AS sourceIds, plan_item_id AS planItemId, project_id AS projectId, platform,
  audience, format, wiki_page_version_ids_json AS wikiPageVersionIds, note_version_ids_json AS noteVersionIds,
  evidence_ids_json AS evidenceIds, free_note_ids_json AS freeNoteIds, risk_flags_json AS riskFlags,
  selection_reasons_json AS selectionReasons, cut_reasons_json AS cutReasons, compiler_schema_version AS compilerSchemaVersion,
  created_by AS createdBy, created_at AS createdAt FROM knowledge_usage_packages`;

const RECORD_SELECT = `SELECT id, scope, workspace_id AS workspaceId, package_id AS packageId,
  output_object_type AS outputObjectType, output_object_id AS outputObjectId,
  note_version_id AS noteVersionId, wiki_page_version_id AS wikiPageVersionId,
  usage_kind AS usageKind, used, locator, reason, actor, evidence_id AS evidenceId,
  created_by AS createdBy, created_at AS createdAt FROM knowledge_usage_records`;

export function getKnowledgeUsagePackage(database: DatabaseSync, id: string): KnowledgeUsagePackageRecord | null {
  const row = database.prepare(`${PACKAGE_SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapPackageRow(row) : null;
}

export function getKnowledgeUsagePackageByRequest(database: DatabaseSync, workspaceId: string, requestId: string): KnowledgeUsagePackageRecord | null {
  const row = database.prepare(`${PACKAGE_SELECT} WHERE workspace_id = ? AND request_id = ?`)
    .get(workspaceId, requestId) as Record<string, unknown> | undefined;
  return row ? mapPackageRow(row) : null;
}

export function listKnowledgeUsagePackages(database: DatabaseSync, input: {
  scope?: string; stage?: KnowledgeUsageStage; topicId?: string; projectId?: string; limit?: number; offset?: number;
} = {}): { items: KnowledgeUsagePackageRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.scope) { where.push('scope = ?'); args.push(input.scope); }
  if (input.stage) { where.push('stage = ?'); args.push(input.stage); }
  if (input.topicId) { where.push('topic_id = ?'); args.push(input.topicId); }
  if (input.projectId) { where.push('project_id = ?'); args.push(input.projectId); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_usage_packages${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`${PACKAGE_SELECT}${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapPackageRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function getKnowledgeUsageRecord(database: DatabaseSync, id: string): KnowledgeUsageRecordRecord | null {
  const row = database.prepare(`${RECORD_SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapRecordRow(row) : null;
}

export function listKnowledgeUsageRecords(database: DatabaseSync, input: {
  packageId?: string; outputObjectType?: KnowledgeUsageOutputType; outputObjectId?: string; used?: boolean;
  wikiPageVersionId?: string; noteVersionId?: string;
  limit?: number; offset?: number;
} = {}): { items: KnowledgeUsageRecordRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.packageId) { where.push('package_id = ?'); args.push(input.packageId); }
  if (input.outputObjectType) { where.push('output_object_type = ?'); args.push(input.outputObjectType); }
  if (input.outputObjectId) { where.push('output_object_id = ?'); args.push(input.outputObjectId); }
  if (input.used !== undefined) { where.push('used = ?'); args.push(input.used ? 1 : 0); }
  if (input.wikiPageVersionId) { where.push('wiki_page_version_id = ?'); args.push(input.wikiPageVersionId); }
  if (input.noteVersionId) { where.push('note_version_id = ?'); args.push(input.noteVersionId); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_usage_records${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`${RECORD_SELECT}${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapRecordRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}
