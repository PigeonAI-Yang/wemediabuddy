import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  getActiveAgentTask,
  getAgentTask,
  getReusableNeedsUserAgentTask,
  readDailyReceiptAggregation,
  type AgentTask,
  type DailyReceiptAggregation
} from './agent-tasks.ts';
import {
  dispatchFailAgentTask,
  dispatchFinishDailyIntelligence,
  dispatchNeedsUserAgentTask,
  dispatchReportAgentTaskProgress,
  dispatchStartAgentTask,
  type AgentTaskMutationDependency
} from './agent-task-commands.ts';
import type { XListBrowserConfig } from './platforms/x-list-primitives.ts';
import { selectedXListBrowser } from './x-list-context.ts';
import {
  readIntelligenceChannelsSummary,
  recordSourceScanReceipt,
  type IntelligenceChannelSource,
  type IntelligenceModule,
  type SourceScanStatus
} from './intelligence-channels.ts';
import { persistWebsiteSourceScan, readWebsiteSourceScan, scanWebsiteSource, type ScanWebsiteSourceInput, type WebsiteSourceScanRead } from './website-channel.ts';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import { collectBoundXListTimeline, persistBoundXListTimeline, readBoundXListTimeline } from './x-list-execution.ts';
import { getXListBinding } from './x-lists.ts';
import { dispatchScheduleXObservationCapture, scheduleXObservationCapture } from './x-observation-jobs.ts';
import type { TaskReadyGrantHook } from './task-grants.ts';
import type { DeferredSignal } from './role-job-registry.ts';
import { dailyControlWatchdogDecision } from './daily-control-policy.ts';

export type DailyChannelInput = {
  businessDate: string;
  workspaceId: string;
  profileRevision: number;
  modules?: IntelligenceModule[];
  workerLeaseId?: string;
  onTaskReady?: TaskReadyGrantHook;
};

export type FrozenDailyChannelSource = Pick<IntelligenceChannelSource,
  'module' | 'sourceId' | 'sourceFeedId' | 'revision' | 'accountKey' | 'listId'>;
export type FrozenDailyChannels = {
  workspaceId: string;
  profileRevision: number;
  modules: IntelligenceModule[];
  sources: FrozenDailyChannelSource[];
};
export type DailyChannelRun = {
  task: AgentTask;
  reused: boolean;
  shouldRunJudgment: boolean;
  frozen: FrozenDailyChannels;
  aggregation: DailyReceiptAggregation | null;
  /** WMB-5118 §5.2：守卫命中 running judge 的瞬时让路信号（不写 agent_task 终态）。 */
  deferred?: DeferredSignal | null;
};

type XCollect = typeof collectBoundXListTimeline;
type WebsiteScan = typeof scanWebsiteSource;

/** WMB-5137：浏览器预检结果。config 为 null 时 X 来源不可扫描；preflightError 记录非用户态
 * 预检异常（如 identifyXAccount 超时），逐 X 来源落可追踪 failed receipt，不阻断其他渠道。 */
export type BrowserPreflight = Readonly<{
  config: XListBrowserConfig | null;
  preflightError: Readonly<{ code: string; message: string }> | null;
}>;
type BrowserPreflightResolver = (database: DatabaseSync, frozen: FrozenDailyChannels, configured: XListBrowserConfig | null | undefined) => Promise<BrowserPreflight>;

const BROWSER_NEEDS_USER_CODES: Record<string, true> = {
  BROWSER_NEEDS_USER: true,
  ACCOUNT_MISMATCH: true,
  BROWSER_PROFILE_MISMATCH: true,
  PROFILE_STALE: true
};

/**
 * 滚动调度前置检查：某模块连一个启用的来源都没有时，tick 直接跳过——
 * 不创建任务、不写回执。否则每次 X 心跳都会落一个 CHANNELS_NEEDS_USER/NOT_CONFIGURED 假任务，
 * 还会以「最新任务」身份在今日页投出假 blocker。
 */
