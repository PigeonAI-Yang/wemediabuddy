// WMB-5335 focused gates: target->plan->project linkage, CAP-028 research gate, article draft/finalize, append-only, idempotency, article_ready projection.
// Verify via: node --test tests/wmb-5335-article.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const planningStage = await import('../src/main/planning-stage.ts');
const articleMod = await import('../src/main/daily-content-article.ts');
const { setActiveJobSpawner } = await import('../src/main/job-spawner.ts');
setActiveJobSpawner({ get: () => null, spawn: (_request, jobId) => ({ id: jobId }), getHandle: (jobId) => ({ taskId: jobId }), dispose() {} });

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5335-'));
  try { return work(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {} }
}
function migrateFresh(dir) {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  db.prepare("INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('workspace_id','ws-5335','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
  return db;
}
function insertSourceWithObservation(db, businessDate, idx, title) {
  const suffix = randomUUID().slice(0,6);
  const sid = `src-${idx}-${suffix}`;
  db.prepare("INSERT OR IGNORE INTO source_feeds (id,name,created_at,updated_at,revision) VALUES ('feed1','f','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
  const url = `https://www.zhihu.com/question/${200000+idx}-${suffix}`;
  db.prepare("INSERT INTO source_items (id, feed_id, original_url, canonical_url, title, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)").run(
    sid, 'feed1', url, url, title, '2026-08-22T00:00:00Z', 'summary', '[]','[]','[]','[]','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z'
  );
  db.prepare("INSERT INTO zhihu_hot_observations (id, source_item_id, business_date, rank, question_title_snapshot, question_url_snapshot, collected_at, input_fingerprint, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
    `obs-${sid}`, sid, businessDate, idx, title, url, '2026-08-22T01:00:00Z', `fp-${sid}`, '2026-08-22T01:00:00Z'
  );
  return sid;
}
function seedApprovedTarget(db, businessDate, sourceId, title) {
  const approvedTitle = `${title} 完整策划标题示例`;
  const { planItemId } = planningStage.createPlanningDraftFromTarget(db, {
    title: approvedTitle,
    sourceIds: [sourceId],
    planDate: businessDate,
  });
  planningStage.submitPlanItemForReview(db, {
    planItemId,
    expectedRevision: 1,
    by: 'planner',
    item: {
      title: approvedTitle,
      priority: 2,
      whyNow: '官方今日公布具体变化，未来两天是解释窗口，错过后需要重新核对事实。',
      timeliness: 'today',
      targetAudience: '正在评估 AI 工具并负责落地交付的科技从业者',
      angle: '可检验切口',
      pointOfView: '独立判断',
      platforms: ['x'],
      formats: ['article'],
      titleGuidance: '标题指引',
      openingGuidance: '开头指引',
      structureGuidance: '第一段交代事件；第二段展示证据；第三段给出行动判断。',
      effortEstimate: 'M',
      sourceIds: [sourceId],
      availableMaterials: ['已有材料'],
      missingMaterials: [],
      scoreReasons: scoredReasons(),
      editorialDecision: editorialDecision('独立判断'),
    },
  });
  planningStage.transitionPlanItem(db, {
    planItemId,
    expectedRevision: 2,
    expectedStatus: 'ready_for_review',
    toStatus: 'approved',
    by: 'desk',
  });
  const cycleId = `cycle-${randomUUID()}`;
  const targetId = `target-${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO daily_content_cycles (id, business_date, timezone, target_count, status, started_at, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,1)")
    .run(cycleId, businessDate, 'Asia/Shanghai', 1, 'running', now, now, now);
  db.prepare("INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, plan_item_id, project_id, predecessor_target_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)")
    .run(targetId, cycleId, 'new_content', 1, sourceId, planItemId, null, null, 0, 'owner_approved', '{}', 'selected', now, now);
  return targetId;
}
function createResearchGate(db, projectId) {
  const taskId = `research-${projectId}-${randomUUID().slice(0,4)}`;
  const now = new Date().toISOString();
  // Minimal agent_tasks row with context_refs_json containing projectId
  db.prepare("INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json, progress_json, checkpoint_json, events_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    taskId, 'research', '2026-08-22', 'succeeded', 'done', null, JSON.stringify({ projectId, research: { gapId: `gap-${projectId}` } }), '{}', '{}','{}','[]', now, now
  );
  const claimId = randomUUID();
  db.prepare("INSERT INTO research_claims (id, task_id, claim_key, claim_text, claim_type, status, verdict_reason, evidence_source_ids_json, needs_time_excerpt, verified_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    claimId, taskId, 'k1', 'fact claim', 'fact', 'supported', 'ok', '[]', 0, now, now, now
  );
  return taskId;
}

test('gate unmet yields no body and blocked state', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const d = '2026-08-22';
    const sourceId = insertSourceWithObservation(db, d, 1, 'Q1 gate unmet');
    insertSourceWithObservation(db, d, 2, 'Q2 second');
    const targetId = seedApprovedTarget(db, d, sourceId, 'Q1 gate unmet');
    const link = articleMod.ensureTargetArticleLinkInternal(db, targetId);
    assert.ok(link.projectId);
    const targetBefore = db.prepare('SELECT revision FROM daily_content_targets WHERE id=?').get(targetId);
    const beforeCount = db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(link.projectId).c;
    assert.equal(beforeCount, 0);
    let threw = null;
    try { articleMod.saveTargetArticleDraftInternal(db, { targetId, body: 'should not be saved', expectedRevision: targetBefore.revision }); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.equal(threw.code, 'RESEARCH_GATE_UNMET');
    const afterCount = db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(link.projectId).c;
    assert.equal(afterCount, 0, 'no body when gate unmet');
    const blocked = db.prepare('SELECT status, blocked_reason_code FROM daily_content_targets WHERE id=?').get(targetId);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blocked_reason_code, 'RESEARCH_GATE_UNMET');
  } finally { db.close(); }
}));

test('gate satisfied yields final article in same project and article_ready', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const d = '2026-08-22';
    const sourceId = insertSourceWithObservation(db, d, 1, 'Q1 gate satisfied');
    const targetId = seedApprovedTarget(db, d, sourceId, 'Q1 gate satisfied');
    const link = articleMod.ensureTargetArticleLinkInternal(db, targetId);
    createResearchGate(db, link.projectId);
    const rev1 = db.prepare('SELECT revision FROM daily_content_targets WHERE id=?').get(targetId).revision;
    const saved = articleMod.saveTargetArticleDraftInternal(db, { targetId, body: '正文 body satisfied', title: '标题', expectedRevision: rev1 });
    assert.equal(saved.projectId, link.projectId);
    const count1 = db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(link.projectId).c;
    assert.equal(count1, 1);
    // finalize to article_ready
    const rev2 = db.prepare('SELECT revision FROM daily_content_targets WHERE id=?').get(targetId).revision;
    const fin = articleMod.finalizeTargetArticleInternal(db, { targetId, expectedRevision: rev2 });
    assert.equal(fin.projectId, link.projectId);
    const targetAfter = db.prepare('SELECT status FROM daily_content_targets WHERE id=?').get(targetId);
    assert.equal(targetAfter.status, 'article_ready');
    const proj = db.prepare('SELECT status FROM content_projects WHERE id=?').get(link.projectId);
    assert.equal(proj.status, 'ready');
  } finally { db.close(); }
}));

test('version history remains append-only', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const d = '2026-08-22';
    const sourceId = insertSourceWithObservation(db, d, 1, 'Q append');
    const targetId = seedApprovedTarget(db, d, sourceId, 'Q append');
    const link = articleMod.ensureTargetArticleLinkInternal(db, targetId);
    createResearchGate(db, link.projectId);
    const rev1 = db.prepare('SELECT revision FROM daily_content_targets WHERE id=?').get(targetId).revision;
    articleMod.saveTargetArticleDraftInternal(db, { targetId, body: 'v1 body', expectedRevision: rev1 });
    const rev2 = db.prepare('SELECT revision FROM daily_content_targets WHERE id=?').get(targetId).revision;
    articleMod.saveTargetArticleDraftInternal(db, { targetId, body: 'v2 body revised', expectedRevision: rev2 });
    const vers = db.prepare('SELECT version_number, body FROM content_versions WHERE project_id=? ORDER BY version_number ASC').all(link.projectId);
    assert.equal(vers.length, 2);
    assert.equal(vers[0].body, 'v1 body');
    assert.equal(vers[1].body, 'v2 body revised');
    assert.equal(vers[0].version_number, 1);
    assert.equal(vers[1].version_number, 2);
    // finalize should not overwrite history
    const rev3 = db.prepare('SELECT revision FROM daily_content_targets WHERE id=?').get(targetId).revision;
    articleMod.finalizeTargetArticleInternal(db, { targetId, expectedRevision: rev3 });
    const after = db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(link.projectId).c;
    assert.equal(after, 2);
  } finally { db.close(); }
}));

test('target becomes article_ready only after finalize, not just drafting', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const d = '2026-08-22';
    const sourceId = insertSourceWithObservation(db, d, 1, 'Q article_ready check');
    const targetId = seedApprovedTarget(db, d, sourceId, 'Q article_ready check');
    const link = articleMod.ensureTargetArticleLinkInternal(db, targetId);
    createResearchGate(db, link.projectId);
    const rev1 = db.prepare('SELECT revision FROM daily_content_targets WHERE id=?').get(targetId).revision;
    articleMod.saveTargetArticleDraftInternal(db, { targetId, body: 'draft body', expectedRevision: rev1 });
    const afterDraft = db.prepare('SELECT status FROM daily_content_targets WHERE id=?').get(targetId);
    assert.equal(afterDraft.status, 'drafting');
    const rev2 = db.prepare('SELECT revision FROM daily_content_targets WHERE id=?').get(targetId).revision;
    articleMod.finalizeTargetArticleInternal(db, { targetId, expectedRevision: rev2 });
    const afterFinal = db.prepare('SELECT status FROM daily_content_targets WHERE id=?').get(targetId);
    assert.equal(afterFinal.status, 'article_ready');
  } finally { db.close(); }
}));

test('repeated ensure does not duplicate identity (idempotency)', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const d = '2026-08-22';
    const sourceId = insertSourceWithObservation(db, d, 1, 'Q idempotent');
    const targetId = seedApprovedTarget(db, d, sourceId, 'Q idempotent');
    const first = articleMod.ensureTargetArticleLinkInternal(db, targetId);
    const second = articleMod.ensureTargetArticleLinkInternal(db, targetId);
    assert.equal(first.projectId, second.projectId);
    assert.equal(first.planItemId, second.planItemId);
    assert.equal(second.created, false);
    const planCount = db.prepare('SELECT COUNT(*) as c FROM plan_items WHERE id=?').get(first.planItemId).c;
    assert.equal(planCount, 1);
    const projCount = db.prepare('SELECT COUNT(*) as c FROM content_projects WHERE id=?').get(first.projectId).c;
    assert.equal(projCount, 1);
    // also ensure second save with stale revision fails as revision conflict
    createResearchGate(db, first.projectId);
    const rev = db.prepare('SELECT revision FROM daily_content_targets WHERE id=?').get(targetId).revision;
    articleMod.saveTargetArticleDraftInternal(db, { targetId, body: 'first', expectedRevision: rev });
    let conflict = null;
    try { articleMod.saveTargetArticleDraftInternal(db, { targetId, body: 'stale', expectedRevision: rev }); } catch (e) { conflict = e; }
    assert.ok(conflict);
    assert.equal(conflict.code, 'REVISION_CONFLICT');
  } finally { db.close(); }
}));
