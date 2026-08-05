import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { failure, success, type CommandResult } from './result.ts';
import {
  persistBoundXListTimeline,
  readBoundXListTimeline,
  type BoundXListTimelineRead
} from './x-list-execution.ts';
import { getXListBinding, type XListBinding } from './x-lists.ts';
import { readWorkspaceProfile } from './workspace-profiles.ts';
import { readXListTimeline } from './platforms/x-list-browser.ts';
import type { XListBrowserConfig } from './platforms/x-list-primitives.ts';

const windows = [
  { key: '15m', milliseconds: 15 * 60_000 },
  { key: '60m', milliseconds: 60 * 60_000 },
  { key: '180m', milliseconds: 180 * 60_000 }
] as const;
const observationLifetimeMs = 24 * 60 * 60_000;
const observationActor = { type: 'scheduler' as const, id: 'x-observation', label: 'x-observation' };

export type XObservationPayload = {
  sessionId: string; requestId: string; selectedBindingIds: string[];
  workspaceId: string; profileRevision: number; accountKey: string;
  browserId: string; bindingId: string; bindingRevision: number; listId: string;
  startedAt: string; expiresAt: string; scheduledFor: string; window: typeof windows[number]['key'];
  initialSourceIds: string[]; initialSnapshotIds: string[];
};
export type XObservationJob = {
  id: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'needs_user';
  dueAt: string; attempts: number; dedupeKey: string; payload: XObservationPayload;
  lastError: string | null; createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
};
export type XObservationSession = {
  id: string; requestId: string; status: 'pending' | 'running' | 'succeeded' | 'partial' | 'needs_user' | 'failed' | 'stopped';
  replayed: boolean; jobs: XObservationJob[];
};

type JobRow = {
  id: string; status: XObservationJob['status']; due_at: string; attempts: number; dedupe_key: string;
  payload_json: string; last_error: string | null; created_at: string; updated_at: string;
  started_at: string | null; finished_at: string | null;
};

export type StartXObservationInput = { requestId: string; bindingIds: string[]; readTimeline?: typeof readXListTimeline };

export type XObservationStartRead = {
  requestId: string;
  selectedBindingIds: string[];
  workspaceId: string;
  profileRevision: number;
  sessionId: string;
  existing: XObservationSession | null;
  bindings: Array<{
    binding: XListBinding;
    startedAt: string;
    timeline: CommandResult<BoundXListTimelineRead>;
  }>;
};

