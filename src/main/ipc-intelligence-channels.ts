import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { DataRoot } from './data-root.ts';
import {
  listSourceScanReceipts,
  readIntelligenceChannelsSummary,
  type IntelligenceChannelSource,
  type IntelligenceModule
} from './intelligence-channels.ts';
import { currentXListContext } from './ipc-x-lists.ts';
import type { CurrentXListContext } from './x-list-context.ts';
import { resolveXListCandidates } from './x-list-channel.ts';
import { readBoundXListTimeline } from './x-list-execution.ts';
import { readWebsiteSourceScan, resolveWebsiteCandidates, trialReadWebsite } from './website-channel.ts';
import { readChannelProposalContext } from './intelligence-channel-confirmation.ts';
import { dispatchConfirmIntelligenceChannelProposal } from './intelligence-channel-command.ts';
import { IntelligenceChannelProposalStore, type ChannelProposalInput, type IntelligenceChannelProposalBinding } from './intelligence-channel-proposals.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import {
  dispatchChannelValidationFailure,
  dispatchPersistWebsiteChannelScan,
  dispatchPersistXChannelScan,
  dispatchRecordXChannelPreflightFailure
} from './intelligence-channel-business-command.ts';

type Dependencies = { loadSelectedDataRoot: () => Promise<DataRoot | null>; channelProposals: IntelligenceChannelProposalStore; getActiveRuntime: () => ActiveWorkspaceRuntime | null };
type ChannelInput = { module: IntelligenceModule; sourceId: string; expectedRevision: number };

export function registerIntelligenceChannelsIpc({ loadSelectedDataRoot, channelProposals, getActiveRuntime }: Dependencies): void {
  ipcMain.handle('intelligence-channels:get', async () => {
    const runtime = requiredRuntime(getActiveRuntime);
    return {
      summary: readIntelligenceChannelsSummary(runtime.database),
      receipts: listSourceScanReceipts(runtime.database, { workspaceId: runtime.identity.workspaceId, limit: 500 })
    };
  });
  ipcMain.handle('intelligence-channels:resolve-website', async (_event, input: { inputText: string }) => resolveWebsiteCandidates(input));
  ipcMain.handle('intelligence-channels:trial-website', async (_event, input: { url: string }) => trialReadWebsite(input));
  ipcMain.handle('intelligence-channels:resolve-x-list', async (_event, input: { inputText: string }) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime);
    return resolveXListCandidates(runtime.database, context.config, input, async () => context.index);
  });
  ipcMain.handle('intelligence-channels:scan-now', async (_event, input: ChannelInput) => scanNow(loadSelectedDataRoot, getActiveRuntime, input));
  ipcMain.handle('intelligence-channels:proposals-prepare', async (_event, input: ChannelProposalInput) => {
    const runtime = requiredRuntime(getActiveRuntime);
    return channelProposals.prepare(input, readChannelProposalContext(runtime.database));
  });
  ipcMain.handle('intelligence-channels:proposals-list', async () => {
    const runtime = requiredRuntime(getActiveRuntime);
    return channelProposals.listForContext(readChannelProposalContext(runtime.database));
  });
  ipcMain.handle('intelligence-channels:proposal-confirm', async (_event, binding: IntelligenceChannelProposalBinding) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const pending = channelProposals.get(binding?.proposalId ?? '');
    const xContext = pending?.changes.some((change) => change.module === 'x_lists')
      ? await currentXListContext(loadSelectedDataRoot, getActiveRuntime)
      : undefined;
    return dispatchConfirmIntelligenceChannelProposal(runtime, { store: channelProposals, binding, xContext });
  });
}

async function scanNow(
  loadSelectedDataRoot: Dependencies['loadSelectedDataRoot'],
  getActiveRuntime: Dependencies['getActiveRuntime'],
  input: ChannelInput
) {
  const runtime = requiredRuntime(getActiveRuntime);
  let source: IntelligenceChannelSource;
  try { source = sourceFor(runtime.database, input); }
  catch (error) { return dispatchChannelValidationFailure(runtime, input, error); }
  const taskId = manualTaskId();
  if (source.module === 'official_web') {
    const scanInput = { taskId, workspaceId: runtime.identity.workspaceId, sourceId: source.sourceId };
    const read = await readWebsiteSourceScan(runtime.database, scanInput);
    return dispatchPersistWebsiteChannelScan(runtime, input, taskId, read);
  }

  let context: CurrentXListContext;
  try { context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime); }
  catch (error) { return dispatchRecordXChannelPreflightFailure(runtime, input, taskId, error); }
  if (!source.accountKey || !source.listId) {
    return dispatchChannelValidationFailure(runtime, input, Object.assign(new Error('X List 来源身份不完整。'), { code: 'VALIDATION_ERROR' }));
  }
  const collectInput = {
    accountKey: source.accountKey, listId: source.listId,
    expectedBindingId: source.sourceId, expectedRevision: source.revision
  };
  const read = await readBoundXListTimeline(runtime.database, context.config, collectInput);
  return dispatchPersistXChannelScan(runtime, context.config, input, taskId, collectInput, read);
}

function sourceFor(database: ActiveWorkspaceRuntime['database'], input: ChannelInput): IntelligenceChannelSource {
  const source = readIntelligenceChannelsSummary(database).sources.find((item) => item.module === input.module && item.sourceId === input.sourceId);
  if (!source) throw Object.assign(new Error('情报来源不存在。'), { code: 'NOT_FOUND' });
  if (source.revision !== input.expectedRevision) throw Object.assign(new Error('来源已变化，请重新加载。'), { code: 'REVISION_CONFLICT' });
  if (!source.enabled) throw Object.assign(new Error('请先启用该来源再扫描。'), { code: 'INVALID_STATE' });
  return source;
}

function requiredRuntime(getActiveRuntime: Dependencies['getActiveRuntime']): ActiveWorkspaceRuntime {
  const runtime = getActiveRuntime();
  if (!runtime?.isActive) throw Object.assign(new Error('当前工作空间运行时不可用。'), { code: 'WORKSPACE_BUSY' });
  return runtime;
}

function manualTaskId(): string { return `manual-channel-scan-${randomUUID()}`; }
