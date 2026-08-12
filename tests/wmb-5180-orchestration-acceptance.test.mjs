// WMB-5180 编排集成验收：按设计 §16 矩阵 1–16 逐项可观察判据。
// 只复用真实生产者/信封/投影/存储/渲染工具模块；渲染层仅检查不可避让的
// producer 分支（状态文案、details/summary 结构、aria-live 计数、CSS 换行/主题令牌）。
// 运行：node --test tests/wmb-5180-orchestration-acceptance.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildOrchestrationEnvelope, parseOrchestrationEnvelope, ORCHESTRATION_SAFE_FIELDS } from '../src/shared/orchestration-envelope.ts';
import { buildJobEventEnvelope } from '../src/shared/job-event-envelope.ts';
import { messagesFromPiEntries } from '../src/main/pi-transcript-projection.ts';
import { appendAcceptedOrchestration, reconcileOrchestrationRows, isOrchestrationMessage } from '../src/main/pi-orchestration-store.ts';
import { readPiConversation, writePiConversation } from '../src/main/pi-conversation.ts';
import { buildDockOrchestrationMessage, acceptedDockOrchestration, sanitizeHumanOrchestrationError, appendAcceptedDockRow, markDockOrchestrationFailed } from '../src/main/ipc-pi-dock.ts';
import { buildTodayIntelligenceDispatch } from '../src/main/manager-dispatch.ts';
import { draftPrompt, reviewPrompt } from '../src/main/agent-runner.ts';
import { libraryOrganizePrompt } from '../src/main/role-job-policies.ts';
import { isPiOrchestration, piRetryable } from '../src/renderer/pi-dock-utils.ts';

const createdAt = '2026-08-11T10:00:00.000Z';
const safe = {
  originLabel: '今日情报',
  title: '今日情报编排',
  goal: '采集并判读当日情报，产出可批方案',
  acceptance: '可信渠道回执 + 当日可批方案'
};
const agentRunnerUrl = new URL('../src/main/agent-runner.ts', import.meta.url);
const rolePoliciesUrl = new URL('../src/main/role-job-policies.ts', import.meta.url);
const libraryTopicsUrl = new URL('../src/renderer/library-topics-view.tsx', import.meta.url);
const resultsViewUrl = new URL('../src/renderer/results-view.tsx', import.meta.url);

// 非导出 view-local 生产者与员工派发内联 safe 的 bounded 源检查：兼容单行和多行条件 safe，
// 断言 wmb-pi-generate detail / 员工信封精确结构 —— 生产者改值、掉字段、换目标即失败（无镜像可漂移）。
async function dispatchSafe(file, marker) {
  const source = await readFile(file, 'utf8');
  const markerIndex = source.indexOf(`dispatchId: \`${marker}`);
  assert.ok(markerIndex >= 0, `${marker} 员工派发行必须存在`);
  const endIndex = source.indexOf('}), { timeoutMs', markerIndex);
  assert.ok(endIndex > markerIndex, `${marker} 员工派发信封必须有确定边界`);
  const block = source.slice(markerIndex, endIndex);
  assert.match(block, /target:\s*'employee',[\s\S]*?delivery:\s*'direct',[\s\S]*?safe:\s*/, `${marker} 信封目标/派发/盖章结构必须完整`);
  const safeLiterals = [...block.matchAll(/\{\s*originLabel:\s*'([^']*)',\s*title:\s*'([^']*)',\s*goal:\s*'([^']*)',\s*acceptance:\s*'([^']*)'\s*\}/g)];
  assert.ok(safeLiterals.length >= 1, `${marker} safe 至少一个完整字面量分支`);
  const safeVariants = safeLiterals.map((match) => Object.fromEntries(ORCHESTRATION_SAFE_FIELDS.map((field, index) => [field, match[index + 1]])));
  return { safe: safeVariants[safeVariants.length - 1], safeVariants, line: block };
}

