import { createHash } from 'node:crypto';
import type { Locator, Page, Response } from 'playwright-core';
import { parseXListId, type XListBrowserConfig, xListUrl } from './x-list-primitives.ts';
import { XListNeedsUserError, XListSession, XListSupersededError } from './x-list-session.ts';

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

export async function readXListIndex(config: XListBrowserConfig): Promise<{ accountKey: string; lists: XListRef[]; observation: XListObservation }> {
  const session = await XListSession.open(config);
  try {
    // Index refresh is interactive UX. Give it enough budget, but keep navigation on browse path.
    return await session.run(async (active) => {
      // /i/lists is treated by X as the @i profile shell and does not render the current account's lists.
      // The real management timeline lives at /{screen_name}/lists and emits ListsManagementPageTimeline.
      const capture = startListManagementCapture(active.page);
      try {
        const hasAccount = await active.page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').count() > 0;
        if (!hasAccount) await active.navigate('https://x.com/home', { mode: 'browse' });
        const accountKey = await readAccountKey(active);
        const listsUrl = `https://x.com/${accountKey.slice(1)}/lists`;

        // Always land on management page AFTER the network listener is attached.
        // If we are already there, force a reload — browse navigate() short-circuits same-URL.
        if (isListsManagementPage(active.page.url(), accountKey)) {
          await active.page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(async () => {
            await active.navigate(listsUrl, { mode: 'browse' });
          });
          await active.page.waitForTimeout(400);
        } else {
          await active.navigate(listsUrl, { mode: 'browse' });
        }
        await active.page.locator('[data-testid="listCell"]').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

        // Wait for GraphQL after navigation. Previous hard 4.5s timer often expired mid-nav.
        const waitBudgetMs = 14_000;
        const startedAt = Date.now();
        let lists = capture.snapshot();
        let nudge = 0;
        while (!lists.length && Date.now() - startedAt < waitBudgetMs) {
          await active.page.waitForTimeout(350);
          lists = capture.snapshot();
          if (lists.length) break;
          if (nudge < 4) {
            await active.page.mouse.wheel(0, 700 + nudge * 300);
            nudge += 1;
          }
        }

        // Prefer network payload. Cell-by-cell fallback is intentionally avoided on the hot path:
        // listCell DOM currently has no /lists/{id} href, so light DOM parse cannot recover IDs.
        if (!lists.length) lists = await readListCellsLight(active);
        const text = await active.visibleText();
        if (!lists.length) {
          throw new Error('已打开列表管理页，但未读到任何 List。请稍后重试刷新。');
        }
        return { accountKey, lists, observation: observe(active.page.url(), text) };
      } finally {
        capture.stop();
      }
    }, { timeoutMs: 45_000 });
  } finally { await session.close(); }
}

function isListsManagementPage(url: string, accountKey: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^(?:www\.)?(?:x|twitter)\.com$/i.test(parsed.hostname)) return false;
    const handle = accountKey.replace(/^@/, '').toLowerCase();
    return new RegExp(`^/${handle}/lists/?$`, 'i').test(parsed.pathname);
  } catch {
    return false;
  }
}

export async function readXListDetail(config: XListBrowserConfig, listId: string): Promise<{ accountKey: string; detail: XListDetail }> {
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      await active.navigateInitially(xListUrl(listId));
      return { accountKey: await readAccountKey(active), detail: await detailFromCurrentPage(active, listId) };
    });
  } finally { await session.close(); }
}

export async function readXListMembers(config: XListBrowserConfig, listId: string): Promise<{ accountKey: string; detail: XListDetail; members: XListMember[] }> {
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      await active.navigateInitially(xListUrl(listId));
      const detail = await detailFromCurrentPage(active, listId);
      const membersHref = `/i/lists/${listId}/members`;
      await active.page.locator(`a[href="${membersHref}"], a[href$="${membersHref}"]`).first().waitFor({ state: 'visible', timeout: 15_000 });
      const membersLink = await active.findFirstVisible([`a[href="${membersHref}"]`, `a[href$="${membersHref}"]`]);
      await active.click(membersLink);
      await active.page.locator('[data-testid="UserCell"]').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      // Direct URL can land on home shell; keep the clicked members surface when available.
      if (!/\/members(?:$|\?)/.test(active.page.url())) {
        await active.navigateWithinOperation(`${xListUrl(listId)}/members`);
        await active.page.locator('[data-testid="UserCell"]').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      }
      const cells = active.page.locator('[data-testid="UserCell"]');
      const members: XListMember[] = [];
      const seen = new Set<string>();
      const count = await cells.count();
      for (let index = 0; index < count; index += 1) {
        const cell = cells.nth(index);
        const text = (await cell.innerText().catch(() => '')).trim();
        // Members show a Remove action; suggested accounts show Follow and must be ignored.
        if (!/(移除|Remove)/i.test(text)) continue;
        const href = await cell.locator('a[href^="/"]').first().getAttribute('href').catch(() => null);
        const handle = (href ? handleFromPath(href) : null) ?? firstHandle(text);
        if (!handle || seen.has(handle)) continue;
        const displayName = text.split('\n').map((line) => line.trim()).find((line) => line && line !== handle && !/^@/.test(line) && !/(移除|Remove|关注|Follow)/i.test(line)) || handle;
        seen.add(handle);
        members.push({ handle, displayName, profileUrl: `https://x.com/${handle.slice(1)}` });
      }
      return { accountKey: await readAccountKey(active), detail, members };
    });
  } finally { await session.close(); }
}

type ListTimelineMemory = {
  listId: string;
  accountKey: string;
  detail: XListDetail;
  posts: XListPost[];
  bottomCursor: string | null;
  updatedAt: number;
};

const listTimelineMemory = new Map<string, ListTimelineMemory>();

