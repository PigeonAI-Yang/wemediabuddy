// WMB-5207: Studio 正文批注存储服务 + 锚点算法（Data agent 所有）。
// 职责：验证区间、增量迁移（编辑器内）、外部正文保守重定位、revision 冲突、
// 文档范围隔离、保存路径事务内迁移。锚点函数为纯函数，可用固定文本独立验证。
// 批注绝不进入正文、Markdown、平台正文或发布载荷：本服务只读写 studio_annotations 表。

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import type {
  StudioAnnotation,
  StudioAnnotationResolveReason,
  StudioDocumentScope,
  StudioPlatform,
  StudioReconcileMode
} from '../shared/studio-annotations.ts';

/** 创建时每侧捕获的邻近上下文长度（code units）。 */
const CONTEXT_LENGTH = 40;
/** 保守重定位中允许偏离期望位置的最大位移（无精确锚时）。 */
const REPLACEMENT_DEVIATION_BOUND = 48;

const RESOLVED_REASONS: readonly StudioAnnotationResolveReason[] = ['edited', 'deleted', 'ambiguous', 'user_removed'];
const PLATFORMS: readonly StudioPlatform[] = ['x', 'xiaohongshu', 'wechat'];

// ---------------------------------------------------------------------------
// 纯锚点算法（可用固定文本独立验证）
// ---------------------------------------------------------------------------

export type BodyEdit = { start: number; endPrevious: number; endNext: number; delta: number };

/**
 * 以最长公共前后缀确定 previousBody → nextBody 的唯一变更区间。
 * 偏移全部为 UTF-16 code-unit（与 JS string / textarea / DOM Range 一致）。
 * 正文未变时返回 null。
 */
export function findSingleEdit(previousBody: string, nextBody: string): BodyEdit | null {
  if (previousBody === nextBody) return null;
  const limit = Math.min(previousBody.length, nextBody.length);
  let start = 0;
  while (start < limit && previousBody.charCodeAt(start) === nextBody.charCodeAt(start)) start += 1;
  let suffix = 0;
  const maxSuffix = Math.min(previousBody.length - start, nextBody.length - start);
  while (suffix < maxSuffix && previousBody.charCodeAt(previousBody.length - 1 - suffix) === nextBody.charCodeAt(nextBody.length - 1 - suffix)) suffix += 1;
  return {
    start,
    endPrevious: previousBody.length - suffix,
    endNext: nextBody.length - suffix,
    delta: nextBody.length - previousBody.length
  };
}

export type IncrementalOutcome =
  | { kind: 'moved'; startOffset: number; endOffset: number }
  | { kind: 'resolve' };

/**
 * 增量迁移：编辑严格完全在标记之前 → 按净变化量平移；
 * 严格完全在标记之后 → 位置不变；编辑与标记内部或边界相交 → resolve（原因 edited）。
 * 平移后校验 nextBody 切片与 quotedText 一致，否则保守 resolve。
 */
export function incrementalMove(
  annotation: Pick<StudioAnnotation, 'startOffset' | 'endOffset' | 'quotedText'>,
  edit: BodyEdit,
  nextBody: string
): IncrementalOutcome {
  if (edit.endPrevious <= annotation.startOffset && edit.start < annotation.startOffset) {
    const startOffset = annotation.startOffset + edit.delta;
    const endOffset = annotation.endOffset + edit.delta;
    if (startOffset >= 0 && endOffset <= nextBody.length && nextBody.slice(startOffset, endOffset) === annotation.quotedText) {
      return { kind: 'moved', startOffset, endOffset };
    }
    return { kind: 'resolve' };
  }
  if (edit.start > annotation.endOffset) {
    return { kind: 'moved', startOffset: annotation.startOffset, endOffset: annotation.endOffset };
  }
  return { kind: 'resolve' };
}

export type ReplacementOutcome =
  | { kind: 'moved'; startOffset: number; endOffset: number }
  | 'deleted'
  | 'ambiguous';

/**
 * 保守重定位：查找 quotedText 全部精确匹配，用 prefix/suffix 上下文与
 * 期望位置偏差筛选；恰有一个候选满足锚点约束时迁移，否则 deleted/ambiguous。
 * previousBody 为 null 表示没有历史基线（首次保存 / 重新打开），仅按上下文锚定。
 */