async function dockProducerSafe(file) {
  const source = await readFile(file, 'utf8');
  const event = source.match(/CustomEvent\('wmb-pi-generate'[\s\S]*?orchestration: \{([^}]*)\}/);
  assert.ok(event, 'wmb-pi-generate detail 必须携带 orchestration 安全字段');
  assert.match(event[0], /detail: \{ prompt, orchestration: \{/, 'detail 必须携带 prompt 与 orchestration 两键');
  assert.doesNotMatch(event[0], /target:|dispatchId:|delivery:|state:/, 'view 只发安全字段，编号/目标由主进程决定');
  const fields = [...event[1].matchAll(/(originLabel|title|goal|acceptance): '([^']*)'/g)];
  assert.equal(fields.length, ORCHESTRATION_SAFE_FIELDS.length, 'wmb-pi-generate safe 四字段必须完整');
  return Object.fromEntries(fields.map(([, k, v]) => [k, v]));
}

function rawEntry(text, id = 'e1', timestamp = createdAt) {
  return { type: 'message', id, timestamp, message: { role: 'user', content: text } };
}

function project(text, id = 'e1') {
  return messagesFromPiEntries([rawEntry(text, id)])[0];
}

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5180-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function orchestrationRowBlock() {
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  return {
    transcript,
    block: transcript.slice(transcript.indexOf('function PiOrchestrationRow'), transcript.indexOf('export function PiDockTranscript'))
  };
}

// ---------------------------------------------------------------------------
// §16-1 直接派发
// ---------------------------------------------------------------------------
test('§16-1 直接派发：Today 生产者盖章，accepted 行先于 Pi 输出，可见文本仅安全标题', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, { id: before.id, sessionFile: before.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });
    const dispatch = buildTodayIntelligenceDispatch('2026-08-11', 'manager-task-5180');
    for (const field of ORCHESTRATION_SAFE_FIELDS) {
      assert.ok(dispatch.orchestration.safe[field]?.trim(), `Today 生产者安全字段 ${field} 必须非空`);
    }
    const envelope = buildDockOrchestrationMessage({ dispatchId: dispatch.dispatchId, delivery: 'direct', safe: dispatch.orchestration.safe, prompt: dispatch.message });
    const parsed = parseOrchestrationEnvelope(envelope);
    assert.ok(parsed, '今日编排信封必须可解析');
    assert.equal(parsed.dispatchId, dispatch.dispatchId);
    assert.equal(parsed.target, 'dock');
    assert.equal(parsed.delivery, 'direct');
    const saved = await appendAcceptedDockRow(root, { dispatchId: dispatch.dispatchId, delivery: 'direct', safe: dispatch.orchestration.safe, createdAt: '2026-08-11T10:01:00.000Z' });
    assert.ok(saved, '接受后必须写入 accepted 行');
    // 接受后先写编排行，再释放 direct 新回合的 thinking/tool/delta（Pi 进程行）
    await writePiConversation(root, { id: saved.id, sessionFile: saved.sessionFile, messages: [...saved.messages, { role: 'assistant', text: '已收到，开始执行。', status: 'stopped', createdAt: '2026-08-11T10:02:00.000Z' }] });
    const after = await readPiConversation(root);
    const rowIndex = after.messages.findIndex(isOrchestrationMessage);
    const piIndex = after.messages.findIndex((message) => message.role === 'assistant');
    assert.ok(rowIndex >= 0 && piIndex >= 0 && rowIndex < piIndex, '编排行必须出现在 Pi thinking/tool/delta 之前');
    const row = after.messages[rowIndex];
    assert.equal(row.orchestration.state, 'accepted');
    assert.equal(row.orchestration.delivery, 'direct');
    assert.equal(row.createdAt, '2026-08-11T10:01:00.000Z', '时间戳随行保留（渲染时间读回源）');
    assert.equal(row.text, dispatch.orchestration.safe.title, '可见文本仅安全标题');
    assert.ok(!row.text.includes('managerTaskId') && !row.text.includes('[WMB_CONTEXT]'), 'raw prompt 绝不进入可见文本');
  });
  // 状态文案三选一（渲染层 producer 分支，集成断言取最小面）
  const { transcript } = await orchestrationRowBlock();
  const helper = transcript.slice(transcript.indexOf('function orchestrationStatusLabel'), transcript.indexOf('function PiOrchestrationRow'));
  assert.match(helper, /已安排主管/);
  assert.match(helper, /已加入主管队列/);
  assert.match(helper, /安排失败/);
  assert.doesNotMatch(helper, /已完成|进行中|待处理/, '不存在第四种默认文案');
});

