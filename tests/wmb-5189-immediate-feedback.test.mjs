import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildOrchestrationEnvelope } from '../src/shared/orchestration-envelope.ts';
import { extractVisiblePrompt, VISIBLE_PROMPT_FALLBACK } from '../src/shared/pi-visible-prompt.ts';
import {
  appendAcceptedOrchestration,
  appendPendingOrchestration,
  isOrchestrationMessage,
  reconcileOrchestrationRows,
  updateFailedOrchestration
} from '../src/main/pi-orchestration-store.ts';
import { messagesFromPiEntries } from '../src/main/pi-transcript-projection.ts';
import { readPiConversation } from '../src/main/pi-conversation.ts';
import {
  acceptedDockOrchestration,
  appendAcceptedDockRow,
  appendPendingDockRow,
  markDockOrchestrationFailed,
  pendingDockOrchestration
} from '../src/main/ipc-pi-dock.ts';
import { createPiLocalQueueItem, filterPiNativeQueueMessages, mergePiLocalQueueMessages, piLocalQueueEntryId, piRetryable, prunePiLocalQueue, reconcilePiLocalQueue } from '../src/renderer/pi-dock-utils.ts';

const createdAt = '2026-08-11T08:57:46.000Z';
const safe = {
  originLabel: '今日情报',
  title: '今日情报编排',
  goal: '采集并判读当日情报，产出可批方案',
  acceptance: '可信渠道回执 + 当日可批方案'
};

function rawEntry(text, id = 'entry-1') {
  return { type: 'message', id, timestamp: createdAt, message: { role: 'user', content: text } };
}

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5189-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test('canonical visible extractor hides wrappers, survives Skill routing, and preserves honeypot text', () => {
  const wrapped = '[WMB_CONTEXT]\npage=agents\npageLabel=班组\nobjectType=manager_task\n[USER_MESSAGE]\n用户真正输入\ntaskId=internal';
  assert.equal(extractVisiblePrompt(wrapped), '用户真正输入');
  assert.equal(extractVisiblePrompt(`/skill:evidence-grounded-writer [USER_MESSAGE]\n${wrapped}`), '用户真正输入');
  const nativeSkillWrapped = `<skill name="evidence-grounded-writer">规则中即使出现 [USER_MESSAGE] 也不是用户正文</skill>\n\n[USER_MESSAGE]\n${wrapped}`;
  assert.equal(extractVisiblePrompt(nativeSkillWrapped), '用户真正输入', 'Pi 原生展开 Skill 后仍递归提取业务信封正文');

  const envelope = buildOrchestrationEnvelope({ dispatchId: 'd-visible', target: 'dock', delivery: 'direct', safe, prompt: '内部原始指令' });
  assert.equal(extractVisiblePrompt(envelope), safe.title, '盖章编排只显示安全标题');
  const honeypot = `[WMB_CONTEXT]\npage=agents\n[USER_MESSAGE]\n这是人类粘贴：${envelope}`;
  assert.ok(extractVisiblePrompt(honeypot).startsWith('这是人类粘贴：'), '正文中的 lookalike 不得截断人类文本');
  assert.equal(extractVisiblePrompt('   '), VISIBLE_PROMPT_FALLBACK, '空值 fail closed');
});

test('pending transitions in place to accepted or failed and remains exactly once', () => {
  const pending = pendingDockOrchestration({ dispatchId: 'd-state', delivery: 'direct', safe });
  const once = appendPendingOrchestration([], pending, createdAt);
  assert.equal(once.length, 1);
  assert.equal(once[0].orchestration.state, 'pending');
  assert.equal(appendPendingOrchestration(once, pending, createdAt), once, '同 dispatchId 重放不得复制');

  const accepted = appendAcceptedOrchestration(once, acceptedDockOrchestration({ dispatchId: 'd-state', delivery: 'direct', safe }), createdAt);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].orchestration.state, 'accepted');
  assert.equal(accepted[0].createdAt, createdAt, '原地升级保留时间位置');

  const failed = updateFailedOrchestration(once, 'd-state', '网络不可用');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].orchestration.state, 'failed');
  assert.equal(failed[0].orchestration.error, '网络不可用');
});

test('pending survives reload without raw evidence and raw acceptance upgrades it without duplication', () => {
  const pending = appendPendingOrchestration([], pendingDockOrchestration({ dispatchId: 'd-reload', delivery: 'direct', safe }), createdAt);
  assert.equal(reconcileOrchestrationRows(pending, []), pending, 'Pi 尚未产生 raw entry 时 pending 必须保留');

  const envelope = buildOrchestrationEnvelope({ dispatchId: 'd-reload', target: 'dock', delivery: 'direct', safe, prompt: '内部原始指令' });
  const projected = messagesFromPiEntries([rawEntry(envelope)]);
  const reconciled = reconcileOrchestrationRows(pending, projected);
  const rows = reconciled.filter(isOrchestrationMessage);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orchestration.state, 'accepted');
});

