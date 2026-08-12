import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);
const { migrateDatabase, migrations } = await import('../src/main/db/migrations.ts');
const {
  upsertResearchClaim, getResearchClaim, listResearchClaims,
  getResearchClaimsSnapshot, projectResearchClaimStatuses
} = await import('../src/main/db/research-claims-store.ts');
// WMB-5171 映射层（research-task-state）：研究持久化 types/parsers/builders/readResearchGap
const {
  buildResearchCheckpoint, buildResearchEvidencePack, parseResearchCheckpoint, parseResearchEvidencePack,
  parseResearchProgress, readResearchGap
} = await import('../src/main/research-task-state.ts');
// WMB-5171 lifecycle 层（agent-tasks 仅保留 intent 数组与恢复/取消/进度 SQL 接线）
const {
  cancelAgentTask, getAgentTask, needsUserAgentTask, recoverInterruptedAgentTasks,
  reportAgentTaskProgress, startAgentTask
} = await import('../src/main/agent-tasks.ts');
const {
  buildJobContextRefs, buildJobObjectBoundary, parseRoleJobRequest, rebuildRoleJobRequest
} = await import('../src/main/role-job-registry.ts');

const ALL_AGENT_TASK_INTENTS = [
  'daily_intelligence', 'daily_scan', 'daily_judge', 'studio_draft', 'results_review', 'research',
  'page_today', 'page_agents', 'page_discover', 'page_proposals', 'page_topic',
  'page_library', 'page_canvas', 'page_studio', 'page_publish', 'page_results'
];
const RESEARCH_CLAIM_COLUMNS = ['id', 'task_id', 'claim_key', 'claim_text', 'claim_type', 'status',
  'verdict_reason', 'evidence_source_ids_json', 'needs_time_excerpt', 'verified_at', 'created_at', 'updated_at'];

async function withDb(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5171-')); const db = migrateDatabase(path.join(root, 'wmb.db'));
  try { await work(db); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

/** 升级路径：先按 v1..v53（跳过 v54）建库并落旧数据，再由 migrateDatabase 应用 v54。 */
async function withPreV54Db(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5171-pre54-')); const dbPath = path.join(root, 'wmb.db');
  const database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of migrations) {
    if (migration.version >= 54) continue;
    if (database.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version)) continue;
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.exec('PRAGMA foreign_keys = ON');
  }
  database.exec('PRAGMA foreign_keys = ON');
  try { await work(database, dbPath); }
  finally { try { database.close(); } catch {} await rm(root, { recursive: true, force: true }); }
}