export function hasEnabledDailySources(database: DatabaseSync, modules: IntelligenceModule[]): boolean {
  for (const module of modules) {
    if (module === 'official_web') {
      const row = database.prepare('SELECT COUNT(*) AS count FROM website_sources WHERE enabled=1').get() as { count: number };
      if (row.count > 0) return true;
    }
    if (module === 'x_lists') {
      const row = database.prepare('SELECT COUNT(*) AS count FROM x_list_bindings WHERE enabled=1').get() as { count: number };
      if (row.count > 0) return true;
    }
  }
  return false;
}

export async function startDailyChannelRun(dependency: AgentTaskMutationDependency, input: DailyChannelInput, dependencies: {
  browserConfig?: XListBrowserConfig | null;
  websiteFetch?: typeof fetch;
  scanWebsite?: WebsiteScan;
  collectX?: XCollect;
  /** WMB-5137：浏览器预检解析（缺省 resolveBrowserConfig）；返回非用户态错误信息而非抛出，
   *  使 X 预检失败只影响 X 来源（逐源 failed 回执），official_web 等渠道继续。 */
  preflight?: BrowserPreflightResolver;
} = {}): Promise<DailyChannelRun> {
  const database: DatabaseSync = 'database' in dependency ? dependency.database : dependency;
  const actor = { type: 'scheduler' as const, id: 'daily-intelligence', label: 'daily-intelligence' };
  const commandContext = (requestId: string, taskId?: string) => ({ actor, requestId, taskId, workerLeaseId: input.workerLeaseId });
  const summary = readIntelligenceChannelsSummary(database);
  const frozen = freezeChannels(summary.sources, input);
  const contextRefs = {
    planDate: input.businessDate,
    workspaceId: input.workspaceId,
    workspaceProfileRevision: input.profileRevision,
    intelligenceChannels: frozen
  };
  const provisional = preflightCode(frozen);
  if (provisional) {
    const reusable = getReusableNeedsUserAgentTask(database, 'daily_scan', input.businessDate, contextRefs, provisional.code);
    if (reusable) return { task: reusable, reused: true, shouldRunJudgment: false, frozen: readFrozenChannels(reusable) ?? frozen, aggregation: null };
  }

  // 判断进行中禁止再开扫描，避免 source revision 被扫写顶掉导致整轮判定失败。
  // WMB-5118：不再把 judge 任务静默当扫描任务返回（交叉 A 伪失败根因）——打 deferred 让路标记，
  // 由 runner 产出瞬时 deferred outcome → pool 泊车 RESOURCE_JUDGE_IN_FLIGHT；task 引用仅作参考。
  const activeJudge = getActiveAgentTask(database, 'daily_judge', input.businessDate)
    || getActiveAgentTask(database, 'daily_intelligence', input.businessDate);
  if (activeJudge && activeJudge.status === 'running' && activeJudge.phase !== 'channel_scanned' && activeJudge.phase !== 'starting') {
    const phase = String(activeJudge.phase || '');
    if (/judg|synth|validat|running_pi/i.test(phase)) {
      return {
        task: activeJudge,
        reused: true,
        shouldRunJudgment: false,
        frozen: readFrozenChannels(activeJudge) ?? frozen,
        aggregation: readDailyReceiptAggregation(database, activeJudge),
        deferred: { reason: 'JUDGE_IN_FLIGHT', taskId: activeJudge.id }
      };
    }
  }

  // requestId must be unique per click: frozen channel revisions change between runs.
  const startRequestId = `daily_intelligence:${input.businessDate}:${input.workspaceId}:channels:start:${randomUUID()}`;
  const started = await dispatchStartAgentTask(dependency, { intent: 'daily_scan', businessDate: input.businessDate, contextRefs: { ...contextRefs, roleId: 'reporter' } }, commandContext(startRequestId));
  const task = started.task;
  const stored = readFrozenChannels(task) ?? frozen;
  if (stored.workspaceId !== input.workspaceId || stored.profileRevision !== input.profileRevision) {
    const failed = await dispatchFailAgentTask(dependency, task.id, 'CHANNEL_CONTEXT_STALE', '工作空间或配方已变化，不能继续旧的每日情报任务。', commandContext(`${task.id}:channels:context-stale`, task.id));
    return { task: failed, reused: started.reused, shouldRunJudgment: false, frozen: stored, aggregation: null };
  }
  // channel_scanned (or resume after scan completed): do not re-scan; hand off to judgment.
  if (started.reused && task.phase === 'channel_scanned') {
    return { task, reused: true, shouldRunJudgment: true, frozen: stored, aggregation: readDailyReceiptAggregation(database, task) };
  }
  if (started.reused && task.phase === 'resume_pending') {
    const prior = readDailyReceiptAggregation(database, task);
    const planned = stored.sources.length;
    if (planned > 0 && prior.receipts.length >= planned) {
      return { task, reused: true, shouldRunJudgment: true, frozen: stored, aggregation: prior };
    }
  }
  if (started.reused && task.phase !== 'resume_pending') {
    return { task, reused: true, shouldRunJudgment: false, frozen: stored, aggregation: readDailyReceiptAggregation(database, task) };
  }

  await input.onTaskReady?.(task.id);

  await dispatchReportAgentTaskProgress(dependency, task.id, {
    phase: 'starting',
    progress: { planned: stored.sources.length, processed: 0, failed: 0 },
    checkpoint: { intelligenceChannels: stored },
    message: '正在启动今日情报…'
  }, commandContext(`${task.id}:progress:starting:${randomUUID()}`, task.id));

  const resolvePreflight = dependencies.preflight ?? resolveBrowserConfig;
  const preflight = await resolvePreflight(database, stored, dependencies.browserConfig);
  const browserConfig = preflight.config;
  const selected = stored.sources;
  const existingReceipts = readDailyReceiptAggregation(database, task).receipts;
  const checked = new Set(existingReceipts.map((receipt) => `${receipt.module}:${receipt.sourceId}`));
  const pending = selected.filter((source) => !checked.has(`${source.module}:${source.sourceId}`));
  const live = pending.filter((source) => sourceIsReady(database, source, browserConfig));
  const blocked = pending.filter((source) => !live.includes(source));
  await dispatchReportAgentTaskProgress(dependency, task.id, {
    phase: 'channel_preflight',
    progress: { planned: selected.length, processed: existingReceipts.length, failed: existingReceipts.filter((receipt) => receipt.status !== 'succeeded').length },
    checkpoint: { intelligenceChannels: stored },
    message: `已冻结 ${selected.length} 个情报来源，待检查 ${pending.length} 个。`
  }, commandContext(`${task.id}:progress:channel-preflight:${randomUUID()}`, task.id));
  if (!selected.length) return finishBlocked(dependency, commandContext, task, stored, 'CHANNELS_NOT_CONFIGURED', '当前工作空间没有启用的官网或 X List。', null, started.reused);

  for (const source of blocked) {
    // WMB-5137：预检失败（identifyXAccount 超时等非用户态异常）的 X 来源逐源落可追踪
    // failed 回执（渠道标识 + code + message）；其余 blocked（含用户态 needs_user 类）保持原路径。
    if (preflight.preflightError && source.module === 'x_lists') {
      await recordPreflightFailure(dependency, database, task.id, stored.workspaceId, source, preflight.preflightError, input.workerLeaseId);
    } else {
      await recordBlockedReceipt(dependency, database, task.id, stored.workspaceId, source, input.workerLeaseId);
    }
  }
  if (blocked.length) {
    await reportChannelScanProgress(dependency, database, task.id, selected.length, stored, commandContext, {
      message: `已标记 ${blocked.length} 个未就绪来源，继续检查可运行渠道。`
    });
  }

  const scanWebsite = dependencies.scanWebsite ?? scanWebsiteSource;
  const collectX = dependencies.collectX ?? collectBoundXListTimeline;
  const websites = live.filter((source) => source.module === 'official_web');
  const stopScanIfControlled = async (): Promise<boolean> => {
    const cur = getAgentTask(database, task.id);
    if (!cur || cur.status !== 'running') return true;
    if (cur.controlAction === 'cancel' || cur.controlAction === 'save_partial') return true;
    const decision = dailyControlWatchdogDecision(cur);
    if (decision) {
      await dispatchFinishDailyIntelligence(dependency, cur.id, {
        forcePartial: true,
        errorCode: decision.code,
        errorMessage: decision.message
      }, commandContext(`${cur.id}:finish:${decision.reason}`, cur.id));
      return true;
    }
    return false;
  };
  for (const source of websites) {
    if (await stopScanIfControlled()) break;
    await reportChannelScanProgress(dependency, database, task.id, selected.length, stored, commandContext, {
      phase: 'scanning_sources',
      currentSource: channelSourceLabel(database, source),
      message: `正在扫描官网：${channelSourceLabel(database, source)}`
    });
    const scanInput = { taskId: task.id, workspaceId: stored.workspaceId, sourceId: source.sourceId, fetchImpl: dependencies.websiteFetch };
    try {
      if (dependencies.scanWebsite) await scanWebsite(database, scanInput);
      else {
        const read = await readWebsiteSourceScan(database, scanInput);
        await commitWebsiteScan(dependency, scanInput, read, input.workerLeaseId);
      }
    } catch (error) {
      await recordAttemptFailure(dependency, database, task.id, stored.workspaceId, source, error, input.workerLeaseId);
    }
    await reportChannelScanProgress(dependency, database, task.id, selected.length, stored, commandContext, {
      phase: 'scanning_sources',
      message: '官网来源已写入扫描回执'
    });
  }
  // The profile was resolved from this root's verified binding before any X scan.
  const selectedXBindingIds = selected.filter((item) => item.module === 'x_lists').map((item) => item.sourceId);
  for (const source of live.filter((item) => item.module === 'x_lists')) {
    if (await stopScanIfControlled()) break;
    await reportChannelScanProgress(dependency, database, task.id, selected.length, stored, commandContext, {
      phase: 'scanning_sources',
      currentSource: channelSourceLabel(database, source),
      message: `正在扫描 X List：${channelSourceLabel(database, source)}`
    });
    try {
      await scanXList(dependency, database, task.id, input.workerLeaseId, stored.workspaceId, source, selectedXBindingIds, browserConfig, collectX);
    } catch (error) {
      await recordAttemptFailure(dependency, database, task.id, stored.workspaceId, source, error, input.workerLeaseId);
    }
    await reportChannelScanProgress(dependency, database, task.id, selected.length, stored, commandContext, {
      phase: 'scanning_sources',
      message: 'X List 来源已写入扫描回执'
    });
  }

  const current = getAgentTask(database, task.id);
  if (!current || current.status !== 'running') {
    return { task: current ?? task, reused: started.reused === true, shouldRunJudgment: false, frozen: stored, aggregation: current ? readDailyReceiptAggregation(database, current) : null };
  }
  const aggregation = readDailyReceiptAggregation(database, current);
  const failed = aggregation.receipts.filter((receipt) => receipt.status !== 'succeeded').length + aggregation.missingReceiptCount;
  const saved = aggregation.receipts.reduce((total, receipt) => total + receipt.savedCount, 0);
  await dispatchReportAgentTaskProgress(dependency, current.id, {
    phase: 'channel_scanned',
    progress: { planned: selected.length, processed: aggregation.receipts.length, failed, saved },
    checkpoint: { intelligenceChannels: stored, channelReceiptIds: aggregation.receipts.map((receipt) => receipt.id) },
    message: `来源检查完成：${aggregation.receipts.length}/${selected.length}，保存 ${saved} 条资料。`
  }, commandContext(`${current.id}:progress:channel-scanned:${randomUUID()}`, current.id));
  if (aggregation.status === 'needs_user' || aggregation.status === 'failed') {
    // 渠道缺席/失败只标注，不再阻塞判断：库存资料永远可供判断，缺席信息由回执与池视图呈现。
    await dispatchReportAgentTaskProgress(dependency, current.id, {
      phase: 'channel_scanned',
      message: aggregation.status === 'needs_user' ? '全部已选来源需要处理；将基于库存资料继续判断。' : '来源检查未全部成功；将基于库存资料继续判断。',
      level: 'warning'
    }, commandContext(`${current.id}:progress:channel-absent:${randomUUID()}`, current.id));
  }
  const ready = getAgentTask(database, current.id);
  if (!ready) throw new Error('每日情报任务读取失败。');
  return { task: ready, reused: started.reused === true, shouldRunJudgment: true, frozen: stored, aggregation };

}
/**
 * WMB-5137：浏览器预检不再对非用户态异常 rethrow——identifyXAccount 超时等错误被捕获为
 * preflightError，由调用方逐 X 来源落 failed 回执并继续 official_web；NEEDS_USER 类仍返回
 * 空 config（既有 needs_user 回执路径）。任何错误都不再使整个工单失败。
 */
