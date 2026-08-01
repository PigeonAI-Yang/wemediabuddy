import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDataRoot } from '../src/main/data-root.ts';
import { createDataRootSelection } from '../src/main/data-root-selection.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { WorkspaceRuntimeGate } from '../src/main/workspace-runtime.ts';
import { enrollAiWorkspace, markWorkspaceSwitchAttempting, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-workspace-switch-'));
try {
  const userData = path.join(parent, 'user-data');
  const registryPath = path.join(userData, 'workspace-registry.json');
  const aiRoot = await createRoot(path.join(parent, 'ai'));
  const ukRoot = await createRoot(path.join(parent, 'uk'));
  const ai = await enrollAiWorkspace({ registryPath, rootPath: aiRoot.path, displayName: 'AI' });
  const uk = await enrollAiWorkspace({ registryPath: path.join(parent, 'uk-registry.json'), rootPath: ukRoot.path, displayName: 'UK' });
  await writeFile(registryPath, JSON.stringify({ version: 1, activeWorkspaceId: ai.id, workspaces: [ai, uk], switchJournal: null }), 'utf8');
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: aiRoot.path }), 'utf8');

  let relaunched = 0;
  const first = selection(userData, { relaunch: () => { relaunched += 1; } });
  await first.switchWorkspace(uk.id);
  assert.equal(relaunched, 1);
  assert.equal((await readWorkspaceRegistry(registryPath)).switchJournal?.state, 'pending');
  assert.equal((await readWorkspaceRegistry(registryPath)).activeWorkspaceId, ai.id);

  const recovered = await selection(userData).loadSelectedDataRoot();
  assert.equal(recovered?.path, ukRoot.path);
  assert.equal((await readWorkspaceRegistry(registryPath)).activeWorkspaceId, uk.id);
  assert.equal((await readWorkspaceRegistry(registryPath)).switchJournal, null);

  const now = new Date().toISOString();
  const aiDbPath = path.join(aiRoot.path, 'wmb.db');
  const aiDb = new DatabaseSync(aiDbPath);
  aiDb.prepare('INSERT INTO jobs (id, kind, status, due_at, dedupe_key, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('switch-sentinel', 'metric_capture', 'running', now, 'switch-sentinel', '{}', now, now);
  aiDb.exec('ALTER TABLE source_items RENAME TO source_items_broken');
  aiDb.close();

  await selection(userData).switchWorkspace(ai.id);
  const rolledBack = await selection(userData).loadSelectedDataRoot();
  assert.equal(rolledBack?.path, ukRoot.path);
  assert.equal((await readWorkspaceRegistry(registryPath)).activeWorkspaceId, uk.id);
  const unchanged = new DatabaseSync(aiDbPath, { readOnly: true });
  assert.equal(unchanged.prepare("SELECT status FROM jobs WHERE id = 'switch-sentinel'").get().status, 'running');
  unchanged.close();

  const repair = new DatabaseSync(aiDbPath);
  repair.exec('ALTER TABLE source_items_broken RENAME TO source_items');
  repair.close();
  await selection(userData).switchWorkspace(ai.id);
  await markWorkspaceSwitchAttempting(registryPath);
  const afterKilledAttempt = await selection(userData).loadSelectedDataRoot();
  assert.equal(afterKilledAttempt?.path, ukRoot.path);
  assert.equal((await readWorkspaceRegistry(registryPath)).activeWorkspaceId, uk.id);

  let refreshed = 0;
  const relinkOnly = selection(userData, { chooseDirectory: async () => aiRoot.path, refreshRuntime: async () => { refreshed += 1; } });
  const stillActive = await relinkOnly.chooseDataRoot();
  assert.equal(stillActive?.path, ukRoot.path);
  assert.equal((await readWorkspaceRegistry(registryPath)).activeWorkspaceId, uk.id);
  assert.equal(refreshed, 0);
} finally {
  await rm(parent, { recursive: true, force: true, maxRetries: 3 });
}

async function createRoot(rootPath) {
  const root = await openDataRoot(rootPath);
  migrateDatabase(path.join(root.path, 'wmb.db')).close();
  return root;
}

function selection(userData, overrides = {}) {
  const gate = new WorkspaceRuntimeGate();
  return createDataRootSelection({
    userDataPath: () => userData,
    chooseDirectory: overrides.chooseDirectory ?? (async () => null),
    refreshRuntime: overrides.refreshRuntime ?? (async () => {}),
    canSwitch: async () => {},
    closeMutationGate: () => gate.closeAndDrain(),
    openMutationGate: () => gate.reopen(),
    stopRuntime: async () => {},
    relaunch: overrides.relaunch ?? (() => {})
  });
}
