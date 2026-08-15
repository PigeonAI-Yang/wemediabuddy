import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DataRoot } from './data-root.ts';
import { migrateDatabase } from './db/migrations.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export type BusinessIpcDependencies = {
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  migrate: (root: DataRoot, options?: { recoverAgentTasks?: boolean }) => DataRoot;
  getActiveRuntime: () => ActiveWorkspaceRuntime | null;
};

export const ownerUiActor = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' } as const;
export const freshRequestId = () => randomUUID();

export async function readWorkspaceDatabase<T>(
  dependencies: BusinessIpcDependencies,
  noRoot: () => T,
  read: (database: DatabaseSync) => T
): Promise<T> {
  const runtime = dependencies.getActiveRuntime();
  if (runtime) return read(runtime.database);
  const root = await dependencies.loadSelectedDataRoot();
  const activatedRuntime = dependencies.getActiveRuntime();
  if (activatedRuntime) return read(activatedRuntime.database);
  if (!root) return noRoot();
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try { return read(database); } finally { database.close(); }
}

export async function requireBusinessRuntime(dependencies: BusinessIpcDependencies): Promise<ActiveWorkspaceRuntime> {
  const runtime = dependencies.getActiveRuntime();
  if (runtime) return runtime;
  const root = await dependencies.loadSelectedDataRoot();
  const activatedRuntime = dependencies.getActiveRuntime();
  if (activatedRuntime) return activatedRuntime;
  if (!root) throw new Error('请先选择数据根目录。');
  throw new Error('当前工作空间运行时尚未就绪。');
}

export async function runtimeForNullableMutation(dependencies: BusinessIpcDependencies): Promise<ActiveWorkspaceRuntime | null> {
  const runtime = dependencies.getActiveRuntime();
  if (runtime) return runtime;
  const root = await dependencies.loadSelectedDataRoot();
  const activatedRuntime = dependencies.getActiveRuntime();
  if (activatedRuntime) return activatedRuntime;
  if (!root) return null;
  throw new Error('当前工作空间运行时尚未就绪。');
}
