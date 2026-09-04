import { createHash } from 'node:crypto';
import type { Locator, Page, Response } from 'playwright-core';
import { parseXListId, isXListTimelineResponse, type XListBrowserConfig, xListUrl } from './x-list-primitives.ts';
import { XListNeedsUserError, XListPlatformRejectedError, XListSession, XListSupersededError } from './x-list-session.ts';
import { xMetricEvidenceMap, xMetricValues, type XMetricEvidenceMap } from './metric-value.ts';

import type {
  XListActionHooks, XListCreateInput, XListDetail, XListKind, XListMember,
  XListMemberOutcome, XListObservation, XListPost, XListPostAuthor,
  XArticleContent, XListPostDetail, XListRef, XListUpdateInput
} from './x-list-browser-types.ts';
import {
  confirmCreateSelectors, confirmDeleteSelectors, confirmSaveSelectors, createListSelectors,
  deleteListSelectors, detailFromCurrentPage, editListSelectors, expandMainTweet, firstHandle,
  firstVisible, isLikelyVideoMediaUrl, listDescriptionSelectors, listMoreSelectors,
  listNameSelectors, normalizeHandle, normalizeMediaUrl, normalizeStatusUrl, nudgeMainVideo,
  pickPlayableVideoUrl, privateListSelectors, readAccountKey, readArticlePost
} from './x-list-browser-dom.ts';
import { readXListDetail, readXListMembers } from './x-list-browser-read.ts';
import { sleepMs } from './x-list-browser-timeline.ts';
import { XListStopRequestedError, XListUnknownError } from './x-list-browser-types.ts';
import { classifyXPostReplies, findXArticleUrls, limitXPostReplies, mergeXPostDetail } from '../x-post-enrichment.ts';
import { extractStructuredXArticle, extractTweetDetailArticles, extractTweetDetailPosts } from './x-detail-structured.ts';

