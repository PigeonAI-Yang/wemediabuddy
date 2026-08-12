import type {
  KnowledgeFlywheelListResult,
  KnowledgeUpdateReceiptRecord,
} from '../shared/knowledge-flywheel';
import type {
  SourceKnowledgeDetail,
} from '../shared/knowledge-topic-library';

export type LibrarySection = 'saved' | 'pending' | 'health' | 'removed';

export type LibrarySourceItem = {
  id: string;
  title: string;
  originalUrl?: string | null;
  author?: string | null;
  summary?: string | null;
  publishedAt?: string | null;
  collectedAt?: string | null;
  verificationStatus?: string;
  managementStatus?: string;
  revision?: number;
  topics?: string;
  opportunityCount?: number;
  projectCount?: number;
  publicationCount?: number;
  reason?: string;
  priority?: number;
  /** source_lane_judgments 最新一行（WMB-4944「已移出」徽标数据源；无判定行 = 主编手动归档）。 */
  laneJudgment?: {
    decision?: string;
    reasonCode?: string;
    reason?: string | null;
    judgedBy?: string;
    judgedAt?: string;
  } | null;
};

export type SourceKnowledgeContext = {
  topics: Array<{ id: string; title: string }>;
  opportunities: unknown[];
  projects: unknown[];
  publications: unknown[];
  reviews: Array<{ id: string; summary?: string | null }>;
  findings: Array<{ id: string; title?: string | null; body?: string | null }>;
};

export type KnowledgeSourcePage = {
  items: LibrarySourceItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type RediscoveryItem = {
  id: string;
  title: string;
  reason?: string;
  priority?: number;
  collectedAt?: string | null;
  /** WMB-5212：backend 在待处理池条目上附加最近一条摄取回执（证据变化摘要）。 */
  latestReceipt?: KnowledgeUpdateReceiptRecord | null;
};

// =====================================================================
// WMB-5212 资料库知识面：backend 契约类型（真源 src/shared/knowledge-topic-library.ts）。
// 本文件只做防御性归一与展示映射；不创建第二套对象身份、不做任何写操作。
// =====================================================================

export type {
  SourceEvidenceEntry,
  SourceKnowledgeDetail,
  KnowledgeDeepLinkPayload,
} from '../shared/knowledge-topic-library';

export function isLibrarySection(value: string | null): value is LibrarySection {
  return value === 'saved' || value === 'pending' || value === 'health' || value === 'removed';
}

/** 旧「重发」段 id 一次性兼容迁移：rediscovery → pending（设计 §9 旧键迁移）。 */
export function migrateLibrarySection(value: string | null): LibrarySection | null {
  if (value === 'rediscovery') return 'pending';
  return isLibrarySection(value) ? value : null;
}

export function asSourceKnowledgeContext(value: unknown): SourceKnowledgeContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const topics = Array.isArray(record.topics) ? record.topics.filter((item): item is { id: string; title: string } => {
    if (!item || typeof item !== 'object') return false;
    const topic = item as Record<string, unknown>;
    return typeof topic.id === 'string' && typeof topic.title === 'string';
  }) : [];
  const reviews = Array.isArray(record.reviews) ? record.reviews.filter((item): item is { id: string; summary?: string | null } => {
    if (!item || typeof item !== 'object') return false;
    return typeof (item as Record<string, unknown>).id === 'string';
  }) : [];
  const findings = Array.isArray(record.findings) ? record.findings.filter((item): item is { id: string; title?: string | null; body?: string | null } => {
    if (!item || typeof item !== 'object') return false;
    return typeof (item as Record<string, unknown>).id === 'string';
  }) : [];
  return {
    topics,
    opportunities: Array.isArray(record.opportunities) ? record.opportunities : [],
    projects: Array.isArray(record.projects) ? record.projects : [],
    publications: Array.isArray(record.publications) ? record.publications : [],
    reviews,
    findings
  };
}

