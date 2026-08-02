import type { DatabaseSync } from 'node:sqlite';
import {
  failAgentTask,
  getAgentTask,
  getReusableNeedsUserAgentTask,
  needsUserAgentTask,
  readDailyReceiptAggregation,
  reportAgentTaskProgress,
  startAgentTask,
  type AgentTask,
  type DailyReceiptAggregation
} from './agent-tasks.ts';
import { readBrowserConfig, type BrowserConfig } from './browser.ts';
import {
  readIntelligenceChannelsSummary,
  recordSourceScanReceipt,
  type IntelligenceChannelSource,
  type IntelligenceModule,
  type SourceScanStatus
} from './intelligence-channels.ts';
import { scanWebsiteSource } from './website-channel.ts';
import { collectBoundXListTimeline } from './x-list-execution.ts';
import { getXListBinding } from './x-lists.ts';

export type DailyChannelInput = {
  businessDate: string;
  workspaceId: string;
  profileRevision: number;
  modules?: IntelligenceModule[];
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

export async function startDailyChannelRun(database: DatabaseSync, input: DailyChannelInput, dependencies: {
  browserConfig?: BrowserConfig | null;
  websiteFetch?: typeof fetch;
  scanWebsite?: WebsiteScan;
  collectX?: XCollect;
} = {}): Promise<DailyChannelRun> {
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

  const started = startAgentTask(database, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs, piSessionId: `daily-${input.businessDate}` });
  if (!started.ok) throw new Error(started.error.message);
  const task = started.data;
  const stored = readFrozenChannels(task) ?? frozen;
  if (stored.workspaceId !== input.workspaceId || stored.profileRevision !== input.profileRevision) {
    const failed = failAgentTask(database, task.id, 'CHANNEL_CONTEXT_STALE', '工作空间或配方已变化，不能继续旧的每日情报任务。');
    if (!failed.ok) throw new Error(failed.error.message);
    return { task: failed.data, reused: started.reused === true, shouldRunJudgment: false, frozen: stored, aggregation: null };
  }
  if (started.reused && task.phase !== 'resume_pending') {
    return { task, reused: true, shouldRunJudgment: false, frozen: stored, aggregation: readDailyReceiptAggregation(database, task) };
  }

  const selected = stored.sources;
  const existingReceipts = readDailyReceiptAggregation(database, task).receipts;
  const checked = new Set(existingReceipts.map((receipt) => `${receipt.module}:${receipt.sourceId}`));
  const pending = selected.filter((source) => !checked.has(`${source.module}:${source.sourceId}`));
  const live = pending.filter((source) => sourceIsReady(database, source, dependencies.browserConfig ?? readBrowserConfig(database)));
  const blocked = pending.filter((source) => !live.includes(source));
  reportAgentTaskProgress(database, task.id, {
    phase: 'channel_preflight',
    progress: { planned: selected.length, processed: existingReceipts.length, failed: existingReceipts.filter((receipt) => receipt.status !== 'succeeded').length },
    checkpoint: { intelligenceChannels: stored },
    message: `已冻结 ${selected.length} 个情报来源，待检查 ${pending.length} 个。`
  });
  if (!selected.length) return finishBlocked(database, task, stored, 'CHANNELS_NOT_CONFIGURED', '当前工作空间没有启用的官网或 X List。', null, started.reused === true);

  for (const source of blocked) recordBlockedReceipt(database, task.id, stored.workspaceId, source);

  const scanWebsite = dependencies.scanWebsite ?? scanWebsiteSource;
  const collectX = dependencies.collectX ?? collectBoundXListTimeline;
  const websites = live.filter((source) => source.module === 'official_web');
  await Promise.all(websites.map(async (source) => {
    try {
      await scanWebsite(database, { taskId: task.id, workspaceId: stored.workspaceId, sourceId: source.sourceId, fetchImpl: dependencies.websiteFetch });
    } catch (error) {
      recordAttemptFailure(database, task.id, stored.workspaceId, source, error);
    }
  }));

  const browserConfig = dependencies.browserConfig ?? readBrowserConfig(database);
  for (const source of live.filter((item) => item.module === 'x_lists')) {
    try {
      await scanXList(database, task.id, stored.workspaceId, source, browserConfig, collectX);
    } catch (error) {
      recordAttemptFailure(database, task.id, stored.workspaceId, source, error);
    }
  }

  const current = getAgentTask(database, task.id);
  if (!current || current.status !== 'running') {
    return { task: current ?? task, reused: started.reused === true, shouldRunJudgment: false, frozen: stored, aggregation: current ? readDailyReceiptAggregation(database, current) : null };
  }
  const aggregation = readDailyReceiptAggregation(database, current);
  const failed = aggregation.receipts.filter((receipt) => receipt.status !== 'succeeded').length + aggregation.missingReceiptCount;
  const saved = aggregation.receipts.reduce((total, receipt) => total + receipt.savedCount, 0);
  reportAgentTaskProgress(database, current.id, {
    phase: 'channel_scanned',
    progress: { planned: selected.length, processed: aggregation.receipts.length, failed, saved },
    checkpoint: { intelligenceChannels: stored, channelReceiptIds: aggregation.receipts.map((receipt) => receipt.id) },
    message: `来源检查完成：${aggregation.receipts.length}/${selected.length}，保存 ${saved} 条资料。`
  });
  if (aggregation.status === 'needs_user') return finishBlocked(database, current, stored, 'CHANNELS_NEEDS_USER', '全部已选情报来源需要用户处理。', aggregation, started.reused === true);
  if (aggregation.status === 'failed') {
    const failedTask = failAgentTask(database, current.id, 'CHANNEL_SCAN_FAILED', '没有可信的来源检查回执。');
    if (!failedTask.ok) throw new Error(failedTask.error.message);
    return { task: failedTask.data, reused: started.reused === true, shouldRunJudgment: false, frozen: stored, aggregation };
  }
  const ready = getAgentTask(database, current.id);
  if (!ready) throw new Error('每日情报任务读取失败。');
  return { task: ready, reused: started.reused === true, shouldRunJudgment: true, frozen: stored, aggregation };
}

