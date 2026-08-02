import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import path from 'node:path';
import type { DataRoot } from './data-root.ts';
import { migrateDatabase } from './db/migrations.ts';
import {
  listSourceScanReceipts,
  readIntelligenceChannelsSummary,
  recordSourceScanReceipt,
  removeWebsiteSource,
  setWebsiteSourceEnabled,
  type IntelligenceChannelSource,
  type IntelligenceModule
} from './intelligence-channels.ts';
import { currentXListContext } from './ipc-x-lists.ts';
import { readXListIndex } from './platforms/x-list-browser.ts';
import { confirmResolvedXList, resolveXListCandidates, type XListCandidate, type XListResolution } from './x-list-channel.ts';
import { collectBoundXListTimeline } from './x-list-execution.ts';
import { setXListBindingEnabled } from './x-lists.ts';
import { confirmWebsiteSource, resolveWebsiteCandidates, scanWebsiteSource, trialReadWebsite, type WebsiteCandidate } from './website-channel.ts';
import type { WebsiteTrialRead } from './intelligence-channels.ts';

type Dependencies = { loadSelectedDataRoot: () => Promise<DataRoot | null> };
type ChannelInput = { module: IntelligenceModule; sourceId: string; expectedRevision: number };

export function registerIntelligenceChannelsIpc({ loadSelectedDataRoot }: Dependencies): void {
  ipcMain.handle('intelligence-channels:get', async () => withDatabase(loadSelectedDataRoot, (database) => {
    const workspaceId = workspaceIdOf(database);
    return { summary: readIntelligenceChannelsSummary(database), receipts: listSourceScanReceipts(database, { workspaceId, limit: 500 }) };
  }));
  ipcMain.handle('intelligence-channels:resolve-website', async (_event, input: { inputText: string }) => resolveWebsiteCandidates(input));
  ipcMain.handle('intelligence-channels:trial-website', async (_event, input: { url: string }) => trialReadWebsite(input));
  ipcMain.handle('intelligence-channels:confirm-website', async (_event, input: { inputText: string; candidate: WebsiteCandidate; trialRead: WebsiteTrialRead }) =>
    withDatabase(loadSelectedDataRoot, (database) => confirmWebsiteSource(database, input)));
  ipcMain.handle('intelligence-channels:resolve-x-list', async (_event, input: { inputText: string }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    const database = migrateDatabase(path.join(context.root.path, 'wmb.db'));
    try { return resolveXListCandidates(database, context.config, input, async () => context.index); }
    finally { database.close(); }
  });
  ipcMain.handle('intelligence-channels:confirm-x-list', async (_event, input: { resolution: XListResolution; candidate: XListCandidate }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    const database = migrateDatabase(path.join(context.root.path, 'wmb.db'));
    try { return confirmResolvedXList(database, context.config, input, readXListIndex); }
    finally { database.close(); }
  });
  ipcMain.handle('intelligence-channels:set-enabled', async (_event, input: ChannelInput & { enabled: boolean }) =>
    withDatabase(loadSelectedDataRoot, (database) => setEnabled(database, input)));
  ipcMain.handle('intelligence-channels:remove', async (_event, input: ChannelInput) =>
    withDatabase(loadSelectedDataRoot, (database) => removeSource(database, input)));
  ipcMain.handle('intelligence-channels:scan-now', async (_event, input: ChannelInput) => scanNow(loadSelectedDataRoot, input));
}

async function withDatabase<T>(loadSelectedDataRoot: Dependencies['loadSelectedDataRoot'], action: (database: ReturnType<typeof migrateDatabase>) => T): Promise<T> {
  const root = await requiredRoot(loadSelectedDataRoot);
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try { return action(database); } finally { database.close(); }
}

function setEnabled(database: ReturnType<typeof migrateDatabase>, input: ChannelInput & { enabled: boolean }) {
  const source = sourceFor(database, input);
  if (source.module === 'official_web') return setWebsiteSourceEnabled(database, { id: source.sourceId, enabled: input.enabled, expectedRevision: input.expectedRevision });
  if (!source.accountKey || !source.listId) throw new Error('X List 来源身份不完整。');
  const result = setXListBindingEnabled(database, { accountKey: source.accountKey, listId: source.listId, enabled: input.enabled, expectedRevision: input.expectedRevision });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data;
}

