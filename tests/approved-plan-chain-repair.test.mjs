import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { approvePlanItems, editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';
import { CommandDispatcher, createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { approvedPlanItemChainPreStateHash, repairApprovedPlanItemChain } from '../src/main/approved-plan-chain-repair.ts';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-approved-chain-repair-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try { await run(database, root); }
  finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function seedApproved(database) {
  const sourceId = upsertSource(database, {
    title: 'GLM-5.3 Flash 官方发布', originalUrl: 'https://example.com/glm-5-3-flash', summary: '官方发布并说明免费额度。'
  }, false).id;
  saveCurrentPlan(database, {
    planDate: '2026-08-28', timezone: 'Asia/Shanghai', summary: '历史批准链修复夹具',
    items: [{
      title: 'GLM-5.3 Flash 免费 100T：真正值得关注的不是免费两个字', priority: 1,
      whyNow: '官方刚发布，免费额度与国产算力是当前决策窗口。', timeliness: '热点 2-3 天',
      targetAudience: '正在评估国产模型调用成本的独立开发者',
      angle: '核对免费额度、算力来源与真实可用性。', pointOfView: '免费只有能稳定完成真实任务才有价值。',
      platforms: ['xiaohongshu'], formats: ['carousel'],
      titleGuidance: '标题兑现免费额度与真实交付之间的反差。', openingGuidance: '首段给出发布事实与额度。',
      structureGuidance: '发布事实→额度边界→真实使用判断。', effortEstimate: '90 分钟',
      sourceIds: [sourceId], availableMaterials: ['官方发布'], missingMaterials: [], scoreReasons: scoredReasons(87, '2026-08-28T08:00:00.000Z'), editorialDecision: editorialDecision('免费只有能稳定完成真实任务才有价值。')
    }]
  });
  const item = database.prepare('SELECT id, revision FROM plan_items').get();
  approvePlanItems(database, [item.id]);
  return database.prepare('SELECT id, revision FROM plan_items WHERE id=?').get(item.id);
}

function insertProject(database, planItemId, suffix = '') {
  const id = randomUUID();
  const now = new Date().toISOString();
  const item = database.prepare('SELECT topic_id AS topicId, title, source_ids_json AS sourceIds FROM plan_items WHERE id=?').get(planItemId);
  database.prepare(`INSERT INTO content_projects (id, topic_id, plan_item_id, title, created_at, updated_at, revision, status)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'drafting')`).run(id, item.topicId, planItemId, `${item.title}${suffix}`, now, now);
  for (const sourceId of JSON.parse(item.sourceIds)) {
    database.prepare('INSERT INTO content_project_sources (project_id, source_id) VALUES (?, ?)').run(id, sourceId);
  }
  return id;
}

function dispatchRepair(database, planItemId, requestId, rollbackBinding, thesisRepair, expectedRevisionOverride) {
  const expectedRevision = expectedRevisionOverride ?? database.prepare('SELECT revision FROM plan_items WHERE id=?').get(planItemId).revision;
  const workspaceId = 'approved-chain-repair-test-workspace';
  const identity = { workspaceId, rootPath: 'test', runtimeEpoch: 'repair-test-epoch' };
  const dispatcher = new CommandDispatcher(database, identity);
  const envelope = createCommandEnvelope({
    workspaceId, runtimeEpoch: identity.runtimeEpoch, command: 'plan_item.repair_approved_chain', requestId,
    input: {
      planItemId,
      expectedRevision,
      ...(rollbackBinding ? { rollbackBinding } : {}),
      ...(thesisRepair ? { thesisRepair } : {})
    },
    boundIdentity: { planItemId }, actor: { type: 'owner_ui', id: 'repair-test' }
  });
  return dispatcher.dispatch(envelope, () => {
    const data = repairApprovedPlanItemChain(database, {
      planItemId,
      expectedRevision,
      ...(rollbackBinding ? { rollbackBinding } : {}),
      ...(thesisRepair ? { thesisRepair } : {})
    });
    return { data, entityType: 'plan_item', entityId: planItemId, readback: data };
  });
}

test('repairs old approved project with zero versions and active carry, then noops on a new request', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const projectId = insertProject(database, item.id);

    const first = dispatchRepair(database, item.id, 'repair:first');
    assert.equal(first.ok, true);
    assert.equal(first.data.projectId, projectId);
    assert.equal(first.data.projectRevision, 2);
    assert.equal(first.data.repaired, true);
    assert.deepEqual(first.data.actions, ['initial_version_created', 'carry_completed']);
    assert.ok(first.data.contentVersionId);
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_versions WHERE project_id=?').get(projectId).count, 1);
    assert.match(database.prepare('SELECT body FROM content_versions WHERE project_id=?').get(projectId).body, /为什么是现在/);
    assert.equal(database.prepare("SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(item.id).state, 'done');

    const second = dispatchRepair(database, item.id, 'repair:second');
    assert.equal(second.ok, true);
    assert.equal(second.data.repaired, false);
    assert.deepEqual(second.data.actions, []);
    assert.equal(second.data.contentVersionId, first.data.contentVersionId);
    assert.equal(second.data.projectRevision, 2);
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_versions WHERE project_id=?').get(projectId).count, 1);

    const replay = dispatchRepair(database, item.id, 'repair:first');
    assert.equal(replay.receiptId, first.receiptId);
  });
});

test('repairs a legacy approved thesis lock through an exact receipt without changing approval or content', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const chain = dispatchRepair(database, item.id, 'repair:prepare-chain');
    assert.equal(chain.ok, true);
    const before = database.prepare(`SELECT revision, planning_status AS planningStatus,
        json_extract(planning_provenance_json, '$.thesis_lock') AS thesisLock,
        (SELECT count(*) FROM content_projects WHERE plan_item_id=plan_items.id) AS projectCount,
        (SELECT count(*) FROM content_versions cv JOIN content_projects cp ON cp.id=cv.project_id WHERE cp.plan_item_id=plan_items.id) AS versionCount
      FROM plan_items WHERE id=?`).get(item.id);
    assert.equal(before.planningStatus, 'approved');
    assert.equal(before.thesisLock, null);

    const decision = editorialDecision('免费只有能稳定完成真实任务才有价值。');
    const reasons = scoredReasons(87, '2026-08-28T08:00:00.000Z');
    const repaired = dispatchRepair(database, item.id, 'repair:thesis-lock', undefined, {
      editorialDecision: decision,
      scoreReasons: reasons,
      approvedBy: 'owner:yangda',
      reason: 'Owner authorized WMB-5389 repair for the historical approved item'
    });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.data.thesisLockRepaired, true);
    assert.deepEqual(repaired.data.actions, ['thesis_lock_repaired']);
    assert.equal(repaired.data.planItemRevision, before.revision + 1);

    const after = database.prepare(`SELECT revision, planning_status AS planningStatus, score_reasons_json AS scoreReasons,
        planning_provenance_json AS provenance,
        (SELECT count(*) FROM content_projects WHERE plan_item_id=plan_items.id) AS projectCount,
        (SELECT count(*) FROM content_versions cv JOIN content_projects cp ON cp.id=cv.project_id WHERE cp.plan_item_id=plan_items.id) AS versionCount
      FROM plan_items WHERE id=?`).get(item.id);
    const provenance = JSON.parse(after.provenance);
    assert.equal(after.planningStatus, 'approved');
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.projectCount, before.projectCount);
    assert.equal(after.versionCount, before.versionCount);
    assert.deepEqual(JSON.parse(after.scoreReasons), reasons);
    assert.deepEqual(provenance.editorial_decision, decision);
    assert.equal(provenance.thesis_lock.version, 'thesis_lock_v1');
    assert.equal(provenance.thesis_lock.winnerThesis, decision.winnerThesis);
    assert.equal(provenance.thesis_lock.approvedBy, 'owner:yangda');
    assert.equal(provenance.thesis_lock.repair.version, 'approved_thesis_repair_v1');
    assert.equal(provenance.thesis_lock.repair.priorRevision, before.revision);

    const replay = dispatchRepair(database, item.id, 'repair:thesis-lock', undefined, {
      editorialDecision: decision,
      scoreReasons: reasons,
      approvedBy: 'owner:yangda',
      reason: 'Owner authorized WMB-5389 repair for the historical approved item'
    }, before.revision);
    assert.equal(replay.ok, true);
    assert.equal(replay.receiptId, repaired.receiptId);
    assert.equal(database.prepare('SELECT revision FROM plan_items WHERE id=?').get(item.id).revision, after.revision);

    const rejected = dispatchRepair(database, item.id, 'repair:thesis-lock-again', undefined, {
      editorialDecision: decision,
      scoreReasons: reasons,
      approvedBy: 'owner:yangda',
      reason: 'must not overwrite an existing lock'
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'THESIS_LOCK_ALREADY_EXISTS');
    assert.equal(database.prepare('SELECT revision FROM plan_items WHERE id=?').get(item.id).revision, after.revision);
  });
});