// ---------------------------------------------------------------------------
// §16-2 steer/follow-up
// ---------------------------------------------------------------------------
test('§16-2 steer/follow-up：队列 ack 行保持原位，投影刷新不丢失不重排', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, { id: before.id, sessionFile: before.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });
    const ack = await appendAcceptedDockRow(root, { dispatchId: 'd-5180-queue', delivery: 'steer', safe, createdAt: '2026-08-11T10:03:00.000Z' });
    assert.ok(ack, '队列 ack 后必须写入 accepted 行');
    const rows = ack.messages.filter(isOrchestrationMessage);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orchestration.delivery, 'steer');
    const projected = messagesFromPiEntries([rawEntry('你好', 'u1', createdAt), rawEntry('追加的问题', 'u2', '2026-08-11T10:04:00.000Z')]);
    const reconciled = reconcileOrchestrationRows(ack.messages, projected);
    const after = reconciled.filter(isOrchestrationMessage);
    assert.equal(after.length, 1, 'queue-ack 行在投影刷新后必须保留');
    assert.equal(after[0].orchestration.dispatchId, 'd-5180-queue');
    assert.equal(after[0].orchestration.state, 'accepted');
    assert.deepEqual(reconciled.map((message) => (message.role === 'user' && message.kind === undefined ? message.text : message.kind)), ['你好', 'orchestration', '追加的问题'], '队列行保持原位，时间线不重排');
    const followUp = acceptedDockOrchestration({ dispatchId: 'd-5180-follow', delivery: 'follow_up', safe });
    const once = appendAcceptedOrchestration(after, followUp, '2026-08-11T10:05:00.000Z');
    assert.equal(once.filter(isOrchestrationMessage).length, 2);
    assert.equal(once.filter(isOrchestrationMessage).at(-1).orchestration.delivery, 'follow_up', 'follow-up 同样按队列 ack 语义接受');
  });
});

// ---------------------------------------------------------------------------
// §16-3 接受后失败
// ---------------------------------------------------------------------------
test('§16-3 接受后失败：同 dispatchId 原地更新为安排失败 + 人类可读错误，无新行无重排', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, {
      id: before.id,
      sessionFile: before.sessionFile,
      messages: [
        { role: 'user', text: '你好', createdAt },
        { role: 'user', text: safe.title, kind: 'orchestration', orchestration: acceptedDockOrchestration({ dispatchId: 'd-5180-fail', delivery: 'direct', safe }), createdAt: '2026-08-11T10:06:00.000Z' },
        { role: 'user', text: '稍后的问题', createdAt: '2026-08-11T10:07:00.000Z' }
      ]
    });
    const saved = await markDockOrchestrationFailed(root, 'd-5180-fail', 'MANAGER_DOCK_FAILED: 渠道请求超时，未收到可信回执。\n    at ipc-pi-dock.ts:10:20');
    assert.ok(saved, '接受后失败必须原地更新');
    const rows = saved.messages.filter(isOrchestrationMessage);
    assert.equal(rows.length, 1, '失败绝不新建行');
    assert.equal(rows[0].orchestration.dispatchId, 'd-5180-fail', '同一行（同 dispatchId）');
    assert.equal(rows[0].orchestration.state, 'failed');
    assert.equal(rows[0].orchestration.error, '渠道请求超时，未收到可信回执。', '人类可读错误，剥离内部码/堆栈');
    assert.ok(!/MANAGER_DOCK_FAILED|at ipc-pi-dock|Error:/.test(rows[0].orchestration.error), '无堆栈/内部码/工具名');
    assert.equal(saved.messages.findIndex(isOrchestrationMessage), 1, '时间线顺序不重排');
    assert.equal(saved.messages.at(-1).text, '稍后的问题');
  });
  assert.equal(sanitizeHumanOrchestrationError('STUDIO_DRAFT_FAILED: 写手接口限流。'), '写手接口限流。');
});

