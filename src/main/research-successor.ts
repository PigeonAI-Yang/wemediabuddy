/**
 * WMB-5173 / CAP-028 §7.3/§8：research_successor 终态续派队列（一次止环的唯一性载体）。
 *
 * 复用既有 jobs 表（kind='research_successor'，dedupe_key UNIQUE）——不新增表/迁移。
 * - 终态处理器 enqueue：INSERT OR IGNORE + dedupe_key UNIQUE ⇒ 每父工单至多一个自动续派（重放/重启幂等）。
 * - succeeded（全部 required claim 已判定）→ 续派直接 pending；partial（含 unresolved/source_unavailable
 *   required claim）→ 生产运行时自动采用最保守的 narrow 决策后进入 pending，不等待人工点击。
 * - 消费：校验父任务 lineage 后提交带稳定 requestId 的 Actor stage_d intent，由 Actor 负责原角色续派与边界校验。
 *   不再由本模块重建 RoleJobRequest 或直接派工；research→research 仍由 Actor 合同拒绝。
 * - failed/cancelled 不续派（enqueue 状态门 fail-closed）。
 * - 重启只消费一次：续派 intent 以 successor job/attempt 身份幂等提交；既有 stale-handle 检查只读旧池状态。
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import type { JobSpawner } from './job-spawner.ts';
import type { SubmitWorkspaceOrchestratorIntentInput } from './workspace-orchestrator-runtime.ts';
import { dispatchBusinessCommand } from './business-command.ts';
import { getAgentTask } from './agent-tasks.ts';
import { parseResearchEvidencePack, readResearchGap, type ResearchEvidencePack } from './research-task-state.ts';
import type { ResearchGap } from './role-job-registry.ts';
import { failure, success, type CommandResult } from './result.ts';
import { recordOperation } from './operations.ts';

export const RESEARCH_SUCCESSOR_KIND = 'research_successor' as const;
type ActorIntentReceipt = Readonly<{ ok: boolean; code?: string | null; message?: string | null }>;
export type ResearchSuccessorIntentSubmitter = (input: SubmitWorkspaceOrchestratorIntentInput) => Promise<ActorIntentReceipt>;

/** 三动作（等你批决策）：收窄范围 / 手动补料 / 接受标注待核实。 */
export type ResearchSuccessorDecision = 'narrow' | 'supplement' | 'accept';
export const RESEARCH_SUCCESSOR_ACTIONS: readonly ResearchSuccessorDecision[] = Object.freeze(['narrow', 'supplement', 'accept'] as const);

export type ResearchSuccessorStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'needs_user';

export type ResearchSuccessorPayload = Readonly<{
  parentJobId: string;
  parentTaskId: string;
  researchTaskId: string;
  parentRoleId: 'writer' | 'planner' | 'librarian';
  unresolvedRequiredClaims: readonly string[];
  briefSuffix: string;
  /** needs_user 决策（收窄/手动补料/接受标注待核实）；未决策 = null。 */
  decision: ResearchSuccessorDecision | null;
}>;

export type ResearchSuccessorJob = Readonly<{
  id: string;
  kind: typeof RESEARCH_SUCCESSOR_KIND;
  status: ResearchSuccessorStatus;
  dueAt: string;
  attempts: number;
  dedupeKey: string;
  payload: ResearchSuccessorPayload;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}>;

export type ResearchSuccessorEnqueueResult = Readonly<{
  enqueued: boolean;
  reason: 'inserted' | 'duplicate_ignored' | 'task_not_found' | 'status_not_terminal' | 'gap_unreadable' | 'evidence_pack_missing' | 'investigation_parent';
  job: ResearchSuccessorJob | null;
}>;

