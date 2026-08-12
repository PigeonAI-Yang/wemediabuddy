/**
 * WMB-5217 M8：历史初始化（legacy knowledge init backfill）。
 * Design: docs/spark/2026-08-12-wmb-knowledge-flywheel-migration-delivery-acceptance-design.md §3–§4、§7。
 *
 * 职责（对照设计 §4 顺序）：
 * 1) 为每个 active Topic（topics.status IN ('active','watching')）幂等创建唯一 stable
 *    Topic WikiPage（初版 flags=['migration','derived-from-legacy']），输入只来自
 *    topic.summary + 既有 dossier 读模型（topic_source_links/source_items/reviews/method_findings）；
 *    不创建平行 Topic/Source 身份；已有 active Topic Wiki 的 Topic 跳过（skipped_already_has_wiki）。
 * 2) verified 高价值 Source / final Review / Method Finding 仅作候选：只在证据明确时经真实
 *    ChangeSet 创建 KnowledgeNote（conclusionStatus 保持 unverified/inference，绝不伪造 verified），
 *    其余保持 Raw/Evidence（回执 failures 记录 kept-raw 明细），交后续增量编译。
 * 3) 每个 Topic 一个原子 ChangeSet + 可读初始化回执（triggerType='migration'）+ 按需健康问题
 *    （无任何来源证据的 Topic Wiki → orphan_knowledge）。
 * 4) 幂等/可重跑/可中断恢复：稳定 requestId `legacy-init:{topicId}` + knowledge_legacy_init_state
 *    checkpoint；同输入重放零写；异输入/已有页面跳过不覆盖；failed 允许下次重试。
 * 5) workspace/data-root 隔离：无 workspace 身份（精简 fixture/历史库）跳过知识写入，不视为失败；
 *    所有知识写入只经 applyKnowledgeChangeSet。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { dispatchBusinessCommand } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  applyKnowledgeChangeSet,
  createKnowledgeChangeSetInputHash,
  KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND,
  type ConclusionStatus,
  type EvidenceLevel,
  type EvidenceLinkWrite,
  type HealthIssueCreateWrite,
  type KnowledgeChangeSetInput,
  type KnowledgeChangeSetMeta,
  type KnowledgeScope,
  type NoteKind,
  type NoteVersionChangeType,
  type NoteWrite,
  type SourceNature,
  type WikiPageWrite
} from './knowledge-flywheel.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

/** 引入本初始化的 schema migration 版本（写入 knowledge_legacy_init_state.migration_version）。 */
export const LEGACY_KNOWLEDGE_INIT_MIGRATION_VERSION = 58 as const;

/** 启动钩子的 scheduler actor（与周期 Lint scheduler 同构；scheduler 命令不需要 capability 注册）。 */
export const legacyInitSchedulerActor = Object.freeze({
  type: 'scheduler',
  id: 'knowledge-init',
  label: 'knowledge-init'
}) as Readonly<{ type: 'scheduler'; id: string; label: string }>;

/** 稳定幂等键：`legacy-init:{topicId}`（同 topic 同输入重放零写；异输入由 store 拒绝）。 */
export function legacyInitRequestId(topicId: string): string {
  return `legacy-init:${topicId}`;
}

// ============================================================
// 结果/输入类型
// ============================================================

export type LegacyKnowledgeInitTopicStatus =
  | 'initialized'
  | 'replayed'
  | 'already_initialized'
  | 'skipped_no_workspace'
  | 'skipped_already_has_wiki'
  | 'skipped_state_changed'
  | 'skipped_inactive'
  | 'failed';

export type LegacyKnowledgeInitTopicResult = Readonly<{
  topicId: string;
  status: LegacyKnowledgeInitTopicStatus;
  wikiPageId: string | null;
  wikiPageVersionId: string | null;
  changeSetId: string | null;
  receiptId: string | null;
  /** 晋升/保留计数（skips/failed 为 null）。 */
  counts: Readonly<Record<string, number>> | null;
  /** kept-raw 明细（`raw:{type}:{id}:{reason}`）。 */
  keptRaw: readonly string[];
  error: string | null;
}>;

export type LegacyKnowledgeInitInput = Readonly<{
  /** 缺省时从 app_meta.workspace_id 读取；无身份（精简 fixture/历史库）→ 全量跳过知识写入。 */
  workspaceId?: string;
  scope?: KnowledgeScope;
  /** 只初始化指定 Topic（测试/定点重跑）；缺省 = 全部 active Topic。 */
  topicIds?: readonly string[];
  /**
   * false = 调用方（CommandDispatcher）已 BEGIN IMMEDIATE 包裹本调用（生产启动钩子按 Topic
   * 逐个 dispatch，事务粒度 = 单 Topic，写经 write-guard 授权）；省略/true = 模块自管每
   * Topic 事务（直连/测试）。
   */
  transaction?: boolean;
}>;

export type LegacyKnowledgeInitResult = Readonly<{
  ok: boolean;
  workspaceId: string | null;
  scope: KnowledgeScope;
  migrationVersion: number;
  topics: readonly LegacyKnowledgeInitTopicResult[];
  totals: Readonly<{
    topics: number;
    initialized: number;
    replayed: number;
    alreadyInitialized: number;
    skipped: number;
    failed: number;
    notesCreated: number;
    evidenceLinks: number;
    wikiPagesCreated: number;
  }>;
}>;

