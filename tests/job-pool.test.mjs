import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MAX_WORKERS, JobPool, RESOURCE_WAIT_CODES } from '../src/main/job-pool.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  deriveIntentForRole,
  deriveResourceLocks,
  deriveRoleJobSpec,
  JOB_ERROR_CODES,
  mapOutcomeToTerminal,
  parseNoopDeclaration,
  parseRoleJobRequest,
  readbackContentVersion,
  readbackLibraryMutation,
  readbackPlansRevision,
  readbackScanPhase
} from '../src/main/role-job-registry.ts';

test('default maxWorkers is 2 and three FIFO jobs leave the third queued', () => {
  assert.equal(DEFAULT_MAX_WORKERS, 2);
  const pool = new JobPool();
  const a = pool.submit({ roleId: 'reporter', brief: 'A', resourceLocks: ['scan:ws:d:all'] });
  const b = pool.submit({ roleId: 'planner', brief: 'B', resourceLocks: ['plan:ws:d'] });
  const c = pool.submit({ roleId: 'writer', brief: 'C', resourceLocks: ['project:ws:p1'] });
  assert.equal(pool.activeEmployeeCount(), 2);
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'running');
  assert.equal(c.status, 'queued');
  assert.equal(c.startedAt, null);
});

test('completing a job promotes the FIFO next job into the freed slot', () => {
  const pool = new JobPool(2);
  const a = pool.submit({ roleId: 'reporter', brief: 'A', resourceLocks: ['scan:ws:d:all'] });
  const b = pool.submit({ roleId: 'planner', brief: 'B', resourceLocks: ['plan:ws:d'] });
  const c = pool.submit({ roleId: 'writer', brief: 'C', resourceLocks: ['project:ws:p1'] });
  pool.complete(a.id);
  assert.equal(pool.get(a.id).status, 'succeeded');
  assert.equal(pool.get(a.id).finishedAt !== null, true);
  assert.equal(pool.activeEmployeeCount(), 2);
  const promoted = pool.get(c.id);
  assert.equal(promoted.status, 'running');
  assert.equal(promoted.startedAt !== null, true);
  assert.equal(b.status, 'running');
});

test('cancel frees the slot for the next queued job', () => {
  const pool = new JobPool(1);
  const a = pool.submit({ roleId: 'reporter', brief: 'A', resourceLocks: ['scan:ws:d:all'] });
  const b = pool.submit({ roleId: 'reporter', brief: 'B', resourceLocks: ['scan:ws:d:all'] });
  assert.equal(pool.activeEmployeeCount(), 1);
  assert.equal(pool.get(b.id).status, 'queued');
  pool.cancel(a.id);
  assert.equal(pool.get(a.id).status, 'cancelled');
  assert.equal(pool.get(b.id).status, 'running');
  assert.equal(pool.activeEmployeeCount(), 1);
});

test('L0-1 lock conflict parks into waiting_resource and auto-promotes after release', () => {
  const pool = new JobPool(2);
  const holder = pool.submit({ roleId: 'reporter', brief: 'A', resourceLocks: ['scan:ws:2026-08-08:all'] });
  const parked = pool.submit({ roleId: 'reporter', brief: 'B', resourceLocks: ['scan:ws:2026-08-08:all'] });
  assert.equal(pool.acquireEntityLocks(holder.id).ok, true);
  assert.equal(pool.acquireEntityLocks(parked.id).code, 'JOB_LOCK_CONFLICT');
  pool.park(parked.id, 'RESOURCE_LOCK_CONFLICT', 'scan:ws:2026-08-08:all (held by holder)');
  const waiting = pool.get(parked.id);
  assert.equal(waiting.status, 'waiting_resource');
  assert.match(waiting.waitReason, /RESOURCE_LOCK_CONFLICT/);
  assert.ok(waiting.waitingSince, 'waitingSince recorded');
  assert.equal(pool.activeEmployeeCount(), 1, 'parked job does not occupy a slot');
  // Holder terminates -> lock released -> parked job promotes automatically (FIFO).
  pool.complete(holder.id);
  const promoted = pool.get(parked.id);
  assert.equal(promoted.status, 'running');
  assert.equal(promoted.waitReason, null, 'waitReason cleared on promotion');
  pool.complete(promoted.id);
  assert.equal(pool.get(promoted.id).status, 'succeeded');
});

