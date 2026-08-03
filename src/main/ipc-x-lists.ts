import { ipcMain } from 'electron';
import path from 'node:path';
import type { DataRoot } from './data-root.ts';
import { migrateDatabase } from './db/migrations.ts';
import { readXListDetail, readXListIndex, readXListMembers, readXListPostDetail, readXListTimeline, seedListTimelineMemory } from './platforms/x-list-browser.ts';
import { type XListBrowserConfig } from './platforms/x-list-primitives.ts';
import { currentXListContextForRoot, selectedXListBrowser, type CurrentXListContext } from './x-list-context.ts';
import { captureXListOperationSnapshot, collectBoundXListTimeline, confirmAndRunXListOperation } from './x-list-execution.ts';
import {
  armXListOperation, bindXList, getXListBinding, getXListOperation, listXListBindings, listXListOperations, prepareXListOperation,
  requestXListOperationStop, setXListBindingEnabled, type PrepareXListOperationInput
} from './x-lists.ts';
import { readXListIndexCache, writeXListIndexCache } from './x-list-cache.ts';
import {
  clearXListTimelineCache,
  readXListTimelineCache,
  summarizeXListTimelineCache,
  writeXListTimelineCacheIfImproved
} from './x-list-timeline-cache.ts';
import { readXListPostCache, writeXListPostCache } from './x-list-post-cache.ts';
import { listSourcesByFeed } from './sources.ts';
import { XListNeedsUserError } from './platforms/x-list-session.ts';
import { getXPostTrend, listXPostMetricSnapshots } from './x-post-metrics.ts';

type Dependencies = { loadSelectedDataRoot: () => Promise<DataRoot | null> };

