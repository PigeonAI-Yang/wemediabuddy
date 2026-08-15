/**
 * WMB-5236：持久化「维护整个 Wiki」运行（full-wiki maintenance orchestrator）。
 * Design: WMB-5235 Karpathy LLM Wiki 能力矩阵缺口 → 编排既有模块为单一持久 run：
 *   阶段固定 scan_compile → lint → report → completed；
 *   状态 running / paused / completed / failed；SQLite（app_meta KV）唯一真源。
 *
 * 编排（不重写底层模块，只复用）：
 * - scan_compile：逐 tick 调用 knowledge-backfill 的有界批次（batchLimit 硬上限；checkpoint
 *   续跑）直到其 checkpoint completed ——「连续调度后续批次直到 checkpoint completed，不再只
 *   在启动跑一步」；连续无进展（stall）检测使持久失败有终态（failed + 保留错误 + 允许 resume）。
 * - lint：复用 knowledge-health 周期 Lint checkpoint（beginPeriodicLint resume 语义），逐 tick
 *   一个 runPeriodicLintStep（有界页），直到 checkpoint done。
 * - report：从 backfill/lint checkpoint 与 operation_log/健康表（DB）装配持久最终报告/读模型
 *   （改动文件 = 本 run 窗口内编译成功的 Source id；已知风险 = 剩余待重试/未解决 Issue/曾失败），
 *   广播 knowledge/topics/health/receipt/library。
 *
 * 写面契约：
 * - run 状态/报告 KV、lint ChangeSet 等生产写经 dispatchBusinessCommand（runtime dispatcher +
 *   write guard）内同步执行：advanceMaintenanceRun / failMaintenanceRun 是同步函数，调用方
 *   （维护调度器 tick / IPC）包进已授权命令；
 * - scan_compile 的回溯批次本身异步（模型编译），沿用 WMB-5230 既有生产形态：在独立连接上跑
 *   runKnowledgeBackfillBatchWith（checkpoint 读改写与编译写与其自身连接一致），随后在授权命令
 *   内读取 checkpoint 推进 run 状态；本模块不改 knowledge-backfill 的写语义。
 *
 * 单飞/幂等/恢复：
 * - 任意时刻至多一个活动 run；重复 start 返回当前 run（幂等）；重启后持久 status='running'
 *   由维护调度器自动继续；pause 只在批次边界生效（tick 开始前检查）；resume 沿 checkpoint 继续；
 * - 严格 workspace 身份：run 绑定创建它的 workspaceId，所有 API 校验输入 workspaceId 与
 *   run.workspaceId（及 DB 绑定身份）一致，跨 workspace/跨 root 一律拒绝。
 *
 * 唯一正式接线点（src/main/index.ts refreshRuntime）：
 *   maintenanceSchedulerRef = new KnowledgeMaintenanceScheduler({ runtime, deps, isCurrent, syncRollingLint })
 *   maintenanceSchedulerRef.start()；teardown：stop() + null。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { broadcastDataChanged } from './data-changed.ts';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import {
  getKnowledgeBackfillCheckpoint,
  runKnowledgeBackfillBatchWith,
  runKnowledgeBackfillStep,
  type BackfillCheckpoint,
  type KnowledgeBackfillDeps
} from './knowledge-backfill.ts';
import {
  beginPeriodicLint,
  getPeriodicLintCheckpoint,
  runPeriodicLintStep,
  type KnowledgeHealthCheckpoint
} from './knowledge-health.ts';
import type {
  KnowledgeMaintenanceBackfillSummary,
  KnowledgeMaintenanceConfig,
  KnowledgeMaintenanceFailure,
  KnowledgeMaintenanceLintSummary,
  KnowledgeMaintenancePhase,
  KnowledgeMaintenanceReport,
  KnowledgeMaintenanceRun,
  KnowledgeMaintenanceStartInput,
  KnowledgeMaintenanceStartResult,
  KnowledgeMaintenanceStatusView,
  KnowledgeMaintenanceStepResult
} from '../shared/knowledge-maintenance.ts';
export type {
  KnowledgeMaintenanceBackfillSummary,
  KnowledgeMaintenanceConfig,
  KnowledgeMaintenanceFailure,
  KnowledgeMaintenanceLintSummary,
  KnowledgeMaintenancePhase,
  KnowledgeMaintenanceReport,
  KnowledgeMaintenanceRun,
  KnowledgeMaintenanceStartInput,
  KnowledgeMaintenanceStartResult,
  KnowledgeMaintenanceStatusView,
  KnowledgeMaintenanceStepResult
} from '../shared/knowledge-maintenance.ts';
export { KNOWLEDGE_MAINTENANCE_IPC_CHANNELS } from '../shared/knowledge-maintenance.ts';

export const KNOWLEDGE_MAINTENANCE_RUN_KEY = 'wmb_knowledge_maintenance_v1';
export const KNOWLEDGE_MAINTENANCE_REPORT_KEY = 'wmb_knowledge_maintenance_report_v1';
export const KNOWLEDGE_MAINTENANCE_COMMAND = 'knowledge.maintenance';
export const KNOWLEDGE_MAINTENANCE_ACTOR_LABEL = 'knowledge-maintenance';
export const KNOWLEDGE_MAINTENANCE_TICK_COMMAND = 'knowledge.maintenance.tick';
export const KNOWLEDGE_MAINTENANCE_FAIL_COMMAND = 'knowledge.maintenance.fail';
export const DEFAULT_MAINTENANCE_BATCH_LIMIT = 10;
export const DEFAULT_MAINTENANCE_MAX_TOPICS = 5;
export const DEFAULT_MAINTENANCE_STALL_LIMIT = 3;
export const KNOWLEDGE_MAINTENANCE_INTERVAL_MS = 10_000;
const MAX_MAINTENANCE_BATCH_LIMIT = 50;
const MAX_MAINTENANCE_MAX_TOPICS = 20;
const MAX_MAINTENANCE_STALL_LIMIT = 20;

export type KnowledgeMaintenanceDeps = Readonly<{
  backfill: KnowledgeBackfillDeps;
}>;

export const maintenanceSchedulerActor = Object.freeze({ type: 'scheduler', id: 'knowledge-maintenance', label: KNOWLEDGE_MAINTENANCE_ACTOR_LABEL }) as {
  type: 'scheduler';
  id: string;
  label: string;
};

// ============================================================
// 持久 run 记录（app_meta KV；schemaVersion=1）
// ============================================================

function freshRun(workspaceId: string, config: KnowledgeMaintenanceConfig): KnowledgeMaintenanceRun {
  const nowIso = new Date().toISOString();
  return Object.freeze({
    schemaVersion: 1,
    runId: `maintenance-${Date.now()}-${randomUUID().slice(0, 8)}`,
    workspaceId,
    phase: 'scan_compile' as const,
    status: 'running' as const,
    step: 0,
    config,
    backfill: Object.freeze({ done: false, lastCursor: '', lastPendingRetryKey: '', stallCount: 0 }),
    lint: Object.freeze({ done: false, runId: null }),
    error: null,
    reportId: null,
    startedAt: nowIso,
    updatedAt: nowIso,
    completedAt: null
  });
}

export function getMaintenanceRun(database: DatabaseSync): KnowledgeMaintenanceRun | null {
  let row: { value: string } | undefined;
  try {
    row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(KNOWLEDGE_MAINTENANCE_RUN_KEY) as { value: string } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as KnowledgeMaintenanceRun;
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.runId || !parsed.workspaceId || !parsed.config || !parsed.backfill || !parsed.lint) return null;
    return Object.freeze({
      ...parsed,
      config: Object.freeze({ ...parsed.config }),
      backfill: Object.freeze({ ...parsed.backfill }),
      lint: Object.freeze({ ...parsed.lint })
    });
  } catch {
    return null;
  }
}

function saveRun(database: DatabaseSync, run: KnowledgeMaintenanceRun): void {
  const value = JSON.stringify(run);
  const nowIso = new Date().toISOString();
  const existing = database.prepare('SELECT revision FROM app_meta WHERE key = ?').get(KNOWLEDGE_MAINTENANCE_RUN_KEY) as { revision: number } | undefined;
  if (existing) {
    database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?')
      .run(value, nowIso, KNOWLEDGE_MAINTENANCE_RUN_KEY);
  } else {
    database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
      .run(KNOWLEDGE_MAINTENANCE_RUN_KEY, value, nowIso, nowIso);
  }
}

export function clearMaintenanceRun(database: DatabaseSync): boolean {
  const existing = database.prepare('SELECT 1 AS one FROM app_meta WHERE key = ?').get(KNOWLEDGE_MAINTENANCE_RUN_KEY);
  if (!existing) return false;
  database.prepare('DELETE FROM app_meta WHERE key = ?').run(KNOWLEDGE_MAINTENANCE_RUN_KEY);
  database.prepare('DELETE FROM app_meta WHERE key = ?').run(KNOWLEDGE_MAINTENANCE_REPORT_KEY);
  return true;
}

function boundWorkspaceId(database: DatabaseSync): string | null {
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function errorInfo(error: unknown): KnowledgeMaintenanceFailure {
  const message = error instanceof Error ? error.message : String(error ?? '');
  let code = 'MAINTENANCE_UNEXPECTED';
  if (error && typeof error === 'object' && 'code' in error) {
    const raw = (error as { code: unknown }).code;
    if (typeof raw === 'string' && raw.trim()) code = raw;
  }
  return Object.freeze({ code, message });
}

function maintenanceError(code: string, message: string, details?: Readonly<Record<string, unknown>>): Error {
  return Object.assign(new Error(message), { code, details });
}

function assertRunWorkspace(run: KnowledgeMaintenanceRun, workspaceId: string): void {
  if (run.workspaceId !== workspaceId) {
    throw maintenanceError('MAINTENANCE_WORKSPACE_MISMATCH', `维护 run 属于工作空间 ${run.workspaceId}，与当前 ${workspaceId} 不一致（禁止跨 root 操作）。`, {
      runWorkspaceId: run.workspaceId,
      workspaceId
    });
  }
}

function assertBoundWorkspace(database: DatabaseSync, workspaceId: string): void {
  const bound = boundWorkspaceId(database);
  if (bound !== null && bound !== workspaceId) {
    throw maintenanceError('MAINTENANCE_WORKSPACE_MISMATCH', `数据库绑定工作空间 ${bound}，与当前 ${workspaceId} 不一致。`, { bound, workspaceId });
  }
}

// ============================================================
// start / pause / resume / fail（同步；生产经 dispatcher 授权写）
// ============================================================

function normalizeConfig(rawInput: KnowledgeMaintenanceStartInput): KnowledgeMaintenanceConfig {
  return Object.freeze({
    batchLimit: Math.min(Math.max(rawInput.batchLimit ?? DEFAULT_MAINTENANCE_BATCH_LIMIT, 1), MAX_MAINTENANCE_BATCH_LIMIT),
    maxTopicsPerSource: Math.min(Math.max(rawInput.maxTopicsPerSource ?? DEFAULT_MAINTENANCE_MAX_TOPICS, 1), MAX_MAINTENANCE_MAX_TOPICS),
    stallLimit: Math.min(Math.max(rawInput.stallLimit ?? DEFAULT_MAINTENANCE_STALL_LIMIT, 1), MAX_MAINTENANCE_STALL_LIMIT)
  });
}

/**
 * 启动全库维护 run。
 * - 已存在 running/paused/failed run → 幂等返回同一 run（created=false，不新建、不重置）；
 * - 已存在 completed run → 新建新一轮（created=true）；
 * - workspaceId 与 run 不一致（或与 DB 绑定身份不一致）→ 拒绝。
 */