test('L0-2 lease-busy park stays parked (no self re-promote) then promotes via rescan', () => {
  const pool = new JobPool(1);
  const a = pool.submit({ roleId: 'reporter', brief: 'A', resourceLocks: ['scan:ws:d:all'] });
  pool.park(a.id, 'RESOURCE_LEASE_BUSY', 'Pi worker 数量已达软上限（8），请等待工单释放。');
  const parked = pool.get(a.id);
  assert.equal(parked.status, 'waiting_resource');
  assert.match(parked.waitReason, /RESOURCE_LEASE_BUSY/);
  assert.equal(pool.activeEmployeeCount(), 0, 'lease-busy park frees the slot');
  // park must NOT immediately re-promote the same job into the still-busy slot.
  assert.equal(pool.get(a.id).status, 'waiting_resource');
  // Resource release event (watchdog / other job terminal) re-scans parked lane.
  assert.equal(pool.rescan(), 1);
  assert.equal(pool.get(a.id).status, 'running');
  pool.complete(a.id);
  assert.equal(pool.get(a.id).status, 'succeeded', 'never failed during lease wait');
});

test('L0-3 cancel matrix: queued / waiting_resource / running all cancel consistently', () => {
  const pool = new JobPool(2);
  // queued
  const q1 = pool.submit({ roleId: 'reporter', brief: 'q1', resourceLocks: ['scan:ws:d:all'] });
  const q2 = pool.submit({ roleId: 'reporter', brief: 'q2', resourceLocks: ['scan:ws:d:all'] });
  const q3 = pool.submit({ roleId: 'reporter', brief: 'q3', resourceLocks: ['scan:ws:d:all'] });
  pool.cancel(q3.id);
  assert.equal(pool.get(q3.id).status, 'cancelled');
  // waiting_resource
  assert.equal(pool.acquireEntityLocks(q1.id).ok, true);
  assert.equal(pool.acquireEntityLocks(q2.id).code, 'JOB_LOCK_CONFLICT');
  pool.park(q2.id, 'RESOURCE_LOCK_CONFLICT', 'scan:ws:d:all');
  assert.equal(pool.get(q2.id).status, 'waiting_resource');
  pool.cancel(q2.id);
  assert.equal(pool.get(q2.id).status, 'cancelled');
  assert.equal(pool.get(q2.id).finishedAt !== null, true);
  // running
  pool.cancel(q1.id);
  assert.equal(pool.get(q1.id).status, 'cancelled');
});

