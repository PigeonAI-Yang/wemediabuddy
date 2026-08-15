/**
 * WMB-5240：Pi 固定版本 Query 读面（本 worker：ImplementPiFixedVersionQuery）。
 *
 * 职责：把「基于这些版本回答」的固定版本引用解析为真实不可变版本行，只读返回
 * 冻结内容 + 规范化引用；全部校验 fail-closed，绝不猜测、绝不返回部分结果。
 * - 引用字符串 `type:objectId:versionRef`：
 *   - wiki_page:<pageId>:<versionId>       → knowledge_wiki_page_versions 版本行
 *   - knowledge_note:<noteId>:<versionId>  → knowledge_note_versions 版本行
 *   - evidence:<id>                        → knowledge_evidence_links 行（无版本表，objectId 即 id）
 * - 每类读取上限 64（与 query-writeback 写回上限同源；超限 fail-closed）；
 * - 版本行不存在（删除/跨 workspace 结构性隔离）→ FIXED_VERSION_NOT_FOUND；
 *   versionId 不属于 objectId（漂移）→ FIXED_VERSION_DRIFT；引用语法非法 → FIXED_VERSION_REF_INVALID；
 * - 只读：本模块无任何写路径；写回仍由既有 settle（wmb_query_writeback 围栏 + 机器校验）执行，
 *   本模块返回的 readWikiVersionIds / readNoteVersionIds / readEvidenceIds 可直接通过
 *   query-writeback 的 validateReadVersions 存在性校验（同一 DB、同一 ID 空间）。
 * - 错误消息只含 code + 可读 message + 缺失 id，不含 rootPath / SQL / 堆栈（T-EL-1）。
 */
import type { DatabaseSync } from 'node:sqlite';

// ============================================================
// 错误与固定矩阵
// ============================================================

export const FIXED_VERSION_QUERY_ERROR_CODES = Object.freeze([
  'FIXED_VERSION_QUERY_INPUT_INVALID',
  'FIXED_VERSION_REF_INVALID',
  'FIXED_VERSION_NOT_FOUND',
  'FIXED_VERSION_DRIFT',
  'FIXED_VERSION_LIMIT_EXCEEDED'
] as const);

/** 每类（wiki_page / knowledge_note / evidence）读取与写回上限（T-BR-2）。 */
export const MAX_FIXED_VERSION_QUERY_PER_KIND = 64;

export class FixedVersionQueryError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'FixedVersionQueryError';
    this.code = code;
    this.details = details;
  }
}

function queryError(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new FixedVersionQueryError(code, message, details);
}

// ============================================================
// 引用解析（语法门：段数/前缀/空白；存在性/归属/漂移在执行面校验）
// ============================================================

export type FixedVersionRefKind = 'wiki_page' | 'knowledge_note' | 'evidence';

export type FixedVersionRef = Readonly<{
  kind: FixedVersionRefKind;
  objectId: string;
  versionId: string;
}>;

const REF_PREFIXES: Readonly<Record<string, FixedVersionRefKind>> = Object.freeze({
  'wiki_page:': 'wiki_page',
  'knowledge_note:': 'knowledge_note',
  'evidence:': 'evidence'
});

/**
 * 严格解析固定版本引用字符串（fail-closed：语法不合法 → null，不猜测）。
 * - wiki_page:<pageId>:<versionId>（3 段）
 * - knowledge_note:<noteId>:<versionId>（3 段）
 * - evidence:<id>（2 段；无版本表，objectId 与 versionId 同值）
 */
export function parseFixedVersionRef(raw: unknown): FixedVersionRef | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  for (const [prefix, kind] of Object.entries(REF_PREFIXES)) {
    if (!value.startsWith(prefix)) continue;
    const rest = value.slice(prefix.length);
    if (kind === 'evidence') {
      const id = rest.trim();
      if (!id || /[:/\\]/.test(id)) return null;
      return Object.freeze({ kind, objectId: id, versionId: id });
    }
    const [objectId, versionId, extra] = rest.split(':');
    if (!objectId?.trim() || !versionId?.trim() || extra !== undefined) return null;
    if (objectId !== objectId.trim() || versionId !== versionId.trim()) return null;
    return Object.freeze({ kind, objectId, versionId });
  }
  return null;
}

