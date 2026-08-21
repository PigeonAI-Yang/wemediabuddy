// extracted from library-topics-view.tsx (structural split)
import type { DossierCategory, DossierCounts, TopicStatusFilter } from './library-topics-helpers';

export const LIST_LIMIT = 50;
export const SEGMENT_LIMIT = 50;
export const DEEP_LIMIT = 50;
export const QUERY_DEBOUNCE_MS = 220;
export const WIDE_RAIL_MQ = '(min-width: 1400px)';

export const EMPTY_COUNTS: DossierCounts = {
  sources: 0,
  judgments: 0,
  audience_demands: 0,
  counter_evidence: 0,
  content_history: 0,
  metrics: 0,
  reviews: 0,
  method_findings: 0,
};

export const DOSSIER_CATEGORY_ORDER: DossierCategory[] = [
  'sources',
  'judgments',
  'audience_demands',
  'counter_evidence',
  'content_history',
  'metrics',
  'reviews',
  'method_findings',
];

export const DOSSIER_LABELS: Record<DossierCategory, string> = {
  sources: '资料',
  judgments: '当前判断',
  audience_demands: '受众需求',
  counter_evidence: '反证',
  content_history: '内容历史',
  metrics: '指标',
  reviews: '复盘',
  method_findings: '方法结论',
};

export const STATUS_FILTERS: Array<{ id: TopicStatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '活跃' },
  { id: 'watching', label: '观察' },
  { id: 'dormant', label: '休眠' },
];

export const OPEN_TOPIC_EVENT = 'wmb-open-library-topic';

// WMB-5212 M3：Topic Wiki 默认详情（Wiki-first 原位改造，设计 existing-knowledge-surfaces §3.2）。
// 顺序即详情页段落顺序：当前认识 → 最近变化 → 证据 → 创作影响 → 待研究 → 完整档案 → 版本。
export const WIKI_SECTION_ORDER = ['current', 'changes', 'evidence', 'impact', 'research', 'dossier', 'versions'] as const;
export type WikiSectionId = (typeof WIKI_SECTION_ORDER)[number];

export const WIKI_SECTION_LABELS: Record<WikiSectionId, string> = {
  current: '当前认识',
  changes: '最近变化',
  evidence: '证据',
  impact: '创作影响',
  research: '待研究',
  dossier: '完整档案',
  versions: '版本',
};

// WMB-5226：四产品页签（概览/资料/变化/版本）替代七章节 sticky 导航。
// 七段章节 DOM 全部保留，仅按页签投影显隐；键盘 1–7 与深链接仍直达章节。
export const WIKI_TAB_ORDER = ['overview', 'sources', 'changes', 'versions'] as const;
export type WikiTabId = (typeof WIKI_TAB_ORDER)[number];

export const WIKI_TAB_LABELS: Record<WikiTabId, string> = {
  overview: '概览',
  sources: '资料',
  changes: '变化',
  versions: '版本',
};

// 键盘/深链接：章节 → 所属页签（跨页签跳转时先切页签再滚动）。
export const WIKI_SECTION_TAB: Record<WikiSectionId, WikiTabId> = {
  current: 'overview',
  changes: 'changes',
  evidence: 'sources',
  impact: 'sources',
  research: 'sources',
  dossier: 'sources',
  versions: 'versions',
};

export const WIKI_DETAIL_LIMITS = {
  versionsLimit: 30,
  receiptsLimit: 10,
  evidenceLimit: 30,
  questionsLimit: 30,
  healthLimit: 20,
  usageLimit: 20,
} as const;

export const COMPILE_STATUS_LABELS: Record<string, string> = {
  current: '已整理',
  stale: '有新资料待更新',
  compiling: '正在整理新资料',
  failed: '整理失败',
};

// WMB-5233：诚实三态用户语言（uncompiled / legacy_shell / compiled）。
// legacy_shell = 历史初始化（migration/derived-from-legacy）创建的初始页，零采纳知识；
// WMB-5242：统一整理语言（compiled→已整理 / uncompiled→尚未整理 / legacy_shell→初始档案）。
export const COMPILE_STATE_LABELS: Record<string, string> = { uncompiled: '等待整理', legacy_shell: '初始档案', compiled: '已整理' }

