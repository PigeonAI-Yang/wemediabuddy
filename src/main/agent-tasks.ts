import { broadcastDataChanged } from './data-changed.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { recordOperation } from './operations.ts';
import { getToday } from './workbench.ts';
import { getStudio } from './content.ts';
import { listReviews } from './reviews.ts';
import { listSourceScanReceipts, type SourceScanReceipt } from './intelligence-channels.ts';

export type PageAgentIntent =
  | 'page_today' | 'page_agents' | 'page_discover' | 'page_proposals' | 'page_topic'
  | 'page_library' | 'page_canvas' | 'page_studio' | 'page_publish' | 'page_results';
export type RunnerAgentIntent = 'daily_intelligence' | 'daily_scan' | 'daily_judge' | 'studio_draft' | 'results_review';
export type AgentIntent = RunnerAgentIntent | PageAgentIntent;
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
  /** Manager 简报/流水摘要：持久化 progress JSON 可携带（manager-dispatch/dock 读取）。 */
  message?: string;
  /** Pi 流式输出最近活动时间：长流式输出防 stall 误判（daily-control 读取）。 */
  streamActivityAt?: string;
  lastActivityAt?: string;
};
export type AgentTaskEvent = { at: string; message: string; level?: 'info' | 'warning' };
export type DailyReceiptAggregation = {
  status: 'succeeded' | 'partial' | 'needs_user' | 'failed';
  receipts: SourceScanReceipt[];
  missingReceiptCount: number;
};

export const dailyAgentSessionId = (businessDate: string, taskId: string): string => `daily-${businessDate}-${taskId}`;

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

const intents: AgentIntent[] = [
  'daily_intelligence', 'daily_scan', 'daily_judge', 'studio_draft', 'results_review',
  'page_today', 'page_agents', 'page_discover', 'page_proposals', 'page_topic',
  'page_library', 'page_canvas', 'page_studio', 'page_publish', 'page_results'
];
export function isPageAgentIntent(intent: string): intent is PageAgentIntent {
  return intent.startsWith('page_');
}

export function isDailyIntelligenceFamily(intent: string): boolean {
  return intent === 'daily_intelligence' || intent === 'daily_scan' || intent === 'daily_judge';
}

/** Prefer running daily_* task for a business date (scan or judge or legacy). */
export function getActiveDailyIntelligenceTask(database: DatabaseSync, businessDate: string): AgentTask | null {
  for (const intent of ['daily_scan', 'daily_judge', 'daily_intelligence'] as const) {
    const hit = getActiveAgentTask(database, intent, businessDate);
    if (hit) return hit;
  }
  return null;
}

export function getLatestDailyIntelligenceTask(database: DatabaseSync, businessDate?: string): AgentTask | null {
  // 同一业务日可能有多条 scan/judge：不能只按 updatedAt，否则「成功后又取消」会盖住已交付方案。
  const intents = ['daily_scan', 'daily_judge', 'daily_intelligence'] as const;
  const rows: AgentTask[] = [];
  for (const intent of intents) {
    const list = businessDate
      ? database.prepare(
          `SELECT id FROM agent_tasks WHERE intent = ? AND business_date = ? ORDER BY updated_at DESC LIMIT 8`
        ).all(intent, businessDate) as Array<{ id: string }>
      : database.prepare(
          `SELECT id FROM agent_tasks WHERE intent = ? ORDER BY updated_at DESC LIMIT 8`
        ).all(intent) as Array<{ id: string }>;
    for (const row of list) {
      const task = getAgentTask(database, row.id);
      if (task) rows.push(task);
    }
  }
  if (!rows.length) return null;
  const rank = (status: string): number => {
    if (status === 'running') return 0;
    if (status === 'needs_user') return 1;
    if (status === 'succeeded' || status === 'completed') return 2;
    if (status === 'partial') return 3;
    if (status === 'failed' || status === 'interrupted') return 4;
    if (status === 'cancelled') return 5;
    return 6;
  };
  return rows.sort((a, b) => {
    const dr = rank(a.status) - rank(b.status);
    if (dr !== 0) return dr;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  })[0] ?? null;
}

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

