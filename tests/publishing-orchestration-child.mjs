import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { initializeWorkspaceBrowserBinding, markWorkspaceBrowserBindingVerified } from '../src/main/workspace-browser-binding.ts';
import { dispatchCreatePublicationSnapshot, dispatchPreparePublicationEditor } from '../src/main/publication-commands.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-publication-orchestration-'));
const dbPath = path.join(directory, 'wmb.db');
const workspaceId = 'workspace-publication-orchestration';
const runtimeEpoch = 'runtime-publication-orchestration';
const setupAt = '2026-08-06T00:00:00.000Z';
const profileId = 'profile-publication-orchestration';
const accountKey = '@orchestration-owner';
const assetId = 'asset-publication-orchestration';
let setup;
let runtime;

try {
  setup = migrateDatabase(dbPath);
  setup.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
    .run(workspaceId, setupAt, setupAt);
  initializeWorkspaceBrowserBinding(setup, profileId);
  const binding = markWorkspaceBrowserBindingVerified(setup, {
    profileId, expectedBindingRevision: 1,
    account: { platform: 'x', accountKey, displayName: 'Orchestration Owner', loginState: 'authenticated', evidenceUrl: 'https://x.com/orchestration-owner' }
  });
  setup.prepare(`INSERT INTO assets(id,relative_path,mime_type,byte_count,sha256,origin,created_at,updated_at,revision)
    VALUES (?,?,?,?,?,'user',?,?,1)`).run(assetId, 'assets/orchestration.png', 'image/png', 13, 'c'.repeat(64), setupAt, setupAt);
  const project = createContentProject(setup, { title: 'orchestration project' });
  const core = saveCoreVersion(setup, { projectId: project.id, body: 'core', expectedRevision: 1 });
  assert.equal(core.ok, true);
  const version = savePlatformVersion(setup, {
    projectId: project.id, contentVersionId: core.data.id, platform: 'x', format: 'image',
    title: 'Frozen orchestration title', body: 'Frozen orchestration body', assetIds: [assetId]
  });
  assert.equal(version.ok, true);
  setup.close();
  setup = null;

  runtime = ActiveWorkspaceRuntime.open(directory, {
    expectedWorkspaceId: workspaceId,
    createEpoch: () => runtimeEpoch,
    openDatabase: migrateDatabase
  });
  const started = [];
  const invoked = [];
  let adapterBusyRejected = false;
  const fakeBrowserRuntime = Object.freeze({ cdpUrl: 'fake://orchestration', stop: async () => {} });
  const frozenProfile = Object.freeze({ id: profileId, label: 'Frozen profile' });
  const frozenBinding = Object.freeze({ profileId, bindingRevision: binding.bindingRevision });
  const frozenIdentity = Object.freeze({ platform: 'x', accountKey, displayName: 'Orchestration Owner', loginState: 'authenticated', evidenceUrl: 'https://x.com/orchestration-owner' });
  const fakeBrowser = Object.freeze({ profile: frozenProfile, binding: frozenBinding, identity: frozenIdentity, runtime: fakeBrowserRuntime });
  const startBrowser = async (database, platform, options) => {
    const beforeStart = database.prepare('SELECT state FROM publication_browser_operations WHERE id=?').get(prepared.operation.id);
    const grantBeforeStart = database.prepare(`SELECT g.status, g.command, g.expected_account AS expectedAccount
      FROM publication_browser_operations o JOIN execution_grants g ON g.id=o.execution_grant_id WHERE o.id=?`).get(prepared.operation.id);
    started.push({ database, platform, options, operationState: beforeStart.state, grant: grantBeforeStart });
    return fakeBrowser;
  };
  const invokeEditor = async (activeRuntime, snapshot, cdpUrl) => {
    const beforeAdapter = runtime.database.prepare('SELECT state FROM publication_browser_operations WHERE id=?').get(prepared.operation.id);
    invoked.push({ activeRuntime, snapshot, cdpUrl, operationState: beforeAdapter.state });
    await assert.rejects(() => runtime.closeClaimsAndDrain(), { code: 'WORKSPACE_BUSY' });
    adapterBusyRejected = true;
    return { title: 'Frozen orchestration title', body: 'Frozen orchestration body', assetIds: [assetId], evidenceUrl: 'https://x.com/compose/orchestration' };
  };
  const setBrowser = (browser) => {
    assert.equal(browser, fakeBrowserRuntime);
    return runtime.bindBrowser(browser);
  };

  const snapshotReceipt = await dispatchCreatePublicationSnapshot(runtime, { platformVersionId: version.data.id, requestId: 'orchestration-snapshot' });
  assert.equal(snapshotReceipt.ok, true);
  const prepared = snapshotReceipt.data;
  assert.equal(prepared.operation.state, 'prepared');
  const request = { publicationId: prepared.publication.id, expectedRevision: prepared.publication.revision, requestId: 'orchestration-prepare' };
  const prepareReceipt = await dispatchPreparePublicationEditor(runtime, request, setBrowser, { startBrowser, invokeEditor });
  assert.equal(prepareReceipt.ok, true);
  assert.equal(prepareReceipt.sideEffectState, 'committed');
  assert.equal(adapterBusyRejected, true);
  assert.equal(started.length, 1);
  assert.equal(invoked.length, 1);
  assert.equal(started[0].operationState, 'execution_granted');
  assert.equal(started[0].grant.status, 'consumed');
  assert.equal(started[0].database, runtime.database);
  assert.equal(started[0].grant.command, 'publication.editor_prepare_execute');
  assert.equal(started[0].grant.expectedAccount, accountKey);
  assert.equal(started[0].platform, 'x');
  assert.equal(started[0].options.mode, 'quiet');
  assert.equal(invoked[0].operationState, 'executing');
  assert.equal(invoked[0].activeRuntime, runtime);
  assert.equal(invoked[0].snapshot.id, prepared.snapshot.id);
  assert.deepEqual(invoked[0].snapshot.payload, prepared.snapshot.payload);
  assert.equal(invoked[0].snapshot.browserProfileId, frozenProfile.id);
  assert.equal(invoked[0].snapshot.browserBindingRevision, frozenBinding.bindingRevision);
  assert.equal(invoked[0].snapshot.accountKey, accountKey);
  assert.equal(invoked[0].cdpUrl, fakeBrowserRuntime.cdpUrl);

  const operation = runtime.database.prepare('SELECT state, readback_json AS readback, evidence_json AS evidence FROM publication_browser_operations WHERE id=?').get(prepared.operation.id);
  const publication = runtime.database.prepare('SELECT status, prepared_title AS title, prepared_body AS body, prepared_assets_json AS assets FROM publications WHERE id=?').get(prepared.publication.id);
  assert.equal(operation.state, 'succeeded');
  assert.equal(publication.status, 'awaiting_confirmation');
  assert.equal(publication.title, 'Frozen orchestration title');
  assert.equal(publication.body, 'Frozen orchestration body');
  assert.deepEqual(JSON.parse(publication.assets), [{ id: assetId, mimeType: 'image/png', relativePath: 'assets/orchestration.png', sha256: 'c'.repeat(64), byteCount: 13 }]);
  assert.equal(JSON.parse(operation.readback).title, 'Frozen orchestration title');
  assert.equal(JSON.parse(operation.evidence).editorEvidenceUrl, 'https://x.com/compose/orchestration');
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_attempts WHERE publication_id=?').get(prepared.publication.id).count, 0);
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_confirmations WHERE publication_id=?').get(prepared.publication.id).count, 0);

  const replay = await dispatchPreparePublicationEditor(runtime, request, setBrowser, { startBrowser, invokeEditor });
  assert.equal(replay.receiptId, prepareReceipt.receiptId);
  assert.equal(JSON.stringify(replay), JSON.stringify(prepareReceipt));
  assert.equal(started.length, 1);
  assert.equal(invoked.length, 1);
  const mismatchSnapshot = await dispatchCreatePublicationSnapshot(runtime, { platformVersionId: version.data.id, requestId: 'orchestration-mismatch-snapshot' });
  await assert.rejects(() => dispatchPreparePublicationEditor(runtime, {
    publicationId: mismatchSnapshot.data.publication.id,
    expectedRevision: mismatchSnapshot.data.publication.revision,
    requestId: request.requestId
  }, setBrowser, { startBrowser, invokeEditor }), (error) => error.code === 'REQUEST_REPLAY_CONFLICT');
  assert.equal(started.length, 1);
  assert.equal(invoked.length, 1);

  const mismatchStarted = [];
  const mismatchInvoked = [];
  await assert.rejects(() => dispatchPreparePublicationEditor(runtime, {
    publicationId: mismatchSnapshot.data.publication.id, expectedRevision: mismatchSnapshot.data.publication.revision, requestId: 'orchestration-mismatch-prepare'
  }, setBrowser, {
    startBrowser: async () => { mismatchStarted.push(true); return { ...fakeBrowser, identity: { ...frozenIdentity, accountKey: '@wrong-account' } }; },
    invokeEditor: async () => { mismatchInvoked.push(true); return { title: 'wrong', body: 'wrong', assetIds: [], evidenceUrl: 'wrong' }; }
  }), (error) => error.code === 'ACCOUNT_MISMATCH');
  assert.equal(mismatchStarted.length, 1);
  assert.equal(mismatchInvoked.length, 0);
  const mismatchOperation = runtime.database.prepare('SELECT state, evidence_json AS evidence FROM publication_browser_operations WHERE id=?').get(mismatchSnapshot.data.operation.id);
  assert.equal(mismatchOperation.state, 'needs_user');
  assert.equal(mismatchOperation.evidence, '{}');
  const identityMismatchCases = [
    ['profile', { ...fakeBrowser, profile: { ...frozenProfile, id: 'wrong-profile' } }, 'BROWSER_PROFILE_MISMATCH'],
    ['binding', { ...fakeBrowser, binding: { ...frozenBinding, bindingRevision: frozenBinding.bindingRevision + 1 } }, 'BROWSER_BINDING_STALE']
  ];
  for (const [label, mismatchedBrowser, expectedCode] of identityMismatchCases) {
    const snapshot = await dispatchCreatePublicationSnapshot(runtime, { platformVersionId: version.data.id, requestId: `orchestration-${label}-snapshot` });
    let adapterInvoked = false;
    await assert.rejects(() => dispatchPreparePublicationEditor(runtime, {
      publicationId: snapshot.data.publication.id, expectedRevision: snapshot.data.publication.revision, requestId: `orchestration-${label}-prepare`
    }, setBrowser, {
      startBrowser: async () => mismatchedBrowser,
      invokeEditor: async () => { adapterInvoked = true; return { title: 'wrong', body: 'wrong', assetIds: [], evidenceUrl: 'wrong' }; }
    }), (error) => error.code === expectedCode);
    assert.equal(adapterInvoked, false);
    const operation = runtime.database.prepare('SELECT state, evidence_json AS evidence FROM publication_browser_operations WHERE id=?').get(snapshot.data.operation.id);
    assert.equal(operation.state, 'needs_user');
    assert.equal(operation.evidence, '{}');
  }
} finally {
  if (runtime) await runtime.stop({ drain: false }).catch(() => {});
  if (setup) setup.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
