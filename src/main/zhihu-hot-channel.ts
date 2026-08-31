// WMB-5350 scoring intake: Zhihu hot observations store real evidence (summary/excerpt/heat/categories) for source-driven scoring; no synthetic 100.
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright-core';
import { ensureRegistrySourceFeed, upsertSource } from './sources.ts';
import { recordSourceScanReceipt } from './intelligence-channels.ts';
import { resolveBrowserBinding } from './bound-browser.ts';
import { loadPlaywrightCore, startBrowser } from './browser.ts';
export const ZHIHU_HOT_URL = 'https://www.zhihu.com/topic/19551275/hot' as const;
export const ZHIHU_HOT_MODULE = 'zhihu_hot' as const;
export const ZHIHU_TOPIC_CATEGORY_MAP = Object.freeze({
  index: { id: 'index', label: '索引', url: 'https://www.zhihu.com/topic/19551275/index', kind: 'summary' },
  intro: { id: 'intro', label: '简介', url: 'https://www.zhihu.com/topic/19551275/intro', kind: 'summary' },
  discussion: { id: 'discussion', label: '讨论', url: ZHIHU_HOT_URL, kind: 'list' },
  essence: { id: 'essence', label: '精华', url: 'https://www.zhihu.com/topic/19551275/top-answers', kind: 'list' },
  unanswered: { id: 'unanswered', label: '等待回答', url: 'https://www.zhihu.com/topic/19551275/unanswered', kind: 'list' }
} as const);
export const ZHIHU_TOPIC_CATEGORIES = Object.freeze(Object.keys(ZHIHU_TOPIC_CATEGORY_MAP) as Array<keyof typeof ZHIHU_TOPIC_CATEGORY_MAP>);
export type ZhihuTopicCategory = keyof typeof ZHIHU_TOPIC_CATEGORY_MAP;
export type ZhihuTopicCategoryDefinition = (typeof ZHIHU_TOPIC_CATEGORY_MAP)[ZhihuTopicCategory];

export function normalizeZhihuTopicCategory(category: string | null | undefined): ZhihuTopicCategory {
  return typeof category === 'string' && Object.prototype.hasOwnProperty.call(ZHIHU_TOPIC_CATEGORY_MAP, category)
    ? category as ZhihuTopicCategory
    : 'discussion';
}

export function zhihuTopicCategoryDefinition(category: string | null | undefined): ZhihuTopicCategoryDefinition {
  return ZHIHU_TOPIC_CATEGORY_MAP[normalizeZhihuTopicCategory(category)];
}

// Centralized selectors for the official AI topic page. The topic feed uses ContentItem cards, not the full-site HotItem ranking DOM.
export const ZHIHU_HOT_SELECTORS = Object.freeze({
  container: 'main[role="main"]',
  item: '.ContentItem.AnswerItem',
  rank: '.TopicHotItem-rank',
  titleLink: '.ContentItem-title a[href*="/question/"]',
  heat: '.VoteButton',
  excerpt: '.RichContent-inner'
} as const);

export const ZHIHU_HOT_ERROR_CODES = Object.freeze({
  DOM_DRIFT: 'ZHIHU_HOT_DOM_DRIFT',
  NEEDS_USER: 'ZHIHU_HOT_NEEDS_USER',
  CHALLENGE: 'ZHIHU_HOT_CHALLENGE',
  UNAVAILABLE: 'ZHIHU_HOT_UNAVAILABLE'
} as const);

export type ZhihuHotItem = {
  rank: number;
  title: string;
  questionUrl: string;
  canonicalUrl: string;
  questionId: string;
  heatText: string | null;
  excerpt: string | null;
};

export type ZhihuTopicCategoryItem = ZhihuHotItem & {
  sourceItemId?: string;
  url: string;
  collectedAt?: string;
};