test('dock persistence exposes pending before Pi and updates the same durable row', async () => {
  await withRoot(async (root) => {
    const pending = await appendPendingDockRow(root, { dispatchId: 'd-durable', delivery: 'direct', safe, createdAt });
    assert.ok(pending);
    assert.equal(pending.messages.filter(isOrchestrationMessage).length, 1);
    assert.equal(pending.messages.find(isOrchestrationMessage).orchestration.state, 'pending');

    const accepted = await appendAcceptedDockRow(root, { dispatchId: 'd-durable', delivery: 'direct', safe, createdAt });
    assert.ok(accepted);
    assert.equal(accepted.messages.filter(isOrchestrationMessage).length, 1);
    assert.equal(accepted.messages.find(isOrchestrationMessage).orchestration.state, 'accepted');

    await markDockOrchestrationFailed(root, 'd-durable', 'PROVIDER_DOWN: 服务暂不可用\n at internal');
    const failed = await readPiConversation(root);
    const rows = failed.messages.filter(isOrchestrationMessage);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orchestration.state, 'failed');
    assert.equal(rows[0].orchestration.error, '服务暂不可用');
  });
});

test('busy manual sends stay in the transcript while native and canonical layers take over exactly once', () => {
  const first = createPiLocalQueueItem('重复问题', 'steer');
  const second = createPiLocalQueueItem('重复问题', 'steer');
  const follow = createPiLocalQueueItem('下一轮问题', 'followUp');
  const failed = { ...createPiLocalQueueItem('会失败的问题'), status: 'failed' };
  const nativeWrapped = '[WMB_CONTEXT]\npage=pi\n[USER_MESSAGE]\n重复问题\ntaskId=secret';
  const followWrapped = '[WMB_CONTEXT]\npage=pi\n[USER_MESSAGE]\n下一轮问题\ntaskId=secret';
  const snapshot = { steering: [nativeWrapped, nativeWrapped, '外部排队消息'], followUp: [followWrapped] };
  const accepted = reconcilePiLocalQueue(snapshot, [first, second, follow, failed]);
  assert.deepEqual(accepted.map((item) => [item.text, item.delivery, item.status]), [
    ['重复问题', 'steer', 'accepted'],
    ['重复问题', 'steer', 'accepted'],
    ['下一轮问题', 'followUp', 'accepted'],
    ['会失败的问题', 'steer', 'failed']
  ]);
  assert.deepEqual(reconcilePiLocalQueue(snapshot, accepted), accepted, 'native 重放只保留 accepted 状态，不删除或复制本地气泡');
  assert.deepEqual(filterPiNativeQueueMessages(snapshot.steering, 'steer', accepted), ['外部排队消息'], '人工正文由用户气泡承载，native 队列只显示未对应的外部消息');
  assert.deepEqual(filterPiNativeQueueMessages(snapshot.followUp, 'followUp', accepted), []);

  const beforeCanonical = mergePiLocalQueueMessages([
    { role: 'assistant', text: '第一轮处理中', entryId: 'assistant-a', createdAt: new Date(Date.parse(first.createdAt) - 1).toISOString() }
  ], accepted);
  const projectedFirst = beforeCanonical.find((message) => message.entryId === piLocalQueueEntryId(first.localId));
  assert.equal(projectedFirst?.text, '重复问题', 'native 接管期间人工正文仍是主时间线用户气泡');
  assert.equal(piRetryable(projectedFirst), false, '瞬态气泡不得冒充 canonical fork/retry 锚点');

  const canonicalFirst = { role: 'user', text: '重复问题', entryId: 'session-user-1', createdAt: new Date(Date.parse(first.createdAt) + 1).toISOString() };
  const afterOneCanonical = mergePiLocalQueueMessages([canonicalFirst], accepted);
  assert.equal(afterOneCanonical.filter((message) => message.text === '重复问题').length, 2, '第一个 canonical 条目只接管第一个重复本地气泡');
  const canonicalSecond = { role: 'user', text: '重复问题', entryId: 'session-user-2', createdAt: new Date(Date.parse(second.createdAt) + 2).toISOString() };
  const afterBothCanonical = mergePiLocalQueueMessages([canonicalFirst, canonicalSecond], accepted);
  assert.equal(afterBothCanonical.filter((message) => message.text === '重复问题').length, 2, '两个 canonical 条目接管后重复文本仍恰好两份');
  assert.equal(afterBothCanonical.some((message) => message.entryId?.startsWith('local-queue:') && message.text === '重复问题'), false);
  assert.equal(prunePiLocalQueue([canonicalFirst], accepted).length, 3, '只回收已有 canonical 证据的第一个重复本地项');
  assert.equal(prunePiLocalQueue([canonicalFirst, canonicalSecond], accepted).length, 2, 'canonical 接管后仅保留尚无会话证据的其他本地项');
});