export async function readXListPostDetail(config: XListBrowserConfig, statusUrl: string, replyLimit = 30): Promise<{ accountKey: string; post: XListPostDetail }> {
  const normalized = normalizeStatusUrl(statusUrl);
  if (!normalized) throw new Error('无效的帖子链接。');
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      const capturedVideoUrls = new Set<string>();
      const payloadPromises: Promise<unknown>[] = [];
      const onResponse = (response: Response) => {
        const url = response.url();
        if (isLikelyVideoMediaUrl(url)) capturedVideoUrls.add(url);
        const contentType = response.headers()['content-type'] ?? '';
        if (payloadPromises.length < 120 && /(?:json|graphql)/i.test(contentType) && /(?:x|twitter)\.com/i.test(url)) {
          payloadPromises.push(response.json().catch(() => null));
        }
      };
      active.page.on('response', onResponse);
      try {
        if (normalizeStatusUrl(active.page.url()) === normalized) {
          await active.page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
        } else {
          await active.navigate(normalized, { mode: 'fast' });
        }
        await active.page.evaluate(() => window.scrollTo(0, 0));
        await active.page.locator('main article').first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
        const accountKey = await readAccountKey(active);
        await expandMainTweet(active.page);
        await nudgeMainVideo(active.page);
        const target = Math.max(0, Math.min(replyLimit, 40));
        const domPosts: XListPost[] = [];
        const seenDom = new Set<string>();
        let stagnant = 0;
        for (let round = 0; round < 6 && stagnant < 2; round += 1) {
          const articles = active.page.locator('main article');
          const count = await articles.count();
          const before = domPosts.length;
          for (let index = 0; index < count; index += 1) {
            const post = await readArticlePost(articles.nth(index), { preferFullText: index === 0 && round === 0 });
            const key = post?.statusId ?? post?.url;
            if (!post || !key || seenDom.has(key)) continue;
            seenDom.add(key);
            domPosts.push({ ...post, captureOrdinal: domPosts.length });
          }
          if (domPosts.length >= target + 1) break;
          if (domPosts.length === before) stagnant += 1;
          else stagnant = 0;
          await active.page.mouse.wheel(0, 900 + round * 80);
          await active.page.waitForTimeout(220 + round * 40);
        }
        const payloads = await settleCapturedPayloads(payloadPromises);
        const structuredArticles = payloads.flatMap((payload) => extractTweetDetailArticles(payload));
        const structuredPosts = payloads.flatMap(extractTweetDetailPosts);
        const posts = mergeCapturedPosts(structuredPosts, domPosts);
        const targetStatusId = normalized.match(/\/status\/(\d+)/)?.[1] ?? null;
        const main = posts.find((item) => targetStatusId && item.statusId === targetStatusId)
          ?? posts.find((item) => item.url.replace(/[?#].*$/, '') === normalized.replace(/[?#].*$/, ''))
          ?? domPosts.find((item) => targetStatusId && item.statusId === targetStatusId)
          ?? domPosts.find((item) => item.url.replace(/[?#].*$/, '') === normalized.replace(/[?#].*$/, ''));
        if (!main) throw new Error('未能读取目标帖子详情。');
        const mainId = main.statusId ?? normalized.match(/\/status\/(\d+)/)?.[1] ?? null;
        const related = posts.filter((item) => {
          if ((item.statusId ?? item.url) === (main.statusId ?? main.url)) return false;
          if (item.parentStatusId) return true;
          return Boolean(main.conversationId && item.conversationId === main.conversationId && item.statusId !== mainId);
        });
        related.sort((left, right) => {
          const leftTime = left.postedAt ? Date.parse(left.postedAt) : Number.NaN;
          const rightTime = right.postedAt ? Date.parse(right.postedAt) : Number.NaN;
          if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
          return (left.captureOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.captureOrdinal ?? Number.MAX_SAFE_INTEGER);
        });
        const limited = limitXPostReplies(related, target, main.metrics.replies);
        const limitedReplies = limited.replies;
        const hasMoreReplies = limited.hasMoreReplies;
        const replySource = structuredPosts.length ? (domPosts.length ? 'mixed' : 'graphql') : 'dom';
        const captureStatus = structuredPosts.length ? (hasMoreReplies ? 'partial' : 'ready') : 'partial';
        const classified = classifyXPostReplies(main, limitedReplies, {
          status: captureStatus,
          replyLimit: target,
          hasMoreReplies,
          fetchedAt: new Date().toISOString(),
          source: replySource,
          errorMessage: structuredPosts.length ? null : '页面未提供可验证的回复归属关系，未把无归属 DOM 卡片当作评论。'
        });

        const mainArticleLinks = articleLinkCandidates(main);
        const quotedArticleLinks = main.quotedPost ? articleLinkCandidates(main.quotedPost) : [];
        const mainStructuredArticles = structuredArticles.filter((item) => item.statusId === main.statusId).map((item) => item.article);
        const quotedStructuredArticles = main.quotedPost?.statusId
          ? structuredArticles.filter((item) => item.statusId === main.quotedPost?.statusId).map((item) => item.article)
          : [];
        const articleCache = new Map<string, XArticleContent | null>();
        const loadArticles = async (links: string[]): Promise<XArticleContent[]> => {
          const articles: XArticleContent[] = [];
          for (const link of links) {
            if (!articleCache.has(link)) articleCache.set(link, await readXArticleContent(active.page, link, payloadPromises));
            const article = articleCache.get(link);
            if (article && !articles.some((item) => item.canonicalUrl === article.canonicalUrl)) articles.push(article);
          }
          return articles;
        };
        const mainArticles = mergeArticleContent(mainStructuredArticles, await loadArticles(mainArticleLinks));
        const quotedArticles = mergeArticleContent(quotedStructuredArticles, await loadArticles(quotedArticleLinks));
        const networkVideoUrl = main.hasVideo ? pickPlayableVideoUrl([...capturedVideoUrls]) : null;
        const enrichedMain = mergeXPostDetail(main, {
          ...main,
          hasVideo: main.hasVideo || Boolean(networkVideoUrl || main.videoUrl),
          videoUrl: pickPlayableVideoUrl([main.videoUrl, networkVideoUrl].filter(Boolean) as string[]),
          images: main.images.map((src) => normalizeMediaUrl(src, 'medium')),
          imageThumbs: main.imageThumbs.map((src) => normalizeMediaUrl(src, 'thumb')),
          articles: mainArticles,
          quotedPost: main.quotedPost ? { ...main.quotedPost, articles: quotedArticles } : null
        });
        return {
          accountKey,
          post: {
            ...enrichedMain,
            replies: classified.replies,
            authorThread: classified.authorThread,
            comments: classified.comments,
            hasMoreReplies,
            replyCapture: classified.capture
          }
        };
      } finally {
        active.page.off('response', onResponse);
      }
    }, { timeoutMs: 90_000 });
  } finally { await session.close(); }
}

function mergeCapturedPosts(structured: XListPost[], dom: XListPost[]): XListPost[] {
  const merged = new Map<string, XListPost>();
  for (const post of [...structured, ...dom]) {
    const key = post.statusId ?? post.url.replace(/[?#].*$/, '');
    const existing = merged.get(key);
    merged.set(key, existing ? mergeXPostDetail(existing, post) : post);
  }
  return [...merged.values()];
}

function mergeArticleContent(...groups: readonly XArticleContent[][]): XArticleContent[] {
  const merged = new Map<string, XArticleContent>();
  const quality = (article: XArticleContent): number => {
    const status = article.status === 'ready' ? 1000 : article.status === 'partial' ? 500 : 0;
    return status + article.blocks.length * 2 + (article.title ? 1 : 0) + (article.source === 'graphql' ? 1 : 0);
  };
  for (const article of groups.flat()) {
    const existing = merged.get(article.canonicalUrl);
    if (!existing || quality(article) > quality(existing)) merged.set(article.canonicalUrl, article);
  }
  return [...merged.values()];
}

async function settleCapturedPayloads(promises: readonly Promise<unknown>[], timeoutMs = 3_000): Promise<unknown[]> {
  if (!promises.length) return [];
  const settled = new Array<unknown>(promises.length);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(promises.map(async (promise, index) => {
        const value = await promise;
        if (value != null) settled[index] = value;
      })),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
  return settled.filter((value) => value != null);
}

function articleLinkCandidates(post: XListPost): string[] {
  const direct = findXArticleUrls(post.text, post.links);
  const redirectCandidates = (post.links ?? [])
    .flatMap((link) => [link.expandedUrl, link.url])
    .filter((value): value is string => typeof value === 'string' && /^https?:\/\/t\.co\//i.test(value));
  return [...new Set([...direct, ...redirectCandidates])].slice(0, 4);
}

async function readXArticleContent(page: Page, candidateUrl: string, payloadPromises: Promise<unknown>[]): Promise<XArticleContent | null> {
  const startedAt = payloadPromises.length;
  const capturedAt = new Date().toISOString();
  let canonical = findXArticleUrls(candidateUrl)[0] ?? null;
  try {
    if (!canonical && /^https?:\/\/t\.co\//i.test(candidateUrl)) {
      const response = await page.request.get(candidateUrl, { maxRedirects: 5, timeout: 5_000 });
      try {
        canonical = findXArticleUrls(response.url())[0] ?? null;
      } finally {
        await response.dispose();
      }
    }
    if (!canonical) return null;
    await page.goto(canonical, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.locator('main').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(350);
    canonical = findXArticleUrls(page.url())[0] ?? canonical;
    const payloads = await settleCapturedPayloads(payloadPromises.slice(startedAt));
    for (const payload of payloads) {
      const structured = extractStructuredXArticle(payload, canonical, capturedAt);
      if (structured) return structured;
    }
    return await readXArticleFromDom(page, canonical, capturedAt);
  } catch (error) {
    if (!canonical) return null;
    const id = canonical.match(/\/i\/article\/(\d+)/)?.[1] ?? '';
    return {
      id,
      canonicalUrl: canonical,
      title: null,
      authorHandle: null,
      displayName: null,
      publishedAt: null,
      blocks: [],
      status: /log.?in|sign.?in|登录/i.test(error instanceof Error ? error.message : String(error)) ? 'needs_user' : 'unavailable',
      source: 'dom',
      capturedAt,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readXArticleFromDom(page: Page, canonicalUrl: string, capturedAt: string): Promise<XArticleContent> {
  const raw = await page.locator('main').first().evaluate((main) => {
    const candidates = [
      main.querySelector('[data-testid="twitterArticleRichTextView"]'),
      ...Array.from(main.querySelectorAll('article')),
      main
    ].filter((value): value is Element => Boolean(value));
    const root = candidates.sort((left, right) => (right.textContent?.length ?? 0) - (left.textContent?.length ?? 0))[0] as HTMLElement;
    const title = (root.querySelector('h1') as HTMLElement | null)?.innerText?.trim() || null;
    const userName = (root.querySelector('[data-testid="User-Name"]') as HTMLElement | null)?.innerText || '';
    const authorHandle = userName.split(/\s+/).find((part) => /^@[A-Za-z0-9_]+$/.test(part)) || null;
    const displayName = userName.split('\n').map((part) => part.trim()).find((part) => part && !part.startsWith('@')) || null;
    const publishedAt = root.querySelector('time')?.getAttribute('datetime') || null;
    const blocks: Array<{ kind: string; text?: string; level?: number; url?: string; alt?: string | null }> = [];
    for (const node of Array.from(root.querySelectorAll('h2, h3, h4, p, li, blockquote, img'))) {
      if (node.closest('nav, aside, footer, button, [data-testid="reply"]')) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === 'img') {
        const image = node as HTMLImageElement;
        const url = image.currentSrc || image.src || '';
        if (/^https?:\/\//i.test(url) && !/profile_images|emoji|hashflags/i.test(url)) {
          blocks.push({ kind: 'image', url, alt: image.alt?.trim() || null });
        }
        continue;
      }
      const text = (node as HTMLElement).innerText?.trim() || '';
      if (!text || text === title) continue;
      if (/^h[2-4]$/.test(tag)) blocks.push({ kind: 'heading', text, level: Number(tag.slice(1)) });
      else if (tag === 'li') blocks.push({ kind: 'list_item', text });
      else if (tag === 'blockquote') blocks.push({ kind: 'quote', text });
      else blocks.push({ kind: 'paragraph', text });
    }
    const pageText = (main as HTMLElement).innerText || '';
    return { title, authorHandle, displayName, publishedAt, blocks, pageText };
  }).catch(() => ({ title: null, authorHandle: null, displayName: null, publishedAt: null, blocks: [], pageText: '' }));
  const id = canonicalUrl.match(/\/i\/article\/(\d+)/)?.[1] ?? '';
  const textBlocks = raw.blocks.filter((block) => block.kind !== 'image');
  const needsUser = /(?:log in|sign in|登录后|请登录)/i.test(raw.pageText) && !textBlocks.length;
  return {
    id,
    canonicalUrl,
    title: raw.title,
    authorHandle: raw.authorHandle,
    displayName: raw.displayName,
    publishedAt: raw.publishedAt && Number.isFinite(Date.parse(raw.publishedAt)) ? new Date(raw.publishedAt).toISOString() : null,
    blocks: raw.blocks as XArticleContent['blocks'],
    status: needsUser ? 'needs_user' : raw.title && textBlocks.length ? 'ready' : textBlocks.length ? 'partial' : 'unavailable',
    source: 'dom',
    capturedAt,
    errorMessage: needsUser ? 'X Article 需要登录后读取。' : textBlocks.length ? null : '页面没有可识别的 Article 正文结构。'
  };
}
export async function createXList(config: XListBrowserConfig, input: XListCreateInput, hooks: XListActionHooks = {}): Promise<{ accountKey: string; detail: XListDetail }> {
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      if (!config.accountKey) throw new XListNeedsUserError('当前 X 账号未知，无法创建 List。');
      await active.navigateInitially(`https://x.com/${config.accountKey.slice(1)}/lists`, { mode: 'browse' });
      const accountKey = await readAccountKey(active);
      await (await active.findFirstVisible(createListSelectors)).click({ force: true });
      await active.page.locator(listNameSelectors.join(', ')).first().waitFor({ state: 'visible', timeout: 15_000 });
      await (await active.findFirstVisible(listNameSelectors)).fill(input.name);
      if (input.description !== undefined) await (await active.findFirstVisible(listDescriptionSelectors)).fill(input.description);
      if (input.isPrivate) await (await active.findFirstVisible(privateListSelectors)).check({ force: true });
      await assertNotStopped(hooks);
      await hooks.beforeAction?.('create_list');
      await (await active.findFirstVisible(confirmCreateSelectors)).click({ force: true });
      await active.page.waitForURL(/\/i\/lists\/\d+/, { timeout: 20_000 }).catch(() => {});
      const listId = parseXListId(active.page.url());
      if (!listId) throw new XListUnknownError('创建 List 后未能从当前页面读回稳定 List ID。');
      await active.navigateWithinOperation(xListUrl(listId), { mode: 'browse' });
      return { accountKey, detail: await detailFromCurrentPage(active, listId) };
    }, { timeoutMs: 180_000 });
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
      // Short modal workflow; keep navigation light and stay in Edit List manager sheet.
      await active.navigateInitially(xListUrl(input.listId), { mode: 'browse' });
      const accountKey = await readAccountKey(active);

      if (input.desiredState === 'present') {
        await openManagedMembers(active, input.listId, 'suggested');
        const outcome = await addMemberInOpenSheet(active, input.listId, normalizedHandle, hooks);
        return { accountKey, outcome, evidenceUrl: active.page.url() };
      }

      await openManagedMembers(active, input.listId, 'members');
      if (!await hasMember(active, normalizedHandle)) {
        return { accountKey, outcome: 'already_absent', evidenceUrl: active.page.url() };
      }
      await removeMember(active, input.listId, normalizedHandle, hooks);
      if (await hasMember(active, normalizedHandle)) {
        throw new XListUnknownError(`移除 ${normalizedHandle} 后仍显示在成员页。`);
      }
      return { accountKey, outcome: 'removed', evidenceUrl: active.page.url() };
    }, { timeoutMs: 90_000 });
  } finally {
    await session.close();
  }
}

export async function openListEditor(session: XListSession): Promise<void> {
  const edit = await firstVisible(session.page.locator('a[href$="/info"], a:has-text("编辑列表"), a:has-text("Edit List")'));
  if (edit) {
    await session.click(edit);
    return;
  }
  await session.click(await session.findFirstVisible(listMoreSelectors));
  await session.click(await session.findFirstVisible(editListSelectors));
}

export async function setPrivacy(session: XListSession, isPrivate: boolean): Promise<void> {
  const control = await session.findFirstVisible(privateListSelectors);
  const current = await control.getAttribute('aria-checked') ?? await control.getAttribute('data-state');
  const enabled = current === 'true' || current === 'checked';
  if (enabled !== isPrivate) await session.click(control);
}

export async function openManagedMembers(session: XListSession, listId: string, tab: 'members' | 'suggested' = 'members'): Promise<void> {
  if (!listId) throw new Error('List ID 缺失，无法打开成员管理。');

  // Reuse manager sheet when possible.
  if (await membersSheetReady(session, tab)) return;
  if (tab === 'suggested' && await membersSheetReady(session, 'members')) {
    // If this is the read-only "列表成员" sheet, it has no Suggested tab.
    const hasSuggested = await firstVisible(session.page.locator('[role="dialog"] a:has-text("已推荐"), [role="dialog"] [role="tab"]:has-text("已推荐")'));
    if (hasSuggested) {
      await switchMembersTab(session, listId, 'suggested');
      if (await membersSheetReady(session, 'suggested')) return;
    }
  }
  if (tab === 'members' && await membersSheetReady(session, 'suggested')) {
    await switchMembersTab(session, listId, 'members');
    if (await membersSheetReady(session, 'members')) return;
  }

  // Reset to clean list page.
  for (let i = 0; i < 2; i += 1) {
    await session.page.keyboard.press('Escape').catch(() => {});
    await sleepMs(120);
  }
  if (!session.page.url().includes(`/i/lists/${listId}`) || session.page.url().includes('/members') || session.page.url().includes('/info') || session.page.url().includes('/home')) {
    await session.navigateWithinOperation(xListUrl(listId), { mode: 'browse' });
  }

  // Canonical write path: Edit List -> Manage members -> Members/Suggested tabs.
  await session.page.locator(
    `a[href="/i/lists/${listId}/info"], a:has-text("编辑列表"), a:has-text("Edit List")`
  ).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  let edit = await firstVisible(session.page.locator(
    `a[href="/i/lists/${listId}/info"], a:has-text("编辑列表"), a:has-text("Edit List")`
  ));
  if (!edit) {
    await session.navigateWithinOperation(xListUrl(listId), { mode: 'browse' });
    edit = await firstVisible(session.page.locator(
      `a[href="/i/lists/${listId}/info"], a:has-text("编辑列表"), a:has-text("Edit List")`
    ));
  }
  if (!edit) throw new XListNeedsUserError('X 列表页未出现“编辑列表”入口；请接管浏览器后重试。');

  await session.click(edit, { force: true });
  await session.page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: /编辑列表|Edit List|管理成员|Manage members/ }).last()
    .waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
  await sleepMs(500);

  let manage = await firstVisible(session.page.locator(
    `[role="dialog"] a[href="/i/lists/${listId}/members"], [role="dialog"] a[data-testid="pivot"][href*="/members"], [role="dialog"] [role="tab"]:has-text("管理成员"), [role="dialog"] a:has-text("管理成员")`
  ));
  if (!manage) {
    // One retry: re-click edit if the sheet closed under us.
    await session.click(edit, { force: true });
    await sleepMs(800);
    manage = await firstVisible(session.page.locator(
      `[role="dialog"] a[href="/i/lists/${listId}/members"], [role="dialog"] [role="tab"]:has-text("管理成员"), [role="dialog"] a:has-text("管理成员")`
    ));
  }
  if (!manage) throw new XListNeedsUserError('X 列表页未出现“管理成员”入口；请接管浏览器后重试。');
  await session.click(manage, { force: true, preserveOverlay: true });
  await session.page.locator(
    '[role="dialog"] [data-testid="UserCell"], [role="dialog"] button:has-text("移除"), [role="dialog"] a:has-text("已推荐"), [role="dialog"] [role="tab"]:has-text("已推荐")'
  ).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

  if (!await membersSheetReady(session, tab)) await switchMembersTab(session, listId, tab);

  if (!await membersSheetReady(session, tab)) {
    throw new XListNeedsUserError('X 成员管理页未出现可操作控件；请接管浏览器后重试。');
  }
}

export async function switchMembersTab(session: XListSession, listId: string, tab: 'members' | 'suggested'): Promise<void> {
  if (tab === 'suggested') {
    const suggested = await firstVisible(session.page.locator(
      `[role="dialog"] a[href="/i/lists/${listId}/members/suggested"], [role="dialog"] a[data-testid="pivot"][href*="suggested"], [role="dialog"] [role="tab"]:has-text("已推荐"), [role="dialog"] [role="tab"]:has-text("Suggested"), [role="dialog"] a:has-text("已推荐"), [role="dialog"] a:has-text("Suggested")`
    ));
    if (suggested) await session.click(suggested, { force: true, preserveOverlay: true });
  } else {
    const members = await firstVisible(session.page.locator(
      `[role="dialog"] a[href="/i/lists/${listId}/members"]:not([href*="suggested"]), [role="dialog"] a[data-testid="pivot"][href*="/members"]:not([href*="suggested"]), [role="dialog"] [role="tab"]:has-text("成员"), [role="dialog"] [role="tab"]:has-text("Members"), [role="dialog"] a:has-text("成员")`
    ));
    if (members) await session.click(members, { force: true, preserveOverlay: true });
  }
  const waitSelector = tab === 'suggested'
    ? '[role="dialog"] input[placeholder*="搜索用户"], [role="dialog"] input[placeholder*="Search people"]'
    : '[role="dialog"] [data-testid="UserCell"], [role="dialog"] button:has-text("移除"), [role="dialog"] button:has-text("添加")';
  await session.page.locator(waitSelector).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  await sleepMs(350);
}

export async function membersSheetReady(session: XListSession, tab: 'members' | 'suggested'): Promise<boolean> {
  if (tab === 'suggested') {
    // Members-sheet people search only — never the global top nav search box.
    const search = session.page.locator(
      '[role="dialog"] input[placeholder*="搜索用户"], [aria-modal="true"] input[placeholder*="搜索用户"], [role="dialog"] input[placeholder*="Search people"], [role="dialog"] input[placeholder*="Search users"]'
    );
    return search.first().isVisible().catch(() => false);
  }
  const root = await membersRoot(session);
  const cells = root.locator('[data-testid="UserCell"]');
  if (await cells.first().isVisible().catch(() => false)) return true;
  const action = root.locator('button:has-text("添加"), button:has-text("Add"), button:has-text("移除"), button:has-text("Remove"), button[aria-label="添加"], button[aria-label="移除"]');
  return action.first().isVisible().catch(() => false);
}

export async function membersRoot(session: XListSession) {
  const candidates = session.page.locator('[role="dialog"], [aria-modal="true"]');
  const count = await candidates.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const hasControls = await candidate.locator(
      '[data-testid="UserCell"], [data-testid="TypeaheadUser"], [data-testid="typeaheadResult"], input[placeholder*="搜索用户"], input[placeholder*="Search people"], button:has-text("添加"), button:has-text("移除"), button:has-text("Add"), button:has-text("Remove"), a:has-text("已推荐"), a:has-text("Suggested"), a:has-text("管理成员")'
    ).first().isVisible().catch(() => false);
    if (hasControls) return candidate;
  }
  return session.page.locator('[data-wmb-members-root-missing]');
}

/** Add one handle inside an already-open members manager sheet (serial). */
export async function addMemberInOpenSheet(session: XListSession, listId: string, handle: string, hooks: XListActionHooks): Promise<'already_present' | 'added'> {
  const bare = handle.replace(/^@/, '');
  // Prefer staying in the current sheet and switching to Suggested.
  if (!await membersSheetReady(session, 'suggested')) {
    if (await membersSheetReady(session, 'members')) {
      await switchMembersTab(session, listId, 'suggested');
    }
  }
  if (!await membersSheetReady(session, 'suggested')) {
    await openManagedMembers(session, listId, 'suggested');
  }

  const search = await firstVisible(session.page.locator([
    '[role="dialog"] input[placeholder*="搜索用户"]',
    '[aria-modal="true"] input[placeholder*="搜索用户"]',
    '[role="dialog"] input[placeholder*="Search people"]',
    '[role="dialog"] input[placeholder*="Search users"]'
  ].join(', ')));
  if (!search) throw new XListNeedsUserError('X 成员推荐页未出现搜索框。');

  // Clear + type directly; human typing is unnecessarily slow inside this modal.
  await search.click({ force: true });
  await session.page.keyboard.press('Control+A').catch(() => {});
  await session.page.keyboard.press('Backspace').catch(() => {});
  await search.fill(bare);
  await sleepMs(1600);

  let rows = session.page.locator(
    '[role="dialog"] [data-testid="typeaheadResult"], [role="dialog"] [data-testid="TypeaheadUser"], [role="dialog"] [role="option"], [aria-modal="true"] [data-testid="typeaheadResult"], [aria-modal="true"] [data-testid="TypeaheadUser"]'
  );
  await rows.first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
  let row = await exactHandleRow(rows, bare);
  if (!row) {
    // Retry once with slow type in case fill was ignored.
    await search.click({ force: true });
    await search.fill('');
    await search.pressSequentially(bare, { delay: 40 }).catch(async () => {
      await session.page.keyboard.type(bare, { delay: 40 });
    });
    await sleepMs(1800);
    rows = session.page.locator(
      '[role="dialog"] [data-testid="typeaheadResult"], [role="dialog"] [data-testid="TypeaheadUser"], [role="dialog"] [role="option"]'
    );
    await rows.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    row = await exactHandleRow(rows, bare);
  }
  if (!row || !await row.isVisible().catch(() => false)) {
    const sample = await session.page.locator('[role="dialog"]').last().innerText().catch(() => '');
    throw new XListNeedsUserError(`X 搜索 ${handle} 后未出现对应用户。sheet=${sample.slice(0, 180).replace(/\s+/g, ' ')}`);
  }

  const removeBtn = row.locator(
    'button[aria-label="移除"], button[aria-label="Remove"], button:has-text("移除"), button:has-text("Remove")'
  ).first();
  if (await removeBtn.isVisible().catch(() => false)) return 'already_present';

  // IMPORTANT: do not match the whole TypeaheadUser row button (its innerText also contains "添加").
  // Only the compact control with aria-label 添加/Add performs membership changes.
  let action = await firstVisible(row.locator(
    'button[aria-label="添加"], button[aria-label="Add"], div[role="button"][aria-label="添加"], div[role="button"][aria-label="Add"]'
  ));
  if (!action) {
    action = await firstVisible(row.locator('button').filter({ hasText: /^\s*添加\s*$|^\s*Add\s*$/ }));
  }
  if (!action) throw new XListNeedsUserError(`X 未显示 ${handle} 的安全添加控件。`);

  await assertNotStopped(hooks);
  await hooks.beforeAction?.('add_member');
  const mutation = session.page.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().includes('/ListAddMember')
  ), { timeout: 12_000 }).catch(() => null);
  await action.click({ timeout: 5_000 });
  const response = await mutation;
  const platformError = response ? xListMutationErrorMessage(await response.json().catch(() => null)) : null;
  if (platformError) throw new XListPlatformRejectedError(`X 拒绝添加 ${handle}：${platformError}`);
  await removeBtn.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (!await removeBtn.isVisible().catch(() => false)) {
    await openManagedMembers(session, listId, 'members');
    if (!await hasMember(session, handle)) throw new XListUnknownError(`点击添加 ${handle} 后未能从成员页读回。`);
  }
  return 'added';
}

