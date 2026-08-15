// WMB-5246: 创作媒体建议共享契约（MediaRecommendations 所有）。
// 纯类型 + 纯函数，无 Node 依赖；main / preload / renderer / tests 共用本文件为唯一权威，
// 禁止在 main / renderer 各自维护第二套同名类型或分类逻辑。
// 数据语义以 docs/spark/2026-08-14-wmb-intelligence-media-production-pipeline-design.md §11/§12 为准：
// - 固定内容/Source/Knowledge 版本 + completed 理解结果 → 按观点生成 0..N 条可审计建议；
// - 没有合适素材必须返回空；未理解媒体可展示为候选，但 AI 不能声称其内容；
// - restricted 不进入自动建议；unknown 显示风险但可由用户决定；
// - 用户接受后才写 Content/Platform Binding；拒绝、关闭或模型失败均零版本写（接受 = 独立 Studio 保存）。

import type { MediaCandidateKind, MediaRiskFlag, MediaRightsStatus } from './media-candidates.ts';
import type { CropRegion } from './media-bindings.ts';

// ---------------------------------------------------------------------------
// 用途与优先级（设计 §11.5：直接证据 > 演示/比较 > 背景 > 封面 > 装饰）
// ---------------------------------------------------------------------------

export const MEDIA_RECOMMENDATION_PURPOSES = [
  'direct_evidence',
  'demonstration',
  'comparison',
  'background',
  'cover',
  'decoration'
] as const;

export type MediaRecommendationPurpose = (typeof MEDIA_RECOMMENDATION_PURPOSES)[number];

/** 用途优先级（0 最高；同 claim 下按此排序后取评分最高的 N 条）。 */
export const MEDIA_RECOMMENDATION_PURPOSE_PRIORITY: Readonly<Record<MediaRecommendationPurpose, number>> = Object.freeze({
  direct_evidence: 0,
  demonstration: 1,
  comparison: 2,
  background: 3,
  cover: 4,
  decoration: 5
});

export function mediaRecommendationPriority(purpose: MediaRecommendationPurpose | string): number {
  return MEDIA_RECOMMENDATION_PURPOSE_PRIORITY[purpose as MediaRecommendationPurpose] ?? 99;
}

export function isMediaRecommendationPurpose(value: string | null | undefined): value is MediaRecommendationPurpose {
  return Boolean(value && (MEDIA_RECOMMENDATION_PURPOSES as readonly string[]).includes(value));
}

/** 用途中文文案（Studio 建议卡片展示；单一实现）。 */
export const mediaRecommendationPurposeLabel = (purpose: MediaRecommendationPurpose | string): string =>
  ({
    direct_evidence: '直接证据',
    demonstration: '演示',
    comparison: '比较',
    background: '背景',
    cover: '封面',
    decoration: '装饰'
  })[purpose as MediaRecommendationPurpose] ?? String(purpose);

// ---------------------------------------------------------------------------
// 审计状态（设计 §11：proposed → accepted/rejected；新提案替换旧提案 → superseded）
// ---------------------------------------------------------------------------

export const MEDIA_RECOMMENDATION_STATES = ['proposed', 'accepted', 'rejected', 'superseded'] as const;
export type MediaRecommendationState = (typeof MEDIA_RECOMMENDATION_STATES)[number];

export function isMediaRecommendationState(value: string | null | undefined): value is MediaRecommendationState {
  return Boolean(value && (MEDIA_RECOMMENDATION_STATES as readonly string[]).includes(value));
}

// ---------------------------------------------------------------------------
// 建议变换（设计 §11.6「建议变换」：只建议不物化；物化由接受后的 Studio 保存/派生完成）
// ---------------------------------------------------------------------------

export type MediaRecommendationTransform =
  | { kind: 'none' }
  | { kind: 'crop'; region: CropRegion }
  | { kind: 'clip'; startMs: number; endMs: number }
  | { kind: 'keyframe'; timeMs: number };

