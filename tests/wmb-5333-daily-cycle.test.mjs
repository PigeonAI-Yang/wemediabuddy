// WMB-5333 focused gates: idempotent ensure, quota/shortage, illegal transition, skip/replace, carry once, exact-version completion.
// Verify via: node --test tests/wmb-5333-daily-cycle.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const scoring = await import('../src/main/zhihu-hot-scoring.ts');
const cycleMod = await import('../src/main/daily-content-cycle.ts');
const { setActiveJobSpawner } = await import('../src/main/job-spawner.ts');
setActiveJobSpawner({ spawn: (_request, jobId) => ({ id: jobId }), getHandle: (jobId) => ({ taskId: jobId }), dispose() {} });
const derivativeMod = await import('../src/main/content-derivative.ts');

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5333-'));
  try { return work(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {} }
}
function migrateFresh(dir) {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  db.prepare("INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('workspace_id','ws-5333','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
  return db;
}
function insertSourceWithObservation(db, businessDate, idx, title) {
  const suffix = randomUUID().slice(0,6);
  const sid = `src-${idx}-${suffix}`;
  const feedId = 'feed1';
  db.prepare("INSERT OR IGNORE INTO source_feeds (id,name,created_at,updated_at,revision) VALUES ('feed1','f','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
  const url = `https://www.zhihu.com/question/${100000+idx}-${suffix}`;
  const collectedAt = '2026-08-28T00:00:00.000Z';
  const summary = 'AI 大模型行业技术变化带来明确用户影响、成本冲突和执行窗口。'.repeat(30);
  const excerpt = '该事件包含多方观点、事实证据、现实代价与可执行路径。'.repeat(12);
  db.prepare("INSERT INTO source_items (id, feed_id, original_url, canonical_url, title, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)").run(
    sid, feedId, url, url, title, collectedAt, summary, JSON.stringify(['AI','大模型','技术','行业']),'[]','[]','[]',collectedAt,collectedAt
  );
  db.prepare("INSERT INTO zhihu_hot_observations (id, source_item_id, business_date, rank, question_title_snapshot, question_url_snapshot, heat_text, excerpt_snapshot, collected_at, input_fingerprint, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    `obs-${sid}`, sid, businessDate, idx, title, url, '2万热度', excerpt, collectedAt, `fp-${sid}`, collectedAt
  );
  return sid;
}
function makeProjectWithArticle(db, status='ready') {
  const topicId = `topic-${randomUUID().slice(0,6)}`;
  const projId = `proj-${randomUUID().slice(0,6)}`;
  const cvId = `cv-${randomUUID().slice(0,6)}`;
  db.prepare("INSERT INTO topics (id,title,created_at,updated_at,revision) VALUES (?,?,?, ?,1)").run(topicId, 't','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z');
  db.prepare("INSERT INTO content_projects (id, topic_id, title, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,1)").run(projId, topicId, 'title', status,'2026-08-22T00:00:00Z','2026-08-22T00:00:00Z');
  db.prepare("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?,?,?,?,?)").run(cvId, projId, 'body',1,'2026-08-22T00:00:00Z');
  return { topicId, projId, cvId };
}
function assignProjectToTarget(db, targetId, projId) {
  db.prepare("UPDATE daily_content_targets SET project_id=?, updated_at=? WHERE id=?").run(projId, new Date().toISOString(), targetId);
  return db.prepare("SELECT * FROM daily_content_targets WHERE id=?").get(targetId);
}
test('idempotent ensure: repeated ensure creates no duplicate target', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const d = '2026-08-22';
    insertSourceWithObservation(db, d, 1, 'Q1');
    insertSourceWithObservation(db, d, 2, 'Q2');
    const first = cycleMod.ensureDailyCycleInternal(db, d);
    const count1 = db.prepare('SELECT COUNT(*) as c FROM daily_content_targets WHERE cycle_id=?').get(first.cycle.id).c;
    const second = cycleMod.ensureDailyCycleInternal(db, d);
    const count2 = db.prepare('SELECT COUNT(*) as c FROM daily_content_targets WHERE cycle_id=?').get(second.cycle.id).c;
    assert.equal(first.cycle.id, second.cycle.id);
    assert.equal(count1, count2);
    assert.equal(count1, 2);
  } finally { db.close(); }
}));

