import type { TodayPlanItem, TodaySource } from '../main/workbench';

export type View = 'today' | 'agents' | 'discover' | 'proposals' | 'topic' | 'library' | 'canvas' | 'studio' | 'publish' | 'results' | 'settings';
export const views: View[] = ['today', 'agents', 'discover', 'proposals', 'topic', 'library', 'canvas', 'studio', 'publish', 'results', 'settings'];
export type Theme = 'dark' | 'light';
export type RankingContextItem = { rank: number; name: string; url: string; description: string; language: string; stars: string; gained: string; boardId: string; boardLabel: string };
export type RankingContext = {
  boards: Array<{ id: string; label: string; sourceUrl: string; items: RankingContextItem[] }>;
  items: RankingContextItem[];
};
export type XListPiPost = {
  url: string;
  authorHandle: string | null;
  displayName?: string | null;
  text: string;
  postedAt: string | null;
  hasVideo?: boolean;
  imageCount?: number;
  replyCount?: number;
};
export type XListPiContext = {
  accountKey: string | null;
  listId: string | null;
  listName: string | null;
  listKind: string | null;
  mode: 'page' | 'post';
  selectedPost: (XListPiPost & { replies?: XListPiPost[] }) | null;
  /** Posts currently loaded in the feed and sent to Pi. */
  visiblePosts: XListPiPost[];
  /** Total posts loaded in UI (same as visiblePosts.length after fix; kept explicit for chip honesty). */
  loadedCount: number;
};
/** WMB-5207：Studio 当前可编辑文档种类。 */
export type StudioDocumentKind = 'core' | 'platform';
/** WMB-5207：可批注的平台版本。 */
export type StudioPlatformId = 'x' | 'xiaohongshu' | 'wechat';
/** WMB-5207：Studio 通过 page focus 发布的当前可编辑工作稿快照。 */
export type PiStudioDocument = {
  projectId: string;
  documentKind: StudioDocumentKind;
  documentId: string | null;
  platform: StudioPlatformId | null;
  title: string;
  currentBody: string;
  bodyFingerprint: string;
  dirty: boolean;
};
/** WMB-5207：随工作稿带入 Pi 的开放批注（用户标注，非修改授权）。prefix/suffix 为 Data 契约的稳定邻近锚点，恒为 string。 */
export type PiStudioOpenAnnotation = {
  id: string;
  startOffset: number;
  endOffset: number;
  quotedText: string;
  prefixContext: string;
  suffixContext: string;
  note: string | null;
};
export type PiFocusObject = {
  type: string;
  id: string;
  title: string;
  summary?: string | null;
  url?: string | null;
  bodyStatus?: 'none' | 'ready' | 'failed' | 'empty';
  bodyExcerpt?: string | null;
  bodyChars?: number;
  meta?: Record<string, unknown>;
  /** WMB-5207：Studio 当前可编辑工作稿；仅用户在创作页显式发送消息时序列化。 */
  studioDocument?: PiStudioDocument | null;
  /** WMB-5207：当前工作稿上的开放批注；只作上下文，不构成授权。 */
  openAnnotations?: PiStudioOpenAnnotation[] | null;
};
export type PiContextRef = {
  page: View;
  pageLabel: string;
  objectType: string | null;
  objectId: string | null;
  objectTitle: string | null;
  packagePurpose?: 'discussion';
  canvasId?: string;
  contextSelection?: { canvasId: string; nodeIds: string[]; mode: 'current_page' | 'selected'; title: string };
  selectedItems?: TodayPlanItem[];
  selectedSources?: Array<TodaySource & { bodyStatus?: 'none' | 'ready' | 'failed' | 'empty'; bodyExcerpt?: string | null; bodyChars?: number }>;
  fermenting?: {
    items: Array<{
      id: string;
      objectType: 'plan_item' | 'source' | 'topic';
      objectId: string;
      title: string;
      state: 'active' | 'watching' | 'done' | 'dismissed' | 'expired';
      priority: number | null;
      topicId: string | null;
      sourceIds: string[];
      originPlanDate: string | null;
      fermentedDays: number;
      decayScore: number;
      reason: string | null;
      aftershocks: Array<{ sourceId: string; title: string; collectedAt: string }>;
      revision: number;
    }>;
    watchingItems: Array<{
      id: string;
      objectType: 'plan_item' | 'source' | 'topic';
      objectId: string;
      title: string;
      state: 'active' | 'watching' | 'done' | 'dismissed' | 'expired';
      priority: number | null;
      topicId: string | null;
      sourceIds: string[];
      originPlanDate: string | null;
      fermentedDays: number;
      decayScore: number;
      reason: string | null;
      aftershocks: Array<{ sourceId: string; title: string; collectedAt: string }>;
      revision: number;
    }>;
    topics: Array<{ topicId: string; title: string; activeCount: number; watchingCount: number; latestTitle: string | null; fermentedDays: number }>;
    pinnedSources: Array<{ id: string; title: string; collectedAt: string; priority: number | null; summary: string | null; canonicalUrl: string | null; fermentedDays: number; reason: string }>;
  };
  rankingContext?: RankingContext;
  xListContext?: XListPiContext | null;
  /** Generic page focus. Pages report what user is looking at; Pi packs this without per-page wiring. */
  focus?: PiFocusObject | null;
};

export const platformNames: Record<string, string> = {
  x: 'X',
  X: 'X',
  twitter: 'X',
  xiaohongshu: '小红书',
  小红书: '小红书',
  wechat: '公众号',
  微信: '公众号',
  公众号: '公众号',
  微信公众号: '公众号',
  jike: '即刻',
  即刻: '即刻'
};
/** @deprecated Prefer <PlatformMark/>; kept for plain-text fallbacks. */
export const platformIcon = (platform?: string): string => ({
  x: '𝕏', X: '𝕏', twitter: '𝕏',
  xiaohongshu: '红', 小红书: '红',
  wechat: '微', 微信: '微', 公众号: '微', 微信公众号: '微',
  jike: '即', 即刻: '即'
} as Record<string, string>)[platform ?? ''] ?? '·';
export const formatNames: Record<string, string> = { text: '观点短文', article: '文章', image: '图文', video: '视频', short_video: '口播视频' };
export const logoUrl = new URL('../../images/logo.png', import.meta.url).href;
