import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { dispatchBusinessCommand } from './business-command.ts';
import type { SubmitWorkspaceOrchestratorIntentInput, WorkspaceOrchestratorReceipt } from './workspace-orchestrator-runtime.ts';
import { shanghaiDate } from './ferment.ts';
import type { TopicConflictEvidence } from './topic-maintenance-conflict.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export type TopicReproposalJob = Readonly<{
  proposalId: string;
  jobId: string;
  runId: string;
  status: 'pending' | 'completed' | 'needs_user';
  conflicts: readonly TopicConflictEvidence[];
  attempts: number;
  dueAt: string;
  lastError: string | null;
  successorProposalId: string | null;
}>;

type Row = { proposal_id: string; job_id: string; run_id: string; status: TopicReproposalJob['status']; conflict_json: string; attempts: number; due_at: string; last_error: string | null; successor_proposal_id: string | null };
const MAX_ATTEMPTS = 3;
export type TopicReproposalIntentSubmitter = (input: SubmitWorkspaceOrchestratorIntentInput) => Promise<WorkspaceOrchestratorReceipt>;
const retryDelayMs = (attempts: number) => [5_000, 30_000][Math.min(attempts - 1, 1)];
const parse = (row: Row): TopicReproposalJob => ({ proposalId: row.proposal_id, jobId: row.job_id, runId: row.run_id, status: row.status, conflicts: JSON.parse(row.conflict_json), attempts: row.attempts, dueAt: row.due_at, lastError: row.last_error, successorProposalId: row.successor_proposal_id });

export function enqueueTopicReproposal(database: DatabaseSync, proposalId: string, conflicts: readonly TopicConflictEvidence[], now: string): TopicReproposalJob {
  const jobId = randomUUID();
  database.prepare("INSERT OR IGNORE INTO topic_maintenance_reproposal_jobs(proposal_id,job_id,run_id,status,conflict_json,attempts,due_at,created_at,updated_at) VALUES(?,?,?,'pending',?,0,?,?,?)")
    .run(proposalId, jobId, `${jobId}:0`, JSON.stringify(conflicts), now, now, now);
  return getTopicReproposal(database, proposalId)!;
}

export function getTopicReproposal(database: DatabaseSync, proposalId: string): TopicReproposalJob | null {
  const row = database.prepare('SELECT * FROM topic_maintenance_reproposal_jobs WHERE proposal_id=?').get(proposalId) as Row | undefined;
  return row ? parse(row) : null;
}

export function completeTopicReproposal(database: DatabaseSync, parentProposalId: string, successorProposalId: string, now: string): void {
  const result = database.prepare("UPDATE topic_maintenance_reproposal_jobs SET status='completed',successor_proposal_id=?,updated_at=?,completed_at=? WHERE proposal_id=? AND status IN ('pending','needs_user') AND successor_proposal_id IS NULL")
    .run(successorProposalId, now, now, parentProposalId);
  if (Number(result.changes) !== 1) throw new Error('TOPIC_REPROPOSAL_NOT_PENDING');
}

export function resumeTopicReproposal(database: DatabaseSync, proposalId: string, now: string): TopicReproposalJob {
  const current = getTopicReproposal(database, proposalId);
  if (!current) throw new Error('TOPIC_REPROPOSAL_NOT_FOUND');
  if (current.status === 'pending') return current;
  if (current.status !== 'needs_user') throw new Error('TOPIC_REPROPOSAL_NOT_RECOVERABLE');
  database.prepare("UPDATE topic_maintenance_reproposal_jobs SET run_id=?,status='pending',attempts=0,due_at=?,last_error=NULL,updated_at=? WHERE proposal_id=? AND status='needs_user'")
    .run(`${current.jobId}:resume:${randomUUID()}`, now, now, proposalId);
  return getTopicReproposal(database, proposalId)!;
}

function dueTopicReproposals(database: DatabaseSync, now: string): TopicReproposalJob[] {
  return (database.prepare("SELECT * FROM topic_maintenance_reproposal_jobs WHERE status='pending' AND due_at<=? ORDER BY due_at,proposal_id").all(now) as Row[]).map(parse);
}

