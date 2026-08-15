import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspaceStorageKey } from './workspace-storage'; import { TopicMaintenanceLedger } from './topic-maintenance-ledger.tsx';
import { severityLabel } from './knowledge-canvas-projection';
import { SourceMark } from './source-mark';
// WMB-5239：共享搜索/日志 hooks 与深链分发（单源 IPC；topicId 限定当前主题范围）。
import {
  dispatchWikiDeepLink,
  dispatchWikiLogEntry,
  formatWikiWhen,
  useKnowledgeLog,
  useWikiIndexSummary,
  useWikiSearch,
  wikiLogEntryDeepLinkInput,
  wikiLogEventLabel,
  wikiLogObjectLabel,
  wikiSearchObjectLabel,
} from './wiki-discovery';
// WMB-5239：主题页特有展示策略（与回执时间线重叠过滤、索引状态提示）。
import { isTopicLogSupplementary, topicIndexStatusLabel } from './topic-search-log';
import type {
  KnowledgeCompileStatus,
  KnowledgeHealthIssueRecord,
  KnowledgeUpdateReceiptRecord,
  KnowledgeUsageRecordRecord,
  KnowledgeWikiPageRecord,
  KnowledgeWikiPageVersionRecord
} from '../shared/knowledge-flywheel';
import type { KnowledgeCompileState } from '../shared/knowledge-compile-state';
import type {
  TopicWikiBody,
  TopicWikiDetail,
  TopicWikiDossierCounts,
  TopicWikiKeyConclusion,
  TopicEvidenceEntry
} from '../shared/knowledge-topic-library';
export type LibraryTopicPiContext = { id: string; title: string } | null;

type TopicStatus = 'active' | 'watching' | 'dormant' | string;
type TopicStatusFilter = 'all' | 'active' | 'watching' | 'dormant';

type TopicListItem = {
  id: string;
  title: string;
  summary?: string | null;
  status?: TopicStatus | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  sourceCount?: number | null;
  opportunityCount?: number | null;
  contentCount?: number | null;
  publicationCount?: number | null;
  // WMB-5233：诚实三态（uncompiled / legacy_shell / compiled）。
  compileState?: string | null;
};

type TopicListPage = {
  items: TopicListItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

type DossierCategory =
  | 'sources'
  | 'judgments'
  | 'audience_demands'
  | 'counter_evidence'
  | 'content_history'
  | 'metrics'
  | 'reviews'
  | 'method_findings';

type DossierCounts = Record<DossierCategory, number>;

type DossierMetadata = {
  relation?: string;
  verificationStatus?: string;
  managementStatus?: string;
  whyNow?: string;
  timeliness?: string;
  status?: string;
  archived?: boolean;
  publicationId?: string;
  sourceUrl?: string;
  originalUrl?: string;
  revision?: number;
  keep?: string;
  stop?: string;
  change?: string;
  reviewId?: string;
  [key: string]: unknown;
};

type DossierItem = {
  category: DossierCategory | string;
  objectId: string;
  objectType: string;
  title: string;
  body?: string | null;
  occurredAt?: string | null;
  metadata?: DossierMetadata | null;
};

type DossierTopic = {
  id: string;
  title: string;
  kind?: string | null;
  summary?: string | null;
  status?: TopicStatus | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  revision?: number;
};

type DossierPage = {
  topic: DossierTopic;
  counts: DossierCounts;
  items: DossierItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

type ContextOpportunity = {
  id: string;
  title: string;
  priority: number | null;
  planDate: string | null;
};

type KnowledgeContextPage = {
  opportunities: ContextOpportunity[];
};

type WorkspaceSegment = 'judgments' | 'sources' | 'outcomes';
type VerificationStatus = 'pending' | 'verified' | 'disputed' | 'rejected';
type ManagementStatus = 'active' | 'watching' | 'expired' | 'archived';

const LIST_LIMIT = 50;
const SEGMENT_LIMIT = 50;
const DEEP_LIMIT = 50;
const QUERY_DEBOUNCE_MS = 220;
const WIDE_RAIL_MQ = '(min-width: 1400px)';

const EMPTY_COUNTS: DossierCounts = {
  sources: 0,
  judgments: 0,
  audience_demands: 0,
  counter_evidence: 0,
  content_history: 0,
  metrics: 0,
  reviews: 0,
  method_findings: 0,
};

const DOSSIER_CATEGORY_ORDER: DossierCategory[] = [
  'sources',
  'judgments',
  'audience_demands',
  'counter_evidence',
  'content_history',
  'metrics',
  'reviews',
  'method_findings',
];

const DOSSIER_LABELS: Record<DossierCategory, string> = {
  sources: '资料',
  judgments: '当前判断',
  audience_demands: '受众需求',
  counter_evidence: '反证',
  content_history: '内容历史',
  metrics: '指标',
  reviews: '复盘',
  method_findings: '方法结论',
};

const STATUS_FILTERS: Array<{ id: TopicStatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '活跃' },
  { id: 'watching', label: '观察' },
  { id: 'dormant', label: '休眠' },
];

const OPEN_TOPIC_EVENT = 'wmb-open-library-topic';

// WMB-5212 M3：Topic Wiki 默认详情（Wiki-first 原位改造，设计 existing-knowledge-surfaces §3.2）。
// 顺序即详情页段落顺序：当前认识 → 最近变化 → 证据 → 创作影响 → 待研究 → 完整档案 → 版本。
const WIKI_SECTION_ORDER = ['current', 'changes', 'evidence', 'impact', 'research', 'dossier', 'versions'] as const;
type WikiSectionId = (typeof WIKI_SECTION_ORDER)[number];

const WIKI_SECTION_LABELS: Record<WikiSectionId, string> = {
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
const WIKI_TAB_ORDER = ['overview', 'sources', 'changes', 'versions'] as const;
type WikiTabId = (typeof WIKI_TAB_ORDER)[number];

const WIKI_TAB_LABELS: Record<WikiTabId, string> = {
  overview: '概览',
  sources: '资料',
  changes: '变化',
  versions: '版本',
};

// 键盘/深链接：章节 → 所属页签（跨页签跳转时先切页签再滚动）。
const WIKI_SECTION_TAB: Record<WikiSectionId, WikiTabId> = {
  current: 'overview',
  changes: 'changes',
  evidence: 'sources',
  impact: 'sources',
  research: 'sources',
  dossier: 'sources',
  versions: 'versions',
};

const WIKI_DETAIL_LIMITS = {
  versionsLimit: 30,
  receiptsLimit: 10,
  evidenceLimit: 30,
  questionsLimit: 30,
  healthLimit: 20,
  usageLimit: 20,
} as const;

const COMPILE_STATUS_LABELS: Record<string, string> = {
  current: '已整理',
  stale: '有新资料待更新',
  compiling: '正在整理新资料',
  failed: '整理失败',
};

// WMB-5233：诚实三态用户语言（uncompiled / legacy_shell / compiled）。
// legacy_shell = 历史初始化（migration/derived-from-legacy）创建的初始页，零采纳知识；
// WMB-5242：统一整理语言（compiled→已整理 / uncompiled→尚未整理 / legacy_shell→初始档案）。
const COMPILE_STATE_LABELS: Record<string, string> = { uncompiled: '等待整理', legacy_shell: '初始档案', compiled: '已整理' }

const COMPILE_STATE_HINTS: Record<string, string> = {
  uncompiled: '本主题还没有整理出当前认识：继续保存可靠来源，资料员会把可验证、可复用的部分持续整理到这里。',
  legacy_shell: '本页由历史资料迁移自动建立（初始档案），还没有形成正式认识：继续保存来源，将逐步整理出当前认识。',
  compiled: '',
};

const CONCLUSION_STATUS_LABELS: Record<string, string> = {
  unverified: '未核验',
  supported: '已支持',
  disputed: '有争议',
  contradicted: '已反驳',
  superseded: '已替代',
  not_applicable: '不适用',
  inference: '推断',
};

const CONCLUSION_STATUS_CLASS: Record<string, string> = {
  supported: 'ok',
  disputed: 'warn',
  contradicted: 'danger',
  superseded: 'gray',
  inference: 'info',
};

const EVIDENCE_LEVEL_LABELS: Record<string, string> = {
  none: '无证据',
  single: '单源',
  corroborated: '多源印证',
  primary: '一手',
  outcome_observed: '结果观察',
  mixed: '混合',
  insufficient: '不足',
};

const EVIDENCE_RELATION_LABELS: Record<string, string> = {
  supports: '支持',
  contradicts: '反驳',
  qualifies: '限定',
  derived_from: '派生',
};

const SOURCE_NATURE_LABELS: Record<string, string> = {
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

const USAGE_KIND_LABELS: Record<string, string> = {
  quoted: '引用',
  paraphrased: '转述',
  reasoning_basis: '推理依据',
  structure_pattern: '结构模式',
  avoided_due_to_risk: '因风险规避',
  rejected_by_user: '被用户拒绝',
  consulted: '仅参考',
};

const USAGE_OUTPUT_LABELS: Record<string, string> = {
  source_item: '资料',
  topic_proposal: '选题提案',
  creative_brief: '创作简报',
  plan_item: '计划项',
  content_version: '内容版本',
  platform_version: '平台版本',
  review: '复盘',
  publication: '发布',
};

const RISK_KIND_LABELS: Record<string, string> = {
  disputed: '有争议',
  contradicted: '已反驳',
  inference: '推断',
  stale: '已过期',
  unverified: '未核验',
  scope_mismatch: '范围不符',
};

const HEALTH_TYPE_LABELS: Record<string, string> = {
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

const HEALTH_STATUS_LABELS: Record<string, string> = {
  open: '未解决',
  repairing: '修复中',
  resolved: '已解决',
  accepted_risk: '接受风险',
  false_positive: '误报',
};

const RECEIPT_TRIGGER_LABELS: Record<string, string> = {
  ingest: '资料更新',
  query: 'Pi 对话',
  lint: '整理检查',
  creation: '创作回流',
  review: '复盘回流',
  migration: '档案初始化',
};

const RECEIPT_COUNT_LABELS: Record<string, string> = {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function normalizeMetadata(raw: unknown): DossierMetadata {
  const parsed = parseMaybeJson(raw);
  const record = asRecord(parsed) ?? {};
  const keepRaw = record.keep;
  const stopRaw = record.stop;
  const changeRaw = record.change;
  return {
    ...record,
    relation: asString(record.relation) ?? undefined,
    verificationStatus: asString(record.verificationStatus) ?? undefined,
    managementStatus: asString(record.managementStatus) ?? undefined,
    whyNow: asString(record.whyNow) ?? undefined,
    timeliness: asString(record.timeliness) ?? undefined,
    status: asString(record.status) ?? undefined,
    archived: typeof record.archived === 'boolean' ? record.archived : undefined,
    publicationId: asString(record.publicationId) ?? undefined,
    sourceUrl: asString(record.sourceUrl) ?? undefined,
    originalUrl: asString(record.originalUrl) ?? undefined,
    revision: asNumber(record.revision) ?? undefined,
    keep: typeof keepRaw === 'string' ? keepRaw : (keepRaw != null ? JSON.stringify(keepRaw) : undefined),
    stop: typeof stopRaw === 'string' ? stopRaw : (stopRaw != null ? JSON.stringify(stopRaw) : undefined),
    change: typeof changeRaw === 'string' ? changeRaw : (changeRaw != null ? JSON.stringify(changeRaw) : undefined),
    reviewId: asString(record.reviewId) ?? undefined,
  };
}

function normalizeDossierItem(raw: unknown): DossierItem | null {
  const record = asRecord(raw);
  if (!record) return null;
  const objectId = asString(record.objectId);
  const title = asString(record.title);
  if (!objectId || !title) return null;
  const metadata = record.metadata !== undefined
    ? normalizeMetadata(record.metadata)
    : record.metadataJson !== undefined
      ? normalizeMetadata(record.metadataJson)
      : null;
  return {
    category: asString(record.category) ?? 'sources',
    objectId,
    objectType: asString(record.objectType) ?? 'unknown',
    title,
    body: asString(record.body),
    occurredAt: asString(record.occurredAt),
    metadata,
  };
}

function normalizeDossierPage(raw: unknown): DossierPage | null {
  const record = asRecord(raw);
  if (!record) return null;
  const topicRecord = asRecord(record.topic);
  if (!topicRecord) return null;
  const id = asString(topicRecord.id);
  const title = asString(topicRecord.title);
  if (!id || !title) return null;
  const countsRecord = asRecord(record.counts) ?? {};
  const counts: DossierCounts = { ...EMPTY_COUNTS };
  (Object.keys(EMPTY_COUNTS) as DossierCategory[]).forEach((key) => {
    counts[key] = asNumber(countsRecord[key]) ?? 0;
  });
  const items = Array.isArray(record.items)
    ? record.items.map(normalizeDossierItem).filter((item): item is DossierItem => item !== null)
    : [];
  return {
    topic: {
      id,
      title,
      kind: asString(topicRecord.kind),
      summary: asString(topicRecord.summary),
      status: asString(topicRecord.status) ?? undefined,
      firstSeenAt: asString(topicRecord.firstSeenAt),
      lastSeenAt: asString(topicRecord.lastSeenAt),
      revision: asNumber(topicRecord.revision) ?? undefined,
    },
    counts,
    items,
    total: asNumber(record.total) ?? items.length,
    limit: asNumber(record.limit) ?? items.length,
    offset: asNumber(record.offset) ?? 0,
    hasMore: Boolean(record.hasMore),
  };
}

function normalizeTopicListItem(raw: unknown): TopicListItem | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.id);
  const title = asString(record.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    summary: asString(record.summary),
    status: asString(record.status) ?? undefined,
    firstSeenAt: asString(record.firstSeenAt),
    lastSeenAt: asString(record.lastSeenAt),
    sourceCount: asNumber(record.sourceCount) ?? 0,
    opportunityCount: asNumber(record.opportunityCount) ?? 0,
    contentCount: asNumber(record.contentCount),
    publicationCount: asNumber(record.publicationCount),
    compileState: asString(record.compileState) ?? null,
  };
}

function normalizeTopicListPage(raw: unknown): TopicListPage {
  if (Array.isArray(raw)) {
    const items = raw.map(normalizeTopicListItem).filter((item): item is TopicListItem => item !== null);
    return {
      items,
      total: items.length,
      limit: items.length,
      offset: 0,
      hasMore: false,
    };
  }
  const record = asRecord(raw);
  const rawItems = record && Array.isArray(record.items) ? record.items : [];
  const items = rawItems.map(normalizeTopicListItem).filter((item): item is TopicListItem => item !== null);
  const limit = asNumber(record?.limit) ?? LIST_LIMIT;
  const offset = asNumber(record?.offset) ?? 0;
  const total = asNumber(record?.total) ?? items.length;
  const hasMore = typeof record?.hasMore === 'boolean'
    ? record.hasMore
    : offset + items.length < total;
  return { items, total, limit, offset, hasMore };
}

function normalizeKnowledgeContext(raw: unknown): KnowledgeContextPage {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.opportunities)) return { opportunities: [] };
  const opportunities: ContextOpportunity[] = [];
  for (const item of record.opportunities) {
    const row = asRecord(item);
    if (!row) continue;
    const id = asString(row.id);
    const title = asString(row.title);
    if (!id || !title) continue;
    opportunities.push({
      id,
      title,
      priority: asNumber(row.priority),
      planDate: asString(row.planDate),
    });
  }
  return { opportunities };
}

function normalizeWikiPageRecord(raw: unknown): KnowledgeWikiPageRecord | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.id);
  const canonicalKey = asString(record.canonicalKey);
  if (!id || !canonicalKey) return null;
  return {
    id,
    scope: asString(record.scope) ?? 'global',
    pageType: asString(record.pageType) ?? 'topic',
    canonicalKey,
    title: asString(record.title) ?? canonicalKey,
    subjectType: asString(record.subjectType) ?? null,
    subjectId: asString(record.subjectId) ?? null,
    lifecycle: asString(record.lifecycle) ?? 'active',
    mergedIntoPageId: asString(record.mergedIntoPageId) ?? null,
    supersededByPageId: asString(record.supersededByPageId) ?? null,
    compileStatus: (asString(record.compileStatus) ?? 'current') as KnowledgeCompileStatus,
    compileNote: asString(record.compileNote) ?? null,
    currentVersionId: asString(record.currentVersionId) ?? null,
    revision: asNumber(record.revision) ?? 1,
    createdAt: asString(record.createdAt) ?? '',
    updatedAt: asString(record.updatedAt) ?? '',
    archivedAt: asString(record.archivedAt) ?? null,
  } as KnowledgeWikiPageRecord;
}

