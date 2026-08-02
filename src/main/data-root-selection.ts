import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDataRoot, validateDataRoot, type DataRoot } from './data-root.ts';
import { migrateDatabase } from './db/migrations.ts';
import { recoverInterruptedPublications } from './publishing.ts';
import { recoverRunningMetricJobs, scheduleJobsForPublishedPublications } from './metrics.ts';
import { recoverInterruptedAgentTasks } from './agent-tasks.ts';
import {
  beginWorkspaceSwitch,
  createOfficialWorkspace,
  enrollAiWorkspace,
  finishWorkspaceSwitch,
  markWorkspaceSwitchAttempting,
  readRootWorkspaceId,
  readWorkspaceRegistry,
  relinkWorkspace,
  rollbackWorkspaceSwitch
} from './workspaces.ts';

export function createDataRootSelection(input: {
  userDataPath: () => string;
  chooseDirectory: () => Promise<string | null>;
  refreshRuntime: (dataRoot: DataRoot) => Promise<void>;
  canSwitch: (dataRoot: DataRoot) => Promise<void>;
  closeMutationGate: () => Promise<void>;
  openMutationGate: () => void;
  stopRuntime: () => Promise<void>;
  relaunch: () => void;
}) {
  let recoveredAgentTasks = false;
  let switching = false;
  const dataRootConfigPath = () => path.join(input.userDataPath(), 'data-root.json');
  const registryPath = () => path.join(input.userDataPath(), 'workspace-registry.json');
  function migrate(dataRoot: DataRoot, options: { recoverAgentTasks?: boolean } = {}): DataRoot {
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    recoverInterruptedPublications(database);
    if (options.recoverAgentTasks) {
      recoverInterruptedAgentTasks(database);
      recoverRunningMetricJobs(database);
      scheduleJobsForPublishedPublications(database);
    }
    database.close();
    return dataRoot;
  }
  function validateWorkspaceStartup(dataRoot: DataRoot): DataRoot {
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      if (integrity?.integrity_check !== 'ok') throw new Error('工作空间数据库完整性检查失败。');
      database.prepare('SELECT (SELECT COUNT(*) FROM source_items) AS sources, (SELECT COUNT(*) FROM content_projects) AS projects, (SELECT COUNT(*) FROM jobs) AS jobs').get();
    } finally { database.close(); }
    return dataRoot;
  }
  async function loadSelectedDataRoot(): Promise<DataRoot | null> {
    try {
      const registry = await readWorkspaceRegistry(registryPath());
      if (registry.switchJournal) return recoverWorkspaceSwitch(registry);
      const active = registry.workspaces.find((workspace) => workspace.id === registry.activeWorkspaceId);
      const rootPath = active?.rootPath ?? (JSON.parse(await readFile(dataRootConfigPath(), 'utf8')) as { path: string }).path;
      const shouldRecover = !recoveredAgentTasks;
      recoveredAgentTasks = true;
      const dataRoot = migrate(await validateDataRoot(rootPath), { recoverAgentTasks: shouldRecover });
      await enrollAiWorkspace({ registryPath: registryPath(), rootPath: dataRoot.path });
      return dataRoot;
    } catch { return null; }
  }
  async function recoverWorkspaceSwitch(registry: Awaited<ReturnType<typeof readWorkspaceRegistry>>): Promise<DataRoot | null> {
    const journal = registry.switchJournal;
    if (!journal) return null;
    const restorePrevious = async (): Promise<DataRoot | null> => {
      const previous = registry.workspaces.find((item) => item.id === journal.previousWorkspaceId);
      if (!previous || await readRootWorkspaceId(previous.rootPath) !== previous.id) return null;
      const dataRoot = validateWorkspaceStartup(await validateDataRoot(previous.rootPath));
      await rollbackWorkspaceSwitch(registryPath());
      await writeFile(dataRootConfigPath(), JSON.stringify({ path: dataRoot.path }), 'utf8');
      return migrate(dataRoot, { recoverAgentTasks: true });
    };
    if (journal.state === 'attempting') return restorePrevious();
    await markWorkspaceSwitchAttempting(registryPath());
    const workspace = registry.workspaces.find((item) => item.id === journal.pendingWorkspaceId);
    let targetDataRoot: DataRoot;
    try {
      if (!workspace || await readRootWorkspaceId(workspace.rootPath) !== workspace.id) throw new Error('工作空间根身份无效。');
      targetDataRoot = validateWorkspaceStartup(await validateDataRoot(workspace.rootPath));
      await writeFile(dataRootConfigPath(), JSON.stringify({ path: targetDataRoot.path }), 'utf8');
      await finishWorkspaceSwitch(registryPath(), workspace.id);
    } catch {
      return restorePrevious();
    }
    return migrate(targetDataRoot, { recoverAgentTasks: true });
  }
  async function chooseDataRoot(): Promise<DataRoot | null> {
    const selectedPath = await input.chooseDirectory();
    if (!selectedPath) return null;
    const registry = await readWorkspaceRegistry(registryPath());
    const dataRoot = registry.workspaces.length === 0
      ? migrate(await openDataRoot(selectedPath))
      : await validateDataRoot(selectedPath);
    if (registry.workspaces.length === 0) await enrollAiWorkspace({ registryPath: registryPath(), rootPath: dataRoot.path });
    else {
      const workspaceId = await readRootWorkspaceId(dataRoot.path);
      if (!workspaceId) throw new Error('所选目录不是已登记工作空间。');
      await relinkWorkspace({ registryPath: registryPath(), workspaceId, rootPath: dataRoot.path });
      if (workspaceId !== registry.activeWorkspaceId) return loadSelectedDataRoot();
    }
    await writeFile(dataRootConfigPath(), JSON.stringify({ path: dataRoot.path }), 'utf8');
    await input.refreshRuntime(dataRoot);
    return dataRoot;
  }
  async function switchWorkspace(targetWorkspaceId: string): Promise<void> {
    if (switching) throw Object.assign(new Error('工作空间切换已在进行。'), { code: 'WORKSPACE_BUSY' });
    const registry = await readWorkspaceRegistry(registryPath());
    const target = registry.workspaces.find((workspace) => workspace.id === targetWorkspaceId);
    const current = registry.workspaces.find((workspace) => workspace.id === registry.activeWorkspaceId);
    if (!target || !current || await readRootWorkspaceId(target.rootPath) !== target.id) throw new Error('目标工作空间不可用。');
    const currentRoot = await validateDataRoot(current.rootPath);
    switching = true;
    let journalStarted = false;
    try {
      await input.closeMutationGate();
      await input.canSwitch(currentRoot);
      await beginWorkspaceSwitch({ registryPath: registryPath(), targetWorkspaceId });
      journalStarted = true;
      await input.stopRuntime();
      input.relaunch();
    } catch (error) {
      if (journalStarted) {
        await rollbackWorkspaceSwitch(registryPath());
        await input.refreshRuntime(currentRoot);
      }
      input.openMutationGate();
      switching = false;
      throw error;
    }
  }
  async function createUkWorkspace() {
    const rootPath = await input.chooseDirectory();
    return rootPath ? createOfficialWorkspace({ registryPath: registryPath(), rootPath, templateId: 'official.uk' }) : null;
  }
  return { loadSelectedDataRoot, chooseDataRoot, migrate, switchWorkspace, createUkWorkspace, listWorkspaces: () => readWorkspaceRegistry(registryPath()) };
}
