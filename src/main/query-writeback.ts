/**
 * WMB-5214 M5：Pi Query 写回服务（本 worker：ImplementQueryWriteback）。
 * Design: docs/spark/2026-08-12-wmb-ai-knowledge-compilation-protocol-design.md §10 +
 *         2026-08-12-wmb-knowledge-object-version-contract-design.md §25
 *
 * 职责：把「Pi 轮次完成后的显式结构化写回清单」机器校验后经 applyKnowledgeChangeSet
 * 原子落库。本模块不做任何自由文本猜测：
 * - 输入必须是结构化 manifest（Pi 在末条回复以 ```json {"wmb_query_writeback": …} ``` 围栏
 *   声明；解析失败 / 无围栏 → 零写，不猜测）；
 * - 冻结本轮实际读取的 Wiki/Knowledge/Evidence 版本（每个 id 必须真实存在）；
 * - 严格三分：restatement（纯复述 → 零知识，仅 Artifact + Receipt）/
 *   new_synthesis（去重后 ChangeSet 更新 Synthesis Wiki，仅引用冻结读取版本）/
 *   user_experience（先保存不可变 FreeNote，不伪造知识）；
 * - 回答本身不是证据：综合候选只能基于本轮冻结读取的版本（basedOn ⊆ read），
 *   证据关系 derived_from 指向读取版本，绝不把答案文本挂为证据；
 * - 幂等：requestId 约定 `query:{conversationId}:{questionHash}`（shared 单源），
 *   同 requestId 已处理 → 零写返回既有 Artifact；同 requestId + 同计划 → store 原生重放零增量；
 * - 失败零写：全部校验发生在 apply 之前；store 事务整体原子。
 *
 * 本模块不包含模型供应商。写回触发接点：Pi 主进程轮次完成 hook（ipc-pi-dock.ts）显式调用
 * dispatchQueryWriteback（经 CommandDispatcher，满足 workspace write guard）；测试与无守卫
 * DB 直接调用 writebackQueryKnowledge。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeQueryRiskFlag } from '../shared/knowledge-flywheel.ts';
import {
  applyKnowledgeChangeSet,
  createKnowledgeChangeSetInputHash,
  getKnowledgeNote,
  getQueryArtifactByRequest,
  getUpdateReceiptByRequest,
  type ConclusionStatus,
  type CreatorNature,
  type EvidenceLevel,
  type EvidenceLinkWrite,
  type FreeNoteWrite,
  type KnowledgeChangeSetInput,
  type KnowledgeChangeSetMeta,
  type KnowledgeQueryArtifactRecord,
  type KnowledgeScope,
  type KnowledgeUpdateReceiptRecord,
  type NoteKind,
  type NoteWrite,
  type QueryArtifactWrite,
  type QueryWriteBackDecision,
  type ReceiptWrite,
  type ResolutionMode,
  type TriggerSource,
  type WikiPageWrite
} from './knowledge-flywheel.ts';

// ============================================================
// 错误与固定矩阵
// ============================================================

export class QueryWritebackError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'QueryWritebackError';
    this.code = code;
    this.details = details;
  }
}

export const QUERY_WRITEBACK_ERROR_CODES = Object.freeze([
  'QUERY_WRITEBACK_INPUT_INVALID',
  'QUERY_WRITEBACK_MANIFEST_INVALID',
  'QUERY_WRITEBACK_VERSION_NOT_FOUND',
  'QUERY_WRITEBACK_BASED_ON_NOT_READ',
  'QUERY_WRITEBACK_EXPERIENCE_NOT_USER'
] as const);

export const QUERY_WRITEBACK_MANIFEST_KEY = 'wmb_query_writeback' as const;

export type QueryWritebackClassification = 'restatement' | 'new_synthesis' | 'user_experience';

const CLASSIFICATIONS: Readonly<Record<string, true>> = Object.freeze({
  restatement: true, new_synthesis: true, user_experience: true
});

const INSIGHT_KIND: NoteKind = 'insight';
const SYNTHESIS_STATUS: ConclusionStatus = 'inference';
const SYNTHESIS_EVIDENCE_LEVEL: EvidenceLevel = 'mixed';

function writebackError(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new QueryWritebackError(code, message, details);
}

function normalizeCanonicalKey(value: string): string {
  return value?.trim().toLowerCase() ?? '';
}

/** 确定性对象 id（幂等关键）：同 requestId + 同计划 → 完全相同的输入 → store 重放零写。 */
function deterministicId(prefix: string, seed: string): string {
  return `${prefix}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

// ============================================================
// 结构化 manifest（Pi 末条回复围栏块；解析失败 → null，零写不猜测）
// ============================================================

export type QueryWritebackManifest = Readonly<{
  classification: QueryWritebackClassification;
  readWikiVersionIds: readonly string[];
  readNoteVersionIds: readonly string[];
  readEvidenceIds: readonly string[];
  synthesis: Readonly<{
    canonicalKey: string;
    title?: string;
    statement: string;
    basedOnNoteVersionIds?: readonly string[];
    valueRationale: string;
  }> | null;
  experience: Readonly<{ body: string }> | null;
}>;

function asStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 严格校验 manifest 的结构形状（fail-closed；语义校验在 writebackQueryKnowledge 内）。 */
export function normalizeQueryWritebackManifest(raw: unknown): QueryWritebackManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const classification = value.classification;
  if (typeof classification !== 'string' || !CLASSIFICATIONS[classification]) return null;
  const readWikiVersionIds = asStringArray(value.readWikiVersionIds);
  const readNoteVersionIds = asStringArray(value.readNoteVersionIds);
  const readEvidenceIds = asStringArray(value.readEvidenceIds);
  if (readWikiVersionIds === null || readNoteVersionIds === null || readEvidenceIds === null) return null;

  const synthesisRaw = value.synthesis ?? null;
  const experienceRaw = value.experience ?? null;
  if (synthesisRaw !== null && (typeof synthesisRaw !== 'object' || Array.isArray(synthesisRaw))) return null;
  if (experienceRaw !== null && (typeof experienceRaw !== 'object' || Array.isArray(experienceRaw))) return null;

  let synthesis: QueryWritebackManifest['synthesis'] = null;
  if (synthesisRaw !== null) {
    const record = synthesisRaw as Record<string, unknown>;
    const canonicalKey = asString(record.canonicalKey);
    const statement = asString(record.statement);
    const valueRationale = asString(record.valueRationale);
    if (!canonicalKey?.trim() || !statement?.trim() || !valueRationale?.trim()) return null;
    const title = asString(record.title);
    const basedOnNoteVersionIds = asStringArray(record.basedOnNoteVersionIds);
    if (basedOnNoteVersionIds === null) return null;
    synthesis = Object.freeze({
      canonicalKey: canonicalKey.trim(),
      ...(title?.trim() ? { title: title.trim() } : {}),
      statement: statement.trim(),
      basedOnNoteVersionIds,
      valueRationale: valueRationale.trim()
    });
  }

  let experience: QueryWritebackManifest['experience'] = null;
  if (experienceRaw !== null) {
    const body = asString((experienceRaw as Record<string, unknown>).body);
    if (!body?.trim()) return null;
    experience = Object.freeze({ body: body.trim() });
  }

  // 三分互斥：restatement 不带 synthesis/experience；new_synthesis 必带 synthesis；
  // user_experience 必带 experience。
  if (classification === 'restatement' && (synthesis || experience)) return null;
  if (classification === 'new_synthesis' && (!synthesis || experience)) return null;
  if (classification === 'user_experience' && (synthesis || !experience)) return null;

  return Object.freeze({
    classification: classification as QueryWritebackClassification,
    readWikiVersionIds: Object.freeze(readWikiVersionIds),
    readNoteVersionIds: Object.freeze(readNoteVersionIds),
    readEvidenceIds: Object.freeze(readEvidenceIds),
    synthesis,
    experience
  });
}

/**
 * 解析 Pi 回复文本中**最后一个** ```json 围栏块里的 `wmb_query_writeback` 清单。
 * 无围栏 / JSON 非法 / 键错 / 结构非法 → null（调用方零写，绝不猜测）。
 */
export function extractQueryWritebackManifest(text: string): QueryWritebackManifest | null {
  const fences = [...(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!fences.length) return null;
  const last = fences[fences.length - 1]![1]!;
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(QUERY_WRITEBACK_MANIFEST_KEY in record)) return null;
  return normalizeQueryWritebackManifest(record[QUERY_WRITEBACK_MANIFEST_KEY]);
}

/** 从回复文本中移除 manifest 围栏块（用户看到的正文不含协议块；无块则原样返回）。 */
export function stripQueryWritebackBlock(text: string): string {
  const fences = [...(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!fences.length) return text;
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    const fence = fences[index]!;
    try {
      const value: unknown = JSON.parse(fence[1]!);
      if (value && typeof value === 'object' && !Array.isArray(value)
        && QUERY_WRITEBACK_MANIFEST_KEY in (value as Record<string, unknown>)) {
        const start = fence.index!;
        const end = start + fence[0].length;
        const prefix = text.slice(0, start).replace(/\s+$/, '');
        const suffix = text.slice(end).replace(/^\s+/, '');
        return ((prefix ? `${prefix}\n` : '') + suffix).trim();
      }
    } catch {
      // 非 JSON 围栏：继续向前找
    }
  }
  return text;
}

// ============================================================
// 写回输入与结果
// ============================================================

export type QueryWritebackSynthesisCandidate = Readonly<{
  canonicalKey: string;
  title?: string;
  statement: string;
  basedOnNoteVersionIds: readonly string[];
  valueRationale: string;
}>;

export type KnowledgeQueryWritebackInput = Readonly<{
  /** 幂等键（shared 约定：`query:{conversationId}:{questionHash}`）。 */
  requestId: string;
  workspaceId: string;
  scope: KnowledgeScope;
  conversationId: string;
  /** 用户问题（与 transcript 用户消息 text 一致）。 */
  question: string;
  /** Pi 回答摘要（manifest 围栏已剥离）。 */
  answerSummary: string;
  classification: QueryWritebackClassification;
  readWikiVersionIds: readonly string[];
  readNoteVersionIds: readonly string[];
  readEvidenceIds: readonly string[];
  synthesis?: QueryWritebackSynthesisCandidate;
  /** 用户新经验原文（先保存 FreeNote）。 */
  experience?: Readonly<{ body: string }>;
  createdBy?: CreatorNature;
  triggerSource?: TriggerSource;
}>;

export type QueryWritebackCounts = Readonly<{
  notesCreated: number;
  notesUpdated: number;
  noteVersionsCreated: number;
  evidenceLinks: number;
  wikiPagesCompiled: number;
  freeNotes: number;
  skippedRepetition: number;
  restatements: number;
}>;

export type KnowledgeQueryWritebackResult = Readonly<{
  ok: boolean;
  /** 同 requestId 已处理（同问幂等）：零写返回既有 Artifact。 */
  duplicate: boolean;
  /** store 幂等重放：零增量。 */
  replay: boolean;
  changeSetId: string;
  requestId: string;
  conversationId: string;
  classification: QueryWritebackClassification;
  writeBackDecision: QueryWriteBackDecision;
  skipReason: string | null;
  counts: QueryWritebackCounts;
  noteIds: Readonly<Record<string, string>>;
  noteVersionIds: Readonly<Record<string, string>>;
  synthesisPageId: string | null;
  synthesisPageVersionId: string | null;
  freeNoteId: string | null;
  artifact: KnowledgeQueryArtifactRecord | null;
  receipt: KnowledgeUpdateReceiptRecord | null;
}>;

// ============================================================
// 冻结读取版本校验（每个 id 必须真实存在；回答本身不是证据）
// ============================================================

function validateReadVersions(
  database: DatabaseSync,
  input: KnowledgeQueryWritebackInput
): { wikiVersionIds: string[]; noteVersionIds: string[]; evidenceIds: string[] } {
  const wikiVersionIds = [...new Set(input.readWikiVersionIds ?? [])];
  const noteVersionIds = [...new Set(input.readNoteVersionIds ?? [])];
  const evidenceIds = [...new Set(input.readEvidenceIds ?? [])];
  for (const id of wikiVersionIds) {
    if (!database.prepare('SELECT 1 FROM knowledge_wiki_page_versions WHERE id = ?').get(id)) {
      writebackError('QUERY_WRITEBACK_VERSION_NOT_FOUND', `读取的 Wiki 版本 ${id} 不存在（冻结失败）。`, { versionKind: 'wiki_page', versionId: id });
    }
  }
  for (const id of noteVersionIds) {
    if (!database.prepare('SELECT 1 FROM knowledge_note_versions WHERE id = ?').get(id)) {
      writebackError('QUERY_WRITEBACK_VERSION_NOT_FOUND', `读取的 Note 版本 ${id} 不存在（冻结失败）。`, { versionKind: 'note', versionId: id });
    }
  }
  for (const id of evidenceIds) {
    if (!database.prepare('SELECT 1 FROM knowledge_evidence_links WHERE id = ?').get(id)) {
      writebackError('QUERY_WRITEBACK_VERSION_NOT_FOUND', `读取的 Evidence ${id} 不存在（冻结失败）。`, { versionKind: 'evidence', versionId: id });
    }
  }
  return { wikiVersionIds, noteVersionIds, evidenceIds };
}

/** 从冻结读取的 Note 版本解析其采用 Topic（综合的受影响面）。 */
function resolveReadTopicIds(database: DatabaseSync, noteVersionIds: readonly string[]): string[] {
  if (!noteVersionIds.length) return [];
  const placeholders = noteVersionIds.map(() => '?').join(',');
  const rows = database.prepare(
    `SELECT adopted_topic_ids_json AS topicsJson FROM knowledge_note_versions WHERE id IN (${placeholders})`
  ).all(...noteVersionIds) as Array<{ topicsJson: string }>;
  const topics = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.topicsJson) as unknown;
      if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string') topics.add(id);
    } catch {
      // 忽略损坏的 JSON（版本为 store 写入，正常不可能）
    }
  }
  return [...topics];
}