export async function readXObservationSessionStart(
  database: DatabaseSync,
  config: XListBrowserConfig,
  input: StartXObservationInput
): Promise<CommandResult<XObservationStartRead>> {
  const requestId = input.requestId.trim();
  const selectedBindingIds = [...new Set(input.bindingIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (!requestId || !selectedBindingIds.length) return failure('VALIDATION_ERROR', '观察请求和 List 不能为空。');
  const workspaceId = workspaceIdentity(database);
  const profile = readWorkspaceProfile(database);
  if (!workspaceId || !profile || config.workspaceId !== workspaceId) return failure('REVISION_CONFLICT', '活动工作空间或能力配置已变化。');
  const sessionId = createHash('sha256').update(`${workspaceId}\0${requestId}`).digest('hex');
  const existingJobs = listJobs(database, sessionId);
  if (existingJobs.length) {
    if (JSON.stringify(existingJobs[0].payload.selectedBindingIds) !== JSON.stringify(selectedBindingIds)) return failure('VALIDATION_ERROR', '同一 request_id 已绑定不同 List。');
    return success({ requestId, selectedBindingIds, workspaceId, profileRevision: profile.revision, sessionId, existing: toSession(existingJobs, true), bindings: [] });
  }

  const bindings: XObservationStartRead['bindings'] = [];
  for (const bindingId of selectedBindingIds) {
    const identity = database.prepare('SELECT account_key AS accountKey, list_id AS listId FROM x_list_bindings WHERE id=?')
      .get(bindingId) as { accountKey: string; listId: string } | undefined;
    const binding = identity ? getXListBinding(database, identity.accountKey, identity.listId) : null;
    if (!binding?.enabled) return failure('INVALID_STATE', `List 绑定不可用：${bindingId}`);
    if (config.accountKey && config.accountKey.toLowerCase() !== binding.accountKey.toLowerCase()) return failure('ACCOUNT_MISMATCH', '当前浏览器账号与所选 List 不一致。');
    const startedAt = new Date().toISOString();
    const timeline = await readBoundXListTimeline(database, { ...config, workspaceId, accountKey: binding.accountKey }, {
      accountKey: binding.accountKey, listId: binding.listId,
      expectedBindingId: binding.id, expectedRevision: binding.revision,
      observationKey: `xobs:${sessionId}:${binding.id}:initial`, readTimeline: input.readTimeline
    });
    bindings.push({ binding, startedAt, timeline });
  }
  return success({ requestId, selectedBindingIds, workspaceId, profileRevision: profile.revision, sessionId, existing: null, bindings });
}

export function persistXObservationSessionStart(
  database: DatabaseSync,
  config: XListBrowserConfig,
  read: XObservationStartRead
): CommandResult<XObservationSession> {
  const workspaceId = workspaceIdentity(database);
  const profile = readWorkspaceProfile(database);
  if (!workspaceId || !profile || workspaceId !== read.workspaceId || profile.revision !== read.profileRevision || config.workspaceId !== workspaceId) {
    return failure('REVISION_CONFLICT', '活动工作空间或能力配置已变化。');
  }
  const existingJobs = listJobs(database, read.sessionId);
  if (existingJobs.length) {
    if (JSON.stringify(existingJobs[0].payload.selectedBindingIds) !== JSON.stringify(read.selectedBindingIds)) return failure('VALIDATION_ERROR', '同一 request_id 已绑定不同 List。');
    return success(toSession(existingJobs, true));
  }
  if (read.existing) return failure('REVISION_CONFLICT', '观察会话已变化，请重新加载。');

  for (const item of read.bindings) {
    const current = getXListBinding(database, item.binding.accountKey, item.binding.listId);
    if (!current?.enabled || current.id !== item.binding.id || current.revision !== item.binding.revision
      || (config.accountKey && config.accountKey.toLowerCase() !== current.accountKey.toLowerCase())) {
      return failure('REVISION_CONFLICT', 'X List 来源或账号在读取期间已变化，未写入观察任务。');
    }
    const collected = item.timeline.ok
      ? persistBoundXListTimeline(database, { ...config, workspaceId, accountKey: item.binding.accountKey }, {
        accountKey: item.binding.accountKey, listId: item.binding.listId,
        expectedBindingId: item.binding.id, expectedRevision: item.binding.revision,
        observationKey: `xobs:${read.sessionId}:${item.binding.id}:initial`
      }, item.timeline.data)
      : item.timeline;
    scheduleCapture(database, config, {
      sessionId: read.sessionId, requestId: read.requestId, selectedBindingIds: read.selectedBindingIds,
      workspaceId, profileRevision: profile.revision, binding: item.binding,
      capturedAt: collected.ok ? collected.data.capturedAt : item.startedAt,
      sourceIds: collected.ok ? collected.data.sourceIds : [], snapshotIds: collected.ok ? collected.data.snapshotIds : []
    }, collected.ok ? 'pending' : needsUser(collected.error.code) ? 'needs_user' : 'failed', collected.ok ? null : `${collected.error.code}: ${collected.error.message}`);
  }
  return success(toSession(listJobs(database, read.sessionId), false));
}

export async function startXObservationSession(
  database: DatabaseSync,
  config: XListBrowserConfig,
  input: StartXObservationInput
): Promise<CommandResult<XObservationSession>> {
  const read = await readXObservationSessionStart(database, config, input);
  if (!read.ok || read.data.existing) return read.ok ? success(read.data.existing!) : read;
  database.exec('BEGIN IMMEDIATE');
  try {
    const persisted = persistXObservationSessionStart(database, config, read.data);
    if (!persisted.ok) {
      database.exec('ROLLBACK');
      return persisted;
    }
    database.exec('COMMIT');
    return persisted;
  } catch (error) {
    database.exec('ROLLBACK');
    return failure('VALIDATION_ERROR', error instanceof Error ? error.message : String(error));
  }
}

export function scheduleXObservationCapture(database: DatabaseSync, config: XListBrowserConfig, input: {
  requestId: string; selectedBindingIds: string[]; binding: XListBinding;
  capturedAt: string; sourceIds: string[]; snapshotIds: string[];
}): XObservationSession {
  const requestId = input.requestId.trim(); const selectedBindingIds = [...new Set(input.selectedBindingIds)].sort();
  const workspaceId = workspaceIdentity(database); const profile = readWorkspaceProfile(database);
  const current = getXListBinding(database, input.binding.accountKey, input.binding.listId);
  if (!requestId || !selectedBindingIds.length || !workspaceId || config.workspaceId !== workspaceId || !profile
    || !current?.enabled || current.id !== input.binding.id || current.revision !== input.binding.revision) throw new Error('OBSERVATION_CONTEXT_STALE');
  const sessionId = createHash('sha256').update(`${workspaceId}\0${requestId}`).digest('hex');
  const existing = listJobs(database, sessionId);
  if (existing.length && JSON.stringify(existing[0].payload.selectedBindingIds) !== JSON.stringify(selectedBindingIds)) throw new Error('OBSERVATION_REQUEST_CONFLICT');
  if (!existing.some((job) => job.payload.bindingId === current.id)) scheduleCapture(database, config, {
    sessionId, requestId, selectedBindingIds, workspaceId, profileRevision: profile.revision,
    binding: current, capturedAt: input.capturedAt, sourceIds: input.sourceIds, snapshotIds: input.snapshotIds
  }, 'pending', null);
  return toSession(listJobs(database, sessionId), existing.length > 0);
}
export async function dispatchScheduleXObservationCapture(
  dependency: ActiveWorkspaceRuntime | DatabaseSync,
  config: XListBrowserConfig,
  input: { requestId: string; selectedBindingIds: string[]; binding: XListBinding; capturedAt: string; sourceIds: string[]; snapshotIds: string[] },
  taskId?: string,
  workerLeaseId?: string
): Promise<XObservationSession> {
  const database = 'database' in dependency ? dependency.database : dependency;
  if (!('database' in dependency)) return scheduleXObservationCapture(database, config, input);
  const receipt = await dispatchBusinessCommand(dependency, {
    command: 'x_observation.schedule', requestId: `${input.requestId}:${input.binding.id}:schedule`,
    actor: { type: 'scheduler', id: 'daily-intelligence', label: 'daily-intelligence' },
    input: { config, input }, boundIdentity: dependency.identity, taskId, workerLeaseId,
    causation: taskId ? { taskId } : undefined, entityType: 'x_observation_session',
    execute: (_database, normalized) => {
      const session = scheduleXObservationCapture(database, normalized.config, normalized.input);
      return { data: session, entityId: session.id };
    }
  });
  return requireReceiptData(receipt);
}

export function getXObservationSession(database: DatabaseSync, sessionId: string): XObservationSession | null {
  const jobs = listJobs(database, sessionId);
  return jobs.length ? toSession(jobs, true) : null;
}

export function stopXObservationSession(database: DatabaseSync, sessionId: string): XObservationSession | null {
  const now = new Date().toISOString();
  database.prepare(`UPDATE jobs SET status='failed', last_error='OBSERVATION_STOPPED', finished_at=?, updated_at=?
    WHERE kind='x_list_observation' AND dedupe_key LIKE ? AND status IN ('pending','running')`)
    .run(now, now, `xobs:${sessionId}:%`);
  return getXObservationSession(database, sessionId);
}

export async function recoverRunningXObservationJobs(dependency: ActiveWorkspaceRuntime | DatabaseSync, generation = 0): Promise<number> {
  const database = 'database' in dependency ? dependency.database : dependency;
  const execute = () => {
    const now = new Date().toISOString();
    return Number(database.prepare(`UPDATE jobs SET status='pending', started_at=NULL, updated_at=?
      WHERE kind='x_list_observation' AND status='running'`).run(now).changes ?? 0);
  };
  if (!('database' in dependency)) return execute();
  const receipt = await dispatchBusinessCommand(dependency, {
    command: 'x_observation.jobs_recover', requestId: `${dependency.identity.runtimeEpoch}:xobs:recover:${generation}`,
    actor: observationActor, input: { generation }, boundIdentity: dependency.identity, entityType: 'x_observation_job',
    execute: () => ({ data: execute(), sideEffectState: 'committed' })
  });
  return requireReceiptData(receipt);
}

export async function processDueXObservationJobs(dependency: ActiveWorkspaceRuntime | DatabaseSync, input: {
  now?: string;
  generation?: number;
  getConfig: (payload: XObservationPayload) => Promise<XListBrowserConfig>;
  readTimeline?: typeof readXListTimeline;
  isCurrent?: () => boolean;
}): Promise<{ processed: number; succeeded: number }> {
  const database = 'database' in dependency ? dependency.database : dependency;
  const now = input.now ?? new Date().toISOString();
  await expireSupersededWindows(dependency, now, input.generation ?? 0);
  let processed = 0; let succeeded = 0;
  for (;;) {
    if (input.isCurrent && !input.isCurrent()) break;
    const claimed = await claimNext(dependency, now, input.generation ?? 0);
    if (!claimed) break;
    const { job, requestId: claimRequestId } = claimed;
    processed += 1;
    const payload = job.payload;
    if (!frozenContextMatches(database, payload) || (input.isCurrent && !input.isCurrent())) {
      await dispatchFinishJob(dependency, job, 'needs_user', 'OBSERVATION_CONTEXT_STALE', claimRequestId, input.generation ?? 0);
      continue;
    }
    let config: XListBrowserConfig;
    try { config = await input.getConfig(payload); }
    catch (error) {
      await dispatchFinishJob(dependency, job, 'needs_user', error instanceof Error ? error.message : String(error), claimRequestId, input.generation ?? 0);
      continue;
    }
    const timeline = await readBoundXListTimeline(database, { ...config, workspaceId: payload.workspaceId, accountKey: payload.accountKey }, {
      accountKey: payload.accountKey, listId: payload.listId,
      expectedBindingId: payload.bindingId, expectedRevision: payload.bindingRevision,
      expectedObservationJobId: job.id, observationKey: `xobs:${job.id}`,
      scheduledFor: payload.scheduledFor, readTimeline: input.readTimeline, isCurrent: input.isCurrent
    });
    if (input.isCurrent && !input.isCurrent()) continue;
    const committed = await dispatchObservationCapture(dependency, job, config, timeline, claimRequestId, input);
    if (committed) succeeded += 1;
  }
  return { processed, succeeded };
}

export function nextXObservationDueAt(database: DatabaseSync): string | null {
  const row = database.prepare(`SELECT due_at AS dueAt FROM jobs WHERE kind='x_list_observation' AND status='pending' ORDER BY due_at LIMIT 1`)
    .get() as { dueAt?: string } | undefined;
  return row?.dueAt ?? null;
}

function scheduleJobs(database: DatabaseSync, base: Omit<XObservationPayload, 'scheduledFor' | 'window'>, status: XObservationJob['status'], error: string | null): void {
  const baseMs = Date.parse(base.startedAt); const now = new Date().toISOString();
  for (const window of windows) {
    const scheduledFor = new Date(baseMs + window.milliseconds).toISOString();
    database.prepare(`INSERT INTO jobs (id,kind,status,due_at,attempts,dedupe_key,payload_json,last_error,created_at,updated_at,started_at,finished_at)
      VALUES (?,'x_list_observation',?,?,0,?,?,?, ?,?,NULL,?)`).run(
      randomUUID(), status, scheduledFor, `xobs:${base.sessionId}:${base.bindingId}:${window.key}`,
      JSON.stringify({ ...base, scheduledFor, window: window.key }), error, now, now, status === 'pending' ? null : now
    );
  }
}

function scheduleCapture(database: DatabaseSync, config: XListBrowserConfig, input: {
  sessionId: string; requestId: string; selectedBindingIds: string[]; workspaceId: string; profileRevision: number;
  binding: XListBinding; capturedAt: string; sourceIds: string[]; snapshotIds: string[];
}, status: XObservationJob['status'], error: string | null): void {
  scheduleJobs(database, {
    sessionId: input.sessionId, requestId: input.requestId, selectedBindingIds: input.selectedBindingIds,
    workspaceId: input.workspaceId, profileRevision: input.profileRevision, accountKey: input.binding.accountKey,
    browserId: config.id, bindingId: input.binding.id, bindingRevision: input.binding.revision, listId: input.binding.listId,
    startedAt: input.capturedAt, expiresAt: new Date(Date.parse(input.capturedAt) + observationLifetimeMs).toISOString(),
    initialSourceIds: input.sourceIds, initialSnapshotIds: input.snapshotIds
  }, status, error);
}

async function expireSupersededWindows(dependency: ActiveWorkspaceRuntime | DatabaseSync, nowIso: string, generation: number): Promise<void> {
  const database = 'database' in dependency ? dependency.database : dependency;
  const nowMs = Date.parse(nowIso); const pending = listJobs(database).filter((job) => job.status === 'pending');
  const dueGroups = new Map<string, XObservationJob[]>();
  for (const job of pending) {
    const expired = !Number.isFinite(Date.parse(job.payload.expiresAt)) || nowMs > Date.parse(job.payload.expiresAt);
    if (expired) { await dispatchFinishJob(dependency, job, 'failed', 'OBSERVATION_WINDOW_EXPIRED', null, generation); continue; }
    if (Date.parse(job.dueAt) > nowMs) continue;
    const key = `${job.payload.sessionId}:${job.payload.bindingId}`;
    dueGroups.set(key, [...(dueGroups.get(key) ?? []), job]);
  }
  for (const jobs of dueGroups.values()) {
    jobs.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    for (const job of jobs.slice(0, -1)) await dispatchFinishJob(dependency, job, 'failed', 'OBSERVATION_WINDOW_EXPIRED', null, generation);
  }
}

async function claimNext(dependency: ActiveWorkspaceRuntime | DatabaseSync, nowIso: string, generation: number): Promise<{ job: XObservationJob; requestId: string } | null> {
  const database = 'database' in dependency ? dependency.database : dependency;
  const row = database.prepare(`SELECT * FROM jobs WHERE kind='x_list_observation' AND status='pending' AND due_at<=? ORDER BY due_at LIMIT 1`).get(nowIso) as JobRow | undefined;
  if (!row) return null;
  const requestId = `${row.id}:claim:${row.attempts + 1}:generation:${generation}`;
  const execute = () => {
    const updated = database.prepare(`UPDATE jobs SET status='running',attempts=attempts+1,started_at=?,updated_at=? WHERE id=? AND status='pending' AND attempts=?`).run(nowIso, nowIso, row.id, row.attempts);
    return Number(updated.changes ?? 0) === 1 ? parseJob(database.prepare('SELECT * FROM jobs WHERE id=?').get(row.id) as JobRow) : null;
  };
  if (!('database' in dependency)) { const job = execute(); return job ? { job, requestId } : null; }
  const receipt = await dispatchBusinessCommand(dependency, {
    command: 'x_observation.job_claim', requestId, actor: observationActor,
    input: { jobId: row.id, expectedAttempts: row.attempts, nowIso, generation }, boundIdentity: dependency.identity,
    causation: { sessionId: parseJob(row).payload.sessionId }, entityType: 'x_observation_job',
    execute: () => ({ data: execute(), entityId: row.id })
  });
  const job = requireReceiptData(receipt);
  return job ? { job, requestId } : null;
}

async function dispatchFinishJob(dependency: ActiveWorkspaceRuntime | DatabaseSync, job: XObservationJob, status: 'succeeded' | 'failed' | 'needs_user', error: string | null, claimRequestId: string | null, generation: number): Promise<void> {
  const database = 'database' in dependency ? dependency.database : dependency;
  const execute = () => finishJob(database, job.id, status, error);
  if (!('database' in dependency)) return execute();
  await dispatchBusinessCommand(dependency, {
    command: 'x_observation.job_finish', requestId: `${job.id}:finish:${job.attempts}:${status}:${generation}`,
    actor: observationActor, input: { jobId: job.id, attempts: job.attempts, status, error, generation },
    boundIdentity: dependency.identity, causation: claimRequestId ? { requestId: claimRequestId } : { sessionId: job.payload.sessionId },
    entityType: 'x_observation_job', execute: () => ({ data: execute(), entityId: job.id })
  });
}

async function dispatchObservationCapture(dependency: ActiveWorkspaceRuntime | DatabaseSync, job: XObservationJob, config: XListBrowserConfig, timeline: CommandResult<BoundXListTimelineRead>, claimRequestId: string, input: { generation?: number; isCurrent?: () => boolean }): Promise<boolean> {
  const database = 'database' in dependency ? dependency.database : dependency;
  const persist = () => {
    const current = database.prepare('SELECT * FROM jobs WHERE id=?').get(job.id) as JobRow | undefined;
    if (!current || current.status !== 'running' || current.attempts !== job.attempts || !frozenContextMatches(database, job.payload) || (input.isCurrent && !input.isCurrent())) return false;
    if (!timeline.ok) { finishJob(database, job.id, needsUser(timeline.error.code) ? 'needs_user' : 'failed', `${timeline.error.code}: ${timeline.error.message}`); return false; }
    const collected = persistBoundXListTimeline(database, { ...config, workspaceId: job.payload.workspaceId, accountKey: job.payload.accountKey }, {
      accountKey: job.payload.accountKey, listId: job.payload.listId,
      expectedBindingId: job.payload.bindingId, expectedRevision: job.payload.bindingRevision,
      expectedObservationJobId: job.id, observationKey: `xobs:${job.id}`, scheduledFor: job.payload.scheduledFor, isCurrent: input.isCurrent
    }, timeline.data);
    if (collected.ok) { finishJob(database, job.id, 'succeeded', null); return true; }
    finishJob(database, job.id, needsUser(collected.error.code) ? 'needs_user' : 'failed', `${collected.error.code}: ${collected.error.message}`);
    return false;
  };
  if (!('database' in dependency)) return persist();
  const generation = input.generation ?? 0;
  const receipt = await dispatchBusinessCommand(dependency, {
    command: 'x_observation.capture_commit', requestId: `${job.id}:capture:${job.attempts}:generation:${generation}`,
    actor: observationActor, input: { jobId: job.id, attempts: job.attempts, generation, timeline }, boundIdentity: dependency.identity,
    causation: { requestId: claimRequestId }, entityType: 'x_observation_job', execute: () => ({ data: persist(), entityId: job.id })
  });
  return requireReceiptData(receipt);
}

function finishJob(database: DatabaseSync, id: string, status: 'succeeded' | 'failed' | 'needs_user', error: string | null): void {
  const current = database.prepare('SELECT status FROM jobs WHERE id=?').get(id) as { status?: string } | undefined;
  if (!current || (current.status !== 'running' && current.status !== 'pending')) return;
  const now = new Date().toISOString();
  database.prepare('UPDATE jobs SET status=?,last_error=?,finished_at=?,updated_at=? WHERE id=?').run(status, error, now, now, id);
}

function frozenContextMatches(database: DatabaseSync, payload: XObservationPayload): boolean {
  const profile = readWorkspaceProfile(database);
  return workspaceIdentity(database) === payload.workspaceId && profile?.revision === payload.profileRevision;
}

function workspaceIdentity(database: DatabaseSync): string | null {
  return (database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value ?? null;
}

function listJobs(database: DatabaseSync, sessionId?: string): XObservationJob[] {
  const rows = (sessionId
    ? database.prepare(`SELECT * FROM jobs WHERE kind='x_list_observation' AND dedupe_key LIKE ? ORDER BY due_at,id`).all(`xobs:${sessionId}:%`)
    : database.prepare(`SELECT * FROM jobs WHERE kind='x_list_observation' ORDER BY due_at,id`).all()) as JobRow[];
  return rows.map(parseJob);
}

function parseJob(row: JobRow): XObservationJob {
  return {
    id: row.id, status: row.status, dueAt: row.due_at, attempts: row.attempts, dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as XObservationPayload, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at, finishedAt: row.finished_at
  };
}

function toSession(jobs: XObservationJob[], replayed: boolean): XObservationSession {
  const statuses = new Set(jobs.map((job) => job.status));
  const stopped = jobs.some((job) => job.lastError === 'OBSERVATION_STOPPED') && !statuses.has('pending') && !statuses.has('running');
  const status = stopped ? 'stopped'
    : statuses.has('running') ? 'running'
    : statuses.has('pending') ? 'pending'
    : statuses.size === 1 && statuses.has('succeeded') ? 'succeeded'
    : statuses.size === 1 && statuses.has('needs_user') ? 'needs_user'
    : statuses.has('succeeded') ? 'partial' : 'failed';
  return { id: jobs[0].payload.sessionId, requestId: jobs[0].payload.requestId, status, replayed, jobs };
}

function needsUser(code: string): boolean { return code === 'BROWSER_NEEDS_USER' || code === 'ACCOUNT_MISMATCH'; }
