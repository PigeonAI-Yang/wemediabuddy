// WMB-5243 Electron E2E fixture seeding for 创作/发布/结果 surfaces (ST/PB/RS journeys).
//
// This module seeds REAL SQLite data through the app's own backend modules
// (content/publishing/metrics/reviews/accounts/publication-operations) — the same
// code paths the WMB-5234 acceptance used — so the renderer reads genuine rows,
// not hand-crafted fixtures. It is invoked from scenario `launch.seedFixture`
// (pre-boot, harness calls it after seedWorkspace and before _electron.launch),
// and is idempotent against the app's own migrateDatabase (which seedWorkspace
// already ran). No business code is touched.
//
// Contract: seedWorkflowBase(dataRoot, workspaceId) MUST be the first call; it
// guarantees the workspace profile exists (official.ai, all platforms by default)
// so settings:get -> readCurrentWorkspaceSnapshot -> requireWorkspaceProfile works.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { migrateDatabase } from '../../src/main/db/migrations.ts';
import { ensureOfficialWorkspaceProfile } from '../../src/main/workspace-profiles.ts';
import * as content from '../../src/main/content.ts';
import * as accounts from '../../src/main/accounts.ts';
import * as publishing from '../../src/main/publishing.ts';
import * as metrics from '../../src/main/metrics.ts';
import * as reviews from '../../src/main/reviews.ts';
import { completePublicationPreparation, createPublicationSnapshot, transitionPublicationBrowserOperation } from '../../src/main/publication-operations.ts';

export const RUNTIME_EPOCH = 'e2e-runtime-epoch';
export const NOW = () => new Date().toISOString();