function normalizeWikiPageVersionRecord(raw: unknown): KnowledgeWikiPageVersionRecord | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.id);
  const pageId = asString(record.pageId);
  if (!id || !pageId) return null;
  return {
    id,
    pageId,
    versionNumber: asNumber(record.versionNumber) ?? 1,
    title: asString(record.title) ?? '',
    body: record.body ?? null,
    adoptedNoteVersionIds: Array.isArray(record.adoptedNoteVersionIds)
      ? record.adoptedNoteVersionIds.map(String).filter(Boolean)
      : [],
    businessObjectRefs: Array.isArray(record.businessObjectRefs)
      ? record.businessObjectRefs
      : [],
    flags: Array.isArray(record.flags) ? record.flags.map(String) : [],
    changeSummary: asString(record.changeSummary) ?? '',
    readableDiff: asString(record.readableDiff) ?? '',
    compileReason: asString(record.compileReason) ?? '',
    creatorNature: asString(record.creatorNature) ?? 'system',
    changeSetId: asString(record.changeSetId) ?? '',
    restoredFromVersionId: asString(record.restoredFromVersionId) ?? null,
    createdAt: asString(record.createdAt) ?? '',
  } as KnowledgeWikiPageVersionRecord;
}

function normalizeKeyConclusion(raw: unknown): TopicWikiKeyConclusion | null {
  const record = asRecord(raw);
  if (!record) return null;
  const statement = asString(record.statement);
  if (!statement) return null;
  return {
    noteId: asString(record.noteId) ?? '',
    statement,
    conclusionStatus: asString(record.conclusionStatus) ?? 'unverified',
    evidenceLevel: asString(record.evidenceLevel) ?? 'none',
    appliesTo: asString(record.appliesTo) ?? null,
    changeType: asString(record.changeType) ?? 'created',
    kind: asString(record.kind) ?? 'claim',
  } as TopicWikiKeyConclusion;
}

function normalizeTopicWikiBody(raw: unknown): TopicWikiBody | null {
  const record = asRecord(raw);
  if (!record || record.kind !== 'topic-wiki') return null;
  const keyConclusions = Array.isArray(record.keyConclusions)
    ? record.keyConclusions.map(normalizeKeyConclusion).filter((item): item is TopicWikiKeyConclusion => item !== null)
    : [];
  const retainedDisputes = Array.isArray(record.retainedDisputes)
    ? record.retainedDisputes.map(normalizeKeyConclusion).filter((item): item is TopicWikiKeyConclusion => item !== null)
    : [];
  return {
    kind: 'topic-wiki',
    title: asString(record.title) ?? '',
    summary: asString(record.summary) ?? '',
    asOf: asString(record.asOf) ?? '',
    scope: asString(record.scope) ?? 'global',
    topicId: asString(record.topicId) ?? '',
    compiledSourceIds: Array.isArray(record.compiledSourceIds) ? record.compiledSourceIds.map(String) : [],
    sourceRevision: asNumber(record.sourceRevision) ?? 0,
    keyConclusions,
    retainedDisputes,
    pendingQuestions: Array.isArray(record.pendingQuestions) ? record.pendingQuestions.map(String).filter(Boolean) : [],
    recentChanges: Array.isArray(record.recentChanges) ? record.recentChanges : [],
    versionCount: asNumber(record.versionCount) ?? 0,
  } as TopicWikiBody;
}

function normalizeEvidenceEntry(raw: unknown): TopicEvidenceEntry | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.id);
  const knowledgeNoteVersionId = asString(record.knowledgeNoteVersionId);
  if (!id || !knowledgeNoteVersionId) return null;
  return {
    id,
    knowledgeNoteVersionId,
    evidenceObjectType: asString(record.evidenceObjectType) ?? 'source',
    evidenceObjectId: asString(record.evidenceObjectId) ?? '',
    relation: asString(record.relation) ?? 'supports',
    sourceNature: asString(record.sourceNature) ?? 'secondary_source',
    excerpt: asString(record.excerpt) ?? null,
    locator: asString(record.locator) ?? null,
    observedAt: asString(record.observedAt) ?? null,
    creatorNature: asString(record.creatorNature) ?? 'system',
    changeSetId: asString(record.changeSetId) ?? '',
    createdAt: asString(record.createdAt) ?? '',
    noteStatement: asString(record.noteStatement) ?? '',
    noteConclusionStatus: asString(record.noteConclusionStatus) ?? 'unverified',
  } as TopicEvidenceEntry;
}

function normalizeUsageRecord(raw: unknown): KnowledgeUsageRecordRecord | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.id);
  if (!id) return null;
  return {
    id,
    scope: asString(record.scope) ?? 'global',
    workspaceId: asString(record.workspaceId) ?? '',
    packageId: asString(record.packageId) ?? '',
    outputObjectType: asString(record.outputObjectType) ?? 'content_version',
    outputObjectId: asString(record.outputObjectId) ?? '',
    knowledgeVersionId: asString(record.knowledgeVersionId) ?? '',
    knowledgeVersionKind: asString(record.knowledgeVersionKind) === 'note' ? 'note' : 'wiki_page',
    usageKind: asString(record.usageKind) ?? 'consulted',
    used: Boolean(record.used),
    locator: asString(record.locator) ?? null,
    reason: asString(record.reason) ?? '',
    actor: asString(record.actor) ?? '',
    evidenceId: asString(record.evidenceId) ?? null,
    createdBy: asString(record.createdBy) ?? 'system',
    createdAt: asString(record.createdAt) ?? '',
  } as KnowledgeUsageRecordRecord;
}

function normalizeHealthIssueRecord(raw: unknown): KnowledgeHealthIssueRecord | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.id);
  if (!id) return null;
  return {
    id,
    scope: asString(record.scope) ?? 'global',
    issueType: asString(record.issueType) ?? 'unsupported_claim',
    affectedObjectType: asString(record.affectedObjectType) ?? null,
    affectedObjectId: asString(record.affectedObjectId) ?? null,
    severity: asString(record.severity) ?? 'low',
    evidence: asRecord(record.evidence) ?? {},
    suggestedAction: asString(record.suggestedAction) ?? '',
    status: asString(record.status) ?? 'open',
    resolutionNote: asString(record.resolutionNote) ?? null,
    resolvedChangeSetId: asString(record.resolvedChangeSetId) ?? null,
    detectedAt: asString(record.detectedAt) ?? '',
    updatedAt: asString(record.updatedAt) ?? '',
    resolvedAt: asString(record.resolvedAt) ?? null,
    revision: asNumber(record.revision) ?? 1,
  } as KnowledgeHealthIssueRecord;
}

function normalizeReceiptRecord(raw: unknown): KnowledgeUpdateReceiptRecord | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.id);
  if (!id) return null;
  // 运行期 affected* / wikiPageVersions / autoResolutions / retainedDisputes / failures 为 string[]
  // （main mapReceiptRow parseJsonArray），与共享类型声明（record[]）存在既有出入：渲染端按 string[]
  // 归一化，仅返回类型按共享契约收窄（不做多余 JSON 猜测）。
  return {
    id,
    workspaceId: asString(record.workspaceId) ?? '',
    changeSetId: asString(record.changeSetId) ?? '',
    triggerType: asString(record.triggerType) ?? 'ingest',
    requestId: asString(record.requestId) ?? '',
    summary: asString(record.summary) ?? '',
    counts: Object.fromEntries(Object.entries(asRecord(record.counts) ?? {}).map(([key, value]) => [key, asNumber(value) ?? 0])),
    affectedTopics: Array.isArray(record.affectedTopics) ? record.affectedTopics.map(String) : [],
    affectedEntities: Array.isArray(record.affectedEntities) ? record.affectedEntities.map(String) : [],
    affectedMethods: Array.isArray(record.affectedMethods) ? record.affectedMethods.map(String) : [],
    affectedSyntheses: Array.isArray(record.affectedSyntheses) ? record.affectedSyntheses.map(String) : [],
    wikiPageVersions: Array.isArray(record.wikiPageVersions) ? record.wikiPageVersions.map(String) : [],
    impact: asRecord(record.impact) ?? {},
    autoResolutions: Array.isArray(record.autoResolutions) ? record.autoResolutions.map(String) : [],
    retainedDisputes: Array.isArray(record.retainedDisputes) ? record.retainedDisputes.map(String) : [],
    failures: Array.isArray(record.failures) ? record.failures.map(String) : [],
    createdBy: asString(record.createdBy) ?? 'system',
    createdAt: asString(record.createdAt) ?? '',
  } as unknown as KnowledgeUpdateReceiptRecord;
}

function normalizeListPage<T>(
  raw: unknown,
  normalizeItem: (item: unknown) => T | null,
): { items: T[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const record = asRecord(raw);
  const rawItems = record && Array.isArray(record.items) ? record.items : [];
  const items = rawItems.map(normalizeItem).filter((item): item is T => item !== null);
  return {
    items,
    total: asNumber(record?.total) ?? items.length,
    limit: asNumber(record?.limit) ?? items.length,
    offset: asNumber(record?.offset) ?? 0,
    hasMore: typeof record?.hasMore === 'boolean' ? record.hasMore : offsetAndTotal(record, items.length),
  };
}

function offsetAndTotal(record: Record<string, unknown> | null | undefined, itemsLength: number): boolean {
  if (!record) return false;
  const offset = asNumber(record.offset) ?? 0;
  const total = asNumber(record.total) ?? itemsLength;
  return offset + itemsLength < total;
}

function normalizeTopicWikiDetail(raw: unknown): TopicWikiDetail | null {
  const record = asRecord(raw);
  if (!record) return null;
  const topicId = asString(record.topicId);
  if (!topicId) return null;
  const topicRecord = asRecord(record.topic);
  const wikiRecord = asRecord(record.wiki);
  const wikiPage = wikiRecord ? normalizeWikiPageRecord(wikiRecord.page) : null;
  const wikiCurrent = wikiRecord ? normalizeWikiPageVersionRecord(wikiRecord.current) : null;
  const wikiBody = wikiRecord ? normalizeTopicWikiBody(wikiRecord.body) : null;
  const risksRecord = asRecord(record.risks) ?? {};
  const dossierRecord = asRecord(record.dossierCounts) ?? {};
  return {
    topicId,
    topic: topicRecord ? {
      id: asString(topicRecord.id) ?? topicId,
      title: asString(topicRecord.title) ?? '',
      canonicalKey: asString(topicRecord.canonicalKey) ?? null,
      kind: asString(topicRecord.kind) ?? null,
      summary: asString(topicRecord.summary) ?? null,
      status: asString(topicRecord.status) ?? 'active',
      firstSeenAt: asString(topicRecord.firstSeenAt) ?? '',
      lastSeenAt: asString(topicRecord.lastSeenAt) ?? '',
      revision: asNumber(topicRecord.revision) ?? 1,
      sourceCount: asNumber(topicRecord.sourceCount) ?? 0,
      opportunityCount: asNumber(topicRecord.opportunityCount) ?? 0,
      contentCount: asNumber(topicRecord.contentCount) ?? 0,
      publicationCount: asNumber(topicRecord.publicationCount) ?? 0,
    } : null,
    wiki: wikiRecord ? {
      page: wikiPage,
      current: wikiCurrent,
      body: wikiBody,
      compileStatus: (asString(wikiRecord.compileStatus) ?? null) as KnowledgeCompileStatus | null,
      compileNote: asString(wikiRecord.compileNote) ?? null,
      compileState: (asString(wikiRecord.compileState) ?? 'uncompiled') as KnowledgeCompileState,
    } : null,
    versions: normalizeListPage(record.versions, normalizeWikiPageVersionRecord),
    receipts: normalizeListPage(record.receipts, normalizeReceiptRecord),
    evidence: normalizeListPage(record.evidence, normalizeEvidenceEntry),
    questions: Array.isArray(record.questions) ? record.questions.map(String).filter(Boolean) : [],
    creationImpact: normalizeListPage(record.creationImpact, normalizeUsageRecord),
    healthIssues: normalizeListPage(record.healthIssues, normalizeHealthIssueRecord),
    dossierCounts: {
      sources: asNumber(dossierRecord.sources) ?? 0,
      judgments: asNumber(dossierRecord.judgments) ?? 0,
      audience_demands: asNumber(dossierRecord.audience_demands) ?? 0,
      counter_evidence: asNumber(dossierRecord.counter_evidence) ?? 0,
      content_history: asNumber(dossierRecord.content_history) ?? 0,
      metrics: asNumber(dossierRecord.metrics) ?? 0,
      reviews: asNumber(dossierRecord.reviews) ?? 0,
      method_findings: asNumber(dossierRecord.method_findings) ?? 0,
    } as TopicWikiDossierCounts,
    risks: {
      disputed: asNumber(risksRecord.disputed) ?? 0,
      contradicted: asNumber(risksRecord.contradicted) ?? 0,
      inference: asNumber(risksRecord.inference) ?? 0,
      stale: Boolean(risksRecord.stale),
      failed: Boolean(risksRecord.failed),
    },
  } as TopicWikiDetail;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '未知错误');
}