export function startMaintenanceRun(database: DatabaseSync, rawInput: KnowledgeMaintenanceStartInput & { workspaceId: string }): KnowledgeMaintenanceStartResult {
  const workspaceId = rawInput.workspaceId;
  assertBoundWorkspace(database, workspaceId);
  const existing = getMaintenanceRun(database);
  if (existing) {
    assertRunWorkspace(existing, workspaceId);
    if (existing.status !== 'completed') {
      return Object.freeze({ run: existing, created: false });
    }
  }
  const run = freshRun(workspaceId, normalizeConfig(rawInput));
  saveRun(database, run);
  broadcastDataChanged({ scopes: ['knowledge', 'topics', 'health', 'receipt', 'library'], reason: 'knowledge.maintenance.start' });
  // 维护生命周期事件由全局时间日志派生（app_meta 维护 run KV：startedAt/completedAt），本处不做日志写。
  return Object.freeze({ run, created: true });
}

/** 暂停（只在批次边界生效：在飞批次完成后，下一 tick 不再执行；paused 不占执行）。 */
export function pauseMaintenanceRun(database: DatabaseSync, workspaceId: string): KnowledgeMaintenanceRun | null {
  const run = getMaintenanceRun(database);
  if (!run) return null;
  assertRunWorkspace(run, workspaceId);
  if (run.status === 'completed' || run.status === 'failed') {
    throw maintenanceError('MAINTENANCE_RUN_NOT_ACTIVE', `维护 run 已处于 ${run.status}，不能暂停。`, { status: run.status });
  }
  if (run.status === 'paused') return run;
  const next: KnowledgeMaintenanceRun = Object.freeze({ ...run, status: 'paused', updatedAt: new Date().toISOString() });
  saveRun(database, next);
  broadcastDataChanged({ scopes: ['knowledge', 'topics', 'health', 'receipt', 'library'], reason: 'knowledge.maintenance.pause' });
  return next;
}

