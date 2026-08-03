import { createHash } from 'node:crypto';
import type { Locator, Page, Response } from 'playwright-core';
import { parseXListId, isXListTimelineResponse, type XListBrowserConfig, xListUrl } from './x-list-primitives.ts';
import { XListNeedsUserError, XListSession, XListSupersededError } from './x-list-session.ts';
import { xMetricEvidenceMap, xMetricValues, type XMetricEvidenceMap } from './metric-value.ts';

import type {
  XListActionHooks, XListCreateInput, XListDetail, XListKind, XListMember,
  XListMemberOutcome, XListObservation, XListPost, XListPostAuthor,
  XListPostDetail, XListRef, XListUpdateInput
} from './x-list-browser-types.ts';
import { normalizeMediaUrl, normalizeStatusUrl, readArticlePost } from './x-list-browser-dom.ts';

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeStatusKey(value: string): string {
  const normalized = normalizeStatusUrl(value);
  return normalized ? normalized.replace(/[?#].*$/, '') : '';
}

type CapturedListTimeline = {
  posts: XListPost[];
  bottomCursor: string | null;
  topCursor: string | null;
};

export function captureListLatestTweetsTimeline(page: Page, listId: string): {
  snapshot: () => CapturedListTimeline;
  stop: () => CapturedListTimeline;
} {
  const postsByUrl = new Map<string, XListPost>();
  let bottomCursor: string | null = null;
  let topCursor: string | null = null;
  let stopped = false;

  const onResponse = (response: Response) => {
    if (stopped) return;
    const url = response.url();
    if (!isXListTimelineResponse(url, listId)) return;
    void response.json().then((payload) => {
      if (stopped) return;
      const parsed = extractPostsFromListTimelinePayload(payload);
      for (const post of parsed.posts) {
        const key = normalizeStatusKey(post.url);
        if (!key || postsByUrl.has(key)) continue;
        postsByUrl.set(key, post);
      }
      if (parsed.bottomCursor) bottomCursor = parsed.bottomCursor;
      if (parsed.topCursor) topCursor = parsed.topCursor;
    }).catch(() => {});
  };

  page.on('response', onResponse);
  const snapshot = (): CapturedListTimeline => ({
    posts: [...postsByUrl.values()],
    bottomCursor,
    topCursor
  });
  const stop = (): CapturedListTimeline => {
    stopped = true;
    page.off('response', onResponse);
    return snapshot();
  };
  return { snapshot, stop };
}

export function extractPostsFromListTimelinePayload(payload: unknown): CapturedListTimeline {
  const posts: XListPost[] = [];
  const seen = new Set<string>();
  let bottomCursor: string | null = null;
  let topCursor: string | null = null;

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;

    if (typeof record.cursorType === 'string' && typeof record.value === 'string') {
      if (record.cursorType === 'Bottom') bottomCursor = record.value;
      if (record.cursorType === 'Top') topCursor = record.value;
    }

    const legacy = record.legacy as Record<string, unknown> | undefined;
    const restId = typeof record.rest_id === 'string' ? record.rest_id : null;
    if (restId && legacy && typeof legacy.full_text === 'string') {
      const post = listTimelineTweetToPost(record);
      if (post) {
        const key = normalizeStatusKey(post.url);
        if (key && !seen.has(key)) {
          seen.add(key);
          posts.push(post);
        }
      }
    }

    // Nested RT/QT bodies are rendered inside the parent card — do not also emit them as top-level feed items.
    for (const [key, value] of Object.entries(record)) {
      if (key === 'retweeted_status_result' || key === 'quoted_status_result' || key === 'quoted_status_permalink') continue;
      walk(value);
    }
  };

  walk(payload);
  return { posts, bottomCursor, topCursor };
}

export function unwrapTweetResult(value: unknown): Record<string, unknown> | null {
  let current: unknown = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return null;
    const record = current as Record<string, unknown>;
    if (record.legacy && typeof record.rest_id === 'string') return record;
    if (record.tweet && typeof record.tweet === 'object') {
      current = record.tweet;
      continue;
    }
    if (record.result && typeof record.result === 'object') {
      current = record.result;
      continue;
    }
    return null;
  }
  return null;
}

