import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, waitForAppReady, closeApp } from '../tests/e2e/harness.mjs';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createWebsiteSource } from '../src/main/intelligence-channels.ts';
import { setDailyOrchestrationSchedule } from '../src/main/daily-orchestration.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const scheduleTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Date.now() + 65_000));
const installedRoot = 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0';
const packageManifest = JSON.parse(fs.readFileSync(`${installedRoot}/resources/wmb-build-manifest.json`, 'utf8'));

const launched = await launchApp({
  name: 'wmb-5374-installed-full-canary',
  appPath: installedRoot,
  headless: true,
  seedFixture: async ({ dataRoot }) => {
    const database = migrateDatabase(`${dataRoot}/wmb.db`);
    try {
      ensureOfficialWorkspaceProfile(database, 'official.ai');
      setDailyOrchestrationSchedule(database, { time: scheduleTime, autoEnabled: true });
      createWebsiteSource(database, {
        inputText: 'http://127.0.0.1:9/wmb-5374-canary',
        name: 'WMB-5374 installed executor canary',
        canonicalUrl: 'http://127.0.0.1:9/wmb-5374-canary',
        resolutionStatus: 'ready',
        trialRead: { url: 'http://127.0.0.1:9/wmb-5374-canary', title: 'WMB-5374 installed executor canary', readable: true },
        notify: false,
      });
    } finally { database.close(); }
  },
});

const { app, page, workspace } = launched;
const database = new DatabaseSync(`${workspace.dataRoot}/wmb.db`, { readOnly: true });
database.exec('PRAGMA busy_timeout=5000');
const readIntent = (producerId, requestId = null) => database.prepare(`SELECT i.intent_id intentId, i.request_id requestId, i.producer_id producerId, i.source, i.root_mode rootMode,
  i.status intentStatus, m.state mailboxState, r.root_request_id rootRequestId, r.root_generation rootGeneration, r.status rootStatus,
  (SELECT COUNT(*) FROM source_snapshots s WHERE s.workspace_id=i.workspace_id AND s.root_request_id=r.root_request_id AND s.status='frozen') sourceSnapshotCount,
  (SELECT COUNT(*) FROM daily_plan_scopes p WHERE p.workspace_id=i.workspace_id AND p.root_request_id=r.root_request_id AND p.scope_status='frozen') scopeCount,
  (SELECT COUNT(*) FROM daily_stage_claims c WHERE c.workspace_id=i.workspace_id AND c.root_request_id=r.root_request_id AND json_extract(c.snapshot_json, '$.stageD.version')='StageDTargetEffectSnapshotV1') stageDSnapshotCount
  FROM orchestrator_intents i JOIN orchestrator_mailbox m ON m.workspace_id=i.workspace_id AND m.intent_id=i.intent_id
  LEFT JOIN daily_orchestration_roots r ON r.workspace_id=i.workspace_id AND r.intent_id=i.intent_id
  WHERE i.producer_id=? AND (? IS NULL OR i.request_id=?) ORDER BY i.created_at DESC LIMIT 1`).get(producerId, requestId, requestId);
async function waitTerminal(producerId, requestId = null, timeoutMs = 95_000) {
  const deadline = Date.now() + timeoutMs;
  let row = null;
  while (Date.now() < deadline) {
    try {
      row = readIntent(producerId, requestId);
      if (row && ['succeeded', 'partial'].includes(row.intentStatus) && ['succeeded', 'partial'].includes(row.mailboxState)) return row;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SQLITE_ERROR')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`terminal timeout: ${JSON.stringify(row)}`);
}

try {
  await waitForAppReady(page);
  const pid = app.process()?.pid ?? null;
  assert.ok(Number.isInteger(pid) && pid > 0);
  const ownerSubmission = await page.evaluate(async (date) => window.wmb.startDailyIntelligence({ businessDate: date, modules: ['official_web'] }), businessDate);
  assert.equal(ownerSubmission.ok, true, JSON.stringify(ownerSubmission));
  const owner = await waitTerminal('today.agent-start-daily-intelligence', ownerSubmission.data.requestId, 30_000);
  assert.equal(owner.rootMode, 'owner');
  assert.equal(owner.source, 'today_ui');
  assert.equal(owner.sourceSnapshotCount, 1);
  assert.equal(owner.scopeCount, 1);

  const scheduler = await waitTerminal('scheduler.daily-0900', null, 240_000);
  assert.equal(scheduler.rootMode, 'scheduler');
  assert.equal(scheduler.source, 'scheduler_0900');
  assert.equal(scheduler.rootStatus, 'succeeded');
  assert.equal(scheduler.stageDSnapshotCount, 1);
  assert.notEqual(scheduler.rootRequestId, owner.rootRequestId);

  const disabled = await page.evaluate(async () => window.wmb.setDailyOrchestrationSchedule({ autoEnabled: false }));
  assert.ok(disabled);
  const cutoverSubmission = await page.evaluate(async (date) => window.wmb.orchestrateDailyContent(date, 'today'), businessDate);
  assert.equal(cutoverSubmission.ok, true, JSON.stringify(cutoverSubmission));
  const cutover = await waitTerminal('today.daily-orchestration', cutoverSubmission.requestId, 30_000);
  assert.equal(cutover.rootMode, 'owner');
  assert.equal(cutover.source, 'today_ui');
  assert.equal(cutover.stageDSnapshotCount, 1);
  assert.notEqual(cutover.rootRequestId, owner.rootRequestId);
  assert.notEqual(cutover.rootRequestId, scheduler.rootRequestId);

  const build = database.prepare(`SELECT b.*, a.workspace_id workspaceId, a.runtime_epoch runtimeEpoch, a.owner_epoch ownerEpoch, a.actor_status actorStatus, a.write_fence writeFence
    FROM workspace_orchestrator_actors a JOIN build_manifests b ON b.build_id=a.current_build_id`).get();
  assert.equal(build.package_hash, packageManifest.packageHash);
  assert.equal(build.app_asar_hash, packageManifest.appAsarHash);
  assert.equal(build.resources_path.replaceAll('\\', '/'), `${installedRoot}/resources`);
  const residual = database.prepare(`SELECT
    (SELECT COUNT(*) FROM orchestrator_intents WHERE status IN ('received','preflight_pending','preflight_running','waiting_resource','admitted','running','waiting_owner')) activeIntents,
    (SELECT COUNT(*) FROM daily_orchestration_roots WHERE status IN ('created','running','waiting_owner')) activeRoots,
    (SELECT COUNT(*) FROM daily_stage_claims WHERE is_active=1) activeClaims,
    (SELECT COUNT(*) FROM managed_job_dispatches WHERE state NOT IN ('terminal','cancelled','orphaned')) activeDispatches`).get();
  assert.deepEqual({ ...residual }, { activeIntents: 0, activeRoots: 0, activeClaims: 0, activeDispatches: 0 });
  console.log(JSON.stringify({ businessDate, scheduleTime, pid, packageManifest, build, owner, scheduler, cutover, residual, dataRoot: workspace.dataRoot }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ electronStdout: launched.evidence.electronStdout, electronStderr: launched.evidence.electronStderr, console: launched.evidence.console, errors: launched.evidence.errors, pageerrors: launched.evidence.pageerrors }, null, 2));
  throw error;
} finally {
  database.close();
  await closeApp(app).catch(() => {});
}