test('default 2 / configured quota respected (shortage truthful, no fake)', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    // default targetCount is 2 from scoring defaults
    assert.equal(scoring.getScoringSettings(db).targetCount, 2);
    // shortage: only 1 candidate for 2026-08-23 => gap 1, partial, 1 target only
    insertSourceWithObservation(db, '2026-08-23', 1, 'Only One');
    const res = cycleMod.ensureDailyCycleInternal(db, '2026-08-23');
    assert.equal(res.cycle.target_count, 2);
    assert.equal(res.cycle.status, 'partial');
    assert.equal(res.shortage.remainingGap, 1);
    assert.equal(res.targets.length, 1);
    // no fake targets: count equals selectedCount
    // configured quota: set to 1 then ensure new date with 2 candidates => only 1 selected
    scoring.setScoringSettings(db, { targetCount: 1 });
    insertSourceWithObservation(db, '2026-08-24', 1, 'A');
    insertSourceWithObservation(db, '2026-08-24', 2, 'B');
    const res2 = cycleMod.ensureDailyCycleInternal(db, '2026-08-24');
    assert.equal(res2.cycle.target_count, 1);
    assert.equal(res2.targets.length, 1);
    assert.equal(res2.shortage.remainingGap, 0);
  } finally { db.close(); }
}));

test('shortage is truthful: zero candidates -> partial with gap, no targets', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const res = cycleMod.ensureDailyCycleInternal(db, '2026-08-25');
    assert.equal(res.targets.length, 0);
    assert.equal(res.cycle.status, 'partial');
    assert.equal(res.shortage.remainingGap, 2);
    assert.equal(res.cycle.last_error_code, 'CANDIDATE_SHORTAGE');
  } finally { db.close(); }
}));

test('retry fills an existing shortage after sources arrive without duplicating targets', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const businessDate = '2026-08-25';
    const empty = cycleMod.ensureDailyCycleInternal(db, businessDate);
    assert.equal(empty.shortage.remainingGap, 2);
    const firstSourceId = insertSourceWithObservation(db, businessDate, 1, 'Late Q1');
    insertSourceWithObservation(db, businessDate, 2, 'Late Q2');
    db.prepare("INSERT INTO zhihu_hot_observations (id, source_item_id, business_date, rank, question_title_snapshot, question_url_snapshot, collected_at, input_fingerprint, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
      `obs-repeat-${firstSourceId}`, firstSourceId, businessDate, 3, 'Late Q1 repeat', `https://www.zhihu.com/question/repeat-${firstSourceId}`, '2026-08-22T02:00:00Z', `fp-repeat-${firstSourceId}`, '2026-08-22T02:00:00Z'
    );
    const filled = cycleMod.ensureDailyCycleInternal(db, businessDate);
    assert.equal(filled.cycle.id, empty.cycle.id);
    assert.equal(filled.targets.length, 2);
    assert.equal(filled.shortage.remainingGap, 0);
    const repeated = cycleMod.ensureDailyCycleInternal(db, businessDate);
    assert.equal(repeated.targets.length, 2);
  } finally { db.close(); }
}));

test('illegal transition is rejected and revision conflict detected', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    insertSourceWithObservation(db, '2026-08-26', 1, 'Q');
    const res = cycleMod.ensureDailyCycleInternal(db, '2026-08-26');
    const t = res.targets[0];
    // illegal: selected -> completed directly must fail (LEGAL check before completion precondition)
    assert.throws(() => cycleMod.transitionTargetInternal(db, { targetId: t.id, expectedRevision: Number(t.revision), toStatus: 'completed' }), (e) => e.code === 'ILLEGAL_TRANSITION' || e.code === 'COMPLETION_PRECONDITION');
    // valid: selected -> researching
    const after = cycleMod.transitionTargetInternal(db, { targetId: t.id, expectedRevision: Number(t.revision), toStatus: 'researching' });
    assert.equal(after.status, 'researching');
    // revision conflict: stale revision
    assert.throws(() => cycleMod.transitionTargetInternal(db, { targetId: t.id, expectedRevision: Number(t.revision), toStatus: 'drafting' }), (e)=> e.code==='REVISION_CONFLICT');
  } finally { db.close(); }
}));

