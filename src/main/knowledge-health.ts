/**
 * WMB-5216 M7：知识健康（Health owner slice）。
 * Design: docs/spark/2026-08-12-wmb-outcome-feedback-knowledge-health-design.md §6–§9/§12–§13
 * 契约: docs/spark/2026-08-12-wmb-knowledge-object-version-contract-design.md §26/§27
 *
 * 本模块为协作模块的公共入口与编排门面（structural split）：
 * 具体实现已拆分至同目录的 knowledge-health-*.ts 协作模块，主文件保留公共导出与编排。
 * 所有导出符号、props 合同、IPC 调用、行为均与拆分前保持一致。
 */
export {
  KnowledgeHealthError,
  KNOWLEDGE_HEALTH_ERROR_CODES,
  KNOWLEDGE_HEALTH_DETECTOR_VERSION,
  KNOWLEDGE_HEALTH_LINT_CHANNEL_REASON,
  DATA_GAP_FREE_NOTE_MAX_AGE_DAYS,
  KNOWLEDGE_HEALTH_DETECTORS,
  KNOWLEDGE_HEALTH_HOOK_MAX_OBJECTS_PER_SCOPE,
} from './knowledge-health-types.ts';

export type {
  HealthLintDetector,
  HealthLintPhase,
  HealthLintObjectRef,
  HealthLintIssuePlan,
  HealthLintCounts,
  KnowledgeHealthCheckpoint,
  BeginPeriodicLintInput,
  KnowledgeHealthLintInput,
  KnowledgeHealthLintResult,
  KnowledgeHealthPeriodicStepResult,
} from './knowledge-health-types.ts';

export {
  reviewOutcomeRequestId,
} from './knowledge-health-detectors.ts';

export {
  localLintRequestId,
  runLocalLint,
} from './knowledge-health-local.ts';

export {
  getPeriodicLintCheckpoint,
  beginPeriodicLint,
  cancelPeriodicLint,
  runPeriodicLintStep,
} from './knowledge-health-periodic.ts';

export {
  registerKnowledgeChangeSetLintTrigger,
  KNOWLEDGE_LINT_JOB_KIND,
  PERIODIC_LINT_STEP_BUDGET,
  PERIODIC_LINT_INTERVAL_MS,
  PERIODIC_LINT_FIRST_DELAY_MS,
  PERIODIC_LINT_RETRY_AFTER_MS,
  schedulePeriodicLintJob,
  recoverOrRetryPeriodicLintJobs,
  runDuePeriodicLintJobs,
  KnowledgeLintScheduler,
} from './knowledge-health-scheduler.ts';
