import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDataRoot, validateDataRoot } from './data-root.ts';
import { migrateDatabase } from './db/migrations.ts';
import { ensureOfficialWorkspaceProfile, insertWorkspaceProfile, OFFICIAL_WORKSPACE_TEMPLATES, type OfficialTemplateId, type WorkspaceProfileV1 } from './workspace-profiles.ts';

export type WorkspaceRecord = { id: string; displayName: string; rootPath: string };
export type WorkspaceSwitchJournal = { previousWorkspaceId: string; pendingWorkspaceId: string; state: 'pending' | 'attempting' };
export type WorkspaceRegistry = { version: 1; activeWorkspaceId: string | null; workspaces: WorkspaceRecord[]; switchJournal: WorkspaceSwitchJournal | null };

const emptyRegistry = (): WorkspaceRegistry => ({ version: 1, activeWorkspaceId: null, workspaces: [], switchJournal: null });

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
  const switchJournal = raw.switchJournal;
  if (switchJournal !== null && switchJournal !== undefined && (
    typeof switchJournal !== 'object' || typeof switchJournal.previousWorkspaceId !== 'string' ||
    typeof switchJournal.pendingWorkspaceId !== 'string' || !['pending', 'attempting'].includes(switchJournal.state)
  )) throw workspaceError('WORKSPACE_NOT_FOUND', '工作空间切换记录无效。');
  return { version: 1, activeWorkspaceId: raw.activeWorkspaceId ?? null, workspaces, switchJournal: switchJournal ?? null };
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

export function writeRootWorkspaceId(rootPath: string, workspaceId: string): void {
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

export async function createProposedWorkspace(input: {
  registryPath: string;
  rootPath: string;
  profile: WorkspaceProfileV1;
  injectFailure?: (phase: 'root_ready' | 'schema_ready' | 'identity_ready' | 'profile_ready' | 'before_registry' | 'after_registry') => void;
}): Promise<WorkspaceRecord> {
  const originalRegistry = await readWorkspaceRegistry(input.registryPath);
  const root = await prepareCandidateRoot(input.rootPath);
  input.injectFailure?.('root_ready');
  const migrated = migrateDatabase(path.join(root.path, 'wmb.db'));
  const registeredPath = originalRegistry.workspaces.some((item) => item.rootPath === root.path);
  let businessRows = 0;
  try { businessRows = candidateBusinessRowCount(migrated); } finally { migrated.close(); }
  if (!registeredPath && businessRows > 0) throw Object.assign(new Error('候选根已包含业务数据，不能作为新工作空间。'), { code: 'VALIDATION_ERROR' });
  input.injectFailure?.('schema_ready');
  const existingId = await readRootWorkspaceId(root.path);
  const workspaceId = existingId ?? randomUUID();
  if (!existingId) writeRootWorkspaceId(root.path, workspaceId);
  input.injectFailure?.('identity_ready');
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try { insertWorkspaceProfile(database, input.profile); } finally { database.close(); }
  input.injectFailure?.('profile_ready');
  const alreadyRegistered = originalRegistry.workspaces.find((item) => item.id === workspaceId || item.rootPath === root.path);
  if (alreadyRegistered) {
    if (alreadyRegistered.id !== workspaceId || alreadyRegistered.rootPath !== root.path) throw workspaceError('WORKSPACE_ID_MISMATCH', '候选根与已登记工作空间不一致。');
    return alreadyRegistered;
  }
  input.injectFailure?.('before_registry');
  const currentRegistry = await readWorkspaceRegistry(input.registryPath);
  if (JSON.stringify(currentRegistry) !== JSON.stringify(originalRegistry)) throw workspaceError('WORKSPACE_ID_MISMATCH', '工作空间注册表已变化，请重新确认。');
  const workspace = { id: workspaceId, displayName: input.profile.displayName, rootPath: root.path };
  await writeWorkspaceRegistry(input.registryPath, { ...currentRegistry, workspaces: [...currentRegistry.workspaces, workspace] });
  input.injectFailure?.('after_registry');
  return workspace;
}

async function prepareCandidateRoot(rootPath: string) {
  const resolved = path.resolve(rootPath);
  await mkdir(resolved, { recursive: true });
  const allowed = ['wmb.db', 'assets', 'browser-profile', 'logs', 'exports'];
  const entries = await readdir(resolved, { withFileTypes: true });
  if (entries.some((entry) => !allowed.includes(entry.name))) throw Object.assign(new Error('新工作空间必须使用空目录或可恢复的候选根。'), { code: 'VALIDATION_ERROR' });
  const databaseEntry = entries.find((entry) => entry.name === 'wmb.db');
  if (databaseEntry) return validateDataRoot(resolved);
  for (const entry of entries) {
    if (!entry.isDirectory() || (await readdir(path.join(resolved, entry.name))).length > 0) throw Object.assign(new Error('候选根不是可恢复的空初始化目录。'), { code: 'VALIDATION_ERROR' });
  }
  for (const directory of allowed.slice(1)) await mkdir(path.join(resolved, directory), { recursive: true });
  await (await open(path.join(resolved, 'wmb.db'), 'a')).close();
  return validateDataRoot(resolved);
}

function candidateBusinessRowCount(database: DatabaseSync): number {
  const metadata = new Set(['schema_migrations', 'app_meta', 'workspace_profiles']);
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name).filter((name) => !metadata.has(name));
  return tables.reduce((total, name) => total + Number((database.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get() as { count: number }).count), 0);
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
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try { ensureOfficialWorkspaceProfile(database, 'official.ai'); } finally { database.close(); }
  const workspace = existing ?? { id: workspaceId, displayName: input.displayName ?? 'AI', rootPath: root.path };
  if (!existing) await writeWorkspaceRegistry(input.registryPath, { version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace], switchJournal: null });
  return workspace;
}

