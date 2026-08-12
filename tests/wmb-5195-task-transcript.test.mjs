import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { dispatchFailAgentTask, dispatchNeedsUserAgentTask, dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { writeJobContractRefs } from '../src/main/generic-employee-runner.ts';
import { buildJobObjectBoundary } from '../src/main/job-object-boundary.ts';
import { readTaskTranscriptForJob, resolveTaskSessionFile } from '../src/main/pi-transcript-projection.ts';

/**
 * WMB-5195 只读工单 transcript API 聚焦测试。
 * - 合法 employee/daily transcript 可投影真实 tool segments（toolName/input/output）；
 * - 未知 / 路径穿越 / 错 jobId / 文件缺失 / 解析失败一律返回 null（无任意文件读取面）。
 */

const DATE = '2026-08-09';

async function pathExists(target) {
  try { await access(target); return true; } catch { return false; }
}

function openRuntime(directory, epoch = 'wmb-5195-epoch', workspaceId = `ws-5195-${randomUUID()}`) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare("INSERT OR REPLACE INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
    .run(workspaceId, now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => epoch });
}

async function withRuntime(work, epoch = 'wmb-5195-epoch') {
  const root = await mkdtemp(path.join(tmpdir(), 'wmb-5195-'));
  let runtime;
  try {
    runtime = openRuntime(root, epoch);
    const shouldStop = await work({ root, runtime, database: runtime.database });
    if (shouldStop !== false) await runtime.stop({ drain: false });
  } finally {
    if (runtime?.isActive) await runtime.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const schedulerCtx = (label) => ({ actor: { type: 'scheduler', id: 'wmb-5195-test', label }, requestId: `${label}:${randomUUID()}` });

/** 与 GenericEmployeeRunner.onTaskReady 同款：建任务 → 写续派合同 refs（running 期）→ 可选终态。 */
async function seedTask(runtime, { roleId, intent, jobId, request, terminal }) {
  const started = await dispatchStartAgentTask(runtime, {
    intent,
    businessDate: DATE,
    contextRefs: { workspaceId: runtime.identity.workspaceId }
  }, schedulerCtx(`seed-${jobId}`));
  await writeJobContractRefs(runtime, started.task.id, {
    jobId,
    request,
    boundary: buildJobObjectBoundary(request, DATE)
  }, 'lease-transcript-test');
  if (terminal === 'needs_user') {
    await dispatchNeedsUserAgentTask(runtime, started.task.id, 'NEEDS_USER_TEST', '需要主管', schedulerCtx(`needs-${jobId}`));
  } else if (terminal === 'failed') {
    await dispatchFailAgentTask(runtime, started.task.id, 'TEST_FAIL', '模拟失败', schedulerCtx(`fail-${jobId}`));
  }
  return started.task;
}

/** 合法 Pi 会话条目：user + assistant（thinking/toolCall/text）+ toolResult，可投影 tool segments。 */
function transcriptEntries() {
  return [
    { type: 'message', id: 'u1', timestamp: '2026-08-09T01:00:00.000Z', message: { role: 'user', content: '请开始' } },
    { type: 'message', id: 'a1', timestamp: '2026-08-09T01:00:05.000Z', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '先检查资料' },
      { type: 'toolCall', id: 'call-1', name: 'wmb_read_project', arguments: { projectId: 'p-1' } },
      { type: 'text', text: '正在起草。' }
    ] } },
    { type: 'message', timestamp: '2026-08-09T01:00:06.000Z', message: { role: 'toolResult', toolCallId: 'call-1', details: { content: '项目资料：AI 日报' } } }
  ];
}

async function writeTranscript(file, entries) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function employeeSessionFile(root, jobId) {
  return path.join(root, 'agent', 'sessions', `job-${jobId}.jsonl`);
}

