import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { collectBoundXListTimeline } from './x-list-execution.ts';
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

export async function startXObservationSession(
  database: DatabaseSync,
  config: XListBrowserConfig,
  input: { requestId: string; bindingIds: string[]; readTimeline?: typeof readXListTimeline }
): Promise<CommandResult<XObservationSession>> {
  const requestId = input.requestId.trim();
  const selectedBindingIds = [...new Set(input.bindingIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (!requestId || !selectedBindingIds.length) return failure('VALIDATION_ERROR', '观察请求和 List 不能为空。');
  const workspaceId = workspaceIdentity(database);
  const profile = readWorkspaceProfile(database);
  if (!workspaceId || !profile || config.workspaceId !== workspaceId) return failure('REVISION_CONFLICT', '活动工作空间或能力配置已变化。');
  const sessionId = createHash('sha256').update(`${workspaceId}\0${requestId}`).digest('hex');
  const existing = listJobs(database, sessionId);
  if (existing.length) {
    if (JSON.stringify(existing[0].payload.selectedBindingIds) !== JSON.stringify(selectedBindingIds)) return failure('VALIDATION_ERROR', '同一 request_id 已绑定不同 List。');
    return success(toSession(existing, true));
  }

  const bindings: XListBinding[] = [];
  for (const bindingId of selectedBindingIds) {
    const identity = database.prepare('SELECT account_key AS accountKey, list_id AS listId FROM x_list_bindings WHERE id=?')
      .get(bindingId) as { accountKey: string; listId: string } | undefined;
    const binding = identity ? getXListBinding(database, identity.accountKey, identity.listId) : null;
    if (!binding?.enabled) return failure('INVALID_STATE', `List 绑定不可用：${bindingId}`);
    if (config.accountKey && config.accountKey.toLowerCase() !== binding.accountKey.toLowerCase()) return failure('ACCOUNT_MISMATCH', '当前浏览器账号与所选 List 不一致。');
    bindings.push(binding);
  }

  for (const binding of bindings) {
    const startedAt = new Date().toISOString();
    const collected = await collectBoundXListTimeline(database, { ...config, workspaceId, accountKey: binding.accountKey }, {
      accountKey: binding.accountKey, listId: binding.listId,
      expectedBindingId: binding.id, expectedRevision: binding.revision,
      observationKey: `xobs:${sessionId}:${binding.id}:initial`, readTimeline: input.readTimeline
    });
    scheduleCapture(database, config, { sessionId, requestId, selectedBindingIds, workspaceId, profileRevision: profile.revision,
      binding, capturedAt: collected.ok ? collected.data.capturedAt : startedAt,
      sourceIds: collected.ok ? collected.data.sourceIds : [], snapshotIds: collected.ok ? collected.data.snapshotIds : []
    }, collected.ok ? 'pending' : needsUser(collected.error.code) ? 'needs_user' : 'failed', collected.ok ? null : `${collected.error.code}: ${collected.error.message}`);
  }
  return success(toSession(listJobs(database, sessionId), false));
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

export function recoverRunningXObservationJobs(database: DatabaseSync): number {
  const now = new Date().toISOString();
  return Number(database.prepare(`UPDATE jobs SET status='pending', started_at=NULL, updated_at=?
    WHERE kind='x_list_observation' AND status='running'`).run(now).changes ?? 0);
}

export async function processDueXObservationJobs(database: DatabaseSync, input: {
  now?: string;
  getConfig: (payload: XObservationPayload) => Promise<XListBrowserConfig>;
  readTimeline?: typeof readXListTimeline;
  isCurrent?: () => boolean;
}): Promise<{ processed: number; succeeded: number }> {
  const now = input.now ?? new Date().toISOString();
  expireSupersededWindows(database, now);
  let processed = 0; let succeeded = 0;
  for (;;) {
    const job = claimNext(database, now);
    if (!job) break;
    processed += 1;
    const payload = job.payload;
    if (!frozenContextMatches(database, payload) || (input.isCurrent && !input.isCurrent())) {
      finishJob(database, job.id, 'needs_user', 'OBSERVATION_CONTEXT_STALE');
      continue;
    }
    try {
      const config = await input.getConfig(payload);
      const collected = await collectBoundXListTimeline(database, { ...config, workspaceId: payload.workspaceId, accountKey: payload.accountKey }, {
        accountKey: payload.accountKey, listId: payload.listId,
        expectedBindingId: payload.bindingId, expectedRevision: payload.bindingRevision,
        expectedObservationJobId: job.id, observationKey: `xobs:${job.id}`,
        scheduledFor: payload.scheduledFor, readTimeline: input.readTimeline, isCurrent: input.isCurrent
      });
      if (collected.ok) { finishJob(database, job.id, 'succeeded', null); succeeded += 1; }
      else finishJob(database, job.id, needsUser(collected.error.code) ? 'needs_user' : 'failed', `${collected.error.code}: ${collected.error.message}`);
    } catch (error) {
      finishJob(database, job.id, 'needs_user', error instanceof Error ? error.message : String(error));
    }
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
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const window of windows) {
      const scheduledFor = new Date(baseMs + window.milliseconds).toISOString();
      database.prepare(`INSERT INTO jobs (id,kind,status,due_at,attempts,dedupe_key,payload_json,last_error,created_at,updated_at,started_at,finished_at)
        VALUES (?,'x_list_observation',?,?,0,?,?,?, ?,?,NULL,?)`).run(
        randomUUID(), status, scheduledFor, `xobs:${base.sessionId}:${base.bindingId}:${window.key}`,
        JSON.stringify({ ...base, scheduledFor, window: window.key }), error, now, now, status === 'pending' ? null : now
      );
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
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

function expireSupersededWindows(database: DatabaseSync, nowIso: string): void {
  const nowMs = Date.parse(nowIso); const pending = listJobs(database).filter((job) => job.status === 'pending');
  const dueGroups = new Map<string, XObservationJob[]>();
  for (const job of pending) {
    const expired = !Number.isFinite(Date.parse(job.payload.expiresAt)) || nowMs > Date.parse(job.payload.expiresAt);
    if (expired) { finishJob(database, job.id, 'failed', 'OBSERVATION_WINDOW_EXPIRED'); continue; }
    if (Date.parse(job.dueAt) > nowMs) continue;
    const key = `${job.payload.sessionId}:${job.payload.bindingId}`;
    dueGroups.set(key, [...(dueGroups.get(key) ?? []), job]);
  }
  for (const jobs of dueGroups.values()) {
    jobs.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    for (const job of jobs.slice(0, -1)) finishJob(database, job.id, 'failed', 'OBSERVATION_WINDOW_EXPIRED');
  }
}

function claimNext(database: DatabaseSync, nowIso: string): XObservationJob | null {
  const row = database.prepare(`SELECT * FROM jobs WHERE kind='x_list_observation' AND status='pending' AND due_at<=? ORDER BY due_at LIMIT 1`)
    .get(nowIso) as JobRow | undefined;
  if (!row) return null;
  const updated = database.prepare(`UPDATE jobs SET status='running',attempts=attempts+1,started_at=?,updated_at=? WHERE id=? AND status='pending'`)
    .run(nowIso, nowIso, row.id);
  return Number(updated.changes ?? 0) === 1 ? parseJob(database.prepare('SELECT * FROM jobs WHERE id=?').get(row.id) as JobRow) : null;
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