function insertAgentTask(db, values) {
  db.prepare(`INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, control_action, heartbeat_at, error_code, error_message, created_at, updated_at, finished_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(values.id, values.intent, values.businessDate, values.status, values.phase, values.piSessionId,
      values.contextRefsJson, values.resultRefsJson, values.progressJson, values.checkpointJson, values.eventsJson,
      values.controlAction, values.heartbeatAt, values.errorCode, values.errorMessage, values.createdAt, values.updatedAt, values.finishedAt);
}

// ============================================================================
// WMB-5171 DB 层 —— 迁移 v54（agent_tasks intent CHECK 重建 + research_claims DDL）
// ============================================================================

test('WMB-5171: v54 applies on a fresh database with exact research_claims DDL and research intent', async () => withDb((db) => {
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
  assert.ok(applied.has(54), 'v54 applied on fresh database');
  const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='research_claims'").get()?.sql;
  assert.ok(createSql, 'research_claims table exists');

  const columns = db.prepare('PRAGMA table_info(research_claims)').all().map((row) => row.name);
  assert.deepEqual(columns, RESEARCH_CLAIM_COLUMNS, 'research_claims column set and order match contract');
  const meta = Object.fromEntries(db.prepare('PRAGMA table_info(research_claims)').all().map((row) => [row.name, row]));
  assert.equal(meta.id.pk, 1, 'id is primary key');
  for (const required of ['task_id', 'claim_key', 'claim_text', 'claim_type', 'status', 'created_at', 'updated_at']) {
    assert.equal(meta[required].notnull, 1, `${required} NOT NULL`);
  }
  assert.equal(String(meta.evidence_source_ids_json.dflt_value).replaceAll("'", ''), '[]', 'evidence_source_ids_json default []');
  assert.equal(String(meta.needs_time_excerpt.dflt_value).trim(), '0', 'needs_time_excerpt default 0');

  assert.ok(createSql.includes("UNIQUE (task_id, claim_key)"), 'UNIQUE (task_id, claim_key) in DDL');
  assert.ok(createSql.includes("claim_type IN ('fact','price','policy')"), 'claim_type CHECK enum exact');
  assert.ok(createSql.includes("status IN ('pending','supported','contradicted','unresolved','source_unavailable')"), 'status CHECK enum exact');
  assert.ok(!createSql.includes("'verified'"), 'status enum has no drift');

  const atSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_tasks'").get()?.sql;
  for (const intent of ALL_AGENT_TASK_INTENTS) assert.ok(atSql.includes(`'${intent}'`), `agent_tasks intent CHECK includes '${intent}'`);
  assert.ok(!atSql.includes("'hack'"), 'agent_tasks intent CHECK rejects unknown intents');

  const now = new Date().toISOString();
  insertAgentTask(db, { id: 't-research', intent: 'research', businessDate: '2026-08-10', status: 'running', phase: 'spawned',
    piSessionId: null, contextRefsJson: '{}', resultRefsJson: '{}', progressJson: '{}', checkpointJson: '{}', eventsJson: '[]',
    controlAction: null, heartbeatAt: null, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now, finishedAt: null });
  assert.equal(db.prepare("SELECT intent FROM agent_tasks WHERE id='t-research'").get().intent, 'research');
  assert.throws(() => insertAgentTask(db, { id: 't-bad', intent: 'hack', businessDate: '2026-08-10', status: 'running', phase: 'x',
    piSessionId: null, contextRefsJson: '{}', resultRefsJson: '{}', progressJson: '{}', checkpointJson: '{}', eventsJson: '[]',
    controlAction: null, heartbeatAt: null, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now, finishedAt: null }), /CHECK constraint failed/);

  const atIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_tasks'").all().map((row) => row.name);
  assert.ok(atIndexes.includes('agent_tasks_intent_date_status'), 'agent_tasks_intent_date_status index survives rebuild');
  const claimIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='research_claims'").all().map((row) => row.name);
  assert.ok(claimIndexes.includes('research_claims_task_status'), 'research_claims_task_status index exists');
  assert.deepEqual(db.prepare('PRAGMA index_info(research_claims_task_status)').all().map((row) => row.name), ['task_id', 'status']);
}));

test('WMB-5171: v54 applies on an upgraded database preserving every old agent_tasks row, value and index', async () => withPreV54Db(async (db, dbPath) => {
  const now = '2026-08-09T10:00:00.000Z';
  const rows = [
    { id: 't-daily', intent: 'daily_scan', businessDate: '2026-08-09', status: 'succeeded', phase: 'done', piSessionId: 'pi-1',
      contextRefsJson: '{"jobId":"job-1"}', resultRefsJson: '{"sourceIds":["s1"]}', progressJson: '{"planned":40,"processed":40}', checkpointJson: '{"round":1}', eventsJson: '[{"at":"x","message":"m"}]',
      controlAction: null, heartbeatAt: now, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now, finishedAt: now },
    { id: 't-page', intent: 'page_agents', businessDate: '2026-08-09', status: 'needs_user', phase: 'waiting', piSessionId: null,
      contextRefsJson: '{}', resultRefsJson: '{}', progressJson: '{}', checkpointJson: '{}', eventsJson: '[]',
      controlAction: 'cancel', heartbeatAt: null, errorCode: 'NEEDS_USER', errorMessage: '配置缺失', createdAt: now, updatedAt: now, finishedAt: null },
    { id: 't-studio', intent: 'studio_draft', businessDate: '2026-08-09', status: 'interrupted', phase: 'running', piSessionId: 'pi-2',
      contextRefsJson: '{"projectId":"p1"}', resultRefsJson: '{}', progressJson: '{}', checkpointJson: '{"keep":true}', eventsJson: '[]',
      controlAction: null, heartbeatAt: null, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now, finishedAt: null }
  ];
  for (const row of rows) insertAgentTask(db, row);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count, 53, 'pre-v54 database is at v53');
  assert.ok(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='research_claims'").get(), 'no research_claims pre-v54');
  assert.throws(() => insertAgentTask(db, { ...rows[0], id: 't-research-pre', intent: 'research', businessDate: '2026-08-10' }), /CHECK constraint failed/, 'research intent rejected pre-v54');
  db.close();

  const upgraded = migrateDatabase(dbPath);
  assert.ok(new Set(upgraded.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version))).has(54), 'v54 applied on upgrade');
  assert.equal(upgraded.prepare('SELECT COUNT(*) count FROM agent_tasks').get().count, 3, 'no rows lost in rebuild');
  for (const expected of rows) {
    const row = upgraded.prepare('SELECT * FROM agent_tasks WHERE id=?').get(expected.id);
    assert.equal(row.intent, expected.intent); assert.equal(row.business_date, expected.businessDate); assert.equal(row.status, expected.status);
    assert.equal(row.phase, expected.phase); assert.equal(row.pi_session_id, expected.piSessionId);
    assert.equal(row.context_refs_json, expected.contextRefsJson); assert.equal(row.result_refs_json, expected.resultRefsJson);
    assert.equal(row.progress_json, expected.progressJson); assert.equal(row.checkpoint_json, expected.checkpointJson);
    assert.equal(row.events_json, expected.eventsJson); assert.equal(row.control_action, expected.controlAction);
    assert.equal(row.heartbeat_at, expected.heartbeatAt); assert.equal(row.error_code, expected.errorCode);
    assert.equal(row.error_message, expected.errorMessage); assert.equal(row.created_at, expected.createdAt);
    assert.equal(row.updated_at, expected.updatedAt); assert.equal(row.finished_at, expected.finishedAt);
  }
  const atIndexes = upgraded.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_tasks'").all().map((row) => row.name);
  assert.ok(atIndexes.includes('agent_tasks_intent_date_status'), 'agent_tasks index recreated after upgrade');
  const claimIndexes = upgraded.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='research_claims'").all().map((row) => row.name);
  assert.ok(claimIndexes.includes('research_claims_task_status'), 'research_claims index exists after upgrade');
  const now2 = new Date().toISOString();
  insertAgentTask(upgraded, { id: 't-research', intent: 'research', businessDate: '2026-08-10', status: 'running', phase: 'spawned',
    piSessionId: null, contextRefsJson: '{}', resultRefsJson: '{}', progressJson: '{}', checkpointJson: '{}', eventsJson: '[]',
    controlAction: null, heartbeatAt: null, errorCode: null, errorMessage: null, createdAt: now2, updatedAt: now2, finishedAt: null });
  assert.equal(upgraded.prepare("SELECT intent FROM agent_tasks WHERE id='t-research'").get().intent, 'research');
  const claim = upsertResearchClaim(upgraded, { taskId: 't-research', claimKey: 'k', claimText: 'x', claimType: 'fact', status: 'pending' });
  assert.equal(claim.ok, true, 'store usable on upgraded database');
  upgraded.close();
}));

test('WMB-5171: migration v54 is idempotent on reopen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5171-reopen-')); const dbPath = path.join(root, 'wmb.db');
  try {
    const first = migrateDatabase(dbPath);
    const count = first.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count;
    assert.ok(count >= 54, 'all migrations including v54 applied');
    first.close();
    const second = migrateDatabase(dbPath);
    assert.equal(second.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count, count, 'reopen applies nothing new');
    second.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WMB-5171: research_claims CHECK enums reject out-of-enum values at the database boundary', async () => withDb((db) => {
  const base = (id, claimType, status) => db.prepare(`INSERT INTO research_claims (id, task_id, claim_key, claim_text, claim_type, status,
    verdict_reason, evidence_source_ids_json, needs_time_excerpt, verified_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 't', 'k', 'text', claimType, status, null, '[]', 0, null, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
  base(randomUUID(), 'fact', 'pending');
  assert.throws(() => base(randomUUID(), 'opinion', 'pending'), /CHECK constraint failed/, 'claim_type outside fact/price/policy rejected');
  assert.throws(() => base(randomUUID(), 'fact', 'verified'), /CHECK constraint failed/, 'status outside five-state machine rejected');
  assert.throws(() => base(randomUUID(), 'price', 'concluded'), /CHECK constraint failed/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM research_claims').get().count, 1);
}));

test('WMB-5171: UNIQUE (task_id, claim_key) rejects duplicates; same key across tasks is allowed', async () => withDb((db) => {
  const insert = (id, taskId, claimKey) => db.prepare(`INSERT INTO research_claims (id, task_id, claim_key, claim_text, claim_type, status,
    verdict_reason, evidence_source_ids_json, needs_time_excerpt, verified_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, taskId, claimKey, 'text', 'fact', 'pending', null, '[]', 0, null, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
  insert('c1', 'task-a', 'k1');
  assert.throws(() => insert('c2', 'task-a', 'k1'), /UNIQUE constraint failed/, 'duplicate (task_id, claim_key) rejected');
  insert('c3', 'task-b', 'k1');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM research_claims').get().count, 2, 'same claim_key under a different task_id is a distinct row');
}));

// ============================================================================
// WMB-5171 DB 层 —— research-claims-store 存取语义
// ============================================================================

test('WMB-5171: store upsert is idempotent by (task_id, claim_key), freezes spawn fields and updates verdict fields', async () => withDb((db) => {
  const created = upsertResearchClaim(db, { taskId: 'task-1', claimKey: 'glm52_official_price_rise', claimText: 'GLM 5.2 官方在 OpenRouter 涨价', claimType: 'price', status: 'pending' });
  assert.equal(created.ok, true);
  assert.equal(created.data.needsTimeExcerpt, 1, 'price claim derives needs_time_excerpt=1');
  assert.equal(created.data.evidenceSourceIds.length, 0);
  assert.equal(created.data.status, 'pending');
  assert.equal(created.data.claimText, 'GLM 5.2 官方在 OpenRouter 涨价');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM research_claims').get().count, 1);

  const replay = upsertResearchClaim(db, { taskId: 'task-1', claimKey: 'glm52_official_price_rise', claimText: 'GLM 5.2 官方在 OpenRouter 涨价', claimType: 'price', status: 'pending' });
  assert.equal(replay.ok, true);
  assert.equal(replay.data.id, created.data.id, 'replay keeps the same row id');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM research_claims').get().count, 1, 'replay never creates a second row');

  const verdict = upsertResearchClaim(db, { taskId: 'task-1', claimKey: 'glm52_official_price_rise', claimText: 'GLM 5.2 官方在 OpenRouter 涨价', claimType: 'price',
    status: 'supported', verdictReason: '官方价页', evidenceSourceIds: ['s2', 's1', 's2'], verifiedAt: '2026-08-11T00:00:00.000Z' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.data.id, created.data.id);
  assert.equal(verdict.data.status, 'supported');
  assert.equal(verdict.data.verdictReason, '官方价页');
  assert.deepEqual(verdict.data.evidenceSourceIds, ['s2', 's1'], 'evidence ids deduped, order preserved');
  assert.equal(verdict.data.verifiedAt, '2026-08-11T00:00:00.000Z');
  assert.equal(verdict.data.claimText, 'GLM 5.2 官方在 OpenRouter 涨价', 'claim_text frozen');
  assert.equal(verdict.data.claimType, 'price', 'claim_type frozen');
  assert.equal(verdict.data.needsTimeExcerpt, 1, 'needs_time_excerpt frozen');
  assert.equal(verdict.data.createdAt, created.data.createdAt, 'created_at frozen');
  assert.ok(verdict.data.updatedAt >= created.data.updatedAt, 'updated_at refreshed');
  const stored = db.prepare("SELECT evidence_source_ids_json FROM research_claims WHERE task_id='task-1'").get().evidence_source_ids_json;
  assert.equal(stored, '["s2","s1"]', 'evidence stored as deterministic normalized JSON');

  const fetched = getResearchClaim(db, 'task-1', 'glm52_official_price_rise');
  assert.ok(fetched, 'getResearchClaim finds the row');
  assert.equal(fetched.id, created.data.id);
  assert.equal(getResearchClaim(db, 'task-1', 'missing'), null);
  assert.equal(getResearchClaim(db, 'other-task', 'glm52_official_price_rise'), null);
}));

test('WMB-5171: store rejects invalid shapes at the boundary with VALIDATION_ERROR', async () => withDb((db) => {
  const base = { taskId: 'task-1', claimKey: 'k', claimText: 'text', claimType: 'fact', status: 'pending' };
  const cases = [
    [{ ...base, taskId: '  ' }, /任务 ID/],
    [{ ...base, claimKey: '' }, /声明键/],
    [{ ...base, claimText: '   ' }, /声明原文/],
    [{ ...base, claimType: 'opinion' }, /声明类型/],
    [{ ...base, status: 'verified' }, /声明状态/],
    [{ ...base, claimType: 'price', needsTimeExcerpt: 0 }, /needs_time_excerpt=1/],
    [{ ...base, needsTimeExcerpt: 1 }, /needs_time_excerpt=0/],
    [{ ...base, needsTimeExcerpt: 2 }, /needs_time_excerpt 必须是 0 或 1/],
    [{ ...base, evidenceSourceIds: 's1' }, /字符串数组/],
    [{ ...base, evidenceSourceIds: ['s1', ''] }, /非空字符串/],
    [{ ...base, evidenceSourceIds: [42] }, /非空字符串/]
  ];
  for (const [input, pattern] of cases) {
    const result = upsertResearchClaim(db, input);
    assert.equal(result.ok, false, `rejected: ${pattern}`);
    assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.match(result.error.message, pattern);
  }
  assert.equal(db.prepare('SELECT COUNT(*) count FROM research_claims').get().count, 0, 'no partial row written');
  const ok = upsertResearchClaim(db, { ...base, claimType: 'fact', needsTimeExcerpt: 0, status: 'pending' });
  assert.equal(ok.ok, true);
  const okPrice = upsertResearchClaim(db, { ...base, claimKey: 'p', claimType: 'price', needsTimeExcerpt: 1, status: 'pending' });
  assert.equal(okPrice.ok, true, 'explicit needsTimeExcerpt matching the type invariant is accepted');
}));

test('WMB-5171: store list is task-scoped and deterministically ordered; snapshot is immutable; projection passes statuses through', async () => withDb((db) => {
  const t0 = '2026-08-10T00:00:00.000Z';
  const insert = (id, taskId, claimKey, createdAt) => db.prepare(`INSERT INTO research_claims (id, task_id, claim_key, claim_text, claim_type, status,
    verdict_reason, evidence_source_ids_json, needs_time_excerpt, verified_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, taskId, claimKey, 'text', 'fact', 'pending', null, '[]', 0, null, createdAt, createdAt);
  insert('c1', 'task-a', 'a', t0);
  insert('c2', 'task-a', 'b', '2026-08-10T00:01:00.000Z');
  insert('c-zz', 'task-a', 'tie-2', t0);
  insert('c-aa', 'task-a', 'tie-1', t0);
  insert('c3', 'task-b', 'a', t0);

  const listA = listResearchClaims(db, 'task-a');
  assert.deepEqual(listA.map((claim) => claim.claimKey), ['tie-1', 'tie-2', 'a', 'b'], 'ORDER BY created_at, id');
  assert.deepEqual(listResearchClaims(db, 'task-a').map((claim) => claim.claimKey), ['tie-1', 'tie-2', 'a', 'b'], 'list is deterministic across calls');
  assert.deepEqual(listResearchClaims(db, 'task-b').map((claim) => claim.claimKey), ['a'], 'task-scoped query does not leak other tasks');

  const snapshot1 = getResearchClaimsSnapshot(db, 'task-a');
  assert.equal(snapshot1.taskId, 'task-a');
  assert.equal(snapshot1.claims.length, 4);
  snapshot1.taskId = 'mutated';
  snapshot1.claims.length = 0;
  const snapshot2 = getResearchClaimsSnapshot(db, 'task-a');
  assert.equal(snapshot2.taskId, 'task-a', 'snapshot object is a copy');
  assert.equal(snapshot2.claims.length, 4, 'snapshot claims are deep copies');
  assert.notEqual(snapshot1.claims, snapshot2.claims);

  const projection = projectResearchClaimStatuses(db, 'task-a');
  assert.deepEqual(projection, { a: 'pending', 'tie-1': 'pending', 'tie-2': 'pending', b: 'pending' }, 'projection mirrors stored statuses without deriving verdicts');
  const verdict = upsertResearchClaim(db, { taskId: 'task-a', claimKey: 'b', claimText: 'text', claimType: 'fact', status: 'contradicted', verdictReason: '官方未涨价' });
  assert.equal(verdict.ok, true);
  assert.deepEqual(projectResearchClaimStatuses(db, 'task-a'), { a: 'pending', 'tie-1': 'pending', 'tie-2': 'pending', b: 'contradicted' });
  assert.deepEqual(projectResearchClaimStatuses(db, 'task-b'), { a: 'pending' });
}));

// ============================================================================
// WMB-5171 lifecycle/mapping 层（resume_pending、映射往返、取消证据保留）：ImplementResearchTaskMapping5171 追加于此
// ============================================================================

const RESEARCH_REQUEST = {
  roleId: 'reporter',
  brief: '研究 GLM 5.2 官方是否涨价（OpenRouter 反常低价）',
  businessDate: '2026-08-10',
  projectId: 'project-parent-1',
  research: {
    gapId: 'research-abc',
    parentJobId: 'job-parent-1',
    parentTaskId: 'task-parent-1',
    parentRoleId: 'writer',
    requiredClaims: [
      { key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价（对比此前的官方基准价）', type: 'price' },
      { key: 'glm52_safety_policy', text: 'GLM 5.2 官方安全政策是否有收紧声明', type: 'policy' }
    ],
    budget: { timeMinutes: 12, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3, maxRounds: 1 },
    channels: ['web', 'x', 'xhs']
  }
};

/** 经角色注册表真源（parseRoleJobRequest + buildJobContextRefs）构造生产路径的 research context refs。 */
function buildResearchRefs() {
  const request = parseRoleJobRequest(RESEARCH_REQUEST);
  const boundary = buildJobObjectBoundary(request, request.businessDate);
  return { request, refs: buildJobContextRefs({ jobId: 'research-job-1', request, boundary }) };
}

test('WMB-5171: research context refs round-trip losslessly through agent_tasks and rebuild the exact RoleJobRequest', async () => withDb((db) => {
  const { request, refs } = buildResearchRefs();
  const started = startAgentTask(db, { intent: 'research', businessDate: '2026-08-10', contextRefs: refs });
  assert.equal(started.ok, true, 'startAgentTask accepts research intent（与 v54 CHECK 并集一致）');
  assert.equal(started.data.intent, 'research');
  const task = getAgentTask(db, started.data.id);
  assert.ok(task, 'research task readable back');
  // context_refs_json 往返无损：readResearchGap 与 rebuildRoleJobRequest 均还原精确合同（续派方直接可用）。
  assert.deepEqual(readResearchGap(task.contextRefs), request.research, 'ResearchGap 从 context_refs 无损读回');
  assert.deepEqual(rebuildRoleJobRequest(task.contextRefs), request, '续派重建精确还原 RoleJobRequest');
  // 无 research 块的既有 reporter refs 保持老路径：readResearchGap → null（不误判为研究任务）。
  const plainReporter = startAgentTask(db, { intent: 'daily_scan', businessDate: '2026-08-11', contextRefs: { jobId: 'scan-job-1', roleId: 'reporter', brief: '渠道扫描' } });
  assert.equal(plainReporter.ok, true);
  assert.equal(readResearchGap(getAgentTask(db, plainReporter.data.id).contextRefs), null);
}));

test('WMB-5171: research progress and checkpoint round-trip losslessly through progress_json/checkpoint_json', async () => withDb((db) => {
  const { refs } = buildResearchRefs();
  const started = startAgentTask(db, { intent: 'research', businessDate: '2026-08-10', contextRefs: refs });
  const id = started.data.id;
  const checkpoint = buildResearchCheckpoint({
    round: 1, startedAt: '2026-08-10T02:00:00.000Z', budgetLeftMs: 600000, candidatesProcessed: 7,
    claimsSnapshot: { glm52_official_price_rise: 'pending' }
  });
  const reported = reportAgentTaskProgress(db, id, {
    phase: 'researching',
    progress: { planned: 40, processed: 7, verified: 3, saved: 2, message: '候选 7/40' },
    checkpoint
  });
  assert.equal(reported.ok, true);
  const task = getAgentTask(db, id);
  assert.deepEqual(parseResearchProgress(task.progress), { planned: 40, processed: 7, verified: 3, saved: 2, message: '候选 7/40' }, '预算计数 progress 无损');
  assert.deepEqual(parseResearchCheckpoint(task.checkpoint), {
    round: 1, startedAt: '2026-08-10T02:00:00.000Z', budgetLeftMs: 600000, candidatesProcessed: 7,
    claimsSnapshot: { glm52_official_price_rise: 'pending' }
  }, '可恢复现场 checkpoint 无损');
  // 续写 merge 语义：更新后不丢既有现场，仍可重读。
  const again = reportAgentTaskProgress(db, id, {
    checkpoint: buildResearchCheckpoint({ ...checkpoint, candidatesProcessed: 9, claimsSnapshot: { glm52_official_price_rise: 'supported' } })
  });
  assert.equal(again.ok, true);
  const resumedCheckpoint = parseResearchCheckpoint(getAgentTask(db, id).checkpoint);
  assert.equal(resumedCheckpoint.candidatesProcessed, 9);
  assert.equal(resumedCheckpoint.claimsSnapshot.glm52_official_price_rise, 'supported');
}));

test('WMB-5171: research EvidencePack round-trips losslessly through result_refs_json', async () => withDb((db) => {
  const { refs } = buildResearchRefs();
  const started = startAgentTask(db, { intent: 'research', businessDate: '2026-08-10', contextRefs: refs });
  const id = started.data.id;
  const pack = buildResearchEvidencePack({
    jobId: 'research-job-1',
    round: 1,
    claims: [
      { id: 'claim-row-1', key: 'glm52_official_price_rise', status: 'supported', verdictReason: '官方价页一手 + 独立二手', evidenceSourceIds: ['s1', 's2'], needsTimeExcerpt: true },
      { id: 'claim-row-2', key: 'glm52_safety_policy', status: 'unresolved', verdictReason: 'threshold_not_met', evidenceSourceIds: [], needsTimeExcerpt: true }
    ],
    sourceIds: ['s1', 's2'],
    validSourceCount: 15, candidateCount: 40, timeSpentMinutes: 11,
    terminalReason: 'claims_resolved',
    unresolvedRequiredClaims: ['glm52_safety_policy']
  });
  // EvidencePack 形状经既有 result_refs_json 列透传（写入侧由执行器落库）。
  db.prepare('UPDATE agent_tasks SET result_refs_json = ? WHERE id = ?').run(JSON.stringify(pack), id);
  const task = getAgentTask(db, id);
  assert.deepEqual(parseResearchEvidencePack(task.resultRefs), pack, 'EvidencePack 从 result_refs 无损读回');
}));

test('WMB-5171: corrupted research refs/progress/checkpoint/evidence fail closed', async () => withDb((db) => {
  const { refs } = buildResearchRefs();
  // context_refs 损坏 → readResearchGap/rebuildRoleJobRequest 均 null（绝不静默降级为普通 reporter）。
  const corruptedRefs = [
    { ...refs, research: { ...refs.research, requiredClaims: [] } },
    { ...refs, research: { ...refs.research, parentRoleId: 'reporter' } },
    { ...refs, research: { ...refs.research, budget: { ...refs.research.budget, maxRounds: 0 } } },
    { ...refs, research: undefined },
    { ...refs, jobId: undefined }
  ];
  for (const corrupted of corruptedRefs) {
    assert.equal(readResearchGap(corrupted), null, '损坏 research refs → null');
    assert.equal(rebuildRoleJobRequest(corrupted), null, '底层续派重建同源 fail-closed');
  }
  // progress 损坏 → null（预算机器执行不靠 prompt，非法计数拒绝继续）。
  assert.equal(parseResearchProgress({ planned: '40' }), null);
  assert.equal(parseResearchProgress({ processed: -1 }), null);
  assert.equal(parseResearchProgress({ verified: 2.5 }), null);
  assert.equal(parseResearchProgress({ saved: 0, message: 42 }), null);
  assert.equal(parseResearchProgress(null), null);
  assert.deepEqual(parseResearchProgress({ saved: 0 }), { saved: 0 }, '合法形状正常读回');
  // checkpoint 损坏 → null；写入侧构造拒绝。
  assert.equal(parseResearchCheckpoint({ round: 0, startedAt: 'x', budgetLeftMs: 1, candidatesProcessed: 0, claimsSnapshot: {} }), null);
  assert.equal(parseResearchCheckpoint({ round: 1, startedAt: '', budgetLeftMs: 1, candidatesProcessed: 0, claimsSnapshot: {} }), null);
  assert.equal(parseResearchCheckpoint({ round: 1, startedAt: 'x', budgetLeftMs: -5, candidatesProcessed: 0, claimsSnapshot: {} }), null);
  assert.equal(parseResearchCheckpoint({ round: 1, startedAt: 'x', budgetLeftMs: 1, candidatesProcessed: 0, claimsSnapshot: { k: 'verified' } }), null, '非五态 status 拒绝');
  assert.throws(() => buildResearchCheckpoint({ round: 1, startedAt: 'x', budgetLeftMs: 1, candidatesProcessed: 0, claimsSnapshot: { k: 'verified' } }), /研究检查点形状非法/);
  // EvidencePack 损坏 → null；写入侧构造拒绝。
  assert.equal(parseResearchEvidencePack({ kind: 'other', jobId: 'j' }), null);
  assert.equal(parseResearchEvidencePack({ kind: 'research_evidence', jobId: 'j', round: 0, claims: [], sourceIds: [], validSourceCount: 0, candidateCount: 0, timeSpentMinutes: 0, terminalReason: 'claims_resolved', unresolvedRequiredClaims: [] }), null);
  assert.equal(parseResearchEvidencePack({ kind: 'research_evidence', jobId: 'j', round: 1, claims: [{ id: 'c', key: 'k', status: 'verified', verdictReason: null, evidenceSourceIds: [], needsTimeExcerpt: false }], sourceIds: [], validSourceCount: 0, candidateCount: 0, timeSpentMinutes: 0, terminalReason: 'claims_resolved', unresolvedRequiredClaims: [] }), null);
  assert.equal(parseResearchEvidencePack({ kind: 'research_evidence', jobId: 'j', round: 1, claims: [], sourceIds: [], validSourceCount: 0, candidateCount: 0, timeSpentMinutes: 0, terminalReason: 'bogus', unresolvedRequiredClaims: [] }), null);
  assert.throws(() => buildResearchEvidencePack({ jobId: 'j', round: 1, claims: [], sourceIds: [], validSourceCount: 0, candidateCount: 0, timeSpentMinutes: 0, terminalReason: 'bogus', unresolvedRequiredClaims: [] }), /EvidencePack 形状非法/);
}));

test('WMB-5171: recoverInterruptedAgentTasks puts running research into resume_pending while old intents keep existing semantics', async () => withDb((db) => {
  const { refs } = buildResearchRefs();
  const research = startAgentTask(db, { intent: 'research', businessDate: '2026-08-10', contextRefs: refs });
  const daily = startAgentTask(db, { intent: 'daily_scan', businessDate: '2026-08-10' });
  const studio = startAgentTask(db, { intent: 'studio_draft', businessDate: '2026-08-10', contextRefs: { projectId: 'p1' } });
  const page = startAgentTask(db, { intent: 'page_agents', businessDate: '2026-08-10' });
  const waiting = startAgentTask(db, { intent: 'results_review', businessDate: '2026-08-10' });
  assert.equal(needsUserAgentTask(db, waiting.data.id, 'REVIEW_WAITING', '等你批').ok, true);
  assert.equal(research.ok && daily.ok && studio.ok && page.ok && waiting.ok, true);

  const interruptedCount = recoverInterruptedAgentTasks(db);
  assert.equal(interruptedCount, 2, '仅非 daily/非 research 的 running 任务计 interrupted（studio + page）');

  const researchTask = getAgentTask(db, research.data.id);
  assert.equal(researchTask.status, 'running', 'research 状态保持 running');
  assert.equal(researchTask.phase, 'resume_pending', 'research 进入 resume_pending');
  assert.equal(researchTask.errorCode, null);
  assert.equal(researchTask.errorMessage, '应用重启，正在从检查点继续。');
  assert.deepEqual(readResearchGap(researchTask.contextRefs), parseRoleJobRequest(RESEARCH_REQUEST).research, '重启后 research 合同仍可恢复');

  const dailyTask = getAgentTask(db, daily.data.id);
  assert.equal(dailyTask.phase, 'resume_pending', 'daily_* 既有 resume_pending 行为不变');

  const studioTask = getAgentTask(db, studio.data.id);
  assert.equal(studioTask.status, 'interrupted', 'studio_draft 仍走 interrupted');
  assert.equal(studioTask.phase, 'interrupted');
  const pageTask = getAgentTask(db, page.data.id);
  assert.equal(pageTask.status, 'interrupted', 'page_* 仍走 interrupted');

  const waitingTask = getAgentTask(db, waiting.data.id);
  assert.equal(waitingTask.status, 'needs_user', 'needs_user 不受重启恢复影响');
}));

test('WMB-5171: cancelling a research task uses the existing state machine and retains committed research_claims rows', async () => withDb((db) => {
  const { refs } = buildResearchRefs();
  const started = startAgentTask(db, { intent: 'research', businessDate: '2026-08-10', contextRefs: refs });
  const id = started.data.id;
  const claim = upsertResearchClaim(db, { taskId: id, claimKey: 'glm52_official_price_rise', claimText: 'GLM 5.2 官方在 OpenRouter 涨价', claimType: 'price', status: 'pending' });
  assert.equal(claim.ok, true);

  const cancelled = cancelAgentTask(db, id);
  assert.equal(cancelled.ok, true, 'running research 可取消（既有状态机）');
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.phase, 'cancelled');
  assert.equal(cancelled.data.errorCode, 'CANCELLED');

  const retained = getResearchClaim(db, id, 'glm52_official_price_rise');
  assert.ok(retained, '已入库 research_claims 行在取消后保留');
  assert.equal(retained.status, 'pending');
  assert.equal(listResearchClaims(db, id).length, 1, '取消不删除任何 claim 行');
  assert.deepEqual(readResearchGap(getAgentTask(db, id).contextRefs), parseRoleJobRequest(RESEARCH_REQUEST).research, '取消后 context refs 仍完整可读');

  const again = cancelAgentTask(db, id);
  assert.equal(again.ok, true, '已取消任务二次取消幂等（既有语义）');
  assert.equal(again.data.status, 'cancelled');
}));