async function resolveBrowserConfig(database: DatabaseSync, frozen: FrozenDailyChannels, configured: XListBrowserConfig | null | undefined): Promise<BrowserPreflight> {
  if (configured !== undefined) return { config: configured, preflightError: null };
  if (!frozen.sources.some((source) => source.module === 'x_lists')) return { config: null, preflightError: null };
  try {
    return { config: await selectedXListBrowser(database), preflightError: null };
  } catch (error) {
    if (BROWSER_NEEDS_USER_CODES[errorCode(error)]) return { config: null, preflightError: null };
    return { config: null, preflightError: { code: errorCode(error), message: errorMessage(error) } };
  }
}

async function commitWebsiteScan(dependency: AgentTaskMutationDependency, input: ScanWebsiteSourceInput, read: WebsiteSourceScanRead, workerLeaseId?: string): Promise<void> {
  const database: DatabaseSync = 'database' in dependency ? dependency.database : dependency;
  if (!('database' in dependency)) { persistWebsiteSourceScan(database, input, read); return; }
  const receipt = await dispatchBusinessCommand(dependency, {
    command: 'intelligence_channels.website_scan', requestId: `${input.taskId}:website:${input.sourceId}:${read.original.revision}`,
    actor: { type: 'scheduler', id: 'daily-intelligence', label: 'daily-intelligence' },
    input: { taskId: input.taskId, workspaceId: input.workspaceId, sourceId: input.sourceId, read },
    boundIdentity: { workspaceId: input.workspaceId, sourceId: input.sourceId, revision: read.original.revision },
    taskId: input.taskId, workerLeaseId, causation: { taskId: input.taskId }, entityType: 'website_source',
    execute: (commandDatabase, value) => {
      const result = persistWebsiteSourceScan(commandDatabase, value, value.read);
      return { data: result, entityId: result.source.id, beforeRevision: read.original.revision, afterRevision: result.source.revision };
    }
  });
  requireReceiptData(receipt);
}

