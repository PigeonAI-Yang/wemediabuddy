import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openBrowserProfileRegistry } from '../src/main/browser-config.ts';
import { initializeWorkspaceBrowserBinding } from '../src/main/workspace-browser-binding.ts';
import { expectedAccount, reservePort, waitForWorkspace, killPortOwner, delay } from './wmb-4809-package-helpers.mjs';

const execFileAsync = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const executable = path.resolve(process.env.WMB_PACKAGE_EXE || path.join(repo, 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe'));
const outer = await mkdtemp(path.join(os.tmpdir(), 'wmb-4812-pi-diag-'));
const parent = path.join(outer, 'parent');
const userData = path.join(parent, 'user-data');
const cdpPort = await reservePort();
let launched;
let browser;

try {
  await mkdir(parent, { recursive: true });
  await execFileAsync(process.execPath, [path.join(repo, 'scripts', 'eval-029-fixtures.mjs'), 'materialize', '--parent', parent], {
    cwd: repo,
    env: { ...process.env, WMB_EVAL_029_ALLOW_TEMP: '1' },
    timeout: 120_000,
    windowsHide: true
  });
  const fixture = JSON.parse(await readFile(path.join(repo, 'tests', 'fixtures', 'eval-029-workspaces.v1.json'), 'utf8'));
  const roots = Object.fromEntries(Object.entries(fixture.roots).map(([key, value]) => [key, path.join(parent, value.directoryName)]));
  const registry = openBrowserProfileRegistry(path.join(userData, 'browser-config.json'));
  for (const key of ['ai', 'uk']) {
    const database = new DatabaseSync(path.join(roots[key], 'wmb.db'));
    try {
      const expected = expectedAccount(key, registry.defaultProfileId);
      const binding = initializeWorkspaceBrowserBinding(database, registry.defaultProfileId, expected);
      database.prepare(`UPDATE platform_accounts
        SET account_key=?, display_name=?, login_state='authenticated', evidence_url=?,
            browser_profile_id=?, browser_binding_revision=?, verified_at=?,
            updated_at=?, revision=revision+1
        WHERE platform='x'`).run(
        expected.x.accountKey,
        expected.x.displayName,
        expected.x.evidenceUrl,
        binding.profileId,
        binding.bindingRevision,
        expected.x.verifiedAt,
        expected.x.verifiedAt
      );
      const aligned = database.prepare("SELECT revision FROM platform_accounts WHERE platform='x'").get();
      const snapshot = JSON.parse(JSON.stringify(binding.expectedAccountSnapshot));
      snapshot.x.accountRevision = aligned.revision;
      database.prepare("UPDATE workspace_browser_bindings SET expected_account_snapshot_json=? WHERE id='effective'")
        .run(JSON.stringify(snapshot));
    } finally {
      database.close();
    }
  }

  const installedUserData = process.env.WMB_ACCEPTANCE_INSTALLED_USER_DATA
    || path.join(process.env.APPDATA ?? '', 'WeMediaBuddy');
  const installed = process.env.WMB_ACCEPTANCE_PI_CONFIG || path.join(installedUserData, 'pi-api-config.json');
  await access(installed);
  await access(path.join(installedUserData, 'Local State'));
  await mkdir(userData, { recursive: true });
  await copyFile(installed, path.join(userData, 'pi-api-config.json'));
  await copyFile(path.join(installedUserData, 'Local State'), path.join(userData, 'Local State'));
  launched = spawn(executable, [], {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      WMB_ACCEPTANCE_USER_DATA: userData,
      WMB_ACCEPTANCE_CDP_PORT: String(cdpPort),
      WMB_ACCEPTANCE_HEADLESS: '1',
      WMB_XHS_MCP_DISABLED: '1'
    },
    stdio: 'ignore',
    windowsHide: true
  });

  const connection = await waitForWorkspace(cdpPort, fixture.roots.ai.workspaceId);
  browser = connection.browser;
  const page = connection.page;
  const settings = await page.evaluate(() => window.wmb.getSettings());
  console.log(JSON.stringify({
    pi: settings?.pi ?? null,
    mcpUrl: settings?.mcp?.url ?? null,
    workspaceId: settings?.workspace?.id ?? null
  }, null, 2));

  await page.evaluate(() => {
    window.__diagEvents = [];
    window.wmb.onPiEvent((event) => { window.__diagEvents.push(event); });
    return true;
  });
  await page.evaluate(({ businessDate, projectId }) => {
    window.__diagDraft = window.wmb.startStudioDraft({ businessDate, projectId });
    return true;
  }, { businessDate: '2026-08-06', projectId: fixture.roots.ai.ids.project });

  let task = null;
  let draft = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    task = await page.evaluate(({ intent, businessDate }) => window.wmb.getAgentTask({ intent, businessDate }), {
      intent: 'studio_draft',
      businessDate: '2026-08-06'
    });
    draft = await page.evaluate(async () => {
      const promise = window.__diagDraft;
      if (!promise) return null;
      return Promise.race([
        promise.then((value) => ({ settled: true, value }), (error) => ({
          settled: true,
          error: error instanceof Error ? error.message : String(error)
        })),
        new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 50))
      ]);
    });
    if ((task && task.status === 'running') || draft?.settled) break;
    await delay(250);
  }

  const events = await page.evaluate(() => window.__diagEvents?.slice(0, 30) ?? []);
  console.log(JSON.stringify({ task, draft, eventCount: events.length, events }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await killPortOwner(cdpPort).catch(() => {});
  if (launched?.pid) {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `if(Get-Process -Id ${launched.pid} -ErrorAction SilentlyContinue){Stop-Process -Id ${launched.pid} -Force}`
    ], { windowsHide: true, timeout: 10_000 }).catch(() => {});
  }
  await rm(outer, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