test('skip/replace semantics: quota respected and auditability preserved', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    insertSourceWithObservation(db, '2026-08-27', 1, 'Q1');
    insertSourceWithObservation(db, '2026-08-27', 2, 'Q2');
    const feedExtra = insertSourceWithObservation(db, '2026-08-27', 3, 'Q3-replacement');
    const res = cycleMod.ensureDailyCycleInternal(db, '2026-08-27');
    const t1 = res.targets[0];
    // skip
    const skipped = cycleMod.skipTargetInternal(db, { targetId: t1.id, expectedRevision: Number(t1.revision) });
    assert.equal(skipped.status, 'skipped');
    // cannot skip again
    assert.throws(() => cycleMod.skipTargetInternal(db, { targetId: t1.id, expectedRevision: Number(skipped.revision) }));
    // replace: remaining target
    const t2 = db.prepare('SELECT * FROM daily_content_targets WHERE cycle_id=? AND status=?').get(res.cycle.id, 'selected');
    const replaced = cycleMod.replaceTargetInternal(db, { targetId: t2.id, expectedRevision: Number(t2.revision), replacementSourceItemId: feedExtra });
    assert.equal(replaced.replaced.status, 'skipped');
    assert.equal(replaced.created.source_item_id, feedExtra);
    // auditability: old row still exists as skipped, not deleted
    const cnt = db.prepare('SELECT COUNT(*) as c FROM daily_content_targets WHERE cycle_id=?').get(res.cycle.id).c;
    assert.equal(cnt, 3); // 1 skipped via skip + 1 original skipped via replace + 1 new
    // active quota still respects original target_count (1 active + 1 skipped counted? active = 1)
    const proj = cycleMod.getDailyCycleProjection(db, '2026-08-27');
    assert.equal(proj.shortage.targetCount, 2);
    // active effective = 1 (since one still selected, one skipped) => gap 1 truthful
    assert.equal(proj.shortage.remainingGap, 1);
  } finally { db.close(); }
}));

test('carry once: second carry fails', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    insertSourceWithObservation(db, '2026-08-28', 1, 'Carry Q');
    const res = cycleMod.ensureDailyCycleInternal(db, '2026-08-28');
    const t = res.targets[0];
    const first = cycleMod.carryTargetInternal(db, { targetId: t.id, expectedRevision: Number(t.revision), nextBusinessDate: '2026-08-29' });
    assert.equal(first.carriedFrom.status, 'carried');
    assert.equal(first.carriedTo.carry_depth, 1);
    assert.equal(first.carriedTo.selection_mode, 'carried');
    // second carry on same original should fail (already carried)
    assert.throws(() => cycleMod.carryTargetInternal(db, { targetId: t.id, expectedRevision: Number(first.carriedFrom.revision), nextBusinessDate: '2026-08-30' }));
    // carry on the carried target should fail (depth 1 limit)
    assert.throws(() => cycleMod.carryTargetInternal(db, { targetId: first.carriedTo.id, expectedRevision: Number(first.carriedTo.revision), nextBusinessDate: '2026-08-30' }));
  } finally { db.close(); }
}));

