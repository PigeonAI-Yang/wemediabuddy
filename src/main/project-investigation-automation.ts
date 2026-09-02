import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { dispatchBusinessCommand, requireCommandResultData } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import type { JobSpawner } from './job-spawner.ts';
import {
  buildInvestigationReporterRequest,
  buildInvestigationWriterRequest,
  decideInvestigationOutline,
  initializeProjectInvestigation,
  readProjectInvestigation,
  recordInvestigationReporterTerminal,
  revertInvestigationWriterDispatch,
  saveInvestigationOutline,
  startInvestigationWriter,
  type InvestigationOutline,
  type ProjectInvestigation
} from './project-investigation.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

function automationActor() {
  return { type: 'scheduler' as const, id: 'creation-flow-automation', label: 'creation-flow-automation' };
}
function requireInvestigation(result: { ok: boolean; data: ProjectInvestigation | null; error: unknown }): ProjectInvestigation {
  if (!result.ok || !result.data) throw result.error;
  return result.data;
}

function approvedPlanOutline(row: Record<string, unknown>, sourceIds: readonly string[]): InvestigationOutline {
  const title = String(row.title ?? '').trim();
  const whyNow = String(row.why_now ?? '').trim();
  const audience = String(row.target_audience ?? '').trim();
  const angle = String(row.angle ?? '').trim();
  const pointOfView = String(row.point_of_view ?? '').trim();
  return Object.freeze({
    scope: `围绕已批准选题“${title}”核验中心主张、关键事实、现实案例与反证；写作对象为${audience || '该选题的目标读者'}。`,
    exclusions: ['不扩展到与已批准中心主张无直接关系的行业综述', '不把未经核验的数字、引语、案例或因果关系写成事实'],
    known: [whyNow, angle, sourceIds.length ? `已批准方案关联 ${sourceIds.length} 条来源。` : '已批准方案暂未关联可核验来源。'].filter(Boolean),
    hypotheses: [pointOfView || `${title} 的价值需要由真实证据与可复现案例支持。`],
    questions: [
      `已批准中心主张“${pointOfView || title}”有哪些可核验事实支持？`,
      '关键机制、适用边界和失败条件分别是什么？',
      '是否存在独立案例、反例或相反证据？',
      '哪些数字、引语、案例和归因可以安全进入正式正文？'
    ],
    dimensions: ['官方与一手事实', '机制与因果边界', '独立案例与实际结果', '反例、限制与适用条件'],
    materialRequirements: ['至少一条官方或一手材料', '至少一条独立来源或真实案例', '针对中心主张的反证或限制条件'],
    truthRisks: ['数字和时间口径漂移', '把相关性写成因果关系', '把单个案例外推为普遍结论', '把来源摘要或模型记忆当成已核验事实'],
    disconfirmingConditions: ['核心事实无法由可追溯来源支持', '独立案例与中心主张相反', '关键机制仅存在宣传材料而无可验证结果'],
    completionCriteria: ['关键问题均有 supported 或明确 unresolved 终态', '正文拟使用的数字、引语、案例和归因均绑定来源', '至少记录一项反证、限制或适用边界']
  });
}

/** 必须与计划批准、项目创建处于同一数据库事务。 */
export function prepareApprovedProjectInvestigation(
  database: DatabaseSync,
  projectId: string,
  decidedBy = 'owner'
): ProjectInvestigation {
  const row = database.prepare(`
    SELECT item.title, item.why_now, item.target_audience, item.angle, item.point_of_view, item.source_ids_json
      FROM content_projects project
      JOIN plan_items item ON item.id = project.plan_item_id
     WHERE project.id = ?
  `).get(projectId) as Record<string, unknown> | undefined;
  if (!row) throw Object.assign(new Error('APPROVED_PROJECT_PLAN_ITEM_MISSING'), { code: 'INVALID_STATE' });
  const sourceIds = JSON.parse(String(row.source_ids_json ?? '[]')) as string[];
  const initialized = requireInvestigation(initializeProjectInvestigation(database, projectId));
  const outlined = requireInvestigation(saveInvestigationOutline(database, {
    projectId,
    expectedRevision: initialized.revision,
    outline: approvedPlanOutline(row, sourceIds)
  }));
  return requireInvestigation(decideInvestigationOutline(database, {
    projectId,
    expectedRevision: outlined.revision,
    decision: 'approve',
    reporterJobId: randomUUID(),
    decidedBy
  }));
}

