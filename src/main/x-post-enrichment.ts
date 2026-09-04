import type {
  XArticleContent,
  XListPost,
  XPostLink,
  XPostReplyCapture
} from './platforms/x-list-browser-types.ts';

const STATUS_URL_PATTERN = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/i;
const ARTICLE_URL_PATTERN = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/(\d+)/i;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;

export function statusIdentity(value: string | null | undefined): { id: string; url: string } | null {
  const match = String(value ?? '').trim().match(STATUS_URL_PATTERN);
  if (!match) return null;
  return { id: match[2], url: `https://x.com/${match[1]}/status/${match[2]}` };
}

export function canonicalXArticleUrl(value: string | null | undefined): { id: string; url: string } | null {
  const match = String(value ?? '').trim().replace(/[),.;!?]+$/, '').match(ARTICLE_URL_PATTERN);
  if (!match) return null;
  return { id: match[1], url: `https://x.com/i/article/${match[1]}` };
}

export function findXArticleUrls(text: string, links: readonly XPostLink[] = []): string[] {
  const candidates = [
    ...(String(text ?? '').match(URL_PATTERN) ?? []),
    ...links.flatMap((link) => [link.expandedUrl, link.url].filter((value): value is string => Boolean(value)))
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const article = canonicalXArticleUrl(candidate);
    if (!article || seen.has(article.url)) continue;
    seen.add(article.url);
    out.push(article.url);
  }
  return out;
}
export function limitXPostReplies(
  replies: readonly XListPost[],
  replyLimit: number,
  reportedReplyCount: number | null | undefined
): { replies: XListPost[]; hasMoreReplies: boolean } {
  const limit = Math.max(0, Math.min(Math.trunc(replyLimit), 40));
  const selected = replies.slice(0, limit);
  const reported = Math.max(0, Number(reportedReplyCount) || 0);
  const hasMoreReplies = replies.length > limit || reported > selected.length;
  return { replies: selected, hasMoreReplies };
}

function normalizedHandle(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/^@/, '').toLowerCase();
}

function postId(post: XListPost): string | null {
  return post.statusId?.trim() || statusIdentity(post.url)?.id || null;
}

function stablePostCompare(left: XListPost, right: XListPost): number {
  const leftTime = left.postedAt ? Date.parse(left.postedAt) : Number.NaN;
  const rightTime = right.postedAt ? Date.parse(right.postedAt) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
  const captureDiff = (left.captureOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.captureOrdinal ?? Number.MAX_SAFE_INTEGER);
  if (captureDiff) return captureDiff;
  return (postId(left) ?? left.url).localeCompare(postId(right) ?? right.url);
}

export function classifyXPostReplies(
  root: XListPost,
  replies: readonly XListPost[],
  capture: XPostReplyCapture
): { replies: XListPost[]; authorThread: XListPost[]; comments: XListPost[]; capture: XPostReplyCapture } {
  const rootIdentity = statusIdentity(root.url);
  const rootId = root.statusId?.trim() || rootIdentity?.id || null;
  const rootAuthor = normalizedHandle(root.authorHandle);
  const quotedId = root.quotedPost ? postId(root.quotedPost) : null;
  const unique: XListPost[] = [];
  const seen = new Set<string>();

  for (const [captureOrdinal, item] of replies.entries()) {
    const identity = statusIdentity(item.url);
    const id = item.statusId?.trim() || identity?.id || null;
    const key = id ? `id:${id}` : `url:${identity?.url ?? item.url.replace(/[?#].*$/, '')}`;
    if (!id || id === rootId || id === quotedId || seen.has(key)) continue;
    seen.add(key);
    unique.push({
      ...item,
      statusId: id,
      captureOrdinal: item.captureOrdinal ?? captureOrdinal,
      isRootAuthor: Boolean(rootAuthor && normalizedHandle(item.authorHandle) === rootAuthor),
      isAuthorThread: false
    });
  }

  const byId = new Map(unique.map((item) => [postId(item), item] as const).filter((entry): entry is [string, XListPost] => Boolean(entry[0])));
  const threadIds = new Set<string>();
  const depthById = new Map<string, number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of unique) {
      const id = postId(item);
      if (!id || threadIds.has(id) || !item.isRootAuthor) continue;
      const parentId = item.parentStatusId?.trim() || null;
      if (!parentId) continue;
      if (parentId === rootId) {
        threadIds.add(id);
        depthById.set(id, 1);
        changed = true;
        continue;
      }
      if (threadIds.has(parentId) && normalizedHandle(byId.get(parentId)?.authorHandle) === rootAuthor) {
        threadIds.add(id);
        depthById.set(id, (depthById.get(parentId) ?? 0) + 1);
        changed = true;
      }
    }
  }

  const enriched = unique.map((item) => {
    const id = postId(item);
    return { ...item, isAuthorThread: Boolean(id && threadIds.has(id)) };
  });
  const authorThread = enriched
    .filter((item) => item.isAuthorThread)
    .sort((left, right) => {
      const depth = (depthById.get(postId(left) ?? '') ?? Number.MAX_SAFE_INTEGER)
        - (depthById.get(postId(right) ?? '') ?? Number.MAX_SAFE_INTEGER);
      return depth || stablePostCompare(left, right);
    })
    .map((item, conversationOrdinal) => ({ ...item, conversationOrdinal }));
  const comments = enriched.filter((item) => !item.isAuthorThread).sort(stablePostCompare);
  const orderedReplies = [...authorThread, ...comments];
  return { replies: orderedReplies, authorThread, comments, capture };
}

export function mergeXPostDetail(root: XListPost, detail: XListPost): XListPost {
  return {
    ...root,
    ...detail,
    metricEvidence: detail.metricEvidence ?? root.metricEvidence,
    quotedPost: detail.quotedPost ?? root.quotedPost,
    links: detail.links?.length ? detail.links : root.links,
    articles: detail.articles?.length ? detail.articles : root.articles
  };
}

export function articleText(article: XArticleContent): string {
  return article.blocks
    .map((block) => {
      if (block.kind === 'image') return '';
      if (block.kind === 'heading') return `${'#'.repeat(Math.max(2, Math.min(block.level ?? 2, 4)))} ${block.text}`;
      if (block.kind === 'list_item') return `- ${block.text}`;
      if (block.kind === 'quote') return `> ${block.text}`;
      return block.text;
    })
    .filter(Boolean)
    .join('\n\n');
}
