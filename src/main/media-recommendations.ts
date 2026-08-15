// WMB-5246: 创作媒体建议服务（MediaRecommendations 所有）。
// 职责：固定内容/Source/Knowledge 版本 + completed 理解结果 → 按观点生成可审计媒体建议；
// 持久化 proposed/accepted/rejected/superseded 审计状态；restricted 排除自动建议；
// 接受 = 独立 Studio 保存（本模块绝不写 Content/Platform Binding，只记录用户决定）。
// 契约：shared/media-recommendations.ts（类型/校验）、db/media-archive-store.ts（绑定）、
// db/video-understanding-store.ts（视频 run）、visual-source-lineage.ts（图片 run）、
// shared/media-candidates.ts（locator/键）。
//
// 确定性：引擎是纯函数（同 contentVersion + sourceRevisionKeys + completed 理解 → 同建议）；
// 匹配只使用真实理解文本（观察 statement/summary/transcript），绝不虚构媒体内容；
// 没有合适素材必须返回空。

import { DatabaseSync } from 'node:sqlite';
import {
  MAX_RECOMMENDATIONS_PER_CLAIM,
  MEDIA_RECOMMENDATION_PURPOSE_PRIORITY,
  claimExcerptOf,
  mediaRecommendationPriority,
  splitContentClaims,
  type MediaClaimSegment,
  type MediaRecommendation,
  type MediaRecommendationDraft,
  type MediaRecommendationPurpose,
  type MediaRecommendationState,
  type MediaRecommendationTransform,
  type MediaRecommendationsReadModel
} from '../shared/media-recommendations.ts';
import { videoEvidenceLocator, type MediaCandidateKind, type MediaRiskFlag, type MediaRightsStatus } from '../shared/media-candidates.ts';
import { listSourceMediaBindings, type SourceMediaBindingRecord } from './db/media-archive-store.ts';
import { getLatestVideoRunForIdentity, parseSegmentsJson, type VideoSegmentRecord } from './db/video-understanding-store.ts';
import { VIDEO_SCHEMA_VERSION } from './video-understanding.ts';
import { VISUAL_SCHEMA_VERSION, getLatestVisualRun, visualEvidenceLocator, type VisualRunRecord } from './visual-source-lineage.ts';

// ---------------------------------------------------------------------------
// 输入/读模型
// ---------------------------------------------------------------------------

export type GenerateMediaRecommendationsInput = Readonly<{
  contentVersionId: string;
  projectId: string;
  /** 固定 Source 版本键（`source:<id>:r<revision>`；调用方在生成前固定，设计 §11.1）。 */
  sourceRevisionKeys: readonly string[];
  /**
   * 允许自动建议「封面」用途：仅当 Asset 是 generated 身份时（设计 §11：生成/重绘封面必须标为生成内容）。
   * 默认 false —— 自动建议绝不以原始证据冒充生成封面。
   */
  allowGeneratedCover?: boolean;
}>;

export type ProposeMediaRecommendationsInput = Readonly<{
  contentVersionId: string;
  projectId: string;
  requestId: string;
  drafts: readonly MediaRecommendationDraft[];
}>;

export type DecideMediaRecommendationInput = Readonly<{
  id: string;
  expectedRevision: number;
  decision: 'accept' | 'reject';
  /** restricted 建议接受必须显式用户确认（设计 §13：用户强制采用需显式确认并写 operation evidence）。 */
  confirmedByOwner?: boolean;
  decidedBy?: string;
}>;

export class MediaRecommendationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MediaRecommendationError';
    this.code = code;
  }
}

function recommendationError(code: string, message: string): MediaRecommendationError {
  return new MediaRecommendationError(code, message);
}

// ---------------------------------------------------------------------------
// 确定性匹配（设计 §11.4-11.6）
// ---------------------------------------------------------------------------

