import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureDataRoot, verifyBaseline } from '../scripts/workspace-baseline.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-workspace-baseline-'));
try {
  await Promise.all(['assets', 'browser-profile', 'logs', 'exports', 'pi-agent', 'xiaohongshu-mcp'].map((name) => mkdir(path.join(root, name))));
  await Promise.all([
    writeFile(path.join(root, 'assets', 'asset.txt'), 'asset'),
    writeFile(path.join(root, 'exports', 'export.txt'), 'export'),
    writeFile(path.join(root, 'browser-profile', 'login-state.txt'), 'login'),
    writeFile(path.join(root, 'pi-agent', 'session.json'), '{}'),
    writeFile(path.join(root, 'xiaohongshu-mcp', 'state.json'), '{}')
  ]);
  const database = new DatabaseSync(path.join(root, 'wmb.db'));
  database.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE content_projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE platform_accounts (id TEXT PRIMARY KEY, account_key TEXT NOT NULL, revision INTEGER NOT NULL);
    INSERT INTO content_projects VALUES ('project-1', 'baseline', 1);
    INSERT INTO platform_accounts VALUES ('account-1', '@owner', 1);
  `);
  database.close();

  const baseline = { schema: 'wmb.workspace-baseline.v1', root: await captureDataRoot(root) };
  let verification = await verifyBaseline(root, baseline);
  assert.equal(verification.ok, true);

  const metadata = new DatabaseSync(path.join(root, 'wmb.db'));
  metadata.exec("INSERT INTO app_meta VALUES ('workspace_id', 'workspace-ai'); CREATE TABLE workspace_profiles (id TEXT PRIMARY KEY);");
  metadata.close();
  verification = await verifyBaseline(root, baseline);
  assert.equal(verification.ok, true);

  const changed = new DatabaseSync(path.join(root, 'wmb.db'));
  changed.exec("UPDATE content_projects SET revision = 2 WHERE id = 'project-1'");
  changed.close();
  verification = await verifyBaseline(root, baseline);
  assert.deepEqual(verification.violations, ['business table changed: content_projects']);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
