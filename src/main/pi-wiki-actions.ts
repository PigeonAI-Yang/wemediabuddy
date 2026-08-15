/**
 * WMB-5240：Pi/operator 全 Wiki 操作 —— main 侧受控执行器（本 worker：ImplementPiWikiActionExecutor）。
 * Design: WMB-5240 施工许可（M-5240，CAP-014/CAP-027）+ src/shared/wiki-operator-protocol.ts
 *   （严格解析 SSOT：fence key `wmb_wiki_action`，fail-closed，本模块不再自行宽松解析）
 *   + 既有正式管线：WMB-5236 knowledge-maintenance、WMB-5230 knowledge-backfill（维护 scan_compile 阶段）、
 *   knowledge-health（全局 Lint）、WMB-5238 searchWikiIndex / listKnowledgeLogEntries、
 *   WMB-5214 query-writeback（可复用答案写回；协议层独立 fence，本模块不复制）。
 *
 * 职责：
 * - 把已解析动作（WikiActionManifest）严格分发到既有正式命令/API，绝不新建第二个 runtime、
 *   不新增 raw DB/execute IPC、不绕过 canonical operator Skill / dispatcher / 既有管线；
 * - 写动作（maintain start/pause/resume、ingest、lint run=true）一律经
 *   dispatchBusinessCommand → runtime.dispatchCommand（workspace write guard +
 *   assertTaskGrantForEnvelope 硬门）；envelope actor 由调用方声明（pi / external_agent），
 *   authority（taskId/grantId/workerLeaseId）来自 manifest（shared 解析器已强制写动作必填）；
 *   无活动 runtime → WIKI_ACTION_RUNTIME_UNAVAILABLE 拒绝（零写）；
 * - 只读动作（maintain status/report、lint 状态、search、log、report、query）直达
 *   workspace 作用域只读 store；绝不接受 manifest 中的 workspaceId/rootPath/本地路径入参
 *   （T-IDOR-1/T-LF-1：工作空间身份只来自绑定 runtime/数据库）；
 * - 批量有界（T-BR-1/2）：ingest items 1..50（解析器强制 + 本模块再核）、search limit ≤100、
 *   log limit ≤100；超限零写；
 * - 逐项结果 + 失败隔离：ingest 每 item 独立有界派发（派生稳定 requestId `${requestId}:item:{index}`），
 *   单 item 失败不阻断其余 item；部分失败 overall='partial'，绝不虚报全成功；
 * - requestId 幂等（T-RE-1/2）：同 requestId + 同输入 → dispatcher 原回执重放（零重复）；
 *   异输入 → REQUEST_REPLAY_CONFLICT（保持原回执语义，不换 ID 绕过）；
 * - 失败回执（T-EL-1）：不携带 rootPath/绝对路径/SQL/堆栈；错误码 + 中文可读原因；
 * - 动作面（T-PUB-1/2）：不含红线命令（无最终平台发布/硬删/外部平台变更执行）；
 *   发布仍只由用户在 WMB UI 新鲜确认，本模块零发布路径。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { CommandActorV1, CommandReceiptV1 } from './command-dispatcher.ts';
import { CommandDispatchError } from './command-dispatcher.ts';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import { dispatchSourceUpsertBatch, type SourceUpsertBatchResult } from './source-commands.ts';
import type { SourceInput } from './sources.ts';
import {
  countOpenHealthIssues,
  emptyMaintenanceStatus,
  getMaintenanceReport,
  getMaintenanceStatus,
  pauseMaintenanceRun,
  resumeMaintenanceRun,
  startMaintenanceRun,
  type KnowledgeMaintenanceRun
} from './knowledge-maintenance.ts';
import {
  beginPeriodicLint,
  getPeriodicLintCheckpoint,
  runPeriodicLintStep
} from './knowledge-health.ts';
import { searchWikiIndex } from './knowledge-search.ts';
import { listKnowledgeLogEntries } from './knowledge-global-log.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import {
  WIKI_INGEST_BATCH_MAX,
  WIKI_MAINTENANCE_BATCH_LIMIT_MAX,
  WIKI_MAINTENANCE_MAX_TOPICS_MAX,
  WIKI_MAINTENANCE_STALL_LIMIT_MAX,
  type WikiActionKind,
  type WikiActionManifest,
  type WikiIngestItem,
  type WikiMaintainConfig
} from '../shared/wiki-operator-protocol.ts';

// ============================================================
// 命令常量（写动作的 dispatcher 命令面；新命令已在 TASK_INTERNAL_COMMANDS +
// cap.wiki_maintain（desk standing）登记）
// ============================================================

/** 全库维护 run 生命周期写命令（input.action = start|pause|resume）。 */
export const WIKI_MAINTENANCE_COMMAND = 'knowledge.maintenance';
/** 全局 Lint 有界步进写命令（input.action = step）。 */
export const WIKI_LINT_COMMAND = 'knowledge.lint';
/** Ingest 写命令（复用既有 sources.upsert_batch 命令面，cap.collect/cap.research 已 grantable）。 */
export const WIKI_INGEST_COMMAND = 'sources.upsert_batch';