export function replacementMove(
  annotation: Pick<StudioAnnotation, 'startOffset' | 'endOffset' | 'quotedText' | 'prefixContext' | 'suffixContext'>,
  previousBody: string | null,
  nextBody: string
): ReplacementOutcome {
  const candidates = exactMatchOffsets(nextBody, annotation.quotedText);
  if (candidates.length === 0) return 'deleted';
  let expectedStart: number | null = null;
  if (previousBody !== null) {
    const edit = findSingleEdit(previousBody, nextBody);
    if (edit && edit.endPrevious <= annotation.startOffset) expectedStart = annotation.startOffset + edit.delta;
    else if (edit && edit.start >= annotation.endOffset) expectedStart = annotation.startOffset;
    // 编辑与批注相交时没有可靠位置锚点，仅靠上下文筛选（宁可 ambiguous 也不挂错句子）。
  }
  const deviationBound = Math.max(annotation.prefixContext.length + annotation.suffixContext.length, REPLACEMENT_DEVIATION_BOUND);
  const anchored = candidates.filter((offset) => {
    const preMatch = commonSuffixLength(
      annotation.prefixContext,
      nextBody.slice(Math.max(0, offset - annotation.prefixContext.length), offset)
    );
    const postMatch = commonPrefixLength(
      annotation.suffixContext,
      nextBody.slice(offset + annotation.quotedText.length, offset + annotation.quotedText.length + annotation.suffixContext.length)
    );
    if (preMatch < Math.min(annotation.prefixContext.length, 3)) return false;
    if (postMatch < Math.min(annotation.suffixContext.length, 3)) return false;
    if (expectedStart !== null && Math.abs(offset - expectedStart) > deviationBound) return false;
    return true;
  });
  if (anchored.length === 1) return { kind: 'moved', startOffset: anchored[0], endOffset: anchored[0] + annotation.quotedText.length };
  return 'ambiguous';
}

/** 创建时从正文区间派生前后文与指纹。 */
export function captureContext(body: string, startOffset: number, endOffset: number): { prefixContext: string; suffixContext: string } {
  return {
    prefixContext: body.slice(Math.max(0, startOffset - CONTEXT_LENGTH), startOffset),
    suffixContext: body.slice(endOffset, Math.min(body.length, endOffset + CONTEXT_LENGTH))
  };
}

export function bodyFingerprintOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function exactMatchOffsets(body: string, quoted: string): number[] {
  if (quoted.length === 0) return [];
  const offsets: number[] = [];
  let index = 0;
  while (true) {
    const at = body.indexOf(quoted, index);
    if (at === -1) break;
    offsets.push(at);
    index = at + 1;
  }
  return offsets;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
  return i;
}

// ---------------------------------------------------------------------------
// 存储服务
// ---------------------------------------------------------------------------

type AnnotationRow = {
  id: string;
  project_id: string;
  document_kind: StudioDocumentScope['documentKind'];
  document_id: string | null;
  platform: StudioPlatform | null;
  start_offset: number;
  end_offset: number;
  quoted_text: string;
  prefix_context: string;
  suffix_context: string;
  body_fingerprint: string;
  note: string | null;
  status: StudioAnnotation['status'];
  resolved_reason: StudioAnnotationResolveReason | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  revision: number;
};

function rowToAnnotation(row: AnnotationRow): StudioAnnotation {
  return {
    id: row.id,
    projectId: row.project_id,
    documentKind: row.document_kind,
    documentId: row.document_id,
    platform: row.platform,
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    quotedText: row.quoted_text,
    prefixContext: row.prefix_context,
    suffixContext: row.suffix_context,
    bodyFingerprint: row.body_fingerprint,
    note: row.note,
    status: row.status,
    resolvedReason: row.resolved_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    revision: Number(row.revision)
  };
}

function getAnnotation(database: DatabaseSync, id: string): StudioAnnotation | null {
  const row = database.prepare('SELECT * FROM studio_annotations WHERE id = ?').get(id) as AnnotationRow | undefined;
  return row ? rowToAnnotation(row) : null;
}

type ScopeValidation = { scope: StudioDocumentScope } | { error: CommandResult<never> };

