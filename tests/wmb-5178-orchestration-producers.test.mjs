import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildOrchestrationEnvelope, parseOrchestrationEnvelope, ORCHESTRATION_SAFE_FIELDS } from '../src/shared/orchestration-envelope.ts';
import { messagesFromPiEntries } from '../src/main/pi-transcript-projection.ts';
import { appendAcceptedOrchestration, updateFailedOrchestration, reconcileOrchestrationRows, isOrchestrationMessage } from '../src/main/pi-orchestration-store.ts';
import { readPiConversation, writePiConversation } from '../src/main/pi-conversation.ts';
import { syncPiConversation } from '../src/main/pi-persistence.ts';
import { PiRpcSupervisor } from '../src/main/pi-runtime.ts';
import {
  buildDockOrchestrationMessage,
  acceptedDockOrchestration,
  extractAuthorityBlock,
  sanitizeHumanOrchestrationError,
  appendAcceptedDockRow,
  markDockOrchestrationFailed,
  registerPiDockIpc,
  runDockManagerPrompt
} from '../src/main/ipc-pi-dock.ts';
import { buildTodayIntelligenceDispatch } from '../src/main/manager-dispatch.ts';
import { draftPrompt, reviewPrompt } from '../src/main/agent-runner.ts';
import { libraryOrganizePrompt } from '../src/main/role-job-policies.ts';
import { buildJobEventEnvelope } from '../src/shared/job-event-envelope.ts';

const createdAt = '2026-08-11T10:00:00.000Z';
const safe = {
  originLabel: '今日情报',
  title: '今日情报编排',
  goal: '采集并判读当日情报，产出可批方案',
  acceptance: '可信渠道回执 + 当日可批方案'
};

function rawEntry(text, id = 'e1', timestamp = createdAt) {
  return { type: 'message', id, timestamp, message: { role: 'user', content: text } };
}

function project(text, id = 'e1') {
  return messagesFromPiEntries([rawEntry(text, id)])[0];
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'wmb-5178-'));
}