function buildReceipt(
  input: KnowledgeQueryWritebackInput,
  summary: string,
  counts: QueryWritebackCounts,
  extras: Readonly<{ affectedSyntheses?: string[]; wikiPageVersions?: string[] }> = {}
): ReceiptWrite {
  return {
    id: deterministicId('qrec', input.requestId),
    triggerType: 'query',
    requestId: input.requestId,
    summary: `Query 写回（${input.classification}）：${summary}读取冻结版本 wiki=${input.readWikiVersionIds?.length ?? 0} / note=${input.readNoteVersionIds?.length ?? 0} / evidence=${input.readEvidenceIds?.length ?? 0}。`,
    counts: { ...counts },
    affectedSyntheses: extras.affectedSyntheses ?? [],
    wikiPageVersions: extras.wikiPageVersions ?? [],
    impact: {
      classification: input.classification,
      requestId: input.requestId,
      conversationId: input.conversationId,
      question: input.question,
      readWikiVersionIds: input.readWikiVersionIds ?? [],
      readNoteVersionIds: input.readNoteVersionIds ?? [],
      readEvidenceIds: input.readEvidenceIds ?? []
    },
    autoResolutions: [],
    retainedDisputes: [],
    failures: []
  };
}

function buildArtifact(
  input: KnowledgeQueryWritebackInput,
  decision: QueryWriteBackDecision,
  skipReason: string | null,
  read: { wikiVersionIds: string[]; noteVersionIds: string[]; evidenceIds: string[] },
  candidates: readonly unknown[]
): QueryArtifactWrite {
  return {
    scope: input.scope,
    requestId: input.requestId,
    question: input.question,
    answerSummary: input.answerSummary,
    readWikiVersionIds: read.wikiVersionIds,
    readNoteVersionIds: read.noteVersionIds,
    readEvidenceIds: read.evidenceIds,
    candidates,
    writeBackDecision: decision,
    skipReason,
    receiptId: deterministicId('qrec', input.requestId)
  };
}

