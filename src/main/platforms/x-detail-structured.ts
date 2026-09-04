import type { XArticleBlock, XArticleContent, XListPost } from './x-list-browser-types.ts';
import { listTimelineTweetToPost } from './x-list-browser-timeline.ts';
import { canonicalXArticleUrl } from '../x-post-enrichment.ts';

function recordsIn(value: unknown, limit = 20_000): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length && records.length < limit) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    const record = current as Record<string, unknown>;
    records.push(record);
    for (const item of Object.values(record)) pending.push(item);
  }
  return records;
}

export function extractTweetDetailPosts(payload: unknown): XListPost[] {
  const posts: XListPost[] = [];
  const seen = new Set<string>();
  for (const record of recordsIn(payload)) {
    if (typeof record.rest_id !== 'string' || !record.legacy || typeof record.legacy !== 'object') continue;
    const post = listTimelineTweetToPost(record);
    if (!post) continue;
    const key = post.statusId ?? post.url;
    if (seen.has(key)) continue;
    seen.add(key);
    posts.push(post);
  }
  return posts;
}

export function extractTweetDetailArticles(payload: unknown, capturedAt = new Date().toISOString()): Array<{ statusId: string; article: XArticleContent }> {
  const articles: Array<{ statusId: string; article: XArticleContent }> = [];
  const seen = new Set<string>();
  for (const record of recordsIn(payload)) {
    const statusId = typeof record.rest_id === 'string' ? record.rest_id : null;
    if (!statusId || !record.article || typeof record.article !== 'object') continue;
    const candidate = recordsIn(record.article, 200).find((item) => {
      const articleId = firstString(item, ['rest_id', 'article_id', 'articleId']);
      return Boolean(articleId && /^\d+$/.test(articleId) && articleBlocks(item).length);
    });
    if (!candidate) continue;
    const articleId = firstString(candidate, ['rest_id', 'article_id', 'articleId']);
    if (!articleId) continue;
    const article = extractStructuredXArticle(candidate, `https://x.com/i/article/${articleId}`, capturedAt);
    if (!article || seen.has(`${statusId}:${article.id}`)) continue;
    const post = listTimelineTweetToPost(record);
    seen.add(`${statusId}:${article.id}`);
    articles.push({
      statusId,
      article: {
        ...article,
        authorHandle: article.authorHandle ?? post?.authorHandle ?? null,
        displayName: article.displayName ?? post?.displayName ?? null
      }
    });
  }
  return articles;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function mediaUrlIn(value: unknown): string | null {
  for (const record of recordsIn(value, 500)) {
    const direct = firstString(record, ['original_img_url', 'media_url_https', 'media_url', 'image_url', 'url']);
    if (direct && /^https?:\/\//i.test(direct) && /(?:twimg\.com|pbs\.twimg|\/media\/|image)/i.test(direct)) return direct;
  }
  return null;
}

function articleBlocks(candidate: Record<string, unknown>): XArticleBlock[] {
  const contentState = (candidate.content_state ?? candidate.contentState ?? candidate.content) as Record<string, unknown> | undefined;
  const rawBlocks = Array.isArray(contentState?.blocks)
    ? contentState.blocks
    : Array.isArray(candidate.blocks) ? candidate.blocks : [];
  const entityMap = (contentState?.entityMap ?? contentState?.entity_map ?? candidate.entityMap ?? candidate.entity_map) as Record<string, unknown> | undefined;
  const blocks: XArticleBlock[] = [];
  const seenImages = new Set<string>();

  for (const raw of rawBlocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    const type = String(block.type ?? block.kind ?? '').toLowerCase();
    const text = firstString(block, ['text', 'value', 'content']);
    if (text) {
      if (/header|heading|title/.test(type)) {
        const levelMatch = type.match(/(?:header|heading)[-_ ]?(\d)/);
        blocks.push({ kind: 'heading', text, level: levelMatch ? Number(levelMatch[1]) : 2 });
      } else if (/unordered|ordered|list/.test(type)) blocks.push({ kind: 'list_item', text });
      else if (/quote|blockquote/.test(type)) blocks.push({ kind: 'quote', text });
      else blocks.push({ kind: 'paragraph', text });
    }

    const directImage = mediaUrlIn(block.data ?? block.media ?? block);
    if (directImage && !seenImages.has(directImage)) {
      seenImages.add(directImage);
      blocks.push({ kind: 'image', url: directImage, alt: firstString(block, ['alt', 'alt_text', 'caption']) });
    }
    const ranges = Array.isArray(block.entityRanges ?? block.entity_ranges) ? (block.entityRanges ?? block.entity_ranges) as unknown[] : [];
    for (const range of ranges) {
      if (!range || typeof range !== 'object' || !entityMap) continue;
      const key = String((range as Record<string, unknown>).key ?? '');
      const image = mediaUrlIn(entityMap[key]);
      if (!image || seenImages.has(image)) continue;
      seenImages.add(image);
      blocks.push({ kind: 'image', url: image, alt: null });
    }
  }
  return blocks;
}

function articleAuthor(candidate: Record<string, unknown>): { handle: string | null; displayName: string | null } {
  for (const record of recordsIn(candidate, 1_000)) {
    const screenName = firstString(record, ['screen_name', 'screenName', 'handle', 'username']);
    const displayName = firstString(record, ['name', 'display_name', 'displayName']);
    if (screenName) return { handle: screenName.startsWith('@') ? screenName : `@${screenName}`, displayName };
  }
  return { handle: null, displayName: null };
}

function articlePublishedAt(candidate: Record<string, unknown>): string | null {
  const direct = firstString(candidate, ['published_at', 'publishedAt', 'created_at', 'createdAt']);
  if (direct && Number.isFinite(Date.parse(direct))) return new Date(direct).toISOString();
  for (const record of recordsIn(candidate, 1_000)) {
    const seconds = Number(record.first_published_at_secs ?? record.firstPublishedAtSecs);
    if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1_000).toISOString();
  }
  return null;
}

export function extractStructuredXArticle(payload: unknown, expectedUrl: string, capturedAt = new Date().toISOString()): XArticleContent | null {
  const expected = canonicalXArticleUrl(expectedUrl);
  if (!expected) return null;
  let best: { score: number; record: Record<string, unknown>; blocks: XArticleBlock[] } | null = null;
  for (const record of recordsIn(payload)) {
    const id = firstString(record, ['rest_id', 'article_id', 'articleId', 'id']);
    const title = firstString(record, ['title', 'headline', 'name']);
    const blocks = articleBlocks(record);
    if (!blocks.length || (!title && id !== expected.id)) continue;
    const score = (id === expected.id ? 100 : 0) + (title ? 20 : 0) + Math.min(blocks.length, 50);
    if (!best || score > best.score) best = { score, record, blocks };
  }
  if (!best) return null;
  const author = articleAuthor(best.record);
  const title = firstString(best.record, ['title', 'headline', 'name']);
  const publishedAt = articlePublishedAt(best.record);
  const textBlocks = best.blocks.filter((block) => block.kind !== 'image');
  return {
    id: expected.id,
    canonicalUrl: expected.url,
    title,
    authorHandle: author.handle,
    displayName: author.displayName,
    publishedAt,
    blocks: best.blocks,
    status: title && textBlocks.length ? 'ready' : 'partial',
    source: 'graphql',
    capturedAt,
    errorMessage: null
  };
}