/** 规范化引用字符串（同一输入 → 同一输出；幂等可重放）。 */
export function fixedVersionRefString(ref: FixedVersionRef): string {
  return ref.kind === 'evidence' ? `evidence:${ref.objectId}` : `${ref.kind}:${ref.objectId}:${ref.versionId}`;
}

// ============================================================
// 冻结内容读面（只读；按 id 批量读真实版本行）
// ============================================================

export type FixedWikiPageVersionEntry = Readonly<{
  versionId: string;
  pageId: string;
  pageType: string;
  title: string;
  versionNumber: number;
  compileStatus: string;
  adoptedNoteVersionIds: readonly string[];
  changeSummary: string;
}>;

export type FixedNoteVersionEntry = Readonly<{
  versionId: string;
  noteId: string;
  kind: string;
  title: string;
  statement: string;
  conclusionStatus: string;
  evidenceLevel: string;
  adoptedTopicIds: readonly string[];
  adoptedKnowledgeVersionIds: readonly string[];
}>;

export type FixedEvidenceEntry = Readonly<{
  id: string;
  noteVersionId: string;
  evidenceObjectType: string;
  evidenceObjectId: string;
  relation: string;
  sourceNature: string;
  excerpt: string | null;
  locator: string | null;
}>;

function parseIdArrayJson(value: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 按 id 批量读取冻结 Wiki 页版本（版本行不存在 → NOT_FOUND 列出缺失 id；零部分返回）。 */
function readWikiPageVersions(database: DatabaseSync, versionIds: readonly string[]): { entries: FixedWikiPageVersionEntry[]; missing: string[] } {
  if (!versionIds.length) return { entries: [], missing: [] };
  const rows = database.prepare(`
    SELECT pv.id AS versionId, pv.page_id AS pageId, p.page_type AS pageType, pv.title,
           pv.version_number AS versionNumber, p.compile_status AS compileStatus,
           pv.adopted_note_version_ids_json AS adoptedNoteVersionIds, pv.change_summary AS changeSummary
    FROM knowledge_wiki_page_versions pv
    JOIN knowledge_wiki_pages p ON p.id = pv.page_id
    WHERE pv.id IN (${versionIds.map(() => '?').join(',')})
  `).all(...versionIds) as Array<Record<string, unknown>>;
  const found = new Set(rows.map((row) => String(row.versionId)));
  return {
    entries: rows.map((row) => Object.freeze({
      versionId: String(row.versionId),
      pageId: String(row.pageId),
      pageType: String(row.pageType),
      title: String(row.title),
      versionNumber: Number(row.versionNumber),
      compileStatus: String(row.compileStatus),
      adoptedNoteVersionIds: Object.freeze(parseIdArrayJson(row.adoptedNoteVersionIds)),
      changeSummary: String(row.changeSummary)
    })),
    missing: versionIds.filter((id) => !found.has(id))
  };
}

/** 按 id 批量读取冻结 Note 版本（版本行不存在 → NOT_FOUND 列出缺失 id；零部分返回）。 */
function readNoteVersions(database: DatabaseSync, versionIds: readonly string[]): { entries: FixedNoteVersionEntry[]; missing: string[] } {
  if (!versionIds.length) return { entries: [], missing: [] };
  const rows = database.prepare(`
    SELECT nv.id AS versionId, nv.note_id AS noteId, n.kind AS kind, nv.title, nv.statement,
           nv.conclusion_status AS conclusionStatus, nv.evidence_level AS evidenceLevel,
           nv.adopted_topic_ids_json AS adoptedTopicIds, nv.adopted_knowledge_version_ids_json AS adoptedKnowledgeVersionIds
    FROM knowledge_note_versions nv
    JOIN knowledge_notes n ON n.id = nv.note_id
    WHERE nv.id IN (${versionIds.map(() => '?').join(',')})
  `).all(...versionIds) as Array<Record<string, unknown>>;
  const found = new Set(rows.map((row) => String(row.versionId)));
  return {
    entries: rows.map((row) => Object.freeze({
      versionId: String(row.versionId),
      noteId: String(row.noteId),
      kind: String(row.kind),
      title: String(row.title),
      statement: String(row.statement),
      conclusionStatus: String(row.conclusionStatus),
      evidenceLevel: String(row.evidenceLevel),
      adoptedTopicIds: Object.freeze(parseIdArrayJson(row.adoptedTopicIds)),
      adoptedKnowledgeVersionIds: Object.freeze(parseIdArrayJson(row.adoptedKnowledgeVersionIds))
    })),
    missing: versionIds.filter((id) => !found.has(id))
  };
}

/** 按 id 批量读取冻结 Evidence 行（行不存在 → NOT_FOUND 列出缺失 id；零部分返回）。 */
function readEvidence(database: DatabaseSync, ids: readonly string[]): { entries: FixedEvidenceEntry[]; missing: string[] } {
  if (!ids.length) return { entries: [], missing: [] };
  const rows = database.prepare(`
    SELECT id, knowledge_note_version_id AS noteVersionId, evidence_object_type AS evidenceObjectType,
           evidence_object_id AS evidenceObjectId, relation, source_nature AS sourceNature,
           excerpt, locator
    FROM knowledge_evidence_links
    WHERE id IN (${ids.map(() => '?').join(',')})
  `).all(...ids) as Array<Record<string, unknown>>;
  const found = new Set(rows.map((row) => String(row.id)));
  return {
    entries: rows.map((row) => Object.freeze({
      id: String(row.id),
      noteVersionId: String(row.noteVersionId),
      evidenceObjectType: String(row.evidenceObjectType),
      evidenceObjectId: String(row.evidenceObjectId),
      relation: String(row.relation),
      sourceNature: String(row.sourceNature),
      excerpt: row.excerpt === null || row.excerpt === undefined ? null : String(row.excerpt),
      locator: row.locator === null || row.locator === undefined ? null : String(row.locator)
    })),
    missing: ids.filter((id) => !found.has(id))
  };
}

// ============================================================
// 引用解析执行面（存在性 + 归属/漂移校验；fail-closed）
// ============================================================

function normalizeIdList(value: unknown, kind: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) queryError('FIXED_VERSION_QUERY_INPUT_INVALID', `${kind} 必须为字符串数组。`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) queryError('FIXED_VERSION_QUERY_INPUT_INVALID', `${kind} 含非法项。`);
    out.push(item.trim());
  }
  return [...new Set(out)];
}