function freezeChannels(sources: IntelligenceChannelSource[], input: DailyChannelInput): FrozenDailyChannels {
  const modules = [...new Set(input.modules ?? ['official_web', 'x_lists'])].filter((module): module is IntelligenceModule => module === 'official_web' || module === 'x_lists');
  return {
    workspaceId: input.workspaceId,
    profileRevision: input.profileRevision,
    modules,
    sources: sources.filter((source) => source.enabled && modules.includes(source.module)).map((source) => {
      const frozen: FrozenDailyChannelSource = {
        module: source.module,
        sourceId: source.sourceId,
        sourceFeedId: source.sourceFeedId,
        revision: source.revision
      };
      if (source.accountKey !== undefined) frozen.accountKey = source.accountKey;
      if (source.listId !== undefined) frozen.listId = source.listId;
      return frozen;
    })
  };
}

function readFrozenChannels(task: AgentTask): FrozenDailyChannels | null {
  const value = task.contextRefs.intelligenceChannels;
  if (!value || typeof value !== 'object') return null;
  const frozen = value as Partial<FrozenDailyChannels>;
  if (typeof frozen.workspaceId !== 'string' || !Number.isInteger(frozen.profileRevision) || !Array.isArray(frozen.modules) || !Array.isArray(frozen.sources)) return null;
  return frozen as FrozenDailyChannels;
}

