import { randomUUID } from 'node:crypto';
import { dispatchBusinessCommand, requireCommandResultData, requireReceiptData } from './business-command.ts';
import {
  readIntelligenceChannelsSummary,
  recordSourceScanReceipt,
  type IntelligenceChannelSource,
  type IntelligenceModule,
  type SourceScanReceipt
} from './intelligence-channels.ts';
import type { ZhihuHotRead } from './zhihu-hot-channel.ts';
import { commitZhihuHotScan, ZHIHU_HOT_URL } from './zhihu-hot-channel.ts';
import {
  persistBoundXListTimeline,
  type BoundXListTimelineCollection,
  type BoundXListTimelineRead,
  type CollectBoundXListTimelineInput
} from './x-list-execution.ts';
import type { XListBrowserConfig } from './platforms/x-list-primitives.ts';
import type { CommandResult } from './result.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import type { XListBinding } from './x-lists.ts';
import { ensureRegistrySourceFeed } from './sources.ts';
import { scheduleSourceKnowledgeCompile } from './knowledge-compile-trigger.ts';
import {
  persistWebsiteSourceScan,
  type ScanWebsiteSourceInput,
  type WebsiteScanResult,
  type WebsiteSourceScanRead
} from './website-channel.ts';

const owner = Object.freeze({ type: 'owner_ui' as const, id: 'renderer', label: 'Owner UI' });

type ChannelInput = { module: IntelligenceModule; sourceId: string; expectedRevision: number };
type XChannelScanResult = { source: IntelligenceChannelSource | XListBinding; receipt: SourceScanReceipt; sourceIds: string[] };
type XChannelPreflightResult = { source: IntelligenceChannelSource; receipt: SourceScanReceipt; sourceIds: string[] };
type ChannelValidationFailureInput = { channel: ChannelInput; failure: { code: string; message: string } };

