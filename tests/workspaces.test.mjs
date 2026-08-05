import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { captureDataRoot, verifyBaseline } from '../scripts/workspace-baseline.mjs';
import { beginWorkspaceSwitch, createOfficialWorkspace, enrollAiWorkspace, finishWorkspaceSwitch, markWorkspaceSwitchAttempting, readRootWorkspaceId, readWorkspaceRegistry, relinkWorkspace, rollbackWorkspaceSwitch } from '../src/main/workspaces.ts';
import { markWorkspaceBrowserBindingVerified, readWorkspaceBrowserBinding } from '../src/main/workspace-browser-binding.ts';

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
  const legacyRead = migrateDatabase(path.join(root.path, 'wmb.db'));
  assert.equal(readWorkspaceBrowserBinding(legacyRead), null);
  legacyRead.close();

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

test('new AI and UK roots explicitly share the default profile but keep independent binding and account revisions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-workspace-browser-bindings-'));
  const defaultProfileId = '4d84e0d3-b495-4a6f-a957-98f47cd5b61b';
  try {
    const registryPath = path.join(directory, 'workspace-registry.json');
    const aiRoot = path.join(directory, 'ai');
    const ukRoot = path.join(directory, 'uk');
    await enrollAiWorkspace({ registryPath, rootPath: aiRoot, defaultProfileId });
    await createOfficialWorkspace({ registryPath, rootPath: ukRoot, templateId: 'official.uk', defaultProfileId });

    for (const rootPath of [aiRoot, ukRoot]) {
      const database = migrateDatabase(path.join(rootPath, 'wmb.db'));
      const initial = readWorkspaceBrowserBinding(database);
      assert.equal(initial.profileId, defaultProfileId);
      assert.equal(initial.bindingRevision, 1);
      assert.equal(initial.state, 'unverified');
      markWorkspaceBrowserBindingVerified(database, {
        profileId: defaultProfileId,
        expectedBindingRevision: 1,
        account: { platform: 'x', accountKey: 'owner', displayName: 'Owner', loginState: 'authenticated' }
      });
      database.close();
    }

    const aiRead = migrateDatabase(path.join(aiRoot, 'wmb.db'));
    const ukRead = migrateDatabase(path.join(ukRoot, 'wmb.db'));
    assert.notEqual(
      aiRead.prepare("SELECT id FROM platform_accounts WHERE platform='x'").get().id,
      ukRead.prepare("SELECT id FROM platform_accounts WHERE platform='x'").get().id
    );
    const aiBinding = readWorkspaceBrowserBinding(aiRead);
    const ukBinding = readWorkspaceBrowserBinding(ukRead);
    assert.equal(aiBinding.profileId, defaultProfileId);
    assert.equal(ukBinding.profileId, defaultProfileId);
    assert.equal(aiBinding.bindingRevision, 2);
    assert.equal(ukBinding.bindingRevision, 2);
    assert.equal(aiBinding.expectedAccountSnapshot.x.accountKey, 'owner');
    assert.equal(ukBinding.expectedAccountSnapshot.x.accountKey, 'owner');
    aiRead.close(); ukRead.close();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
});
