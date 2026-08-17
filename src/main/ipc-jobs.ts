import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import {
  ensureJobSpawner,
  getActiveJobSpawner,
  setActiveJobSpawner,
  type SpawnJobRequest
} from './job-spawner.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { DEFAULT_MAX_WORKERS } from './job-pool.ts';
import { createGenericEmployeeRunner } from './generic-employee-runner.ts';
import type { RoleJobReportV1 } from './role-job-registry.ts';
import { notifyDeskJobEvent } from './manager-job-notify.ts';
import { broadcastDataChanged } from './data-changed.ts';
import type { McpRuntime } from './mcp.ts';
import { handleTopicReproposalJobEvent } from './topic-maintenance-reproposal.ts';
import { handleResearchSuccessorJobEvent } from './research-successor.ts';
import { buildInvestigationSupervisorReviewPrompt, handleInvestigationJobEvent } from './project-investigation.ts';
import { runDockManagerPrompt } from './ipc-pi-dock.ts';

export type JobsIpcDependencies = {
  getActiveRuntime: () => ActiveWorkspaceRuntime | null;
};

const supervisorReviewsStarted = new Set<string>();

function dispatchInvestigationSupervisorReview(projectId: string): void {
  if (supervisorReviewsStarted.has(projectId)) return;
  supervisorReviewsStarted.add(projectId);
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
    supervisorReviewsStarted.delete(projectId);
    console.error('[project-investigation-supervisor-review]', error);
  });
}

export function resumePendingInvestigationSupervisorReviews(runtime: ActiveWorkspaceRuntime): void {
  const rows = runtime.database.prepare(
    `SELECT project_id FROM project_investigations WHERE status = 'research_review' ORDER BY updated_at ASC`
  ).all() as Array<{ project_id: string }>;
  for (const row of rows) dispatchInvestigationSupervisorReview(row.project_id);
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
            dispatchInvestigationSupervisorReview(investigation.projectId);
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
  ipcMain.handle('jobs:spawn', (_event, input: SpawnJobRequest) => {
    const spawner = ensureJobsSpawner(deps);
    return spawner.spawn(input);
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
    broadcastDataChanged({ scopes: ['agent'], reason: 'jobs.maxWorkers' });
    return { maxWorkers: n };
  });
}

export function resetJobsIpcSpawner(): void {
  setActiveJobSpawner(null);
}