function validateScope(database: DatabaseSync, raw: unknown): ScopeValidation {
  const input = (raw ?? {}) as Record<string, unknown>;
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  if (!projectId) return { error: failure('VALIDATION_ERROR', '批注必须属于一个内容项目。') };
  const documentKind = input.documentKind;
  if (documentKind !== 'core' && documentKind !== 'platform') {
    return { error: failure('VALIDATION_ERROR', 'documentKind 必须是 core 或 platform。') };
  }
  const platform = input.platform === null || input.platform === undefined ? null : input.platform;
  const documentId = input.documentId === null || input.documentId === undefined ? null : (typeof input.documentId === 'string' ? input.documentId : null);
  if (documentKind === 'core') {
    if (platform !== null) return { error: failure('VALIDATION_ERROR', 'core 文档不允许绑定平台。') };
    if (documentId !== null && !database.prepare('SELECT id FROM content_versions WHERE id = ? AND project_id = ?').get(documentId, projectId)) {
      return { error: failure('VALIDATION_ERROR', '核心版本锚点不存在或不属于该项目。') };
    }
  } else {
    if (!PLATFORMS.includes(platform as StudioPlatform) || !documentId) {
      return { error: failure('VALIDATION_ERROR', 'platform 文档必须提供平台与平台版本 ID。') };
    }
    const version = database.prepare('SELECT id, platform FROM platform_versions WHERE id = ? AND project_id = ?')
      .get(documentId, projectId) as { id: string; platform: string } | undefined;
    if (!version) return { error: failure('VALIDATION_ERROR', '平台版本不存在或不属于该项目。') };
    if (version.platform !== platform) return { error: failure('VALIDATION_ERROR', '批注平台与平台版本平台不一致。') };
  }
  return { scope: { projectId, documentKind, documentId, platform: platform as StudioPlatform | null } };
}

function normalizeNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}

function listScopeAnnotations(database: DatabaseSync, scope: StudioDocumentScope, includeResolved = false): StudioAnnotation[] {
  const rows = database.prepare(`SELECT * FROM studio_annotations
    WHERE project_id = ? AND document_kind = ? AND document_id IS ?
      ${includeResolved ? '' : "AND status = 'open'"}
    ORDER BY start_offset ASC, created_at ASC`).all(scope.projectId, scope.documentKind, scope.documentId) as AnnotationRow[];
  return rows.map(rowToAnnotation);
}

function hasOpenOverlap(database: DatabaseSync, scope: StudioDocumentScope, startOffset: number, endOffset: number, excludeId?: string): boolean {
  const rows = database.prepare(`SELECT id FROM studio_annotations
    WHERE project_id = ? AND document_kind = ? AND document_id IS ? AND status = 'open'
      ${excludeId ? 'AND id <> ?' : ''} AND start_offset < ? AND end_offset > ?`)
    .all(scope.projectId, scope.documentKind, scope.documentId, ...(excludeId ? [excludeId] : []), endOffset, startOffset);
  return rows.length > 0;
}

export function listStudioAnnotations(
  database: DatabaseSync,
  input: StudioDocumentScope & { includeResolved?: boolean }
): StudioAnnotation[] {
  const scopeResult = validateScope(database, input);
  if ('error' in scopeResult) return [];
  return listScopeAnnotations(database, scopeResult.scope, input.includeResolved === true);
}

export function createStudioAnnotation(
  database: DatabaseSync,
  input: StudioDocumentScope & { body: string; startOffset: number; endOffset: number; note?: string | null }
): CommandResult<StudioAnnotation> {
  const scopeResult = validateScope(database, input);
  if ('error' in scopeResult) return scopeResult.error;
  const scope = scopeResult.scope;
  const body = typeof input.body === 'string' ? input.body : null;
  if (body === null || body.trim() === '') return failure('VALIDATION_ERROR', '当前正文为空，无法创建批注。');
  const startOffset = input.startOffset;
  const endOffset = input.endOffset;
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return failure('VALIDATION_ERROR', '批注区间必须是整数偏移。');
  if (startOffset < 0 || endOffset > body.length || startOffset >= endOffset) return failure('VALIDATION_ERROR', '批注区间超出正文边界。');
  const quotedText = body.slice(startOffset, endOffset);
  if (quotedText.trim() === '') return failure('VALIDATION_ERROR', '不能标记纯空白文字。');
  if (hasOpenOverlap(database, scope, startOffset, endOffset)) {
    return failure('VALIDATION_ERROR', '所选文字已有问题标记，请先编辑或移除原标记。');
  }
  const { prefixContext, suffixContext } = captureContext(body, startOffset, endOffset);
  const note = normalizeNote(input.note);
  const now = new Date().toISOString();
  const id = randomUUID();
  database.prepare(`INSERT INTO studio_annotations (
    id, project_id, document_kind, document_id, platform, start_offset, end_offset, quoted_text,
    prefix_context, suffix_context, body_fingerprint, note, status, resolved_reason, created_at, updated_at, resolved_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL, 1)`).run(
    id, scope.projectId, scope.documentKind, scope.documentId, scope.platform, startOffset, endOffset, quotedText,
    prefixContext, suffixContext, bodyFingerprintOf(body), note, now, now
  );
  return success(getAnnotation(database, id)!);
}

