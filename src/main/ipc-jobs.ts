import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import {
  ensureJobSpawner,
  getActiveJobSpawner,
  setActiveJobSpawner
} from './job-spawner.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { DEFAULT_MAX_WORKERS } from './job-pool.ts';
import { createGenericEmployeeRunner } from './generic-employee-runner.ts';
import { parseRoleJobRequest, type RoleJobReportV1 } from './role-job-registry.ts';
import { shanghaiDate } from './ferment.ts';
import { submitWorkspaceOrchestratorIntent } from './workspace-orchestrator-runtime.ts';
import { notifyDeskJobEvent } from './manager-job-notify.ts';
import { broadcastDataChanged } from './data-changed.ts';
import type { McpRuntime } from './mcp.ts';
import { handleTopicReproposalJobEvent } from './topic-maintenance-reproposal.ts';
import { handleResearchSuccessorJobEvent } from './research-successor.ts';
import { buildInvestigationSupervisorReviewPrompt, handleInvestigationJobEvent } from './project-investigation.ts';
import { runDockManagerPrompt } from './ipc-pi-dock.ts';

type JobSpawnProducerId = 'ui.jobs-spawn';

async function submitRoleJobIntent(runtime: ActiveWorkspaceRuntime, input: unknown, producerId: JobSpawnProducerId) {
  const request = parseRoleJobRequest(input);
  const requestedBusinessDate = 'businessDate' in request ? request.businessDate : null;
  const businessDate = typeof requestedBusinessDate === 'string' && requestedBusinessDate.length > 0
    ? requestedBusinessDate
    : shanghaiDate();
  const payloadSource = 'businessDate' in request
    ? { ...request, businessDate }
    : request;
  const payload = Object.freeze(Object.fromEntries(Object.entries(payloadSource).filter(([, value]) => value !== undefined)));
  return submitWorkspaceOrchestratorIntent(runtime, {
    producerId,
    businessDate,
    requestId: randomUUID(),
    action: 'stage_d',
    logicalInput: payload,
    payload,
    rootMode: 'owner'
  });
}

export type JobsIpcDependencies = {
  getActiveRuntime: () => ActiveWorkspaceRuntime | null;
};

const supervisorReviewPackagesStarted = new Map<string, string>();

function dispatchInvestigationSupervisorReview(runtime: ActiveWorkspaceRuntime, projectId: string): void {
  const pending = runtime.database.prepare(
    `SELECT package.id AS package_id
       FROM project_investigations AS investigation
       JOIN investigation_packages AS package ON package.project_id = investigation.project_id
      WHERE investigation.project_id = ?
        AND investigation.status = 'research_review'
        AND package.review_json IS NULL
      ORDER BY package.round DESC
      LIMIT 1`
  ).get(projectId) as { package_id: string } | undefined;
  if (!pending || supervisorReviewPackagesStarted.get(projectId) === pending.package_id) return;
  supervisorReviewPackagesStarted.set(projectId, pending.package_id);
  const dispatchId = randomUUID();
  void runDockManagerPrompt({
    message: buildInvestigationSupervisorReviewPrompt(projectId),
    page: 'studio',
    pageLabel: '创作 · 调查验收',
    objectType: 'content_project',
    objectId: projectId,
    orchestration: {
      dispatchId,
      delivery: 'direct',
      safe: {
        originLabel: '专项调查',
        title: '主管验收调查资料包',
        goal: '核验调查证据并形成调查后写作方向',
        acceptance: '真实资料包已验收；通过时形成待 Owner 审批的方向草稿'
      }
    }
  }).catch((error) => {
    if (supervisorReviewPackagesStarted.get(projectId) === pending.package_id) {
      supervisorReviewPackagesStarted.delete(projectId);
    }
    console.error('[project-investigation-supervisor-review]', error);
  });
}

export function resumePendingInvestigationSupervisorReviews(runtime: ActiveWorkspaceRuntime): void {
  const rows = runtime.database.prepare(
    `SELECT project_id FROM project_investigations WHERE status = 'research_review' ORDER BY updated_at ASC`
  ).all() as Array<{ project_id: string }>;
  for (const row of rows) dispatchInvestigationSupervisorReview(runtime, row.project_id);
}

