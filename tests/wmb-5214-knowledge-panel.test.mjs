import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { knowledgeQueryWritebackRequestId } from '../src/shared/knowledge-flywheel.ts';
import {
  piKnowledgeQuestionBefore,
  piKnowledgeRiskKindLabel,
  piKnowledgeShortId,
  piKnowledgeWriteBackDecisionLabel
} from '../src/renderer/pi-dock-utils.ts';

// ============================================================
// WMB-5214 Pi UI 知识使用与沉淀面板（renderer 聚焦测试）
// 验收：restatement 显示未沉淀原因；synthesis 显示写回；无回答冒充证据；
// 面板与 tool JSON 分离；aria/details/主题；requestId 与 writeback 同源派生。
// ============================================================

test('requestId derivation matches the writeback backend convention (query:{conversationId}:{hash(question.trim())})', () => {
  const conversationId = 'conv-123';
  const question = '  X 平台 6 月最新政策是什么  ';
  const first = knowledgeQueryWritebackRequestId(conversationId, question);
  const trimmed = knowledgeQueryWritebackRequestId(conversationId, question.trim());
  assert.equal(first, trimmed, 'shared 派生统一先 trim，调用方无需自行归一');
  assert.match(first, /^query:conv-123:[0-9a-f]{8}$/, '键形符契约：query:{conversationId}:{8位 hex}');
  assert.notEqual(knowledgeQueryWritebackRequestId(conversationId, '另一个问题'), first, '不同问题不同键');
  assert.notEqual(knowledgeQueryWritebackRequestId('conv-other', question), first, '不同会话不同键');
  assert.equal(knowledgeQueryWritebackRequestId(conversationId, '   '), knowledgeQueryWritebackRequestId(conversationId, ''), '空/空白问题归一为空内容');
});

test('piKnowledgeQuestionBefore walks back to the last real user question, skipping system/orchestration/local rows', () => {
  const messages = [
    { role: 'user', kind: 'system_event', entryId: 'job-1', text: '工单终态' },
    { role: 'user', text: '第一个问题', entryId: 'u1' },
    { role: 'assistant', text: '答一', entryId: 'a1' },
    { role: 'user', kind: 'orchestration', orchestration: { state: 'accepted' }, entryId: 'orch-1', text: '编排任务' },
    { role: 'user', text: '第二个问题', entryId: 'u2' },
    { role: 'assistant', text: '答二', entryId: 'a2' }
  ];
  assert.equal(piKnowledgeQuestionBefore(messages, 1), null, 'assistant 前无用户问题则 null');
  assert.equal(piKnowledgeQuestionBefore(messages, 2), '第一个问题');
  assert.equal(piKnowledgeQuestionBefore(messages, 3), '第一个问题', 'orchestration 行不阻断回溯（index 3 是编排行）');
  assert.equal(piKnowledgeQuestionBefore(messages, 4), '第一个问题', 'system/orchestration 行不阻断回溯（index 4 用户问题之前是编排行）');
  assert.equal(piKnowledgeQuestionBefore(messages, 5), '第二个问题');
  assert.equal(piKnowledgeQuestionBefore(messages, 6), '第二个问题', '越界 index 从末尾开始回溯仍找到最近问题');
  assert.equal(piKnowledgeQuestionBefore(messages, 99), '第二个问题');
  assert.equal(piKnowledgeQuestionBefore([], 0), null);

  const withLocal = [
    { role: 'user', text: '本地乐观气泡', entryId: 'local-queue:abc', createdAt: '2026-08-12T00:00:00.000Z' },
    { role: 'user', text: 'canonical 问题', entryId: 'u-canonical' },
    { role: 'assistant', text: '答', entryId: 'a1' }
  ];
  assert.equal(piKnowledgeQuestionBefore(withLocal, 2), 'canonical 问题', '本地乐观气泡不作为写回问题的键源');
  const localOnly = [
    { role: 'user', text: '忙时提交', entryId: 'local-queue:xyz' },
    { role: 'assistant', text: '答', entryId: 'a1' }
  ];
  assert.equal(piKnowledgeQuestionBefore(localOnly, 1), null, '仅本地气泡时面板不派生 requestId（无 canonical 键源）');
});

test('decision label covers created/updated writeback and every skip reason (no fourth default)', () => {
  assert.equal(piKnowledgeWriteBackDecisionLabel('created'), '已沉淀：本次形成新知识');
  assert.equal(piKnowledgeWriteBackDecisionLabel('updated'), '已沉淀：本次更新既有知识');
  assert.equal(piKnowledgeWriteBackDecisionLabel('skipped_repetition'), '未写回：纯复述既有知识');
  assert.equal(piKnowledgeWriteBackDecisionLabel('skipped_low_value'), '未写回：内容价值不足');
  assert.equal(piKnowledgeWriteBackDecisionLabel('skipped_transient'), '未写回：一次性/低复用内容');
  assert.equal(piKnowledgeWriteBackDecisionLabel('no_write_back'), '未写回：本次无可沉淀增量');
  assert.equal(piKnowledgeWriteBackDecisionLabel('bogus'), 'bogus', '未知决策原样展示，不冒充已知状态');
  assert.equal(piKnowledgeWriteBackDecisionLabel(null), '未写回');
  assert.match(piKnowledgeWriteBackDecisionLabel('skipped_repetition'), /^未写回/);
  assert.match(piKnowledgeWriteBackDecisionLabel('created'), /^已沉淀/);
});

