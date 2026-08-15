// WMB-5247 聚焦安全测试：引用集保护 / 证据 locator 与视频运行引用计数 / restricted 覆盖证据 /
// 删除门 / staging 清理 / 30 天无引用派生缓存 GC（幂等 + data-root 隔离）/ 设置容量如实报告。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  assetIdFromEvidenceLocator,
  assetReferences,
  classifyAssetKind,
  collectProtectedAssetIds,
  isDerivedAsset,
  mediaAssetStorageReport,
  mediaStagingStorageReport,
  MEDIA_STAGING_RELATIVE_DIR,
  MEDIA_STAGING_PART_SUFFIX,
  planDerivedCacheGc,
  resolveAssetFileWithinDataRoot,
  runDerivedCacheGc,
  runStagingCleanup,
  sourceAssetReferenceSummary,
  sourceDeleteGate
} from '../src/main/media-governance.ts';
import {
  canAcceptMediaBinding,
  canAutoSuggestMedia,
  classifyRightsStatus,
  hasRestrictedOverride,
  recordRestrictedOverride,
  requireRestrictedOverride
} from '../src/main/media-rights.ts';
import { deleteKnowledgeSource } from '../src/main/knowledge.ts';
import { readSettings } from '../src/main/settings.ts';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;

async function setupDataRoot() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-gov-'));
  const root = path.join(parent, 'data');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  const db = migrateDatabase(path.join(root, 'wmb.db'));
  db.exec('PRAGMA foreign_keys = OFF');
  const now = new Date().toISOString();
  const insert = (sql, ...args) => db.prepare(sql).run(...args);
  const asset = (opts = {}) => {
    const id = opts.id ?? randomUUID();
    const createdAt = opts.createdAt ?? now;
    insert(
      `INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, width, height, duration_ms, created_at, updated_at, revision)
       VALUES (?, ?, 'application/octet-stream', ?, ?, ?, NULL, NULL, NULL, ?, ?, 1)`,
      id, opts.relativePath ?? `assets/${id}.bin`, opts.byteCount ?? 16, opts.sha ?? sha(id), opts.origin ?? 'test', createdAt, createdAt
    );
    return id;
  };
  const source = (opts = {}) => {
    const id = opts.id ?? randomUUID();
    const url = opts.url ?? `https://example.com/${id}`;
    insert(
      `INSERT INTO source_items (id, feed_id, original_url, canonical_url, title, author, published_at, collected_at, summary, categories_json, keywords_json, value_judgment, ip_relevance, creation_angles, recommended_platforms_json, recommended_formats_json, timeliness, priority, evidence, client_label, created_at, updated_at, revision)
       VALUES (?, NULL, ?, ?, ?, NULL, NULL, ?, NULL, '[]', '[]', NULL, NULL, '[]', '[]', '[]', NULL, NULL, NULL, NULL, ?, ?, 1)`,
      id, url, url, opts.title ?? '标题', now, now, now
    );
    return { id, revision: 1, revisionKey: `source:${id}:r1` };
  };
  const provenance = (opts) => {
    insert(
      `INSERT INTO asset_provenance (id, asset_id, kind, origin, source_asset_id, derived_asset_id, transform_json, source_url, source_revision_id, generator, generation_prompt, generation_model, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      opts.id ?? randomUUID(), opts.assetId, opts.kind, opts.origin ?? 'test', opts.sourceAssetId ?? null,
      opts.derivedAssetId ?? null, opts.transformJson ?? null, now
    );
  };
  const writeAssetFile = async (relativePath, content = 'x') => {
    const filePath = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return filePath;
  };
  return { parent, root, db, now, insert, asset, source, provenance, writeAssetFile };
}

test('引用集：每类引用都保护 Asset；证据 locator 与视频运行引用计入', async () => {
  const { parent, root, db, insert, asset, source, provenance, now } = await setupDataRoot();
  try {
    const s1 = source();
    const revKey = s1.revisionKey;
    // source_binding
    const a1 = asset({ id: 'a-1' });
    insert(`INSERT INTO source_media_candidates (id, source_id, source_revision_key, kind, original_url, stable_remote_identity, channel, ordinal, status, attempt_count, max_attempts, discovered_at)
      VALUES (?, ?, ?, 'image', ?, ?, 'research', 0, 'preserved', 0, 3, ?)`, 'smc-1', s1.id, revKey, 'https://x/1', sha('u1'), now);
    insert(`INSERT INTO source_media_bindings (id, source_id, source_revision_key, candidate_id, asset_id, kind, ordinal, original_url, sha256, captured_at, rights_status, risk_flags_json, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, 'image', 0, 'https://x/1', ?, ?, 'unknown', '[]', ?, 'test')`,
      'sbm-1', s1.id, revKey, 'smc-1', a1, sha('a1'), now, now);
    // content_binding
    const a2 = asset({ id: 'a-2' });
    const p = randomUUID(); const cv = randomUUID();
    insert('INSERT INTO content_projects (id, topic_id, plan_item_id, title, created_at, updated_at, revision) VALUES (?, NULL, NULL, ?, ?, ?, 1)', p, '项目', now, now);
    insert('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 1, ?)', cv, p, 'body', now);
    insert(`INSERT INTO content_media_bindings (id, content_version_id, asset_id, ordinal, occurrence, width_preset, align, caption, link_url, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, 'full', 'center', NULL, NULL, ?, ?)`, 'cmb-1', cv, a2, now, now);
    // platform_binding（asset_id + derived_asset_id + poster_asset_id 三列都算）
    const a3 = asset({ id: 'a-3' }); const a4 = asset({ id: 'a-4' }); const a5 = asset({ id: 'a-5' });
    const pv = randomUUID();
    insert(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
      VALUES (?, ?, ?, 'x', 'text', NULL, 'body', '[]', ?, ?, 1)`, pv, p, cv, now, now);
    insert(`INSERT INTO platform_media_bindings (id, platform_version_id, asset_id, ordinal, is_cover, derived_asset_id, poster_asset_id, media_kind, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, ?, ?, 'video', ?, ?)`, 'pmb-1', pv, a3, a4, a5, now, now);
    // publication_snapshot
    const a6 = asset({ id: 'a-6' });
    insert(`INSERT INTO publication_snapshots (id, publication_id, workspace_id, runtime_epoch, platform_version_id, platform_version_revision, platform, account_id, account_key, account_revision, browser_binding_id, browser_profile_id, browser_binding_revision, payload_json, payload_hash, assets_json, assets_hash, input_hash, causation_json, created_at)
      VALUES (?, 'pub-1', 'ws-1', 'epoch-1', ?, 1, 'x', 'acc-1', 'acc', 1, 'effective', 'prof-1', 1, '{}', ?, ?, ?, ?, '{}', ?)`,
      'snap-1', pv, sha('payload'), JSON.stringify([a6]), sha('assets'), sha('input'), now);
    // project_link
    const a7 = asset({ id: 'a-7' });
    insert('INSERT INTO content_project_assets (project_id, asset_id, created_at) VALUES (?, ?, ?)', p, a7, now);
    // provenance source 端（派生行指向原图）
    const a9 = asset({ id: 'a-9' });
    const a8 = asset({ id: 'a-8' });
    provenance({ assetId: a8, kind: 'derived_keyframe', sourceAssetId: a9, derivedAssetId: a8, transformJson: '{"timeMs":0,"width":100,"height":100}' });
    // video run（原视频列 + keyframes_json.frames[].assetId + segments_json[].keyframeAssetId）
    const a10 = asset({ id: 'a-10' }); const a11 = asset({ id: 'a-11' });
    insert(`INSERT INTO video_understanding_runs (id, source_id, source_revision_key, asset_id, schema_version, attempt, status, stage, keyframes_json, segments_json, created_at)
      VALUES (?, ?, ?, ?, 1, 1, 'completed', 'summarize', ?, ?, ?)`,
      'vur-1', s1.id, revKey, a10, JSON.stringify({ frames: [{ index: 0, timeMs: 0, assetId: a11, width: 100, height: 100 }] }),
      JSON.stringify([{ index: 0, startMs: 0, endMs: 1000, keyframeAssetId: a11 }]), now);
    // image run
    const a12 = asset({ id: 'a-12' });
    insert(`INSERT INTO knowledge_visual_runs (id, source_id, source_revision_id, asset_id, schema_version, attempt, status, prompt_version, created_at)
      VALUES (?, ?, ?, ?, 1, 1, 'queued', 1, ?)`, 'vr-1', s1.id, revKey, a12, now);
    // evidence locator（图片整图/区域 + 视频 timeRange 均计入）
    const a13 = asset({ id: 'a-13' }); const a14 = asset({ id: 'a-14' });
    insert(`INSERT INTO knowledge_evidence_links (id, knowledge_note_version_id, evidence_object_type, evidence_object_id, relation, source_nature, excerpt, locator, observed_at, creator_nature, change_set_id, created_at)
      VALUES (?, 'nv-1', 'source', ?, 'supports', 'primary_source', '', ?, ?, 'system', 'cs-1', ?)`,
      'ev-1', s1.id, `asset:${a13}|sourceRevision:${revKey}`, now, now);
    insert(`INSERT INTO knowledge_evidence_links (id, knowledge_note_version_id, evidence_object_type, evidence_object_id, relation, source_nature, excerpt, locator, observed_at, creator_nature, change_set_id, created_at)
      VALUES (?, 'nv-1', 'source', ?, 'supports', 'primary_source', '', ?, ?, 'system', 'cs-1', ?)`,
      'ev-2', s1.id, `asset:${a14}|sourceRevision:${revKey}|timeRange:1000-3000`, now, now);

    // 单类断言
    assert.ok(assetReferences(db, a1).some((r) => r.class === 'source_binding' && r.table === 'source_media_bindings'));
    assert.ok(assetReferences(db, a2).some((r) => r.class === 'content_binding'));
    assert.ok(assetReferences(db, a3).some((r) => r.class === 'platform_binding' && r.detail === 'asset_id'));
    assert.ok(assetReferences(db, a4).some((r) => r.class === 'platform_binding' && r.detail === 'derived_asset_id'));
    assert.ok(assetReferences(db, a5).some((r) => r.class === 'platform_binding' && r.detail === 'poster_asset_id'));
    assert.ok(assetReferences(db, a6).some((r) => r.class === 'publication_snapshot'));
    assert.ok(assetReferences(db, a7).some((r) => r.class === 'project_link'));
    assert.ok(assetReferences(db, a9).some((r) => r.class === 'provenance' && r.detail === 'source'));
    assert.equal(assetReferences(db, a8).length, 0, '派生资产自身 provenance identity 行不保护自己');
    assert.ok(assetReferences(db, a10).some((r) => r.class === 'video_run'));
    assert.ok(assetReferences(db, a11).some((r) => r.class === 'video_run'), 'video run 关键帧 JSON 引用计入');
    assert.ok(assetReferences(db, a12).some((r) => r.class === 'image_run'));
    assert.ok(assetReferences(db, a13).some((r) => r.class === 'evidence_locator'));
    assert.ok(assetReferences(db, a14).some((r) => r.class === 'evidence_locator'), '视频 timeRange locator 引用计入');

    // 完整受保护集合：除 a8（自身身份行）外全部在列
    const protectedIds = collectProtectedAssetIds(db);
    for (const id of [a1, a2, a3, a4, a5, a6, a7, a9, a10, a11, a12, a13, a14]) {
      assert.ok(protectedIds.has(id), `受保护集合应包含 ${id}`);
    }
    assert.ok(!protectedIds.has(a8), '无外部引用的派生资产不在受保护集合');

    // locator 严格解析
    assert.equal(assetIdFromEvidenceLocator(`asset:${a13}|sourceRevision:${revKey}`), a13);
    assert.equal(assetIdFromEvidenceLocator(`asset:${a13}|sourceRevision:${revKey}|region:0,0,0.5,0.5`), a13);
    assert.equal(assetIdFromEvidenceLocator(`asset:${a14}|sourceRevision:${revKey}|timeRange:1000-3000`), a14);
    assert.equal(assetIdFromEvidenceLocator('url:https://x'), null);
    assert.equal(assetIdFromEvidenceLocator(''), null);
    assert.equal(assetIdFromEvidenceLocator(null), null);

    // 分类
    assert.equal(classifyAssetKind(db, a1), 'original');
    assert.equal(classifyAssetKind(db, a8), 'derived');
    assert.ok(isDerivedAsset(db, a8));
    assert.ok(!isDerivedAsset(db, a1));
  } finally {
    db.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('删除门：无外部引用放行；有引用阻止普通删除并要求显式确认；永不删除素材字节', async () => {
  const { parent, root, db, insert, asset, source, now } = await setupDataRoot();
  try {
    const s2 = source();
    const revKey = s2.revisionKey;
    const b1 = asset({ id: 'b-1' });
    insert(`INSERT INTO source_media_candidates (id, source_id, source_revision_key, kind, original_url, stable_remote_identity, channel, ordinal, status, attempt_count, max_attempts, discovered_at)
      VALUES (?, ?, ?, 'image', 'https://x/2', ?, 'research', 0, 'preserved', 0, 3, ?)`, 'smc-2', s2.id, revKey, sha('u2'), now);
    insert(`INSERT INTO source_media_bindings (id, source_id, source_revision_key, candidate_id, asset_id, kind, ordinal, original_url, sha256, captured_at, rights_status, risk_flags_json, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, 'image', 0, 'https://x/2', ?, ?, 'unknown', '[]', ?, 'test')`,
      'sbm-2', s2.id, revKey, 'smc-2', b1, sha('b1'), now, now);

    // 仅自身绑定 → 允许删除
    let gate = sourceDeleteGate(db, s2.id, {});
    assert.equal(gate.allowed, true);
    assert.equal(gate.summary.totalReferences, 0);

    // 加入外部引用（核心正文绑定）→ 阻止普通删除
    const p = randomUUID(); const cv = randomUUID();
    insert('INSERT INTO content_projects (id, topic_id, plan_item_id, title, created_at, updated_at, revision) VALUES (?, NULL, NULL, ?, ?, ?, 1)', p, '项目', now, now);
    insert("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, 'body', 1, ?)", cv, p, now);
    insert(`INSERT INTO content_media_bindings (id, content_version_id, asset_id, ordinal, occurrence, width_preset, align, caption, link_url, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, 'full', 'center', NULL, NULL, ?, ?)`, 'cmb-2', cv, b1, now, now);

    gate = sourceDeleteGate(db, s2.id, {});
    assert.equal(gate.allowed, false);
    assert.match(gate.blockedReason, /^SOURCE_DELETE_BLOCKED_REFERENCED_ASSETS:/);
    assert.equal(gate.summary.totalReferences, 1);
    assert.equal(gate.summary.byClass.content_binding, 1);
    assert.equal(sourceAssetReferenceSummary(db, s2.id).assets[0].references[0].class, 'content_binding');

    // deleteKnowledgeSource 拒绝普通删除（带稳定错误码与摘要）
    assert.throws(() => deleteKnowledgeSource(db, { id: s2.id, expectedRevision: s2.revision }, false, false), (error) => {
      assert.equal(error.code, 'SOURCE_DELETE_BLOCKED_REFERENCED_ASSETS');
      assert.ok(error.details.summary);
      return true;
    });
    assert.ok(db.prepare('SELECT 1 FROM source_items WHERE id=?').get(s2.id), '被阻止时 Source 仍在');
    assert.ok(db.prepare('SELECT 1 FROM assets WHERE id=?').get(b1), '被阻止时 Asset 仍在');

    // 显式确认（forceReferencedDelete）→ 删除 Source 关系，素材字节保留
    const result = deleteKnowledgeSource(db, { id: s2.id, expectedRevision: s2.revision }, false, false, { forceReferencedDelete: true });
    assert.equal(result.deleted, true);
    assert.equal(db.prepare('SELECT 1 FROM source_items WHERE id=?').get(s2.id), undefined, 'Source 关系已删除');
    assert.ok(db.prepare('SELECT 1 FROM assets WHERE id=?').get(b1), 'Asset 字节/行永不随 Source 删除');
    assert.ok(db.prepare('SELECT 1 FROM content_media_bindings WHERE asset_id=?').get(b1), '外部绑定关系不受影响');
  } finally {
    db.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('restricted：禁止自动建议；采用需显式所有者确认并落证据；幂等', async () => {
  const { parent, db, insert, asset, source, now } = await setupDataRoot();
  try {
    const s3 = source();
    const revKey = s3.revisionKey;
    const a = asset({ id: 'r-a' });
    insert(`INSERT INTO source_media_candidates (id, source_id, source_revision_key, kind, original_url, stable_remote_identity, channel, ordinal, status, attempt_count, max_attempts, discovered_at)
      VALUES (?, ?, ?, 'image', 'https://x/3', ?, 'research', 0, 'preserved', 0, 3, ?)`, 'smc-3', s3.id, revKey, sha('u3'), now);
    insert(`INSERT INTO source_media_bindings (id, source_id, source_revision_key, candidate_id, asset_id, kind, ordinal, original_url, sha256, captured_at, rights_status, risk_flags_json, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, 'image', 0, 'https://x/3', ?, ?, 'restricted', '["third_party_repost"]', ?, 'test')`,
      'sbm-3', s3.id, revKey, 'smc-3', a, sha('a'), now, now);
    const ok = asset({ id: 'r-ok' });
    insert(`INSERT INTO source_media_bindings (id, source_id, source_revision_key, candidate_id, asset_id, kind, ordinal, original_url, sha256, captured_at, rights_status, risk_flags_json, created_at, created_by)
      VALUES (?, ?, ?, 'smc-4', ?, 'image', 1, 'https://x/4', ?, ?, 'unknown', '[]', ?, 'test')`,
      'sbm-4', s3.id, revKey, ok, sha('ok'), now, now);

    // 分类
    assert.equal(classifyRightsStatus(['third_party_repost']), 'restricted');
    assert.equal(classifyRightsStatus(['paywalled']), 'restricted');
    assert.equal(classifyRightsStatus(['copyright']), 'permission_required');
    assert.equal(classifyRightsStatus(['portrait', 'privacy']), 'permission_required');
    assert.equal(classifyRightsStatus([]), 'unknown');
    // 建议门
    assert.equal(canAutoSuggestMedia('restricted'), false);
    assert.equal(canAutoSuggestMedia('unknown'), true);
    assert.equal(canAutoSuggestMedia('permission_required'), true);
    // 采用门
    assert.equal(canAcceptMediaBinding(db, 'sbm-4').allowed, true);
    assert.equal(canAcceptMediaBinding(db, 'sbm-3').allowed, false);
    assert.equal(canAcceptMediaBinding(db, 'sbm-3', { confirmedByOwner: true }).allowed, false, '无证据时即使 confirmedByOwner 也 blocked');
    assert.throws(() => requireRestrictedOverride(db, 'sbm-3'), (e) => e.code === 'RIGHTS_RESTRICTED_OVERRIDE_REQUIRED');
    // 非 restricted 不能写覆盖证据
    assert.throws(() => recordRestrictedOverride(db, { bindingId: 'sbm-4', reason: 'x', confirmedBy: 'owner-ui', requestId: 'rq-0' }), /NOT_RESTRICTED_BINDING/);
    // 显式确认 → 证据落库 + operation_log 审计
    const first = recordRestrictedOverride(db, { bindingId: 'sbm-3', reason: '所有者显式确认用于评测', confirmedBy: 'owner-ui', requestId: 'rq-1' });
    assert.equal(first.bindingId, 'sbm-3');
    assert.equal(first.assetId, a);
    assert.equal(first.sourceRevisionKey, revKey);
    assert.equal(first.confirmedBy, 'owner-ui');
    assert.equal(hasRestrictedOverride(db, 'sbm-3'), true);
    assert.ok(canAcceptMediaBinding(db, 'sbm-3', { confirmedByOwner: true }).allowed, '有证据后 owner 确认可放行');
    assert.doesNotThrow(() => requireRestrictedOverride(db, 'sbm-3'));
    const audit = db.prepare("SELECT 1 FROM operation_log WHERE command='media.rights_override' AND entity_type='source_media_binding' AND entity_id='sbm-3' AND result='ok'").get();
    assert.ok(audit, 'operation_log 写入覆盖审计');
    // 幂等：重复确认返回既有行，不重复写
    const second = recordRestrictedOverride(db, { bindingId: 'sbm-3', reason: '再次确认', confirmedBy: 'owner-ui', requestId: 'rq-2' });
    assert.equal(second.id, first.id);
    const rows = db.prepare("SELECT count(*) AS count FROM media_rights_overrides WHERE binding_id='sbm-3'").get();
    assert.equal(rows.count, 1);
  } finally {
    db.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('GC：仅回收超期无引用派生缓存；原始/已采用/证据引用/新鲜派生永不清理；幂等且 data-root 隔离', async () => {
  const { parent, root, db, insert, asset, provenance, writeAssetFile } = await setupDataRoot();
  try {
    const oldIso = new Date(Date.now() - 40 * DAY_MS).toISOString();
    const nowIso = new Date().toISOString();
    const fixedNow = new Date();
    const revKey = 'source:gc:r1';
    const sId = 'gc-src';
    insert(`INSERT INTO source_items (id, feed_id, original_url, canonical_url, title, author, published_at, collected_at, summary, categories_json, keywords_json, value_judgment, ip_relevance, creation_angles, recommended_platforms_json, recommended_formats_json, timeliness, priority, evidence, client_label, created_at, updated_at, revision)
      VALUES (?, NULL, ?, ?, 'GC', NULL, NULL, ?, NULL, '[]', '[]', NULL, NULL, '[]', '[]', '[]', NULL, NULL, NULL, NULL, ?, ?, 1)`,
      sId, 'https://example.com/gc', 'https://example.com/gc', nowIso, nowIso, nowIso);
    // 原始（imported）→ 永不清理
    const originalOld = asset({ id: 'gc-orig', createdAt: oldIso, byteCount: 100 });
    provenance({ assetId: originalOld, kind: 'imported', origin: 'source-preserve' });
    await writeAssetFile(`assets/${originalOld}.bin`, 'original');
    // 超期无引用派生 → 可回收
    const derivedOld = asset({ id: 'gc-der-old', createdAt: oldIso, byteCount: 50 });
    provenance({ assetId: derivedOld, kind: 'derived_crop', sourceAssetId: originalOld, derivedAssetId: derivedOld, transformJson: '{}' });
    await writeAssetFile(`assets/${derivedOld}.bin`, 'derived-old');
    // 新鲜派生 → 不回收
    const derivedFresh = asset({ id: 'gc-der-fresh', createdAt: nowIso, byteCount: 50 });
    provenance({ assetId: derivedFresh, kind: 'derived_crop', sourceAssetId: originalOld, derivedAssetId: derivedFresh, transformJson: '{}' });
    await writeAssetFile(`assets/${derivedFresh}.bin`, 'derived-fresh');
    // 已采用派生（平台绑定）→ 永不清理
    const derivedAdopted = asset({ id: 'gc-der-adopted', createdAt: oldIso, byteCount: 50 });
    provenance({ assetId: derivedAdopted, kind: 'derived_keyframe', sourceAssetId: originalOld, derivedAssetId: derivedAdopted, transformJson: '{}' });
    await writeAssetFile(`assets/${derivedAdopted}.bin`, 'adopted');
    const p = randomUUID(); const cv = randomUUID(); const pv = randomUUID();
    insert('INSERT INTO content_projects (id, topic_id, plan_item_id, title, created_at, updated_at, revision) VALUES (?, NULL, NULL, ?, ?, ?, 1)', p, '项目', nowIso, nowIso);
    insert("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, 'body', 1, ?)", cv, p, nowIso);
    insert(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
      VALUES (?, ?, ?, 'x', 'text', NULL, 'body', '[]', ?, ?, 1)`, pv, p, cv, nowIso, nowIso);
    insert(`INSERT INTO platform_media_bindings (id, platform_version_id, asset_id, ordinal, is_cover, derived_asset_id, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?)`, 'pmb-gc', pv, originalOld, derivedAdopted, nowIso, nowIso);
    // 证据 locator 引用 → 永不清理
    const derivedEvidence = asset({ id: 'gc-der-evidence', createdAt: oldIso, byteCount: 50 });
    provenance({ assetId: derivedEvidence, kind: 'derived_clip', sourceAssetId: originalOld, derivedAssetId: derivedEvidence, transformJson: '{}' });
    await writeAssetFile(`assets/${derivedEvidence}.bin`, 'evidence');
    insert(`INSERT INTO knowledge_evidence_links (id, knowledge_note_version_id, evidence_object_type, evidence_object_id, relation, source_nature, excerpt, locator, observed_at, creator_nature, change_set_id, created_at)
      VALUES ('ev-gc', 'nv-1', 'source', ?, 'supports', 'primary_source', '', ?, ?, 'system', 'cs-1', ?)`,
      sId, `asset:${derivedEvidence}|sourceRevision:${revKey}`, nowIso, nowIso);
    // 越界 relative_path → DB 行回收但文件绝不删除（data-root 隔离）
    const derivedEscape = asset({ id: 'gc-der-escape', createdAt: oldIso, byteCount: 50, relativePath: '../escape/evil.bin' });
    provenance({ assetId: derivedEscape, kind: 'derived_transcode', sourceAssetId: originalOld, derivedAssetId: derivedEscape, transformJson: '{}' });
    const escapeFile = path.join(root, '..', 'escape', 'evil.bin');
    await mkdir(path.dirname(escapeFile), { recursive: true });
    await writeFile(escapeFile, 'escape', 'utf8');

    // 规划：只有 gc-der-old 与 gc-der-escape 是候选
    const plan = planDerivedCacheGc(db, root, { now: fixedNow, retentionDays: 30 });
    const planIds = plan.candidates.map((c) => c.assetId).sort();
    assert.deepEqual(planIds, ['gc-der-escape', 'gc-der-old']);
    assert.equal(plan.derivedTotal, 5);
    assert.equal(plan.freshCount, 1);

    // 执行：回收超期无引用派生；其余保留
    const result = await runDerivedCacheGc(db, root, { now: fixedNow, retentionDays: 30 });
    assert.deepEqual(result.collected.map((c) => c.assetId).sort(), ['gc-der-escape', 'gc-der-old']);
    assert.equal(result.removedBytes, 50); // 越界资产文件不删除，只计实际删除字节
    assert.ok(db.prepare('SELECT 1 FROM assets WHERE id=?').get(originalOld), '原始 Source 资产永不自动清理');
    assert.ok(db.prepare('SELECT 1 FROM assets WHERE id=?').get(derivedFresh), '新鲜派生不回收');
    assert.ok(db.prepare('SELECT 1 FROM assets WHERE id=?').get(derivedAdopted), '已采用派生永不回收');
    assert.ok(db.prepare('SELECT 1 FROM assets WHERE id=?').get(derivedEvidence), '证据引用派生永不回收');
    assert.equal(db.prepare('SELECT 1 FROM assets WHERE id=?').get(derivedOld), undefined, '超期无引用派生已回收');
    await assert.rejects(stat(path.join(root, 'assets', `${derivedOld}.bin`)), (e) => e.code === 'ENOENT', '回收资产文件已删除');
    assert.ok(await stat(path.join(root, 'assets', `${originalOld}.bin`)), '原始文件仍在');
    assert.ok(await stat(path.join(root, 'assets', `${derivedAdopted}.bin`)), '已采用文件仍在');
    assert.ok(await stat(escapeFile), '越界文件绝不删除（data-root 隔离）');
    assert.ok(result.errors.some((e) => e.assetId === 'gc-der-escape'), '越界资产记录错误但不删除文件');
    // 幂等：再次运行零候选零回收
    const second = await runDerivedCacheGc(db, root, { now: fixedNow, retentionDays: 30 });
    assert.equal(second.candidates.length, 0);
    assert.equal(second.collected.length, 0);
    // dryRun：不动任何东西
    const dry = await runDerivedCacheGc(db, root, { now: fixedNow, retentionDays: 30, dryRun: true });
    assert.equal(dry.collected.length, 0);
    // resolveAssetFileWithinDataRoot 边界
    assert.equal(resolveAssetFileWithinDataRoot(root, 'assets/x.bin'), path.join(root, 'assets', 'x.bin'));
    assert.equal(resolveAssetFileWithinDataRoot(root, '../escape/evil.bin'), null);
    assert.equal(resolveAssetFileWithinDataRoot(root, 'staging/media/x.part'), null);
  } finally {
    db.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('staging 清理：只删超窗口 .part/.tmp；幂等', async () => {
  const { parent, root } = await setupDataRoot();
  try {
    const stagingDir = path.join(root, MEDIA_STAGING_RELATIVE_DIR);
    const assetsDir = path.join(root, 'assets');
    await mkdir(stagingDir, { recursive: true });
    await mkdir(assetsDir, { recursive: true });
    const oldMs = new Date(Date.now() - 2 * DAY_MS);
    const freshMs = new Date();
    const stalePart = path.join(stagingDir, `media-c.a1.xyz${MEDIA_STAGING_PART_SUFFIX}`);
    const freshPart = path.join(stagingDir, `media-c.a2.abc${MEDIA_STAGING_PART_SUFFIX}`);
    const staleTmp = path.join(assetsDir, 'leftover.tmp');
    await writeFile(stalePart, 'stale');
    await writeFile(freshPart, 'fresh');
    await writeFile(staleTmp, 'tmp');
    await utimes(stalePart, oldMs, oldMs);
    await utimes(freshPart, freshMs, freshMs);
    await utimes(staleTmp, oldMs, oldMs);

    const first = await runStagingCleanup(root, { now: new Date(), maxStaleMs: DAY_MS });
    assert.equal(first.removedFiles, 2, '旧 .part 与 .tmp 被清');
    assert.equal(first.skippedFresh, 1, '新鲜 .part 保留');
    await assert.rejects(stat(stalePart), (e) => e.code === 'ENOENT');
    await assert.rejects(stat(staleTmp), (e) => e.code === 'ENOENT');
    assert.ok(await stat(freshPart), '新鲜文件仍在');

    const second = await runStagingCleanup(root, { now: new Date(), maxStaleMs: DAY_MS });
    assert.equal(second.removedFiles, 0, '幂等：无剩余可删项');
    assert.equal(second.skippedFresh, 1);

    // staging 容量投影如实
    const stagingReport = await mediaStagingStorageReport(root);
    assert.equal(stagingReport.count, 1);
    assert.equal(stagingReport.bytes, 5);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('设置页：原始/派生/staging 数量与字节如实报告', async () => {
  const { parent, root, db, insert, asset, provenance } = await setupDataRoot();
  try {
    const origA = asset({ id: 'set-a', byteCount: 10 });
    provenance({ assetId: origA, kind: 'imported' });
    const origB = asset({ id: 'set-b', byteCount: 20 }); // 无 provenance 行（stageAssetBytes 路径）
    const derA = asset({ id: 'set-c', byteCount: 30 });
    provenance({ assetId: derA, kind: 'derived_crop', sourceAssetId: origA, derivedAssetId: derA, transformJson: '{}' });

    const report = mediaAssetStorageReport(db);
    assert.equal(report.assets.total.count, 3);
    assert.equal(report.assets.total.bytes, 60);
    assert.equal(report.assets.original.count, 2);
    assert.equal(report.assets.original.bytes, 30);
    assert.equal(report.assets.derived.count, 1);
    assert.equal(report.assets.derived.bytes, 30);

    const stagingDir = path.join(root, MEDIA_STAGING_RELATIVE_DIR);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, `x${MEDIA_STAGING_PART_SUFFIX}`), 'hello');

    db.close();
    const settings = await readSettings(root);
    assert.equal(settings.media.assets.total.count, 3);
    assert.equal(settings.media.assets.original.count, 2);
    assert.equal(settings.media.assets.original.bytes, 30);
    assert.equal(settings.media.assets.derived.count, 1);
    assert.equal(settings.media.assets.derived.bytes, 30);
    assert.equal(settings.media.staging.count, 1);
    assert.equal(settings.media.staging.bytes, 5);
    assert.equal(settings.media.retentionDays, 30);
  } finally {
    try { db.close(); } catch { /* already closed */ }
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});