export async function dispatchPersistWebsiteChannelScan(
  runtime: ActiveWorkspaceRuntime,
  input: ChannelInput,
  taskId: string,
  read: WebsiteSourceScanRead
): Promise<WebsiteScanResult> {
  const scanInput: ScanWebsiteSourceInput = { taskId, workspaceId: runtime.identity.workspaceId, sourceId: input.sourceId };
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'intelligence_channels.scan', requestId: randomUUID(), actor: owner,
    input: { channel: input, scanInput, read },
    boundIdentity: { module: input.module, sourceId: input.sourceId, revision: input.expectedRevision },
    entityType: 'intelligence_channel_source',
    execute: (database, value) => {
      const source = requireSource(database, value.channel);
      if (source.module !== 'official_web' || value.read.original.id !== source.sourceId || value.read.original.revision !== source.revision) {
        throw Object.assign(new Error('来源已变化，请重新加载。'), { code: 'REVISION_CONFLICT' });
      }
      const result = persistWebsiteSourceScan(database, value.scanInput, value.read);
      return { data: result, entityId: result.source.id, beforeRevision: source.revision, afterRevision: result.source.revision, readback: result };
    }
  });
  return requireReceiptData(receipt);
}
export async function dispatchZhihuHotScan(
  runtime: ActiveWorkspaceRuntime,
  input: ChannelInput,
  taskId: string,
  read: ZhihuHotRead
): Promise<{ source: IntelligenceChannelSource; receipt: SourceScanReceipt; sourceIds: string[] }> {
  const businessDate = new Date().toISOString().slice(0, 10);
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'intelligence.zhihu_hot.scan',
    requestId: `${taskId}:zhihu_hot:${input.sourceId}:${read.collectedAt}`,
    actor: owner,
    input: { channel: input, taskId, workspaceId: runtime.identity.workspaceId, businessDate, read },
    boundIdentity: { workspaceId: runtime.identity.workspaceId, sourceId: input.sourceId },
    taskId,
    entityType: 'source_item',
    execute: (database, value) => {
      const source = requireSource(database, value.channel);
      if (source.module !== 'zhihu_hot') throw Object.assign(new Error('来源不匹配。'), { code: 'VALIDATION_ERROR' });
      const result = commitZhihuHotScan(database, { taskId: value.taskId, workspaceId: value.workspaceId, businessDate: value.businessDate }, value.read as ZhihuHotRead);
      const rec = recordSourceScanReceipt(database, { taskId: value.taskId, workspaceId: value.workspaceId, module: 'zhihu_hot', sourceId: value.channel.sourceId, sourceFeedId: result.feedId, status: 'succeeded', candidateCount: result.candidateCount, savedCount: result.savedCount });
      return { data: { source, receipt: rec, sourceIds: result.sourceIds }, entityId: source.sourceId };
    }
  });
  const data = requireReceiptData(receipt);
  for (const sourceId of data.sourceIds) {
    const row = runtime.database.prepare('SELECT revision FROM source_items WHERE id=?').get(sourceId) as { revision: number } | undefined;
    if (row) scheduleSourceKnowledgeCompile({ sourceId, revision: row.revision });
  }
  return data;
}
export async function dispatchZhihuHotFailure(
  runtime: ActiveWorkspaceRuntime,
  input: ChannelInput,
  taskId: string,
  error: unknown
): Promise<{ source: IntelligenceChannelSource; receipt: SourceScanReceipt; sourceIds: string[] }> {
  const code = errorCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const status = (code === 'ZHIHU_HOT_NEEDS_USER' || code === 'ZHIHU_HOT_CHALLENGE' || code === 'BROWSER_NEEDS_USER') ? 'needs_user' as const : 'failed' as const;
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'intelligence.zhihu_hot.scan',
    requestId: `${taskId}:zhihu_hot:${input.sourceId}:failed:${code}`,
    actor: owner,
    input: { channel: input, taskId, error: { code, message } },
    boundIdentity: { workspaceId: runtime.identity.workspaceId, sourceId: input.sourceId },
    taskId,
    entityType: 'source_item',
    execute: (database, value) => {
      const source = requireSource(database, value.channel);
      const feedId = (() => {
        try {
          const row = database.prepare("SELECT id FROM source_feeds WHERE registry_id='zhihu_hot'").get() as { id?: string } | undefined;
          if (row?.id) return row.id;
        } catch {}
        return ensureRegistrySourceFeed(database, { registryId: 'zhihu_hot', name: '知乎 AI 专题', url: ZHIHU_HOT_URL }).id;
      })();
      const rec = recordSourceScanReceipt(database, { taskId: value.taskId, workspaceId: runtime.identity.workspaceId, module: 'zhihu_hot', sourceId: value.channel.sourceId, sourceFeedId: feedId, status, errorCode: code, errorMessage: message, candidateCount: 0, savedCount: 0 });
      return { data: { source, receipt: rec, sourceIds: [] }, entityId: source.sourceId };
    }
  });
  return requireReceiptData(receipt);
}


export async function dispatchPersistXChannelScan(
  runtime: ActiveWorkspaceRuntime,
  config: XListBrowserConfig,
  input: ChannelInput,
  taskId: string,
  collectInput: CollectBoundXListTimelineInput,
  readResult: CommandResult<BoundXListTimelineRead>
): Promise<XChannelScanResult> {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'intelligence_channels.scan', requestId: randomUUID(), actor: owner,
    input: { channel: input, taskId, collectInput, readResult },
    boundIdentity: { module: input.module, sourceId: input.sourceId, revision: input.expectedRevision, accountKey: collectInput.accountKey, listId: collectInput.listId },
    entityType: 'intelligence_channel_source',
    execute: (database, value) => {
      const source = requireSource(database, value.channel);
      if (source.module !== 'x_lists' || !source.accountKey || !source.listId) {
        throw Object.assign(new Error('X List 来源身份不完整。'), { code: 'VALIDATION_ERROR' });
      }
      const collected: CommandResult<BoundXListTimelineCollection> = value.readResult.ok
        ? persistBoundXListTimeline(database, config, value.collectInput, value.readResult.data)
        : value.readResult;
      if (!collected.ok) {
        const scanReceipt = recordSourceScanReceipt(database, {
          taskId: value.taskId, workspaceId: runtime.identity.workspaceId, module: 'x_lists', sourceId: source.sourceId,
          sourceFeedId: source.sourceFeedId,
          status: collected.error.code === 'BROWSER_NEEDS_USER' || collected.error.code === 'ACCOUNT_MISMATCH' ? 'needs_user' : 'failed',
          errorCode: collected.error.code, errorMessage: collected.error.message
        });
        const data: XChannelScanResult = { source, receipt: scanReceipt, sourceIds: [] };
        return { data, entityId: source.sourceId, beforeRevision: source.revision, afterRevision: source.revision, readback: data };
      }
      const result = requireCommandResultData(collected);
      const scanReceipt = recordSourceScanReceipt(database, {
        taskId: value.taskId, workspaceId: runtime.identity.workspaceId, module: 'x_lists', sourceId: source.sourceId,
        sourceFeedId: source.sourceFeedId, status: 'succeeded', candidateCount: result.candidateCount, savedCount: result.sourceIds.length
      });
      const data: XChannelScanResult = { source: result.binding, receipt: scanReceipt, sourceIds: result.sourceIds };
      return { data, entityId: source.sourceId, beforeRevision: source.revision, afterRevision: result.binding.revision, readback: data };
    }
  });
  return requireReceiptData(receipt);
}

