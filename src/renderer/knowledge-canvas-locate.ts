// WMB-5239：关系画布「最近变化定位 / 图谱内搜索定位」纯函数层（无 DOM、无 IPC、无副作用）。
// 边界：
// - 画布是全局知识网络的只读投影：本模块只把「最近变化（全局日志）条目 / 图谱内搜索命中」
//   翻译成画布可执行的定位决策 —— 聚焦既有节点 / 打开知识本体卡 / 走既有深链 / 诚实不可定位；
//   绝不写库、不做任何维护执行动作（画布不承担维护执行，资料库独占维护控制）；
// - 复用 WMB-5243 稳定节点 ID（`<objectType>:<objectId>`，src/shared/knowledge-network.ts）、
//   filterGraph 的 query 匹配语义（knowledge-network-interaction.ts）与既有深链目标
//   CanvasDetailTarget（knowledge-network-format.ts）；
// - 产品语言（最近变化/搜索定位/去资料库），不暴露 changeset/receipt/hot-cache 等工程词。

import type { KnowledgeLogEntry } from '../shared/knowledge-global-log';
import type { KnowledgeNetworkNode } from '../shared/knowledge-network';
import { knowledgeNetworkNodeId } from '../shared/knowledge-network.ts';
import type { CanvasDetailTarget } from './knowledge-network-format';
import { filterGraph } from './knowledge-network-interaction.ts';

/** 画布定位决策（视图按 kind 分发：聚焦节点 / 打开本体卡 / 既有深链 / 诚实提示）。 */
export type CanvasLocateDecision = Readonly<
  | { kind: 'focus-node'; nodeId: string }
  | { kind: 'open-card'; nodeId: string }
  | { kind: 'deep-link'; target: CanvasDetailTarget }
  | { kind: 'not-locatable'; reason: string }
>;

/** 图谱内搜索定位结果列表上限（轻量入口，有界防刷屏）。 */
export const SEARCH_LOCATE_LIMIT = 12;

/**
 * 日志条目 → 画布节点候选（定位优先级：主题 → 知识结论 → 实体；去重保序）。
 * 只取每个 refs 组的首个 ID（有界；足够定位入口使用）。
 */
export function logEntryNodeCandidates(entry: KnowledgeLogEntry): string[] {
  const out: string[] = [];
  const push = (nodeId: string | null | undefined) => {
    if (nodeId && !out.includes(nodeId)) out.push(nodeId);
  };
  push(
    entry.refs.topicIds[0]
      ? knowledgeNetworkNodeId('topic', entry.refs.topicIds[0])
      : null,
  );
  push(
    entry.refs.noteIds[0]
      ? knowledgeNetworkNodeId('knowledge_note', entry.refs.noteIds[0])
      : null,
  );
  push(
    entry.refs.entityIds[0]
      ? knowledgeNetworkNodeId('knowledge_entity', entry.refs.entityIds[0])
      : null,
  );
  return out;
}

/**
 * 日志条目 → 资料库深链目标。
 * Scout 风险点：source 日志条目的 locator.id 是 revisionId（source_body_revisions.id），
 * 导航必须取 versionRefs.sourceId（正式 source id），否则资料库无法定位到正确资料。
 */
export function logEntrySourceTarget(
  entry: KnowledgeLogEntry,
): CanvasDetailTarget | null {
  const sourceId = entry.versionRefs.sourceId ?? entry.refs.sourceIds[0] ?? null;
  return sourceId
    ? { type: 'source', id: sourceId, title: entry.title }
    : null;
}

/** 诚实不可定位文案（按条目承载对象给用户语言；未知回退通用提示，不静默）。 */
export function logEntryNotLocatableReason(entry: KnowledgeLogEntry): string {
  switch (entry.locator.kind) {
    case 'health_issue':
      return '健康问题暂无独立页面，可在资料库查看';
    case 'maintenance_run':
      return '整理记录暂无独立页面，可在资料库查看';
    default:
      return '该记录暂无法定位到具体知识';
  }
}

/**
 * 日志条目 → 画布定位决策。
 * 规则（诚实降级链）：
 * 1) 候选节点（主题/结论/实体）已在当前投影 → 聚焦节点；
 * 2) 主题未加载 → 走既有主题深链（主题恒有正式页）；
 * 3) 资料相关 → 走资料库深链（sourceId 正式 ID）；
 * 4) 结论/实体未加载 → 打开知识本体卡（浮卡可独立读取，无正式页面不静默）；
 * 5) 无任何定位目标 → 诚实不可定位文案。
 */
export function locateLogEntry(
  entry: KnowledgeLogEntry,
  loadedNodeIds: ReadonlySet<string>,
): CanvasLocateDecision {
  const candidates = logEntryNodeCandidates(entry);
  for (const nodeId of candidates) {
    if (loadedNodeIds.has(nodeId)) return { kind: 'focus-node', nodeId };
  }
  const topicId = entry.refs.topicIds[0];
  if (topicId)
    return {
      kind: 'deep-link',
      target: { type: 'topic', id: topicId, title: entry.title },
    };
  const sourceTarget = logEntrySourceTarget(entry);
  if (sourceTarget) return { kind: 'deep-link', target: sourceTarget };
  const firstCandidate = candidates[0];
  if (firstCandidate) return { kind: 'open-card', nodeId: firstCandidate };
  return { kind: 'not-locatable', reason: logEntryNotLocatableReason(entry) };
}

/**
 * 图谱内搜索定位候选：与图谱过滤同一 query 匹配语义（shortTitle/summary，大小写不敏感），
 * 只看 query 不看类型/关系过滤（被过滤隐藏的命中也能被定位，点击时由视图清除隐藏过滤）。
 * 空 query → 空数组（契约语义）；结果有界 SEARCH_LOCATE_LIMIT。
 */
export function searchMatchCandidates(
  nodes: readonly KnowledgeNetworkNode[],
  query: string,
  limit: number = SEARCH_LOCATE_LIMIT,
): KnowledgeNetworkNode[] {
  const q = query.trim();
  if (!q) return [];
  return filterGraph(nodes, [], { query: q }).nodes.slice(0, limit);
}

/** 图谱内搜索无匹配的诚实提示（query 非空且零命中）；有命中或空 query → null。 */
export function searchEmptyHint(query: string, matchCount: number): string | null {
  if (!query.trim()) return null;
  if (matchCount > 0) return null;
  return '没有匹配的知识节点，可去资料库搜索全部资料';
}