export function xListMutationErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { data?: unknown; errors?: unknown };
  if (record.data && typeof record.data === 'object' && (record.data as { list?: unknown }).list) return null;
  const errors = record.errors;
  if (!Array.isArray(errors)) return null;
  const message = errors.find((item) => item && typeof item === 'object' && typeof (item as { message?: unknown }).message === 'string');
  return message ? (message as { message: string }).message : null;
}

async function exactHandleRow(rows: Locator, handle: string): Promise<Locator | null> {
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const hrefs = await row.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    if (hrefs.some((href) => xProfileHrefMatchesHandle(href, handle))) return row;
  }
  return null;
}

export function xProfileHrefMatchesHandle(href: string, handle: string): boolean {
  try {
    const pathname = new URL(href, 'https://x.com').pathname.replace(/\/$/, '');
    return pathname.toLowerCase() === `/${handle.replace(/^@/, '').toLowerCase()}`;
  } catch { return false; }
}

export async function addMember(session: XListSession, listId: string, handle: string, hooks: XListActionHooks): Promise<void> {
  await openManagedMembers(session, listId, 'suggested');
  await addMemberInOpenSheet(session, listId, handle, hooks);
}

export async function removeMember(session: XListSession, listId: string, handle: string, hooks: XListActionHooks): Promise<void> {
  if (!listId) throw new Error('List ID 缺失，无法移除成员。');
  await openManagedMembers(session, listId, 'members');
  const bare = handle.replace(/^@/, '');
  const profile = await firstVisible(session.page.locator(
    `[data-testid="UserCell"] a[href="/${bare}"], [role="dialog"] a[href="/${bare}"], main a[href="/${bare}"]`
  ));
  if (!profile) throw new XListNeedsUserError(`成员页未找到 ${handle}。`);
  const row = profile.locator('xpath=ancestor::*[@data-testid="UserCell" or @role="button"][1]');
  const action = await firstVisible(row.locator('button:has-text("移除"), button:has-text("Remove"), button[aria-label*="移除"], button[aria-label*="Remove"]'));
  if (!action) throw new XListNeedsUserError(`X 未显示 ${handle} 的安全移除控件。`);
  await assertNotStopped(hooks);
  await hooks.beforeAction?.('remove_member');
  await session.click(action, { force: true });
  const confirm = await firstVisible(session.page.locator('[role="dialog"] button:has-text("Remove"), [role="dialog"] button:has-text("移除")'));
  if (confirm) await session.click(confirm, { force: true });
}

export async function hasMember(session: XListSession, handle: string): Promise<boolean> {
  const cells = (await membersRoot(session)).locator('[data-testid="UserCell"]');
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

export async function assertNotStopped(hooks: XListActionHooks): Promise<void> {
  if (await hooks.shouldStop?.()) throw new XListStopRequestedError('用户请求在当前页面动作完成后停止。');
}