export async function dispatchRecordXChannelPreflightFailure(
  runtime: ActiveWorkspaceRuntime,
  input: ChannelInput,
  taskId: string,
  error: unknown
): Promise<XChannelPreflightResult> {
  const failure = { code: errorCodeOf(error), message: error instanceof Error ? error.message : String(error) };
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'intelligence_channels.scan', requestId: randomUUID(), actor: owner,
    input: { channel: input, taskId, failure },
    boundIdentity: { module: input.module, sourceId: input.sourceId, revision: input.expectedRevision },
    entityType: 'intelligence_channel_source',
    execute: (database, value) => {
      const source = requireSource(database, value.channel);
      if (source.module !== 'x_lists') throw Object.assign(new Error('X List 来源不存在。'), { code: 'NOT_FOUND' });
      const scanReceipt = recordSourceScanReceipt(database, {
        taskId: value.taskId, workspaceId: runtime.identity.workspaceId, module: source.module,
        sourceId: source.sourceId, sourceFeedId: source.sourceFeedId, status: 'needs_user',
        errorCode: value.failure.code, errorMessage: value.failure.message
      });
      const data: XChannelPreflightResult = { source, receipt: scanReceipt, sourceIds: [] };
      return { data, entityId: source.sourceId, beforeRevision: source.revision, afterRevision: source.revision, readback: data };
    }
  });
  return requireReceiptData(receipt);
}

function requireSource(database: ActiveWorkspaceRuntime['database'], input: ChannelInput): IntelligenceChannelSource {
  const source = readIntelligenceChannelsSummary(database).sources.find((item) => item.module === input.module && item.sourceId === input.sourceId);
  if (!source) throw Object.assign(new Error('情报来源不存在。'), { code: 'NOT_FOUND' });
  if (source.revision !== input.expectedRevision) throw Object.assign(new Error('来源已变化，请重新加载。'), { code: 'REVISION_CONFLICT' });
  if (!source.enabled) throw Object.assign(new Error('请先启用该来源再扫描。'), { code: 'INVALID_STATE' });
  return source;
}

export async function dispatchChannelValidationFailure(runtime: ActiveWorkspaceRuntime, input: ChannelInput, error: unknown): Promise<never> {
  const failure = { code: errorCodeOf(error), message: error instanceof Error ? error.message : String(error) };
  const receipt = await dispatchBusinessCommand<ChannelValidationFailureInput, never>(runtime, {
    command: 'intelligence_channels.scan', requestId: randomUUID(), actor: owner,
    input: { channel: input, failure },
    boundIdentity: { module: input.module, sourceId: input.sourceId, revision: input.expectedRevision },
    entityType: 'intelligence_channel_source',
    execute: () => { throw Object.assign(new Error(failure.message), { code: failure.code }); }
  });
  return requireReceiptData<never>(receipt);
}

function errorCodeOf(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return 'BROWSER_NEEDS_USER';
  return error.code;
}