function freezeChannels(sources: IntelligenceChannelSource[], input: DailyChannelInput): FrozenDailyChannels {
  const modules = [...new Set(input.modules ?? ['official_web', 'x_lists'])].filter((module): module is IntelligenceModule => module === 'official_web' || module === 'x_lists');
  return {
    workspaceId: input.workspaceId,
    profileRevision: input.profileRevision,
    modules,
    sources: sources.filter((source) => source.enabled && modules.includes(source.module)).map((source) => ({
      module: source.module, sourceId: source.sourceId, sourceFeedId: source.sourceFeedId, revision: source.revision,
      ...(source.accountKey ? { accountKey: source.accountKey } : {}), ...(source.listId ? { listId: source.listId } : {})
    }))
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

function sourceIsReady(database: DatabaseSync, source: FrozenDailyChannelSource, browserConfig: BrowserConfig | null): boolean {
  if (source.module === 'official_web') {
    const row = database.prepare('SELECT enabled, revision, resolution_status AS status FROM website_sources WHERE id=?').get(source.sourceId) as { enabled: number; revision: number; status: string } | undefined;
    return Boolean(row && row.enabled && row.revision === source.revision && row.status === 'ready');
  }
  const row = source.accountKey && source.listId ? getXListBinding(database, source.accountKey, source.listId) : null;
  return Boolean(browserConfig && row?.enabled && row.id === source.sourceId && row.revision === source.revision);
}

function recordBlockedReceipt(database: DatabaseSync, taskId: string, workspaceId: string, source: FrozenDailyChannelSource): void {
  try {
    recordSourceScanReceipt(database, {
      taskId, workspaceId, module: source.module, sourceId: source.sourceId, sourceFeedId: source.sourceFeedId,
      status: 'needs_user', errorCode: 'CHANNEL_SOURCE_NOT_READY', errorMessage: '来源当前未就绪，需要配置、登录或重新确认。'
    });
  } catch {}
}

function recordAttemptFailure(database: DatabaseSync, taskId: string, workspaceId: string, source: FrozenDailyChannelSource, error: unknown): void {
  try {
    recordSourceScanReceipt(database, {
      taskId, workspaceId, module: source.module, sourceId: source.sourceId, sourceFeedId: source.sourceFeedId,
      status: failureStatus(error), errorCode: errorCode(error), errorMessage: errorMessage(error)
    });
  } catch {}
}

async function scanXList(database: DatabaseSync, taskId: string, workspaceId: string, source: FrozenDailyChannelSource, browserConfig: BrowserConfig | null, collectX: XCollect): Promise<void> {
  if (!source.accountKey || !source.listId || !browserConfig) return recordBlockedReceipt(database, taskId, workspaceId, source);
  const result = await collectX(database, { id: browserConfig.id, cdpUrl: browserConfig.cdpUrl, workspaceId, accountKey: source.accountKey }, {
    accountKey: source.accountKey, listId: source.listId, expectedBindingId: source.sourceId, expectedRevision: source.revision
  });
  if (!result.ok) return recordAttemptFailure(database, taskId, workspaceId, source, Object.assign(new Error(result.error.message), { code: result.error.code }));
  recordSourceScanReceipt(database, {
    taskId, workspaceId, module: 'x_lists', sourceId: source.sourceId, sourceFeedId: source.sourceFeedId,
    status: 'succeeded', candidateCount: result.data.candidateCount, savedCount: result.data.sourceIds.length
  });
}

function finishBlocked(database: DatabaseSync, task: AgentTask, frozen: FrozenDailyChannels, code: string, message: string, aggregation: DailyReceiptAggregation | null = null, reused = false): DailyChannelRun {
  const waiting = needsUserAgentTask(database, task.id, code, message);
  if (!waiting.ok) throw new Error(waiting.error.message);
  return { task: waiting.data, reused, shouldRunJudgment: false, frozen, aggregation };
}

function failureStatus(error: unknown): SourceScanStatus {
  const code = errorCode(error);
  return code === 'BROWSER_NEEDS_USER' || code === 'ACCOUNT_MISMATCH' ? 'needs_user' : 'failed';
}
function errorCode(error: unknown): string { return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'CHANNEL_SCAN_FAILED'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
