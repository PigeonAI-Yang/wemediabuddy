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

export async function readAccountKey(session: XListSession): Promise<string> {
  const account = session.page.locator('[data-testid="SideNav_AccountSwitcher_Button"]');
  const text = await account.innerText({ timeout: 5_000 }).catch(() => '');
  const avatarTestId = await account.locator('[data-testid^="UserAvatar-Container-"]').getAttribute('data-testid').catch(() => null);
  const handle = firstHandle(text) ?? (avatarTestId ? `@${avatarTestId.replace('UserAvatar-Container-', '')}` : null);
  if (!handle) throw new Error('无法从专用 X 浏览器读取当前账号。');
  return handle;
}

export function startListManagementCapture(page: Page): {
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

export function extractListsFromManagementPayload(payload: unknown): XListRef[] {
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

export async function readListCellsLight(session: XListSession): Promise<XListRef[]> {
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

export async function readListCells(session: XListSession): Promise<XListRef[]> {
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

export const createListSelectors = ['a[href="/i/lists/create"]', 'a[href$="/i/lists/create"]', 'button:has-text("New")', 'button:has-text("新建")', 'button[aria-label*="Create"]', 'button[aria-label*="创建"]'];
export const listNameSelectors = ['input[name="name"]', 'input[aria-label*="List name"]', 'input[aria-label*="列表名称"]', 'input[placeholder*="List name"]', 'input[placeholder*="列表名称"]'];
export const listDescriptionSelectors = ['textarea[name="description"]', 'textarea[aria-label*="Description"]', 'textarea[aria-label*="描述"]', 'textarea'];
export const privateListSelectors = ['input[type="checkbox"]', 'label:has-text("Make private")', 'label:has-text("设为私密")', '[role="switch"][aria-label*="private"]', '[role="switch"][aria-label*="私密"]'];
export const confirmCreateSelectors = ['button:has-text("Next")', 'button:has-text("下一步")', 'button:has-text("Create")', 'button:has-text("创建")'];
export const listMoreSelectors = ['button[aria-label="More"]', 'button[aria-label="更多"]', 'button[data-testid="caret"]'];
export const editListSelectors = ['[role="menuitem"]:has-text("Edit List")', '[role="menuitem"]:has-text("编辑列表")', 'a:has-text("Edit List")', 'a:has-text("编辑列表")', 'a[href$="/info"]'];
export const confirmSaveSelectors = ['button:has-text("Save")', 'button:has-text("保存")'];
export const deleteListSelectors = ['button:has-text("Delete List")', 'button:has-text("删除列表")', '[role="menuitem"]:has-text("Delete")', '[role="menuitem"]:has-text("删除")'];
export const confirmDeleteSelectors = ['[role="dialog"] button:has-text("Delete")', '[role="dialog"] button:has-text("删除")'];
const addMemberSelectors = ['button:has-text("Add members")', 'button:has-text("Add member")', 'button:has-text("添加成员")'];
const memberSearchSelectors = ['[role="dialog"] input[data-testid="SearchBox_Search_Input"]', '[role="dialog"] input[placeholder*="Search"]', '[role="dialog"] input[placeholder*="搜索"]'];
const removeMemberSelectors = ['[role="menuitem"]:has-text("Remove")', '[role="menuitem"]:has-text("移除")', 'button:has-text("Remove")', 'button:has-text("移除")'];

export function listDescriptionFromHeaderLines(name: string | null, lines: string[]): string {
  const nameIndex = name ? lines.indexOf(name) : -1;
  const afterName = nameIndex >= 0 ? lines.slice(nameIndex + 1) : [];
  return afterName.length >= 2 && !afterName[1]!.startsWith('@') ? afterName[0]! : '';
}

export async function detailFromCurrentPage(session: XListSession, listId: string): Promise<XListDetail> {
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
  const headerLines = await session.page.locator('main div[dir="ltr"]').evaluateAll((nodes) => nodes
    .filter((node) => (node as HTMLElement).offsetWidth > 0)
    .map((node) => (node.textContent ?? '').trim()).filter(Boolean)).catch(() => [] as string[]);
  const description = listDescriptionFromHeaderLines(nameCandidate, headerLines);
  const isPrivate = await session.page.locator('main svg[aria-label="Private List"], main svg[aria-label="私密列表"]').first().isVisible().catch(() => false);
  return {
    listId,
    canonicalUrl: xListUrl(listId),
    name: nameCandidate || `List ${listId}`,
    ownerHandle: ownerFromLink || firstHandle(text),
    // List detail pages opened from the operator's management page are owned; avoid "成员" text flipping kind.
    kind: 'owned',
    description,
    isPrivate,
    memberCount,
    observation: observe(session.page.url(), text)
  };
}


export async function expandMainTweet(page: Page): Promise<void> {
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

export async function nudgeMainVideo(page: Page): Promise<void> {
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

export function isLikelyVideoMediaUrl(value: string): boolean {
  if (!value || value.startsWith('blob:') || value.startsWith('data:')) return false;
  if (/\.m3u8(?:$|\?)/i.test(value)) return true;
  if (/\.mp4(?:$|\?)/i.test(value)) return true;
  if (/video\.twimg\.com/i.test(value)) return true;
  if (/amplify_video|ext_tw_video|tweet_video/i.test(value) && !/\.(?:jpg|jpeg|png|webp)(?:$|\?)/i.test(value)) return true;
  return false;
}

export function scoreVideoUrl(value: string): number {
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

export function pickPlayableVideoUrl(candidates: Array<string | null | undefined>): string | null {
  const urls = [...new Set(candidates.filter((item): item is string => typeof item === 'string' && isLikelyVideoMediaUrl(item)))];
  if (!urls.length) return null;
  urls.sort((left, right) => scoreVideoUrl(right) - scoreVideoUrl(left));
  const mp4 = urls.find((item) => /\.mp4(?:$|\?)/i.test(item));
  return mp4 ?? urls[0] ?? null;
}

export async function readArticlePost(article: Locator, options: { preferFullText?: boolean } = {}): Promise<XListPost | null> {
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

    const labelFrom = (selectors: string[], patterns: RegExp[]): string | null => {
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

    const metricLabels = {
      replies: labelFrom(
        ['[data-testid="reply"]'],
        [/([\d.,.\sKkMmBb万亿]+)\s*(?:Replies|Reply|回复|条回复)/i]
      ),
      reposts: labelFrom(
        ['[data-testid="retweet"]', '[data-testid="unretweet"]'],
        [/([\d.,.\sKkMmBb万亿]+)\s*(?:Reposts?|Retweets?|转帖|转推|转发)/i]
      ),
      likes: labelFrom(
        ['[data-testid="like"]', '[data-testid="unlike"]'],
        [/([\d.,.\sKkMmBb万亿]+)\s*(?:Likes?|喜欢|赞)/i]
      ),
      bookmarks: labelFrom(
        ['[data-testid="bookmark"]', '[data-testid="removeBookmark"]'],
        [/([\d.,.\sKkMmBb万亿]+)\s*(?:Bookmarks?|书签|收藏)/i]
      ),
      views: labelFrom(
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
      metricLabels
    };
  }).catch(() => null);
  if (!raw?.statusHref) return null;
  const text = (raw.text || '').trim();
  if (!text && raw.images.length === 0 && !raw.hasVideo) return null;
  const thumbs = raw.images.map((src) => normalizeMediaUrl(src, 'thumb'));
  const fullImages = options.preferFullText
    ? raw.images.map((src) => normalizeMediaUrl(src, 'small'))
    : thumbs;
  const metricEvidence = xMetricEvidenceMap(raw.metricLabels ?? {}, 'dom');
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
    metrics: xMetricValues(metricEvidence),
    metricEvidence
  };
}

export function normalizeStatusUrl(value: string): string | null {
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

export function normalizeMediaUrl(value: string, size: 'thumb' | 'small' | 'medium' | 'large' | 'orig' = 'thumb'): string {
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
export async function firstStatusLink(article: Locator): Promise<string | null> {
  const links = article.locator('a[href*="/status/"]');
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const href = await links.nth(index).getAttribute('href');
    if (href?.match(/^\/[A-Za-z0-9_]+\/status\/\d+/)) return href;
  }
  return null;
}

export async function firstText(locator: Locator): Promise<string | null> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const value = (await locator.nth(index).innerText().catch(() => '')).trim();
    if (value) return value;
  }
  return null;
}

export async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false) && await candidate.boundingBox()) return candidate;
  }
  return null;
}

export function observe(pageUrl: string, visibleText: string): XListObservation {
  return {
    capturedAt: new Date().toISOString(),
    pageUrl,
    fingerprint: createHash('sha256').update(visibleText).digest('hex'),
    visibleText: visibleText.slice(0, 8_000)
  };
}

export function ownerHandleFromUserResults(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('result' in value)) return null;
  const result = value.result;
  if (!result || typeof result !== 'object' || !('core' in result)) return null;
  const core = result.core;
  if (!core || typeof core !== 'object' || !('screen_name' in core)) return null;
  const screen = core.screen_name;
  return typeof screen === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(screen) ? `@${screen}` : null;
}

export function firstHandle(value: string): string | null {
  const match = value.match(/@[A-Za-z0-9_]{1,15}\b/);
  return match?.[0] ?? null;
}

export function normalizeHandle(value: string): string {
  const candidate = value.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(candidate)) throw new Error('X 成员必须使用精确 handle。');
  return `@${candidate}`;
}

export function handleFromPath(value: string): string | null {
  const match = value.match(/^\/([A-Za-z0-9_]{1,15})$/);
  return match ? `@${match[1]}` : null;
}

export function inferKind(value: string): XListKind {
  if (/(created|创建|你的列表)/i.test(value)) return 'owned';
  if (/(following|关注)/i.test(value)) return 'following';
  if (/(member of|成员)/i.test(value)) return 'member';
  return 'unknown';
}

export function parseCount(value: string, pattern: RegExp): number | null {
  const match = value.match(pattern);
  if (!match) return null;
  const parsed = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}
