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
  readbackScanPhase,
  readbackXiaohongshuPlatformVersion
} from '../src/main/role-job-registry.ts';
import { draftPrompt } from '../src/main/agent-runner.ts';
import { completeAgentTask, startAgentTask } from '../src/main/agent-tasks.ts';

test('default maxWorkers is 5 and six FIFO jobs leave the sixth queued', () => {
  assert.equal(DEFAULT_MAX_WORKERS, 5);
  const pool = new JobPool();
  const jobs = Array.from({ length: 6 }, (_, index) => pool.submit({
    roleId: 'reporter',
    brief: `R${index}`,
    resourceLocks: [`scan:ws:d:${index}`]
  }));
  assert.equal(pool.activeEmployeeCount(), 5);
  assert.ok(jobs.slice(0, 5).every((job) => pool.get(job.id).status === 'running'));
  assert.equal(pool.get(jobs[5].id).status, 'queued');
  assert.equal(pool.get(jobs[5].id).startedAt, null);
});

test('completing a job promotes the FIFO next job into the freed slot', () => {
  const pool = new JobPool(5);
  const jobs = Array.from({ length: 6 }, (_, index) => pool.submit({
    roleId: 'reporter',
    brief: `R${index}`,
    resourceLocks: [`scan:ws:d:${index}`]
  }));
  assert.equal(pool.get(jobs[5].id).status, 'queued');
  pool.complete(jobs[0].id);
  assert.equal(pool.get(jobs[0].id).status, 'succeeded');
  assert.equal(pool.get(jobs[0].id).finishedAt !== null, true);
  assert.equal(pool.activeEmployeeCount(), 5);
  const promoted = pool.get(jobs[5].id);
  assert.equal(promoted.status, 'running');
  assert.equal(promoted.startedAt !== null, true);
  assert.ok(jobs.slice(1).every((job) => pool.get(job.id).status === 'running'));
});