/** 继续（paused/failed → running；沿既有 checkpoint 续跑；错误保留到下一次成功推进）。 */
export function resumeMaintenanceRun(database: DatabaseSync, workspaceId: string): KnowledgeMaintenanceRun {
  const run = getMaintenanceRun(database);
  if (!run) throw maintenanceError('MAINTENANCE_RUN_NOT_FOUND', '没有可继续的维护 run。');
  assertRunWorkspace(run, workspaceId);
  if (run.status === 'completed') {
    throw maintenanceError('MAINTENANCE_RUN_COMPLETED', '维护 run 已完成，请使用 start 开启新一轮。');
  }
  if (run.status === 'running') return run;
  const next: KnowledgeMaintenanceRun = Object.freeze({ ...run, status: 'running', updatedAt: new Date().toISOString() });
  saveRun(database, next);
  broadcastDataChanged({ scopes: ['knowledge', 'topics', 'health', 'receipt', 'library'], reason: 'knowledge.maintenance.resume' });
  return next;
}

/** 标记 run 失败（保留错误；resume 后可继续）。调用方为调度器 tick 异常路径 / 停滞检测。 */
export function failMaintenanceRun(database: DatabaseSync, workspaceId: string, failure: KnowledgeMaintenanceFailure): KnowledgeMaintenanceRun {
  const run = getMaintenanceRun(database);
  if (!run) throw maintenanceError('MAINTENANCE_RUN_NOT_FOUND', '没有可标记失败的维护 run。');
  assertRunWorkspace(run, workspaceId);
  if (run.status === 'completed') return run;
  const next: KnowledgeMaintenanceRun = Object.freeze({
    ...run,
    status: 'failed',
    error: Object.freeze({ code: failure.code || 'MAINTENANCE_UNEXPECTED', message: failure.message }),
    updatedAt: new Date().toISOString()
  });
  saveRun(database, next);
  broadcastDataChanged({ scopes: ['knowledge', 'topics', 'health', 'receipt', 'library'], reason: 'knowledge.maintenance.fail' });
  return next;
}