// ---------------------------------------------------------------------------
// §16-4 接受前失败
// ---------------------------------------------------------------------------
test('§16-4 接受前失败：会话中无任何 orchestration 行残留', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, { id: before.id, sessionFile: before.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });
    const saved = await markDockOrchestrationFailed(root, 'd-5180-never-dispatched', 'Pi 未接受当前对话。');
    assert.equal(saved, null, '无该 dispatchId 行 → no-op');
    const after = await readPiConversation(root);
    assert.equal(after.messages.filter(isOrchestrationMessage).length, 0, '接受前失败不产生行');
    assert.equal(appendAcceptedOrchestration(after.messages, null, createdAt), after.messages, '无接受证据绝不 append');
    const reconciled = reconcileOrchestrationRows(after.messages, messagesFromPiEntries([rawEntry('你好', 'u1')]));
    assert.equal(reconciled.filter(isOrchestrationMessage).length, 0, 'raw 投影后仍无残留行');
  });
});

// ---------------------------------------------------------------------------
// §16-5 重载/去重
// ---------------------------------------------------------------------------
test('§16-5 重载/去重：全量 reload、重复事件、重复重投影后每 dispatchId 恰一行', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    const envelope = buildDockOrchestrationMessage({ dispatchId: 'd-5180-reload', delivery: 'direct', safe, prompt: '请执行今日情报编排' });
    await writeFile(before.sessionFile, [rawEntry('你好', 'u1', createdAt), rawEntry(envelope, 'o1', '2026-08-11T10:08:00.000Z')].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
    await writePiConversation(root, {
      id: before.id,
      sessionFile: before.sessionFile,
      messages: [
        { role: 'user', text: '你好', createdAt },
        { role: 'user', text: safe.title, kind: 'orchestration', orchestration: acceptedDockOrchestration({ dispatchId: 'd-5180-reload', delivery: 'direct', safe }), createdAt: '2026-08-11T10:08:00.000Z' }
      ]
    });
    const first = await readPiConversation(root);
    assert.equal(first.messages.filter(isOrchestrationMessage).length, 1, '全量 reload 后恰一行');
    const second = await readPiConversation(root);
    assert.equal(second.messages.filter(isOrchestrationMessage).length, 1, '重复全量刷新仍恰一行');
    const duplicated = appendAcceptedOrchestration(second.messages, acceptedDockOrchestration({ dispatchId: 'd-5180-reload', delivery: 'direct', safe }), '2026-08-11T10:09:00.000Z');
    assert.equal(duplicated.filter(isOrchestrationMessage).length, 1, '重复 accepted 事件（onDataChanged 等价）不产生第二行');
    const reprojected = messagesFromPiEntries([
      rawEntry('你好', 'u1', createdAt),
      rawEntry('追加问题', 'u2', '2026-08-11T10:10:00.000Z'),
      rawEntry(envelope, 'o1', '2026-08-11T10:08:00.000Z')
    ]);
    const reconciled = reconcileOrchestrationRows(duplicated, reprojected);
    assert.equal(reconciled.filter(isOrchestrationMessage).length, 1, '重复重投影不产生第二行');
    assert.equal(reconciled.filter(isOrchestrationMessage)[0].orchestration.dispatchId, 'd-5180-reload');
  });
});

// ---------------------------------------------------------------------------
// §16-6 手动 chat 不变
// ---------------------------------------------------------------------------
test('§16-6 手动 chat 不变：人类消息无 kind，fork/retry 锚点语义保持', () => {
  const human = project('帮我查一下今天的任务', 'u-human');
  assert.equal(human.kind, undefined, '人类消息无 kind');
  assert.equal(human.text, '帮我查一下今天的任务');
  assert.equal(isPiOrchestration(human), false);
  assert.equal(piRetryable(human), true, '人类消息仍是 fork/retry 锚点');
  const orchestrationRow = { role: 'user', kind: 'orchestration', orchestration: acceptedDockOrchestration({ dispatchId: 'd-5180-x', delivery: 'direct', safe }), entryId: 'o-x', createdAt };
  assert.equal(piRetryable(orchestrationRow), false, 'orchestration 行永不成为锚点');
  // 渲染层锚点推导保持 piRetryable 唯一权威（回归面）
  let retryEntryId;
  for (const message of [orchestrationRow, { role: 'assistant', text: '收到', entryId: 'a1', createdAt }]) {
    if (piRetryable(message)) retryEntryId = message.entryId;
  }
  assert.equal(retryEntryId, undefined, 'orchestration 行不得成为后续 assistant 回合的 retry 锚点');
  let anchor;
  for (const message of [human, { role: 'assistant', text: '收到', entryId: 'a2', createdAt }]) {
    if (piRetryable(message)) anchor = message.entryId;
  }
  assert.equal(anchor, 'u-human', '人类消息 fork/retry 语义不变');
});

