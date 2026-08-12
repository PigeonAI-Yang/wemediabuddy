import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildOrchestrationEnvelope,
  parseOrchestrationEnvelope,
  isOrchestrationEnvelope,
  isValidOrchestrationData,
  ORCHESTRATION_MARKER,
  ORCHESTRATION_SAFE_FIELDS
} from '../src/shared/orchestration-envelope.ts';
import { messagesFromPiEntries } from '../src/main/pi-transcript-projection.ts';
import {
  appendAcceptedOrchestration,
  updateFailedOrchestration,
  reconcileOrchestrationRows,
  isOrchestrationMessage
} from '../src/main/pi-orchestration-store.ts';
import { readPiConversation, writePiConversation } from '../src/main/pi-conversation.ts';
import { buildJobEventEnvelope } from '../src/shared/job-event-envelope.ts';

const dispatchId = 'dispatch-1';
const safe = {
  originLabel: '今日情报',
  title: '今日情报编排',
  goal: '采集并判读当日情报，产出可批方案',
  acceptance: '可信渠道回执 + 当日可批方案'
};
const acceptedData = { dispatchId, target: 'dock', delivery: 'direct', state: 'accepted', safe };
const createdAt = '2026-08-10T10:00:00.000Z';

function rawEntry(text, id = 'e1', timestamp = createdAt) {
  return { type: 'message', id, timestamp, message: { role: 'user', content: text } };
}

function project(text, id = 'e1') {
  return messagesFromPiEntries([rawEntry(text, id)])[0];
}

test('builder emits the canonical envelope and parser round-trips full data', () => {
  const envelope = buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe, prompt: '请执行今日情报编排' });
  assert.equal(envelope.startsWith('[WMB_CONTEXT]\npage=pi\npageLabel=Pi 编排\nobjectType=orchestration\ndispatchId=dispatch-1\ntarget=dock\ndelivery=direct\n'), true);
  assert.equal(envelope.includes(ORCHESTRATION_MARKER), true, '语义标记位于 [USER_MESSAGE] 之前');
  assert.equal(envelope.endsWith(`\n${ORCHESTRATION_MARKER}\n[USER_MESSAGE]\n请执行今日情报编排`), true, '正文按原样保留在 [USER_MESSAGE] 之后');
  assert.equal(isOrchestrationEnvelope(envelope), true);
  assert.deepEqual(parseOrchestrationEnvelope(envelope), acceptedData, 'parser 往返恢复完整 canonical 数据（state 恒为 accepted）');

  const generated = project(envelope, 'e-orch-1');
  assert.equal(generated.kind, 'orchestration');
  assert.equal(generated.role, 'user', 'raw role=user 不变');
  assert.equal(generated.orchestration.state, 'accepted');
  assert.equal(generated.text, safe.title, '可见文本仅安全标题');
  assert.equal(generated.text.includes('请执行今日情报编排'), false, 'raw prompt 绝不泄漏进可见文本');
  assert.equal(generated.text.includes('[WMB_CONTEXT]'), false);
  assert.equal(generated.entryId, 'e-orch-1');
  assert.equal(generated.createdAt, createdAt);
});

test('safe-field validator accepts complete data and rejects every invalid/tampered field', () => {
  assert.equal(isValidOrchestrationData(acceptedData), true);
  assert.equal(isValidOrchestrationData({ ...acceptedData, state: 'failed', error: '渠道请求超时，未收到可信回执。' }), true);
  for (const field of ORCHESTRATION_SAFE_FIELDS) {
    assert.equal(isValidOrchestrationData({ ...acceptedData, safe: { ...safe, [field]: '' } }), false, `${field} 缺失必须非法`);
  }
  assert.equal(isValidOrchestrationData({ ...acceptedData, safe: { originLabel: 'x', title: 'y', goal: 'z' } }), false, 'safe 缺字段必须非法');
  assert.equal(isValidOrchestrationData({ ...acceptedData, dispatchId: '' }), false);
  assert.equal(isValidOrchestrationData({ ...acceptedData, dispatchId: '   ' }), false);
  assert.equal(isValidOrchestrationData({ ...acceptedData, target: 'other' }), false);
  assert.equal(isValidOrchestrationData({ ...acceptedData, delivery: 'chat' }), false);
  assert.equal(isValidOrchestrationData({ ...acceptedData, state: 'pending' }), true);
  assert.equal(isValidOrchestrationData({ ...acceptedData, error: '炸了' }), false, 'accepted 行不得携带 error');
  assert.equal(isValidOrchestrationData({ ...acceptedData, state: 'failed', error: '' }), false);
  assert.equal(isValidOrchestrationData({ ...acceptedData, state: 'failed', error: '   ' }), false);
  assert.equal(isValidOrchestrationData(null), false);
  assert.equal(isValidOrchestrationData(undefined), false);
  assert.equal(isValidOrchestrationData('text'), false);
});

