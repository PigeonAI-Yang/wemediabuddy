// WMB-5334 focused: yesterday iteration both sources — draft_revision & published_revision
// Verify: one new local version each, no overwrite, no platform side effect, no quota consumption, idempotent/revision-safe
// Run: node --test tests/wmb-5334-yesterday-iteration.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const iter = await import('../src/main/daily-iteration.ts');
const cycleMod = await import('../src/main/daily-content-cycle.ts');

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5334-'));
  try { return work(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}
function migrateFresh(dir) {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  db.prepare("INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('workspace_id','ws-5334','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
  return db;
}
function makeDraftProject(db, status='drafting') {
  const topicId = `topic-${randomUUID().slice(0,6)}`;
  const projId = `proj-${randomUUID().slice(0,6)}`;
  const cvId = `cv-${randomUUID().slice(0,6)}`;
  db.prepare("INSERT INTO topics (id,title,created_at,updated_at,revision) VALUES (?,?,?, ?,1)").run(topicId, 't','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z');
  db.prepare("INSERT INTO content_projects (id, topic_id, title, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,1)").run(projId, topicId, 'draft title', status,'2026-08-22T00:00:00Z','2026-08-22T00:00:00Z');
  db.prepare("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?,?,?,?,?)").run(cvId, projId, 'orig body draft',1,'2026-08-22T00:00:00Z');
  return { topicId, projId, cvId };
}
function makePublishedProject(db) {
  const { projId, cvId } = makeDraftProject(db, 'completed');
  // platform version
  const pvId = `pv-${randomUUID().slice(0,6)}`;
  db.prepare("INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,1)").run(pvId, projId, cvId, 'x','post','t','body','[]','2026-08-22T01:00:00Z','2026-08-22T01:00:00Z');
  const accId = `acc-${randomUUID().slice(0,6)}`;
  db.prepare("INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, evidence_url, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,1)").run(accId, 'x','k1','n','authenticated','https://x.com/n','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z');
  const pubId = `pub-${randomUUID().slice(0,6)}`;
  db.prepare("INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status, prepared_assets_json, external_url, external_id, published_at, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)").run(pubId, pvId, 1, 'x', accId, 'k1','published','[]','https://x.com/p','ext1','2026-08-22T02:00:00Z','2026-08-22T02:00:00Z','2026-08-22T02:00:00Z');
  // metric snapshot + review for aggregation
  db.prepare("INSERT INTO publication_metric_snapshots (id, publication_id, scheduled_for, captured_at, source_url, normalized_json, raw_json, created_at) VALUES (?,?,?,?,?,?,?,?)").run(`snap-${randomUUID().slice(0,6)}`, pubId,'2026-08-22T03:00:00Z','2026-08-22T03:00:00Z','https://x.com/p','{"views":100}','{}','2026-08-22T03:00:00Z');
  const reviewId = `rev-${randomUUID().slice(0,6)}`;
  // need content_version_id for reviews table
  db.prepare("INSERT INTO reviews (id, publication_id, content_version_id, metric_snapshot_ids_json, status, keep_json, stop_json, change_json, summary, created_at, updated_at, finalized_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)").run(reviewId, pubId, cvId,'[]','final','["keep a"]','["stop b"]','["change c: add evidence"]','s','2026-08-22T04:00:00Z','2026-08-22T04:00:00Z','2026-08-22T04:00:00Z');
  return { projId, cvId, pvId, pubId, reviewId, accId };
}

test('WMB-5334 draft_revision: one new local version, no overwrite, no platform side effect, no quota', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const businessDate = '2026-08-23';
    const { projId, cvId } = makeDraftProject(db, 'drafting');
    // ensure cycle exists with some targetCount (default 2) and no new_content targets yet -> gap
    const beforeCycle = iter.ensureDraftRevisionTargetInternal(db, { businessDate, projectId: projId, predecessorContentVersionId: cvId, predecessorTargetId: null });
    assert.equal(beforeCycle.target_kind, 'draft_revision');
    assert.equal(Number(beforeCycle.counts_toward_goal), 0);
    // create iteration version (append-only)
    const pvCountBefore = Number(db.prepare('SELECT COUNT(*) as c FROM platform_versions').get().c);
    const pubCountBefore = Number(db.prepare('SELECT COUNT(*) as c FROM publications').get().c);
    const verBefore = Number(db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(projId).c);
    assert.equal(verBefore, 1);
    const newVer = iter.createIterationContentVersionInternal(db, { projectId: projId, predecessorContentVersionId: cvId, body: 'revised draft body v2' });
    const verAfter = Number(db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(projId).c);
    assert.equal(verAfter, 2);
    // original preserved
    const orig = db.prepare('SELECT body FROM content_versions WHERE id=?').get(cvId);
    assert.equal(orig.body, 'orig body draft');
    assert.notEqual(newVer.id, cvId);
    // no platform side effect
    assert.equal(Number(db.prepare('SELECT COUNT(*) as c FROM platform_versions').get().c), pvCountBefore);
    assert.equal(Number(db.prepare('SELECT COUNT(*) as c FROM publications').get().c), pubCountBefore);
    // no quota consumption: shortage gap computed only from new_content
    const proj = cycleMod.getDailyCycleProjection(db, businessDate);
    // draft_revision should not count toward selectedCount
    assert.equal(proj.shortage.selectedCount, 0);
    assert.equal(proj.shortage.targetCount, 2);
    assert.equal(proj.shortage.remainingGap, 2);
    // idempotent second ensure same predecessor returns same target (no duplicate)
    const second = iter.ensureDraftRevisionTargetInternal(db, { businessDate, projectId: projId, predecessorContentVersionId: cvId });
    assert.equal(String(second.id), String(beforeCycle.id));
    const cnt = Number(db.prepare('SELECT COUNT(*) as c FROM daily_content_targets WHERE cycle_id=? AND target_kind=?').get(beforeCycle.cycle_id, 'draft_revision').c);
    assert.equal(cnt, 1);
    // projection contains it
    const yesterday = iter.getYesterdayIterationProjection(db, businessDate);
    assert.equal(yesterday.draftIterations.length, 1);
    assert.equal(yesterday.publishedIterations.length, 0);
  } finally { db.close(); }
}));