// ============================================================
// 写回主流程（纯服务：校验 → 去重 → ChangeSet 构造 → apply；全部失败零写）
// ============================================================

function buildChangeSet(
  database: DatabaseSync,
  input: KnowledgeQueryWritebackInput,
  read: { wikiVersionIds: string[]; noteVersionIds: string[]; evidenceIds: string[] }
): BuiltQueryWriteback {
  const scope = input.scope;
  const createdBy: CreatorNature = input.createdBy ?? 'pi';
  const triggerSource: TriggerSource = input.triggerSource ?? 'query';
  const resolutionMode: ResolutionMode = 'none';
  const zero = { notesCreated: 0, notesUpdated: 0, noteVersionsCreated: 0, evidenceLinks: 0, wikiPagesCompiled: 0, freeNotes: 0, skippedRepetition: 0, restatements: 0 };

  // ---- restatement：纯复述 → 零知识，仅 Artifact + Receipt ----
  if (input.classification === 'restatement') {
    if (read.wikiVersionIds.length + read.noteVersionIds.length + read.evidenceIds.length === 0) {
      writebackError('QUERY_WRITEBACK_INPUT_INVALID', 'restatement 必须声明至少一个实际读取的知识版本。');
    }
    const meta: KnowledgeChangeSetMeta = {
      workspaceId: input.workspaceId, requestId: input.requestId,
      reason: `Query 纯复述：${input.question.slice(0, 80)}`,
      triggerSource, resolutionMode, createdBy,
      inputHash: createKnowledgeChangeSetInputHash(input.requestId, {
        classification: input.classification,
        question: input.question, answerSummary: input.answerSummary,
        readWikiVersionIds: read.wikiVersionIds, readNoteVersionIds: read.noteVersionIds, readEvidenceIds: read.evidenceIds
      })
    };
    const skipReason = '纯复述既有知识，未产生新沉淀。';
    const counts = { ...zero, restatements: 1, skippedRepetition: 1 };
    const segments: KnowledgeChangeSetInput = {
      receipts: [buildReceipt(input, skipReason, counts)],
      queryArtifacts: [buildArtifact(input, 'skipped_repetition', skipReason, read, [])]
    };
    return { meta, segments, decision: 'skipped_repetition', skipReason, counts, noteIds: {}, noteVersionIds: {}, synthesisPageId: null, synthesisPageVersionId: null, freeNoteId: null };
  }

  // ---- user_experience：先保存不可变 FreeNote（用户原文），不伪造知识 ----
  if (input.classification === 'user_experience') {
    const experience = input.experience;
    if (!experience?.body?.trim()) writebackError('QUERY_WRITEBACK_INPUT_INVALID', 'user_experience 必须携带用户经验原文（experience.body）。');
    const body = experience!.body.trim();
    if (body === input.answerSummary.trim()) {
      writebackError('QUERY_WRITEBACK_EXPERIENCE_NOT_USER', '用户经验原文与回答摘要相同：经验必须是用户自己的表述，不是回答本身。');
    }
    const freeNoteId = deterministicId('qfn', `${input.requestId}|${scope}|user_experience`);
    const freeNote: FreeNoteWrite = {
      id: freeNoteId, scope, sourceNature: 'pi_dialogue', body,
      processingState: 'captured',
      processingReason: 'WMB-5214：Pi 对话中的用户新经验，先保存原文，待后续提炼',
      sessionRef: input.conversationId,
      linkedObjectType: 'knowledge_query_artifact'
    };
    const meta: KnowledgeChangeSetMeta = {
      workspaceId: input.workspaceId, requestId: input.requestId,
      reason: `Query 用户经验：${input.question.slice(0, 80)}`,
      triggerSource, resolutionMode, createdBy,
      inputHash: createKnowledgeChangeSetInputHash(input.requestId, {
        classification: input.classification, body,
        question: input.question, answerSummary: input.answerSummary,
        readWikiVersionIds: read.wikiVersionIds, readNoteVersionIds: read.noteVersionIds, readEvidenceIds: read.evidenceIds
      })
    };
    const counts = { ...zero, freeNotes: 1 };
    const skipReason = `用户经验已保存为 FreeNote ${freeNoteId}，待后续提炼。`;
    const segments: KnowledgeChangeSetInput = {
      freeNotes: [freeNote],
      receipts: [buildReceipt(input, skipReason, counts)],
      queryArtifacts: [buildArtifact(input, 'no_write_back', skipReason, read, [{ kind: 'user_experience', body, freeNoteId }])]
    };
    return { meta, segments, decision: 'no_write_back', skipReason, counts, noteIds: {}, noteVersionIds: {}, synthesisPageId: null, synthesisPageVersionId: null, freeNoteId };
  }

  // ---- new_synthesis：去重后 ChangeSet 更新 Synthesis Wiki；仅引用冻结读取版本 ----
  const synthesis = input.synthesis;
  if (!synthesis) writebackError('QUERY_WRITEBACK_INPUT_INVALID', 'new_synthesis 必须携带 synthesis 候选。');
  const basedOn = [...new Set(synthesis!.basedOnNoteVersionIds ?? [])];
  if (basedOn.length === 0) {
    writebackError('QUERY_WRITEBACK_INPUT_INVALID', 'new_synthesis 必须基于至少一个冻结读取的 Note 版本。');
  }
  for (const id of basedOn) {
    if (!read.noteVersionIds.includes(id)) {
      writebackError('QUERY_WRITEBACK_BASED_ON_NOT_READ', `综合候选基于的 Note 版本 ${id} 不在本轮冻结读取集合内（回答本身不是证据）。`, { basedOnVersionId: id });
    }
  }

  const key = normalizeCanonicalKey(synthesis!.canonicalKey);
  if (!key || !synthesis!.statement?.trim() || !synthesis!.valueRationale?.trim()) {
    writebackError('QUERY_WRITEBACK_INPUT_INVALID', '综合候选需要 canonicalKey / statement / valueRationale。');
  }
  const adoptedTopicIds = resolveReadTopicIds(database, basedOn);
  const noteId = deterministicId('qnote', `${scope}|${key}`);
  const noteVersionId = deterministicId('qver', `${input.requestId}|${scope}|${key}`);
  const pageId = deterministicId('qpage', `${scope}|synthesis:${key}`);
  const pageVersionId = deterministicId('qwver', `${input.requestId}|${scope}|synthesis:${key}`);
  const title = synthesis!.title?.trim() || synthesis!.statement.trim().slice(0, 120);
  const reason = `Query 新综合：${input.question.slice(0, 80)}`;

  const existingNote = getKnowledgeNote(database, noteId);
  const noteIds: Record<string, string> = {};
  const noteVersionIds: Record<string, string> = {};
  const counts = { ...zero };

  // 同问幂等 / 去重：同 canonicalKey 且同 statement → 零知识写（仅 Artifact + Receipt）
  if (existingNote && existingNote.version?.statement?.trim() === synthesis!.statement.trim()) {
    const meta: KnowledgeChangeSetMeta = {
      workspaceId: input.workspaceId, requestId: input.requestId, reason,
      triggerSource, resolutionMode, createdBy,
      inputHash: createKnowledgeChangeSetInputHash(input.requestId, {
        classification: input.classification, canonicalKey: key, statement: synthesis!.statement,
        basedOnNoteVersionIds: basedOn, valueRationale: synthesis!.valueRationale,
        question: input.question, answerSummary: input.answerSummary,
        readWikiVersionIds: read.wikiVersionIds, readNoteVersionIds: read.noteVersionIds, readEvidenceIds: read.evidenceIds
      })
    };
    const skipReason = '同问/同陈述综合已存在，未重复沉淀。';
    const countsNow = { ...counts, skippedRepetition: 1 };
    const segments: KnowledgeChangeSetInput = {
      receipts: [buildReceipt(input, skipReason, countsNow)],
      queryArtifacts: [buildArtifact(input, 'skipped_repetition', skipReason, read, [{ kind: 'synthesis', canonicalKey: key, statement: synthesis!.statement, basedOnNoteVersionIds: basedOn, decision: 'skipped_repetition' }])]
    };
    const existingPageId = (database.prepare(
      `SELECT id FROM knowledge_wiki_pages WHERE scope = ? AND canonical_key = ? AND lifecycle = 'active' LIMIT 1`
    ).get(scope, `synthesis:${key}`) as { id: string } | undefined)?.id ?? null;
    return {
      meta, segments, decision: 'skipped_repetition', skipReason, counts: countsNow,
      noteIds: { [key]: noteId }, noteVersionIds: { [key]: existingNote.version.id },
      synthesisPageId: existingPageId, synthesisPageVersionId: null, freeNoteId: null
    };
  }

  // 晋升：创建/追加 insight Note 版本 + derived_from 证据（指向冻结读取版本）+ Synthesis Wiki 页
  const changeType = existingNote ? 'recompiled' : 'created';
  const noteOp: NoteWrite = {
    id: noteId, scope, kind: INSIGHT_KIND, canonicalKey: key, title,
    ...(existingNote ? { beforeRevision: existingNote.note.revision } : {}),
    version: {
      versionId: noteVersionId, title, statement: synthesis!.statement,
      conclusionStatus: SYNTHESIS_STATUS, evidenceLevel: SYNTHESIS_EVIDENCE_LEVEL,
      adoptedTopicIds,
      adoptedKnowledgeVersionIds: basedOn,
      changeType,
      changeReason: synthesis!.valueRationale
    }
  };
  const evidenceOps: EvidenceLinkWrite[] = [
    ...basedOn.map((versionId) => ({
      knowledgeNoteVersionId: noteVersionId, evidenceObjectType: 'knowledge_note_version' as const,
      evidenceObjectId: versionId, relation: 'derived_from' as const, sourceNature: 'derived_knowledge' as const,
      excerpt: null, locator: `query:${input.requestId}`
    })),
    // schema CHECK：derived_knowledge 仅允许 knowledge_note_version 证据对象；
    // Wiki 版本（编译知识）作为综合依据以 ai_inference 记录（回答本身仍不是证据）。
    ...read.wikiVersionIds.map((versionId) => ({
      knowledgeNoteVersionId: noteVersionId, evidenceObjectType: 'wiki_page_version' as const,
      evidenceObjectId: versionId, relation: 'derived_from' as const, sourceNature: 'ai_inference' as const,
      excerpt: null, locator: `query:${input.requestId}`
    }))
  ];
  const adoptedNoteVersionIds = [...new Set([...read.noteVersionIds, noteVersionId])];
  // Synthesis Wiki 页存在性：更新用 beforeRevision（store 强制），不存在则创建
  const existingPage = database.prepare(
    `SELECT revision FROM knowledge_wiki_pages WHERE scope = ? AND canonical_key = ? AND lifecycle = 'active' LIMIT 1`
  ).get(scope, `synthesis:${key}`) as { revision: number } | undefined;

  const wikiPageOp: WikiPageWrite = {
    id: pageId, scope, pageType: 'synthesis', canonicalKey: `synthesis:${key}`, title,
    ...(existingPage ? { beforeRevision: existingPage.revision } : {}),
    version: {
      versionId: pageVersionId, title,
      body: {
        kind: 'synthesis-wiki',
        title,
        statement: synthesis!.statement,
        classification: 'new_synthesis',
        requestId: input.requestId,
        scope,
        basedOn: {
          wikiVersionIds: read.wikiVersionIds,
          noteVersionIds: read.noteVersionIds,
          evidenceIds: read.evidenceIds
        },
        adoptedTopicIds,
        adoptedNoteVersionIds
      },
      adoptedNoteVersionIds,
      businessObjectRefs: [
        ...read.wikiVersionIds.map((id) => `wiki_version:${id}`),
        ...read.noteVersionIds.map((id) => `note_version:${id}`)
      ],
      changeSummary: `Query 新综合「${title}」：基于 ${read.noteVersionIds.length} 个冻结 Note 版本 / ${read.wikiVersionIds.length} 个冻结 Wiki 版本沉淀为 Synthesis Wiki。`,
      readableDiff: existingNote
        ? `综合更新（追加版本）：采纳 ${adoptedNoteVersionIds.length} 个 Note 版本。`
        : `新建综合：采纳 ${adoptedNoteVersionIds.length} 个 Note 版本。`,
      compileReason: reason
    }
  };

  counts.notesCreated = existingNote ? 0 : 1;
  counts.notesUpdated = existingNote ? 1 : 0;
  counts.noteVersionsCreated = 1;
  counts.evidenceLinks = evidenceOps.length;
  counts.wikiPagesCompiled = 1;
  noteIds[key] = noteId;
  noteVersionIds[key] = noteVersionId;

  const meta: KnowledgeChangeSetMeta = {
    workspaceId: input.workspaceId, requestId: input.requestId, reason,
    triggerSource, resolutionMode, createdBy,
    inputHash: createKnowledgeChangeSetInputHash(input.requestId, {
      classification: input.classification, canonicalKey: key, statement: synthesis!.statement,
      title, basedOnNoteVersionIds: basedOn, valueRationale: synthesis!.valueRationale,
      question: input.question, answerSummary: input.answerSummary,
      readWikiVersionIds: read.wikiVersionIds, readNoteVersionIds: read.noteVersionIds, readEvidenceIds: read.evidenceIds
    })
  };
  const decision: QueryWriteBackDecision = existingNote ? 'updated' : 'created';
  const segments: KnowledgeChangeSetInput = {
    notes: [noteOp],
    wikiPages: [wikiPageOp],
    evidenceLinks: evidenceOps,
    receipts: [buildReceipt(input, `${existingNote ? '更新' : '创建'}综合「${title}」。`, counts, { affectedSyntheses: [pageId], wikiPageVersions: [pageVersionId] })],
    queryArtifacts: [buildArtifact(input, decision, null, read, [{ kind: 'synthesis', canonicalKey: key, statement: synthesis!.statement, basedOnNoteVersionIds: basedOn, decision }])]
  };
  return {
    meta, segments, decision, skipReason: null, counts,
    noteIds, noteVersionIds,
    synthesisPageId: pageId, synthesisPageVersionId: pageVersionId, freeNoteId: null
  };
}

