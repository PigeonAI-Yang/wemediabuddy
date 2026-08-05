import { BrowserWindow, ipcMain } from 'electron';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import { getGitHubRankings } from './github-rankings.ts';
import { readRankingCache, writeRankingCache } from './ranking-cache.ts';
import {
  deleteKnowledgeSource, listKnowledgeSources, listWatchingSources, markSourcesWatching, updateKnowledgeSource,
  type ManagementStatus, type VerificationStatus
} from './knowledge.ts';
import { fetchAndCacheSourceBody, getSourceBodyCache, listSourceBodyCaches, writeSourceBodyCache } from './source-body-cache.ts';
import { getWireHealthLedger } from './source-wire-health.ts';
import { dispatchSourceUpsertBatch } from './source-commands.ts';
import { assertAiOnlyRoute } from './workspace-profiles.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, runtimeForNullableMutation,
  type BusinessIpcDependencies
} from './ipc-business-context.ts';
import { registerKnowledgeBusinessIpc } from './ipc-knowledge-business.ts';
import { registerTodayStudioBusinessIpc } from './ipc-today-studio-business.ts';

export function registerKnowledgeContentIpc(dependencies: BusinessIpcDependencies): void {
  registerKnowledgeBusinessIpc(dependencies);
  registerTodayStudioBusinessIpc(dependencies);

  ipcMain.handle('rankings:get-cached', () => readWorkspaceDatabase(dependencies, () => null, database => {
    assertAiOnlyRoute(database, 'ai.library.rankings'); return readRankingCache(database);
  }));
  ipcMain.handle('rankings:github-ai', async (_event, refresh = false) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    assertAiOnlyRoute(runtime.database, 'ai.library.rankings');
    const value = await getGitHubRankings(refresh); const cached = readRankingCache(runtime.database);
    const freshReady = value.boards.some(board => board.status === 'ready');
    if (!freshReady && cached?.boards.some(board => board.status === 'ready')) return cached;
    if (!freshReady) return value;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'rankings:github-ai', requestId: freshRequestId(), actor: ownerUiActor,
      input: value, boundIdentity: { entityType: 'ranking_cache', entityId: 'github-ai' }, entityType: 'ranking_cache',
      execute: (database, input) => { writeRankingCache(database, input); return { data: input, entityId: 'github-ai', readback: readRankingCache(database) }; } });
    return requireReceiptData(receipt);
  });

  ipcMain.handle('knowledge:list-sources', (_event, input = {}) => readWorkspaceDatabase(dependencies, () => null, database => listKnowledgeSources(database, input)));
  ipcMain.handle('knowledge:update-source', async (_event, input: {
    id: string; expectedRevision: number; verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus;
    title?: string; summary?: string | null; author?: string | null;
  }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge:update-source', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'source_item', entityId: input.id }, entityType: 'source_item',
      execute: (database, value) => { const data = updateKnowledgeSource(database, value, false); return { data, entityId: data.id,
        beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['library', 'sources', 'today'], reason: 'source.update' }); return data;
  });
  ipcMain.handle('knowledge:delete-source', async (_event, input: { id: string; expectedRevision: number }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge:delete-source', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'source_item', entityId: input.id }, entityType: 'source_item',
      execute: (database, value) => { const data = deleteKnowledgeSource(database, value, false, false); return { data, entityId: data.id,
        beforeRevision: value.expectedRevision, sideEffectState: 'deleted' }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['library', 'sources', 'today'], reason: 'source.delete' }); return data;
  });
  ipcMain.handle('knowledge:list-watching', (_event, input: { limit?: number } = {}) => readWorkspaceDatabase(dependencies,
    () => [], database => listWatchingSources(database, input?.limit ?? 30)));
  ipcMain.handle('knowledge:mark-watching', async (_event, input: { sourceIds?: string[] } = {}) => {
    const runtime = await requireBusinessRuntime(dependencies); const sourceIds = Array.isArray(input?.sourceIds) ? input.sourceIds : [];
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge:mark-watching', requestId: freshRequestId(), actor: ownerUiActor,
      input: { sourceIds }, boundIdentity: { entityType: 'source_item' }, entityType: 'source_item',
      execute: (database, value) => { const data = markSourcesWatching(database, value.sourceIds, false); return { data, readback: data }; } });
    const data = requireReceiptData(receipt); if (data.updated > 0) broadcastDataChanged({ scopes: ['library', 'sources', 'today'], reason: 'source.watching' }); return data;
  });

  ipcMain.handle('sources:get-body-cache', (_event, sourceId: string) => readWorkspaceDatabase(dependencies, () => null, database => getSourceBodyCache(database, sourceId)));
  ipcMain.handle('sources:list-body-cache', (_event, sourceIds: string[] = []) => readWorkspaceDatabase(dependencies,
    () => [], database => listSourceBodyCaches(database, Array.isArray(sourceIds) ? sourceIds : [])));
  ipcMain.handle('sources:fetch-body', async (_event, input: { sourceId: string; force?: boolean; maxChars?: number }) => {
    const runtime = await requireBusinessRuntime(dependencies); if (!input?.sourceId) throw new Error('缺少 sourceId。');
    const fetched = await fetchAndCacheSourceBody(runtime.database, { ...input, persist: false });
    const receipt = await dispatchBusinessCommand(runtime, { command: 'sources:fetch-body', requestId: freshRequestId(), actor: ownerUiActor,
      input: fetched, boundIdentity: { entityType: 'source_body_cache', entityId: input.sourceId }, entityType: 'source_body_cache',
      execute: (database, value) => ({ data: writeSourceBodyCache(database, value), entityId: value.sourceId, readback: value }) });
    return requireReceiptData(receipt);
  });
  ipcMain.handle('sources:wire-health', (_event, input: { businessDate?: string } = {}) => readWorkspaceDatabase(dependencies,
    () => ({ taskId: null, businessDate: input?.businessDate ?? null, status: null, phase: null, updatedAt: null, entries: [], summary: { total: 0, ok: 0, failed: 0, saved: 0 } }),
    database => { assertAiOnlyRoute(database, 'ai.intelligence.release_sources'); return getWireHealthLedger(database, input ?? {}); }));
  ipcMain.handle('sources:save-discovered', async (_event, input: { requestId: string; title: string; originalUrl?: string; summary?: string; author?: string; categories?: string[] }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    return dispatchSourceUpsertBatch(runtime, { requestId: input.requestId, actor: ownerUiActor,
      items: [{ title: input.title, originalUrl: input.originalUrl, summary: input.summary, author: input.author, categories: input.categories }] });
  });

  ipcMain.handle('window:control', (event, action: 'minimize' | 'maximize' | 'close') => {
    const window = BrowserWindow.fromWebContents(event.sender); if (!window) return false;
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') window.close();
    return window.isMaximized();
  });
}
