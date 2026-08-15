// WMB-5216 结果页「知识健康 · 结果回流」投影 —— 纯函数层（renderer 内部，无 IPC/无副作用）。
// 与 Topic/Library/Canvas 投影同一 KnowledgeHealthIssueRecord identity：只读复用
// listHealthIssues shared/preload 通道，不新增 schema/身份/写能力；
// 多路查询合并按真实 issue.id 去重（同一问题绝不复制）。
// 深链只在本页已有发布钻取（setSelectedId）内可行：不做任何跨页路由。

import type {
  KnowledgeFlywheelListResult,
  KnowledgeHealthIssueRecord,
  KnowledgeHealthIssueType,
} from '../shared/knowledge-flywheel';
import { severityRank } from './knowledge-canvas-projection.ts';

/** 结果回流相关 issue 类型（与知识健康正式词典对齐）。 */
export const RESULTS_HEALTH_ISSUE_TYPES: readonly KnowledgeHealthIssueType[] = Object.freeze([
  'unreturned_review',
  'underperforming_method',
]);

/** 结果回流相关受影响对象类型（业务对象：Review / Publication / Metric 快照）。 */
export const RESULTS_HEALTH_AFFECTED_TYPES: readonly string[] = Object.freeze([
  'review',
  'publication',
  'metric_snapshot',
]);

/** dataChanged 触发结果健康刷新的 scope（lint/回流/ChangeSet 广播均含 health/knowledge/receipt）。 */
export const RESULTS_HEALTH_REFRESH_SCOPES: readonly string[] = Object.freeze(['health', 'knowledge', 'receipt']);

/** 每路查询的有界页大小（区域本身有界，不倾倒全量问题队列）。 */
export const RESULTS_HEALTH_QUERY_LIMIT = 50;

export function shouldRefreshResultsHealth(scopes: readonly string[] | null | undefined): boolean {
  if (!scopes || !scopes.length) return true;
  return scopes.some((scope) => RESULTS_HEALTH_REFRESH_SCOPES.includes(scope));
}

/** 合并多路查询并按真实 issue id 去重；active（open/repairing）优先 → 严重度降序 → 检测时间新→旧。 */
export function mergeResultsHealthIssues(
  pages: ReadonlyArray<KnowledgeFlywheelListResult<KnowledgeHealthIssueRecord> | null | undefined>,
): KnowledgeHealthIssueRecord[] {
  const byId = new Map<string, KnowledgeHealthIssueRecord>();
  for (const page of pages ?? []) {
    for (const issue of page?.items ?? []) {
      if (!issue || typeof issue.id !== 'string' || !issue.id) continue;
      if (!byId.has(issue.id)) byId.set(issue.id, issue);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const aActive = a.status === 'open' || a.status === 'repairing' ? 0 : 1;
    const bActive = b.status === 'open' || b.status === 'repairing' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const rankDiff = severityRank(b.severity) - severityRank(a.severity);
    if (rankDiff !== 0) return rankDiff;
    const timeDiff = String(b.detectedAt).localeCompare(String(a.detectedAt));
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });
}

/** 本页可行深链/标签解析输入（同一真实对象 id；只读）。 */
export type ResultsHealthContext = Readonly<{
  publications: ReadonlyArray<{ id: string; title: string }>;
  reviews: ReadonlyArray<{ id: string; publicationId: string }>;
  snapshots: ReadonlyArray<{ id: string; publicationId: string }>;
}>;

export type ResultsHealthResolution = Readonly<{
  /** 本页可行深链（发布钻取）；null = 无可行目标，不渲染按钮（无额外路由）。 */
  target: { kind: 'publication'; publicationId: string; title: string } | null;
  /** 受影响对象可读标签（全局/发布/复盘/指标快照/对象）。 */
  affectedLabel: string;
}>;

const AFFECTED_TYPE_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  review: '复盘',
  publication: '发布',
  metric_snapshot: '指标快照',
});

/**
 * 解析受影响对象到本页已有深链：publication 直接钻取；review/metric_snapshot 经
 * 同一真实 id 映射到 publicationId 再钻取；其余（含未知类型/缺失对象）→ null（不渲染按钮）。
 */
export function resolveResultsHealthIssue(
  issue: KnowledgeHealthIssueRecord,
  ctx: ResultsHealthContext,
): ResultsHealthResolution {
  if (!issue.affectedObjectType || !issue.affectedObjectId) {
    return { target: null, affectedLabel: '全局' };
  }
  const type = issue.affectedObjectType;
  const id = issue.affectedObjectId;
  const short = (prefix: string) => `${prefix} ${id.slice(0, 8)}`;
  if (type === 'publication') {
    const pub = ctx.publications.find((p) => p.id === id);
    if (!pub) return { target: null, affectedLabel: short('发布') };
    return { target: { kind: 'publication', publicationId: pub.id, title: pub.title }, affectedLabel: pub.title };
  }
  if (type === 'review') {
    const review = ctx.reviews.find((r) => r.id === id);
    if (!review) return { target: null, affectedLabel: short('复盘') };
    const pub = ctx.publications.find((p) => p.id === review.publicationId);
    if (!pub) return { target: null, affectedLabel: short('复盘') };
    return {
      target: { kind: 'publication', publicationId: pub.id, title: pub.title },
      affectedLabel: `${pub.title} 的复盘`,
    };
  }
  if (type === 'metric_snapshot') {
    const snap = ctx.snapshots.find((s) => s.id === id);
    if (!snap) return { target: null, affectedLabel: short('指标快照') };
    const pub = ctx.publications.find((p) => p.id === snap.publicationId);
    if (!pub) return { target: null, affectedLabel: short('指标快照') };
    return {
      target: { kind: 'publication', publicationId: pub.id, title: pub.title },
      affectedLabel: `${pub.title} 的指标快照`,
    };
  }
  return { target: null, affectedLabel: short(AFFECTED_TYPE_PREFIXES[type] ?? '对象') };
}

/** 状态 → pill-status 类（与 Library 知识健康页同一视觉语义；结果页只读投影）。 */
export function resultsHealthStatusCls(status: string | null | undefined): string {
  const value = String(status ?? '');
  if (value === 'resolved' || value === 'false_positive') return 'green';
  if (value === 'repairing') return 'blue';
  return 'amber';
}

/** 检测时间可读格式；非法时间原样返回。 */
export function formatHealthTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}