test('L0-4 role lock matrix: same-day reporter+writer+librarian run concurrently; same-key seconds wait', () => {
  const pool = new JobPool(6);
  const reporter = pool.submit({ roleId: 'reporter', brief: 'scan', resourceLocks: ['scan:ws:2026-08-08:all'] });
  const writer = pool.submit({ roleId: 'writer', brief: 'draft', resourceLocks: ['project:ws:p1'] });
  const librarian = pool.submit({ roleId: 'librarian', brief: 'library', resourceLocks: ['library-maintenance:ws'] });
  // 槽位充足：三单均 running，锁键互不串扰（同日 reporter+writer+librarian 并发）。
  assert.equal(reporter.status, 'running');
  assert.equal(writer.status, 'running');
  assert.equal(librarian.status, 'running');
  assert.equal(pool.acquireEntityLocks(reporter.id).ok, true);
  assert.equal(pool.acquireEntityLocks(writer.id).ok, true);
  assert.equal(pool.acquireEntityLocks(librarian.id).ok, true);

  // 同 project 键 writer 第二单：running 后拿锁冲突 → park → waiting_resource。
  const writer2 = pool.submit({ roleId: 'writer', brief: 'draft2', resourceLocks: ['project:ws:p1'] });
  assert.equal(writer2.status, 'running', '槽位足够，第二单先晋升 running');
  assert.equal(pool.acquireEntityLocks(writer2.id).code, 'JOB_LOCK_CONFLICT');
  pool.park(writer2.id, 'RESOURCE_LOCK_CONFLICT', 'project:ws:p1');
  assert.equal(pool.get(writer2.id).status, 'waiting_resource');
  // 不同项目 writer 并发不受影响。
  const writer3 = pool.submit({ roleId: 'writer', brief: 'draft3', resourceLocks: ['project:ws:p2'] });
  assert.equal(writer3.status, 'running');
  assert.equal(pool.acquireEntityLocks(writer3.id).ok, true, 'different project does not conflict');

  // 同 workspace librarian 第二单：running → 冲突 → park → waiting_resource。
  const librarian2 = pool.submit({ roleId: 'librarian', brief: 'library2', resourceLocks: ['library-maintenance:ws'] });
  assert.equal(librarian2.status, 'running');
  assert.equal(pool.acquireEntityLocks(librarian2.id).code, 'JOB_LOCK_CONFLICT');
  pool.park(librarian2.id, 'RESOURCE_LOCK_CONFLICT', 'library-maintenance:ws');
  assert.equal(pool.get(librarian2.id).status, 'waiting_resource');
});

test('L0-5 terminal mapping: abort always beats any outcome', () => {
  const succeeded = { status: 'succeeded', code: 'OK', message: null, readback: null };
  const failed = { status: 'failed', code: 'JOB_FAILED', message: 'boom', readback: null };
  const partial = { status: 'partial', code: 'PARTIAL', message: null, readback: null };
  const needsUser = { status: 'needs_user', code: 'NEEDS_USER', message: null, readback: null };
  assert.equal(mapOutcomeToTerminal(succeeded, false).pool, 'succeeded');
  assert.equal(mapOutcomeToTerminal(succeeded, false).agentTask, 'succeeded');
  assert.equal(mapOutcomeToTerminal(failed, false).pool, 'failed');
  assert.equal(mapOutcomeToTerminal(partial, false).pool, 'partial');
  assert.equal(mapOutcomeToTerminal(needsUser, false).pool, 'needs_user');
  // abort + any outcome -> cancelled, never其余四态。
  for (const outcome of [succeeded, failed, partial, needsUser]) {
    const mapped = mapOutcomeToTerminal(outcome, true);
    assert.equal(mapped.pool, 'cancelled');
    assert.equal(mapped.agentTask, 'cancelled');
    assert.equal(mapped.code, JOB_ERROR_CODES.JOB_CANCELLED);
  }
});

test('spawn input validation: intent/planDate/unknown keys rejected at runtime', () => {
  assert.throws(() => parseRoleJobRequest({ roleId: 'reporter', brief: 'x', intent: 'studio_draft' }), (error) => {
    assert.equal(error.code, JOB_ERROR_CODES.VALIDATION_ERROR);
    return true;
  });
  assert.throws(() => parseRoleJobRequest({ roleId: 'planner', brief: 'x', planDate: '2026-08-08' }), (error) => {
    assert.equal(error.code, JOB_ERROR_CODES.VALIDATION_ERROR);
    return true;
  });
  assert.throws(() => parseRoleJobRequest({ roleId: 'reporter', brief: 'x', bogus: 1 }), (error) => {
    assert.equal(error.code, JOB_ERROR_CODES.VALIDATION_ERROR);
    return true;
  });
  assert.throws(() => parseRoleJobRequest({ roleId: 'desk', brief: 'x' }), (error) => {
    assert.equal(error.code, JOB_ERROR_CODES.ROLE_NOT_SPAWNABLE);
    return true;
  });
  assert.throws(() => parseRoleJobRequest({ roleId: 'writer', brief: 'x' }), (error) => {
    assert.equal(error.code, JOB_ERROR_CODES.JOB_PROJECT_REQUIRED);
    return true;
  });
  assert.throws(() => parseRoleJobRequest({ roleId: 'reporter', brief: '  ' }), (error) => {
    assert.equal(error.code, JOB_ERROR_CODES.JOB_BRIEF_REQUIRED);
    return true;
  });
  const ok = parseRoleJobRequest({ roleId: 'reporter', brief: '扫', businessDate: '2026-08-08', channelIds: ['c1', 'c2'] });
  assert.equal(ok.roleId, 'reporter');
  assert.deepEqual(ok.channelIds, ['c1', 'c2']);
});