test('cancel frees the slot for the next queued job', () => {
  const pool = new JobPool(5);
  const jobs = Array.from({ length: 6 }, (_, index) => pool.submit({
    roleId: 'reporter',
    brief: `R${index}`,
    resourceLocks: [`scan:ws:d:${index}`]
  }));
  assert.equal(pool.activeEmployeeCount(), 5);
  assert.equal(pool.get(jobs[5].id).status, 'queued');
  pool.cancel(jobs[0].id);
  assert.equal(pool.get(jobs[0].id).status, 'cancelled');
  assert.equal(pool.get(jobs[5].id).status, 'running');
  assert.equal(pool.activeEmployeeCount(), 5);
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
  const coreWriter = parseRoleJobRequest({ roleId: 'writer', brief: '写核心稿', projectId: 'p1', writerTask: 'core_draft' });
  assert.equal(coreWriter.writerTask, 'core_draft');
  const xhsWriter = parseRoleJobRequest({ roleId: 'writer', brief: '写小红书版', projectId: 'p1', writerTask: 'xiaohongshu_platform_version' });
  assert.equal(xhsWriter.writerTask, 'xiaohongshu_platform_version');
  assert.throws(() => parseRoleJobRequest({ roleId: 'writer', brief: '错误任务', projectId: 'p1', writerTask: 'platform' }), { code: JOB_ERROR_CODES.VALIDATION_ERROR });
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
  const xhsSpec = deriveRoleJobSpec({ roleId: 'writer', brief: 'xhs', projectId: 'p1', writerTask: 'xiaohongshu_platform_version' }, 'ws');
  assert.equal(xhsSpec.writerTask, 'xiaohongshu_platform_version');
  assert.equal(xhsSpec.readback, 'xiaohongshu_platform_version');
  const corePrompt = draftPrompt({ id: 'task-core' }, 'p1', 'req-core', 'core_draft', '基于项目资料写核心稿');
  assert.match(corePrompt, /wmb_save_core_version/);
  assert.match(corePrompt, /brief=基于项目资料写核心稿/);
  const readyPrompt = draftPrompt({ id: 'task-core' }, 'p1', 'req-core', 'core_draft', '基于项目资料写核心稿', true);
  assert.match(readyPrompt, /wmb_save_core_version/);
  assert.doesNotMatch(readyPrompt, /调用 wmb_save_platform_version/);
  assert.match(readyPrompt, /不要发布/);
  assert.match(readyPrompt, /brief=基于项目资料写核心稿/);
  const xhsPrompt = draftPrompt({ id: 'task-xhs' }, 'p1', 'req-xhs', 'xiaohongshu_platform_version', '基于现有 WMB 核心稿生成小红书平台版本');
  assert.match(xhsPrompt, /wmb_save_platform_version/);
  assert.match(xhsPrompt, /brief=基于现有 WMB 核心稿生成小红书平台版本/);
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

    // writer: WMB-5356 因果读回——仅 exact task 的 content.save_version 成功收据可产生 content_version
    // 占位版本不得满足不同任务；无 receipt/跨任务/跨项目一律 null（fail-closed）
    assert.equal(readbackContentVersion(db, 'proj-1', 'writer-missing'), null);
    db.prepare("INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES ('proj-1', '项目', ?, ?, 1)").run(now, now);
    assert.equal(readbackContentVersion(db, 'proj-1', 'writer-1'), null, 'no receipt yet -> null even before version');
    db.prepare("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('ver-1', 'proj-1', '正文', 1, ?)").run(now);
    assert.equal(readbackContentVersion(db, 'proj-1', 'writer-1'), null, 'placeholder version without exact receipt must not succeed');
    // exact successful receipt -> succeeds
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, result_json, readback_json, side_effect_state, created_at)
      VALUES ('r-writer-1', 'ws', 'epoch', 'writer-1:req1', 'content.save_version', 'h', 'pi', 'pi', 'writer-1', '{}', ?, 'ok', ?, ?, 'committed', ?)`).run(JSON.stringify({ data: { id: 'ver-1' } }), JSON.stringify({ id: 'ver-1' }), JSON.stringify({ id: 'ver-1' }), now);
    assert.deepEqual(readbackContentVersion(db, 'proj-1', 'writer-1'), { kind: 'content_version', projectId: 'proj-1', versionId: 'ver-1' });
    // 跨任务隔离：同一版本、不同任务不得复用
    assert.equal(readbackContentVersion(db, 'proj-1', 'writer-2'), null, 'other task receipt does not satisfy');
    const xhsTask = startAgentTask(db, {
      intent: 'studio_draft',
      businessDate: '2026-08-12',
      contextRefs: { projectId: 'proj-1', writerTask: 'xiaohongshu_platform_version' }
    });
    assert.equal(xhsTask.ok, true);
    const missingPlatform = completeAgentTask(db, xhsTask.data.id);
    assert.equal(missingPlatform.ok, false);
    assert.match(missingPlatform.error.message, /小红书平台版本/);
    assert.equal(readbackXiaohongshuPlatformVersion(db, 'proj-1'), null);
    db.prepare(`INSERT INTO platform_versions
      (id, project_id, content_version_id, platform, format, body, asset_ids_json, created_at, updated_at, revision)
      VALUES ('pv-xhs-1', 'proj-1', 'ver-1', 'xiaohongshu', 'text', '小红书正文', '[]', ?, ?, 1)`).run(now, now);
    assert.deepEqual(readbackXiaohongshuPlatformVersion(db, 'proj-1'), {
      kind: 'xiaohongshu_platform_version', projectId: 'proj-1', versionId: 'pv-xhs-1', contentVersionId: 'ver-1'
    });
    const completedPlatform = completeAgentTask(db, xhsTask.data.id);
    assert.equal(completedPlatform.ok, true);
    assert.equal(completedPlatform.data.status, 'succeeded');

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
  const pool = new JobPool(5);
  const [a, b, c, d, e, f] = Array.from({ length: 6 }, (_, index) => pool.submit({
    roleId: 'reporter',
    brief: String.fromCharCode(65 + index),
    resourceLocks: [`scan:ws:d:${index}`]
  }));
  pool.park(a.id, 'RESOURCE_LEASE_BUSY', 'busy');
  const g = pool.submit({ roleId: 'reporter', brief: 'G', resourceLocks: ['scan:ws:d:6'] });
  // a 泊车（waiting_resource，不占槽）；f 晋升补位；g 在五个 running 工单之后排队。
  assert.equal(pool.get(a.id).status, 'waiting_resource');
  assert.equal(pool.get(b.id).status, 'running');
  assert.equal(pool.get(g.id).status, 'queued');
  const listed = pool.list();
  assert.deepEqual(listed.map((job) => job.status), ['queued', 'waiting_resource', 'running', 'running', 'running', 'running', 'running']);
  assert.deepEqual(listed.map((job) => job.brief), ['G', 'A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(pool.get('missing'), null);
  // 槽位仍被五个 running 工单占用：parked A 不会凭空晋升（资源未释放）。
  pool.rescan();
  assert.equal(pool.get(a.id).status, 'waiting_resource', '容量已满时 rescan 不晋升 parked');
  // 真实容量释放（b 终态）→ FIFO：更早提交的 parked A 先于 queued G 晋升。
  pool.complete(b.id);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(pool.get(a.id).status, 'running', 'b 完成后 parked A 按 FIFO 先晋升');
  assert.equal(pool.get(g.id).status, 'queued');
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
  const pool = new JobPool(5);
  const [a, b, c, d, e, f] = Array.from({ length: 6 }, (_, index) => pool.submit({
    roleId: 'reporter',
    brief: String.fromCharCode(65 + index),
    resourceLocks: [`scan:ws:d:${index}`]
  }));
  pool.park(a.id, 'RESOURCE_JUDGE_IN_FLIGHT', 'judge running');
  const g = pool.submit({ roleId: 'reporter', brief: 'G', resourceLocks: ['scan:ws:d:6'] });
  // a 泊车（waiting_resource，不占槽）；f 晋升补位；g 保持 queued。
  assert.equal(pool.get(a.id).status, 'waiting_resource');
  assert.equal(pool.get(b.id).status, 'running');
  assert.equal(pool.get(g.id).status, 'queued');
  pool.rescan();
  assert.equal(pool.get(a.id).status, 'waiting_resource', '容量已满时 rescan 不晋升 parked');
  // b 终态释放槽位 → FIFO：更早提交的 parked A 先晋升。
  pool.complete(b.id);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(pool.get(a.id).status, 'running', 'b 终态后 parked A 先晋升');
  assert.equal(pool.get(g.id).status, 'queued');
  pool.complete(a.id);
});

test('WMB-5356 writer readback causal proof: failed receipt + placeholder cannot succeed, exact ok receipt succeeds, cross-task/project isolated', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-5356-readback-'));
  const db = openDatabase(directory);
  try {
    const now = new Date().toISOString();
    // 占位项目+版本预先存在（模拟历史 placeholder）
    db.prepare("INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES ('proj-5356', '项目', ?, ?, 1)").run(now, now);
    db.prepare("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('ver-placeholder', 'proj-5356', '占位正文', 1, ?)").run(now);
    db.prepare("INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES ('proj-other', '他项目', ?, ?, 1)").run(now, now);
    db.prepare("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('ver-other', 'proj-other', '他项目正文', 1, ?)").run(now);
    // 1. TASK_GRANT_NOT_FOUND（失败收据）+ 占位 -> 必须 null（fail-closed，绝不 succeeded）
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, error_json, side_effect_state, created_at)
      VALUES ('r-fail-5356', 'ws', 'epoch', 'writer-5356:fail', 'content.save_version', 'h', 'pi', 'pi', 'writer-5356', '{}', '{}', 'error', ?, 'not_started', ?)`).run(JSON.stringify({ code: 'TASK_GRANT_NOT_FOUND', message: 'Task grant 不存在。' }), now);
    assert.equal(readbackContentVersion(db, 'proj-5356', 'writer-5356'), null, 'placeholder + TASK_GRANT_NOT_FOUND failed receipt must be JOB_READBACK_MISSING');
    // 2. exact successful receipt -> succeed（同 receipt 复用保持接受）
    db.prepare("INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('ver-5356', 'proj-5356', 'Writer 成功正文', 2, ?)").run(now);
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, result_json, readback_json, side_effect_state, created_at)
      VALUES ('r-ok-5356', 'ws', 'epoch', 'writer-5356:ok', 'content.save_version', 'h2', 'pi', 'pi', 'writer-5356', '{}', ?, 'ok', ?, ?, 'committed', ?)`).run(JSON.stringify({ data: { id: 'ver-5356' } }), JSON.stringify({ id: 'ver-5356' }), JSON.stringify({ id: 'ver-5356' }), now);
    assert.deepEqual(readbackContentVersion(db, 'proj-5356', 'writer-5356'), { kind: 'content_version', projectId: 'proj-5356', versionId: 'ver-5356' }, 'exact task ok receipt must produce version');
    // 同收据再次查询应稳定接受
    assert.deepEqual(readbackContentVersion(db, 'proj-5356', 'writer-5356'), { kind: 'content_version', projectId: 'proj-5356', versionId: 'ver-5356' });
    // 3. receipt 对 another task 不计入
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, result_json, readback_json, side_effect_state, created_at)
      VALUES ('r-other-task', 'ws', 'epoch', 'other-task:ok', 'content.save_version', 'h3', 'pi', 'pi', 'other-task', '{}', ?, 'ok', ?, ?, 'committed', ?)`).run(JSON.stringify({ data: { id: 'ver-placeholder' } }), JSON.stringify({ id: 'ver-placeholder' }), JSON.stringify({ id: 'ver-placeholder' }), now);
    assert.equal(readbackContentVersion(db, 'proj-5356', 'writer-other'), null, 'other task receipt must not satisfy this task');
    // 4. receipt 版本归属他项目 -> 不计入
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, result_json, readback_json, side_effect_state, created_at)
      VALUES ('r-cross-proj', 'ws', 'epoch', 'writer-cross:ok', 'content.save_version', 'h4', 'pi', 'pi', 'writer-cross', '{}', ?, 'ok', ?, ?, 'committed', ?)`).run(JSON.stringify({ data: { id: 'ver-other' } }), JSON.stringify({ id: 'ver-other' }), JSON.stringify({ id: 'ver-other' }), now);
    assert.equal(readbackContentVersion(db, 'proj-5356', 'writer-cross'), null, 'cross-project version must be rejected');
    assert.deepEqual(readbackContentVersion(db, 'proj-other', 'writer-cross'), { kind: 'content_version', projectId: 'proj-other', versionId: 'ver-other' });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
