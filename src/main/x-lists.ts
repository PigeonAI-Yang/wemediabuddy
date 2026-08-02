import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { broadcastDataChanged } from './data-changed.ts';
import { createSourceFeed } from './sources.ts';
import { failure, success, type CommandResult } from './result.ts';
import { xListUrl } from './platforms/x-list-primitives.ts';

export const xListOperationKinds = ['create', 'update', 'delete', 'members_add', 'members_remove'] as const;
export type XListOperationKind = typeof xListOperationKinds[number];
export type XListOperationState = 'prepared' | 'awaiting_confirmation' | 'running' | 'succeeded' | 'partial' | 'needs_user' | 'unknown' | 'failed';
export type XListBindingKind = 'owned' | 'following' | 'member';
type XListOperationItemState = 'pending' | 'already_present' | 'already_absent' | 'succeeded' | 'needs_user' | 'unknown' | 'failed' | 'skipped';

export type XListOperationPayload =
  | { name: string; description?: string; isPrivate: boolean }
  | { name?: string; description?: string; isPrivate?: boolean }
  | Record<string, never>
  | { handles: string[]; desiredState: 'present' | 'absent' };

export type XListSnapshot = {
  accountKey: string;
  index?: { evidenceFingerprint: string };
  list?: {
    listId: string; canonicalUrl: string; ownerHandle: string | null; name: string; description: string;
    isPrivate: boolean; memberCount: number | null; kind: XListBindingKind | 'unknown'; evidenceFingerprint: string;
  };
  members?: Array<{ handle: string; present: boolean }>;
};

export type XListOperationItem = {
  id: string; sortOrder: number; handle: string; desiredState: 'present' | 'absent'; state: XListOperationItemState;
  evidence: Record<string, unknown>; updatedAt: string;
};

export type XListOperation = {
  id: string; requestId: string; inputHash: string; kind: XListOperationKind; accountKey: string; listId: string | null;
  canonicalUrl: string | null; ownerHandle: string | null; snapshot: XListSnapshot; payload: XListOperationPayload;
  state: XListOperationState; phase: string; stopRequested: boolean; confirmationFingerprint: string | null;
  confirmedAt: string | null; startedAt: string | null; finishedAt: string | null; evidence: Record<string, unknown>;
  errorCode: string | null; errorMessage: string | null; createdAt: string; updatedAt: string; revision: number;
  items: XListOperationItem[];
};

export type XListBinding = {
  id: string; accountKey: string; listId: string; canonicalUrl: string; ownerHandle: string; name: string;
  kind: XListBindingKind; sourceFeedId: string; enabled: boolean; lastObservedAt: string | null;
  lastObservation: Record<string, unknown>; createdAt: string; updatedAt: string; revision: number;
};

export type PrepareXListOperationInput = {
  requestId: string; accountKey: string; kind: XListOperationKind; listId?: string;
  name?: string; description?: string; isPrivate?: boolean; handles?: string[];
};