function preflightCode(frozen: FrozenDailyChannels): { code: string } | null {
  // 只有"完全没有启用来源"才是真正的配置阻塞；单个渠道未就绪只记录缺席回执，判断照常。
  if (!frozen.sources.length) return { code: 'CHANNELS_NOT_CONFIGURED' };
  return null;
}

function channelSourceLabel(database: DatabaseSync, source: FrozenDailyChannelSource): string {
  if (source.module === 'official_web') {
    const row = database.prepare('SELECT input_text AS name, canonical_url AS url FROM website_sources WHERE id=?').get(source.sourceId) as { name: string | null; url: string | null } | undefined;
    return (row?.name || row?.url || source.sourceId).trim();
  }
  if (source.accountKey && source.listId) {
    const binding = getXListBinding(database, source.accountKey, source.listId);
    if (binding?.name) return binding.name;
    return `${source.accountKey} / ${source.listId}`;
  }
  return source.sourceId;
}

async function reportChannelScanProgress(
  dependency: AgentTaskMutationDependency,
  database: DatabaseSync,
  taskId: string,
  planned: number,
  stored: FrozenDailyChannels,
  commandContext: (requestId: string, taskId?: string) => { actor: { type: 'scheduler'; id: string; label: string }; requestId: string; taskId?: string; workerLeaseId?: string },
  input: { phase?: string; currentSource?: string; message: string }
): Promise<void> {
  const current = getAgentTask(database, taskId);
  if (!current || current.status !== 'running') return;
  const aggregation = readDailyReceiptAggregation(database, current);
  const failed = aggregation.receipts.filter((receipt) => receipt.status !== 'succeeded').length + aggregation.missingReceiptCount;
  const saved = aggregation.receipts.reduce((total, receipt) => total + receipt.savedCount, 0);
  await dispatchReportAgentTaskProgress(dependency, taskId, {
    phase: input.phase ?? 'scanning_sources',
    progress: {
      planned,
      processed: aggregation.receipts.length,
      failed,
      saved,
      ...(input.currentSource ? { currentSource: input.currentSource } : {})
    },
    checkpoint: {
      intelligenceChannels: stored,
      channelReceiptIds: aggregation.receipts.map((receipt) => receipt.id)
    },
    message: input.message
  }, commandContext(`${taskId}:progress:channel-tick:${aggregation.receipts.length}:${Date.now()}`, taskId));
}

