// WMB-5246: Studio 媒体区读模型投影（StudioMediaWorkflow 所有）。
// 职责：把「项目关联 Source 的已保存媒体 + 视频理解结果」投影为 Studio 媒体区可消费的
// 只读形状（来源图/原视频/关键帧/Segment + 建议卡片），并生成确定性、诚实的基础建议
// （理由只来自真实元数据与理解结果，绝不虚构媒体内容；AI 建议可后续替换/增强同形状）。
//
// 契约来源：
// - 候选/绑定/视频运行 schema 与 ID：src/shared/media-candidates.ts + src/main/db/media-archive-store.ts
//   （MediaSchema 权威）+ src/main/db/video-understanding-store.ts。
// - 设计 §12.2：Studio 展示来源图、原视频、关键帧和可引用 Segment；建议显示目标段落、理由、
//   图注、变换和风险；视频是结构化附件（绝不进入 wmb-asset:// 图片 token）。
// - 设计 §11：无合适素材必须返回空；未理解媒体可展示为候选，但 AI 不能声称其内容；
//   restricted 不进入自动建议；unknown 显示风险但可由用户决定。
//
// 防御性读模型：候选/绑定/视频运行表在迁移 64-66 之前不存在时返回空数组（Studio 不崩），
// 迁移落地后自动点亮。禁止在本模块写库。

import { DatabaseSync } from 'node:sqlite';
import { getAsset } from './assets.ts';
import { listSourceMediaBindings } from './db/media-archive-store.ts';
import {
  listVideoRunsForRevision,
  parseKeyframesJson,
  parseProbeJson,
  parseSegmentsJson,
  type VideoKeyframeRecord,
  type VideoSegmentRecord,
  type VideoUnderstandingRunRecord
} from './db/video-understanding-store.ts';
import { sourceRevisionKey } from '../shared/media-candidates.ts';
import type { MediaRiskFlag, MediaRightsStatus } from '../shared/media-candidates.ts';
import type { MediaKind } from '../shared/media-bindings.ts';

export { studioRightsLabel, studioRiskFlagLabel } from '../shared/studio-media-labels.ts';

// ---------------------------------------------------------------------------
// Studio 读模型类型（main 投影 + renderer type-only 导入共用）
// ---------------------------------------------------------------------------

export type StudioSourceMedia = Readonly<{
  sourceId: string;
  /** 媒体集合冻结所依据的 revision 键（`source:<id>:r<revision>`；建议生成入参用）。 */
  sourceRevisionKey: string;
  sourceTitle: string;
  bindingId: string;
  candidateId: string;
  assetId: string;
  kind: MediaKind;
  ordinal: number;
  originalUrl: string;
  caption: string | null;
  sha256: string;
  rightsStatus: MediaRightsStatus;
  riskFlags: readonly MediaRiskFlag[];
  asset: {
    id: string;
    mimeType: string;
    byteCount: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  };
  /** 视频理解（kind=video 且存在 run 时非 null；run 未完成的机械结果如实呈现，不伪造内容）。 */
  video: StudioVideoUnderstanding | null;
}>;

export type StudioVideoUnderstanding = Readonly<{
  runStatus: VideoUnderstandingRunRecord['status'];
  stage: VideoUnderstandingRunRecord['stage'];
  durationMs: number | null;
  transcriptSource: 'native' | 'asr' | 'ocr' | 'none' | null;
  keyframes: readonly StudioVideoKeyframe[];
  segments: readonly StudioVideoSegment[];
}>;

export type StudioVideoKeyframe = Readonly<{
  assetId: string;
  timeMs: number;
  width: number;
  height: number;
}>;

export type StudioVideoSegment = Readonly<{
  index: number;
  startMs: number;
  endMs: number;
  keyframeAssetId: string | null;
  summary: string | null;
  quoteRange: { startMs: number; endMs: number } | null;
  confidence: number | null;
  transcript: string | null;
  transcriptSource: 'native' | 'asr' | 'ocr' | 'none';
  warnings: readonly string[];
}>;

/** 建议用途优先级（设计 §11：直接证据 > 演示/比较 > 背景 > 封面 > 装饰）。 */
/** 建议用途优先级（设计 §11：直接证据 > 演示/比较 > 背景 > 封面 > 装饰）。 */
export type StudioSuggestionPriority =
  | 'direct_evidence'
  | 'demonstration'
  | 'comparison'
  | 'background'
  | 'cover'
  | 'decoration';

// ---------------------------------------------------------------------------
// 表存在性守卫（迁移 64-66 未落地时 Studio 读模型返回空，不抛错）
// ---------------------------------------------------------------------------