export function prepareXListOperation(database: DatabaseSync, input: PrepareXListOperationInput): CommandResult<{ operation: XListOperation; replayed: boolean }> {
  try {
    const normalized = normalizeOperationInput(input);
    const prior = database.prepare('SELECT id, input_hash AS inputHash FROM x_list_operations WHERE request_id = ?').get(normalized.requestId) as { id: string; inputHash: string } | undefined;
    if (prior) {
      if (prior.inputHash !== normalized.inputHash) return failure('VALIDATION_ERROR', '同一 request_id 不能对应不同的 List 操作。');
      return success({ operation: getXListOperation(database, prior.id)!, replayed: true });
    }
    const id = randomUUID(); const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`INSERT INTO x_list_operations
        (id, request_id, input_hash, kind, account_key, list_id, canonical_url, owner_handle, snapshot_json, payload_json,
         state, phase, stop_requested, confirmation_fingerprint, evidence_json, created_at, updated_at, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'prepared', 'prepared', 0, NULL, ?, ?, ?, 1)`)
        .run(id, normalized.requestId, normalized.inputHash, normalized.kind, normalized.accountKey, normalized.listId,
          normalized.canonicalUrl, JSON.stringify({ accountKey: normalized.accountKey }), JSON.stringify(normalized.payload),
          JSON.stringify({ requestedAt: now }), now, now);
      if ('handles' in normalized.payload) {
        const desiredState = normalized.payload.desiredState;
        for (const [sortOrder, handle] of normalized.payload.handles.entries()) {
          database.prepare(`INSERT INTO x_list_operation_items
            (id, operation_id, sort_order, handle, desired_state, state, evidence_json, updated_at)
            VALUES (?, ?, ?, ?, ?, 'pending', '{}', ?)`)
            .run(randomUUID(), id, sortOrder, handle, desiredState, now);
        }
      }
      database.exec('COMMIT');
      return success({ operation: getXListOperation(database, id)!, replayed: false });
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } catch (error) {
    return failure('VALIDATION_ERROR', error instanceof Error ? error.message : String(error));
  }
}

