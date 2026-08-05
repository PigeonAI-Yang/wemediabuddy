import type { DatabaseSync } from 'node:sqlite';
import { CommandDispatchError, type CommandActorV1 } from './command-dispatcher.ts';
import { dispatchBusinessCommand, requireCommandResultData } from './business-command.ts';
import {
  claimMetricJob,
  completeMetricJob,
  failClaimedMetricJob,
  hasScheduledPublicationMetricJobs,
  listMetricJobs,
  recoverMetricJob,
  saveAccountMetricSnapshot,
  savePublicationMetricSnapshot,
  schedulePublicationMetricJobs,
  type MetricJob,
  type MetricSnapshot
} from './metrics.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

type Capture = { sourceUrl: string; capturedAt: string; normalized: Record<string, unknown>; raw: Record<string, unknown> };
type PublicationSchedule = { publicationId: string; publishedAt: string; sourceUrl: string; platform: string; expectedRevision: number };
type PublicationSnapshotInput = Parameters<typeof savePublicationMetricSnapshot>[1] & { expectedRevision?: number; expectedSourceUrl?: string };
type AccountSnapshotInput = Parameters<typeof saveAccountMetricSnapshot>[1] & { expectedRevision?: number; expectedAccountKey?: string };

const ownerActor = Object.freeze({ type: 'owner_ui' as const, id: 'renderer', label: 'Owner UI' });
const schedulerActor = Object.freeze({ type: 'scheduler' as const, id: 'publication-metrics', label: 'Publication Metrics' });

function assertActive(runtime: ActiveWorkspaceRuntime): void {
  if (!runtime.isActive) throw new CommandDispatchError('WORKSPACE_STALE', '工作空间或运行时身份已失效。');
}

function publicationIdOf(job: MetricJob): string {
  return String(job.payload.publicationId ?? '');
}

function transitionRequestId(job: MetricJob, attempt: number, transition: string): string {
  return `publication:${publicationIdOf(job)}:job:${job.id}:attempt:${attempt}:${transition}`;
}

function requirePublishedRevision(database: DatabaseSync, input: PublicationSchedule): void {
  const row = database.prepare(`SELECT revision, status, external_url AS externalUrl, published_at AS publishedAt, platform
    FROM publications WHERE id = ?`).get(input.publicationId) as {
      revision: number; status: string; externalUrl: string | null; publishedAt: string | null; platform: string;
    } | undefined;
  if (!row) throw new CommandDispatchError('NOT_FOUND', '发布记录不存在。');
  if (row.revision !== input.expectedRevision) throw new CommandDispatchError('REVISION_CONFLICT', '发布状态已变化，请重新加载。');
  if (row.status !== 'published' || row.externalUrl !== input.sourceUrl || row.publishedAt !== input.publishedAt || row.platform !== input.platform) {
    throw new CommandDispatchError('INVALID_STATE', '只有已发布且有 URL 的内容可以创建指标任务。');
  }
}

export function dispatchSchedulePublicationMetricJobs(
  runtime: ActiveWorkspaceRuntime,
  requestId: string,
  input: PublicationSchedule,
  actor: CommandActorV1 = ownerActor
) {
  return dispatchBusinessCommand(runtime, {
    command: 'metrics.publication.schedule', requestId, actor, input,
    boundIdentity: { publicationId: input.publicationId, expectedRevision: input.expectedRevision }, entityType: 'publication',
    execute: (database, normalized) => {
      requirePublishedRevision(database, normalized);
      const data = requireCommandResultData(schedulePublicationMetricJobs(database, normalized, false));
      return { data, entityId: normalized.publicationId, beforeRevision: normalized.expectedRevision, afterRevision: normalized.expectedRevision, readback: data };
    }
  });
}