/** 校验 ref 的 versionId 归属（wiki/note 版本行必须属于声明的 objectId；evidence 只查存在性）。 */
function resolveRef(database: DatabaseSync, ref: FixedVersionRef): void {
  if (ref.kind === 'evidence') {
    if (!database.prepare('SELECT 1 FROM knowledge_evidence_links WHERE id = ?').get(ref.versionId)) {
      queryError('FIXED_VERSION_NOT_FOUND', `证据 ${ref.versionId} 不存在（冻结失败）。`, { kind: 'evidence', versionId: ref.versionId });
    }
    return;
  }
  const table = ref.kind === 'wiki_page' ? 'knowledge_wiki_page_versions' : 'knowledge_note_versions';
  const parentColumn = ref.kind === 'wiki_page' ? 'page_id' : 'note_id';
  const row = database.prepare(`SELECT ${parentColumn} AS parentId FROM ${table} WHERE id = ?`).get(ref.versionId) as { parentId?: string } | undefined;
  if (!row) {
    queryError('FIXED_VERSION_NOT_FOUND', `${ref.kind} 版本 ${ref.versionId} 不存在（冻结失败）。`, { kind: ref.kind, versionId: ref.versionId });
  }
  if (String(row.parentId) !== ref.objectId) {
    queryError('FIXED_VERSION_DRIFT', `${ref.kind} 版本 ${ref.versionId} 不属于声明的对象 ${ref.objectId}（引用漂移）。`, { kind: ref.kind, objectId: ref.objectId, versionId: ref.versionId });
  }
}