export function authorFromTweet(tweet: Record<string, unknown>): XListPostAuthor {
  const userResult = ((tweet.core as Record<string, unknown> | undefined)?.user_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
  const userCore = (userResult?.core as Record<string, unknown> | undefined) ?? {};
  const screenName = typeof userCore.screen_name === 'string' ? userCore.screen_name : null;
  const displayName = typeof userCore.name === 'string' ? userCore.name : null;
  const avatarUrl = typeof (userResult?.avatar as Record<string, unknown> | undefined)?.image_url === 'string'
    ? String((userResult?.avatar as Record<string, unknown>).image_url)
    : null;
  return {
    handle: screenName ? `@${screenName}` : null,
    displayName,
    avatarUrl
  };
}

export function listTimelineTweetToPost(tweet: Record<string, unknown>, options: { allowNestedQuote?: boolean } = {}): XListPost | null {
  const allowNestedQuote = options.allowNestedQuote !== false;
  const legacy = tweet.legacy as Record<string, unknown> | undefined;
  const restId = typeof tweet.rest_id === 'string' ? tweet.rest_id : null;
  if (!legacy || !restId) return null;

  const retweeted = unwrapTweetResult(
    (legacy.retweeted_status_result as Record<string, unknown> | undefined)?.result
    ?? (tweet.retweeted_status_result as Record<string, unknown> | undefined)?.result
    ?? legacy.retweeted_status_result
    ?? tweet.retweeted_status_result
  );
  // Pure repost: surface original author/content, keep reposter in social context.
  if (retweeted) {
    const original = listTimelineTweetToPost(retweeted, { allowNestedQuote: true });
    if (!original) return null;
    const reposter = authorFromTweet(tweet);
    return {
      ...original,
      postKind: 'repost',
      repostedBy: reposter,
      // Keep original metrics; X shows original engagement on repost cards.
    };
  }

  const author = authorFromTweet(tweet);
  if (!author.handle) return null;
  const screenName = author.handle.slice(1);
  const text = String(legacy.full_text ?? '').trim();
  const createdAt = typeof legacy.created_at === 'string' ? new Date(legacy.created_at).toISOString() : null;
  const media = extractTimelineMedia(legacy);
  const metricEvidence = xMetricEvidenceMap({
    replies: legacy.reply_count,
    reposts: legacy.retweet_count,
    likes: legacy.favorite_count,
    bookmarks: legacy.bookmark_count,
    views: (tweet.views as Record<string, unknown> | undefined)?.count
  }, 'graphql', {
    replies: 'legacy.reply_count', reposts: 'legacy.retweet_count', likes: 'legacy.favorite_count',
    bookmarks: 'legacy.bookmark_count', views: 'views.count'
  });
  const metrics = xMetricValues(metricEvidence);

  let quotedPost: XListPost | null = null;
  if (allowNestedQuote) {
    const quoted = unwrapTweetResult(
      (legacy.quoted_status_result as Record<string, unknown> | undefined)?.result
      ?? (tweet.quoted_status_result as Record<string, unknown> | undefined)?.result
      ?? legacy.quoted_status_result
      ?? tweet.quoted_status_result
    );
    if (quoted) {
      // Nested quotes stop at one level to keep cards readable and payloads bounded.
      quotedPost = listTimelineTweetToPost(quoted, { allowNestedQuote: false });
      if (quotedPost) {
        quotedPost = {
          ...quotedPost,
          postKind: 'tweet',
          repostedBy: null,
          quotedPost: null
        };
      }
    }
  }

  if (!text && media.images.length === 0 && !media.hasVideo && !quotedPost) return null;

  return {
    url: `https://x.com/${screenName}/status/${restId}`,
    authorHandle: author.handle,
    displayName: author.displayName,
    avatarUrl: author.avatarUrl,
    text: text || (media.hasVideo ? '[视频]' : media.images.length ? '[图片]' : quotedPost ? '' : ''),
    postedAt: createdAt,
    images: media.images,
    imageThumbs: media.imageThumbs,
    hasVideo: media.hasVideo,
    videoPoster: media.videoPoster,
    videoUrl: media.videoUrl,
    postKind: quotedPost ? 'quote' : 'tweet',
    repostedBy: null,
    quotedPost,
    metrics,
    metricEvidence
  };
}

export function extractTimelineMedia(legacy: Record<string, unknown>): {
  images: string[];
  imageThumbs: string[];
  hasVideo: boolean;
  videoPoster: string | null;
  videoUrl: string | null;
} {
  const extended = (legacy.extended_entities as Record<string, unknown> | undefined)?.media;
  const basic = (legacy.entities as Record<string, unknown> | undefined)?.media;
  const mediaItems = Array.isArray(extended) ? extended : Array.isArray(basic) ? basic : [];
  const images: string[] = [];
  let hasVideo = false;
  let videoPoster: string | null = null;
  let videoUrl: string | null = null;

  for (const item of mediaItems) {
    if (!item || typeof item !== 'object') continue;
    const media = item as Record<string, unknown>;
    const type = typeof media.type === 'string' ? media.type : '';
    const mediaUrl = typeof media.media_url_https === 'string' ? media.media_url_https
      : typeof media.media_url === 'string' ? media.media_url
      : null;
    if (type === 'photo' && mediaUrl) images.push(mediaUrl);
    if (type === 'video' || type === 'animated_gif') {
      hasVideo = true;
      if (mediaUrl) videoPoster = mediaUrl;
      const variants = (media.video_info as Record<string, unknown> | undefined)?.variants;
      if (Array.isArray(variants)) {
        const mp4s = variants
          .filter((variant): variant is Record<string, unknown> => !!variant && typeof variant === 'object')
          .filter((variant) => variant.content_type === 'video/mp4' && typeof variant.url === 'string')
          .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0));
        if (typeof mp4s[0]?.url === 'string') videoUrl = String(mp4s[0].url);
      }
    }
  }

  const uniqueImages = [...new Set(images)].slice(0, 4).map((src) => normalizeMediaUrl(src, 'small'));
  const thumbs = uniqueImages.map((src) => normalizeMediaUrl(src, 'thumb'));
  return {
    images: uniqueImages,
    imageThumbs: thumbs,
    hasVideo,
    videoPoster: videoPoster ? normalizeMediaUrl(videoPoster, 'thumb') : null,
    videoUrl
  };
}

