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
import { captureListLatestTweetsTimeline, detectMissingListPage, extractPostsFromListTimelinePayload, normalizeStatusKey, readArticlesFromPage, sleepMs } from './x-list-browser-timeline.ts';
import { isXListPage } from './x-list-browser-timeline.ts';
import { detailFromCurrentPage, firstHandle, handleFromPath, observe, readAccountKey, readListCells, readListCellsLight, startListManagementCapture } from './x-list-browser-dom.ts';
import { openManagedMembers } from './x-list-browser-actions.ts';

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

export function isListsManagementPage(url: string, accountKey: string): boolean {
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
      await active.navigateInitially(xListUrl(listId), { mode: 'browse' });
      const detail = await detailFromCurrentPage(active, listId);
      await openManagedMembers(active, listId, 'members');
      const cells = active.page.locator('[data-testid="UserCell"]');
      await cells.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
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
    }, { timeoutMs: 180_000 });
  } finally { await session.close(); }
}

type ListTimelineMemory = {
  workspaceId: string; browserId: string;
  listId: string;
  accountKey: string;
  detail: XListDetail;
  posts: XListPost[];
  bottomCursor: string | null;
  updatedAt: number;
};

const listTimelineMemory = new Map<string, ListTimelineMemory>();

export function timelineMemoryKey(workspaceId: string, browserId: string, accountKey: string, listId: string): string {
  return `${workspaceId}\u0000${browserId}\u0000${accountKey.toLowerCase()}\u0000${listId}`;
}

export function seedListTimelineMemory(input: {
  workspaceId: string; browserId: string;
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
  if (!input.workspaceId || !input.listId || !input.accountKey || !Array.isArray(input.posts) || input.posts.length === 0) return;
  const key = timelineMemoryKey(input.workspaceId, input.browserId, input.accountKey, input.listId);
  const previous = listTimelineMemory.get(key);
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
  listTimelineMemory.set(key, {
    workspaceId: input.workspaceId, browserId: input.browserId,
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
  const memoryKey = config.workspaceId && config.accountKey ? timelineMemoryKey(config.workspaceId, config.id, config.accountKey, listId) : null;
  if (continuing && memoryKey) {
    const cached = listTimelineMemory.get(memoryKey);
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

      if (!isXListPage(active.page.url(), listId) || !continuing) {
        await active.navigate(listHref, { mode: 'browse' });
      }

      const missing = await detectMissingListPage(active);
      if (missing) {
        timelineCapture.stop();
        throw new Error(missing);
      }

      await active.page.locator('main article').first().waitFor({ state: 'attached', timeout: 4_000 }).catch(() => {});
      for (let nudge = 0; nudge < 3 && timelineCapture.snapshot().posts.length < Math.max(target, 30); nudge += 1) {
        await active.page.mouse.wheel(0, 1_600 + nudge * 500);
        await active.page.waitForTimeout(280);
      }

      if (continuing && timelineCapture.snapshot().posts.length <= known.size) {
        for (let i = 0; i < 5; i += 1) {
          const unknown = timelineCapture.snapshot().posts.filter((post) => !known.has(normalizeStatusKey(post.url))).length;
          if (unknown >= target) break;
          await active.page.mouse.wheel(0, 2_400 + i * 200);
          await active.page.waitForTimeout(220);
        }
      }

      const captured = timelineCapture.stop();
      const previous = memoryKey ? listTimelineMemory.get(memoryKey) : undefined;
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
      const accountKey = await readAccountKey(active);
      if (config.accountKey && config.accountKey.toLowerCase() !== accountKey.toLowerCase()) {
        throw Object.assign(new XListNeedsUserError('当前浏览器账号已变化，请重新读取并确认本根 List。'), { code: 'ACCOUNT_MISMATCH' });
      }
      const mergedPosts = [...mergedMap.values()];
      if (memoryKey) listTimelineMemory.set(memoryKey, {
        workspaceId: config.workspaceId!, browserId: config.id, listId, accountKey, detail, posts: mergedPosts,
        bottomCursor: captured.bottomCursor ?? previous?.bottomCursor ?? null, updatedAt: Date.now()
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
