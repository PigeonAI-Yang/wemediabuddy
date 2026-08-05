import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { getPublication, type PublicationRecord } from './publishing.ts';

export type PublicationBrowserOperationState =
  | 'prepared' | 'execution_granted' | 'browser_leased' | 'executing' | 'readback_pending'
  | 'succeeded' | 'needs_user' | 'unknown' | 'failed';

export type PublicationSnapshotAssetV1 = Readonly<{
  id: string;
  sha256: string;
  relativePath: string;
  mimeType: string;
}>;

export type PublicationSnapshotV1 = Readonly<{
  version: 'PublicationSnapshotV1';
  id: string;
  publicationId: string;
  workspaceId: string;
  runtimeEpoch: string;
  platformVersionId: string;
  platformVersionRevision: number;
  platform: PublicationRecord['platform'];
  accountId: string;
  accountKey: string;
  accountRevision: number;
  browserBindingId: 'effective';
  browserProfileId: string;
  browserBindingRevision: number;
  payload: Readonly<{ title: string | null; body: string; format: string }>;
  payloadHash: string;
  assets: readonly PublicationSnapshotAssetV1[];
  assetsHash: string;
  inputHash: string;
  causation: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export type PublicationBrowserOperationV1 = Readonly<{
  version: 'PublicationBrowserOperationV1';
  id: string;
  publicationId: string;
  snapshotId: string;
  state: PublicationBrowserOperationState;
  phase: string;
  executionGrantId: string | null;
  evidence: unknown;
  readback: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  revision: number;
}>;

type SnapshotPayloadInput = Readonly<{
  title: string | null;
  body: string;
  assets: readonly (string | Readonly<{ id: string; sha256?: string }>)[];
}>;

export type CreatePublicationSnapshotInput = Readonly<{
  platformVersionId: string;
  accountId: string;
  browserProfileId: string;
  browserBindingRevision: number;
  workspaceId: string;
  runtimeEpoch: string;
  payload: SnapshotPayloadInput;
  causation?: Readonly<Record<string, unknown>>;
}>;

export type TransitionPublicationBrowserOperationInput = Readonly<{
  operationId: string;
  expectedRevision: number;
  to: PublicationBrowserOperationState;
  phase: string;
  executionGrantId?: string;
  evidence?: unknown;
  readback?: unknown;
  errorCode?: string;
  errorMessage?: string;
}>;

const transitions: Readonly<Record<PublicationBrowserOperationState, readonly PublicationBrowserOperationState[]>> = {
  prepared: ['execution_granted', 'needs_user', 'failed'],
  execution_granted: ['browser_leased', 'needs_user'],
  browser_leased: ['executing', 'needs_user'],
  executing: ['readback_pending', 'needs_user', 'unknown'],
  readback_pending: ['needs_user', 'unknown'],
  succeeded: [], needs_user: [], unknown: [], failed: []
};
const RECOVERY_LIMIT = 100;

export function createPublicationSnapshot(
  database: DatabaseSync,
  input: CreatePublicationSnapshotInput
): CommandResult<{ publication: PublicationRecord; snapshot: PublicationSnapshotV1; operation: PublicationBrowserOperationV1 }> {
  const identityError = validateIdentityInput(input);
  if (identityError) return identityError;
  const workspace = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value: string } | undefined;
  if (!workspace || workspace.value !== input.workspaceId) return failure('WORKSPACE_ID_MISMATCH', '工作空间身份与发布快照不一致。');
  const version = database.prepare(`SELECT id, platform, format, title, body, asset_ids_json AS assetIds,
    revision FROM platform_versions WHERE id=?`).get(input.platformVersionId) as VersionRow | undefined;
  const account = database.prepare(`SELECT id, platform, account_key AS accountKey, login_state AS loginState, revision,
    browser_profile_id AS browserProfileId, browser_binding_revision AS browserBindingRevision
    FROM platform_accounts WHERE id=?`).get(input.accountId) as AccountRow | undefined;
  if (!version || !account) return failure('NOT_FOUND', '平台版本或账号不存在。');
  if (version.platform !== account.platform) return failure('ACCOUNT_MISMATCH', '平台版本与账号不属于同一平台。');
  if (account.loginState !== 'authenticated') return failure('BROWSER_NEEDS_USER', '平台账号需要重新登录或人工处理。');
  const binding = database.prepare(`SELECT profile_id AS profileId, binding_revision AS bindingRevision, state,
    expected_account_snapshot_json AS expectedAccounts FROM workspace_browser_bindings WHERE id='effective'`).get() as BindingRow | undefined;
  const bindingError = validateBrowserBinding(input, version, account, binding);
  if (bindingError) return bindingError;
  if (input.payload.title !== version.title || input.payload.body !== version.body) {
    return failure('CONFIRMATION_STALE', '发布载荷与平台版本不一致。');
  }
  let assetIds: string[];
  try {
    const parsed = JSON.parse(version.assetIds) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return failure('VALIDATION_ERROR', '平台版本的素材绑定无效。');
    assetIds = parsed;
  } catch { return failure('VALIDATION_ERROR', '平台版本的素材绑定无效。'); }
  const suppliedAssets: Array<{ id: string; sha256?: string }> = input.payload.assets.map((asset) =>
    typeof asset === 'string' ? { id: asset } : { id: asset.id, ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }) });
  if (suppliedAssets.length !== assetIds.length || suppliedAssets.some((asset, index) => asset.id !== assetIds[index])) {
    return failure('CONFIRMATION_STALE', '发布素材顺序与平台版本不一致。');
  }
  const assets: PublicationSnapshotAssetV1[] = [];
  for (let index = 0; index < assetIds.length; index += 1) {
    const asset = database.prepare(`SELECT id, sha256, relative_path AS relativePath, mime_type AS mimeType
      FROM assets WHERE id=?`).get(assetIds[index]) as PublicationSnapshotAssetV1 | undefined;
    if (!asset) return failure('NOT_FOUND', `发布素材不存在：${assetIds[index]}`);
    if (suppliedAssets[index].sha256 !== undefined && suppliedAssets[index].sha256 !== asset.sha256) {
      return failure('CONFIRMATION_STALE', `发布素材内容已经变化：${asset.id}`);
    }
    assets.push(Object.freeze(asset));
  }

  const payload = Object.freeze({ title: version.title, body: version.body, format: version.format });
  const causation = JSON.parse(canonicalJson(input.causation ?? {})) as Readonly<Record<string, unknown>>;
  const payloadJson = canonicalJson(payload); const assetsJson = canonicalJson(assets);
  const payloadHash = sha256(payloadJson); const assetsHash = sha256(assetsJson);
  const frozenInput = {
    version: 'PublicationSnapshotV1', workspaceId: input.workspaceId, runtimeEpoch: input.runtimeEpoch,
    platformVersion: { id: version.id, revision: version.revision, platform: version.platform },
    account: { id: account.id, key: account.accountKey, revision: account.revision },
    browserBinding: { id: 'effective', profileId: input.browserProfileId, revision: input.browserBindingRevision },
    payload, payloadHash, assets, assetsHash, causation
  };
  const inputHash = sha256(canonicalJson(frozenInput));
  const publicationId = randomUUID(); const snapshotId = randomUUID(); const operationId = randomUUID();
  const now = new Date().toISOString();
  try {
    return atomic(database, () => {
      database.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id,
        account_key, status, prepared_assets_json, created_at, updated_at, revision)
        VALUES (?,?,?,?,?,?,'draft','[]',?,?,1)`).run(publicationId, version.id, version.revision, version.platform, account.id, account.accountKey, now, now);
      database.prepare(`INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at)
        VALUES (?, ?, NULL, 'draft', 'immutable snapshot created', ?)`).run(randomUUID(), publicationId, now);
      database.prepare(`INSERT INTO publication_snapshots (id, publication_id, workspace_id, runtime_epoch, platform_version_id,
        platform_version_revision, platform, account_id, account_key, account_revision, browser_binding_id, browser_profile_id,
        browser_binding_revision, payload_json, payload_hash, assets_json, assets_hash, input_hash, causation_json, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshotId, publicationId, input.workspaceId, input.runtimeEpoch,
          version.id, version.revision, version.platform, account.id, account.accountKey, account.revision, 'effective',
          input.browserProfileId, input.browserBindingRevision, payloadJson, payloadHash, assetsJson, assetsHash, inputHash,
          canonicalJson(causation), now);
      database.prepare(`INSERT INTO publication_browser_operations (id, publication_id, snapshot_id, state, phase,
        evidence_json, readback_json, created_at, updated_at, revision) VALUES (?,?,?,'prepared','prepared','{}','{}',?,?,1)`)
        .run(operationId, publicationId, snapshotId, now, now);
      return success({ publication: getPublication(database, publicationId)!, snapshot: getPublicationSnapshot(database, snapshotId)!, operation: getPublicationBrowserOperation(database, operationId)! });
    });
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function getPublicationSnapshot(database: DatabaseSync, id: string): PublicationSnapshotV1 | undefined {
  const row = database.prepare(`SELECT id, publication_id AS publicationId, workspace_id AS workspaceId, runtime_epoch AS runtimeEpoch,
    platform_version_id AS platformVersionId, platform_version_revision AS platformVersionRevision, platform,
    account_id AS accountId, account_key AS accountKey, account_revision AS accountRevision,
    browser_binding_id AS browserBindingId, browser_profile_id AS browserProfileId,
    browser_binding_revision AS browserBindingRevision, payload_json AS payload, payload_hash AS payloadHash,
    assets_json AS assets, assets_hash AS assetsHash, input_hash AS inputHash, causation_json AS causation,
    created_at AS createdAt FROM publication_snapshots WHERE id=?`).get(id) as SnapshotRow | undefined;
  return row ? Object.freeze({ ...row, version: 'PublicationSnapshotV1', browserBindingId: 'effective', payload: JSON.parse(row.payload), assets: JSON.parse(row.assets), causation: JSON.parse(row.causation) }) : undefined;
}