export function isValidRecommendationTransform(transform: unknown): transform is MediaRecommendationTransform {
  if (!transform || typeof transform !== 'object') return false;
  const value = transform as Record<string, unknown>;
  if (value.kind === 'none') return true;
  if (value.kind === 'crop') {
    const region = value.region as CropRegion | undefined;
    return Boolean(
      region &&
      typeof region.x === 'number' && Number.isFinite(region.x) && region.x >= 0 && region.x <= 1 &&
      typeof region.y === 'number' && Number.isFinite(region.y) && region.y >= 0 && region.y <= 1 &&
      typeof region.width === 'number' && Number.isFinite(region.width) && region.width > 0 &&
      typeof region.height === 'number' && Number.isFinite(region.height) && region.height > 0 &&
      region.x + region.width <= 1 && region.y + region.height <= 1
    );
  }
  if (value.kind === 'clip') {
    return (
      typeof value.startMs === 'number' && Number.isFinite(value.startMs) && value.startMs >= 0 &&
      typeof value.endMs === 'number' && Number.isFinite(value.endMs) && value.endMs > value.startMs
    );
  }
  if (value.kind === 'keyframe') {
    return typeof value.timeMs === 'number' && Number.isFinite(value.timeMs) && value.timeMs >= 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 建议草稿 / 读模型（设计 §11.6：固定 Asset、目标段落/claim、用途、理由、图注、变换、来源、风险）
// ---------------------------------------------------------------------------

export type MediaRecommendationDraft = Readonly<{
  /** 目标段落/claim 键（splitContentClaims 的稳定键）。 */
  claimKey: string;
  /** 目标段落摘录。 */
  claimExcerpt: string;
  sourceId: string;
  sourceRevisionKey: string;
  bindingId: string;
  assetId: string;
  mediaKind: MediaCandidateKind;
  purpose: MediaRecommendationPurpose;
  priority: number;
  /** 理由（引用理解结果；AI 建议可解释）。 */
  rationale: string;
  /** 建议图注。 */
  caption: string;
  transform: MediaRecommendationTransform;
  /** 证据 locator（图片 asset|sourceRevision[|region]；视频 + timeRange）。 */
  provenance: string;
  rightsStatus: MediaRightsStatus;
  riskFlags: readonly MediaRiskFlag[];
}>;

export type MediaRecommendation = MediaRecommendationDraft & Readonly<{
  id: string;
  contentVersionId: string;
  projectId: string;
  state: MediaRecommendationState;
  revision: number;
  requestId: string;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  supersededAt: string | null;
  supersededBy: string | null;
}>;

/** Studio 建议读模型（按 claim 分组；preload/renderer 与 main 共用单一类型）。 */
export type MediaRecommendationsReadModel = Readonly<{
  contentVersionId: string;
  projectId: string;
  claims: ReadonlyArray<Readonly<{
    claimKey: string;
    claimExcerpt: string;
    suggestions: readonly MediaRecommendation[];
  }>>;
  counts: Readonly<Record<MediaRecommendationState, number>>;
}>;

// ---------------------------------------------------------------------------
// IPC 通道（主进程注册 + preload 消费同一常量，避免第二套命名）
// ---------------------------------------------------------------------------

export const MEDIA_RECOMMENDATIONS_LIST_IPC_CHANNEL = 'media-recommendations:list' as const;
export const MEDIA_RECOMMENDATIONS_GENERATE_IPC_CHANNEL = 'media-recommendations:generate' as const;
export const MEDIA_RECOMMENDATIONS_DECIDE_IPC_CHANNEL = 'media-recommendations:decide' as const;

// ---------------------------------------------------------------------------
// 确定性 claim 切分（纯函数；同正文恒同输出，测试可断言）
// ---------------------------------------------------------------------------

export type MediaClaimSegment = Readonly<{
  /** 稳定键：`c0`、`c1` … 按正文顺序。 */
  key: string;
  /** 段标题（markdown 标题行去 # 后 trim；无标题段为空串）。 */
  heading: string;
  /** 段正文（标题行之后、下一标题/文末之前的非空行）。 */
  text: string;
  /** 摘录：text 前 80 字符（超出截断加省略号）。 */
  excerpt: string;
}>;

export const CLAIM_EXCERPT_MAX_CHARS = 80;

export function claimExcerptOf(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= CLAIM_EXCERPT_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, CLAIM_EXCERPT_MAX_CHARS)}…`;
}

/**
 * 把 markdown 正文确定性切分为观点/段落：标题行（`^#{1,6}\s`）开新段，
 * 段落以空行分隔；同一标题下的连续非空行并入该段。返回的键稳定（c0..cN）。
 */
export function splitContentClaims(body: string): MediaClaimSegment[] {
  const claims: Array<{ heading: string; text: string }> = [];
  let heading = '';
  const buffer: string[] = [];
  const flush = () => {
    const text = buffer.join('\n').replace(/\n{2,}/g, '\n').trim();
    if (text || heading) claims.push({ heading, text });
    buffer.length = 0;
  };
  for (const rawLine of String(body ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      flush();
      heading = headingMatch[1]!.trim();
      continue;
    }
    if (!line.trim()) {
      flush();
      heading = '';
      continue;
    }
    buffer.push(line.trim());
  }
  flush();
  return claims.map((claim, index) => {
    const text = claim.text || claim.heading;
    return Object.freeze({
      key: `c${index}`,
      heading: claim.heading,
      text,
      excerpt: claimExcerptOf(text)
    });
  });
}

/** 每 claim 最多建议数（确定性上限；同 claim 按优先级+评分取前 N）。 */
export const MAX_RECOMMENDATIONS_PER_CLAIM = 3;
