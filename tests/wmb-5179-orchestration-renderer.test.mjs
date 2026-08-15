import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { isPiOrchestration, piRetryable } from '../src/renderer/pi-dock-utils.ts';
import { buildOrchestrationEnvelope } from '../src/shared/orchestration-envelope.ts';
import { messagesFromPiEntries } from '../src/main/pi-transcript-projection.ts';

const dispatchId = 'dispatch-1';
const safe = {
  originLabel: '今日情报',
  title: '今日情报编排',
  goal: '采集并判读当日情报，产出可批方案',
  acceptance: '可信渠道回执 + 当日可批方案'
};
const acceptedData = { dispatchId, target: 'dock', delivery: 'direct', state: 'accepted', safe };
const failedData = { dispatchId, target: 'dock', delivery: 'direct', state: 'failed', safe, error: '渠道请求超时，未收到可信回执。' };
const createdAt = '2026-08-10T10:00:00.000Z';

test('isPiOrchestration follows kind as the sole presentation authority (no visible-text heuristic)', () => {
  assert.equal(isPiOrchestration({ role: 'user', kind: 'orchestration', orchestration: acceptedData, entryId: 'e1' }), true);
  assert.equal(isPiOrchestration({ role: 'user', kind: 'orchestration', orchestration: failedData, entryId: 'e2' }), true);
  assert.equal(isPiOrchestration({ role: 'user', kind: 'orchestration' }), true, 'kind 是唯一呈现权威，与数据存在性无关');
  assert.equal(isPiOrchestration({ role: 'user', kind: 'system_event', text: '工单终态', entryId: 'j1' }), false, '与 system_event 归类互斥');
  assert.equal(isPiOrchestration({ role: 'user', text: '[WMB_CONTEXT]\npage=pi\nobjectType=orchestration\n[USER_MESSAGE]\n任务', entryId: 'u1' }), false, '无 kind 的 lookalike 文本（honeypot）不得打标');
  assert.equal(isPiOrchestration({ role: 'user', text: '你好', entryId: 'u2' }), false, '普通人类消息不打标');
  assert.equal(isPiOrchestration({ role: 'assistant', text: '在' }), false);
});

test('piRetryable excludes orchestration rows regardless of entryId (reviewer finding regression)', () => {
  assert.equal(piRetryable({ role: 'user', kind: 'orchestration', orchestration: acceptedData, entryId: 'raw-orch-1' }), false, '带 entryId 的直接接受行不是锚点');
  assert.equal(piRetryable({ role: 'user', kind: 'orchestration', orchestration: failedData, entryId: 'raw-orch-2' }), false, '带 entryId 的失败行不是锚点');
  assert.equal(piRetryable({ role: 'user', kind: 'orchestration', orchestration: { ...acceptedData, delivery: 'steer' }, entryId: 'raw-orch-3' }), false, 'steer 队列行不是锚点');
  assert.equal(piRetryable({ role: 'user', kind: 'orchestration', orchestration: acceptedData }), false, '无 entryId 同样排除');
  assert.equal(piRetryable({ role: 'user', kind: 'orchestration', entryId: 'e' }), false, 'kind 即排除，与数据完整性无关');
  // 既有语义不变：人类消息仍是锚点，system_event / assistant 仍不是
  assert.equal(piRetryable({ role: 'user', text: '你好', entryId: 'u1' }), true);
  assert.equal(piRetryable({ role: 'user', kind: 'system_event', text: '工单终态', entryId: 'j1' }), false);
  assert.equal(piRetryable({ role: 'assistant', text: '在', entryId: 'a1' }), false);
});

test('orchestration never becomes the retry anchor for later assistant turns', () => {
  // 复刻 pi-dock-transcript.tsx 的锚点推导：仅 piRetryable 消息设置 retryEntryId
  const messages = [
    { role: 'user', kind: 'orchestration', orchestration: acceptedData, entryId: 'raw-orch-1', createdAt },
    { role: 'assistant', text: '收到', entryId: 'a1', createdAt }
  ];
  let retryEntryId;
  for (const message of messages) {
    if (piRetryable(message)) retryEntryId = message.entryId;
  }
  assert.equal(retryEntryId, undefined, 'orchestration 行不得成为后续 assistant 回合的 retry 锚点');

  const humanFirst = [
    { role: 'user', text: '你好', entryId: 'u1', createdAt },
    { role: 'assistant', text: '收到', entryId: 'a1', createdAt }
  ];
  let anchor;
  for (const message of humanFirst) {
    if (piRetryable(message)) anchor = message.entryId;
  }
  assert.equal(anchor, 'u1', '人类消息的 fork/retry 语义保持不变');
});