async function withRoot(fn) {
  const root = await tempRoot();
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

// ---------------------------------------------------------------------------
// 1. 今日情报编排（Today）生产者：盖章 + 完整安全字段 + 前置失败语义
// ---------------------------------------------------------------------------

test('Today producer stamps canonical envelope with complete safe fields before dispatch', () => {
  const dispatch = buildTodayIntelligenceDispatch('2026-08-11', 'manager-task-9');
  assert.equal(typeof dispatch.dispatchId, 'string');
  assert.ok(dispatch.dispatchId.length > 0);
  assert.ok(dispatch.message.includes('2026-08-11'), 'prompt 携带业务日期');
  assert.ok(dispatch.message.includes('managerTaskId=manager-task-9'), 'prompt 携带任务引用');
  for (const field of ORCHESTRATION_SAFE_FIELDS) {
    assert.ok(dispatch.orchestration.safe[field]?.trim(), `安全字段 ${field} 必须非空`);
    assert.ok(!/managerTaskId|taskId|wmb_|\[WMB_CONTEXT\]/.test(dispatch.orchestration.safe[field]), `安全字段 ${field} 不得含内部措辞`);
  }
  const envelope = buildDockOrchestrationMessage({
    dispatchId: dispatch.dispatchId,
    delivery: 'direct',
    safe: dispatch.orchestration.safe,
    prompt: dispatch.message
  });
  const parsed = parseOrchestrationEnvelope(envelope);
  assert.ok(parsed, '今日编排信封必须可解析');
  assert.equal(parsed.dispatchId, dispatch.dispatchId);
  assert.equal(parsed.target, 'dock');
  assert.equal(parsed.delivery, 'direct');
  assert.deepEqual(parsed.safe, dispatch.orchestration.safe);
  const row = project(envelope, 'o-today');
  assert.equal(row.kind, 'orchestration');
  assert.equal(row.orchestration.state, 'accepted');
  assert.equal(row.text, safe.title, '可见文本仅安全标题');
  assert.ok(!row.text.includes('managerTaskId'), 'raw prompt 绝不泄漏进可见文本');
});

test('dock envelope rejects any missing safe field before dispatch (task not sent)', () => {
  for (const field of ORCHESTRATION_SAFE_FIELDS) {
    assert.throws(
      () => buildDockOrchestrationMessage({ dispatchId: 'd-1', delivery: 'direct', safe: { ...safe, [field]: '' }, prompt: '任务' }),
      /不能为空/,
      `${field} 缺失必须抛错（派发前校验失败）`
    );
    assert.throws(
      () => buildDockOrchestrationMessage({ dispatchId: 'd-1', delivery: 'direct', safe: { ...safe, [field]: '   ' }, prompt: '任务' }),
      /不能为空/,
      `${field} 空白必须抛错`
    );
  }
  assert.throws(() => buildDockOrchestrationMessage({ dispatchId: 'd-1', delivery: 'direct', safe: { originLabel: 'x', title: 'y', goal: 'z' }, prompt: '任务' }), /不能为空/);
  assert.throws(() => buildDockOrchestrationMessage({ dispatchId: 'd-1', delivery: 'steer', safe, prompt: '   ' }), /prompt/);
  assert.throws(() => buildDockOrchestrationMessage({ dispatchId: 'd-1', delivery: 'queue', safe, prompt: '任务' }), /delivery/);
});

test('authority block rides inside the prompt without breaking the canonical envelope', () => {
  const authorityBlock = 'taskId=t-1\ngrantId=g-1\nworkerLeaseId=w-1';
  const envelope = buildDockOrchestrationMessage({ dispatchId: 'd-2', delivery: 'direct', safe, prompt: '请执行今日情报编排', authorityBlock });
  const parsed = parseOrchestrationEnvelope(envelope);
  assert.ok(parsed, '带 authority 块仍可解析');
  assert.ok(envelope.includes('taskId=t-1'), 'authority 随信封保留（Pi 读授权上下文）');
  assert.ok(envelope.indexOf(authorityBlock) > envelope.indexOf('[USER_MESSAGE]'), 'authority 位于 [USER_MESSAGE] 之后正文区');
  const row = project(envelope, 'o-auth');
  assert.equal(row.kind, 'orchestration');
  assert.equal(row.text, safe.title);
  assert.ok(!row.text.includes('taskId='), '内部授权字段不进可见文本');
});

test('extractAuthorityBlock pulls only the trailing authority tail from an authorized head', () => {
  const head = '[WMB_CONTEXT]\npage=agents\nobjectType=manager_task\nobjectId=v1\ntaskId=t-9\ngrantId=g-9\nworkerLeaseId=w-9\n[USER_MESSAGE]\n任务';
  assert.equal(extractAuthorityBlock(head), 'taskId=t-9\ngrantId=g-9\nworkerLeaseId=w-9');
  const blocked = '[WMB_CONTEXT]\npage=agents\n[WMB_AUTHORITY_BLOCKED] reason=pi_unavailable\n[USER_MESSAGE]\n任务';
  assert.equal(extractAuthorityBlock(blocked), '[WMB_AUTHORITY_BLOCKED] reason=pi_unavailable');
  assert.equal(extractAuthorityBlock('[WMB_CONTEXT]\npage=agents\n[USER_MESSAGE]\n任务'), '', '无 authority 块返回空');
  assert.equal(extractAuthorityBlock('no marker'), '');
});

// ---------------------------------------------------------------------------
// 2. 接受门：direct = raw entry 已建立；steer/follow-up = queue ack；无证据不产生行
// ---------------------------------------------------------------------------

test('direct acceptance ordering: accepted row is appended before buffered new-turn events are released', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, { id: before.id, sessionFile: before.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });
    // 接受后先 appendAcceptedDockRow（写 + broadcast），之后才释放暂存的 thinking/tool/delta。
    const saved = await appendAcceptedDockRow(root, { dispatchId: 'd-order', delivery: 'direct', safe, createdAt: '2026-08-11T10:01:00.000Z' });
    assert.ok(saved, '接受后必须写入并广播 accepted 行');
    // 释放暂存事件：追加 streaming 助手行。
    await writePiConversation(root, { id: saved.id, sessionFile: saved.sessionFile, messages: [...saved.messages, { role: 'assistant', text: '', status: 'streaming', createdAt: '2026-08-11T10:01:01.000Z' }] });
    const after = await readPiConversation(root);
    const rows = after.messages.filter((message) => message.kind === 'orchestration');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orchestration.dispatchId, 'd-order');
    const rowIndex = after.messages.findIndex((message) => isOrchestrationMessage(message));
    const streamIndex = after.messages.findIndex((message) => message.role === 'assistant' && message.status === 'streaming');
    assert.ok(rowIndex >= 0 && streamIndex >= 0, 'accepted 行与 streaming 行都必须存在');
    assert.ok(rowIndex < streamIndex, 'accepted 行先于新回合输出释放');
  });
});

test('queue-ack acceptance: steer row survives raw projection refresh (syncPiConversation preserves it)', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, { id: before.id, sessionFile: before.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });
    await appendAcceptedDockRow(root, { dispatchId: 'd-ack1', delivery: 'steer', safe, createdAt: '2026-08-11T10:02:00.000Z' });
    const stub = {
      getEntries: async () => ({ data: { entries: [rawEntry('你好', 'u1'), rawEntry('追加的问题', 'u2', '2026-08-11T10:03:00.000Z')] } }),
      getState: async () => ({ data: { sessionId: 's-ack' } })
    };
    const conversation = await readPiConversation(root);
    const synced = await syncPiConversation(root, conversation, stub);
    assert.ok(synced, 'syncPiConversation 必须返回会话');
    const rows = synced.messages.filter((message) => message.kind === 'orchestration');
    assert.equal(rows.length, 1, 'queue-ack-only 行在 raw 整体覆盖后必须保留');
    assert.equal(rows[0].orchestration.dispatchId, 'd-ack1');
    assert.equal(rows[0].orchestration.delivery, 'steer');
    assert.equal(rows[0].orchestration.state, 'accepted');
  });
});