export async function dispatchSchedulePublishedPublicationMetricJobs(runtime: ActiveWorkspaceRuntime): Promise<number> {
  assertActive(runtime);
  const rows = runtime.database.prepare(`SELECT id AS publicationId, published_at AS publishedAt, external_url AS sourceUrl, platform, revision AS expectedRevision
    FROM publications WHERE status = 'published' AND external_url IS NOT NULL AND published_at IS NOT NULL ORDER BY id`).all() as PublicationSchedule[];
  let created = 0;
  for (const input of rows) {
    // Startup runs after every restart. Jobs persist across boots while the
    // deterministic requestId receipt was written under a previous runtimeEpoch,
    // so re-dispatching replays into REQUEST_REPLAY_CONFLICT and aborts boot
    // before window creation. Skip when the windows already exist (business
    // no-op) or the schedule decision was already recorded (replay would throw).
    if (hasScheduledPublicationMetricJobs(runtime.database, input.publicationId)) continue;
    const requestId = `publication:${input.publicationId}:revision:${input.expectedRevision}:metrics-schedule`;
    const recorded = runtime.database.prepare('SELECT 1 AS found FROM command_receipts WHERE workspace_id = ? AND request_id = ?')
      .get(runtime.identity.workspaceId, requestId) as { found: number } | undefined;
    if (recorded) continue;
    const receipt = await dispatchSchedulePublicationMetricJobs(
      runtime,
      requestId,
      input,
      schedulerActor
    );
    if (receipt.ok && receipt.data) created += receipt.data.created;
  }
  return created;
}

export async function dispatchRecoverRunningMetricJobs(runtime: ActiveWorkspaceRuntime, recoveredAt = new Date().toISOString()): Promise<number> {
  assertActive(runtime);
  const running = listMetricJobs(runtime.database).filter((job) => job.status === 'running');
  let recovered = 0;
  for (const job of running) {
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'metrics.job.recover', requestId: transitionRequestId(job, job.attempts, 'recover'), actor: schedulerActor,
      input: { jobId: job.id, expectedAttempts: job.attempts, recoveredAt },
      boundIdentity: { publicationId: publicationIdOf(job), jobId: job.id, attempts: job.attempts, status: 'running' }, entityType: 'metric_job',
      execute: (database, input) => ({ data: requireCommandResultData(recoverMetricJob(database, input.jobId, input.expectedAttempts, input.recoveredAt)), entityId: input.jobId })
    });
    if (receipt.ok) recovered += 1;
  }
  return recovered;
}

export async function dispatchClaimDueMetricJobs(
  runtime: ActiveWorkspaceRuntime,
  nowIso = new Date().toISOString(),
  limit = 20,
  publicationId?: string
): Promise<MetricJob[]> {
  assertActive(runtime);
  const candidates = listMetricJobs(runtime.database)
    .filter((job) => job.status === 'pending' && job.dueAt <= nowIso && (!publicationId || publicationIdOf(job) === publicationId))
    .slice(0, limit);
  const claimed: MetricJob[] = [];
  for (const job of candidates) {
    const attempt = job.attempts + 1;
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'metrics.job.claim', requestId: transitionRequestId(job, attempt, 'claim'), actor: schedulerActor,
      input: { jobId: job.id, expectedAttempts: job.attempts, claimedAt: nowIso },
      boundIdentity: { publicationId: publicationIdOf(job), jobId: job.id, attempts: job.attempts, status: 'pending', dueAt: job.dueAt }, entityType: 'metric_job',
      execute: (database, input) => ({ data: requireCommandResultData(claimMetricJob(database, input.jobId, input.expectedAttempts, input.claimedAt)), entityId: input.jobId })
    });
    if (receipt.ok && receipt.data) claimed.push(receipt.data);
  }
  return claimed;
}

export function dispatchCompleteMetricJob(runtime: ActiveWorkspaceRuntime, job: MetricJob, capture: Capture) {
  const publicationId = publicationIdOf(job);
  const scheduledFor = String(job.payload.scheduledFor ?? job.dueAt);
  const input = { jobId: job.id, publicationId, scheduledFor, ...capture, expectedAttempts: job.attempts };
  return dispatchBusinessCommand(runtime, {
    command: 'metrics.job.complete', requestId: transitionRequestId(job, job.attempts, 'complete'), actor: schedulerActor, input,
    boundIdentity: { publicationId, jobId: job.id, attempts: job.attempts, status: 'running', scheduledFor }, entityType: 'publication_metric_snapshot',
    execute: (database, normalized) => {
      const data = requireCommandResultData(completeMetricJob(database, normalized, false, false));
      return { data, entityId: data.id, readback: data };
    }
  });
}