/** Seed/merge in-memory GraphQL pages so load-more survives app restarts + cache-first UI. */
export function seedListTimelineMemory(input: {
  listId: string;
  accountKey: string;
  detail?: { name?: string; canonicalUrl?: string } | null;
  posts: Array<{
    url: string;
    authorHandle?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    text?: string;
    postedAt?: string | null;
    images?: string[];
    imageThumbs?: string[];
    hasVideo?: boolean;
    videoPoster?: string | null;
    videoUrl?: string | null;
    metrics?: {
      replies?: number | null;
      reposts?: number | null;
      likes?: number | null;
      bookmarks?: number | null;
      views?: number | null;
    } | null;
  }>;
  bottomCursor?: string | null;
}): void {
  if (!input.listId || !input.accountKey || !Array.isArray(input.posts) || input.posts.length === 0) return;
  const previous = listTimelineMemory.get(input.listId);
  const merged = new Map<string, XListPost>();
  for (const post of previous?.posts ?? []) {
    const key = normalizeStatusKey(post.url);
    if (key) merged.set(key, post);
  }
  for (const raw of input.posts) {
    const key = normalizeStatusKey(raw.url);
    if (!key) continue;
    const existing = merged.get(key);
    merged.set(key, {
      url: key,
      authorHandle: raw.authorHandle ?? existing?.authorHandle ?? null,
      displayName: raw.displayName ?? existing?.displayName ?? null,
      avatarUrl: raw.avatarUrl ?? existing?.avatarUrl ?? null,
      text: String(raw.text ?? existing?.text ?? ''),
      postedAt: raw.postedAt ?? existing?.postedAt ?? null,
      images: Array.isArray(raw.images) ? raw.images : existing?.images ?? [],
      imageThumbs: Array.isArray(raw.imageThumbs) ? raw.imageThumbs : existing?.imageThumbs ?? [],
      hasVideo: Boolean(raw.hasVideo ?? existing?.hasVideo ?? false),
      videoPoster: raw.videoPoster ?? existing?.videoPoster ?? null,
      videoUrl: raw.videoUrl ?? existing?.videoUrl ?? null,
      postKind: (raw as any).postKind ?? existing?.postKind ?? 'tweet',
      repostedBy: (raw as any).repostedBy ?? existing?.repostedBy ?? null,
      quotedPost: (raw as any).quotedPost ?? existing?.quotedPost ?? null,
      metrics: {
        replies: raw.metrics?.replies ?? existing?.metrics?.replies ?? null,
        reposts: raw.metrics?.reposts ?? existing?.metrics?.reposts ?? null,
        likes: raw.metrics?.likes ?? existing?.metrics?.likes ?? null,
        bookmarks: raw.metrics?.bookmarks ?? existing?.metrics?.bookmarks ?? null,
        views: raw.metrics?.views ?? existing?.metrics?.views ?? null
      }
    });
  }
  const detail: XListDetail = previous?.detail ?? {
    listId: input.listId,
    canonicalUrl: input.detail?.canonicalUrl || xListUrl(input.listId),
    name: input.detail?.name || `List ${input.listId}`,
    ownerHandle: null,
    kind: 'unknown',
    description: '',
    isPrivate: false,
    memberCount: null,
    observation: {
      capturedAt: new Date().toISOString(),
      pageUrl: input.detail?.canonicalUrl || xListUrl(input.listId),
      fingerprint: '',
      visibleText: ''
    }
  };
  if (input.detail?.name) detail.name = input.detail.name;
  if (input.detail?.canonicalUrl) detail.canonicalUrl = input.detail.canonicalUrl;
  listTimelineMemory.set(input.listId, {
    listId: input.listId,
    accountKey: input.accountKey,
    detail,
    posts: [...merged.values()],
    bottomCursor: input.bottomCursor ?? previous?.bottomCursor ?? null,
    updatedAt: Date.now()
  });
}