function topicStatusLabel(status?: string | null): string {
  if (status === 'watching') return '持续观察';
  if (status === 'dormant') return '休眠';
  if (status === 'archived') return '已归档';
  return '活跃';
}

function topicStatusClass(status?: string | null): string {
  if (status === 'watching') return 'amber';
  if (status === 'dormant' || status === 'archived') return 'gray';
  return 'green';
}

function changeTypeLabel(value?: string | null): string {
  const labels: Record<string, string> = {
    created: '新增',
    strengthened: '强化',
    weakened: '削弱',
    contradicted: '冲突',
    qualified: '限域',
    superseded: '替代',
    merged: '合并',
    promoted: '晋升',
    archived: '归档',
    rejected: '排除',
    restored: '恢复',
    recompiled: '重新整理',
  };
  return labels[value ?? ''] ?? value ?? '变化';
}

function kindLabel(value?: string | null): string {
  const labels: Record<string, string> = {
    claim: '主张',
    insight: '洞察',
    concept: '概念',
    case: '案例',
    method: '方法',
    question: '问题',
    creative_pattern: '创作模式',
  };
  return labels[value ?? ''] ?? value ?? '知识';
}

function verificationLabel(value?: string | null): string {
  if (value === 'verified') return '已核验';
  if (value === 'disputed') return '有争议';
  if (value === 'rejected') return '已排除';
  return '待核验';
}

function managementLabel(value?: string | null): string {
  if (value === 'watching') return '观察中';
  if (value === 'archived') return '已归档';
  if (value === 'expired') return '已过期';
  return '活跃';
}

function relationLabel(value?: string | null): string {
  if (value === 'contradicting') return '反证';
  if (value === 'primary') return '主证';
  if (value === 'supporting') return '佐证';
  if (!value) return '关联';
  return value;
}

function formatRelativeTime(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  if (absMs < hour) return rtf.format(Math.round(diffMs / minute), 'minute');
  if (absMs < day) return rtf.format(Math.round(diffMs / hour), 'hour');
  if (absMs < 30 * day) return rtf.format(Math.round(diffMs / day), 'day');
  return date.toLocaleDateString('zh-CN');
}

function formatWhen(value?: string | null): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN');
}

function prettyJsonish(value?: string | null): string | null {
  if (!value) return null;
  const parsed = parseMaybeJson(value);
  if (typeof parsed === 'string') return parsed.trim() || null;
  if (Array.isArray(parsed)) {
    const parts = parsed.map((item) => {
      if (typeof item === 'string') return item;
      const record = asRecord(item);
      if (record) return asString(record.text) ?? asString(record.title) ?? asString(record.body) ?? JSON.stringify(item);
      return String(item);
    }).filter(Boolean);
    return parts.length ? parts.join('；') : null;
  }
  if (parsed && typeof parsed === 'object') {
    try {
      return JSON.stringify(parsed);
    } catch {
      return String(parsed);
    }
  }
  return String(parsed);
}

function itemKey(item: DossierItem): string {
  return `${item.category}:${item.objectId}:${item.occurredAt ?? ''}`;
}

function patchSourceItem(
  item: DossierItem,
  patch: { revision: number; verificationStatus?: string; managementStatus?: string },
): DossierItem {
  return {
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      revision: patch.revision,
      verificationStatus: patch.verificationStatus ?? item.metadata?.verificationStatus,
      managementStatus: patch.managementStatus ?? item.metadata?.managementStatus,
    },
  };
}

// WMB-5242：列表卡元信息以「更新于…」和资料/创作使用为主（知识目录语义；去掉机会等管线词）。
function listTopicMeta(item: TopicListItem): string {
  const parts: string[] = [];
  const relative = formatRelativeTime(item.lastSeenAt);
  if (relative) parts.push(`更新于 ${relative}`);
  parts.push(`${item.sourceCount ?? 0} 资料`);
  if (item.contentCount != null) parts.push(`${item.contentCount} 内容`);
  if (item.publicationCount != null && item.publicationCount > 0) parts.push(`${item.publicationCount} 发布`);
  return parts.join(' · ');
}