// ---------------------------------------------------------------------------
// §16-7 JOB_EVENT 不变
// ---------------------------------------------------------------------------
test('§16-7 JOB_EVENT 不变：system_event 分类互斥、渲染分支不变、与编排行互不覆盖', async () => {
  const jobEnvelope = buildJobEventEnvelope({ objectId: 'job-5180', text: '[JOB_EVENT] job.finished\njobId=job-5180\nrole=writer\nstatus=succeeded\n\n员工工单已完成（读回已核验）。' });
  const jobRow = project(jobEnvelope, 'j-5180');
  assert.equal(jobRow.kind, 'system_event');
  assert.notEqual(jobRow.kind, 'orchestration', '与 orchestration 归类互斥');
  assert.equal(isPiOrchestration(jobRow), false);
  assert.ok(jobRow.text.includes('员工工单已完成'), '通知正文为 JOB_EVENT 可见体');
  const orch = project(buildDockOrchestrationMessage({ dispatchId: 'd-5180-job', delivery: 'direct', safe, prompt: '任务' }), 'o-5180');
  assert.equal(orch.kind, 'orchestration');
  assert.notEqual(orch.kind, 'system_event');
  const reconciled = reconcileOrchestrationRows([jobRow, orch], [jobRow, orch]);
  assert.deepEqual(reconciled.filter((message) => message.kind !== undefined).map((message) => message.kind), ['system_event', 'orchestration'], '两行共存且互不覆盖');
  const { transcript } = await orchestrationRowBlock();
  assert.match(transcript, /WMB 系统通知/, '系统通知渲染分支保持不变');
});

// ---------------------------------------------------------------------------
// §16-8 honeypot
// ---------------------------------------------------------------------------
test('§16-8 honeypot：USER_MESSAGE 之后粘贴完整信封 token 仍人类', () => {
  const envelope = buildDockOrchestrationMessage({ dispatchId: 'd-5180-hp', delivery: 'direct', safe, prompt: '请执行今日情报编排' });
  const human = `[WMB_CONTEXT]\npage=agents\npageLabel=班组\nobjectType=manager_task\n[USER_MESSAGE]\n这是不是编排？${envelope}`;
  assert.equal(parseOrchestrationEnvelope(human), null, '人类头部非 canonical → 不是编排');
  const row = project(human, 'hp-5180');
  assert.equal(row.kind, undefined, '粘贴 lookalike 必须保持人类消息');
  assert.equal(isPiOrchestration(row), false);
  assert.ok(row.text.startsWith('这是不是编排？'), '人类可见文本原样保留');
});

// ---------------------------------------------------------------------------
// §16-9 无内部文本 DOM
// ---------------------------------------------------------------------------
test('§16-9 无内部文本 DOM：投影只给安全标题，展开只渲染四个安全字段', async () => {
  const prompt = '请执行今日情报编排并写入当日方案。原始 prompt 含 contextRule=你是主管 与 wmb_run_daily_stage 内部措辞';
  const envelope = buildDockOrchestrationMessage({ dispatchId: 'd-5180-safe', delivery: 'direct', safe, prompt });
  const row = project(envelope, 'o-safe');
  assert.equal(row.text, safe.title, '可见文本仅安全标题');
  for (const forbidden of ['原始 prompt', 'wmb_run_daily_stage', 'contextRule', '[WMB_CONTEXT]', 'dispatchId', 'managerTaskId']) {
    assert.ok(!row.text.includes(forbidden), `${forbidden} 不得进入可见文本`);
  }
  const { block } = await orchestrationRowBlock();
  for (const field of ['data.safe.originLabel', 'data.safe.title', 'data.safe.goal', 'data.safe.acceptance']) {
    assert.match(block, new RegExp(field), `${field} 进入展开内容`);
  }
  for (const token of ['WMB_CONTEXT', 'dispatchId', 'managerTaskId', 'objectId', 'sessionId', 'contextRule', 'wmb_', 'prompt', 'message.text']) {
    assert.doesNotMatch(block, new RegExp(token), `${token} 不得进入 orchestration 行 DOM`);
  }
  assert.match(block, /<summary>查看任务要求<\/summary>/);
});