test('settlement persists final text when Pi entry read is stale at turn completion', async () => {
  await withRoot(async (root) => {
    const current = await readPiConversation(root);
    const visible = '刚刚那一篇叫写手重新写';
    const wrapped = `[WMB_CONTEXT]\npage=agents\n[USER_MESSAGE]\n${visible}`;
    const skillExpanded = `<skill name="evidence-grounded-writer">内部写作规则</skill>\n\n[USER_MESSAGE]\n${wrapped}`;
    const stored = await writePiConversation(root, {
      id: current.id,
      sessionFile: current.sessionFile,
      messages: [
        { role: 'user', text: visible, createdAt },
        { role: 'assistant', text: '', thinking: '正在处理', segments: [{ kind: 'thinking', text: '正在处理' }], status: 'streaming', createdAt: '2026-08-11T10:00:01.000Z' }
      ]
    });
    const staleSupervisor = {
      getEntries: async () => ({ data: { entries: [
        rawEntry(skillExpanded, 'u-stale'),
        { type: 'message', id: 'a-stale', timestamp: '2026-08-11T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '正在处理' }] } }
      ] } }),
      getState: async () => ({ data: { sessionId: 's-stale' } })
    };

    const synced = await syncPiConversation(root, stored, staleSupervisor, {
      status: 'stopped',
      thinking: '正在处理',
      text: '已经重新派给写手了。'
    });
    assert.ok(synced);
    const assistant = synced.messages.at(-1);
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.text, '已经重新派给写手了。');
    assert.equal(assistant.status, 'stopped');
    assert.deepEqual(assistant.segments.map((segment) => segment.kind), ['thinking', 'text']);
    assert.equal(assistant.segments.at(-1).text, assistant.text, '最终 result.text 必须进入可见 text segment');
  });
});

// ---------------------------------------------------------------------------
// 3. 接受后失败：同 dispatchId 原地更新；接受前失败无行
// ---------------------------------------------------------------------------

test('sanitizeHumanOrchestrationError strips internal codes, stacks and keeps a human message', () => {
  assert.equal(sanitizeHumanOrchestrationError('MANAGER_DOCK_FAILED: 渠道请求超时，未收到可信回执。'), '渠道请求超时，未收到可信回执。');
  assert.equal(sanitizeHumanOrchestrationError('Error: Pi 接口触发限流，请稍后再试。\n    at run (ipc-pi-dock.ts:123:45)'), 'Pi 接口触发限流，请稍后再试。');
  assert.equal(sanitizeHumanOrchestrationError('STUDIO_DRAFT_FAILED'), 'STUDIO_DRAFT_FAILED');
  assert.equal(sanitizeHumanOrchestrationError('   \n\n'), '安排失败，请查看任务状态。');
  assert.equal(sanitizeHumanOrchestrationError(undefined), '安排失败，请查看任务状态。');
});

test('accepted failure updates the same dispatchId row in place with a human error (no new row, no reorder)', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, {
      id: before.id,
      sessionFile: before.sessionFile,
      messages: [
        { role: 'user', text: '你好', createdAt },
        { role: 'user', text: safe.title, kind: 'orchestration', orchestration: acceptedDockOrchestration({ dispatchId: 'd-fail', delivery: 'direct', safe }), createdAt: '2026-08-11T10:04:00.000Z' },
        { role: 'user', text: '稍后的问题', createdAt: '2026-08-11T10:05:00.000Z' }
      ]
    });
    const saved = await markDockOrchestrationFailed(root, 'd-fail', 'MANAGER_DOCK_FAILED: 渠道请求超时，未收到可信回执。\n    at ipc-pi-dock.ts:10:20');
    assert.ok(saved, '接受后失败必须原地更新');
    const rows = saved.messages.filter((message) => message.kind === 'orchestration');
    assert.equal(rows.length, 1, '无新行');
    assert.equal(rows[0].orchestration.dispatchId, 'd-fail');
    assert.equal(rows[0].orchestration.state, 'failed');
    assert.equal(rows[0].orchestration.error, '渠道请求超时，未收到可信回执。');
    assert.ok(!/MANAGER_DOCK_FAILED|at ipc-pi-dock/.test(rows[0].orchestration.error), '无堆栈/内部码/工具名');
    // 时间线不重排：原 orchestration 行位置不变
    assert.equal(saved.messages.findIndex((message) => isOrchestrationMessage(message)), 1);
    assert.equal(saved.messages.at(-1).text, '稍后的问题');
  });
});

test('pre-acceptance failure leaves no row (unknown dispatchId is a no-op)', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, { id: before.id, sessionFile: before.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });
    const saved = await markDockOrchestrationFailed(root, 'd-never-dispatched', 'Pi 未接受当前对话。');
    assert.equal(saved, null, '无该 dispatchId 行 → no-op');
    const after = await readPiConversation(root);
    assert.equal(after.messages.filter((message) => message.kind === 'orchestration').length, 0, '接受前失败不产生 orchestration 行');
    // 接受门：无接受证据（决策 null）→ 绝不 append
    const appended = appendAcceptedOrchestration(after.messages, null, createdAt);
    assert.equal(appended, after.messages, '无接受证据时不得 append 任何行');
  });
});