function sourceIsReady(database: DatabaseSync, source: FrozenDailyChannelSource, browserConfig: XListBrowserConfig | null): boolean {
  if (source.module === 'official_web') {
    const row = database.prepare('SELECT enabled, revision, resolution_status AS status FROM website_sources WHERE id=?').get(source.sourceId) as { enabled: number; revision: number; status: string } | undefined;
    return Boolean(row && row.enabled && row.revision === source.revision && row.status === 'ready');
  }
  const row = source.accountKey && source.listId ? getXListBinding(database, source.accountKey, source.listId) : null;
  return Boolean(browserConfig && row?.enabled && row.id === source.sourceId && row.revision === source.revision);
}

async function recordBlockedReceipt(dependency: AgentTaskMutationDependency, database: DatabaseSync, taskId: string, workspaceId: string, source: FrozenDailyChannelSource, workerLeaseId?: string): Promise<void> {
  await dispatchSourceFailureReceipt(dependency, database, taskId, workspaceId, source, 'needs_user', 'CHANNEL_SOURCE_NOT_READY', '来源当前未就绪，需要配置、登录或重新确认。', workerLeaseId);
}

/** WMB-5137：X 浏览器预检失败（非用户态异常）的渠道级 failed 回执——含渠道标识（行内 module/sourceId）与原因。 */
async function recordPreflightFailure(dependency: AgentTaskMutationDependency, database: DatabaseSync, taskId: string, workspaceId: string, source: FrozenDailyChannelSource, preflightError: { code: string; message: string }, workerLeaseId?: string): Promise<void> {
  await dispatchSourceFailureReceipt(dependency, database, taskId, workspaceId, source, 'failed', preflightError.code, `X 浏览器预检失败：${preflightError.message}`, workerLeaseId);
}