// ============================================================
// 入口分层：prepare（校验+构造，零写）→ dispatch/apply → finalize（读回）
// ============================================================

type BuiltQueryWriteback = Readonly<{
  meta: KnowledgeChangeSetMeta;
  segments: KnowledgeChangeSetInput;
  decision: QueryWriteBackDecision;
  skipReason: string | null;
  counts: QueryWritebackCounts;
  noteIds: Record<string, string>;
  noteVersionIds: Record<string, string>;
  synthesisPageId: string | null;
  synthesisPageVersionId: string | null;
  freeNoteId: string | null;
}>;

export type PreparedQueryWriteback = Readonly<{
  /** 同 requestId 已处理（同问幂等）：零写，result 即既有 Artifact 读回。 */
  duplicate: boolean;
  result: KnowledgeQueryWritebackResult | null;
  meta: KnowledgeChangeSetMeta | null;
  segments: KnowledgeChangeSetInput | null;
  /** 预览（dispatcher 路径在 apply 后组装最终结果用）。 */
  preview: Readonly<{
    requestId: string;
    conversationId: string;
    classification: QueryWritebackClassification;
    writeBackDecision: QueryWriteBackDecision;
    skipReason: string | null;
    counts: QueryWritebackCounts;
    noteIds: Readonly<Record<string, string>>;
    noteVersionIds: Readonly<Record<string, string>>;
    synthesisPageId: string | null;
    synthesisPageVersionId: string | null;
    freeNoteId: string | null;
  }>;
}>;

