import type { TodayPlanItem } from '../main/workbench';

export type View = 'today' | 'discover' | 'knowledge' | 'topic' | 'library' | 'canvas' | 'studio' | 'publish' | 'results' | 'settings';
export const views: View[] = ['today', 'discover', 'knowledge', 'topic', 'library', 'canvas', 'studio', 'publish', 'results', 'settings'];
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
  rankingContext?: RankingContext;
  xListContext?: XListPiContext | null;
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