test('builder fails before dispatch when any safe field is missing or malformed', () => {
  for (const field of ORCHESTRATION_SAFE_FIELDS) {
    assert.throws(() => buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe: { ...safe, [field]: '' }, prompt: '任务' }), /不能为空/, `${field} 缺失必须抛错`);
  }
  assert.throws(() => buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe: { originLabel: 'x', title: 'y', goal: 'z' }, prompt: '任务' }), /不能为空/);
  assert.throws(() => buildOrchestrationEnvelope({ dispatchId: '', target: 'dock', delivery: 'direct', safe, prompt: '任务' }), /不能为空/);
  assert.throws(() => buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe: { ...safe, title: '标题\n换行' }, prompt: '任务' }), /换行/);
  assert.throws(() => buildOrchestrationEnvelope({ dispatchId, target: 'other', delivery: 'direct', safe, prompt: '任务' }), /target/);
  assert.throws(() => buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'queue', safe, prompt: '任务' }), /delivery/);
  assert.throws(() => buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe, prompt: '   ' }), /prompt/);
});

test('every envelope field mutation is rejected (mutation matrix derived from builder output)', () => {
  const base = buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe, prompt: '请执行今日情报编排' });
  const mutations = [
    { name: 'dispatchId 为空', apply: (s) => s.replace('dispatchId=dispatch-1', 'dispatchId=') },
    { name: 'target 非法', apply: (s) => s.replace('target=dock', 'target=other') },
    { name: 'delivery 非法', apply: (s) => s.replace('delivery=direct', 'delivery=queue') },
    { name: 'originLabel 为空', apply: (s) => s.replace('originLabel=今日情报', 'originLabel=') },
    { name: 'title 为空', apply: (s) => s.replace('title=今日情报编排', 'title=') },
    { name: 'goal 缺失', apply: (s) => s.replace('goal=采集并判读当日情报，产出可批方案\n', '') },
    { name: 'acceptance 为空', apply: (s) => s.replace('acceptance=可信渠道回执 + 当日可批方案', 'acceptance=') },
    { name: '语义标记删除', apply: (s) => s.replace(`${ORCHESTRATION_MARKER}\n`, '') },
    { name: '[USER_MESSAGE] 标记大小写', apply: (s) => s.replace('[USER_MESSAGE]\n', '[user_message]\n') },
    { name: '[WMB_CONTEXT] 前缀缺失', apply: (s) => s.replace('[WMB_CONTEXT]\n', '') },
    { name: '头部顺序', apply: (s) => { const lines = s.split('\n'); [lines[1], lines[2]] = [lines[2], lines[1]]; return lines.join('\n'); } }
  ];
  for (const mutation of mutations) {
    const mutated = mutation.apply(base);
    assert.notEqual(mutated, base, `${mutation.name} 变异必须真实改变文本`);
    assert.equal(parseOrchestrationEnvelope(mutated), null, `${mutation.name} 变异必须判非 orchestration`);
    const generated = project(mutated, `m-${mutations.indexOf(mutation)}`);
    assert.equal(generated.kind, undefined, `${mutation.name} 变异投影必须保持 kindless`);
  }
});

