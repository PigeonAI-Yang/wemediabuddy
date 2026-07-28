import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { schedulePublicationMetricJobs } from './metrics.ts';

export type PublicationStatus = 'draft' | 'prepared' | 'awaiting_confirmation' | 'publishing' | 'published' | 'failed' | 'needs_user' | 'unknown';

const transitions: Record<PublicationStatus, PublicationStatus[]> = {
  draft: ['prepared'],
  prepared: ['awaiting_confirmation', 'draft'],
  awaiting_confirmation: ['publishing', 'published', 'draft', 'needs_user'],
  publishing: ['published', 'failed', 'needs_user', 'unknown'],
  failed: ['prepared'],
  needs_user: ['prepared', 'published', 'unknown'],
  unknown: ['published', 'failed'],
  published: []
};

export type PublicationRecord = {
  id: string; platformVersionId: string; platformVersionRevision: number; platform: 'x' | 'xiaohongshu' | 'wechat';
  accountId: string; accountKey: string; status: PublicationStatus; revision: number;
  externalUrl: string | null; externalId: string | null; publishedAt: string | null;
};

type BoundAsset = { id: string; sha256: string; relativePath: string; mimeType: string };
type PreparedPayload = { title: string | null; body: string; assets: BoundAsset[]; editorEvidenceUrl: string };

