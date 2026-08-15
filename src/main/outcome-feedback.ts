/**
 * WMB-5216 M7：结果回流（Outcome Feedback）——Publication / Metric / final Review → 知识。
 * Design: docs/spark/2026-08-12-wmb-outcome-feedback-knowledge-health-design.md §2–§5/§12
 *
 * 职责（保守因果 + 幂等 + 原子）：
 * - 以发布时固定 Knowledge Usage Package/Record 为唯一知识血缘：结果知识版本
 *   （KnowledgeNoteVersion.adoptedKnowledgeVersionIds）只引用发布时冻结的
 *   wiki/note 版本，绝不回读当前知识（协议 §2/§4.6；不重写历史）。
 * - 单次 final Review 结果只形成：
 *     1) 一个 `case` 观察 Note（evidence = review + publication + metric snapshots，
 *        sourceNature=review/performance_observation，evidenceLevel=outcome_observed
 *        或 insufficient —— 零/未知指标严格区分，不当 0）；
 *     2) 限域表述：keep 项与既有 active creative_pattern/method/claim Note 的
 *        canonicalKey 精确匹配时，追加 `qualified` 版本并限定平台/受众/时间窗；
 *   —— 绝不自动生成因果 Method（kind='method' 永不出现于本模块计划）。
 * - 重复、跨结果证据达到门槛（同一 topic + 同一 platform/audience + 同一规范化
 *   keep 项 ≥ 2 次 final Review）时，才创建/强化 `creative_pattern` Note，且
 *   结论固定为 inference + corroborated，appliesTo 按平台/受众/时间窗限定，
 *   语句不宣称因果（§3/§5）。
 * - 全部正式 Note/Wiki/Evidence/Receipt 经 applyKnowledgeChangeSet 原子提交；
 *   final Review 同一事务内原子重编译受影响 Topic Wiki（合并既有 body、追加
 *   recentOutcomes/recentChanges、采纳新结果版本），Review 后 Topic Wiki 新版本
 *   立即可见；失败零部分写（调用方事务整体回滚）；稳定 requestId `outcome:review:{reviewId}`
 *   同输入重放零写、异输入 REQUEST_REPLAY_CONFLICT。
 * - 保持 workspace/lane/data-root 隔离（store 强制）与人工发布边界：本模块只读
 *   reviews/publications/metrics 的已冻结终态，不触碰发布流程。
 *
 * 触发接点：reviews.saveReview(status='final') 在同一事务内调用本模块（transaction=false）；
 * 测试可独立调用 flowBackOutcome 验证重放/幂等。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  applyKnowledgeChangeSet,
  createKnowledgeChangeSetInputHash,
  getUpdateReceiptByRequest,
  getWikiPageVersion,
  type ConclusionStatus,
  type CreatorNature,
  type EvidenceLevel,
  type EvidenceLinkWrite,
  type KnowledgeChangeSetInput,
  type KnowledgeChangeSetMeta,
  type KnowledgeScope,
  type KnowledgeUpdateReceiptRecord,
  type NoteKind,
  type NoteVersionChangeType,
  type NoteWrite,
  type ReceiptWrite,
  type TriggerSource,
  type WikiPageWrite
} from './knowledge-flywheel.ts';
import { readPublicationTimeUsage } from './knowledge-usage-integration.ts';
import { getPublication } from './publishing.ts';

// ============================================================
// 错误与固定矩阵
// ============================================================

export class OutcomeFeedbackError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'OutcomeFeedbackError';
    this.code = code;
    this.details = details;
  }
}

export const OUTCOME_FEEDBACK_ERROR_CODES = Object.freeze([
  'OUTCOME_REVIEW_NOT_FOUND',
  'OUTCOME_REVIEW_NOT_FINAL',
  'OUTCOME_PUBLICATION_NOT_FOUND',
  'OUTCOME_SNAPSHOT_CORRUPT',
  'OUTCOME_PLAN_INVALID'
] as const);

/** 单次结果绝不生成的 Note kind：因果 Method 永不自动产生（§5 防伪因果规则）。 */
const FORBIDDEN_NOTE_KINDS: Readonly<Record<string, true>> = Object.freeze({ method: true });

/** 限域表述（qualify）允许触碰的既有 Note kind（question 不可承载结果证据语义）。 */
const QUALIFY_TARGET_KINDS: Readonly<Record<string, true>> = Object.freeze({ creative_pattern: true, method: true, claim: true });

/** 指标摘要只读取这些平台常见数值字段（与 x-metrics 的 normalized 形状兼容）。 */
const METRIC_VALUE_KEYS: readonly string[] = Object.freeze([
  'views', 'likes', 'reposts', 'replies', 'bookmarks', 'impressions', 'reach', 'engagements',
  'followers', 'comments', 'shares', 'saves', 'plays', 'reads', 'favorites'
]);

/** 正式知识触发源（ChangeSet meta + Receipt triggerType）。 */
const TRIGGER_SOURCE: TriggerSource = 'review';
const CREATED_BY: CreatorNature = 'system';

// ============================================================
// 工具
// ============================================================

/** 稳定 requestId 约定：`outcome:review:{reviewId}`（健康侧 unreturned_review 检测据此只读判读）。 */
export function outcomeFeedbackRequestId(reviewId: string): string {
  return `outcome:review:${reviewId}`;
}