/** 归一 source 详情聚合（backend 信封 → 本组件模型；缺字段按空信封处理）。 */
export function asSourceKnowledgeDetail(value: unknown): SourceKnowledgeDetail | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const sourceId = typeof record.sourceId === 'string' ? record.sourceId : '';
  if (!sourceId) return null;
  const emptyPage = (): KnowledgeFlywheelListResult<never> => ({ items: [], total: 0, limit: 20, offset: 0, hasMore: false });
  const pageOf = (name: string): KnowledgeFlywheelListResult<unknown> => {
    const envelope = record[name];
    if (!envelope || typeof envelope !== 'object') return emptyPage();
    const box = envelope as Record<string, unknown>;
    const items = Array.isArray(box.items) ? box.items : [];
    return {
      items,
      total: Number(box.total ?? items.length),
      limit: Number(box.limit ?? 20),
      offset: Number(box.offset ?? 0),
      hasMore: Boolean(box.hasMore)
    };
  };
  const topics = Array.isArray(record.topics) ? (record.topics as Array<Record<string, unknown>>).filter(
    (item): item is { id: string; title: string; status: string } => !!item && typeof item.id === 'string' && typeof item.title === 'string'
  ) as SourceKnowledgeDetail['topics'] : [];
  return {
    sourceId,
    source: record.source && typeof record.source === 'object' ? record.source as SourceKnowledgeDetail['source'] : null,
    topics,
    evidence: pageOf('evidence') as SourceKnowledgeDetail['evidence'],
    receipts: pageOf('receipts') as SourceKnowledgeDetail['receipts'],
    healthIssues: pageOf('healthIssues') as SourceKnowledgeDetail['healthIssues'],
    annotations: pageOf('annotations') as SourceKnowledgeDetail['annotations']
  };
}

// =====================================================================
// 展示标签（只读映射；不创建第二套对象身份，不做任何写操作）
// =====================================================================

const EVIDENCE_RELATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  supports: '支持',
  contradicts: '反驳',
  qualifies: '限定',
  derived_from: '派生'
});
export function evidenceRelationLabel(relation: string | null | undefined): string {
  return EVIDENCE_RELATION_LABELS[String(relation ?? '')] ?? String(relation ?? '');
}

const EVIDENCE_NATURE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  primary_source: '一手来源',
  secondary_source: '二手来源',
  user_statement: '用户陈述',
  user_experience: '用户经验',
  business_record: '业务记录',
  performance_observation: '表现观察',
  review: '复盘',
  derived_knowledge: '派生知识',
  ai_inference: 'AI 推断'
});
export function evidenceNatureLabel(nature: string | null | undefined): string {
  return EVIDENCE_NATURE_LABELS[String(nature ?? '')] ?? String(nature ?? '');
}

const RECEIPT_TRIGGER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ingest: '资料摄取',
  query: '问答写回',
  lint: '健康检查',
  creation: '创作引用',
  review: '复盘回流'
});
export function receiptTriggerLabel(triggerType: string | null | undefined): string {
  return RECEIPT_TRIGGER_LABELS[String(triggerType ?? '')] ?? String(triggerType ?? '');
}

const HEALTH_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  open: '未处理',
  repairing: '修复中',
  resolved: '已解决',
  accepted_risk: '接受风险',
  false_positive: '误报'
});
export function healthStatusLabel(status: string | null | undefined): string {
  return HEALTH_STATUS_LABELS[String(status ?? '')] ?? String(status ?? '');
}

const ANNOTATION_INTENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  correction: '纠正',
  qualify: '限定',
  downgrade: '降级',
  emphasize: '强调',
  research_request: '研究请求',
  merge: '合并',
  split: '拆分',
  restore: '恢复',
  comment: '评论'
});
export function annotationIntentLabel(intent: string | null | undefined): string {
  return ANNOTATION_INTENT_LABELS[String(intent ?? '')] ?? String(intent ?? '');
}

const CONCLUSION_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  unverified: '未验证',
  supported: '已支持',
  disputed: '有争议',
  contradicted: '被反驳',
  superseded: '已被替代',
  not_applicable: '不适用',
  inference: '推断'
});
export function conclusionStatusLabel(status: string | null | undefined): string {
  return CONCLUSION_STATUS_LABELS[String(status ?? '')] ?? String(status ?? '');
}

const BODY_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ready: '正文已抓取',
  failed: '抓取失败',
  empty: '无正文',
  none: '尚未抓取'
});
export function bodyStatusLabel(status: string | null | undefined): string {
  return BODY_STATUS_LABELS[String(status ?? '')] ?? String(status ?? '');
}

// =====================================================================
// 资料消化摘要（回执 → 资料行内联状态）
// =====================================================================

/** ingest/重编译回执的 impact.sourceId 归属（compiler 契约：ingest 回执必带）。 */
export function receiptSourceId(receipt: KnowledgeUpdateReceiptRecord): string | null {
  const impact = receipt.impact as Readonly<Record<string, unknown>> | null | undefined;
  return impact && typeof impact.sourceId === 'string' ? impact.sourceId : null;
}