function assertToolSegments(messages) {
  assert.ok(messages && messages.length === 2, `应投影 user+assistant 两条消息，实际 ${messages?.length}`);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  const tool = messages[1].segments.find((segment) => segment.kind === 'tool');
  assert.ok(tool, 'assistant 消息应含 tool segment');
  assert.equal(tool.toolName, 'wmb_read_project');
  assert.match(tool.input, /"projectId"/);
  assert.match(tool.output, /项目资料：AI 日报/);
  assert.ok(messages[1].segments.some((segment) => segment.kind === 'thinking'), '应保留 thinking segment');
}

test('T1 合法 employee transcript：writer needs_user 活动实例按 agent/sessions/job-<jobId>.jsonl 投影 tool segments', async () => {
  await withRuntime(async ({ root, runtime }) => {
    const jobId = 'emp-writer-1';
    const task = await seedTask(runtime, {
      roleId: 'writer',
      intent: 'studio_draft',
      jobId,
      request: { roleId: 'writer', brief: '写一篇 AI 日报', projectId: 'p-1', businessDate: DATE },
      terminal: 'needs_user'
    });
    await writeTranscript(employeeSessionFile(root, jobId), transcriptEntries());

    const messages = await readTaskTranscriptForJob(runtime.database, root, jobId, null);
    assertToolSegments(messages);
    assert.equal(task.piSessionId, null, '非 daily 任务不应带 daily piSessionId');
  });
});

test('T2 合法 daily transcript：reporter daily_scan 活动实例按 pi-agent/sessions/daily-<date>-<taskId>.jsonl 投影 tool segments', async () => {
  await withRuntime(async ({ root, runtime }) => {
    const jobId = 'rep-daily-1';
    const task = await seedTask(runtime, {
      roleId: 'reporter',
      intent: 'daily_scan',
      jobId,
      request: { roleId: 'reporter', brief: '扫描今日 AI 热点', businessDate: DATE },
      terminal: 'needs_user'
    });
    assert.equal(task.piSessionId, `daily-${DATE}-${task.id}`, 'daily 家族任务自动获得 daily piSessionId');
    const dailyFile = path.join(root, 'pi-agent', 'sessions', `${task.piSessionId}.jsonl`);
    await writeTranscript(dailyFile, transcriptEntries());
    // 同一实例的 employee 会话文件不存在——证明 daily piSessionId 优先解析，不误读 job-<jobId>.jsonl。
    assert.equal(await pathExists(employeeSessionFile(root, jobId)), false);
    const messages = await readTaskTranscriptForJob(runtime.database, root, jobId, null);
    assertToolSegments(messages);
  });
});

test('T3 未知 jobId / 文件缺失 / 解析失败返回 null', async () => {
  await withRuntime(async ({ root, runtime }) => {
    // 未知 jobId：即使对应约定路径下存在合法 transcript 文件，投影中没有实例 → null（无任意文件读取面）。
    const ghostFile = employeeSessionFile(root, 'ghost');
    await writeTranscript(ghostFile, transcriptEntries());
    assert.equal(await readTaskTranscriptForJob(runtime.database, root, 'ghost', null), null);

    // 实例存在但会话文件缺失 → null。
    await seedTask(runtime, {
      roleId: 'writer', intent: 'studio_draft', jobId: 'emp-nofile-1',
      request: { roleId: 'writer', brief: '无文件', projectId: 'p-2', businessDate: DATE },
      terminal: 'failed'
    });
    assert.equal(await readTaskTranscriptForJob(runtime.database, root, 'emp-nofile-1', null), null);

    // 会话文件损坏（非 JSONL）→ null。
    await seedTask(runtime, {
      roleId: 'writer', intent: 'studio_draft', jobId: 'emp-corrupt-1',
      request: { roleId: 'writer', brief: '损坏', projectId: 'p-3', businessDate: DATE },
      terminal: 'failed'
    });
    await writeFile(employeeSessionFile(root, 'emp-corrupt-1'), 'not-json\n{broken}\n', 'utf8');
    assert.equal(await readTaskTranscriptForJob(runtime.database, root, 'emp-corrupt-1', null), null);
  });
});