test('completion only with exact article+ready-script; article-only and script-only remain incomplete; stale script fails', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const biz = '2026-08-30';
    insertSourceWithObservation(db, biz, 1, 'Complete Q');
    const res = cycleMod.ensureDailyCycleInternal(db, biz);
    const t = res.targets[0];
    const { projId, cvId } = makeProjectWithArticle(db, 'ready');
    assignProjectToTarget(db, t.id, projId);
    // Move to scripting via legal steps
    let cur = t;
    cur = cycleMod.transitionTargetInternal(db, { targetId: cur.id, expectedRevision: Number(cur.revision), toStatus: 'researching' });
    cur = cycleMod.transitionTargetInternal(db, { targetId: cur.id, expectedRevision: Number(cur.revision), toStatus: 'drafting' });
    cur = cycleMod.transitionTargetInternal(db, { targetId: cur.id, expectedRevision: Number(cur.revision), toStatus: 'article_ready' });
    cur = cycleMod.transitionTargetInternal(db, { targetId: cur.id, expectedRevision: Number(cur.revision), toStatus: 'scripting' });
    // article-only (no script) => completed should fail
    assert.throws(() => cycleMod.transitionTargetInternal(db, { targetId: cur.id, expectedRevision: Number(cur.revision), toStatus: 'completed' }), (e)=> e.code==='COMPLETION_PRECONDITION');
    // create script draft pointing to exact version but still draft => should still fail
    derivativeMod.saveDerivativeVersionInternal(db, { projectId: projId, sourceContentVersionId: cvId, title: 's', body: 'b', formatDecisionJson: JSON.stringify({ goal: 'explain', audience: 'creators', suitableForm: '观点讲解', reason: 'The source article is an evidence-led explanation with a concise claim structure.', narrativeStructure: 'claim-evidence-conclusion', visualDensity: 'medium', paceAndTone: 'measured' }) });
    assert.throws(() => cycleMod.transitionTargetInternal(db, { targetId: cur.id, expectedRevision: Number(cur.revision), toStatus: 'completed' }));
    // finalize to ready with exact version => now succeeds
    derivativeMod.finalizeDerivativeVersionInternal(db, { projectId: projId });
    const completed = db.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(cur.id);
    assert.equal(completed.status, 'completed');
    // Now test stale: create new article version, same target already completed but stale script should have prevented? New target for stale check
    const biz2 = '2026-08-31';
    insertSourceWithObservation(db, biz2, 1, 'Stale Q');
    const res2 = cycleMod.ensureDailyCycleInternal(db, biz2);
    const t2 = res2.targets[0];
    const { projId: projId2, cvId: cvId1 } = makeProjectWithArticle(db, 'ready');
    assignProjectToTarget(db, t2.id, projId2);
    let c2 = t2;
    c2 = cycleMod.transitionTargetInternal(db, { targetId: c2.id, expectedRevision: Number(c2.revision), toStatus: 'researching' });
    c2 = cycleMod.transitionTargetInternal(db, { targetId: c2.id, expectedRevision: Number(c2.revision), toStatus: 'drafting' });
    c2 = cycleMod.transitionTargetInternal(db, { targetId: c2.id, expectedRevision: Number(c2.revision), toStatus: 'article_ready' });
    c2 = cycleMod.transitionTargetInternal(db, { targetId: c2.id, expectedRevision: Number(c2.revision), toStatus: 'scripting' });
    derivativeMod.saveDerivativeVersionInternal(db, { projectId: projId2, sourceContentVersionId: cvId1, title: 's', body: 'b' });
    derivativeMod.finalizeDerivativeVersionInternal(db, { projectId: projId2 });
    // new article version (simulating writer update after script ready)
    const cvId2 = `cv-${randomUUID().slice(0,6)}`;
    db.prepare("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?,?,?,?,?)").run(cvId2, projId2, 'new body',2,'2026-08-22T03:00:00Z');
    // latest article is now 2, and production stale propagation regresses the completed target to scripting
    derivativeMod.regressStaleTargetsForProject(db, projId2);
    const staleTarget = db.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(c2.id);
    assert.equal(staleTarget.status, 'scripting');
    assert.throws(() => cycleMod.transitionTargetInternal(db, { targetId: staleTarget.id, expectedRevision: Number(staleTarget.revision), toStatus: 'completed' }), (e)=> e.code==='COMPLETION_PRECONDITION');
    // fixing by saving new script pointing to exact new version and finalizing auto-completes the target
    derivativeMod.saveDerivativeVersionInternal(db, { projectId: projId2, sourceContentVersionId: cvId2, title: 's2', body: 'b2' });
    derivativeMod.finalizeDerivativeVersionInternal(db, { projectId: projId2 });
    const completed2 = db.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(c2.id);
    assert.equal(completed2.status, 'completed');
    // script-only without article ready: create project with drafting status, add ready script, should fail
    const biz3 = '2026-09-01';
    insertSourceWithObservation(db, biz3, 1, 'Script Only Q');
    const res3 = cycleMod.ensureDailyCycleInternal(db, biz3);
    const t3 = res3.targets[0];
    const { projId: projId3, cvId: cvId3 } = makeProjectWithArticle(db, 'drafting'); // not ready
    assignProjectToTarget(db, t3.id, projId3);
    let c3 = t3;
    c3 = cycleMod.transitionTargetInternal(db, { targetId: c3.id, expectedRevision: Number(c3.revision), toStatus: 'researching' });
    c3 = cycleMod.transitionTargetInternal(db, { targetId: c3.id, expectedRevision: Number(c3.revision), toStatus: 'drafting' });
    c3 = cycleMod.transitionTargetInternal(db, { targetId: c3.id, expectedRevision: Number(c3.revision), toStatus: 'article_ready' });
    // this would already require article ready? Actually drafting->article_ready doesn't check article, but completion will
    c3 = cycleMod.transitionTargetInternal(db, { targetId: c3.id, expectedRevision: Number(c3.revision), toStatus: 'scripting' });
    derivativeMod.saveDerivativeVersionInternal(db, { projectId: projId3, sourceContentVersionId: cvId3, title: 's', body: 'b' });
    derivativeMod.finalizeDerivativeVersionInternal(db, { projectId: projId3 });
    assert.throws(() => cycleMod.transitionTargetInternal(db, { targetId: c3.id, expectedRevision: Number(c3.revision), toStatus: 'completed' }));
  } finally { db.close(); }
}));
