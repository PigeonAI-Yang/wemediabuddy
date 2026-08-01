import { dialog } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDataRoot, validateDataRoot, type DataRoot } from './data-root.ts';
import { migrateDatabase } from './db/migrations.ts';
import { recoverInterruptedPublications } from './publishing.ts';
import { recoverRunningMetricJobs, scheduleJobsForPublishedPublications } from './metrics.ts';
import { recoverInterruptedAgentTasks } from './agent-tasks.ts';
import { enrollAiWorkspace, readRootWorkspaceId, readWorkspaceRegistry, relinkWorkspace } from './workspaces.ts';

export function createDataRootSelection(input: {
  userDataPath: () => string;
  refreshRuntime: (dataRoot: DataRoot) => Promise<void>;
}) {
  let recoveredAgentTasks = false;
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
  async function loadSelectedDataRoot(): Promise<DataRoot | null> {
    try {
      const { path: rootPath } = JSON.parse(await readFile(dataRootConfigPath(), 'utf8')) as { path: string };
      const shouldRecover = !recoveredAgentTasks;
      recoveredAgentTasks = true;
      const dataRoot = migrate(await validateDataRoot(rootPath), { recoverAgentTasks: shouldRecover });
      await enrollAiWorkspace({ registryPath: registryPath(), rootPath: dataRoot.path });
      return dataRoot;
    } catch { return null; }
  }
  async function chooseDataRoot(): Promise<DataRoot | null> {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const registry = await readWorkspaceRegistry(registryPath());
    const dataRoot = registry.workspaces.length === 0
      ? migrate(await openDataRoot(result.filePaths[0]))
      : migrate(await validateDataRoot(result.filePaths[0]));
    if (registry.workspaces.length === 0) await enrollAiWorkspace({ registryPath: registryPath(), rootPath: dataRoot.path });
    else {
      const workspaceId = await readRootWorkspaceId(dataRoot.path);
      if (!workspaceId) throw new Error('所选目录不是已登记工作空间。');
      await relinkWorkspace({ registryPath: registryPath(), workspaceId, rootPath: dataRoot.path });
    }
    await writeFile(dataRootConfigPath(), JSON.stringify({ path: dataRoot.path }), 'utf8');
    await input.refreshRuntime(dataRoot);
    return dataRoot;
  }
  return { loadSelectedDataRoot, chooseDataRoot, migrate };
}