test('L1-2 derivation table: four roles map to locked intents and resource lock keys', () => {
  assert.equal(deriveIntentForRole('reporter'), 'daily_scan');
  assert.equal(deriveIntentForRole('planner'), 'daily_judge');
  assert.equal(deriveIntentForRole('writer'), 'studio_draft');
  assert.equal(deriveIntentForRole('librarian'), 'page_library');
  // 锁键固定（合同 §3）
  assert.deepEqual(deriveResourceLocks({ roleId: 'reporter', workspaceId: 'ws', businessDate: '2026-08-08' }), ['scan:ws:2026-08-08:all']);
  assert.deepEqual(deriveResourceLocks({ roleId: 'reporter', workspaceId: 'ws', businessDate: '2026-08-08', channelIds: ['c1'] }), ['scan:ws:2026-08-08:c1']);
  assert.deepEqual(deriveResourceLocks({ roleId: 'planner', workspaceId: 'ws', businessDate: '2026-08-08' }), ['plan:ws:2026-08-08']);
  assert.deepEqual(deriveResourceLocks({ roleId: 'writer', workspaceId: 'ws', businessDate: '2026-08-08', projectId: 'p1' }), ['project:ws:p1']);
  assert.deepEqual(deriveResourceLocks({ roleId: 'librarian', workspaceId: 'ws', businessDate: '2026-08-08' }), ['library-maintenance:ws']);
  const spec = deriveRoleJobSpec({ roleId: 'writer', brief: 'draft', projectId: 'p1' }, 'ws');
  assert.equal(spec.intent, 'studio_draft');
  assert.equal(spec.policy, 'draft');
  assert.deepEqual(spec.resourceLocks, ['project:ws:p1']);
});

function openDatabase(directory) {
  return migrateDatabase(path.join(directory, 'wmb.db'));
}

