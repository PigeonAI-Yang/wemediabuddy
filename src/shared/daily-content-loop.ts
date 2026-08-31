/**
 * WMB-5330 Zhihu hot question driven daily content loop — frozen contracts (M-5330 foundation only).
 * No runtime behavior; interfaces frozen for WMB-5331..5337.
 * Design: docs/spark/2026-08-22-zhihu-hot-question-content-loop-PLAN.md
 */

export const ZHIHU_HOT_SCAN_COMMAND = 'intelligence.zhihu_hot.scan' as const;

export const DAILY_CONTENT_CYCLE_ENSURE_COMMAND = 'daily_content_cycle.ensure' as const;
export const DAILY_CONTENT_CYCLE_PAUSE_COMMAND = 'daily_content_cycle.pause' as const;
export const DAILY_CONTENT_CYCLE_RESUME_COMMAND = 'daily_content_cycle.resume' as const;

export const DAILY_CONTENT_TARGET_SELECT_COMMAND = 'daily_content_target.select' as const;
export const DAILY_CONTENT_TARGET_REPLACE_COMMAND = 'daily_content_target.replace' as const;
export const DAILY_CONTENT_TARGET_SKIP_COMMAND = 'daily_content_target.skip' as const;
export const DAILY_CONTENT_TARGET_CARRY_COMMAND = 'daily_content_target.carry' as const;
export const DAILY_CONTENT_TARGET_TRANSITION_COMMAND = 'daily_content_target.transition' as const;
export const DAILY_ITERATION_DRAFT_ENSURE_COMMAND = 'daily_iteration.draft_ensure' as const;
export const DAILY_ITERATION_PUBLISHED_ENSURE_COMMAND = 'daily_iteration.published_ensure' as const;
export const DAILY_ITERATION_VERSION_CREATE_COMMAND = 'daily_iteration.version_create' as const;
export const DAILY_ITERATION_PROJECTION_COMMAND = 'daily_iteration.projection' as const;

export const CONTENT_DERIVATIVE_ENSURE_COMMAND = 'content_derivative.ensure' as const;
export const CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND = 'content_derivative.save_version' as const;
export const CONTENT_DERIVATIVE_FINALIZE_VERSION_COMMAND = 'content_derivative.finalize_version' as const;

export const DAILY_CONTENT_LOOP_COMMANDS = Object.freeze([
  ZHIHU_HOT_SCAN_COMMAND,
  DAILY_CONTENT_CYCLE_ENSURE_COMMAND,
  DAILY_CONTENT_CYCLE_PAUSE_COMMAND,
  DAILY_CONTENT_CYCLE_RESUME_COMMAND,
  DAILY_CONTENT_TARGET_SELECT_COMMAND,
  DAILY_CONTENT_TARGET_REPLACE_COMMAND,
  DAILY_CONTENT_TARGET_SKIP_COMMAND,
  DAILY_CONTENT_TARGET_CARRY_COMMAND,
  DAILY_CONTENT_TARGET_TRANSITION_COMMAND,
  DAILY_ITERATION_DRAFT_ENSURE_COMMAND,
  DAILY_ITERATION_PUBLISHED_ENSURE_COMMAND,
  DAILY_ITERATION_VERSION_CREATE_COMMAND,
  DAILY_ITERATION_PROJECTION_COMMAND,
  CONTENT_DERIVATIVE_ENSURE_COMMAND,
  CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND,
  CONTENT_DERIVATIVE_FINALIZE_VERSION_COMMAND
] as const);

export type DailyContentLoopCommand = (typeof DAILY_CONTENT_LOOP_COMMANDS)[number];

export type ZhihuHotObservationStatus = 'collected';
export type DailyCycleStatus = 'pending' | 'running' | 'needs_user' | 'completed' | 'partial' | 'paused' | 'failed';
export type DailyTargetKind = 'new_content' | 'draft_revision' | 'published_revision';
export type DailyTargetSelectionMode = 'automatic' | 'owner_approved' | 'carried';
export type DailyTargetStatus = 'proposed' | 'selected' | 'researching' | 'drafting' | 'article_ready' | 'scripting' | 'completed' | 'blocked' | 'skipped' | 'carried';

export type ContentDerivativeKind = 'video_script';
export type ContentDerivativeVersionStatus = 'draft' | 'ready';
export type ContentDerivativeVersionAuthor = 'ai' | 'user';

export type ScoreSnapshot = Readonly<{
  total: number;
  audienceFit: number;
  viewpointRoom: number;
  evidenceAvailability: number;
  timelinessLifecycle: number;
  articleVideoTransfer: number;
  executionCost: number;
  risks: readonly string[];
  proposalReason?: string;
}>;

export type FormatDecision = Readonly<{
  goal: string;
  audience: string;
  suitableForm: string;
  reason: string;
  durationRange?: string;
  narrativeStructure: string;
  visualDensity: string;
  paceAndTone: string;
  needsPresence?: boolean;
  needsDemo?: boolean;
}>;

