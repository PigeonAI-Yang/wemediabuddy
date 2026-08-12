/**
 * WMB-5211：知识编译服务（compiler service）。
 * Design: docs/spark/2026-08-12-wmb-ai-knowledge-compilation-protocol-design.md
 *
 * 职责：把一份已冻结的严格 candidate plan（typed、可验证）编译成原子 ChangeSet，
 * 仅通过 store 的 applyKnowledgeChangeSet 写库（正式写单一入口，本模块不做任何旁路写）。
 *
 * - 真实 Source 触发：编译必须指向 source_items 中真实存在且 revision 与冻结值一致的 Source；
 * - 查重优先：先查 existing Topic/Entity/Note（scope + canonical_key），命中既有对象一律复用，
 *   绝不创建第二个身份；只有计划声明真实变更（strengthened/qualified/contradicted/…）才追加版本；
 * - 价值门（确定性）：每个候选必须携带 valueRationale；命中既有 Note 却未声明变更类型的候选
 *   一律视为纯复述（no_change）不晋升 —— 零 Note/Wiki 写入仍生成持久 receipt（低价值成功路径）；
 * - 幂等：同 (requestId + 输入) 重放零增量（store 原生）；sourceCompileRequestId 给出
 *   「同 source revision」稳定键；冻结 revision 与库中不一致 → 拒绝陈旧提交；
 * - 受影响 Wiki：只重编译一个已关联 Topic 的 Topic Wiki 页（subject_type='topic'），
 *   不创建/触碰 Entity、Method 等其他页面；
 * - 失败零写：所有校验失败发生在 apply 之前，或由 store 事务整体回滚。
 *
 * 触发接点（sources 明确接点）：Source 保存成功后（upsertSource / dispatchSourceUpsertBatch
 * 返回 {id, revision} 之后）显式调用本服务：
 *   compileSavedSource(database, { workspaceId, sourceId, topicId, reason, entities, notes, … })
 * 或对「已冻结在旧 revision 的计划」调用 compileSourceKnowledge（含 sourceRevision + requestId）。
 * 本模块不包含模型供应商：候选由上游（人工/规则/未来模型）提供，编译器只做规范化、查重、
 * 价值门、ChangeSet 构造与原子提交。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  applyKnowledgeChangeSet,
  createKnowledgeChangeSetInputHash,
  getKnowledgeNote,
  getWikiPage,
  getWikiPageVersion,
  type ConclusionStatus,
  type CreatorNature,
  type EntityType,
  type EntityWrite,
  type EvidenceLevel,
  type EvidenceLinkWrite,
  type KnowledgeChangeSetInput,
  type KnowledgeChangeSetMeta,
  type KnowledgeScope,
  type KnowledgeUpdateReceiptRecord,
  type NoteKind,
  type NoteVersionChangeType,
  type NoteWrite,
  type ReceiptTriggerType,
  type ResolutionMode,
  type SourceNature,
  type TriggerSource,
  type WikiPageWrite
} from './knowledge-flywheel.ts';
import { getSource } from './sources.ts';

// ============================================================
// 错误与固定矩阵
// ============================================================

export class KnowledgeCompilerError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'KnowledgeCompilerError';
    this.code = code;
    this.details = details;
  }
}

export const KNOWLEDGE_COMPILER_ERROR_CODES = Object.freeze([
  'COMPILE_INPUT_INVALID',
  'COMPILE_SOURCE_NOT_FOUND',
  'COMPILE_SOURCE_REVISION_STALE',
  'COMPILE_TOPIC_NOT_FOUND',
  'COMPILE_CANDIDATE_INVALID',
  'COMPILE_CANDIDATE_DUPLICATE',
  'COMPILE_NOTE_CHANGE_TYPE_INVALID',
  'COMPILE_NOTE_KIND_MISMATCH',
  'COMPILE_ENTITY_KEY_UNRESOLVED'
] as const);

/** 命中既有 Note 时允许追加版本的变更分类（契约 §3.6；create 只能用于新 Note）。 */
const UPDATE_CHANGE_TYPES: Readonly<Record<string, true>> = Object.freeze({
  strengthened: true, weakened: true, qualified: true, contradicted: true, superseded: true, recompiled: true
});

const NOTE_KINDS: Readonly<Record<string, true>> = Object.freeze({
  claim: true, insight: true, concept: true, case: true, method: true, question: true, creative_pattern: true
});

const ENTITY_TYPES: Readonly<Record<string, true>> = Object.freeze({
  person: true, organization: true, product: true, platform: true, policy: true,
  institution: true, place: true, publication_channel: true, other: true
});

const CONCLUSION_STATUSES: Readonly<Record<string, true>> = Object.freeze({
  unverified: true, supported: true, disputed: true, contradicted: true,
  superseded: true, not_applicable: true, inference: true
});

const EVIDENCE_LEVELS: Readonly<Record<string, true>> = Object.freeze({
  none: true, single: true, corroborated: true, primary: true, outcome_observed: true, mixed: true, insufficient: true
});

