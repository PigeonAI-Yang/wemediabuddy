// WMB-5247：情报媒体权利/风险执行面（设计 §6.3、§11.8、§13）。
// - restricted 永不进入 AI 自动建议；用户强制采用前必须显式确认并写 operation evidence
//   （media_rights_overrides 表 + operation_log + command_receipts，同 request_id 可追溯）。
// - 枚举与类型以 shared/media-candidates.ts 为唯一权威，本模块只做门禁与证据。
import type { DatabaseSync } from 'node:sqlite';
import { getSourceMediaBindingById } from './db/media-archive-store.ts';
import { recordOperation } from './operations.ts';
import type { MediaRightsStatus, MediaRiskFlag } from '../shared/media-candidates.ts';

export {
  MEDIA_RIGHTS_STATUSES,
  MEDIA_RISK_FLAGS
} from '../shared/media-candidates.ts';
export type {
  MediaRightsStatus,
  MediaRiskFlag
} from '../shared/media-candidates.ts';

/** restricted 覆盖确认命令（owner UI IPC；不入任何 Agent grant）。 */
export const RESTRICTED_OVERRIDE_COMMAND = 'media.rights_override';

/**
 * 确定性权利分类（绑定创建时写入建议；AI 永远不能把 restricted 改成已授权——
 * 覆盖只能由 owner UI 显式确认并落证据）。
 * - third_party_repost / paywalled → restricted（禁止自动建议）
 * - 其余风险（copyright/portrait/privacy/brand）→ permission_required
 * - 无风险 → unknown（≠ 可自由使用，仅表示未评估）
 */
export function classifyRightsStatus(riskFlags: readonly string[]): MediaRightsStatus {
  const flags = new Set(riskFlags);
  if (flags.has('third_party_repost') || flags.has('paywalled')) return 'restricted';
  if (flags.size > 0) return 'permission_required';
  return 'unknown';
}

/** 自动建议门：restricted 一律禁止；其余（含 unknown）允许但由用户决定。 */
export function canAutoSuggestMedia(rightsStatus: MediaRightsStatus): boolean {
  return rightsStatus !== 'restricted';
}

export type AcceptGateResult =
  | { allowed: true }
  | { allowed: false; code: 'BINDING_NOT_FOUND' | 'RIGHTS_RESTRICTED'; message: string };

/**
 * 采用门（用户接受建议后写 Binding 前调用）：restricted 必须 confirmedByOwner=true
 * 且已存在覆盖证据；否则 blocked（fail-closed，不写任何 Binding）。
 */
export function canAcceptMediaBinding(
  database: DatabaseSync,
  bindingId: string,
  options: { confirmedByOwner?: boolean } = {}
): AcceptGateResult {
  const binding = getSourceMediaBindingById(database, bindingId);
  if (!binding) return { allowed: false, code: 'BINDING_NOT_FOUND', message: `媒体绑定不存在: ${bindingId}` };
  if (binding.rightsStatus !== 'restricted') return { allowed: true };
  if (options.confirmedByOwner !== true) {
    return { allowed: false, code: 'RIGHTS_RESTRICTED', message: '该素材受版权/转载限制（restricted），不能直接采用；需所有者显式确认（media.rights_override）。' };
  }
  if (!hasRestrictedOverride(database, bindingId)) {
    return { allowed: false, code: 'RIGHTS_RESTRICTED', message: '该素材为 restricted 但缺少所有者确认证据；请先执行 media.rights_override。' };
  }
  return { allowed: true };
}

export type RestrictedOverrideRecord = Readonly<{
  id: string;
  bindingId: string;
  assetId: string;
  sourceRevisionKey: string;
  confirmedBy: string;
  confirmedAt: string;
  reason: string;
  requestId: string;
  createdAt: string;
}>;

const OVERRIDE_COLUMNS = `id, binding_id AS bindingId, asset_id AS assetId, source_revision_key AS sourceRevisionKey,
  confirmed_by AS confirmedBy, confirmed_at AS confirmedAt, reason, request_id AS requestId, created_at AS createdAt`;

function mapOverrideRow(row: Record<string, unknown>): RestrictedOverrideRecord {
  return Object.freeze({
    id: String(row.id),
    bindingId: String(row.bindingId),
    assetId: String(row.assetId),
    sourceRevisionKey: String(row.sourceRevisionKey),
    confirmedBy: String(row.confirmedBy),
    confirmedAt: String(row.confirmedAt),
    reason: String(row.reason),
    requestId: String(row.requestId),
    createdAt: String(row.createdAt)
  });
}

function getOverrideById(database: DatabaseSync, id: string): RestrictedOverrideRecord | null {
  const row = database.prepare(`SELECT ${OVERRIDE_COLUMNS} FROM media_rights_overrides WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapOverrideRow(row) : null;
}

/**
 * 记录 restricted 显式所有者确认证据（幂等：同 binding 已确认则返回既有行，不重复写）。
 * 仅 restricted 绑定可确认；reason 必填；同事务经 operation_log 审计（entity=binding）。
 */
export function recordRestrictedOverride(
  database: DatabaseSync,
  input: { bindingId: string; reason: string; confirmedBy: string; requestId: string; confirmedAt?: string }
): RestrictedOverrideRecord {
  const binding = getSourceMediaBindingById(database, input.bindingId);
  if (!binding) throw new Error('BINDING_NOT_FOUND');
  if (binding.rightsStatus !== 'restricted') throw new Error('NOT_RESTRICTED_BINDING');
  const reason = input.reason.trim();
  if (!reason) throw new Error('OVERRIDE_REASON_REQUIRED');
  if (!input.requestId.trim()) throw new Error('OVERRIDE_REQUEST_ID_REQUIRED');
  const existing = database.prepare('SELECT id FROM media_rights_overrides WHERE binding_id=?').get(input.bindingId) as { id: string } | undefined;
  if (existing) return getOverrideById(database, existing.id)!;
  const now = input.confirmedAt ?? new Date().toISOString();
  const id = `mro:${input.bindingId}`;
  database.prepare(`INSERT INTO media_rights_overrides (
    id, binding_id, asset_id, source_revision_key, confirmed_by, confirmed_at, reason, request_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.bindingId, binding.assetId, binding.sourceRevisionKey, input.confirmedBy, now, reason, input.requestId, now
  );
  recordOperation(database, {
    actorType: 'ui',
    clientLabel: input.confirmedBy,
    command: RESTRICTED_OVERRIDE_COMMAND,
    entityType: 'source_media_binding',
    entityId: input.bindingId,
    result: 'ok'
  });
  return getOverrideById(database, id)!;
}

export function hasRestrictedOverride(database: DatabaseSync, bindingId: string): boolean {
  return database.prepare('SELECT 1 FROM media_rights_overrides WHERE binding_id=?').get(bindingId) !== undefined;
}

/** fail-closed 门：restricted 绑定在缺少所有者确认证据时抛错（采用路径调用）。 */
export function requireRestrictedOverride(database: DatabaseSync, bindingId: string): void {
  if (!hasRestrictedOverride(database, bindingId)) {
    throw Object.assign(new Error('该素材受版权/转载限制（restricted）且缺少所有者确认证据。'), { code: 'RIGHTS_RESTRICTED_OVERRIDE_REQUIRED' });
  }
}