export const FORMAT_DECISION_REQUIRED_FIELDS = Object.freeze(['goal','audience','suitableForm','reason','narrativeStructure','visualDensity','paceAndTone'] as const);
export type FormatDecisionField = typeof FORMAT_DECISION_REQUIRED_FIELDS[number];
export function isValidFormatDecision(value: unknown): value is FormatDecision {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  for (const f of FORMAT_DECISION_REQUIRED_FIELDS) {
    if (typeof v[f] !== 'string' || !(v[f] as string).trim()) return false;
  }
  if (typeof (v as FormatDecision).suitableForm !== 'string' || !(v as FormatDecision).suitableForm.trim()) return false;
  return true;
}
export function parseFormatDecisionJson(json: string): FormatDecision {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw Object.assign(new Error('formatDecision 非法 JSON'), { code: 'VALIDATION_ERROR' }); }
  if (!isValidFormatDecision(parsed)) throw Object.assign(new Error('formatDecision 缺少必填字段'), { code: 'VALIDATION_ERROR', details: { required: [...FORMAT_DECISION_REQUIRED_FIELDS] } });
  return parsed as FormatDecision;
}
export function buildAdaptiveFormatDecision(input: { title: string; body: string; audience?: string }): FormatDecision {
  const title = (input.title ?? '').trim();
  const body = (input.body ?? '').trim();
  const len = body.length;
  const hasSteps = /步骤|教程|如何|指南|流程/.test(body+title);
  const hasStory = /故事|案例|经历|当年|曾经/.test(body+title);
  const hasOpinion = /观点|我认为|判断|立场|争议/.test(body+title);
  const hasData = /数据|研究|报告|统计|证据/.test(body+title);
  let suitableForm: string;
  let narrativeStructure: string;
  let visualDensity: string;
  let paceAndTone: string;
  let durationRange: string;
  let needsPresence = false;
  let needsDemo = false;
  if (hasSteps && len > 800) {
    suitableForm = '教程型长视频讲解';
    narrativeStructure = '问题-原理-分步演示-总结';
    visualDensity = '高密度屏幕演示+关键步骤特写';
    paceAndTone = '清晰、节奏适中、强调实操';
    durationRange = '6-10分钟';
    needsPresence = false;
    needsDemo = true;
  } else if (hasStory) {
    suitableForm = '故事型短视频';
    narrativeStructure = '钩子-冲突-转折-结论';
    visualDensity = '中等画面叙事+字幕要点';
    paceAndTone = '叙事感、情绪递进';
    durationRange = '2-4分钟';
    needsPresence = true;
    needsDemo = false;
  } else if (hasOpinion && hasData) {
    suitableForm = '观点独白+证据可视化';
    narrativeStructure = '立场-证据-机制-行动建议';
    visualDensity = '中高密度图表/引用卡片';
    paceAndTone = '坚定、论证型';
    durationRange = '3-5分钟';
    needsPresence = true;
    needsDemo = false;
  } else if (len > 2000) {
    suitableForm = '长视频深度讲解';
    narrativeStructure = '背景-拆解-案例-结论';
    visualDensity = '中高密度图文+章节卡';
    paceAndTone = '沉稳、分章节递进';
    durationRange = '8-12分钟';
    needsPresence = false;
    needsDemo = false;
  } else if (len < 600) {
    suitableForm = '短视频口播';
    narrativeStructure = '钩子-要点三段-收束';
    visualDensity = '低密度人像+要点字幕';
    paceAndTone = '轻快、直接';
    durationRange = '60-90秒';
    needsPresence = true;
    needsDemo = false;
  } else {
    suitableForm = '解释型中视频';
    narrativeStructure = '问题-分析-结论';
    visualDensity = '中等信息图+字幕';
    paceAndTone = '清晰、稳定';
    durationRange = '3-6分钟';
    needsPresence = false;
    needsDemo = false;
  }
  const goal = `将《${title || '本文'}》的核心观点转化为适合${suitableForm}的表达`;
  const audience = input.audience?.trim() || '对该话题有关注的创作者与从业者';
  const reason = `基于正文长度${len}字、${hasSteps ? '含教程要素' : hasStory ? '含故事要素' : hasOpinion ? '含观点论证' : '通用解释'}，正文结构与受众匹配度分析选择${suitableForm}；该形态能最大化保留原文事实与核心观点。`;
  return {
    goal,
    audience,
    suitableForm,
    reason,
    durationRange,
    narrativeStructure,
    visualDensity,
    paceAndTone,
    needsPresence,
    needsDemo,
  };
}
export type StudioDualReadiness = 'no_article' | 'article_ready' | 'script_draft' | 'script_ready' | 'stale';
export type StudioDualProjection = Readonly<{
  projectId: string;
  article: { latestVersionId: string | null; status: string | null; versionCount: number };
  derivative: { id: string | null; latestVersion: Record<string, unknown> | null; isStale: boolean; readiness: StudioDualReadiness };
  compare: { articleVersionId: string | null; scriptSourceVersionId: string | null; isAligned: boolean };
}>;

export const DAILY_CONTENT_CYCLE_STATUSES: readonly DailyCycleStatus[] = Object.freeze(['pending','running','needs_user','completed','partial','paused','failed'] as const);
export const DAILY_TARGET_KINDS: readonly DailyTargetKind[] = Object.freeze(['new_content','draft_revision','published_revision'] as const);
export const CONTENT_DERIVATIVE_KINDS: readonly ContentDerivativeKind[] = Object.freeze(['video_script'] as const);
