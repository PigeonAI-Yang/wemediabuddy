// WMB-5239：主题原位「搜索本主题资料 / 相关动态」纯逻辑（无 React、无 window 依赖，可直接单测）。
// 分工：资料库拥有全库维护控制台与全库搜索；主题只呈现「与当前主题相关」的搜索与日志上下文。
// IPC 读取与用户语言映射统一走 wiki-discovery-parts.ts（单源）；本模块只保留主题页特有的
// 展示策略：与「最近变化」回执时间线的重叠过滤、索引状态提示。深链分发复用
// dispatchWikiDeepLink / dispatchWikiLogEntry（WireWmb5239UiSeams 在 main.tsx 注册导航桥）。
import type { KnowledgeLogEntry, KnowledgeLogEventType } from '../shared/knowledge-global-log';
import type { WikiIndexSummary } from '../shared/knowledge-search';

/** 变化页签 receipts 时间线已覆盖的日志事件类型：这些事件已有「最近变化」回执渲染，本切片跳过，避免并列双份。 */
export const TOPIC_LOG_RECEIPT_OVERLAP: Partial<Record<KnowledgeLogEventType, true>> = {
  change_set: true,
  receipt: true,
  compile: true,
};

/** 本主题动态切片展示的事件类型（与回执时间线互补：资料摄取 / 整理检查 / Pi 问答；不含全库整理事件——整理报告属于资料库）。 */
export const TOPIC_LOG_SUPPLEMENTARY_EVENT_TYPES: readonly KnowledgeLogEventType[] = Object.freeze([
  'source',
  'lint_detected',
  'lint_resolved',
  'query',
] as const);

/** 日志条目是否应进入主题动态切片（跳过与回执重叠的事件；未知类型 fail-open 展示）。 */
export function isTopicLogSupplementary(entry: KnowledgeLogEntry): boolean {
  return !TOPIC_LOG_RECEIPT_OVERLAP[entry.eventType];
}

/** 索引状态提示（用户语言）：检索覆盖与最近更新时间；索引为空 → 建设中提示。 */
export function topicIndexStatusLabel(summary: WikiIndexSummary | null): string {
  return summary?.updatedAt ? `全库资料检索已更新至 ${summary.updatedAt}` : '全库资料检索正在建立';
}
