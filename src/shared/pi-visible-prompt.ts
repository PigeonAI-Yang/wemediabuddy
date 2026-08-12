/**
 * WMB-5189 canonical 可见文本提取器（main 与 renderer 共用单源；browser-safe、main-safe，零 Node 依赖）。
 *
 * 替代原 `visiblePiPrompt`（首 `[USER_MESSAGE]` 标记截断）的全部消费面；任何地方不得再手抄
 * `[USER_MESSAGE]` / authority 行 / `/skill:*` 字面量。提取规则（修订设计 §8）：
 *   1. orchestration 信封命中 → 返回 safe.title（编排行权威可见文本）；
 *   2. 先移除 Skill 路由命令或 Pi 原生展开后的 `<skill>…</skill>` 包裹，再取业务信封的**第一个**
 *    `[USER_MESSAGE]\n` 标记；用户正文中粘贴的 lookalike 标记保持原文且不获编排身份；
 *   3. 剥离尾部 authority/内部行：taskId=/grantId=/workerLeaseId=、[WMB_TASK_AUTHORITY]、
 *      [WMB_AUTHORITY_BLOCKED]（pi-page-authority 注入格式）以及 [WMB_CONTEXT]/[ORCHESTRATION]
 *      块与内部 ID 行（managerTaskId=/dispatchId=/sessionId=/objectId=、WMB_CONTEXT 体 page= 等）；
 *   4. 去 `/skill:*` 前缀与残留包装（[WMB_CONTEXT]/[ORCHESTRATION]/authority 块头 + 连续内部体行）；
 *   5. 解析失败/空 → 固定安全兜底文案（fail-closed，绝不回退 raw）。
 *
 * 对已可见文本（safe.title、队列项、人类消息）幂等：无信封、无标记时原样返回 trim 后文本。
 */

import { ORCHESTRATION_USER_MESSAGE_MARKER, parseOrchestrationEnvelope } from './orchestration-envelope.ts';

/** 解析失败/空时的固定安全兜底文案（DOM 准入边界，绝不回退 raw）。 */
export const VISIBLE_PROMPT_FALLBACK = '（内容不可显示）';

/** 剥离的 authority/内部行：pi-page-authority 注入键 + WMB_CONTEXT 体键 + 内部 ID 键。 */
const INTERNAL_LINE = /^(?:taskId|grantId|workerLeaseId|managerTaskId|dispatchId|sessionId|objectId|page|pageLabel|objectType|contextRule)=/;

/** 剥离的包装块行（[WMB_CONTEXT]/[ORCHESTRATION]/authority 块头）。 */
const WRAPPER_LINE = /^\[(?:WMB_TASK_AUTHORITY|WMB_AUTHORITY_BLOCKED|WMB_CONTEXT|ORCHESTRATION)\]/;

/** 路由/技能前缀 token（`/skill:<name>`；Skill 路由措辞永不进 DOM）。 */
const SKILL_PREFIX = /^\/skill:[^\s]*\s*/;
/** Pi 原生会把 `/skill:*` 展开为置顶 `<skill …>…</skill>` 文档，后接同一外层用户标记。 */
const SKILL_DOCUMENT_PREFIX = /^<skill\b[^>]*>[\s\S]*?<\/skill>\s*/;

/** 剥离开头残留包装块：块头行 + 紧随其后的连续内部体行（如 `[WMB_CONTEXT]\npage=…\n…`）。 */
function stripLeadingWrapper(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length) {
    if (WRAPPER_LINE.test(lines[start] ?? '')) {
      start += 1;
      while (start < lines.length && INTERNAL_LINE.test(lines[start] ?? '')) start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start);
}

export function extractVisiblePrompt(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return VISIBLE_PROMPT_FALLBACK;
  const envelope = parseOrchestrationEnvelope(raw);
  if (envelope) return envelope.safe.title;
  let source = raw;
  const skillRouted = SKILL_PREFIX.test(source) || SKILL_DOCUMENT_PREFIX.test(source);
  if (skillRouted) {
    source = source.replace(SKILL_PREFIX, '').replace(SKILL_DOCUMENT_PREFIX, '');
    if (source.startsWith(ORCHESTRATION_USER_MESSAGE_MARKER)) {
      source = source.slice(ORCHESTRATION_USER_MESSAGE_MARKER.length);
    }
  }
  const markerIndex = source.indexOf(ORCHESTRATION_USER_MESSAGE_MARKER);
  const tail = markerIndex >= 0 ? source.slice(markerIndex + ORCHESTRATION_USER_MESSAGE_MARKER.length) : source;
  const lines = tail.split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1] ?? '';
    if (last.trim() === '' || INTERNAL_LINE.test(last) || WRAPPER_LINE.test(last)) lines.pop();
    else break;
  }
  const text = stripLeadingWrapper(lines).join('\n').replace(SKILL_PREFIX, '').trim();
  return text || VISIBLE_PROMPT_FALLBACK;
}