export function registerXListIpc({ loadSelectedDataRoot: loadRoot }: Dependencies): void {
  const loadSelectedDataRoot = loadRoot;
  ipcMain.handle('x-lists:get-cached-index', async () => {
    const context = await currentXListContext(loadSelectedDataRoot);
    const database = migrateDatabase(path.join(context.root.path, 'wmb.db'));
    try {
      const cached = readXListIndexCache(database);
      return cached && sameAccount(cached.accountKey, context.accountKey) ? cached : null;
    } finally { database.close(); }
  });
  ipcMain.handle('x-lists:read-index', async () => {
    const root = await requiredRoot(loadSelectedDataRoot);
    const first = migrateDatabase(path.join(root.path, 'wmb.db'));
    let config: XListBrowserConfig;
    try { config = await selectedXListBrowser(first); } finally { first.close(); }
    let value;
    try { value = await readXListIndex(config); } catch (error) { throw needsUser(error); }
    if (value.lists.length > 0) {
      const database = migrateDatabase(path.join(root.path, 'wmb.db'));
      try { writeXListIndexCache(database, value); } finally { database.close(); }
    }
    return value;
  });
  ipcMain.handle('x-lists:read-detail', async (_event, listId: string) => withXListBrowser(loadSelectedDataRoot, (config) => readXListDetail(config, listId)));
  ipcMain.handle('x-lists:read-members', async (_event, listId: string) => withXListBrowser(loadSelectedDataRoot, (config) => readXListMembers(config, listId)));
  ipcMain.handle('x-lists:read-timeline', async (_event, input: { listId: string; limit?: number; knownUrls?: string[] }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    const continuing = Array.isArray(input.knownUrls) && input.knownUrls.length > 0;
    const value = await withTimeout(
      readXListTimeline(context.config, input.listId, input.limit, { knownUrls: input.knownUrls }),
      continuing ? 20_000 : 15_000,
      continuing ? '加载更多超时，请再试一次。' : '读取动态超时，请再试一次。'
    );
    const database = migrateDatabase(path.join(context.root.path, 'wmb.db'));
    try {
      const existing = readXListTimelineCache(database, value.accountKey, input.listId, { touch: false });
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
      writeXListTimelineCacheIfImproved(database, {
        accountKey: value.accountKey,
        listId: input.listId,
        posts: mergedPosts,
        detail: { name: value.detail.name, canonicalUrl: value.detail.canonicalUrl },
        source: 'live',
        fetchedAt: value.detail.observation?.capturedAt
      });
      seedListTimelineMemory({
        workspaceId: context.workspaceId,
        browserId: context.browserId,
        listId: input.listId,
        accountKey: value.accountKey,
        detail: { name: value.detail.name, canonicalUrl: value.detail.canonicalUrl },
        posts: mergedPosts
      });
    } finally { database.close(); }
    return value;
  });
  ipcMain.handle('x-lists:read-post', async (_event, input: { statusUrl: string; replyLimit?: number; bypassCache?: boolean }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    if (!input.bypassCache) {
      const cached = readXListPostCache(context, input.statusUrl);
      if (cached) return { accountKey: cached.accountKey, post: cached.post, cached: true, fetchedAt: cached.fetchedAt, stale: cached.stale };
    }
    const value = await readXListPostDetail(context.config, input.statusUrl, input.replyLimit ?? 30);
    if (!sameAccount(value.accountKey, context.accountKey)) throw accountMismatch();
    writeXListPostCache(context, input.statusUrl, value);
    return { ...value, cached: false, fetchedAt: new Date().toISOString(), stale: false };
  });
  ipcMain.handle('x-lists:get-cached-timeline', async (_event, input: { accountKey: string; listId: string }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    if (!sameAccount(context.accountKey, input.accountKey)) throw accountMismatch();
    return withDatabase(loadSelectedDataRoot, (database) => {
      if (!getXListBinding(database, context.accountKey, input.listId)) return null;
      const cached = readXListTimelineCache(database, input.accountKey, input.listId);
      if (cached?.payload?.posts?.length) {
        seedListTimelineMemory({
          workspaceId: context.workspaceId,
          browserId: context.browserId,
          listId: input.listId,
          accountKey: cached.accountKey || input.accountKey,
          detail: cached.payload.detail ?? null,
          posts: cached.payload.posts
        });
      }
      return cached;
    });
  });
  ipcMain.handle('x-lists:list-cached-timeline', async (_event, input: { accountKey: string; listId: string; limit?: number; offset?: number }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    if (!sameAccount(context.accountKey, input.accountKey)) throw accountMismatch();
    return withDatabase(loadSelectedDataRoot, (database) => {
      const binding = getXListBinding(database, input.accountKey, input.listId);
      if (!binding) return { items: [], limit: input.limit ?? 50, offset: input.offset ?? 0, hasMore: false, binding: null };
      const page = listSourcesByFeed(database, binding.sourceFeedId, { limit: input.limit, offset: input.offset });
      return { ...page, binding };
    });
  });
  ipcMain.handle('x-lists:clear-timeline-cache', async (_event, input: { accountKey?: string } = {}) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    if (input.accountKey && !sameAccount(context.accountKey, input.accountKey)) throw accountMismatch();
    return withDatabase(loadSelectedDataRoot, (database) => clearXListTimelineCache(database, context.accountKey));
  });
  ipcMain.handle('x-lists:timeline-cache-stats', async () => {
    const context = await currentXListContext(loadSelectedDataRoot);
    return withDatabase(loadSelectedDataRoot, (database) => summarizeXListTimelineCache(database, context.accountKey));
  });
  ipcMain.handle('x-lists:list-bindings', async (_event, accountKey?: string) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    if (accountKey && !sameAccount(context.accountKey, accountKey)) throw accountMismatch();
    return withDatabase(loadSelectedDataRoot, (database) => listXListBindings(database, context.accountKey));
  });
  ipcMain.handle('x-lists:list-post-metric-snapshots', async (_event, input: { sourceId: string; limit?: number }) =>
    withDatabase(loadSelectedDataRoot, (database) => listXPostMetricSnapshots(database, input.sourceId, input.limit)));
  ipcMain.handle('x-lists:get-post-trend', async (_event, input: { sourceId: string }) =>
    withDatabase(loadSelectedDataRoot, (database) => getXPostTrend(database, input.sourceId)));
  ipcMain.handle('x-lists:list-operations', async (_event, input: { accountKey?: string; limit?: number } = {}) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    if (input.accountKey && !sameAccount(context.accountKey, input.accountKey)) throw accountMismatch();
    return withDatabase(loadSelectedDataRoot, (database) => listXListOperations(database, { ...input, accountKey: context.accountKey }));
  });
  ipcMain.handle('x-lists:get-operation', async (_event, operationId: string) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    return withDatabase(loadSelectedDataRoot, (database) => {
      const operation = getXListOperation(database, operationId);
      if (operation && !sameAccount(operation.accountKey, context.accountKey)) throw accountMismatch();
      return operation;
    });
  });
  ipcMain.handle('x-lists:prepare', async (_event, input: PrepareXListOperationInput) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    if (!sameAccount(context.accountKey, input.accountKey)) throw accountMismatch();
    return withDatabase(loadSelectedDataRoot, (database) => prepareXListOperation(database, input));
  });
  ipcMain.handle('x-lists:arm', async (_event, input: { operationId: string; expectedRevision: number }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    const first = migrateDatabase(path.join(context.root.path, 'wmb.db'));
    let operation;
    try { operation = getXListOperation(first, input.operationId); } finally { first.close(); }
    if (!operation) throw new Error('List 操作不存在。');
    if (!sameAccount(operation.accountKey, context.accountKey)) throw accountMismatch();
    const snapshot = await captureXListOperationSnapshot(context.config, operation);
    const database = migrateDatabase(path.join(context.root.path, 'wmb.db'));
    try { return armXListOperation(database, { ...input, snapshot }); } finally { database.close(); }
  });
  ipcMain.handle('x-lists:confirm', async (_event, input: { operationId: string; expectedRevision: number; typedListName?: string }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    const database = migrateDatabase(path.join(context.root.path, 'wmb.db'));
    try {
      const operation = getXListOperation(database, input.operationId);
      if (operation && !sameAccount(operation.accountKey, context.accountKey)) throw accountMismatch();
      return await confirmAndRunXListOperation(database, context.config, input);
    } finally { database.close(); }
  });
  ipcMain.handle('x-lists:stop', async (_event, input: { operationId: string; expectedRevision: number }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    return withDatabase(loadSelectedDataRoot, (database) => {
      const operation = getXListOperation(database, input.operationId);
      if (operation && !sameAccount(operation.accountKey, context.accountKey)) throw accountMismatch();
      return requestXListOperationStop(database, input);
    });
  });
  ipcMain.handle('x-lists:bind', async (_event, input: { listId: string; expectedRevision?: number }) => {
    const root = await requiredRoot(loadSelectedDataRoot);
    const first = migrateDatabase(path.join(root.path, 'wmb.db'));
    let config: XListBrowserConfig;
    try { config = await selectedXListBrowser(first); } finally { first.close(); }
    let index;
    try { index = await readXListIndex(config); } catch (error) { throw needsUser(error); }
    const list = index.lists.find((candidate) => candidate.listId === input.listId);
    if (!list) throw new Error('当前账号未读到该 List，不能绑定。');
    const database = migrateDatabase(path.join(root.path, 'wmb.db'));
    try { return bindXList(database, { accountKey: index.accountKey, list, observation: { index: index.observation }, expectedRevision: input.expectedRevision }); } finally { database.close(); }
  });
  ipcMain.handle('x-lists:set-binding-enabled', async (_event, input: { accountKey: string; listId: string; expectedRevision: number; enabled: boolean }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    if (!sameAccount(context.accountKey, input.accountKey)) throw accountMismatch();
    return withDatabase(loadSelectedDataRoot, (database) => setXListBindingEnabled(database, input));
  });
  ipcMain.handle('x-lists:collect-timeline', async (_event, input: { accountKey: string; listId: string; limit?: number }) => {
    const context = await currentXListContext(loadSelectedDataRoot);
    if (!sameAccount(context.accountKey, input.accountKey)) throw accountMismatch();
    const database = migrateDatabase(path.join(context.root.path, 'wmb.db'));
    try {
      const result = await collectBoundXListTimeline(database, context.config, input);
      return result;
    } finally { database.close(); }
  });
}