// ---------------------------------------------------------------------------
// 4. 员工接收会话：盖章 + 目标隔离（employee 行只进员工会话，Dock 永不镜像）
// ---------------------------------------------------------------------------

const employeeSafe = {
  daily: { originLabel: '今日情报', title: '今日情报判读', goal: '判断当日增量资料，产出可批机会方案', acceptance: '渠道回执与当日可批方案' },
  studio: { originLabel: 'Studio 初稿', title: '内容核心初稿', goal: '基于项目资料撰写完整核心初稿并保存', acceptance: '核心版本读回' },
  review: { originLabel: 'Results 复盘', title: '周期复盘', goal: '基于真实指标给出 Keep/Stop/Change 与方法结论', acceptance: 'final 复盘读回' },
  library: { originLabel: '资料库整理', title: '资料整理', goal: '判断与整理资料，产出待批提案', acceptance: '整理读回或 no-op 确认' }
};

test('employee producers stamp target=employee envelopes (dispatchId 稳定 per task)', () => {
  const task = { id: 'task-1', businessDate: '2026-08-11', intent: 'daily_judge', status: 'running' };
  for (const [kind, idPrefix] of [['daily', 'daily_judge'], ['studio', 'studio_draft'], ['review', 'results_review'], ['library', 'page_library']]) {
    const prompt = kind === 'daily' ? '判断当日增量资料并产出方案。'
      : kind === 'studio' ? draftPrompt(task, 'proj-1', 'req-1')
        : kind === 'review' ? reviewPrompt(task, 'pub-1', 'req-1')
          : libraryOrganizePrompt(task, { jobId: 'job-1', brief: '整理资料', businessDate: '2026-08-11', spec: {}, runtime: {}, mcpUrl: '', xhsMcpUrl: '', workerLeaseId: 'w', sessionFile: 's', signal: new AbortController().signal, onTaskReady: async () => null, onEvent: () => {}, registerStoppable: () => {} });
    const envelope = buildOrchestrationEnvelope({ dispatchId: `${idPrefix}:${task.id}`, target: 'employee', delivery: 'direct', safe: employeeSafe[kind], prompt });
    const parsed = parseOrchestrationEnvelope(envelope);
    assert.ok(parsed, `${kind} 员工信封必须可解析`);
    assert.equal(parsed.target, 'employee');
    assert.equal(parsed.delivery, 'direct');
    assert.equal(parsed.dispatchId, `${idPrefix}:task-1`, 'dispatchId 按任务稳定唯一');
    const row = project(envelope, `e-${kind}`);
    assert.equal(row.kind, 'orchestration');
    assert.equal(row.orchestration.target, 'employee');
    assert.equal(row.text, employeeSafe[kind].title, '可见文本仅安全标题');
  }
});

test('employee rows only enter the employee session; the Dock carries only dock-target rows', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, { id: before.id, sessionFile: before.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });
    // 员工信封 → 员工会话自身读取所得为 employee 行（无员工 transcript UI，行只留在员工会话文件）
    const employeeEnvelope = buildOrchestrationEnvelope({ dispatchId: 'studio_draft:task-1', target: 'employee', delivery: 'direct', safe: employeeSafe.studio, prompt: draftPrompt({ id: 'task-1' }, 'p1', 'r1') });
    const employeeRow = project(employeeEnvelope, 'emp-1');
    assert.equal(employeeRow.kind, 'orchestration');
    assert.equal(employeeRow.orchestration.target, 'employee');
    // Dock 会话只读自己的 raw（只含 dock 目标信封）→ 只产生 dock 行，绝不出现 employee 行
    const dockEnvelope = buildDockOrchestrationMessage({ dispatchId: 'd-dock1', delivery: 'direct', safe, prompt: '请执行今日情报编排' });
    const dockEntries = [rawEntry('你好', 'u1'), rawEntry(dockEnvelope, 'o-dock', '2026-08-11T10:10:00.000Z')];
    const projected = messagesFromPiEntries(dockEntries);
    const dockRows = projected.filter((message) => message.kind === 'orchestration');
    assert.equal(dockRows.length, 1);
    assert.ok(dockRows.every((message) => message.orchestration.target === 'dock'), 'Dock 只含 dock 目标行');
    // 员工信封绝不进入 Dock 会话文件（写入路径只经 appendAcceptedDockRow，调用方仅 dock 目标）
    const conversation = await readPiConversation(root);
    const reconciled = reconcileOrchestrationRows(conversation.messages, projected);
    assert.ok(reconciled.every((message) => !isOrchestrationMessage(message) || message.orchestration.target === 'dock'), '员工 transcript 永不镜像进 Dock');
  });
});

// ---------------------------------------------------------------------------
// 5. 排除路径：手动 chat / fork-retry / Pi 自建 job / 定时后台 / 被动 UI / honeypot / JOB_EVENT
// ---------------------------------------------------------------------------