function tableExists(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// ---------------------------------------------------------------------------
// 视频理解 → Studio 投影
// ---------------------------------------------------------------------------

function projectVideoUnderstanding(run: VideoUnderstandingRunRecord): StudioVideoUnderstanding {
  const probe = parseProbeJson(run);
  const keyframes = (parseKeyframesJson(run) ?? []).map((frame: VideoKeyframeRecord) => ({
    assetId: frame.assetId,
    timeMs: frame.timeMs,
    width: frame.width,
    height: frame.height
  }));
  const segments = (parseSegmentsJson(run) ?? []).map((segment: VideoSegmentRecord) => ({
    index: segment.index,
    startMs: segment.startMs,
    endMs: segment.endMs,
    keyframeAssetId: segment.keyframeAssetId,
    summary: segment.summary,
    quoteRange: segment.quoteRange,
    confidence: segment.confidence,
    transcript: segment.transcript.length > 0 ? segment.transcript.map((item) => item.text).join(' ') : null,
    transcriptSource: segment.transcriptSource,
    warnings: segment.warnings
  }));
  const transcriptSource = segments.find((segment) => segment.transcriptSource !== 'none')?.transcriptSource ?? null;
  return {
    runStatus: run.status,
    stage: run.stage,
    durationMs: probe?.durationMs ?? null,
    transcriptSource,
    keyframes,
    segments
  };
}

// ---------------------------------------------------------------------------
// Studio 媒体区主投影入口
// ---------------------------------------------------------------------------

/**
 * 读取项目关联 Source 的已保存媒体 + 视频理解。
 * sourceIds 来自 content_project_sources；每个 Source 取当前 revision（source_items.revision）
 * 冻结的媒体集合（设计 §6.1：revision key = source:<sourceId>:r<revision>）。
 * 表不存在（迁移未落地）→ 空数组；单表查询失败不影响其它 Source。
 * 建议（媒体建议）不在此生成：由 MediaRecommendations 引擎按 claim 匹配生成并持久化
 * （media-recommendations:* IPC；接受仍是独立 Studio 保存边界）。
 */
export function readStudioMediaProjection(
  database: DatabaseSync,
  input: { sourceIds: readonly string[] }
): { sourceMedia: StudioSourceMedia[] } {
  const result: StudioSourceMedia[] = [];
  if (input.sourceIds.length === 0 || !tableExists(database, 'source_media_bindings')) {
    return { sourceMedia: [] };
  }
  const hasVideoRuns = tableExists(database, 'video_understanding_runs');
  for (const sourceId of input.sourceIds) {
    try {
      const source = database.prepare('SELECT id, title, revision FROM source_items WHERE id = ?').get(sourceId) as
        | { id: string; title: string; revision: number }
        | undefined;
      if (!source) continue;
      const revisionKey = sourceRevisionKey(source.id, source.revision);
      const bindings = listSourceMediaBindings(database, revisionKey);
      if (bindings.length === 0) continue;
      const runs = hasVideoRuns ? listVideoRunsForRevision(database, revisionKey) : [];
      const latestRunByAsset = new Map<string, VideoUnderstandingRunRecord>();
      for (const run of runs) {
        if (!latestRunByAsset.has(run.assetId)) latestRunByAsset.set(run.assetId, run);
      }
      for (const binding of bindings) {
        const asset = getAsset(database, binding.assetId);
        if (!asset) continue;
        const riskFlags = parseRiskFlags(binding.riskFlagsJson);
        const run = binding.kind === 'video' ? latestRunByAsset.get(binding.assetId) ?? null : null;
        result.push({
          sourceId: source.id,
          sourceRevisionKey: revisionKey,
          sourceTitle: source.title,
          bindingId: binding.id,
          candidateId: binding.candidateId,
          assetId: binding.assetId,
          kind: binding.kind,
          ordinal: binding.ordinal,
          originalUrl: binding.originalUrl,
          caption: binding.caption,
          sha256: binding.sha256,
          rightsStatus: binding.rightsStatus,
          riskFlags,
          asset: {
            id: asset.id,
            mimeType: asset.mimeType,
            byteCount: asset.byteCount,
            width: asset.width,
            height: asset.height,
            durationMs: asset.durationMs
          },
          video: run ? projectVideoUnderstanding(run) : null
        });
      }
    } catch {
      // 单 Source 媒体读取失败不阻断其余 Source 与 Studio 主体（只读投影降级为空）。
      continue;
    }
  }
  return { sourceMedia: result };
}

function parseRiskFlags(json: string): readonly MediaRiskFlag[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((flag): flag is MediaRiskFlag =>
      typeof flag === 'string' && ['copyright', 'portrait', 'privacy', 'brand', 'paywalled', 'third_party_repost'].includes(flag));
  } catch {
    return [];
  }
}