/** Open a read-write connection to the live workspace DB (schema already migrated by seedWorkspace). */
export function openWriteDb(dataRoot) {
  const db = new DatabaseSync(path.join(dataRoot, 'wmb.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Ensure the workspace identity + profile exist so the app boots with a live
 * runtime and settings:get succeeds. Idempotent; safe to call repeatedly.
 * @param {string} dataRoot
 * @param {string} workspaceId
 * @param {{ template?: 'official.ai'|'official.uk', platforms?: Array<'x'|'xiaohongshu'|'wechat'> }} [options]
 */
export async function seedWorkflowBase(dataRoot, workspaceId, options = {}) {
  const dbPath = path.join(dataRoot, 'wmb.db');
  const db = migrateDatabase(dbPath);
  try {
    if (!db.prepare("SELECT 1 FROM app_meta WHERE key='workspace_id'").get()) {
      db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
        .run(workspaceId, NOW(), NOW());
    }
    ensureOfficialWorkspaceProfile(db, (options.template ?? 'official.ai'));
    if (options.platforms) {
      db.prepare(`UPDATE workspace_profiles SET platforms_json = ?, updated_at = ?, revision = revision + 1 WHERE id = 'effective'`)
        .run(JSON.stringify(options.platforms), NOW());
    }
  } finally {
    db.close();
  }
  return dbPath;
}

/**
 * Seed a studio project with core versions and platform versions.
 * @returns {{ projectId, coreV1Id, coreV2Id, platXId, platWechatId, platXhsId }}
 */
export function seedStudioProject(db, { title = 'E2E 创作项目 A', coreV1 = '核心 V1 正文', coreV2 = '核心 V2 正文（编辑保存）', platforms = ['x', 'wechat', 'xiaohongshu'] } = {}) {
  const core1 = content.createContentProjectWithVersion(db, { title, body: coreV1 });
  const core2 = content.saveCoreVersion(db, { projectId: core1.id, body: coreV2, expectedRevision: 1 });
  if (!core2.ok) throw new Error(`seedStudioProject: core v2 保存失败 ${JSON.stringify(core2.error ?? core2)}`);
  const out = { projectId: core1.id, coreV1Id: core1.contentVersionId, coreV2Id: core2.data.id, platXId: null, platWechatId: null, platXhsId: null };
  if (platforms.includes('x')) {
    const platX = content.savePlatformVersion(db, { projectId: core1.id, contentVersionId: core2.data.id, platform: 'x', format: 'text', title: 'X 平台稿', body: '平台 V1 正文' });
    if (!platX.ok) throw new Error(`seedStudioProject: x 平台版本失败 ${JSON.stringify(platX.error ?? platX)}`);
    out.platXId = platX.data.id;
    // 第二个 X 版本：同基修订（版本切换/历史断言用）
    const platX2 = content.savePlatformVersion(db, { id: platX.data.id, projectId: core1.id, contentVersionId: core2.data.id, platform: 'x', format: 'text', title: 'X 平台稿修订', body: '平台 V2 正文', expectedRevision: 1 });
    if (!platX2.ok) throw new Error(`seedStudioProject: x 平台修订失败 ${JSON.stringify(platX2.error ?? platX2)}`);
  }
  if (platforms.includes('wechat')) {
    const platWechat = content.savePlatformVersion(db, { projectId: core1.id, contentVersionId: core2.data.id, platform: 'wechat', format: 'article', title: '公众号稿', body: '公众号正文' });
    if (!platWechat.ok) throw new Error(`seedStudioProject: wechat 平台版本失败 ${JSON.stringify(platWechat.error ?? platWechat)}`);
    out.platWechatId = platWechat.data.id;
  }
  if (platforms.includes('xiaohongshu')) {
    const platXhs = content.savePlatformVersion(db, { projectId: core1.id, contentVersionId: core2.data.id, platform: 'xiaohongshu', format: 'text', title: '小红书稿', body: '小红书正文' });
    if (!platXhs.ok) throw new Error(`seedStudioProject: xiaohongshu 平台版本失败 ${JSON.stringify(platXhs.error ?? platXhs)}`);
    out.platXhsId = platXhs.data.id;
  }
  return out;
}

/**
 * Seed a verified workspace browser binding + bound account so
 * createPublicationSnapshot (prepared operations) can run.
 */
export function seedPublishBinding(db, { platform = 'x', accountKey = '@e2e-workflow-x', displayName = 'E2E X', browserProfileId = 'e2e-browser-profile' } = {}) {
  const acc = accounts.saveAccount(db, { platform, accountKey, displayName, loginState: 'authenticated' });
  db.prepare('UPDATE platform_accounts SET browser_profile_id = ?, browser_binding_revision = ?, verified_at = ? WHERE id = ?')
    .run(browserProfileId, 1, NOW(), acc.id);
  const expected = {};
  expected[platform] = { accountKey, browserProfileId, browserBindingRevision: 1, accountRevision: acc.revision };
  db.prepare(`INSERT INTO workspace_browser_bindings (id, profile_id, binding_revision, state, expected_account_snapshot_json, created_at, updated_at)
    VALUES ('effective', ?, 1, 'verified', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, binding_revision = excluded.binding_revision,
      state = excluded.state, expected_account_snapshot_json = excluded.expected_account_snapshot_json, updated_at = excluded.updated_at`)
    .run(browserProfileId, JSON.stringify(expected), NOW(), NOW());
  return { ...acc, accountKey };
}

/**
 * 真实编辑器准备完成后的状态：publication awaiting_confirmation + operation succeeded。
 * 预置精确执行授权并走完 prepared→execution_granted→browser_leased→executing→readback_pending→
 * completePublicationPreparation 全链（与生产派发同一状态机）。
 */
export function seedAwaitingConfirmationPublication(db, { workspaceId, platformVersionId, account, payloadTitle, payloadBody, evidenceUrl = 'https://example.com/e2e-editor-readback' }) {
  const created = createPublicationSnapshot(db, {
    platformVersionId,
    accountId: account.id,
    browserProfileId: 'e2e-browser-profile',
    browserBindingRevision: 1,
    workspaceId,
    runtimeEpoch: RUNTIME_EPOCH,
    payload: { title: payloadTitle, body: payloadBody, assets: [] }
  });
  if (!created.ok) throw new Error(`seedAwaitingConfirmationPublication: createPublicationSnapshot 失败 ${JSON.stringify(created.error ?? created)}`);
  const grantId = `e2e-grant-${created.data.operation.id}`;
  db.prepare(`INSERT INTO execution_grants(id,workspace_id,runtime_epoch,task_id,task_grant_id,
    command,input_hash,bound_identity_json,target_actor_type,target_actor_id,browser_profile_id,binding_revision,expected_account,
    allowed_transition,required_readback_json,status,issued_at,expires_at,consumed_at,revoked_at,revision)
    VALUES (?,?,?,NULL,NULL,'publication.editor_prepare_execute',?,'{}','owner_ui','renderer','e2e-browser-profile',1,?,
      'prepared->execution_granted','{}','consumed',?,?,?,NULL,2)`)
    .run(grantId, workspaceId, RUNTIME_EPOCH, created.data.snapshot.inputHash, account.accountKey, NOW(), '2099-01-01T00:00:00.000Z', NOW());
  const steps = [
    { to: 'execution_granted', phase: 'execution_granted', input: { executionGrantId: grantId } },
    { to: 'browser_leased', phase: 'browser_leased', input: {} },
    { to: 'executing', phase: 'executing', input: {} },
    { to: 'readback_pending', phase: 'readback_pending', input: { readback: { title: payloadTitle, body: payloadBody, assetIds: [] } } }
  ];
  let operationId = created.data.operation.id;
  let operationRevision = created.data.operation.revision;
  for (const step of steps) {
    const next = transitionPublicationBrowserOperation(db, { operationId, expectedRevision: operationRevision, to: step.to, phase: step.phase, ...step.input });
    if (!next.ok) throw new Error(`seedAwaitingConfirmationPublication: ${step.to} 失败 ${JSON.stringify(next.error ?? next)}`);
    operationId = next.data.id;
    operationRevision = next.data.revision;
  }
  const completed = completePublicationPreparation(db, { operationId, expectedRevision: operationRevision, editorEvidenceUrl: evidenceUrl });
  if (!completed.ok) throw new Error(`seedAwaitingConfirmationPublication: complete 失败 ${JSON.stringify(completed.error ?? completed)}`);
  return { publicationId: created.data.publication.id, snapshotId: created.data.snapshot.id, operationId: created.data.operation.id, accountId: account.id };
}

/** Create a publication in 'prepared' operation state (snapshot + browser operation), returns ids. */
export function seedPreparedPublication(db, { workspaceId, platformVersionId, account, payloadTitle, payloadBody }) {
  const created = createPublicationSnapshot(db, {
    platformVersionId,
    accountId: account.id,
    browserProfileId: 'e2e-browser-profile',
    browserBindingRevision: 1,
    workspaceId,
    runtimeEpoch: RUNTIME_EPOCH,
    payload: { title: payloadTitle, body: payloadBody, assets: [] }
  });
  if (!created.ok) throw new Error(`seedPreparedPublication: createPublicationSnapshot 失败 ${JSON.stringify(created.error ?? created)}`);
  const prepared = publishing.preparePublication(db, {
    publicationId: created.data.publication.id,
    expectedRevision: created.data.publication.revision,
    editorTitle: payloadTitle,
    editorBody: payloadBody,
    editorAssetIds: [],
    editorEvidenceUrl: 'https://example.com/e2e-readback'
  });
  if (!prepared.ok) throw new Error(`seedPreparedPublication: preparePublication 失败 ${JSON.stringify(prepared.error ?? prepared)}`);
  return {
    publicationId: created.data.publication.id,
    snapshotId: created.data.snapshot.id,
    operationId: created.data.operation.id,
    accountId: account.id
  };
}

/** Create a bare publication and force a status via the real transition guard (fixture-level, no external side effect). */
export function seedPublicationWithStatus(db, { platformVersionId, accountId, accountKey, to, externalUrl = null, externalId = null, publishedAt = null, lastError = null, title = null, body = null }) {
  const pub = publishing.createPublication(db, { platformVersionId, accountId });
  if (!pub.ok) throw new Error(`seedPublicationWithStatus: createPublication 失败 ${JSON.stringify(pub.error ?? pub)}`);
  const now = NOW();
  const id = pub.data.id;
  // 真实产品中发布记录总是经 createPublicationSnapshot + preparePublication 创建，
  // 带 prepared_* 负载（选中卡渲染依赖 payload；裸记录只会渲染「尚未读取编辑器内容」
  // 占位符且列表标题回退「已发布内容」）。未显式传 title/body 时回退到平台版本内容。
  const version = db.prepare('SELECT title, body FROM platform_versions WHERE id = ?').get(platformVersionId) ?? { title: null, body: '' };
  const preparedTitle = title ?? version.title ?? null;
  const preparedBody = body ?? version.body ?? '';
  db.prepare(`UPDATE publications SET status = ?, external_url = ?, external_id = ?, published_at = ?,
    last_error_code = ?, last_error_message = ?, prepared_title = ?, prepared_body = ?, prepared_assets_json = '[]',
    updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(to, externalUrl, externalId, publishedAt, lastError?.code ?? null, lastError?.message ?? null, preparedTitle, preparedBody, now, id);
  db.prepare(`INSERT INTO publication_events (id, publication_id, from_status, to_status, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, pub.data.status, to, lastError?.message ?? `seeded ${to}`, now);
  return { publicationId: id, accountKey };
}

/** Seed metric snapshots at hour offsets after publishedAt (same real API the UI consumes). */
export function seedMetricSnapshots(db, { publicationId, publishedAt, sourceUrl, points }) {
  const out = [];
  for (const pt of points) {
    const when = new Date(Date.parse(publishedAt) + pt.hours * 3_600_000).toISOString();
    const normalized = {};
    for (const [field, value] of Object.entries(pt.values ?? {})) {
      normalized[field] = { status: 'value', value, rawLabel: String(value) };
    }
    const snap = metrics.savePublicationMetricSnapshot(db, {
      publicationId,
      scheduledFor: when,
      sourceUrl,
      capturedAt: when,
      normalized,
      raw: normalized
    });
    if (!snap.ok) throw new Error(`seedMetricSnapshots: 快照失败 ${JSON.stringify(snap.error ?? snap)}`);
    out.push(snap.data.id);
  }
  return out;
}

/** Seed a review (draft or final) over real snapshot ids. */
export function seedReview(db, { publicationId, snapshotIds = [], keep = [], stop = [], change = [], summary = 'E2E 复盘', status = 'final', findings = [] }) {
  const review = reviews.saveReview(db, {
    publicationId,
    metricSnapshotIds: snapshotIds,
    keep,
    stop,
    change,
    summary,
    status,
    findings
  });
  if (!review.ok) throw new Error(`seedReview: 保存失败 ${JSON.stringify(review.error ?? review)}`);
  return review.data.id;
}

/** Seed a health issue row visible to the results health panel filters. */
export function seedResultsHealthIssue(db, { id, issueType, affectedObjectType, affectedObjectId, severity = 'medium', suggestedAction = 'E2E 健康问题' }) {
  const now = NOW();
  db.prepare(`INSERT INTO knowledge_health_issues
    (id, scope, issue_type, affected_object_type, affected_object_id, severity, evidence_json, suggested_action,
     status, detected_at, updated_at, revision)
    VALUES (?, 'global', ?, ?, ?, ?, '{}', ?, 'open', ?, ?, 1)`)
    .run(id, issueType, affectedObjectType, affectedObjectId, severity, suggestedAction, now, now);
  return id;
}

/**
 * 让指定发布记录成为发布页选中项（列表按 updated_at DESC，选中 = 第一条）。
 * 各场景把「预期选中」的记录刷为最新，避免种子顺序影响选中卡状态断言。
 */
export function makePublicationLatest(db, publicationId) {
  db.prepare('UPDATE publications SET updated_at = ?, revision = revision + 0 WHERE id = ?')
    .run(new Date(Date.now() + 60_000).toISOString(), publicationId);
  return publicationId;
}