test('L0-6 readback rules: scan phase / plans revision / content version / library mutation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-pool-readback-'));
  const db = openDatabase(directory);
  try {
    const now = new Date().toISOString();
    // reporter: channel_scanned 到达 -> scan_phase_reached；未到达 -> null
    db.prepare(`INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json, progress_json, checkpoint_json, events_json, heartbeat_at, error_code, error_message, created_at, updated_at, finished_at)
      VALUES ('scan-task', 'daily_scan', '2026-08-08', 'running', 'channel_scanned', NULL, '{}', '{}', '{}', '{}', '[]', ?, NULL, NULL, ?, ?, NULL)`).run(now, now, now);
    assert.deepEqual(readbackScanPhase(db, 'scan-task'), { kind: 'scan_phase_reached', phase: 'channel_scanned' });
    db.prepare(`INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json, progress_json, checkpoint_json, events_json, heartbeat_at, error_code, error_message, created_at, updated_at, finished_at)
      VALUES ('scan-task-2', 'daily_scan', '2026-08-08', 'running', 'scanning', NULL, '{}', '{}', '{}', '{}', '[]', ?, NULL, NULL, ?, ?, NULL)`).run(now, now, now);
    assert.equal(readbackScanPhase(db, 'scan-task-2'), null);
    // 评审 MAJOR 1：零增量成功收尾以 succeeded+completed 落终态 → 同样是 scan_phase_reached（不得 JOB_READBACK_MISSING 分叉）
    db.prepare(`INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json, progress_json, checkpoint_json, events_json, heartbeat_at, error_code, error_message, created_at, updated_at, finished_at)
      VALUES ('scan-task-3', 'daily_scan', '2026-08-08', 'succeeded', 'completed', NULL, '{}', '{}', '{}', '{}', '[]', ?, NULL, NULL, ?, ?, ?)`).run(now, now, now, now);
    assert.deepEqual(readbackScanPhase(db, 'scan-task-3'), { kind: 'scan_phase_reached', phase: 'completed' });

    // planner: 当日 is_current plan 行存在 → plans_revision（空方案也成行）；无 plan 行但有收据 → noop_confirmed；两者皆无 → null
    assert.equal(readbackPlansRevision(db, '2026-08-08', 'judge-task'), null);
    db.prepare("INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES ('plan-1', '2026-08-08', 'Asia/Shanghai', '', 1, ?, ?, 1)").run(now, now);
    assert.deepEqual(readbackPlansRevision(db, '2026-08-08', 'judge-task'), { kind: 'plans_revision', planDate: '2026-08-08', revision: 1 });
    db.prepare("INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES ('plan-2', '2026-08-09', 'Asia/Shanghai', '', 1, ?, ?, 1)").run(now, now);
    // 08-09 已有 is_current plan → plans_revision（不是 noop_confirmed，读回按真实数据判定）
    assert.deepEqual(readbackPlansRevision(db, '2026-08-09', 'judge-task'), { kind: 'plans_revision', planDate: '2026-08-09', revision: 1 });
    // 无 plan 行但有 plans.save 收据 -> noop_confirmed
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, side_effect_state, created_at)
      VALUES ('r1', 'ws', 'epoch', 'judge-task:plan', 'plans.save', 'h', 'pi', 'pi', 'judge-task', '{}', '{}', 'ok', '{}', ?)`).run(now);
    assert.deepEqual(readbackPlansRevision(db, '2026-08-10', 'judge-task'), { kind: 'noop_confirmed', scope: 'plan:2026-08-10' });

    // writer: 项目存在且有核心版本 -> content_version；无版本 -> null
    assert.equal(readbackContentVersion(db, 'proj-1'), null);
    db.prepare("INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES ('proj-1', '项目', ?, ?, 1)").run(now, now);
    assert.equal(readbackContentVersion(db, 'proj-1'), null, 'no core version yet');
    db.prepare("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('ver-1', 'proj-1', '正文', 1, ?)").run(now);
    assert.deepEqual(readbackContentVersion(db, 'proj-1'), { kind: 'content_version', projectId: 'proj-1', versionId: 'ver-1' });

    // librarian（WMB-5121 结构化 no-op）：收据>=1 → sources_mutated；零收据仅认末条最后 ```json {"wmb_noop":true} 围栏 → noop_confirmed；
    // 存量自然语言 no-op（无围栏）/静默无写 → 保守 null（JOB_READBACK_MISSING，不得假成功）
    const sessionDir = path.join(directory, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const fenceSession = path.join(sessionDir, 'noop-fence.jsonl');
    await writeFile(fenceSession, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '检查完毕，本次无变更。\n```json\n{"wmb_noop": true}\n```' }] } }) + '\n', 'utf8');
    assert.deepEqual(await readbackLibraryMutation(db, 'lib-task', now, fenceSession), { kind: 'noop_confirmed', scope: 'workspace' });
    const noopSession = path.join(sessionDir, 'noop.jsonl');
    await writeFile(noopSession, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '检查完毕，本次无变更。' }] } }) + '\n', 'utf8');
    assert.equal(await readbackLibraryMutation(db, 'lib-task', now, noopSession), null, '存量无围栏 no-op 会话 → 保守失败（不假成功）');
    const silentSession = path.join(sessionDir, 'silent.jsonl');
    await writeFile(silentSession, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '已整理完成，共 3 条。' }] } }) + '\n', 'utf8');
    assert.equal(await readbackLibraryMutation(db, 'lib-task', now, silentSession), null, '静默无写 → JOB_READBACK_MISSING');
    assert.equal(await readbackLibraryMutation(db, 'lib-task', now, path.join(sessionDir, 'missing.jsonl')), null, '会话文件缺失 → 无证据');
    // 收据 >= 1 → sources_mutated（围栏被忽略，mutation 赢）
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, side_effect_state, created_at)
      VALUES ('r2', 'ws', 'epoch', 'lib-task:upsert', 'sources.upsert_batch', 'h', 'pi', 'pi', 'lib-task', '{}', '{}', 'ok', '{}', ?)`).run(now);
    const mutated = await readbackLibraryMutation(db, 'lib-task', now, fenceSession);
    assert.equal(mutated.kind, 'sources_mutated');
    assert.ok(mutated.count >= 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('WMB-5121 T-18: librarian no-op 矩阵（围栏/附加键/非法/非末条/finalText 免读文件）', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-noop-matrix-'));
  const db = openDatabase(directory);
  try {
    const now = new Date().toISOString();
    const sessionDir = path.join(directory, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const session = async (text) => {
      const file = path.join(sessionDir, `s-${Math.random().toString(36).slice(2)}.jsonl`);
      await writeFile(file, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n', 'utf8');
      return file;
    };
    // M1 末条最后围栏 {"wmb_noop":true} → noop_confirmed
    assert.deepEqual(await readbackLibraryMutation(db, 'mt-task', now, await session('```json\n{"wmb_noop": true}\n```')), { kind: 'noop_confirmed', scope: 'workspace' });
    // M2 附加键（如 scope）接受
    assert.deepEqual(await readbackLibraryMutation(db, 'mt-task', now, await session('```json\n{"wmb_noop": true, "scope": "workspace"}\n```')), { kind: 'noop_confirmed', scope: 'workspace' });
    // M3 围栏 JSON 坏 → null（保守失败）
    assert.equal(await readbackLibraryMutation(db, 'mt-task', now, await session('```json\n{"wmb_noop": \n```')), null, 'JSON 坏 → JOB_READBACK_MISSING');
    // M4 wmb_noop:false → null
    assert.equal(await readbackLibraryMutation(db, 'mt-task', now, await session('```json\n{"wmb_noop": false}\n```')), null, 'wmb_noop:false → JOB_READBACK_MISSING');
    // M5 键错（wmb_noop 缺失/非布尔）→ null
    assert.equal(await readbackLibraryMutation(db, 'mt-task', now, await session('```json\n{"noop": true}\n```')), null, '键错 → JOB_READBACK_MISSING');
    assert.equal(await readbackLibraryMutation(db, 'mt-task', now, await session('```json\n{"wmb_noop": "true"}\n```')), null, '字符串 true 非严格布尔 → JOB_READBACK_MISSING');
    // M6 非末条：只认最后一个围栏块（前块 true、末块 false → null；末块 true、前块坏 → 接受）
    assert.equal(await readbackLibraryMutation(db, 'mt-task', now, await session('```json\n{"wmb_noop": true}\n```\n后续说明\n```json\n{"wmb_noop": false}\n```')), null, '声明不在末条围栏 → JOB_READBACK_MISSING');
    assert.deepEqual(await readbackLibraryMutation(db, 'mt-task', now, await session('```json\n{broken\n```\n```json\n{"wmb_noop": true}\n```')), { kind: 'noop_confirmed', scope: 'workspace' }, '末条围栏合法即接受（前块不参与）');
    // M8 finalText 内存路径免读文件：传 finalText 且会话文件缺失 → noop_confirmed；无 finalText 且文件缺失 → null
    assert.deepEqual(await readbackLibraryMutation(db, 'mt-task', now, path.join(sessionDir, 'missing.jsonl'), '```json\n{"wmb_noop": true}\n```'), { kind: 'noop_confirmed', scope: 'workspace' }, 'finalText 内存路径免读文件');
    assert.equal(await readbackLibraryMutation(db, 'mt-task', now, path.join(sessionDir, 'missing.jsonl')), null, '无 finalText 且文件缺失 → 无证据');
    // M7 围栏 + 收据 >=1 → sources_mutated（mutation 赢，围栏被忽略）
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, side_effect_state, created_at)
      VALUES ('r3', 'ws', 'epoch', 'mt-task:upsert', 'sources.upsert_batch', 'h', 'pi', 'pi', 'mt-task', '{}', '{}', 'ok', '{}', ?)`).run(now);
    const mutated = await readbackLibraryMutation(db, 'mt-task', now, await session('```json\n{"wmb_noop": true}\n```'));
    assert.equal(mutated.kind, 'sources_mutated');
    assert.ok(mutated.count >= 1);
    // 解析器级 smoke：parseNoopDeclaration 与 readback 同规则
    assert.equal(parseNoopDeclaration('```json\n{"wmb_noop": true}\n```'), true);
    assert.equal(parseNoopDeclaration('```json\n{"wmb_noop": true, "scope": "workspace"}\n```'), true);
    assert.equal(parseNoopDeclaration('```json\n{"wmb_noop": false}\n```'), false);
    assert.equal(parseNoopDeclaration('```json\n{"noop": true}\n```'), false);
    assert.equal(parseNoopDeclaration('```json\n{"wmb_noop": \n```'), false);
    assert.equal(parseNoopDeclaration('```json\n{"wmb_noop": true}\n```\n```json\n{"wmb_noop": false}\n```'), false);
    assert.equal(parseNoopDeclaration('没有围栏的说明文本'), false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('WMB-5121: LIBRARIAN_NOOP_MARKERS 正则回退已删除（迁移收口证据）', async () => {
  const source = await readFile(new URL('../src/main/role-job-registry.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('LIBRARIAN_NOOP_MARKERS'), 'role-job-registry.ts 不得再含 LIBRARIAN_NOOP_MARKERS');
});

test('desk role and empty brief are rejected by the pool', () => {
  const pool = new JobPool();
  assert.throws(() => pool.submit({ roleId: 'desk', brief: 'x' }), /desk/);
  assert.throws(() => pool.submit({ roleId: 'reporter', brief: '  ' }), /brief/);
});

test('list returns queued, parked, running, and terminal records with FIFO semantics', async () => {
  const pool = new JobPool(1);
  const a = pool.submit({ roleId: 'reporter', brief: 'A', resourceLocks: ['scan:ws:d:all'] });
  const b = pool.submit({ roleId: 'reporter', brief: 'B', resourceLocks: ['scan:ws:d:all'] });
  const c = pool.submit({ roleId: 'reporter', brief: 'C', resourceLocks: ['scan:ws:d:all'] });
  pool.park(a.id, 'RESOURCE_LEASE_BUSY', 'busy');
  // a 泊车（waiting_resource，不占槽）；b 晋升 running 占唯一槽；c 保持 queued。
  assert.equal(pool.get(a.id).status, 'waiting_resource');
  assert.equal(pool.get(b.id).status, 'running');
  assert.equal(pool.get(c.id).status, 'queued');
  const listed = pool.list();
  assert.deepEqual(listed.map((job) => job.status), ['queued', 'waiting_resource', 'running']);
  assert.deepEqual(listed.map((job) => job.brief), ['C', 'A', 'B']);
  assert.equal(pool.get('missing'), null);
  // 槽位仍被 b 占用：parked A 不会凭空晋升（资源未释放）。
  pool.rescan();
  assert.equal(pool.get(a.id).status, 'waiting_resource', '唯一槽被 b 占用时 rescan 不晋升 parked');
  // 真实容量释放（b 终态）→ FIFO：更早提交的 parked A 先于 queued C 晋升。
  // 晋升通知为 queueMicrotask 异步派发：断言前等待一个微任务，按真实异步事件语义观测。
  pool.complete(b.id);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(pool.get(a.id).status, 'running', 'b 完成后 parked A 按 FIFO 先晋升');
  assert.equal(pool.get(c.id).status, 'queued');
});

test('T-01 judge-in-flight is the third park code: parks, skips self, promotes via rescan', () => {
  assert.deepEqual(
    Object.keys(RESOURCE_WAIT_CODES).sort(),
    ['RESOURCE_JUDGE_IN_FLIGHT', 'RESOURCE_LEASE_BUSY', 'RESOURCE_LOCK_CONFLICT'],
    'RESOURCE_WAIT_CODES 含第三码 RESOURCE_JUDGE_IN_FLIGHT'
  );
  const pool = new JobPool(1);
  const a = pool.submit({ roleId: 'reporter', brief: 'A', resourceLocks: ['scan:ws:d:all'] });
  pool.park(a.id, 'RESOURCE_JUDGE_IN_FLIGHT', 'daily_judge running（judging_opportunities）');
  const parked = pool.get(a.id);
  assert.equal(parked.status, 'waiting_resource');
  assert.match(parked.waitReason, /RESOURCE_JUDGE_IN_FLIGHT/);
  assert.equal(pool.activeEmployeeCount(), 0, 'judge-park 不占槽位');
  // skip-self：park 级联不得把刚泊车的工单原地拉起（同 lease-busy 模式，不空转）。
  assert.equal(pool.get(a.id).status, 'waiting_resource', 'no immediate self re-promote');
  // 外部事件（judge settle / 看门狗 rescan）驱动晋升。
  assert.equal(pool.rescan(), 1);
  assert.equal(pool.get(a.id).status, 'running');
  pool.complete(a.id);
  assert.equal(pool.get(a.id).status, 'succeeded', 'never failed during judge wait');
});

test('T-01b judge-park keeps FIFO order against the queued lane', async () => {
  const pool = new JobPool(1);
  const a = pool.submit({ roleId: 'reporter', brief: 'A', resourceLocks: ['scan:ws:d:all'] });
  const b = pool.submit({ roleId: 'reporter', brief: 'B', resourceLocks: ['scan:ws:d:all'] });
  pool.park(a.id, 'RESOURCE_JUDGE_IN_FLIGHT', 'judge running');
  // a 泊车（waiting_resource，不占槽）；b 晋升占唯一槽。
  assert.equal(pool.get(a.id).status, 'waiting_resource');
  assert.equal(pool.get(b.id).status, 'running');
  pool.rescan();
  assert.equal(pool.get(a.id).status, 'waiting_resource', '唯一槽被 b 占用时 rescan 不晋升 parked');
  // b 终态释放槽位 → FIFO：更早提交的 parked A 先晋升。
  pool.complete(b.id);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(pool.get(a.id).status, 'running', 'b 终态后 parked A 按 FIFO 先晋升');
  pool.complete(a.id);
});

test('deferred is a transient outcome status, not a terminal JobStatus', () => {
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'partial', 'needs_user']);
  const deferred = { status: 'deferred', code: JOB_ERROR_CODES.SCAN_JUDGE_IN_FLIGHT, message: null, readback: null };
  assert.equal(terminal.has(deferred.status), false, 'deferred 不在 JobTerminalStatus');
  assert.equal(JOB_ERROR_CODES.SCAN_JUDGE_IN_FLIGHT, 'SCAN_JUDGE_IN_FLIGHT');
  // deferred 不得进入终态映射：运行期抛错兜底（编译期由调用方窄化保证不误映射）。
  assert.throws(() => mapOutcomeToTerminal(deferred, false), /deferred/);
  // 取消优先不变量：abort + deferred → cancelled，绝不落其余四态。
  assert.equal(mapOutcomeToTerminal(deferred, true).pool, 'cancelled');
});