async function recordAttemptFailure(dependency: AgentTaskMutationDependency, database: DatabaseSync, taskId: string, workspaceId: string, source: FrozenDailyChannelSource, error: unknown, workerLeaseId?: string): Promise<void> {
  await dispatchSourceFailureReceipt(dependency, database, taskId, workspaceId, source, failureStatus(error), errorCode(error), errorMessage(error), workerLeaseId);
}

async function dispatchSourceFailureReceipt(dependency: AgentTaskMutationDependency, database: DatabaseSync, taskId: string, workspaceId: string, source: FrozenDailyChannelSource, status: SourceScanStatus, code: string, message: string, workerLeaseId?: string): Promise<void> {
  const write = () => recordSourceScanReceipt(database, { taskId, workspaceId, module: source.module, sourceId: source.sourceId, sourceFeedId: source.sourceFeedId, status, errorCode: code, errorMessage: message });
  if (!('database' in dependency)) { write(); return; }
  const receipt = await dispatchBusinessCommand(dependency, {
    command: 'intelligence_channels.scan_failed', requestId: `${taskId}:channel:${source.module}:${source.sourceId}:${source.revision}:${code}`,
    actor: { type: 'scheduler', id: 'daily-intelligence', label: 'daily-intelligence' }, input: { taskId, workspaceId, source, status, code, message },
    boundIdentity: { workspaceId, sourceId: source.sourceId, revision: source.revision }, taskId, workerLeaseId, causation: { taskId }, entityType: 'source_scan_receipt',
    execute: () => ({ data: write() })
  });
  requireReceiptData(receipt);
}