// ============================================================
// 失败形状（T-EL-1：无 rootPath/绝对路径/SQL/堆栈）
// ============================================================

export type WikiActionFailure = Readonly<{
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export type WikiActionOverall = 'succeeded' | 'partial' | 'no_op';

export type WikiActionResult =
  | Readonly<{
      ok: true;
      requestId: string;
      action: WikiActionKind;
      overall: WikiActionOverall;
      data: unknown;
      receipts?: readonly CommandReceiptV1[];
    }>
  | Readonly<{
      ok: false;
      requestId: string;
      action: WikiActionKind;
      overall: 'failed';
      data: null;
      error: WikiActionFailure;
      /** 被拒写命令的持久化回执（dispatcher 已落 command_receipts；证据，非完成）。 */
      receipts?: readonly CommandReceiptV1[];
    }>;

export type WikiActionExecutorContext = Readonly<{
  /** 活动运行时：写动作必需（dispatcher + workspace write guard）；缺省时读动作退化到 database。 */
  runtime?: ActiveWorkspaceRuntime;
  /** workspace 作用域只读数据库（缺省 = runtime.database）。 */
  database?: DatabaseSync;
}>;

export type WikiActionCaller = Readonly<{ actor: 'pi' | 'external_agent' }>;

// ============================================================
// query 动作路由缝（由 ImplementPiFixedVersionQuery 注册；未注册 fail-closed）
// ============================================================

export type WikiQueryExecutor = (
  ctx: Readonly<{ runtime: ActiveWorkspaceRuntime; database: DatabaseSync }>,
  manifest: WikiActionManifest
) => Promise<unknown> | unknown;

let registeredQueryExecutor: WikiQueryExecutor | null = null;
let queryExecutorWireAttempted = false;

/** 固定版本 Query 执行器注册缝：WMB-5240 query 动作唯一入口；重复注册覆盖（后注册者生效）。 */
export function registerWikiQueryExecutor(executor: WikiQueryExecutor): void {
  registeredQueryExecutor = executor;
}

/**
 * 生产接线：把 query 动作路由到 ImplementPiFixedVersionQuery 的 `runFixedVersionQuery`
 * （src/main/fixed-version-query.ts）。动态导入原因：该模块由并行 worker 交付，可能晚于本模块
 * 落地；静态导入会让本模块在对方未落地时构建失败。幂等：只尝试一次；未落地 →
 * 返回 false，query 动作保持 WIKI_ACTION_QUERY_UNAVAILABLE fail-closed。
 */
export async function wireDefaultWikiQueryExecutor(): Promise<boolean> {
  if (queryExecutorWireAttempted || registeredQueryExecutor) return registeredQueryExecutor !== null;
  queryExecutorWireAttempted = true;
  try {
    const mod = await import('./fixed-version-query.ts') as { runFixedVersionQuery?: (database: DatabaseSync, input: Record<string, unknown>) => unknown };
    const runFixedVersionQuery = mod.runFixedVersionQuery;
    if (typeof runFixedVersionQuery !== 'function') return false;
    registerWikiQueryExecutor(({ database }, manifest) => {
      const payload = manifest.action === 'query' ? manifest : null;
      if (!payload) return { ok: false, error: { code: 'WIKI_ACTION_QUERY_INVALID', message: 'query 动作载荷缺失。' } };
      return runFixedVersionQuery(database, {
        ...(payload.question ? { question: payload.question } : {}),
        ...(payload.wikiVersionRefs && payload.wikiVersionRefs.length ? { wikiVersionRefs: [...payload.wikiVersionRefs] } : {}),
        ...(payload.noteVersionRefs && payload.noteVersionRefs.length ? { noteVersionRefs: [...payload.noteVersionRefs] } : {}),
        ...(payload.evidenceRefs && payload.evidenceRefs.length ? { evidenceRefs: [...payload.evidenceRefs] } : {})
      });
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 内部辅助
// ============================================================

function wikiActionError(code: string, message: string, details?: Readonly<Record<string, unknown>>): Error {
  return Object.assign(new Error(message), { code, details });
}

function boundWorkspaceIdOf(database: DatabaseSync): string | null {
  try {
    const row = database.prepare("SELECT value AS workspaceId FROM app_meta WHERE key='workspace_id'").get() as
      | { workspaceId?: string }
      | undefined;
    return row?.workspaceId ?? null;
  } catch {
    return null;
  }
}

function databaseOf(ctx: WikiActionExecutorContext): DatabaseSync | null {
  if (ctx.database) return ctx.database;
  return ctx.runtime?.database ?? null;
}

function requireWriteRuntime(ctx: WikiActionExecutorContext): ActiveWorkspaceRuntime {
  if (!ctx.runtime) throw wikiActionError('WIKI_ACTION_RUNTIME_UNAVAILABLE', '没有活动工作空间运行时，写动作被拒绝（零写）。');
  return ctx.runtime;
}

function actorOf(caller: WikiActionCaller): CommandActorV1 {
  return caller.actor === 'pi'
    ? Object.freeze({ type: 'pi' as const, id: 'pi', label: 'Pi worker' })
    : Object.freeze({ type: 'external_agent' as const, id: 'mcp', label: 'External Agent' });
}

function authorityOf(manifest: WikiActionManifest): { taskId?: string; workerLeaseId?: string; grantId?: string } {
  return {
    ...(manifest.taskId ? { taskId: manifest.taskId } : {}),
    ...(manifest.workerLeaseId ? { workerLeaseId: manifest.workerLeaseId } : {}),
    ...(manifest.grantId ? { grantId: manifest.grantId } : {})
  };
}

/** 失败归一化：透传已知错误码；剥离 rootPath 等敏感路径（T-EL-1）。 */
function normalizeFailure(error: unknown, runtimePath?: string): WikiActionFailure {
  const code = typeof (error as { code?: unknown })?.code === 'string' && (error as { code: string }).code
    ? (error as { code: string }).code
    : 'WIKI_ACTION_FAILED';
  const raw = error instanceof Error ? error.message : String(error);
  let message = raw || '动作执行失败。';
  if (runtimePath) message = message.split(runtimePath).join('<workspace>');
  message = message.replace(/\b[A-Za-z]:[\\/][^\s]*/g, '<path>');
  const details = error instanceof CommandDispatchError && error.details
    ? (error.details as Readonly<Record<string, unknown>>)
    : undefined;
  return Object.freeze({ code, message, ...(details ? { details } : {}) });
}

/** 防御性再核 maintain config 边界（解析器已强制；执行器双门防直连绕过）。 */
function normalizeMaintainConfig(config: WikiMaintainConfig | undefined): WikiMaintainConfig | null {
  if (!config) return null;
  const out: { batchLimit?: number; maxTopicsPerSource?: number; stallLimit?: number } = {};
  if (config.batchLimit !== undefined) {
    const value = Math.floor(config.batchLimit);
    if (!Number.isFinite(value) || value < 1 || value > WIKI_MAINTENANCE_BATCH_LIMIT_MAX) {
      throw wikiActionError('WIKI_ACTION_MAINTAIN_CONFIG_INVALID', `batchLimit 必须在 1..${WIKI_MAINTENANCE_BATCH_LIMIT_MAX}。`);
    }
    out.batchLimit = value;
  }
  if (config.maxTopicsPerSource !== undefined) {
    const value = Math.floor(config.maxTopicsPerSource);
    if (!Number.isFinite(value) || value < 1 || value > WIKI_MAINTENANCE_MAX_TOPICS_MAX) {
      throw wikiActionError('WIKI_ACTION_MAINTAIN_CONFIG_INVALID', `maxTopicsPerSource 必须在 1..${WIKI_MAINTENANCE_MAX_TOPICS_MAX}。`);
    }
    out.maxTopicsPerSource = value;
  }
  if (config.stallLimit !== undefined) {
    const value = Math.floor(config.stallLimit);
    if (!Number.isFinite(value) || value < 1 || value > WIKI_MAINTENANCE_STALL_LIMIT_MAX) {
      throw wikiActionError('WIKI_ACTION_MAINTAIN_CONFIG_INVALID', `stallLimit 必须在 1..${WIKI_MAINTENANCE_STALL_LIMIT_MAX}。`);
    }
    out.stallLimit = value;
  }
  return Object.freeze(out);
}

/** 防御性再核 ingest 条目（协议已强制；执行器双门：title 非空、originalUrl http(s)、feedId 禁入）。 */
function validateIngestItem(item: WikiIngestItem, index: number): { ok: true; item: WikiIngestItem } | { ok: false; error: WikiActionFailure } {
  if (typeof item.title !== 'string' || !item.title.trim()) {
    return { ok: false, error: { code: 'WIKI_ACTION_INGEST_ITEM_INVALID', message: `第 ${index + 1} 条资料缺少非空 title。` } };
  }
  if (typeof item.originalUrl !== 'string' || !/^https?:\/\//i.test(item.originalUrl.trim())) {
    return { ok: false, error: { code: 'WIKI_ACTION_INGEST_ITEM_INVALID', message: `第 ${index + 1} 条资料 originalUrl 必须是 http(s) 链接。` } };
  }
  return { ok: true, item };
}

/** WikiIngestItem（readonly 协议类型）→ SourceInput（sources.upsert_batch 入参；可变数组）。 */
function toSourceInput(item: WikiIngestItem): SourceInput {
  return {
    title: item.title,
    originalUrl: item.originalUrl,
    ...(item.author ? { author: item.author } : {}),
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.categories ? { categories: [...item.categories] } : {}),
    ...(item.keywords ? { keywords: [...item.keywords] } : {}),
    ...(item.valueJudgment ? { valueJudgment: item.valueJudgment } : {}),
    ...(item.ipRelevance ? { ipRelevance: item.ipRelevance } : {}),
    ...(item.creationAngles ? { creationAngles: item.creationAngles } : {}),
    ...(item.recommendedPlatforms ? { recommendedPlatforms: [...item.recommendedPlatforms] } : {}),
    ...(item.recommendedFormats ? { recommendedFormats: [...item.recommendedFormats] } : {}),
    ...(item.timeliness ? { timeliness: item.timeliness } : {}),
    ...(item.priority !== undefined ? { priority: item.priority } : {}),
    ...(item.evidence ? { evidence: item.evidence } : {}),
    ...(item.expectedRevision !== undefined ? { expectedRevision: item.expectedRevision } : {})
  };
}

// ============================================================
// 动作执行（每动作一个函数；读直达只读 store，写经 dispatcher）
// ============================================================

type MaintainWriteData = Readonly<{ run: KnowledgeMaintenanceRun | null; created?: boolean }>;

async function executeMaintain(
  ctx: WikiActionExecutorContext,
  manifest: WikiActionManifest,
  caller: WikiActionCaller
): Promise<WikiActionResult> {
  if (manifest.action !== 'maintain') throw wikiActionError('WIKI_ACTION_INVALID', 'maintain 动作载荷不匹配。');
  const requestId = manifest.requestId;
  const subaction = manifest.subaction;
  if (subaction === 'status' || subaction === 'report') {
    const db = databaseOf(ctx);
    if (!db) throw wikiActionError('WIKI_ACTION_RUNTIME_UNAVAILABLE', '没有可用工作空间数据源，只读动作被拒绝。');
    if (subaction === 'status') {
      const workspaceId = boundWorkspaceIdOf(db);
      return {
        ok: true,
        requestId,
        action: 'maintain',
        overall: 'succeeded',
        data: workspaceId ? getMaintenanceStatus(db, workspaceId) : emptyMaintenanceStatus()
      };
    }
    const report = getMaintenanceReport(db);
    return {
      ok: true,
      requestId,
      action: 'maintain',
      overall: report ? 'succeeded' : 'no_op',
      data: { report }
    };
  }
  // 写面：start / pause / resume 经 dispatcher（grant + write guard）
  const runtime = requireWriteRuntime(ctx);
  const receipt = await dispatchBusinessCommand<{ action: string; workspaceId: string; config?: WikiMaintainConfig | null }, MaintainWriteData>(runtime, {
    command: WIKI_MAINTENANCE_COMMAND,
    requestId,
    actor: actorOf(caller),
    input: {
      action: subaction,
      workspaceId: runtime.identity.workspaceId,
      config: subaction === 'start' ? normalizeMaintainConfig(manifest.config) : null
    },
    boundIdentity: { entityType: 'knowledge_maintenance_run' },
    entityType: 'knowledge_maintenance_run',
    ...authorityOf(manifest),
    execute: (database, value) => {
      if (value.action === 'start') {
        const started = startMaintenanceRun(database, { workspaceId: value.workspaceId, ...((value.config ?? {}) as Record<string, unknown>) });
        return { data: { run: started.run, created: started.created }, entityId: started.run.runId, readback: started.run };
      }
      if (value.action === 'pause') {
        const paused = pauseMaintenanceRun(database, value.workspaceId);
        if (!paused) return { data: { run: null }, readback: null };
        return { data: { run: paused }, entityId: paused.runId, readback: paused };
      }
      const resumed = resumeMaintenanceRun(database, value.workspaceId);
      return { data: { run: resumed }, entityId: resumed.runId, readback: resumed };
    }
  });
  if (!receipt.ok) {
    // 被拒写命令：dispatcher 已持久化错误回执（grant 缺失/越界/replay 冲突等）→ 作为证据返回，零业务写。
    const error = receipt.error ?? { code: 'WIKI_ACTION_MAINTAIN_FAILED', message: '维护写命令未通过。' };
    return { ok: false, requestId, action: 'maintain', overall: 'failed', data: null, error, receipts: [receipt] };
  }
  const data = requireReceiptData<MaintainWriteData>(receipt);
  const overall: WikiActionOverall = subaction === 'start'
    ? (data.created ? 'succeeded' : 'no_op')
    : (data.run ? 'succeeded' : 'no_op');
  return { ok: true, requestId, action: 'maintain', overall, data, receipts: [receipt] };
}

async function executeIngest(
  ctx: WikiActionExecutorContext,
  manifest: WikiActionManifest,
  caller: WikiActionCaller
): Promise<WikiActionResult> {
  if (manifest.action !== 'ingest') throw wikiActionError('WIKI_ACTION_INVALID', 'ingest 动作载荷不匹配。');
  const requestId = manifest.requestId;
  const items = manifest.items;
  // 双门边界：items 1..50（T-BR-1；超限零写）
  if (!Array.isArray(items) || items.length < 1 || items.length > WIKI_INGEST_BATCH_MAX) {
    throw wikiActionError('WIKI_ACTION_INGEST_BATCH_INVALID', `ingest 批量必须在 1..${WIKI_INGEST_BATCH_MAX} 条。`);
  }
  const runtime = requireWriteRuntime(ctx);
  const actor = actorOf(caller);
  // 逐项前置校验（失败隔离：非法 item 只影响自身，合法 item 照常派发）
  const validated = items.map((item, index) => ({ index, ...validateIngestItem(item, index) }));
  const perItemResults: Array<Record<string, unknown>> = [];
  const receipts: CommandReceiptV1[] = [];
  let failed = 0;
  for (const entry of validated) {
    if (!entry.ok) {
      failed += 1;
      perItemResults.push({ index: entry.index, ok: false, error: entry.error });
      continue;
    }
    // 每 item 独立有界派发（派生稳定 requestId：`{requestId}:item:{index}`——整批重放逐 item 零重复）
    const itemRequestId = `${requestId}:item:${entry.index}`;
    try {
      const receipt = await dispatchSourceUpsertBatch(runtime, {
        requestId: itemRequestId,
        actor,
        items: [toSourceInput(entry.item)],
        ...authorityOf(manifest)
      });
      receipts.push(receipt);
      if (!receipt.ok) {
        failed += 1;
        const error = receipt.error ?? { code: 'WIKI_ACTION_INGEST_ITEM_FAILED', message: '资料写入未通过。' };
        perItemResults.push({ index: entry.index, ok: false, requestId: itemRequestId, error });
        continue;
      }
      const result = receipt.data as SourceUpsertBatchResult | null;
      const saved = result?.items?.[0];
      perItemResults.push({
        index: entry.index,
        ok: true,
        requestId: itemRequestId,
        id: saved?.id ?? null,
        created: saved?.created ?? false,
        revision: saved?.revision ?? null
      });
    } catch (error) {
      failed += 1;
      perItemResults.push({ index: entry.index, ok: false, requestId: itemRequestId, error: normalizeFailure(error, ctx.runtime?.identity.rootPath) });
    }
  }
  const allFailed = failed === validated.length;
  const data = { items: perItemResults, failed, total: validated.length };
  if (allFailed) {
    // 全部失败时透传一致的首个错误码（REQUEST_REPLAY_CONFLICT / TASK_GRANT_REQUIRED /
    // TASK_SCOPE_BROADENED 等 dispatcher 语义必须原样可见，不折叠成泛化码）
    const firstError = perItemResults[0]?.error as WikiActionFailure | undefined;
    const uniform = firstError && perItemResults.every((item) => (item.error as WikiActionFailure | undefined)?.code === firstError.code);
    const error = uniform && firstError
      ? firstError
      : { code: 'WIKI_ACTION_INGEST_ALL_FAILED', message: `全部 ${failed} 条资料写入失败（零成功）。` };
    return { ok: false, requestId, action: 'ingest', overall: 'failed', data: null, error, receipts };
  }
  const overall: WikiActionOverall = failed === 0 ? 'succeeded' : 'partial';
  return { ok: true, requestId, action: 'ingest', overall, data, receipts };
}

async function executeLint(ctx: WikiActionExecutorContext, manifest: WikiActionManifest, caller: WikiActionCaller): Promise<WikiActionResult> {
  if (manifest.action !== 'lint') throw wikiActionError('WIKI_ACTION_INVALID', 'lint 动作载荷不匹配。');
  const requestId = manifest.requestId;
  const run = manifest.run === true;
  if (!run) {
    // 只读：checkpoint + 未解决 Issue 计数
    const db = databaseOf(ctx);
    if (!db) throw wikiActionError('WIKI_ACTION_RUNTIME_UNAVAILABLE', '没有可用工作空间数据源，只读动作被拒绝。');
    return {
      ok: true,
      requestId,
      action: 'lint',
      overall: 'succeeded',
      data: { checkpoint: getPeriodicLintCheckpoint(db), openIssues: countOpenHealthIssues(db) }
    };
  }
  // 写面：一步有界全局 Lint（beginPeriodicLint 续跑 + runPeriodicLintStep；与维护 lint 阶段/周期调度同机）
  const runtime = requireWriteRuntime(ctx);
  const receipt = await dispatchBusinessCommand<{ action: string; workspaceId: string }, unknown>(runtime, {
    command: WIKI_LINT_COMMAND,
    requestId,
    actor: actorOf(caller),
    input: { action: 'step', workspaceId: runtime.identity.workspaceId },
    boundIdentity: { entityType: 'knowledge_lint_job' },
    entityType: 'knowledge_lint_job',
    ...authorityOf(manifest),
    execute: (database, value) => {
      beginPeriodicLint(database, { workspaceId: value.workspaceId, scope: 'global', resume: true });
      const step = runPeriodicLintStep(database);
      return { data: step, entityId: step.checkpoint.runId, readback: step };
    }
  });
  if (!receipt.ok) {
    const error = receipt.error ?? { code: 'WIKI_ACTION_LINT_FAILED', message: 'Lint 写命令未通过。' };
    return { ok: false, requestId, action: 'lint', overall: 'failed', data: null, error, receipts: [receipt] };
  }
  const data = requireReceiptData(receipt);
  return { ok: true, requestId, action: 'lint', overall: 'succeeded', data, receipts: [receipt] };
}

function executeSearch(ctx: WikiActionExecutorContext, manifest: WikiActionManifest): WikiActionResult {
  if (manifest.action !== 'search') throw wikiActionError('WIKI_ACTION_INVALID', 'search 动作载荷不匹配。');
  const requestId = manifest.requestId;
  const db = databaseOf(ctx);
  if (!db) throw wikiActionError('WIKI_ACTION_RUNTIME_UNAVAILABLE', '没有可用工作空间数据源，只读动作被拒绝。');
  const page = searchWikiIndex(db, {
    query: manifest.query ?? '',
    ...(manifest.limit !== undefined ? { limit: manifest.limit } : {}),
    ...(manifest.objectTypes ? { objectTypes: [...manifest.objectTypes] } : {})
  });
  return { ok: true, requestId, action: 'search', overall: 'succeeded', data: page };
}

function executeLog(ctx: WikiActionExecutorContext, manifest: WikiActionManifest): WikiActionResult {
  if (manifest.action !== 'log') throw wikiActionError('WIKI_ACTION_INVALID', 'log 动作载荷不匹配。');
  const requestId = manifest.requestId;
  const db = databaseOf(ctx);
  if (!db) throw wikiActionError('WIKI_ACTION_RUNTIME_UNAVAILABLE', '没有可用工作空间数据源，只读动作被拒绝。');
  const filter = manifest.filter ?? {};
  const page = listKnowledgeLogEntries(db, {
    ...filter,
    ...(manifest.limit !== undefined ? { limit: manifest.limit } : {}),
    ...(manifest.cursor ? { cursor: manifest.cursor } : {})
  });
  return { ok: true, requestId, action: 'log', overall: 'succeeded', data: page };
}

function executeReport(ctx: WikiActionExecutorContext, manifest: WikiActionManifest): WikiActionResult {
  if (manifest.action !== 'report') throw wikiActionError('WIKI_ACTION_INVALID', 'report 动作载荷不匹配。');
  const requestId = manifest.requestId;
  const db = databaseOf(ctx);
  if (!db) throw wikiActionError('WIKI_ACTION_RUNTIME_UNAVAILABLE', '没有可用工作空间数据源，只读动作被拒绝。');
  const report = getMaintenanceReport(db);
  return {
    ok: true,
    requestId,
    action: 'report',
    overall: report ? 'succeeded' : 'no_op',
    data: { report }
  };
}

async function executeQuery(ctx: WikiActionExecutorContext, manifest: WikiActionManifest): Promise<WikiActionResult> {
  if (manifest.action !== 'query') throw wikiActionError('WIKI_ACTION_INVALID', 'query 动作载荷不匹配。');
  const requestId = manifest.requestId;
  const runtime = ctx.runtime;
  const db = databaseOf(ctx);
  if (!runtime || !db) throw wikiActionError('WIKI_ACTION_RUNTIME_UNAVAILABLE', '没有可用工作空间运行时，query 动作被拒绝。');
  await wireDefaultWikiQueryExecutor();
  if (!registeredQueryExecutor) {
    throw wikiActionError('WIKI_ACTION_QUERY_UNAVAILABLE', '固定版本 Query 执行器尚未注册，query 动作未执行（零写）。');
  }
  const data = await registeredQueryExecutor({ runtime, database: db }, manifest);
  // 固定版本 Query 执行面返回 { ok:false, error:{code,message} }（引用非法/不存在/漂移等）：
  // 映射为动作级失败，用户可见（不把查询失败说成动作成功）。
  if (data !== null && typeof data === 'object' && 'ok' in data && data.ok === false) {
    const errorValue = (data as { error?: unknown }).error;
    const code = errorValue !== null && typeof errorValue === 'object' && 'code' in errorValue && typeof errorValue.code === 'string'
      ? errorValue.code
      : 'WIKI_ACTION_QUERY_FAILED';
    const message = errorValue !== null && typeof errorValue === 'object' && 'message' in errorValue && typeof errorValue.message === 'string'
      ? errorValue.message
      : '固定版本 Query 未通过（零写）。';
    return { ok: false, requestId, action: 'query', overall: 'failed', data: null, error: { code, message } };
  }
  return { ok: true, requestId, action: 'query', overall: 'succeeded', data };
}

// ============================================================
// 主入口
// ============================================================

/**
 * 执行一个已解析的 Wiki 操作清单（wmb_wiki_action）。
 * - manifest 必须来自 shared 解析器（normalizeWikiActionManifest / extractWikiActionManifest）——
 *   本函数对 manifest 做结构性信任 + 防御性双门（边界/字段），不自行宽松解析；
 * - caller.actor='pi'（dock 主管轮次）或 'external_agent'（MCP/外部 Agent）；
 * - 返回用户可见结果（成功/部分/低价值保留原始资料/失败），写动作附 dispatcher 回执证据。
 */
export async function executeWikiAction(
  ctx: WikiActionExecutorContext,
  manifest: WikiActionManifest,
  caller: WikiActionCaller
): Promise<WikiActionResult> {
  const requestId = manifest.requestId;
  const action = manifest.action;
  try {
    switch (action) {
      case 'maintain':
        return await executeMaintain(ctx, manifest, caller);
      case 'ingest':
        return await executeIngest(ctx, manifest, caller);
      case 'lint':
        return await executeLint(ctx, manifest, caller);
      case 'search':
        return executeSearch(ctx, manifest);
      case 'log':
        return executeLog(ctx, manifest);
      case 'report':
        return executeReport(ctx, manifest);
      case 'query':
        return await executeQuery(ctx, manifest);
    }
  } catch (error) {
    // 受控执行器契约：任何动作失败都以用户可见结果返回，异常不外泄；
    // 已知业务码（dispatcher/协议/运行时）原样归一化，未知错误兜底 WIKI_ACTION_FAILED。
    return {
      ok: false,
      requestId,
      action,
      overall: 'failed',
      data: null,
      error: normalizeFailure(error, ctx.runtime?.identity.rootPath)
    };
  }
  throw wikiActionError('WIKI_ACTION_UNKNOWN', `未知动作 ${String(action)}。`);
}
