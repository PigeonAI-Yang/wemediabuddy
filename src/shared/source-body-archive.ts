// WMB-5269: Source 正文自动归档 UI 共享契约（资料库「采集异常」失败读模型 + 重试动作）。
// 纯类型 + 纯函数，无 Node 依赖；main / preload / renderer / tests 共用本文件为唯一权威。
// 数据语义以 docs/spark/2026-08-15-automatic-source-body-archive-design.md §8/§9/§11/§12 为准：
// - 失败读模型来自 source_body_capture_jobs（status IN ('needs_review','unavailable')），
//   不是独立 failures 表；attempts 时间线在 source_body_capture_attempts（按 jobId 查）。
// - retryable=false（安全拦截/明确失效/登录验证码/政策禁止）绝不进入 reason/all 批量重试；
//   selected 显式人工选择允许重试任意终态失败任务（设计 §9 人工重试新周期）。
// - 禁止在 main / renderer 各自维护第二套同名类型或 parser。

/** 渠道明确声明的完整正文候选（设计 §6：只有声明为完整文本的内容才能传入 full_text）。 */
export type SourceBodyCandidate = Readonly<{
  kind: 'full_text';
  text: string;
  contentType: string;
  origin: string;
}>;

// ---------------------------------------------------------------------------
// IPC 通道（主进程注册 + preload 消费同一常量）
// ---------------------------------------------------------------------------

export const SOURCES_LIST_BODY_CAPTURE_FAILURES_IPC_CHANNEL = 'sources:list-body-capture-failures' as const;
export const SOURCES_RETRY_BODY_CAPTURE_FAILURES_IPC_CHANNEL = 'sources:retry-body-capture-failures' as const;

// ---------------------------------------------------------------------------
// 原因分类（设计 §12 聚合维度：原因码 → 域名 → 渠道）
// ---------------------------------------------------------------------------

export const SOURCE_BODY_REASON_CATEGORIES = [
  'security',
  'http',
  'network',
  'auth',
  'content',
  'policy',
  'no_source',
  'unknown'
] as const;
export type SourceBodyReasonCategory = (typeof SOURCE_BODY_REASON_CATEGORIES)[number];

/** 任务状态（设计 §8 状态机；read model 只暴露终态失败行）。 */
export const SOURCE_BODY_CAPTURE_JOB_STATUSES = [
  'pending',
  'running',
  'retry_wait',
  'ready',
  'needs_review',
  'unavailable'
] as const;
export type SourceBodyCaptureJobStatus = (typeof SOURCE_BODY_CAPTURE_JOB_STATUSES)[number];

/** 抓取方式（设计 §11：channel_text / static_http / none）。 */
export const SOURCE_BODY_FETCH_METHODS = ['channel_text', 'static_http', 'none'] as const;
export type SourceBodyFetchMethod = (typeof SOURCE_BODY_FETCH_METHODS)[number];

/** 任务优先级（设计 §8：new_source 永远优先于 historical_backfill）。 */
export const SOURCE_BODY_CAPTURE_PRIORITIES = ['new_source', 'historical_backfill'] as const;
export type SourceBodyCapturePriority = (typeof SOURCE_BODY_CAPTURE_PRIORITIES)[number];

// ---------------------------------------------------------------------------
// 失败读模型（设计 §12 异常中心行；列表 + 单条 attempts 时间线）
// ---------------------------------------------------------------------------

export type SourceBodyCaptureFailure = Readonly<{
  jobId: string;
  sourceId: string;
  title: string;
  url: string | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  reasonCategory: SourceBodyReasonCategory | null;
  retryable: boolean;
  failedAt: string;
  domain: string | null;
  channel: string | null;
  fetchMethod: SourceBodyFetchMethod | null;
  lastHttpStatus: number | null;
}>;

export type SourceBodyCaptureFailureListInput = Readonly<{
  reasonCategory?: SourceBodyReasonCategory | null;
  limit?: number;
  cursor?: string | null;
}>;

export type SourceBodyCaptureFailureListResult = Readonly<{
  items: SourceBodyCaptureFailure[];
  nextCursor: string | null;
}>;

export type SourceBodyCaptureRetryInput = Readonly<{
  scope: 'selected' | 'reason' | 'all';
  jobIds?: string[];
  reasonCategory?: SourceBodyReasonCategory | null;
}>;

export type SourceBodyCaptureRetryResult = Readonly<{
  retried: number;
  excluded: number;
  excludedJobIds: string[];
}>;

/** 单条失败任务的 3 次尝试时间线（设计 §12「三次尝试时间线」；attempt 1-based）。 */
export type SourceBodyCaptureAttempt = Readonly<{
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  fetchMethod: SourceBodyFetchMethod | null;
  /** 设计 §11 诊断：Content-Type（如有）。 */
  contentType: string | null;
  /** 设计 §11 诊断：已提取字符数。 */
  extractedChars: number | null;
  /** 设计 §11 诊断：最终 URL（重定向后）。 */
  finalUrl: string | null;
  /** 设计 §11 诊断：重定向链摘要。 */
  redirectChain: string[] | null;
}>;

// ---------------------------------------------------------------------------
// 纯分类/文案（renderer 与测试共享单一实现）
// ---------------------------------------------------------------------------

export const SOURCE_BODY_STATUS_LABELS: Readonly<Record<SourceBodyCaptureJobStatus, string>> = {
  pending: '正文归档中',
  running: '正文归档中',
  retry_wait: '等待重试',
  ready: '正文已保存',
  needs_review: '正文归档失败',
  unavailable: '缺少正文来源'
};

export const SOURCE_BODY_REASON_CATEGORY_LABELS: Readonly<Record<SourceBodyReasonCategory, string>> = {
  security: '安全拦截',
  http: 'HTTP 错误',
  network: '网络错误',
  auth: '登录或验证',
  content: '内容不可用',
  policy: '政策限制',
  no_source: '缺少正文来源',
  unknown: '未知错误'
};

export const SOURCE_BODY_FETCH_METHOD_LABELS: Readonly<Record<SourceBodyFetchMethod, string>> = {
  channel_text: '渠道文本',
  static_http: '网页抓取',
  none: '无'
};

/** 任务状态中文文案（用户可见，非工程术语）。 */
export function sourceBodyStatusLabel(status: SourceBodyCaptureJobStatus | string | null | undefined): string {
  if (status && status in SOURCE_BODY_STATUS_LABELS) return SOURCE_BODY_STATUS_LABELS[status as SourceBodyCaptureJobStatus];
  return '未知状态';
}

/** 原因分类中文文案。 */
export function sourceBodyReasonCategoryLabel(category: SourceBodyReasonCategory | string | null | undefined): string {
  if (category && category in SOURCE_BODY_REASON_CATEGORY_LABELS) return SOURCE_BODY_REASON_CATEGORY_LABELS[category as SourceBodyReasonCategory];
  return '未知分类';
}

/** 抓取方式中文文案。 */
export function sourceBodyFetchMethodLabel(method: SourceBodyFetchMethod | string | null | undefined): string {
  if (method && method in SOURCE_BODY_FETCH_METHOD_LABELS) return SOURCE_BODY_FETCH_METHOD_LABELS[method as SourceBodyFetchMethod];
  return '未知方式';
}