// ============================================================
// 读模型投影（status / report）
// ============================================================

function summarizeBackfill(cp: BackfillCheckpoint | null): KnowledgeMaintenanceBackfillSummary {
  if (!cp) {
    return Object.freeze({
      done: false, runId: null, cursor: '', pendingRetry: Object.freeze([]),
      scanned: 0, processed: 0, compiled: 0, skippedExistingReceipt: 0, skippedWeak: 0, skippedNoTopic: 0, skippedNoSignal: 0, failed: 0,
      startedAt: null, updatedAt: null, completedAt: null
    });
  }
  return Object.freeze({
    done: cp.status === 'completed',
    runId: cp.runId,
    cursor: cp.cursor,
    pendingRetry: cp.pendingRetry,
    scanned: cp.counts.scanned,
    processed: cp.counts.processed,
    compiled: cp.counts.compiled,
    skippedExistingReceipt: cp.counts.skippedExistingReceipt,
    skippedWeak: cp.counts.skippedWeak,
    skippedNoTopic: cp.counts.skippedNoTopic,
    skippedNoSignal: cp.counts.skippedNoSignal,
    failed: cp.counts.failed,
    startedAt: cp.startedAt,
    updatedAt: cp.updatedAt,
    completedAt: cp.completedAt
  });
}

