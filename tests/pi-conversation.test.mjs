import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensurePiConversationLayout, readPiConversation, writePiConversation } from '../src/main/pi-conversation.ts';

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
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '在', status: 'stopped' }
      ]
    });
    assert.equal(saved.sessionId, 'session-1');
    const loaded = await readPiConversation(root);
    assert.equal(loaded.sessionId, 'session-1');
    assert.equal(loaded.sessionFile, layout.sessionFile);
    assert.deepEqual(loaded.messages.map(({ createdAt: _createdAt, ...message }) => message), [
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '在', status: 'stopped' }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