export async function createOfficialWorkspace(input: { registryPath: string; rootPath: string; templateId: OfficialTemplateId }): Promise<WorkspaceRecord> {
  const registry = await readWorkspaceRegistry(input.registryPath);
  await mkdir(input.rootPath, { recursive: true });
  const entries = await readdir(input.rootPath);
  if (entries.length > 0 && !entries.includes('wmb.db')) throw Object.assign(new Error('新工作空间必须使用空目录。'), { code: 'VALIDATION_ERROR' });
  const root = await openDataRoot(input.rootPath);
  migrateDatabase(path.join(root.path, 'wmb.db')).close();
  const existingId = await readRootWorkspaceId(root.path);
  const workspaceId = existingId ?? randomUUID();
  if (registry.workspaces.some((workspace) => workspace.id === workspaceId || workspace.rootPath === root.path)) {
    throw workspaceError('WORKSPACE_ID_MISMATCH', '该工作空间已登记。');
  }
  writeRootWorkspaceId(root.path, workspaceId);
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try { ensureOfficialWorkspaceProfile(database, input.templateId); } finally { database.close(); }
  const workspace = { id: workspaceId, displayName: OFFICIAL_WORKSPACE_TEMPLATES[input.templateId].displayName, rootPath: root.path };
  await writeWorkspaceRegistry(input.registryPath, { ...registry, workspaces: [...registry.workspaces, workspace] });
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

export async function beginWorkspaceSwitch(input: { registryPath: string; targetWorkspaceId: string }): Promise<WorkspaceSwitchJournal> {
  const registry = await readWorkspaceRegistry(input.registryPath);
  if (registry.switchJournal) throw workspaceError('WORKSPACE_NOT_FOUND', '已有未恢复的工作空间切换。');
  if (!registry.activeWorkspaceId) throw workspaceError('WORKSPACE_NOT_FOUND', '当前没有活动工作空间。');
  if (!registry.workspaces.some((workspace) => workspace.id === input.targetWorkspaceId)) throw workspaceError('WORKSPACE_NOT_FOUND', '未找到目标工作空间。');
  if (registry.activeWorkspaceId === input.targetWorkspaceId) throw workspaceError('WORKSPACE_NOT_FOUND', '目标工作空间已处于活动状态。');
  const switchJournal = { previousWorkspaceId: registry.activeWorkspaceId, pendingWorkspaceId: input.targetWorkspaceId, state: 'pending' } as const;
  await writeWorkspaceRegistry(input.registryPath, { ...registry, switchJournal });
  return switchJournal;
}

export async function markWorkspaceSwitchAttempting(registryPath: string): Promise<WorkspaceSwitchJournal | null> {
  const registry = await readWorkspaceRegistry(registryPath);
  if (!registry.switchJournal) return null;
  const switchJournal = { ...registry.switchJournal, state: 'attempting' as const };
  await writeWorkspaceRegistry(registryPath, { ...registry, switchJournal });
  return switchJournal;
}

export async function finishWorkspaceSwitch(registryPath: string, workspaceId: string): Promise<WorkspaceRegistry> {
  const registry = await readWorkspaceRegistry(registryPath);
  if (!registry.switchJournal || registry.switchJournal.pendingWorkspaceId !== workspaceId) throw workspaceError('WORKSPACE_NOT_FOUND', '没有匹配的待切换工作空间。');
  const next = { ...registry, activeWorkspaceId: workspaceId, switchJournal: null };
  await writeWorkspaceRegistry(registryPath, next);
  return next;
}

export async function rollbackWorkspaceSwitch(registryPath: string): Promise<WorkspaceRegistry> {
  const registry = await readWorkspaceRegistry(registryPath);
  if (!registry.switchJournal) return registry;
  const next = { ...registry, activeWorkspaceId: registry.switchJournal.previousWorkspaceId, switchJournal: null };
  await writeWorkspaceRegistry(registryPath, next);
  return next;
}