export type ZhihuTopicCategoryRead = {
  category: ZhihuTopicCategory;
  items: ZhihuTopicCategoryItem[];
  summary: string | null;
  evidenceUrl: string;
  collectedAt: string | null;
};
export type ZhihuTopicCategorySnapshot = ZhihuTopicCategoryRead & {
  businessDate: string | null;
  latestScan: { status: 'succeeded' | 'failed' | 'needs_user'; checkedAt: string; errorMessage: string | null } | null;
};

export type ZhihuHotRead = {
  items: ZhihuHotItem[];
  evidenceUrl: string;
  collectedAt: string;
};

export type ZhihuHotReadyState = 'ready' | 'needs_user' | 'unavailable';

export function canonicalizeZhihuQuestionUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let urlStr = trimmed;
  // handle relative
  if (urlStr.startsWith('/')) urlStr = `https://www.zhihu.com${urlStr}`;
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('zhihu.com')) return null;
  const match = parsed.pathname.match(/\/question\/(\d+)/);
  if (!match) return null;
  const id = match[1];
  return `https://www.zhihu.com/question/${id}`;
}

export function zhihuQuestionIdFromCanonical(canonical: string): string | null {
  const m = canonical.match(/\/question\/(\d+)/);
  return m ? m[1] : null;
}