export function getPublicationBrowserOperation(database: DatabaseSync, id: string): PublicationBrowserOperationV1 | undefined {
  const row = database.prepare(`SELECT id, publication_id AS publicationId, snapshot_id AS snapshotId, state, phase,
    execution_grant_id AS executionGrantId, evidence_json AS evidence, readback_json AS readback, error_code AS errorCode,
    error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt, started_at AS startedAt,
    finished_at AS finishedAt, revision FROM publication_browser_operations WHERE id=?`).get(id) as OperationRow | undefined;
  return row ? Object.freeze({ ...row, version: 'PublicationBrowserOperationV1', evidence: JSON.parse(row.evidence), readback: JSON.parse(row.readback) }) : undefined;
}

export function transitionPublicationBrowserOperation(
  database: DatabaseSync,
  input: TransitionPublicationBrowserOperationInput
): CommandResult<PublicationBrowserOperationV1> {
  const current = getPublicationBrowserOperation(database, input.operationId);
  if (!current) return failure('NOT_FOUND', '发布浏览器操作不存在。');
  if (current.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', '发布浏览器操作已变化，请重新加载。', { current });
  if (!input.phase?.trim()) return failure('VALIDATION_ERROR', '操作阶段不能为空。');
  if (input.to === 'succeeded') return failure('INVALID_STATE', '成功准备必须通过 completePublicationPreparation 完成。');
  if (!transitions[current.state].includes(input.to)) return failure('INVALID_STATE', `浏览器操作不能从 ${current.state} 变为 ${input.to}。`);
  if (input.to === 'execution_granted') {
    if (!input.executionGrantId?.trim()) return failure('VALIDATION_ERROR', 'execution_granted 必须绑定精确执行授权。');
    const snapshot = getPublicationSnapshot(database, current.snapshotId);
    const grant = database.prepare(`SELECT workspace_id AS workspaceId, runtime_epoch AS runtimeEpoch, command,
      browser_profile_id AS browserProfileId, binding_revision AS bindingRevision, expected_account AS expectedAccount,
      allowed_transition AS allowedTransition, status FROM execution_grants WHERE id=?`).get(input.executionGrantId) as {
        workspaceId: string; runtimeEpoch: string; command: string; browserProfileId: string | null; bindingRevision: number | null;
        expectedAccount: string | null; allowedTransition: string; status: string;
      } | undefined;
    if (!snapshot || !grant) return failure('NOT_FOUND', '精确执行授权或发布快照不存在。');
    if (grant.status !== 'consumed' || grant.command !== 'publication.editor_prepare_execute'
      || grant.workspaceId !== snapshot.workspaceId || grant.runtimeEpoch !== snapshot.runtimeEpoch
      || grant.browserProfileId !== snapshot.browserProfileId || grant.bindingRevision !== snapshot.browserBindingRevision
      || grant.expectedAccount !== snapshot.accountKey || grant.allowedTransition !== 'prepared->execution_granted') {
      return failure('CONFIRMATION_STALE', '精确执行授权与不可变发布快照不一致。');
    }
  } else if (input.executionGrantId && input.executionGrantId !== current.executionGrantId) {
    return failure('VALIDATION_ERROR', '浏览器操作不能更换精确执行授权。');
  }
  if (input.to === 'readback_pending' && input.readback === undefined) return failure('VALIDATION_ERROR', '进入回读阶段必须保存回读事实。');
  const now = new Date().toISOString();
  const grantId = input.to === 'execution_granted' ? input.executionGrantId!.trim() : current.executionGrantId;
  try {
    return atomic(database, () => {
      const changed = database.prepare(`UPDATE publication_browser_operations SET state=?, phase=?, execution_grant_id=?,
        evidence_json=?, readback_json=?, error_code=?, error_message=?, updated_at=?,
        started_at=CASE WHEN ?='executing' THEN COALESCE(started_at, ?) ELSE started_at END,
        finished_at=CASE WHEN ? IN ('needs_user','unknown','failed') THEN ? ELSE finished_at END, revision=revision+1
        WHERE id=? AND revision=? AND state=?`).run(input.to, input.phase.trim(), grantId,
          input.evidence === undefined ? canonicalJson(current.evidence) : canonicalJson(input.evidence),
          input.readback === undefined ? canonicalJson(current.readback) : canonicalJson(input.readback),
          input.errorCode ?? null, input.errorMessage ?? null, now, input.to, now, input.to, now,
          current.id, current.revision, current.state);
      if (Number(changed.changes) !== 1) throw revisionConflict();
      if (input.to === 'needs_user' || input.to === 'unknown' || input.to === 'failed') syncPublicationFailure(database, current.publicationId, input.to, input.errorCode, input.errorMessage, now);
      return success(getPublicationBrowserOperation(database, current.id)!);
    });
  } catch (error) {
    if (isRevisionConflict(error)) return failure('REVISION_CONFLICT', '发布浏览器操作已变化，请重新加载。');
    return persistenceFailure(error);
  }
}

export function completePublicationPreparation(database: DatabaseSync, input: {
  operationId: string; expectedRevision: number; editorEvidenceUrl: string;
}): CommandResult<{ publication: PublicationRecord; snapshot: PublicationSnapshotV1; operation: PublicationBrowserOperationV1 }> {
  const operation = getPublicationBrowserOperation(database, input.operationId);
  if (!operation) return failure('NOT_FOUND', '发布浏览器操作不存在。');
  if (operation.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', '发布浏览器操作已变化，请重新加载。', { current: operation });
  if (operation.state !== 'readback_pending') return failure('INVALID_STATE', '只有等待回读确认的操作可以完成准备。');
  const editorEvidenceUrl = input.editorEvidenceUrl?.trim();
  if (!editorEvidenceUrl) return failure('VALIDATION_ERROR', '编辑器证据地址不能为空。');
  const snapshot = getPublicationSnapshot(database, operation.snapshotId);
  if (!snapshot) return failure('NOT_FOUND', '发布快照不存在。');
  const readbackError = validateReadback(snapshot, operation.readback);
  if (readbackError) return readbackError;
  const publication = getPublication(database, operation.publicationId);
  if (!publication) return failure('NOT_FOUND', '发布记录不存在。');
  if (!['draft', 'failed', 'needs_user'].includes(publication.status)) return failure('INVALID_STATE', '发布记录当前不能完成编辑器准备。');
  const evidence = operation.evidence && typeof operation.evidence === 'object' && !Array.isArray(operation.evidence)
    ? { ...(operation.evidence as Record<string, unknown>), editorEvidenceUrl }
    : { evidence: operation.evidence, editorEvidenceUrl };
  const now = new Date().toISOString();
  try {
    return atomic(database, () => {
      const changed = database.prepare(`UPDATE publication_browser_operations SET state='succeeded', phase='succeeded',
        evidence_json=?, error_code=NULL, error_message=NULL, updated_at=?, finished_at=?, revision=revision+1
        WHERE id=? AND revision=? AND state='readback_pending'`).run(canonicalJson(evidence), now, now, operation.id, operation.revision);
      if (Number(changed.changes) !== 1) throw revisionConflict();
      const publicationChanged = database.prepare(`UPDATE publications SET status='awaiting_confirmation', prepared_title=?, prepared_body=?,
        prepared_assets_json=?, prepared_evidence_url=?, last_error_code=NULL, last_error_message=NULL,
        updated_at=?, revision=revision+2 WHERE id=? AND revision=? AND status=?`).run(snapshot.payload.title, snapshot.payload.body,
          canonicalJson(snapshot.assets), editorEvidenceUrl, now, publication.id, publication.revision, publication.status);
      if (Number(publicationChanged.changes) !== 1) throw revisionConflict();
      database.prepare(`INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at)
        VALUES (?,?,?,?,?,?)`).run(randomUUID(), publication.id, publication.status, 'prepared', 'editor readback matched immutable snapshot', now);
      database.prepare(`INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at)
        VALUES (?,?,?,?,?,?)`).run(randomUUID(), publication.id, 'prepared', 'awaiting_confirmation', 'manual final publication required', now);
      return success({ publication: getPublication(database, publication.id)!, snapshot, operation: getPublicationBrowserOperation(database, operation.id)! });
    });
  } catch (error) {
    if (isRevisionConflict(error)) return failure('REVISION_CONFLICT', '发布浏览器操作已变化，请重新加载。');
    return persistenceFailure(error);
  }
}

export function recoverInterruptedPublicationBrowserOperations(database: DatabaseSync): number {
  const rows = database.prepare(`SELECT id FROM publication_browser_operations
    WHERE state IN ('execution_granted','browser_leased','executing','readback_pending') ORDER BY updated_at, id LIMIT ?`).all(RECOVERY_LIMIT) as Array<{ id: string }>;
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  return atomic(database, () => {
    let recovered = 0;
    for (const { id } of rows) {
      const operation = getPublicationBrowserOperation(database, id);
      if (!operation || !['execution_granted', 'browser_leased', 'executing', 'readback_pending'].includes(operation.state)) continue;
      const uncertain = operation.state === 'readback_pending';
      const to = uncertain ? 'unknown' : 'needs_user';
      const code = uncertain ? 'PUBLICATION_READBACK_INTERRUPTED' : 'PUBLICATION_BROWSER_INTERRUPTED';
      const message = uncertain ? '应用在编辑器回读确认完成前退出。' : '应用在浏览器操作期间退出，禁止自动重试。';
      const changed = database.prepare(`UPDATE publication_browser_operations SET state=?, phase='restart_recovery',
        error_code=?, error_message=?, updated_at=?, finished_at=?, revision=revision+1 WHERE id=? AND revision=? AND state=?`)
        .run(to, code, message, now, now, operation.id, operation.revision, operation.state);
      if (Number(changed.changes) !== 1) continue;
      syncPublicationFailure(database, operation.publicationId, to, code, message, now);
      recovered += 1;
    }
    return recovered;
  });
}
type VersionRow = { id: string; platform: PublicationRecord['platform']; format: string; title: string | null; body: string; assetIds: string; revision: number };
type AccountRow = { id: string; platform: PublicationRecord['platform']; accountKey: string; loginState: string; revision: number; browserProfileId: string | null; browserBindingRevision: number | null };
type BindingRow = { profileId: string | null; bindingRevision: number; state: string; expectedAccounts: string };
type SnapshotRow = Omit<PublicationSnapshotV1, 'version' | 'payload' | 'assets' | 'causation' | 'browserBindingId'> & { browserBindingId: string; payload: string; assets: string; causation: string };
type OperationRow = Omit<PublicationBrowserOperationV1, 'version' | 'evidence' | 'readback'> & { evidence: string; readback: string };

function validateIdentityInput(input: CreatePublicationSnapshotInput): CommandResult<never> | null {
  if (!input.workspaceId?.trim() || !input.runtimeEpoch?.trim() || !input.platformVersionId?.trim() || !input.accountId?.trim() || !input.browserProfileId?.trim()) return failure('VALIDATION_ERROR', '发布快照身份字段不能为空。');
  if (!Number.isInteger(input.browserBindingRevision) || input.browserBindingRevision < 1) return failure('VALIDATION_ERROR', '浏览器 binding revision 无效。');
  if (!input.payload || typeof input.payload.body !== 'string' || (input.payload.title !== null && typeof input.payload.title !== 'string') || !Array.isArray(input.payload.assets)) return failure('VALIDATION_ERROR', '发布载荷无效。');
  return null;
}

function validateBrowserBinding(input: CreatePublicationSnapshotInput, version: VersionRow, account: AccountRow, binding?: BindingRow): CommandResult<never> | null {
  if (!binding || binding.state !== 'verified') return failure('BROWSER_NEEDS_USER', '当前工作空间浏览器绑定尚未验证。');
  if (binding.profileId !== input.browserProfileId) return failure('PROFILE_STALE', '浏览器档案与当前工作空间绑定不一致。');
  if (binding.bindingRevision !== input.browserBindingRevision) return failure('PROFILE_STALE', '浏览器 binding revision 已变化。');
  if (account.browserProfileId !== input.browserProfileId || account.browserBindingRevision !== input.browserBindingRevision) return failure('ACCOUNT_MISMATCH', '平台账号不属于当前浏览器绑定。');
  try {
    const expected = (JSON.parse(binding.expectedAccounts) as Record<string, Record<string, unknown>>)[version.platform];
    if (!expected || expected.accountKey !== account.accountKey || expected.browserProfileId !== input.browserProfileId
      || expected.browserBindingRevision !== input.browserBindingRevision || expected.accountRevision !== account.revision) return failure('ACCOUNT_MISMATCH', '浏览器绑定的账号快照与发布账号不一致。');
  } catch { return failure('PROFILE_STALE', '浏览器绑定账号快照无效。'); }
  return null;
}

function validateReadback(snapshot: PublicationSnapshotV1, value: unknown): CommandResult<never> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('VALIDATION_ERROR', '编辑器回读事实无效。');
  const readback = value as Record<string, unknown>;
  if (readback.body !== snapshot.payload.body) return failure('CONFIRMATION_STALE', '编辑器正文与不可变发布快照不一致。');
  if ((readback.title ?? null) !== snapshot.payload.title) return failure('CONFIRMATION_STALE', '编辑器标题与不可变发布快照不一致。');
  if (!Array.isArray(readback.assetIds) || readback.assetIds.some((id) => typeof id !== 'string')
    || readback.assetIds.join('\0') !== snapshot.assets.map((asset) => asset.id).join('\0')) return failure('CONFIRMATION_STALE', '编辑器素材与不可变发布快照不一致。');
  return null;
}

function syncPublicationFailure(database: DatabaseSync, publicationId: string, to: 'needs_user' | 'unknown' | 'failed', code: string | undefined, message: string | undefined, now: string): void {
  const publication = getPublication(database, publicationId);
  if (!publication || ['published', 'awaiting_confirmation'].includes(publication.status) || publication.status === to) return;
  database.prepare(`UPDATE publications SET status=?, last_error_code=?, last_error_message=?, updated_at=?, revision=revision+1 WHERE id=?`)
    .run(to, code ?? null, message ?? null, now, publicationId);
  database.prepare(`INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at) VALUES (?,?,?,?,?,?)`)
    .run(randomUUID(), publicationId, publication.status, to, message ?? code ?? 'browser operation stopped', now);
}

function atomic<T>(database: DatabaseSync, run: () => T): T {
  if (database.isTransaction) return run();
  database.exec('BEGIN IMMEDIATE');
  try { const result = run(); database.exec('COMMIT'); return result; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
}
function canonicalJson(value: unknown): string { return stableJson(value, false); }
function stableJson(value: unknown, inArray: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_JSON_NUMBER'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? 'null' : stableJson(item, true)).join(',')}]`;
  if (typeof value === 'object') { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(record[key], false)}`).join(',')}}`; }
  if (inArray) return 'null';
  throw new TypeError('UNSUPPORTED_JSON_VALUE');
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function revisionConflict(): Error { return Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT' }); }
function isRevisionConflict(error: unknown): error is Error & { code: 'REVISION_CONFLICT' } { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'REVISION_CONFLICT'); }
function persistenceFailure(error: unknown): CommandResult<never> { const message = error instanceof Error ? error.message : String(error); return failure('VALIDATION_ERROR', message); }