export function armXListOperation(database: DatabaseSync, input: { operationId: string; expectedRevision: number; snapshot: XListSnapshot }): CommandResult<XListOperation> {
  const operation = getXListOperation(database, input.operationId);
  if (!operation) return failure('NOT_FOUND', 'List 操作不存在。');
  if (operation.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', 'List 操作已变化，请重新加载。', { current: operation });
  if (operation.state !== 'prepared') return failure('INVALID_STATE', '只有 prepared 的 List 操作可以进入确认。');
  const invalid = validateSnapshotForOperation(operation, input.snapshot);
  if (invalid) return failure('BROWSER_NEEDS_USER', invalid);
  const now = new Date().toISOString();
  const fingerprint = xListSnapshotFingerprint(input.snapshot);
  database.prepare(`UPDATE x_list_operations SET list_id=?, canonical_url=?, owner_handle=?, snapshot_json=?, state='awaiting_confirmation',
    phase='awaiting_confirmation', confirmation_fingerprint=?, error_code=NULL, error_message=NULL, updated_at=?, revision=revision+1 WHERE id=?`)
    .run(input.snapshot.list?.listId ?? null, input.snapshot.list?.canonicalUrl ?? null, input.snapshot.list?.ownerHandle ?? null,
      JSON.stringify(input.snapshot), fingerprint, now, operation.id);
  return success(getXListOperation(database, operation.id)!);
}

export function beginXListOperation(database: DatabaseSync, input: { operationId: string; expectedRevision: number; currentSnapshot: XListSnapshot }): CommandResult<XListOperation> {
  const operation = getXListOperation(database, input.operationId);
  if (!operation) return failure('NOT_FOUND', 'List 操作不存在。');
  if (operation.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', 'List 操作已变化，请重新加载。', { current: operation });
  if (operation.state !== 'awaiting_confirmation') return failure('CONFIRMATION_REQUIRED', 'List 操作尚未等待 UI 最终确认。');
  if (operation.confirmationFingerprint !== xListSnapshotFingerprint(input.currentSnapshot)) {
    const now = new Date().toISOString();
    database.prepare(`UPDATE x_list_operations SET state='prepared', phase='confirmation_stale', confirmation_fingerprint=NULL,
      evidence_json=?, error_code='CONFIRMATION_STALE', error_message=?, updated_at=?, revision=revision+1 WHERE id=?`)
      .run(JSON.stringify({ ...operation.evidence, currentSnapshot: input.currentSnapshot }), '账号、List 或冻结变更集已变化，确认失效。', now, operation.id);
    return failure('CONFIRMATION_STALE', '账号、List 或冻结变更集已变化，确认失效。');
  }
  const now = new Date().toISOString();
  database.prepare(`UPDATE x_list_operations SET state='running', phase='running', confirmed_at=?, started_at=?, updated_at=?, revision=revision+1 WHERE id=?`)
    .run(now, now, now, operation.id);
  return success(getXListOperation(database, operation.id)!);
}

export function requestXListOperationStop(database: DatabaseSync, input: { operationId: string; expectedRevision: number }): CommandResult<XListOperation> {
  const operation = getXListOperation(database, input.operationId);
  if (!operation) return failure('NOT_FOUND', 'List 操作不存在。');
  if (operation.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', 'List 操作已变化，请重新加载。', { current: operation });
  if (operation.state !== 'running') return failure('INVALID_STATE', '只有运行中的批量操作可以停止。');
  const now = new Date().toISOString();
  database.prepare("UPDATE x_list_operations SET stop_requested=1, phase='stop_requested', updated_at=?, revision=revision+1 WHERE id=?").run(now, operation.id);
  return success(getXListOperation(database, operation.id)!);
}

export function isXListOperationStopRequested(database: DatabaseSync, operationId: string): boolean {
  const row = database.prepare('SELECT stop_requested AS stopRequested FROM x_list_operations WHERE id = ?').get(operationId) as { stopRequested: number } | undefined;
  return row?.stopRequested === 1;
}

export function recordXListOperationIntent(database: DatabaseSync, operationId: string, action: string, handle?: string): void {
  const operation = getXListOperation(database, operationId);
  if (!operation || operation.state !== 'running') return;
  const now = new Date().toISOString();
  database.prepare("UPDATE x_list_operations SET phase=?, evidence_json=?, updated_at=?, revision=revision+1 WHERE id=?")
    .run(`intent_recorded:${action}`, JSON.stringify({ ...operation.evidence, intent: { action, handle: handle ?? null, recordedAt: now } }), now, operationId);
}

export function finishXListOperation(database: DatabaseSync, operationId: string, input: {
  state: Extract<XListOperationState, 'succeeded' | 'partial' | 'needs_user' | 'unknown' | 'failed'>;
  phase: string; evidence?: Record<string, unknown>; errorCode?: string; errorMessage?: string;
}): XListOperation {
  const operation = getXListOperation(database, operationId);
  if (!operation) throw new Error('List 操作不存在。');
  const now = new Date().toISOString();
  database.prepare(`UPDATE x_list_operations SET state=?, phase=?, evidence_json=?, error_code=?, error_message=?, finished_at=?, updated_at=?, revision=revision+1 WHERE id=?`)
    .run(input.state, input.phase, JSON.stringify({ ...operation.evidence, ...(input.evidence ?? {}) }), input.errorCode ?? null,
      input.errorMessage ?? null, now, now, operationId);
  return getXListOperation(database, operationId)!;
}

export function updateXListOperationItem(database: DatabaseSync, input: { operationId: string; handle: string; state: XListOperationItemState; evidence?: Record<string, unknown> }): void {
  const now = new Date().toISOString();
  database.prepare(`UPDATE x_list_operation_items SET state=?, evidence_json=?, updated_at=? WHERE operation_id=? AND handle=?`)
    .run(input.state, JSON.stringify(input.evidence ?? {}), now, input.operationId, input.handle);
}

export function skipPendingXListOperationItems(database: DatabaseSync, operationId: string): void {
  database.prepare("UPDATE x_list_operation_items SET state='skipped', updated_at=? WHERE operation_id=? AND state='pending'")
    .run(new Date().toISOString(), operationId);
}

export function getXListOperation(database: DatabaseSync, id: string): XListOperation | null {
  const row = database.prepare(`${operationSelect} WHERE id = ?`).get(id) as OperationRow | undefined;
  return row ? parseOperation(database, row) : null;
}

export function listXListOperations(database: DatabaseSync, input: { accountKey?: string; limit?: number } = {}): XListOperation[] {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const rows = input.accountKey
    ? database.prepare(`${operationSelect} WHERE account_key = ? ORDER BY updated_at DESC, id DESC LIMIT ?`).all(input.accountKey, limit) as OperationRow[]
    : database.prepare(`${operationSelect} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(limit) as OperationRow[];
  return rows.map((row) => parseOperation(database, row));
}

export function bindXList(database: DatabaseSync, input: {
  accountKey: string; list: { listId: string; canonicalUrl: string; ownerHandle: string | null; name: string; kind: XListBindingKind | 'unknown' };
  observation?: Record<string, unknown>; expectedRevision?: number;
}): CommandResult<XListBinding> {
  const accountKey = normalizeHandle(input.accountKey, '账号');
  if (!input.list.ownerHandle || input.list.kind === 'unknown') return failure('BROWSER_NEEDS_USER', '当前 List 的创建者或归类未能可靠读回。');
  const listId = requireListId(input.list.listId); const canonicalUrl = xListUrl(listId); const ownerHandle = normalizeHandle(input.list.ownerHandle, '创建者');
  const name = input.list.name.trim();
  if (!name) return failure('VALIDATION_ERROR', 'List 名称不能为空。');
  const existing = database.prepare('SELECT id, revision AS revision, source_feed_id AS sourceFeedId FROM x_list_bindings WHERE account_key=? AND list_id=?')
    .get(accountKey, listId) as { id: string; revision: number; sourceFeedId: string } | undefined;
  if (existing && input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', 'List 绑定已变化，请重新加载。');
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    const sourceFeedId = existing?.sourceFeedId ?? createSourceFeed(database, { name: `X List · ${name}`, url: canonicalUrl }).id;
    database.prepare('UPDATE source_feeds SET name=?, url=?, updated_at=?, revision=revision+1 WHERE id=?').run(`X List · ${name}`, canonicalUrl, now, sourceFeedId);
    if (existing) {
      database.prepare(`UPDATE x_list_bindings SET canonical_url=?, owner_handle=?, name=?, list_kind=?, enabled=1, last_observed_at=?,
        last_observation_json=?, updated_at=?, revision=revision+1 WHERE id=?`)
        .run(canonicalUrl, ownerHandle, name, input.list.kind, now, JSON.stringify(input.observation ?? {}), now, existing.id);
    } else {
      database.prepare(`INSERT INTO x_list_bindings (id, account_key, list_id, canonical_url, owner_handle, name, list_kind, source_feed_id,
        enabled, last_observed_at, last_observation_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`)
        .run(randomUUID(), accountKey, listId, canonicalUrl, ownerHandle, name, input.list.kind, sourceFeedId, now, JSON.stringify(input.observation ?? {}), now, now);
    }
    database.exec('COMMIT');
    const binding = getXListBinding(database, accountKey, listId)!;
    broadcastDataChanged({ scopes: ['sources', 'today'], reason: 'intelligence.x-list.bind' });
    return success(binding);
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function setXListBindingEnabled(database: DatabaseSync, input: { accountKey: string; listId: string; expectedRevision: number; enabled: boolean }): CommandResult<XListBinding> {
  const binding = getXListBinding(database, input.accountKey, input.listId);
  if (!binding) return failure('NOT_FOUND', 'List 绑定不存在。');
  if (binding.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', 'List 绑定已变化，请重新加载。', { current: binding });
  database.prepare('UPDATE x_list_bindings SET enabled=?, updated_at=?, revision=revision+1 WHERE id=?').run(input.enabled ? 1 : 0, new Date().toISOString(), binding.id);
  const updated = getXListBinding(database, binding.accountKey, binding.listId)!;
  broadcastDataChanged({ scopes: ['sources', 'today'], reason: 'intelligence.x-list.enabled' });
  return success(updated);
}

export function updateXListBindingObservation(database: DatabaseSync, accountKey: string, listId: string, observation: Record<string, unknown>): XListBinding | null {
  const binding = getXListBinding(database, accountKey, listId);
  if (!binding) return null;
  const now = new Date().toISOString();
  database.prepare('UPDATE x_list_bindings SET last_observed_at=?, last_observation_json=?, updated_at=?, revision=revision+1 WHERE id=?')
    .run(now, JSON.stringify(observation), now, binding.id);
  return getXListBinding(database, accountKey, listId);
}

export function getXListBinding(database: DatabaseSync, accountKey: string, listId: string): XListBinding | null {
  const row = database.prepare(`${bindingSelect} WHERE account_key=? AND list_id=?`).get(accountKey, listId) as BindingRow | undefined;
  return row ? parseBinding(row) : null;
}

export function listXListBindings(database: DatabaseSync, accountKey?: string): XListBinding[] {
  const rows = accountKey
    ? database.prepare(`${bindingSelect} WHERE account_key=? ORDER BY updated_at DESC, id DESC`).all(accountKey) as BindingRow[]
    : database.prepare(`${bindingSelect} ORDER BY updated_at DESC, id DESC`).all() as BindingRow[];
  return rows.map(parseBinding);
}

export function xListSnapshotFingerprint(snapshot: XListSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    accountKey: snapshot.accountKey.toLowerCase(),
    list: snapshot.list && {
      listId: snapshot.list.listId,
      canonicalUrl: snapshot.list.canonicalUrl,
      ownerHandle: snapshot.list.ownerHandle?.toLowerCase() ?? null,
      name: snapshot.list.name,
      description: snapshot.list.description ?? '',
      isPrivate: snapshot.list.isPrivate === true,
      kind: snapshot.list.kind
      // memberCount is observational and can change between arm and confirm; identity is listId/url/name/owner.
    },
    members: snapshot.members?.map((member) => ({ handle: member.handle.toLowerCase(), present: member.present })) ?? []
  })).digest('hex');
}

function normalizeOperationInput(input: PrepareXListOperationInput): { requestId: string; inputHash: string; accountKey: string; kind: XListOperationKind; listId: string | null; canonicalUrl: string | null; payload: XListOperationPayload } {
  const requestId = input.requestId.trim(); if (!requestId) throw new Error('request_id 不能为空。');
  if (!xListOperationKinds.includes(input.kind)) throw new Error('不支持的 List 操作。');
  const accountKey = normalizeHandle(input.accountKey, '账号');
  const listId = input.kind === 'create' ? null : requireListId(input.listId ?? '');
  let payload: XListOperationPayload;
  if (input.kind === 'create') {
    const name = (input.name ?? '').trim(); if (!name) throw new Error('List 名称不能为空。');
    payload = { name, description: input.description, isPrivate: input.isPrivate === true };
  } else if (input.kind === 'update') {
    if (input.name === undefined && input.description === undefined && input.isPrivate === undefined) throw new Error('更新 List 至少需要一个变更字段。');
    const name = input.name === undefined ? undefined : input.name.trim();
    if (name !== undefined && !name) throw new Error('List 名称不能为空。');
    payload = { ...(name === undefined ? {} : { name }), ...(input.description === undefined ? {} : { description: input.description }), ...(input.isPrivate === undefined ? {} : { isPrivate: input.isPrivate }) };
  } else if (input.kind === 'members_add' || input.kind === 'members_remove') {
    const handles = normalizeHandles(input.handles ?? []); if (!handles.length) throw new Error('成员批处理至少需要一个精确 handle。');
    payload = { handles, desiredState: input.kind === 'members_add' ? 'present' : 'absent' };
  } else {
    payload = {};
  }
  const canonicalUrl = listId ? xListUrl(listId) : null;
  return { requestId, inputHash: createHash('sha256').update(JSON.stringify({ accountKey, kind: input.kind, listId, payload })).digest('hex'), accountKey, kind: input.kind, listId, canonicalUrl, payload };
}

function validateSnapshotForOperation(operation: XListOperation, snapshot: XListSnapshot): string | null {
  if (!sameHandle(operation.accountKey, snapshot.accountKey)) return '当前浏览器账号与 List 操作绑定账号不一致。';
  if (operation.kind === 'create') return snapshot.index?.evidenceFingerprint ? null : '创建 List 前必须读取当前账号的 List 页面。';
  if (!snapshot.list || snapshot.list.listId !== operation.listId || snapshot.list.canonicalUrl !== operation.canonicalUrl) return '当前 List 身份与操作目标不一致。';
  if (!snapshot.list.ownerHandle || !sameHandle(snapshot.list.ownerHandle, snapshot.accountKey) || snapshot.list.kind !== 'owned') return '只有当前账号拥有的 List 才能修改成员或设置。';
  if (operation.kind === 'members_add' || operation.kind === 'members_remove') {
    const handles = (operation.payload as { handles: string[] }).handles;
    if (!snapshot.members || snapshot.members.length !== handles.length || snapshot.members.some((member, index) => member.handle.toLowerCase() !== handles[index]!.toLowerCase())) return '成员快照与冻结的精确 handle 列表不一致。';
  }
  return null;
}

function normalizeHandles(handles: string[]): string[] {
  const seen = new Set<string>();
  return handles.map((handle) => normalizeHandle(handle, '成员')).filter((handle) => {
    const key = handle.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true;
  });
}

function normalizeHandle(value: string, label: string): string {
  const handle = value.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error(`${label}必须使用精确 X handle。`);
  return `@${handle}`;
}

function requireListId(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error('List ID 必须是数字。');
  return value;
}

function sameHandle(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }

type OperationRow = Omit<XListOperation, 'snapshot' | 'payload' | 'stopRequested' | 'evidence' | 'items'> & {
  snapshot: string; payload: string; stopRequested: number; evidence: string;
};
type BindingRow = Omit<XListBinding, 'lastObservation' | 'enabled'> & { lastObservation: string; enabled: number };

const operationSelect = `SELECT id, request_id AS requestId, input_hash AS inputHash, kind, account_key AS accountKey, list_id AS listId,
  canonical_url AS canonicalUrl, owner_handle AS ownerHandle, snapshot_json AS snapshot, payload_json AS payload, state, phase,
  stop_requested AS stopRequested, confirmation_fingerprint AS confirmationFingerprint, confirmed_at AS confirmedAt, started_at AS startedAt,
  finished_at AS finishedAt, evidence_json AS evidence, error_code AS errorCode, error_message AS errorMessage, created_at AS createdAt,
  updated_at AS updatedAt, revision FROM x_list_operations`;
const bindingSelect = `SELECT id, account_key AS accountKey, list_id AS listId, canonical_url AS canonicalUrl, owner_handle AS ownerHandle,
  name, list_kind AS kind, source_feed_id AS sourceFeedId, enabled, last_observed_at AS lastObservedAt,
  last_observation_json AS lastObservation, created_at AS createdAt, updated_at AS updatedAt, revision FROM x_list_bindings`;

function parseOperation(database: DatabaseSync, row: OperationRow): XListOperation {
  const items = database.prepare(`SELECT id, sort_order AS sortOrder, handle, desired_state AS desiredState, state, evidence_json AS evidence,
    updated_at AS updatedAt FROM x_list_operation_items WHERE operation_id=? ORDER BY sort_order`).all(row.id) as Array<Omit<XListOperationItem, 'evidence'> & { evidence: string }>;
  return { ...row, snapshot: JSON.parse(row.snapshot) as XListSnapshot, payload: JSON.parse(row.payload) as XListOperationPayload,
    stopRequested: row.stopRequested === 1, evidence: JSON.parse(row.evidence) as Record<string, unknown>,
    items: items.map((item) => ({ ...item, evidence: JSON.parse(item.evidence) as Record<string, unknown> })) };
}

function parseBinding(row: BindingRow): XListBinding {
  return { ...row, enabled: row.enabled === 1, lastObservation: JSON.parse(row.lastObservation) as Record<string, unknown> };
}