export function fingerprintForZhihuObservation(input: { canonicalUrl: string; title: string; rank: number; heatText: string | null; excerpt: string | null }): string {
  const payload = JSON.stringify([input.canonicalUrl, input.title.trim(), input.rank, (input.heatText ?? '').trim(), (input.excerpt ?? '').trim()]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}
// Fixture-friendly parser from captured topic HTML; production extraction uses the same ContentItem contract in page.evaluate.
// Only AnswerItem question cards inside the topic main surface are accepted.
export function parseZhihuHotHtml(html: string, evidenceUrl: string = ZHIHU_HOT_URL): ZhihuHotItem[] {
  void evidenceUrl;
  const blocks: string[] = [];
  const stack: Array<{ start: number; tag: string; insideTopicMain: boolean; isAnswerItem: boolean }> = [];
  const elementPattern = /<(\/)?(main|div)\b[^>]*>/gi;
  let token: RegExpExecArray | null;
  while ((token = elementPattern.exec(html)) !== null) {
    if (!token[1]) {
      const tag = token[2].toLowerCase();
      const classNames = token[0].match(/class\s*=\s*["']([^"']*)["']/i)?.[1].split(/\s+/).filter(Boolean) ?? [];
      const isTopicMain = tag === 'main' && /role\s*=\s*["']main["']/i.test(token[0]);
      stack.push({
        start: token.index,
        tag,
        insideTopicMain: isTopicMain || (stack.at(-1)?.insideTopicMain ?? false),
        isAnswerItem: classNames.includes('ContentItem') && classNames.includes('AnswerItem')
      });
      continue;
    }
    const frame = stack.pop();
    if (frame?.isAnswerItem && frame.insideTopicMain) {
      blocks.push(html.slice(frame.start, token.index + token[0].length));
    }
  }

  const items: ZhihuHotItem[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<[^>]*class=["'][^"']*ContentItem-title[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']*\/question\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i;
  for (const block of blocks) {
    const anchor = anchorPattern.exec(block);
    if (!anchor) continue;
    const rawUrl = anchor[1];
    const titleRaw = anchor[3].replace(/<[^>]+>/g, '').trim();
    const canonical = canonicalizeZhihuQuestionUrl(rawUrl);
    if (!titleRaw || !canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    const heatMatch = block.match(/class=["'][^"']*VoteButton[^"']*["'][^>]*>([\s\S]*?)</i);
    const heatText = heatMatch ? heatMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 120) || null : null;
    const excerptMatch = block.match(/class=["'][^"']*RichContent-inner[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const excerpt = excerptMatch ? excerptMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 300) || null : null;
    items.push({
      rank: items.length + 1,
      title: titleRaw.slice(0, 200),
      questionUrl: rawUrl,
      canonicalUrl: canonical,
      questionId: zhihuQuestionIdFromCanonical(canonical)!,
      heatText,
      excerpt
    });
    if (items.length >= 50) break;
  }
  return items;
}

export function isZhihuHotChallengeHtml(html: string): boolean {
  // The normal Zhihu bundle contains words such as "challenge" and "验证码" in scripts.
  // Only classify challenge markers from rendered markup/text, never script or style payloads.
  const renderedHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  return /(?:id|class)=["'][^"']*(?:captcha|security-verification|unhuman)[^"']*["']/i.test(renderedHtml)
    || /请输入验证码|安全验证|人机验证|完成验证/.test(renderedHtml);
}

export function isZhihuHotSigninHtml(html: string, url: string): boolean {
  if (url.includes('/signin')) return true;
  return /data-za-detail-view-path-module="SignInButton"|>登录</.test(html) && !html.includes('ContentItem');
}
// Browser readiness proves only that the workspace owns a verified BrowserProfile.
// Zhihu login truth comes from the live page: signin/challenge detection runs after navigation.
export function zhihuHotReadiness(database: DatabaseSync): { state: ZhihuHotReadyState; code: string | null; message: string | null } {
  try {
    resolveBrowserBinding(database);
    return { state: 'ready', code: null, message: null };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'BROWSER_NEEDS_USER') return { state: 'needs_user', code: ZHIHU_HOT_ERROR_CODES.NEEDS_USER, message: (e as Error).message || '浏览器未就绪。' };
    return { state: 'unavailable', code: ZHIHU_HOT_ERROR_CODES.UNAVAILABLE, message: (e as Error).message };
  }
}

type RawZhihuTopicItem = { href: string; title: string; heatText: string | null; excerpt: string | null };

/** Read one official topic category through the existing page DOM only. No click, focus, or foreground interaction is used. */
export async function extractZhihuTopicCategoryFromPage(page: Page, category: string = 'discussion'): Promise<{ items: RawZhihuTopicItem[]; summary: string | null; url: string; htmlSnippet: string }> {
  const normalizedCategory = normalizeZhihuTopicCategory(category);
  const definition = zhihuTopicCategoryDefinition(normalizedCategory);
  const url = page.url();
  const bodyText = await page.content().catch(() => '');
  const visibleText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  if (isZhihuHotChallengeHtml(visibleText)) {
    throw Object.assign(new Error('知乎页面要求安全验证，请在绑定浏览器中完成验证后重试。'), { code: ZHIHU_HOT_ERROR_CODES.CHALLENGE, details: { url, state: 'challenge', category: normalizedCategory } });
  }
  if (isZhihuHotSigninHtml(bodyText, url)) {
    throw Object.assign(new Error('知乎尚未登录，请在绑定浏览器中登录知乎后重试。'), { code: ZHIHU_HOT_ERROR_CODES.NEEDS_USER, details: { url, state: 'needs_user', category: normalizedCategory } });
  }
  if (definition.kind === 'summary') {
    const summary = await page.evaluate(() => {
      const root = document.querySelector('main[role="main"]') ?? document.body;
      if (!root) return '';
      const blocks = Array.from(root.querySelectorAll('h1,h2,h3,p,article'))
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .filter(Boolean);
      const text = (blocks.length ? blocks : [root.textContent?.replace(/\s+/g, ' ').trim() ?? '']).join('\n');
      return text.slice(0, 1600);
    }).catch(() => '');
    return { items: [], summary: summary || null, url, htmlSnippet: bodyText.slice(0, 2000) };
  }
  const raw = await page.evaluate(() => {
    const container = document.querySelector('main[role="main"]');
    if (!container) return [];
    const links = Array.from(container.querySelectorAll('a[href*="/question/"]')) as HTMLAnchorElement[];
    return links.slice(0, 100).map((link) => {
      const card = link.closest('.ContentItem, article, [data-za-detail-view-element_name]') as HTMLElement | null;
      const heading = card?.querySelector('h1,h2,h3,.ContentItem-title') as HTMLElement | null;
      const title = (link.textContent || heading?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const heat = card?.querySelector('.VoteButton') as HTMLElement | null;
      const excerpt = card?.querySelector('.RichContent-inner') as HTMLElement | null;
      return {
        href: link.href,
        title,
        heatText: heat?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) || null,
        excerpt: excerpt?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 300) || null
      };
    }).filter((item) => item.title && item.href);
  }) as RawZhihuTopicItem[];
  const items: RawZhihuTopicItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const canonical = canonicalizeZhihuQuestionUrl(item.href);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    items.push(item);
    if (items.length >= 50) break;
  }
  if (!items.length) {
    throw Object.assign(new Error('知乎 AI 专题页面结构已变化，未能提取任何问题；请更新选择器后重试。'), { code: ZHIHU_HOT_ERROR_CODES.DOM_DRIFT, details: { url, category: normalizedCategory } });
  }
  return { items, summary: null, url, htmlSnippet: bodyText.slice(0, 2000) };
}

export async function extractZhihuHotFromPage(page: Page): Promise<{ items: Array<{ rank: number; title: string; href: string; heatText: string | null; excerpt: string | null }>; url: string; htmlSnippet: string }> {
  const url = page.url();
  const bodyText = await page.content().catch(() => '');
  const visibleText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  if (isZhihuHotChallengeHtml(visibleText)) {
    throw Object.assign(new Error('知乎页面要求安全验证，请在绑定浏览器中完成验证后重试。'), { code: ZHIHU_HOT_ERROR_CODES.CHALLENGE, details: { url, state: 'challenge' } });
  }
  if (isZhihuHotSigninHtml(bodyText, url)) {
    throw Object.assign(new Error('知乎尚未登录，请在绑定浏览器中登录知乎后重试。'), { code: ZHIHU_HOT_ERROR_CODES.NEEDS_USER, details: { url, state: 'needs_user' } });
  }
  const raw = await page.evaluate((selectors) => {
    const container = document.querySelector(selectors.container) as HTMLElement | null;
    if (!container) return [];
    const nodes = Array.from(container.querySelectorAll(selectors.item)) as HTMLElement[];
    return nodes.slice(0, 50).map((node, idx) => {
      const link = node.querySelector(selectors.titleLink) as HTMLAnchorElement | null;
      const heatEl = node.querySelector(selectors.heat) as HTMLElement | null;
      const excerptEl = node.querySelector(selectors.excerpt) as HTMLElement | null;
      return {
        rank: idx + 1,
        title: link?.textContent?.trim().slice(0, 200) ?? '',
        href: link?.href ?? '',
        heatText: heatEl?.textContent?.trim().slice(0, 120) ?? null,
        excerpt: excerptEl?.textContent?.trim().slice(0, 300) ?? null
      };
    }).filter((item) => item.title && item.href);
  }, ZHIHU_HOT_SELECTORS as unknown as Record<string, string>);

  // DOM drift detection: centralized selectors yielded nothing
  if (!raw.length) {
    // Allow fallback regex on full html before declaring drift
    const html = await page.content().catch(() => '');
    const fallback = parseZhihuHotHtml(html, url);
    if (fallback.length) {
      return { items: fallback.map((f) => ({ rank: f.rank, title: f.title, href: f.questionUrl, heatText: f.heatText, excerpt: f.excerpt })), url, htmlSnippet: html.slice(0, 2000) };
    }
    throw Object.assign(new Error('知乎 AI 专题页面结构已变化，未能提取任何问题；请更新选择器后重试。'), { code: ZHIHU_HOT_ERROR_CODES.DOM_DRIFT, details: { url, selectors: ZHIHU_HOT_SELECTORS } });
  }
  const htmlSnippet = bodyText.slice(0, 2000);
  return { items: raw, url, htmlSnippet };
}

type ZhihuBrowserDeps = { connectBrowser?: () => Promise<{ cdpUrl: string; profileId: string }> };

export async function readZhihuTopicCategoryViaBrowser(database: DatabaseSync, category: string = 'discussion', deps: ZhihuBrowserDeps = {}): Promise<ZhihuTopicCategoryRead> {
  const normalizedCategory = normalizeZhihuTopicCategory(category);
  const definition = zhihuTopicCategoryDefinition(normalizedCategory);
  const readiness = zhihuHotReadiness(database);
  if (readiness.state === 'needs_user') {
    throw Object.assign(new Error(readiness.message ?? '知乎 AI 专题需要登录验证。'), { code: ZHIHU_HOT_ERROR_CODES.NEEDS_USER, details: { state: 'needs_user', category: normalizedCategory, resume: '请在绑定浏览器中登录/完成验证后重试扫描。' } });
  }
  if (readiness.state === 'unavailable') {
    throw Object.assign(new Error(readiness.message ?? '浏览器不可用。'), { code: ZHIHU_HOT_ERROR_CODES.UNAVAILABLE, details: { state: 'unavailable', category: normalizedCategory } });
  }
  const { profile } = resolveBrowserBinding(database);
  const runtime = await (deps.connectBrowser ? null : startBrowser(profile, { mode: 'quiet' }));
  let cdpUrl: string;
  let closeBrowser: () => Promise<void> = async () => {};
  if (deps.connectBrowser) {
    const browserBinding = await deps.connectBrowser();
    cdpUrl = browserBinding.cdpUrl;
  } else {
    cdpUrl = (runtime as { cdpUrl: string }).cdpUrl;
  }
  const { chromium } = loadPlaywrightCore();
  const browser = await (chromium as unknown as { connectOverCDP: (url: string) => Promise<{ contexts: () => { pages: () => Page[]; newPage: () => Promise<Page> }[]; close: () => Promise<void> }> }).connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw Object.assign(new Error('浏览器上下文不可用。'), { code: ZHIHU_HOT_ERROR_CODES.UNAVAILABLE });
    const page = await context.newPage();
    try {
      await page.goto(definition.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);
      const categoryRead = await extractZhihuTopicCategoryFromPage(page as unknown as Page, normalizedCategory);
      const extractedItems = categoryRead.items;
      const summary = categoryRead.summary;
      const collectedAt = new Date().toISOString();
      const items: ZhihuTopicCategoryItem[] = [];
      const seen = new Set<string>();
      for (const raw of extractedItems) {
        const canonical = canonicalizeZhihuQuestionUrl(raw.href);
        const questionId = canonical ? zhihuQuestionIdFromCanonical(canonical) : null;
        if (!canonical || !questionId || seen.has(canonical)) continue;
        seen.add(canonical);
        items.push({ rank: items.length + 1, title: raw.title, questionUrl: raw.href, canonicalUrl: canonical, questionId, url: canonical, collectedAt, heatText: raw.heatText, excerpt: raw.excerpt });
      }
      return { category: normalizedCategory, items, summary, evidenceUrl: definition.url, collectedAt };
    } finally {
      await (page as { close: () => Promise<void> }).close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    await closeBrowser().catch(() => {});
  }
}

export async function readZhihuHotViaBrowser(database: DatabaseSync, deps: ZhihuBrowserDeps = {}): Promise<ZhihuHotRead> {
  const read = await readZhihuTopicCategoryViaBrowser(database, 'discussion', deps);
  if (!read.items.length) throw Object.assign(new Error('知乎 AI 专题页面结构已变化，未能提取任何问题。'), { code: ZHIHU_HOT_ERROR_CODES.DOM_DRIFT });
  return { items: read.items, evidenceUrl: read.evidenceUrl, collectedAt: read.collectedAt ?? new Date().toISOString() };
}

export type ZhihuHotObservationListItem = {
  sourceItemId: string;
  rank: number;
  title: string;
  url: string;
  heatText: string | null;
  excerpt: string | null;
  collectedAt: string;
};

export type ZhihuHotObservationList = {
  businessDate: string | null;
  collectedAt: string | null;
  sourceUrl: typeof ZHIHU_HOT_URL;
  items: ZhihuHotObservationListItem[];
  latestScan: { status: 'succeeded' | 'failed' | 'needs_user'; checkedAt: string; errorMessage: string | null } | null;
};

/** Read the newest locally persisted batch for exactly one official category URL. */
export function listZhihuTopicCategoryObservations(database: DatabaseSync, category: string = 'discussion', limit = 50): ZhihuTopicCategorySnapshot {
  const normalizedCategory = normalizeZhihuTopicCategory(category);
  const definition = zhihuTopicCategoryDefinition(normalizedCategory);
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
  const latestDate = database.prepare('SELECT MAX(business_date) AS businessDate FROM zhihu_hot_observations WHERE evidence_url=?').get(definition.url) as { businessDate: string | null };
  const latestScan = database.prepare(`SELECT status, checked_at AS checkedAt, error_message AS errorMessage
    FROM source_scan_receipts WHERE module='zhihu_hot' ORDER BY checked_at DESC, updated_at DESC LIMIT 1`).get() as
    | { status: 'succeeded' | 'failed' | 'needs_user'; checkedAt: string; errorMessage: string | null }
    | undefined;
  if (definition.kind === 'summary' || !latestDate.businessDate) {
    return { category: normalizedCategory, businessDate: null, items: [], summary: null, evidenceUrl: definition.url, collectedAt: null, latestScan: latestScan ?? null };
  }
  const rawItems = database.prepare(`WITH valid AS (
      SELECT o.source_item_id AS sourceItemId, o.rank, o.question_title_snapshot AS title,
        COALESCE(si.canonical_url, o.question_url_snapshot) AS url, o.heat_text AS heatText,
        o.excerpt_snapshot AS excerpt, o.collected_at AS collectedAt,
        ROW_NUMBER() OVER (PARTITION BY o.source_item_id ORDER BY o.collected_at DESC, o.created_at DESC) AS recency
      FROM zhihu_hot_observations o JOIN source_items si ON si.id=o.source_item_id
      WHERE o.business_date=? AND o.evidence_url=? AND LENGTH(TRIM(o.question_title_snapshot)) > 1
    )
    SELECT sourceItemId, rank, title, url, heatText, excerpt, collectedAt
    FROM valid WHERE recency=1 ORDER BY rank ASC, collectedAt DESC LIMIT ?`).all(latestDate.businessDate, definition.url, boundedLimit) as ZhihuHotObservationListItem[];
  const items: ZhihuTopicCategoryItem[] = rawItems.map((item) => {
    const canonicalUrl = canonicalizeZhihuQuestionUrl(item.url) ?? item.url;
    return {
      sourceItemId: item.sourceItemId,
      rank: item.rank,
      title: item.title,
      url: item.url,
      questionUrl: item.url,
      canonicalUrl,
      questionId: zhihuQuestionIdFromCanonical(canonicalUrl) ?? '',
      heatText: item.heatText,
      excerpt: item.excerpt,
      collectedAt: item.collectedAt
    };
  });
  return {
    businessDate: latestDate.businessDate,
    category: normalizedCategory,
    items,
    summary: null,
    evidenceUrl: definition.url,
    collectedAt: items.reduce<string | null>((latest, item) => {
      const sourceItem = rawItems.find((candidate) => candidate.sourceItemId === item.sourceItemId);
      return sourceItem && (!latest || sourceItem.collectedAt > latest) ? sourceItem.collectedAt : latest;
    }, null),
    latestScan: latestScan ?? null
  };
}

/** Backward-compatible discussion projection used by the daily scheduler and existing Discover consumers. */
export function listZhihuHotObservations(database: DatabaseSync, limit = 50): ZhihuHotObservationList {
  const category = listZhihuTopicCategoryObservations(database, 'discussion', limit);
  return {
    businessDate: category.businessDate,
    collectedAt: category.collectedAt,
    sourceUrl: ZHIHU_HOT_URL,
    items: category.items.filter((item): item is ZhihuTopicCategoryItem & { sourceItemId: string } => Boolean(item.sourceItemId)).map((item) => ({
      sourceItemId: item.sourceItemId,
      rank: item.rank,
      title: item.title,
      url: item.url,
      heatText: item.heatText,
      excerpt: item.excerpt,
      collectedAt: category.collectedAt ?? ''
    })),
    latestScan: category.latestScan
  };
}

// Persistence: upsert Source + observation in one serialized write boundary
export function persistZhihuHotScan(
  database: DatabaseSync,
  input: { taskId: string; workspaceId: string; businessDate: string; evidenceUrl: string; collectedAt: string },
  items: ZhihuHotItem[]
): { sourceIds: string[]; observations: number; feedId: string } {
  const feed = ensureRegistrySourceFeed(database, { registryId: 'zhihu_hot', name: '知乎 AI 专题', url: ZHIHU_HOT_URL });
  const feedId = feed.id;
  const sourceIds: string[] = [];
  let observations = 0;
  // Use outer transaction if not already in one
  const wasInTx = false; // dispatchBusinessCommand wraps in dispatcher transaction; here we just run immediate writes
  // For atomicity per spec: caller should have dispatchBusinessCommand transaction; we just do sequential ops which are within that dispatcher tx
  for (const item of items) {
    const up = upsertSource(database, {
      feedId,
      originalUrl: item.canonicalUrl,
      title: item.title,
      summary: item.excerpt ?? item.heatText ?? undefined,
      evidence: item.canonicalUrl,
      categories: ['zhihu_hot'],
      keywords: [],
      valueJudgment: undefined
    }, false);
    sourceIds.push(up.id);
    const fingerprint = fingerprintForZhihuObservation({
      canonicalUrl: item.canonicalUrl,
      title: item.title,
      rank: item.rank,
      heatText: item.heatText,
      excerpt: item.excerpt
    });
    const now = new Date().toISOString();
    // Insert observation deduped by UNIQUE(source_item_id, business_date, input_fingerprint)
    try {
      database.prepare(`INSERT INTO zhihu_hot_observations
        (id, source_item_id, business_date, rank, heat_text, question_title_snapshot, question_url_snapshot, excerpt_snapshot, evidence_url, collected_at, scan_task_id, input_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(),
        up.id,
        input.businessDate,
        item.rank,
        item.heatText,
        item.title,
        item.canonicalUrl,
        item.excerpt,
        input.evidenceUrl,
        input.collectedAt,
        input.taskId,
        fingerprint,
        now
      );
      observations += 1;
    } catch (e) {
      // Duplicate fingerprint -> ignore (idempotent)
      const msg = String((e as Error).message ?? '');
      if (msg.includes('UNIQUE') || msg.includes('constraint')) {
        continue;
      }
      throw e;
    }
  }
  return { sourceIds, observations, feedId };
}

// High-level scan+receipt that caller wraps in dispatchBusinessCommand
export function commitZhihuHotScan(
  database: DatabaseSync,
  taskInput: { taskId: string; workspaceId: string; businessDate: string },
  read: ZhihuHotRead
): { sourceIds: string[]; candidateCount: number; savedCount: number; feedId: string } {
  const persisted = persistZhihuHotScan(database, {
    taskId: taskInput.taskId,
    workspaceId: taskInput.workspaceId,
    businessDate: taskInput.businessDate,
    evidenceUrl: read.evidenceUrl,
    collectedAt: read.collectedAt
  }, read.items);
  const receipt = recordSourceScanReceipt(database, {
    taskId: taskInput.taskId,
    workspaceId: taskInput.workspaceId,
    module: 'zhihu_hot',
    sourceId: 'zhihu_hot',
    sourceFeedId: persisted.feedId,
    status: 'succeeded',
    candidateCount: read.items.length,
    savedCount: persisted.sourceIds.length
  });
  void receipt;
  return { sourceIds: persisted.sourceIds, candidateCount: read.items.length, savedCount: persisted.sourceIds.length, feedId: persisted.feedId };
}