function previewFromBuilt(input: KnowledgeQueryWritebackInput, built: BuiltQueryWriteback): PreparedQueryWriteback['preview'] {
  return {
    requestId: input.requestId,
    conversationId: input.conversationId,
    classification: input.classification,
    writeBackDecision: built.decision,
    skipReason: built.skipReason,
    counts: built.counts,
    noteIds: built.noteIds,
    noteVersionIds: built.noteVersionIds,
    synthesisPageId: built.synthesisPageId,
    synthesisPageVersionId: built.synthesisPageVersionId,
    freeNoteId: built.freeNoteId
  };
}

/** 校验 + 构造 ChangeSet（零写）；同 requestId 已处理 → duplicate（零写）。 */
export function prepareQueryWriteback(database: DatabaseSync, rawInput: KnowledgeQueryWritebackInput): PreparedQueryWriteback {
  const input = Object.freeze({ ...rawInput });
  if (!input.requestId?.trim()) writebackError('QUERY_WRITEBACK_INPUT_INVALID', 'Query 写回必须携带 requestId（幂等键）。');
  if (!input.workspaceId?.trim()) writebackError('QUERY_WRITEBACK_INPUT_INVALID', 'Query 写回必须携带 workspaceId。');
  if (!input.conversationId?.trim()) writebackError('QUERY_WRITEBACK_INPUT_INVALID', 'Query 写回必须携带 conversationId。');
  if (!input.question?.trim()) writebackError('QUERY_WRITEBACK_INPUT_INVALID', 'Query 写回必须携带用户问题。');
  if (!CLASSIFICATIONS[input.classification]) writebackError('QUERY_WRITEBACK_INPUT_INVALID', `非法 classification：${String(input.classification)}。`);
  const scope = input.scope ?? 'global';
  if (scope !== 'global' && !scope.startsWith('lane:')) writebackError('QUERY_WRITEBACK_INPUT_INVALID', 'scope 必须为 global 或 lane:<key>。');

  // 同问幂等：同 requestId 已持久化 Artifact → 零写返回既有记录（首次处理为准）。
  const prior = getQueryArtifactByRequest(database, input.requestId);
  if (prior) {
    const duplicateResult: KnowledgeQueryWritebackResult = Object.freeze({
      ok: true,
      duplicate: true,
      replay: false,
      changeSetId: prior.changeSetId ?? '',
      requestId: input.requestId,
      conversationId: input.conversationId,
      classification: input.classification,
      writeBackDecision: prior.writeBackDecision,
      skipReason: prior.skipReason,
      counts: Object.freeze({ notesCreated: 0, notesUpdated: 0, noteVersionsCreated: 0, evidenceLinks: 0, wikiPagesCompiled: 0, freeNotes: 0, skippedRepetition: 1, restatements: 0 }),
      noteIds: Object.freeze({}),
      noteVersionIds: Object.freeze({}),
      synthesisPageId: null,
      synthesisPageVersionId: null,
      freeNoteId: null,
      artifact: prior,
      receipt: getUpdateReceiptByRequest(database, input.workspaceId, input.requestId)
    });
    return Object.freeze({
      duplicate: true,
      result: duplicateResult,
      meta: null,
      segments: null,
      preview: {
        requestId: input.requestId,
        conversationId: input.conversationId,
        classification: input.classification,
        writeBackDecision: prior.writeBackDecision,
        skipReason: prior.skipReason,
        counts: Object.freeze({ notesCreated: 0, notesUpdated: 0, noteVersionsCreated: 0, evidenceLinks: 0, wikiPagesCompiled: 0, freeNotes: 0, skippedRepetition: 1, restatements: 0 }),
        noteIds: Object.freeze({}),
        noteVersionIds: Object.freeze({}),
        synthesisPageId: null,
        synthesisPageVersionId: null,
        freeNoteId: null
      }
    });
  }

  const read = validateReadVersions(database, input);
  const built = buildChangeSet(database, input, read);
  return Object.freeze({
    duplicate: false,
    result: null,
    meta: built.meta,
    segments: built.segments,
    preview: previewFromBuilt(input, built)
  });
}