test('WMB-5334 published_revision: one new local version, no overwrite, no platform side effect, no quota, idempotent', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const businessDate = '2026-08-23';
    const { projId, cvId, pubId } = makePublishedProject(db);
    const pvBefore = Number(db.prepare('SELECT COUNT(*) as c FROM platform_versions').get().c);
    const pubBefore = Number(db.prepare('SELECT COUNT(*) as c FROM publications').get().c);
    const verBefore = Number(db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(projId).c);
    assert.equal(verBefore, 1);
    const target = iter.ensurePublishedRevisionTargetInternal(db, { businessDate, projectId: projId, predecessorPublicationId: pubId, predecessorContentVersionId: cvId });
    assert.equal(target.target_kind, 'published_revision');
    assert.equal(Number(target.counts_toward_goal), 0);
    // context aggregated: should contain review keep/stop/change
    const snap = JSON.parse(String(target.score_snapshot_json));
    assert.ok(snap.reviews && Array.isArray(snap.reviews));
    // create new local version
    const newVer = iter.createIterationContentVersionInternal(db, { projectId: projId, predecessorContentVersionId: cvId, body: 'revised published body v2' });
    assert.notEqual(newVer.id, cvId);
    assert.equal(Number(db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(projId).c), 2);
    // original still there
    assert.equal(db.prepare('SELECT body FROM content_versions WHERE id=?').get(cvId).body, 'orig body draft');
    // no platform publish side effect
    assert.equal(Number(db.prepare('SELECT COUNT(*) as c FROM platform_versions').get().c), pvBefore);
    assert.equal(Number(db.prepare('SELECT COUNT(*) as c FROM publications').get().c), pubBefore);
    // no quota
    const proj = cycleMod.getDailyCycleProjection(db, businessDate);
    assert.equal(proj.shortage.selectedCount, 0);
    assert.equal(proj.shortage.remainingGap, 2);
    // idempotent
    const second = iter.ensurePublishedRevisionTargetInternal(db, { businessDate, projectId: projId, predecessorPublicationId: pubId, predecessorContentVersionId: cvId });
    assert.equal(String(second.id), String(target.id));
    const cnt = Number(db.prepare("SELECT COUNT(*) as c FROM daily_content_targets WHERE target_kind='published_revision'").get().c);
    assert.equal(cnt, 1);
    const yesterday = iter.getYesterdayIterationProjection(db, businessDate);
    assert.equal(yesterday.publishedIterations.length, 1);
  } finally { db.close(); }
}));

test('WMB-5334 revision-safe uniqueness guard: same predecessor in same cycle duplicate rejected via idempotent return', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const d = '2026-08-23';
    const { projId, cvId } = makeDraftProject(db);
    const a = iter.ensureDraftRevisionTargetInternal(db, { businessDate: d, projectId: projId, predecessorContentVersionId: cvId });
    const b = iter.ensureDraftRevisionTargetInternal(db, { businessDate: d, projectId: projId, predecessorContentVersionId: cvId });
    assert.equal(a.id, b.id);
    // new body version still append-only, second version create appends again (not overwrite)
    const v1 = iter.createIterationContentVersionInternal(db, { projectId: projId, predecessorContentVersionId: cvId, body: 'v2' });
    const v2 = iter.createIterationContentVersionInternal(db, { projectId: projId, predecessorContentVersionId: cvId, body: 'v3' });
    assert.notEqual(v1.id, v2.id);
    assert.equal(Number(db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(projId).c), 3);
  } finally { db.close(); }
}));