const EVIDENCE_RELATIONS: Readonly<Record<string, true>> = Object.freeze({
  supports: true, contradicts: true, qualifies: true
});

/** 与契约 §8.1 / DB CHECK 对齐的早验（store 仍为真源，最终强制在事务内）。 */
const QUESTION_KINDS: Readonly<Record<string, true>> = Object.freeze({ question: true });
const NON_SUPPORTABLE_STATUSES: Readonly<Record<string, true>> = Object.freeze({
  supported: true, contradicted: true, disputed: true
});

// ============================================================
// 编译输入（严格 typed candidate plan；全部 Readonly，编译前冻结）
// ============================================================

export type KnowledgeCompilerEntityCandidate = Readonly<{
  entityType: EntityType;
  canonicalKey: string;
  canonicalName: string;
  aliases?: readonly string[];
  externalIdentity?: Readonly<Record<string, unknown>>;
  /** 价值门：为什么这个身份值得入库（可验证/复用/改变认识…）。 */
  valueRationale: string;
}>;

export type KnowledgeCompilerNoteCandidate = Readonly<{
  kind: NoteKind;
  canonicalKey: string;
  statement: string;
  title?: string;
  body?: string;
  conclusionStatus: ConclusionStatus;
  evidenceLevel: EvidenceLevel;
  appliesTo?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  /**
   * 与既有知识的变更分类（契约 §3.6）：
   * - 省略或 'no_change'：命中既有 Note 时视为纯复述（不晋升）；新 Note 时省略 = 创建；
   * - 'strengthened' | 'weakened' | 'qualified' | 'contradicted' | 'superseded' | 'recompiled'：
   *   命中既有 Note 时追加新版本；'created' 只能用于新 Note（命中既有 → COMPILE_NOTE_CHANGE_TYPE_INVALID）。
   */
  changeType?: NoteVersionChangeType | 'no_change';
  changeReason?: string;
  /** 原文定位（必填，Stage B：无法定位到输入的候选不得进入正式 ChangeSet）。 */
  locator: string;
  /** 可定位原文片段（EvidenceLink.excerpt）。 */
  excerpt?: string;
  /** 证据关系：默认 supports。 */
  relation?: 'supports' | 'contradicts' | 'qualifies';
  /** 关联 Entity 的 canonicalKey（必须在 entities 中声明或已存在，否则 COMPILE_ENTITY_KEY_UNRESOLVED）。 */
  entityKeys?: readonly string[];
  /** 价值门：为什么这条知识值得晋升（可验证/复用/改变认识/限域/综合/高价值问题…）。 */
  valueRationale: string;
}>;

export type KnowledgeCompilerInput = Readonly<{
  /** 幂等键：同 requestId + 同输入重放零增量；推荐 sourceCompileRequestId(sourceId, sourceRevision)。 */
  requestId: string;
  workspaceId: string;
  /** 真实已保存 Source（source_items）。 */
  sourceId: string;
  /** 冻结的 Source revision；与库中不一致 → 拒绝陈旧提交。 */
  sourceRevision: number;
  /** 已关联 Topic（唯一受影响 Wiki 的 subject）。 */
  topicId: string;
  scope?: KnowledgeScope;
  createdBy?: CreatorNature;
  triggerSource?: TriggerSource;
  sourceNature?: SourceNature;
  resolutionMode?: ResolutionMode;
  reason: string;
  entities?: readonly KnowledgeCompilerEntityCandidate[];
  notes?: readonly KnowledgeCompilerNoteCandidate[];
  topicCompile?: Readonly<{ title?: string; summary?: string }>;
}>;

export type KnowledgeCompileCounts = Readonly<{
  entitiesCreated: number;
  entitiesMatched: number;
  notesCreated: number;
  notesUpdated: number;
  notesSkippedLowValue: number;
  noteVersionsCreated: number;
  evidenceLinks: number;
  wikiPagesCompiled: number;
}>;

export type KnowledgeCompileResult = Readonly<{
  ok: boolean;
  replay: boolean;
  changeSetId: string;
  requestId: string;
  sourceId: string;
  sourceRevision: number;
  counts: KnowledgeCompileCounts;
  /** canonicalKey → entityId（matched 或新建）。 */
  entityIds: Readonly<Record<string, string>>;
  /** canonicalKey → noteId（matched 或新建）。 */
  noteIds: Readonly<Record<string, string>>;
  /** 仅晋升的 Note：canonicalKey → 新版本 id（重放时为库中当前版本 id）。 */
  noteVersionIds: Readonly<Record<string, string>>;
  wikiPageId: string | null;
  wikiPageVersionId: string | null;
  receipt: KnowledgeUpdateReceiptRecord | null;
}>;

// ============================================================
// 工具
// ============================================================

/** 同 source revision 的稳定幂等键：`compile:source:{sourceId}:r{revision}`。 */
export function sourceCompileRequestId(sourceId: string, sourceRevision: number): string {
  return `compile:source:${sourceId}:r${sourceRevision}`;
}

