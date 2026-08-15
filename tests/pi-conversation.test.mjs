import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createForkedPiConversation, ensurePiConversationLayout, listPiConversations, readPiConversation, setPiConversationArchived, startNewPiConversation, switchPiConversation, writePiConversation } from '../src/main/pi-conversation.ts';
import { buildJobEventEnvelope } from '../src/shared/job-event-envelope.ts';

test('Pi conversation snapshot round-trips session identity and messages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-'));
  try {
    const layout = await ensurePiConversationLayout(root);
    assert.equal(layout.sessionFile.endsWith(`${path.sep}sessions${path.sep}dock.jsonl`), true);
    const empty = await readPiConversation(root);
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.sessionFile.endsWith(`${path.sep}sessions${path.sep}${empty.id}.jsonl`), true);

    const saved = await writePiConversation(root, {
      sessionFile: layout.sessionFile,
      sessionId: 'session-1',
      messages: [
        { role: 'user', text: '你好', entryId: 'u1' },
        { role: 'assistant', text: '在', status: 'stopped' }
      ]
    });
    assert.equal(saved.sessionId, 'session-1');
    const loaded = await readPiConversation(root);
    assert.equal(loaded.sessionId, 'session-1');
    assert.equal(loaded.sessionFile, layout.sessionFile);
    assert.deepEqual(loaded.messages.map(({ createdAt: _createdAt, ...message }) => message), [
      { role: 'user', text: '你好', entryId: 'u1' },
      { role: 'assistant', text: '在', status: 'stopped' }
    ]);
    await writeFile(layout.sessionFile, [
      { type: 'message', id: 'u1', message: { role: 'user', content: '你好' } },
      { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '先想' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'pwd' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '/tmp' }] } },
      { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: '在' }] } }
    ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
    const projected = await readPiConversation(root);
    assert.deepEqual(projected.messages[1].segments.map((segment) => segment.kind), ['thinking', 'tool', 'text']);
    assert.equal(projected.messages[1].segments[1].output.includes('/tmp'), true);
    const forked = await createForkedPiConversation(root, {
      sessionFile: path.join(root, 'pi-agent', 'sessions', 'fork.jsonl'),
      sessionId: 'fork-1',
      messages: [{ role: 'user', text: '分叉后的消息', entryId: 'u2' }]
    });
    assert.notEqual(forked.id, loaded.id);
    assert.equal((await readPiConversation(root)).id, forked.id);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi conversation cold read prefers newer canonical session entries over a stale segmented snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-stale-'));
  try {
    const active = await readPiConversation(root);
    await writePiConversation(root, {
      id: active.id,
      sessionFile: active.sessionFile,
      messages: [
        { role: 'user', text: '旧问题', entryId: 'u1' },
        { role: 'assistant', text: '旧回答', entryId: 'a1', segments: [{ kind: 'text', text: '旧回答' }] }
      ]
    });
    await writeFile(active.sessionFile, [
      { type: 'message', id: 'u1', timestamp: '2026-08-03T10:00:00.000Z', message: { role: 'user', content: '旧问题' } },
      { type: 'message', id: 'a1', timestamp: '2026-08-03T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] } },
      { type: 'message', id: 'u2', timestamp: '2026-08-03T10:01:00.000Z', message: { role: 'user', content: '重启前的新问题' } },
      { type: 'message', id: 'a2', timestamp: '2026-08-03T10:01:01.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '已开始处理' }, { type: 'text', text: '中断前可见回复' }] } }
    ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');

    const reopened = await readPiConversation(root);
    assert.equal(reopened.messages.at(-2).text, '重启前的新问题');
    assert.equal(reopened.messages.at(-1).text, '中断前可见回复');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi conversation preserves a live turn on ordinary reads and recovers it at runtime start', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-pending-'));
  try {
    const active = await readPiConversation(root);
    await writeFile(active.sessionFile, [
      { type: 'message', id: 'u1', message: { role: 'user', content: '上一条问题' } },
      { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '上一条回答' }] } }
    ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
    await writePiConversation(root, {
      id: active.id,
      sessionFile: active.sessionFile,
      messages: [
        { role: 'user', text: '上一条问题' },
        { role: 'assistant', text: '上一条回答' },
        { role: 'user', text: '刚提交的问题' },
        { role: 'assistant', text: '', status: 'streaming' }
      ]
    });

    const liveRead = await readPiConversation(root);
    assert.equal(liveRead.messages.at(-2).text, '刚提交的问题');
    assert.equal(liveRead.messages.at(-1).status, 'streaming');

    const relaunched = await readPiConversation(root, { recoverInterrupted: true });
    assert.equal(relaunched.messages.at(-2).text, '刚提交的问题');
    assert.equal(relaunched.messages.at(-1).text, '生成被中断。');
    assert.equal(relaunched.messages.at(-1).status, 'stopped');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('native Skill-wrapped transcript repairs a stale streaming snapshot on reload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-skill-recovery-'));
  try {
    const initial = await readPiConversation(root);
    const visible = '刚刚那一篇叫写手重新写';
    const wrapped = `[WMB_CONTEXT]\npage=agents\nobjectType=manager_task\n[USER_MESSAGE]\n${visible}`;
    const nativeUser = `<skill name="evidence-grounded-writer">内部 Skill 规则 [USER_MESSAGE] 不属于正文</skill>\n\n[USER_MESSAGE]\n${wrapped}`;
    const oldVisible = '这篇写完整';
    const oldLeaked = `objectTitle=旧项目\nmanagerRole=desk\n[USER_MESSAGE]\n${oldVisible}`;
    const oldWrapped = `[WMB_CONTEXT]\npage=studio\nobjectTitle=旧项目\nmanagerRole=desk\n[USER_MESSAGE]\n${oldVisible}`;
    const oldNativeUser = `<skill name="evidence-grounded-writer">内部 Skill 规则</skill>\n\n[USER_MESSAGE]\n${oldWrapped}`;
    const saved = await writePiConversation(root, {
      id: initial.id,
      sessionFile: initial.sessionFile,
      messages: [
        { role: 'user', text: oldLeaked, createdAt: '2026-08-11T11:59:58.000Z' },
        { role: 'assistant', text: '旧回复', segments: [{ kind: 'text', text: '旧回复' }], createdAt: '2026-08-11T11:59:59.000Z' },
        { role: 'user', text: visible, createdAt: '2026-08-11T12:00:00.000Z' },
        { role: 'assistant', text: '', thinking: '已经确认需求', segments: [{ kind: 'thinking', text: '已经确认需求' }], status: 'streaming', createdAt: '2026-08-11T12:00:01.000Z' }
      ]
    });
    const entries = [
      { type: 'message', id: 'u-old', timestamp: '2026-08-11T11:59:58.000Z', message: { role: 'user', content: [{ type: 'text', text: oldNativeUser }] } },
      { type: 'message', id: 'a-old', timestamp: '2026-08-11T11:59:59.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '旧回复' }] }, stopReason: 'stop' },
      { type: 'message', id: 'u-final', timestamp: '2026-08-11T12:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: nativeUser }] } },
      { type: 'message', id: 'a-final', timestamp: '2026-08-11T12:00:01.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '已经确认需求' }, { type: 'text', text: '已派给写手重新创作。' }] }, stopReason: 'stop' }
    ];
    await writeFile(saved.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

    const recovered = await readPiConversation(root);
    assert.equal(recovered.messages.at(-2).text, visible, 'Skill 原生包裹不得破坏用户输入对账');
    assert.equal(recovered.messages.at(-1).text, '已派给写手重新创作。');
    assert.equal(recovered.messages.at(-1).status, undefined, '完整原生终态不得再显示为 streaming');
    assert.deepEqual(recovered.messages.at(-1).segments.map((segment) => segment.kind), ['thinking', 'text']);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi conversation archive hides without rewriting files and restores', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-archive-'));
  try {
    const first = await readPiConversation(root);
    const second = await startNewPiConversation(root);
    const conversationPath = path.join(root, 'pi-agent', 'conversations', `${second.id}.json`);
    const beforeConversation = await readFile(conversationPath, 'utf8');
    const beforeSession = await readFile(second.sessionFile, 'utf8');
    const selected = await setPiConversationArchived(root, second.id, true);
    assert.equal(selected.id, first.id);
    const archived = await listPiConversations(root);
    assert.equal(archived.find((item) => item.id === second.id)?.archivedAt !== null, true);
    assert.equal(archived.find((item) => item.id === first.id)?.active, true);
    assert.equal(await readFile(conversationPath, 'utf8'), beforeConversation);
    assert.equal(await readFile(second.sessionFile, 'utf8'), beforeSession);
    await assert.rejects(() => switchPiConversation(root, second.id), /恢复已归档会话/);
    await setPiConversationArchived(root, second.id, false);
    assert.equal((await listPiConversations(root)).find((item) => item.id === second.id)?.archivedAt, null);
    assert.equal((await switchPiConversation(root, second.id)).id, second.id);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('legacy conversation pointer remains byte-identical through migration and canonical operations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-legacy-pointer-'));
  try {
    const agentRoot = path.join(root, 'pi-agent');
    await mkdir(agentRoot, { recursive: true });
    const legacySession = path.join(agentRoot, 'session.jsonl');
    const legacySessionBytes = '{"type":"session","version":3,"id":"legacy-session","timestamp":"2026-08-06T00:00:00.000Z"}\n{"type":"message","id":"legacy-user","parentId":null,"timestamp":"2026-08-06T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"旧消息"}]}}\n';
    await writeFile(legacySession, legacySessionBytes, 'utf8');
    const legacyPointer = JSON.stringify({
      id: 'legacy-conversation',
      title: '旧会话',
      sessionFile: legacySession,
      sessionId: 'legacy-session',
      messages: [{ role: 'user', text: '旧消息' }],
      updatedAt: '2026-08-06T00:00:00.000Z'
    }, null, 2);
    const pointerPath = path.join(agentRoot, 'conversation.json');
    await writeFile(pointerPath, legacyPointer, 'utf8');

    const migrated = await readPiConversation(root);
    assert.equal(migrated.id, 'legacy-conversation');
    assert.equal(await readFile(pointerPath, 'utf8'), legacyPointer);
    assert.equal(await readFile(legacySession, 'utf8'), legacySessionBytes);
    assert.notEqual(path.resolve(migrated.sessionFile), path.resolve(legacySession));
    assert.equal(await readFile(migrated.sessionFile, 'utf8'), legacySessionBytes);
    await writePiConversation(root, {
      id: migrated.id,
      sessionFile: migrated.sessionFile,
      messages: [{ role: 'user', text: '更新后的消息' }]
    });
    const created = await startNewPiConversation(root);
    await switchPiConversation(root, migrated.id);
    assert.equal((await readPiConversation(root)).id, migrated.id);
    assert.notEqual(created.id, migrated.id);
    assert.equal(await readFile(pointerPath, 'utf8'), legacyPointer);
    assert.equal(await readFile(legacySession, 'utf8'), legacySessionBytes);
    assert.equal(await readFile(migrated.sessionFile, 'utf8'), legacySessionBytes);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
test('legacy migration never overwrites an existing canonical session target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-legacy-no-clobber-'));
  try {
    const agentRoot = path.join(root, 'pi-agent');
    const sessionsRoot = path.join(agentRoot, 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    const legacySession = path.join(agentRoot, 'session.jsonl');
    const canonicalSession = path.join(sessionsRoot, 'legacy-existing.jsonl');
    const legacyBytes = '{"type":"session","version":3,"id":"legacy-source"}\n';
    const canonicalBytes = '{"type":"session","version":3,"id":"canonical-existing"}\n';
    await writeFile(legacySession, legacyBytes, 'utf8');
    await writeFile(canonicalSession, canonicalBytes, 'utf8');
    const pointer = JSON.stringify({
      id: 'legacy-existing',
      title: '已存在 canonical target',
      sessionFile: legacySession,
      sessionId: 'legacy-source',
      messages: [{ role: 'user', text: '保留 pointer 结构' }],
      updatedAt: '2026-08-06T00:00:00.000Z'
    }, null, 2);
    const pointerPath = path.join(agentRoot, 'conversation.json');
    await writeFile(pointerPath, pointer, 'utf8');

    const migrated = await readPiConversation(root);
    assert.equal(migrated.id, 'legacy-existing');
    assert.equal(migrated.sessionFile, canonicalSession);
    assert.equal(await readFile(pointerPath, 'utf8'), pointer);
    assert.equal(await readFile(legacySession, 'utf8'), legacyBytes);
    assert.equal(await readFile(canonicalSession, 'utf8'), canonicalBytes);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});


test('fresh canonical conversation roots never create a legacy pointer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-canonical-only-'));
  try {
    const first = await startNewPiConversation(root);
    const written = await writePiConversation(root, {
      id: first.id,
      sessionFile: first.sessionFile,
      messages: [{ role: 'user', text: '首条消息' }]
    });
    const second = await startNewPiConversation(root);
    await switchPiConversation(root, written.id);
    assert.equal((await readPiConversation(root)).id, written.id);
    await assert.rejects(() => readFile(path.join(root, 'pi-agent', 'conversation.json'), 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(root, 'pi-agent', 'conversations', `${written.id}.json`), 'utf8').then(Boolean), true);
    assert.equal(await readFile(path.join(root, 'pi-agent', 'conversations', `${second.id}.json`), 'utf8').then(Boolean), true);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi conversation projects a generated WMB JOB_EVENT prompt as system_event without touching raw session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-job-event-'));
  try {
    const active = await readPiConversation(root);
    const envelope = buildJobEventEnvelope({
      objectId: 'job-1',
      text: '[JOB_EVENT] job.finished\njobId=job-1\nrole=writer\nstatus=succeeded'
    });
    const sessionBytes = [
      { type: 'message', id: 'j1', timestamp: '2026-08-10T10:00:00.000Z', message: { role: 'user', content: envelope } }
    ].map((entry) => JSON.stringify(entry)).join('\n');
    await writeFile(active.sessionFile, sessionBytes, 'utf8');
    const bytesBefore = await readFile(active.sessionFile, 'utf8');

    const projected = await readPiConversation(root);
    assert.equal(projected.messages.length, 1);
    assert.equal(projected.messages[0].role, 'user');
    assert.equal(projected.messages[0].kind, 'system_event');
    assert.equal(projected.messages[0].text.startsWith('[JOB_EVENT] job.finished'), true);
    assert.equal(projected.messages[0].text.includes('[WMB_CONTEXT]'), false);
    assert.equal(await readFile(active.sessionFile, 'utf8'), bytesBefore, 'raw Pi session bytes must stay byte-for-byte identical');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi conversation keeps an ordinary human WMB_CONTEXT prompt kind absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-human-prompt-'));
  try {
    const active = await readPiConversation(root);
    const humanWrapped = [
      '[WMB_CONTEXT]',
      'page=agents',
      'pageLabel=班组',
      'objectType=manager_task',
      'objectId=',
      'contextRule=你是主管。自动编排是你的工具：scan/judge/full 用 wmb_run_daily_stage；先 readiness，再按你的判断选用工具；用 list_jobs/roster 监工并汇报。',
      '[USER_MESSAGE]',
      '帮我检查今天的任务'
    ].join('\n');
    await writeFile(active.sessionFile, [
      { type: 'message', id: 'u1', timestamp: '2026-08-10T10:01:00.000Z', message: { role: 'user', content: humanWrapped } }
    ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');

    const projected = await readPiConversation(root);
    assert.equal(projected.messages.length, 1);
    assert.equal(projected.messages[0].role, 'user');
    assert.equal(projected.messages[0].kind, undefined);
    assert.equal(projected.messages[0].text, '帮我检查今天的任务');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi conversation persists an offline system_event notification with kind', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-offline-event-'));
  try {
    const active = await readPiConversation(root);
    const createdAt = '2026-08-10T10:02:00.000Z';
    await writePiConversation(root, {
      id: active.id,
      sessionFile: active.sessionFile,
      messages: [
        { role: 'user', text: '[JOB_EVENT] job.finished\njobId=job-1\nstatus=succeeded', createdAt, kind: 'system_event' },
        { role: 'assistant', text: '（系统）员工工单已有终态。打开对话后我会据此汇报；也可让我立即验收。', createdAt, segments: [{ kind: 'text', text: '（系统）员工工单已有终态。打开对话后我会据此汇报；也可让我立即验收。' }] }
      ]
    });

    const loaded = await readPiConversation(root);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0].role, 'user');
    assert.equal(loaded.messages[0].kind, 'system_event');
    assert.equal(loaded.messages[0].text.startsWith('[JOB_EVENT] job.finished'), true);
    assert.equal('kind' in loaded.messages[1], false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('legacy kindless offline snapshot stays kindless and byte-identical through read and round-trip', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-legacy-kindless-'));
  try {
    const conversationsRoot = path.join(root, 'pi-agent', 'conversations');
    await mkdir(conversationsRoot, { recursive: true });
    const id = 'legacy-offline';
    // 遗留离线快照：可见 [JOB_EVENT] 文本、无 kind，sessionFile 指向不存在的 raw session（无可用的投影源）
    const legacySession = path.join(root, 'pi-agent', 'sessions', `${id}.jsonl`);
    const visibleText = '[JOB_EVENT] job.finished\njobId=job-1\nrole=writer\nstatus=succeeded';
    const snapshot = {
      id,
      title: '遗留工单通知',
      sessionFile: legacySession,
      sessionId: null,
      messages: [{ role: 'user', text: visibleText }],
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z'
    };
    const snapshotBytes = JSON.stringify(snapshot, null, 2);
    const conversationPath = path.join(conversationsRoot, `${id}.json`);
    await writeFile(conversationPath, snapshotBytes, 'utf8');
    await writeFile(path.join(conversationsRoot, 'index.json'), JSON.stringify({
      activeId: id,
      conversations: [{
        id,
        title: snapshot.title,
        preview: visibleText,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        archivedAt: null
      }]
    }, null, 2), 'utf8');

    // 读取后保持 kindless：绝不依据可见 [JOB_EVENT] 文本推断 provenance
    const loaded = await readPiConversation(root);
    assert.equal(loaded.id, id);
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].role, 'user');
    assert.equal('kind' in loaded.messages[0], false);
    assert.equal(loaded.messages[0].kind, undefined);
    assert.equal(loaded.messages[0].text, visibleText, 'visible text must round-trip byte-for-byte');
    // 读入不改写存储快照字节
    assert.equal(await readFile(conversationPath, 'utf8'), snapshotBytes, 'reading must not mutate the stored conversation bytes');

    // 读入→写出后文本逐字节一致，且不隐式回填 kind
    const roundTripped = await writePiConversation(root, { id, sessionFile: legacySession, messages: loaded.messages });
    assert.equal(roundTripped.messages.length, 1);
    assert.equal('kind' in roundTripped.messages[0], false);
    assert.equal(roundTripped.messages[0].text, visibleText);
    const afterRoundTrip = await readPiConversation(root);
    assert.equal(afterRoundTrip.messages[0].text, visibleText);
    assert.equal('kind' in afterRoundTrip.messages[0], false);
    const storedBytes = await readFile(conversationPath, 'utf8');
    assert.doesNotMatch(storedBytes, /"kind"/, 'no implicit kind backfill may be written');
    assert.equal(JSON.parse(storedBytes).messages[0].text, visibleText, 'stored message text must stay byte-identical');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