export async function readXListTimeline(
  config: XListBrowserConfig,
  listId: string,
  limit = 50,
  options: { knownUrls?: string[] } = {}
): Promise<{ accountKey: string; detail: XListDetail; posts: XListPost[]; hasMore: boolean }> {
  const known = new Set((options.knownUrls ?? []).map((item) => normalizeStatusKey(item)).filter(Boolean));
  const continuing = known.size > 0;
  const target = Math.max(1, Math.min(limit, 20));

  // Fast path: serve additional pages from memory without touching the browser.
  if (continuing) {
    const cached = listTimelineMemory.get(listId);
    if (cached && Date.now() - cached.updatedAt < 10 * 60_000) {
      const posts: XListPost[] = [];
      for (const post of cached.posts) {
        const key = normalizeStatusKey(post.url);
        if (!key || known.has(key)) continue;
        posts.push(post);
        if (posts.length >= target) break;
      }
      if (posts.length > 0) {
        const remaining = cached.posts.some((post) => {
          const key = normalizeStatusKey(post.url);
          return key && !known.has(key) && !posts.some((item) => normalizeStatusKey(item.url) === key);
        });
        return {
          accountKey: cached.accountKey,
          detail: cached.detail,
          posts,
          hasMore: remaining || Boolean(cached.bottomCursor)
        };
      }
    }
  }

  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      const listHref = xListUrl(listId);
      const timelineCapture = captureListLatestTweetsTimeline(active.page, listId);

      // Always land on the list page. Do not assume prior page state.
      if (!isXListPage(active.page.url(), listId) || !continuing) {
        await active.navigate(listHref, { mode: 'browse' });
      }

      const missing = await detectMissingListPage(active);
      if (missing) {
        timelineCapture.stop();
        throw new Error(missing);
      }

      // Wait briefly for first paint / first GraphQL page.
      await active.page.locator('main article').first().waitFor({ state: 'attached', timeout: 4_000 }).catch(() => {});
      for (let nudge = 0; nudge < 3 && timelineCapture.snapshot().posts.length < Math.max(target, 30); nudge += 1) {
        await active.page.mouse.wheel(0, 1_600 + nudge * 500);
        await active.page.waitForTimeout(280);
      }

      // Continuation with empty memory: a couple more scrolls to ensure payload is rich.
      if (continuing && timelineCapture.snapshot().posts.length <= known.size) {
        for (let i = 0; i < 5; i += 1) {
          const unknown = timelineCapture.snapshot().posts.filter((post) => !known.has(normalizeStatusKey(post.url))).length;
          if (unknown >= target) break;
          await active.page.mouse.wheel(0, 2_400 + i * 200);
          await active.page.waitForTimeout(220);
        }
      }

      const captured = timelineCapture.stop();
      // Skip expensive detail parsing on load-more; keep previous detail if present.
      const previous = listTimelineMemory.get(listId);
      const detail = previous?.detail ?? await detailFromCurrentPage(active, listId).catch(() => ({
        listId,
        canonicalUrl: listHref,
        name: `List ${listId}`,
        ownerHandle: null,
        kind: 'unknown' as const,
        description: '',
        isPrivate: false,
        memberCount: null,
        observation: { capturedAt: new Date().toISOString(), pageUrl: active.page.url(), fingerprint: '', visibleText: '' }
      }));

      let sourcePosts = captured.posts;
      if (!sourcePosts.length) {
        sourcePosts = await readArticlesFromPage(active.page, { preferFullText: false }).catch(() => []);
      }

      const mergedMap = new Map<string, XListPost>();
      for (const post of previous?.posts ?? []) {
        const key = normalizeStatusKey(post.url);
        if (key) mergedMap.set(key, post);
      }
      for (const post of sourcePosts) {
        const key = normalizeStatusKey(post.url);
        if (key) mergedMap.set(key, post);
      }
      const accountKey = previous?.accountKey || await readAccountKey(active);
      const mergedPosts = [...mergedMap.values()];
      listTimelineMemory.set(listId, {
        listId,
        accountKey,
        detail,
        posts: mergedPosts,
        bottomCursor: captured.bottomCursor ?? previous?.bottomCursor ?? null,
        updatedAt: Date.now()
      });

      const posts: XListPost[] = [];
      const seen = new Set<string>();
      for (const post of mergedPosts) {
        const key = normalizeStatusKey(post.url);
        if (!key || known.has(key) || seen.has(key)) continue;
        seen.add(key);
        posts.push(post);
        if (posts.length >= target) break;
      }

      const remaining = mergedPosts.some((post) => {
        const key = normalizeStatusKey(post.url);
        return key && !known.has(key) && !posts.some((item) => normalizeStatusKey(item.url) === key);
      });

      return {
        accountKey,
        detail,
        posts,
        hasMore: remaining || Boolean(captured.bottomCursor ?? previous?.bottomCursor) || posts.length >= Math.min(12, target)
      };
    }, { timeoutMs: continuing ? 12_000 : 12_000 });
  } catch (error) {
    if (error instanceof XListSupersededError) throw error;
    throw error;
  } finally {
    await session.close();
  }
}
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatusKey(value: string): string {
  const normalized = normalizeStatusUrl(value);
  return normalized ? normalized.replace(/[?#].*$/, '') : '';
}

type CapturedListTimeline = {
  posts: XListPost[];
  bottomCursor: string | null;
  topCursor: string | null;
};

function captureListLatestTweetsTimeline(page: Page, listId: string): {
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
    if (!url.includes('ListLatestTweetsTimeline')) return;
    if (!url.includes(listId) && !url.includes(encodeURIComponent(listId))) {
      // Still accept if body contains this list; URL usually includes listId.
    }
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

function extractPostsFromListTimelinePayload(payload: unknown): CapturedListTimeline {
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

function unwrapTweetResult(value: unknown): Record<string, unknown> | null {
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

function authorFromTweet(tweet: Record<string, unknown>): XListPostAuthor {
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

function listTimelineTweetToPost(tweet: Record<string, unknown>, options: { allowNestedQuote?: boolean } = {}): XListPost | null {
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
  const metrics = {
    replies: numberOrNull(legacy.reply_count),
    reposts: numberOrNull(legacy.retweet_count),
    likes: numberOrNull(legacy.favorite_count),
    bookmarks: numberOrNull(legacy.bookmark_count),
    views: numberOrNull((tweet.views as Record<string, unknown> | undefined)?.count)
  };

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
    metrics
  };
}

function extractTimelineMedia(legacy: Record<string, unknown>): {
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

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function isXListPage(url: string, listId: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^(?:www\.)?(?:x|twitter)\.com$/i.test(parsed.hostname)) return false;
    return parsed.pathname.includes(`/lists/${listId}`);
  } catch {
    return false;
  }
}

async function detectMissingListPage(session: XListSession): Promise<string | null> {
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

async function readArticlesFromPage(page: Page, options: { preferFullText?: boolean } = {}): Promise<XListPost[]> {
  const rawItems = await page.evaluate(() => {
    const parseCount = (value: string | null | undefined): number | null => {
      if (!value) return null;
      const normalized = value
        .replace(/,/g, '')
        .replace(/\s+/g, '')
        .replace(/条|次|人|views?|likes?|reposts?|replies?|bookmarks?|quotes?|回复|转帖|转推|喜欢|赞|书签|查看|播放/ig, '')
        .trim();
      const match = normalized.match(/(\d+(?:\.\d+)?)([KkMmBb万亿])?/);
      if (!match) return null;
      const base = Number(match[1]);
      if (!Number.isFinite(base)) return null;
      const unit = match[2] || '';
      if (unit === '万') return Math.round(base * 10_000);
      if (unit === '亿') return Math.round(base * 100_000_000);
      if (/^k$/i.test(unit)) return Math.round(base * 1_000);
      if (/^m$/i.test(unit)) return Math.round(base * 1_000_000);
      if (/^b$/i.test(unit)) return Math.round(base * 1_000_000_000);
      return Math.round(base);
    };
    const countFrom = (root: HTMLElement, selectors: string[], patterns: RegExp[]): number | null => {
      for (const selector of selectors) {
        const el = root.querySelector(selector) as HTMLElement | null;
        if (!el) continue;
        const labeled = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        const direct = parseCount(labeled);
        if (direct != null) return direct;
        for (const pattern of patterns) {
          const matched = labeled.match(pattern);
          if (matched) {
            const parsed = parseCount(matched[1] || matched[0]);
            if (parsed != null) return parsed;
          }
        }
        const nested = el.querySelector('[data-testid="app-text-transition-container"], span span') as HTMLElement | null;
        const nestedText = (nested?.textContent || el.textContent || '').trim();
        const nestedCount = parseCount(nestedText);
        if (nestedCount != null) return nestedCount;
      }
      for (const pattern of patterns) {
        const hit = Array.from(root.querySelectorAll('[aria-label], a, button, span, div'))
          .map((item) => (item as HTMLElement).getAttribute('aria-label') || (item as HTMLElement).textContent || '')
          .find((value) => pattern.test(value));
        if (!hit) continue;
        const matched = hit.match(pattern);
        const parsed = parseCount(matched?.[1] || hit);
        if (parsed != null) return parsed;
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
      const metrics = {
        replies: countFrom(root, ['[data-testid="reply"]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Replies|Reply|回复|条回复)/i]),
        reposts: countFrom(root, ['[data-testid="retweet"]', '[data-testid="unretweet"]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Reposts?|Retweets?|转帖|转推|转发)/i]),
        likes: countFrom(root, ['[data-testid="like"]', '[data-testid="unlike"]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Likes?|喜欢|赞)/i]),
        bookmarks: countFrom(root, ['[data-testid="bookmark"]', '[data-testid="removeBookmark"]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Bookmarks?|书签|收藏)/i]),
        views: countFrom(root, ['a[href$="/analytics"]', 'a[href*="/analytics"]', '[aria-label*="View" i]', '[aria-label*="view" i]', '[aria-label*="查看" i]', '[aria-label*="播放" i]'], [/([\d.,.\sKkMmBb万亿]+)\s*(?:Views?|views?|次查看|查看|播放)/i])
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
        metrics
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
      metrics: {
        replies: raw.metrics?.replies ?? null,
        reposts: raw.metrics?.reposts ?? null,
        likes: raw.metrics?.likes ?? null,
        bookmarks: raw.metrics?.bookmarks ?? null,
        views: raw.metrics?.views ?? null
      }
    });
  }
  return posts;
}

export async function readXListPostDetail(config: XListBrowserConfig, statusUrl: string, replyLimit = 30): Promise<{ accountKey: string; post: XListPostDetail }> {
  const normalized = normalizeStatusUrl(statusUrl);
  if (!normalized) throw new Error('无效的帖子链接。');
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      const capturedVideoUrls = new Set<string>();
      const onResponse = (response: Response) => {
        const url = response.url();
        if (isLikelyVideoMediaUrl(url)) capturedVideoUrls.add(url);
      };
      active.page.on('response', onResponse);
      try {
        await active.navigate(normalized, { mode: 'fast' });
        await active.page.locator('main article').first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
        await expandMainTweet(active.page);
        await nudgeMainVideo(active.page);
        const target = Math.max(1, Math.min(replyLimit, 40));
        const posts: XListPost[] = [];
        const seen = new Set<string>();
        let stagnant = 0;
        for (let round = 0; round < 6 && stagnant < 2; round += 1) {
          if (round === 0) {
            await expandMainTweet(active.page);
            await nudgeMainVideo(active.page);
          }
          const articles = active.page.locator('main article');
          const count = await articles.count();
          const before = posts.length;
          for (let index = 0; index < count; index += 1) {
            const post = await readArticlePost(articles.nth(index), { preferFullText: index === 0 && round === 0 });
            if (!post || seen.has(post.url)) continue;
            seen.add(post.url);
            posts.push(post);
          }
          if (posts.length >= target + 1) break;
          if (posts.length === before) stagnant += 1;
          else stagnant = 0;
          await active.page.mouse.wheel(0, 900 + round * 80);
          await active.page.waitForTimeout(220 + round * 40);
        }
        const main = posts.find((item) => item.url.replace(/[?#].*$/, '') === normalized.replace(/[?#].*$/, '')) ?? posts[0];
        if (!main) throw new Error('未能读取帖子详情。');
        const replies = posts.filter((item) => item.url !== main.url).slice(0, target);
        const networkVideoUrl = pickPlayableVideoUrl([...capturedVideoUrls]);
        return {
          accountKey: await readAccountKey(active),
          post: {
            ...main,
            hasVideo: main.hasVideo || Boolean(networkVideoUrl || main.videoUrl),
            videoUrl: pickPlayableVideoUrl([main.videoUrl, networkVideoUrl].filter(Boolean) as string[]),
            images: main.images.map((src) => normalizeMediaUrl(src, 'medium')),
            imageThumbs: main.imageThumbs.map((src) => normalizeMediaUrl(src, 'thumb')),
            replies: replies.map((item) => ({
              ...item,
              images: item.images.map((src) => normalizeMediaUrl(src, 'thumb')),
              imageThumbs: item.imageThumbs.map((src) => normalizeMediaUrl(src, 'thumb'))
            })),
            hasMoreReplies: replies.length >= target
          }
        };
      } finally {
        active.page.off('response', onResponse);
      }
    });
  } finally { await session.close(); }
}
export async function createXList(config: XListBrowserConfig, input: XListCreateInput, hooks: XListActionHooks = {}): Promise<{ accountKey: string; detail: XListDetail }> {
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      const accountKey = await (async () => {
        await active.navigateInitially('https://x.com/home');
        return readAccountKey(active);
      })();
      await active.navigateWithinOperation(`https://x.com/${accountKey.slice(1)}/lists`);
      await active.click(await active.findFirstVisible(createListSelectors));
      await active.typeInto(await active.findFirstVisible(listNameSelectors), input.name);
      if (input.description !== undefined) await active.typeInto(await active.findFirstVisible(listDescriptionSelectors), input.description);
      if (input.isPrivate) await active.click(await active.findFirstVisible(privateListSelectors));
      await assertNotStopped(hooks);
      await hooks.beforeAction?.('create_list');
      await active.click(await active.findFirstVisible(confirmCreateSelectors));
      const listId = parseXListId(active.page.url());
      if (!listId) throw new XListUnknownError('创建 List 后未能从当前页面读回稳定 List ID。');
      return { accountKey, detail: await detailFromCurrentPage(active, listId) };
    });
  } finally { await session.close(); }
}

export async function updateXList(config: XListBrowserConfig, input: XListUpdateInput, hooks: XListActionHooks = {}): Promise<{ accountKey: string; detail: XListDetail }> {
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      await active.navigateInitially(xListUrl(input.listId));
      const accountKey = await readAccountKey(active);
      await openListEditor(active);
      if (input.name !== undefined) await active.typeInto(await active.findFirstVisible(listNameSelectors), input.name);
      if (input.description !== undefined) await active.typeInto(await active.findFirstVisible(listDescriptionSelectors), input.description);
      if (input.isPrivate !== undefined) await setPrivacy(active, input.isPrivate);
      await assertNotStopped(hooks);
      await hooks.beforeAction?.('update_list');
      await active.click(await active.findFirstVisible(confirmSaveSelectors));
      return { accountKey, detail: await detailFromCurrentPage(active, input.listId) };
    });
  } finally { await session.close(); }
}

export async function deleteXList(config: XListBrowserConfig, listId: string, hooks: XListActionHooks = {}): Promise<{ accountKey: string; deletedListId: string; evidenceUrl: string }> {
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      await active.navigateInitially(xListUrl(listId));
      const accountKey = await readAccountKey(active);
      await openListEditor(active);
      await active.click(await active.findFirstVisible(deleteListSelectors));
      await assertNotStopped(hooks);
      await hooks.beforeAction?.('delete_list');
      await active.click(await active.findFirstVisible(confirmDeleteSelectors));
      if (parseXListId(active.page.url()) === listId) throw new XListUnknownError('删除确认后当前页面仍指向原 List，无法确认删除结果。');
      return { accountKey, deletedListId: listId, evidenceUrl: active.page.url() };
    });
  } finally { await session.close(); }
}

export async function ensureXListMember(config: XListBrowserConfig, input: { listId: string; handle: string; desiredState: 'present' | 'absent' }, hooks: XListActionHooks = {}): Promise<{ accountKey: string; outcome: XListMemberOutcome; evidenceUrl: string }> {
  const normalizedHandle = normalizeHandle(input.handle);
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      await active.navigateInitially(xListUrl(input.listId));
      const accountKey = await readAccountKey(active);
      await openManagedMembers(active, input.listId);
      const present = await hasMember(active, normalizedHandle);
      if (input.desiredState === 'present' && present) return { accountKey, outcome: 'already_present', evidenceUrl: active.page.url() };
      if (input.desiredState === 'absent' && !present) return { accountKey, outcome: 'already_absent', evidenceUrl: active.page.url() };
      if (input.desiredState === 'present') {
        await addMember(active, normalizedHandle, hooks);
        await openManagedMembers(active, input.listId, 'members');
        if (!await hasMember(active, normalizedHandle)) throw new XListUnknownError(`添加 ${normalizedHandle} 后未能在成员页读回。`);
        return { accountKey, outcome: 'added', evidenceUrl: active.page.url() };
      }
      await removeMember(active, normalizedHandle, hooks);
      if (await hasMember(active, normalizedHandle)) throw new XListUnknownError(`移除 ${normalizedHandle} 后仍显示在成员页。`);
      return { accountKey, outcome: 'removed', evidenceUrl: active.page.url() };
    });
  } finally { await session.close(); }
}

async function openListEditor(session: XListSession): Promise<void> {
  const edit = await firstVisible(session.page.locator('a[href$="/info"], a:has-text("编辑列表"), a:has-text("Edit List")'));
  if (edit) {
    await session.click(edit);
    return;
  }
  await session.click(await session.findFirstVisible(listMoreSelectors));
  await session.click(await session.findFirstVisible(editListSelectors));
}

async function setPrivacy(session: XListSession, isPrivate: boolean): Promise<void> {
  const control = await session.findFirstVisible(privateListSelectors);
  const current = await control.getAttribute('aria-checked') ?? await control.getAttribute('data-state');
  const enabled = current === 'true' || current === 'checked';
  if (enabled !== isPrivate) await session.click(control);
}

async function openManagedMembers(session: XListSession, listId: string, tab: 'members' | 'suggested' = 'members'): Promise<void> {
  // X hides bulk member controls behind Edit List → Manage members.
  if (!listId) throw new Error('List ID 缺失，无法打开成员管理。');
  if (!session.page.url().includes(`/i/lists/${listId}/info`) && !session.page.url().includes(`/i/lists/${listId}/members`)) {
    const edit = await firstVisible(session.page.locator(`a[href="/i/lists/${listId}/info"], a[href$="/i/lists/${listId}/info"], a:has-text("编辑列表"), a:has-text("Edit List")`));
    if (edit) await session.click(edit);
    else await session.navigateWithinOperation(`${xListUrl(listId)}/info`);
  }
  if (!session.page.url().includes(`/i/lists/${listId}/members`)) {
    const manage = await firstVisible(session.page.locator(`a:has-text("管理成员"), a:has-text("Manage members"), a[href="/i/lists/${listId}/members"], [data-testid="pivot"]`));
    if (manage) await session.click(manage);
    else await session.navigateWithinOperation(`${xListUrl(listId)}/members`);
  }
  if (tab === 'suggested') {
    const suggested = await firstVisible(session.page.locator(`a:has-text("已推荐"), a:has-text("Suggested"), a[href$="/members/suggested"]`));
    if (suggested) await session.click(suggested);
    else await session.navigateWithinOperation(`${xListUrl(listId)}/members/suggested`);
  } else if (session.page.url().includes('/members/suggested')) {
    const membersTab = await firstVisible(session.page.locator(`a[href="/i/lists/${listId}/members"], a:has-text("成员"), a:has-text("Members")`));
    if (membersTab) await session.click(membersTab);
  }
  await session.page.locator('[data-testid="UserCell"], [role="dialog"] input, button:has-text("添加"), button:has-text("移除")').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
}

async function addMember(session: XListSession, handle: string, hooks: XListActionHooks): Promise<void> {
  const listId = parseXListId(session.page.url());
  if (!listId) throw new Error('当前页面不是有效的 X List。');
  await openManagedMembers(session, listId, 'suggested');
  const search = await session.findFirstVisible([
    '[role="dialog"] input[data-testid="SearchBox_Search_Input"]',
    '[role="dialog"] input[placeholder*="搜索"]',
    '[role="dialog"] input[placeholder*="Search"]',
    'input[data-testid="SearchBox_Search_Input"]',
    'input[placeholder*="搜索用户"]',
    'input[placeholder*="Search people"]'
  ]);
  await session.typeInto(search, handle.slice(1));
  const profile = await session.findFirstVisible([
    `[role="dialog"] a[href="/${handle.slice(1)}"]`,
    `a[href="/${handle.slice(1)}"]`
  ]);
  const row = profile.locator('xpath=ancestor::*[@data-testid="UserCell" or @role="button"][1]');
  const action = await firstVisible(row.locator('button:has-text("添加"), button:has-text("Add"), button[aria-label*="添加"], button[aria-label*="Add"]'));
  if (!action) throw new XListNeedsUserError(`X 未显示 ${handle} 的安全添加控件。`);
  await assertNotStopped(hooks);
  await hooks.beforeAction?.('add_member');
  await session.click(action);
}

async function removeMember(session: XListSession, handle: string, hooks: XListActionHooks): Promise<void> {
  const listId = parseXListId(session.page.url());
  if (!listId) throw new Error('当前页面不是有效的 X List。');
  await openManagedMembers(session, listId, 'members');
  const profile = await session.findFirstVisible([
    `[data-testid="UserCell"] a[href="/${handle.slice(1)}"]`,
    `main a[href="/${handle.slice(1)}"]`
  ]);
  const row = profile.locator('xpath=ancestor::*[@data-testid="UserCell" or @role="button"][1]');
  const action = await firstVisible(row.locator('button:has-text("移除"), button:has-text("Remove"), button[aria-label*="移除"], button[aria-label*="Remove"]'));
  if (!action) throw new XListNeedsUserError(`X 未显示 ${handle} 的安全移除控件。`);
  await assertNotStopped(hooks);
  await hooks.beforeAction?.('remove_member');
  await session.click(action);
  const confirm = await firstVisible(session.page.locator('[role="dialog"] button:has-text("Remove"), [role="dialog"] button:has-text("移除")'));
  if (confirm) await session.click(confirm);
}

async function hasMember(session: XListSession, handle: string): Promise<boolean> {
  const cells = session.page.locator('[data-testid="UserCell"]');
  const count = await cells.count();
  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index);
    const text = (await cell.innerText().catch(() => '')).trim();
    if (!/(移除|Remove)/i.test(text)) continue;
    if (await cell.locator(`a[href="/${handle.slice(1)}"]`).count() > 0) return true;
    if (firstHandle(text)?.toLowerCase() === handle.toLowerCase()) return true;
  }
  return false;
}

async function assertNotStopped(hooks: XListActionHooks): Promise<void> {
  if (await hooks.shouldStop?.()) throw new XListStopRequestedError('用户请求在当前页面动作完成后停止。');
}

async function readAccountKey(session: XListSession): Promise<string> {
  const account = session.page.locator('[data-testid="SideNav_AccountSwitcher_Button"]');
  const text = await account.innerText({ timeout: 5_000 }).catch(() => '');
  const avatarTestId = await account.locator('[data-testid^="UserAvatar-Container-"]').getAttribute('data-testid').catch(() => null);
  const handle = firstHandle(text) ?? (avatarTestId ? `@${avatarTestId.replace('UserAvatar-Container-', '')}` : null);
  if (!handle) throw new Error('无法从专用 X 浏览器读取当前账号。');
  return handle;
}

function startListManagementCapture(page: Page): {
  snapshot: () => XListRef[];
  stop: () => XListRef[];
} {
  const listsById = new Map<string, XListRef>();
  let stopped = false;
  const onResponse = (response: Response) => {
    if (stopped) return;
    if (!response.url().includes('ListsManagementPageTimeline')) return;
    void response.json().then((payload) => {
      if (stopped) return;
      for (const list of extractListsFromManagementPayload(payload)) {
        listsById.set(list.listId, list);
      }
    }).catch(() => { /* ignore partial payloads */ });
  };
  page.on('response', onResponse);
  const snapshot = () => [...listsById.values()];
  return {
    snapshot,
    stop: () => {
      if (stopped) return snapshot();
      stopped = true;
      page.off('response', onResponse);
      return snapshot();
    }
  };
}

function extractListsFromManagementPayload(payload: unknown): XListRef[] {
  const output: XListRef[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    const record = node as Record<string, unknown>;
    const listId = typeof record.id_str === 'string' ? record.id_str
      : typeof record.rest_id === 'string' && /^\d+$/.test(record.rest_id) ? record.rest_id
      : typeof record.id === 'string' && /^\d+$/.test(record.id) ? record.id
      : null;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (listId && name && ('member_count' in record || 'mode' in record || 'user_results' in record) && !seen.has(listId)) {
      const owner = ownerHandleFromUserResults(record.user_results);
      // Lists on the management page are the current account's owned/subscribed lists.
      // Prefer owned when mode is present (public/private ownership metadata).
      const kind: XListKind = typeof record.mode === 'string' ? 'owned'
        : record.following === true ? 'following'
        : record.is_member === true ? 'member'
        : 'unknown';
      output.push({ listId, canonicalUrl: xListUrl(listId), name, ownerHandle: owner, kind });
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(payload);
  return output;
}

async function readListCellsLight(session: XListSession): Promise<XListRef[]> {
  // Best-effort DOM fallback without opening each cell (too slow for interactive refresh).
  const cells = session.page.locator('[data-testid="listCell"]');
  const output: XListRef[] = [];
  const seen = new Set<string>();
  const count = await cells.count();
  for (let index = 0; index < Math.min(count, 40); index += 1) {
    const cell = cells.nth(index);
    const text = (await cell.innerText().catch(() => '')).trim();
    if (!text) continue;
    const name = text.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('@') && !line.startsWith('·') && !/位成员|members|followers|关注者/i.test(line));
    if (!name) continue;
    // Some list shells expose an internal id on nested anchors/buttons.
    const href = await cell.locator('a[href*="/lists/"]').first().getAttribute('href').catch(() => null);
    const listId = href ? parseXListId(href.startsWith('http') ? href : `https://x.com${href}`) : null;
    if (!listId || seen.has(listId)) continue;
    seen.add(listId);
    output.push({
      listId,
      canonicalUrl: xListUrl(listId),
      name,
      ownerHandle: firstHandle(text),
      kind: inferKind(text)
    });
  }
  return output;
}

async function readListCells(session: XListSession): Promise<XListRef[]> {
  // Heavy fallback only for offline tooling / rare recovery paths.
  const cells = session.page.locator('[data-testid="listCell"]');
  const output: XListRef[] = [];
  const count = await cells.count();
  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index);
    const text = (await cell.innerText().catch(() => '')).trim();
    if (!text) continue;
    const name = text.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('@') && !line.startsWith('·') && !/位成员|members|followers|关注者/i.test(line));
    if (!name) continue;
    await session.click(cell);
    const listId = parseXListId(session.page.url());
    if (listId) {
      output.push({ listId, canonicalUrl: xListUrl(listId), name, ownerHandle: firstHandle(text), kind: inferKind(text) });
    }
    await session.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await session.page.locator('[data-testid="listCell"]').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  }
  return output;
}