/** apply 已提交后组装最终结果（读回 Artifact/Receipt；不重复写）。 */
export function finalizeQueryWriteback(database: DatabaseSync, prepared: PreparedQueryWriteback): KnowledgeQueryWritebackResult {
  if (prepared.duplicate) return prepared.result!;
  const artifact = getQueryArtifactByRequest(database, prepared.preview.requestId);
  const receipt = getUpdateReceiptByRequest(database, boundWorkspaceIdOf(database), prepared.preview.requestId);
  return Object.freeze({
    ok: true,
    duplicate: false,
    replay: false,
    changeSetId: artifact?.changeSetId ?? '',
    requestId: prepared.preview.requestId,
    conversationId: prepared.preview.conversationId,
    classification: prepared.preview.classification,
    writeBackDecision: prepared.preview.writeBackDecision,
    skipReason: prepared.preview.skipReason,
    counts: prepared.preview.counts,
    noteIds: prepared.preview.noteIds,
    noteVersionIds: prepared.preview.noteVersionIds,
    synthesisPageId: prepared.preview.synthesisPageId,
    synthesisPageVersionId: prepared.preview.synthesisPageVersionId,
    freeNoteId: prepared.preview.freeNoteId,
    artifact,
    receipt
  });
}

function boundWorkspaceIdOf(database: DatabaseSync): string {
  try {
    const row = database.prepare("SELECT value AS workspaceId FROM app_meta WHERE key='workspace_id'").get() as { workspaceId?: string } | undefined;
    return row?.workspaceId ?? '';
  } catch {
    return '';
  }
}

