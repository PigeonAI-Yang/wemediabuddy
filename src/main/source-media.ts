// WMB-5244: Source 媒体 UI 读模型投影（纯映射层）。
// - 数据真源：src/main/db/media-archive-store.ts（MediaSchema 权威 store）——
//   listMediaCandidatesForRevision / listSourceMediaBindings / mediaArchiveStatusSummary。
//   本模块只做「store 记录 → 共享 UI 契约（../shared/source-media.ts）」的纯映射，不重复读表、不写库。
// - preserved 的真源判定是当前 revision 存在有效（未归档）绑定行；远程 URL 候选永远映射为
//   assetId=null，绝不在 UI 呈现为已保存。计数与明细同源（buildSourceMediaCounts），避免漂移。
// - revision 键权威实现见 ../shared/media-candidates.ts 的 sourceRevisionKey。
import type { MediaCandidateRecord, SourceMediaBindingRecord } from './db/media-archive-store.ts';
import {
  buildSourceMediaCounts,
  type SourceMediaAssetInfo,
  type SourceMediaItem,
  type SourceMediaOverview
} from '../shared/source-media.ts';

/** 候选记录 + 有效绑定 + 本地 Asset → UI 行（纯函数；未知状态按 unsupported 兜底，不伪造）。 */
export function mapSourceMediaItem(
  candidate: MediaCandidateRecord,
  binding: SourceMediaBindingRecord | null,
  asset: SourceMediaAssetInfo | null
): SourceMediaItem {
  return Object.freeze({
    id: String(candidate.id),
    kind: candidate.kind,
    ordinal: Number(candidate.ordinal),
    channel: candidate.channel,
    originalUrl: String(candidate.originalUrl),
    captionHint: binding?.caption ?? candidate.captionHint,
    status: candidate.status,
    errorCode: candidate.errorCode,
    errorMessage: candidate.errorMessage,
    attemptCount: Number(candidate.attemptCount ?? 0),
    maxAttempts: Number(candidate.maxAttempts ?? 3),
    assetId: binding?.assetId ?? null,
    asset: binding?.assetId && asset ? asset : null
  });
}

/**
 * store 记录批 → UI 聚合（纯函数；计数与明细同源，避免 summary/items 漂移）。
 * bindings 只接受有效（archivedAt 为 null）绑定；同一候选多条有效绑定时取列表首条
 * （store 保证 preserve 流程每候选至多一条有效绑定）。
 */
export function composeSourceMediaOverview(
  input: Readonly<{
    sourceId: string;
    revision: number;
    revisionKey: string;
    candidates: readonly MediaCandidateRecord[];
    bindings: readonly SourceMediaBindingRecord[];
    assetsById: ReadonlyMap<string, SourceMediaAssetInfo>;
    globalPaused: boolean;
  }>
): SourceMediaOverview {
  const activeBindings = new Map<string, SourceMediaBindingRecord>();
  for (const binding of input.bindings) {
    if (binding.archivedAt == null && !activeBindings.has(String(binding.candidateId))) {
      activeBindings.set(String(binding.candidateId), binding);
    }
  }
  const items = input.candidates.map((candidate) => {
    const binding = activeBindings.get(String(candidate.id)) ?? null;
    const asset = binding ? input.assetsById.get(binding.assetId) ?? null : null;
    return mapSourceMediaItem(candidate, binding, asset);
  });
  return Object.freeze({
    sourceId: input.sourceId,
    revision: input.revision,
    revisionKey: input.revisionKey,
    counts: buildSourceMediaCounts(items),
    items,
    globalPaused: input.globalPaused
  });
}