export type SourceDigest = {
  receipts: KnowledgeUpdateReceiptRecord[];
  latest: KnowledgeUpdateReceiptRecord | null;
  /** 最近知识变化一句话（回执 summary，无回执时为 null）。 */
  summary: string | null;
  updatedAt: string | null;
};

/** 按 impact.sourceId 归属回执；无匹配 → 空摘要（未消化）。 */
export function digestForSource(
  receipts: readonly KnowledgeUpdateReceiptRecord[] | null | undefined,
  sourceId: string,
): SourceDigest {
  const matched = (receipts ?? []).filter((receipt) => receiptSourceId(receipt) === sourceId);
  const latest = matched.length ? matched.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b)) : null;
  return {
    receipts: [...matched].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
    latest,
    summary: latest?.summary ?? null,
    updatedAt: latest?.createdAt ?? null
  };
}

/** 回执计数的可读摘要（知识变化部分），用于列表行与回执面板。 */
export function receiptCountsSummary(counts: Readonly<Record<string, number>> | null | undefined): string {
  const c = counts ?? {};
  const parts: string[] = [];
  const add = (key: string, label: string) => {
    const value = Number(c[key] ?? 0);
    if (value > 0) parts.push(`${label} ${value}`);
  };
  add('notesCreated', '新增');
  add('notesUpdated', '更新');
  add('noteVersionsCreated', '新版本');
  add('wikiPagesCompiled', '重编译');
  add('evidenceLinks', '证据');
  add('entitiesCreated', '新实体');
  add('entitiesMatched', '匹配实体');
  return parts.join(' · ') || '无知识变化';
}

/** 资料行内联状态徽标（正文缓存 + 是否已消化 + 未处理健康问题数）。 */
export function sourceListBadges(opts: {
  bodyStatus?: string;
  digested?: boolean;
  openHealthIssues?: number;
}): Array<{ cls: string; text: string }> {
  const badges: Array<{ cls: string; text: string }> = [];
  if (opts.bodyStatus === 'ready') badges.push({ cls: 'green', text: '正文已抓取' });
  else if (opts.bodyStatus === 'failed') badges.push({ cls: 'amber', text: '正文抓取失败' });
  else if (opts.bodyStatus === 'empty') badges.push({ cls: 'gray', text: '无正文' });
  if (opts.digested) badges.push({ cls: 'green', text: '已消化' });
  if (opts.openHealthIssues && opts.openHealthIssues > 0) {
    badges.push({ cls: 'amber', text: `健康问题 ${opts.openHealthIssues}` });
  }
  return badges;
}

/** 来源质量画像（详情页「质量」区：核验/管理/优先级/正文/消化/证据/健康）。 */
export function sourceQualityProfile(source: LibrarySourceItem, extras: {
  bodyStatus?: string;
  digested?: boolean;
  evidenceCount?: number;
  openHealthIssues?: number;
}) {
  const verification = source.verificationStatus === 'verified' ? { cls: 'green', text: '已核验' }
    : source.verificationStatus === 'disputed' ? { cls: 'amber', text: '有争议' }
    : source.verificationStatus === 'rejected' ? { cls: 'gray', text: '已排除' }
    : { cls: 'gray', text: '待核验' };
  const management = source.managementStatus === 'watching' ? { cls: 'blue', text: '观察中' }
    : source.managementStatus === 'archived' ? { cls: 'gray', text: '已归档' }
    : source.managementStatus === 'expired' ? { cls: 'gray', text: '已过期' }
    : { cls: 'green', text: '活跃' };
  return {
    verification,
    management,
    priority: source.priority ?? null,
    bodyStatus: extras.bodyStatus ?? 'none',
    digested: extras.digested ?? false,
    evidenceCount: extras.evidenceCount ?? 0,
    openHealthIssues: extras.openHealthIssues ?? 0
  };
}

/** 知识健康问题严重度 → 徽标类名（与画布三模式同一套严重度排序）。 */
export function healthSeverityCls(severity: string | null | undefined): string {
  const value = String(severity ?? '');
  if (value === 'critical' || value === 'high') return 'critical';
  if (value === 'medium') return 'medium';
  return 'low';
}

/** dataChanged 触发资料库刷新的 scope（设计 §9：knowledge/topics/canvas/health/receipt + 既有 library/sources）。 */
export const LIBRARY_REFRESH_SCOPES: readonly string[] = ['sources', 'library', 'knowledge', 'topics', 'receipt', 'health'];
export function shouldRefreshLibrary(scopes: readonly string[] | null | undefined): boolean {
  if (!scopes || !scopes.length) return true;
  return scopes.some((scope) => LIBRARY_REFRESH_SCOPES.includes(scope));
}