async function markReporterSpawnFailed(
  runtime: ActiveWorkspaceRuntime,
  projectId: string,
  jobId: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await dispatchBusinessCommand(runtime, {
    command: 'investigation.reporter_terminal',
    requestId: `investigation.reporter_spawn_failed:${projectId}:${jobId}`,
    actor: automationActor(),
    input: { projectId, jobId, message },
    boundIdentity: { entityType: 'content_project', entityId: projectId },
    entityType: 'project_investigation',
    execute: (database, value) => {
      const data = requireCommandResultData(recordInvestigationReporterTerminal(database, {
        projectId: value.projectId,
        jobId: value.jobId,
        type: 'job.failed',
        error: value.message
      }));
      return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
    }
  });
}

async function spawnQueuedReporter(
  runtime: ActiveWorkspaceRuntime,
  spawner: JobSpawner,
  investigation: ProjectInvestigation
): Promise<ProjectInvestigation> {
  const reporter = investigation.reporter;
  if (investigation.status !== 'researching' || reporter?.status !== 'queued' || !reporter.jobId) return investigation;
  const built = buildInvestigationReporterRequest(runtime.database, investigation.projectId, reporter.round);
  if (!built) throw Object.assign(new Error('INVESTIGATION_REPORTER_REQUEST_MISSING'), { code: 'INVALID_STATE' });
  try {
    spawner.spawn(built.request, reporter.jobId);
  } catch (error) {
    await markReporterSpawnFailed(runtime, investigation.projectId, reporter.jobId, error);
    throw error;
  }
  return readProjectInvestigation(runtime.database, investigation.projectId) ?? investigation;
}

async function spawnReadyWriter(
  runtime: ActiveWorkspaceRuntime,
  spawner: JobSpawner,
  investigation: ProjectInvestigation
): Promise<ProjectInvestigation> {
  if (investigation.status !== 'ready_to_write') return investigation;
  const request = buildInvestigationWriterRequest(investigation);
  if (!request) throw Object.assign(new Error('INVESTIGATION_WRITER_REQUEST_MISSING'), { code: 'INVALID_STATE' });
  const jobId = randomUUID();
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'investigation.start_writer',
    requestId: `investigation.start_writer:auto:${investigation.projectId}:${investigation.revision}`,
    actor: automationActor(),
    input: { projectId: investigation.projectId, expectedRevision: investigation.revision, jobId },
    boundIdentity: { entityType: 'content_project', entityId: investigation.projectId },
    entityType: 'project_investigation',
    execute: (database, value) => {
      const data = requireCommandResultData(startInvestigationWriter(database, {
        projectId: value.projectId,
        expectedRevision: value.expectedRevision,
        writerJobId: value.jobId,
        decidedBy: 'creation-flow-automation'
      }));
      return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
    }
  });
  if (!receipt.ok) throw Object.assign(new Error(receipt.error?.message ?? 'INVESTIGATION_WRITER_START_FAILED'), { code: receipt.error?.code });
  try {
    spawner.spawn(request, jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dispatchBusinessCommand(runtime, {
      command: 'investigation.revert_writer_dispatch',
      requestId: `investigation.revert_writer_dispatch:auto:${investigation.projectId}:${jobId}`,
      actor: automationActor(),
      input: { projectId: investigation.projectId, note: `自动派写手失败：${message}` },
      boundIdentity: { entityType: 'content_project', entityId: investigation.projectId },
      entityType: 'project_investigation',
      execute: (database, value) => {
        const data = requireCommandResultData(revertInvestigationWriterDispatch(database, value));
        return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
      }
    });
    throw error;
  }
  return readProjectInvestigation(runtime.database, investigation.projectId) ?? investigation;
}

export async function continueAutomaticInvestigation(
  runtime: ActiveWorkspaceRuntime,
  spawner: JobSpawner,
  projectId: string
): Promise<ProjectInvestigation | null> {
  let investigation = readProjectInvestigation(runtime.database, projectId);
  if (!investigation) return null;
  investigation = await spawnQueuedReporter(runtime, spawner, investigation);
  investigation = await spawnReadyWriter(runtime, spawner, investigation);
  broadcastDataChanged({ scopes: ['studio', 'agent', 'today', 'proposals'], reason: 'creation_flow.automatic_progress' });
  return investigation;
}

export function resumeAutomaticInvestigations(runtime: ActiveWorkspaceRuntime, spawner: JobSpawner): void {
  const rows = runtime.database.prepare(`
    SELECT project_id
      FROM project_investigations
     WHERE (status='researching' AND reporter_status='queued' AND reporter_job_id IS NOT NULL)
        OR status='ready_to_write'
     ORDER BY updated_at ASC
  `).all() as Array<{ project_id: string }>;
  for (const row of rows) {
    void continueAutomaticInvestigation(runtime, spawner, row.project_id)
      .catch((error) => console.error('[creation-flow-automatic-progress]', row.project_id, error));
  }
}