/** 与 store normalizeCanonicalKey 对齐（scope + canonical_key 唯一性依赖同一规范化）。 */
function normalizeCanonicalKey(value: string): string {
  return value?.trim().toLowerCase() ?? '';
}

/**
 * 确定性对象 id（幂等关键）：ChangeSet 输入必须是计划的纯函数 —— 同 requestId + 同计划
 * 生成完全相同的输入 → store 原生 (requestId, inputHash) 重放零写。
 * id 无业务含义，仅用于幂等与追溯稳定。
 */
function deterministicId(prefix: string, seed: string): string {
  return `${prefix}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function compileError(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new KnowledgeCompilerError(code, message, details);
}

function freezeInput(input: KnowledgeCompilerInput): KnowledgeCompilerInput {
  const frozen = { ...input };
  if (frozen.entities) frozen.entities = Object.freeze([...frozen.entities]);
  if (frozen.notes) frozen.notes = Object.freeze([...frozen.notes]);
  if (frozen.topicCompile) frozen.topicCompile = Object.freeze({ ...frozen.topicCompile });
  return Object.freeze(frozen);
}

// ============================================================
// 校验（fail-closed；全部发生在 apply 之前 → 失败零写）
// ============================================================

function validateCompilerInput(input: KnowledgeCompilerInput): void {
  if (!input.requestId?.trim()) compileError('COMPILE_INPUT_INVALID', '编译必须携带 requestId（幂等键）。');
  if (!input.workspaceId?.trim()) compileError('COMPILE_INPUT_INVALID', '编译必须携带 workspaceId。');
  if (!input.sourceId?.trim()) compileError('COMPILE_INPUT_INVALID', '编译必须携带真实 Source id。');
  if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 1) {
    compileError('COMPILE_INPUT_INVALID', 'sourceRevision 必须为正整数。', { sourceRevision: input.sourceRevision });
  }
  if (!input.topicId?.trim()) compileError('COMPILE_INPUT_INVALID', '编译必须携带已关联 Topic id。');
  if (!input.reason?.trim()) compileError('COMPILE_INPUT_INVALID', '编译必须携带人类可读的总体原因。');
  const scope = input.scope ?? 'global';
  if (scope !== 'global' && !scope.startsWith('lane:')) {
    compileError('COMPILE_INPUT_INVALID', 'scope 必须为 global 或 lane:<key>。', { scope });
  }

  const entityKeys = new Set<string>();
  for (const candidate of input.entities ?? []) {
    const key = normalizeCanonicalKey(candidate.canonicalKey);
    if (!ENTITY_TYPES[candidate.entityType]) {
      compileError('COMPILE_CANDIDATE_INVALID', `Entity 候选 entityType 非法：${candidate.entityType}。`, { canonicalKey: candidate.canonicalKey });
    }
    if (!key || !candidate.canonicalName?.trim()) {
      compileError('COMPILE_CANDIDATE_INVALID', 'Entity 候选需要 canonicalKey 与 canonicalName。');
    }
    if (!candidate.valueRationale?.trim()) {
      compileError('COMPILE_CANDIDATE_INVALID', `Entity 候选 ${candidate.canonicalKey} 缺少价值理由（valueRationale）。`);
    }
    if (entityKeys.has(key)) {
      compileError('COMPILE_CANDIDATE_DUPLICATE', `Entity 候选 canonicalKey 重复：${candidate.canonicalKey}。`);
    }
    entityKeys.add(key);
  }

  const noteKeys = new Set<string>();
  for (const candidate of input.notes ?? []) {
    const key = normalizeCanonicalKey(candidate.canonicalKey);
    if (!NOTE_KINDS[candidate.kind]) {
      compileError('COMPILE_CANDIDATE_INVALID', `Note 候选 kind 非法：${candidate.kind}。`, { canonicalKey: candidate.canonicalKey });
    }
    if (!key || !candidate.statement?.trim()) {
      compileError('COMPILE_CANDIDATE_INVALID', 'Note 候选需要 canonicalKey 与 statement。');
    }
    if (!candidate.locator?.trim()) {
      compileError('COMPILE_CANDIDATE_INVALID', `Note 候选 ${candidate.canonicalKey} 缺少原文 locator（无法定位的候选不得进入 ChangeSet）。`);
    }
    if (!candidate.valueRationale?.trim()) {
      compileError('COMPILE_CANDIDATE_INVALID', `Note 候选 ${candidate.canonicalKey} 缺少价值理由（valueRationale）。`);
    }
    if (!CONCLUSION_STATUSES[candidate.conclusionStatus]) {
      compileError('COMPILE_CANDIDATE_INVALID', `Note 候选 ${candidate.canonicalKey} conclusionStatus 非法：${candidate.conclusionStatus}。`);
    }
    if (!EVIDENCE_LEVELS[candidate.evidenceLevel]) {
      compileError('COMPILE_CANDIDATE_INVALID', `Note 候选 ${candidate.canonicalKey} evidenceLevel 非法：${candidate.evidenceLevel}。`);
    }
    if (candidate.relation && !EVIDENCE_RELATIONS[candidate.relation]) {
      compileError('COMPILE_CANDIDATE_INVALID', `Note 候选 ${candidate.canonicalKey} 证据关系非法：${candidate.relation}。`);
    }
    // 契约 §8.1：Question 不能标记为 supported
    if (QUESTION_KINDS[candidate.kind] && candidate.conclusionStatus === 'supported') {
      compileError('COMPILE_CANDIDATE_INVALID', `Question 候选 ${candidate.canonicalKey} 不能标记 supported。`);
    }
    // 契约 §8.2 / DB CHECK：证据不足不得宣称 supported/contradicted/disputed
    if (NON_SUPPORTABLE_STATUSES[candidate.conclusionStatus]
      && (candidate.evidenceLevel === 'none' || candidate.evidenceLevel === 'insufficient')) {
      compileError('COMPILE_CANDIDATE_INVALID',
        `Note 候选 ${candidate.canonicalKey} 证据等级 ${candidate.evidenceLevel} 不能标记 ${candidate.conclusionStatus}。`);
    }
    if (candidate.changeType && candidate.changeType !== 'no_change' && !UPDATE_CHANGE_TYPES[candidate.changeType as NoteVersionChangeType]
      && candidate.changeType !== 'created') {
      compileError('COMPILE_CANDIDATE_INVALID', `Note 候选 ${candidate.canonicalKey} changeType 非法：${candidate.changeType}。`);
    }
    if (noteKeys.has(key)) {
      compileError('COMPILE_CANDIDATE_DUPLICATE', `Note 候选 canonicalKey 重复：${candidate.canonicalKey}。`);
    }
    noteKeys.add(key);
    for (const entityKey of candidate.entityKeys ?? []) {
      if (!entityKey?.trim()) {
        compileError('COMPILE_CANDIDATE_INVALID', `Note 候选 ${candidate.canonicalKey} 包含空 entityKey。`);
      }
    }
  }
}

// ============================================================
// 编译主流程
// ============================================================

/**
 * 严格单入口：把已冻结的 candidate plan 编译为原子 ChangeSet。
 * 冻结的 sourceRevision 与库中当前 revision 不一致 → COMPILE_SOURCE_REVISION_STALE（零写）。
 * 同 requestId + 同输入重放 → 零增量并返回原 ChangeSet 与同一回执。
 */
export function compileSourceKnowledge(database: DatabaseSync, rawInput: KnowledgeCompilerInput): KnowledgeCompileResult {
  const input = freezeInput(rawInput);
  validateCompilerInput(input);
  const scope = input.scope ?? 'global';
  const createdBy: CreatorNature = input.createdBy ?? 'background_agent';
  const triggerSource: TriggerSource = input.triggerSource ?? 'ingest';
  const sourceNature: SourceNature = input.sourceNature ?? 'primary_source';

  // ---- 真实 Source 触发 + 冻结 revision ----
  const source = getSource(database, input.sourceId);
  if (!source) compileError('COMPILE_SOURCE_NOT_FOUND', `编译触发 Source ${input.sourceId} 不存在（必须为真实已保存 Source）。`, { sourceId: input.sourceId });
  if (source.revision !== input.sourceRevision) {
    compileError('COMPILE_SOURCE_REVISION_STALE', `编译输入冻结的 Source revision=${input.sourceRevision} 与当前 ${source.revision} 不一致，拒绝陈旧提交。`, {
      sourceId: input.sourceId, frozenRevision: input.sourceRevision, currentRevision: source.revision
    });
  }

  // ---- 已关联 Topic（真实存在） ----
  const topicRow = database.prepare('SELECT id, title FROM topics WHERE id = ?').get(input.topicId) as { id: string; title: string } | undefined;
  if (!topicRow) compileError('COMPILE_TOPIC_NOT_FOUND', `已关联 Topic ${input.topicId} 不存在。`, { topicId: input.topicId });

  // ---- 查 existing Entity（scope + canonical_key；命中复用，零重复） ----
  const entityIds: Record<string, string> = {};
  const entityOps: EntityWrite[] = [];
  let entitiesCreated = 0;
  let entitiesMatched = 0;
  for (const candidate of input.entities ?? []) {
    const key = normalizeCanonicalKey(candidate.canonicalKey);
    const existing = database.prepare('SELECT id FROM knowledge_entities WHERE scope = ? AND canonical_key = ?').get(scope, key) as { id: string } | undefined;
    if (existing) {
      entityIds[candidate.canonicalKey] = existing.id;
      entitiesMatched += 1;
    } else {
      const id = deterministicId('ent', `${scope}|${normalizeCanonicalKey(candidate.canonicalKey)}`);
      entityOps.push({
        id, scope, entityType: candidate.entityType, canonicalKey: candidate.canonicalKey,
        canonicalName: candidate.canonicalName, aliases: candidate.aliases, externalIdentity: candidate.externalIdentity
      });
      entityIds[candidate.canonicalKey] = id;
      entitiesCreated += 1;
    }
  }

  // ---- 查 existing Note + 构造版本/证据（价值门：纯复述不晋升） ----
  const noteOps: NoteWrite[] = [];
  const evidenceOps: EvidenceLinkWrite[] = [];
  const noteIds: Record<string, string> = {};
  const noteVersionIds: Record<string, string> = {};
  const promoted: Array<{
    canonicalKey: string; noteId: string; versionId: string; kind: NoteKind; changeType: NoteVersionChangeType;
    disputed: boolean; statement: string; conclusionStatus: ConclusionStatus; evidenceLevel: EvidenceLevel; appliesTo: string;
    beforeVersionId: string | null;
  }> = [];
  const skipped: string[] = [];
  let notesCreated = 0;
  let notesUpdated = 0;

  for (const candidate of input.notes ?? []) {
    const key = normalizeCanonicalKey(candidate.canonicalKey);
    const adoptedEntityIds: string[] = [];
    for (const entityKey of candidate.entityKeys ?? []) {
      let id = entityIds[entityKey];
      if (!id) {
        // 计划未声明但库中已存在的 Entity：按 canonicalKey 解析复用（不隐式创建）。
        const existing = database.prepare('SELECT id FROM knowledge_entities WHERE scope = ? AND canonical_key = ?')
          .get(scope, normalizeCanonicalKey(entityKey)) as { id: string } | undefined;
        if (!existing) {
          compileError('COMPILE_ENTITY_KEY_UNRESOLVED', `Note 候选 ${candidate.canonicalKey} 引用的 Entity key ${entityKey} 未声明且不存在。`, { entityKey });
        }
        id = existing.id;
        entityIds[entityKey] = id;
      }
      adoptedEntityIds.push(id);
    }

    const existing = database.prepare(
      'SELECT id, revision, kind, current_version_id AS currentVersionId FROM knowledge_notes WHERE scope = ? AND canonical_key = ?'
    ).get(scope, key) as { id: string; revision: number; kind: string; currentVersionId: string | null } | undefined;

    const versionId = deterministicId('ver', `${input.requestId}|${scope}|${normalizeCanonicalKey(candidate.canonicalKey)}`);
    if (!existing) {
      if (candidate.changeType === 'no_change') {
        compileError('COMPILE_NOTE_CHANGE_TYPE_INVALID', `新 Note 候选 ${candidate.canonicalKey} 不能声明 no_change。`);
      }
      if (candidate.changeType && candidate.changeType !== 'created') {
        compileError('COMPILE_NOTE_CHANGE_TYPE_INVALID', `新 Note 候选 ${candidate.canonicalKey} 只能以 created 创建，不能声明 ${candidate.changeType}。`);
      }
      const noteId = deterministicId('note', `${scope}|${normalizeCanonicalKey(candidate.canonicalKey)}`);
      noteIds[candidate.canonicalKey] = noteId;
      noteOps.push({
        id: noteId, scope, kind: candidate.kind, canonicalKey: candidate.canonicalKey, title: candidate.title,
        version: {
          versionId, statement: candidate.statement, body: candidate.body,
          conclusionStatus: candidate.conclusionStatus, evidenceLevel: candidate.evidenceLevel,
          appliesTo: candidate.appliesTo, validFrom: candidate.validFrom ?? null, validUntil: candidate.validUntil ?? null,
          adoptedEntityIds, adoptedTopicIds: [input.topicId],
          changeType: 'created', changeReason: candidate.changeReason ?? candidate.valueRationale
        }
      });
      evidenceOps.push({
        knowledgeNoteVersionId: versionId, evidenceObjectType: 'source', evidenceObjectId: input.sourceId,
        relation: candidate.relation ?? 'supports', sourceNature,
        excerpt: candidate.excerpt ?? null, locator: candidate.locator, observedAt: source.publishedAt ?? null
      });
      noteVersionIds[candidate.canonicalKey] = versionId;
      promoted.push({
        canonicalKey: candidate.canonicalKey, noteId, versionId, kind: candidate.kind, changeType: 'created',
        disputed: candidate.conclusionStatus === 'disputed', statement: candidate.statement,
        conclusionStatus: candidate.conclusionStatus, evidenceLevel: candidate.evidenceLevel,
        appliesTo: candidate.appliesTo ?? '', beforeVersionId: null
      });
      notesCreated += 1;
      continue;
    }

    // 命中既有 Note：只有声明真实变更才追加版本；纯复述/未声明一律不晋升
    noteIds[candidate.canonicalKey] = existing.id;
    if (existing.kind !== candidate.kind) {
      compileError('COMPILE_NOTE_KIND_MISMATCH', `Note 候选 ${candidate.canonicalKey} kind=${candidate.kind} 与既有 ${existing.kind} 不一致。`, { noteId: existing.id });
    }
    const changeType = candidate.changeType ?? 'no_change';
    if (changeType === 'no_change' || changeType === 'created' || !UPDATE_CHANGE_TYPES[changeType as NoteVersionChangeType]) {
      skipped.push(`skipped:${candidate.canonicalKey}:${changeType === 'created' ? '已存在但计划声明 created' : '纯复述/未声明变更类型（no_change）'}`);
      continue;
    }
    const finalChangeType = changeType as NoteVersionChangeType;
    noteOps.push({
      id: existing.id, scope, kind: existing.kind as NoteKind, canonicalKey: candidate.canonicalKey,
      beforeRevision: existing.revision,
      version: {
        versionId, statement: candidate.statement, title: candidate.title, body: candidate.body,
        conclusionStatus: candidate.conclusionStatus, evidenceLevel: candidate.evidenceLevel,
        appliesTo: candidate.appliesTo, validFrom: candidate.validFrom ?? null, validUntil: candidate.validUntil ?? null,
        adoptedEntityIds, adoptedTopicIds: [input.topicId],
        changeType: finalChangeType, changeReason: candidate.changeReason ?? candidate.valueRationale
      }
    });
    evidenceOps.push({
      knowledgeNoteVersionId: versionId, evidenceObjectType: 'source', evidenceObjectId: input.sourceId,
      relation: candidate.relation ?? 'supports', sourceNature,
      excerpt: candidate.excerpt ?? null, locator: candidate.locator, observedAt: source.publishedAt ?? null
    });
    noteVersionIds[candidate.canonicalKey] = versionId;
    promoted.push({
      canonicalKey: candidate.canonicalKey, noteId: existing.id, versionId, kind: candidate.kind,
      changeType: finalChangeType, disputed: candidate.conclusionStatus === 'disputed', statement: candidate.statement,
      conclusionStatus: candidate.conclusionStatus, evidenceLevel: candidate.evidenceLevel,
      appliesTo: candidate.appliesTo ?? '', beforeVersionId: existing.currentVersionId
    });
    notesUpdated += 1;
  }

  // ---- 受影响 Wiki：只重编译一个已关联 Topic 的 Topic Wiki 页 ----
  let wikiPageOp: WikiPageWrite | null = null;
  let wikiPageId: string | null = null;
  let wikiPageVersionId: string | null = null;
  let wikiPagesCompiled = 0;
  if (promoted.length > 0) {
    const page = database.prepare(
      `SELECT id, revision FROM knowledge_wiki_pages
       WHERE scope = ? AND subject_type = 'topic' AND subject_id = ? AND lifecycle = 'active' LIMIT 1`
    ).get(scope, input.topicId) as { id: string; revision: number } | undefined;
    let previousAdopted: string[] = [];
    if (page) {
      const current = database.prepare('SELECT current_version_id AS c FROM knowledge_wiki_pages WHERE id = ?').get(page.id) as { c: string | null } | undefined;
      if (current?.c) {
        const version = getWikiPageVersion(database, current.c);
        if (version) previousAdopted = [...version.adoptedNoteVersionIds];
      }
    }
    const adoptedNoteVersionIds = [...new Set([...previousAdopted, ...promoted.map((entry) => entry.versionId)])];
    // 知识版本元数据：既有版本从库中读取（不可变），本次晋升版本取候选数据（apply 前尚未落库）。
    const keyConclusions: Array<Readonly<Record<string, unknown>>> = [];
    const persistedAdopted = adoptedNoteVersionIds.filter((id) => !promoted.some((entry) => entry.versionId === id));
    if (persistedAdopted.length > 0) {
      const placeholders = persistedAdopted.map(() => '?').join(',');
      const rows = database.prepare(
        `SELECT nv.note_id AS noteId, nv.statement, nv.conclusion_status AS conclusionStatus, nv.evidence_level AS evidenceLevel,
           nv.applies_to AS appliesTo, nv.change_type AS changeType, n.kind AS kind
         FROM knowledge_note_versions nv JOIN knowledge_notes n ON n.id = nv.note_id
         WHERE nv.id IN (${placeholders})`
      ).all(...persistedAdopted) as Array<Record<string, unknown>>;
      for (const row of rows) {
        keyConclusions.push({
          noteId: row.noteId, statement: row.statement, conclusionStatus: row.conclusionStatus,
          evidenceLevel: row.evidenceLevel, appliesTo: row.appliesTo, changeType: row.changeType, kind: row.kind
        });
      }
    }
    for (const entry of promoted) {
      keyConclusions.push({
        noteId: entry.noteId, statement: entry.statement, conclusionStatus: entry.conclusionStatus,
        evidenceLevel: entry.evidenceLevel, appliesTo: entry.appliesTo, changeType: entry.changeType, kind: entry.kind
      });
    }
    // SQL IN 子句行序无保证：按 noteId 排序保证同计划输入哈希稳定（幂等）。
    keyConclusions.sort((left, right) => String(left.noteId).localeCompare(String(right.noteId)));
    const body: Readonly<Record<string, unknown>> = {
      kind: 'topic-wiki',
      title: input.topicCompile?.title ?? topicRow.title,
      summary: input.topicCompile?.summary ?? '',
      asOf: source.collectedAt,
      scope,
      topicId: input.topicId,
      compiledSourceIds: [input.sourceId],
      sourceRevision: input.sourceRevision,
      keyConclusions,
      retainedDisputes: keyConclusions.filter((entry) => entry.conclusionStatus === 'disputed'),
      pendingQuestions: keyConclusions.filter((entry) => entry.kind === 'question').map((entry) => entry.statement),
      recentChanges: promoted.map((entry) => ({ noteId: entry.noteId, versionId: entry.versionId, canonicalKey: entry.canonicalKey, changeType: entry.changeType })),
      versionCount: adoptedNoteVersionIds.length
    };
    const title = (input.topicCompile?.title ?? topicRow.title).trim();
    const changeSummary = `Source ${input.sourceId} r${input.sourceRevision} 编译：新增 ${notesCreated} 条知识、更新 ${notesUpdated} 条、重编译 Topic Wiki（采纳 ${adoptedNoteVersionIds.length} 个知识版本）。`;
    const readableDiff = `采纳版本 ${previousAdopted.length} → ${adoptedNoteVersionIds.length}（本次晋升 ${promoted.length}：${promoted.map((entry) => entry.canonicalKey).join('、') || '无'}）。`;
    const businessObjectRefs = [`source:${input.sourceId}:r${input.sourceRevision}`];
    wikiPageVersionId = deterministicId('wver', `${input.requestId}|wiki-topic|${input.topicId}`);
    if (page) {
      wikiPageId = page.id;
      wikiPageOp = {
        id: page.id, scope, pageType: 'topic', canonicalKey: `wiki-topic:${input.topicId}`, title,
        subjectType: 'topic', subjectId: input.topicId, beforeRevision: page.revision,
        version: { versionId: wikiPageVersionId, title, body, adoptedNoteVersionIds, businessObjectRefs, changeSummary, readableDiff, compileReason: input.reason }
      };
    } else {
      wikiPageId = deterministicId('page', `wiki-topic|${input.topicId}`);
      wikiPageOp = {
        id: wikiPageId, scope, pageType: 'topic', canonicalKey: `wiki-topic:${input.topicId}`, title,
        subjectType: 'topic', subjectId: input.topicId,
        version: { versionId: wikiPageVersionId, title, body, adoptedNoteVersionIds, businessObjectRefs, changeSummary, readableDiff, compileReason: input.reason }
      };
    }
    wikiPagesCompiled = 1;
  }

  // ---- 回执（低价值/纯复述也持久化；说明未晋升项） ----
  const disputedVersionIds = promoted.filter((entry) => entry.disputed).map((entry) => entry.versionId);
  const methodNoteIds = promoted.filter((entry) => entry.kind === 'method').map((entry) => entry.noteId);
  const affectedEntityIds = [...new Set(Object.values(entityIds))];
  const autoResolutions: string[] = promoted
    .filter((entry) => entry.changeType !== 'created')
    .map((entry) => `${entry.changeType}:${entry.noteId}:${entry.beforeVersionId ?? 'new'}->${entry.versionId}`);
  const resolutionMode: ResolutionMode = input.resolutionMode ?? (disputedVersionIds.length > 0 ? 'kept_disputed' : 'none');
  const receiptRequestId = input.requestId;

  const changeSetInput: KnowledgeChangeSetInput = {
    entities: entityOps,
    notes: noteOps,
    wikiPages: wikiPageOp ? [wikiPageOp] : [],
    evidenceLinks: evidenceOps,
    receipts: [{
      triggerType: 'ingest' as ReceiptTriggerType,
      requestId: receiptRequestId,
      summary: `Source ${input.sourceId} r${input.sourceRevision} 知识编译：新增 ${notesCreated} 条、更新 ${notesUpdated} 条、跳过 ${skipped.length} 条低价值/复述、Entity 匹配 ${entitiesMatched} 个/新建 ${entitiesCreated} 个、重编译 Topic Wiki ${wikiPagesCompiled} 个。`,
      counts: {
        entitiesCreated, entitiesMatched, notesCreated, notesUpdated,
        notesSkippedLowValue: skipped.length, noteVersionsCreated: promoted.length,
        evidenceLinks: evidenceOps.length, wikiPagesCompiled
      },
      affectedTopics: [input.topicId],
      affectedEntities: affectedEntityIds,
      affectedMethods: methodNoteIds,
      affectedSyntheses: [],
      wikiPageVersions: wikiPageVersionId ? [wikiPageVersionId] : [],
      impact: { sourceId: input.sourceId, sourceRevision: input.sourceRevision, scope, topicId: input.topicId, asOf: source.collectedAt },
      autoResolutions,
      retainedDisputes: disputedVersionIds,
      failures: skipped
    }]
  };

  // 幂等输入哈希：对「冻结计划」而非派生段求哈希（契约 §9 幂等输入哈希；派生段含
  // 观察态计数/受影响数组，重放时必然不同）。同 requestId + 同计划 → 重放零写；
  // 同 requestId + 不同计划（含 sourceNature/reason/scope 变化）→ REQUEST_REPLAY_CONFLICT。
  const planHash = createKnowledgeChangeSetInputHash(input.requestId, {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    topicId: input.topicId,
    scope,
    createdBy,
    triggerSource,
    sourceNature,
    reason: input.reason,
    topicCompile: input.topicCompile ?? null,
    entities: input.entities ?? [],
    notes: input.notes ?? [],
    resolutionMode
  });

  const meta: KnowledgeChangeSetMeta = {
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    reason: input.reason,
    triggerSource,
    resolutionMode,
    createdBy,
    inputHash: planHash
  };
  const result = applyKnowledgeChangeSet(database, meta, changeSetInput);

  // ---- 重放：以库中持久化结果为准（版本 id 与首次编译一致，计数取回执） ----
  // 重放时预计算看到的是「已全部存在」的观察态（promoted 为空、无 wiki 操作），
  // 结果必须反映首次编译的持久化产物。
  if (result.replay) {
    for (const candidate of input.notes ?? []) {
      const note = getKnowledgeNote(database, noteIds[candidate.canonicalKey]);
      if (note?.version?.id) noteVersionIds[candidate.canonicalKey] = note.version.id;
    }
    const persistedPage = database.prepare(
      `SELECT id FROM knowledge_wiki_pages
       WHERE scope = ? AND subject_type = 'topic' AND subject_id = ? AND lifecycle = 'active' LIMIT 1`
    ).get(scope, input.topicId) as { id: string } | undefined;
    if (persistedPage) {
      wikiPageId = persistedPage.id;
      wikiPageVersionId = getWikiPage(database, persistedPage.id)?.version?.id ?? null;
    }
  }

  const counts: KnowledgeCompileCounts = result.replay && result.receipt
    ? {
        entitiesCreated: Number(result.receipt.counts.entitiesCreated ?? 0),
        entitiesMatched: Number(result.receipt.counts.entitiesMatched ?? 0),
        notesCreated: Number(result.receipt.counts.notesCreated ?? 0),
        notesUpdated: Number(result.receipt.counts.notesUpdated ?? 0),
        notesSkippedLowValue: Number(result.receipt.counts.notesSkippedLowValue ?? 0),
        noteVersionsCreated: Number(result.receipt.counts.noteVersionsCreated ?? 0),
        evidenceLinks: Number(result.receipt.counts.evidenceLinks ?? 0),
        wikiPagesCompiled: Number(result.receipt.counts.wikiPagesCompiled ?? 0)
      }
    : {
        entitiesCreated, entitiesMatched, notesCreated, notesUpdated,
        notesSkippedLowValue: skipped.length, noteVersionsCreated: promoted.length,
        evidenceLinks: evidenceOps.length, wikiPagesCompiled
      };

  return Object.freeze({
    ok: true,
    replay: result.replay,
    changeSetId: result.changeSetId,
    requestId: input.requestId,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    counts: Object.freeze(counts),
    entityIds: Object.freeze({ ...entityIds }),
    noteIds: Object.freeze({ ...noteIds }),
    noteVersionIds: Object.freeze({ ...noteVersionIds }),
    wikiPageId,
    wikiPageVersionId,
    receipt: result.receipt
  });
}

/**
 * Source 保存后的显式触发入口（sources 明确接点）：读取 Source 当前 revision 并冻结，
 * requestId 自动取 sourceCompileRequestId(sourceId, revision) —— 同 source revision 重放幂等。
 * 供 upsertSource / dispatchSourceUpsertBatch 成功后的业务调用；不含模型供应商。
 */
export function compileSavedSource(
  database: DatabaseSync,
  input: Readonly<{
    workspaceId: string;
    sourceId: string;
    topicId: string;
    scope?: KnowledgeScope;
    createdBy?: CreatorNature;
    triggerSource?: TriggerSource;
    sourceNature?: SourceNature;
    resolutionMode?: ResolutionMode;
    reason: string;
    entities?: readonly KnowledgeCompilerEntityCandidate[];
    notes?: readonly KnowledgeCompilerNoteCandidate[];
    topicCompile?: Readonly<{ title?: string; summary?: string }>;
  }>
): KnowledgeCompileResult {
  const source = getSource(database, input.sourceId);
  if (!source) compileError('COMPILE_SOURCE_NOT_FOUND', `编译触发 Source ${input.sourceId} 不存在（必须为真实已保存 Source）。`, { sourceId: input.sourceId });
  return compileSourceKnowledge(database, {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    sourceRevision: source.revision,
    requestId: sourceCompileRequestId(input.sourceId, source.revision),
    topicId: input.topicId,
    scope: input.scope,
    createdBy: input.createdBy,
    triggerSource: input.triggerSource,
    sourceNature: input.sourceNature,
    resolutionMode: input.resolutionMode,
    reason: input.reason,
    entities: input.entities,
    notes: input.notes,
    topicCompile: input.topicCompile
  });
}