export function countOpenHealthIssues(database: DatabaseSync): number {
  try {
    const row = database.prepare(
      "SELECT COUNT(*) AS c FROM knowledge_health_issues WHERE scope = 'global' AND status IN ('open','repairing')"
    ).get() as { c: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

function summarizeLint(database: DatabaseSync, cp: KnowledgeHealthCheckpoint | null): KnowledgeMaintenanceLintSummary {
  const openIssues = countOpenHealthIssues(database);
  if (!cp) {
    return Object.freeze({
      done: false, runId: null, phase: '', step: 0,
      scannedObjects: 0, issuesCreated: 0, issuesDeduplicated: 0, issuesAutoResolved: 0, repairsApplied: 0,
      openIssues, startedAt: null, updatedAt: null, completedAt: null
    });
  }
  return Object.freeze({
    done: cp.status === 'completed',
    runId: cp.runId,
    phase: cp.phase,
    step: cp.step,
    scannedObjects: cp.counts.scannedObjects,
    issuesCreated: cp.counts.issuesCreated,
    issuesDeduplicated: cp.counts.issuesDeduplicated,
    issuesAutoResolved: cp.counts.issuesAutoResolved,
    repairsApplied: cp.counts.repairsApplied,
    openIssues,
    startedAt: cp.startedAt,
    updatedAt: cp.updatedAt,
    completedAt: cp.completedAt
  });
}

export function getMaintenanceReport(database: DatabaseSync): KnowledgeMaintenanceReport | null {
  let row: { value: string } | undefined;
  try {
    row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(KNOWLEDGE_MAINTENANCE_REPORT_KEY) as { value: string } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as KnowledgeMaintenanceReport;
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.reportId || !parsed.runId) return null;
    return Object.freeze({
      ...parsed,
      backfill: Object.freeze({ ...parsed.backfill, pendingRetry: Object.freeze([...(parsed.backfill?.pendingRetry ?? [])]) }),
      lint: Object.freeze({ ...parsed.lint }),
      changedSources: Object.freeze([...(parsed.changedSources ?? [])]),
      failures: Object.freeze([...(parsed.failures ?? [])]),
      risks: Object.freeze([...(parsed.risks ?? [])])
    });
  } catch {
    return null;
  }
}

export function getMaintenanceStatus(database: DatabaseSync, workspaceId: string): KnowledgeMaintenanceStatusView {
  const run = getMaintenanceRun(database);
  if (run) assertRunWorkspace(run, workspaceId);
  const backfillCp = getKnowledgeBackfillCheckpoint(database);
  const lintCp = getPeriodicLintCheckpoint(database);
  const report = getMaintenanceReport(database);
  return Object.freeze({
    run,
    backfill: summarizeBackfill(backfillCp),
    lint: summarizeLint(database, lintCp),
    report: report && run && report.runId === run.runId ? report : null
  });
}

export function emptyMaintenanceStatus(): KnowledgeMaintenanceStatusView {
  return Object.freeze({
    run: null,
    backfill: summarizeBackfill(null),
    lint: Object.freeze({
      done: false, runId: null, phase: '', step: 0,
      scannedObjects: 0, issuesCreated: 0, issuesDeduplicated: 0, issuesAutoResolved: 0, repairsApplied: 0,
      openIssues: 0, startedAt: null, updatedAt: null, completedAt: null
    }),
    report: null
  });
}

// ============================================================
// 改动文件（operation_log 证据：本 run 窗口内 command=knowledge.backfill 且 result=ok）
// ============================================================

function changedSourcesForRun(database: DatabaseSync, startedAt: string): readonly string[] {
  let rows: Array<{ entityId: string }> = [];
  try {
    rows = database.prepare(
      "SELECT entity_id AS entityId FROM operation_log WHERE command = 'knowledge.backfill' AND result = 'ok' AND created_at >= ?"
    ).all(startedAt) as Array<{ entityId: string }>;
  } catch {
    return Object.freeze([]);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const sourceId = String(row.entityId ?? '').split(':')[0]!;
    if (!sourceId) continue;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    out.push(sourceId);
  }
  out.sort();
  return Object.freeze(out);
}

// ============================================================
// report 阶段：持久最终报告 / 读模型（数字全部来自 checkpoint/DB）
// ============================================================

export function buildMaintenanceReport(database: DatabaseSync, run: KnowledgeMaintenanceRun): KnowledgeMaintenanceReport {
  const backfillCp = getKnowledgeBackfillCheckpoint(database);
  const lintCp = getPeriodicLintCheckpoint(database);
  const openIssues = countOpenHealthIssues(database);
  const changedSources = changedSourcesForRun(database, run.startedAt);
  const failures: KnowledgeMaintenanceFailure[] = [];
  if (run.error) failures.push(run.error);
  const risks: string[] = [];
  if (backfillCp && backfillCp.counts.failed > 0) {
    risks.push(`${backfillCp.counts.failed} 个 Source 在本轮编译中失败（含重试后成功）。`);
  }
  if (backfillCp && backfillCp.pendingRetry.length > 0) {
    risks.push(`${backfillCp.pendingRetry.length} 个 Source 仍待重试：${backfillCp.pendingRetry.slice(0, 5).join('、')}${backfillCp.pendingRetry.length > 5 ? '…' : ''}。`);
  }
  if (lintCp && lintCp.counts.issuesCreated > 0) {
    risks.push(`Lint 共创建 ${lintCp.counts.issuesCreated} 个健康 Issue。`);
  }
  if (openIssues > 0) {
    risks.push(`${openIssues} 个健康 Issue 未解决（open/repairing），建议人工复核。`);
  }
  if (backfillCp && backfillCp.counts.skippedWeak + backfillCp.counts.skippedNoTopic + backfillCp.counts.skippedNoSignal > 0) {
    risks.push(`${backfillCp.counts.skippedWeak + backfillCp.counts.skippedNoTopic + backfillCp.counts.skippedNoSignal} 个 Source 因弱资料/无活跃 Topic/无价值信号保持 Raw（未编译）。`);
  }
  const report: KnowledgeMaintenanceReport = Object.freeze({
    schemaVersion: 1,
    reportId: `report:${run.runId}`,
    runId: run.runId,
    workspaceId: run.workspaceId,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? new Date().toISOString(),
    backfill: Object.freeze({
      runId: backfillCp?.runId ?? null,
      scanned: backfillCp?.counts.scanned ?? 0,
      processed: backfillCp?.counts.processed ?? 0,
      compiled: backfillCp?.counts.compiled ?? 0,
      skippedExistingReceipt: backfillCp?.counts.skippedExistingReceipt ?? 0,
      skippedWeak: backfillCp?.counts.skippedWeak ?? 0,
      skippedNoTopic: backfillCp?.counts.skippedNoTopic ?? 0,
      skippedNoSignal: backfillCp?.counts.skippedNoSignal ?? 0,
      failed: backfillCp?.counts.failed ?? 0,
      pendingRetry: backfillCp?.pendingRetry ?? Object.freeze([])
    }),
    lint: Object.freeze({
      runId: lintCp?.runId ?? null,
      steps: lintCp?.step ?? 0,
      scannedObjects: lintCp?.counts.scannedObjects ?? 0,
      issuesCreated: lintCp?.counts.issuesCreated ?? 0,
      issuesDeduplicated: lintCp?.counts.issuesDeduplicated ?? 0,
      issuesAutoResolved: lintCp?.counts.issuesAutoResolved ?? 0,
      repairsApplied: lintCp?.counts.repairsApplied ?? 0,
      openIssues
    }),
    changedSources,
    failures: Object.freeze(failures),
    risks: Object.freeze(risks)
  });
  return report;
}

function saveReport(database: DatabaseSync, report: KnowledgeMaintenanceReport): void {
  const value = JSON.stringify(report);
  const nowIso = new Date().toISOString();
  const existing = database.prepare('SELECT revision FROM app_meta WHERE key = ?').get(KNOWLEDGE_MAINTENANCE_REPORT_KEY) as { revision: number } | undefined;
  if (existing) {
    database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?')
      .run(value, nowIso, KNOWLEDGE_MAINTENANCE_REPORT_KEY);
  } else {
    database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
      .run(KNOWLEDGE_MAINTENANCE_REPORT_KEY, value, nowIso, nowIso);
  }
}

// ============================================================
// 阶段推进核心（同步；lint/报告写经 dispatcher 授权）
// ============================================================

function nextAfterScanCompile(
  database: DatabaseSync,
  run: KnowledgeMaintenanceRun,
  nowIso: string
): { run: KnowledgeMaintenanceRun; changed: boolean; failed: boolean } {
  const cp = getKnowledgeBackfillCheckpoint(database);
  if (!cp) {
    throw maintenanceError('MAINTENANCE_BACKFILL_CHECKPOINT_MISSING', 'scan_compile 阶段缺少回溯编译 checkpoint（回溯批次未执行）。');
  }
  const retryCount = cp.pendingRetry.length;
  const scanned = cp.counts.scanned;
  const stallLimit = run.config.stallLimit;
  const stallThreshold = Math.min(stallLimit, MAX_MAINTENANCE_STALL_LIMIT);
  const pendingRetryKey = retryCount === 0 ? '' : JSON.stringify(cp.pendingRetry);
  let stallCount = run.backfill.stallCount;
  if (retryCount > 0 && cp.cursor === run.backfill.lastCursor && pendingRetryKey === run.backfill.lastPendingRetryKey) {
    stallCount += 1;
  } else {
    stallCount = 0;
  }
  const done = cp.status === 'completed';
  const backfillNext = Object.freeze({
    done,
    lastCursor: cp.cursor,
    lastPendingRetryKey: pendingRetryKey,
    stallCount
  });
  if (stallCount >= stallThreshold) {
    const failure: KnowledgeMaintenanceFailure = Object.freeze({
      code: 'MAINTENANCE_BACKFILL_STALLED',
      message: `回溯编译连续 ${stallCount} 批无进展，仍有 ${retryCount} 个 Source 待重试：${cp.pendingRetry.slice(0, 5).join('、')}${retryCount > 5 ? '…' : ''}。请修复后 resume。`
    });
    const next: KnowledgeMaintenanceRun = Object.freeze({
      ...run,
      phase: 'scan_compile',
      status: 'failed',
      step: run.step + 1,
      backfill: backfillNext,
      error: failure,
      updatedAt: nowIso
    });
    saveRun(database, next);
    return { run: next, changed: true, failed: true };
  }
  let phase: KnowledgeMaintenancePhase = 'scan_compile';
  if (done) {
    phase = 'lint';
    // 进入 lint 阶段：复用周期 Lint checkpoint（已有 running 则续跑，否则新建）。
    beginPeriodicLint(database, { workspaceId: run.workspaceId, scope: 'global', resume: true });
  }
  const next: KnowledgeMaintenanceRun = Object.freeze({
    ...run,
    phase,
    step: run.step + 1,
    backfill: backfillNext,
    error: null,
    updatedAt: nowIso
  });
  saveRun(database, next);
  return { run: next, changed: true, failed: false };
}

function nextLintStep(
  database: DatabaseSync,
  run: KnowledgeMaintenanceRun,
  nowIso: string
): { run: KnowledgeMaintenanceRun; changed: boolean; failed: boolean } {
  const cp = getPeriodicLintCheckpoint(database);
  if (!cp || cp.status === 'completed') {
    beginPeriodicLint(database, { workspaceId: run.workspaceId, scope: 'global', resume: false });
  }
  const step = runPeriodicLintStep(database);
  const lintDone = step.done;
  const next: KnowledgeMaintenanceRun = Object.freeze({
    ...run,
    phase: lintDone ? 'report' : 'lint',
    step: run.step + 1,
    lint: Object.freeze({ done: lintDone, runId: step.checkpoint.runId }),
    error: null,
    updatedAt: nowIso
  });
  saveRun(database, next);
  return { run: next, changed: true, failed: false };
}

function completeRun(database: DatabaseSync, run: KnowledgeMaintenanceRun, nowIso: string): { run: KnowledgeMaintenanceRun; changed: boolean; failed: boolean } {
  const report = buildMaintenanceReport(database, run);
  saveReport(database, report);
  const next: KnowledgeMaintenanceRun = Object.freeze({
    ...run,
    phase: 'completed',
    status: 'completed',
    step: run.step + 1,
    lint: Object.freeze({ ...run.lint, done: true }),
    error: null,
    reportId: report.reportId,
    completedAt: nowIso,
    updatedAt: nowIso
  });
  saveRun(database, next);
  broadcastDataChanged({ scopes: ['knowledge', 'topics', 'health', 'receipt', 'library'], reason: 'knowledge.maintenance.report' });
  return { run: next, changed: true, failed: false };
}

/**
 * 同步阶段推进（生产经 dispatchBusinessCommand 授权写；测试直连）。
 * 前置：scan_compile 的回溯批次已由调用方执行（checkpoint 已就绪）。
 * 每次调用执行恰好一个「有界单元」：一个回溯批次簿记 / 一个 lint 页 / 报告生成。
 */
export function advanceMaintenanceRun(
  database: DatabaseSync,
  input: { workspaceId: string }
): KnowledgeMaintenanceStepResult {
  const run = getMaintenanceRun(database);
  if (!run) throw maintenanceError('MAINTENANCE_RUN_NOT_FOUND', '没有进行中的维护 run。');
  assertRunWorkspace(run, input.workspaceId);
  if (run.status !== 'running') {
    return Object.freeze({
      run,
      changed: false,
      done: run.status === 'completed',
      failed: run.status === 'failed'
    });
  }
  const nowIso = new Date().toISOString();
  switch (run.phase) {
    case 'scan_compile': {
      const { run: next, changed, failed } = nextAfterScanCompile(database, run, nowIso);
      return Object.freeze({ run: next, changed, done: next.phase === 'completed', failed });
    }
    case 'lint': {
      const { run: next, changed, failed } = nextLintStep(database, run, nowIso);
      return Object.freeze({ run: next, changed, done: next.phase === 'completed', failed });
    }
    case 'report': {
      const { run: next, changed, failed } = completeRun(database, run, nowIso);
      return Object.freeze({ run: next, changed, done: next.status === 'completed', failed });
    }
    case 'completed': {
      return Object.freeze({ run, changed: false, done: true, failed: false });
    }
  }
}

/**
 * DB 级整步执行（测试 / 无 dispatcher 直连模式）：scan_compile 直接在当前连接跑有界回溯批次，
 * 然后同步推进。生产调度器改用「独立连接批次 + 授权推进」拆法（见类注释）。
 */
export async function runMaintenanceStep(
  database: DatabaseSync,
  deps: KnowledgeMaintenanceDeps,
  input: { workspaceId: string }
): Promise<KnowledgeMaintenanceStepResult> {
  const run = getMaintenanceRun(database);
  if (!run) throw maintenanceError('MAINTENANCE_RUN_NOT_FOUND', '没有进行中的维护 run。');
  assertRunWorkspace(run, input.workspaceId);
  if (run.status !== 'running') {
    return Object.freeze({
      run,
      changed: false,
      done: run.status === 'completed',
      failed: run.status === 'failed'
    });
  }
  if (run.phase === 'scan_compile') {
    await runKnowledgeBackfillStep(database, deps.backfill, {
      workspaceId: run.workspaceId,
      batchLimit: run.config.batchLimit,
      maxTopicsPerSource: run.config.maxTopicsPerSource
    });
  }
  return advanceMaintenanceRun(database, { workspaceId: input.workspaceId });
}

// ============================================================
// 生产维护调度器（与 XObservationScheduler / KnowledgeLintScheduler 同构：
// 轮询到期 tick + 唤醒；每 tick 恰好一个「有界单元」，绝不在 setInterval 回调内无界循环）
// ============================================================

export class KnowledgeMaintenanceScheduler {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private rerun = false;
  private generation = 0;
  private executing = false;
  private readonly options: {
    runtime: ActiveWorkspaceRuntime;
    deps: () => KnowledgeMaintenanceDeps;
    isCurrent?: () => boolean;
    intervalMs?: number;
    /** 执行状态变化通知（index.ts 用它挂起/恢复滚动周期 Lint，避免双驱动同一 checkpoint）。 */
    onExecutionChange?: (executing: boolean) => void;
  };

  constructor(options: {
    runtime: ActiveWorkspaceRuntime;
    deps: () => KnowledgeMaintenanceDeps;
    isCurrent?: () => boolean;
    intervalMs?: number;
    onExecutionChange?: (executing: boolean) => void;
  }) {
    this.options = options;
  }

  isExecuting(): boolean {
    return this.executing;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    if (this.current) {
      this.rerun = true;
      return;
    }
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => void this.tick(), 0);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.rerun = false;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    await this.current?.catch(() => {});
    this.setExecuting(false);
  }

  private setExecuting(value: boolean): void {
    if (this.executing === value) return;
    this.executing = value;
    this.options.onExecutionChange?.(value);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.current) return;
    this.timer = null;
    const generation = this.generation;
    const runtime = this.options.runtime;
    const intervalMs = this.options.intervalMs ?? KNOWLEDGE_MAINTENANCE_INTERVAL_MS;
    this.current = (async () => {
      if (this.stopped || generation !== this.generation || !runtime.isActive || (this.options.isCurrent && !this.options.isCurrent())) return;
      const run = getMaintenanceRun(runtime.database);
      if (!run || run.status !== 'running' || run.workspaceId !== runtime.identity.workspaceId) {
        this.setExecuting(false);
        return;
      }
      this.setExecuting(true);
      const deps = this.options.deps();
      try {
        // scan_compile：独立连接跑有界回溯批次（异步模型编译；沿用 WMB-5230 生产形态），
        // checkpoint 提交后由授权推进命令在运行时连接上读取并推进 run 状态。
        if (run.phase === 'scan_compile') {
          await runKnowledgeBackfillBatchWith(deps.backfill);
        }
        const receipt = await dispatchBusinessCommand(runtime, {
          command: KNOWLEDGE_MAINTENANCE_TICK_COMMAND,
          requestId: `knowledge-maintenance:${run.runId}:tick:${Date.now()}`,
          actor: maintenanceSchedulerActor,
          input: { workspaceId: runtime.identity.workspaceId },
          boundIdentity: runtime.identity,
          entityType: 'knowledge_maintenance_run',
          execute: (db) => ({ data: advanceMaintenanceRun(db, { workspaceId: runtime.identity.workspaceId }) })
        });
        const result = requireReceiptData(receipt);
        this.setExecuting(result.run.status === 'running');
      } catch (error) {
        console.error('[knowledge-maintenance] tick failed', error);
        const failure = errorInfo(error);
        try {
          await dispatchBusinessCommand(runtime, {
            command: KNOWLEDGE_MAINTENANCE_FAIL_COMMAND,
            requestId: `knowledge-maintenance:${run.runId}:fail:${Date.now()}`,
            actor: maintenanceSchedulerActor,
            input: { workspaceId: runtime.identity.workspaceId, error: failure },
            boundIdentity: runtime.identity,
            entityType: 'knowledge_maintenance_run',
            execute: (db) => ({ data: failMaintenanceRun(db, runtime.identity.workspaceId, failure) })
          });
        } catch (failError) {
          console.error('[knowledge-maintenance] failed to record run failure', failError);
        }
        this.setExecuting(false);
        broadcastDataChanged({ scopes: ['knowledge', 'topics', 'health', 'receipt', 'library'], reason: 'knowledge.maintenance.fail' });
      }
    })();
    await this.current;
    this.current = null;
    if (this.stopped || (this.options.isCurrent && !this.options.isCurrent())) return;
    if (this.rerun) {
      this.rerun = false;
      this.wake();
      return;
    }
    this.timer = setTimeout(() => void this.tick(), intervalMs);
    this.timer.unref();
  }
}
