import { ipcMain } from 'electron';
import type { DataRoot } from './data-root.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { readXListDetail, readXListIndex, readXListMembers, readXListPostDetail, readXListTimeline, seedListTimelineMemory } from './platforms/x-list-browser.ts';
import { type XListBrowserConfig } from './platforms/x-list-primitives.ts';
import { selectedXListBrowser, type CurrentXListContext } from './x-list-context.ts';
import { activeXListOperationIds, captureXListOperationSnapshot, readBoundXListTimeline, runAcceptedXListOperation } from './x-list-execution.ts';
import { getXListBinding, getXListOperation, listXListBindings, listXListOperations, readXListExecutionAuthority, type PrepareXListOperationInput } from './x-lists.ts';
import { readXListTimelineCache, summarizeXListTimelineCache } from './x-list-timeline-cache.ts';
import { listSourcesByFeed } from './sources.ts';
import { XListNeedsUserError } from './platforms/x-list-session.ts';
import { getXPostTrend, listXPostMetricSnapshots, listXPostTrends } from './x-post-metrics.ts';
import type { ActiveWorkspaceRuntime, WorkspaceRuntimeLease } from './workspace-runtime.ts';
import type { BrowserRuntime } from './browser.ts';
import { dispatchAcceptXListOperation, readXListExecutionReplay } from './x-list-command.ts';
import { startVerifiedBoundBrowser, type WorkspaceBrowserVerificationOptions } from './bound-browser.ts';
import {
  createXListOperationPersistence,
  dispatchArmXListOperation,
  dispatchBeginXListOperation,
  dispatchBindXList,
  dispatchClearXListTimelineCache,
  dispatchFinishXListOperation,
  dispatchLeaseXListOperation,
  dispatchPersistBoundXListTimeline,
  dispatchPersistXListIndex,
  dispatchPersistXListPost,
  dispatchPersistXListTimeline,
  dispatchPrepareXListOperation,
  dispatchReadXListPostCache,
  dispatchReadXListTimelineCache,
  dispatchSetXListBindingEnabled,
  dispatchStartXObservation,
  dispatchStopXListOperation,
  dispatchStopXObservation,
  dispatchXListValidationFailure,
  readXListIndexFromRuntime,
  readXObservationFromRuntime
} from './x-list-business-command.ts';
import { readXObservationSessionStart } from './x-observation-jobs.ts';

type Dependencies = { loadSelectedDataRoot: () => Promise<DataRoot | null>; getActiveRuntime: () => ActiveWorkspaceRuntime | null; setBrowser: (runtime: BrowserRuntime) => WorkspaceRuntimeLease; wakeObservationScheduler?: () => void };