export function ensureJobsSpawner(deps: JobsIpcDependencies) {
  const runtime = deps.getActiveRuntime();
  if (!runtime) throw new Error('当前工作空间运行时不可用。');
  const spawner = ensureJobSpawner(runtime, {
    onEvent: (event) => {
      broadcastDataChanged({ scopes: ['agent'], reason: String(event.type ?? 'jobs.event') });
      const jobId = typeof event.jobId === 'string' ? event.jobId : '';
      const spawner = getActiveJobSpawner();
      const job = jobId && spawner ? spawner.get(jobId) : null;
      void handleInvestigationJobEvent(runtime, event)
        .then((investigation) => {
          if (investigation?.role === 'reporter_review' && investigation.dispatchSupervisor) {
            dispatchInvestigationSupervisorReview(runtime, investigation.projectId);
          }
          return notifyDeskJobEvent({
            type: String(event.type ?? ''),
            job: job ?? {
              id: jobId,
              roleId: typeof event.roleId === 'string' ? event.roleId : undefined,
              intent: typeof event.intent === 'string' ? event.intent : undefined,
              status: typeof event.status === 'string' ? event.status : undefined,
              brief: typeof event.brief === 'string' ? event.brief : undefined,
              error: typeof event.error === 'string' ? event.error : undefined,
              report: typeof event.report === 'object' && event.report !== null ? event.report as RoleJobReportV1 : null
            },
            runtime,
            handle: jobId && spawner ? spawner.getHandle(jobId) : null,
            suppressDeskPrompt: investigation?.role === 'reporter_review'
          });
        })
        .catch((error) => console.error('[project-investigation-event]', error));
      void handleTopicReproposalJobEvent(runtime, event).catch((error) => console.error('[topic-reproposal-event]', error));
      void handleResearchSuccessorJobEvent(runtime, event).catch((error) => console.error('[research-successor-event]', error));
    },
    execute: createGenericEmployeeRunner(
      () => deps.getActiveRuntime(),
      () => {
        const rt = deps.getActiveRuntime();
        const mcp = rt?.getMcp<McpRuntime>();
        return mcp?.url ? { mcpUrl: mcp.url, xhsMcpUrl: '' } : null;
      }
    )
  });
  resumePendingInvestigationSupervisorReviews(runtime);
  return spawner;
}

export function registerJobsIpc(deps: JobsIpcDependencies): void {
  ipcMain.handle('jobs:spawn', async (_event, input: unknown) => {
    const runtime = deps.getActiveRuntime();
    if (!runtime) throw new Error('当前工作空间运行时不可用。');
    return submitRoleJobIntent(runtime, input, 'ui.jobs-spawn');
  });

  ipcMain.handle('jobs:list', () => {
    const spawner = getActiveJobSpawner();
    if (!spawner) return [];
    return spawner.list().map((job) => ({
      ...job,
      handle: spawner.getHandle(job.id)
    }));
  });

  ipcMain.handle('jobs:get', (_event, jobId: string) => {
    const spawner = getActiveJobSpawner();
    if (!spawner) return null;
    const job = spawner.get(jobId);
    if (!job) return null;
    return { ...job, handle: spawner.getHandle(jobId) };
  });

  ipcMain.handle('jobs:await', async (_event, input: { jobId: string; timeoutMs?: number }) => {
    const spawner = ensureJobsSpawner(deps);
    return spawner.await(input.jobId, input.timeoutMs ?? 120_000);
  });

  ipcMain.handle('jobs:cancel', async (_event, jobId: string) => {
    const spawner = getActiveJobSpawner();
    if (!spawner) return null;
    return spawner.cancel(jobId);
  });

  ipcMain.handle('jobs:message', async (_event, input: { jobId: string; body: string }) => {
    const spawner = ensureJobsSpawner(deps);
    const jobId = String(input?.jobId || '').trim();
    const body = String(input?.body || '');
    if (!jobId) throw new Error('缺少 jobId。');
    return spawner.postMessage(jobId, body, 'desk');
  });

  ipcMain.handle('jobs:messages', (_event, jobId: string) => {
    const spawner = getActiveJobSpawner();
    if (!spawner) return [];
    return spawner.listMessages(String(jobId || ''));
  });

  ipcMain.handle('jobs:pool-status', () => {
    const spawner = getActiveJobSpawner();
    const runtime = deps.getActiveRuntime();
    const jobs = spawner?.list() ?? [];
    const running = jobs.filter((j) => j.status === 'running').length;
    const queued = jobs.filter((j) => j.status === 'queued').length;
    const waitingResource = jobs.filter((j) => j.status === 'waiting_resource').length;
    return {
      maxWorkers: spawner ? spawner.getMaxWorkers() : DEFAULT_MAX_WORKERS,
      running,
      queued,
      waitingResource,
      employeeSnapshots: runtime?.getWorkerSnapshots().filter((s) => s.purpose === 'employee') ?? [],
      deskSnapshot: runtime?.getWorkerSnapshots().find((s) => s.purpose === 'desk') ?? runtime?.getWorkerSnapshot() ?? null,
      jobs
    };
  });

  ipcMain.handle('jobs:set-max-workers', (_event, maxWorkers: number) => {
    const spawner = ensureJobsSpawner(deps);
    const n = Number(maxWorkers);
    if (!Number.isFinite(n) || n < 0) throw new Error('maxWorkers 无效。');
    if (n === 0) spawner.setEnabled(false);
    else spawner.setMaxWorkers(Math.floor(n));
    const resolvedMaxWorkers = spawner.getMaxWorkers();
    broadcastDataChanged({ scopes: ['agent'], reason: 'jobs.maxWorkers' });
    return { maxWorkers: resolvedMaxWorkers };
  });
}

export function resetJobsIpcSpawner(): void {
  setActiveJobSpawner(null);
}