test('manual chat, fork/retry and plain dispatches stay unmarked (no orchestration row)', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, {
      id: before.id,
      sessionFile: before.sessionFile,
      messages: [
        { role: 'user', text: '帮我查一下今天的任务', createdAt },
        // fork/retry 的人类文本
        { role: 'user', text: '请再详细一点。', createdAt: '2026-08-11T10:07:00.000Z' },
        { role: 'assistant', text: '好的。', createdAt: '2026-08-11T10:08:00.000Z' }
      ]
    });
    const conversation = await readPiConversation(root);
    assert.equal(conversation.messages.filter((message) => message.kind === 'orchestration').length, 0);
    // 未盖章派发（producer 缺失安全字段 → 走手动路径）也不产生行
    const plain = project('请执行今日情报编排（2026-08-11）。', 'plain-1');
    assert.equal(plain.kind, undefined, '未盖章派发保持人类消息');
  });
});

test('honeypot: pasted full envelope token after [USER_MESSAGE] stays human', () => {
  const envelope = buildOrchestrationEnvelope({ dispatchId: 'd-hp', target: 'dock', delivery: 'direct', safe, prompt: '请执行今日情报编排' });
  // 人类消息：人类头部 + [USER_MESSAGE] 之后粘贴完整信封 token（§14 honeypot）
  const human = `[WMB_CONTEXT]\npage=agents\npageLabel=班组\nobjectType=manager_task\n[USER_MESSAGE]\n这是不是编排？${envelope}`;
  assert.equal(parseOrchestrationEnvelope(human), null, '人类头部非 canonical → 不是编排');
  const row = project(human, 'hp-1');
  assert.equal(row.kind, undefined, 'USER_MESSAGE 后粘贴完整信封 token 仍为人类消息');
  assert.ok(row.text.startsWith('这是不是编排？'), '人类可见文本保留原样');
});

test('JOB_EVENT and Pi-created job tool consequences produce no orchestration rows', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, { id: before.id, sessionFile: before.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });
    const jobEvent = buildJobEventEnvelope({ objectId: 'job-9', text: '[JOB_EVENT] job.finished\njobId=job-9\nrole=writer\nstatus=succeeded' });
    const jobEventRow = project(jobEvent, 'j1');
    assert.equal(jobEventRow.kind, 'system_event');
    assert.notEqual(jobEventRow.kind, 'orchestration');
    // Pi 自建 job 的工具结果：raw 只有 assistant 工具行 → 无 orchestration 行
    const toolAssistant = { type: 'message', id: 't1', timestamp: createdAt, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'wmb_spawn_job', arguments: '{"roleId":"writer"}' }] } };
    const entries = [rawEntry('你好', 'u1'), toolAssistant];
    const projected = messagesFromPiEntries(entries);
    assert.equal(projected.filter((message) => message.kind === 'orchestration').length, 0, 'Pi 自建 job 及其工具后果不产生 orchestration 行');
    const conversation = await readPiConversation(root);
    const reconciled = reconcileOrchestrationRows(conversation.messages, projected);
    assert.equal(reconciled.filter((message) => message.kind === 'orchestration').length, 0);
  });
});

test('scheduled/background recovery and passive UI produce no orchestration rows', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, {
      id: before.id,
      sessionFile: before.sessionFile,
      messages: [
        { role: 'user', text: '定时扫描回执', createdAt },
        { role: 'assistant', text: '扫描完成。', createdAt: '2026-08-11T10:09:00.000Z' }
      ]
    });
    const projected = messagesFromPiEntries([
      rawEntry('定时扫描回执', 'u1'),
      { type: 'message', id: 'a1', timestamp: '2026-08-11T10:09:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '扫描完成。' }] } }
    ]);
    const conversation = await readPiConversation(root);
    const reconciled = reconcileOrchestrationRows(conversation.messages, projected);
    assert.equal(reconciled.filter((message) => message.kind === 'orchestration').length, 0, '定时/后台恢复不新增 orchestration 行');
    assert.ok(conversation.messages.every((message) => message.kind === undefined), '被动 UI 操作（只读浏览/切换）不产生行');
  });
});

test('failed state updates in place via store helper preserve order (regression against append)', () => {
  const accepted = { role: 'user', text: safe.title, kind: 'orchestration', orchestration: acceptedDockOrchestration({ dispatchId: 'd-f2', delivery: 'direct', safe }), createdAt };
  const rows = [accepted];
  const updated = updateFailedOrchestration(rows, 'd-f2', '渠道请求超时，未收到可信回执。');
  assert.equal(updated.length, 1);
  assert.equal(updated[0].orchestration.state, 'failed');
  assert.equal(updated[0].orchestration.error, '渠道请求超时，未收到可信回执。');
  const noop = updateFailedOrchestration(rows, 'unknown', '炸了');
  assert.equal(noop, rows, '未知 dispatchId 为 no-op');
  const empty = updateFailedOrchestration(rows, 'd-f2', '   ');
  assert.equal(empty, rows, '空错误为 no-op');
});