export const COMPILE_STATE_HINTS: Record<string, string> = {
  uncompiled: '本主题还没有整理出当前认识：继续保存可靠来源，资料员会把可验证、可复用的部分持续整理到这里。',
  legacy_shell: '本页由历史资料迁移自动建立（初始档案），还没有形成正式认识：继续保存来源，将逐步整理出当前认识。',
  compiled: '',
};

export const CONCLUSION_STATUS_LABELS: Record<string, string> = {
  unverified: '未核验',
  supported: '已支持',
  disputed: '有争议',
  contradicted: '已反驳',
  superseded: '已替代',
  not_applicable: '不适用',
  inference: '推断',
};

export const CONCLUSION_STATUS_CLASS: Record<string, string> = {
  supported: 'ok',
  disputed: 'warn',
  contradicted: 'danger',
  superseded: 'gray',
  inference: 'info',
};

export const EVIDENCE_LEVEL_LABELS: Record<string, string> = {
  none: '无证据',
  single: '单源',
  corroborated: '多源印证',
  primary: '一手',
  outcome_observed: '结果观察',
  mixed: '混合',
  insufficient: '不足',
};

export const EVIDENCE_RELATION_LABELS: Record<string, string> = {
  supports: '支持',
  contradicts: '反驳',
  qualifies: '限定',
  derived_from: '派生',
};

export const SOURCE_NATURE_LABELS: Record<string, string> = {
  primary_source: '一手来源',
  secondary_source: '二手来源',
  user_statement: '用户陈述',
  user_experience: '用户经验',
  business_record: '业务记录',
  performance_observation: '表现观察',
  review: '复盘',
  derived_knowledge: '派生知识',
  ai_inference: 'AI 推断',
};

export const USAGE_KIND_LABELS: Record<string, string> = {
  quoted: '引用',
  paraphrased: '转述',
  reasoning_basis: '推理依据',
  structure_pattern: '结构模式',
  avoided_due_to_risk: '因风险规避',
  rejected_by_user: '被用户拒绝',
  consulted: '仅参考',
};

export const USAGE_OUTPUT_LABELS: Record<string, string> = {
  source_item: '资料',
  topic_proposal: '选题提案',
  creative_brief: '创作简报',
  plan_item: '计划项',
  content_version: '内容版本',
  platform_version: '平台版本',
  review: '复盘',
  publication: '发布',
};

export const RISK_KIND_LABELS: Record<string, string> = {
  disputed: '有争议',
  contradicted: '已反驳',
  inference: '推断',
  stale: '已过期',
  unverified: '未核验',
  scope_mismatch: '范围不符',
};

export const HEALTH_TYPE_LABELS: Record<string, string> = {
  stale_claim: '过期结论',
  unresolved_contradiction: '未决矛盾',
  unsupported_claim: '无支撑结论',
  duplicate_entity: '重复实体',
  duplicate_knowledge: '重复知识',
  orphan_knowledge: '孤立知识',
  missing_wiki_page: '尚未整理',
  stale_wiki_page: '有新资料待更新',
  broken_reference: '失效引用',
  unreturned_review: '复盘未回流',
  underperforming_method: '方法表现不佳',
  overgeneralized_global: '过度泛化',
  unanswered_high_value_question: '高价值问题未答',
};

export const HEALTH_STATUS_LABELS: Record<string, string> = {
  open: '未解决',
  repairing: '修复中',
  resolved: '已解决',
  accepted_risk: '接受风险',
  false_positive: '误报',
};

export const RECEIPT_TRIGGER_LABELS: Record<string, string> = {
  ingest: '资料更新',
  query: 'Pi 对话',
  lint: '整理检查',
  creation: '创作回流',
  review: '复盘回流',
  migration: '档案初始化',
};

export const RECEIPT_COUNT_LABELS: Record<string, string> = {
  entitiesCreated: '新建实体',
  entitiesMatched: '匹配实体',
  notesCreated: '新增知识',
  notesUpdated: '更新知识',
  notesSkippedLowValue: '跳过低价值',
  noteVersionsCreated: '新增版本',
  evidenceLinks: '证据链',
  wikiPagesCompiled: '更新主题',
  restatements: '纯复述',
  skippedRepetition: '跳过复述',
  skippedLowValue: '跳过低价值',
  skippedTransient: '跳过瞬时',
  freeNotesCaptured: '自由记录',
  usageRecords: '使用记录',
};

