// WMB-5236：持久化「维护整个 Wiki」运行（full-wiki maintenance run）的 preload ↔ main IPC 公共契约。
// Design: WMB-5235 Karpathy LLM Wiki 能力矩阵缺口（维护整个 Wiki）→ 本运行编排既有
//   knowledge-backfill（scan_compile 阶段）+ knowledge-health 周期 Lint（lint 阶段）→
//   持久最终报告（report 阶段）。
// 定位：preload/renderer 侧的唯一通道清单与纯 JSON 边界类型（与
//   src/shared/knowledge-flywheel.ts 同款模式；主进程状态机真源在
//   src/main/knowledge-maintenance.ts，字段与其保持对齐）。
// 约束：
// - 不暴露内部 DB 或任意 SQL：通道集合固定为下方 4 个，无 execute/query/raw 通道；
// - preload 对入参只做透传，非法/缺失参数由 main boundary 拒绝；
// - start 幂等：存在 running/paused/failed run 时重复 start 返回同一 run（不新建）；
//   重启恢复由主进程维护调度器沿 SQLite 持久 checkpoint 自动继续；
// - pause 只在批次边界生效；paused 不占执行；失败保留错误并允许 resume；
// - 严格 workspace 身份：run 绑定创建它的 workspaceId，跨 workspace 操作一律拒绝。

export const KNOWLEDGE_MAINTENANCE_IPC_CHANNELS = Object.freeze({
  start: 'knowledge-maintenance:start',
  status: 'knowledge-maintenance:status',
  pause: 'knowledge-maintenance:pause',
  resume: 'knowledge-maintenance:resume'
} as const);

export type KnowledgeMaintenanceIpcChannel = (typeof KNOWLEDGE_MAINTENANCE_IPC_CHANNELS)[keyof typeof KNOWLEDGE_MAINTENANCE_IPC_CHANNELS];

/** 运行阶段固定顺序：scan_compile → lint → report → completed。 */
export type KnowledgeMaintenancePhase = 'scan_compile' | 'lint' | 'report' | 'completed';

export type KnowledgeMaintenanceStatus = 'running' | 'paused' | 'completed' | 'failed';

export type KnowledgeMaintenanceFailure = Readonly<{
  code: string;
  message: string;
}>;

/** 每次执行的硬预算（start 时冻结进 run，重启继续沿用）。 */
export type KnowledgeMaintenanceConfig = Readonly<{
  /** scan_compile 每 tick 回溯的 Source 硬上限（1..50）。 */
  batchLimit: number;
  /** 每 Source 最多编译的活跃 Topic 数（1..20）。 */
  maxTopicsPerSource: number;
  /** 回溯连续无进展批次上限；超过则 run 进入 failed（保留错误，允许 resume）。 */
  stallLimit: number;
}>;

/** 全库维护 run 持久记录（app_meta KV；schemaVersion=1；单飞：任意时刻至多一个活动 run）。 */
export type KnowledgeMaintenanceRun = Readonly<{
  schemaVersion: 1;
  runId: string;
  workspaceId: string;
  phase: KnowledgeMaintenancePhase;
  status: KnowledgeMaintenanceStatus;
  /** 已执行的 tick 数（每次有界执行 +1）。 */
  step: number;
  config: KnowledgeMaintenanceConfig;
  /** scan_compile 阶段回溯 checkpoint 的镜像簿记（供停滞检测；报告数字仍取自 checkpoint）。 */
  backfill: Readonly<{
    done: boolean;
    lastCursor: string;
    lastPendingRetryKey: string;
    stallCount: number;
  }>;
  /** lint 阶段复用周期 Lint checkpoint 的镜像簿记。 */
  lint: Readonly<{
    done: boolean;
    runId: string | null;
  }>;
  /** 最近一次失败（status='failed' 时保留；resume 后在下一次成功推进前仍可见）。 */
  error: KnowledgeMaintenanceFailure | null;
  reportId: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

/** 回溯 checkpoint 的只读投影（数字来自 app_meta 内既有 backfill checkpoint）。 */
export type KnowledgeMaintenanceBackfillSummary = Readonly<{
  done: boolean;
  runId: string | null;
  cursor: string;
  pendingRetry: readonly string[];
  scanned: number;
  processed: number;
  compiled: number;
  skippedExistingReceipt: number;
  skippedWeak: number;
  skippedNoTopic: number;
  skippedNoSignal: number;
  failed: number;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}>;

/** 周期 Lint checkpoint 的只读投影（数字来自 app_meta 内既有 lint checkpoint + 健康表）。 */
export type KnowledgeMaintenanceLintSummary = Readonly<{
  done: boolean;
  runId: string | null;
  phase: string;
  step: number;
  scannedObjects: number;
  issuesCreated: number;
  issuesDeduplicated: number;
  issuesAutoResolved: number;
  repairsApplied: number;
  /** 仍 open/repairing 的健康 Issue 数（DB 实时计数）。 */
  openIssues: number;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}>;

/** 持久最终报告（读模型；report 阶段生成，数字全部来自 checkpoint/DB）。 */
export type KnowledgeMaintenanceReport = Readonly<{
  schemaVersion: 1;
  reportId: string;
  runId: string;
  workspaceId: string;
  startedAt: string;
  completedAt: string;
  backfill: Readonly<{
    runId: string | null;
    scanned: number;
    processed: number;
    compiled: number;
    skippedExistingReceipt: number;
    skippedWeak: number;
    skippedNoTopic: number;
    skippedNoSignal: number;
    failed: number;
    pendingRetry: readonly string[];
  }>;
  lint: Readonly<{
    runId: string | null;
    /** 周期 Lint 已执行的步数。 */
    steps: number;
    scannedObjects: number;
    issuesCreated: number;
    issuesDeduplicated: number;
    issuesAutoResolved: number;
    repairsApplied: number;
    openIssues: number;
  }>;
  /** 本轮实际改动（编译成功）的 Source id（「改动文件」；来自 operation_log 证据）。 */
  changedSources: readonly string[];
  /** 失败摘要（run 级失败 + 回溯/健康风险）。 */
  failures: readonly KnowledgeMaintenanceFailure[];
  /** 已知风险（剩余待重试、未解决 Issue、曾失败等）。 */
  risks: readonly string[];
}>;

/** start/status/pause/resume 的读模型投影。 */
export type KnowledgeMaintenanceStatusView = Readonly<{
  run: KnowledgeMaintenanceRun | null;
  backfill: KnowledgeMaintenanceBackfillSummary;
  lint: KnowledgeMaintenanceLintSummary;
  report: KnowledgeMaintenanceReport | null;
}>;

export type KnowledgeMaintenanceStartInput = Readonly<{
  batchLimit?: number;
  maxTopicsPerSource?: number;
  stallLimit?: number;
}>;

export type KnowledgeMaintenanceStartResult = Readonly<{
  run: KnowledgeMaintenanceRun;
  /** true = 本次新建了 run；false = 返回既有活动 run（幂等）。 */
  created: boolean;
}>;

export type KnowledgeMaintenanceStepResult = Readonly<{
  run: KnowledgeMaintenanceRun;
  changed: boolean;
  done: boolean;
  failed: boolean;
}>;