/** apply（无 write guard 的 DB / 测试直连）：apply 原子 ChangeSet 后组装结果。 */
export function applyPreparedQueryWriteback(database: DatabaseSync, prepared: PreparedQueryWriteback): KnowledgeQueryWritebackResult {
  if (prepared.duplicate) return prepared.result!;
  const result = applyKnowledgeChangeSet(database, prepared.meta!, prepared.segments!);
  const artifact = getQueryArtifactByRequest(database, prepared.preview.requestId);
  return Object.freeze({
    ok: true,
    duplicate: false,
    replay: result.replay,
    changeSetId: result.changeSetId,
    requestId: prepared.preview.requestId,
    conversationId: prepared.preview.conversationId,
    classification: prepared.preview.classification,
    writeBackDecision: prepared.preview.writeBackDecision,
    skipReason: prepared.preview.skipReason,
    counts: prepared.preview.counts,
    noteIds: prepared.preview.noteIds,
    noteVersionIds: prepared.preview.noteVersionIds,
    synthesisPageId: prepared.preview.synthesisPageId,
    synthesisPageVersionId: prepared.preview.synthesisPageVersionId,
    freeNoteId: prepared.preview.freeNoteId,
    artifact,
    receipt: result.receipt
  });
}

/**
 * 单入口（无 write guard 的 DB / 测试直连）：prepare → apply → finalize。
 * 同 requestId 已处理（同问幂等）→ 零写返回既有 Artifact；
 * 同 requestId + 同计划 → store 重放零增量。
 */