export function isXListPage(url: string, listId: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^(?:www\.)?(?:x|twitter)\.com$/i.test(parsed.hostname)) return false;
    return parsed.pathname.includes(`/lists/${listId}`);
  } catch {
    return false;
  }
}

export async function detectMissingListPage(session: XListSession): Promise<string | null> {
  const title = (await session.page.title().catch(() => '')).trim();
  const text = (await session.visibleText()).replace(/\s+/g, ' ').trim();
  if (/未找到页面|page doesn.?t exist|this page doesn.?t exist|hmm\.\.\.this page doesn.?t exist|该页面不存在/i.test(`${title}\n${text}`)) {
    return '这个 List 在 X 上已不存在或无权访问（页面 404）。请换一个有效 List，或重新同步 List 列表。';
  }
  const hasListHeader = await session.page.locator('main h1, main h2, a[href*="/lists/"][href*="/members"]').count().catch(() => 0);
  const articles = await session.page.locator('main article').count().catch(() => 0);
  if (!hasListHeader && articles === 0 && /唔\.\.\.|Hmm/i.test(text)) {
    return '未能打开这个 List 页面。可能已失效，请重新同步 List 列表。';
  }
  return null;
}

export async function readArticlesFromPage(page: Page, options: { preferFullText?: boolean } = {}): Promise<XListPost[]> {
  const rawItems = await page.evaluate(() => {
    const labelFrom = (root: HTMLElement, selectors: string[], patterns: RegExp[]): string | null => {
      for (const selector of selectors) {
        const el = root.querySelector(selector) as HTMLElement | null;
        if (!el) continue;
        const labeled = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        if (labeled && patterns.some((pattern) => pattern.test(labeled))) return labeled;
        const nested = el.querySelector('[data-testid="app-text-transition-container"], span span') as HTMLElement | null;
        const nestedText = (nested?.textContent || el.textContent || '').trim();
        if (nestedText) return nestedText;
      }
      for (const pattern of patterns) {
        const hit = Array.from(root.querySelectorAll('[aria-label], a, button, span, div'))
          .map((item) => (item as HTMLElement).getAttribute('aria-label') || (item as HTMLElement).textContent || '')
          .find((value) => pattern.test(value));
        if (hit) return hit;
      }
      return null;
    };

    return Array.from(document.querySelectorAll('main article')).map((node) => {
      const root = node as HTMLElement;
      const statusHref = Array.from(root.querySelectorAll('a[href*="/status/"]'))
        .map((item) => item.getAttribute('href') || '')
        .find((href) => /^\/[A-Za-z0-9_]+\/status\/\d+(?:\/(?:photo|video)\/\d+)?/.test(href))
        ?.replace(/\/(?:photo|video)\/\d+$/, '');
      if (!statusHref) return null;
      const handleMatch = statusHref.match(/^\/([A-Za-z0-9_]+)\/status\/\d+/);
      const authorHandle = handleMatch ? `@${handleMatch[1]}` : null;
      const tweetTextNodes = Array.from(root.querySelectorAll('[data-testid="tweetText"]')) as HTMLElement[];
      const text = tweetTextNodes
        .map((item) => (item.innerText || '').trim())
        .filter(Boolean)
        .join('\n')
        || (root.querySelector('[lang]') as HTMLElement | null)?.innerText?.trim()
        || '';
      const avatarUrl = (root.querySelector('img[src*="profile_images"]') as HTMLImageElement | null)?.src || null;
      const userText = (root.querySelector('[data-testid="User-Name"]') as HTMLElement | null)?.innerText || '';
      const displayName = userText.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('@') && !/·/.test(line)) || null;
      const images = Array.from(root.querySelectorAll('img'))
        .map((img) => (img as HTMLImageElement).currentSrc || img.src || '')
        .filter((src) => /pbs\.twimg\.com\/media\//i.test(src) || /twimg\.com\/media\//i.test(src));
      const uniqueImages = [...new Set(images)].slice(0, 4);
      const video = root.querySelector('video') as HTMLVideoElement | null;
      const hasVideo = Boolean(
        video
        || root.querySelector('[data-testid="videoPlayer"], [data-testid="previewInterstitial"], [aria-label*="Video" i], [aria-label*="视频"]')
      );
      const sourceNodes = Array.from(root.querySelectorAll('video source')) as HTMLSourceElement[];
      const sourceUrls = sourceNodes.map((item) => item.src || item.getAttribute('src') || '').filter(Boolean);
      const videoUrlCandidates = [
        video?.currentSrc || '',
        video?.src || '',
        ...sourceUrls
      ].filter((item) => item && !item.startsWith('blob:') && !item.startsWith('data:'));
      const videoUrl = videoUrlCandidates.find((item) => /\.mp4(?:$|\?)/i.test(item) || /video\.twimg\.com/i.test(item) || /\.m3u8(?:$|\?)/i.test(item))
        || videoUrlCandidates[0]
        || null;
      const videoPoster = video?.poster
        || (root.querySelector('img[src*="ext_tw_video_thumb"], img[src*="amplify_video_thumb"], img[src*="tweet_video_thumb"]') as HTMLImageElement | null)?.src
        || null;
      const postedAt = root.querySelector('time')?.getAttribute('datetime') || null;
      const metricLabels = {
        replies: labelFrom(root, ['[data-testid="reply"]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Replies|Reply|回复|条回复)/i]),
        reposts: labelFrom(root, ['[data-testid="retweet"]', '[data-testid="unretweet"]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Reposts?|Retweets?|转帖|转推|转发)/i]),
        likes: labelFrom(root, ['[data-testid="like"]', '[data-testid="unlike"]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Likes?|喜欢|赞)/i]),
        bookmarks: labelFrom(root, ['[data-testid="bookmark"]', '[data-testid="removeBookmark"]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Bookmarks?|书签|收藏)/i]),
        views: labelFrom(root, ['a[href$="/analytics"]', 'a[href*="/analytics"]', '[aria-label*="View" i]', '[aria-label*="view" i]', '[aria-label*="查看" i]', '[aria-label*="播放" i]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Views?|views?|次查看|查看|播放)/i])
      };
      return {
        statusHref,
        authorHandle,
        displayName,
        avatarUrl,
        text,
        postedAt,
        images: uniqueImages,
        hasVideo,
        videoPoster,
        videoUrl,
        metricLabels
      };
    }).filter(Boolean);
  }).catch(() => [] as Array<any>);

  const posts: XListPost[] = [];
  for (const raw of rawItems as Array<any>) {
    if (!raw?.statusHref) continue;
    const text = String(raw.text || '').trim();
    if (!text && !(raw.images?.length) && !raw.hasVideo) continue;
    const images = Array.isArray(raw.images) ? raw.images.map((src: string) => normalizeMediaUrl(src, options.preferFullText ? 'small' : 'thumb')) : [];
    const thumbs = Array.isArray(raw.images) ? raw.images.map((src: string) => normalizeMediaUrl(src, 'thumb')) : [];
    const metricEvidence = xMetricEvidenceMap(raw.metricLabels ?? {}, 'dom');
    posts.push({
      url: new URL(raw.statusHref, 'https://x.com').toString(),
      authorHandle: raw.authorHandle ?? null,
      displayName: raw.displayName ?? null,
      avatarUrl: raw.avatarUrl ?? null,
      text: text || (raw.hasVideo ? '[视频]' : images.length ? '[图片]' : ''),
      postedAt: raw.postedAt ?? null,
      images,
      imageThumbs: thumbs,
      hasVideo: Boolean(raw.hasVideo),
      videoPoster: raw.videoPoster ? normalizeMediaUrl(raw.videoPoster, 'thumb') : null,
      videoUrl: typeof raw.videoUrl === 'string' && raw.videoUrl ? raw.videoUrl : null,
      metrics: xMetricValues(metricEvidence),
      metricEvidence
    });
  }
  return posts;
}