test('risk kind label maps the five risk kinds and never mislabels unknown kinds', () => {
  assert.equal(piKnowledgeRiskKindLabel('disputed'), '有争议');
  assert.equal(piKnowledgeRiskKindLabel('contradicted'), '被反驳');
  assert.equal(piKnowledgeRiskKindLabel('inference'), '推断');
  assert.equal(piKnowledgeRiskKindLabel('stale'), '已过期');
  assert.equal(piKnowledgeRiskKindLabel('unverified'), '未验证');
  assert.equal(piKnowledgeRiskKindLabel('unknown_kind'), 'unknown_kind');
  assert.equal(piKnowledgeRiskKindLabel(null), '风险');
});

test('short id keeps the object prefix and tail for entry points', () => {
  assert.equal(piKnowledgeShortId('abc'), 'abc', '短 id 原样');
  assert.equal(piKnowledgeShortId('wver-0000000000000000001'), 'wver-000…000001', '长 id 保留前缀与尾部');
  assert.equal(piKnowledgeShortId(null), '');
  assert.equal(piKnowledgeShortId(undefined), '');
});

test('transcript renders a collapsible knowledge panel only after completed assistant answers', async () => {
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  const panelStart = transcript.indexOf('const piKnowledgeSummaryCache');
  const dockExport = transcript.indexOf('export function PiDockTranscript');
  assert.ok(panelStart >= 0 && panelStart < dockExport, 'PiKnowledgePanel 相关代码位于导出前');
  const panelBlock = transcript.slice(panelStart, dockExport);

  // 请求键：与 writeback 同源的 shared 派生（conversationId + 前溯问题文本）
  assert.match(panelBlock, /knowledgeQueryWritebackRequestId\(conversationId, question\)/);
  assert.match(panelBlock, /conversationId && question \? knowledgeQueryWritebackRequestId/);

  // 挂载门：仅回答结束后（非 streaming、非纯活动占位）渲染，且只读拉取摘要
  assert.match(transcript, /!activityOnly && message\.status !== 'streaming' && <PiKnowledgePanel conversationId=\{conversationId \?\? null\} question=\{piKnowledgeQuestionBefore\(displayMessages, index\)\} \/>/);
  assert.match(panelBlock, /usePiKnowledgeSummary\(requestId\)/);
  assert.match(panelBlock, /window\.wmb\.getQueryWritebackSummary/);
  assert.match(panelBlock, /\{ requestId \}\)/);

  // 无 artifact 且无 settle（重启后旧轮次）→ 整个面板隐藏，不展示空壳
  assert.match(panelBlock, /if \(!artifact && !settle\) return null;/);
  // WMB-5231：无 artifact 但有 settle（无/非法清单、校验或写回失败）→ 显示可读未写原因
  assert.match(panelBlock, /settle\?\.reason \?\? '本轮未产生知识写回。'/);
  assert.match(panelBlock, /pi-knowledge-settle-reason/);
});

test('knowledge panel shows used entries, risks, writeback decision, skip reason, receipt and changeSet entry — never tool JSON or answer-as-evidence', async () => {
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  const block = transcript.slice(transcript.indexOf('const piKnowledgeSummaryCache'), transcript.indexOf('export function PiDockTranscript'));
  assertPanelContract(block);
});