const createListSelectors = ['a[href="/i/lists/create"]', 'a[href$="/i/lists/create"]', 'button:has-text("New")', 'button:has-text("新建")', 'button[aria-label*="Create"]', 'button[aria-label*="创建"]'];
const listNameSelectors = ['input[name="name"]', 'input[aria-label*="List name"]', 'input[aria-label*="列表名称"]', 'input[placeholder*="List name"]', 'input[placeholder*="列表名称"]'];
const listDescriptionSelectors = ['textarea[name="description"]', 'textarea[aria-label*="Description"]', 'textarea[aria-label*="描述"]', 'textarea'];
const privateListSelectors = ['label:has-text("Make private")', 'label:has-text("设为私密")', '[role="switch"][aria-label*="private"]', '[role="switch"][aria-label*="私密"]'];
const confirmCreateSelectors = ['button:has-text("Create")', 'button:has-text("创建")'];
const listMoreSelectors = ['button[aria-label="More"]', 'button[aria-label="更多"]', 'button[data-testid="caret"]'];
const editListSelectors = ['[role="menuitem"]:has-text("Edit List")', '[role="menuitem"]:has-text("编辑列表")', 'a:has-text("Edit List")', 'a:has-text("编辑列表")', 'a[href$="/info"]'];
const confirmSaveSelectors = ['button:has-text("Save")', 'button:has-text("保存")'];
const deleteListSelectors = ['button:has-text("Delete List")', 'button:has-text("删除列表")', '[role="menuitem"]:has-text("Delete")', '[role="menuitem"]:has-text("删除")'];
const confirmDeleteSelectors = ['[role="dialog"] button:has-text("Delete")', '[role="dialog"] button:has-text("删除")'];
const addMemberSelectors = ['button:has-text("Add members")', 'button:has-text("Add member")', 'button:has-text("添加成员")'];
const memberSearchSelectors = ['[role="dialog"] input[data-testid="SearchBox_Search_Input"]', '[role="dialog"] input[placeholder*="Search"]', '[role="dialog"] input[placeholder*="搜索"]'];
const removeMemberSelectors = ['[role="menuitem"]:has-text("Remove")', '[role="menuitem"]:has-text("移除")', 'button:has-text("Remove")', 'button:has-text("移除")'];