test('renderer input contract: orchestration rows carry kind + valid data + safe title only', () => {
  const envelope = buildOrchestrationEnvelope({ dispatchId, target: 'dock', delivery: 'direct', safe, prompt: '请执行今日情报编排并写入当日方案' });
  const [row] = messagesFromPiEntries([
    { type: 'message', id: 'e-orch-1', timestamp: createdAt, message: { role: 'user', content: envelope } }
  ]);
  assert.equal(isPiOrchestration(row), true);
  assert.equal(row.role, 'user');
  assert.equal(row.orchestration.state, 'accepted');
  assert.equal(row.text, safe.title, '可见文本仅安全标题');
  assert.equal(row.text.includes('请执行今日情报编排并写入当日方案'), false, 'raw prompt 不进入渲染输入');
  assert.equal(row.text.includes('[WMB_CONTEXT]'), false);
});

test('transcript routes orchestration before assistant/user catch-all with no actions or aria-live', async () => {
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  const rowStart = transcript.indexOf('function PiOrchestrationRow');
  const dockExport = transcript.indexOf('export function PiDockTranscript');
  assert.ok(rowStart >= 0 && dockExport > rowStart, 'PiOrchestrationRow 组件存在');
  const rowBlock = transcript.slice(rowStart, dockExport);

  // 第四分支在 assistant/user catch-all 之前；锚点推导仍走 piRetryable
  assert.match(transcript, /const isOrchestration = isPiOrchestration\(message\);/);
  assert.ok(transcript.indexOf('? <PiOrchestrationRow key={messageKey} message={message} />') < transcript.indexOf(': message.role === '), 'orchestration 分支先于 assistant/user catch-all');
  assert.match(transcript, /if \(piRetryable\(message\)\) retryEntryId = message\.entryId;/);

  // 展开内容仅四个安全字段；禁止内部 token 进入 DOM
  for (const field of ['data.safe.originLabel', 'data.safe.title', 'data.safe.goal', 'data.safe.acceptance']) {
    assert.match(rowBlock, new RegExp(field), `${field} 进入展开内容`);
  }
  for (const token of ['WMB_CONTEXT', 'dispatchId', 'managerTaskId', 'objectId', 'sessionId', 'contextRule', 'wmb_', 'prompt', 'message.text']) {
    assert.doesNotMatch(rowBlock, new RegExp(token), `${token} 不得进入 orchestration 行 DOM`);
  }

  // 独立任务卡：正式可播放动画资产 + 状态/时间 + 标题；失败错误在 details 之前
  assert.match(rowBlock, /<article className=\{`pi-orchestration-wrap \$\{visualState\}`\} data-state=\{visualState\} aria-label=\{`编排任务：\$\{status\}，\$\{data\.safe\.title\}`\}>/);
  assert.match(rowBlock, /<div className="pi-orchestration-mascot">\s*<WmbCreatureMotionAsset action=\{motionAction\} className="pi-orchestration-motion"\/>\s*<\/div>/);
  assert.doesNotMatch(rowBlock, /WmbCreatureMark|pi-orchestration-mark/, '任务卡不得把 UI Logo 组件塞进去冒充动画资产');
  assert.match(rowBlock, /<header className="pi-orchestration-head">\s*<span className="pi-orchestration-status">\{status\}<\/span>\s*<time className="pi-orchestration-time">\{formatPiMessageTime\(message\.createdAt\)\}<\/time>\s*<\/header>\s*<strong className="pi-orchestration-title">\{data\.safe\.title\}<\/strong>/);
  assert.ok(rowBlock.indexOf('pi-orchestration-error') < rowBlock.indexOf('pi-orchestration-details'), '安排失败错误行在展开控件之前');
  assert.doesNotMatch(rowBlock, /pi-bubble|pi-bubble-meta/, '编排任务卡不得冒充用户或 Pi 对话气泡');

  // 交互仅原生 details/summary：无按钮/动作/aria-live；全局 aria-live 数量不增
  assert.match(rowBlock, /<details className="pi-orchestration-details">\s*<summary>查看任务要求<\/summary>/);
  assert.doesNotMatch(rowBlock, /aria-live|<button|pi-bubble-actions|onCopy|onFork|onRetry|role="status"/);
  assert.equal(transcript.match(/aria-live/g)?.length ?? 0, 2, 'aria-live 仅 pi-activity 与 pi-native-queue 两处，orchestration 不加');
  assert.match(transcript, /return isOrchestration\s*\? <PiOrchestrationRow key=\{messageKey\} message=\{message\} \/>\s*: \(\s*<div className=\{`pi-bubble-wrap/, 'orchestration 真分支只渲染该组件，并在普通角色分支之前返回');
  assert.match(transcript, /\{!activityOnly && <div className="pi-bubble-meta">/);
});

test('three-state copy is exhaustive with no fourth default', async () => {
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  const helperStart = transcript.indexOf('function orchestrationStatusLabel');
  const helperEnd = transcript.indexOf('function PiOrchestrationRow');
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = transcript.slice(helperStart, helperEnd);
  assert.match(helper, /已安排主管/);
  assert.match(helper, /已加入主管队列/);
  assert.match(helper, /安排失败/);
  assert.doesNotMatch(helper, /已完成|进行中|待处理/);
});

test('orchestration embeds the Owner-approved executable motion asset instead of the UI Logo component', async () => {
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  const rowBlock = transcript.slice(transcript.indexOf('function PiOrchestrationRow'), transcript.indexOf('export function PiDockTranscript'));
  assert.match(rowBlock, /const motionAction: WmbCreatureMotionAction = visualState === 'failed' \? 'sleep' : visualState === 'pending' \? 'connect' : 'settle';/);
  assert.match(rowBlock, /<WmbCreatureMotionAsset action=\{motionAction\} className="pi-orchestration-motion"\/>/);
  assert.doesNotMatch(rowBlock, /WmbCreatureMark/, '任务卡不复用静态 UI Logo 组件');

  const bridge = await readFile(new URL('../src/renderer/wmb-creature-motion-asset.tsx', import.meta.url), 'utf8');
  assert.match(bridge, /wmb-creature-motion-library\.html\?url/, '直接加载冻结动作图鉴资产');
  assert.match(bridge, /\.card\[data-action="\$\{action\}"\]/, '从动作图鉴选择真实状态场景');
  assert.match(bridge, /doc\.body\.replaceChildren\(card\)/, '产品表面只保留选中动作场景');
  assert.doesNotMatch(bridge, /WmbCreatureMark|wmb-brand-mark/, '动画资产桥接不得回退到 UI Logo 组件');
  assert.match(bridge, /body\{display:grid;place-items:center\}/, 'iframe 底框建立双轴中心基准');
  assert.match(bridge, /\.card\{[^}]*left:calc\(50% - 115px\)[^}]*top:calc\(50% - 79px\)[^}]*transform:scale\(\.4\)[^}]*transform-origin:center/, '先按未缩放 230×158 场景定位中心，再围绕自身中心缩放');
  assert.match(bridge, /\.stage\{[^}]*padding:0[^}]*place-items:center[^}]*transform:translateY\(-16\.5px\)/, '清除图鉴底部站立基线，并以原始舞台坐标补偿角色视觉中心');
  assert.doesNotMatch(bridge, /translate\(-50%,-50%\)|padding-bottom:20px/, '不得再用造成上偏的双重位移或图鉴底部留白');

  const library = await readFile(new URL('../docs/design/brand-motion/wmb-creature-motion-library.html', import.meta.url), 'utf8');
  for (const action of ['connect', 'settle', 'sleep']) {
    assert.match(library, new RegExp(`action-${action}`), `${action} 动作来自正式图鉴`);
  }
  assert.match(library, /@media\(prefers-reduced-motion:reduce\)\{\*\{animation:none!important\}/, '冻结资产自带 reduced-motion 静止替代');
});

function cssRule(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `CSS 选择器存在: ${selector}`);
  const brace = css.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > brace, `CSS 规则闭合: ${selector}`);
  return css.slice(brace, end + 1);
}

test('orchestration CSS is a full-width branded task card with one flat boundary and stable spacing', async () => {
  const css = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  const wrapRule = cssRule(css, '.pi-orchestration-wrap');
  assert.match(wrapRule, /border: 1px solid color-mix/, '单一完整边界定义任务对象');
  assert.match(wrapRule, /background: var\(--surface-raised\)/, '使用主题表面而非用户气泡紫底');
  assert.match(wrapRule, /grid-template-columns: 62px minmax\(0, 1fr\)/, '动画舞台与任务正文使用稳定双列');
  assert.match(wrapRule, /margin: 14px 0 18px/, '与上下对话保持独立呼吸');

  const mascotRule = cssRule(css, '.pi-orchestration-mascot');
  assert.match(mascotRule, /width: 62px/);
  assert.match(mascotRule, /height: 62px/);
  assert.match(mascotRule, /overflow: hidden/, '动画特效保持在产品舞台内');
  assert.match(mascotRule, /background: color-mix/, '动画资产拥有独立但克制的舞台');
  const motionRule = cssRule(css, '.pi-orchestration-motion');
  assert.match(motionRule, /width: 62px/);
  assert.match(motionRule, /height: 62px/);
  assert.match(motionRule, /border: 0/);
  assert.match(motionRule, /pointer-events: none/, '动画资产不抢任务卡交互');

  assert.match(cssRule(css, '.pi-orchestration-status'), /color: var\(--accent-soft\)/);
  assert.match(cssRule(css, '.pi-orchestration-status'), /font-size: 11px/);
  assert.match(cssRule(css, '.pi-orchestration-wrap.failed .pi-orchestration-status'), /color: var\(--danger\)/);
  assert.match(cssRule(css, '.pi-orchestration-error'), /color: var\(--danger\)/);
  assert.match(cssRule(css, '.pi-orchestration-title'), /font-size: 13\.5px/);
  assert.match(cssRule(css, '.pi-orchestration-title'), /color: var\(--ink\)/);
  assert.match(cssRule(css, '.pi-orchestration-time'), /font-size: 11px/);
  assert.match(cssRule(css, '.pi-orchestration-time'), /color: var\(--muted-low\)/);

  assert.match(cssRule(css, '.pi-orchestration-details > summary:focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.doesNotMatch(css, /pi-orchestration[^\r\n]*details-marker/, '保留原生 details 标记与键盘行为');
  assert.doesNotMatch(cssRule(css, '.pi-orchestration-details > summary'), /content:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.pi-orchestration-details > summary \{ transition: none; \} \}/);
});

test('long titles and expanded content wrap naturally with 1100px-safe overflow', async () => {
  const css = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  assert.match(cssRule(css, '.pi-orchestration-title'), /overflow-wrap: anywhere/);
  assert.match(cssRule(css, '.pi-orchestration-title'), /word-break: break-word/);
  assert.match(cssRule(css, '.pi-orchestration-head'), /flex-wrap: wrap/);
  assert.match(cssRule(css, '.pi-orchestration-head'), /min-width: 0/);
  assert.match(cssRule(css, '.pi-orchestration-requirement dd'), /overflow-wrap: anywhere/);
  assert.match(cssRule(css, '.pi-orchestration-requirement dd'), /word-break: break-word/);
  assert.match(cssRule(css, '.pi-orchestration-requirement {'), /grid-template-columns: 34px minmax\(0, 1fr\)/);
  assert.match(css, /\.pi-conversation \{[^\r\n]*overflow-x: hidden/);
  assert.match(css, /\.pi-conversation \{[^\r\n]*min-width: 0/);
});

test('both themes define every orchestration token (contrast surface for the muted violet label)', async () => {
  const foundation = await readFile(new URL('../src/renderer/styles-foundation.css', import.meta.url), 'utf8');
  const darkStart = foundation.indexOf(':root {');
  const lightStart = foundation.indexOf(':root[data-theme="light"]');
  assert.ok(darkStart >= 0 && lightStart > darkStart);
  const darkBlock = foundation.slice(darkStart, lightStart);
  const lightBlock = foundation.slice(lightStart);
  for (const token of ['--accent-soft', '--ink', '--ink-soft', '--muted-low', '--surface', '--surface-raised', '--border', '--border-soft', '--danger']) {
    assert.match(darkBlock, new RegExp(`${token}:`), `暗主题定义 ${token}`);
    assert.match(lightBlock, new RegExp(`${token}:`), `光主题定义 ${token}`);
  }
});