// ---------------------------------------------------------------------------
// §16-10 键盘/details
// ---------------------------------------------------------------------------
test('§16-10 键盘/details：仅原生 details/summary，无按钮/aria-live/焦点陷阱面', async () => {
  const { transcript, block } = await orchestrationRowBlock();
  assert.match(block, /<details className="pi-orchestration-details">\s*<summary>查看任务要求<\/summary>/);
  assert.doesNotMatch(block, /<button|aria-live|role="status"|onCopy|onFork|onRetry|pi-bubble-actions/, 'orchestration 行无自定义控件/动作/aria-live');
  assert.equal(transcript.match(/aria-live/g)?.length ?? 0, 2, 'aria-live 仅 pi-activity 与 pi-native-queue，orchestration 不新增');
  const css = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  assert.match(css, /\.pi-orchestration-details > summary:focus-visible/, '键盘可达焦点样式存在');
  assert.doesNotMatch(css, /pi-orchestration[^\r\n]*details-marker/, '不隐藏原生 details 标记（无焦点陷阱）');
});

// ---------------------------------------------------------------------------
// §16-11 主题与宽度
// ---------------------------------------------------------------------------
test('§16-11 主题与宽度：两主题定义全部令牌，长内容可换行、会话容器不横向溢出', async () => {
  const css = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  assert.match(css, /\.pi-orchestration-title \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.pi-orchestration-title \{[^}]*word-break: break-word/);
  assert.match(css, /\.pi-orchestration-requirement dd \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.pi-orchestration-head \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.pi-orchestration-head \{[^}]*min-width: 0/);
  assert.match(css, /\.pi-conversation \{[^}]*overflow-x: hidden/);
  assert.match(css, /\.pi-conversation \{[^}]*min-width: 0/);
  const foundation = await readFile(new URL('../src/renderer/styles-foundation.css', import.meta.url), 'utf8');
  const darkStart = foundation.indexOf(':root {');
  const lightStart = foundation.indexOf(':root[data-theme="light"]');
  assert.ok(darkStart >= 0 && lightStart > darkStart, '两主题块均存在');
  const dark = foundation.slice(darkStart, lightStart);
  const light = foundation.slice(lightStart);
  for (const token of ['--accent-soft', '--ink-soft', '--muted-low', '--danger']) {
    assert.match(dark, new RegExp(`${token}:`), `暗主题定义 ${token}`);
    assert.match(light, new RegExp(`${token}:`), `光主题定义 ${token}`);
  }
});