type Row = {
  id: string;
  kind: string;
  status: ResearchSuccessorStatus;
  due_at: string;
  attempts: number;
  dedupe_key: string;
  payload_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const TERMINAL_ROW_STATUSES: Readonly<Record<string, true>> = Object.freeze({ succeeded: true, failed: true });

/**
 * 崩溃残留恢复参数（WMB-5173）：
 * - STALE_MS：running 行超过该时长仍无 spawner 池内句柄回收 → 视为「claim 后进程死亡」残留
 *   （对齐 job-spawner 60s 看门狗粒度；调度器 10s 一轮，恢复延迟 ≤ ~70s）。
 * - MAX_ATTEMPTS：恢复后再次崩溃累计 attempts 达到该值 → 落 failed（可审计），杜绝 crash-loop 无限重派。
 */
export const RESEARCH_SUCCESSOR_STALE_MS = 60_000;
export const RESEARCH_SUCCESSOR_MAX_ATTEMPTS = 3;

export function researchSuccessorDedupeKey(parentJobId: string): string {
  return `research-succ:${parentJobId}`;
}

function parseRow(row: Row): ResearchSuccessorJob {
  const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
  const payload: ResearchSuccessorPayload = {
    parentJobId: String(parsed.parentJobId ?? ''),
    parentTaskId: String(parsed.parentTaskId ?? ''),
    researchTaskId: String(parsed.researchTaskId ?? ''),
    parentRoleId: (parsed.parentRoleId === 'writer' || parsed.parentRoleId === 'planner' || parsed.parentRoleId === 'librarian') ? parsed.parentRoleId : 'writer',
    unresolvedRequiredClaims: Array.isArray(parsed.unresolvedRequiredClaims)
      ? parsed.unresolvedRequiredClaims.filter((key): key is string => typeof key === 'string')
      : [],
    briefSuffix: typeof parsed.briefSuffix === 'string' ? parsed.briefSuffix : '',
    decision: (parsed.decision === 'narrow' || parsed.decision === 'supplement' || parsed.decision === 'accept') ? parsed.decision : null
  };
  return Object.freeze({
    id: row.id,
    kind: RESEARCH_SUCCESSOR_KIND,
    status: row.status,
    dueAt: row.due_at,
    attempts: row.attempts,
    dedupeKey: row.dedupe_key,
    payload: Object.freeze(payload),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  });
}

function selectRow(database: DatabaseSync, sql: string, ...params: Array<string | number>): Row | undefined {
  return database.prepare(sql).get(...params) as Row | undefined;
}

export function getResearchSuccessor(database: DatabaseSync, parentJobId: string): ResearchSuccessorJob | null {
  const row = selectRow(database, `SELECT * FROM jobs WHERE kind = ? AND dedupe_key = ?`, RESEARCH_SUCCESSOR_KIND, researchSuccessorDedupeKey(parentJobId));
  return row ? parseRow(row) : null;
}

export function getResearchSuccessorById(database: DatabaseSync, id: string): ResearchSuccessorJob | null {
  const row = selectRow(database, `SELECT * FROM jobs WHERE id = ? AND kind = ?`, id, RESEARCH_SUCCESSOR_KIND);
  return row ? parseRow(row) : null;
}

/** 是否 research_successor 行（行为层止环：续派工单再报缺口 → 拒绝自动再派研究）。 */
export function isResearchSuccessorRow(database: DatabaseSync, jobId: string): boolean {
  return Boolean(selectRow(database, `SELECT id FROM jobs WHERE id = ? AND kind = ?`, jobId, RESEARCH_SUCCESSOR_KIND));
}

const DECISION_NOTES: Readonly<Record<ResearchSuccessorDecision, string>> = Object.freeze({
  narrow: '【主管决策：收窄】未解决声明已从本次续派验收范围和正式正文中剔除；只使用已判定声明完成一篇独立、连贯、有读者价值的成稿。不要解释研究缺了什么，也不要追加核查清单或免责声明。',
  supplement: '【主管决策：手动补料】基于既有证据与补充材料完成成稿；没有证据支持的主张直接删除或自然收窄，不得编造，也不得用免责声明替代内容。',
  accept: '【主管决策：接受标注待核实】未解决声明不得作为事实写入；能自然归因且对读者有价值时才保留归因表达，否则删除。正式正文不得出现待核实清单、研究过程说明或免责声明式尾注。'
});

/**
 * 续派 brief 追加段（EvidencePack 摘要 + 写作纪律；决策动作在 decide 时追加对应说明）。
 */
export function buildSuccessorBriefSuffix(pack: ResearchEvidencePack, gap: ResearchGap, decision: ResearchSuccessorDecision | null = null): string {
  const lines = [
    '【研究续派 — EvidencePack 摘要】',
    `研究任务 ${pack.jobId}（父工单 ${gap.parentRoleId} / ${gap.parentJobId}）已终态：round ${pack.round} / terminalReason=${pack.terminalReason} / 有效来源 ${pack.validSourceCount} / 候选 ${pack.candidateCount}。`,
    '声明判定：'
  ];
  if (pack.claims.length) {
    for (const claim of pack.claims) {
      lines.push(`- ${claim.key}（${claim.needsTimeExcerpt ? 'price/policy，需时间+摘录' : 'fact'}）：${claim.status}${claim.verdictReason ? `（${claim.verdictReason}）` : ''}`);
    }
  } else {
    lines.push('- （无）');
  }
  if (pack.unresolvedRequiredClaims.length) {
    lines.push(`仅供内部剔除的未解决声明：${pack.unresolvedRequiredClaims.join('、')}`);
  }
  lines.push('写作纪律：不得编造无出处数字；未解决声明只用于内部删减，不得写入正式正文；不得输出研究过程、核查摘要、残余不确定项或免责声明式尾注；不得整段复制旧稿。');
  if (decision) lines.push(DECISION_NOTES[decision]);
  return lines.join('\n');
}

/**
 * 终态处理器：research 任务终态（succeeded/partial）且 EvidencePack 已落盘 → enqueue research_successor。
 * - INSERT OR IGNORE + dedupe_key UNIQUE ⇒ 重复投递/重放幂等（至多一行）。
 * - failed/cancelled/needs_user/interrupted/running → 不续派（reason=status_not_terminal）。
 * - autoDecision 缺省时保留纯状态机的 needs_user 门，供显式决策 API 与历史兼容测试使用。
 * - 生产运行时传 narrow：未解决声明从本次续派验收范围收窄，直接 pending，文章流程不中断。
 */
export function enqueueResearchSuccessor(database: DatabaseSync, input: { researchTaskId: string; now?: string; autoDecision?: ResearchSuccessorDecision | null }): ResearchSuccessorEnqueueResult {
  const now = input.now ?? new Date().toISOString();
  const task = getAgentTask(database, input.researchTaskId);
  if (!task) return { enqueued: false, reason: 'task_not_found', job: null };
  if (task.status !== 'succeeded' && task.status !== 'partial') {
    // failed/cancelled 零续派（fail-closed 状态门）。
    return { enqueued: false, reason: 'status_not_terminal', job: null };
  }
  const gap = readResearchGap(task.contextRefs);
  if (!gap) return { enqueued: false, reason: 'gap_unreadable', job: null };
  // WMB-5290：项目专项调查（desk 父合成身份）绝不经 research_successor 自动续派——
  // 补查/重试由主管显式决策（reviewResearch supplement / retryReporter），不建立隐藏多跳链路。
  if (gap.parentRoleId === 'desk') return { enqueued: false, reason: 'investigation_parent', job: null };
  const pack = parseResearchEvidencePack(task.resultRefs);
  if (!pack) return { enqueued: false, reason: 'evidence_pack_missing', job: null };

  const unresolvedRequiredClaims = pack.unresolvedRequiredClaims.filter((key) => gap.requiredClaims.some((claim) => claim.key === key));
  const autoDecision = unresolvedRequiredClaims.length ? (input.autoDecision ?? null) : null;
  const payload: ResearchSuccessorPayload = {
    parentJobId: gap.parentJobId,
    parentTaskId: gap.parentTaskId,
    researchTaskId: task.id,
    parentRoleId: gap.parentRoleId,
    unresolvedRequiredClaims,
    briefSuffix: buildSuccessorBriefSuffix(pack, gap, autoDecision),
    decision: autoDecision
  };
  const status: ResearchSuccessorStatus = unresolvedRequiredClaims.length && !autoDecision ? 'needs_user' : 'pending';
  const dedupeKey = researchSuccessorDedupeKey(gap.parentJobId);
  const inserted = database.prepare(
    `INSERT OR IGNORE INTO jobs (id, kind, status, due_at, attempts, dedupe_key, payload_json, last_error, created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, NULL, NULL)`
  ).run(randomUUID(), RESEARCH_SUCCESSOR_KIND, status, now, dedupeKey, JSON.stringify(payload), now, now);
  const job = getResearchSuccessor(database, gap.parentJobId);
  const reason = Number(inserted.changes) === 1 ? 'inserted' : 'duplicate_ignored';
  if (reason === 'inserted') {
    recordOperation(database, {
      actorType: 'scheduler',
      clientLabel: 'research-successor',
      command: 'jobs.enqueue_research_successor',
      entityType: 'research_successor',
      entityId: gap.parentJobId,
      result: 'ok'
    });
  }
  return { enqueued: true, reason, job };
}

/**
 * needs_user 决策（三动作）：收窄 / 手动补料 / 接受标注待核实。
 * needs_user → pending（due_at=now，调度器随即消费派生原角色续派）；decision 与决策说明写入 payload。
 * 幂等：已 pending/running 的续派返回当前行（重放安全）；已终态 → NOT_RECOVERABLE。
 */
export function decideResearchSuccessor(database: DatabaseSync, jobId: string, decision: ResearchSuccessorDecision, now = new Date().toISOString()): CommandResult<ResearchSuccessorJob> {
  const current = getResearchSuccessorById(database, jobId);
  if (!current) return failure('NOT_FOUND', '研究续派工单不存在。');
  if (current.status === 'pending' || current.status === 'running') return success(current);
  if (TERMINAL_ROW_STATUSES[current.status]) return failure('INVALID_STATE', `研究续派已终态（${current.status}），不可再决策。`);
  if (current.status !== 'needs_user') return failure('INVALID_STATE', `研究续派当前状态（${current.status}）不接受决策。`);
  if (!RESEARCH_SUCCESSOR_ACTIONS.includes(decision)) {
    return failure('VALIDATION_ERROR', `决策只允许 ${RESEARCH_SUCCESSOR_ACTIONS.join('/')}（收窄/手动补料/接受标注待核实）。`);
  }
  const nextPayload: ResearchSuccessorPayload = {
    ...current.payload,
    decision,
    briefSuffix: `${current.payload.briefSuffix}\n${DECISION_NOTES[decision]}`
  };
  const updated = database.prepare(
    `UPDATE jobs SET status = 'pending', due_at = ?, attempts = 0, last_error = NULL, payload_json = ?, updated_at = ?
     WHERE id = ? AND kind = ? AND status = 'needs_user'`
  ).run(now, JSON.stringify(nextPayload), now, jobId, RESEARCH_SUCCESSOR_KIND);
  if (Number(updated.changes) !== 1) return failure('INVALID_STATE', '研究续派决策并发冲突：行状态已变化。');
  recordOperation(database, {
    actorType: 'scheduler',
    clientLabel: 'research-successor',
    command: `jobs.decide_research_successor:${decision}`,
    entityType: 'research_successor',
    entityId: current.payload.parentJobId,
    result: 'ok'
  });
  return success(getResearchSuccessorById(database, jobId)!);
}

// ---------------------------------------------------------------------------
// 运行时写封装：工作空间写守卫要求所有 DB 写经命令派发（writeAuthorizationDepth>0）。
// 纯 DB 函数（enqueue/decide/reconcile 等）在命令 execute 闭包内被授权调用；
// 调度器/事件处理器/执行器通过下列 dispatchBusinessCommand 封装执行。
// ---------------------------------------------------------------------------

function successorActor() {
  return { type: 'scheduler' as const, id: 'research-successor', label: 'research-successor' };
}

async function runSuccessorWrite<T>(
  runtime: ActiveWorkspaceRuntime,
  command: string,
  entityId: string,
  work: (database: DatabaseSync) => T
): Promise<T> {
  const receipt = await dispatchBusinessCommand(runtime, {
    command,
    requestId: `${command}:${entityId}:${randomUUID()}`,
    actor: successorActor(),
    input: { entityId },
    boundIdentity: { entityType: 'research_successor', entityId },
    entityType: 'research_successor',
    execute: (database, input) => {
      const data = work(database);
      return { data, entityId: input.entityId, readback: data };
    }
  });
  if (!receipt.ok) {
    throw Object.assign(new Error(receipt.error?.message ?? 'RESEARCH_SUCCESSOR_WRITE_FAILED'), {
      code: 'RESEARCH_SUCCESSOR_WRITE_FAILED',
      details: receipt.error?.details
    });
  }
  return receipt.data as T;
}

/** 终态处理器（运行时路径）：research 任务终态 → 采用最保守的 narrow 自动续派（幂等）。 */
export async function enqueueResearchSuccessorForTask(runtime: ActiveWorkspaceRuntime, researchTaskId: string, now?: string): Promise<ResearchSuccessorEnqueueResult> {
  return runSuccessorWrite(runtime, 'jobs.enqueue_research_successor', researchTaskId, (database) => enqueueResearchSuccessor(database, { researchTaskId, now, autoDecision: 'narrow' }));
}

/** needs_user 决策（运行时路径）：收窄 / 手动补料 / 接受标注待核实 → 恢复 pending。 */
export async function decideResearchSuccessorViaRuntime(runtime: ActiveWorkspaceRuntime, jobId: string, decision: ResearchSuccessorDecision): Promise<CommandResult<ResearchSuccessorJob>> {
  return runSuccessorWrite(runtime, `jobs.decide_research_successor:${decision}`, jobId, (database) => decideResearchSuccessor(database, jobId, decision));
}

function dueResearchSuccessors(database: DatabaseSync, now: string): ResearchSuccessorJob[] {
  const rows = database.prepare(
    `SELECT * FROM jobs WHERE kind = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at, id`
  ).all(RESEARCH_SUCCESSOR_KIND, now) as Row[];
  return rows.map(parseRow);
}

/** 消费：先确认父任务 lineage，再提交带完整身份的 Actor stage_d intent。 */
export async function kickResearchSuccessors(runtime: ActiveWorkspaceRuntime, submitIntent: ResearchSuccessorIntentSubmitter): Promise<number> {
  const now = new Date().toISOString();
  let count = 0;
  for (const item of dueResearchSuccessors(runtime.database, now)) {
    try {
      const parentTask = getAgentTask(runtime.database, item.payload.parentTaskId);
      if (!parentTask) throw Object.assign(new Error(`父任务 ${item.payload.parentTaskId} 不存在，无法提交研究续派 intent。`), { code: 'RESEARCH_SUCCESSOR_PARENT_MISSING' });
      const researchTask = getAgentTask(runtime.database, item.payload.researchTaskId);
      const parentRefs = parentTask.contextRefs ?? {};
      const researchRefs = researchTask?.contextRefs ?? {};
      const refs = { ...parentRefs, ...researchRefs };
      const readIdentityRef = (camel: string, snake: string): string => {
        const values: string[] = [];
        for (const source of [parentRefs, researchRefs]) {
          for (const key of [camel, snake]) {
            const value = source[key];
            if (typeof value === 'string' && value.trim()) values.push(value.trim());
          }
        }
        const unique = [...new Set(values)];
        if (unique.length > 1) {
          throw Object.assign(new Error(`MANAGER_ORCHESTRATION_MISMATCH: successor ${camel} 在 parent/research lineage 中冲突。`), { code: 'MANAGER_ORCHESTRATION_MISMATCH' });
        }
        return unique[0] ?? '';
      };
      const rootRequestId = readIdentityRef('rootRequestId', 'root_request_id');
      const orchestrationId = readIdentityRef('orchestrationId', 'orchestration_id');
      const stageRequestId = readIdentityRef('stageRequestId', 'stage_request_id');
      if (!rootRequestId || !orchestrationId || !stageRequestId) {
        throw Object.assign(new Error('MANAGER_ORCHESTRATION_MISMATCH: 研究续派缺少 parent/root/stage identity，拒绝按日期或 latest 任务猜测。'), { code: 'MANAGER_ORCHESTRATION_MISMATCH' });
      }
      const identity = {
        parentJobId: item.payload.parentJobId,
        parentTaskId: item.payload.parentTaskId,
        researchTaskId: item.payload.researchTaskId,
        successorJobId: item.id,
        parentRoleId: item.payload.parentRoleId,
        gapId: typeof refs.gapId === 'string' ? refs.gapId : undefined,
        rootRequestId,
        rootGeneration: Number.isInteger(refs.rootGeneration) ? refs.rootGeneration : Number.isInteger(refs.root_generation) ? refs.root_generation : undefined,
        rootInputHash: typeof refs.rootInputHash === 'string' ? refs.rootInputHash : typeof refs.root_input_hash === 'string' ? refs.root_input_hash : undefined,
        managerTaskId: typeof refs.managerTaskId === 'string' ? refs.managerTaskId : typeof refs.manager_task_id === 'string' ? refs.manager_task_id : undefined,
        orchestrationId,
        parentStageRequestId: typeof refs.parentStageRequestId === 'string' ? refs.parentStageRequestId : typeof refs.parent_stage_request_id === 'string' ? refs.parent_stage_request_id : undefined,
        stageRequestId,
        sourceSnapshotHash: typeof refs.sourceSnapshotHash === 'string' ? refs.sourceSnapshotHash : typeof refs.source_snapshot_hash === 'string' ? refs.source_snapshot_hash : undefined,
        retryGeneration: Number.isInteger(refs.retryGeneration) ? refs.retryGeneration : Number.isInteger(refs.retry_generation) ? refs.retry_generation : undefined,
        attempt: item.attempts
      };
      const claimed = await claimResearchSuccessor(runtime, item.id, item.attempts, now);
      if (!claimed) continue; // 并发消费者已认领
      const logicalInput = { businessDate: parentTask.businessDate, source: 'orphan_reconcile', ...identity };
      const receipt = await submitIntent({
        producerId: 'reconcile.research-successor-scheduler',
        businessDate: parentTask.businessDate,
        requestId: `reconcile.research-successor-scheduler:${item.id}:${item.attempts}`,
        action: 'stage_d',
        logicalInput,
        payload: logicalInput,
        rootMode: 'scheduler'
      });
      if (!receipt.ok) throw Object.assign(new Error(receipt.message ?? receipt.code ?? 'RESEARCH_SUCCESSOR_INTENT_REJECTED'), { code: receipt.code ?? 'RESEARCH_SUCCESSOR_INTENT_REJECTED' });
      count += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failResearchSuccessor(runtime, item.id, message, now);
    }
  }
  return count;
}

async function claimResearchSuccessor(runtime: ActiveWorkspaceRuntime, id: string, expectedAttempts: number, now: string): Promise<boolean> {
  return runSuccessorWrite(runtime, 'jobs.claim_research_successor', id, (database) => markResearchSuccessorRunning(database, id, expectedAttempts, now));
}


async function failResearchSuccessor(runtime: ActiveWorkspaceRuntime, id: string, error: string, now: string): Promise<void> {
  await runSuccessorWrite(runtime, 'jobs.fail_research_successor', id, (database) => markResearchSuccessorFailed(database, id, error, now));
}

function markResearchSuccessorRunning(database: DatabaseSync, id: string, expectedAttempts: number, now: string): boolean {
  const result = database.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?), last_error = NULL, updated_at = ?
     WHERE id = ? AND kind = ? AND status = 'pending' AND attempts = ?`
  ).run(now, now, id, RESEARCH_SUCCESSOR_KIND, expectedAttempts);
  return Number(result.changes) === 1;
}

function markResearchSuccessorFailed(database: DatabaseSync, id: string, error: string, now: string): boolean {
  const result = database.prepare(
    `UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ?
     WHERE id = ? AND kind = ? AND status IN ('pending', 'running')`
  ).run(error, now, now, id, RESEARCH_SUCCESSOR_KIND);
  const changed = Number(result.changes) === 1;
  if (changed) {
    recordOperation(database, {
      actorType: 'scheduler',
      clientLabel: 'research-successor',
      command: 'jobs.fail_research_successor',
      entityType: 'research_successor',
      entityId: id,
      result: 'error',
      errorCode: 'RESEARCH_SUCCESSOR_FAILED'
    });
  }
  return changed;
}

/**
 * 续派工单（原角色）终态事件 → 行终态（消费完成）。
 * job.finished / job.partial → succeeded；job.failed / job.cancelled → failed；job.needs_user → needs_user。
 * 重放/非 running 行忽略（幂等）。
 */
export async function handleResearchSuccessorJobEvent(runtime: ActiveWorkspaceRuntime, event: Record<string, unknown>): Promise<void> {
  const jobId = typeof event.jobId === 'string' ? event.jobId : '';
  if (!jobId) return;
  const row = getResearchSuccessorById(runtime.database, jobId);
  if (!row || row.status !== 'running') return;
  const type = String(event.type ?? '');
  const terminal: ResearchSuccessorStatus | null =
    type === 'job.finished' || type === 'job.partial' ? 'succeeded'
      : type === 'job.failed' || type === 'job.cancelled' ? 'failed'
        : type === 'job.needs_user' ? 'needs_user'
          : null;
  if (!terminal) return;
  const now = new Date().toISOString();
  const error = terminal === 'failed' ? (typeof event.error === 'string' ? event.error : null) : null;
  await runSuccessorWrite(runtime, `jobs.${terminal}_research_successor`, row.id, (database) => {
    const result = database.prepare(
      `UPDATE jobs SET status = ?, last_error = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND kind = ? AND status = 'running'`
    ).run(terminal, error, now, now, row.id, RESEARCH_SUCCESSOR_KIND);
    if (Number(result.changes) === 1) {
      recordOperation(database, {
        actorType: 'scheduler',
        clientLabel: 'research-successor',
        command: `jobs.${terminal}_research_successor`,
        entityType: 'research_successor',
        entityId: row.payload.parentJobId,
        result: terminal === 'failed' ? 'error' : 'ok',
        errorCode: terminal === 'failed' ? 'RESEARCH_SUCCESSOR_FAILED' : undefined
      });
      return true;
    }
    return false;
  });
}

/**
 * 重启恢复兜底：扫描已终态（succeeded/partial）且 EvidencePack 已落盘、但无 research_successor 行的
 * research 任务 → 补 enqueue（INSERT OR IGNORE 幂等，至多一行）。覆盖「终态已写、enqueue 未执行即崩溃」窗口。
 */
/** 重启 reconcile：补齐终态 research 未建立的续派；autoDecision 仅由生产调度器传入。 */
export function reconcileResearchSuccessors(
  database: DatabaseSync,
  now = new Date().toISOString(),
  autoDecision: ResearchSuccessorDecision | null = null
): number {
  const rows = database.prepare(
    `SELECT id FROM agent_tasks WHERE intent = 'research' AND status IN ('succeeded', 'partial') ORDER BY updated_at`
  ).all() as Array<{ id: string }>;
  let enqueued = 0;
  for (const row of rows) {
    const result = enqueueResearchSuccessor(database, { researchTaskId: row.id, now, autoDecision });
    if (result.enqueued && result.reason === 'inserted') enqueued += 1;
  }
  return enqueued;
}
/** 历史 needs_user 行也采用 narrow 恢复；只处理尚未决策的研究续派。 */
export function autoResumeResearchSuccessors(database: DatabaseSync, now = new Date().toISOString()): number {
  const rows = database.prepare(
    `SELECT id FROM jobs WHERE kind = ? AND status = 'needs_user' ORDER BY updated_at, id`
  ).all(RESEARCH_SUCCESSOR_KIND) as Array<{ id: string }>;
  let resumed = 0;
  for (const row of rows) {
    const result = decideResearchSuccessor(database, row.id, 'narrow', now);
    if (result.ok) resumed += 1;
  }
  return resumed;
}

/** 崩溃残留候选：running 且 updated_at 早于 (now - staleMs) 的行（updated_at 为最近一次 claim 时间）。 */
export function staleRunningResearchSuccessors(database: DatabaseSync, now = new Date().toISOString(), staleMs = RESEARCH_SUCCESSOR_STALE_MS): ResearchSuccessorJob[] {
  const cutoff = new Date(Date.parse(now) - staleMs).toISOString();
  const rows = database.prepare(
    `SELECT * FROM jobs WHERE kind = ? AND status = 'running' AND updated_at <= ? ORDER BY updated_at, id`
  ).all(RESEARCH_SUCCESSOR_KIND, cutoff) as Row[];
  return rows.map(parseRow);
}

/**
 * 崩溃残留结算（纯 DB，须在命令派发内调用——写守卫授权）：
 * - attempts < maxAttempts → 恢复 pending（due_at=now 随即被 kick 消费；started_at 重置为下次 claim 时间；
 *   attempts 保留作为恢复次数审计），并记录恢复 operation。
 * - attempts >= maxAttempts → 落 failed（复用 markResearchSuccessorFailed 审计），不再自动重派。
 * - 行已非 running / updated_at 已超阈值（dispatch 与检查之间被更新）→ 跳过（并发安全）。
 */
export function reconcileStaleRunningResearchSuccessors(
  database: DatabaseSync,
  ids: readonly string[],
  now = new Date().toISOString(),
  staleMs = RESEARCH_SUCCESSOR_STALE_MS,
  maxAttempts = RESEARCH_SUCCESSOR_MAX_ATTEMPTS
): { restored: number; failed: number } {
  const cutoff = new Date(Date.parse(now) - staleMs).toISOString();
  let restored = 0;
  let failed = 0;
  for (const id of ids) {
    const current = getResearchSuccessorById(database, id);
    if (!current || current.status !== 'running') continue;
    if (current.updatedAt > cutoff) continue;
    if (current.attempts < maxAttempts) {
      const result = database.prepare(
        `UPDATE jobs SET status = 'pending', due_at = ?, started_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND kind = ? AND status = 'running' AND updated_at <= ?`
      ).run(now, now, id, RESEARCH_SUCCESSOR_KIND, cutoff);
      if (Number(result.changes) !== 1) continue;
      restored += 1;
      recordOperation(database, {
        actorType: 'scheduler',
        clientLabel: 'research-successor',
        command: 'jobs.restore_stale_research_successor',
        entityType: 'research_successor',
        entityId: current.payload.parentJobId,
        result: 'ok'
      });
    } else if (markResearchSuccessorFailed(database, id, `研究续派崩溃恢复重派已达上限（${current.attempts}/${maxAttempts}），标记失败不再自动重派。`, now)) {
      failed += 1;
    }
  }
  return { restored, failed };
}

/**
 * 崩溃残留恢复（运行时路径）：先以纯读挑出超阈值 running 候选，再用 spawner 池内句柄过滤——
 * 池内存在工单记录（queued/waiting_resource/running/终态）即 live，禁止恢复（防双派）；
 * 仅无句柄的残留行进入单次命令派发内恢复/失败。
 */
export async function reconcileStaleRunningResearchSuccessorsViaRuntime(
  runtime: ActiveWorkspaceRuntime,
  spawner: JobSpawner,
  now = new Date().toISOString(),
  staleMs = RESEARCH_SUCCESSOR_STALE_MS,
  maxAttempts = RESEARCH_SUCCESSOR_MAX_ATTEMPTS
): Promise<{ restored: number; failed: number }> {
  const ids = staleRunningResearchSuccessors(runtime.database, now, staleMs)
    .filter((row) => spawner.get(row.id) === null)
    .map((row) => row.id);
  if (ids.length === 0) return { restored: 0, failed: 0 };
  return runSuccessorWrite(runtime, 'jobs.reconcile_stale_research_successor', 'stale-running', (database) =>
    reconcileStaleRunningResearchSuccessors(database, ids, now, staleMs, maxAttempts)
  );
}

/** 重启恢复（运行时路径）：补齐缺失续派，并将历史 needs_user 以 narrow 自动恢复。 */
export async function reconcileResearchSuccessorsViaRuntime(runtime: ActiveWorkspaceRuntime, now = new Date().toISOString()): Promise<number> {
  return runSuccessorWrite(runtime, 'jobs.reconcile_research_successor', 'all', (database) =>
    reconcileResearchSuccessors(database, now, 'narrow') + autoResumeResearchSuccessors(database, now)
  );
}

/** 调度器：启动即 reconcile + stale-running 恢复 + Actor intent kick，之后每 10s 一轮。 */
export async function startResearchSuccessorScheduler(runtime: ActiveWorkspaceRuntime, spawner: JobSpawner, submitIntent: ResearchSuccessorIntentSubmitter): Promise<() => void> {
  await reconcileResearchSuccessorsViaRuntime(runtime);
  await reconcileStaleRunningResearchSuccessorsViaRuntime(runtime, spawner);
  await kickResearchSuccessors(runtime, submitIntent);
  const timer = setInterval(() => {
    if (!runtime.isActive) return;
    void reconcileResearchSuccessorsViaRuntime(runtime).catch((error) => console.error('[research-successor-reconcile]', error));
    void reconcileStaleRunningResearchSuccessorsViaRuntime(runtime, spawner).catch((error) => console.error('[research-successor-stale]', error));
    void kickResearchSuccessors(runtime, submitIntent).catch((error) => console.error('[research-successor-scheduler]', error));
  }, 10_000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
