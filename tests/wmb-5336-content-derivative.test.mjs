// WMB-5336 focused gate: adaptive immutable video-script versions, exact article binding, stale regression, Writer task wiring.
// Verify via: node --test tests/wmb-5336-content-derivative.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const derivative = await import('../src/main/content-derivative.ts');
const jobs = await import('../src/main/role-job-registry.ts');
const { draftPrompt } = await import('../src/main/agent-runner.ts');

function withDatabase(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5336-'));
  const db = migrateDatabase(path.join(dir, 'wmb.db'));
  try {
    db.prepare("INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('workspace_id','ws-5336','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
    return work(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function seedTargetAndProject(db) {
  const timestamp = '2026-08-22T00:00:00Z';
  db.prepare("INSERT INTO source_feeds (id,name,created_at,updated_at,revision) VALUES ('feed-5336','知乎热榜',?,?,1)").run(timestamp, timestamp);
  db.prepare(`INSERT INTO source_items
    (id,feed_id,original_url,canonical_url,title,collected_at,summary,categories_json,keywords_json,recommended_platforms_json,recommended_formats_json,created_at,updated_at,revision)
    VALUES ('source-5336','feed-5336','https://www.zhihu.com/question/5336','https://www.zhihu.com/question/5336','如何完成一套真实教程',?,'教程摘要','[]','[]','[]','[]',?,?,1)`)
    .run(timestamp, timestamp, timestamp);
  db.prepare(`INSERT INTO zhihu_hot_observations
    (id,source_item_id,business_date,rank,question_title_snapshot,question_url_snapshot,collected_at,input_fingerprint,created_at)
    VALUES ('observation-5336','source-5336','2026-08-22',1,'如何完成一套真实教程','https://www.zhihu.com/question/5336',?,'fingerprint-5336',?)`)
    .run(timestamp, timestamp);
  db.prepare("INSERT INTO topics (id,title,created_at,updated_at,revision) VALUES ('topic-5336','教程主题',?,?,1)").run(timestamp, timestamp);
  db.prepare("INSERT INTO content_projects (id,topic_id,title,status,created_at,updated_at,revision) VALUES ('project-5336','topic-5336','真实教程','ready',?,?,1)").run(timestamp, timestamp);
  const articleBody = `教程步骤：先准备材料，再执行流程，最后检查结果。${'这是用于演示具体操作与关键步骤的正文。'.repeat(55)}`;
  db.prepare("INSERT INTO content_versions (id,project_id,body,version_number,created_at) VALUES ('article-v1','project-5336',?,1,?)").run(articleBody, timestamp);
  db.prepare("INSERT INTO daily_content_cycles (id,business_date,timezone,target_count,status,started_at,created_at,updated_at,revision) VALUES ('cycle-5336','2026-08-22','Asia/Shanghai',1,'running',?,?,?,1)").run(timestamp, timestamp, timestamp);
  db.prepare("INSERT INTO daily_content_targets (id,cycle_id,target_kind,counts_toward_goal,source_item_id,project_id,carry_depth,selection_mode,score_snapshot_json,status,created_at,updated_at,revision) VALUES ('target-5336','cycle-5336','new_content',1,'source-5336','project-5336',0,'owner_approved','{}','article_ready',?,?,1)").run(timestamp, timestamp);
  return { targetId: 'target-5336', articleBody };
}

test('adaptive script versions are immutable, stale on article change, then realign and complete', () => withDatabase((db) => {
  const { targetId, articleBody } = seedTargetAndProject(db);
  const draft = derivative.saveDerivativeVersionInternal(db, {
    projectId: 'project-5336',
    sourceContentVersionId: 'article-v1',
    title: '真实教程视频文案',
    body: '开场提出问题，随后逐步演示准备、执行与检查，最后总结关键动作。'
  });
  const decision = JSON.parse(draft.format_decision_json);
  assert.equal(decision.suitableForm, '教程型长视频讲解');
  assert.match(decision.reason, /正文长度\d+字.*含教程要素/);
  assert.equal(decision.needsDemo, true);

  const readyV1 = derivative.finalizeDerivativeVersionInternal(db, { projectId: 'project-5336', expectedLatestVersionNumber: 1 });
  assert.equal(readyV1.status, 'ready');
  assert.equal(readyV1.source_content_version_id, 'article-v1');
  assert.equal(db.prepare('SELECT status FROM daily_content_targets WHERE id=?').get(targetId).status, 'completed');
  assert.throws(() => db.prepare("UPDATE content_derivative_versions SET body='mutated' WHERE id=?").run(readyV1.id), /IMMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM content_derivative_versions WHERE id=?').run(readyV1.id), /IMMUTABLE/);

  db.prepare("INSERT INTO content_versions (id,project_id,body,version_number,created_at) VALUES ('article-v2','project-5336',?,2,'2026-08-22T01:00:00Z')").run(`${articleBody}\n新增纠错步骤。`);
  derivative.regressStaleTargetsForProject(db, 'project-5336');
  const stale = derivative.getStudioDualProjectionInternal(db, 'project-5336');
  assert.equal(stale.isStale, true);
  assert.equal(stale.readiness, 'stale');
  assert.equal(stale.compare.isAligned, false);
  assert.equal(db.prepare('SELECT status FROM daily_content_targets WHERE id=?').get(targetId).status, 'scripting');

  const draftV2 = derivative.saveDerivativeVersionInternal(db, {
    projectId: 'project-5336',
    sourceContentVersionId: 'article-v2',
    title: '真实教程视频文案（修订）',
    body: '按新版文章增加纠错步骤，再完整演示准备、执行、检查和修正。'
  });
  const readyV2 = derivative.finalizeDerivativeVersionInternal(db, { projectId: 'project-5336', expectedLatestVersionNumber: draftV2.version_number });
  const fresh = derivative.getStudioDualProjectionInternal(db, 'project-5336');
  assert.equal(readyV2.source_content_version_id, 'article-v2');
  assert.equal(fresh.isStale, false);
  assert.equal(fresh.readiness, 'script_ready');
  assert.equal(fresh.compare.isAligned, true);
  assert.equal(db.prepare('SELECT status FROM daily_content_targets WHERE id=?').get(targetId).status, 'completed');
}));

test('video_script Writer task derives exact readback and adaptive prompt', () => {
  const request = jobs.parseRoleJobRequest({ roleId: 'writer', brief: '把最新定稿转成视频文案', projectId: 'project-5336', writerTask: 'video_script' });
  const spec = jobs.deriveRoleJobSpec(request, 'workspace-5336');
  assert.equal(spec.writerTask, 'video_script');
  assert.equal(spec.readback, 'video_script');
  const prompt = draftPrompt({ id: 'task-5336' }, 'project-5336', 'request-5336', 'video_script', request.brief);
  assert.match(prompt, /先判断内容最适合的真实视频形态/);
  assert.match(prompt, /wmb_save_video_script/);
});
