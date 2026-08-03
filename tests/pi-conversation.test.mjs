import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createForkedPiConversation, ensurePiConversationLayout, readPiConversation, writePiConversation } from '../src/main/pi-conversation.ts';

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
