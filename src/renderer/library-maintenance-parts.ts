// WMB-5239：资料库「全库整理」用户语言映射与汇总纯函数（renderer 单一来源；无 React 便于聚焦测试）。
// 定位：library-view.tsx 原位维护入口的只读展示映射 —— 工程状态（phase/status/计数）→ 用户语言，
//   禁 compiled/receipt/changeset/hot-cache/index/cursor/scan_compile/lint/phase 等工程词
//   （Review 边界：资料库是唯一维护执行面；阶段映射 整理资料→检查健康→生成报告→已完成）。
// 约束：
// - 只读：不调用任何 IPC/写通道，仅把 main 投影（KnowledgeMaintenanceStatusView 派生数字）转成展示文本；
// - 入参用最小结构化形状（checkpoint 投影与最终报告投影字段兼容，缺字段按 0/空处理）；
// - 后端风险/失败消息可能含 Source/Topic/Lint/Issue/Raw（未编译）等内部词，maintenanceUserText 统一替换
//   为用户语言（顺序敏感：先长词后短词）；
// - 未知 phase/status 兜底为中性用户词，绝不回显原始工程字符串。
import type { KnowledgeMaintenanceFailure, KnowledgeMaintenancePhase, KnowledgeMaintenanceStatus } from '../shared/knowledge-maintenance';

/** 与主进程调度器 KNOWLEDGE_MAINTENANCE_INTERVAL_MS 对齐的有界轮询节奏（≥10s；暂停/完成/卸载即清理）。 */
export const MAINTENANCE_POLL_INTERVAL_MS = 10_000;

/** 阶段固定顺序（与 shared 契约一致）：整理资料 → 检查健康 → 生成报告 → 已完成。 */
export const MAINTENANCE_PHASE_ORDER: readonly KnowledgeMaintenancePhase[] = Object.freeze([
  'scan_compile', 'lint', 'report', 'completed',
]);

const MAINTENANCE_PHASE_LABELS: Readonly<Record<KnowledgeMaintenancePhase, string>> = Object.freeze({
  scan_compile: '整理资料',
  lint: '检查健康',
  report: '生成报告',
  completed: '已完成',
});

/** 阶段 → 用户语言（未知/空 → 「未开始」；不回显工程 phase 名）。 */
export function maintenancePhaseLabel(phase: string | null | undefined): string {
  return MAINTENANCE_PHASE_LABELS[phase as KnowledgeMaintenancePhase] ?? '未开始';
}

/** 阶段 → 顺序下标（0..3；未知 → 0）。 */
export function maintenancePhaseIndex(phase: string | null | undefined): number {
  const index = MAINTENANCE_PHASE_ORDER.indexOf(phase as KnowledgeMaintenancePhase);
  return index < 0 ? 0 : index;
}

const MAINTENANCE_STATUS_LABELS: Readonly<Record<KnowledgeMaintenanceStatus, string>> = Object.freeze({
  running: '整理中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
});

/** 运行状态 → 用户语言（未知/空 → 「未开始」）。 */
export function maintenanceStatusLabel(status: string | null | undefined): string {
  return MAINTENANCE_STATUS_LABELS[status as KnowledgeMaintenanceStatus] ?? '未开始';
}

/** 运行状态 → 现有 pill-status 语义类（foundation token；无新增色值）。 */
export function maintenanceStatusCls(status: string | null | undefined): string {
  if (status === 'running') return 'blue';
  if (status === 'paused') return 'amber';
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'amber';
  return 'gray';
}

// =====================================================================
// 批量摄取反馈（backfill 投影 → 成功 / 低价值保留原始资料 / 失败原因）
// =====================================================================

/** backfill 计数最小投影（checkpoint 与最终报告两处字段兼容）。 */
export type MaintenanceBackfillLike = Readonly<{
  compiled?: number | null;
  skippedWeak?: number | null;
  skippedNoTopic?: number | null;
  skippedNoSignal?: number | null;
  failed?: number | null;
  scanned?: number | null;
  pendingRetry?: readonly string[] | null;
}>;

export type MaintenanceIngestionSummary = Readonly<{
  /** 成功整理（本轮编译成功的 Source 数）。 */
  success: number;
  /** 低价值保留原始资料（弱资料 + 无活跃主题 + 无价值信号）。 */
  keptRaw: number;
  /** 失败条数（含重试后成功的口径：checkpoint.failed 计数）。 */
  failed: number;
  /** 仍待重试条数。 */
  retry: number;
  /** 本轮已检查的 Source 数。 */
  scanned: number;
}>;

/** backfill checkpoint 投影 → 批量摄取反馈数字（缺字段按 0；pendingRetry 取长度）。 */
export function maintenanceIngestionSummary(backfill: MaintenanceBackfillLike | null | undefined): MaintenanceIngestionSummary {
  const b = backfill ?? {};
  return Object.freeze({
    success: Number(b.compiled ?? 0),
    keptRaw: Number(b.skippedWeak ?? 0) + Number(b.skippedNoTopic ?? 0) + Number(b.skippedNoSignal ?? 0),
    failed: Number(b.failed ?? 0),
    retry: Array.isArray(b.pendingRetry) ? b.pendingRetry.length : 0,
    scanned: Number(b.scanned ?? 0),
  });
}

