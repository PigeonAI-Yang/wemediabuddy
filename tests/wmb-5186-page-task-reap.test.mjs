import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  PAGE_TASK_ORPHANED_ERROR_CODE,
  dispatchReapOrphanedPageTasks,
  interruptPageTaskOrphan,
  listOrphanedPageTasks,
  pageTaskOrphanMs,
  reapOrphanedPageTasks,
  touchAgentTaskHeartbeat
} from '../src/main/page-task-orphan.ts';
import { getAgentTask, recoverInterruptedAgentTasks } from '../src/main/agent-tasks.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';

// WMB-5186：page_* 失活收尸聚焦测试。收尸判定=status=running + heartbeat 陈旧 + 无 live worker；
// 阈值走 env（WMB_PAGE_TASK_ORPHAN_MS=1000，下限 1s），陈旧行用固定远古时间戳，判定确定。
process.env.WMB_PAGE_TASK_ORPHAN_MS = '1000';

const PAGE_INTENTS = [
  'page_today', 'page_agents', 'page_discover', 'page_proposals', 'page_topic',
  'page_library', 'page_canvas', 'page_studio', 'page_publish', 'page_results'
];
const RUNNER_INTENTS = ['daily_intelligence', 'daily_scan', 'daily_judge', 'studio_draft', 'results_review', 'research'];
const OLD = '2026-08-01T00:00:00.000Z';
const FRESH = () => new Date().toISOString();

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5186-page-reap-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function insertTask(database, {
  id, intent, businessDate = '2026-08-11', status = 'running', phase = 'starting',
  updatedAt = OLD, heartbeatAt = OLD, createdAt = OLD, errorCode = null, contextRefs = {}
}) {
  database.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, control_action, heartbeat_at, error_code, error_message,
    created_at, updated_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, '{}', '{}', '{}', '[]', NULL, ?, ?, NULL, ?, ?, NULL)`).run(
    id, intent, businessDate, status, phase, JSON.stringify(contextRefs), heartbeatAt, errorCode, createdAt, updatedAt
  );
}

function auditRows(database, id) {
  return database.prepare(
    `SELECT command, entity_id AS entityId, actor_type AS actorType, error_code AS errorCode, result
     FROM operation_log WHERE command = 'agent_tasks.interrupt_page_orphan' AND entity_id = ?`
  ).all(id);
}

test('threshold is a named conservative constant with env override', () => {
  assert.equal(pageTaskOrphanMs(), 1000);
  const saved = process.env.WMB_PAGE_TASK_ORPHAN_MS;
  delete process.env.WMB_PAGE_TASK_ORPHAN_MS;
  try {
    assert.equal(pageTaskOrphanMs(), 30 * 60_000);
  } finally {
    process.env.WMB_PAGE_TASK_ORPHAN_MS = saved;
  }
});

test('stale starting page task reaps to interrupted with audit and finished_at', async () => {
  await withDb((database) => {
    insertTask(database, { id: 't-starting', intent: 'page_studio', phase: 'starting' });
    const { reaped } = reapOrphanedPageTasks(database, () => false);
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].id, 't-starting');
    assert.equal(reaped[0].status, 'interrupted');
    assert.equal(reaped[0].phase, 'interrupted');
    assert.equal(reaped[0].errorCode, PAGE_TASK_ORPHANED_ERROR_CODE);
    assert.notEqual(reaped[0].finishedAt, null);
    const row = getAgentTask(database, 't-starting');
    assert.equal(row.status, 'interrupted');
    const audit = auditRows(database, 't-starting');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actorType, 'scheduler');
    assert.equal(audit[0].errorCode, PAGE_TASK_ORPHANED_ERROR_CODE);
    assert.equal(audit[0].result, 'error');
  });
});

test('stale report-phase page task reaps', async () => {
  await withDb((database) => {
    insertTask(database, { id: 't-report', intent: 'page_agents', phase: 'report' });
    const { reaped } = reapOrphanedPageTasks(database, () => false);
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].id, 't-report');
    assert.equal(reaped[0].status, 'interrupted');
    assert.equal(reaped[0].errorCode, PAGE_TASK_ORPHANED_ERROR_CODE);
  });
});

test('all 10 page intents reap; runner intents untouched', async () => {
  await withDb((database) => {
    PAGE_INTENTS.forEach((intent, index) => insertTask(database, { id: `p-${index}`, intent }));
    RUNNER_INTENTS.forEach((intent, index) => insertTask(database, { id: `r-${index}`, intent }));
    const { reaped } = reapOrphanedPageTasks(database, () => false);
    assert.equal(reaped.length, PAGE_INTENTS.length);
    const reapedIds = new Set(reaped.map((task) => task.id));
    assert.equal(reapedIds.size, PAGE_INTENTS.length);
    for (const task of reaped) {
      assert.equal(task.status, 'interrupted');
      assert.equal(task.errorCode, PAGE_TASK_ORPHANED_ERROR_CODE);
      assert.notEqual(task.finishedAt, null);
    }
    RUNNER_INTENTS.forEach((intent, index) => {
      const task = getAgentTask(database, `r-${index}`);
      assert.equal(task.status, 'running', `${intent} must stay running`);
    });
  });
});

test('fresh heartbeat page task is not listed nor reaped', async () => {
  await withDb((database) => {
    insertTask(database, { id: 't-fresh', intent: 'page_canvas', updatedAt: FRESH(), heartbeatAt: FRESH() });
    assert.deepEqual(listOrphanedPageTasks(database).map((task) => task.id), []);
    const { reaped } = reapOrphanedPageTasks(database, () => false);
    assert.equal(reaped.length, 0);
    assert.equal(getAgentTask(database, 't-fresh').status, 'running');
  });
});

test('live worker binding prevents reap of stale page task', async () => {
  await withDb((database) => {
    insertTask(database, { id: 't-live', intent: 'page_today' });
    const { reaped } = reapOrphanedPageTasks(database, (taskId) => taskId === 't-live');
    assert.equal(reaped.length, 0);
    assert.equal(getAgentTask(database, 't-live').status, 'running');
    assert.equal(auditRows(database, 't-live').length, 0);
  });
});

test('needs_user and non-page running rows are never reaped', async () => {
  await withDb((database) => {
    insertTask(database, { id: 't-needs', intent: 'page_publish', status: 'needs_user', phase: 'needs_user', errorCode: 'NEEDS_USER' });
    insertTask(database, { id: 't-daily', intent: 'daily_intelligence' });
    insertTask(database, { id: 't-research', intent: 'research' });
    const { reaped } = reapOrphanedPageTasks(database, () => false);
    assert.equal(reaped.length, 0);
    assert.equal(getAgentTask(database, 't-needs').status, 'needs_user');
    assert.equal(getAgentTask(database, 't-daily').status, 'running');
    assert.equal(getAgentTask(database, 't-research').status, 'running');
  });
});

test('concurrent latest heartbeat wins over sweep transition', async () => {
  await withDb((database) => {
    insertTask(database, { id: 't-race', intent: 'page_library' });
    assert.equal(listOrphanedPageTasks(database).length, 1);
    const nowMs = Date.now();
    const touched = touchAgentTaskHeartbeat(database, 't-race');
    assert.equal(touched.ok, true);
    const result = interruptPageTaskOrphan(database, 't-race', nowMs);
    assert.equal(result.transitioned, false);
    assert.equal(result.data.status, 'running');
    assert.equal(auditRows(database, 't-race').length, 0);
  });
});

test('repeated sweep is idempotent with zero second writes and restart path not regressed', async () => {
  await withDb((database) => {
    insertTask(database, { id: 't-idem', intent: 'page_proposals' });
    const first = reapOrphanedPageTasks(database, () => false);
    assert.equal(first.reaped.length, 1);
    assert.equal(auditRows(database, 't-idem').length, 1);
    const second = reapOrphanedPageTasks(database, () => false);
    assert.equal(second.reaped.length, 0);
    assert.equal(auditRows(database, 't-idem').length, 1, 'no second audit row');
    const task = getAgentTask(database, 't-idem');
    assert.equal(task.status, 'interrupted');
    assert.equal(recoverInterruptedAgentTasks(database), 0, 'terminal rows untouched by restart path');
    assert.equal(getAgentTask(database, 't-idem').status, 'interrupted');
  });
});

test('legal busy + zero instances transient is preserved', async () => {
  await withDb((database) => {
    insertTask(database, { id: 't-busy', intent: 'page_canvas', phase: 'starting', updatedAt: FRESH(), heartbeatAt: FRESH() });
    for (let round = 0; round < 3; round += 1) {
      const { reaped } = reapOrphanedPageTasks(database, (taskId) => taskId === 't-busy');
      assert.equal(reaped.length, 0);
    }
    const task = getAgentTask(database, 't-busy');
    assert.equal(task.status, 'running');
    assert.equal(task.phase, 'starting', 'starting phase stays honest');
    const jobs = database.prepare('SELECT COUNT(*) AS n FROM jobs').get();
    assert.equal(jobs.n, 0, 'sweep never fabricates JobPool instances');
  });
});

test('interruptPageTaskOrphan rejects missing task', async () => {
  await withDb((database) => {
    const result = interruptPageTaskOrphan(database, 'missing');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NOT_FOUND');
  });
});

// WMB-5186 实机根因回归：sweep 曾以 runtime.database 裸调收尸，写守卫
// （WMB_WRITE_REQUIRES_COMMAND_DISPATCH）拒绝后 page_* 孤儿永不收敛。本测试用真
// ActiveWorkspaceRuntime（open 即装守卫）先证明裸调用必抛，再证明 dispatch 包装成功
// 收尸（interrupted/PAGE_TASK_ORPHANED/audit once），且重复包装幂等。
test('real runtime write guard: bare DB reap throws WMB_WRITE_REQUIRES_COMMAND_DISPATCH; dispatch wrapper reaps once and is idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5186-write-guard-'));
  let runtime;
  try {
    const database = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`workspace-${randomUUID()}`, now, now);
    // 写守卫在 ActiveWorkspaceRuntime 构造时安装 → 种子行必须在打开 runtime 之前写入。
    insertTask(database, { id: 't-guard', intent: 'page_studio', phase: 'starting' });
    database.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'wmb5186-write-guard-epoch' });
    const isLiveWorker = (taskId) => runtime.getWorkerSnapshots().some((worker) => worker.taskId === taskId);
    // 1) 原裸调用（修复前实机错误路径）：守卫拒绝写 → 抛 WMB_WRITE_REQUIRES_COMMAND_DISPATCH，孤儿保持 running。
    assert.throws(() => reapOrphanedPageTasks(runtime.database, isLiveWorker), /WMB_WRITE_REQUIRES_COMMAND_DISPATCH/);
    assert.equal(getAgentTask(runtime.database, 't-guard').status, 'running', 'rejected bare write leaves the orphan untouched');
    assert.equal(auditRows(runtime.database, 't-guard').length, 0);
    // 2) runtime wrapper 经 dispatchBusinessCommand → runtime.dispatchCommand 写授权深度收尸。
    const { reaped } = await dispatchReapOrphanedPageTasks(runtime, isLiveWorker);
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].id, 't-guard');
    assert.equal(reaped[0].status, 'interrupted');
    assert.equal(reaped[0].phase, 'interrupted');
    assert.equal(reaped[0].errorCode, PAGE_TASK_ORPHANED_ERROR_CODE);
    assert.notEqual(reaped[0].finishedAt, null);
    const audit = auditRows(runtime.database, 't-guard');
    assert.equal(audit.length, 1, 'audit written exactly once');
    assert.equal(audit[0].actorType, 'scheduler');
    assert.equal(audit[0].errorCode, PAGE_TASK_ORPHANED_ERROR_CODE);
    assert.equal(audit[0].result, 'error');
    // 3) 重复 wrapper（新 requestId 新轮，但零 eligible 候选 → 只读短路不 dispatch）：
    //    零收尸、零二次审计、不新增 command receipt。
    const recoverReceipts = () => runtime.database.prepare(
      "SELECT COUNT(*) AS n FROM command_receipts WHERE workspace_id = ? AND command = 'agent_tasks.recover_interrupted'"
    ).get(runtime.identity.workspaceId).n;
    assert.equal(recoverReceipts(), 1, 'first dispatch wrote exactly one recover receipt');
    const second = await dispatchReapOrphanedPageTasks(runtime, isLiveWorker);
    assert.equal(second.reaped.length, 0);
    assert.equal(recoverReceipts(), 1, 'idempotent repeat with zero eligible orphans short-circuits without dispatch');
    assert.equal(auditRows(runtime.database, 't-guard').length, 1, 'no second audit row on idempotent repeat');
    assert.equal(getAgentTask(runtime.database, 't-guard').status, 'interrupted');
  } finally {
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
