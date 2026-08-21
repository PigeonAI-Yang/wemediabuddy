// extracted from library-topics-view.tsx (structural split)
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

export type TopicStatus = 'active' | 'watching' | 'dormant' | string;
export type TopicStatusFilter = 'all' | 'active' | 'watching' | 'dormant';

export type TopicListItem = {
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

export type TopicListPage = {
  items: TopicListItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type DossierCategory =
  | 'sources'
  | 'judgments'
  | 'audience_demands'
  | 'counter_evidence'
  | 'content_history'
  | 'metrics'
  | 'reviews'
  | 'method_findings';

export type DossierCounts = Record<DossierCategory, number>;

export type DossierMetadata = {
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

export type DossierItem = {
  category: DossierCategory | string;
  objectId: string;
  objectType: string;
  title: string;
  body?: string | null;
  occurredAt?: string | null;
  metadata?: DossierMetadata | null;
};

export type DossierTopic = {
  id: string;
  title: string;
  kind?: string | null;
  summary?: string | null;
  status?: TopicStatus | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  revision?: number;
};

export type DossierPage = {
  topic: DossierTopic;
  counts: DossierCounts;
  items: DossierItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type ContextOpportunity = {
  id: string;
  title: string;
  priority: number | null;
  planDate: string | null;
};

export type KnowledgeContextPage = {
  opportunities: ContextOpportunity[];
};

export type WorkspaceSegment = 'judgments' | 'sources' | 'outcomes';
export type VerificationStatus = 'pending' | 'verified' | 'disputed' | 'rejected';
export type ManagementStatus = 'active' | 'watching' | 'expired' | 'archived';

// helpers-internal constants (mirrored from constants file to avoid circular)
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
const LIST_LIMIT = 50;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function parseMaybeJson(value: unknown): unknown {
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

export function normalizeMetadata(raw: unknown): DossierMetadata {
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

export function normalizeDossierItem(raw: unknown): DossierItem | null {
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

export function normalizeDossierPage(raw: unknown): DossierPage | null {
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

export function normalizeTopicListItem(raw: unknown): TopicListItem | null {
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

export function normalizeTopicListPage(raw: unknown): TopicListPage {
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

export function normalizeKnowledgeContext(raw: unknown): KnowledgeContextPage {
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

export function normalizeWikiPageRecord(raw: unknown): KnowledgeWikiPageRecord | null {
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

export function normalizeWikiPageVersionRecord(raw: unknown): KnowledgeWikiPageVersionRecord | null {
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

export function normalizeKeyConclusion(raw: unknown): TopicWikiKeyConclusion | null {
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

export function normalizeTopicWikiBody(raw: unknown): TopicWikiBody | null {
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

export function normalizeEvidenceEntry(raw: unknown): TopicEvidenceEntry | null {
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

export function normalizeUsageRecord(raw: unknown): KnowledgeUsageRecordRecord | null {
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

export function normalizeHealthIssueRecord(raw: unknown): KnowledgeHealthIssueRecord | null {
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

export function normalizeReceiptRecord(raw: unknown): KnowledgeUpdateReceiptRecord | null {
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

export function normalizeListPage<T>(
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

export function offsetAndTotal(record: Record<string, unknown> | null | undefined, itemsLength: number): boolean {
  if (!record) return false;
  const offset = asNumber(record.offset) ?? 0;
  const total = asNumber(record.total) ?? itemsLength;
  return offset + itemsLength < total;
}

export function normalizeTopicWikiDetail(raw: unknown): TopicWikiDetail | null {
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

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '未知错误');
}

export function topicStatusLabel(status?: string | null): string {
  if (status === 'watching') return '持续观察';
  if (status === 'dormant') return '休眠';
  if (status === 'archived') return '已归档';
  return '活跃';
}

export function topicStatusClass(status?: string | null): string {
  if (status === 'watching') return 'amber';
  if (status === 'dormant' || status === 'archived') return 'gray';
  return 'green';
}

export function changeTypeLabel(value?: string | null): string {
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

export function kindLabel(value?: string | null): string {
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

export function verificationLabel(value?: string | null): string {
  if (value === 'verified') return '已核验';
  if (value === 'disputed') return '有争议';
  if (value === 'rejected') return '已排除';
  return '待核验';
}

export function managementLabel(value?: string | null): string {
  if (value === 'watching') return '观察中';
  if (value === 'archived') return '已归档';
  if (value === 'expired') return '已过期';
  return '活跃';
}

export function relationLabel(value?: string | null): string {
  if (value === 'contradicting') return '反证';
  if (value === 'primary') return '主证';
  if (value === 'supporting') return '佐证';
  if (!value) return '关联';
  return value;
}

export function formatRelativeTime(value?: string | null): string | null {
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

export function formatWhen(value?: string | null): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN');
}

export function prettyJsonish(value?: string | null): string | null {
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

export function itemKey(item: DossierItem): string {
  return `${item.category}:${item.objectId}:${item.occurredAt ?? ''}`;
}

export function patchSourceItem(
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
export function listTopicMeta(item: TopicListItem): string {
  const parts: string[] = [];
  const relative = formatRelativeTime(item.lastSeenAt);
  if (relative) parts.push(`更新于 ${relative}`);
  parts.push(`${item.sourceCount ?? 0} 资料`);
  if (item.contentCount != null) parts.push(`${item.contentCount} 内容`);
  if (item.publicationCount != null && item.publicationCount > 0) parts.push(`${item.publicationCount} 发布`);
  return parts.join(' · ');
}