// ============================================================
// 入口：runFixedVersionQuery（NL「基于这些版本回答」读面；只读，零写）
// ============================================================

export type FixedVersionQueryInput = Readonly<{
  /** 用户问题（透传展示；不参与校验）。 */
  question?: string | null;
  /** 固定版本引用字符串（wiki_page:<pageId>:<versionId> 等）。 */
  wikiVersionRefs?: readonly string[];
  noteVersionRefs?: readonly string[];
  evidenceRefs?: readonly string[];
  /** 裸版本 id（同一 ID 空间；与 refs 合并去重）。 */
  wikiVersionIds?: readonly string[];
  noteVersionIds?: readonly string[];
  evidenceIds?: readonly string[];
}>;

export type FixedVersionQueryResult =
  | Readonly<{
      ok: true;
      workspaceId: string;
      question: string | null;
      readWikiVersionIds: readonly string[];
      readNoteVersionIds: readonly string[];
      readEvidenceIds: readonly string[];
      /** 规范化引用字符串（同一输入幂等；写回围栏使用裸 id 数组）。 */
      versionRefs: readonly string[];
      wikiPages: readonly FixedWikiPageVersionEntry[];
      noteVersions: readonly FixedNoteVersionEntry[];
      evidence: readonly FixedEvidenceEntry[];
    }>
  | Readonly<{ ok: false; error: Readonly<{ code: string; message: string; details?: Readonly<Record<string, unknown>> }> }>;

function boundWorkspaceIdOf(database: DatabaseSync): string {
  try {
    const row = database.prepare("SELECT value AS workspaceId FROM app_meta WHERE key='workspace_id'").get() as { workspaceId?: string } | undefined;
    return row?.workspaceId ?? '';
  } catch {
    return '';
  }
}

export type ResolvedFixedVersionRefs = Readonly<{
  ok: true;
  refs: readonly FixedVersionRef[];
  wikiVersionIds: readonly string[];
  noteVersionIds: readonly string[];
  evidenceIds: readonly string[];
}>;

/**
 * 只校验固定版本引用（语法 + 存在性 + 归属/漂移），零读取内容。
 * fail-closed：任一引用非法/不存在/漂移 → { ok:false, error }（可读原因，无 rootPath/SQL/堆栈）。
 * 供 wiki-action manifest 解析/执行面做「固定版本必填」后的引用校验（与 runFixedVersionQuery 同一执行面）。
 */
export function resolveFixedVersionRefs(database: DatabaseSync, rawRefs: unknown): ResolvedFixedVersionRefs | Readonly<{ ok: false; error: Readonly<{ code: string; message: string; details?: Readonly<Record<string, unknown>> }> }> {
  try {
    if (!Array.isArray(rawRefs)) {
      queryError('FIXED_VERSION_QUERY_INPUT_INVALID', 'versionRefs 必须为字符串数组。');
    }
    if (rawRefs.length > MAX_FIXED_VERSION_QUERY_PER_KIND * 3) {
      queryError('FIXED_VERSION_LIMIT_EXCEEDED', `版本引用超过上限（${MAX_FIXED_VERSION_QUERY_PER_KIND * 3}），零读。`);
    }
    const refs: FixedVersionRef[] = [];
    for (const item of rawRefs) {
      const parsed = parseFixedVersionRef(item);
      if (!parsed) queryError('FIXED_VERSION_REF_INVALID', `非法版本引用：${String(item)}。`, { ref: String(item) });
      resolveRef(database, parsed!);
      refs.push(parsed!);
    }
    return Object.freeze({
      ok: true,
      refs: Object.freeze(refs),
      wikiVersionIds: Object.freeze([...new Set(refs.filter((ref) => ref.kind === 'wiki_page').map((ref) => ref.versionId))]),
      noteVersionIds: Object.freeze([...new Set(refs.filter((ref) => ref.kind === 'knowledge_note').map((ref) => ref.versionId))]),
      evidenceIds: Object.freeze([...new Set(refs.filter((ref) => ref.kind === 'evidence').map((ref) => ref.versionId))])
    });
  } catch (error) {
    if (error instanceof FixedVersionQueryError) {
      return Object.freeze({
        ok: false,
        error: Object.freeze({
          code: error.code,
          message: error.message,
          ...(error.details ? { details: Object.freeze(error.details) } : {})
        })
      });
    }
    return Object.freeze({ ok: false, error: Object.freeze({ code: 'FIXED_VERSION_QUERY_FAILED', message: '固定版本引用校验失败（内部错误）。' }) });
  }
}