/** 与 store/compiler 对齐的 canonicalKey 规范化（同 key 才能命中既有 Note）。 */
function normalizeCanonicalKey(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 稳定对象 id：ChangeSet 输入必须是计划的纯函数（幂等关键）。 */
function deterministicId(prefix: string, seed: string): string {
  return `${prefix}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function fail(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new OutcomeFeedbackError(code, message, details);
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

/** 工作空间身份（app_meta）；无绑定（精简 fixture）→ null，调用方跳过知识写入。 */
function readBoundWorkspaceId(database: DatabaseSync): string | null {
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** 读取 review 引用快照的 normalized 值；corrupt JSON 抛 OUTCOME_SNAPSHOT_CORRUPT（失败即回滚）。 */
function readSnapshotNormalized(database: DatabaseSync, snapshotId: string): Readonly<Record<string, unknown>> {
  const row = database.prepare('SELECT normalized_json AS normalized FROM publication_metric_snapshots WHERE id = ?')
    .get(snapshotId) as { normalized?: string } | undefined;
  if (!row || row.normalized === undefined || row.normalized === null) {
    fail('OUTCOME_SNAPSHOT_CORRUPT', `指标快照 ${snapshotId} 缺失 normalized 数据（保留未知，不当作 0）。`, { snapshotId });
  }
  try {
    const parsed = JSON.parse(row.normalized) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail('OUTCOME_SNAPSHOT_CORRUPT', `指标快照 ${snapshotId} normalized 形状非法。`, { snapshotId });
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    fail('OUTCOME_SNAPSHOT_CORRUPT', `指标快照 ${snapshotId} normalized 无法解析（零写回滚）。`, { snapshotId });
  }
}

/** 从 normalized 提取可量化信号：零/未知严格区分；只取有限数值 ≥ 0。 */
function extractMetricSignal(normalized: Readonly<Record<string, unknown>>): {
  hasKnown: boolean;
  hasPositive: boolean;
  summary: string;
} {
  const values: Array<[string, number]> = [];
  for (const key of METRIC_VALUE_KEYS) {
    if (!(key in normalized)) continue;
    const raw = normalized[key];
    let value: number | null = null;
    if (typeof raw === 'number') value = raw;
    else if (raw && typeof raw === 'object') {
      const candidate = (raw as Record<string, unknown>).value;
      if (typeof candidate === 'number') value = candidate;
    }
    if (value !== null && Number.isFinite(value) && value >= 0) values.push([key, value]);
  }
  values.sort(([a], [b]) => a.localeCompare(b));
  const hasKnown = values.length > 0;
  const hasPositive = values.some(([, value]) => value > 0);
  const summary = hasKnown
    ? values.map(([key, value]) => `${key}=${value}`).join(', ')
    : '指标未知或缺失';
  return { hasKnown, hasPositive, summary };
}

function scopeKeyOf(platform: string | null | undefined, audience: string | null | undefined): string {
  return `${String(platform ?? 'any')}\u0000${String(audience ?? 'any')}`;
}

/** 限域字符串：平台/受众/时间窗（重复结果强化必须按平台/受众/时间限定）。 */
function scopedAppliesTo(platform: string | null, audience: string | null, windowFrom: string | null, windowTo: string | null): string {
  const parts = [`platform:${String(platform ?? 'any')}`];
  parts.push(`audience:${String(audience ?? 'any')}`);
  const from = dateOnly(windowFrom);
  const to = dateOnly(windowTo);
  if (from && to) parts.push(`window:${from}..${to}`);
  else if (from) parts.push(`window:${from}..`);
  else if (to) parts.push(`window:..${to}`);
  return parts.join('|');
}

// ============================================================
// 冻结输入（全部来自不可变业务终态：final review + 发布 + 快照 + 固定 Usage 血缘）
// ============================================================

type FrozenReviewRow = {
  id: string;
  publicationId: string;
  contentVersionId: string;
  metricSnapshotIds: string[];
  keep: string[];
  stop: string[];
  change: string[];
  summary: string | null;
  finalizedAt: string | null;
  revision: number;
};

type FrozenMetricSnapshot = Readonly<{
  id: string;
  scheduledFor: string;
  capturedAt: string;
  normalized: Readonly<Record<string, unknown>>;
}>;

type FrozenLineage = Readonly<{
  wikiPageVersionIds: readonly string[];
  noteVersionIds: readonly string[];
}>;

type PriorMatch = Readonly<{
  reviewId: string;
  publicationId: string;
  finalizedAt: string;
  metricSnapshotIds: readonly string[];
}>;

function readFrozenReview(database: DatabaseSync, reviewId: string): FrozenReviewRow {
  const row = database.prepare(
    `SELECT id, publication_id AS publicationId, content_version_id AS contentVersionId, status,
       metric_snapshot_ids_json AS snapshotIdsJson, keep_json AS keepJson, stop_json AS stopJson,
       change_json AS changeJson, summary, finalized_at AS finalizedAt, revision
     FROM reviews WHERE id = ?`
  ).get(reviewId) as Record<string, unknown> | undefined;
  if (!row) fail('OUTCOME_REVIEW_NOT_FOUND', `复盘 ${reviewId} 不存在。`, { reviewId });
  if (row.status !== 'final') fail('OUTCOME_REVIEW_NOT_FINAL', `只有 final Review 可以回流结果（${reviewId} 当前 ${String(row.status)}）。`, { reviewId });
  return {
    id: String(row.id),
    publicationId: String(row.publicationId),
    contentVersionId: String(row.contentVersionId),
    metricSnapshotIds: parseJsonArray(String(row.snapshotIdsJson)),
    keep: parseJsonArray(String(row.keepJson)),
    stop: parseJsonArray(String(row.stopJson)),
    change: parseJsonArray(String(row.changeJson)),
    summary: row.summary ? String(row.summary) : null,
    finalizedAt: row.finalizedAt ? String(row.finalizedAt) : null,
    revision: Number(row.revision)
  };
}

function readFindings(database: DatabaseSync, reviewId: string): Array<{ title: string; body: string }> {
  try {
    return (database.prepare('SELECT title, body FROM method_findings WHERE review_id = ? ORDER BY created_at, id').all(reviewId) as Array<{ title: string; body: string }>)
      .map((finding) => ({ title: String(finding.title), body: String(finding.body) }));
  } catch {
    return [];
  }
}

/** 同 topic 的其他 final Review（不可变；结果聚合只读终态，绝不回读未来知识）。 */
function readPriorFinalReviews(database: DatabaseSync, topicId: string | null, reviewId: string): Array<{
  reviewId: string;
  publicationId: string;
  finalizedAt: string;
  platform: string;
  audience: string;
  keep: string[];
  metricSnapshotIds: string[];
}> {
  if (!topicId) return [];
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = database.prepare(
      `SELECT r.id AS reviewId, r.publication_id AS publicationId, r.finalized_at AS finalizedAt,
              r.keep_json AS keepJson, r.metric_snapshot_ids_json AS snapshotIdsJson, p.platform AS platform
       FROM reviews r
       JOIN publications p ON p.id = r.publication_id
       JOIN platform_versions pv ON pv.id = p.platform_version_id
       JOIN content_versions cv ON cv.id = pv.content_version_id
       JOIN content_projects cp ON cp.id = cv.project_id
       WHERE cp.topic_id = ? AND r.status = 'final' AND r.id != ?
       ORDER BY r.finalized_at, r.id`
    ).all(topicId, reviewId) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
  const prior: Array<{
    reviewId: string;
    publicationId: string;
    finalizedAt: string;
    platform: string;
    audience: string;
    keep: string[];
    metricSnapshotIds: string[];
  }> = [];
  for (const row of rows) {
    const publicationId = String(row.publicationId);
    const usage = readPublicationTimeUsage(database, { publicationId });
    const audience = usage?.platformPackage?.audience ?? '';
    prior.push({
      reviewId: String(row.reviewId),
      publicationId,
      finalizedAt: row.finalizedAt ? String(row.finalizedAt) : '',
      platform: String(row.platform ?? ''),
      audience,
      keep: parseJsonArray(String(row.keepJson)),
      metricSnapshotIds: parseJsonArray(String(row.snapshotIdsJson))
    });
  }
  return prior;
}

// ============================================================
// 回流主流程
// ============================================================

export type OutcomeFeedbackCounts = Readonly<{
  caseNotesCreated: number;
  notesQualified: number;
  patternsCreated: number;
  patternsStrengthened: number;
  evidenceLinks: number;
  wikiPagesCompiled: number;
  lineageVersions: number;
}>;

export type OutcomeFeedbackResult = Readonly<{
  ok: boolean;
  /** true = 无 workspace 身份（精简 fixture/历史库）时跳过知识写入，不视为失败。 */
  skipped: boolean;
  /** true = 同 (workspaceId, requestId, inputHash) 幂等重放，零新增行。 */
  replay: boolean;
  changeSetId: string;
  requestId: string;
  reviewId: string;
  counts: OutcomeFeedbackCounts;
  /** canonicalKey → 新 Note 版本 id（case/pattern；重放时为库中当前版本）。 */
  noteVersionIds: Readonly<Record<string, string>>;
  wikiPageId: string | null;
  wikiPageVersionId: string | null;
  receipt: KnowledgeUpdateReceiptRecord | null;
}>;

const ZERO_COUNTS: OutcomeFeedbackCounts = Object.freeze({
  caseNotesCreated: 0,
  notesQualified: 0,
  patternsCreated: 0,
  patternsStrengthened: 0,
  evidenceLinks: 0,
  wikiPagesCompiled: 0,
  lineageVersions: 0
});

export function flowBackOutcome(
  database: DatabaseSync,
  input: { reviewId: string },
  transaction = true
): OutcomeFeedbackResult {
  if (!input.reviewId?.trim()) fail('OUTCOME_PLAN_INVALID', '回流必须携带 reviewId。', { reviewId: input.reviewId });
  const workspaceId = readBoundWorkspaceId(database);
  if (!workspaceId) {
    // 无工作空间身份：与 WMB-5215 usage 一致，不造无归属血缘（历史库/精简 fixture 兼容）。
    return Object.freeze({
      ok: true,
      skipped: true,
      replay: false,
      changeSetId: '',
      requestId: outcomeFeedbackRequestId(input.reviewId),
      reviewId: input.reviewId,
      counts: ZERO_COUNTS,
      noteVersionIds: Object.freeze({}),
      wikiPageId: null,
      wikiPageVersionId: null,
      receipt: null
    });
  }
  const requestId = outcomeFeedbackRequestId(input.reviewId);
  const priorReceipt = getUpdateReceiptByRequest(database, workspaceId, requestId);
  if (priorReceipt) {
    // 已回流：以持久化回执为准（幂等重放，零新增行；异输入冲突由 store 拒绝）。
    const prior = database.prepare('SELECT id FROM knowledge_change_sets WHERE workspace_id = ? AND request_id = ?')
      .get(workspaceId, requestId) as { id: string } | undefined;
    const caseRow = database.prepare(
      `SELECT current_version_id AS c FROM knowledge_notes WHERE canonical_key = ? LIMIT 1`
    ).get(`case:outcome:${input.reviewId}`) as { c?: string } | undefined;
    const replayNoteVersionIds: Record<string, string> = {};
    if (caseRow?.c) replayNoteVersionIds[`case:outcome:${input.reviewId}`] = caseRow.c;
    let replayWikiPageVersionId: string | null = null;
    let replayWikiPageId: string | null = null;
    const persistedWikiVersions = (priorReceipt.wikiPageVersions ?? []) as readonly string[];
    if (persistedWikiVersions.length > 0) {
      replayWikiPageVersionId = persistedWikiVersions[0];
      const pageRow = database.prepare('SELECT page_id AS pageId FROM knowledge_wiki_page_versions WHERE id = ?')
        .get(persistedWikiVersions[0]) as { pageId?: string } | undefined;
      replayWikiPageId = pageRow?.pageId ?? null;
    }
    return Object.freeze({
      ok: true,
      skipped: false,
      replay: true,
      changeSetId: prior?.id ?? '',
      requestId,
      reviewId: input.reviewId,
      counts: countsFromReceipt(priorReceipt),
      noteVersionIds: Object.freeze(replayNoteVersionIds),
      wikiPageId: replayWikiPageId,
      wikiPageVersionId: replayWikiPageVersionId,
      receipt: priorReceipt
    });
  }

  const review = readFrozenReview(database, input.reviewId);
  const publication = getPublication(database, review.publicationId);
  if (!publication) fail('OUTCOME_PUBLICATION_NOT_FOUND', `发布记录 ${review.publicationId} 不存在。`, { publicationId: review.publicationId });
  const publishedAt = publication.publishedAt ?? review.finalizedAt;

  // ---- 发布时固定血缘（唯一知识血缘；绝不回读当前 Wiki） ----
  const usage = readPublicationTimeUsage(database, { publicationId: review.publicationId });
  const lineage: FrozenLineage = {
    wikiPageVersionIds: [...new Set([
      ...(usage?.platformPackage?.wikiPageVersionIds ?? []),
      ...(usage?.corePackage?.wikiPageVersionIds ?? []),
      ...(usage?.reviewPackages.flatMap((entry) => entry.package.wikiPageVersionIds) ?? [])
    ])],
    noteVersionIds: [...new Set([
      ...(usage?.platformPackage?.noteVersionIds ?? []),
      ...(usage?.corePackage?.noteVersionIds ?? []),
      ...(usage?.reviewPackages.flatMap((entry) => entry.package.noteVersionIds) ?? [])
    ])]
  };
  const lineageVersionIds = [...lineage.wikiPageVersionIds, ...lineage.noteVersionIds];
  // adoptedKnowledgeVersionIds 只接受 Note 版本（store 校验 knowledge_note_versions 存在性；
  // Wiki 版本血缘保留在回执 impact + 不可变 Usage Package）。
  const adoptedNoteLineage = [...new Set(lineage.noteVersionIds)];
  const platform = usage?.platformPackage?.platform ?? publication.platform;
  const audience = usage?.platformPackage?.audience ?? '';

  // ---- topic / scope（结果知识归属） ----
  let topicId: string | null = null;
  try {
    const row = database.prepare(
      `SELECT cp.topic_id AS topicId FROM publications p
       JOIN platform_versions pv ON pv.id = p.platform_version_id
       JOIN content_versions cv ON cv.id = pv.content_version_id
       JOIN content_projects cp ON cp.id = cv.project_id WHERE p.id = ?`
    ).get(review.publicationId) as { topicId: string | null } | undefined;
    topicId = row?.topicId ?? null;
  } catch {
    topicId = null;
  }
  let scope: KnowledgeScope = 'global';
  if (topicId) {
    try {
      const row = database.prepare(
        `SELECT scope FROM knowledge_wiki_pages WHERE subject_type='topic' AND subject_id=? AND lifecycle='active' LIMIT 1`
      ).get(topicId) as { scope?: string } | undefined;
      if (row?.scope === 'global' || (typeof row?.scope === 'string' && row.scope.startsWith('lane:'))) scope = row.scope as KnowledgeScope;
    } catch { /* 缺表 → global */ }
  }

  // ---- 冻结指标快照（final Review 引用；零/未知严格区分） ----
  const snapshots: FrozenMetricSnapshot[] = [];
  for (const snapshotId of review.metricSnapshotIds) {
    const row = database.prepare(
      `SELECT scheduled_for AS scheduledFor, captured_at AS capturedAt FROM publication_metric_snapshots WHERE id = ? AND publication_id = ?`
    ).get(snapshotId, review.publicationId) as { scheduledFor?: string; capturedAt?: string } | undefined;
    if (!row) fail('OUTCOME_SNAPSHOT_CORRUPT', `指标快照 ${snapshotId} 不属于该发布，结果证据缺失。`, { snapshotId, publicationId: review.publicationId });
    snapshots.push({
      id: snapshotId,
      scheduledFor: String(row.scheduledFor ?? ''),
      capturedAt: String(row.capturedAt ?? ''),
      normalized: readSnapshotNormalized(database, snapshotId)
    });
  }

  const signal = extractMetricSignal(snapshots[0]?.normalized ?? {});
  const metricSummary = snapshots.length ? signal.summary : '指标未知或缺失';
  const caseEvidenceLevel: EvidenceLevel = signal.hasKnown && signal.hasPositive ? 'outcome_observed' : 'insufficient';

  // ---- 计划：单次结果只形成 case/限域表述；重复同向结果才限域强化 pattern ----
  const keepItems = [...new Set(review.keep.map((item) => normalizeCanonicalKey(item)).filter(Boolean))];
  const priorReviews = readPriorFinalReviews(database, topicId, review.id);
  const currentScopeKey = scopeKeyOf(platform, audience);

  const notes: NoteWrite[] = [];
  const evidenceLinks: EvidenceLinkWrite[] = [];
  const noteVersionIds: Record<string, string> = {};
  const promoted: Array<{ noteId: string; versionId: string; canonicalKey: string; kind: NoteKind; changeType: NoteVersionChangeType }> = [];
  const patternUpdates: Array<{ canonicalKey: string; changeType: NoteVersionChangeType; versionId: string }> = [];
  const qualifiedNoteKeys: string[] = [];

  // 1) case 观察 Note（每个 final Review 恰好一条；幂等由 requestId 保证）
  const caseCanonicalKey = `case:outcome:${review.id}`;
  const caseNoteId = deterministicId('of-case', `${requestId}|${scope}|${review.id}`);
  const caseVersionId = deterministicId('of-case-ver', `${requestId}|${scope}|${review.id}`);
  const finalizedDate = dateOnly(review.finalizedAt) || '未知日期';
  const findings = readFindings(database, review.id);
  const caseStatement =
    `案例：${String(platform ?? '未知平台')} 发布 ${finalizedDate}。` +
    `本次使用发布时固定知识 ${lineageVersionIds.length} 条（版本见血缘）。` +
    `Keep ${review.keep.length} / Stop ${review.stop.length} / Change ${review.change.length}；指标：${metricSummary}。` +
    `单次样本观察，仅记录相关性，不证明因果；${findings.length} 条方法发现作为解释性证据保留于复盘，未自动晋升为知识。`;
  notes.push({
    id: caseNoteId,
    scope,
    kind: 'case',
    canonicalKey: caseCanonicalKey,
    title: `结果案例 ${String(platform ?? 'unknown')} ${finalizedDate}`,
    version: {
      versionId: caseVersionId,
      statement: caseStatement,
      body: JSON.stringify({
        reviewId: review.id,
        publicationId: review.publicationId,
        metricSnapshotIds: review.metricSnapshotIds,
        keep: review.keep,
        stop: review.stop,
        change: review.change,
        findings: findings.map((finding) => finding.title)
      }, null, 0),
      conclusionStatus: 'unverified' as ConclusionStatus,
      evidenceLevel: caseEvidenceLevel,
      appliesTo: scopedAppliesTo(platform, audience, review.finalizedAt, null),
      adoptedTopicIds: topicId ? [topicId] : [],
      adoptedKnowledgeVersionIds: adoptedNoteLineage,
      changeType: 'created' as NoteVersionChangeType,
      changeReason: '结果回流：final Review 单次样本观察'
    }
  });
  noteVersionIds[caseCanonicalKey] = caseVersionId;
  promoted.push({ noteId: caseNoteId, versionId: caseVersionId, canonicalKey: caseCanonicalKey, kind: 'case', changeType: 'created' });

  // 2) 限域表述：keep 项精确命中既有 active creative_pattern/method/claim Note → qualified 版本
  for (const keepItem of keepItems) {
    const target = database.prepare(
      `SELECT id, kind, revision, current_version_id AS currentVersionId
       FROM knowledge_notes WHERE scope = ? AND canonical_key = ? AND lifecycle = 'active' LIMIT 1`
    ).get(scope, keepItem) as { id: string; kind: string; revision: number; currentVersionId: string | null } | undefined;
    if (!target) continue;
    if (!QUALIFY_TARGET_KINDS[target.kind]) continue;
    const qualifiedVersionId = deterministicId('of-qual-ver', `${requestId}|${scope}|${target.id}`);
    notes.push({
      id: target.id,
      scope,
      kind: target.kind as NoteKind,
      canonicalKey: keepItem,
      beforeRevision: target.revision,
      version: {
        versionId: qualifiedVersionId,
        statement:
          `在 ${String(platform ?? 'any')} / ${String(audience ?? 'any')} 的 ${finalizedDate} 单次样本中同向；` +
          `限该平台/受众/时间窗继续观察，不构成普遍证明。`,
        conclusionStatus: 'inference' as ConclusionStatus,
        evidenceLevel: 'outcome_observed' as EvidenceLevel,
        appliesTo: scopedAppliesTo(platform, audience, review.finalizedAt, null),
        adoptedTopicIds: topicId ? [topicId] : [],
        adoptedKnowledgeVersionIds: adoptedNoteLineage,
        changeType: 'qualified' as NoteVersionChangeType,
        changeReason: '结果回流：单次结果限域表述'
      }
    });
    qualifiedNoteKeys.push(keepItem);
    promoted.push({ noteId: target.id, versionId: qualifiedVersionId, canonicalKey: keepItem, kind: target.kind as NoteKind, changeType: 'qualified' });
  }

  // 3) 重复结果限域强化：同 topic + 同 platform/audience + 同规范化 keep ≥ 2 次才建/强化 pattern
  const planMatches: Array<PriorMatch & { keepItem: string; platform: string; audience: string; patternCanonicalKey: string }> = [];
  for (const keepItem of keepItems) {
    const matched: Array<{ reviewId: string; publicationId: string; finalizedAt: string; metricSnapshotIds: readonly string[]; platform: string; audience: string }> = [];
    for (const prior of priorReviews) {
      if (scopeKeyOf(prior.platform, prior.audience) !== currentScopeKey) continue;
      if (!prior.keep.some((item) => normalizeCanonicalKey(item) === keepItem)) continue;
      matched.push({ reviewId: prior.reviewId, publicationId: prior.publicationId, finalizedAt: prior.finalizedAt, metricSnapshotIds: prior.metricSnapshotIds, platform: prior.platform, audience: prior.audience });
    }
    if (matched.length < 1) continue; // 设计门槛：≥ 2 次（含本次）
    const totalCount = matched.length + 1;
    const windowFrom = [review.finalizedAt, ...matched.map((entry) => entry.finalizedAt)].filter(Boolean).sort()[0] ?? null;
    const windowTo = [review.finalizedAt, ...matched.map((entry) => entry.finalizedAt)].filter(Boolean).sort().at(-1) ?? null;
    const patternCanonicalKey =
      `pattern:keep:${createHash('sha256').update(keepItem).digest('hex').slice(0, 16)}:${String(platform ?? 'any')}:` +
      createHash('sha256').update(String(audience ?? 'any')).digest('hex').slice(0, 12);
    const existingPattern = database.prepare(
      `SELECT id, revision, current_version_id AS currentVersionId
       FROM knowledge_notes WHERE scope = ? AND canonical_key = ? AND kind = 'creative_pattern' AND lifecycle = 'active' LIMIT 1`
    ).get(scope, patternCanonicalKey) as { id: string; revision: number; currentVersionId: string | null } | undefined;
    const patternVersionId = deterministicId('of-pattern-ver', `${requestId}|${scope}|${patternCanonicalKey}`);
    const patternStatement =
      `在 ${String(platform ?? 'any')} / ${String(audience ?? 'any')} 的 ${totalCount} 次发布样本` +
      `${windowFrom && windowTo ? `（${dateOnly(windowFrom)}..${dateOnly(windowTo)}）` : ''}中，「${keepItem}」被重复确认同向。` +
      `支持在该限域内继续观察/复用，不构成因果证明。`;
    const adopted = [...adoptedNoteLineage];
    if (existingPattern) {
      notes.push({
        id: existingPattern.id,
        scope,
        kind: 'creative_pattern',
        canonicalKey: patternCanonicalKey,
        beforeRevision: existingPattern.revision,
        version: {
          versionId: patternVersionId,
          statement: patternStatement,
          conclusionStatus: 'inference' as ConclusionStatus,
          evidenceLevel: 'corroborated' as EvidenceLevel,
          appliesTo: scopedAppliesTo(platform, audience, windowFrom, windowTo),
          adoptedTopicIds: topicId ? [topicId] : [],
          adoptedKnowledgeVersionIds: adopted,
          changeType: 'strengthened' as NoteVersionChangeType,
          changeReason: '结果回流：重复同向结果限域强化'
        }
      });
      promoted.push({ noteId: existingPattern.id, versionId: patternVersionId, canonicalKey: patternCanonicalKey, kind: 'creative_pattern', changeType: 'strengthened' });
      patternUpdates.push({ canonicalKey: patternCanonicalKey, changeType: 'strengthened', versionId: patternVersionId });
    } else {
      const patternNoteId = deterministicId('of-pattern', `${scope}|${patternCanonicalKey}`);
      notes.push({
        id: patternNoteId,
        scope,
        kind: 'creative_pattern',
        canonicalKey: patternCanonicalKey,
        title: keepItem,
        version: {
          versionId: patternVersionId,
          statement: patternStatement,
          conclusionStatus: 'inference' as ConclusionStatus,
          evidenceLevel: 'corroborated' as EvidenceLevel,
          appliesTo: scopedAppliesTo(platform, audience, windowFrom, windowTo),
          adoptedTopicIds: topicId ? [topicId] : [],
          adoptedKnowledgeVersionIds: adopted,
          changeType: 'created' as NoteVersionChangeType,
          changeReason: '结果回流：重复同向结果达到门槛，限域建立'
        }
      });
      noteVersionIds[patternCanonicalKey] = patternVersionId;
      promoted.push({ noteId: patternNoteId, versionId: patternVersionId, canonicalKey: patternCanonicalKey, kind: 'creative_pattern', changeType: 'created' });
      patternUpdates.push({ canonicalKey: patternCanonicalKey, changeType: 'created', versionId: patternVersionId });
    }
    for (const match of matched) {
      planMatches.push({ ...match, keepItem, platform: match.platform, audience: match.audience, patternCanonicalKey });
    }
  }

  // 4) 证据（review + publication + metric snapshots；重复模式建立时含全部匹配 Review 的证据）
  function addOutcomeEvidence(noteVersionId: string, includePrior: readonly PriorMatch[] = []): void {
    evidenceLinks.push({
      knowledgeNoteVersionId: noteVersionId,
      evidenceObjectType: 'review',
      evidenceObjectId: review.id,
      relation: 'supports',
      sourceNature: 'review',
      excerpt: review.summary ?? null,
      locator: `review:${review.id}`,
      observedAt: review.finalizedAt
    });
    evidenceLinks.push({
      knowledgeNoteVersionId: noteVersionId,
      evidenceObjectType: 'publication',
      evidenceObjectId: review.publicationId,
      relation: 'supports',
      sourceNature: 'performance_observation',
      locator: `publication:${review.publicationId}`,
      observedAt: publishedAt
    });
    for (const snapshot of snapshots) {
      evidenceLinks.push({
        knowledgeNoteVersionId: noteVersionId,
        evidenceObjectType: 'metric_snapshot',
        evidenceObjectId: snapshot.id,
        relation: 'supports',
        sourceNature: 'performance_observation',
        locator: `metric:${snapshot.id}`,
        observedAt: snapshot.capturedAt || review.finalizedAt
      });
    }
    for (const prior of includePrior) {
      evidenceLinks.push({
        knowledgeNoteVersionId: noteVersionId,
        evidenceObjectType: 'review',
        evidenceObjectId: prior.reviewId,
        relation: 'supports',
        sourceNature: 'review',
        observedAt: prior.finalizedAt || null
      });
      evidenceLinks.push({
        knowledgeNoteVersionId: noteVersionId,
        evidenceObjectType: 'publication',
        evidenceObjectId: prior.publicationId,
        relation: 'supports',
        sourceNature: 'performance_observation',
        observedAt: prior.finalizedAt || null
      });
      for (const snapshotId of prior.metricSnapshotIds) {
        evidenceLinks.push({
          knowledgeNoteVersionId: noteVersionId,
          evidenceObjectType: 'metric_snapshot',
          evidenceObjectId: snapshotId,
          relation: 'supports',
          sourceNature: 'performance_observation',
          observedAt: prior.finalizedAt || null
        });
      }
    }
  }

  addOutcomeEvidence(caseVersionId);
  for (const keepItem of qualifiedNoteKeys) {
    const qualifiedVersionId = notes.find((note) => note.canonicalKey === keepItem && note.version.changeType === 'qualified')?.version.versionId;
    if (qualifiedVersionId) addOutcomeEvidence(qualifiedVersionId);
  }
  // 重复模式：建立（created）时证据含全部匹配 Review；强化（strengthened）只附本次证据（既往版本已携带）。
  for (const pattern of patternUpdates) {
    if (pattern.changeType !== 'created') continue;
    const priorForPattern = planMatches
      .filter((entry) => entry.patternCanonicalKey === pattern.canonicalKey && entry.reviewId !== review.id)
      .map((entry) => ({ reviewId: entry.reviewId, publicationId: entry.publicationId, finalizedAt: entry.finalizedAt, metricSnapshotIds: entry.metricSnapshotIds }));
    addOutcomeEvidence(pattern.versionId, priorForPattern);
  }

  // ---- 防伪因果守卫：绝不「新建」因果 Method Note（既有 method 的限域表述 qualified 允许） ----
  for (const note of notes) {
    if (FORBIDDEN_NOTE_KINDS[note.kind] && note.beforeRevision === undefined) {
      fail('OUTCOME_PLAN_INVALID', `结果回流禁止生成因果 Method（${note.canonicalKey}）。`, { canonicalKey: note.canonicalKey });
    }
  }

  // ---- 受影响 Topic Wiki 原子重编译（与结果知识同一 ChangeSet：Review 后立即可见） ----
  // 合并既有 body（保留编译器字段），追加 recentOutcomes/recentChanges，采纳新结果版本；
  // 无 topic 时跳过（结果 Note 仍落库 + 回执）。revision 冲突/任何失败 → 整个 ChangeSet
  // 回滚（含 review 保存），零部分写。
  let wikiPageOp: WikiPageWrite | null = null;
  let wikiPageId: string | null = null;
  let wikiPageVersionId: string | null = null;
  let wikiPagesCompiled = 0;
  if (topicId) {
    const page = database.prepare(
      `SELECT id, revision FROM knowledge_wiki_pages
       WHERE scope = ? AND subject_type = 'topic' AND subject_id = ? AND lifecycle = 'active' LIMIT 1`
    ).get(scope, topicId) as { id: string; revision: number } | undefined;
    let previousAdopted: string[] = [];
    let previousBody: Readonly<Record<string, unknown>> = {};
    if (page) {
      const current = database.prepare('SELECT current_version_id AS c FROM knowledge_wiki_pages WHERE id = ?').get(page.id) as { c: string | null } | undefined;
      if (current?.c) {
        const version = getWikiPageVersion(database, current.c);
        if (version) {
          previousAdopted = [...version.adoptedNoteVersionIds];
          if (version.body && typeof version.body === 'object' && !Array.isArray(version.body)) {
            previousBody = version.body as Readonly<Record<string, unknown>>;
          }
        }
      }
    }
    const newVersionIds = promoted.map((entry) => entry.versionId);
    const adoptedNoteVersionIds = [...new Set([...previousAdopted, ...newVersionIds])].sort((a, b) => a.localeCompare(b));
    const recentOutcomes = Array.isArray(previousBody.recentOutcomes) ? [...(previousBody.recentOutcomes as unknown[])] : [];
    recentOutcomes.push({
      reviewId: review.id,
      publicationId: review.publicationId,
      caseNoteVersionId: caseVersionId,
      patternUpdates: patternUpdates.map((entry) => ({ canonicalKey: entry.canonicalKey, changeType: entry.changeType })),
      asOf: review.finalizedAt ?? ''
    });
    const recentChanges = Array.isArray(previousBody.recentChanges) ? [...(previousBody.recentChanges as unknown[])] : [];
    for (const entry of promoted) {
      recentChanges.push({ noteId: entry.noteId, versionId: entry.versionId, canonicalKey: entry.canonicalKey, changeType: entry.changeType });
    }
    const body: Readonly<Record<string, unknown>> = {
      ...previousBody,
      recentOutcomes,
      recentChanges,
      versionCount: adoptedNoteVersionIds.length,
      updatedByOutcome: true
    };
    const changeSummary = `结果回流 Review ${review.id}：新增 ${promoted.length} 条结果知识（${promoted.map((entry) => entry.changeType).join('、')}）、重编译 Topic Wiki（采纳 ${adoptedNoteVersionIds.length} 个知识版本）。`;
    const readableDiff = `结果观察：Keep ${review.keep.length} / Stop ${review.stop.length} / Change ${review.change.length}；指标 ${metricSummary}。`;
    wikiPageVersionId = deterministicId('of-wver', `${requestId}|wiki-topic|${topicId}`);
    if (page) {
      wikiPageId = page.id;
      wikiPageOp = {
        id: page.id, scope, pageType: 'topic', canonicalKey: `wiki-topic:${topicId}`,
        subjectType: 'topic', subjectId: topicId, beforeRevision: page.revision,
        version: { versionId: wikiPageVersionId, body, adoptedNoteVersionIds, businessObjectRefs: [`review:${review.id}`], changeSummary, readableDiff, compileReason: '结果回流' }
      };
    } else {
      wikiPageId = deterministicId('page', `wiki-topic|${topicId}`);
      const pageTitle = String(previousBody.title ?? `Topic ${topicId}`);
      wikiPageOp = {
        id: wikiPageId, scope, pageType: 'topic', canonicalKey: `wiki-topic:${topicId}`, title: pageTitle,
        subjectType: 'topic', subjectId: topicId,
        version: { versionId: wikiPageVersionId, title: pageTitle, body, adoptedNoteVersionIds, businessObjectRefs: [`review:${review.id}`], changeSummary, readableDiff, compileReason: '结果回流' }
      };
    }
    wikiPagesCompiled = 1;
  }

  const counts: OutcomeFeedbackCounts = Object.freeze({
    caseNotesCreated: 1,
    notesQualified: qualifiedNoteKeys.length,
    patternsCreated: patternUpdates.filter((entry) => entry.changeType === 'created').length,
    patternsStrengthened: patternUpdates.filter((entry) => entry.changeType === 'strengthened').length,
    evidenceLinks: evidenceLinks.length,
    wikiPagesCompiled,
    lineageVersions: lineageVersionIds.length
  });

  const receipt: ReceiptWrite = {
    triggerType: 'review',
    requestId,
    summary:
      `final Review ${review.id} 结果回流：案例观察 ${counts.caseNotesCreated} 条、限域表述 ${counts.notesQualified} 条、` +
      `重复结果模式 ${counts.patternsCreated + counts.patternsStrengthened} 条（${counts.patternsCreated} 新建 / ${counts.patternsStrengthened} 强化）、` +
      `证据 ${counts.evidenceLinks} 条、Topic Wiki 重编译 ${counts.wikiPagesCompiled} 个；发布时固定血缘 ${counts.lineageVersions} 条。`,
    counts: { ...counts } as Readonly<Record<string, number>>,
    affectedTopics: topicId ? [topicId] : [],
    affectedEntities: [],
    affectedMethods: [],
    affectedSyntheses: [],
    wikiPageVersions: wikiPageVersionId ? [wikiPageVersionId] : [],
    impact: {
      reviewId: review.id,
      publicationId: review.publicationId,
      contentVersionId: review.contentVersionId,
      platform,
      audience,
      snapshotCount: snapshots.length,
      metricSummary,
      window: { from: dateOnly(review.finalizedAt), to: dateOnly(review.finalizedAt) },
      lineagePresent: lineageVersionIds.length > 0,
      lineageVersionIds,
      stopItems: review.stop,
      changeItems: review.change,
      nonPromoted: [...review.stop, ...review.change].map((item) => ({ item, reason: '单次结果不做否定/修改结论（防伪因果，§5）' }))
    },
    autoResolutions: [],
    retainedDisputes: [],
    failures: []
  };

  const changeSetInput: KnowledgeChangeSetInput = {
    notes,
    evidenceLinks,
    wikiPages: wikiPageOp ? [wikiPageOp] : [],
    receipts: [receipt]
  };

  // 幂等输入哈希：只对「冻结终态计划」求哈希（派生段含观察态计数，重放必然不同）；
  // 同 requestId + 同计划 → 重放零写；同 requestId + 异计划 → REQUEST_REPLAY_CONFLICT。
  const planHash = createKnowledgeChangeSetInputHash(requestId, {
    workspaceId,
    reviewId: review.id,
    reviewRevision: review.revision,
    publicationId: review.publicationId,
    contentVersionId: review.contentVersionId,
    topicId,
    scope,
    platform,
    audience,
    lineage: { wikiPageVersionIds: lineage.wikiPageVersionIds, noteVersionIds: lineage.noteVersionIds },
    snapshots: snapshots.map((snapshot) => ({ id: snapshot.id, scheduledFor: snapshot.scheduledFor, capturedAt: snapshot.capturedAt, normalized: snapshot.normalized })),
    keep: review.keep,
    stop: review.stop,
    change: review.change,
    summary: review.summary,
    findings: findings.map((finding) => ({ title: finding.title, body: finding.body })),
    finalizedAt: review.finalizedAt,
    planMatches: planMatches.map((entry) => ({
      reviewId: entry.reviewId,
      publicationId: entry.publicationId,
      finalizedAt: entry.finalizedAt,
      metricSnapshotIds: entry.metricSnapshotIds,
      keepItem: entry.keepItem,
      platform: entry.platform,
      audience: entry.audience
    }))
  });

  const meta: KnowledgeChangeSetMeta = {
    workspaceId,
    requestId,
    reason: `结果回流：final Review ${review.id} → 保守知识（单次观察/限域表述/重复限域模式）`,
    triggerSource: TRIGGER_SOURCE,
    resolutionMode: 'none',
    createdBy: CREATED_BY,
    inputHash: planHash
  };

  const result = applyKnowledgeChangeSet(database, meta, changeSetInput, false);

  // 重放：以库中持久化结果为准（replay 由 store 短路，不执行本计划写）。
  let persistedReceipt = result.receipt;
  if (result.replay) {
    persistedReceipt = getUpdateReceiptByRequest(database, workspaceId, requestId);
  }

  return Object.freeze({
    ok: true,
    skipped: false,
    replay: result.replay,
    changeSetId: result.changeSetId,
    requestId,
    reviewId: review.id,
    counts: result.replay && persistedReceipt ? countsFromReceipt(persistedReceipt) : counts,
    noteVersionIds: Object.freeze({ ...noteVersionIds }),
    wikiPageId,
    wikiPageVersionId,
    receipt: persistedReceipt
  });
}

function countsFromReceipt(receipt: KnowledgeUpdateReceiptRecord): OutcomeFeedbackCounts {
  return Object.freeze({
    caseNotesCreated: Number(receipt.counts.caseNotesCreated ?? 0),
    notesQualified: Number(receipt.counts.notesQualified ?? 0),
    patternsCreated: Number(receipt.counts.patternsCreated ?? 0),
    patternsStrengthened: Number(receipt.counts.patternsStrengthened ?? 0),
    evidenceLinks: Number(receipt.counts.evidenceLinks ?? 0),
    wikiPagesCompiled: Number(receipt.counts.wikiPagesCompiled ?? 0),
    lineageVersions: Number(receipt.counts.lineageVersions ?? 0)
  });
}