/**
 * 最近一次成功写入的增量判断水印。水印存于各任务 checkpoint，但判断任务往往是一轮一个新任务，
 * 跨任务读取最近一次水印才能让"只评新资料"在滚动流程中真正生效（评审 N1 修复）。
 */
export function readLatestJudgeWatermark(database: DatabaseSync): string | null {
  const rows = database.prepare(`SELECT checkpoint_json AS checkpointJson FROM agent_tasks
    WHERE intent IN ('daily_intelligence','daily_scan','daily_judge') AND checkpoint_json LIKE '%judgeWatermark%'
    ORDER BY updated_at DESC LIMIT 5`).all() as Array<{ checkpointJson: string }>;
  for (const row of rows) {
    try {
      const checkpoint = JSON.parse(row.checkpointJson) as { judgeWatermark?: unknown };
      if (typeof checkpoint.judgeWatermark === 'string' && checkpoint.judgeWatermark) return checkpoint.judgeWatermark;
    } catch {
      // 忽略无法解析的历史检查点，继续向前找。
    }
  }
  return null;
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
  const piSessionId = isDailyIntelligenceFamily(input.intent) ? dailyAgentSessionId(input.businessDate, id) : input.piSessionId ?? null;
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
    piSessionId,
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

export function getReusableNeedsUserAgentTask(database: DatabaseSync, intent: AgentIntent, businessDate: string, contextRefs: Record<string, unknown>, errorCode: string): AgentTask | null {
  const task = getLatestAgentTask(database, intent, businessDate);
  if (!task || task.status !== 'needs_user' || task.errorCode !== errorCode) return null;
  const expected = { ...contextRefs, ...readTaskProfileContext(database) };
  return Object.entries(expected).every(([key, value]) => JSON.stringify(task.contextRefs[key]) === JSON.stringify(value)) ? task : null;
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
  extras: { piSessionId?: string | null; contextRefs?: Record<string, unknown>; intent?: string } = {}
): CommandResult<AgentTask> {
  const current = getRow(database, id);
  if (!current) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (current.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以更新阶段。');
  const now = new Date().toISOString();
  const nextIntent = extras.intent
    && isDailyIntelligenceFamily(current.intent)
    && isDailyIntelligenceFamily(extras.intent)
    ? extras.intent
    : current.intent;
  database.prepare(`UPDATE agent_tasks SET intent = ?, phase = ?, pi_session_id = COALESCE(?, pi_session_id),
    context_refs_json = COALESCE(?, context_refs_json), updated_at = ? WHERE id = ?`).run(
    nextIntent,
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
  // 幂等：已离开 running 时返回当前快照，避免「保存并停止」二次点击吓人失败。
  if (task.status !== 'running') return success(task);
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
  if (current.status === 'cancelled') return success(requireTask(database, id));
  if (current.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以取消。');
  const now = new Date().toISOString();
  database.prepare(`UPDATE agent_tasks SET status = 'cancelled', phase = 'cancelled', error_code = 'CANCELLED',
    error_message = '用户取消了任务。已入库资料仍保留在本地。', updated_at = ?, finished_at = ? WHERE id = ?`).run(now, now, id);
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
    WHERE status = 'running' AND intent IN ('daily_intelligence','daily_scan','daily_judge')`).run(now);
  const result = database.prepare(`UPDATE agent_tasks SET status = 'interrupted', phase = 'interrupted',
    error_code = COALESCE(error_code, 'INTERRUPTED'),
    error_message = COALESCE(error_message, '应用重启时任务仍在运行。'),
    updated_at = ?, finished_at = COALESCE(finished_at, ?)
    WHERE status = 'running' AND intent NOT IN ('daily_intelligence','daily_scan','daily_judge')`).run(now, now);
  return Number(result.changes ?? 0);
}

export function partialAgentTask(database: DatabaseSync, id: string): CommandResult<AgentTask> {
  const task = getAgentTask(database, id);
  if (!task) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (task.status === 'partial' || task.status === 'succeeded') return success(task);
  if (task.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以部分完成。');
  if (isDailyIntelligenceFamily(task.intent)) return finishDailyIntelligenceFromReceipts(database, id, { forcePartial: true });
  const today = getToday(database, task.businessDate);
  const receipts = database.prepare(`SELECT result_json AS resultJson FROM mcp_request_results WHERE tool='sources.upsert_batch' AND request_id LIKE ?
    UNION ALL SELECT result_json FROM command_receipts WHERE command='sources.upsert_batch' AND status='ok' AND request_id LIKE ?`).all(`${id}:source:%`, `${id}:source:%`) as Array<{ resultJson: string }>;
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

export function readDailyReceiptAggregation(database: DatabaseSync, task: Pick<AgentTask, 'id' | 'contextRefs'>): DailyReceiptAggregation {
  const workspaceId = typeof task.contextRefs.workspaceId === 'string' ? task.contextRefs.workspaceId : '';
  const frozen = task.contextRefs.intelligenceChannels as { sources?: unknown } | undefined;
  const selected = Array.isArray(frozen?.sources) ? frozen.sources.filter((source): source is { module: string; sourceId: string; sourceFeedId: string } => {
    if (!source || typeof source !== 'object') return false;
    const item = source as { module?: unknown; sourceId?: unknown; sourceFeedId?: unknown };
    return (item.module === 'official_web' || item.module === 'x_lists') && typeof item.sourceId === 'string' && typeof item.sourceFeedId === 'string';
  }) : [];
  if (!workspaceId || !Array.isArray(frozen?.sources)) return { status: 'failed', receipts: [], missingReceiptCount: 0 };
  const expected = new Map(selected.map((source) => [`${source.module}:${source.sourceId}:${source.sourceFeedId}`, source]));
  const all = listSourceScanReceipts(database, { taskId: task.id, workspaceId, limit: 500 });
  const byIdentity = new Map(all.map((receipt) => [`${receipt.module}:${receipt.sourceId}:${receipt.sourceFeedId}`, receipt]));
  const receipts = [...expected.keys()].flatMap((identity) => byIdentity.has(identity) ? [byIdentity.get(identity)!] : []);
  const missingReceiptCount = Math.max(0, expected.size - receipts.length);
  const succeeded = receipts.filter((receipt) => receipt.status === 'succeeded').length;
  const failed = receipts.filter((receipt) => receipt.status === 'failed').length + missingReceiptCount;
  const needsUser = receipts.filter((receipt) => receipt.status === 'needs_user').length;
  if (succeeded) return { status: failed || needsUser ? 'partial' : 'succeeded', receipts, missingReceiptCount };
  if (needsUser && !failed) return { status: 'needs_user', receipts, missingReceiptCount };
  return { status: 'failed', receipts, missingReceiptCount };
}

export function finishDailyIntelligenceFromReceipts(database: DatabaseSync, id: string, input: { forcePartial?: boolean; errorCode?: string; errorMessage?: string } = {}): CommandResult<AgentTask> {
  const task = getAgentTask(database, id);
  if (!task) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (task.status === 'partial' || task.status === 'succeeded' || task.status === 'cancelled') return success(task);
  if (task.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以结束。');
  const aggregation = readDailyReceiptAggregation(database, task);
  // 渠道缺席/失败一律以 partial 收尾并保留标注，不再把整任务打成 needs_user/failed；
  // 唯一真正的配置阻塞（未启用任何来源）在渠道编排的 preflight 阶段处理，不会到达这里。
  const annotatedCode = input.errorCode
    ?? (aggregation.status === 'needs_user' ? 'CHANNELS_NEEDS_USER' : aggregation.status === 'failed' ? 'CHANNEL_SCAN_FAILED' : null);
  const annotatedMessage = input.errorMessage
    ?? (aggregation.status === 'needs_user' ? '全部已选情报来源需要处理；已基于库存资料完成判断。'
      : aggregation.status === 'failed' ? '来源检查未全部成功；已基于库存资料完成判断。' : null);
  const now = new Date().toISOString();
  const status = input.forcePartial || aggregation.status !== 'succeeded' ? 'partial' : 'succeeded';
  database.prepare(`UPDATE agent_tasks SET status=?, phase=?, result_refs_json=?, error_code=?, error_message=?,
    control_action=NULL, updated_at=?, finished_at=? WHERE id=?`).run(
    status,
    status === 'partial' ? 'partial' : 'completed',
    JSON.stringify({ receiptIds: aggregation.receipts.map((receipt) => receipt.id), checkedSourceCount: aggregation.receipts.length, missingReceiptCount: aggregation.missingReceiptCount }),
    annotatedCode,
    annotatedMessage,
    now,
    now,
    id
  );
  broadcastDataChanged({ scopes: ['agent', 'today'], reason: `agent.daily.${status}` });
  return success(requireTask(database, id));
}

function validateDailyIntelligence(database: DatabaseSync, taskId: string, businessDate: string): CommandResult<Record<string, unknown>> {
  const task = getAgentTask(database, taskId);
  if (!task) return failure('NOT_FOUND', 'Agent 任务不存在。');
  const aggregation = readDailyReceiptAggregation(database, task);
  // 渠道缺席不再使完成校验失败；方案本身的存在性、归属与引用真实性仍是硬门槛。
  const today = getToday(database, businessDate);
  const plan = today.plan;
  if (!plan) return failure('VALIDATION_ERROR', '成功要求存在当日 current plan。');
  const planRequestId = agentRequestId(taskId, 'plan');
  const owned = database.prepare(`SELECT 1 FROM mcp_request_results WHERE tool='plans.save' AND request_id=?`).get(planRequestId)
    ?? database.prepare(`SELECT 1 FROM command_receipts WHERE command='plans.save' AND request_id=? AND task_id=? AND status='ok'`).get(planRequestId, taskId);
  // 允许：本任务成功写入；或本任务因空方案保底未覆盖、但当日已有非空 current plan（judge 保底路径）。
  if (!owned) {
    const anyPlanSave = database.prepare(
      `SELECT 1 AS ok FROM command_receipts WHERE command='plans.save' AND task_id=? AND status='ok' LIMIT 1`
    ).get(taskId);
    const preservedNonEmpty = Array.isArray(plan.items) && plan.items.length > 0;
    if (!(anyPlanSave || preservedNonEmpty)) {
      return failure('VALIDATION_ERROR', '成功要求方案由当前任务写入。');
    }
  }

  const existsStmt = database.prepare('SELECT 1 AS ok FROM source_items WHERE id = ?');
  for (const item of plan.items) {
    const sourceIds = Array.isArray(item.sourceIds) ? item.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === 'string' && sourceId.trim().length > 0) : [];
    if (!sourceIds.length || sourceIds.some((sourceId) => !existsStmt.get(sourceId))) {
      return failure('VALIDATION_ERROR', '非空方案的每个条目必须引用真实资料。');
    }
  }
  return success({
    taskStatus: aggregation.status === 'succeeded' ? 'succeeded' : 'partial',
    receiptIds: aggregation.receipts.map((receipt) => receipt.id),
    checkedSourceCount: aggregation.receipts.length,
    missingReceiptCount: aggregation.missingReceiptCount,
    planId: plan.id,
    planItemIds: plan.items.map((item) => item.id),
    opportunityCount: plan.items.length
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
  if (isDailyIntelligenceFamily(current.intent)) validation = validateDailyIntelligence(database, current.id, current.business_date);
  else if (current.intent === 'studio_draft') validation = validateStudioDraft(database, contextRefs);
  else if (current.intent === 'results_review') validation = validateResultsReview(database, contextRefs);
  else if (isPageAgentIntent(current.intent)) validation = success({ page: current.intent, ...contextRefs });
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
  const dailyStatus = isDailyIntelligenceFamily(current.intent) && validation.data.taskStatus === 'partial' ? 'partial' : 'succeeded';
  database.prepare(`UPDATE agent_tasks SET status = ?, phase = ?, result_refs_json = ?,
    error_code = NULL, error_message = NULL, updated_at = ?, finished_at = ? WHERE id = ?`).run(
    dailyStatus,
    dailyStatus === 'partial' ? 'partial' : 'completed',
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
    result: dailyStatus === 'partial' ? 'error' : 'ok'
  });
  broadcastDataChanged({ scopes: ['agent', 'today'], reason: `agent.${dailyStatus === 'partial' ? 'partial' : 'complete'}` });
  return success(requireTask(database, id));
}