/** 批量摄取反馈 → 一行用户语言（如「成功整理 3 条 · 低价值保留原始 2 条 · 失败 1 条 · 1 条待重试」）。 */
export function maintenanceIngestionText(summary: MaintenanceIngestionSummary): string {
  const parts = [`成功整理 ${summary.success} 条`];
  if (summary.keptRaw > 0) parts.push(`低价值保留原始 ${summary.keptRaw} 条`);
  if (summary.failed > 0) parts.push(`失败 ${summary.failed} 条`);
  if (summary.retry > 0) parts.push(`${summary.retry} 条待重试`);
  return parts.join(' · ');
}

// =====================================================================
// 健康检查（lint 投影）摘要
// =====================================================================

/** lint 计数最小投影（周期 checkpoint 与最终报告两处字段兼容）。 */
export type MaintenanceLintLike = Readonly<{
  scannedObjects?: number | null;
  issuesCreated?: number | null;
  repairsApplied?: number | null;
  openIssues?: number | null;
}>;

/** lint checkpoint 投影 → 一行用户语言（如「检查对象 12 · 发现问题 3 · 自动修复 2 · 未解决 1」）。 */
export function maintenanceLintText(lint: MaintenanceLintLike | null | undefined): string {
  const l = lint ?? {};
  const parts = [`检查对象 ${Number(l.scannedObjects ?? 0)}`];
  if (Number(l.issuesCreated ?? 0) > 0) parts.push(`发现问题 ${Number(l.issuesCreated)}`);
  if (Number(l.repairsApplied ?? 0) > 0) parts.push(`自动修复 ${Number(l.repairsApplied)}`);
  parts.push(`未解决 ${Number(l.openIssues ?? 0)}`);
  return parts.join(' · ');
}

// =====================================================================
// 失败项（code → 用户语言；消息清洗）
// =====================================================================

const MAINTENANCE_FAILURE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  MAINTENANCE_BACKFILL_STALLED: '整理停滞（连续多批没有进展）',
  MAINTENANCE_UNEXPECTED: '整理过程出现意外错误',
  MAINTENANCE_WORKSPACE_MISMATCH: '整理任务与当前工作空间不匹配',
  MAINTENANCE_RUN_NOT_FOUND: '没有找到进行中的整理任务',
  MAINTENANCE_RUN_COMPLETED: '整理任务已完成',
  MAINTENANCE_RUN_NOT_ACTIVE: '整理任务已结束，不能执行该操作',
  MAINTENANCE_BACKFILL_CHECKPOINT_MISSING: '整理进度缺失，无法继续',
});

/** 失败代码 → 用户语言（未知 → 中性「整理失败」，不回显代码）。 */
export function maintenanceFailureLabel(code: string | null | undefined): string {
  return MAINTENANCE_FAILURE_LABELS[String(code ?? '')] ?? '整理失败';
}

/** 后端消息/风险 → 用户语言（顺序敏感：先长词后短词；不制造新工程词）。 */
const MAINTENANCE_ENGINEERING_TOKENS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['Raw（未编译）', '原始资料'],
  ['open/repairing', '待处理'],
  ['Source', '资料'],
  ['Topic', '主题'],
  ['Lint', '健康检查'],
  ['Issue', '问题'],
  ['pendingRetry', '待重试'],
  ['checkpoint', '进度'],
  ['resume', '继续'],
]);

/** 清洗后端生成的风险/失败消息中的内部词（未知片段原样保留，不丢信息）。 */
export function maintenanceUserText(text: string | null | undefined): string {
  let out = String(text ?? '');
  for (const [token, replacement] of MAINTENANCE_ENGINEERING_TOKENS) {
    out = out.split(token).join(replacement);
  }
  return out;
}

// =====================================================================
// 整理报告（report 投影 → 展示数字）
// =====================================================================

export type MaintenanceReportLike = Readonly<{
  changedSources?: readonly string[] | null;
  failures?: readonly KnowledgeMaintenanceFailure[] | null;
  risks?: readonly string[] | null;
}>;

export type MaintenanceReportSummary = Readonly<{
  /** 本轮改动（编译成功）的资料来源数。 */
  changed: number;
  failures: readonly KnowledgeMaintenanceFailure[];
  risks: readonly string[];
}>;

/** 最终报告 → 展示汇总（changedSources 取长度；failures/risks 透传供清洗展示）。 */
export function maintenanceReportSummary(report: MaintenanceReportLike | null | undefined): MaintenanceReportSummary {
  const r = report ?? {};
  return Object.freeze({
    changed: Array.isArray(r.changedSources) ? r.changedSources.length : 0,
    failures: r.failures ?? Object.freeze([]),
    risks: r.risks ?? Object.freeze([]),
  });
}