// ---------------------------------------------------------------------------
// 6. 运行时接受门：真实 PiRpcSupervisor reader —— 持久化成功前零外向事件，成功后按原顺序释放
// ---------------------------------------------------------------------------

/** 同一 chunk 内依次送达：agent_start（接受信号）→ 增量/工具/raw → agent_settled。 */
function runtimeChunk() {
  return [
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你好', partial: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } }, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } },
    { type: 'tool_call', name: 'wmb_get_content', arguments: '{}' },
    { type: 'agent_settled' }
  ].map((item) => JSON.stringify(item)).join('\n') + '\n';
}

/** 同一 chunk 内依次送达：agent_start → 增量/工具/raw，不含 agent_settled（接受门拒绝后仍在流式的场景）。 */
function runtimeChunkBeforeSettled() {
  return [
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你好', partial: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } }, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } },
    { type: 'tool_call', name: 'wmb_get_content', arguments: '{}' }
  ].map((item) => JSON.stringify(item)).join('\n') + '\n';
}

const gatedEventTypes = ['agent_start', 'message_start', 'wmb_text_delta', 'message_update', 'tool_call', 'agent_settled'];

test('runtime gate: no outward event before deferred persistence resolves; flush in order; prompt settles after', async () => {
  const events = [];
  const runtime = new PiRpcSupervisor('node', [], {}, (event) => events.push(event));
  runtime.prompt = async () => ({ type: 'response', success: true });
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const turn = runtime.promptUntilSettled('编排任务', { onStreaming: async () => { await gate; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  runtime.read(runtimeChunk());
  assert.equal(events.length, 0, '持久化未完成前不得有任何外向事件（agent_start/delta/tool/raw 全部缓冲）');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.length, 0, '微任务推进也不得提前释放');
  releaseGate();
  const result = await turn;
  assert.equal(result.text, '你好', 'gate 释放后回合正常结束');
  assert.deepEqual(events.map((event) => event.type), gatedEventTypes, '缓冲事件按原顺序 flush');
});

test('runtime gate rejection drops buffered events and fails the turn without unhandled rejection', async () => {
  const events = [];
  const runtime = new PiRpcSupervisor('node', [], {}, (event) => events.push(event));
  runtime.prompt = async () => ({ type: 'response', success: true });
  let rejectGate;
  const gate = new Promise((_, reject) => { rejectGate = reject; });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const turn = runtime.promptUntilSettled('编排任务', { onStreaming: async () => { await gate; } }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.read(runtimeChunk());
    assert.equal(events.length, 0);
    rejectGate(new Error('持久化失败'));
    const outcome = await turn;
    assert.equal(outcome.ok, false, 'gate 失败必须整轮失败');
    assert.equal(outcome.error.message, '持久化失败');
    assert.equal(events.length, 0, 'gate 失败：缓冲事件被丢弃，不产生任何外向事件');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], '不得产生 unhandled rejection');
});

test('runtime gate: post-rejection read-path events stay suppressed until that turn settles, then reset cleanly', async () => {
  const events = [];
  const runtime = new PiRpcSupervisor('node', [], {}, (event) => events.push(event));
  runtime.prompt = async () => ({ type: 'response', success: true });
  let rejectGate;
  const gate = new Promise((_, reject) => { rejectGate = reject; });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const turn = runtime.promptUntilSettled('编排任务', { onStreaming: async () => { await gate; } }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.read(runtimeChunkBeforeSettled());
    assert.equal(events.length, 0, '持久化未完成前零外向事件');
    rejectGate(new Error('持久化失败'));
    const outcome = await turn;
    assert.equal(outcome.ok, false, 'gate 失败必须整轮失败');
    assert.equal(outcome.error.message, '持久化失败');
    assert.equal(events.length, 0, '拒绝时缓冲事件被丢弃');
    // 拒绝之后、同回合 agent_settled 之前：后续 delta/tool/raw 一律抑制，不得表面化为未跟踪 transcript。
    runtime.read([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '迟到', partial: { role: 'assistant', content: [{ type: 'text', text: '迟到' }] } }, message: { role: 'assistant', content: [{ type: 'text', text: '迟到' }] } },
      { type: 'tool_call', name: 'wmb_get_content', arguments: '{}' },
      { type: 'message', id: 'raw-1', timestamp: createdAt, message: { role: 'user', content: '迟到的 raw 行' } }
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');
    assert.deepEqual(events, [], '拒绝后至 settle 前：delta/tool/raw 全部抑制');
    // 同回合 agent_settled：失败回合整体零外向（settle 事件本身也丢弃），内部抑制干净复位。
    runtime.read(`${JSON.stringify({ type: 'agent_settled' })}\n`);
    assert.deepEqual(events, [], '失败回合的 agent_settled 也随回合丢弃');
    // 复位后普通外向事件恢复可见（后续回合/普通输出不被残留抑制吞掉）。
    runtime.read(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '可见', partial: { role: 'assistant', content: [{ type: 'text', text: '可见' }] } }, message: { role: 'assistant', content: [{ type: 'text', text: '可见' }] } })}\n`);
    assert.deepEqual(events.map((event) => event.type), ['wmb_text_delta', 'message_update'], 'settle 后普通外向事件恢复可见');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], '不得产生 unhandled rejection');
});

test('runtime gate: agent_settled already observed while gated leaves no stale suppression after rejection', async () => {
  const events = [];
  const runtime = new PiRpcSupervisor('node', [], {}, (event) => events.push(event));
  runtime.prompt = async () => ({ type: 'response', success: true });
  let rejectGate;
  const gate = new Promise((_, reject) => { rejectGate = reject; });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const turn = runtime.promptUntilSettled('编排任务', { onStreaming: async () => { await gate; } }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.read(runtimeChunk()); // 含 agent_settled：settle 在门内被观察到，waiters 转入 heldSettles
    assert.equal(events.length, 0, '持久化未完成前零外向事件');
    rejectGate(new Error('持久化失败'));
    const outcome = await turn;
    assert.equal(outcome.ok, false, 'agent_settled 已在门内观察：回合仍按接受失败处理');
    assert.equal(outcome.error.message, '持久化失败');
    assert.equal(events.length, 0, '缓冲事件（含 agent_settled）被丢弃');
    // 该回合已 settle → 拒绝后不得残留抑制；后续普通事件直接可见。
    runtime.read(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '后续', partial: { role: 'assistant', content: [{ type: 'text', text: '后续' }] } }, message: { role: 'assistant', content: [{ type: 'text', text: '后续' }] } })}\n`);
    assert.deepEqual(events.map((event) => event.type), ['wmb_text_delta', 'message_update'], 'agent_settled 已在门内观察 → 拒绝后不残留抑制');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], '不得产生 unhandled rejection');
});

