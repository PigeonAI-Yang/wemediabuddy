export type XListKind = 'owned' | 'following' | 'member' | 'unknown';
export type XListRef = { listId: string; canonicalUrl: string; name: string; ownerHandle: string | null; kind: XListKind };
export type XListObservation = { capturedAt: string; pageUrl: string; fingerprint: string; visibleText: string };
export type XListDetail = XListRef & { description: string; isPrivate: boolean; memberCount: number | null; observation: XListObservation };
export type XListMember = { handle: string; displayName: string; profileUrl: string };
export type XListPostAuthor = {
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};
export type XListPost = {
  url: string;
  authorHandle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  text: string;
  postedAt: string | null;
  images: string[];
  imageThumbs: string[];
  hasVideo: boolean;
  videoPoster: string | null;
  videoUrl: string | null;
  /** tweet=普通帖；repost=转发；quote=引用 */
  postKind?: 'tweet' | 'repost' | 'quote';
  /** 转发者（仅 repost） */
  repostedBy?: XListPostAuthor | null;
  /** 被引用的原帖（quote；repost 一般为空） */
  quotedPost?: XListPost | null;
  metrics: {
    replies: number | null;
    reposts: number | null;
    likes: number | null;
    bookmarks: number | null;
    views: number | null;
  };
  metricEvidence?: XMetricEvidenceMap;
};
export type XListPostDetail = XListPost & {
  replies: XListPost[];
  hasMoreReplies: boolean;
};
export type XListCreateInput = { name: string; description?: string; isPrivate: boolean };
export type XListUpdateInput = { listId: string; name?: string; description?: string; isPrivate?: boolean };
export type XListMemberOutcome = 'added' | 'removed' | 'already_present' | 'already_absent';
export type XListActionHooks = { beforeAction?: (action: string) => Promise<void>; shouldStop?: () => Promise<boolean> };

export class XListUnknownError extends Error {}
export class XListStopRequestedError extends Error {}
import type { XMetricEvidenceMap } from './metric-value.ts';
