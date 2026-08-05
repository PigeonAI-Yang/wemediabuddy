import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { messagesFromPiEntries } from '../src/main/pi-transcript-projection.ts';
import { piToolSummary } from '../src/shared/pi-message.ts';
import { coalescePiMessages, finishPiTool, isPiConversationNearBottom, nextPiConversationFollowing, piThinkingSummary, streamingToolSegment, updatePiMessageSegment } from '../src/renderer/pi-dock-utils.ts';

test('Pi stream snapshots replace their original segment across tool rows', () => {
  let message = updatePiMessageSegment({ role: 'assistant', text: '' }, { kind: 'thinking', text: '先', streamKey: '1:0:thinking' });
  message = updatePiMessageSegment(message, streamingToolSegment('read', 'call-1'));
  message = updatePiMessageSegment(message, { kind: 'thinking', text: '先判断', streamKey: '1:0:thinking' });
  assert.deepEqual(message.segments.map((segment) => `${segment.kind}:${segment.text}`), ['thinking:先判断', 'tool:read · 读取文件']);
  message = updatePiMessageSegment(message, { kind: 'thinking', text: '下一轮', streamKey: '2:0:thinking' });
  assert.equal(message.segments.length, 3);
});

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
  assert.match(css, /\.pi-message-segment\.text \{ color: #fff; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.pi-message-segment\.text \{ color: var\(--ink\); \}/);
});