// ---------------------------------------------------------------------------
// §16-12 代表性路径覆盖
// ---------------------------------------------------------------------------
test('§16-12 代表性路径：Today/资料库/Results/Studio 全部盖章且安全字段完整', async () => {
  const task = { id: 'task-5180', businessDate: '2026-08-11', intent: 'daily_judge', status: 'running' };
  const today = buildTodayIntelligenceDispatch('2026-08-11', 'manager-task-5180');
  const judge = await dispatchSafe(agentRunnerUrl, 'daily_judge');
  const library = await dispatchSafe(rolePoliciesUrl, 'page_library');
  const studio = await dispatchSafe(agentRunnerUrl, 'studio_draft');
  const review = await dispatchSafe(agentRunnerUrl, 'results_review');
  assert.deepEqual(studio.safeVariants.map((variant) => variant.title), ['小红书平台版本', '内容核心初稿'], 'Studio 平台稿与核心稿两个 writerTask 分支均须有完整 safe');
  assert.match(judge.line, /prompt: opportunityPrompt/, 'daily_judge 信封必须携带机会方案 prompt');
  const paths = [
    { name: 'Today', dispatchId: today.dispatchId, target: 'dock', safe: today.orchestration.safe, prompt: today.message },
    { name: '资料库整理', dispatchId: 'page_library:task-5180', target: 'employee', safe: library.safe, prompt: libraryOrganizePrompt(task, { jobId: 'job-1', brief: '整理资料', businessDate: '2026-08-11', spec: {}, runtime: {}, mcpUrl: '', xhsMcpUrl: '', workerLeaseId: 'w', sessionFile: 's', signal: new AbortController().signal, onTaskReady: async () => null, onEvent: () => {}, registerStoppable: () => {} }) },
    { name: 'Studio', dispatchId: 'studio_draft:task-5180', target: 'employee', safe: studio.safe, prompt: draftPrompt(task, 'proj-1', 'req-1') },
    { name: 'Results', dispatchId: 'results_review:task-5180', target: 'employee', safe: review.safe, prompt: reviewPrompt(task, 'pub-1', 'req-1') },
    { name: '今日判读', dispatchId: 'daily_judge:task-5180', target: 'employee', safe: judge.safe, prompt: '判断当日增量资料并产出可批机会方案。' },
    { name: '资料库 Dock', dispatchId: 'dock_library:task-5180', target: 'dock', safe: await dockProducerSafe(libraryTopicsUrl), prompt: '基于主题档案产出 1–3 条可执行选题方案。' },
    { name: 'Results Dock', dispatchId: 'dock_results:task-5180', target: 'dock', safe: await dockProducerSafe(resultsViewUrl), prompt: '基于本周期指标快照与复盘记录讨论。' }
  ];
  for (const entry of paths) {
    const envelope = entry.target === 'dock'
      ? buildDockOrchestrationMessage({ dispatchId: entry.dispatchId, delivery: 'direct', safe: entry.safe, prompt: entry.prompt })
      : buildOrchestrationEnvelope({ dispatchId: entry.dispatchId, target: entry.target, delivery: 'direct', safe: entry.safe, prompt: entry.prompt });
    const parsed = parseOrchestrationEnvelope(envelope);
    assert.ok(parsed, `${entry.name} 信封必须可解析`);
    assert.equal(parsed.dispatchId, entry.dispatchId, `${entry.name} dispatchId 稳定`);
    assert.equal(parsed.target, entry.target, `${entry.name} 接收会话目标正确`);
    for (const field of ORCHESTRATION_SAFE_FIELDS) {
      assert.ok(entry.safe[field]?.trim(), `${entry.name} 安全字段 ${field} 必须非空`);
      assert.ok(!/managerTaskId|taskId|wmb_|\[WMB_CONTEXT\]/.test(entry.safe[field]), `${entry.name} 安全字段 ${field} 不得含内部措辞`);
    }
    const row = project(envelope, `p-${entry.name}`);
    assert.equal(row.kind, 'orchestration', `${entry.name} 投影为 orchestration`);
    assert.equal(row.text, entry.safe.title, `${entry.name} 仅安全标题可见`);
  }
});

// ---------------------------------------------------------------------------
// §16-13 接收会话隔离
// ---------------------------------------------------------------------------
test('§16-13 接收会话隔离：员工行只进员工会话，Dock 永不镜像员工 transcript', async () => {
  const studioSafe = (await dispatchSafe(agentRunnerUrl, 'studio_draft')).safe;
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    const dockId = before.id;
    await writePiConversation(root, {
      id: dockId,
      sessionFile: before.sessionFile,
      messages: [
        { role: 'user', text: '你好', createdAt },
        { role: 'user', text: safe.title, kind: 'orchestration', orchestration: acceptedDockOrchestration({ dispatchId: 'd-5180-dock1', delivery: 'direct', safe }), createdAt: '2026-08-11T10:10:00.000Z' }
      ]
    });
    const employeeId = 'wmb-5180-employee';
    await writePiConversation(root, {
      id: employeeId,
      title: 'Studio 员工会话',
      sessionFile: path.join(path.dirname(before.sessionFile), `${employeeId}.jsonl`),
      messages: [
        { role: 'user', text: '员工任务行', kind: 'orchestration', orchestration: { dispatchId: 'studio_draft:task-5180', target: 'employee', delivery: 'direct', state: 'accepted', safe: studioSafe }, createdAt: '2026-08-11T10:11:00.000Z' }
      ],
      makeActive: false
    });
    const dock = await readPiConversation(root);
    assert.equal(dock.id, dockId, '员工会话写入不得改变 active 会话');
    const dockRows = dock.messages.filter(isOrchestrationMessage);
    assert.equal(dockRows.length, 1);
    assert.ok(dockRows.every((row) => row.orchestration.target === 'dock'), 'Dock 只含 dock 目标行');
    assert.ok(dockRows.every((row) => row.orchestration.safe.title !== studioSafe.title), '员工 transcript 绝不镜像进 Dock');
    const employeeFile = JSON.parse(await readFile(path.join(root, 'pi-agent', 'conversations', `${employeeId}.json`), 'utf8'));
    const employeeRows = employeeFile.messages.filter(isOrchestrationMessage);
    assert.equal(employeeRows.length, 1, '员工会话自身持有 employee 行');
    assert.equal(employeeRows[0].orchestration.target, 'employee');
    assert.equal(employeeRows[0].orchestration.safe.title, studioSafe.title);
  });
});