/**
 * 固定版本 Query 读面：解析引用（语法门）+ 校验存在性/归属（fail-closed）+
 * 只读返回冻结内容与规范化引用。全部失败返回 { ok:false, error }（不抛到 IPC/MCP 边界，
 * 错误消息只含 code + message + 缺失 id，无 rootPath/SQL/堆栈）。
 */
export function runFixedVersionQuery(database: DatabaseSync, rawInput: FixedVersionQueryInput): FixedVersionQueryResult {
  try {
    const wikiRefs = normalizeIdList(rawInput.wikiVersionRefs, 'wikiVersionRefs');
    const noteRefs = normalizeIdList(rawInput.noteVersionRefs, 'noteVersionRefs');
    const evidenceRefs = normalizeIdList(rawInput.evidenceRefs, 'evidenceRefs');
    const wikiIds = normalizeIdList(rawInput.wikiVersionIds, 'wikiVersionIds');
    const noteIds = normalizeIdList(rawInput.noteVersionIds, 'noteVersionIds');
    const evidenceIds = normalizeIdList(rawInput.evidenceIds, 'evidenceIds');
    if (wikiRefs.length + noteRefs.length + evidenceRefs.length + wikiIds.length + noteIds.length + evidenceIds.length === 0) {
      queryError('FIXED_VERSION_QUERY_INPUT_INVALID', '必须至少提供一个固定版本引用或版本 id（基于这些版本回答）。');
    }
    for (const kind of ['wiki_page', 'knowledge_note', 'evidence'] as const) {
      const count = kind === 'wiki_page' ? wikiRefs.length + wikiIds.length
        : kind === 'knowledge_note' ? noteRefs.length + noteIds.length
        : evidenceRefs.length + evidenceIds.length;
      if (count > MAX_FIXED_VERSION_QUERY_PER_KIND) {
        queryError('FIXED_VERSION_LIMIT_EXCEEDED', `${kind} 引用/版本 id 超过上限（每类最多 ${MAX_FIXED_VERSION_QUERY_PER_KIND} 个），零读。`, { kind, limit: MAX_FIXED_VERSION_QUERY_PER_KIND });
      }
    }
    // 语法门 + 归属/存在性校验（refs 与裸 ids 合并去重）
    const parsedWiki = wikiRefs.map((ref) => {
      const parsed = parseFixedVersionRef(ref);
      if (!parsed || parsed.kind !== 'wiki_page') queryError('FIXED_VERSION_REF_INVALID', `非法 Wiki 版本引用：${ref}。`, { ref });
      return parsed!;
    });
    const parsedNotes = noteRefs.map((ref) => {
      const parsed = parseFixedVersionRef(ref);
      if (!parsed || parsed.kind !== 'knowledge_note') queryError('FIXED_VERSION_REF_INVALID', `非法 Note 版本引用：${ref}。`, { ref });
      return parsed!;
    });
    const parsedEvidence = evidenceRefs.map((ref) => {
      const parsed = parseFixedVersionRef(ref);
      if (!parsed || parsed.kind !== 'evidence') queryError('FIXED_VERSION_REF_INVALID', `非法 Evidence 引用：${ref}。`, { ref });
      return parsed!;
    });
    for (const ref of [...parsedWiki, ...parsedNotes, ...parsedEvidence]) resolveRef(database, ref);

    const readWikiVersionIds = [...new Set([...wikiIds, ...parsedWiki.map((ref) => ref.versionId)])];
    const readNoteVersionIds = [...new Set([...noteIds, ...parsedNotes.map((ref) => ref.versionId)])];
    const readEvidenceIds = [...new Set([...evidenceIds, ...parsedEvidence.map((ref) => ref.versionId)])];
    for (const id of readWikiVersionIds) {
      if (!database.prepare('SELECT 1 FROM knowledge_wiki_page_versions WHERE id = ?').get(id)) {
        queryError('FIXED_VERSION_NOT_FOUND', `读取的 Wiki 版本 ${id} 不存在（冻结失败）。`, { kind: 'wiki_page', versionId: id });
      }
    }
    for (const id of readNoteVersionIds) {
      if (!database.prepare('SELECT 1 FROM knowledge_note_versions WHERE id = ?').get(id)) {
        queryError('FIXED_VERSION_NOT_FOUND', `读取的 Note 版本 ${id} 不存在（冻结失败）。`, { kind: 'knowledge_note', versionId: id });
      }
    }
    for (const id of readEvidenceIds) {
      if (!database.prepare('SELECT 1 FROM knowledge_evidence_links WHERE id = ?').get(id)) {
        queryError('FIXED_VERSION_NOT_FOUND', `读取的 Evidence ${id} 不存在（冻结失败）。`, { kind: 'evidence', versionId: id });
      }
    }

    const wikiRead = readWikiPageVersions(database, readWikiVersionIds);
    const noteRead = readNoteVersions(database, readNoteVersionIds);
    const evidenceRead = readEvidence(database, readEvidenceIds);
    const missing = [...wikiRead.missing, ...noteRead.missing, ...evidenceRead.missing];
    if (missing.length) {
      queryError('FIXED_VERSION_NOT_FOUND', `以下固定版本不存在（冻结失败）：${missing.join(', ')}。`, { missing });
    }

    const versionRefs = Object.freeze([
      ...wikiRead.entries.map((entry) => fixedVersionRefString({ kind: 'wiki_page', objectId: entry.pageId, versionId: entry.versionId })),
      ...noteRead.entries.map((entry) => fixedVersionRefString({ kind: 'knowledge_note', objectId: entry.noteId, versionId: entry.versionId })),
      ...evidenceRead.entries.map((entry) => fixedVersionRefString({ kind: 'evidence', objectId: entry.id, versionId: entry.id }))
    ]);

    return Object.freeze({
      ok: true,
      workspaceId: boundWorkspaceIdOf(database),
      question: typeof rawInput.question === 'string' && rawInput.question.trim() ? rawInput.question.trim() : null,
      readWikiVersionIds: Object.freeze(readWikiVersionIds),
      readNoteVersionIds: Object.freeze(readNoteVersionIds),
      readEvidenceIds: Object.freeze(readEvidenceIds),
      versionRefs,
      wikiPages: Object.freeze(wikiRead.entries),
      noteVersions: Object.freeze(noteRead.entries),
      evidence: Object.freeze(evidenceRead.entries)
    });
  } catch (error) {
    if (error instanceof FixedVersionQueryError) {
      return Object.freeze({
        ok: false,
        error: Object.freeze({
          code: error.code,
          message: error.message,
          ...(error.details ? { details: Object.freeze(error.details) } : {})
        })
      });
    }
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'FIXED_VERSION_QUERY_FAILED', message: '固定版本读取失败（内部错误）。' })
    });
  }
}