test('honeypot: lookalike envelopes stay human after [USER_MESSAGE] or with partial headers', () => {
  const base = buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe, prompt: '请执行今日情报编排' });

  // 人类风格头部（班组 header）+ 正文粘贴全部信封 token → 仍人类
  const humanHeader = base
    .replace('page=pi', 'page=agents')
    .replace('pageLabel=Pi 编排', 'pageLabel=班组')
    .replace('objectType=orchestration', 'objectType=manager_task')
    .replace('请执行今日情报编排', `这是不是编排？${base}`);
  assert.equal(isOrchestrationEnvelope(humanHeader), false);
  assert.equal(project(humanHeader, 'h1').kind, undefined);

  // token soup 在正文中间、无 canonical 头部 → 仍人类
  const soup = `帮我看看这段：${ORCHESTRATION_MARKER} dispatchId=${dispatchId} page=pi 是什么？`;
  assert.equal(isOrchestrationEnvelope(soup), false);
  assert.equal(project(soup, 'h2').kind, undefined);

  // 裸 [ORCHESTRATION] 前缀启发式依旧禁止
  const bare = '[ORCHESTRATION] 这行是什么？';
  assert.equal(isOrchestrationEnvelope(bare), false);
  assert.equal(project(bare, 'h3').kind, undefined);

  // 不完整头部（缺 target/delivery/safe/marker）→ 仍人类
  const partial = ['[WMB_CONTEXT]', 'page=pi', 'pageLabel=Pi 编排', 'objectType=orchestration', 'dispatchId=partial-1', '[USER_MESSAGE]', '帮我解释编排'].join('\n');
  assert.equal(isOrchestrationEnvelope(partial), false);
  assert.equal(project(partial, 'h4').kind, undefined);
  assert.equal(project(partial, 'h4').text, '帮我解释编排', '可见文本保持人类原样');
});

test('ordinary / system_event / orchestration paths are mutually exclusive', () => {
  const orchestration = buildOrchestrationEnvelope({ dispatchId, target: 'employee', delivery: 'steer', safe, prompt: '采完续接策划' });
  const jobEvent = buildJobEventEnvelope({ objectId: 'job-9', text: '[JOB_EVENT] job.finished\njobId=job-9\nrole=writer\nstatus=succeeded' });

  const orchestrationRow = project(orchestration, 'o1');
  assert.equal(orchestrationRow.kind, 'orchestration');
  assert.notEqual(orchestrationRow.kind, 'system_event');
  assert.equal(orchestrationRow.orchestration.target, 'employee');
  assert.equal(orchestrationRow.orchestration.delivery, 'steer');

  const jobEventRow = project(jobEvent, 'j1');
  assert.equal(jobEventRow.kind, 'system_event');
  assert.notEqual(jobEventRow.kind, 'orchestration');

  const humanRow = project('帮我查一下今天的任务', 'u1');
  assert.equal(humanRow.kind, undefined);
  assert.equal(humanRow.text, '帮我查一下今天的任务', '普通人类消息剥离语义不变');
});