async function detailFromCurrentPage(session: XListSession, listId: string): Promise<XListDetail> {
  const text = await session.visibleText();
  const title = await session.page.title().catch(() => '');
  const titleName = title.match(/^(?:@[^/\s]+\/)?(.+?)\s*\/\s*X\s*$/i)?.[1]?.trim() || null;
  const headingName = await firstText(session.page.locator('main h2, main h1').filter({ hasNotText: /^(列表|Lists|主页|Home)$/i }));
  const nameCandidate = titleName && !/^(主页|Home|列表|Lists)$/i.test(titleName) ? titleName : headingName;
  const chipCount = await firstText(session.page.locator(`a[href$="/i/lists/${listId}/members"], a[href="/i/lists/${listId}/members"]`));
  const memberCount = parseCount(chipCount ?? '', /([\d,.]+)/) ?? parseCount(text, /([\d,.]+)\s*(?:位)?\s*(?:members?|成员)/i);
  const ownerFromLink = await session.page.locator('main a[href^="/"]').evaluateAll((nodes) => {
    for (const node of nodes) {
      const href = node.getAttribute('href') ?? '';
      const match = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (match) return `@${match[1]}`;
    }
    return null;
  }).catch(() => null);
  return {
    listId,
    canonicalUrl: xListUrl(listId),
    name: nameCandidate || `List ${listId}`,
    ownerHandle: ownerFromLink || firstHandle(text),
    // List detail pages opened from the operator's management page are owned; avoid "成员" text flipping kind.
    kind: 'owned',
    description: '',
    isPrivate: /(private|私密)/i.test(text),
    memberCount,
    observation: observe(session.page.url(), text)
  };
}