async function scanXList(dependency: AgentTaskMutationDependency, database: DatabaseSync, taskId: string, workerLeaseId: string | undefined, workspaceId: string, source: FrozenDailyChannelSource, selectedBindingIds: string[], browserConfig: XListBrowserConfig | null, collectX: XCollect): Promise<void> {
  if (!source.accountKey || !source.listId || !browserConfig) return recordBlockedReceipt(dependency, database, taskId, workspaceId, source, workerLeaseId);
  const config = { id: browserConfig.id, cdpUrl: browserConfig.cdpUrl, workspaceId, accountKey: source.accountKey };
  const collectInput = { accountKey: source.accountKey, listId: source.listId, expectedBindingId: source.sourceId, expectedRevision: source.revision };
  if (!('database' in dependency) || collectX !== collectBoundXListTimeline) {
    const result = await collectX(database, config, collectInput);
    if (!result.ok) return recordAttemptFailure(dependency, database, taskId, workspaceId, source, Object.assign(new Error(result.error.message), { code: result.error.code }), workerLeaseId);
    await dispatchScheduleXObservationCapture(dependency, config, { requestId: `daily:${taskId}`, selectedBindingIds, binding: result.data.binding, capturedAt: result.data.capturedAt, sourceIds: result.data.sourceIds, snapshotIds: result.data.snapshotIds }, taskId, workerLeaseId);
    recordSourceScanReceipt(database, { taskId, workspaceId, module: 'x_lists', sourceId: source.sourceId, sourceFeedId: source.sourceFeedId, status: 'succeeded', candidateCount: result.data.candidateCount, savedCount: result.data.sourceIds.length });
    return;
  }
  const read = await readBoundXListTimeline(database, config, collectInput);
  if (!read.ok) {
    const receipt = await dispatchBusinessCommand(dependency, {
      command: 'intelligence_channels.x_scan_failed', requestId: `${taskId}:x-list:${source.sourceId}:${source.revision}:failed`,
      actor: { type: 'scheduler', id: 'daily-intelligence', label: 'daily-intelligence' }, input: { taskId, workspaceId, source, error: read.error },
      boundIdentity: { workspaceId, sourceId: source.sourceId, revision: source.revision }, taskId, workerLeaseId,
      causation: { taskId }, entityType: 'source_scan_receipt', execute: (commandDatabase, value) => ({ data: recordSourceScanReceipt(commandDatabase, {
        taskId: value.taskId, workspaceId: value.workspaceId, module: 'x_lists', sourceId: value.source.sourceId, sourceFeedId: value.source.sourceFeedId,
        status: failureStatus(value.error), errorCode: value.error.code, errorMessage: value.error.message
      }) })
    });
    requireReceiptData(receipt);
    return;
  }
  const receipt = await dispatchBusinessCommand(dependency, {
    command: 'intelligence_channels.x_scan_commit', requestId: `${taskId}:x-list:${source.sourceId}:${source.revision}:commit`,
    actor: { type: 'scheduler', id: 'daily-intelligence', label: 'daily-intelligence' }, input: { taskId, workspaceId, source, selectedBindingIds, read },
    boundIdentity: { workspaceId, sourceId: source.sourceId, revision: source.revision }, taskId, workerLeaseId,
    causation: { taskId }, entityType: 'x_list_binding', execute: (commandDatabase, value) => {
      const result = persistBoundXListTimeline(commandDatabase, config, collectInput, value.read.data);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
      scheduleXObservationCapture(commandDatabase, config, { requestId: `daily:${taskId}`, selectedBindingIds: value.selectedBindingIds, binding: result.data.binding, capturedAt: result.data.capturedAt, sourceIds: result.data.sourceIds, snapshotIds: result.data.snapshotIds });
      recordSourceScanReceipt(commandDatabase, { taskId, workspaceId, module: 'x_lists', sourceId: source.sourceId, sourceFeedId: source.sourceFeedId, status: 'succeeded', candidateCount: result.data.candidateCount, savedCount: result.data.sourceIds.length });
      return { data: result.data, entityId: result.data.binding.id };
    }
  });
  requireReceiptData(receipt);
}

async function finishBlocked(
  dependency: AgentTaskMutationDependency,
  context: (requestId: string, taskId?: string) => { actor: { type: 'scheduler'; id: string; label: string }; requestId: string; taskId?: string; workerLeaseId?: string },
  task: AgentTask, frozen: FrozenDailyChannels, code: string, message: string,
  aggregation: DailyReceiptAggregation | null = null, reused = false
): Promise<DailyChannelRun> {
  const waiting = await dispatchNeedsUserAgentTask(dependency, task.id, code, message, context(`${task.id}:needs-user:${code}`, task.id));
  return { task: waiting, reused, shouldRunJudgment: false, frozen, aggregation };
}

function failureStatus(error: unknown): SourceScanStatus {
  return BROWSER_NEEDS_USER_CODES[errorCode(error)] ? 'needs_user' : 'failed';
}
function errorCode(error: unknown): string { return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'CHANNEL_SCAN_FAILED'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
