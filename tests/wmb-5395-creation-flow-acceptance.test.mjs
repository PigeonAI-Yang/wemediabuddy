import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { approvePlanItemAndCreateProject } from '../src/main/plan-item-approval.ts';
import { continueAutomaticInvestigation, prepareApprovedProjectInvestigation } from '../src/main/project-investigation-automation.ts';
import { handleInvestigationJobEvent, readProjectInvestigation, recordInvestigationReporterTerminal, reviewInvestigationResearch } from '../src/main/project-investigation.ts';
import { buildResearchEvidencePack } from '../src/main/research-task-state.ts';
import { saveCoreVersion } from '../src/main/content.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const BUSINESS_DATE = '2026-09-03';

function planItem(sourceId) {
  const pointOfView = '只有证据链完整并能形成真实正文的选题才值得进入生产。';
  return {
    title: 'E2E 单一生产授权完整链路', priority: 1,
    whyNow: '官方刚公布关键变化，当前两天是解释窗口。', timeliness: '热点 2-3 天',
    targetAudience: '正在评估 AI 内容生产可靠性的独立创作者',
    angle: '用同一工作空间的真实状态链验证一次授权能否直达待审正文。', pointOfView,
    platforms: ['xiaohongshu'], formats: ['carousel'],
    titleGuidance: '突出一次授权与待审正文之间的关系。',
    openingGuidance: '先给出真实链路结果，再解释每个质量门。',
    structureGuidance: '第一段说明方案授权；第二段展示证据调查与主管验收；第三段交付正文并说明待审状态。', effortEstimate: '90 分钟',
    sourceIds: [sourceId], availableMaterials: ['官方材料'], missingMaterials: [],
    scoreReasons: scoredReasons(88, new Date().toISOString()), editorialDecision: editorialDecision(pointOfView)
  };
}

function pack(jobId, sourceId) {
  return buildResearchEvidencePack({
    jobId,
    round: 1,
    claims: [{ id: 'claim-wmb-5395', key: 'q1', status: 'supported', verdictReason: null, evidenceSourceIds: [sourceId], needsTimeExcerpt: false }],
    sourceIds: [sourceId],
    validSourceCount: 1,
    candidateCount: 1,
    timeSpentMinutes: 1,
    terminalReason: 'claims_resolved',
    unresolvedRequiredClaims: []
  });
}