test('runtime gate: non-async onStreaming keeps immediate emission (no event delay)', async () => {
  const events = [];
  const runtime = new PiRpcSupervisor('node', [], {}, (event) => events.push(event));
  runtime.prompt = async () => ({ type: 'response', success: true });
  const turn = runtime.promptUntilSettled('手动消息', { onStreaming: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  runtime.read(runtimeChunk());
  assert.deepEqual(events.map((event) => event.type), gatedEventTypes, '非 async 回调保持即时释放、零延迟');
  const result = await turn;
  assert.equal(result.text, '你好');
});

test('ipc orchestration direct callback awaits accepted-row persistence before closing the turn gate', async () => {
  await withRoot(async (root) => {
    const events = [];
    const runtime = new PiRpcSupervisor('node', [], {}, (event) => events.push(event));
    let promptCalled;
    const promptStarted = new Promise((resolve) => { promptCalled = resolve; });
    runtime.prompt = async () => { promptCalled(); return { type: 'response', success: true }; };
    runtime.getEntries = async () => ({ data: { entries: [{ type: 'message', id: 'a1', timestamp: createdAt, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } }] } });
    runtime.getState = async () => ({ data: { sessionId: 's-ipc', sessionFile: 's-ipc.jsonl' } });
    const deps = {
      loadSelectedDataRoot: async () => ({ path: root }),
      ensurePi: async () => runtime,
      getPi: () => null,
      setPiSessionFile: () => {},
      getActiveRuntime: () => null
    };
    // node:test 无 electron ipcMain：registerPiDockIpc 先写 dockPromptDeps 再注册 handler → 抛 TypeError（副作用即完成接线）。
    assert.throws(() => registerPiDockIpc(deps), TypeError);
    const turn = runDockManagerPrompt({ message: '执行今日情报编排', orchestration: { dispatchId: 'd-ipc', delivery: 'direct', safe } });
    await promptStarted; // promptUntilSettled 已注册 settle waiter（位于 await this.prompt 之前），之后喂 chunk 无竞态
    runtime.read(runtimeChunk());
    assert.equal(events.length, 0, '真实 ipc 回调在 appendAcceptedDockRow 持久化完成前不得释放任何外向事件');
    const result = await turn;
    assert.deepEqual(events.map((event) => event.type), gatedEventTypes, '持久化成功后按原顺序释放');
    assert.ok(result.conversation, '回合结束后返回会话快照');
    const rows = result.conversation.messages.filter((message) => message.kind === 'orchestration');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orchestration.dispatchId, 'd-ipc');
    assert.equal(rows[0].orchestration.state, 'accepted');
    assert.equal(rows[0].orchestration.target, 'dock');
  });
});

