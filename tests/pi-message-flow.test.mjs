import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { messagesFromPiEntries } from '../src/main/pi-transcript-projection.ts';
import { piToolSummary } from '../src/shared/pi-message.ts';
import { coalescePiMessages, piThinkingSummary } from '../src/renderer/pi-dock-utils.ts';

test('Pi transcript preserves visible order and keeps tool details behind one summary', () => {
  const messages = messagesFromPiEntries([
    { type: 'message', id: 'u1', message: { role: 'user', content: '请检查' } },
    { type: 'message', id: 'a1', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '先判断' },
      { type: 'text', text: '我先检查。' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'rg -n TODO src' } }
    ] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'src/a.ts:1' }] } },
    { type: 'message', id: 'a2', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '结果足够' },
      { type: 'text', text: '检查完成。' }
    ] } }
  ]);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].segments.map((segment) => segment.kind), ['thinking', 'text', 'tool', 'thinking', 'text']);
  assert.equal(messages[1].segments[2].text, 'bash · rg -n TODO src');
  assert.match(messages[1].segments[2].input, /"command"/);
  assert.match(messages[1].segments[2].output, /src\/a\.ts:1/);
  assert.equal(messages[1].text, '我先检查。检查完成。');
  assert.equal(piToolSummary('wmb_get_workbench'), 'wmb_get_workbench · 读取工作台');
});

test('legacy consecutive assistant entries render as one chronological turn', () => {
  const messages = coalescePiMessages([
    { role: 'user', text: '问' },
    { role: 'assistant', text: '先说', thinking: '先想' },
    { role: 'assistant', text: '再说', thinking: '再想' }
  ]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].segments.map((segment) => `${segment.kind}:${segment.text}`), [
    'thinking:先想', 'text:先说', 'thinking:再想', 'text:再说'
  ]);
});

test('closed tool rows hide raw details', async () => {
  const css = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  assert.match(css, /\.pi-tool-line:not\(\[open\]\) > \.pi-tool-detail \{ display: none; \}/);
});

test('completed thinking uses a compact truthful summary without semantic deletion', async () => {
  assert.equal(piThinkingSummary('  先检查   资料，再判断。  '), '思考 · 先检查 资料，再判断。');
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  assert.match(transcript, /streaming \? segments\.map\(\(segment\) => segment\.kind\)\.lastIndexOf\('thinking'\)/);
  assert.match(transcript, /<details className="pi-thinking-line"/);
  assert.match(css, /\.pi-thinking-line:not\(\[open\]\) > \.pi-thinking-detail \{ display: none; \}/);
});
