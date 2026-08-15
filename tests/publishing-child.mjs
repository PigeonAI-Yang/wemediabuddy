import { mkdtemp, rm } from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { createPublication, createPublicationAttempt, reconcileAsNotPublished, recordReconciliation, recoverInterruptedPublications, transitionPublication } from '../src/main/publishing.ts';
import { initializeWorkspaceBrowserBinding, markWorkspaceBrowserBindingVerified } from '../src/main/workspace-browser-binding.ts';
import { completePublicationPreparation, createPublicationSnapshot, getPublicationBrowserOperation, getPublicationSnapshot, recoverInterruptedPublicationBrowserOperations, transitionPublicationBrowserOperation } from '../src/main/publication-operations.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-publishing-'));
try {
  const db = migrateDatabase(path.join(directory, 'wmb.db'));
  const project = createContentProject(db, { title: 'publish state' });
  const core = saveCoreVersion(db, { projectId: project.id, body: 'core', expectedRevision: 1 });
  if (!core.ok) throw new Error('core setup failed');
  const version = savePlatformVersion(db, { projectId: project.id, contentVersionId: core.data.id, platform: 'x', format: 'text', body: 'hello' });
  const account = saveAccount(db, { platform: 'x', accountKey: '@owner', displayName: 'Owner', loginState: 'authenticated', evidenceUrl: 'https://x.com/owner' });
  if (!version.ok) throw new Error('version setup failed');
  const created = createPublication(db, { platformVersionId: version.data.id, accountId: account.id });
  if (!created.ok || created.data.status !== 'draft') throw new Error('draft creation failed');
  const invalid = transitionPublication(db, created.data.id, 'published', { expectedRevision: 1, externalUrl: 'https://x.com/owner/status/1', externalId: '1' });
  if (invalid.ok || invalid.error.code !== 'INVALID_STATE') throw new Error('invalid transition accepted');
  const prepared = transitionPublication(db, created.data.id, 'prepared', { expectedRevision: 1 });
  const awaiting = prepared.ok && transitionPublication(db, created.data.id, 'awaiting_confirmation', { expectedRevision: prepared.data.revision });
  const publishing = awaiting && awaiting.ok && transitionPublication(db, created.data.id, 'publishing', { expectedRevision: awaiting.data.revision });
  if (!publishing || !publishing.ok) throw new Error('publishing transition failed');
  const attempt = createPublicationAttempt(db, created.data.id);
  if (!attempt.ok || attempt.data.attemptNumber !== 1) throw new Error('attempt creation failed');
  const unknown = transitionPublication(db, created.data.id, 'unknown', { expectedRevision: publishing.data.revision, reason: 'readback interrupted' });
  if (!unknown.ok) throw new Error('unknown transition failed');
  const reconciliation = recordReconciliation(db, { publicationId: created.data.id, attemptId: attempt.data.id, outcome: 'ambiguous', evidence: { candidates: 2 } });
  if (!reconciliation.ok) throw new Error('reconciliation persistence failed');
  const stillUnknown = db.prepare('SELECT status FROM publications WHERE id = ?').get(created.data.id);
  const attemptState = db.prepare('SELECT status, finished_at AS finishedAt FROM publication_attempts WHERE id = ?').get(attempt.data.id);
  const evidence = db.prepare('SELECT evidence_json AS evidence FROM publication_reconciliations WHERE id = ?').get(reconciliation.data.id);
  if (stillUnknown.status !== 'unknown' || attemptState.status !== 'unknown' || !attemptState.finishedAt || JSON.parse(evidence.evidence).candidates !== 2) throw new Error('unknown evidence mismatch');
  const published = transitionPublication(db, created.data.id, 'published', { expectedRevision: unknown.data.revision, externalUrl: 'https://x.com/owner/status/1', externalId: '1' });
  const terminal = published.ok && transitionPublication(db, created.data.id, 'failed', { expectedRevision: published.data.revision });
  if (!published.ok || !terminal || terminal.ok || terminal.error.code !== 'INVALID_STATE') throw new Error('terminal state mismatch');
  const second = createPublication(db, { platformVersionId: version.data.id, accountId: account.id });
  if (!second.ok) throw new Error('second publication setup failed');
  const secondPrepared = transitionPublication(db, second.data.id, 'prepared', { expectedRevision: 1 });
  const secondAwaiting = secondPrepared.ok && transitionPublication(db, second.data.id, 'awaiting_confirmation', { expectedRevision: secondPrepared.data.revision });
  const secondPublishing = secondAwaiting && secondAwaiting.ok && transitionPublication(db, second.data.id, 'publishing', { expectedRevision: secondAwaiting.data.revision });
  if (!secondPublishing || !secondPublishing.ok) throw new Error('second publishing setup failed');
  const secondAttempt = createPublicationAttempt(db, second.data.id);
  const secondUnknown = secondAttempt.ok && transitionPublication(db, second.data.id, 'unknown', { expectedRevision: secondPublishing.data.revision });
  const resolved = secondUnknown && secondUnknown.ok && reconcileAsNotPublished(db, { publicationId: second.data.id, expectedRevision: secondUnknown.data.revision, evidence: { checked: true } });
  if (!resolved || !resolved.ok || resolved.data.status !== 'failed' || db.prepare('SELECT COUNT(*) AS count FROM publication_attempts WHERE publication_id = ?').get(second.data.id).count !== 1) throw new Error('controlled unknown reconciliation retried publication');
  const events = db.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_id = ?').get(created.data.id);
  if (events.count !== 6) throw new Error(`event timeline mismatch: ${events.count}`);
  const interrupted = createPublication(db, { platformVersionId: version.data.id, accountId: account.id });
  const interruptedPrepared = interrupted.ok && transitionPublication(db, interrupted.data.id, 'prepared', { expectedRevision: interrupted.data.revision });
  const interruptedAwaiting = interruptedPrepared && interruptedPrepared.ok && transitionPublication(db, interrupted.data.id, 'awaiting_confirmation', { expectedRevision: interruptedPrepared.data.revision });
  const interruptedPublishing = interruptedAwaiting && interruptedAwaiting.ok && transitionPublication(db, interrupted.data.id, 'publishing', { expectedRevision: interruptedAwaiting.data.revision });
  if (!interruptedPublishing || !interruptedPublishing.ok || !createPublicationAttempt(db, interrupted.data.id).ok) throw new Error('interrupted publication setup failed');
  db.close();
  const reopened = migrateDatabase(path.join(directory, 'wmb.db'));
  recoverInterruptedPublications(reopened);
  const recovered = reopened.prepare('SELECT status, revision FROM publications WHERE id = ?').get(interrupted.data.id);
  const recoveredAttempt = reopened.prepare('SELECT status, error_code AS errorCode FROM publication_attempts WHERE publication_id = ?').get(interrupted.data.id);
  if (recovered.status !== 'unknown' || recoveredAttempt.status !== 'unknown' || recoveredAttempt.errorCode !== 'PUBLICATION_UNKNOWN') throw new Error('restart did not preserve publication uncertainty');
  const recoveredRevision = recovered.revision;
  recoverInterruptedPublications(reopened);
  if (reopened.prepare('SELECT revision FROM publications WHERE id = ?').get(interrupted.data.id).revision !== recoveredRevision) throw new Error('restart recovery was not idempotent');

  const workspaceId = 'workspace-publication-persistence'; const runtimeEpoch = 'runtime-publication-persistence';
  const setupAt = '2026-08-06T00:00:00.000Z';
  reopened.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
    .run(workspaceId, setupAt, setupAt);
  initializeWorkspaceBrowserBinding(reopened, 'profile-publication');
  const verifiedBinding = markWorkspaceBrowserBindingVerified(reopened, {
    profileId: 'profile-publication', expectedBindingRevision: 1,
    account: { platform: 'x', accountKey: '@owner', displayName: 'Owner', loginState: 'authenticated', evidenceUrl: 'https://x.com/owner' }
  });
  const verifiedAccount = reopened.prepare("SELECT id, revision FROM platform_accounts WHERE platform='x'").get();
  reopened.prepare(`INSERT INTO assets(id,relative_path,mime_type,byte_count,sha256,origin,created_at,updated_at,revision)
    VALUES (?,?,?,?,?,'user',?,?,1)`).run('asset-publication-a', 'assets/publication-a.png', 'image/png', 11, 'a'.repeat(64), setupAt, setupAt);
  reopened.prepare(`INSERT INTO assets(id,relative_path,mime_type,byte_count,sha256,origin,created_at,updated_at,revision)
    VALUES (?,?,?,?,?,'user',?,?,1)`).run('asset-publication-b', 'assets/publication-b.png', 'image/png', 12, 'b'.repeat(64), setupAt, setupAt);
  const frozenVersion = savePlatformVersion(reopened, {
    projectId: project.id, contentVersionId: core.data.id, platform: 'x', format: 'image', title: 'Frozen title', body: 'Frozen body',
    assetIds: ['asset-publication-b', 'asset-publication-a']
  });
  if (!frozenVersion.ok || verifiedBinding.bindingRevision !== 2) throw new Error('immutable publication fixture setup failed');
  const snapshotInput = (causation) => ({
    platformVersionId: frozenVersion.data.id, accountId: verifiedAccount.id, browserProfileId: 'profile-publication',
    browserBindingRevision: verifiedBinding.bindingRevision, workspaceId, runtimeEpoch,
    payload: { title: 'Frozen title', body: 'Frozen body', assets: [{ id: 'asset-publication-b', sha256: 'b'.repeat(64) }, { id: 'asset-publication-a', sha256: 'a'.repeat(64) }] },
    causation
  });
  const publicationCountBeforeInvalid = reopened.prepare('SELECT COUNT(*) AS count FROM publications').get().count;
  const staleBinding = createPublicationSnapshot(reopened, { ...snapshotInput({ actor: 'owner_ui', requestId: 'stale-binding' }), browserBindingRevision: 1 });
  const stalePayload = createPublicationSnapshot(reopened, { ...snapshotInput({ actor: 'owner_ui', requestId: 'stale-payload' }), payload: { title: 'Wrong', body: 'Frozen body', assets: ['asset-publication-b', 'asset-publication-a'] } });
  if (staleBinding.ok || staleBinding.error.code !== 'PROFILE_STALE' || stalePayload.ok || stalePayload.error.code !== 'CONFIRMATION_STALE'
    || reopened.prepare('SELECT COUNT(*) AS count FROM publications').get().count !== publicationCountBeforeInvalid) throw new Error('invalid snapshot reference created persistence rows');
  const firstSnapshot = createPublicationSnapshot(reopened, snapshotInput({ requestId: 'same-request', actor: 'owner_ui' }));
  const leasedSnapshot = createPublicationSnapshot(reopened, snapshotInput({ actor: 'owner_ui', requestId: 'same-request' }));
  const executingSnapshot = createPublicationSnapshot(reopened, snapshotInput({ actor: 'owner_ui', requestId: 'executing-request' }));
  const pendingSnapshot = createPublicationSnapshot(reopened, snapshotInput({ actor: 'owner_ui', requestId: 'pending-request' }));
  if (!firstSnapshot.ok || !leasedSnapshot.ok || !executingSnapshot.ok || !pendingSnapshot.ok) throw new Error('publication snapshot creation failed');
  if (firstSnapshot.data.snapshot.inputHash !== leasedSnapshot.data.snapshot.inputHash) throw new Error('canonical snapshot hash depends on object key order');
  const exactSnapshot = getPublicationSnapshot(reopened, firstSnapshot.data.snapshot.id);
  if (!exactSnapshot || exactSnapshot.payload.title !== 'Frozen title' || exactSnapshot.payload.body !== 'Frozen body'
    || exactSnapshot.assets.map((asset) => `${asset.id}:${asset.sha256}`).join('|') !== `asset-publication-b:${'b'.repeat(64)}|asset-publication-a:${'a'.repeat(64)}`
    || exactSnapshot.accountRevision !== verifiedAccount.revision || exactSnapshot.browserBindingRevision !== 2) throw new Error('immutable snapshot facts mismatch');
  let updateRejected = false; let deleteRejected = false;
  try { reopened.prepare("UPDATE publication_snapshots SET payload_json='{}' WHERE id=?").run(exactSnapshot.id); } catch (error) { updateRejected = String(error).includes('PUBLICATION_SNAPSHOT_IMMUTABLE'); }
  try { reopened.prepare('DELETE FROM publication_snapshots WHERE id=?').run(exactSnapshot.id); } catch (error) { deleteRejected = String(error).includes('PUBLICATION_SNAPSHOT_IMMUTABLE'); }
  if (!updateRejected || !deleteRejected) throw new Error('publication snapshot mutation was not rejected');

  const seedGrant = (id, inputHash) => reopened.prepare(`INSERT INTO execution_grants(id,workspace_id,runtime_epoch,task_id,task_grant_id,
    command,input_hash,bound_identity_json,target_actor_type,target_actor_id,browser_profile_id,binding_revision,expected_account,
    allowed_transition,required_readback_json,status,issued_at,expires_at,consumed_at,revoked_at,revision)
    VALUES (?,?,?,NULL,NULL,'publication.editor_prepare_execute',?,'{}','owner_ui','renderer','profile-publication',2,'@owner',
      'prepared->execution_granted','{}','consumed',?,'2027-08-06T00:00:00.000Z',?,NULL,2)`)
    .run(id, workspaceId, runtimeEpoch, inputHash, setupAt, setupAt);
  const prepareForBrowser = (created, grantId, finalState) => {
    seedGrant(grantId, created.data.snapshot.inputHash);
    const granted = transitionPublicationBrowserOperation(reopened, { operationId: created.data.operation.id, expectedRevision: 1, to: 'execution_granted', phase: 'execution_granted', executionGrantId: grantId });
    if (!granted.ok) throw new Error(`execution grant transition failed: ${grantId}`);
    const leased = transitionPublicationBrowserOperation(reopened, { operationId: granted.data.id, expectedRevision: granted.data.revision, to: 'browser_leased', phase: 'browser_leased' });
    if (!leased.ok || finalState === 'browser_leased') return leased;
    const executing = transitionPublicationBrowserOperation(reopened, { operationId: leased.data.id, expectedRevision: leased.data.revision, to: 'executing', phase: 'executing' });
    if (!executing.ok || finalState === 'executing') return executing;
    return transitionPublicationBrowserOperation(reopened, { operationId: executing.data.id, expectedRevision: executing.data.revision, to: 'readback_pending', phase: 'readback_pending', readback: { title: 'Frozen title', body: 'Frozen body', assetIds: ['asset-publication-b', 'asset-publication-a'] } });
  };
  const illegal = transitionPublicationBrowserOperation(reopened, { operationId: firstSnapshot.data.operation.id, expectedRevision: 1, to: 'browser_leased', phase: 'browser_leased' });
  if (illegal.ok || illegal.error.code !== 'INVALID_STATE') throw new Error('illegal browser transition accepted');
  const firstPending = prepareForBrowser(firstSnapshot, 'grant-publication-first', 'readback_pending');
  if (!firstPending.ok || firstPending.data.state !== 'readback_pending') throw new Error('legal browser transition chain failed');
  const stale = transitionPublicationBrowserOperation(reopened, { operationId: firstPending.data.id, expectedRevision: 1, to: 'unknown', phase: 'stale' });
  if (stale.ok || stale.error.code !== 'REVISION_CONFLICT') throw new Error('operation optimistic revision was not enforced');
  const genericSuccess = transitionPublicationBrowserOperation(reopened, { operationId: firstPending.data.id, expectedRevision: firstPending.data.revision, to: 'succeeded', phase: 'succeeded' });
  if (genericSuccess.ok || genericSuccess.error.code !== 'INVALID_STATE') throw new Error('generic transition bypassed atomic preparation completion');
  reopened.prepare(`UPDATE platform_versions SET title='Changed title', body='Changed body', asset_ids_json='[]', revision=revision+1 WHERE id=?`).run(frozenVersion.data.id);
  const completed = completePublicationPreparation(reopened, { operationId: firstPending.data.id, expectedRevision: firstPending.data.revision, editorEvidenceUrl: 'https://x.com/compose/post' });
  if (!completed.ok || completed.data.operation.state !== 'succeeded' || completed.data.publication.status !== 'awaiting_confirmation'
    || completed.data.publication.externalUrl !== null || completed.data.publication.externalId !== null || completed.data.publication.publishedAt !== null) throw new Error('manual final-publication boundary failed');
  const preparedRow = reopened.prepare('SELECT prepared_title AS title, prepared_body AS body, prepared_assets_json AS assets FROM publications WHERE id=?').get(completed.data.publication.id);
  if (preparedRow.title !== 'Frozen title' || preparedRow.body !== 'Frozen body' || JSON.parse(preparedRow.assets)[0].id !== 'asset-publication-b') throw new Error('completion did not use immutable snapshot');
  if (reopened.prepare('SELECT COUNT(*) AS count FROM publication_attempts WHERE publication_id=?').get(completed.data.publication.id).count !== 0
    || reopened.prepare('SELECT COUNT(*) AS count FROM publication_confirmations WHERE publication_id=?').get(completed.data.publication.id).count !== 0) throw new Error('editor preparation recorded a final publication attempt');

  const leased = prepareForBrowser(leasedSnapshot, 'grant-publication-leased', 'browser_leased');
  const executing = prepareForBrowser(executingSnapshot, 'grant-publication-executing', 'executing');
  const pending = prepareForBrowser(pendingSnapshot, 'grant-publication-pending', 'readback_pending');
  if (!leased.ok || !executing.ok || !pending.ok) throw new Error('interrupted browser operation setup failed');
  const interruptedRevisions = new Map([leased.data, executing.data, pending.data].map((operation) => [operation.id, operation.revision]));
  reopened.close();
  const browserReopened = migrateDatabase(path.join(directory, 'wmb.db'));
  if (recoverInterruptedPublicationBrowserOperations(browserReopened) !== 3) throw new Error('browser operation recovery count mismatch');
  const recoveredLeased = getPublicationBrowserOperation(browserReopened, leased.data.id);
  const recoveredExecuting = getPublicationBrowserOperation(browserReopened, executing.data.id);
  const recoveredPending = getPublicationBrowserOperation(browserReopened, pending.data.id);
  if (recoveredLeased.state !== 'needs_user' || recoveredExecuting.state !== 'needs_user' || recoveredPending.state !== 'unknown'
    || recoveredLeased.revision !== interruptedRevisions.get(recoveredLeased.id) + 1
    || recoveredExecuting.revision !== interruptedRevisions.get(recoveredExecuting.id) + 1
    || recoveredPending.revision !== interruptedRevisions.get(recoveredPending.id) + 1) throw new Error('restart recovery did not preserve interruption truth');
  if (recoverInterruptedPublicationBrowserOperations(browserReopened) !== 0) throw new Error('browser operation recovery was not idempotent');
  if (getPublicationBrowserOperation(browserReopened, leased.data.id).revision !== recoveredLeased.revision) throw new Error('restart recovery retried browser work');
  browserReopened.close();
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