test('runDockManagerPrompt does not retry a failed Pi startup with a poisoned authority envelope', async () => {
  await withRoot(async (root) => {
    const runtime = new PiRpcSupervisor('node', [], {});
    let ensureCalls = 0;
    let prompted = '';
    let promptCalled;
    const promptStarted = new Promise((resolve) => { promptCalled = resolve; });
    runtime.prompt = async (message) => { prompted = message; promptCalled(); return { type: 'response', success: true }; };
    runtime.getEntries = async () => ({ data: { entries: [{ type: 'message', id: 'a-retry', timestamp: createdAt, message: { role: 'assistant', content: [{ type: 'text', text: '已恢复' }] } }] } });
    runtime.getState = async () => ({ data: { sessionId: 's-retry', sessionFile: 's-retry.jsonl' } });
    const deps = {
      loadSelectedDataRoot: async () => ({ path: root }),
      ensurePi: async () => {
        ensureCalls += 1;
        if (ensureCalls === 1) throw new Error('transient startup failure');
        return runtime;
      },
      getPi: () => null,
      setPiSessionFile: () => {},
      getActiveRuntime: () => null
    };
    assert.throws(() => registerPiDockIpc(deps), TypeError);
    await assert.rejects(
      runDockManagerPrompt({ message: '执行今日情报编排', orchestration: { dispatchId: 'd-first', delivery: 'direct', safe } }),
      /transient startup failure/
    );
    assert.equal(ensureCalls, 1, '首次启动失败必须原样结束，禁止同一回合二次启动并携带过期 blocked 标记');

    const recovered = runDockManagerPrompt({ message: '执行今日情报编排', orchestration: { dispatchId: 'd-second', delivery: 'direct', safe } });
    await promptStarted;
    runtime.read(runtimeChunk());
    await recovered;
    assert.equal(ensureCalls, 2, '恢复重试是新的干净回合，每回合只启动一次');
    assert.equal(prompted.includes('[WMB_AUTHORITY_BLOCKED] reason=pi_unavailable'), false, '恢复后的信封不得继承上次启动失败');
  });
});

test('pi:chat direct orchestration callback awaits appendAcceptedDockRow before closeTurnGate', async () => {
  const source = await readFile(new URL('../src/main/ipc-pi-dock.ts', import.meta.url), 'utf8');
  const chat = source.slice(source.indexOf("ipcMain.handle('pi:chat'"));
  const stream = chat.slice(chat.indexOf('onStreaming: async () =>'));
  assert.ok(stream.startsWith('onStreaming: async'), 'pi:chat direct 编排回调必须是 async');
  const append = stream.indexOf('await appendAcceptedDockRow');
  const close = stream.indexOf('closeTurnGate()');
  assert.ok(append >= 0 && close >= 0, '回调内必须 await 持久化并关闭回合门');
  assert.ok(append < close, '先 await appendAcceptedDockRow 持久化成功，再 closeTurnGate 释放新回合');
});

test('pi:chat direct orchestration starts Pi before authority is frozen into the envelope', async () => {
  const source = await readFile(new URL('../src/main/ipc-pi-dock.ts', import.meta.url), 'utf8');
  const chat = source.slice(source.indexOf("ipcMain.handle('pi:chat'"));
  const directStart = chat.indexOf('// §10.3 direct');
  const direct = chat.slice(directStart, chat.indexOf("const current = await readPiConversation(dataRoot.path);", directStart) + 1_500);
  const ensure = direct.indexOf('runtime = await ensurePi(dataRoot);');
  const authorize = direct.indexOf('const authorized = await authorize(raw);');
  const envelope = direct.indexOf('const envelope = buildDockOrchestrationMessage');
  assert.ok(ensure >= 0 && authorize >= 0 && envelope >= 0, 'direct 编排必须启动 Pi、生成 authority 并构建信封');
  assert.ok(ensure < authorize && authorize < envelope, '必须先确认 Pi 可用，再冻结 authority；禁止把瞬时 pi_unavailable 带入已恢复的 Pi 回合');

  const managerStart = source.indexOf('// §10.3：direct');
  const manager = source.slice(managerStart, source.indexOf('const result = await runtime.promptUntilSettled', managerStart));
  const managerEnsure = manager.indexOf('runtime = await deps.ensurePi(dataRoot);');
  const managerAuthorize = manager.indexOf('const authorized = await authorize(wrapped);');
  assert.ok(managerStart >= 0 && managerEnsure >= 0 && managerAuthorize >= 0, '主管实际 direct 路径必须包含 Pi 启动和 authority 冻结');
  assert.ok(managerEnsure < managerAuthorize, '主管实际 direct 路径同样必须先启动 Pi 再冻结 authority');
});

test('Studio direct runs default to a deterministic per-task employee session beside the Dock session; explicit override wins', async () => {
  const source = await readFile(new URL('../src/main/agent-runner.ts', import.meta.url), 'utf8');
  const studio = source.slice(source.indexOf('export async function startStudioDraft'));
  assert.match(studio, /'--session', \(input\.sessionFile \|\| path\.join\(path\.dirname\(layout\.sessionFile\), `studio-\$\{task\.id\}\.jsonl`\)\)/, '默认 session 必须是与 Dock 会话同目录的确定性 per-task 员工会话（绝不为 layout.sessionFile）');
  assert.match(studio, /员工会话隔离：不传则用确定性 per-task 员工会话/, 'doc 注释同步：默认不再回退 dock session');
  assert.match(studio, /input\.sessionFile \|\| /, '显式 sessionFile 覆盖仍然优先');
  assert.match(source, /`results-\$\{task\.id\}\.jsonl`/, 'Results 同目录隔离先例保持');
});