export function writebackQueryKnowledge(database: DatabaseSync, rawInput: KnowledgeQueryWritebackInput): KnowledgeQueryWritebackResult {
  const prepared = prepareQueryWriteback(database, rawInput);
  return applyPreparedQueryWriteback(database, prepared);
}

// ============================================================
// 只读摘要（面板消费）：Artifact + 风险标记 + Receipt
// ============================================================

/** 从 QueryArtifact 的冻结读取版本解析风险标记（disputed/contradicted/stale/inference/unverified）。 */
export function resolveQueryWritebackRiskFlags(database: DatabaseSync, artifact: KnowledgeQueryArtifactRecord | null): KnowledgeQueryRiskFlag[] {
  if (!artifact) return [];
  const flags: KnowledgeQueryRiskFlag[] = [];
  const noteVersionIds = artifact.readNoteVersionIds ?? [];
  if (noteVersionIds.length) {
    const placeholders = noteVersionIds.map(() => '?').join(',');
    const rows = database.prepare(
      `SELECT id, conclusion_status AS conclusionStatus, evidence_level AS evidenceLevel
       FROM knowledge_note_versions WHERE id IN (${placeholders})`
    ).all(...noteVersionIds) as Array<{ id: string; conclusionStatus: string; evidenceLevel: string }>;
    for (const row of rows) {
      if (row.conclusionStatus === 'disputed' || row.conclusionStatus === 'contradicted') {
        flags.push({ kind: row.conclusionStatus, versionKind: 'note', versionId: row.id, note: `读取的 Note 版本结论为 ${row.conclusionStatus}` });
      } else if (row.conclusionStatus === 'inference') {
        flags.push({ kind: 'inference', versionKind: 'note', versionId: row.id, note: '读取的 Note 版本为模型推断，未经独立证据支撑' });
      } else if (row.evidenceLevel === 'none' || row.evidenceLevel === 'insufficient') {
        flags.push({ kind: 'unverified', versionKind: 'note', versionId: row.id, note: `读取的 Note 版本证据等级 ${row.evidenceLevel}` });
      }
    }
  }
  const wikiVersionIds = artifact.readWikiVersionIds ?? [];
  if (wikiVersionIds.length) {
    const placeholders = wikiVersionIds.map(() => '?').join(',');
    const rows = database.prepare(
      `SELECT pv.id AS id, p.compile_status AS compileStatus
       FROM knowledge_wiki_page_versions pv JOIN knowledge_wiki_pages p ON p.id = pv.page_id
       WHERE pv.id IN (${placeholders})`
    ).all(...wikiVersionIds) as Array<{ id: string; compileStatus: string }>;
    for (const row of rows) {
      if (row.compileStatus === 'stale' || row.compileStatus === 'failed') {
        flags.push({ kind: 'stale', versionKind: 'wiki_page', versionId: row.id, note: `读取的 Wiki 版本状态为 ${row.compileStatus}` });
      }
    }
  }
  return flags;
}

/**
 * 每轮 Query 写回摘要（面板单次调用）；无 Artifact → { artifact: null, riskFlags: [], receipt: null }。
 * 返回 store 记录形态（IPC 边界序列化后由 preload 按 shared KnowledgeQueryWritebackSummaryRecord 消费）。
 */
export function getQueryWritebackSummary(
  database: DatabaseSync,
  requestId: string
): Readonly<{
  artifact: KnowledgeQueryArtifactRecord | null;
  riskFlags: readonly KnowledgeQueryRiskFlag[];
  receipt: KnowledgeUpdateReceiptRecord | null;
}> {
  const artifact = getQueryArtifactByRequest(database, requestId);
  if (!artifact) return Object.freeze({ artifact: null, riskFlags: Object.freeze([]), receipt: null });
  return Object.freeze({
    artifact,
    riskFlags: Object.freeze(resolveQueryWritebackRiskFlags(database, artifact)),
    receipt: artifact.receiptId ? getUpdateReceiptByRequest(database, artifact.workspaceId, requestId) : null
  });
}