export function LibraryTopicsView(props: {
  workspaceId: string | null;
  initialTopicId?: string | null;
  onTopicContextChange?: (ctx: LibraryTopicPiContext) => void;
  onOpenStudio?: (projectId: string) => void;
  onGoStudio?: () => void;
  onOpenCanvas?: (canvasId?: string) => void;
  onOpenPi?: () => void;
  piConfigured?: boolean;
  aiSourcePresentation?: boolean;
}): React.JSX.Element {
  const {
    workspaceId,
    initialTopicId = null,
    onTopicContextChange,
    onOpenStudio,
    onGoStudio,
    onOpenCanvas,
    onOpenPi,
    piConfigured = false,
    aiSourcePresentation = false,
  } = props;

  const [topics, setTopics] = useState<TopicListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listHasMore, setListHasMore] = useState(false);
  const [listTotal, setListTotal] = useState(0);
  const [listReloadToken, setListReloadToken] = useState(0);
  const [topicQuery, setTopicQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TopicStatusFilter>('all'); const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [focusedTopicId, setFocusedTopicId] = useState<string | null>(null);
  const [segment, setSegment] = useState<WorkspaceSegment>('judgments');
  const [segmentReloadToken, setSegmentReloadToken] = useState(0);
  const [deepMode, setDeepMode] = useState(false);
  const [deepCategory, setDeepCategory] = useState<DossierCategory | ''>('');
  const [deepReloadToken, setDeepReloadToken] = useState(0);
  // WMB-5212 M3：Topic Wiki 详情（Wiki-first 默认；dossier 兜底仍可达）。
  const [wikiDetail, setWikiDetail] = useState<TopicWikiDetail | null>(null);
  const [wikiError, setWikiError] = useState<string | null>(null);
  const [wikiReloadToken, setWikiReloadToken] = useState(0);
  const [wikiTab, setWikiTab] = useState<WikiTabId>('overview');
  // WMB-5239：主题原位「搜索本主题资料 / 相关动态」（topicId 限定当前主题范围；无主题时不发 IPC）。
  const [topicSearchQuery, setTopicSearchQuery] = useState('');
  const topicScopeId = selectedTopicId ?? undefined;
  const topicScopeEnabled = Boolean(selectedTopicId);
  const topicSearch = useWikiSearch({ query: topicSearchQuery, topicId: topicScopeId, enabled: topicScopeEnabled, limit: 12 });
  const topicActivity = useKnowledgeLog({ topicId: topicScopeId, enabled: topicScopeEnabled, limit: 30 });
  const { summary: indexSummary, error: indexError } = useWikiIndexSummary({ enabled: topicScopeEnabled });
  const indexHint = indexError ? '检索状态暂不可用' : topicIndexStatusLabel(indexSummary);
  const topicActivityEntries = useMemo(
    () => topicActivity.entries.filter((entry) => isTopicLogSupplementary(entry)),
    [topicActivity.entries],
  );
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const wikiLoadSeq = useRef(0);
  const [canvasBusy, setCanvasBusy] = useState(false);
  const [canvasMessage, setCanvasMessage] = useState<string | null>(null);
  const [sourceActionError, setSourceActionError] = useState<string | null>(null);
  const [sourceUpdatingId, setSourceUpdatingId] = useState<string | null>(null);
  const [wideLayout, setWideLayout] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(WIDE_RAIL_MQ).matches;
  });

  const [headerTopic, setHeaderTopic] = useState<DossierTopic | null>(null);
  const [counts, setCounts] = useState<DossierCounts>(EMPTY_COUNTS);

  const [judgments, setJudgments] = useState<DossierItem[]>([]);
  const [methodFindings, setMethodFindings] = useState<DossierItem[]>([]);
  const [sources, setSources] = useState<DossierItem[]>([]);
  const [counterEvidence, setCounterEvidence] = useState<DossierItem[]>([]);
  const [sourcesPreview, setSourcesPreview] = useState<DossierItem[]>([]);
  const [contentHistory, setContentHistory] = useState<DossierItem[]>([]);
  const [metrics, setMetrics] = useState<DossierItem[]>([]);
  const [reviews, setReviews] = useState<DossierItem[]>([]);
  const [opportunities, setOpportunities] = useState<ContextOpportunity[]>([]);
  const [expandedReviews, setExpandedReviews] = useState<Record<string, boolean>>({});

  const [segmentLoading, setSegmentLoading] = useState(false);
  const [segmentError, setSegmentError] = useState<string | null>(null);

  const [deepItems, setDeepItems] = useState<DossierItem[]>([]);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepLoadingMore, setDeepLoadingMore] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);
  const [deepHasMore, setDeepHasMore] = useState(false);
  const [deepTotal, setDeepTotal] = useState(0);

  const selectedTopicIdRef = useRef<string | null>(selectedTopicId);
  const topicsRef = useRef<TopicListItem[]>([]);
  const onTopicContextChangeRef = useRef(onTopicContextChange);
  const segmentLoadSeq = useRef(0);
  const listLoadSeq = useRef(0);
  const deepLoadSeq = useRef(0);
  const lastEmittedKeyRef = useRef<string | null>(null);
  const listPaneRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const preferIdOnListLoadRef = useRef<string | null>(null);

  useEffect(() => {
    selectedTopicIdRef.current = selectedTopicId;
  }, [selectedTopicId]);

  useEffect(() => {
    topicsRef.current = topics;
  }, [topics]);

  useEffect(() => {
    onTopicContextChangeRef.current = onTopicContextChange;
  }, [onTopicContextChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(topicQuery.trim()), QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [topicQuery]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(WIDE_RAIL_MQ);
    const onChange = () => setWideLayout(media.matches);
    onChange();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  const emitContext = useCallback((topicId: string | null, title?: string | null) => {
    const nextKey = topicId && title ? `${topicId}::${title}` : 'null';
    if (lastEmittedKeyRef.current === nextKey) return;
    lastEmittedKeyRef.current = nextKey;
    if (!topicId || !title) {
      onTopicContextChangeRef.current?.(null);
      return;
    }
    onTopicContextChangeRef.current?.({ id: topicId, title });
  }, []);

  const clearWorkspace = useCallback(() => {
    setHeaderTopic(null);
    setCounts(EMPTY_COUNTS);
    setJudgments([]);
    setMethodFindings([]);
    setSources([]);
    setCounterEvidence([]);
    setSourcesPreview([]);
    setContentHistory([]);
    setMetrics([]);
    setReviews([]);
    setOpportunities([]);
    setSegmentError(null);
    setSourceActionError(null);
    setDeepItems([]);
    setDeepError(null);
    setDeepHasMore(false);
    setDeepTotal(0);
    setExpandedReviews({});
    setCanvasMessage(null);
    setWikiDetail(null);
    setWikiError(null);
    setWikiTab('overview');
    setRestoringVersionId(null);
    setRestoreMessage(null);
  }, []);

  const selectTopic = useCallback((topicId: string | null, title?: string | null) => {
    setSelectedTopicId(topicId);
    selectedTopicIdRef.current = topicId;
    if (workspaceId) { const key = workspaceStorageKey(workspaceId, 'libraryTopicId'); if (topicId) localStorage.setItem(key, topicId); else localStorage.removeItem(key); }
    setDeepMode(false);
    setDeepCategory('');
    setExpandedReviews({});
    setSourceActionError(null);
    setCanvasMessage(null);
    if (!topicId) {
      clearWorkspace();
      emitContext(null);
      return;
    }
    const knownTitle = title
      ?? topicsRef.current.find((item) => item.id === topicId)?.title
      ?? null;
    if (knownTitle) emitContext(topicId, knownTitle);
  }, [clearWorkspace, emitContext, workspaceId]);

  const loadTopicList = useCallback(async (options?: {
    preferId?: string | null;
    offset?: number;
    append?: boolean;
  }) => {
    const offset = options?.offset ?? 0;
    const append = Boolean(options?.append);
    const seq = ++listLoadSeq.current;
    if (append) setListLoadingMore(true);
    else {
      setListLoading(true);
      setListError(null);
    }
    try {
      const raw = await window.wmb.listKnowledgeTopics({
        query: debouncedQuery || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: LIST_LIMIT,
        offset,
      });
      if (seq !== listLoadSeq.current) return;
      const page = normalizeTopicListPage(raw);
      const nextItems = append
        ? (() => {
          const seen = new Set(topicsRef.current.map((item) => item.id));
          const merged = [...topicsRef.current];
          for (const item of page.items) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            merged.push(item);
          }
          return merged;
        })()
        : page.items;

      setTopics(nextItems);
      topicsRef.current = nextItems;
      setListTotal(page.total);
      setListHasMore(page.hasMore);
      if (append) return;

      const preferredCandidate = options?.preferId
        ?? preferIdOnListLoadRef.current
        ?? null;
      preferIdOnListLoadRef.current = null;
      const preferred = preferredCandidate && nextItems.some((item) => item.id === preferredCandidate)
        ? preferredCandidate
        : null;

      if (preferred) {
        const row = nextItems.find((item) => item.id === preferred) ?? null;
        if (preferred !== selectedTopicIdRef.current) {
          selectTopic(preferred, row?.title ?? null);
        } else if (row?.title) {
          emitContext(preferred, row.title);
        }
      } else if (selectedTopicIdRef.current) {
        const stillVisible = nextItems.some((item) => item.id === selectedTopicIdRef.current);
        if (!stillVisible) selectTopic(null);
        else {
          const row = nextItems.find((item) => item.id === selectedTopicIdRef.current) ?? null;
          if (row?.title) emitContext(row.id, row.title);
        }
      }
    } catch (error) {
      if (seq !== listLoadSeq.current) return;
      if (!append) {
        setTopics([]);
        topicsRef.current = [];
        setListTotal(0);
        setListHasMore(false);
        setListError(errorMessage(error));
        selectTopic(null);
      } else {
        setListError(errorMessage(error));
      }
    } finally {
      if (seq === listLoadSeq.current) {
        setListLoading(false);
        setListLoadingMore(false);
      }
    }
  }, [debouncedQuery, emitContext, selectTopic, statusFilter]);

  useEffect(() => {
    void loadTopicList({ preferId: selectedTopicIdRef.current ?? undefined });
  }, [debouncedQuery, statusFilter, listReloadToken, loadTopicList]);

  useEffect(() => {
    const topicId = asString(initialTopicId);
    if (!topicId) return;
    preferIdOnListLoadRef.current = topicId;
    setSegment('judgments');
    setDeepMode(false);
    selectTopic(topicId);
    void loadTopicList({ preferId: topicId });
    // Mount-time deep link only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedTopicId || deepMode) {
      if (!selectedTopicId) {
        setSegmentLoading(false);
        setSegmentError(null);
      }
      return;
    }

    const topicId = selectedTopicId;
    const activeSegment = segment;
    const seq = ++segmentLoadSeq.current;
    let cancelled = false;

    const run = async () => {
      setSegmentLoading(true);
      setSegmentError(null);
      try {
        if (activeSegment === 'judgments') {
          const requests: Array<Promise<unknown>> = [
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'judgments', limit: SEGMENT_LIMIT, offset: 0 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'method_findings', limit: 20, offset: 0 }),
            // Preload content projects so 「去创作」 works from the default tab.
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'content_history', limit: 20, offset: 0 }),
            // WMB-5226：概览「已有资料」预览始终需要真实来源（不依赖宽布局）。
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'sources', limit: 12, offset: 0 }),
          ];
          const [judgmentsPageRaw, methodsPageRaw, contentPageRaw, sourcesPreviewRaw] = await Promise.all(requests);
          if (cancelled || seq !== segmentLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
          const judgmentsPage = normalizeDossierPage(judgmentsPageRaw);
          const methodsPage = normalizeDossierPage(methodsPageRaw);
          const contentPage = normalizeDossierPage(contentPageRaw);
          const previewPage = normalizeDossierPage(sourcesPreviewRaw);
          if (!judgmentsPage) throw new Error('主题档案读取失败');
          setHeaderTopic(judgmentsPage.topic);
          setCounts(judgmentsPage.counts);
          setJudgments(judgmentsPage.items);
          setMethodFindings(methodsPage?.items ?? []);
          setContentHistory(contentPage?.items ?? []);
          setSourcesPreview(previewPage?.items ?? []);
          emitContext(judgmentsPage.topic.id, judgmentsPage.topic.title);
        } else if (activeSegment === 'sources') {
          const [sourcesPageRaw, counterPageRaw] = await Promise.all([
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'sources', limit: SEGMENT_LIMIT, offset: 0 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'counter_evidence', limit: SEGMENT_LIMIT, offset: 0 }),
          ]);
          if (cancelled || seq !== segmentLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
          const sourcesPage = normalizeDossierPage(sourcesPageRaw);
          const counterPage = normalizeDossierPage(counterPageRaw);
          const page = sourcesPage ?? counterPage;
          if (!page) throw new Error('主题资料读取失败');
          setHeaderTopic(page.topic);
          setCounts(page.counts);
          setSources(sourcesPage?.items ?? []);
          setCounterEvidence(counterPage?.items ?? []);
          setSourcesPreview(sourcesPage?.items.slice(0, 12) ?? []);
          emitContext(page.topic.id, page.topic.title);
        } else {
          const [contextRaw, contentRaw, metricsRaw, reviewsRaw] = await Promise.all([
            window.wmb.getKnowledgeContext({ topicId, limit: 50 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'content_history', limit: SEGMENT_LIMIT, offset: 0 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'metrics', limit: SEGMENT_LIMIT, offset: 0 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'reviews', limit: SEGMENT_LIMIT, offset: 0 }),
          ]);
          if (cancelled || seq !== segmentLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
          const context = normalizeKnowledgeContext(contextRaw);
          const contentPage = normalizeDossierPage(contentRaw);
          const metricsPage = normalizeDossierPage(metricsRaw);
          const reviewsPage = normalizeDossierPage(reviewsRaw);
          const page = contentPage ?? metricsPage ?? reviewsPage;
          if (page) {
            setHeaderTopic(page.topic);
            setCounts(page.counts);
            emitContext(page.topic.id, page.topic.title);
          } else {
            const listItem = topicsRef.current.find((item) => item.id === topicId) ?? null;
            if (listItem) {
              setHeaderTopic({
                id: listItem.id,
                title: listItem.title,
                summary: listItem.summary,
                status: listItem.status,
                firstSeenAt: listItem.firstSeenAt,
                lastSeenAt: listItem.lastSeenAt,
              });
              emitContext(listItem.id, listItem.title);
            }
          }
          setOpportunities(context.opportunities);
          setContentHistory(contentPage?.items ?? []);
          setMetrics(metricsPage?.items ?? []);
          setReviews(reviewsPage?.items ?? []);
        }
      } catch (error) {
        if (cancelled || seq !== segmentLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        setSegmentError(errorMessage(error));
      } finally {
        if (!cancelled && seq === segmentLoadSeq.current) setSegmentLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedTopicId, segment, segmentReloadToken, emitContext, deepMode, wideLayout]);

  useEffect(() => {
    if (!selectedTopicId || !deepMode) {
      if (!deepMode) {
        setDeepLoading(false);
        setDeepLoadingMore(false);
      }
      return;
    }

    const topicId = selectedTopicId;
    const category = deepCategory;
    const seq = ++deepLoadSeq.current;
    let cancelled = false;

    const run = async () => {
      setDeepLoading(true);
      setDeepError(null);
      try {
        const raw = await window.wmb.getKnowledgeTopicDossier({
          topicId,
          category: category || undefined,
          limit: DEEP_LIMIT,
          offset: 0,
        });
        if (cancelled || seq !== deepLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        const page = normalizeDossierPage(raw);
        if (!page) throw new Error('完整档案读取失败');
        setHeaderTopic(page.topic);
        setCounts(page.counts);
        setDeepItems(page.items);
        setDeepHasMore(page.hasMore);
        setDeepTotal(page.total);
        emitContext(page.topic.id, page.topic.title);
      } catch (error) {
        if (cancelled || seq !== deepLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        setDeepError(errorMessage(error));
        setDeepItems([]);
        setDeepHasMore(false);
        setDeepTotal(0);
      } finally {
        if (!cancelled && seq === deepLoadSeq.current) setDeepLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedTopicId, deepMode, deepCategory, deepReloadToken, emitContext]);

  // WMB-5212 M3：Topic Wiki 详情加载（Wiki-first 默认；dossier 仍可深查）。
  useEffect(() => {
    if (!selectedTopicId || deepMode) {
      if (!selectedTopicId) {
        setWikiError(null);
      }
      return;
    }

    const topicId = selectedTopicId;
    const seq = ++wikiLoadSeq.current;
    let cancelled = false;

    const run = async () => {
      setWikiError(null);
      try {
        const raw = await window.wmb.getTopicWikiDetail({ topicId, ...WIKI_DETAIL_LIMITS });
        if (cancelled || seq !== wikiLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        const detail = normalizeTopicWikiDetail(raw);
        if (!detail || detail.topicId !== topicId) return;
        setWikiDetail(detail);
        if (detail.topic) {
          setHeaderTopic({
            id: detail.topic.id,
            title: detail.topic.title,
            summary: detail.topic.summary,
            status: detail.topic.status,
            firstSeenAt: detail.topic.firstSeenAt,
            lastSeenAt: detail.topic.lastSeenAt,
            revision: detail.topic.revision,
          });
          if (detail.dossierCounts) setCounts({ ...EMPTY_COUNTS, ...detail.dossierCounts });
          emitContext(detail.topic.id, detail.topic.title);
        }
      } catch (error) {
        if (cancelled || seq !== wikiLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        setWikiError(errorMessage(error));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedTopicId, deepMode, wikiReloadToken, emitContext]);

  // WMB-5212：dataChanged 订阅（topics/knowledge/receipt scope）替代手动刷新主路径；
  // 刷新 Wiki 详情与列表但保留当前选择（设计 §2.5 / §9）。
  useEffect(() => {
    if (typeof window.wmb.onDataChanged !== 'function') return;
    const refresh = (event: { scopes: string[] }) => {
      const scopes = event.scopes ?? [];
      const touches = scopes.some((scope) => scope === 'topics' || scope === 'knowledge' || scope === 'receipt' || scope === 'library');
      if (!touches) return;
      // 主题/Wiki 数据变化：列表始终刷新（保留当前选择）；已开详情时同步刷新各投影。
      setListReloadToken((value) => value + 1);
      if (selectedTopicIdRef.current) {
        setWikiReloadToken((value) => value + 1);
        setSegmentReloadToken((value) => value + 1);
        setDeepReloadToken((value) => value + 1);
      }
    };
    const unsubscribe = window.wmb.onDataChanged(refresh);
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const onOpenTopic = (event: Event) => {
      const custom = event as CustomEvent<{ topicId?: string }>;
      const topicId = asString(custom.detail?.topicId);
      if (!topicId) return;
      setSegment('judgments');
      setDeepMode(false);
      const known = topicsRef.current.find((item) => item.id === topicId) ?? null;
      if (known) {
        selectTopic(known.id, known.title);
        return;
      }
      preferIdOnListLoadRef.current = topicId;
      selectTopic(topicId);
      void loadTopicList({ preferId: topicId });
    };
    window.addEventListener(OPEN_TOPIC_EVENT, onOpenTopic as EventListener);
    return () => window.removeEventListener(OPEN_TOPIC_EVENT, onOpenTopic as EventListener);
  }, [loadTopicList, selectTopic]);

  const selectedListItem = useMemo(
    () => topics.find((item) => item.id === selectedTopicId) ?? null,
    [topics, selectedTopicId],
  );
  const displayTopic = headerTopic ?? selectedListItem;

  const sourceTotal = (counts.sources ?? 0) + (counts.counter_evidence ?? 0);
  const opportunityTotal = selectedListItem?.opportunityCount ?? opportunities.length;
  const contentTotal = counts.content_history ?? selectedListItem?.contentCount ?? 0;
  const reviewTotal = counts.reviews ?? 0;
  const outcomeBadge = (opportunityTotal || 0) + contentTotal + (counts.metrics ?? 0) + reviewTotal;
  const showSourcesRail = !deepMode && segment === 'judgments' && wideLayout && Boolean(displayTopic);
  const recentLabel = formatRelativeTime(displayTopic?.lastSeenAt) ?? '—';

  const objectMetaLine = useMemo(() => {
    const parts = [
      `资料 ${sourceTotal}`,
      `机会 ${opportunityTotal || 0}`,
      `内容 ${contentTotal}`,
      `复盘 ${reviewTotal}`,
      `最近 ${recentLabel}`,
    ];
    return parts.join(' · ');
  }, [sourceTotal, opportunityTotal, contentTotal, reviewTotal, recentLabel]);

  // WMB-5242：最近整理时间 = 当前认识版本创建时间（唯一可读的整理时点）；尚未整理（无版本）时不显示时间。
  const organizeLabel = useMemo(() => {
    const time = wikiDetail?.wiki?.current?.createdAt ?? null;
    if (!time) return null;
    return formatRelativeTime(time) ?? formatWhen(time);
  }, [wikiDetail]);

  const moveFocus = useCallback((delta: number) => {
    if (!topics.length) return;
    const currentIndex = topics.findIndex((item) => item.id === focusedTopicId);
    const nextIndex = currentIndex < 0
      ? (delta > 0 ? 0 : topics.length - 1)
      : Math.max(0, Math.min(topics.length - 1, currentIndex + delta));
    const next = topics[nextIndex];
    if (!next) return;
    setFocusedTopicId(next.id);
  }, [focusedTopicId, topics]);

  // WMB-5212 M3：Wiki 默认详情状态推导 + 章节直达（供键盘/章节导航共用）。
  // failed/stale 编译状态横幅始终可见；hasCurrentKnowledge 只在有摘要、结论或争议时展示正文。
  const wikiPage = wikiDetail?.wiki?.page ?? null;
  const wikiCurrent = wikiDetail?.wiki?.current ?? null;
  const wikiBody = wikiDetail?.wiki?.body ?? null;
  const hasCurrentKnowledge = Boolean(
    wikiBody
    && ((wikiBody.summary && wikiBody.summary !== '暂无综合摘要。')
      || wikiBody.keyConclusions?.length
      || wikiBody.retainedDisputes?.length)
  );
  const showWikiPage = Boolean(wikiDetail?.wiki);
  const wikiRisks = wikiDetail?.risks ?? null;
  const wikiCompileStatus = wikiDetail?.wiki?.compileStatus ?? null;
  // WMB-5233：诚实三态（后端读投影派生；无 wiki → uncompiled）。
  const compileState = (wikiDetail?.wiki?.compileState ?? 'uncompiled') as KnowledgeCompileState;

  const scrollToWikiSection = useCallback((section: WikiSectionId) => {
    // 跨页签章节：先切到所属页签，等渲染完成后再滚动定位（DOM 章节始终保留）。
    setWikiTab(WIKI_SECTION_TAB[section]);
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => {
      const target = document.getElementById(`topic-wiki-${section}`);
      if (target) {
        target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
        target.focus({ preventScroll: true });
      }
    });
  }, []);

  const onGridKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveFocus(1);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      moveFocus(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const current = topics.find((item) => item.id === (focusedTopicId ?? selectedTopicIdRef.current));
      if (current) {
        setSegment('judgments');
        selectTopic(current.id, current.title);
      }
    }
  }, [focusedTopicId, moveFocus, selectTopic, topics]);

  const onWorkspaceKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    // Wiki 默认详情：数字键 1–7 直达章节（当前认识→版本）。
    const wikiKey = Number(event.key);
    const wikiIndex = Number.isInteger(wikiKey) && wikiKey >= 1 && wikiKey <= WIKI_SECTION_ORDER.length ? wikiKey - 1 : -1;
    if (wikiIndex >= 0 && showWikiPage && !deepMode) {
      event.preventDefault();
      scrollToWikiSection(WIKI_SECTION_ORDER[wikiIndex]);
      return;
    }
    if (event.key === '1') {
      event.preventDefault();
      setDeepMode(false);
      setSegment('judgments');
      return;
    }
    if (event.key === '2') {
      event.preventDefault();
      setDeepMode(false);
      setSegment('sources');
      return;
    }
    if (event.key === '3') {
      event.preventDefault();
      setDeepMode(false);
      setSegment('outcomes');
    }
  }, [deepMode, showWikiPage, scrollToWikiSection]);

  const loadMoreTopics = useCallback(() => {
    if (listLoading || listLoadingMore || !listHasMore) return;
    void loadTopicList({ offset: topics.length, append: true });
  }, [listHasMore, listLoading, listLoadingMore, loadTopicList, topics.length]);

  const loadMoreDeep = useCallback(async () => {
    if (!selectedTopicId || !deepMode || deepLoading || deepLoadingMore || !deepHasMore) return;
    const topicId = selectedTopicId;
    const seq = ++deepLoadSeq.current;
    setDeepLoadingMore(true);
    setDeepError(null);
    try {
      const raw = await window.wmb.getKnowledgeTopicDossier({
        topicId,
        category: deepCategory || undefined,
        limit: DEEP_LIMIT,
        offset: deepItems.length,
      });
      if (seq !== deepLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
      const page = normalizeDossierPage(raw);
      if (!page) throw new Error('完整档案读取失败');
      setHeaderTopic(page.topic);
      setCounts(page.counts);
      setDeepItems((current) => {
        const seen = new Set(current.map(itemKey));
        const merged = [...current];
        for (const item of page.items) {
          const key = itemKey(item);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }
        return merged;
      });
      setDeepHasMore(page.hasMore);
      setDeepTotal(page.total);
    } catch (error) {
      if (seq !== deepLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
      setDeepError(errorMessage(error));
    } finally {
      if (seq === deepLoadSeq.current) setDeepLoadingMore(false);
    }
  }, [deepCategory, deepHasMore, deepItems.length, deepLoading, deepLoadingMore, deepMode, selectedTopicId]);

  const updateSourceMeta = useCallback(async (
    item: DossierItem,
    patch: { verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus },
  ) => {
    const revision = asNumber(item.metadata?.revision);
    if (revision == null) return;
    setSourceUpdatingId(item.objectId);
    setSourceActionError(null);
    try {
      const result = await window.wmb.updateKnowledgeSource({
        id: item.objectId,
        expectedRevision: revision,
        verificationStatus: patch.verificationStatus,
        managementStatus: patch.managementStatus,
      });
      const nextRevision = asNumber(result?.revision) ?? revision + 1;
      const apply = (rows: DossierItem[]) => rows.map((row) => (
        row.objectId === item.objectId
          ? patchSourceItem(row, {
            revision: nextRevision,
            verificationStatus: patch.verificationStatus,
            managementStatus: patch.managementStatus,
          })
          : row
      ));
      setSources(apply);
      setCounterEvidence(apply);
      setSourcesPreview(apply);
      setDeepItems(apply);
    } catch (error) {
      setSourceActionError(errorMessage(error));
    } finally {
      setSourceUpdatingId(null);
    }
  }, []);

  const openCanvasForTopic = useCallback(async () => {
    if (!displayTopic || canvasBusy) return;
    setCanvasBusy(true);
    setCanvasMessage(null);
    try {
      const listRaw = await window.wmb.listKnowledgeCanvases();
      const list = Array.isArray(listRaw) ? listRaw : [];
      let canvasId: string | null = null;
      for (const entry of list) {
        const row = asRecord(entry);
        if (!row) continue;
        if (asString(row.topicId) === displayTopic.id) {
          canvasId = asString(row.id);
          break;
        }
      }
      if (!canvasId) {
        const createdRaw = await window.wmb.createKnowledgeCanvas({
          title: `${displayTopic.title} 工作台`,
          topicId: displayTopic.id,
        });
        canvasId = asString(asRecord(createdRaw)?.id);
      }
      if (!canvasId) throw new Error('画布创建失败');
      setCanvasMessage('已准备主题画布');
      onOpenCanvas?.(canvasId);
    } catch (error) {
      setCanvasMessage(errorMessage(error));
    } finally {
      setCanvasBusy(false);
    }
  }, [canvasBusy, displayTopic, onOpenCanvas]);

  const goCreate = useCallback(() => {
    if (!displayTopic) return;
    let projectId: string | null = null;
    for (const item of contentHistory) {
      if (item.objectType === 'content_project' && item.objectId) {
        projectId = item.objectId;
        break;
      }
    }
    if (projectId) {
      onOpenStudio?.(projectId);
      return;
    }
    if (workspaceId) localStorage.setItem(workspaceStorageKey(workspaceId, 'studioTopicId'), displayTopic.id);
    if (onGoStudio) {
      onGoStudio();
      return;
    }
    onOpenStudio?.('');
  }, [contentHistory, displayTopic, onGoStudio, onOpenStudio]);

  const backToGrid = useCallback(() => {
    setFocusedTopicId(selectedTopicIdRef.current);
    selectTopic(null);
  }, [selectTopic]);

  const askPiBrief = useCallback(() => {
    if (!displayTopic) return;
    emitContext(displayTopic.id, displayTopic.title);
    onOpenPi?.();
    const prompt = [
      `请基于当前主题「${displayTopic.title}」的档案（判断、关键资料与回流），产出 1–3 条可执行选题方案。`,
      '每条含：标题方向、why now、时效、角度、目标读者、建议平台/体裁、还缺什么证据。',
      '不要空泛综述，优先可马上开写的切口。'
    ].join('');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('wmb-pi-generate', { detail: { prompt, orchestration: { originLabel: '资料库', title: '请 Pi 出选题', goal: '基于主题档案产出可执行选题方案', acceptance: '1–3 条可执行选题方案' } } }));
    }, 0);
  }, [displayTopic, emitContext, onOpenPi]);

  // WMB-5212：Wiki 版本恢复 = 既有 ChangeSet 写路径追加新版本（契约 §15.2；设计 §2.7 明确会生成新版本）。
  const restoreWikiVersion = useCallback(async (version: KnowledgeWikiPageVersionRecord) => {
    const page = wikiDetail?.wiki?.page;
    if (!page || !selectedTopicId || restoringVersionId) return;
    if (!window.confirm(`恢复会生成一个以 V${version.versionNumber} 内容为基础的新版本（不覆盖历史）。确定恢复？`)) return;
    setRestoringVersionId(version.id);
    setRestoreMessage(null);
    try {
      const result = await window.wmb.submitKnowledgeChangeSet({
        requestId: `wiki-restore:${page.id}:${version.id}:${Date.now()}`,
        reason: `恢复主题 Wiki 到 V${version.versionNumber}（用户操作）`,
        triggerSource: 'user',
        resolutionMode: 'manual_correction',
        createdBy: 'user',
        input: {
          wikiPages: [{
            id: page.id,
            scope: page.scope,
            pageType: 'topic',
            canonicalKey: page.canonicalKey,
            title: version.title || page.title,
            subjectType: 'topic',
            subjectId: selectedTopicId,
            beforeRevision: page.revision,
            version: {
              restoreFromVersionId: version.id,
              changeSummary: `恢复至 V${version.versionNumber}`,
              compileReason: 'user-restore',
              body: {},
            },
          }],
        },
      });
      if (!result.ok) throw new Error(result.error?.message ?? '恢复失败');
      setRestoreMessage(`已生成新版本（基于 V${version.versionNumber}）。`);
      setWikiReloadToken((value) => value + 1);
      setSegmentReloadToken((value) => value + 1);
      setDeepReloadToken((value) => value + 1);
      setListReloadToken((value) => value + 1);
    } catch (error) {
      setRestoreMessage(`恢复失败：${errorMessage(error)}`);
    } finally {
      setRestoringVersionId(null);
    }
  }, [restoringVersionId, selectedTopicId, wikiDetail]);

  const renderSourceCard = (item: DossierItem, forceContradicting = false) => {
    const relation = item.metadata?.relation ?? (forceContradicting ? 'contradicting' : null);
    const contradicting = forceContradicting || relation === 'contradicting';
    const revision = asNumber(item.metadata?.revision);
    const originalUrl = item.metadata?.originalUrl ?? item.metadata?.sourceUrl ?? null;
    const busy = sourceUpdatingId === item.objectId;
    return <article key={itemKey(item)} className={`library-topic-card${contradicting ? ' contradicting' : ''}`}>
      <header>
        <div className="library-topic-source-title">
          <SourceMark canonicalUrl={originalUrl} aiSourcePresentation={aiSourcePresentation}/>
          <strong>{item.title}</strong>
        </div>
        <div className="library-topic-card-badges">
          <span className={`library-topic-badge${contradicting ? ' danger' : ''}`}>{relationLabel(relation)}</span>
          <time>{formatWhen(item.occurredAt)}</time>
        </div>
      </header>
      <p>{item.body || '无摘要'}</p>
      <div className="library-topic-card-meta">
        <span>{verificationLabel(item.metadata?.verificationStatus)} · {managementLabel(item.metadata?.managementStatus)}</span>
      </div>
      <div className="library-topic-source-actions">
        {revision != null ? <>
          <label>
            <span>核验</span>
            <select
              aria-label={`核验 ${item.title}`}
              disabled={busy}
              value={item.metadata?.verificationStatus || 'pending'}
              onChange={(event) => {
                void updateSourceMeta(item, { verificationStatus: event.target.value as VerificationStatus });
              }}
            >
              <option value="pending">待核验</option>
              <option value="verified">已核验</option>
              <option value="disputed">有争议</option>
              <option value="rejected">已排除</option>
            </select>
          </label>
          <label>
            <span>管理</span>
            <select
              aria-label={`管理 ${item.title}`}
              disabled={busy}
              value={item.metadata?.managementStatus || 'active'}
              onChange={(event) => {
                void updateSourceMeta(item, { managementStatus: event.target.value as ManagementStatus });
              }}
            >
              <option value="active">活跃</option>
              <option value="watching">持续观察</option>
              <option value="expired">已过期</option>
              <option value="archived">已归档</option>
            </select>
          </label>
        </> : null}
        {originalUrl ? <button
          type="button"
          className="text-button"
          onClick={() => void window.wmb.openExternal(String(originalUrl))}
        >打开原文 ↗</button> : null}
      </div>
    </article>;
  };

  const renderMethodFindings = () => {
    if (!methodFindings.length) return null;
    return <section className="library-topic-secondary" aria-label="方法结论次级">
      <h4>方法结论·不是当前判断</h4>
      <p className="library-topic-secondary-note">以下不是当前判断，只作方法沉淀参考。</p>
      <div className="library-topic-cards">
        {methodFindings.map((item) => <article key={itemKey(item)} className="library-topic-card secondary">
          <header>
            <strong>{item.title || '方法结论'}</strong>
            <time>{formatWhen(item.occurredAt)}</time>
          </header>
          <p>{item.body || '暂无正文'}</p>
        </article>)}
      </div>
    </section>;
  };

  const renderDeepItem = (item: DossierItem) => {
    const category = (item.category in DOSSIER_LABELS ? item.category : 'sources') as DossierCategory;
    if (category === 'sources' || category === 'counter_evidence') {
      return renderSourceCard(item, category === 'counter_evidence');
    }
    if (category === 'content_history') {
      return <article key={itemKey(item)} className="library-topic-card">
        <header>
          <strong>{item.title}</strong>
          <time>{formatWhen(item.occurredAt)}</time>
        </header>
        <p>{item.body || '暂无正文摘要'}</p>
        <div className="library-topic-card-meta">
          <span>状态 {item.metadata?.status || '未知'}{item.metadata?.archived ? ' · 已归档' : ''}</span>
          <span>{DOSSIER_LABELS[category]}</span>
        </div>
        {item.objectType === 'content_project' && onOpenStudio ? <div className="library-panel-actions">
          <button type="button" className="text-button" onClick={() => onOpenStudio(item.objectId)}>打开创作</button>
        </div> : null}
      </article>;
    }
    if (category === 'reviews') {
      const key = itemKey(item);
      const expanded = expandedReviews[key] ?? true;
      const keep = prettyJsonish(item.metadata?.keep ?? null);
      const stop = prettyJsonish(item.metadata?.stop ?? null);
      const change = prettyJsonish(item.metadata?.change ?? null);
      return <article key={key} className="library-topic-card">
        <header>
          <strong>{item.title || '复盘'}</strong>
          <div className="library-topic-card-badges">
            <button
              type="button"
              className="text-button"
              onClick={() => setExpandedReviews((current) => ({ ...current, [key]: !expanded }))}
            >{expanded ? '收起' : '展开'}</button>
            <time>{formatWhen(item.occurredAt)}</time>
          </div>
        </header>
        <p>{item.body || '无摘要'}</p>
        {expanded && (keep || stop || change) ? <div className="library-topic-ksc">
          {keep ? <div><b>Keep</b><span>{keep}</span></div> : null}
          {stop ? <div><b>Stop</b><span>{stop}</span></div> : null}
          {change ? <div><b>Change</b><span>{change}</span></div> : null}
        </div> : null}
      </article>;
    }
    if (category === 'metrics') {
      const body = prettyJsonish(item.body) || item.body || '暂无指标明细';
      return <article key={itemKey(item)} className="library-topic-card">
        <header>
          <strong>{item.title}</strong>
          <time>{formatWhen(item.occurredAt)}</time>
        </header>
        <p className="library-topic-metric-body">{body}</p>
        {item.metadata?.sourceUrl ? <div className="library-panel-actions">
          <button type="button" className="text-button" onClick={() => void window.wmb.openExternal(String(item.metadata?.sourceUrl))}>来源 ↗</button>
        </div> : null}
      </article>;
    }
    return <article key={itemKey(item)} className="library-topic-card">
      <header>
        <strong>{item.title}</strong>
        <div className="library-topic-card-badges">
          <span className="library-topic-badge">{DOSSIER_LABELS[category]}</span>
          <time>{formatWhen(item.occurredAt)}</time>
        </div>
      </header>
      <p>{item.body || '暂无正文'}</p>
      {(item.metadata?.whyNow || item.metadata?.timeliness) ? <div className="library-topic-card-meta">
        {item.metadata.whyNow ? <span>为何现在：{item.metadata.whyNow}</span> : null}
        {item.metadata.timeliness ? <span>时效：{item.metadata.timeliness}</span> : null}
      </div> : null}
    </article>;
  };

  // ===== WMB-5212 M3：Topic Wiki 详情渲染（Wiki-first 默认） =====
  const renderKeyConclusion = (item: TopicWikiKeyConclusion, index: number) => {
    const status = item.conclusionStatus || 'unverified';
    const statusClass = CONCLUSION_STATUS_CLASS[status] ?? 'gray';
    const level = EVIDENCE_LEVEL_LABELS[item.evidenceLevel] ?? item.evidenceLevel;
    return <article key={`${item.noteId}-${index}`} className="library-topic-card topic-wiki-conclusion">
      <header>
        <strong>{item.statement || '（无表述）'}</strong>
        <div className="library-topic-card-badges">
          <span className={`library-topic-badge status-${statusClass}`} data-status={status}>{CONCLUSION_STATUS_LABELS[status] ?? status}</span>
          {item.changeType && item.changeType !== 'created' ? <span className="library-topic-badge">{changeTypeLabel(item.changeType)}</span> : null}
        </div>
      </header>
      <div className="library-topic-card-meta">
        <span>证据 {level}</span>
        {item.appliesTo ? <span>适用 {item.appliesTo}</span> : null}
        <span>{kindLabel(item.kind)}</span>
      </div>
    </article>;
  };

  const renderWikiEvidence = (entry: TopicEvidenceEntry) => {
    const relation = EVIDENCE_RELATION_LABELS[entry.relation] ?? entry.relation;
    const contradicting = entry.relation === 'contradicts';
    return <article key={entry.id} className={`library-topic-card${contradicting ? ' contradicting' : ''}`}>
      <header>
        <strong>{entry.noteStatement || '（无表述）'}</strong>
        <div className="library-topic-card-badges">
          <span className={`library-topic-badge${contradicting ? ' danger' : ''}`}>{relation}</span>
          <time>{formatWhen(entry.createdAt)}</time>
        </div>
      </header>
      {entry.excerpt ? <p>{entry.excerpt}</p> : null}
      <div className="library-topic-card-meta">
        <span>{SOURCE_NATURE_LABELS[entry.sourceNature] ?? entry.sourceNature}</span>
        <span>{CONCLUSION_STATUS_LABELS[entry.noteConclusionStatus] ?? entry.noteConclusionStatus}</span>
        {entry.locator ? <span>定位 {entry.locator}</span> : null}
      </div>
    </article>;
  };

  const renderWikiReceipt = (receipt: KnowledgeUpdateReceiptRecord) => {
    const impact = asRecord(receipt.impact) ?? {};
    const sourceId = asString(impact.sourceId);
    const countEntries = Object.entries(receipt.counts ?? {}).filter(([key, value]) => Number(value) > 0 && key in RECEIPT_COUNT_LABELS);
    const triggerLabel = RECEIPT_TRIGGER_LABELS[receipt.triggerType] ?? receipt.triggerType;
    const isMigration = receipt.triggerType === 'migration';
    const visibleSummary = isMigration ? '已建立主题档案，后续资料会自动沉淀为当前认识。' : (receipt.summary || '当前认识已更新');
    return <article key={receipt.id} className="library-topic-card">
      <header>
        <strong>{visibleSummary}</strong>
        <time>{formatWhen(receipt.createdAt)}</time>
      </header>
      <div className="library-topic-card-meta">
        <span>{triggerLabel}</span>
        {countEntries.map(([key, value]) => {
          const label = RECEIPT_COUNT_LABELS[key] ?? key;
          return <span key={key}>{label} {value}</span>;
        })}
      </div>
      {sourceId ? <div className="library-panel-actions"><span>来源 {sourceId}</span></div> : null}
    </article>;
  };

  const renderWikiUsage = (record: KnowledgeUsageRecordRecord) => {
    const usageLabel = USAGE_KIND_LABELS[record.usageKind] ?? record.usageKind;
    const outputLabel = USAGE_OUTPUT_LABELS[record.outputObjectType] ?? record.outputObjectType;
    return <article key={record.id} className="library-topic-card">
      <header>
        <strong>{outputLabel} · {record.used ? '已采用' : '仅参考'}</strong>
        <div className="library-topic-card-badges">
          <span className="library-topic-badge">{usageLabel}</span>
          <time>{formatWhen(record.createdAt)}</time>
        </div>
      </header>
      <p>{record.reason || '（无原因说明）'}</p>
    </article>;
  };

  const renderWikiHealth = (issue: KnowledgeHealthIssueRecord) => {
    return <article key={issue.id} className="library-topic-card">
      <header>
        <strong>{HEALTH_TYPE_LABELS[issue.issueType] ?? issue.issueType}</strong>
        <div className="library-topic-card-badges">
          <span className={`library-topic-badge severity-${issue.severity}`}>{severityLabel(issue.severity)}</span>
          <span className="library-topic-badge">{HEALTH_STATUS_LABELS[issue.status] ?? issue.status}</span>
          <time>{formatWhen(issue.detectedAt)}</time>
        </div>
      </header>
      {issue.suggestedAction ? <p>{issue.suggestedAction}</p> : null}
    </article>;
  };

  const renderWikiVersion = (version: KnowledgeWikiPageVersionRecord, isCurrent: boolean) => {
    const isMigration = version.compileReason?.includes('migration') || version.changeSummary?.includes('历史初始化') || version.readableDiff?.includes('derived-from-legacy');
    const visibleSummary = isMigration ? '主题档案已建立，等待资料整理出第一版当前认识。' : (version.changeSummary || version.compileReason || '未记录变更说明');
    return <article key={version.id} className={`library-topic-card topic-wiki-version${isCurrent ? ' current' : ''}`}>
      <header>
        <strong><span className="topic-wiki-version-num">V{version.versionNumber}</span>{isMigration ? '主题档案初始化' : (version.title || '主题认识')}</strong>
        <div className="library-topic-card-badges">
          {isCurrent ? <span className="library-topic-badge">{isMigration ? COMPILE_STATE_LABELS.legacy_shell : '当前'}</span> : null}
          <time>{formatWhen(version.createdAt)}</time>
        </div>
      </header>
      {!isMigration && version.readableDiff ? <details className="topic-wiki-diff">
        <summary>查看差异</summary>
        <pre>{version.readableDiff}</pre>
      </details> : null}
      {!isCurrent ? <div className="library-panel-actions">
        <button
          type="button"
          className="text-button"
          disabled={restoringVersionId !== null}
          onClick={() => void restoreWikiVersion(version)}
        >{restoringVersionId === version.id ? '恢复中…' : '恢复此版本'}</button>
        <span>恢复会生成新版本</span>
      </div> : null}
    </article>;
  };

  const renderTopicSearchBody = () => {
    if (topicSearch.loading) return <p className="library-panel-empty">正在检索本主题资料…</p>;
    if (topicSearch.error) return <div className="library-topic-error" role="alert">
      <strong>本主题资料检索失败</strong>
      <p>{topicSearch.error}</p>
      <button type="button" onClick={topicSearch.retry}>重试</button>
    </div>;
    if (!topicSearchQuery.trim()) return <p className="library-panel-empty">输入关键词，检索本主题已收录的资料、知识与实体。</p>;
    if (!topicSearch.results.length) return <p className="library-panel-empty">没有找到相关内容。搜索全部资料可到资料库。</p>;
    return <>
      <p className="topic-wiki-search-count" role="status">找到 {topicSearch.total} 条结果</p>
      <div className="topic-wiki-search-results">
        {topicSearch.results.map((result) => (
          <button
            key={`${result.objectType}:${result.objectId}:${result.versionRef}`}
            type="button"
            className="topic-wiki-search-result"
            onClick={() => dispatchWikiDeepLink(result.navigation)}
          >
            <span className="topic-wiki-search-result-body">
              <span className="topic-wiki-search-result-title">{result.title}</span>
              {result.snippet ? <span className="topic-wiki-search-result-snippet">{result.snippet}</span> : null}
              <span className="topic-wiki-search-result-meta">更新于 {formatWikiWhen(result.updatedAt)}</span>
            </span>
            <span className="topic-wiki-search-result-side">
              <span className="topic-wiki-search-result-type">{wikiSearchObjectLabel(result.objectType)}</span>
            </span>
          </button>
        ))}
      </div>
    </>;
  };

  const renderTopicActivityBody = () => {
    if (topicActivity.loading) return <p className="library-panel-empty">正在加载相关动态…</p>;
    if (topicActivity.error) return <div className="library-topic-error" role="alert">
      <strong>相关动态加载失败</strong>
      <p>{topicActivity.error}</p>
      <button type="button" onClick={topicActivity.retry}>重试</button>
    </div>;
    if (!topicActivityEntries.length) return <p className="library-panel-empty">还没有与本主题相关的动态。</p>;
    return <>
      <div className="library-topic-cards">
        {topicActivityEntries.map((entry) => {
          const navigable = wikiLogEntryDeepLinkInput(entry) !== null;
          return <article key={entry.id} className="library-topic-card">
            <header>
              <strong>{entry.title}</strong>
              <div className="library-topic-card-badges">
                <span className="library-topic-badge">{wikiLogEventLabel(entry.eventType)}</span>
                <time>{formatWikiWhen(entry.time)}</time>
              </div>
            </header>
            {entry.summary ? <p>{entry.summary}</p> : null}
            <div className="library-topic-card-meta">
              <span>{wikiLogObjectLabel(entry.objectType)}</span>
            </div>
            {navigable ? <div className="library-panel-actions">
              <button type="button" className="text-button" onClick={() => void dispatchWikiLogEntry(entry)}>打开</button>
            </div> : null}
          </article>;
        })}
      </div>
      {topicActivity.hasMore ? <div className="topic-wiki-activity-more">
        <button type="button" disabled={topicActivity.loadingMore} onClick={topicActivity.loadMore}>
          {topicActivity.loadingMore ? '加载中…' : '加载更多'}
        </button>
      </div> : null}
    </>;
  };

  const renderWikiPage = () => {
    if (!wikiDetail) return null;
    const dossier = wikiDetail.dossierCounts;
    const evidenceEmpty = !wikiDetail.evidence.items.length;
    const impactEmpty = !wikiDetail.creationImpact.items.length;
    const researchEmpty = !wikiDetail.questions.length && !wikiDetail.healthIssues.items.length;
    const secondaryEmpty = evidenceEmpty && impactEmpty && researchEmpty;
    const receipts = wikiDetail.receipts.items;
    const sourceTotalCount = counts.sources ?? 0;
    const openDeepSources = () => { setDeepMode(true); setDeepCategory('sources'); };
    return <div className="topic-wiki-page" data-compile-status={wikiCompileStatus ?? 'none'} data-wiki-tab={wikiTab}>
      <nav className="topic-wiki-tabs" aria-label="主题内容">
        {WIKI_TAB_ORDER.map((tab) => <button
          key={tab}
          type="button"
          className={wikiTab === tab ? 'active' : ''}
          aria-pressed={wikiTab === tab}
          onClick={() => setWikiTab(tab)}
        >{WIKI_TAB_LABELS[tab]}{tab === 'overview' ? null : <span>{tab === 'sources' ? (counts.sources ?? 0) : tab === 'changes' ? wikiDetail.receipts.total : wikiDetail.versions.total}</span>}</button>)}
      </nav>

      {wikiCompileStatus && wikiCompileStatus !== 'current' ? <div className={`topic-wiki-compile-banner ${wikiCompileStatus}`} role="status">
        <strong>{COMPILE_STATUS_LABELS[wikiCompileStatus] ?? wikiCompileStatus}</strong>
        {wikiDetail.wiki?.compileNote ? <span>{wikiDetail.wiki.compileNote}</span> : null}
      </div> : null}

      {/* WMB-5233：空壳诚实三态 —— 尚未整理 / legacy 初始档案，绝不显示“已整理/当前”。 */}
      {compileState === 'uncompiled' || compileState === 'legacy_shell' ? <div className={`topic-wiki-compile-banner compile-state-${compileState}`} role="status">
        <strong>{COMPILE_STATE_LABELS[compileState]}</strong>
        <span>{COMPILE_STATE_HINTS[compileState]}</span>
      </div> : null}

      {wikiRisks && (wikiRisks.disputed > 0 || wikiRisks.inference > 0 || wikiRisks.contradicted > 0 || wikiRisks.stale || wikiRisks.failed) ? <div className="topic-wiki-risks" aria-label="当前认识风险">
        {wikiRisks.disputed > 0 ? <span className="library-topic-badge warn">{RISK_KIND_LABELS.disputed} {wikiRisks.disputed}</span> : null}
        {wikiRisks.contradicted > 0 ? <span className="library-topic-badge danger">{RISK_KIND_LABELS.contradicted} {wikiRisks.contradicted}</span> : null}
        {wikiRisks.inference > 0 ? <span className="library-topic-badge info">{RISK_KIND_LABELS.inference} {wikiRisks.inference}</span> : null}
        {wikiRisks.stale ? <span className="library-topic-badge">{RISK_KIND_LABELS.stale}</span> : null}
        {wikiRisks.failed ? <span className="library-topic-badge danger">{COMPILE_STATUS_LABELS.failed}</span> : null}
      </div> : null}

      <section id="topic-wiki-current" data-wiki-tab="overview" className={`topic-wiki-section topic-wiki-primary${hasCurrentKnowledge ? '' : ' is-empty'}`} aria-labelledby="topic-wiki-current-title" tabIndex={-1}>
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-current-title">当前认识</h3>
          {wikiBody?.asOf ? <span>截至 {formatWhen(wikiBody.asOf)}</span> : null}
        </div>
        {hasCurrentKnowledge ? <>
          {wikiBody?.summary && wikiBody.summary !== '暂无综合摘要。' ? <p className="topic-wiki-summary">{wikiBody.summary}</p> : null}
          {(wikiBody?.keyConclusions ?? []).length ? <div className="library-topic-cards">
            {(wikiBody?.keyConclusions ?? []).map((item, index) => renderKeyConclusion(item, index))}
          </div> : null}
          {(wikiBody?.retainedDisputes ?? []).length ? <section className="library-topic-secondary" aria-label="未解决争议">
            <h4>未解决争议</h4>
            <p className="library-topic-secondary-note">这些主张仍在对抗中，未自动裁决。</p>
            <div className="library-topic-cards">
              {(wikiBody?.retainedDisputes ?? []).map((item, index) => renderKeyConclusion(item, index))}
            </div>
          </section> : null}
        </> : <div className="topic-wiki-empty">
          <span className="empty-mark" aria-hidden="true">◔</span>
          <strong className="topic-wiki-empty-title">还没有形成可复用的认识</strong>
          <p className="topic-wiki-empty-text">已有资料仍在档案中。继续保存可靠来源，资料员会把其中可验证、可复用的部分整理成当前认识。</p>
          <button type="button" className="secondary-button" onClick={() => setDeepMode(true)}>查看已有资料</button>
        </div>}
      </section>

      {sourceTotalCount > 0 ? <section className="topic-wiki-section topic-wiki-sources-preview" data-wiki-tab="overview" aria-labelledby="topic-wiki-sources-title">
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-sources-title">已有资料</h3>
          <button type="button" className="text-button" onClick={openDeepSources}>查看全部 {sourceTotalCount} 份</button>
        </div>
        {sourcesPreview.length ? <div className="topic-wiki-source-list">
          {sourcesPreview.slice(0, 2).map((item) => <article key={itemKey(item)} className="topic-wiki-source-row">
            <SourceMark canonicalUrl={item.metadata?.originalUrl ?? item.metadata?.sourceUrl ?? null} aiSourcePresentation={aiSourcePresentation}/>
            <div className="topic-wiki-source-body">
              <div className="topic-wiki-source-title">{item.title}</div>
              {item.body ? <div className="topic-wiki-source-summary">{item.body}</div> : null}
              <div className="topic-wiki-source-meta">{formatWhen(item.occurredAt)} · 已归入本主题</div>
            </div>
            <span className={`topic-wiki-source-type${item.metadata?.relation === 'primary' ? ' primary' : ''}`}>{relationLabel(item.metadata?.relation)}</span>
          </article>)}
        </div> : <p className="library-panel-empty">资料正在整理中。</p>}
        {sourcesPreview.length > 2 ? <div className="topic-wiki-source-more">
          <button type="button" className="text-button" onClick={openDeepSources}>展开剩余 {sourcesPreview.length - 2} 份资料</button>
        </div> : null}
      </section> : null}

      {receipts.length ? <section className="topic-wiki-section topic-wiki-changes topic-wiki-recent" data-wiki-tab="overview" aria-labelledby="topic-wiki-recent-title">
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-recent-title">最近变化</h3>
          <button type="button" className="text-button" onClick={() => setWikiTab('changes')}>查看全部</button>
        </div>
        <div className="library-topic-cards">
          {receipts.slice(0, 3).map((receipt) => renderWikiReceipt(receipt))}
        </div>
      </section> : null}

      <section id="topic-wiki-changes" data-wiki-tab="changes" className="topic-wiki-section topic-wiki-changes" aria-labelledby="topic-wiki-changes-title" tabIndex={-1}>
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-changes-title">最近变化</h3>
          <span>{wikiDetail.receipts.total} 次更新</span>
        </div>
        {receipts.length ? <div className="library-topic-cards">
          {receipts.map((receipt) => renderWikiReceipt(receipt))}
        </div> : <p className="library-panel-empty">最近还没有认识变化。</p>}
      </section>

      {/* WMB-5239：相关动态 —— 与「最近变化」回执时间线互补的资料摄取/检查/问答（topicId 限定；不复制资料库维护控制台）。 */}
      <section className="topic-wiki-section topic-wiki-changes topic-wiki-activity" data-wiki-tab="changes" aria-labelledby="topic-wiki-activity-title" tabIndex={-1}>
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-activity-title">相关动态</h3>
          <span>资料摄取 · 检查 · 问答</span>
        </div>
        {renderTopicActivityBody()}
      </section>

      {/* WMB-5239：搜索本主题资料 —— 统一搜索按当前主题范围过滤（topicId 真实生效），结果走既有深链。 */}
      <section className="topic-wiki-section topic-wiki-search" data-wiki-tab="sources" aria-labelledby="topic-wiki-search-title" tabIndex={-1}>
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-search-title">搜索本主题资料</h3>
          <span className="topic-index-hint" role="status">{indexHint}</span>
        </div>
        <div className="topic-wiki-search-field">
          <input
            type="search"
            className="topic-wiki-search-input"
            placeholder="在本主题的资料、知识与实体中检索"
            aria-label="搜索本主题资料"
            value={topicSearchQuery}
            onChange={(event) => setTopicSearchQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {renderTopicSearchBody()}
      </section>

      <div className="topic-wiki-secondary" data-wiki-tab="sources" aria-label="认识储备">
        {secondaryEmpty ? <p className="topic-wiki-secondary-empty">认识仍在积累：证据、创作影响与待研究会在情报回流后出现。</p> : null}
        <section id="topic-wiki-evidence" className="topic-wiki-section topic-wiki-compact" aria-labelledby="topic-wiki-evidence-title" tabIndex={-1}>
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-evidence-title">证据</h3>
            <span>{wikiDetail.evidence.total} 条</span>
          </div>
          {wikiDetail.evidence.items.length ? <div className="library-topic-cards">
            {wikiDetail.evidence.items.map((entry) => renderWikiEvidence(entry))}
          </div> : !secondaryEmpty ? <p className="library-panel-empty">暂无证据条目。</p> : null}
        </section>

        <section id="topic-wiki-impact" className="topic-wiki-section topic-wiki-compact" aria-labelledby="topic-wiki-impact-title" tabIndex={-1}>
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-impact-title">创作影响</h3>
            <span>{wikiDetail.creationImpact.total} 条</span>
          </div>
          {wikiDetail.creationImpact.items.length ? <div className="library-topic-cards">
            {wikiDetail.creationImpact.items.map((record) => renderWikiUsage(record))}
          </div> : !secondaryEmpty ? <p className="library-panel-empty">暂无创作使用记录（创作参考当前认识后出现）。</p> : null}
        </section>

        <section id="topic-wiki-research" className="topic-wiki-section topic-wiki-compact" aria-labelledby="topic-wiki-research-title" tabIndex={-1}>
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-research-title">待研究</h3>
            <span>{wikiDetail.questions.length + wikiDetail.healthIssues.total} 项</span>
          </div>
          {wikiDetail.questions.length ? <div className="library-topic-cards">
            {wikiDetail.questions.map((question, index) => <article key={`q-${index}`} className="library-topic-card">
              <p>{question}</p>
            </article>)}
          </div> : null}
          {wikiDetail.healthIssues.items.length ? <div className="library-topic-cards">
            {wikiDetail.healthIssues.items.map((issue) => renderWikiHealth(issue))}
          </div> : null}
          {!wikiDetail.questions.length && !wikiDetail.healthIssues.items.length && !secondaryEmpty ? <p className="library-panel-empty">暂无待研究问题。</p> : null}
        </section>

        <section id="topic-wiki-dossier" className="topic-wiki-section topic-wiki-compact topic-wiki-dossier" aria-labelledby="topic-wiki-dossier-title" tabIndex={-1}>
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-dossier-title">完整档案</h3>
            <span>八类档案</span>
          </div>
          {dossier && Object.values(dossier).some((count) => count > 0) ? <div className="topic-wiki-dossier-counts" aria-label="档案分类计数">
            {DOSSIER_CATEGORY_ORDER.map((category) => <span key={category} className="library-topic-badge">{DOSSIER_LABELS[category]} {dossier[category] ?? 0}</span>)}
          </div> : <p className="library-panel-empty">档案会在资料入库后建立。</p>}
          <div className="library-panel-actions">
            <button type="button" className="text-button" onClick={() => { setDeepMode(true); setDeepCategory(''); }}>打开完整档案</button>
          </div>
        </section>
      </div>

      <section id="topic-wiki-versions" data-wiki-tab="versions" className="topic-wiki-section topic-wiki-compact topic-wiki-versions" aria-labelledby="topic-wiki-versions-title" tabIndex={-1}>
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-versions-title">版本</h3>
          <span>{wikiDetail.versions.total} 个版本</span>
        </div>
        {wikiDetail.versions.items.length ? <div className="library-topic-cards">
          {wikiDetail.versions.items.map((version) => renderWikiVersion(version, version.id === wikiPage?.currentVersionId))}
        </div> : <p className="library-panel-empty">暂无版本记录。</p>}
        {restoreMessage ? <p className="library-topic-action-note" role="status">{restoreMessage}</p> : null}
      </section>
    </div>;
  };

  const homeView = (
    <div className="topic-home" aria-label="主题首页">
      <div className="topic-home-toolbar library-topic-list-toolbar">
        <input
          type="search"
          value={topicQuery}
          placeholder="搜索主题"
          aria-label="搜索主题"
          onChange={(event) => setTopicQuery(event.target.value)}
        />
        <div className="topic-status-filters studio-filter-row" role="group" aria-label="主题状态筛选">
          {STATUS_FILTERS.map((filter) => <button
            key={filter.id}
            type="button"
            className={statusFilter === filter.id ? 'active' : ''}
            aria-pressed={statusFilter === filter.id}
            onClick={() => setStatusFilter(filter.id)}
          >{filter.label}</button>)}
        </div>
        <button type="button" className="topic-maintenance-entry" onClick={() => setMaintenanceOpen(true)}>整理台账</button>
      </div>
      <div
        className="topic-card-grid"
        aria-label="主题卡片"
        ref={listPaneRef as React.RefObject<HTMLDivElement>}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
      >
        {listLoading ? <p className="library-panel-empty library-topic-list-state">正在加载主题…</p> : null}
        {listError ? <div className="library-topic-error library-topic-list-state" role="alert">
          <strong>主题列表失败</strong>
          <p>{listError}</p>
          <button type="button" onClick={() => void loadTopicList()}>重试</button>
        </div> : null}
        {!listLoading && !listError && !topics.length ? <section className="empty-state library-empty topic-home-empty">
          <h2>尚未形成主题</h2>
          <p>{debouncedQuery || statusFilter !== 'all' ? '没有匹配当前筛选的主题。' : '下一轮情报会把资料归入稳定主题。'}</p>
        </section> : null}
        {topics.map((item) => {
          const summary = asString(item.summary);
          const focused = item.id === focusedTopicId;
          return <button
            key={item.id}
            type="button"
            className={`topic-object-card${focused ? ' focused' : ''}`}
            onClick={() => {
              setFocusedTopicId(item.id);
              setSegment('judgments');
              selectTopic(item.id, item.title);
            }}
            onFocus={() => setFocusedTopicId(item.id)}
          >
            <div className="topic-object-card-top">
              <strong>{item.title}</strong>
            </div>
            {/* WMB-5242：当前综合 —— 标题后优先呈现（知识目录语义）。 */}
            {summary ? <p className="topic-object-card-summary topic-object-card-current">{summary}</p> : null}
            <div className="topic-object-card-footer">
              <div className="topic-object-card-meta">{listTopicMeta(item)}</div>
              <span className="topic-object-card-footer-badges">
                {/* WMB-5242：整理状态（已整理 / 初始资料 / 尚未整理）；仅已有数据可推导时展示。 */}
                {item.compileState ? <span className={`topic-compile-state ${item.compileState}`}>
                  {COMPILE_STATE_LABELS[item.compileState] ?? item.compileState}
                </span> : null}
                <span className={`pill-status ${topicStatusClass(item.status)}`}>
                  <span className="dot" />
                  {topicStatusLabel(item.status)}
                </span>
              </span>
            </div>
          </button>;
        })}
      </div>
      {listHasMore ? <div className="library-topic-list-more topic-home-more">
        <button type="button" disabled={listLoadingMore} onClick={loadMoreTopics}>
          {listLoadingMore ? '加载中…' : `加载更多（${topics.length}/${listTotal || topics.length}）`}
        </button>
      </div> : null}
    </div>
  );

  const maintenanceView = (<div className="topic-maintenance-page" aria-label="主题整理台账页面"><header className="topic-maintenance-page-head"><button type="button" className="topic-back-button" onClick={() => setMaintenanceOpen(false)}>← 主题</button><div><h2>整理台账</h2><p>批准当前建议，查看资料员重新整理进度和历史记录。</p></div></header><TopicMaintenanceLedger /></div>);

  if (!selectedTopicId) {
    return <div className="topic-layout topic-layout-home">{maintenanceOpen ? maintenanceView : homeView}</div>;
  }

  return <div className="topic-layout topic-layout-detail">
    <section
      className={`topic-work-pane library-topic-workspace topic-detail-pane${showSourcesRail ? ' with-rail' : ''}`}
      aria-label="主题详情"
      ref={workspaceRef}
      tabIndex={0}
      onKeyDown={onWorkspaceKeyDown}
    >
      {!displayTopic ? <div className="empty-state library-empty">
        <button type="button" className="topic-back-button" onClick={backToGrid}>← 主题</button>
        <h2>{listLoading || segmentLoading ? '正在准备主题' : '主题读取中'}</h2>
        <p>如果长时间无响应，返回主题卡重试。</p>
      </div> : <>
        <header className="topic-object-head">
          <div className="topic-object-head-bar">
            <button type="button" className="topic-back-button" onClick={backToGrid}>← 主题</button>
            <div className="library-topic-head-actions topic-object-head-actions">
              <details className="topic-more">
                <summary>更多</summary>
                <div className="topic-more-menu">
                  {deepMode ? (
                    <button type="button" onClick={() => { setDeepMode(false); setDeepCategory(''); }}>退出档案</button>
                  ) : (
                    <button type="button" onClick={() => { setDeepMode(true); setDeepCategory(''); }}>完整档案</button>
                  )}
                  <button type="button" onClick={goCreate}>去创作</button>
                  {onOpenCanvas ? <button
                    type="button"
                    disabled={canvasBusy}
                    onClick={() => void openCanvasForTopic()}
                  >{canvasBusy ? '处理中…' : '放画布'}</button> : null}
                </div>
              </details>
              <button
                type="button"
                className="primary-button"
                disabled={!piConfigured}
                title={!piConfigured ? '请先配置 Pi' : '基于当前主题让 Pi 出选题方案'}
                onClick={askPiBrief}
              >让 Pi 出选题方案</button>
            </div>
          </div>
          <div className="library-topic-title-row">
            <h2>{displayTopic.title}</h2>
            <span className={`pill-status ${topicStatusClass(displayTopic.status)}`}>
              <span className="dot" />
              {topicStatusLabel(displayTopic.status)}
            </span>
          </div>
          <p className="topic-object-meta">{objectMetaLine}</p>
          {showWikiPage ? <p className="topic-object-meta">{`资料员持续维护${organizeLabel ? ` · 最近整理 ${organizeLabel}` : ''}`}</p> : null}
          {canvasMessage ? <p className="library-topic-action-note">{canvasMessage}</p> : null}
          {!piConfigured ? <p className="library-topic-action-note">Pi 尚未配置时，无法直接生成选题方案。</p> : null}
        </header>

        {deepMode ? <>
          <nav className="library-topic-deep-tabs" aria-label="完整档案分类">
            <button
              type="button"
              className={!deepCategory ? 'active' : ''}
              onClick={() => setDeepCategory('')}
            >全部 <span>{Object.values(counts).reduce((sum, value) => sum + value, 0)}</span></button>
            {DOSSIER_CATEGORY_ORDER.map((category) => <button
              key={category}
              type="button"
              className={deepCategory === category ? 'active' : ''}
              onClick={() => setDeepCategory(category)}
            >{DOSSIER_LABELS[category]} <span>{counts[category] ?? 0}</span></button>)}
          </nav>
          <div className="library-topic-segment-body topic-work-body" data-segment="deep">
            {deepLoading ? <p className="library-panel-empty">正在加载完整档案…</p>
              : deepError ? <div className="library-topic-error" role="alert">
                <strong>完整档案加载失败</strong>
                <p>{deepError}</p>
                <button type="button" onClick={() => setDeepReloadToken((value) => value + 1)}>重试</button>
              </div>
              : !deepItems.length ? <p className="library-panel-empty">这个分类还没有资产。资料 {sourceTotal} · 内容 {contentTotal} · 复盘 {reviewTotal}。</p>
                : <>
                  <div className="library-topic-section-head">
                    <h3>{deepCategory ? DOSSIER_LABELS[deepCategory] : '全部档案'}</h3>
                    <span>{deepItems.length}/{deepTotal || deepItems.length}</span>
                  </div>
                  {sourceActionError ? <p className="library-topic-action-note danger">{sourceActionError}</p> : null}
                  <div className="library-topic-cards">
                    {deepItems.map((item) => renderDeepItem(item))}
                  </div>
                  {deepHasMore ? <div className="library-topic-list-more">
                    <button type="button" disabled={deepLoadingMore} onClick={() => void loadMoreDeep()}>
                      {deepLoadingMore ? '加载中…' : '加载更多'}
                    </button>
                  </div> : null}
                </>}
          </div>
        </> : !wikiDetail && wikiError ? <div className="library-topic-error" role="alert">
            <strong>主题加载失败</strong>
            <p>{wikiError}</p>
            <button type="button" onClick={() => setWikiReloadToken((value) => value + 1)}>重试</button>
          </div>
          : !wikiDetail ? <p className="library-panel-empty">正在加载主题…</p>
          : showWikiPage ? renderWikiPage() : <>
          <p className="library-topic-action-note">本主题还没有整理出当前认识：继续保存资料后，资料员会在这里持续汇总。以下为现有档案。</p>
          <nav className="topic-work-tabs" aria-label="主题工作分段">
            <button type="button" className={segment === 'judgments' ? 'active' : ''} onClick={() => setSegment('judgments')}>
              判断 <span>{counts.judgments}</span>
            </button>
            <button type="button" className={segment === 'sources' ? 'active' : ''} onClick={() => setSegment('sources')}>
              证据 <span>{sourceTotal}</span>
            </button>
            <button type="button" className={segment === 'outcomes' ? 'active' : ''} onClick={() => setSegment('outcomes')}>
              回流 <span>{outcomeBadge}</span>
            </button>
          </nav>

          <div className="library-topic-main-row">
            <div className="library-topic-segment-body topic-work-body" data-segment={segment}>
              {segment === 'judgments' ? (
                segmentLoading ? <p className="library-panel-empty">正在加载判断…</p>
                  : segmentError ? <div className="library-topic-error" role="alert">
                    <strong>判断加载失败</strong>
                    <p>{segmentError}</p>
                    <button type="button" onClick={() => setSegmentReloadToken((value) => value + 1)}>重试</button>
                  </div>
                  : judgments.length ? <div className="library-topic-cards">
                    {judgments.map((item) => <article key={itemKey(item)} className="library-topic-card">
                      <header>
                        <strong>{item.title || '判断'}</strong>
                        <time>{formatWhen(item.occurredAt)}</time>
                      </header>
                      <p>{item.body || '暂无正文'}</p>
                      {(item.metadata?.whyNow || item.metadata?.timeliness) ? <div className="library-topic-card-meta">
                        {item.metadata.whyNow ? <span>为何现在：{item.metadata.whyNow}</span> : null}
                        {item.metadata.timeliness ? <span>时效：{item.metadata.timeliness}</span> : null}
                      </div> : null}
                    </article>)}
                    {renderMethodFindings()}
                  </div> : <div className="library-topic-empty-block">
                    <p className="library-panel-empty">尚未沉淀判断（来自计划观点）。可先看证据或等今日机会回流。</p>
                    {renderMethodFindings()}
                  </div>
              ) : null}

              {segment === 'sources' ? (
                segmentLoading ? <p className="library-panel-empty">正在加载证据…</p>
                  : segmentError ? <div className="library-topic-error" role="alert">
                    <strong>证据加载失败</strong>
                    <p>{segmentError}</p>
                    <button type="button" onClick={() => setSegmentReloadToken((value) => value + 1)}>重试</button>
                  </div>
                  : (!sources.length && !counterEvidence.length) ? <p className="library-panel-empty">这个主题还没有关联证据。计数以档案为准：资料 {counts.sources} · 反证 {counts.counter_evidence}。</p>
                    : <div className="library-topic-sources">
                      <div className="library-topic-section-head">
                        <h3>支撑证据</h3>
                        <span>真计数 {counts.sources} · 反证 {counts.counter_evidence}</span>
                      </div>
                      {sourceActionError ? <p className="library-topic-action-note danger">{sourceActionError}</p> : null}
                      {sources.length ? <div className="library-topic-cards">
                        {sources.map((item) => renderSourceCard(item))}
                      </div> : <p className="library-panel-empty">暂无主证据条目。</p>}
                      {counterEvidence.length ? <section className="library-topic-counter" aria-label="反证资料">
                        <div className="library-topic-section-head">
                          <h3>反证</h3>
                          <span>{counterEvidence.length} 条</span>
                        </div>
                        <div className="library-topic-cards">
                          {counterEvidence.map((item) => renderSourceCard(item, true))}
                        </div>
                      </section> : null}
                    </div>
              ) : null}

              {segment === 'outcomes' ? (
                segmentLoading ? <p className="library-panel-empty">正在加载回流…</p>
                  : segmentError ? <div className="library-topic-error" role="alert">
                    <strong>回流加载失败</strong>
                    <p>{segmentError}</p>
                    <button type="button" onClick={() => setSegmentReloadToken((value) => value + 1)}>重试</button>
                  </div>
                  : (!(opportunities.length || contentHistory.length || metrics.length || reviews.length)) ? <p className="library-panel-empty">还没有关联机会、内容或复盘教训回流到这个主题。</p>
                    : <div className="library-topic-outcomes">
                      <section className="library-topic-outcome-block">
                        <div className="library-topic-section-head">
                          <h3>关联机会</h3>
                          <span>{opportunities.length} 条</span>
                        </div>
                        {opportunities.length ? <div className="library-topic-cards">
                          {opportunities.map((item) => <article key={item.id} className="library-topic-card">
                            <header>
                              <strong>{item.title}</strong>
                              <time>{item.planDate || '计划日未知'}</time>
                            </header>
                            <p>优先级 {item.priority ?? '—'}</p>
                          </article>)}
                        </div> : <p className="library-panel-empty">暂无关联机会。</p>}
                      </section>

                      <section className="library-topic-outcome-block">
                        <div className="library-topic-section-head">
                          <h3>关联内容</h3>
                          <span>档案计数 {counts.content_history}</span>
                        </div>
                        {contentHistory.length ? <div className="library-topic-cards">
                          {contentHistory.map((item) => <article key={itemKey(item)} className="library-topic-card">
                            <header>
                              <strong>{item.title}</strong>
                              <time>{formatWhen(item.occurredAt)}</time>
                            </header>
                            <p>{item.body || '暂无正文摘要'}</p>
                            <div className="library-topic-card-meta">
                              <span>状态 {item.metadata?.status || '未知'}{item.metadata?.archived ? ' · 已归档' : ''}</span>
                            </div>
                            {item.objectType === 'content_project' && onOpenStudio ? <div className="library-panel-actions">
                              <button type="button" className="text-button" onClick={() => onOpenStudio(item.objectId)}>打开创作</button>
                            </div> : null}
                          </article>)}
                        </div> : <p className="library-panel-empty">暂无关联内容。</p>}
                      </section>

                      {metrics.length ? <section className="library-topic-outcome-block">
                        <div className="library-topic-section-head">
                          <h3>指标快照</h3>
                          <span>档案计数 {counts.metrics}</span>
                        </div>
                        <div className="library-topic-cards">
                          {metrics.map((item) => {
                            const body = prettyJsonish(item.body) || item.body || '暂无指标明细';
                            return <article key={itemKey(item)} className="library-topic-card">
                              <header>
                                <strong>{item.title}</strong>
                                <time>{formatWhen(item.occurredAt)}</time>
                              </header>
                              <p className="library-topic-metric-body">{body}</p>
                              {item.metadata?.sourceUrl ? <div className="library-panel-actions">
                                <button type="button" className="text-button" onClick={() => void window.wmb.openExternal(String(item.metadata?.sourceUrl))}>来源 ↗</button>
                              </div> : null}
                            </article>;
                          })}
                        </div>
                      </section> : null}

                      <section className="library-topic-outcome-block">
                        <div className="library-topic-section-head">
                          <h3>复盘教训</h3>
                          <span>档案计数 {counts.reviews}</span>
                        </div>
                        {reviews.length ? <div className="library-topic-cards">
                          {reviews.map((item) => {
                            const key = itemKey(item);
                            const expanded = expandedReviews[key] ?? true;
                            const keep = prettyJsonish(item.metadata?.keep ?? null);
                            const stop = prettyJsonish(item.metadata?.stop ?? null);
                            const change = prettyJsonish(item.metadata?.change ?? null);
                            return <article key={key} className="library-topic-card">
                              <header>
                                <strong>{item.title || '复盘'}</strong>
                                <div className="library-topic-card-badges">
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() => setExpandedReviews((current) => ({ ...current, [key]: !expanded }))}
                                  >{expanded ? '收起' : '展开'}</button>
                                  <time>{formatWhen(item.occurredAt)}</time>
                                </div>
                              </header>
                              <p>{item.body || '无摘要'}</p>
                              {expanded && (keep || stop || change) ? <div className="library-topic-ksc">
                                {keep ? <div><b>Keep</b><span>{keep}</span></div> : null}
                                {stop ? <div><b>Stop</b><span>{stop}</span></div> : null}
                                {change ? <div><b>Change</b><span>{change}</span></div> : null}
                              </div> : null}
                            </article>;
                          })}
                        </div> : <p className="library-panel-empty">暂无复盘教训（Keep / Stop / Change）。</p>}
                      </section>
                    </div>
              ) : null}
            </div>

            {showSourcesRail ? <aside className="library-topic-rail topic-rail" aria-label="证据侧栏">
              <div className="library-topic-section-head">
                <h3>证据</h3>
                <span>{counts.sources}</span>
              </div>
              {sourcesPreview.length ? <ul className="library-topic-rail-list">
                {sourcesPreview.map((item) => <li key={itemKey(item)}>
                  <button type="button" onClick={() => setSegment('sources')}>
                    <strong>{item.title}</strong>
                    <span>{relationLabel(item.metadata?.relation)}</span>
                  </button>
                </li>)}
              </ul> : <p className="library-panel-empty">{segmentLoading ? '加载证据…' : '暂无证据标题'}</p>}
              <button type="button" className="text-button library-topic-rail-open" onClick={() => setSegment('sources')}>查看全部证据</button>
            </aside> : null}
          </div>
        </>}
      </>}
    </section>
  </div>;
}
