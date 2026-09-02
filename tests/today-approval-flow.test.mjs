import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { approvePlanItemAndCreateProject } from '../src/main/plan-item-approval.ts';
import { prepareApprovedProjectInvestigation } from '../src/main/project-investigation-automation.ts';
import { buildTodayRecommendationProjection } from '../src/main/today-recommendation.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const BUSINESS_DATE = '2026-08-28';
const NOW = new Date('2026-08-28T08:00:00.000Z');

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-approval-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try { await run(database); }
  finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function completeItem(title, sourceId, total, overrides = {}) {
  const item = {
    title, priority: 1,
    whyNow: '官方刚公布关键变化，当前两天是解释窗口，错过后读者注意力会明显下降。',
    timeliness: '热点 2-3 天',
    targetAudience: `正在评估 ${title} 并需要控制实际调用成本的个人开发者`,
    angle: `用 ${title} 的真实任务回执解释免费额度，而不是复述参数。`,
    pointOfView: `${title} 只有在真实任务可稳定完成时才具有商业价值。`,
    platforms: ['xiaohongshu'], formats: ['carousel'],
    titleGuidance: '标题使用免费额度与真实交付成本之间的反差。',
    openingGuidance: '先给出一次真实调用回执，再解释免费数字为什么可能误导。',
    structureGuidance: '第一段交代事件与额度；第二段展示真实任务回执；第三段给出是否值得使用的判断清单。',
    effortEstimate: '90 分钟', sourceIds: [sourceId],
    availableMaterials: ['官方公告', '真实调用回执'], missingMaterials: [], ...overrides
  };
  return { ...item, scoreReasons: overrides.scoreReasons ?? scoredReasons(total, NOW.toISOString()), editorialDecision: overrides.editorialDecision ?? editorialDecision(item.pointOfView) };
}

function insertPlan(database) {
  const sourceIds = ['a', 'b'].map((slug) => upsertSource(database, {
    title: `资料 ${slug}`, originalUrl: `https://example.com/${slug}`, summary: `资料 ${slug} 的可核验摘要`
  }, false).id);
  saveCurrentPlan(database, {
    planDate: BUSINESS_DATE, timezone: 'Asia/Shanghai', summary: '批准事务夹具',
    items: [
      completeItem('高分候选 A', sourceIds[0], 92),
      completeItem('递补候选 B', sourceIds[1], 84, {
        targetAudience: '已经部署本地模型、正在核算国产算力吞吐和稳定性的技术负责人',
        angle: '从国产集群的并发吞吐、失败率和持续可用性切入，核对免费额度能否兑现。',
        pointOfView: '算力来源与持续服务能力决定免费额度能否从发布新闻变成生产工具。'
      })
    ]
  });
  return database.prepare('SELECT id, revision, title FROM plan_items ORDER BY sort_order').all();
}

test('Today recommendation action opens the corresponding complete proposal without approving it', async () => {
  const source = await readFile(new URL('../src/renderer/today-view.tsx', import.meta.url), 'utf8');
  const createBody = source.match(/const create = \(item: TodayPlanItem\) => \{([\s\S]*?)\n  \};/)?.[1] ?? '';
  assert.match(createBody, /openProposals\?\.\(item\.id\)/, 'Today must deep-link the visible plan item into Proposals');
  assert.doesNotMatch(createBody, /approvePlanItem|openStudio/, 'Today must not duplicate proposal approval or project routing');
});