test('normalize preserves only valid orchestration records and never grants the kind to invalid metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5177-normalize-'));
  try {
    const active = await readPiConversation(root);
    await writePiConversation(root, {
      id: active.id,
      sessionFile: active.sessionFile,
      messages: [
        { role: 'user', text: safe.title, kind: 'orchestration', orchestration: acceptedData, createdAt },
        { role: 'user', text: '旧消息', createdAt },
        { role: 'user', text: '篡改行', kind: 'orchestration', orchestration: { dispatchId: 'bad-1', target: 'dock', delivery: 'direct', state: 'accepted', safe: { originLabel: 'x', title: 'y', goal: 'z' } }, createdAt },
        { role: 'user', text: '事件行', kind: 'system_event', orchestration: acceptedData, createdAt }
      ]
    });
    const rows = (await readPiConversation(root)).messages;
    assert.equal(rows[0].kind, 'orchestration', '有效编排记录保留 kind + data');
    assert.equal(rows[0].orchestration.dispatchId, dispatchId);
    assert.equal(rows[0].orchestration.state, 'accepted');
    assert.equal('kind' in rows[1], false, '无 kind 遗留消息保持 kindless');
    assert.equal('orchestration' in rows[2], false, '非法元数据绝不获得 kind');
    assert.equal(rows[2].kind, undefined);
    assert.equal(rows[2].text, '篡改行', '非法行保留可见文本但不带 kind');
    assert.equal(rows[3].kind, 'system_event', 'system_event 路径不变');
    assert.equal('orchestration' in rows[3], false, 'system_event 与 orchestration 互斥，data 被丢弃');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('reload refresh merges live accepted row with raw projection exactly once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5177-exact-once-'));
  try {
    const active = await readPiConversation(root);
    await writePiConversation(root, {
      id: active.id,
      sessionFile: active.sessionFile,
      messages: [
        { role: 'user', text: '你好', createdAt },
        { role: 'user', text: safe.title, kind: 'orchestration', orchestration: acceptedData, createdAt }
      ]
    });
    const envelope = buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe, prompt: '请执行今日情报编排' });
    await writeFile(active.sessionFile, [
      { type: 'message', id: 'u1', timestamp: createdAt, message: { role: 'user', content: '你好' } },
      { type: 'message', id: 'o1', timestamp: createdAt, message: { role: 'user', content: envelope } }
    ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');

    const reloaded = await readPiConversation(root);
    assert.equal(reloaded.messages.filter((message) => message.kind === 'orchestration').length, 1, 'reload 后每 dispatchId 恰一行');
    assert.equal(reloaded.messages.filter((message) => message.kind === 'orchestration')[0].orchestration.dispatchId, dispatchId);

    const again = await readPiConversation(root);
    assert.equal(again.messages.filter((message) => message.kind === 'orchestration').length, 1, '重复全量刷新不产生第二行');

    const reprojected = messagesFromPiEntries([
      { type: 'message', id: 'u1', timestamp: createdAt, message: { role: 'user', content: '你好' } },
      { type: 'message', id: 'o1', timestamp: createdAt, message: { role: 'user', content: envelope } }
    ]);
    const reconciled = reconcileOrchestrationRows(reloaded.messages, reprojected);
    assert.equal(reconciled.filter((message) => message.kind === 'orchestration').length, 1, '重复重投影不产生第二行');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('raw projection arriving before the live accepted event forms the row and late events are ignored', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5177-raw-first-'));
  try {
    const active = await readPiConversation(root);
    const envelope = buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe, prompt: '请执行今日情报编排' });
    await writeFile(active.sessionFile, [rawEntry(envelope, 'o1')].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
    await writePiConversation(root, { id: active.id, sessionFile: active.sessionFile, messages: [{ role: 'user', text: '你好', createdAt }] });

    const reloaded = await readPiConversation(root);
    const rows = reloaded.messages.filter((message) => message.kind === 'orchestration');
    assert.equal(rows.length, 1, 'canonical raw entry 本身已是接受证明，直接成行');
    assert.equal(rows[0].orchestration.dispatchId, dispatchId);

    const afterLive = appendAcceptedOrchestration(reloaded.messages, acceptedData, '2026-08-10T10:01:00.000Z');
    assert.equal(afterLive.filter((message) => message.kind === 'orchestration').length, 1, '后到的同 dispatchId accepted 事件幂等忽略');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('queue-ack accepted rows with no raw entry survive projection refresh', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5177-queue-ack-'));
  try {
    const active = await readPiConversation(root);
    await writePiConversation(root, {
      id: active.id,
      sessionFile: active.sessionFile,
      messages: [
        { role: 'user', text: '你好', createdAt },
        { role: 'user', text: safe.title, kind: 'orchestration', orchestration: { ...acceptedData, delivery: 'steer' }, createdAt }
      ]
    });
    await writeFile(active.sessionFile, [rawEntry('你好', 'u1')].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');

    const reloaded = await readPiConversation(root);
    const rows = reloaded.messages.filter((message) => message.kind === 'orchestration');
    assert.equal(rows.length, 1, 'queue-ack 行在投影刷新后必须保留');
    assert.equal(rows[0].orchestration.delivery, 'steer');
    assert.equal(rows[0].orchestration.state, 'accepted');

    const envelope = buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'steer', safe, prompt: '采完续接策划' });
    const projected = messagesFromPiEntries([
      rawEntry('你好', 'u1'),
      rawEntry(envelope, 'o1')
    ]);
    const reconciled = reconcileOrchestrationRows(reloaded.messages, projected);
    assert.equal(reconciled.filter((message) => message.kind === 'orchestration').length, 1, '后续同 dispatchId raw entry 只做对账');
    assert.equal(reconciled.filter((message) => message.kind === 'orchestration')[0].orchestration.delivery, 'steer');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('queue-ack row survives a preferred projection with no matching raw entry, reinserted chronologically', () => {
  const storedQueueRow = { role: 'user', text: safe.title, kind: 'orchestration', orchestration: { ...acceptedData, delivery: 'steer' }, createdAt };
  // projected 普通消息更完整/更多（2 > 1）且完全无该 dispatchId → preferProjectedMessages 选投影版本
  const projected = messagesFromPiEntries([
    rawEntry('你好', 'u1', createdAt),
    rawEntry('追加的问题', 'u2', '2026-08-10T10:02:00.000Z')
  ]);
  const reconciled = reconcileOrchestrationRows(
    [{ role: 'user', text: '你好', createdAt }, storedQueueRow],
    projected
  );
  const plainUsers = reconciled.filter((message) => message.role === 'user' && message.kind === undefined);
  assert.deepEqual(plainUsers.map((message) => message.text), ['你好', '追加的问题'], '普通投影内容采用新版本');
  const rows = reconciled.filter((message) => message.kind === 'orchestration');
  assert.equal(rows.length, 1, 'stored queue 行仍恰一行');
  assert.equal(rows[0].orchestration.dispatchId, dispatchId);
  assert.equal(rows[0].orchestration.delivery, 'steer', 'delivery 保留');
  assert.equal(rows[0].orchestration.state, 'accepted', 'state 保留');
  assert.deepEqual(rows[0].orchestration.safe, safe, 'safe 保留');
  assert.equal(isValidOrchestrationData(rows[0].orchestration), true);
  // 时间顺序：queue 行按 createdAt 重插（u1 → queue → u2），时间线不重排
  assert.deepEqual(reconciled.map((message) => (message.role === 'user' && message.kind === undefined ? message.text : message.kind)), ['你好', 'orchestration', '追加的问题']);
});

test('failed state updates the same row in place, preserving order and never appending', () => {
  const base = [
    { role: 'user', text: '你好', createdAt },
    { role: 'user', text: safe.title, kind: 'orchestration', orchestration: acceptedData, createdAt },
    { role: 'assistant', text: '收到', createdAt }
  ];
  const updated = updateFailedOrchestration(base, dispatchId, '渠道请求超时，未收到可信回执。');
  assert.equal(updated.length, 3, 'NEVER 新建行');
  assert.equal(isOrchestrationMessage(updated[1]), true);
  assert.equal(updated[1].orchestration.state, 'failed');
  assert.equal(updated[1].orchestration.error, '渠道请求超时，未收到可信回执。');
  assert.deepEqual(updated[1].orchestration.safe, safe, 'safe 字段原地保留');
  assert.equal(isValidOrchestrationData(updated[1].orchestration), true);
  assert.equal(updated[0].text, '你好', '时间线顺序不重排');
  assert.equal(updated[2].text, '收到');

  assert.deepEqual(updateFailedOrchestration(base, 'unknown-dispatch', '错'), base, '未知 dispatchId 为 no-op');
  assert.deepEqual(updateFailedOrchestration(base, dispatchId, '   '), base, '空错误为 no-op');

  const twice = updateFailedOrchestration(updated, dispatchId, '第二次重试仍超时。');
  assert.equal(twice.length, 3, '重复失败事件仍同一行');
  assert.equal(twice[1].orchestration.state, 'failed');
  assert.equal(twice[1].orchestration.error, '第二次重试仍超时。');
});

test('appendAcceptedOrchestration appends once and rejects invalid data', () => {
  const once = appendAcceptedOrchestration([], acceptedData, createdAt);
  assert.equal(once.length, 1);
  assert.equal(once[0].role, 'user');
  assert.equal(once[0].kind, 'orchestration');
  assert.equal(once[0].text, safe.title);
  assert.equal(once[0].createdAt, createdAt);
  assert.equal(appendAcceptedOrchestration(once, acceptedData, createdAt).length, 1, '重复 accepted 事件不产生第二行');
  assert.equal(appendAcceptedOrchestration([], { ...acceptedData, state: 'failed', error: '错' }, createdAt).length, 0, '非 accepted 状态不产生行');
  assert.equal(appendAcceptedOrchestration([], { ...acceptedData, safe: { originLabel: 'x', title: 'y', goal: 'z' } }, createdAt).length, 0, '非法数据不产生行');
});