async function expandMainTweet(page: Page): Promise<void> {
  const main = page.locator('main article').first();
  if (!(await main.count())) return;
  const candidates = [
    main.locator('[data-testid="tweet-text-show-more-link"]').first(),
    main.getByRole('button', { name: /show more|显示更多|展开/i }).first(),
    main.locator('div[role="button"]', { hasText: /show more|显示更多|展开/i }).first()
  ];
  for (const locator of candidates) {
    if (!(await locator.count().catch(() => 0))) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click({ timeout: 1_500 }).catch(() => {});
    await page.waitForTimeout(180);
    break;
  }
}

async function nudgeMainVideo(page: Page): Promise<void> {
  const main = page.locator('main article').first();
  if (!(await main.count())) return;
  const player = main.locator('[data-testid="videoPlayer"], [data-testid="previewInterstitial"], video').first();
  if (!(await player.count().catch(() => 0))) return;
  await player.scrollIntoViewIfNeeded().catch(() => {});
  await player.click({ timeout: 1_200 }).catch(() => {});
  await page.waitForTimeout(700);
  await player.hover().catch(() => {});
  await page.waitForTimeout(350);
}

function isLikelyVideoMediaUrl(value: string): boolean {
  if (!value || value.startsWith('blob:') || value.startsWith('data:')) return false;
  if (/\.m3u8(?:$|\?)/i.test(value)) return true;
  if (/\.mp4(?:$|\?)/i.test(value)) return true;
  if (/video\.twimg\.com/i.test(value)) return true;
  if (/amplify_video|ext_tw_video|tweet_video/i.test(value) && !/\.(?:jpg|jpeg|png|webp)(?:$|\?)/i.test(value)) return true;
  return false;
}

