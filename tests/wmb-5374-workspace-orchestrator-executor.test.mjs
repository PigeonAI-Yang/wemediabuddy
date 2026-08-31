import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createWebsiteSource } from '../src/main/intelligence-channels.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { initializeWorkspaceOrchestratorRuntime, submitWorkspaceOrchestratorIntent } from '../src/main/workspace-orchestrator-runtime.ts';

const BUSINESS_DATE = '2026-09-01';

async function waitFor(read, debug, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`executor terminal readback timeout: ${JSON.stringify(debug())}`);
}

test('WMB-5374 packaged manifest binds the runtime build row to exact app.asar identity', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-5374-manifest-'));
  const manifestDirectory = path.join(directory, 'resources');
  fs.mkdirSync(manifestDirectory, { recursive: true });
  const appAsar = Buffer.from('wmb-5374-packaged-app-asar');
  fs.writeFileSync(path.join(manifestDirectory, 'app.asar'), appAsar);
  const appAsarHash = createHash('sha256').update(appAsar).digest('hex');
  const packageHash = createHash('sha256').update('wmb-5374-package').digest('hex');
  const manifestPath = path.join(manifestDirectory, 'wmb-build-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, sourceCommit: 'wmb-5374-test', packageHash, appAsarHash, appAsar: 'app.asar' }));
  const previousManifest = process.env.WMB_BUILD_MANIFEST_PATH;
  let runtime;
  try {
    process.env.WMB_BUILD_MANIFEST_PATH = manifestPath;
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    database.prepare(`INSERT INTO app_meta(key, value, created_at, updated_at, revision)
      VALUES('workspace_id', 'wmb-5374-manifest', datetime('now'), datetime('now'), 1)`).run();
    database.close();
    runtime = ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-wmb-5374-manifest' });
    const state = await initializeWorkspaceOrchestratorRuntime(runtime);
    assert.equal(state.buildManifest.buildId, `wmb-runtime-${state.buildManifest.schemaEpoch}-${packageHash.slice(0, 12)}`);
    assert.equal(state.buildManifest.sourceCommit, 'wmb-5374-test');
    assert.equal(state.buildManifest.packageHash, packageHash);
    assert.equal(state.buildManifest.appAsarHash, appAsarHash);
    await runtime.stop({ drain: false });
    runtime = null;
    const expiredDatabase = migrateDatabase(path.join(directory, 'wmb.db'));
    expiredDatabase.prepare(`UPDATE workspace_orchestrator_actors SET lease_expires_at_utc=?, lease_expires_at_mono=0,
      control_stall_deadline_utc=?, control_stall_deadline_mono=0, gate_deadline_utc=?, gate_deadline_mono=0 WHERE workspace_id=?`).run(
      '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 'wmb-5374-manifest');
    expiredDatabase.close();
    const nextAppAsar = Buffer.from('wmb-5374-packaged-app-asar-next');
    fs.writeFileSync(path.join(manifestDirectory, 'app.asar'), nextAppAsar);
    const nextAppAsarHash = createHash('sha256').update(nextAppAsar).digest('hex');
    const nextPackageHash = createHash('sha256').update('wmb-5374-package-next').digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, sourceCommit: 'wmb-5374-test-next', packageHash: nextPackageHash, appAsarHash: nextAppAsarHash, appAsar: 'app.asar' }));
    runtime = ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-wmb-5374-manifest-next' });
    const nextState = await initializeWorkspaceOrchestratorRuntime(runtime);
    assert.equal(nextState.buildManifest.packageHash, nextPackageHash);
    assert.equal(nextState.actor.migrationEpoch, 2);
    assert.equal(nextState.migration.migrationEpoch, 2);
  } finally {
    if (previousManifest === undefined) delete process.env.WMB_BUILD_MANIFEST_PATH;
    else process.env.WMB_BUILD_MANIFEST_PATH = previousManifest;
    await runtime?.stop({ drain: false });
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('WMB-5374 accepted scan intent is consumed through source snapshot and terminal projection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-5374-executor-'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><head><title>WMB executor canary</title></head><body><article><h1>AI infrastructure canary</h1><p>Production mailbox executor verification.</p></article></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/canary`;
  let runtime;
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    database.prepare(`INSERT INTO app_meta(key, value, created_at, updated_at, revision)
      VALUES('workspace_id', 'wmb-5374-executor', datetime('now'), datetime('now'), 1)`).run();
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    createWebsiteSource(database, {
      inputText: url,
      name: 'WMB executor canary',
      canonicalUrl: url,
      resolutionStatus: 'ready',
      trialRead: { url, title: 'WMB executor canary', readable: true },
      notify: false,
    });
    database.close();

    runtime = ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-wmb-5374' });
    await initializeWorkspaceOrchestratorRuntime(runtime);
    runtime.setMcp({ url: 'http://127.0.0.1:1/mcp', close: async () => {} });
    const receipt = await submitWorkspaceOrchestratorIntent(runtime, {
      producerId: 'mcp.daily-run-stage',
      businessDate: BUSINESS_DATE,
      requestId: 'wmb-5374-executor-scan',
      action: 'scan',
      logicalInput: { businessDate: BUSINESS_DATE, modules: ['official_web'] },
      payload: { businessDate: BUSINESS_DATE, modules: ['official_web'] },
      channelPolicy: [{ channelId: 'official_web', requiredness: 'required', module: 'official_web' }],
      rootMode: 'owner',
    });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    const terminal = await waitFor(() => runtime.database.prepare(`SELECT i.status intent_status, i.stop_reason_json, m.state mailbox_state, r.status root_status,
      (SELECT e.event_type || ':' || e.payload_json FROM orchestrator_events e WHERE e.workspace_id=i.workspace_id AND e.intent_id=i.intent_id ORDER BY e.event_sequence DESC LIMIT 1) last_event,
      (SELECT COUNT(*) FROM source_snapshots s WHERE s.workspace_id=i.workspace_id AND s.root_request_id=r.root_request_id AND s.status='frozen') source_snapshot_count,
      (SELECT COUNT(*) FROM daily_plan_scopes p WHERE p.workspace_id=i.workspace_id AND p.root_request_id=r.root_request_id AND p.scope_status='frozen') scope_count,
      (SELECT COUNT(*) FROM daily_stage_claims c WHERE c.workspace_id=i.workspace_id AND c.root_request_id=r.root_request_id AND c.is_active=1) active_claim_count,
      (SELECT COUNT(*) FROM managed_job_dispatches d WHERE d.workspace_id=i.workspace_id AND d.root_request_id=r.root_request_id AND d.state NOT IN ('terminal','cancelled','orphaned')) active_dispatch_count
      FROM orchestrator_intents i
      JOIN orchestrator_mailbox m ON m.workspace_id=i.workspace_id AND m.intent_id=i.intent_id
      LEFT JOIN daily_orchestration_roots r ON r.workspace_id=i.workspace_id AND r.intent_id=i.intent_id
      WHERE i.request_id=? AND m.state IN ('succeeded','partial','failed','needs_user','cancelled')`).get('wmb-5374-executor-scan'), () => runtime.database.prepare(`SELECT i.status intent_status, m.state mailbox_state, r.status root_status,
        (SELECT json_group_array(json_object('attempt', c.attempt_stage, 'status', c.status)) FROM daily_stage_claims c WHERE c.workspace_id=i.workspace_id AND c.root_request_id=r.root_request_id) claims,
        (SELECT json_group_array(json_object('state', d.state, 'request', d.stage_request_id)) FROM managed_job_dispatches d WHERE d.workspace_id=i.workspace_id AND d.root_request_id=r.root_request_id) dispatches
        FROM orchestrator_intents i JOIN orchestrator_mailbox m ON m.workspace_id=i.workspace_id AND m.intent_id=i.intent_id
        LEFT JOIN daily_orchestration_roots r ON r.workspace_id=i.workspace_id AND r.intent_id=i.intent_id WHERE i.request_id=?`).get('wmb-5374-executor-scan'));

    assert.ok(['succeeded', 'partial'].includes(terminal.intent_status), JSON.stringify(terminal));
    assert.ok(['succeeded', 'partial'].includes(terminal.mailbox_state), JSON.stringify(terminal));
    assert.ok(['succeeded', 'partial'].includes(terminal.root_status), JSON.stringify(terminal));
    assert.equal(terminal.source_snapshot_count, 1);
    assert.equal(terminal.scope_count, 1);
    assert.equal(terminal.active_claim_count, 0);

    const actorBeforeIdle = runtime.database.prepare('SELECT owner_epoch FROM workspace_orchestrator_actors WHERE workspace_id=?').get(runtime.identity.workspaceId);
    await runtime.runActorControlPlane(() => runtime.database.prepare(`UPDATE workspace_orchestrator_actors SET
      lease_expires_at_utc=?, lease_expires_at_mono=0, control_stall_deadline_utc=?, control_stall_deadline_mono=0,
      gate_deadline_utc=?, gate_deadline_mono=0 WHERE workspace_id=?`).run(
      '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', runtime.identity.workspaceId));

    const schedulerReceipt = await submitWorkspaceOrchestratorIntent(runtime, {
      producerId: 'scheduler.daily-0900',
      businessDate: BUSINESS_DATE,
      requestId: 'scheduler.daily-0900:wmb-5374-executor:2026-09-01',
      action: 'stage_d',
      logicalInput: { businessDate: BUSINESS_DATE, source: 'scheduler_0900' },
      payload: { businessDate: BUSINESS_DATE, source: 'scheduler_0900' },
      rootMode: 'scheduler',
    });
    assert.equal(schedulerReceipt.ok, true, JSON.stringify(schedulerReceipt));
    const schedulerTerminal = await waitFor(() => runtime.database.prepare(`SELECT i.status intent_status, m.state mailbox_state,
      r.root_request_id, r.status root_status, r.root_mode, r.source,
      (SELECT COUNT(*) FROM daily_stage_claims c WHERE c.workspace_id=i.workspace_id AND c.root_request_id=r.root_request_id AND json_extract(c.snapshot_json, '$.stageD.version')='StageDTargetEffectSnapshotV1') stage_d_snapshot_count,
      (SELECT COUNT(*) FROM daily_stage_claims c WHERE c.workspace_id=i.workspace_id AND c.root_request_id=r.root_request_id AND c.is_active=1) active_claim_count,
      (SELECT COUNT(*) FROM managed_job_dispatches d WHERE d.workspace_id=i.workspace_id AND d.root_request_id=r.root_request_id AND d.state NOT IN ('terminal','cancelled','orphaned')) active_dispatch_count
      FROM orchestrator_intents i JOIN orchestrator_mailbox m ON m.workspace_id=i.workspace_id AND m.intent_id=i.intent_id
      JOIN daily_orchestration_roots r ON r.workspace_id=i.workspace_id AND r.intent_id=i.intent_id
      WHERE i.request_id=? AND m.state IN ('succeeded','partial','failed','needs_user','cancelled')`).get('scheduler.daily-0900:wmb-5374-executor:2026-09-01'), () => runtime.database.prepare(`SELECT i.status intent_status, m.state mailbox_state FROM orchestrator_intents i JOIN orchestrator_mailbox m ON m.intent_id=i.intent_id WHERE i.request_id=?`).get('scheduler.daily-0900:wmb-5374-executor:2026-09-01'));
    assert.equal(schedulerTerminal.intent_status, 'succeeded', JSON.stringify(schedulerTerminal));
    assert.equal(schedulerTerminal.mailbox_state, 'succeeded', JSON.stringify(schedulerTerminal));
    assert.equal(schedulerTerminal.root_status, 'succeeded', JSON.stringify(schedulerTerminal));
    assert.equal(schedulerTerminal.root_mode, 'scheduler');
    assert.equal(schedulerTerminal.source, 'scheduler_0900');
    assert.equal(schedulerTerminal.stage_d_snapshot_count, 1);
    assert.equal(schedulerTerminal.active_claim_count, 0);
    assert.equal(schedulerTerminal.active_dispatch_count, 0);
    const actorAfterIdle = runtime.database.prepare('SELECT owner_epoch FROM workspace_orchestrator_actors WHERE workspace_id=?').get(runtime.identity.workspaceId);
    assert.ok(Number(actorAfterIdle.owner_epoch) > Number(actorBeforeIdle.owner_epoch));
    const ownerRoot = runtime.database.prepare(`SELECT r.root_request_id FROM orchestrator_intents i JOIN daily_orchestration_roots r ON r.intent_id=i.intent_id WHERE i.request_id=?`).get('wmb-5374-executor-scan');
    assert.notEqual(schedulerTerminal.root_request_id, ownerRoot.root_request_id);
    assert.equal(terminal.active_dispatch_count, 0);
  } finally {
    await runtime?.stop({ drain: false });
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});