test('Pi retry exposes a guarded pending action before awaiting native fork', async () => {
  const dock = await readFile(new URL('../src/renderer/pi-dock.tsx', import.meta.url), 'utf8');
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  assert.ok(dock.indexOf('setForkAction({ entryId, retry })') < dock.indexOf('await window.wmb.forkPiConversation(entryId)'));
  assert.match(dock, /if \(busy \|\| forkActionRef\.current\) return/);
  assert.match(dock, /finally \{\s*forkActionRef\.current = false; setForkAction\(null\)/);
  assert.match(transcript, /aria-busy=\{retryPending \|\| undefined\}/);
});

test('Pi streaming follows only while the reader remains near the bottom', async () => {
  assert.equal(isPiConversationNearBottom(752, 1200, 400), true);
  assert.equal(isPiConversationNearBottom(700, 1200, 400), false);
  assert.equal(nextPiConversationFollowing(true, false, false), true);
  assert.equal(nextPiConversationFollowing(true, true, false), false);
  assert.equal(nextPiConversationFollowing(false, false, true), true);
  const dock = await readFile(new URL('../src/renderer/pi-dock.tsx', import.meta.url), 'utf8');
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(dock, /node\.scrollTop = node\.scrollHeight/);
  assert.match(transcript, /useLayoutEffect\(\(\) =>/);
  assert.match(transcript, /nextPiConversationFollowing\(followingLatest\.current, userScrollIntent\.current, nearBottom\)/);
  assert.match(transcript, /scrollTo\(\{ top: node\.scrollHeight, behavior: 'smooth' \}\)/);
  assert.match(transcript, /latestLeaving \? ' leaving' : ''/);
  const css = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  assert.match(css, /button\.pi-jump-latest:not\(:disabled\):not\(\[aria-disabled="true"\]\):active \{ transform: translateX\(-50%\) translateY\(1px\) scale\(0\.98\); \}/);
  assert.match(transcript, />回到最新<\/button>/);
  assert.doesNotMatch(transcript, /pi-conversation-end-spacer/);
  assert.match(css, /\.pi-conversation \{[^\r\n]*padding: 16px;/);
  assert.match(css, /\.pi-conversation > \.pi-bubble-wrap:last-of-type \{ margin-bottom: 0; \}/);
});

test('Pi uses distinct WMB creature states for connecting and unfinished tools', async () => {
  const active = streamingToolSegment('wmb_get_workbench', 'call-live');
  assert.equal('output' in active, false);
  const [finished] = finishPiTool([{ role: 'assistant', text: '', status: 'streaming', segments: [active] }], 'call-live', { ok: true });
  assert.equal('output' in finished.segments[0], true);
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  const mark = await readFile(new URL('../src/renderer/wmb-brand-mark.tsx', import.meta.url), 'utf8');
  const dock = await readFile(new URL('../src/renderer/pi-dock.tsx', import.meta.url), 'utf8');
  assert.match(transcript, /const running = streaming && !\('output' in segment\)/);
  assert.match(transcript, /const completed = 'output' in segment/);
  assert.match(transcript, /WmbCreatureMark state=\{running \? 'working' : completed \? 'sleep' : 'idle'\}/);
  const foundation = await readFile(new URL('../src/renderer/styles-foundation.css', import.meta.url), 'utf8');
  assert.match(dock, /connecting=\{phase === 'starting'\}/);
  assert.match(dock, /if \(event\.type === 'running'\) \{ setPhase\('starting'\); setStatusText\('正在连接 Pi'\); return; \}/);
  assert.doesNotMatch(dock, /setStatusText\('正在思考'\)/);
  assert.match(transcript, /<WmbCreatureMark state=\{connecting \? 'connect' : 'working'\} className="pi-activity-mark"\/>/);
  assert.match(transcript, /className="pi-activity" role="status" aria-live="polite" aria-label=\{statusText\}/);
  assert.match(transcript, /\{!activityOnly && <div className="pi-bubble-meta">/);
  assert.doesNotMatch(transcript, /pi-activity-copy|Pi 正在继续处理/);
  assert.doesNotMatch(transcript, /<span className="pi-activity-mark"[^>]*><i \/><\/span>/);
  assert.match(foundation, /\.wmb-creature-mark\.is-working > \.wmb-creature-logo[^\r\n]*wmb-creature-work/);
  assert.match(foundation, /\.wmb-creature-mark\.is-working \.wmb-creature-pupil-track[^\r\n]*wmb-creature-work-eye/);
  assert.match(foundation, /\.wmb-creature-mark\.is-sleep \.wmb-creature-upper-lid[^\r\n]*translateY\(118px\)/);
  assert.match(foundation, /@keyframes wmb-creature-work \{[^\r\n]*translate\(-1\.2px,-\.3px\)[^\r\n]*translate\(1\.2px,-\.3px\)/);
  assert.match(foundation, /@keyframes wmb-creature-work-eye \{[^\r\n]*translateX\(-54px\)[^\r\n]*translateX\(62px\)/);
  assert.match(mark, /wmb-creature-work-fx/);
  assert.match(foundation, /\.wmb-creature-mark\.is-working \.wmb-creature-work-fx \{ display: block; \}/);
  assert.match(foundation, /wmb-creature-task-left 2\.4s/);
  assert.match(foundation, /wmb-creature-task-right 2\.4s/);
  assert.match(foundation, /wmb-creature-progress 2\.4s/);
  assert.match(foundation, /wmb-creature-connect 1\.8s cubic-bezier\(\.25,1,\.5,1\) infinite/);
  assert.match(foundation, /wmb-creature-connect-current 1\.8s linear infinite/);
  assert.match(mark, /wmb-creature-connect-current" viewBox="0 0 230 158"/);
  assert.match(foundation, /wmb-creature-settle-blink \.4s ease-out both/);
  assert.match(mark, /fillRule="evenodd"/);
  assert.match(mark, /wmb-creature-upper-lid" d="M180,-200 H570 V174 C485,242 285,242 180,174 Z"/);
  assert.match(mark, /clipPath=\{\`url\(#\$\{eyeClipId\}\)\`\}/);
  assert.doesNotMatch(foundation, /wmb-creature-wing/);
  assert.doesNotMatch(foundation, /wmb-creature-eye/);
  assert.match(foundation, /@keyframes wmb-creature-blink \{[^\r\n]*translateY\(-174px\)[^\r\n]*translateY\(172px\)/);
});

test('approved WMB walk asset keeps one continuous flexible body and phase-locked locomotion', async () => {
  const walk = await readFile(new URL('../docs/design/brand-motion/wmb-creature-walk.html', import.meta.url), 'utf8');
  assert.equal(walk.match(/<path class="white-shape"/g)?.length, 1);
  assert.doesNotMatch(walk, /walk-left-leg|walk-right-leg|<g class="leg/);
  assert.match(walk, /id="walkMorph" attributeName="d" dur="1\.4s"/);
  assert.match(walk, /phases=\[\[0,0,-4\],\[\.08,0,-4\]/);
  assert.match(walk, /bodyAnimation=creature\.animate/);
  assert.match(walk, /animation:blink 6\.7s/);
  assert.match(walk, /prefers-reduced-motion:reduce/);
  assert.match(walk, /embedMode\?28:72/);
  assert.match(walk, /body\.embed \.traveler/);
});

test('WMB brand motion library keeps the approved silhouette and complete action vocabulary', async () => {
  const library = await readFile(new URL('../docs/design/brand-motion/wmb-creature-motion-library.html', import.meta.url), 'utf8');
  const walk = await readFile(new URL('../docs/design/brand-motion/wmb-creature-walk.html', import.meta.url), 'utf8');
  const receipt = await readFile(new URL('../docs/design/brand-motion/README.md', import.meta.url), 'utf8');
  for (const action of ['blink', 'look', 'breathe', 'connect', 'work', 'settle', 'walk', 'scout', 'hop', 'sleep', 'discover', 'celebrate', 'recover']) {
    assert.match(library, new RegExp(`\\['${action}'`));
  }
  assert.equal(library.match(/<path class="white" fill-rule="evenodd"/g)?.length, 1);
  assert.match(library, /M0,1 L211,510 L216,509 L246,455/);
  assert.match(library, /src="wmb-creature-walk\.html\?embed=1"/);
  assert.match(library, /animation:blink calc\(6\.7s \* var\(--speed\)\)/);
  assert.match(library, /scale\(1\.075,\.92\)/);
  assert.match(library, /fx-electric/);
  assert.match(library, /work-progress/);
  assert.match(library, /translate\(24px,-8px\)/);
  assert.match(library, /sleep-z/);
  assert.match(library, /@keyframes celebrate\{[^\r\n]*rotate\(-10deg\)[^\r\n]*rotate\(10deg\)/);
  assert.match(library, /@keyframes cheer-ray\{[^\r\n]*translateY\(-22px\)[^\r\n]*translateY\(-78px\)/);
  assert.match(library, /@keyframes scout\{[^\r\n]*translate\(-25px,-18px\)[^\r\n]*translate\(25px,-18px\)/);
  assert.match(library, /@keyframes scout-eye\{[^\r\n]*translateX\(-92px\)[^\r\n]*translateX\(92px\)/);
  assert.match(library, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(library, /walk-left-leg|walk-right-leg|class="leg/);
  const libraryHash = createHash('sha256').update(library).digest('hex').toUpperCase();
  const walkHash = createHash('sha256').update(walk).digest('hex').toUpperCase();
  assert.match(receipt, new RegExp(libraryHash));
  assert.match(receipt, new RegExp(walkHash));
});

test('Pi conversation archive stays in the session menu and cannot interrupt an active turn', async () => {
  const header = await readFile(new URL('../src/renderer/pi-dock-header.tsx', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(header, /已归档会话/);
  assert.match(header, /归档会话/);
  assert.match(header, /恢复会话/);
  assert.match(header, /className="pi-session-more"/);
  assert.match(main, /ipcMain\.handle\('pi:conversation-archive'/);
  assert.match(main, /const worker = currentPi\(\); if \(archived && worker\?\.isActive\)/);
});