export function createPublication(database: DatabaseSync, input: { platformVersionId: string; accountId: string }): CommandResult<PublicationRecord> {
  const version = database.prepare('SELECT platform, revision FROM platform_versions WHERE id = ?').get(input.platformVersionId) as { platform: PublicationRecord['platform']; revision: number } | undefined;
  const account = database.prepare('SELECT id, platform, account_key AS accountKey FROM platform_accounts WHERE id = ?').get(input.accountId) as { id: string; platform: PublicationRecord['platform']; accountKey: string } | undefined;
  if (!version || !account) return failure('NOT_FOUND', '平台版本或账号不存在。');
  if (version.platform !== account.platform) return failure('ACCOUNT_MISMATCH', '平台版本与账号不属于同一平台。');
  const id = randomUUID(); const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status,
      prepared_assets_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, 'draft', '[]', ?, ?, 1)`)
      .run(id, input.platformVersionId, version.revision, version.platform, account.id, account.accountKey, now, now);
    database.prepare('INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at) VALUES (?, ?, NULL, ?, ?, ?)')
      .run(randomUUID(), id, 'draft', 'created', now);
    database.exec('COMMIT');
    return success(getPublication(database, id)!);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function transitionPublication(database: DatabaseSync, id: string, to: PublicationStatus, input: {
  expectedRevision: number; reason?: string; externalUrl?: string; externalId?: string; errorCode?: string; errorMessage?: string;
}): CommandResult<PublicationRecord> {
  const current = getPublication(database, id);
  if (!current) return failure('NOT_FOUND', '发布记录不存在。');
  if (current.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', '发布状态已变化，请重新加载。', { current });
  if (!transitions[current.status].includes(to)) return failure('INVALID_STATE', `发布状态不能从 ${current.status} 变为 ${to}。`, { currentStatus: current.status, requestedStatus: to });
  if (to === 'published' && (!input.externalUrl || !input.externalId)) return failure('VALIDATION_ERROR', '发布成功必须包含稳定地址和平台身份。');
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`UPDATE publications SET status = ?, external_url = COALESCE(?, external_url), external_id = COALESCE(?, external_id),
      published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END, last_error_code = ?, last_error_message = ?,
      updated_at = ?, revision = revision + 1 WHERE id = ?`)
      .run(to, input.externalUrl ?? null, input.externalId ?? null, to, now, input.errorCode ?? null, input.errorMessage ?? null, now, id);
    if (current.status === 'publishing') {
      database.prepare(`UPDATE publication_attempts SET status = ?, finished_at = ?, error_code = ?, error_message = ?
        WHERE id = (SELECT id FROM publication_attempts WHERE publication_id = ? ORDER BY attempt_number DESC LIMIT 1)`)
        .run(to, now, input.errorCode ?? null, input.errorMessage ?? null, id);
    }
    database.prepare('INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), id, current.status, to, input.reason ?? null, now);
    database.exec('COMMIT');
    const publication = getPublication(database, id)!;
    if (to === 'published' && publication.externalUrl && publication.publishedAt) {
      schedulePublicationMetricJobs(database, {
        publicationId: publication.id,
        publishedAt: publication.publishedAt,
        sourceUrl: publication.externalUrl,
        platform: publication.platform
      });
    }
    return success(publication);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function createPublicationAttempt(database: DatabaseSync, publicationId: string): CommandResult<{ id: string; attemptNumber: number }> {
  const publication = getPublication(database, publicationId);
  if (!publication) return failure('NOT_FOUND', '发布记录不存在。');
  if (publication.status !== 'publishing') return failure('INVALID_STATE', '只有 publishing 状态可以创建发布尝试。');
  const attemptNumber = Number((database.prepare('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS number FROM publication_attempts WHERE publication_id = ?').get(publicationId) as { number: number }).number);
  const id = randomUUID();
  database.prepare(`INSERT INTO publication_attempts (id, publication_id, attempt_number, status, started_at, evidence_json)
    VALUES (?, ?, ?, 'publishing', ?, '[]')`).run(id, publicationId, attemptNumber, new Date().toISOString());
  return success({ id, attemptNumber });
}

export function recordReconciliation(database: DatabaseSync, input: { publicationId: string; attemptId?: string; outcome: 'matched' | 'not_published' | 'ambiguous'; evidence: unknown }): CommandResult<{ id: string }> {
  const publication = getPublication(database, input.publicationId);
  if (!publication) return failure('NOT_FOUND', '发布记录不存在。');
  if (publication.status !== 'unknown') return failure('INVALID_STATE', '只有 unknown 状态可以保存对账结果。');
  const id = randomUUID();
  database.prepare('INSERT INTO publication_reconciliations (id, publication_id, attempt_id, outcome, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.publicationId, input.attemptId ?? null, input.outcome, JSON.stringify(input.evidence), new Date().toISOString());
  return success({ id });
}

export function preparePublication(database: DatabaseSync, input: {
  publicationId: string; expectedRevision: number; editorTitle: string | null; editorBody: string;
  editorAssetIds: string[]; editorEvidenceUrl: string;
}): CommandResult<{ publication: PublicationRecord; payload: PreparedPayload }> {
  const publication = getPublication(database, input.publicationId);
  if (!publication) return failure('NOT_FOUND', '发布记录不存在。');
  if (publication.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', '发布记录已变化，请重新加载。', { current: publication });
  if (!['draft', 'failed', 'needs_user'].includes(publication.status)) return failure('INVALID_STATE', '当前状态不能重新准备发布。');
  const binding = readCurrentBinding(database, publication);
  if (!binding) return failure('NOT_FOUND', '平台版本或账号不存在。');
  if (binding.account.loginState !== 'authenticated') return failure('BROWSER_NEEDS_USER', '平台账号需要重新登录或人工处理。', { loginState: binding.account.loginState });
  if (binding.account.accountKey !== publication.accountKey) return failure('ACCOUNT_MISMATCH', '当前账号与发布记录绑定账号不一致。');
  if (binding.version.revision !== publication.platformVersionRevision) return failure('CONFIRMATION_STALE', '平台版本已经变化，请创建新的发布记录。');
  if (binding.version.title !== input.editorTitle || binding.version.body !== input.editorBody || binding.version.assetIds.join('|') !== input.editorAssetIds.join('|')) {
    return failure('VALIDATION_ERROR', '编辑器回读内容与绑定的平台版本不一致。');
  }
  const payload: PreparedPayload = { title: binding.version.title, body: binding.version.body, assets: binding.assets, editorEvidenceUrl: input.editorEvidenceUrl };
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`UPDATE publications SET status = 'awaiting_confirmation', prepared_title = ?, prepared_body = ?,
      prepared_assets_json = ?, prepared_evidence_url = ?, updated_at = ?, revision = revision + 2 WHERE id = ?`)
      .run(payload.title, payload.body, JSON.stringify(payload.assets), payload.editorEvidenceUrl, now, publication.id);
    database.prepare('INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), publication.id, publication.status, 'prepared', 'editor readback matched', now);
    database.prepare('INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), publication.id, 'prepared', 'awaiting_confirmation', 'confirmation view ready', now);
    database.exec('COMMIT');
    return success({ publication: getPublication(database, publication.id)!, payload });
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function confirmAndStartPublication(database: DatabaseSync, input: { publicationId: string; expectedRevision: number }): CommandResult<{
  publication: PublicationRecord; confirmationId: string; attemptId: string;
}> {
  const publication = getPublication(database, input.publicationId);
  if (!publication) return failure('NOT_FOUND', '发布记录不存在。');
  if (publication.status !== 'awaiting_confirmation') return failure('INVALID_STATE', '发布记录尚未等待确认。');
  if (publication.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', '发布记录已变化，请重新加载。', { current: publication });
  const binding = readCurrentBinding(database, publication);
  const prepared = database.prepare('SELECT prepared_title AS title, prepared_body AS body, prepared_assets_json AS assets FROM publications WHERE id = ?').get(publication.id) as { title: string | null; body: string | null; assets: string };
  if (!binding || binding.account.accountKey !== publication.accountKey || binding.version.revision !== publication.platformVersionRevision) return failure('CONFIRMATION_STALE', '账号或内容版本已变化，原确认已失效。');
  const preparedAssets = JSON.parse(prepared.assets) as BoundAsset[];
  if (prepared.body !== binding.version.body || prepared.title !== binding.version.title || JSON.stringify(preparedAssets) !== JSON.stringify(binding.assets)) {
    return failure('CONFIRMATION_STALE', '正文或素材已变化，原确认已失效。');
  }
  const confirmationId = randomUUID(); const attemptId = randomUUID(); const now = new Date().toISOString();
  const attemptNumber = Number((database.prepare('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS number FROM publication_attempts WHERE publication_id = ?').get(publication.id) as { number: number }).number);
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO publication_attempts (id, publication_id, attempt_number, status, started_at, evidence_json)
      VALUES (?, ?, ?, 'publishing', ?, '[]')`).run(attemptId, publication.id, attemptNumber, now);
    database.prepare(`INSERT INTO publication_confirmations (id, publication_id, attempt_id, platform_version_id, platform_version_revision,
      account_id, account_key, assets_json, confirmed_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(confirmationId, publication.id, attemptId, publication.platformVersionId, publication.platformVersionRevision, publication.accountId, publication.accountKey, JSON.stringify(binding.assets), now, now);
    database.prepare("UPDATE publications SET status = 'publishing', updated_at = ?, revision = revision + 1 WHERE id = ?").run(now, publication.id);
    database.prepare('INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), publication.id, 'awaiting_confirmation', 'publishing', 'human confirmation consumed', now);
    database.exec('COMMIT');
    return success({ publication: getPublication(database, publication.id)!, confirmationId, attemptId });
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function getPublicationDetail(database: DatabaseSync, id: string): {
  publication: PublicationRecord; payload: PreparedPayload | null; attempts: unknown[]; events: unknown[]; reconciliations: unknown[];
} | undefined {
  const publication = getPublication(database, id);
  if (!publication) return undefined;
  const row = database.prepare('SELECT prepared_title AS title, prepared_body AS body, prepared_assets_json AS assets, prepared_evidence_url AS editorEvidenceUrl FROM publications WHERE id = ?').get(id) as { title: string | null; body: string | null; assets: string; editorEvidenceUrl: string | null };
  return {
    publication,
    payload: row.body === null ? null : { title: row.title, body: row.body, assets: JSON.parse(row.assets), editorEvidenceUrl: row.editorEvidenceUrl ?? '' },
    attempts: database.prepare('SELECT * FROM publication_attempts WHERE publication_id = ? ORDER BY attempt_number DESC').all(id),
    events: database.prepare('SELECT * FROM publication_events WHERE publication_id = ? ORDER BY created_at, rowid').all(id),
    reconciliations: database.prepare('SELECT * FROM publication_reconciliations WHERE publication_id = ? ORDER BY created_at DESC').all(id)
  };
}

export function listPublicationDetails(database: DatabaseSync): NonNullable<ReturnType<typeof getPublicationDetail>>[] {
  const ids = database.prepare('SELECT id FROM publications ORDER BY updated_at DESC').all() as Array<{ id: string }>;
  return ids.map(({ id }) => getPublicationDetail(database, id)).filter(Boolean) as NonNullable<ReturnType<typeof getPublicationDetail>>[];
}

export function recoverInterruptedPublications(database: DatabaseSync): number {
  const interrupted = database.prepare("SELECT id FROM publications WHERE status = 'publishing'").all() as Array<{ id: string }>;
  if (!interrupted.length) return 0;
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const { id } of interrupted) {
      database.prepare(`UPDATE publication_attempts SET status = 'unknown', finished_at = ?,
        error_code = 'PUBLICATION_UNKNOWN', error_message = '应用在发布结果回读前退出。'
        WHERE id = (SELECT id FROM publication_attempts WHERE publication_id = ? ORDER BY attempt_number DESC LIMIT 1)`)
        .run(now, id);
      database.prepare(`UPDATE publications SET status = 'unknown', last_error_code = 'PUBLICATION_UNKNOWN',
        last_error_message = '应用在发布结果回读前退出。', updated_at = ?, revision = revision + 1 WHERE id = ?`)
        .run(now, id);
      database.prepare('INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), id, 'publishing', 'unknown', 'restart preserved uncertain publication', now);
    }
    database.exec('COMMIT');
    return interrupted.length;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function reconcileAsNotPublished(database: DatabaseSync, input: { publicationId: string; expectedRevision: number; evidence: unknown }): CommandResult<PublicationRecord> {
  const publication = getPublication(database, input.publicationId);
  if (!publication) return failure('NOT_FOUND', '发布记录不存在。');
  if (publication.status !== 'unknown') return failure('INVALID_STATE', '只有 unknown 状态可以确认未发布。');
  if (publication.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', '发布记录已变化，请重新加载。', { current: publication });
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare("INSERT INTO publication_reconciliations (id, publication_id, attempt_id, outcome, evidence_json, created_at) VALUES (?, ?, (SELECT id FROM publication_attempts WHERE publication_id = ? ORDER BY attempt_number DESC LIMIT 1), 'not_published', ?, ?)")
      .run(randomUUID(), publication.id, publication.id, JSON.stringify(input.evidence), now);
    database.prepare("UPDATE publications SET status = 'failed', updated_at = ?, revision = revision + 1 WHERE id = ?").run(now, publication.id);
    database.prepare('INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), publication.id, 'unknown', 'failed', 'human confirmed not published', now);
    database.exec('COMMIT');
    return success(getPublication(database, publication.id)!);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function getPublication(database: DatabaseSync, id: string): PublicationRecord | undefined {
  return database.prepare(`SELECT id, platform_version_id AS platformVersionId, platform_version_revision AS platformVersionRevision,
    platform, account_id AS accountId, account_key AS accountKey, status, revision, external_url AS externalUrl,
    external_id AS externalId, published_at AS publishedAt FROM publications WHERE id = ?`).get(id) as PublicationRecord | undefined;
}

function readCurrentBinding(database: DatabaseSync, publication: PublicationRecord): {
  version: { title: string | null; body: string; revision: number; assetIds: string[] };
  account: { accountKey: string; loginState: string };
  assets: BoundAsset[];
} | undefined {
  const version = database.prepare('SELECT title, body, revision, asset_ids_json AS assetIds FROM platform_versions WHERE id = ?').get(publication.platformVersionId) as { title: string | null; body: string; revision: number; assetIds: string } | undefined;
  const account = database.prepare('SELECT account_key AS accountKey, login_state AS loginState FROM platform_accounts WHERE id = ?').get(publication.accountId) as { accountKey: string; loginState: string } | undefined;
  if (!version || !account) return undefined;
  const assetIds = JSON.parse(version.assetIds) as string[];
  const assets = assetIds.map((id) => database.prepare('SELECT id, sha256, relative_path AS relativePath, mime_type AS mimeType FROM assets WHERE id = ?').get(id) as BoundAsset | undefined);
  if (assets.some((asset) => !asset)) return undefined;
  return { version: { ...version, assetIds }, account, assets: assets as BoundAsset[] };
}