export function registerXListIpc({ loadSelectedDataRoot, getActiveRuntime, setBrowser, wakeObservationScheduler }: Dependencies): void {
  ipcMain.handle('x-lists:get-cached-index', async () => readXListIndexFromRuntime(requiredRuntime(getActiveRuntime)));
  ipcMain.handle('x-lists:read-index', async () => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime, { allowMissingExpectedAccount: true });
    const value = context.index;
    if (value.lists.length > 0) await dispatchPersistXListIndex(runtime, { browserId: context.browserId, expectedAccountKey: context.accountKey, value });
    return value;
  });
  ipcMain.handle('x-lists:read-detail', async (_event, listId: string) => withXListBrowser(loadSelectedDataRoot, getActiveRuntime, (config) => readXListDetail(config, listId), { allowMissingExpectedAccount: true }));
  ipcMain.handle('x-lists:read-members', async (_event, listId: string) => withXListBrowser(loadSelectedDataRoot, getActiveRuntime, (config) => readXListMembers(config, listId), { allowMissingExpectedAccount: true }));
  ipcMain.handle('x-lists:read-timeline', async (_event, input: { listId: string; limit?: number; knownUrls?: string[] }) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime, { allowMissingExpectedAccount: true });
    const continuing = Array.isArray(input.knownUrls) && input.knownUrls.length > 0;
    const value = await withTimeout(
      readXListTimeline(context.config, input.listId, input.limit, { knownUrls: input.knownUrls }),
      continuing ? 20_000 : 15_000,
      continuing ? '加载更多超时，请再试一次。' : '读取动态超时，请再试一次。'
    );
    const existing = readXListTimelineCache(runtime.database, value.accountKey, input.listId, { touch: false, cleanup: false });
    const known = new Set((input.knownUrls ?? []).map((item) => item.replace(/[?#].*$/, '')));
    const mergedPosts = (() => {
      if (!known.size || !existing?.payload?.posts?.length) return value.posts;
      const out = [...existing.payload.posts];
      const seen = new Set(out.map((item) => item.url.replace(/[?#].*$/, '')));
      for (const post of value.posts) {
        const key = post.url.replace(/[?#].*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      }
      return out;
    })();
    const saved = await dispatchPersistXListTimeline(runtime, {
      browserId: context.browserId, expectedAccountKey: context.accountKey, observedAccountKey: value.accountKey,
      listId: input.listId, posts: mergedPosts,
      detail: { name: value.detail.name, canonicalUrl: value.detail.canonicalUrl },
      fetchedAt: value.detail.observation?.capturedAt
    });
    const resolvedPosts = saved?.payload.posts ?? mergedPosts;
    seedListTimelineMemory({
      workspaceId: context.workspaceId, browserId: context.browserId, listId: input.listId,
      accountKey: value.accountKey, detail: { name: value.detail.name, canonicalUrl: value.detail.canonicalUrl }, posts: resolvedPosts
    });
    if (!continuing) return {
      ...value, posts: resolvedPosts, livePostCount: value.posts.length,
      refreshDisposition: value.posts.length === 0 && resolvedPosts.length > 0 ? 'retained_cache'
        : resolvedPosts.length > value.posts.length ? 'merged_cache' : 'updated'
    };
    return value;
  });
  ipcMain.handle('x-lists:read-post', async (_event, input: { statusUrl: string; replyLimit?: number; bypassCache?: boolean }) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime, { allowMissingExpectedAccount: true });
    const cacheScope = { workspaceId: context.workspaceId, browserId: context.browserId, accountKey: context.accountKey };
    if (!input.bypassCache) {
      const cached = await dispatchReadXListPostCache(runtime, cacheScope, input.statusUrl);
      if (cached) return { accountKey: cached.accountKey, post: cached.post, cached: true, fetchedAt: cached.fetchedAt, stale: cached.stale };
    }
    const value = await readXListPostDetail(context.config, input.statusUrl, input.replyLimit ?? 30);
    await dispatchPersistXListPost(runtime, { scope: cacheScope, statusUrl: input.statusUrl, value });
    return { ...value, cached: false, fetchedAt: new Date().toISOString(), stale: false };
  });
  ipcMain.handle('x-lists:get-cached-timeline', async (_event, input: { accountKey: string; listId: string }) =>
    dispatchReadXListTimelineCache(requiredRuntime(getActiveRuntime), input));
  ipcMain.handle('x-lists:list-cached-timeline', async (_event, input: { accountKey: string; listId: string; limit?: number; offset?: number }) => {
    const database = requiredRuntime(getActiveRuntime).database;
    const binding = getXListBinding(database, input.accountKey, input.listId);
    if (!binding) return { items: [], limit: input.limit ?? 50, offset: input.offset ?? 0, hasMore: false, binding: null };
    return { ...listSourcesByFeed(database, binding.sourceFeedId, { limit: input.limit, offset: input.offset }), binding };
  });
  ipcMain.handle('x-lists:clear-timeline-cache', async (_event, input: { accountKey?: string } = {}) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime);
    return dispatchClearXListTimelineCache(runtime, { browserId: context.browserId, expectedAccountKey: context.accountKey, requestedAccountKey: input.accountKey });
  });
  ipcMain.handle('x-lists:timeline-cache-stats', async () => summarizeXListTimelineCache(requiredRuntime(getActiveRuntime).database));
  ipcMain.handle('x-lists:list-bindings', async (_event, accountKey?: string) => listXListBindings(requiredRuntime(getActiveRuntime).database, accountKey));
  ipcMain.handle('x-lists:list-post-metric-snapshots', async (_event, input: { sourceId: string; limit?: number }) => listXPostMetricSnapshots(requiredRuntime(getActiveRuntime).database, input.sourceId, input.limit));
  ipcMain.handle('x-lists:get-post-trend', async (_event, input: { sourceId: string }) => getXPostTrend(requiredRuntime(getActiveRuntime).database, input.sourceId));
  ipcMain.handle('x-lists:list-post-trends', async (_event, input: { bindingId: string; limit?: number }) => listXPostTrends(requiredRuntime(getActiveRuntime).database, { bindingId: input.bindingId, limit: input.limit }));
  ipcMain.handle('x-lists:start-observation', async (_event, input: { requestId: string; bindingIds: string[] }) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime, { allowMissingExpectedAccount: true });
    const read = await readXObservationSessionStart(runtime.database, context.config, input);
    const result = await dispatchStartXObservation(runtime, context.config, input, read);
    if (result.ok) wakeObservationScheduler?.();
    return result;
  });
  ipcMain.handle('x-lists:get-observation', async (_event, input: { sessionId: string }) => readXObservationFromRuntime(requiredRuntime(getActiveRuntime), input.sessionId));
  ipcMain.handle('x-lists:stop-observation', async (_event, input: { sessionId: string }) => dispatchStopXObservation(requiredRuntime(getActiveRuntime), input.sessionId));
  ipcMain.handle('x-lists:list-operations', async (_event, input: { accountKey?: string; limit?: number } = {}) => listXListOperations(requiredRuntime(getActiveRuntime).database, input));
  ipcMain.handle('x-lists:get-operation', async (_event, operationId: string) => getXListOperation(requiredRuntime(getActiveRuntime).database, operationId));
  ipcMain.handle('x-lists:prepare', async (_event, input: PrepareXListOperationInput) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime);
    return dispatchPrepareXListOperation(runtime, input, context.accountKey);
  });
  ipcMain.handle('x-lists:arm', async (_event, input: { operationId: string; expectedRevision: number }) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime);
    const operation = getXListOperation(runtime.database, input.operationId);
    if (!operation) return dispatchXListValidationFailure(runtime, {
      command: 'x_lists.operation_arm', boundIdentity: { operationId: input.operationId, revision: input.expectedRevision },
      error: Object.assign(new Error('List 操作不存在。'), { code: 'NOT_FOUND' })
    });
    if (operation.accountKey.trim().toLowerCase() !== context.accountKey.trim().toLowerCase()) return dispatchXListValidationFailure(runtime, {
      command: 'x_lists.operation_arm', boundIdentity: { operationId: input.operationId, revision: input.expectedRevision, accountKey: context.accountKey },
      error: Object.assign(new Error('当前浏览器账号与本根绑定账号不一致。'), { code: 'ACCOUNT_MISMATCH' })
    });
    const snapshot = await captureXListOperationSnapshot(context.config, operation);
    return dispatchArmXListOperation(runtime, { ...input, snapshot, expectedAccountKey: context.accountKey });
  });
  ipcMain.handle('x-lists:confirm', async (_event, input: { operationId: string; expectedRevision: number; typedListName?: string }) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const before = getXListOperation(runtime.database, input.operationId);
    if (before) {
      const replay = readXListExecutionReplay(runtime, before, input);
      if (replay) return replay;
    }
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime);
    const receipt = await dispatchAcceptXListOperation(runtime, context, input);
    if (receipt.ok && receipt.data?.state === 'execution_granted' && !activeXListOperationIds.has(receipt.data.id)) {
      activeXListOperationIds.add(receipt.data.id);
      void runAcceptedXListOperationForRuntime(runtime, receipt.data.id, setBrowser);
    }
    return receipt;
  });
  ipcMain.handle('x-lists:stop', async (_event, input: { operationId: string; expectedRevision: number }) => dispatchStopXListOperation(requiredRuntime(getActiveRuntime), input));
  ipcMain.handle('x-lists:bind', async (_event, input: { listId: string; expectedRevision?: number }) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime);
    const list = context.index.lists.find((candidate) => candidate.listId === input.listId);
    if (!list) return dispatchXListValidationFailure(runtime, {
      command: 'x_lists.binding_bind', boundIdentity: { accountKey: context.accountKey, listId: input.listId, revision: input.expectedRevision ?? null },
      error: Object.assign(new Error('当前账号未读到该 List，不能绑定。'), { code: 'NOT_FOUND' })
    });
    const result = await dispatchBindXList(runtime, { accountKey: context.index.accountKey, list, observation: { index: context.index.observation }, expectedRevision: input.expectedRevision });
    if (result.ok) broadcastDataChanged({ scopes: ['sources', 'today'], reason: 'intelligence.x-list.bind' });
    return result;
  });
  ipcMain.handle('x-lists:set-binding-enabled', async (_event, input: { accountKey: string; listId: string; expectedRevision: number; enabled: boolean }) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime);
    const result = await dispatchSetXListBindingEnabled(runtime, input, context.accountKey);
    if (result.ok) broadcastDataChanged({ scopes: ['sources', 'today'], reason: 'intelligence.x-list.enabled' });
    return result;
  });
  ipcMain.handle('x-lists:collect-timeline', async (_event, input: { accountKey: string; listId: string; limit?: number }) => {
    const runtime = requiredRuntime(getActiveRuntime);
    const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime, { allowMissingExpectedAccount: true });
    const read = await readBoundXListTimeline(runtime.database, context.config, input);
    return dispatchPersistBoundXListTimeline(runtime, context.config, input, read, context.accountKey);
  });
}