export function updateStudioAnnotation(
  database: DatabaseSync,
  input: { id: string; expectedRevision: number; note: string | null }
): CommandResult<StudioAnnotation> {
  const current = getAnnotation(database, input.id);
  if (!current) return failure('NOT_FOUND', '批注不存在。');
  if (current.revision !== input.expectedRevision) {
    return failure('REVISION_CONFLICT', '批注已在其他位置更新，请重新加载。', { current });
  }
  const note = normalizeNote(input.note);
  const now = new Date().toISOString();
  database.prepare('UPDATE studio_annotations SET note = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
    .run(note, now, input.id);
  return success(getAnnotation(database, input.id)!);
}

export function resolveStudioAnnotation(
  database: DatabaseSync,
  input: { id: string; expectedRevision: number; reason: StudioAnnotationResolveReason }
): CommandResult<StudioAnnotation> {
  const current = getAnnotation(database, input.id);
  if (!current) return failure('NOT_FOUND', '批注不存在。');
  if (current.revision !== input.expectedRevision) {
    return failure('REVISION_CONFLICT', '批注已在其他位置更新，请重新加载。', { current });
  }
  if (!RESOLVED_REASONS.includes(input.reason)) return failure('VALIDATION_ERROR', '无效的解决原因。');
  if (current.status === 'resolved') return success(current); // 幂等：重复移除不报错
  const now = new Date().toISOString();
  database.prepare(`UPDATE studio_annotations SET status = 'resolved', resolved_reason = ?, resolved_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(input.reason, now, now, input.id);
  return success(getAnnotation(database, input.id)!);
}

export function reopenStudioAnnotation(
  database: DatabaseSync,
  input: { id: string; expectedRevision: number; body: string }
): CommandResult<StudioAnnotation> {
  const current = getAnnotation(database, input.id);
  if (!current) return failure('NOT_FOUND', '批注不存在。');
  if (current.revision !== input.expectedRevision) {
    return failure('REVISION_CONFLICT', '批注已在其他位置更新，请重新加载。', { current });
  }
  if (typeof input.body !== 'string' || input.body.trim() === '') return failure('VALIDATION_ERROR', '当前正文为空，无法重新定位批注。');
  if (current.status === 'open') return success(current); // 幂等
  const moved = replacementMove(current, null, input.body);
  if (moved === 'deleted' || moved === 'ambiguous') {
    return failure('VALIDATION_ERROR', '无法在当前正文中唯一定位被标记文字，请重新选择文字创建标记。');
  }
  if (hasOpenOverlap(database, current, moved.startOffset, moved.endOffset, current.id)) {
    return failure('VALIDATION_ERROR', '重新打开后与现有未解决标记重叠，请重新选择文字创建标记。');
  }
  const { prefixContext, suffixContext } = captureContext(input.body, moved.startOffset, moved.endOffset);
  const now = new Date().toISOString();
  database.prepare(`UPDATE studio_annotations SET status = 'open', resolved_reason = NULL, resolved_at = NULL,
    start_offset = ?, end_offset = ?, prefix_context = ?, suffix_context = ?, body_fingerprint = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(moved.startOffset, moved.endOffset, prefixContext, suffixContext, bodyFingerprintOf(input.body), now, current.id);
  return success(getAnnotation(database, current.id)!);
}

export function reconcileStudioAnnotations(
  database: DatabaseSync,
  input: StudioDocumentScope & { previousBody: string; nextBody: string; mode: StudioReconcileMode }
): CommandResult<StudioAnnotation[]> {
  const scopeResult = validateScope(database, input);
  if ('error' in scopeResult) return scopeResult.error;
  const scope = scopeResult.scope;
  if (input.mode !== 'incremental' && input.mode !== 'replacement') {
    return failure('VALIDATION_ERROR', '迁移模式必须是 incremental 或 replacement。');
  }
  if (typeof input.previousBody !== 'string' || typeof input.nextBody !== 'string') {
    return failure('VALIDATION_ERROR', '迁移需要前后两版正文。');
  }
  const now = new Date().toISOString();
  for (const annotation of listScopeAnnotations(database, scope)) {
    if (input.mode === 'incremental') {
      const edit = findSingleEdit(input.previousBody, input.nextBody);
      if (!edit) continue;
      const moved = incrementalMove(annotation, edit, input.nextBody);
      if (moved.kind === 'moved') applyMovedAnnotation(database, annotation, moved.startOffset, moved.endOffset, input.nextBody, now);
      else applyResolvedAnnotation(database, annotation.id, 'edited', now);
    } else {
      const moved = replacementMove(annotation, input.previousBody, input.nextBody);
      if (moved === 'deleted' || moved === 'ambiguous') applyResolvedAnnotation(database, annotation.id, moved, now);
      else applyMovedAnnotation(database, annotation, moved.startOffset, moved.endOffset, input.nextBody, now);
    }
  }
  return success(listScopeAnnotations(database, scope, true));
}

function applyResolvedAnnotation(database: DatabaseSync, id: string, reason: StudioAnnotationResolveReason, now: string): void {
  database.prepare(`UPDATE studio_annotations SET status = 'resolved', resolved_reason = ?, resolved_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(reason, now, now, id);
}

function applyMovedAnnotation(database: DatabaseSync, annotation: StudioAnnotation, startOffset: number, endOffset: number, nextBody: string, now: string): void {
  const { prefixContext, suffixContext } = captureContext(nextBody, startOffset, endOffset);
  database.prepare(`UPDATE studio_annotations SET start_offset = ?, end_offset = ?, prefix_context = ?, suffix_context = ?,
    body_fingerprint = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(startOffset, endOffset, prefixContext, suffixContext, bodyFingerprintOf(nextBody), now, annotation.id);
}

// ---------------------------------------------------------------------------
// 保存路径迁移（与正文保存同一事务，由调用方提供事务；异常整体回滚）
// ---------------------------------------------------------------------------

/**
 * 核心正文保存时：全部 core 批注（含已解决）的文档锚点跟随最新核心版本，
 * 然后对 open 批注执行保守重定位。previousBody 为 null 表示首次保存（无历史版本），
 * 仅按 nextBody 上下文验证原位置。
 */
export function migrateAnnotationsForCoreSave(
  database: DatabaseSync,
  input: { projectId: string; previousBody: string | null; nextBody: string; newVersionId: string }
): void {
  database.prepare(`UPDATE studio_annotations SET document_id = ? WHERE project_id = ? AND document_kind = 'core'`)
    .run(input.newVersionId, input.projectId);
  const scope: StudioDocumentScope = { projectId: input.projectId, documentKind: 'core', documentId: input.newVersionId, platform: null };
  reconcileOpenAnnotations(database, scope, input.previousBody, input.nextBody);
}

/** 平台正文更新时：同步平台列并对 open 批注执行保守重定位（平台版本 ID 不变）。 */
export function migrateAnnotationsForPlatformSave(
  database: DatabaseSync,
  input: { scope: StudioDocumentScope; previousBody: string; nextBody: string }
): void {
  database.prepare(`UPDATE studio_annotations SET platform = ? WHERE project_id = ? AND document_kind = 'platform' AND document_id = ?`)
    .run(input.scope.platform, input.scope.projectId, input.scope.documentId);
  reconcileOpenAnnotations(database, input.scope, input.previousBody, input.nextBody);
}

function reconcileOpenAnnotations(database: DatabaseSync, scope: StudioDocumentScope, previousBody: string | null, nextBody: string): void {
  const now = new Date().toISOString();
  const nextFingerprint = bodyFingerprintOf(nextBody);
  for (const annotation of listScopeAnnotations(database, scope)) {
    // UI 已逐次 incremental reconcile 持久化：fingerprint 与 nextBody 一致且区间切片仍等于原文时，
    // 批注已处于最终态，跳过二次 replacement 迁移（避免保存双重迁移）；core 的 documentId 锚点由调用方先行更新。
    if (annotation.bodyFingerprint === nextFingerprint && nextBody.slice(annotation.startOffset, annotation.endOffset) === annotation.quotedText) continue;
    const moved = replacementMove(annotation, previousBody, nextBody);
    if (moved === 'deleted' || moved === 'ambiguous') applyResolvedAnnotation(database, annotation.id, moved, now);
    else applyMovedAnnotation(database, annotation, moved.startOffset, moved.endOffset, nextBody, now);
  }
}