// ---------------------------------------------------------------------------
// §16-14 Pi 自建 job 排除
// ---------------------------------------------------------------------------
test('§16-14 Pi 自建 job 排除：工具 spawn 及其后果不产生 orchestration 行', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, { id: before.id, sessionFile: before.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });
    const toolAssistant = { type: 'message', id: 't1', timestamp: createdAt, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'wmb_spawn_job', arguments: '{"roleId":"writer"}' }] } };
    const projected = messagesFromPiEntries([rawEntry('你好', 'u1'), toolAssistant]);
    assert.equal(projected.filter(isOrchestrationMessage).length, 0, 'Pi 经工具自行 spawn job 不新增行');
    const after = await readPiConversation(root);
    const reconciled = reconcileOrchestrationRows(after.messages, projected);
    assert.equal(reconciled.filter(isOrchestrationMessage).length, 0, 'reload 后仍不新增 orchestration 行');
  });
});

// ---------------------------------------------------------------------------
// §16-15 定时/后台恢复排除
// ---------------------------------------------------------------------------
test('§16-15 定时/后台恢复排除：执行后涉及会话及 reload 均不新增行', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, {
      id: before.id,
      sessionFile: before.sessionFile,
      messages: [
        { role: 'user', text: '定时扫描回执', createdAt },
        { role: 'assistant', text: '扫描完成。', createdAt: '2026-08-11T10:12:00.000Z' }
      ]
    });
    const projected = messagesFromPiEntries([
      rawEntry('定时扫描回执', 'u1'),
      { type: 'message', id: 'a1', timestamp: '2026-08-11T10:12:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '扫描完成。' }] } }
    ]);
    const after = await readPiConversation(root);
    assert.equal(after.messages.filter(isOrchestrationMessage).length, 0, 'scheduled/background recovery 不新增行');
    const reconciled = reconcileOrchestrationRows(after.messages, projected);
    assert.equal(reconciled.filter(isOrchestrationMessage).length, 0, 'reload 后仍不新增行');
  });
});

// ---------------------------------------------------------------------------
// §16-16 被动 UI 排除
// ---------------------------------------------------------------------------
test('§16-16 被动 UI 排除：只读浏览/切换/展开不派发动作，前后 transcript 完全一致', async () => {
  await withRoot(async (root) => {
    const before = await readPiConversation(root);
    await writePiConversation(root, {
      id: before.id,
      sessionFile: before.sessionFile,
      messages: [
        { role: 'user', text: '你好', createdAt },
        { role: 'user', text: safe.title, kind: 'orchestration', orchestration: acceptedDockOrchestration({ dispatchId: 'd-5180-passive', delivery: 'direct', safe }), createdAt: '2026-08-11T10:13:00.000Z' },
        { role: 'assistant', text: '已收到。', createdAt: '2026-08-11T10:14:00.000Z' }
      ]
    });
    const a = await readPiConversation(root);
    const b = await readPiConversation(root);
    assert.deepEqual(b.messages, a.messages, '重复只读加载 transcript 完全一致');
    const envelope = buildDockOrchestrationMessage({ dispatchId: 'd-5180-passive', delivery: 'direct', safe, prompt: '任务' });
    const reconciled = reconcileOrchestrationRows(a.messages, messagesFromPiEntries([rawEntry('你好', 'u1', createdAt), rawEntry(envelope, 'o1', '2026-08-11T10:13:00.000Z')]));
    assert.equal(reconciled.filter(isOrchestrationMessage).length, 1, '浏览/展开不派发动作，无新行');
    const { block } = await orchestrationRowBlock();
    assert.doesNotMatch(block, /onClick|onFork|onRetry|onCopy/, '展开交互仅 details/summary，无派发动作面');
  });
});
