import assert from 'node:assert/strict';
import test from 'node:test';
import { messagesFromPiEntries } from '../src/main/pi-transcript-projection.ts';
import { buildJobEventEnvelope, isJobEventEnvelope, JOB_EVENT_CONTEXT_RULE } from '../src/shared/job-event-envelope.ts';
import { presentPiNativeQueueMessage } from '../src/renderer/pi-dock-utils.ts';

const body = '[JOB_EVENT] job.finished\njobId=job-7\nrole=writer\nstatus=succeeded';

function project(text) {
  return messagesFromPiEntries([
    { type: 'message', id: 'j1', timestamp: '2026-08-10T10:00:00.000Z', message: { role: 'user', content: text } }
  ])[0];
}

test('builder emits the canonical envelope shape byte-for-byte', () => {
  const envelope = buildJobEventEnvelope({ objectId: 'job-7', text: body });
  // 固定头部字段（字段值 + 顺序）与生产信封逐字一致；contextRule 行与正文经常量/原样传递
  assert.equal(envelope.startsWith('[WMB_CONTEXT]\npage=agents\npageLabel=班组 · 工单通知\nobjectType=job\nobjectId=job-7\n'), true);
  assert.equal(envelope.split(JOB_EVENT_CONTEXT_RULE).length, 2, 'contextRule 全文恰好出现一次');
  assert.equal(envelope.endsWith(`\n${JOB_EVENT_CONTEXT_RULE}\n[USER_MESSAGE]\n${body}`), true, '正文按原样保留在 [USER_MESSAGE] 之后');
});

test('round trip: builder output is a system event through the projection detector', () => {
  const envelope = buildJobEventEnvelope({ objectId: 'job-7', text: body });
  assert.equal(isJobEventEnvelope(envelope), true);
  const generated = project(envelope);
  assert.equal(generated.kind, 'system_event');
  assert.equal(generated.role, 'user');
  assert.equal(generated.text.startsWith('[JOB_EVENT] job.finished'), true);
  assert.equal(generated.text.includes('[WMB_CONTEXT]'), false, '投影只暴露可见正文');
});

test('native queue keeps canonical system identity without reclassifying human lookalikes', () => {
  const envelope = buildJobEventEnvelope({ objectId: 'job-7', text: body });
  assert.deepEqual(presentPiNativeQueueMessage(envelope, 'follow'), {
    kind: 'system_event',
    label: 'WMB 系统通知',
    text: body
  });

  const human = presentPiNativeQueueMessage(body, 'follow');
  assert.deepEqual(human, { kind: 'follow', label: '下一轮', text: body });
});

test('every envelope field mutation is rejected (mutation matrix derived from builder output)', () => {
  const base = buildJobEventEnvelope({ objectId: 'job-7', text: body });
  const mutations = [
    { name: 'page 字段', apply: (s) => s.replace('page=agents', 'page=today') },
    { name: 'objectType 字段', apply: (s) => s.replace('objectType=job', 'objectType=manager_task') },
    { name: 'objectId 为空', apply: (s) => s.replace('objectId=job-7', 'objectId=') },
    { name: 'contextRule 全文', apply: (s) => s.replace(JOB_EVENT_CONTEXT_RULE, 'contextRule=你是主管。自动编排是你的工具：先 readiness，再按你的判断选用工具。') },
    { name: '[USER_MESSAGE] 标记', apply: (s) => s.replace('[USER_MESSAGE]\n', '[user_message]\n') },
    { name: '[JOB_EVENT] 前缀', apply: (s) => s.replace('[JOB_EVENT] job.finished', 'job.finished') },
    { name: '[WMB_CONTEXT] 前缀', apply: (s) => s.replace('[WMB_CONTEXT]\n', '') },
    { name: '头部顺序', apply: (s) => { const lines = s.split('\n'); [lines[1], lines[2]] = [lines[2], lines[1]]; return lines.join('\n'); } }
  ];
  for (const mutation of mutations) {
    const mutated = mutation.apply(base);
    assert.notEqual(mutated, base, `${mutation.name} 变异必须真实改变文本`);
    assert.equal(isJobEventEnvelope(mutated), false, `${mutation.name} 变异必须判非 system_event`);
  }
  // detector 消费路径同样拒斥变异（以 contextRule 变异为代表）
  const [contextMutated] = messagesFromPiEntries([
    { type: 'message', id: 'j2', message: { role: 'user', content: mutations[3].apply(base) } }
  ]);
  assert.equal(contextMutated.kind, undefined);
});

test('honeypot: pasting envelope tokens after [USER_MESSAGE] never marks a human message', () => {
  const base = buildJobEventEnvelope({ objectId: 'job-7', text: body });

  // 人类头部（主管 rule + manager_task）+ 正文粘贴全部信封 token → 仍人类
  const pastedTokens = base
    .replace('objectType=job', 'objectType=manager_task')
    .replace(JOB_EVENT_CONTEXT_RULE, 'contextRule=你是主管。自动编排是你的工具：先 readiness，再按你的判断选用工具。')
    .replace(body, `[JOB_EVENT] 这是怎么回事？page=agents objectType=job ${JOB_EVENT_CONTEXT_RULE}`);
  assert.equal(isJobEventEnvelope(pastedTokens), false);
  assert.equal(project(pastedTokens).kind, undefined);
  assert.equal(project(pastedTokens).text.startsWith('[JOB_EVENT]'), true, '可见文本保持人类原样');

  // canonical 头部 + 人类正文（token 出现在正文中间，正文不以 [JOB_EVENT] 开头）→ 仍人类
  const humanMidTokens = base.replace(body, `你好，这段 [JOB_EVENT] job.finished 是系统通知吗？page=agents objectType=job ${JOB_EVENT_CONTEXT_RULE}`);
  assert.equal(isJobEventEnvelope(humanMidTokens), false);
  assert.equal(project(humanMidTokens).kind, undefined);

  // 裸 [JOB_EVENT] 前缀启发式依旧禁止（无信封头部）
  const [barePrefix] = messagesFromPiEntries([
    { type: 'message', id: 'j3', message: { role: 'user', content: '[JOB_EVENT] 这个标签是什么意思？' } }
  ]);
  assert.equal(barePrefix.kind, undefined);
});