// ============================================================
// 工具
// ============================================================

function normalizeCanonicalKey(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 确定性对象 id（幂等关键）：ChangeSet 输入必须是计划的纯函数。 */
function deterministicId(prefix: string, seed: string): string {
  return `${prefix}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function dateOnly(value: string | null | undefined): string {
  return value ? String(value).slice(0, 10) : '';
}

/** 工作空间身份（app_meta）；无绑定（精简 fixture/历史库）→ null，调用方跳过知识写入。 */
function readBoundWorkspaceId(database: DatabaseSync): string | null {
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function noteExists(database: DatabaseSync, scope: KnowledgeScope, canonicalKey: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM knowledge_notes WHERE scope = ? AND canonical_key = ?').get(scope, canonicalKey));
}

// ============================================================
// 计划（冻结的纯函数输入；同 DB 状态 → 同计划 → 同 inputHash → 重放零写）
// ============================================================

type LegacyInitTopicRow = Readonly<{
  id: string;
  title: string;
  summary: string | null;
  status: string;
  lastSeenAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
}>;

type LegacyInitSourceRow = Readonly<{
  id: string;
  title: string;
  summary: string | null;
  relation: string;
  revision: number;
  priority: number;
  verificationStatus: string;
  publishedAt: string | null;
  collectedAt: string | null;
}>;

type LegacyInitReviewRow = Readonly<{
  id: string;
  publicationId: string;
  summary: string | null;
  platform: string | null;
  finalizedAt: string | null;
  keepJson: string;
  stopJson: string;
  changeJson: string;
  metricSnapshotCount: number;
}>;

type LegacyInitFindingRow = Readonly<{
  id: string;
  reviewId: string;
  title: string | null;
  body: string | null;
}>;

type LegacyInitPlan = Readonly<{
  workspaceId: string;
  topicId: string;
  scope: KnowledgeScope;
  topicTitle: string;
  topicSummary: string;
  asOf: string;
  /** 关联的非 archived Source 总数（health orphan 判据）。 */
  sourceCount: number;
  sources: readonly LegacyInitSourceRow[];
  reviews: readonly LegacyInitReviewRow[];
  findings: readonly LegacyInitFindingRow[];
}>;

type PromotedEntry = Readonly<{
  noteId: string;
  versionId: string;
  canonicalKey: string;
  kind: NoteKind;
  changeType: NoteVersionChangeType;
  statement: string;
  conclusionStatus: ConclusionStatus;
  evidenceLevel: EvidenceLevel;
  appliesTo: string;
  disputed: boolean;
}>;

const REVIEW_LINKAGE_WHERE = `WHERE r.status = 'final'
  AND (cp.topic_id = ? OR EXISTS (
    SELECT 1 FROM content_project_sources cps JOIN topic_source_links linked ON linked.source_id = cps.source_id
    WHERE cps.project_id = cp.id AND linked.topic_id = ?))`;

function buildPlan(database: DatabaseSync, ctx: { workspaceId: string; scope: KnowledgeScope; topic: LegacyInitTopicRow }): LegacyInitPlan {
  const { workspaceId, scope, topic } = ctx;
  const asOf = topic.lastSeenAt ?? topic.updatedAt ?? topic.createdAt ?? '1970-01-01T00:00:00.000Z';
  const sources = (database.prepare(
    `SELECT s.id, s.title, s.summary, tsl.relation, s.revision, s.priority,
       s.verification_status AS verificationStatus, s.published_at AS publishedAt, s.collected_at AS collectedAt
     FROM topic_source_links tsl JOIN source_items s ON s.id = tsl.source_id
     WHERE tsl.topic_id = ? AND s.management_status != 'archived'
     ORDER BY s.id`
  ).all(topic.id) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ''),
    summary: row.summary === null ? null : String(row.summary),
    relation: String(row.relation ?? ''),
    revision: Number(row.revision ?? 1),
    priority: Number(row.priority ?? 0),
    verificationStatus: String(row.verificationStatus ?? 'pending'),
    publishedAt: row.publishedAt === null ? null : String(row.publishedAt),
    collectedAt: row.collectedAt === null ? null : String(row.collectedAt)
  }));
  const reviews = (database.prepare(
    `SELECT DISTINCT r.id, r.publication_id AS publicationId, r.summary, r.keep_json AS keepJson,
       r.stop_json AS stopJson, r.change_json AS changeJson, r.finalized_at AS finalizedAt, p.platform
     FROM reviews r
     JOIN publications p ON p.id = r.publication_id
     JOIN platform_versions pv ON pv.id = p.platform_version_id
     JOIN content_versions cv ON cv.id = pv.content_version_id
     JOIN content_projects cp ON cp.id = cv.project_id
     ${REVIEW_LINKAGE_WHERE}
     ORDER BY r.id`
  ).all(topic.id, topic.id) as Array<Record<string, unknown>>).map((row) => {
    const publicationId = String(row.publicationId ?? '');
    const metricSnapshotCount = Number((database.prepare(
      'SELECT count(*) AS count FROM publication_metric_snapshots WHERE publication_id = ?'
    ).get(publicationId) as { count: number }).count);
    return {
      id: String(row.id),
      publicationId,
      summary: row.summary === null ? null : String(row.summary),
      platform: row.platform === null ? null : String(row.platform),
      finalizedAt: row.finalizedAt === null ? null : String(row.finalizedAt),
      keepJson: String(row.keepJson ?? '[]'),
      stopJson: String(row.stopJson ?? '[]'),
      changeJson: String(row.changeJson ?? '[]'),
      metricSnapshotCount
    };
  });
  const findings = (database.prepare(
    `SELECT DISTINCT f.id, f.title, f.body, r.id AS reviewId
     FROM method_findings f
     JOIN reviews r ON r.id = f.review_id
     JOIN publications p ON p.id = r.publication_id
     JOIN platform_versions pv ON pv.id = p.platform_version_id
     JOIN content_versions cv ON cv.id = pv.content_version_id
     JOIN content_projects cp ON cp.id = cv.project_id
     ${REVIEW_LINKAGE_WHERE}
     ORDER BY f.id`
  ).all(topic.id, topic.id) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    reviewId: String(row.reviewId ?? ''),
    title: row.title === null ? null : String(row.title),
    body: row.body === null ? null : String(row.body)
  }));
  const sourceCount = Number((database.prepare(
    `SELECT count(*) AS count FROM topic_source_links tsl JOIN source_items s ON s.id = tsl.source_id
     WHERE tsl.topic_id = ? AND s.management_status != 'archived'`
  ).get(topic.id) as { count: number }).count);
  return Object.freeze({
    workspaceId,
    topicId: topic.id,
    scope,
    topicTitle: topic.title,
    topicSummary: String(topic.summary ?? ''),
    asOf,
    sourceCount,
    sources: Object.freeze(sources),
    reviews: Object.freeze(reviews),
    findings: Object.freeze(findings)
  });
}

// ============================================================
// 候选 → ChangeSet 输入（纯函数 of 计划 + 库内既有 Note 去重）
// ============================================================

function buildTopicChangeSet(database: DatabaseSync, plan: LegacyInitPlan): {
  input: KnowledgeChangeSetInput;
  counts: Readonly<Record<string, number>>;
  keptRaw: readonly string[];
  promoted: readonly PromotedEntry[];
  pageId: string;
  wikiVersionId: string;
} {
  const requestId = legacyInitRequestId(plan.topicId);
  const notes: NoteWrite[] = [];
  const evidenceLinks: EvidenceLinkWrite[] = [];
  const keptRaw: string[] = [];
  const promoted: PromotedEntry[] = [];
  let sourcesPromoted = 0;
  let reviewsPromoted = 0;
  let findingsPromoted = 0;
  let sourcesKeptRaw = 0;
  let reviewsKeptRaw = 0;
  let findingsKeptRaw = 0;

  // ---- 候选 1：verified 高价值 Source（primary/supporting + priority<=2 + 非空 summary） ----
  for (const source of plan.sources) {
    let reason = '';
    if (source.verificationStatus !== 'verified') reason = 'not_verified';
    else if (source.priority > 2) reason = 'low_priority';
    else if (!source.summary?.trim()) reason = 'no_summary';
    else if (source.relation !== 'primary' && source.relation !== 'supporting') reason = 'unlinked_relation';
    if (reason) {
      keptRaw.push(`raw:source:${source.id}:${reason}`);
      sourcesKeptRaw += 1;
      continue;
    }
    const key = `claim:legacy:${source.id}`;
    const canonicalKey = normalizeCanonicalKey(key);
    if (noteExists(database, plan.scope, canonicalKey)) {
      keptRaw.push(`raw:source:${source.id}:already_exists`);
      sourcesKeptRaw += 1;
      continue;
    }
    const statement = String(source.summary).trim();
    const noteId = deterministicId('note', `${plan.scope}|${canonicalKey}`);
    const versionId = deterministicId('ver', `${requestId}|${plan.scope}|${canonicalKey}`);
    notes.push({
      id: noteId,
      scope: plan.scope,
      kind: 'claim',
      canonicalKey: key,
      title: source.title,
      version: {
        versionId,
        statement,
        conclusionStatus: 'unverified',
        evidenceLevel: 'single',
        adoptedTopicIds: [plan.topicId],
        changeType: 'created',
        changeReason: '历史初始化：verified 高价值 Source 迁移为未验证知识候选（未声明 verified）'
      }
    });
    const sourceNature: SourceNature = source.relation === 'primary' ? 'primary_source' : 'secondary_source';
    evidenceLinks.push({
      knowledgeNoteVersionId: versionId,
      evidenceObjectType: 'source',
      evidenceObjectId: source.id,
      relation: 'supports',
      sourceNature,
      locator: `source:${source.id}`,
      observedAt: source.publishedAt ?? source.collectedAt
    });
    promoted.push({ noteId, versionId, canonicalKey: key, kind: 'claim', changeType: 'created', statement, conclusionStatus: 'unverified', evidenceLevel: 'single', appliesTo: '', disputed: false });
    sourcesPromoted += 1;
  }

  // ---- 候选 2：final Review（非空 summary 且尚未有 case:outcome:{reviewId} 观察 Note） ----
  for (const review of plan.reviews) {
    if (!review.summary?.trim()) {
      keptRaw.push(`raw:review:${review.id}:no_summary`);
      reviewsKeptRaw += 1;
      continue;
    }
    const key = `case:outcome:${review.id}`;
    const canonicalKey = normalizeCanonicalKey(key);
    if (noteExists(database, plan.scope, canonicalKey)) {
      keptRaw.push(`raw:review:${review.id}:already_exists`);
      reviewsKeptRaw += 1;
      continue;
    }
    const keep = parseJsonArray(review.keepJson);
    const stop = parseJsonArray(review.stopJson);
    const change = parseJsonArray(review.changeJson);
    const hasMetrics = review.metricSnapshotCount > 0;
    const metricSummary = hasMetrics ? `${review.metricSnapshotCount} 条指标快照` : '指标未知或缺失';
    const statement =
      `案例：${String(review.platform ?? '未知平台')} 发布 ${dateOnly(review.finalizedAt) || '未知日期'}。` +
      `Keep ${keep.length} / Stop ${stop.length} / Change ${change.length}；指标：${metricSummary}。` +
      `历史迁移：final Review 单次样本观察，仅记录相关性，不证明因果。`;
    const noteId = deterministicId('note', `${plan.scope}|${canonicalKey}`);
    const versionId = deterministicId('ver', `${requestId}|${plan.scope}|${canonicalKey}`);
    const evidenceLevel: EvidenceLevel = hasMetrics ? 'outcome_observed' : 'insufficient';
    notes.push({
      id: noteId,
      scope: plan.scope,
      kind: 'case',
      canonicalKey: key,
      title: `结果案例 ${String(review.platform ?? 'unknown')} ${dateOnly(review.finalizedAt) || 'unknown'}`,
      version: {
        versionId,
        statement,
        conclusionStatus: 'unverified',
        evidenceLevel,
        adoptedTopicIds: [plan.topicId],
        changeType: 'created',
        changeReason: '历史初始化：final Review 单次样本观察迁移（不证明因果）'
      }
    });
    evidenceLinks.push({
      knowledgeNoteVersionId: versionId,
      evidenceObjectType: 'review',
      evidenceObjectId: review.id,
      relation: 'supports',
      sourceNature: 'review',
      locator: `review:${review.id}`,
      observedAt: review.finalizedAt
    });
    promoted.push({ noteId, versionId, canonicalKey: key, kind: 'case', changeType: 'created', statement, conclusionStatus: 'unverified', evidenceLevel, appliesTo: '', disputed: false });
    reviewsPromoted += 1;
  }

  // ---- 候选 3：final Review 的 Method Finding（非空 title+body 且尚未有 method:legacy:{id}） ----
  for (const finding of plan.findings) {
    if (!finding.title?.trim() || !finding.body?.trim()) {
      keptRaw.push(`raw:finding:${finding.id}:weak_evidence`);
      findingsKeptRaw += 1;
      continue;
    }
    const key = `method:legacy:${finding.id}`;
    const canonicalKey = normalizeCanonicalKey(key);
    if (noteExists(database, plan.scope, canonicalKey)) {
      keptRaw.push(`raw:finding:${finding.id}:already_exists`);
      findingsKeptRaw += 1;
      continue;
    }
    const review = plan.reviews.find((entry) => entry.id === finding.reviewId);
    const hasMetrics = (review?.metricSnapshotCount ?? 0) > 0;
    const evidenceLevel: EvidenceLevel = hasMetrics ? 'outcome_observed' : 'insufficient';
    const noteId = deterministicId('note', `${plan.scope}|${canonicalKey}`);
    const versionId = deterministicId('ver', `${requestId}|${plan.scope}|${canonicalKey}`);
    notes.push({
      id: noteId,
      scope: plan.scope,
      kind: 'method',
      canonicalKey: key,
      title: String(finding.title),
      version: {
        versionId,
        statement: String(finding.title),
        body: String(finding.body),
        conclusionStatus: 'inference',
        evidenceLevel,
        adoptedTopicIds: [plan.topicId],
        changeType: 'created',
        changeReason: '历史初始化：final Review 的 Method Finding 迁移（单样本推断，未声明验证）'
      }
    });
    evidenceLinks.push({
      knowledgeNoteVersionId: versionId,
      evidenceObjectType: 'review',
      evidenceObjectId: finding.reviewId,
      relation: 'supports',
      sourceNature: 'review',
      locator: `review:${finding.reviewId}`,
      observedAt: review?.finalizedAt ?? null
    });
    promoted.push({ noteId, versionId, canonicalKey: key, kind: 'method', changeType: 'created', statement: String(finding.title), conclusionStatus: 'inference', evidenceLevel, appliesTo: '', disputed: false });
    findingsPromoted += 1;
  }

  // ---- 唯一 Topic Wiki 页（v1 标记 migration + derived-from-legacy） ----
  const adoptedNoteVersionIds = promoted.map((entry) => entry.versionId);
  const keyConclusions = [...promoted]
    .sort((left, right) => String(left.noteId).localeCompare(String(right.noteId)))
    .map((entry) => ({
      noteId: entry.noteId,
      statement: entry.statement,
      conclusionStatus: entry.conclusionStatus,
      evidenceLevel: entry.evidenceLevel,
      appliesTo: entry.appliesTo,
      changeType: entry.changeType,
      kind: entry.kind
    }));
  const body: Readonly<Record<string, unknown>> = {
    kind: 'topic-wiki',
    title: plan.topicTitle,
    summary: plan.topicSummary,
    asOf: plan.asOf,
    scope: plan.scope,
    topicId: plan.topicId,
    migration: true,
    derivedFromLegacy: true,
    compiledSourceIds: [],
    keyConclusions,
    retainedDisputes: [],
    pendingQuestions: [],
    recentChanges: promoted.map((entry) => ({ noteId: entry.noteId, versionId: entry.versionId, canonicalKey: entry.canonicalKey, changeType: entry.changeType })),
    versionCount: adoptedNoteVersionIds.length
  };
  const pageId = deterministicId('page', `wiki-topic|${plan.topicId}`);
  const wikiVersionId = deterministicId('wver', `${requestId}|wiki-topic|${plan.topicId}`);
  const wikiPage: WikiPageWrite = {
    id: pageId,
    scope: plan.scope,
    pageType: 'topic',
    canonicalKey: `wiki-topic:${plan.topicId}`,
    title: plan.topicTitle,
    subjectType: 'topic',
    subjectId: plan.topicId,
    version: {
      versionId: wikiVersionId,
      title: plan.topicTitle,
      body,
      adoptedNoteVersionIds,
      businessObjectRefs: [`topic:${plan.topicId}`],
      flags: ['migration', 'derived-from-legacy'],
      changeSummary: `历史初始化：为 Topic「${plan.topicTitle}」创建 derived-from-legacy 初始 Wiki（来源：topic.summary + 既有 dossier；采纳 ${adoptedNoteVersionIds.length} 个 legacy 知识版本；${promoted.length} 条明确证据晋升，其余保持 Raw/Evidence）。`,
      readableDiff: `legacy → migration v1（flags: migration, derived-from-legacy）。`,
      compileReason: '历史初始化（WMB-5217 legacy init）'
    }
  };

  // ---- 健康问题：无任何来源证据的 Topic Wiki（orphan_knowledge） ----
  const healthIssues: HealthIssueCreateWrite[] = [];
  if (plan.sourceCount === 0 && promoted.length === 0) {
    healthIssues.push({
      op: 'create',
      id: deterministicId('hi', `${requestId}|orphan_knowledge|${plan.topicId}`),
      scope: plan.scope,
      issueType: 'orphan_knowledge',
      affectedObjectType: 'wiki_page',
      affectedObjectId: pageId,
      severity: 'low',
      evidence: {
        topicId: plan.topicId,
        wikiPageId: pageId,
        sourceCount: 0,
        adoptedNoteVersionIds: 0,
        note: '历史初始化：Topic Wiki 无任何来源证据，知识仅来自 topic.summary'
      },
      suggestedAction: '通过后续来源摄取与增量编译接入证据链'
    });
  }

  // ---- 可读初始化回执（triggerType='migration'；保留原对象 ID/数量/贡献发布链） ----
  const affectedMethods = promoted.filter((entry) => entry.kind === 'method').map((entry) => entry.noteId);
  const counts: Readonly<Record<string, number>> = Object.freeze({
    sourcesTotal: plan.sources.length,
    sourcesPromoted,
    sourcesKeptRaw,
    reviewsFinal: plan.reviews.length,
    reviewsPromoted,
    reviewsKeptRaw,
    findingsTotal: plan.findings.length,
    findingsPromoted,
    findingsKeptRaw,
    notesCreated: promoted.length,
    evidenceLinks: evidenceLinks.length,
    wikiPagesCompiled: 1
  });
  const input: KnowledgeChangeSetInput = {
    notes,
    evidenceLinks,
    wikiPages: [wikiPage],
    healthIssues,
    receipts: [{
      triggerType: 'migration' as const,
      requestId,
      summary: `历史初始化 Topic「${plan.topicTitle}」：Wiki v1（migration/derived-from-legacy）；` +
        `Source 候选 ${sourcesPromoted}/${plan.sources.length}、Review 候选 ${reviewsPromoted}/${plan.reviews.length}、` +
        `Method Finding 候选 ${findingsPromoted}/${plan.findings.length}；其余保持 Raw/Evidence 交增量编译。`,
      counts,
      affectedTopics: [plan.topicId],
      affectedMethods,
      affectedSyntheses: [],
      wikiPageVersions: [wikiVersionId],
      impact: {
        topicId: plan.topicId,
        scope: plan.scope,
        migrationVersion: LEGACY_KNOWLEDGE_INIT_MIGRATION_VERSION,
        asOf: plan.asOf,
        initializedFrom: 'legacy',
        sourceCount: plan.sourceCount,
        reviewCount: plan.reviews.length,
        findingCount: plan.findings.length
      },
      autoResolutions: [],
      retainedDisputes: [],
      failures: keptRaw
    }]
  };
  return Object.freeze({ input, counts, keptRaw: Object.freeze(keptRaw), promoted: Object.freeze(promoted), pageId, wikiVersionId });
}

// ============================================================
// 初始化状态 checkpoint（migration 基础设施；与 ChangeSet 同事务原子写）
// ============================================================

type InitStateRow = Readonly<{
  topicId: string;
  status: string;
  wikiPageId: string | null;
  changeSetId: string | null;
  receiptId: string | null;
}>;

function readInitState(database: DatabaseSync, topicId: string, workspaceId: string): InitStateRow | null {
  const row = database.prepare(
    `SELECT topic_id AS topicId, status, wiki_page_id AS wikiPageId, change_set_id AS changeSetId, receipt_id AS receiptId
     FROM knowledge_legacy_init_state WHERE topic_id = ? AND workspace_id = ?`
  ).get(topicId, workspaceId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    topicId: String(row.topicId),
    status: String(row.status),
    wikiPageId: row.wikiPageId === null ? null : String(row.wikiPageId),
    changeSetId: row.changeSetId === null ? null : String(row.changeSetId),
    receiptId: row.receiptId === null ? null : String(row.receiptId)
  };
}

function writeInitState(
  database: DatabaseSync,
  topicId: string,
  workspaceId: string,
  scope: KnowledgeScope,
  status: string,
  wikiPageId: string | null,
  changeSetId: string | null,
  receiptId: string | null,
  lastError: string | null
): void {
  database.prepare(`INSERT INTO knowledge_legacy_init_state
    (topic_id, workspace_id, scope, migration_version, status, wiki_page_id, change_set_id, receipt_id, last_error, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(topic_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      scope = excluded.scope,
      migration_version = excluded.migration_version,
      status = excluded.status,
      wiki_page_id = excluded.wiki_page_id,
      change_set_id = excluded.change_set_id,
      receipt_id = excluded.receipt_id,
      last_error = excluded.last_error,
      completed_at = excluded.completed_at`)
    .run(topicId, workspaceId, scope, LEGACY_KNOWLEDGE_INIT_MIGRATION_VERSION, status,
      wikiPageId, changeSetId, receiptId, lastError, new Date().toISOString());
}

// ============================================================
// 主入口
// ============================================================

function topicResult(
  topicId: string,
  status: LegacyKnowledgeInitTopicStatus,
  wikiPageId: string | null = null,
  changeSetId: string | null = null,
  receiptId: string | null = null,
  counts: Readonly<Record<string, number>> | null = null,
  keptRaw: readonly string[] = [],
  wikiPageVersionId: string | null = null,
  error: string | null = null
): LegacyKnowledgeInitTopicResult {
  return Object.freeze({ topicId, status, wikiPageId, wikiPageVersionId, changeSetId, receiptId, counts, keptRaw: Object.freeze(keptRaw), error });
}

function loadTopics(database: DatabaseSync, topicIds: readonly string[] | undefined): LegacyInitTopicRow[] {
  const rows = topicIds?.length
    ? database.prepare(
        `SELECT id, title, summary, status, last_seen_at AS lastSeenAt, updated_at AS updatedAt, created_at AS createdAt
         FROM topics WHERE id IN (${topicIds.map(() => '?').join(',')}) ORDER BY last_seen_at DESC, id DESC`
      ).all(...topicIds)
    : database.prepare(
        `SELECT id, title, summary, status, last_seen_at AS lastSeenAt, updated_at AS updatedAt, created_at AS createdAt
         FROM topics WHERE status IN ('active','watching') ORDER BY last_seen_at DESC, id DESC`
      ).all();
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ''),
    summary: row.summary === null ? null : String(row.summary),
    status: String(row.status ?? 'active'),
    lastSeenAt: row.lastSeenAt === null ? null : String(row.lastSeenAt),
    updatedAt: row.updatedAt === null ? null : String(row.updatedAt),
    createdAt: row.createdAt === null ? null : String(row.createdAt)
  }));
}

function initTopic(database: DatabaseSync, ctx: { workspaceId: string | null; scope: KnowledgeScope; topic: LegacyInitTopicRow; transaction: boolean }): LegacyKnowledgeInitTopicResult {
  const { workspaceId, scope, topic, transaction } = ctx;
  if (workspaceId === null) {
    return topicResult(topic.id, 'skipped_no_workspace');
  }
  if (topic.status !== 'active' && topic.status !== 'watching') {
    writeInitState(database, topic.id, workspaceId, scope, 'skipped_inactive', null, null, null, null);
    return topicResult(topic.id, 'skipped_inactive');
  }
  // 状态表快路径：本初始化已完成 → 幂等跳过（零写，可中断恢复的关键）。
  // 必须先于 existing-page 检查：已初始化 Topic 的 Wiki 正是本初始化创建的。
  const state = readInitState(database, topic.id, workspaceId);
  if (state?.status === 'initialized') {
    return topicResult(topic.id, 'already_initialized', state.wikiPageId, state.changeSetId, state.receiptId);
  }
  // 冻结计划（纯函数 of DB state）→ 计划哈希（幂等关键；派生段含观察态，不做哈希输入）
  const plan = buildPlan(database, { workspaceId, scope, topic });
  const requestId = legacyInitRequestId(topic.id);
  const planHash = createKnowledgeChangeSetInputHash(requestId, plan);
  // 已有本初始化 ChangeSet（曾运行但状态行缺失/被删）：同输入 → 经 store 重放补齐状态行（零写）；
  // 异输入 → 跳过不覆盖（迁移不重写已发布初始 Wiki，后续变化走编译器流程）
  const prior = database.prepare(
    'SELECT id, input_hash AS inputHash FROM knowledge_change_sets WHERE workspace_id = ? AND request_id = ?'
  ).get(workspaceId, requestId) as { id: string; inputHash: string } | undefined;
  if (prior && prior.inputHash !== planHash) {
    writeInitState(database, topic.id, workspaceId, scope, 'skipped_state_changed', null, prior.id, null,
      'legacy data changed after init；后续变化应走编译器流程，迁移不覆盖已发布初始 Wiki');
    return topicResult(topic.id, 'skipped_state_changed', null, prior.id);
  }
  if (!prior) {
    // 一 Topic 一 Wiki：已有 active Topic Wiki（编译器/既有知识，无本初始化 ChangeSet）→ 跳过
    const existingPage = database.prepare(
      `SELECT id FROM knowledge_wiki_pages WHERE scope = ? AND subject_type = 'topic' AND subject_id = ? AND lifecycle = 'active' LIMIT 1`
    ).get(scope, topic.id) as { id: string } | undefined;
    if (existingPage) {
      writeInitState(database, topic.id, workspaceId, scope, 'skipped_already_has_wiki', existingPage.id, null, null, null);
      return topicResult(topic.id, 'skipped_already_has_wiki', existingPage.id);
    }
  }
  try {
    const built = buildTopicChangeSet(database, plan);
    const meta: KnowledgeChangeSetMeta = {
      workspaceId,
      requestId,
      reason: `历史初始化：为 Topic「${topic.title}」创建 derived-from-legacy 初始 Wiki。`,
      triggerSource: 'migration',
      resolutionMode: 'none',
      createdBy: 'migration',
      inputHash: planHash
    };
    if (transaction) database.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = applyKnowledgeChangeSet(database, meta, built.input, false);
      writeInitState(database, topic.id, workspaceId, scope, 'initialized', built.pageId, result.changeSetId, result.receipt?.id ?? null, null);
      if (transaction) database.exec('COMMIT');
    } catch (error) {
      if (transaction) database.exec('ROLLBACK');
      throw error;
    }
    if (result.replay) {
      // 重放：以持久化回执为准（首次运行产物已在库中；本轮仅补齐状态行）
      const receiptCounts = result.receipt?.counts ?? null;
      return topicResult(topic.id, 'replayed', built.pageId, result.changeSetId, result.receipt?.id ?? null,
        receiptCounts ? Object.freeze({ ...receiptCounts }) : built.counts, built.keptRaw, built.wikiVersionId);
    }
    return topicResult(topic.id, 'initialized', built.pageId, result.changeSetId, result.receipt?.id ?? null,
      built.counts, built.keptRaw, built.wikiVersionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      writeInitState(database, topic.id, workspaceId, scope, 'failed', null, null, null, message);
    } catch {
      // 状态行写入失败不掩盖主错误
    }
    return topicResult(topic.id, 'failed', null, null, null, null, [], null, message);
  }
}

/**
 * 历史初始化主入口（幂等、可重跑、可中断恢复）：
 * - 无 workspace 身份 → 全量 skipped_no_workspace（零知识写入，不视为失败）；
 * - 每个 active Topic 一个原子 ChangeSet（唯一 Topic Wiki + 明确证据 Note + 回执 + 按需 HealthIssue）；
 * - 同 topic 同输入重放零写；异输入/已有 Wiki 跳过；单 Topic 失败不阻断其余。
 */
export function runLegacyKnowledgeInit(database: DatabaseSync, rawInput: LegacyKnowledgeInitInput = {}): LegacyKnowledgeInitResult {
  const workspaceId = rawInput.workspaceId ?? readBoundWorkspaceId(database);
  const scope = rawInput.scope ?? 'global';
  if (scope !== 'global' && !scope.startsWith('lane:')) {
    throw new Error('LEGACY_INIT_INVALID_SCOPE');
  }
  const topics = loadTopics(database, rawInput.topicIds);
  const transaction = rawInput.transaction !== false;
  const topicResults: LegacyKnowledgeInitTopicResult[] = [];
  let initialized = 0;
  let replayed = 0;
  let alreadyInitialized = 0;
  let skipped = 0;
  let failed = 0;
  let notesCreated = 0;
  let evidenceLinks = 0;
  let wikiPagesCreated = 0;
  for (const topic of topics) {
    const result = initTopic(database, { workspaceId, scope, topic, transaction });
    topicResults.push(result);
    switch (result.status) {
      case 'initialized':
        initialized += 1;
        notesCreated += Number(result.counts?.notesCreated ?? 0);
        evidenceLinks += Number(result.counts?.evidenceLinks ?? 0);
        wikiPagesCreated += 1;
        break;
      case 'replayed':
        replayed += 1;
        break;
      case 'already_initialized':
        alreadyInitialized += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      default:
        skipped += 1;
    }
  }
  const totals = Object.freeze({
    topics: topics.length,
    initialized,
    replayed,
    alreadyInitialized,
    skipped,
    failed,
    notesCreated,
    evidenceLinks,
    wikiPagesCreated
  });
  return Object.freeze({
    ok: workspaceId === null || failed === 0,
    workspaceId,
    scope,
    migrationVersion: LEGACY_KNOWLEDGE_INIT_MIGRATION_VERSION,
    topics: Object.freeze(topicResults),
    totals
  });
}

// ============================================================
// 生产启动钩子（经 CommandDispatcher 授权写；不直接绕 write-guard）
// ============================================================

export type LegacyKnowledgeInitStartupResult = Readonly<{
  command: typeof KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND;
  workspaceId: string;
  runtimeEpoch: string;
  topicResults: readonly LegacyKnowledgeInitTopicResult[];
  totals: LegacyKnowledgeInitResult['totals'];
}>;

/**
 * 工作空间激活后的历史初始化（有界、幂等、不阻断启动）：
 * - 只读枚举未初始化（无 'initialized' 状态行）的 active Topic，逐个经
 *   `knowledge_flywheel.legacy_init` dispatcher 命令执行 —— 事务粒度 = 单 Topic，
 *   写经 write-guard 授权（scheduler actor，复用既有能力域，不新增能力）；
 * - 命令 requestId 带 runtimeEpoch（`legacy-init:run:{epoch}:{topicId}`）：同 boot 内幂等、
 *   跨 boot 失败可重试（不 pin 错误收据）；知识层幂等键保持稳定
 *   `legacy-init:{topicId}`（同输入重放零写）；
 * - 单 Topic 失败被捕获并以 status='failed' 汇总（状态行落库，下次启动按 Topic 续跑），
 *   绝不抛出 → 启动不阻断；有初始化时广播 dataChanged（receipt/Wiki/健康可见）。
 */
export async function runLegacyKnowledgeInitAtStartup(runtime: ActiveWorkspaceRuntime): Promise<LegacyKnowledgeInitStartupResult> {
  let pending: Array<{ id: string }> = [];
  try {
    pending = runtime.database.prepare(
      `SELECT t.id FROM topics t
       WHERE t.status IN ('active','watching')
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_legacy_init_state s
           WHERE s.topic_id = t.id AND s.status = 'initialized'
         )
       ORDER BY t.last_seen_at DESC, t.id`
    ).all() as Array<{ id: string }>;
  } catch {
    // 运行时不可读（正在切换/已停止）→ 零进度返回，调用方无需特殊处理（启动不阻断）。
    return Object.freeze({
      command: KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND,
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      topicResults: Object.freeze([]),
      totals: Object.freeze({
        topics: 0, initialized: 0, replayed: 0, alreadyInitialized: 0, skipped: 0, failed: 0,
        notesCreated: 0, evidenceLinks: 0, wikiPagesCreated: 0
      })
    });
  }
  const topicResults: LegacyKnowledgeInitTopicResult[] = [];
  for (const { id } of pending) {
    let result: LegacyKnowledgeInitTopicResult;
    try {
      const receipt = await dispatchBusinessCommand(runtime, {
        command: KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND,
        requestId: `legacy-init:run:${runtime.identity.runtimeEpoch}:${id}`,
        actor: legacyInitSchedulerActor,
        input: { topicId: id },
        boundIdentity: { entityType: 'knowledge_legacy_init_state', topicId: id },
        entityType: 'knowledge_legacy_init_state',
        execute: (database, value) => {
          const outcome = runLegacyKnowledgeInit(database, { transaction: false, topicIds: [String(value.topicId)] });
          return { data: outcome, entityId: String(value.topicId), readback: outcome };
        }
      });
      const topicOutcome = receipt.data?.topics?.[0];
      result = topicOutcome
        ? Object.freeze({ ...topicOutcome })
        : Object.freeze({
            topicId: id, status: 'failed', wikiPageId: null, wikiPageVersionId: null,
            changeSetId: null, receiptId: null, counts: null, keptRaw: [],
            error: receipt.error?.message ?? 'knowledge_flywheel.legacy_init 命令失败'
          });
    } catch (error) {
      result = Object.freeze({
        topicId: id, status: 'failed', wikiPageId: null, wikiPageVersionId: null,
        changeSetId: null, receiptId: null, counts: null, keptRaw: [],
        error: error instanceof Error ? error.message : String(error)
      });
    }
    topicResults.push(result);
  }
  let initialized = 0;
  let replayed = 0;
  let alreadyInitialized = 0;
  let skipped = 0;
  let failed = 0;
  let notesCreated = 0;
  let evidenceLinks = 0;
  let wikiPagesCreated = 0;
  for (const result of topicResults) {
    switch (result.status) {
      case 'initialized':
        initialized += 1;
        notesCreated += Number(result.counts?.notesCreated ?? 0);
        evidenceLinks += Number(result.counts?.evidenceLinks ?? 0);
        wikiPagesCreated += 1;
        break;
      case 'replayed':
        replayed += 1;
        break;
      case 'already_initialized':
        alreadyInitialized += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      default:
        skipped += 1;
    }
  }
  const totals: LegacyKnowledgeInitResult['totals'] = Object.freeze({
    topics: topicResults.length,
    initialized, replayed, alreadyInitialized, skipped, failed,
    notesCreated, evidenceLinks, wikiPagesCreated
  });
  if (initialized > 0) {
    broadcastDataChanged({
      scopes: ['knowledge', 'topics', 'canvas', 'health', 'receipt', 'library', 'today'],
      reason: KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND
    });
  }
  return Object.freeze({
    command: KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND,
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    topicResults: Object.freeze(topicResults),
    totals
  });
}