async function withDatabase<T>(loadSelectedDataRoot: Dependencies['loadSelectedDataRoot'], action: (database: ReturnType<typeof migrateDatabase>) => T): Promise<T> {
  const root = await requiredRoot(loadSelectedDataRoot);
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try { return action(database); } finally { database.close(); }
}

async function withXListBrowser<T>(loadSelectedDataRoot: Dependencies['loadSelectedDataRoot'], action: (config: XListBrowserConfig) => Promise<T>): Promise<T> {
  const context = await currentXListContext(loadSelectedDataRoot);
  try { return await action(context.config); }
  catch (error) {
    if (error instanceof XListNeedsUserError) throw needsUser(error);
    throw error;
  }
}

export async function currentXListContext(loadSelectedDataRoot: Dependencies['loadSelectedDataRoot']): Promise<CurrentXListContext> {
  try { return await currentXListContextForRoot(await requiredRoot(loadSelectedDataRoot)); }
  catch (error) { throw needsUser(error); }
}

async function requiredRoot(loadSelectedDataRoot: Dependencies['loadSelectedDataRoot']): Promise<DataRoot> {
  const root = await loadSelectedDataRoot();
  if (!root) throw new Error('请先选择数据根目录。');
  return root;
}

function sameAccount(left: string, right: string): boolean { return left.trim().toLowerCase() === right.trim().toLowerCase(); }
function accountMismatch(): Error { return Object.assign(new Error('当前浏览器账号与本根绑定账号不一致。'), { code: 'ACCOUNT_MISMATCH' }); }
function needsUser(error: unknown): Error {
  return Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: (error as { code?: string })?.code ?? 'BROWSER_NEEDS_USER' });
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
