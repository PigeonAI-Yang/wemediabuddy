// WMB-5243：全局知识网络 renderer 纯函数层（无 IPC / 无副作用）。
// 供 knowledge-canvas-view / knowledge-canvas-layout / knowledge-network-card 消费。
// 边界：本模块只把 src/shared/knowledge-network.ts 投影翻译成展示标签/文案；
// 过滤、布局、邻接与视口数学由 knowledge-network-interaction 承担，本模块不重复实现。

import type { KnowledgeNetworkNodeDetail } from '../shared/knowledge-network';
import type { KnowledgeDeepLinkPayload } from '../shared/knowledge-topic-library';

/** 节点 → 正式导航目标（既有导航回调；深链路由由后端给出稳定正式对象 ID）。 */
export type CanvasDetailTarget = {
  type: 'topic' | 'source' | 'studio' | 'results';
  id?: string;
  title?: string;
};

// ===== 深链决策（WMB-5243 high correctness：note/entity 双击/跳转不得静默 no-op） =====
// knowledge_note / knowledge_entity 没有独立正式页面（深链解析为 knowledge_object）。
// 诚实降级：双击与跳转按钮统一落到已有知识本体浮卡，并给出可观察反馈；不新建路由。

/** note/entity 无独立正式页面时的诚实降级反馈文案（浮卡即完整认识面）。 */
export const NO_FORMAL_PAGE_NOTICE =
  '该知识暂无独立正式页面，已保留在本卡查看完整认识。';

/** 无正式页面时跳转按钮的诚实降级文案（点击保留本体浮卡并提示，不导航）。 */
export const CARD_FALLBACK_JUMP_LABEL = '无独立页面 · 在本卡查看';

/** 深链决策：正式导航目标，或降级到本体浮卡（含反馈文案）。 */
export type DetailTargetDecision = Readonly<
  | { kind: 'navigate'; target: CanvasDetailTarget }
  | { kind: 'card-fallback'; notice: string }
>;

/**
 * 节点深链 → 决策。
 * - deepLink route='topic'：直连正式主题页（topic 永远有正式页，双击深链成立）；
 * - 深链解析给出 topic_wiki/source：走既有正式导航；
 * - knowledge_object（note/entity 无独立正式页面）或解析失败：诚实降级到本体浮卡。
 */
export function decideDetailTarget(
  link: KnowledgeNetworkNodeDetail['deepLink'],
  payload: KnowledgeDeepLinkPayload | null,
): DetailTargetDecision {
  if (link?.route === 'topic')
    return {
      kind: 'navigate',
      target: { type: 'topic', id: link.objectId, title: link.title },
    };
  if (payload?.targetType === 'topic_wiki' && payload.targetId)
    return {
      kind: 'navigate',
      target: { type: 'topic', id: payload.targetId, title: payload.title },
    };
  if (payload?.targetType === 'source' && payload.targetId)
    return {
      kind: 'navigate',
      target: { type: 'source', id: payload.targetId, title: payload.title },
    };
  return { kind: 'card-fallback', notice: NO_FORMAL_PAGE_NOTICE };
}

const RELATION_KEY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  supports: '支持',
  contradicts: '反驳',
  qualifies: '限定',
  derived_from: '派生',
  about: '关于',
  belongs_to_topic: '属于主题',
  entity_relation: '实体关联',
  adopted: '采纳',
  custom: '自定义',
});

/** 关系语义 → 用户语言（未知 key 诚实回退原值）。 */
export function relationKeyLabel(key: string | null | undefined): string {
  return RELATION_KEY_LABELS[String(key ?? '')] ?? String(key ?? '');
}

const SOURCE_NATURE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  primary_source: '一手资料',
  secondary_source: '二手资料',
  user_statement: '用户陈述',
  user_experience: '用户经验',
  business_record: '业务记录',
  performance_observation: '效果观察',
  review: '复盘',
  derived_knowledge: '派生知识',
  ai_inference: 'AI 推断',
});

/** 证据来源性质 → 用户语言（未知值诚实回退原值）。 */
export function sourceNatureLabel(nature: string | null | undefined): string {
  return SOURCE_NATURE_LABELS[String(nature ?? '')] ?? String(nature ?? '');
}

export type EvidenceBoundaryLike = Readonly<{
  evidenceCount: number;
  byRelation: Readonly<Record<string, number>>;
  bySourceNature: Readonly<Record<string, number>>;
}>;

/** 证据边界摘要条（有界）：[N 条依据, 关系前二, 来源性质前二]；无证据返回空数组。 */
export function evidenceBoundaryChips(
  boundary: EvidenceBoundaryLike | null | undefined,
): string[] {
  if (!boundary || !boundary.evidenceCount) return [];
  const byRelation = Object.entries(boundary.byRelation)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key, count]) => `${relationKeyLabel(key)} ${count}`);
  const byNature = Object.entries(boundary.bySourceNature)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key, count]) => `${sourceNatureLabel(key)} ${count}`);
  return [`${boundary.evidenceCount} 条依据`, ...byRelation, ...byNature];
}

/** 证据边界一句话（同一摘要的平铺形式；测试与工具提示用）。 */
export function evidenceBoundaryText(
  boundary: EvidenceBoundaryLike | null | undefined,
): string {
  const chips = evidenceBoundaryChips(boundary);
  return chips.length ? chips.join(' · ') : '暂无依据';
}

/** 最近更新时间的人话（刚刚 / n 分钟前 / n 小时前 / n 天前 / 日期）。 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(time).toLocaleDateString();
}