test('approval directly creates the selected content project', async () => {
  const source = await readFile(new URL('../src/main/ipc-today-studio-business.ts', import.meta.url), 'utf8');
  const handler = source.match(/ipcMain\.handle\('plan-item:approve'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  assert.ok(handler, 'plan-item:approve handler must exist');
  assert.match(handler, /approvePlanItemAndCreateProject/);
  assert.doesNotMatch(handler, /submitWorkspaceOrchestratorIntent|executeOwnerProjectionDecision|Projection/);
  assert.match(handler, /continueAutomaticInvestigation/, 'approval must continue the committed investigation without a second Owner action');
});

test('approval transaction creates one complete project, closes carry, and advances the projection', async () => {
  await withDb(async (database) => {
    const [a, b] = insertPlan(database);
    assert.equal(buildTodayRecommendationProjection(database, BUSINESS_DATE, { now: NOW }).primary?.planItemId, a.id);

    database.exec('BEGIN IMMEDIATE');
    const resultA = approvePlanItemAndCreateProject(database, { planItemId: a.id, expectedRevision: a.revision, by: 'owner', now: NOW });
    const preparedA = prepareApprovedProjectInvestigation(database, resultA.projectId, 'owner');
    database.exec('COMMIT');
    assert.equal(database.prepare('SELECT planning_status AS status FROM plan_items WHERE id=?').get(a.id).status, 'approved');
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_projects WHERE plan_item_id=?').get(a.id).count, 1);
    const version = database.prepare('SELECT body FROM content_versions WHERE id=?').get(resultA.contentVersionId);
    for (const fragment of ['为什么是现在', '目标读者', '内容角度', '核心观点', '内容结构', '来源']) assert.match(version.body, new RegExp(fragment));
    assert.equal(database.prepare("SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(a.id).state, 'done');
    assert.equal(buildTodayRecommendationProjection(database, BUSINESS_DATE, { now: NOW }).primary?.planItemId, b.id);
    const investigation = database.prepare(`
      SELECT status, outline_version AS outlineVersion, reporter_job_id AS reporterJobId,
             reporter_status AS reporterStatus, revision
        FROM project_investigations WHERE project_id=?
    `).get(resultA.projectId);
    assert.deepEqual(
      { status: investigation.status, outlineVersion: investigation.outlineVersion, reporterStatus: investigation.reporterStatus },
      { status: 'researching', outlineVersion: 1, reporterStatus: 'queued' }
    );
    assert.equal(investigation.reporterJobId, preparedA.reporter?.jobId);
    assert.equal(investigation.revision, preparedA.revision);
    assert.equal(database.prepare('SELECT status FROM investigation_outline_versions WHERE project_id=? AND version=1').get(resultA.projectId).status, 'approved');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM project_investigations WHERE project_id=?').get(resultA.projectId).count, 1);

    assert.throws(
      () => approvePlanItemAndCreateProject(database, { planItemId: a.id, expectedRevision: a.revision, by: 'owner', now: NOW }),
      (error) => error?.code === 'REVISION_CONFLICT'
    );
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_projects WHERE plan_item_id=?').get(a.id).count, 1);
    assert.equal(database.prepare('SELECT count(*) AS count FROM project_investigations WHERE project_id=?').get(resultA.projectId).count, 1);

    database.exec('BEGIN IMMEDIATE');
    const resultB = approvePlanItemAndCreateProject(database, { planItemId: b.id, expectedRevision: b.revision, by: 'owner', now: NOW });
    prepareApprovedProjectInvestigation(database, resultB.projectId, 'owner');
    database.exec('COMMIT');
    assert.equal(buildTodayRecommendationProjection(database, BUSINESS_DATE, { now: NOW }).primary, null);
  });
});

test('approval failure rolls back status, project, version, topic links, and carry as one unit', async () => {
  await withDb(async (database) => {
    const [a] = insertPlan(database);
    database.exec(`CREATE TRIGGER fail_initial_version BEFORE INSERT ON content_versions BEGIN SELECT RAISE(ABORT, 'injected_version_failure'); END`);
    database.exec('BEGIN IMMEDIATE');
    assert.throws(
      () => approvePlanItemAndCreateProject(database, { planItemId: a.id, expectedRevision: a.revision, by: 'owner', now: NOW }),
      /injected_version_failure/
    );
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT planning_status AS status, revision FROM plan_items WHERE id=?').get(a.id).status, 'ready_for_review');
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_projects WHERE plan_item_id=?').get(a.id).count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(a.id).count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_versions').get().count, 0);
    assert.equal(buildTodayRecommendationProjection(database, BUSINESS_DATE, { now: NOW }).primary?.planItemId, a.id);
  });
});