function scoreVideoUrl(value: string): number {
  let score = 0;
  if (/\.mp4(?:$|\?)/i.test(value)) score += 1_000;
  if (/video\.twimg\.com/i.test(value)) score += 200;
  if (/\.m3u8(?:$|\?)/i.test(value)) score += 50;
  const dim = value.match(/(\d{3,4})x(\d{3,4})/);
  if (dim) score += Number(dim[1]) * Number(dim[2]) / 1_000;
  if (/\/avc1\//i.test(value)) score += 120;
  if (/\/hevc\//i.test(value)) score += 80;
  if (/[?&]tag=/i.test(value)) score += 10;
  return score;
}

function pickPlayableVideoUrl(candidates: Array<string | null | undefined>): string | null {
  const urls = [...new Set(candidates.filter((item): item is string => typeof item === 'string' && isLikelyVideoMediaUrl(item)))];
  if (!urls.length) return null;
  urls.sort((left, right) => scoreVideoUrl(right) - scoreVideoUrl(left));
  const mp4 = urls.find((item) => /\.mp4(?:$|\?)/i.test(item));
  return mp4 ?? urls[0] ?? null;
}

async function readArticlePost(article: Locator, options: { preferFullText?: boolean } = {}): Promise<XListPost | null> {
  const raw = await article.evaluate((node) => {
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

    const parseCount = (value: string | null | undefined): number | null => {
      if (!value) return null;
      const normalized = value
        .replace(/,/g, '')
        .replace(/\s+/g, '')
        .replace(/条|次|人|views?|likes?|reposts?|replies?|bookmarks?|quotes?|回复|转帖|转推|喜欢|赞|书签|查看|播放/ig, '')
        .trim();
      const match = normalized.match(/(\d+(?:\.\d+)?)([KkMmBb万亿])?/);
      if (!match) return null;
      const base = Number(match[1]);
      if (!Number.isFinite(base)) return null;
      const unit = match[2] || '';
      if (unit === '万') return Math.round(base * 10_000);
      if (unit === '亿') return Math.round(base * 100_000_000);
      if (/^k$/i.test(unit)) return Math.round(base * 1_000);
      if (/^m$/i.test(unit)) return Math.round(base * 1_000_000);
      if (/^b$/i.test(unit)) return Math.round(base * 1_000_000_000);
      return Math.round(base);
    };

    const countFrom = (selectors: string[], patterns: RegExp[]): number | null => {
      for (const selector of selectors) {
        const el = root.querySelector(selector) as HTMLElement | null;
        if (!el) continue;
        const labeled = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        const direct = parseCount(labeled);
        if (direct != null) return direct;
        for (const pattern of patterns) {
          const matched = labeled.match(pattern);
          if (matched) {
            const parsed = parseCount(matched[1] || matched[0]);
            if (parsed != null) return parsed;
          }
        }
        const nested = el.querySelector('[data-testid="app-text-transition-container"], span span') as HTMLElement | null;
        const nestedText = (nested?.textContent || el.textContent || '').trim();
        const nestedCount = parseCount(nestedText);
        if (nestedCount != null) return nestedCount;
      }
      for (const pattern of patterns) {
        const hit = Array.from(root.querySelectorAll('[aria-label], a, button, span, div'))
          .map((item) => (item as HTMLElement).getAttribute('aria-label') || (item as HTMLElement).textContent || '')
          .find((value) => pattern.test(value));
        if (!hit) continue;
        const matched = hit.match(pattern);
        const parsed = parseCount(matched?.[1] || hit);
        if (parsed != null) return parsed;
      }
      return null;
    };

    const metrics = {
      replies: countFrom(
        ['[data-testid="reply"]'],
        [/([\d.,.\sKkMmBb万亿]+)\s*(?:Replies|Reply|回复|条回复)/i]
      ),
      reposts: countFrom(
        ['[data-testid="retweet"]', '[data-testid="unretweet"]'],
        [/([\d.,.\sKkMmBb万亿]+)\s*(?:Reposts?|Retweets?|转帖|转推|转发)/i]
      ),
      likes: countFrom(
        ['[data-testid="like"]', '[data-testid="unlike"]'],
        [/([\d.,.\sKkMmBb万亿]+)\s*(?:Likes?|喜欢|赞)/i]
      ),
      bookmarks: countFrom(
        ['[data-testid="bookmark"]', '[data-testid="removeBookmark"]'],
        [/([\d.,.\sKkMmBb万亿]+)\s*(?:Bookmarks?|书签|收藏)/i]
      ),
      views: countFrom(
        [
          'a[href$="/analytics"]',
          'a[href*="/analytics"]',
          '[aria-label*="View" i]',
          '[aria-label*="view" i]',
          '[aria-label*="查看" i]',
          '[aria-label*="播放" i]'
        ],
        [/([\d.,.\sKkMmBb万亿]+)\s*(?:Views?|views?|次查看|查看|播放)/i]
      )
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
      metrics
    };
  }).catch(() => null);
  if (!raw?.statusHref) return null;
  const text = (raw.text || '').trim();
  if (!text && raw.images.length === 0 && !raw.hasVideo) return null;
  const thumbs = raw.images.map((src) => normalizeMediaUrl(src, 'thumb'));
  const fullImages = options.preferFullText
    ? raw.images.map((src) => normalizeMediaUrl(src, 'small'))
    : thumbs;
  return {
    url: new URL(raw.statusHref, 'https://x.com').toString(),
    authorHandle: raw.authorHandle,
    displayName: raw.displayName,
    avatarUrl: raw.avatarUrl,
    text: text || (raw.hasVideo ? '[视频]' : raw.images.length ? '[图片]' : ''),
    postedAt: raw.postedAt,
    images: fullImages,
    imageThumbs: thumbs,
    hasVideo: raw.hasVideo,
    videoPoster: raw.videoPoster ? normalizeMediaUrl(raw.videoPoster, 'thumb') : null,
    videoUrl: typeof raw.videoUrl === 'string' && raw.videoUrl ? raw.videoUrl : null,
    metrics: {
      replies: raw.metrics?.replies ?? null,
      reposts: raw.metrics?.reposts ?? null,
      likes: raw.metrics?.likes ?? null,
      bookmarks: raw.metrics?.bookmarks ?? null,
      views: raw.metrics?.views ?? null
    }
  };
}

function normalizeStatusUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^(?:www\.)?(?:x|twitter)\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    if (!match) return null;
    return `https://x.com/${match[1]}/status/${match[2]}`;
  } catch {
    return null;
  }
}

