import type { TodayPlanItem } from '../main/workbench';

export type View = 'today' | 'knowledge' | 'topic' | 'library' | 'canvas' | 'compose' | 'studio' | 'publish' | 'results' | 'settings';
export const views: View[] = ['today', 'knowledge', 'topic', 'library', 'canvas', 'compose', 'studio', 'publish', 'results', 'settings'];
export type Theme = 'dark' | 'light';
export type RankingContextItem = { rank: number; name: string; url: string; description: string; language: string; stars: string; gained: string; boardId: string; boardLabel: string };
export type RankingContext = {
  boards: Array<{ id: string; label: string; sourceUrl: string; items: RankingContextItem[] }>;
  items: RankingContextItem[];
};
export type PiContextRef = {
  page: View;
  pageLabel: string;
  objectType: string | null;
  objectId: string | null;
  objectTitle: string | null;
  packagePurpose?: 'discussion' | 'creation';
  canvasId?: string;
  contextSelection?: { canvasId: string; nodeIds: string[]; mode: 'current_page' | 'selected'; title: string };
  selectedItems?: TodayPlanItem[];
  rankingContext?: RankingContext;
};

export const platformNames: Record<string, string> = { x: 'X', xiaohongshu: '小红书', wechat: '微信公众号' };
export const formatNames: Record<string, string> = { text: '观点短文', article: '文章', image: '图文', video: '视频', short_video: '口播视频' };
export const logoUrl = new URL('../../images/logo.png', import.meta.url).href;
