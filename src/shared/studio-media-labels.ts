// WMB-5246: Studio 媒体区展示文案（单一实现；main 投影与 renderer 共用）。
// 纯函数、无 Node 依赖；禁止在 main / renderer 各自维护第二套同名字段或中文文案。

import type { MediaRiskFlag, MediaRightsStatus } from './media-candidates.ts';

/** 风险标记中文文案（Studio 建议卡片展示）。 */
export function studioRiskFlagLabel(flag: MediaRiskFlag | string): string {
  return ({
    copyright: '版权',
    portrait: '肖像',
    privacy: '隐私',
    brand: '品牌',
    paywalled: '付费墙',
    third_party_repost: '第三方转发'
  } as Record<string, string>)[flag] ?? flag;
}

/** rights_status 中文文案（Studio 建议卡片展示）。 */
export function studioRightsLabel(status: MediaRightsStatus | string): string {
  return ({
    unknown: '权利状态未知',
    likely_reusable: '可能可复用',
    permission_required: '需要授权',
    restricted: '受限'
  } as Record<string, string>)[status] ?? status;
}

/** 建议用途优先级中文文案（设计 §11：直接证据 > 演示/比较 > 背景 > 封面 > 装饰）。 */
export function studioSuggestionPriorityLabel(priority: string): string {
  return ({
    direct_evidence: '直接证据',
    demonstration: '演示',
    comparison: '对比',
    background: '背景',
    cover: '封面',
    decoration: '装饰'
  } as Record<string, string>)[priority] ?? priority;
}

/** 媒体种类中文文案（Studio 媒体区展示）。 */
export function studioMediaKindLabel(kind: string): string {
  return ({ image: '图片', video: '视频', video_poster: '视频封面' } as Record<string, string>)[kind] ?? kind;
}
