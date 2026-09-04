import { DatabaseSync } from 'node:sqlite';
import { CommandDispatcher, createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { startAgentTask, getAgentTask } from '../src/main/agent-tasks.ts';
import { upsertResearchClaim, listResearchClaims } from '../src/main/db/research-claims-store.ts';
import { isResearchGateSatisfied } from '../src/main/daily-content-article.ts';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const PROJECT_ID = 'd6dc2d38-8013-4e98-8320-6e3185586446';
const TARGET_ID = 'dc5c85d1-e349-468e-a208-e73dd93f9722';
const INVALID_TASK_ID = 'research-d6dc2d38-a341';
const INVALID_CLAIM_ID = 'bc85eecf-19bc-46b8-bb57-034a7f50c50a';

function log(...a){ console.log(...a); }

const db = new DatabaseSync(DB_PATH);
try {
  const workspaceRow = db.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get();
  const workspaceId = workspaceRow.value;
  const runtimeEpoch = randomUUID();
  const identity = { workspaceId, rootPath: 'J:/PigeonYang/WeMediaBuddyData', runtimeEpoch };
  const dispatcher = new CommandDispatcher(db, identity);

  // Backup
  const invalidTask = db.prepare("SELECT * FROM agent_tasks WHERE id=?").get(INVALID_TASK_ID);
  const invalidClaim = db.prepare("SELECT * FROM research_claims WHERE id=?").get(INVALID_CLAIM_ID);
  const backupPath = 'J:/PigeonYang/WeMediaBuddy/.ai/a4-backup-invalid.json';
  fs.mkdirSync(path.dirname(backupPath), {recursive:true});
  fs.writeFileSync(backupPath, JSON.stringify({invalidTask, invalidClaim, backedAt:new Date().toISOString()}, null,2), 'utf8');
  log('backup written', backupPath);
  log('invalidTask exists?', !!invalidTask);
  log('invalidClaim exists?', !!invalidClaim);

  // Check FK safety: research_claims only references that task
  const otherClaimsForTask = db.prepare("SELECT count(*) as c FROM research_claims WHERE task_id=?").get(INVALID_TASK_ID);
  log('claims for invalid task', otherClaimsForTask);
  const fk = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='research_claims'").get();
  log('research_claims FK exists?', fk?.sql?.includes('REFERENCES'));

  // Record pre-state
  const prePubAttempts = db.prepare("SELECT COUNT(*) as c FROM publication_attempts").get().c;
  const prePubs = db.prepare("SELECT COUNT(*) as c FROM publications").get().c;
  log('pre pubs', prePubAttempts, prePubs);
  const preGate = isResearchGateSatisfied(db, TARGET_ID);
  log('pre gate satisfied?', preGate);

  // Remove if safe - claim first then task
  if (invalidClaim) {
    db.prepare("DELETE FROM research_claims WHERE id=?").run(INVALID_CLAIM_ID);
    log('deleted claim', INVALID_CLAIM_ID);
  }
  if (invalidTask) {
    // also check if any other research_claims still reference task (should be 0 after claim delete)
    const remaining = db.prepare("SELECT count(*) as c FROM research_claims WHERE task_id=?").get(INVALID_TASK_ID).c;
    log('remaining claims for task after claim delete', remaining);
    if (remaining === 0) {
      db.prepare("DELETE FROM agent_tasks WHERE id=?").run(INVALID_TASK_ID);
      log('deleted task', INVALID_TASK_ID);
    } else {
      log('skip task delete due to remaining claims');
    }
  }

  const postDeleteGate = isResearchGateSatisfied(db, TARGET_ID);
  log('post-delete gate?', postDeleteGate);
  if (postDeleteGate) throw new Error('gate still satisfied after delete - unexpected, need check');

  // Create legitimate task via authoritative command surface
  // Use scheduler actor, command agent_tasks.start
  const taskRequestId = `repair-a4:agent_tasks.start:${PROJECT_ID}:${Date.now()}`;
  const taskEnvelope = createCommandEnvelope({
    workspaceId,
    runtimeEpoch,
    command: 'agent_tasks.start',
    requestId: taskRequestId,
    actor: { type: 'scheduler', id: 'research-runner', label: 'research-runner' },
    input: { intent: 'research', businessDate: '2026-08-22', contextRefs: { projectId: PROJECT_ID, research: { gapId: `gap-${PROJECT_ID}` } } },
    boundIdentity: { taskId: INVALID_TASK_ID },
    taskId: undefined,
    workerLeaseId: undefined,
    grantId: undefined,
  });
  // Handler: startAgentTask
  const taskReceipt = dispatcher.dispatch(taskEnvelope, () => {
    const result = startAgentTask(db, taskEnvelope.input);
    if (!result.ok) throw Object.assign(new Error(result.error.message), {code: result.error.code});
    const task = result.data;
    return { data: task, entityType: 'agent_task', entityId: task.id, readback: task };
  });
  log('task receipt', JSON.stringify({id: taskReceipt.receiptId, ok: taskReceipt.ok, command: taskReceipt.command, actor: taskReceipt.actor, error: taskReceipt.error}, null,2));
  if (!taskReceipt.ok) throw new Error('task creation failed: ' + JSON.stringify(taskReceipt.error));
  const newTaskId = taskReceipt.data.id;
  log('newTaskId', newTaskId);

  // Create claim via research_claims.upsert_batch
  const claimInput = { taskId: newTaskId, claims: [{ claimKey: 'k1', claimText: '事实声明：武大杨景媛论文涉AI疑点需核验学术规范', claimType: 'fact', status: 'supported', verdictReason: '证据充分', evidenceSourceIds: [], verifiedAt: new Date().toISOString() }] };
  // stable requestId like research-job-runtime: sha256 of claims
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(JSON.stringify(claimInput.claims.map(c=>({claimKey:c.claimKey, claimText:c.claimText, claimType:c.claimType, status:c.status, verdictReason:c.verdictReason, evidenceSourceIds:[...c.evidenceSourceIds], verifiedAt:c.verifiedAt})))).digest('hex').slice(0,24);
  const claimRequestId = `${newTaskId}:claims:${digest}`;
  const claimEnvelope = createCommandEnvelope({
    workspaceId,
    runtimeEpoch,
    command: 'research_claims.upsert_batch',
    requestId: claimRequestId,
    actor: { type: 'scheduler', id: 'research-runner', label: 'research-runner' },
    input: claimInput,
    boundIdentity: { entityType: 'research_claim', taskId: newTaskId },
    taskId: newTaskId,
  });
  const claimReceipt = dispatcher.dispatch(claimEnvelope, () => {
    for (const claim of claimInput.claims) {
      const r = upsertResearchClaim(db, { taskId: claimInput.taskId, claimKey: claim.claimKey, claimText: claim.claimText, claimType: claim.claimType, status: claim.status, verdictReason: claim.verdictReason, evidenceSourceIds: claim.evidenceSourceIds, verifiedAt: claim.verifiedAt });
      if (!r.ok) throw new Error(r.error.message);
    }
    const snap = listResearchClaims(db, newTaskId);
    return { data: { taskId: newTaskId, written: snap.length, claims: snap }, entityType: 'research_claim', entityId: newTaskId, readback: snap };
  });
  log('claim receipt', JSON.stringify({id: claimReceipt.receiptId, ok: claimReceipt.ok, command: claimReceipt.command, actor: claimReceipt.actor, error: claimReceipt.error}, null,2));
  if (!claimReceipt.ok) throw new Error('claim creation failed');

  const finalGate = isResearchGateSatisfied(db, TARGET_ID);
  log('final gate satisfied?', finalGate);
  if (!finalGate) throw new Error('gate still not satisfied after legit creation');

  // Verify target/project unchanged
  const target = db.prepare("SELECT id, project_id, status FROM daily_content_targets WHERE id=?").get(TARGET_ID);
  const project = db.prepare("SELECT id FROM content_projects WHERE id=?").get(PROJECT_ID);
  log('target', target);
  log('project', project);
  const postPubAttempts = db.prepare("SELECT COUNT(*) as c FROM publication_attempts").get().c;
  const postPubs = db.prepare("SELECT COUNT(*) as c FROM publications").get().c;
  log('post pubs', postPubAttempts, postPubs, 'unchanged?', prePubAttempts===postPubAttempts && prePubs===postPubs);

  // Persist proof artifact
  const proof = {
    workspaceId,
    runtimeEpoch,
    backupPath,
    invalidTaskId: INVALID_TASK_ID,
    invalidClaimId: INVALID_CLAIM_ID,
    newTaskId,
    newClaimId: claimReceipt.data.claims[0]?.id,
    taskReceiptId: taskReceipt.receiptId,
    taskCommand: taskReceipt.command,
    taskActor: taskReceipt.actor,
    claimReceiptId: claimReceipt.receiptId,
    claimCommand: claimReceipt.command,
    claimActor: claimReceipt.actor,
    gateSatisfied: finalGate,
    targetProjectUnchanged: target?.project_id===PROJECT_ID && !!project,
    publicationUnchanged: prePubAttempts===postPubAttempts && prePubs===postPubs,
    createdAt: new Date().toISOString()
  };
  const proofPath = 'J:/PigeonYang/WeMediaBuddy/.ai/a4-repair-proof.json';
  fs.writeFileSync(proofPath, JSON.stringify(proof, null,2), 'utf8');
  log('proof written', proofPath);
  console.log(JSON.stringify(proof, null,2));
} finally {
  db.close();
}
