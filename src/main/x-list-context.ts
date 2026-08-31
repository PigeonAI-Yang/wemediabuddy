import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DataRoot } from './data-root.ts';
import { migrateDatabase } from './db/migrations.ts';
import { startVerifiedBoundBrowser, type WorkspaceBrowserVerificationOptions } from './bound-browser.ts';
import { readXListIndex } from './platforms/x-list-browser.ts';
import type { XListBrowserConfig } from './platforms/x-list-primitives.ts';

export type CurrentXListContext = {
  root: DataRoot;
  workspaceId: string;
  browserId: string;
  accountKey: string;
  config: XListBrowserConfig;
  index: Awaited<ReturnType<typeof readXListIndex>>;
};

export async function currentXListContextForRoot(root: DataRoot, options: WorkspaceBrowserVerificationOptions = {}): Promise<CurrentXListContext> {
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  let config: XListBrowserConfig;
  let workspaceId: string | undefined;
  try {
    workspaceId = (database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value;
    if (!workspaceId) throw new Error('当前工作空间身份缺失。');
    config = await selectedXListBrowser(database, options);
  } finally { database.close(); }
  const index = await readXListIndex({ ...config!, workspaceId });
  return { root, workspaceId: workspaceId!, browserId: config!.id, accountKey: index.accountKey, config: { ...config!, workspaceId, accountKey: index.accountKey }, index };
}

export async function selectedXListBrowser(database: DatabaseSync, options: WorkspaceBrowserVerificationOptions = {}): Promise<XListBrowserConfig> {
  const resolved = await startVerifiedBoundBrowser(database, 'x', { mode: 'quiet', ...options });
  return { id: resolved.profile.id, cdpUrl: resolved.runtime.cdpUrl };
}