async function withXListBrowser<T>(
  loadSelectedDataRoot: Dependencies['loadSelectedDataRoot'],
  getActiveRuntime: Dependencies['getActiveRuntime'],
  action: (config: XListBrowserConfig) => Promise<T>,
  options: WorkspaceBrowserVerificationOptions = {}
): Promise<T> {
  const context = await currentXListContext(loadSelectedDataRoot, getActiveRuntime, options);
  try { return await action(context.config); }
  catch (error) {
    if (error instanceof XListNeedsUserError) throw needsUser(error);
    throw error;
  }
}

async function runAcceptedXListOperationForRuntime(runtime: ActiveWorkspaceRuntime, operationId: string, setBrowser: Dependencies['setBrowser']): Promise<void> {
  let executionGrantId: string | null = null;
  try {
    const granted = getXListOperation(runtime.database, operationId);
    if (!granted || granted.state !== 'execution_granted' || !granted.executionGrantId) return;
    executionGrantId = granted.executionGrantId;
    const persistence = createXListOperationPersistence(runtime, operationId, executionGrantId);
    const authority = readXListExecutionAuthority(persistence.assertAuthority());
    const browser = await startVerifiedBoundBrowser(runtime.database, 'x', { mode: 'quiet' });
    if (!authority || browser.profile.id !== authority.browserProfileId
      || browser.binding.bindingRevision !== authority.browserBindingRevision
      || browser.identity.accountKey.trim().toLowerCase() !== authority.expectedAccount.trim().toLowerCase()) {
      throw new Error('浏览器档案、绑定版本或账号与精确授权不一致。');
    }
    const lease = setBrowser(browser.runtime);
    await runtime.runExternalBrowserWork(lease, async () => {
      try {
        await dispatchLeaseXListOperation(runtime, operationId, executionGrantId!);
        const running = await dispatchBeginXListOperation(runtime, operationId, executionGrantId!);
        await runAcceptedXListOperation(
          { id: browser.profile.id, cdpUrl: browser.runtime.cdpUrl, workspaceId: runtime.identity.workspaceId, accountKey: running.accountKey },
          running,
          persistence
        );
      } catch (error) {
        const current = getXListOperation(runtime.database, operationId);
        if (current && executionGrantId && ['execution_granted', 'browser_leased', 'running'].includes(current.state)) {
          const uncertain = current.state === 'running' && current.phase.startsWith('intent_recorded:');
          await dispatchFinishXListOperation(runtime, operationId, executionGrantId, {
            state: uncertain ? 'unknown' : 'needs_user', phase: uncertain ? 'unknown_after_action' : 'needs_user',
            errorCode: uncertain ? 'X_LIST_UNKNOWN' : 'BROWSER_NEEDS_USER', errorMessage: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });
  } catch (error) {
    const current = getXListOperation(runtime.database, operationId);
    if (current && executionGrantId && current.state === 'execution_granted') {
      await dispatchFinishXListOperation(runtime, operationId, executionGrantId, {
        state: 'needs_user', phase: 'needs_user', errorCode: 'BROWSER_NEEDS_USER', errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  } finally { activeXListOperationIds.delete(operationId); }
}

export async function currentXListContext(
  loadSelectedDataRoot: Dependencies['loadSelectedDataRoot'],
  getActiveRuntime: Dependencies['getActiveRuntime'],
  options: WorkspaceBrowserVerificationOptions = {}
): Promise<CurrentXListContext> {
  try {
    const runtime = requiredRuntime(getActiveRuntime);
    const root = await requiredRoot(loadSelectedDataRoot);
    const browser = await selectedXListBrowser(runtime.database, options);
    const index = await readXListIndex({ ...browser, workspaceId: runtime.identity.workspaceId });
    return {
      root, workspaceId: runtime.identity.workspaceId, browserId: browser.id, accountKey: index.accountKey,
      config: { ...browser, workspaceId: runtime.identity.workspaceId, accountKey: index.accountKey }, index
    };
  } catch (error) { throw needsUser(error); }
}

async function requiredRoot(loadSelectedDataRoot: Dependencies['loadSelectedDataRoot']): Promise<DataRoot> {
  const root = await loadSelectedDataRoot();
  if (!root) throw new Error('请先选择数据根目录。');
  return root;
}

function requiredRuntime(getActiveRuntime: Dependencies['getActiveRuntime']): ActiveWorkspaceRuntime {
  const runtime = getActiveRuntime();
  if (!runtime?.isActive) throw Object.assign(new Error('当前工作空间运行时不可用。'), { code: 'WORKSPACE_BUSY' });
  return runtime;
}

function needsUser(error: unknown): Error {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'BROWSER_NEEDS_USER';
  return Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
