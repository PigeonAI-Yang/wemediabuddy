import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { captureDataRoot, verifyBaseline } from '../scripts/workspace-baseline.mjs';
import { beginWorkspaceSwitch, enrollAiWorkspace, finishWorkspaceSwitch, markWorkspaceSwitchAttempting, readRootWorkspaceId, readWorkspaceRegistry, relinkWorkspace, rollbackWorkspaceSwitch } from '../src/main/workspaces.ts';

const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-workspace-registry-'));
try {
  const originalRoot = path.join(parent, 'ai');
  const registryPath = path.join(parent, 'user-data', 'workspace-registry.json');
  const root = await openDataRoot(originalRoot);
  migrateDatabase(path.join(root.path, 'wmb.db')).close();
  const baseline = { schema: 'wmb.workspace-baseline.v1', root: await captureDataRoot(root.path) };
  const workspace = await enrollAiWorkspace({ registryPath, rootPath: root.path });
  assert.equal(await readRootWorkspaceId(root.path), workspace.id);
  assert.deepEqual(await verifyBaseline(root.path, baseline).then((result) => result.violations), []);

  const movedRoot = path.join(parent, 'moved-ai');
  await rename(root.path, movedRoot);
  const relinked = await relinkWorkspace({ registryPath, workspaceId: workspace.id, rootPath: movedRoot });
  assert.equal(relinked.rootPath, movedRoot);
  assert.equal((await readWorkspaceRegistry(registryPath)).workspaces[0].rootPath, movedRoot);

  const otherRoot = await openDataRoot(path.join(parent, 'other'));
  migrateDatabase(path.join(otherRoot.path, 'wmb.db')).close();
  const otherWorkspace = await enrollAiWorkspace({ registryPath: path.join(parent, 'other-user-data', 'workspace-registry.json'), rootPath: otherRoot.path });
  await assert.rejects(() => relinkWorkspace({ registryPath, workspaceId: workspace.id, rootPath: otherRoot.path }), { code: 'WORKSPACE_ID_MISMATCH' });
  assert.equal((await readWorkspaceRegistry(registryPath)).workspaces[0].rootPath, movedRoot);

  const registry = await readWorkspaceRegistry(registryPath);
  await writeFile(registryPath, JSON.stringify({ ...registry, workspaces: [...registry.workspaces, otherWorkspace] }), 'utf8');
  assert.deepEqual(await beginWorkspaceSwitch({ registryPath, targetWorkspaceId: otherWorkspace.id }), { previousWorkspaceId: workspace.id, pendingWorkspaceId: otherWorkspace.id, state: 'pending' });
  assert.equal((await markWorkspaceSwitchAttempting(registryPath))?.state, 'attempting');
  assert.equal((await finishWorkspaceSwitch(registryPath, otherWorkspace.id)).activeWorkspaceId, otherWorkspace.id);
  await beginWorkspaceSwitch({ registryPath, targetWorkspaceId: workspace.id });
  assert.equal((await rollbackWorkspaceSwitch(registryPath)).activeWorkspaceId, otherWorkspace.id);
} finally {
  await rm(parent, { recursive: true, force: true, maxRetries: 3 });
}