function assertPanelContract(block) {
  // 折叠控件：原生 details/summary + aria；不新增按钮/aria-live
  assert.match(block, /<details className=\{`pi-knowledge-panel\$\{writtenBack \? ' written-back' : ' not-written-back'\}`\} data-decision=\{decision\} aria-label=\{`知识使用与沉淀：\$\{writtenBack \? '已沉淀' : '未写回'\}`\}>/);
  assert.match(block, /<summary>/);
  assert.doesNotMatch(block, /aria-live|<button/, '知识面板不加 aria-live/按钮');

  // 本次使用：Wiki/知识/来源 数量 + 短 id 入口（只读固定版本引用）
  assert.match(block, /QUERY_USED_GROUPS/);
  assert.match(block, /readWikiVersionIds|readNoteVersionIds|readEvidenceIds/);
  assert.match(block, /piKnowledgeShortId/);
  assert.match(block, /pi-knowledge-used-ids/);

  // 风险：只展示风险种类可读标签 + note，不展示内部 JSON
  assert.match(block, /piKnowledgeRiskKindLabel\(flag\.kind\)/);
  assert.match(block, /pi-risk-chip/);
  assert.doesNotMatch(block, /JSON\.stringify|candidates|inputHash|beforeRevision/, '面板不得泄露内部 ChangeSet 细节');

  // 沉淀/未写回：决策文案 + skipReason（restatement 显示未沉淀原因）
  assert.match(block, /piKnowledgeWriteBackDecisionLabel\(decision\)/);
  assert.match(block, /!writtenBack && artifact\.skipReason && <p className="pi-knowledge-skip-reason">/);
  assert.match(block, /pi-knowledge-skip-reason/);

  // 回执与差异入口：receipt.summary + 回执/变更短 id（synthesis 显示写回）
  assert.match(block, /receipt\.summary/);
  assert.match(block, /pi-knowledge-receipt-entry/);
  assert.match(block, /receipt\.id/);
  assert.match(block, /receiptEntryId/);

  // 无回答冒充证据：面板永不渲染回答正文、answerSummary 或原始 tool 输入/输出
  for (const token of ['answerSummary', 'segment.input', 'segment.output', 'toolName', 'toolCallId', 'message.text', 'artifact.question']) {
    assert.doesNotMatch(block, new RegExp(token), `${token} 不得进入知识面板 DOM`);
  }
}

test('dock passes the Pi conversation snapshot id so requestIds are conversation-scoped', async () => {
  const dock = await readFile(new URL('../src/renderer/pi-dock.tsx', import.meta.url), 'utf8');
  assert.match(dock, /conversationId=\{activeSessionId\}/, 'PiDock 把 active 会话 id 传入 transcript');
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  assert.match(transcript, /conversationId\?: string \| null;/, 'transcript 声明可选会话 id 契约');
});

test('preload exposes flat getQueryWritebackSummary and shared channel const is the single source', async () => {
  const preload = await readFile(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
  assert.match(preload, /getQueryWritebackSummary: \(input: KnowledgeRequestIdRead\) => ipcRenderer\.invoke\(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS\.getQueryWritebackSummary, input\)/);
  const shared = await readFile(new URL('../src/shared/knowledge-flywheel.ts', import.meta.url), 'utf8');
  assert.match(shared, /getQueryWritebackSummary: 'knowledge-flywheel:get-query-writeback-summary'/);
  const globalTypes = await readFile(new URL('../src/renderer/global.d.ts', import.meta.url), 'utf8');
  assert.match(globalTypes, /getQueryWritebackSummary\(input: KnowledgeRequestIdRead\): Promise<KnowledgeQueryWritebackSummaryRecord \| null>/);
});

test('knowledge panel CSS uses theme tokens, native details affordance, focus ring and reduced motion', async () => {
  const css = await readFile(new URL('../src/renderer/styles-pi.css', import.meta.url), 'utf8');
  const panelRule = css.slice(css.indexOf('.pi-knowledge-panel {'), css.indexOf('.pi-knowledge-panel > summary {'));
  assert.match(panelRule, /border: 1px solid var\(--border-soft\)/);
  assert.match(panelRule, /background: color-mix/);
  assert.match(panelRule, /color: var\(--muted\)/);

  const summaryRule = css.slice(css.indexOf('.pi-knowledge-panel > summary {'), css.indexOf('.pi-knowledge-panel > summary::-webkit-details-marker'));
  assert.match(summaryRule, /list-style: none/);
  assert.match(summaryRule, /cursor: pointer/);
  // 与 .pi-tool-line 同文件惯例：隐藏 webkit 原生标记并用 ::before 箭头替代，保留原生 details 键盘行为
  assert.match(css, /\.pi-knowledge-panel > summary::-webkit-details-marker \{ display: none; \}/);
  assert.match(css, /\.pi-knowledge-panel > summary::before \{ content: '›'/);
  assert.match(css, /\.pi-knowledge-panel\[open\] > summary::before \{ transform: rotate\(90deg\); \}/);

  assert.match(cssRule(css, '.pi-knowledge-panel > summary:focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(cssRule(css, '.pi-knowledge-panel-badge'), /var\(--amber\)/);
  assert.match(cssRule(css, '.pi-knowledge-panel.written-back .pi-knowledge-panel-badge'), /var\(--accent\)/);
  assert.match(cssRule(css, '.pi-risk-chip.stale'), /var\(--amber\)/);
  assert.match(cssRule(css, '.pi-risk-chip.disputed, .pi-risk-chip.contradicted'), /var\(--danger\)/);
  assert.match(cssRule(css, '.pi-risk-chip.inference, .pi-risk-chip.unverified'), /var\(--accent\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.pi-knowledge-panel > summary, \.pi-knowledge-panel > summary::before \{ transition: none; \} \}/);
  assert.match(cssRule(css, '.pi-knowledge-receipt-summary'), /overflow-wrap: anywhere/);
  assert.match(cssRule(css, '.pi-knowledge-skip-reason'), /overflow-wrap: anywhere/);
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