async function seedAttributedWriterVersion(runtime, projectId, jobId, body) {
  return runtime.runActorControlPlane(() => {
    const db = runtime.database;
    const now = new Date().toISOString();
    const taskId = `task-${jobId}`;
    db.prepare(`INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
      progress_json, checkpoint_json, events_json, error_code, error_message, created_at, updated_at, finished_at)
      VALUES (?, 'studio_draft', ?, 'succeeded', 'done', NULL, ?, '{}', '{}', '{}', '[]', NULL, NULL, ?, ?, ?)`)
      .run(taskId, BUSINESS_DATE, JSON.stringify({ jobId, projectId }), now, now, now);
    const project = db.prepare('SELECT revision FROM content_projects WHERE id=?').get(projectId);
    const saved = saveCoreVersion(db, { projectId, body, expectedRevision: Number(project.revision), author: 'ai' });
    if (!saved.ok) throw saved.error;
    const versionId = saved.data.id;
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, result_json, readback_json, side_effect_state, created_at)
      VALUES (?, ?, ?, ?, 'content.save_version', 'wmb-5395', 'external_agent', 'writer', ?, '{}', ?, 'ok', ?, ?, 'committed', ?)`)
      .run(`receipt-${jobId}`, runtime.identity.workspaceId, runtime.identity.runtimeEpoch, `${jobId}:content`, taskId,
        JSON.stringify({ data: { id: versionId } }), JSON.stringify({ id: versionId }), JSON.stringify({ id: versionId }), now);
    return versionId;
  });
}

test('WMB-5395 one production authorization reaches attributed draft review in the same workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5395-'));
  let runtime;
  try {
    const db = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('workspace_id','ws-wmb-5395',?,?,1)").run(now, now);
    const sourceId = upsertSource(db, { title: 'WMB-5395 官方材料', originalUrl: 'https://example.com/wmb-5395', summary: '可核验摘要' }, false).id;
    saveCurrentPlan(db, { planDate: BUSINESS_DATE, timezone: 'Asia/Shanghai', summary: 'WMB-5395 验收', items: [planItem(sourceId)] });
    const plan = db.prepare('SELECT id, revision FROM plan_items WHERE title=?').get('E2E 单一生产授权完整链路');
    db.close();

    runtime = ActiveWorkspaceRuntime.open(root, { expectedWorkspaceId: 'ws-wmb-5395', createEpoch: () => 'epoch-wmb-5395' });
    const approved = await runtime.runActorControlPlane(() => {
      runtime.database.exec('BEGIN IMMEDIATE');
      try {
        const result = approvePlanItemAndCreateProject(runtime.database, { planItemId: plan.id, expectedRevision: plan.revision, by: 'owner' });
        const investigation = prepareApprovedProjectInvestigation(runtime.database, result.projectId, 'owner');
        runtime.database.exec('COMMIT');
        return { ...result, investigation };
      } catch (error) {
        runtime.database.exec('ROLLBACK');
        throw error;
      }
    });
    assert.equal(approved.investigation.status, 'researching');

    const spawned = [];
    const spawner = { spawn(request, jobId) { spawned.push({ roleId: request.roleId, jobId }); return { id: jobId }; } };
    await continueAutomaticInvestigation(runtime, spawner, approved.projectId);
    assert.deepEqual(spawned.map((entry) => entry.roleId), ['reporter']);

    const reporterJobId = readProjectInvestigation(runtime.database, approved.projectId).reporter.jobId;
    await runtime.runActorControlPlane(() => recordInvestigationReporterTerminal(runtime.database, {
      projectId: approved.projectId, jobId: reporterJobId, type: 'job.finished', pack: pack(reporterJobId, sourceId)
    }));
    const reviewed = await runtime.runActorControlPlane(() => reviewInvestigationResearch(runtime.database, {
      projectId: approved.projectId,
      expectedRevision: readProjectInvestigation(runtime.database, approved.projectId).revision,
      decision: 'accept', decidedBy: 'desk',
      direction: { keyFacts: ['官方材料支持核心主张'], upheld: ['中心判断成立'], changed: [], discoveries: ['一次授权可持续推进'], unknowns: [], recommendation: 'continue', coreQuestion: '一次授权能否到达待审正文？', audienceValue: '减少重复审批', scope: '只写已批准主张', constraints: ['不扩展发布边界'] }
    }));
    assert.equal(reviewed.data.status, 'ready_to_write');

    await continueAutomaticInvestigation(runtime, spawner, approved.projectId);
    assert.deepEqual(spawned.map((entry) => entry.roleId), ['reporter', 'writer']);
    const writerJobId = readProjectInvestigation(runtime.database, approved.projectId).writer.jobId;
    const versionId = await seedAttributedWriterVersion(runtime, approved.projectId, writerJobId, '# 待审正文\n\n这是同一真实工作空间生成的正文。');
    const terminal = await handleInvestigationJobEvent(runtime, { type: 'job.finished', jobId: writerJobId });
    assert.deepEqual(terminal, { role: 'writer', projectId: approved.projectId });

    const finalInvestigation = readProjectInvestigation(runtime.database, approved.projectId);
    const project = runtime.database.prepare('SELECT status FROM content_projects WHERE id=?').get(approved.projectId);
    const version = runtime.database.prepare('SELECT id, body FROM content_versions WHERE id=?').get(versionId);
    assert.equal(finalInvestigation.status, 'completed');
    assert.equal(project.status, 'review');
    assert.match(version.body, /同一真实工作空间/);
    assert.equal(runtime.database.prepare('SELECT COUNT(*) count FROM content_projects WHERE plan_item_id=?').get(plan.id).count, 1);
    assert.equal(finalInvestigation.history.filter((event) => event.kind === 'outline_approved').length, 1, 'only the proposal approval authorizes production');
  } finally {
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