/** 理解文本（图片观察 item 或视频 segment）→ 匹配文本。 */
type MediaEvidence = Readonly<{
  binding: SourceMediaBindingRecord;
  /** 图片：观察 items 的 statement/excerpt；视频：segment summary/transcript。 */
  text: string;
  /** 视频 segment（仅视频建议）；图片为 null。 */
  segment: VideoSegmentRecord | null;
  /** 生成身份（provenance kind=generated）；用于 cover 建议门。 */
  generated: boolean;
}>;

function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  const lower = String(text).toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9]+/g)) out.add(match[0]);
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length; i++) {
    out.add(cjk[i]);
    if (i + 1 < cjk.length) out.add(cjk.slice(i, i + 2));
  }
  return out;
}

/** 归一化重叠度：交集 / min(两侧 token 数)；无 token 任一侧 → 0。确定性。 */
function overlapScore(claimText: string, mediaText: string): number {
  const left = tokensOf(claimText);
  const right = tokensOf(mediaText);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

const SCORE_EVIDENCE = 0.4;
const SCORE_DEMO = 0.28;
const SCORE_BACKGROUND = 0.12;
const COMPARISON_KEYWORDS = /(对比|比较|相比之下|versus|\bvs\.?)/i;

function classifyPurpose(score: number, claimText: string): MediaRecommendationPurpose | null {
  if (score >= SCORE_EVIDENCE) return 'direct_evidence';
  if (score >= SCORE_DEMO) return COMPARISON_KEYWORDS.test(claimText) ? 'comparison' : 'demonstration';
  if (score >= SCORE_BACKGROUND) return 'background';
  return null;
}

function riskFlagsOf(binding: SourceMediaBindingRecord): readonly MediaRiskFlag[] {
  try {
    const parsed = JSON.parse(binding.riskFlagsJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((flag): flag is MediaRiskFlag => ['copyright', 'portrait', 'privacy', 'brand', 'paywalled', 'third_party_repost'].includes(String(flag)))
      : [];
  } catch {
    return [];
  }
}

function imageEvidenceText(run: VisualRunRecord): string {
  const items = run.observation?.items ?? [];
  return items.map((item) => `${item.statement} ${item.excerpt}`.trim()).filter(Boolean).join(' ');
}

function segmentEvidenceText(segment: VideoSegmentRecord): string {
  const transcript = (segment.transcript ?? []).map((item) => item.text).join(' ');
  return [segment.summary, transcript].filter(Boolean).join(' ');
}

function captionSuggestion(binding: SourceMediaBindingRecord, evidenceText: string): string {
  const raw = binding.caption?.trim() || evidenceText.trim();
  return raw.length <= 60 ? raw : `${raw.slice(0, 60)}…`;
}

function imageTransform(): MediaRecommendationTransform {
  return { kind: 'none' };
}

function videoTransform(segment: VideoSegmentRecord): MediaRecommendationTransform {
  const range = segment.quoteRange ?? { startMs: segment.startMs, endMs: segment.endMs };
  return { kind: 'clip', startMs: range.startMs, endMs: range.endMs };
}

function videoRangeOf(segment: VideoSegmentRecord): { startMs: number; endMs: number } {
  return segment.quoteRange ?? { startMs: segment.startMs, endMs: segment.endMs };
}

function isGeneratedAsset(database: DatabaseSync, assetId: string): boolean {
  const row = database
    .prepare("SELECT 1 FROM asset_provenance WHERE asset_id = ? AND kind = 'generated' LIMIT 1")
    .get(assetId) as { 1?: number } | undefined;
  return Boolean(row);
}

function buildDraft(
  claim: MediaClaimSegment,
  evidence: MediaEvidence,
  purpose: MediaRecommendationPurpose
): MediaRecommendationDraft {
  const binding = evidence.binding;
  const isVideo = evidence.segment !== null;
  const range = evidence.segment ? videoRangeOf(evidence.segment) : null;
  const provenance = isVideo && evidence.segment
    ? videoEvidenceLocator(binding.assetId, binding.sourceRevisionKey, range!.startMs, range!.endMs)
    : visualEvidenceLocator(binding.assetId, binding.sourceRevisionKey);
  const score = overlapScore(claim.text, evidence.text);
  const scoreText = score.toFixed(2);
  const rationale = purpose === 'cover'
    ? `无直接证据匹配「${claim.excerpt}」；该媒体为生成身份，仅建议作为封面/信息图（生成内容，不冒充原始证据）。`
    : purpose === 'background'
      ? `媒体内容「${evidence.text.slice(0, 40)}」与观点「${claim.excerpt}」弱相关（重叠 ${scoreText}），可作为背景素材。`
      : isVideo && evidence.segment
        ? `视频段 ${range!.startMs}-${range!.endMs}ms 摘要「${(evidence.segment.summary ?? evidence.text).slice(0, 40)}」与观点「${claim.excerpt}」关键词重叠 ${scoreText}，可作为直接体验证据。`
        : `图片理解「${evidence.text.slice(0, 40)}」与观点「${claim.excerpt}」关键词重叠 ${scoreText}，可作为直接证据。`;
  return Object.freeze({
    claimKey: claim.key,
    claimExcerpt: claim.excerpt,
    sourceId: binding.sourceId,
    sourceRevisionKey: binding.sourceRevisionKey,
    bindingId: binding.id,
    assetId: binding.assetId,
    mediaKind: binding.kind,
    purpose,
    priority: mediaRecommendationPriority(purpose),
    rationale,
    caption: captionSuggestion(binding, evidence.text),
    transform: isVideo && evidence.segment ? videoTransform(evidence.segment) : imageTransform(),
    provenance,
    rightsStatus: binding.rightsStatus,
    riskFlags: riskFlagsOf(binding)
  });
}

/**
 * 引擎：读取固定 contentVersion 正文 + 各 sourceRevisionKey 的已保存媒体与 completed 理解，
 * 按观点生成 0..N 条建议（确定性排序：用途优先级升序 → 重叠度降序 → ordinal 升序 → assetId 升序）。
 * - restricted 绑定不进入自动建议；unknown/likely_reusable/permission_required 照常建议并携带风险。
 * - 未理解媒体（无 completed run）绝不声称其内容，不产生建议。
 * - 没有合适素材 → 返回空数组（不虚构）。
 */
export function generateMediaRecommendations(
  database: DatabaseSync,
  input: GenerateMediaRecommendationsInput
): MediaRecommendationDraft[] {
  const bodyRow = database.prepare('SELECT body FROM content_versions WHERE id = ?').get(input.contentVersionId) as { body: string } | undefined;
  if (!bodyRow) throw recommendationError('CONTENT_VERSION_NOT_FOUND', `内容版本不存在: ${input.contentVersionId}`);
  const claims = splitContentClaims(bodyRow.body);
  if (claims.length === 0) return [];

  // 收集每个 sourceRevisionKey 的已保存媒体 + completed 理解证据。
  const evidences: MediaEvidence[] = [];
  for (const revisionKey of input.sourceRevisionKeys) {
    const bindings = listSourceMediaBindings(database, revisionKey);
    for (const binding of bindings) {
      if (binding.archivedAt != null) continue;
      // restricted 不进入自动建议（设计 §11.8）。
      if (binding.rightsStatus === 'restricted') continue;
      const generated = isGeneratedAsset(database, binding.assetId);
      if (binding.kind === 'video') {
        const run = getLatestVideoRunForIdentity(database, {
          sourceId: binding.sourceId,
          sourceRevisionKey: binding.sourceRevisionKey,
          assetId: binding.assetId,
          schemaVersion: VIDEO_SCHEMA_VERSION
        });
        if (!run || run.status !== 'completed') continue; // 未理解 → 不声称内容
        const segments = parseSegmentsJson(run) ?? [];
        for (const segment of segments) {
          const text = segmentEvidenceText(segment);
          if (!text.trim()) continue; // 无文本段（transcriptSource none）不参与观点匹配
          evidences.push({ binding, text, segment, generated });
        }
      } else {
        const run = getLatestVisualRun(database, {
          sourceId: binding.sourceId,
          sourceRevisionId: binding.sourceRevisionKey,
          assetId: binding.assetId,
          schemaVersion: VISUAL_SCHEMA_VERSION
        });
        if (!run || run.status !== 'completed') continue; // 未理解 → 不声称内容
        const text = imageEvidenceText(run);
        if (!text.trim()) continue;
        evidences.push({ binding, text, segment: null, generated });
      }
    }
  }
  if (evidences.length === 0) return [];

  const drafts: MediaRecommendationDraft[] = [];
  for (const claim of claims) {
    const matches: Array<{ evidence: MediaEvidence; purpose: MediaRecommendationPurpose; score: number }> = [];
    for (const evidence of evidences) {
      const score = overlapScore(claim.text, evidence.text);
      if (score < SCORE_BACKGROUND) continue;
      const purpose = classifyPurpose(score, claim.text);
      if (!purpose) continue;
      matches.push({ evidence, purpose, score });
    }
    // 设计 §11：没有直接证据时，仅当显式允许且媒体为生成身份，才建议封面（标为生成内容，绝不冒充原始证据）。
    if (matches.length === 0 && input.allowGeneratedCover) {
      for (const evidence of evidences) {
        if (!evidence.generated) continue;
        matches.push({ evidence, purpose: 'cover', score: overlapScore(claim.text, evidence.text) });
      }
    }
    if (matches.length === 0) continue; // 没有合适素材 → 该观点零建议
    matches.sort((a, b) =>
      mediaRecommendationPriority(a.purpose) - mediaRecommendationPriority(b.purpose) ||
      b.score - a.score ||
      a.evidence.binding.ordinal - b.evidence.binding.ordinal ||
      (a.evidence.binding.assetId < b.evidence.binding.assetId ? -1 : a.evidence.binding.assetId > b.evidence.binding.assetId ? 1 : 0)
    );
    for (const match of matches.slice(0, MAX_RECOMMENDATIONS_PER_CLAIM)) {
      drafts.push(buildDraft(claim, match.evidence, match.purpose));
    }
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// 持久化：建议审计状态（proposed → accepted/rejected；新提案替换旧提案 → superseded）
// ---------------------------------------------------------------------------

const RECOMMENDATION_COLUMNS = `id, content_version_id AS contentVersionId, project_id AS projectId,
  claim_key AS claimKey, claim_excerpt AS claimExcerpt, source_id AS sourceId, source_revision_key AS sourceRevisionKey,
  binding_id AS bindingId, asset_id AS assetId, media_kind AS mediaKind, purpose, priority, rationale, caption,
  transform_json AS transformJson, provenance, rights_status AS rightsStatus, risk_flags_json AS riskFlagsJson,
  state, revision, request_id AS requestId, created_at AS createdAt, updated_at AS updatedAt,
  decided_at AS decidedAt, decided_by AS decidedBy, superseded_at AS supersededAt, superseded_by AS supersededBy`;

function mapRecommendationRow(row: Record<string, unknown>): MediaRecommendation {
  const transform = JSON.parse(String(row.transformJson)) as MediaRecommendationTransform;
  const riskFlags = JSON.parse(String(row.riskFlagsJson)) as MediaRiskFlag[];
  return Object.freeze({
    id: String(row.id),
    contentVersionId: String(row.contentVersionId),
    projectId: String(row.projectId),
    claimKey: String(row.claimKey),
    claimExcerpt: String(row.claimExcerpt),
    sourceId: String(row.sourceId),
    sourceRevisionKey: String(row.sourceRevisionKey),
    bindingId: String(row.bindingId),
    assetId: String(row.assetId),
    mediaKind: row.mediaKind as MediaCandidateKind,
    purpose: row.purpose as MediaRecommendationPurpose,
    priority: Number(row.priority),
    rationale: String(row.rationale),
    caption: String(row.caption),
    transform,
    provenance: String(row.provenance),
    rightsStatus: row.rightsStatus as MediaRightsStatus,
    riskFlags,
    state: row.state as MediaRecommendationState,
    revision: Number(row.revision),
    requestId: String(row.requestId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    decidedAt: (row.decidedAt as string | null) ?? null,
    decidedBy: (row.decidedBy as string | null) ?? null,
    supersededAt: (row.supersededAt as string | null) ?? null,
    supersededBy: (row.supersededBy as string | null) ?? null
  });
}

export function getMediaRecommendation(database: DatabaseSync, id: string): MediaRecommendation | null {
  const row = database.prepare(`SELECT ${RECOMMENDATION_COLUMNS} FROM media_recommendations WHERE id = ?`).get(id);
  return row ? mapRecommendationRow(row as Record<string, unknown>) : null;
}

/**
 * 持久化 proposed 建议（调用方事务内）：新提案运行先把自己名下 prior proposed 置 superseded
 * （审计保留），再按 UNIQUE(content_version_id, claim_key, asset_id, purpose) 幂等 upsert。
 * 已 accepted/rejected 的行绝不被覆盖（用户决定是终态，除非用户显式重新决定）。
 * 返回写入/更新的建议行（按 claimKey, priority, id 稳定序）。
 */
export function proposeMediaRecommendations(
  database: DatabaseSync,
  input: ProposeMediaRecommendationsInput
): MediaRecommendation[] {
  const now = new Date().toISOString();
  const inserted: MediaRecommendation[] = [];
  const upsert = database.prepare(`
    INSERT INTO media_recommendations (
      id, content_version_id, project_id, claim_key, claim_excerpt, source_id, source_revision_key,
      binding_id, asset_id, media_kind, purpose, priority, rationale, caption, transform_json, provenance,
      rights_status, risk_flags_json, state, revision, request_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?, ?)
    ON CONFLICT (content_version_id, claim_key, asset_id, purpose) DO UPDATE SET
      claim_excerpt = excluded.claim_excerpt,
      source_id = excluded.source_id,
      source_revision_key = excluded.source_revision_key,
      binding_id = excluded.binding_id,
      media_kind = excluded.media_kind,
      purpose = excluded.purpose,
      priority = excluded.priority,
      rationale = excluded.rationale,
      caption = excluded.caption,
      transform_json = excluded.transform_json,
      provenance = excluded.provenance,
      rights_status = excluded.rights_status,
      risk_flags_json = excluded.risk_flags_json,
      state = 'proposed',
      revision = revision + 1,
      request_id = excluded.request_id,
      updated_at = excluded.updated_at,
      decided_at = NULL,
      decided_by = NULL
    WHERE media_recommendations.state IN ('proposed', 'superseded')
      AND NOT (media_recommendations.state = 'proposed' AND media_recommendations.request_id = excluded.request_id)
  `);
  for (const draft of input.drafts) {
    const id = `mrec:${input.contentVersionId}:${draft.claimKey}:${draft.assetId}:${draft.purpose}`;
    upsert.run(
      id, input.contentVersionId, input.projectId, draft.claimKey, draft.claimExcerpt,
      draft.sourceId, draft.sourceRevisionKey, draft.bindingId, draft.assetId, draft.mediaKind,
      draft.purpose, draft.priority, draft.rationale, draft.caption, JSON.stringify(draft.transform),
      draft.provenance, draft.rightsStatus, JSON.stringify(draft.riskFlags), input.requestId, now, now
    );
    const row = getMediaRecommendation(database, id);
    // 只返回真正处于 proposed 且属于本次提案运行的行；与 accepted/rejected 冲突的草稿
    // 因 ON CONFLICT WHERE 不生效而保持用户决定，绝不以新提案覆盖（设计 §11.9 用户决定是终态）。
    if (row && row.state === 'proposed' && row.requestId === input.requestId) inserted.push(row);
  }
  inserted.sort((a, b) =>
    a.claimKey < b.claimKey ? -1 : a.claimKey > b.claimKey ? 1 :
    a.priority - b.priority ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return inserted;
}

/**
 * 把某个 contentVersionId 的 prior proposed 建议置 superseded（调用方事务内；新提案运行开头调用）。
 */
export function supersedeProposedRecommendations(
  database: DatabaseSync,
  input: { contentVersionId: string; requestId: string; at?: string }
): number {
  const at = input.at ?? new Date().toISOString();
  const result = database.prepare(`
    UPDATE media_recommendations SET state = 'superseded', superseded_at = ?, superseded_by = ?, updated_at = ?
    WHERE content_version_id = ? AND state = 'proposed'
  `).run(at, input.requestId, at, input.contentVersionId);
  return Number(result.changes);
}

/**
 * 用户决定：accept/reject。接受绝不写 Content/Platform Binding（独立 Studio 保存边界）；
 * 只记录审计状态与决定者。restricted 建议接受必须 confirmedByOwner=true（显式用户确认 + operation evidence）。
 * 乐观锁：revision 不符 → 零写入抛错。
 */
export function decideMediaRecommendation(
  database: DatabaseSync,
  input: DecideMediaRecommendationInput
): MediaRecommendation {
  const existing = getMediaRecommendation(database, input.id);
  if (!existing) throw recommendationError('RECOMMENDATION_NOT_FOUND', `建议不存在: ${input.id}`);
  if (existing.state !== 'proposed') {
    throw recommendationError('RECOMMENDATION_ALREADY_DECIDED', `建议已 ${existing.state}，不能再次决定。`);
  }
  if (existing.revision !== input.expectedRevision) {
    throw recommendationError('RECOMMENDATION_REVISION_CONFLICT', '建议版本已变化，请刷新后重试。');
  }
  if (input.decision === 'accept' && existing.rightsStatus === 'restricted' && !input.confirmedByOwner) {
    throw recommendationError('RIGHTS_RESTRICTED_OVERRIDE_REQUIRED', 'restricted 素材须用户显式确认后才能采用。');
  }
  const now = new Date().toISOString();
  const decidedBy = input.decidedBy ?? 'owner_ui';
  database.prepare(`
    UPDATE media_recommendations SET state = ?, decided_at = ?, decided_by = ?, updated_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ? AND state = 'proposed'
  `).run(input.decision === 'accept' ? 'accepted' : 'rejected', now, decidedBy, now, input.id, input.expectedRevision);
  return getMediaRecommendation(database, input.id)!;
}

// ---------------------------------------------------------------------------
// 读模型（Studio 媒体区消费；按观点分组 + 状态计数）
// ---------------------------------------------------------------------------

export function readMediaRecommendations(
  database: DatabaseSync,
  input: { contentVersionId: string; projectId?: string }
): MediaRecommendationsReadModel {
  const rows = database
    .prepare(`SELECT ${RECOMMENDATION_COLUMNS} FROM media_recommendations WHERE content_version_id = ?
      ORDER BY claim_key, priority, id`)
    .all(input.contentVersionId) as Array<Record<string, unknown>>;
  const suggestions = rows.map(mapRecommendationRow);
  const counts: Record<MediaRecommendationState, number> = { proposed: 0, accepted: 0, rejected: 0, superseded: 0 };
  for (const row of suggestions) counts[row.state] += 1;
  const byClaim = new Map<string, MediaRecommendation[]>();
  for (const suggestion of suggestions) {
    const list = byClaim.get(suggestion.claimKey) ?? [];
    list.push(suggestion);
    byClaim.set(suggestion.claimKey, list);
  }
  const claims = [...byClaim.entries()].map(([claimKey, list]) => {
    const first = list[0]!;
    return Object.freeze({
      claimKey,
      claimExcerpt: first.claimExcerpt,
      suggestions: Object.freeze(list)
    });
  });
  return Object.freeze({
    contentVersionId: input.contentVersionId,
    projectId: input.projectId ?? suggestions[0]?.projectId ?? '',
    claims,
    counts
  });
}

// 供引擎/测试使用的确定性辅助（claim 切分单一实现来自 shared）。
export { splitContentClaims, claimExcerptOf, MEDIA_RECOMMENDATION_PURPOSE_PRIORITY };
