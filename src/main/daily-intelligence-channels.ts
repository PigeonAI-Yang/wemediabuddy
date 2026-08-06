import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  getAgentTask,
  getReusableNeedsUserAgentTask,
  readDailyReceiptAggregation,
  type AgentTask,
  type DailyReceiptAggregation
} from './agent-tasks.ts';
import {
  dispatchFailAgentTask,
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
};

type XCollect = typeof collectBoundXListTimeline;
type WebsiteScan = typeof scanWebsiteSource;
const BROWSER_NEEDS_USER_CODES: Record<string, true> = {
  BROWSER_NEEDS_USER: true,
  ACCOUNT_MISMATCH: true,
  BROWSER_PROFILE_MISMATCH: true,
  PROFILE_STALE: true
};

export async function startDailyChannelRun(dependency: AgentTaskMutationDependency, input: DailyChannelInput, dependencies: {
  browserConfig?: XListBrowserConfig | null;
  websiteFetch?: typeof fetch;
  scanWebsite?: WebsiteScan;
  collectX?: XCollect;
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
  const provisional = preflightCode(frozen, summary.sources);
  if (provisional) {
    const reusable = getReusableNeedsUserAgentTask(database, 'daily_intelligence', input.businessDate, contextRefs, provisional.code);
    if (reusable) return { task: reusable, reused: true, shouldRunJudgment: false, frozen: readFrozenChannels(reusable) ?? frozen, aggregation: null };
  }

  // requestId must be unique per click: frozen channel revisions change between runs.
  const startRequestId = `daily_intelligence:${input.businessDate}:${input.workspaceId}:channels:start:${randomUUID()}`;
  const started = await dispatchStartAgentTask(dependency, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs }, commandContext(startRequestId));
  const task = started.task;
  const stored = readFrozenChannels(task) ?? frozen;
  if (stored.workspaceId !== input.workspaceId || stored.profileRevision !== input.profileRevision) {
    const failed = await dispatchFailAgentTask(dependency, task.id, 'CHANNEL_CONTEXT_STALE', '工作空间或配方已变化，不能继续旧的每日情报任务。', commandContext(`${task.id}:channels:context-stale`, task.id));
    return { task: failed, reused: started.reused, shouldRunJudgment: false, frozen: stored, aggregation: null };
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
  }, commandContext(`${task.id}:progress:starting`, task.id));

  const browserConfig = await resolveBrowserConfig(database, stored, dependencies.browserConfig);
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
  }, commandContext(`${task.id}:progress:channel-preflight`, task.id));
  if (!selected.length) return finishBlocked(dependency, commandContext, task, stored, 'CHANNELS_NOT_CONFIGURED', '当前工作空间没有启用的官网或 X List。', null, started.reused);

  for (const source of blocked) await recordBlockedReceipt(dependency, database, task.id, stored.workspaceId, source, input.workerLeaseId);

  const scanWebsite = dependencies.scanWebsite ?? scanWebsiteSource;
  const collectX = dependencies.collectX ?? collectBoundXListTimeline;
  const websites = live.filter((source) => source.module === 'official_web');
  await Promise.all(websites.map(async (source) => {
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
  }));
  // The profile was resolved from this root's verified binding before any X scan.
  const selectedXBindingIds = selected.filter((item) => item.module === 'x_lists').map((item) => item.sourceId);
  for (const source of live.filter((item) => item.module === 'x_lists')) {
    try {
      await scanXList(dependency, database, task.id, input.workerLeaseId, stored.workspaceId, source, selectedXBindingIds, browserConfig, collectX);
    } catch (error) {
      await recordAttemptFailure(dependency, database, task.id, stored.workspaceId, source, error, input.workerLeaseId);
    }
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
  }, commandContext(`${current.id}:progress:channel-scanned`, current.id));
  if (aggregation.status === 'needs_user') return finishBlocked(dependency, commandContext, current, stored, 'CHANNELS_NEEDS_USER', '全部已选情报来源需要用户处理。', aggregation, started.reused);
  if (aggregation.status === 'failed') {
    const failedTask = await dispatchFailAgentTask(dependency, current.id, 'CHANNEL_SCAN_FAILED', '没有可信的来源检查回执。', commandContext(`${current.id}:fail:channel-scan`, current.id));
    return { task: failedTask, reused: started.reused, shouldRunJudgment: false, frozen: stored, aggregation };
  }
  const ready = getAgentTask(database, current.id);
  if (!ready) throw new Error('每日情报任务读取失败。');
  return { task: ready, reused: started.reused === true, shouldRunJudgment: true, frozen: stored, aggregation };

}
async function resolveBrowserConfig(database: DatabaseSync, frozen: FrozenDailyChannels, configured: XListBrowserConfig | null | undefined): Promise<XListBrowserConfig | null> {
  if (configured !== undefined) return configured;
  if (!frozen.sources.some((source) => source.module === 'x_lists')) return null;
  try { return await selectedXListBrowser(database); }
  catch (error) {
    if (BROWSER_NEEDS_USER_CODES[errorCode(error)]) return null;
    throw error;
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

function preflightCode(frozen: FrozenDailyChannels, sources: IntelligenceChannelSource[]): { code: string } | null {
  if (!frozen.sources.length) return { code: 'CHANNELS_NOT_CONFIGURED' };
  return frozen.sources.some((source) => sources.some((item) => item.sourceId === source.sourceId && item.status === 'ready')) ? null : { code: 'CHANNELS_NEEDS_USER' };
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