export function dispatchFailMetricJob(runtime: ActiveWorkspaceRuntime, job: MetricJob, errorMessage: string, failedAt = new Date().toISOString()) {
  const input = { jobId: job.id, expectedAttempts: job.attempts, errorMessage, failedAt };
  return dispatchBusinessCommand(runtime, {
    command: 'metrics.job.fail', requestId: transitionRequestId(job, job.attempts, 'fail'), actor: schedulerActor, input,
    boundIdentity: { publicationId: publicationIdOf(job), jobId: job.id, attempts: job.attempts, status: 'running' }, entityType: 'metric_job',
    execute: (database, normalized) => ({
      data: requireCommandResultData(failClaimedMetricJob(database, normalized.jobId, normalized.expectedAttempts, normalized.errorMessage, normalized.failedAt)),
      entityId: normalized.jobId
    })
  });
}

export function dispatchSavePublicationMetricSnapshot(runtime: ActiveWorkspaceRuntime, requestId: string, input: PublicationSnapshotInput) {
  return dispatchBusinessCommand(runtime, {
    command: 'metrics.publication.snapshot.save', requestId, actor: ownerActor, input,
    boundIdentity: {
      publicationId: input.publicationId,
      scheduledFor: input.scheduledFor,
      expectedRevision: input.expectedRevision ?? null,
      expectedSourceUrl: input.expectedSourceUrl ?? null
    }, entityType: 'publication_metric_snapshot',
    execute: (database, normalized) => {
      if (normalized.expectedRevision !== undefined) {
        const publication = database.prepare('SELECT revision, external_url AS sourceUrl FROM publications WHERE id = ?')
          .get(normalized.publicationId) as { revision: number; sourceUrl: string | null } | undefined;
        if (!publication || publication.revision !== normalized.expectedRevision || publication.sourceUrl !== normalized.expectedSourceUrl) {
          throw new CommandDispatchError('REVISION_CONFLICT', '发布记录已变化，请重新采集。');
        }
      }
      const data = requireCommandResultData(savePublicationMetricSnapshot(database, normalized, false));
      return { data, entityId: data.id, beforeRevision: normalized.expectedRevision, afterRevision: normalized.expectedRevision, readback: data };
    }
  });
}

export function dispatchSaveAccountMetricSnapshot(runtime: ActiveWorkspaceRuntime, requestId: string, input: AccountSnapshotInput) {
  return dispatchBusinessCommand(runtime, {
    command: 'metrics.account.snapshot.save', requestId, actor: ownerActor, input,
    boundIdentity: {
      accountId: input.accountId,
      platform: input.platform,
      expectedRevision: input.expectedRevision ?? null,
      expectedAccountKey: input.expectedAccountKey ?? null
    }, entityType: 'account_metric_snapshot',
    execute: (database, normalized) => {
      if (normalized.expectedRevision !== undefined) {
        const account = database.prepare('SELECT revision, account_key AS accountKey FROM platform_accounts WHERE id = ?')
          .get(normalized.accountId) as { revision: number; accountKey: string } | undefined;
        if (!account || account.revision !== normalized.expectedRevision || account.accountKey !== normalized.expectedAccountKey) {
          throw new CommandDispatchError('REVISION_CONFLICT', '平台账号已变化，请重新采集。');
        }
      }
      const data = requireCommandResultData(saveAccountMetricSnapshot(database, normalized, false));
      return { data, entityId: data.id, beforeRevision: normalized.expectedRevision, afterRevision: normalized.expectedRevision, readback: data };
    }
  });
}

export async function processDueMetricJobs(
  runtime: ActiveWorkspaceRuntime,
  collect: (platform: string, sourceUrl: string) => Promise<Capture>
): Promise<{ processed: number; snapshots: MetricSnapshot[] }> {
  const due = await dispatchClaimDueMetricJobs(runtime);
  const snapshots: MetricSnapshot[] = [];
  for (const job of due) {
    const sourceUrl = String(job.payload.sourceUrl ?? '');
    const platform = String(job.payload.platform ?? '');
    try {
      assertActive(runtime);
      const capture = await collect(platform, sourceUrl);
      assertActive(runtime);
      const receipt = await dispatchCompleteMetricJob(runtime, job, capture);
      if (receipt.ok && receipt.data) snapshots.push(receipt.data);
      else await dispatchFailMetricJob(runtime, job, receipt.error?.message ?? '指标快照保存失败。');
    } catch (error) {
      assertActive(runtime);
      await dispatchFailMetricJob(runtime, job, error instanceof Error ? error.message : String(error));
    }
  }
  return { processed: due.length, snapshots };
}
