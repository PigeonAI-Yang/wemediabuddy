import { broadcastDataChanged } from './data-changed.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { recordOperation } from './operations.ts';
import { getToday } from './workbench.ts';
import { getStudio } from './content.ts';
import { listReviews } from './reviews.ts';

export type AgentIntent = 'daily_intelligence' | 'studio_draft' | 'results_review';
export type AgentTaskStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'interrupted' | 'needs_user';
export type AgentTaskControl = 'skip_source' | 'save_partial' | 'cancel';
export type AgentTaskProgress = {
  currentSource?: string;
  planned?: number;
  processed?: number;
  failed?: number;
  verified?: number;
  saved?: number;
  opportunityCount?: number;
  lastActivityAt?: string;
};
export type AgentTaskEvent = { at: string; message: string; level?: 'info' | 'warning' };

export type AgentTask = {
  id: string;
  intent: AgentIntent;
  businessDate: string;
  status: AgentTaskStatus;
  phase: string;
  piSessionId: string | null;
  contextRefs: Record<string, unknown>;
  resultRefs: Record<string, unknown>;
  progress: AgentTaskProgress;
  checkpoint: Record<string, unknown>;
  events: AgentTaskEvent[];
  controlAction: AgentTaskControl | null;
  heartbeatAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

type AgentTaskRow = {
  id: string;
  intent: AgentIntent;
  business_date: string;
  status: AgentTaskStatus;
  phase: string;
  pi_session_id: string | null;
  context_refs_json: string;
  result_refs_json: string;
  progress_json: string;
  checkpoint_json: string;
  events_json: string;
  control_action: AgentTaskControl | null;
  heartbeat_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

const intents: AgentIntent[] = ['daily_intelligence', 'studio_draft', 'results_review'];

function parseTask(row: AgentTaskRow): AgentTask {
  return {
    id: row.id,
    intent: row.intent,
    businessDate: row.business_date,
    status: row.status,
    phase: row.phase,
    piSessionId: row.pi_session_id,
    contextRefs: JSON.parse(row.context_refs_json) as Record<string, unknown>,
    resultRefs: JSON.parse(row.result_refs_json) as Record<string, unknown>,
    progress: JSON.parse(row.progress_json) as AgentTaskProgress,
    checkpoint: JSON.parse(row.checkpoint_json) as Record<string, unknown>,
    events: JSON.parse(row.events_json) as AgentTaskEvent[],
    controlAction: row.control_action,
    heartbeatAt: row.heartbeat_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  };
}

function getRow(database: DatabaseSync, id: string): AgentTaskRow | undefined {
  return database.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).get(id) as AgentTaskRow | undefined;
}

export function agentRequestId(taskId: string, logicalStep: string): string {
  return `${taskId}:${logicalStep}`;
}

export function getAgentTask(database: DatabaseSync, id: string): AgentTask | null {
  const row = getRow(database, id);
  return row ? parseTask(row) : null;
}


function requireTask(database: DatabaseSync, id: string): AgentTask {
  const task = getAgentTask(database, id);
  if (!task) throw new Error(`Agent 任务不存在：${id}`);
  return task;
}
export function getActiveAgentTask(database: DatabaseSync, intent: AgentIntent, businessDate: string): AgentTask | null {
  const row = database.prepare(`SELECT * FROM agent_tasks
    WHERE intent = ? AND business_date = ? AND status = 'running'
    ORDER BY created_at DESC LIMIT 1`).get(intent, businessDate) as AgentTaskRow | undefined;
  return row ? parseTask(row) : null;
}

export function getLatestAgentTask(database: DatabaseSync, intent?: AgentIntent, businessDate?: string): AgentTask | null {
  if (intent && businessDate) {
    const row = database.prepare(`SELECT * FROM agent_tasks
      WHERE intent = ? AND business_date = ? ORDER BY created_at DESC LIMIT 1`).get(intent, businessDate) as AgentTaskRow | undefined;
    return row ? parseTask(row) : null;
  }
  if (intent) {
    const row = database.prepare(`SELECT * FROM agent_tasks
      WHERE intent = ? ORDER BY created_at DESC LIMIT 1`).get(intent) as AgentTaskRow | undefined;
    return row ? parseTask(row) : null;
  }
  const row = database.prepare(`SELECT * FROM agent_tasks
    ORDER BY created_at DESC LIMIT 1`).get() as AgentTaskRow | undefined;
  return row ? parseTask(row) : null;
}

export function startAgentTask(
  database: DatabaseSync,
  input: { intent: AgentIntent; businessDate: string; contextRefs?: Record<string, unknown>; piSessionId?: string | null }
): CommandResult<AgentTask> & { reused?: boolean } {
  if (!intents.includes(input.intent)) return failure<AgentTask>('VALIDATION_ERROR', '不支持的 Pi 意图。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) return failure<AgentTask>('VALIDATION_ERROR', '业务日期必须是 YYYY-MM-DD。');

  const active = getActiveAgentTask(database, input.intent, input.businessDate);
  if (active) {
    recordOperation(database, {
      actorType: 'ui',
      command: 'agent_tasks.reuse',
      entityType: 'agent_task',
      entityId: active.id,
      result: 'ok'
    });
    const reusedTask: AgentTask = active;
    return { ok: true, data: reusedTask, error: null, reused: true };
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const profileContext = readTaskProfileContext(database);
  database.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, heartbeat_at,
    error_code, error_message, created_at, updated_at, finished_at
  ) VALUES (?, ?, ?, 'running', 'starting', ?, ?, '{}', '{}', '{}', '[]', ?,
    NULL, NULL, ?, ?, NULL)`).run(
    id,
    input.intent,
    input.businessDate,
    input.piSessionId ?? null,
    JSON.stringify({ ...(input.contextRefs ?? {}), ...profileContext }),
    now,
    now,
    now
  );
  recordOperation(database, {
    actorType: 'ui',
    command: 'agent_tasks.start',
    entityType: 'agent_task',
    entityId: id,
    result: 'ok'
  });
  const created = getAgentTask(database, id);
  if (!created) return failure<AgentTask>('NOT_FOUND', '创建 Agent 任务后读取失败。');
  broadcastDataChanged({ scopes: ['agent', 'today'], reason: 'agent.start' });
  return { ok: true, data: created, error: null, reused: false };
}

function readTaskProfileContext(database: DatabaseSync): Record<string, unknown> {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_profiles'").get()) return {};
  const profile = database.prepare("SELECT profile_id AS profileId, revision FROM workspace_profiles WHERE id='effective'").get() as { profileId: string; revision: number } | undefined;
  const workspace = database.prepare("SELECT value AS workspaceId FROM app_meta WHERE key='workspace_id'").get() as { workspaceId: string } | undefined;
  return profile ? { workspaceId: workspace?.workspaceId ?? null, workspaceProfileId: profile.profileId, workspaceProfileRevision: profile.revision } : {};
}
export function updateAgentTaskPhase(
  database: DatabaseSync,
  id: string,
  phase: string,
  extras: { piSessionId?: string | null; contextRefs?: Record<string, unknown> } = {}
): CommandResult<AgentTask> {
  const current = getRow(database, id);
  if (!current) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (current.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以更新阶段。');
  const now = new Date().toISOString();
  database.prepare(`UPDATE agent_tasks SET phase = ?, pi_session_id = COALESCE(?, pi_session_id),
    context_refs_json = COALESCE(?, context_refs_json), updated_at = ? WHERE id = ?`).run(
    phase,
    extras.piSessionId ?? null,
    extras.contextRefs ? JSON.stringify(extras.contextRefs) : null,
    now,
    id
  );
  return success(requireTask(database, id));
}

export function reportAgentTaskProgress(
  database: DatabaseSync,
  id: string,
  input: { phase?: string; progress?: AgentTaskProgress; checkpoint?: Record<string, unknown>; message?: string; level?: 'info' | 'warning' }
): CommandResult<AgentTask> {
  const task = getAgentTask(database, id);
  if (!task) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (task.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以汇报进度。');
  const now = new Date().toISOString();
  const hasActivity = Boolean(input.phase || input.progress || input.checkpoint || input.message);
  const progress = { ...task.progress, ...input.progress, ...(hasActivity ? { lastActivityAt: now } : {}) };
  const checkpoint = { ...task.checkpoint, ...input.checkpoint };
  const events = input.message ? [...task.events, { at: now, message: input.message, level: input.level }].slice(-30) : task.events;
  database.prepare(`UPDATE agent_tasks SET phase = COALESCE(?, phase), progress_json = ?, checkpoint_json = ?,
    events_json = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?`).run(
    input.phase ?? null, JSON.stringify(progress), JSON.stringify(checkpoint), JSON.stringify(events), now, now, id
  );
  return success(requireTask(database, id));
}

export function requestAgentTaskControl(database: DatabaseSync, id: string, action: AgentTaskControl): CommandResult<AgentTask> {
  const task = getAgentTask(database, id);
  if (!task) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (task.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以控制。');
  const now = new Date().toISOString();
  database.prepare('UPDATE agent_tasks SET control_action = ?, updated_at = ? WHERE id = ?').run(action, now, id);
  return success(requireTask(database, id));
}

export function clearAgentTaskControl(database: DatabaseSync, id: string): void {
  database.prepare('UPDATE agent_tasks SET control_action = NULL WHERE id = ?').run(id);
}

export function cancelAgentTask(database: DatabaseSync, id: string): CommandResult<AgentTask> {
  const current = getRow(database, id);
  if (!current) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (current.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以取消。');
  const now = new Date().toISOString();
  database.prepare(`UPDATE agent_tasks SET status = 'cancelled', phase = 'cancelled', error_code = 'CANCELLED',
    error_message = '用户取消了任务。', updated_at = ?, finished_at = ? WHERE id = ?`).run(now, now, id);
  recordOperation(database, {
    actorType: 'ui',
    command: 'agent_tasks.cancel',
    entityType: 'agent_task',
    entityId: id,
    result: 'ok'
  });
  broadcastDataChanged({ scopes: ['agent', 'today'], reason: 'agent.cancel' });
  return success(requireTask(database, id));
}

export function failAgentTask(database: DatabaseSync, id: string, errorCode: string, errorMessage: string): CommandResult<AgentTask> {
  const current = getRow(database, id);
  if (!current) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (current.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以标记失败。');
  const now = new Date().toISOString();
  database.prepare(`UPDATE agent_tasks SET status = 'failed', phase = 'failed', error_code = ?, error_message = ?,
    updated_at = ?, finished_at = ? WHERE id = ?`).run(errorCode, errorMessage, now, now, id);
  recordOperation(database, {
    actorType: 'ui',
    command: 'agent_tasks.fail',
    entityType: 'agent_task',
    entityId: id,
    result: 'error',
    errorCode
  });
  broadcastDataChanged({ scopes: ['agent', 'today'], reason: 'agent.fail' });
  return success(requireTask(database, id));
}

export function needsUserAgentTask(database: DatabaseSync, id: string, errorCode: string, errorMessage: string): CommandResult<AgentTask> {
  const current = getRow(database, id);
  if (!current) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (current.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以等待用户处理。');
  const now = new Date().toISOString();
  database.prepare(`UPDATE agent_tasks SET status='needs_user', phase='needs_user', error_code=?, error_message=?, updated_at=?, finished_at=? WHERE id=?`)
    .run(errorCode, errorMessage, now, now, id);
  recordOperation(database, { actorType: 'ui', command: 'agent_tasks.needs_user', entityType: 'agent_task', entityId: id, result: 'error', errorCode });
  broadcastDataChanged({ scopes: ['agent', 'today'], reason: 'agent.needs_user' });
  return success(requireTask(database, id));
}

export function recoverInterruptedAgentTasks(database: DatabaseSync): number {
  const now = new Date().toISOString();
  database.prepare(`UPDATE agent_tasks SET phase = 'resume_pending',
    error_code = NULL, error_message = '应用重启，正在从检查点继续。', updated_at = ?
    WHERE status = 'running' AND intent = 'daily_intelligence'`).run(now);
  const result = database.prepare(`UPDATE agent_tasks SET status = 'interrupted', phase = 'interrupted',
    error_code = COALESCE(error_code, 'INTERRUPTED'),
    error_message = COALESCE(error_message, '应用重启时任务仍在运行。'),
    updated_at = ?, finished_at = COALESCE(finished_at, ?)
    WHERE status = 'running' AND intent <> 'daily_intelligence'`).run(now, now);
  return Number(result.changes ?? 0);
}

export function partialAgentTask(database: DatabaseSync, id: string): CommandResult<AgentTask> {
  const task = getAgentTask(database, id);
  if (!task) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (task.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以部分完成。');
  const today = getToday(database, task.businessDate);
  const receipts = database.prepare(`SELECT result_json AS resultJson FROM mcp_request_results
    WHERE tool='sources.upsert_batch' AND request_id LIKE ?`).all(`${id}:source:%`) as Array<{ resultJson: string }>;
  const receiptText = receipts.map((row) => row.resultJson).join('\n');
  const ownedSources = (today.sources ?? []).filter((source) => receiptText.includes(source.id));
  // Wire path writes sources directly; accept today's sources as evidence too.
  const evidenceSources = ownedSources.length ? ownedSources : (today.sources ?? []);
  if (!evidenceSources.length) return failure('VALIDATION_ERROR', '没有当前任务已保存的证据，不能保留部分结果。');
  const now = new Date().toISOString();
  const resultRefs = {
    sourceIds: evidenceSources.map((source) => source.id),
    opportunityCount: today.plan?.items?.length ?? 0
  };
  database.prepare(`UPDATE agent_tasks SET status = 'partial', phase = 'partial', result_refs_json = ?,
    control_action = NULL, updated_at = ?, finished_at = ? WHERE id = ?`).run(JSON.stringify(resultRefs), now, now, id);
  return success(requireTask(database, id));
}

function validateDailyIntelligence(database: DatabaseSync, taskId: string, businessDate: string): CommandResult<Record<string, unknown>> {
  const today = getToday(database, businessDate);
  const receipts = database.prepare(`SELECT result_json AS resultJson FROM mcp_request_results
    WHERE tool='sources.upsert_batch' AND request_id LIKE ?`).all(`${taskId}:source:%`) as Array<{ resultJson: string }>;
  const receiptText = receipts.map((row) => row.resultJson).join('\n');
  const receiptSources = (today.sources ?? []).filter((source) => receiptText.includes(source.id));
  // Official wire / X-list wire upsert directly into SQLite (not only via MCP receipts).
  const todaySources = today.sources ?? [];
  const sources = todaySources.length ? todaySources : receiptSources;
  const plan = today.plan;
  if (!sources.length && !receiptSources.length) {
    // Fall back to any source_items collected on the business date window.
    const dayStart = `${businessDate}T00:00:00.000+08:00`;
    const dayEnd = `${businessDate}T23:59:59.999+08:00`;
    const count = database.prepare(`SELECT COUNT(*) AS total FROM source_items WHERE collected_at >= ? AND collected_at <= ?`)
      .get(dayStart, dayEnd) as { total: number };
    if (!Number(count?.total || 0)) return failure('VALIDATION_ERROR', '成功要求至少一条真实资料落库。');
  }
  if (!plan) return failure('VALIDATION_ERROR', '成功要求存在当日 current plan。');
  if (!database.prepare(`SELECT 1 FROM mcp_request_results WHERE tool='plans.save' AND request_id=?`)
    .get(agentRequestId(taskId, 'plan'))) return failure('VALIDATION_ERROR', '成功要求方案由当前任务写入。');
  if (!plan.items.length) return failure('VALIDATION_ERROR', '成功要求至少一个合格的 plan item。');

  const existsStmt = database.prepare('SELECT 1 AS ok FROM source_items WHERE id = ?');
  const usableItems: typeof plan.items = [];
  for (const item of plan.items) {
    const rawIds = Array.isArray(item.sourceIds) ? item.sourceIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : [];
    if (!rawIds.length) continue;
    const validIds = rawIds.filter((sourceId) => Boolean(existsStmt.get(sourceId)));
    // Keep the opportunity if it still has at least one real source. Stale/deleted refs are ignored.
    if (!validIds.length) continue;
    usableItems.push({ ...item, sourceIds: validIds });
  }
  if (!usableItems.length) return failure('VALIDATION_ERROR', '成功要求至少一个引用真实资料的 plan item。');

  return success({
    sourceIds: sources.map((source) => source.id),
    planId: plan.id,
    planItemIds: usableItems.map((item) => item.id),
    opportunityCount: usableItems.length
  });
}

function validateStudioDraft(database: DatabaseSync, contextRefs: Record<string, unknown>): CommandResult<Record<string, unknown>> {
  const projectId = typeof contextRefs.projectId === 'string' ? contextRefs.projectId : null;
  if (!projectId) return failure('VALIDATION_ERROR', '写初稿任务需要 projectId。');
  const studio = getStudio(database);
  const project = studio.find((item) => item.id === projectId);
  if (!project) return failure('NOT_FOUND', '内容项目不存在。');
  const latest = project.revisions[0];
  if (!latest?.body?.trim()) return failure('VALIDATION_ERROR', '成功要求已保存核心正文版本。');
  return success({ projectId, contentVersionId: latest.id, versionNumber: latest.number });
}

function validateResultsReview(database: DatabaseSync, contextRefs: Record<string, unknown>): CommandResult<Record<string, unknown>> {
  const publicationId = typeof contextRefs.publicationId === 'string' ? contextRefs.publicationId : null;
  if (!publicationId) return failure('VALIDATION_ERROR', '结果复盘任务需要 publicationId。');
  const reviews = listReviews(database, publicationId).filter((item) => item.status === 'final');
  if (!reviews.length) return failure('VALIDATION_ERROR', '成功要求该发布存在最终复盘。');
  const review = reviews[0];
  if (!review.keep.length || !review.stop.length || !review.change.length) return failure('VALIDATION_ERROR', '最终复盘必须包含 Keep/Stop/Change。');
  if (!review.metricSnapshotIds.length) return failure('VALIDATION_ERROR', '最终复盘必须引用指标快照。');
  if (!review.findings.length) return failure('VALIDATION_ERROR', '成功要求至少一条方法结论。');
  return success({
    publicationId,
    reviewId: review.id,
    metricSnapshotIds: review.metricSnapshotIds,
    findingIds: review.findings.map((item) => item.id)
  });
}

export function completeAgentTask(database: DatabaseSync, id: string): CommandResult<AgentTask> {
  const current = getRow(database, id);
  if (!current) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (current.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以完成。');

  const contextRefs = JSON.parse(current.context_refs_json) as Record<string, unknown>;
  let validation: CommandResult<Record<string, unknown>>;
  if (current.intent === 'daily_intelligence') validation = validateDailyIntelligence(database, current.id, current.business_date);
  else if (current.intent === 'studio_draft') validation = validateStudioDraft(database, contextRefs);
  else if (current.intent === 'results_review') validation = validateResultsReview(database, contextRefs);
  else validation = failure('VALIDATION_ERROR', '未知 Agent 意图。');

  if (!validation.ok) {
    recordOperation(database, {
      actorType: 'ui',
      command: 'agent_tasks.complete_rejected',
      entityType: 'agent_task',
      entityId: id,
      result: 'error',
      errorCode: validation.error.code
    });
    return validation as CommandResult<AgentTask>;
  }

  const now = new Date().toISOString();
  database.prepare(`UPDATE agent_tasks SET status = 'succeeded', phase = 'completed', result_refs_json = ?,
    error_code = NULL, error_message = NULL, updated_at = ?, finished_at = ? WHERE id = ?`).run(
    JSON.stringify(validation.data),
    now,
    now,
    id
  );
  recordOperation(database, {
    actorType: 'ui',
    command: 'agent_tasks.complete',
    entityType: 'agent_task',
    entityId: id,
    result: 'ok'
  });
  broadcastDataChanged({ scopes: ['agent', 'today'], reason: 'agent.complete' });
  return success(requireTask(database, id));
}
