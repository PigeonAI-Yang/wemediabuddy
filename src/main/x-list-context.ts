import path from 'node:path';
import type { DataRoot } from './data-root.ts';
import { migrateDatabase } from './db/migrations.ts';
import { ensurePyaireaderXBrowser, readBrowserConfig } from './browser.ts';
import { readXListIndex } from './platforms/x-list-browser.ts';
import { pyaireaderXProfileId, type XListBrowserConfig } from './platforms/x-list-primitives.ts';
import { allowsAiOnlyRoutes } from './workspace-profiles.ts';

export type CurrentXListContext = {
  root: DataRoot;
  workspaceId: string;
  browserId: string;
  accountKey: string;
  config: XListBrowserConfig;
  index: Awaited<ReturnType<typeof readXListIndex>>;
};

export async function currentXListContextForRoot(root: DataRoot): Promise<CurrentXListContext> {
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  let config: XListBrowserConfig;
  let workspaceId: string | undefined;
  try {
    workspaceId = (database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value;
    if (!workspaceId) throw new Error('当前工作空间身份缺失。');
    config = await selectedXListBrowser(database);
  } finally { database.close(); }
  const index = await readXListIndex({ ...config!, workspaceId });
  return { root, workspaceId: workspaceId!, browserId: config!.id, accountKey: index.accountKey, config: { ...config!, workspaceId, accountKey: index.accountKey }, index };
}

export async function selectedXListBrowser(database: ReturnType<typeof migrateDatabase>): Promise<XListBrowserConfig> {
  const config = readBrowserConfig(database);
  if (!config) throw new Error('请先在设置中选择当前工作空间专用的 X 登录态。');
  if (config.id === pyaireaderXProfileId && !allowsAiOnlyRoutes(database)) throw new Error('此根尚未配置独立 X 登录态。');
  const runtime = await ensurePyaireaderXBrowser(config, { mode: 'quiet' });
  return { id: config.id, cdpUrl: runtime.cdpUrl };
}