test('T4 路径穿越 fail-closed：含 ../ 的 jobId 与注入式会话引用一律 null', async () => {
  await withRuntime(async ({ root, runtime }) => {
    // 投影中存在一个 jobId 带多级 ../ 的实例：其会话 ref 真实逃逸 data root，containment 拒绝（不触盘）。
    const evilJobId = '../../../../../escape';
    await seedTask(runtime, {
      roleId: 'writer', intent: 'studio_draft', jobId: evilJobId,
      request: { roleId: 'writer', brief: '穿越', projectId: 'p-4', businessDate: DATE },
      terminal: 'needs_user'
    });
    assert.equal(await readTaskTranscriptForJob(runtime.database, root, evilJobId, null), null, '逃逸会话引用必须被 containment 拒绝');

    // 直接单元断言解析边界。
    assert.equal(resolveTaskSessionFile(root, evilJobId, `agent/sessions/job-${evilJobId}.jsonl`, null), null, 'employee 穿越 ref 必须被 containment 拒绝');
    assert.equal(resolveTaskSessionFile(root, 'x', null, 'daily-2026-08-09-a/../../outside'), null, 'daily id 注入分隔符必须拒绝');
    assert.equal(resolveTaskSessionFile(root, 'x', 'agent/sessions/job-../secret.jsonl', null), null, '会话 ref 指向其他 job 必须拒绝');
  });
});

test('T5 错 jobId / 不匹配会话引用返回 null；合法引用可解析', async () => {
  await withRuntime(async ({ root, runtime }) => {
    await seedTask(runtime, {
      roleId: 'writer', intent: 'studio_draft', jobId: 'emp-writer-2',
      request: { roleId: 'writer', brief: '正确', projectId: 'p-5', businessDate: DATE },
      terminal: 'needs_user'
    });
    await writeTranscript(employeeSessionFile(root, 'emp-writer-2'), transcriptEntries());
    // 错 jobId：实例存在但用另一个 jobId 查询 → null。
    assert.equal(await readTaskTranscriptForJob(runtime.database, root, 'emp-writer-2-mismatch', null), null);
    // 正确 jobId 正常返回。
    assert.ok((await readTaskTranscriptForJob(runtime.database, root, 'emp-writer-2', null))?.length === 2);

    // 会话引用契约单元断言。
    const rootNorm = path.resolve(root);
    const employeeRef = 'agent/sessions/job-emp-writer-2.jsonl';
    assert.equal(resolveTaskSessionFile(root, 'emp-writer-2', employeeRef, null), path.join(rootNorm, employeeRef), '持久面相对 ref 接受');
    const absolute = path.join(rootNorm, 'agent', 'sessions', 'job-emp-writer-2.jsonl');
    assert.equal(resolveTaskSessionFile(root, 'emp-writer-2', absolute, null), path.join(rootNorm, employeeRef), '运行句柄绝对路径接受');
    assert.equal(resolveTaskSessionFile(root, 'emp-writer-2', 'agent/sessions/job-other.jsonl', null), null, '其他 job 的 ref 拒绝');
    assert.equal(resolveTaskSessionFile(root, 'emp-writer-2', null, null), null, '双 null 拒绝');
    assert.equal(resolveTaskSessionFile(root, 'emp-writer-2', employeeRef, 'dock-abc'), path.join(rootNorm, employeeRef), '非 daily piSessionId 回落 employee 会话');
    const dailyId = `daily-${DATE}-task-abc`;
    assert.equal(resolveTaskSessionFile(root, 'rep-daily-2', employeeRef, dailyId), path.join(rootNorm, 'pi-agent', 'sessions', `${dailyId}.jsonl`), 'daily piSessionId 优先解析');
  });
});