test('creates a missing done carry for an already complete approved chain', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const projectId = insertProject(database, item.id);
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO content_versions (id, project_id, body, version_number, created_at, author)
      VALUES (?, ?, '# existing', 1, ?, 'ai')`).run(randomUUID(), projectId, now);
    database.prepare("DELETE FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").run(item.id);

    const receipt = dispatchRepair(database, item.id, 'repair:missing-carry');
    assert.equal(receipt.ok, true);
    assert.deepEqual(receipt.data.actions, ['carry_created_done']);
    assert.equal(database.prepare("SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(item.id).state, 'done');
  });
});

test('rolls back the whole business repair when initial version creation fails', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const projectId = insertProject(database, item.id);
    database.exec(`CREATE TRIGGER fail_repair_version BEFORE INSERT ON content_versions BEGIN SELECT RAISE(ABORT, 'injected_repair_failure'); END`);

    const receipt = dispatchRepair(database, item.id, 'repair:rollback');
    assert.equal(receipt.ok, false);
    assert.match(receipt.error.message, /injected_repair_failure/);
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_versions WHERE project_id=?').get(projectId).count, 0);
    assert.equal(database.prepare("SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(item.id).state, 'active');
  });
});

test('reuses the deduplicated carry of the same story instead of creating a competing carry', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const projectId = insertProject(database, item.id);
    const carry = database.prepare("SELECT id FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(item.id);
    database.prepare("UPDATE work_carry_items SET object_id='same-story-older-plan-item' WHERE id=?").run(carry.id);

    const receipt = dispatchRepair(database, item.id, 'repair:shared-carry');
    assert.equal(receipt.ok, true);
    assert.equal(receipt.data.carryId, carry.id);
    assert.deepEqual(receipt.data.actions, ['initial_version_created', 'carry_completed']);
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_versions WHERE project_id=?').get(projectId).count, 1);
    assert.equal(database.prepare('SELECT count(*) AS count FROM work_carry_items').get().count, 1);
    assert.equal(database.prepare('SELECT state FROM work_carry_items WHERE id=?').get(carry.id).state, 'done');
  });
});

test('fails closed when one approved plan item points at multiple projects', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    insertProject(database, item.id, ' A');
    insertProject(database, item.id, ' B');

    const receipt = dispatchRepair(database, item.id, 'repair:ambiguous');
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, 'AMBIGUOUS_PROJECTS');
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_versions').get().count, 0);
    assert.equal(database.prepare("SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(item.id).state, 'active');
  });
});

test('fails closed before creating version 1 when existing project metadata does not match', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const projectId = insertProject(database, item.id);
    database.prepare('DELETE FROM content_project_sources WHERE project_id=?').run(projectId);

    const receipt = dispatchRepair(database, item.id, 'repair:metadata-mismatch');
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, 'PROJECT_METADATA_MISMATCH');
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_versions WHERE project_id=?').get(projectId).count, 0);
    assert.equal(database.prepare("SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(item.id).state, 'active');
  });
});

test('fails closed on placeholder proposal text instead of generating a hollow initial version', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const projectId = insertProject(database, item.id);
    database.prepare("UPDATE plan_items SET title_guidance='待补充' WHERE id=?").run(item.id);

    const receipt = dispatchRepair(database, item.id, 'repair:placeholder');
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, 'REPAIR_INPUT_INCOMPLETE');
    assert.match(receipt.error.message, /titleGuidance_placeholder/);
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_versions WHERE project_id=?').get(projectId).count, 0);
    assert.equal(database.prepare('SELECT revision FROM content_projects WHERE id=?').get(projectId).revision, 1);
  });
});

test('fails closed when versions exist but immutable version 1 is missing', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const projectId = insertProject(database, item.id);
    database.prepare(`INSERT INTO content_versions (id, project_id, body, version_number, created_at, author)
      VALUES (?, ?, '# orphan version 2', 2, ?, 'ai')`).run(randomUUID(), projectId, new Date().toISOString());

    const receipt = dispatchRepair(database, item.id, 'repair:missing-v1');
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, 'MISSING_INITIAL_VERSION');
    assert.equal(database.prepare('SELECT count(*) AS count FROM content_versions WHERE project_id=?').get(projectId).count, 1);
  });
});

test('complete historical chain is an idempotent noop even when proposal guidance is incomplete', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const projectId = insertProject(database, item.id);
    database.prepare(`INSERT INTO content_versions (id, project_id, body, version_number, created_at, author)
      VALUES (?, ?, '# existing version 1', 1, ?, 'ai')`).run(randomUUID(), projectId, new Date().toISOString());
    database.prepare("UPDATE work_carry_items SET state='done' WHERE object_type='plan_item' AND object_id=?").run(item.id);
    database.prepare("UPDATE plan_items SET why_now='', title_guidance='', opening_guidance='', structure_guidance='' WHERE id=?").run(item.id);

    const receipt = dispatchRepair(database, item.id, 'repair:incomplete-noop');
    assert.equal(receipt.ok, true);
    assert.equal(receipt.data.repaired, false);
    assert.deepEqual(receipt.data.actions, []);
  });
});

test('reconciles the legacy missing project revision bump exactly once from the old repair receipt', async () => {
  await withDb(async (database) => {
    const item = seedApproved(database);
    const projectId = insertProject(database, item.id);
    const repaired = dispatchRepair(database, item.id, 'repair:legacy-revision-seed');
    assert.equal(repaired.ok, true);
    assert.equal(repaired.data.projectRevision, 2);
    database.prepare('UPDATE content_projects SET revision=1 WHERE id=?').run(projectId);

    const reconciled = dispatchRepair(database, item.id, 'repair:legacy-revision-reconcile');
    assert.equal(reconciled.ok, true);
    assert.deepEqual(reconciled.data.actions, ['project_revision_reconciled']);
    assert.equal(reconciled.data.projectRevision, 2);

    const noop = dispatchRepair(database, item.id, 'repair:legacy-revision-noop');
    assert.equal(noop.ok, true);
    assert.deepEqual(noop.data.actions, []);
    assert.equal(noop.data.projectRevision, 2);
  });
});

test('apply command creates a verified backup, reports retry guidance, and exits nonzero on failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-approved-chain-cli-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const item = seedApproved(database);
  insertProject(database, item.id, ' A');
  insertProject(database, item.id, ' B');
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(randomUUID(), now, now);
  database.close();
  try {
    const result = spawnSync(process.execPath, [
      '--experimental-sqlite', 'scripts/repair-approved-plan-chains.mjs',
      '--data-root', root, '--apply', '--run-id', 'cli-failure-test', '--attempt-id', 'attempt-1', '--summary-only'
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failed, 1);
    assert.match(report.retryInstruction, /--attempt-id retry-<unique-id>/);
    assert.match(report.backup.sha256, /^[A-F0-9]{64}$/);
    const files = await readdir(root);
    assert.equal(files.filter((name) => name.includes('approved-chain-repair-backup')).length, 1);
    const backupDb = new (await import('node:sqlite')).DatabaseSync(report.backup.path, { readOnly: true });
    assert.equal(Object.values(backupDb.prepare('PRAGMA quick_check').get())[0], 'ok');
    backupDb.close();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});


test('apply command accepts an exact verified external backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-approved-chain-external-backup-'));
  await openDataRoot(root);
  const databasePath = path.join(root, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const item = seedApproved(database);
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(randomUUID(), now, now);
  database.close();
  const referencePath = path.join(root, 'owner-reference.db');
  await copyFile(databasePath, referencePath);
  const referenceSha256 = createHash('sha256').update(readFileSync(referencePath)).digest('hex').toUpperCase();
  try {
    const result = spawnSync(process.execPath, [
      '--experimental-sqlite', 'scripts/repair-approved-plan-chains.mjs',
      '--data-root', root, '--plan-item-id', item.id, '--apply',
      '--run-id', 'external-backup-test', '--attempt-id', 'attempt-1',
      '--reference-backup', referencePath, '--reference-sha256', referenceSha256
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failed, 0);
    assert.equal(report.backup.path, referencePath);
    assert.equal(report.backup.sha256, referenceSha256);
    assert.equal(report.backup.provided, true);
    assert.equal(report.receipts[0].data.planItemId, item.id);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
test('rollback must refuse a repaired version with a logical knowledge usage reference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-approved-chain-rollback-usage-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const item = seedApproved(database);
  const projectId = insertProject(database, item.id);
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(randomUUID(), now, now);
  const referencePath = path.join(root, 'reference.db');
  await backup(database, referencePath);
  const referenceSha256 = createHash('sha256').update(readFileSync(referencePath)).digest('hex').toUpperCase();
  const repaired = dispatchRepair(database, item.id, 'rollback:usage-reference', {
    referenceSha256,
    preStateHash: approvedPlanItemChainPreStateHash(database, item.id)
  });
  assert.equal(repaired.ok, true);
  const contentVersionId = repaired.data.contentVersionId;
  const workspaceId = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get().value;
  const changeSetId = randomUUID();
  const knowledgeNoteId = randomUUID();
  const knowledgeNoteVersionId = randomUUID();
  const usagePackageId = randomUUID();
  database.prepare(`INSERT INTO knowledge_change_sets
    (id, workspace_id, request_id, input_hash, reason, trigger_source, resolution_mode, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'creation', 'none', 'system', ?)`).run(
    changeSetId, workspaceId, `rollback-test:${changeSetId}`, 'rollback-test', 'rollback test', now
  );
  database.prepare(`INSERT INTO knowledge_notes
    (id, scope, kind, canonical_key, title, lifecycle, revision, created_at, updated_at)
    VALUES (?, 'global', 'insight', ?, 'Rollback test note', 'active', 1, ?, ?)`).run(knowledgeNoteId, `rollback-test:${knowledgeNoteId}`, now, now);
  database.prepare(`INSERT INTO knowledge_note_versions
    (id, note_id, version_number, title, statement, conclusion_status, evidence_level, change_type, creator_nature, change_set_id, created_at)
    VALUES (?, ?, 1, 'Rollback test note', 'A test note.', 'unverified', 'none', 'created', 'system', ?, ?)`).run(knowledgeNoteVersionId, knowledgeNoteId, changeSetId, now);
  database.prepare(`INSERT INTO knowledge_usage_packages
    (id, scope, workspace_id, stage, request_id, input_hash, compiler_schema_version, created_by, created_at)
    VALUES (?, 'global', ?, 'core_draft', ?, 'rollback-test', 'test', 'system', ?)`).run(usagePackageId, workspaceId, `rollback-test:${usagePackageId}`, now);
  database.prepare(`INSERT INTO knowledge_usage_records
    (id, scope, workspace_id, package_id, output_object_type, output_object_id, note_version_id,
     usage_kind, used, reason, actor, created_by, created_at)
    VALUES (?, 'global', ?, ?, 'content_version', ?, ?, 'reasoning_basis', 1, 'rollback test', 'system', 'system', ?)`).run(
    randomUUID(), workspaceId, usagePackageId, contentVersionId, knowledgeNoteVersionId, now
  );
  assert.equal(database.prepare("SELECT count(*) AS count FROM knowledge_usage_records WHERE output_object_type='content_version' AND output_object_id=?").get(contentVersionId).count, 1);
  const receiptId = repaired.receiptId;
  database.close();

  try {
    const result = spawnSync(process.execPath, [
      '--experimental-sqlite', 'scripts/rollback-approved-plan-chain-repair.mjs',
      '--data-root', root, '--reference-backup', referencePath, '--reference-sha256', referenceSha256,
      '--plan-item-id', item.id, '--project-id', projectId,
      '--content-version-id', contentVersionId, '--receipt-id', receiptId
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /content version has downstream references/);
    const readback = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true });
    try {
      assert.equal(readback.prepare('SELECT count(*) AS count FROM content_versions WHERE id=? AND project_id=?').get(contentVersionId, projectId).count, 1);
      assert.equal(readback.prepare("SELECT count(*) AS count FROM knowledge_usage_records WHERE output_object_type='content_version' AND output_object_id=?").get(contentVersionId).count, 1);
    } finally {
      readback.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('backup-bound rollback restores the exact pre-repair chain and writes a command receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-approved-chain-rollback-success-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const item = seedApproved(database);
  const projectId = insertProject(database, item.id);
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(randomUUID(), now, now);
  const referencePath = path.join(root, 'reference.db');
  await backup(database, referencePath);
  const referenceSha256 = createHash('sha256').update(readFileSync(referencePath)).digest('hex').toUpperCase();
  const repaired = dispatchRepair(database, item.id, 'rollback:bound-success', {
    referenceSha256,
    preStateHash: approvedPlanItemChainPreStateHash(database, item.id)
  });
  assert.equal(repaired.ok, true);
  database.close();

  try {
    const result = spawnSync(process.execPath, [
      '--experimental-sqlite', 'scripts/rollback-approved-plan-chain-repair.mjs',
      '--data-root', root, '--reference-backup', referencePath, '--reference-sha256', referenceSha256,
      '--plan-item-id', item.id, '--project-id', projectId,
      '--content-version-id', repaired.data.contentVersionId, '--receipt-id', repaired.receiptId
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.commandReceipt.ok, true);
    assert.equal(report.commandReceipt.command, 'plan_item.rollback_approved_chain_repair');
    assert.equal(report.commandReceipt.data.restoredVersionCount, 0);
    assert.equal(report.commandReceipt.data.restoredCarryState, 'active');
    const replay = spawnSync(process.execPath, [
      '--experimental-sqlite', 'scripts/rollback-approved-plan-chain-repair.mjs',
      '--data-root', root, '--reference-backup', referencePath, '--reference-sha256', referenceSha256,
      '--plan-item-id', item.id, '--project-id', projectId,
      '--content-version-id', repaired.data.contentVersionId, '--receipt-id', repaired.receiptId
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    assert.equal(JSON.parse(replay.stdout).commandReceipt.receiptId, report.commandReceipt.receiptId);
    const readback = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true });
    try {
      assert.equal(readback.prepare('SELECT count(*) AS count FROM content_versions WHERE project_id=?').get(projectId).count, 0);
      assert.equal(readback.prepare("SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(item.id).state, 'active');
    } finally { readback.close(); }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('backup-bound rollback refuses a plan item edited after repair', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-approved-chain-rollback-plan-item-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const item = seedApproved(database);
  const projectId = insertProject(database, item.id);
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(randomUUID(), now, now);
  const referencePath = path.join(root, 'reference.db');
  await backup(database, referencePath);
  const referenceSha256 = createHash('sha256').update(readFileSync(referencePath)).digest('hex').toUpperCase();
  const repaired = dispatchRepair(database, item.id, 'rollback:plan-item-edited', {
    referenceSha256,
    preStateHash: approvedPlanItemChainPreStateHash(database, item.id)
  });
  assert.equal(repaired.ok, true);
  database.prepare("UPDATE plan_items SET title_guidance='Owner edited after repair', revision=revision+1 WHERE id=?").run(item.id);
  database.close();

  try {
    const result = spawnSync(process.execPath, [
      '--experimental-sqlite', 'scripts/rollback-approved-plan-chain-repair.mjs',
      '--data-root', root, '--reference-backup', referencePath, '--reference-sha256', referenceSha256,
      '--plan-item-id', item.id, '--project-id', projectId,
      '--content-version-id', repaired.data.contentVersionId, '--receipt-id', repaired.receiptId
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /plan item changed after the reference backup/);
    const readback = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true });
    try {
      assert.equal(readback.prepare('SELECT count(*) AS count FROM content_versions WHERE id=?').get(repaired.data.contentVersionId).count, 1);
      assert.equal(readback.prepare('SELECT title_guidance AS titleGuidance FROM plan_items WHERE id=?').get(item.id).titleGuidance, 'Owner edited after repair');
    } finally { readback.close(); }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('rollback rechecks plan item after a concurrent writer commits before its transaction starts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-approved-chain-rollback-race-'));
  await openDataRoot(root);
  const databasePath = path.join(root, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const item = seedApproved(database);
  const projectId = insertProject(database, item.id);
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(randomUUID(), now, now);
  const referencePath = path.join(root, 'reference.db');
  await backup(database, referencePath);
  const referenceSha256 = createHash('sha256').update(readFileSync(referencePath)).digest('hex').toUpperCase();
  const repaired = dispatchRepair(database, item.id, 'rollback:concurrent-plan-item-edit', {
    referenceSha256,
    preStateHash: approvedPlanItemChainPreStateHash(database, item.id)
  });
  assert.equal(repaired.ok, true);
  database.close();

  const writerCode = `
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(${JSON.stringify(databasePath)});
    database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    database.prepare("UPDATE plan_items SET title_guidance='Concurrent owner edit', revision=revision+1 WHERE id=?").run(${JSON.stringify(item.id)});
    process.stdout.write('LOCKED\\n');
    setTimeout(() => { database.exec('COMMIT'); database.close(); }, 500);
  `;
  const writer = spawn(process.execPath, ['--experimental-sqlite', '-e', writerCode], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const writerDone = new Promise((resolve, reject) => {
    let stderr = '';
    writer.stderr.on('data', (chunk) => { stderr += chunk; });
    writer.on('error', reject);
    writer.on('close', (code) => code === 0 ? resolve() : reject(new Error(`concurrent writer failed (${code}): ${stderr}`)));
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('concurrent writer did not acquire the transaction')), 5_000);
    writer.stdout.on('data', (chunk) => {
      if (String(chunk).includes('LOCKED')) { clearTimeout(timeout); resolve(); }
    });
    writer.on('error', reject);
  });

  try {
    const rollback = spawn(process.execPath, [
      '--experimental-sqlite', 'scripts/rollback-approved-plan-chain-repair.mjs',
      '--data-root', root, '--reference-backup', referencePath, '--reference-sha256', referenceSha256,
      '--plan-item-id', item.id, '--project-id', projectId,
      '--content-version-id', repaired.data.contentVersionId, '--receipt-id', repaired.receiptId
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const rollbackResult = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      rollback.stdout.on('data', (chunk) => { stdout += chunk; });
      rollback.stderr.on('data', (chunk) => { stderr += chunk; });
      rollback.on('error', reject);
      rollback.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    await writerDone;
    assert.notEqual(rollbackResult.status, 0, rollbackResult.stdout);
    assert.match(`${rollbackResult.stdout}\n${rollbackResult.stderr}`, /plan item changed after the reference backup/);
    const readback = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(readback.prepare('SELECT count(*) AS count FROM content_versions WHERE id=?').get(repaired.data.contentVersionId).count, 1);
      assert.equal(readback.prepare('SELECT title_guidance AS titleGuidance FROM plan_items WHERE id=?').get(item.id).titleGuidance, 'Concurrent owner edit');
    } finally { readback.close(); }
  } finally {
    if (writer.exitCode === null) writer.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
