import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDataRoot, validateDataRoot } from './data-root.ts';

export type WorkspaceRecord = { id: string; displayName: string; rootPath: string };
export type WorkspaceRegistry = { version: 1; activeWorkspaceId: string | null; workspaces: WorkspaceRecord[] };

const emptyRegistry = (): WorkspaceRegistry => ({ version: 1, activeWorkspaceId: null, workspaces: [] });

function workspaceError(code: 'WORKSPACE_ID_MISMATCH' | 'WORKSPACE_NOT_FOUND', message: string): Error {
  return Object.assign(new Error(message), { code });
}

function normalizeRegistry(value: unknown): WorkspaceRegistry {
  if (!value || typeof value !== 'object') throw workspaceError('WORKSPACE_NOT_FOUND', '工作空间注册表无效。');
  const raw = value as Partial<WorkspaceRegistry>;
  if (raw.version !== 1 || !Array.isArray(raw.workspaces) || (raw.activeWorkspaceId !== null && typeof raw.activeWorkspaceId !== 'string')) {
    throw workspaceError('WORKSPACE_NOT_FOUND', '工作空间注册表无效。');
  }
  const workspaces = raw.workspaces.map((workspace) => {
    if (!workspace || typeof workspace.id !== 'string' || typeof workspace.displayName !== 'string' || typeof workspace.rootPath !== 'string') {
      throw workspaceError('WORKSPACE_NOT_FOUND', '工作空间注册表无效。');
    }
    return { id: workspace.id, displayName: workspace.displayName, rootPath: path.resolve(workspace.rootPath) };
  });
  if (new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length) throw workspaceError('WORKSPACE_NOT_FOUND', '工作空间注册表存在重复身份。');
  return { version: 1, activeWorkspaceId: raw.activeWorkspaceId ?? null, workspaces };
}

export async function readWorkspaceRegistry(registryPath: string): Promise<WorkspaceRegistry> {
  try { return normalizeRegistry(JSON.parse(await readFile(registryPath, 'utf8'))); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
    throw error;
  }
}

async function writeWorkspaceRegistry(registryPath: string, registry: WorkspaceRegistry): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, registryPath);
}

export async function readRootWorkspaceId(rootPath: string): Promise<string | null> {
  const root = await validateDataRoot(rootPath);
  const database = new DatabaseSync(path.join(root.path, 'wmb.db'), { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key = 'workspace_id'").get() as { value?: string } | undefined;
    return typeof row?.value === 'string' && row.value.length > 0 ? row.value : null;
  } finally {
    database.close();
  }
}

function writeRootWorkspaceId(rootPath: string, workspaceId: string): void {
  const database = new DatabaseSync(path.join(rootPath, 'wmb.db'));
  try {
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    const existing = database.prepare("SELECT value, revision FROM app_meta WHERE key = 'workspace_id'").get() as { value: string; revision: number } | undefined;
    if (existing && existing.value !== workspaceId) throw workspaceError('WORKSPACE_ID_MISMATCH', '数据根已属于其他工作空间。');
    if (!existing) database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('workspace_id', workspaceId, now, now);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

export async function enrollAiWorkspace(input: { registryPath: string; rootPath: string; displayName?: string }): Promise<WorkspaceRecord> {
  const root = await openDataRoot(input.rootPath);
  const registry = await readWorkspaceRegistry(input.registryPath);
  const rootWorkspaceId = await readRootWorkspaceId(root.path);
  if (registry.workspaces.length > 0 && !rootWorkspaceId) throw workspaceError('WORKSPACE_ID_MISMATCH', '未登记的数据根不能替换当前工作空间。');
  const workspaceId = rootWorkspaceId ?? randomUUID();
  const existing = registry.workspaces.find((workspace) => workspace.id === workspaceId);
  if (existing && existing.rootPath !== root.path) throw workspaceError('WORKSPACE_ID_MISMATCH', '移动后的数据根必须通过重新关联更新位置。');
  writeRootWorkspaceId(root.path, workspaceId);
  const workspace = existing ?? { id: workspaceId, displayName: input.displayName ?? 'AI', rootPath: root.path };
  if (!existing) await writeWorkspaceRegistry(input.registryPath, { version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace] });
  return workspace;
}

export async function relinkWorkspace(input: { registryPath: string; workspaceId: string; rootPath: string }): Promise<WorkspaceRecord> {
  const registry = await readWorkspaceRegistry(input.registryPath);
  const index = registry.workspaces.findIndex((workspace) => workspace.id === input.workspaceId);
  if (index < 0) throw workspaceError('WORKSPACE_NOT_FOUND', '未找到要重新关联的工作空间。');
  const root = await validateDataRoot(input.rootPath);
  if (await readRootWorkspaceId(root.path) !== input.workspaceId) throw workspaceError('WORKSPACE_ID_MISMATCH', '所选数据根身份与工作空间不匹配。');
  const workspace = { ...registry.workspaces[index], rootPath: root.path };
  const next = { ...registry, workspaces: registry.workspaces.map((item, itemIndex) => itemIndex === index ? workspace : item) };
  await writeWorkspaceRegistry(input.registryPath, next);
  return workspace;
}