function removeSource(database: ReturnType<typeof migrateDatabase>, input: ChannelInput) {
  const source = sourceFor(database, input);
  if (source.module === 'official_web') return removeWebsiteSource(database, { id: source.sourceId, expectedRevision: input.expectedRevision });
  return setEnabled(database, { ...input, enabled: false });
}

async function scanNow(loadSelectedDataRoot: Dependencies['loadSelectedDataRoot'], input: ChannelInput) {
  const root = await requiredRoot(loadSelectedDataRoot);
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  let source: IntelligenceChannelSource;
  let workspaceId: string;
  try {
    source = sourceFor(database, input);
    workspaceId = workspaceIdOf(database);
    if (!source.enabled) throw new Error('请先启用该来源再扫描。');
    if (source.module === 'official_web') return await scanWebsiteSource(database, {
      taskId: manualTaskId(), workspaceId, sourceId: source.sourceId
    });
  } finally { database.close(); }

  let context: Awaited<ReturnType<typeof currentXListContext>>;
  try { context = await currentXListContext(loadSelectedDataRoot); }
  catch (error) { return recordXPreflightFailure(root, input, error); }
  const xDatabase = migrateDatabase(path.join(context.root.path, 'wmb.db'));
  try {
    source = sourceFor(xDatabase, input);
    workspaceId = workspaceIdOf(xDatabase);
    if (!source.accountKey || !source.listId) throw new Error('X List 来源身份不完整。');
    const taskId = manualTaskId();
    const result = await collectBoundXListTimeline(xDatabase, context.config, {
      accountKey: source.accountKey, listId: source.listId, expectedBindingId: source.sourceId, expectedRevision: source.revision
    });
    if (!result.ok) {
      const receipt = recordSourceScanReceipt(xDatabase, {
        taskId, workspaceId, module: 'x_lists', sourceId: source.sourceId, sourceFeedId: source.sourceFeedId,
        status: result.error.code === 'BROWSER_NEEDS_USER' || result.error.code === 'ACCOUNT_MISMATCH' ? 'needs_user' : 'failed',
        errorCode: result.error.code, errorMessage: result.error.message
      });
      return { source, receipt, sourceIds: [] };
    }
    const receipt = recordSourceScanReceipt(xDatabase, {
      taskId, workspaceId, module: 'x_lists', sourceId: source.sourceId, sourceFeedId: source.sourceFeedId,
      status: 'succeeded', candidateCount: result.data.candidateCount, savedCount: result.data.sourceIds.length
    });
    return { source: result.data.binding, receipt, sourceIds: result.data.sourceIds };
  } finally { xDatabase.close(); }
}

function recordXPreflightFailure(root: DataRoot, input: ChannelInput, error: unknown) {
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try {
    const source = sourceFor(database, input);
    if (source.module !== 'x_lists') throw new Error('X List 来源不存在。');
    const receipt = recordSourceScanReceipt(database, {
      taskId: manualTaskId(), workspaceId: workspaceIdOf(database), module: source.module,
      sourceId: source.sourceId, sourceFeedId: source.sourceFeedId, status: 'needs_user',
      errorCode: errorCodeOf(error), errorMessage: error instanceof Error ? error.message : String(error)
    });
    return { source, receipt, sourceIds: [] };
  } finally { database.close(); }
}

function sourceFor(database: ReturnType<typeof migrateDatabase>, input: ChannelInput): IntelligenceChannelSource {
  const source = readIntelligenceChannelsSummary(database).sources.find((item) => item.module === input.module && item.sourceId === input.sourceId);
  if (!source) throw new Error('情报来源不存在。');
  if (source.revision !== input.expectedRevision) throw Object.assign(new Error('来源已变化，请重新加载。'), { code: 'REVISION_CONFLICT' });
  return source;
}

function workspaceIdOf(database: ReturnType<typeof migrateDatabase>): string {
  const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
  if (!row?.value) throw new Error('当前工作空间身份缺失。');
  return row.value;
}

function manualTaskId(): string { return `manual-channel-scan-${randomUUID()}`; }
function errorCodeOf(error: unknown): string { return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'BROWSER_NEEDS_USER'; }

async function requiredRoot(loadSelectedDataRoot: Dependencies['loadSelectedDataRoot']): Promise<DataRoot> {
  const root = await loadSelectedDataRoot();
  if (!root) throw new Error('请先选择数据根目录。');
  return root;
}