export async function recordTopicReproposalFailure(runtime: ActiveWorkspaceRuntime, runId: string, error: string): Promise<void> {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'knowledge.topic_maintenance_reproposal_retry', requestId: `topic-reproposal:${runId}:failure:${randomUUID()}`,
    actor: { type: 'scheduler', id: 'topic-reproposal', label: 'Topic reproposal' }, input: { runId, error },
    boundIdentity: { entityType: 'topic_maintenance_reproposal_job', entityId: runId }, entityType: 'topic_maintenance_reproposal_job',
    execute: (database, input) => {
      const row = database.prepare("SELECT * FROM topic_maintenance_reproposal_jobs WHERE run_id=? AND status='pending'").get(input.runId) as Row | undefined;
      if (!row) return { data: null, entityId: input.runId, readback: null };
      const attempts = row.attempts + 1, terminal = attempts >= MAX_ATTEMPTS, now = new Date().toISOString();
      const nextRunId = terminal ? row.run_id : `${row.job_id}:${attempts}`;
      const dueAt = terminal ? row.due_at : new Date(Date.now() + retryDelayMs(attempts)).toISOString();
      database.prepare("UPDATE topic_maintenance_reproposal_jobs SET run_id=?,status=?,attempts=?,due_at=?,last_error=?,updated_at=? WHERE proposal_id=? AND run_id=? AND status='pending'")
        .run(nextRunId, terminal ? 'needs_user' : 'pending', attempts, dueAt, input.error, now, row.proposal_id, row.run_id);
      const data = getTopicReproposal(database, row.proposal_id);
      return { data, entityId: row.proposal_id, readback: data };
    }
  });
  if (!receipt.ok) throw new Error(receipt.error?.message ?? 'TOPIC_REPROPOSAL_RETRY_FAILED');
}

export async function kickTopicReproposals(runtime: ActiveWorkspaceRuntime, submitIntent: TopicReproposalIntentSubmitter): Promise<number> {
  let count = 0;
  for (const item of dueTopicReproposals(runtime.database, new Date().toISOString())) {
    try {
      const businessDate = shanghaiDate(new Date(item.dueAt));
      const logicalInput = {
        businessDate,
        source: 'content_cycle',
        proposalId: item.proposalId,
        reproposalJobId: item.jobId,
        runId: item.runId
      } as const;
      const receipt = await submitIntent({
        producerId: 'maintenance.topic-reproposal',
        businessDate,
        requestId: `maintenance.topic-reproposal:${item.runId}`,
        action: 'stage_d',
        logicalInput,
        payload: logicalInput,
        rootMode: 'scheduler'
      });
      if (!receipt.ok) throw Object.assign(new Error(receipt.message ?? receipt.code ?? 'TOPIC_REPROPOSAL_INTENT_REJECTED'), { code: receipt.code ?? 'TOPIC_REPROPOSAL_INTENT_REJECTED' });
      count += 1;
    } catch (error) {
      try { await recordTopicReproposalFailure(runtime, item.runId, error instanceof Error ? error.message : String(error)); }
      catch (failureError) { console.error('[topic-reproposal-retry]', failureError); }
    }
  }
  return count;
}

export async function handleTopicReproposalJobEvent(runtime: ActiveWorkspaceRuntime, event: Record<string, unknown>): Promise<void> {
  const runId = typeof event.jobId === 'string' ? event.jobId : '';
  if (!runId) return;
  const row = runtime.database.prepare('SELECT proposal_id FROM topic_maintenance_reproposal_jobs WHERE run_id=?').get(runId) as { proposal_id: string } | undefined;
  if (!row) return;
  const current = getTopicReproposal(runtime.database, row.proposal_id);
  if (!current || current.status !== 'pending') return;
  const type = String(event.type ?? '');
  if (!['job.finished', 'job.failed', 'job.cancelled', 'job.partial', 'job.needs_user'].includes(type)) return;
  await recordTopicReproposalFailure(runtime, runId, type === 'job.finished' ? '资料员工单未形成新的主题提案。' : String(event.error ?? event.report ?? type));
}

export async function startTopicReproposalScheduler(runtime: ActiveWorkspaceRuntime, submitIntent: TopicReproposalIntentSubmitter): Promise<() => void> {
  await kickTopicReproposals(runtime, submitIntent);
  const timer = setInterval(() => { if (runtime.isActive) void kickTopicReproposals(runtime, submitIntent).catch((error) => console.error('[topic-reproposal-scheduler]', error)); }, 10_000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
