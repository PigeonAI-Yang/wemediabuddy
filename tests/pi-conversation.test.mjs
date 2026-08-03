import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createForkedPiConversation, ensurePiConversationLayout, listPiConversations, readPiConversation, setPiConversationArchived, startNewPiConversation, switchPiConversation, writePiConversation } from '../src/main/pi-conversation.ts';

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

test('Pi conversation cold read preserves a submitted turn when Pi never commits it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-conversation-pending-'));
  try {
    const active = await readPiConversation(root);
    await writePiConversation(root, {
      id: active.id,
      sessionFile: active.sessionFile,
      messages: [{ role: 'user', text: '刚提交的问题' }, { role: 'assistant', text: '', status: 'streaming' }]
    });
    const reopened = await readPiConversation(root);
    assert.equal(reopened.messages[0].text, '刚提交的问题');
    assert.equal(reopened.messages[1].text, '生成被中断。');
    assert.equal(reopened.messages[1].status, 'stopped');
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