function normalizeMediaUrl(value: string, size: 'thumb' | 'small' | 'medium' | 'large' = 'thumb'): string {
  try {
    const url = new URL(value);
    if (!/twimg\.com$/i.test(url.hostname) && !/\.twimg\.com$/i.test(url.hostname)) return value;
    url.searchParams.set('name', size);
    if (!url.searchParams.get('format')) url.searchParams.set('format', 'jpg');
    return url.toString();
  } catch {
    return value.replace(/([?&])name=\w+/i, `$1name=${size}`);
  }
}
async function firstStatusLink(article: Locator): Promise<string | null> {
  const links = article.locator('a[href*="/status/"]');
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const href = await links.nth(index).getAttribute('href');
    if (href?.match(/^\/[A-Za-z0-9_]+\/status\/\d+/)) return href;
  }
  return null;
}

async function firstText(locator: Locator): Promise<string | null> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const value = (await locator.nth(index).innerText().catch(() => '')).trim();
    if (value) return value;
  }
  return null;
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false) && await candidate.boundingBox()) return candidate;
  }
  return null;
}

function observe(pageUrl: string, visibleText: string): XListObservation {
  return {
    capturedAt: new Date().toISOString(),
    pageUrl,
    fingerprint: createHash('sha256').update(visibleText).digest('hex'),
    visibleText: visibleText.slice(0, 8_000)
  };
}

function ownerHandleFromUserResults(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('result' in value)) return null;
  const result = value.result;
  if (!result || typeof result !== 'object' || !('core' in result)) return null;
  const core = result.core;
  if (!core || typeof core !== 'object' || !('screen_name' in core)) return null;
  const screen = core.screen_name;
  return typeof screen === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(screen) ? `@${screen}` : null;
}

function firstHandle(value: string): string | null {
  const match = value.match(/@[A-Za-z0-9_]{1,15}\b/);
  return match?.[0] ?? null;
}

function normalizeHandle(value: string): string {
  const candidate = value.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(candidate)) throw new Error('X 成员必须使用精确 handle。');
  return `@${candidate}`;
}

function handleFromPath(value: string): string | null {
  const match = value.match(/^\/([A-Za-z0-9_]{1,15})$/);
  return match ? `@${match[1]}` : null;
}

function inferKind(value: string): XListKind {
  if (/(created|创建|你的列表)/i.test(value)) return 'owned';
  if (/(following|关注)/i.test(value)) return 'following';
  if (/(member of|成员)/i.test(value)) return 'member';
  return 'unknown';
}

function parseCount(value: string, pattern: RegExp): number | null {
  const match = value.match(pattern);
  if (!match) return null;
  const parsed = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}
