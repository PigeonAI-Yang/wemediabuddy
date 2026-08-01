import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BrowserConfig } from './browser.ts';
import { ensurePyaireaderXBrowser } from './browser.ts';
import { ensureRegistrySourceFeed, upsertSource } from './sources.ts';
import { collectBoundXListTimeline } from './x-list-execution.ts';
import { readXListTimelineCache, type XListTimelineCachePost } from './x-list-timeline-cache.ts';
import { listXListBindings, type XListBinding } from './x-lists.ts';

const require = createRequire(import.meta.url);

export const AI_FRONTIER_LIST_ID = '2082851520417255750';

export type WireSourceHealth = {
  ok: boolean;
  at: string;
  error?: string;
  saved?: number;
};

export type WireCheckpoint = {
  completedRoutes?: string[];
  completedListIds?: string[];
  completedSourceIds?: string[];
  sourceHealth?: Record<string, WireSourceHealth>;
};

export type PrimaryReleaseSource = {
  id: string;
  name: string;
  url: string;
  collector: string;
  fallbackUrls: string[];
};

type SourceIndexEntry = {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  collector?: unknown;
  enabled?: unknown;
  trust_level?: unknown;
  roles?: unknown;
  fallback_urls?: unknown;
  fallbackUrls?: unknown;
};

const OFFICIAL_FETCH_TIMEOUT_MS = 15_000;
const OFFICIAL_ITEMS_PER_SOURCE = 8;
const OFFICIAL_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function loadPrimaryReleaseSources(skillRoot: string): PrimaryReleaseSource[] {
  const indexPath = path.join(skillRoot, 'references', 'source-index.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
  } catch {
    return [];
  }
  const sources = Array.isArray((raw as { sources?: unknown })?.sources)
    ? (raw as { sources: SourceIndexEntry[] }).sources
    : [];
  const out: PrimaryReleaseSource[] = [];
  for (const entry of sources) {
    if (entry?.enabled !== true) continue;
    if (entry.trust_level !== 'primary') continue;
    const roles = Array.isArray(entry.roles) ? entry.roles.filter((role): role is string => typeof role === 'string') : [];
    if (!roles.includes('release')) continue;
    if (typeof entry.id !== 'string' || !entry.id.trim()) continue;
    if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
    if (typeof entry.url !== 'string' || !entry.url.trim()) continue;
    const fallbackUrls = readStringList(entry.fallback_urls ?? entry.fallbackUrls)
      .map((value) => value.trim())
      .filter((value) => value && value !== entry.url.trim());
    // Built-in escape hatch for known Cloudflare-gated OpenAI platform docs.
    if (entry.id.trim() === 'openai-changelog') {
      for (const extra of [
        'https://developers.openai.com/api/docs/changelog.md',
        'https://developers.openai.com/api/docs/changelog'
      ]) {
        if (!fallbackUrls.includes(extra) && extra !== entry.url.trim()) fallbackUrls.push(extra);
      }
    }
    out.push({
      id: entry.id.trim(),
      name: entry.name.trim(),
      url: entry.url.trim(),
      collector: typeof entry.collector === 'string' && entry.collector.trim() ? entry.collector.trim() : 'official-web',
      fallbackUrls
    });
  }
  return out;
}

export function mergeWireCheckpoint(existing: unknown, patch: Partial<WireCheckpoint>): WireCheckpoint {
  const base = asWireCheckpoint(existing);
  return {
    completedRoutes: uniqueStrings([...(base.completedRoutes ?? []), ...(patch.completedRoutes ?? [])]),
    completedListIds: uniqueStrings([...(base.completedListIds ?? []), ...(patch.completedListIds ?? [])]),
    completedSourceIds: uniqueStrings([...(base.completedSourceIds ?? []), ...(patch.completedSourceIds ?? [])]),
    sourceHealth: {
      ...(base.sourceHealth ?? {}),
      ...(patch.sourceHealth ?? {})
    }
  };
}

export async function runEnabledXListWire(input: {
  database: DatabaseSync;
  browserConfig: BrowserConfig | null;
  checkpoint: WireCheckpoint;
  onProgress: (msg: string, checkpoint: WireCheckpoint) => void;
}): Promise<{ checkpoint: WireCheckpoint; sourceIds: string[] }> {
  let checkpoint = asWireCheckpoint(input.checkpoint);
  const completed = new Set(checkpoint.completedListIds ?? []);
  const bindings = orderEnabledBindings(listXListBindings(input.database).filter((binding) => binding.enabled));
  const sourceIds: string[] = [];
  const xListConfig = input.browserConfig
    ? { id: input.browserConfig.id, cdpUrl: input.browserConfig.cdpUrl }
    : null;

  for (const binding of bindings) {
    if (completed.has(binding.listId)) continue;
    const healthKey = `x-list:${binding.listId}`;
    const label = binding.name || binding.listId;
    input.onProgress(`正在巡检 X List：${label}`, checkpoint);
    const at = new Date().toISOString();
    try {
      let savedIds: string[] = [];
      let usedLive = false;
      if (xListConfig) {
        const collected = await collectBoundXListTimeline(input.database, xListConfig, {
          accountKey: binding.accountKey,
          listId: binding.listId,
          limit: 50
        });
        if (collected.ok) {
          savedIds = collected.data.sourceIds;
          usedLive = true;
        } else {
          savedIds = upsertCachedTimelinePosts(input.database, binding);
          if (savedIds.length === 0) {
            throw new Error(collected.error.message);
          }
        }
      } else {
        savedIds = upsertCachedTimelinePosts(input.database, binding);
      }
      sourceIds.push(...savedIds);
      const ok = usedLive || savedIds.length > 0;
      checkpoint = mergeWireCheckpoint(checkpoint, {
        completedListIds: [binding.listId],
        sourceHealth: {
          [healthKey]: {
            ok,
            at,
            saved: savedIds.length,
            ...(ok ? {} : { error: input.browserConfig ? 'live collect failed and cache empty' : 'cache empty' })
          }
        }
      });
    } catch (error) {
      checkpoint = mergeWireCheckpoint(checkpoint, {
        completedListIds: [binding.listId],
        sourceHealth: {
          [healthKey]: {
            ok: false,
            at,
            error: error instanceof Error ? error.message : String(error),
            saved: 0
          }
        }
      });
    }
    completed.add(binding.listId);
    input.onProgress(`完成巡检 X List：${label}`, checkpoint);
  }

  return { checkpoint, sourceIds };
}
export async function runOfficialWebWire(input: {
  database: DatabaseSync;
  skillRoot: string;
  checkpoint: WireCheckpoint;
  onProgress: (msg: string, checkpoint: WireCheckpoint) => void;
  fetchImpl?: typeof fetch;
  browserConfig?: BrowserConfig | null;
}): Promise<{ checkpoint: WireCheckpoint; sourceIds: string[] }> {
  let checkpoint = asWireCheckpoint(input.checkpoint);
  const completed = new Set(checkpoint.completedSourceIds ?? []);
  const sources = loadPrimaryReleaseSources(input.skillRoot);
  const sourceIds: string[] = [];
  const fetchImpl = input.fetchImpl ?? fetch;

  for (const source of sources) {
    if (completed.has(source.id)) continue;
    input.onProgress(`正在巡检官方源：${source.name}`, checkpoint);
    const at = new Date().toISOString();
    try {
      const page = await loadOfficialSourcePage({
        source,
        fetchImpl,
        browserConfig: input.browserConfig ?? null
      });
      const body = page.body;
      const pageTitle = page.title || extractHtmlTitle(body) || source.name;
      const summary = extractTextSnippet(body, 500);
      const feed = ensureRegistrySourceFeed(input.database, {
        registryId: source.id,
        name: source.name,
        url: source.url
      });
      const items = extractOfficialItems(page.finalUrl || source.url, body, OFFICIAL_ITEMS_PER_SOURCE);
      const savedIds: string[] = [];
      if (items.length > 0) {
        for (const item of items) {
          const saved = upsertSource(input.database, {
            feedId: feed.id,
            title: item.title,
            summary: item.summary || summary || pageTitle,
            originalUrl: item.url,
            priority: 1,
            categories: ['official_release', 'release_item'],
            clientLabel: source.id,
            verificationStatus: 'pending',
            managementStatus: 'active',
            evidence: JSON.stringify({
              wire: 'official_web',
              sourceId: source.id,
              collector: source.collector,
              checkedAt: at,
              httpStatus: page.status,
              pageTitle,
              feedId: feed.id,
              itemExtraction: true,
              fetchMode: page.mode,
              fetchedUrl: page.finalUrl
            })
          });
          savedIds.push(saved.id);
        }
      } else {
        const saved = upsertSource(input.database, {
          feedId: feed.id,
          title: `[官宣巡检] ${source.name}`,
          summary: summary || pageTitle,
          originalUrl: source.url,
          priority: 1,
          categories: ['official_release'],
          clientLabel: source.id,
          verificationStatus: 'pending',
          managementStatus: 'active',
          evidence: JSON.stringify({
            wire: 'official_web',
            sourceId: source.id,
            collector: source.collector,
            checkedAt: at,
            httpStatus: page.status,
            pageTitle,
            feedId: feed.id,
            itemExtraction: false,
            fetchMode: page.mode,
            fetchedUrl: page.finalUrl
          })
        });
        savedIds.push(saved.id);
      }
      sourceIds.push(...savedIds);
      checkpoint = mergeWireCheckpoint(checkpoint, {
        completedSourceIds: [source.id],
        sourceHealth: {
          [source.id]: { ok: true, at, saved: savedIds.length }
        }
      });
    } catch (error) {
      checkpoint = mergeWireCheckpoint(checkpoint, {
        completedSourceIds: [source.id],
        sourceHealth: {
          [source.id]: {
            ok: false,
            at,
            error: error instanceof Error ? error.message : String(error),
            saved: 0
          }
        }
      });
    }
    completed.add(source.id);
    input.onProgress(`完成巡检官方源：${source.name}`, checkpoint);
  }

  return { checkpoint, sourceIds };
}

function orderEnabledBindings(bindings: XListBinding[]): XListBinding[] {
  return [...bindings].sort((left, right) => preferenceScore(left) - preferenceScore(right));
}

function preferenceScore(binding: XListBinding): number {
  if (binding.listId === AI_FRONTIER_LIST_ID) return 0;
  if (binding.name.includes('AI前沿')) return 0;
  if (/AI博主|AI测评|AI薅羊毛|赚钱信息差/.test(binding.name)) return 1;
  if (/AI|模型|Agent/.test(binding.name)) return 2;
  return 3;
}

function upsertCachedTimelinePosts(database: DatabaseSync, binding: XListBinding): string[] {
  const cache = readXListTimelineCache(database, binding.accountKey, binding.listId, { touch: true });
  if (!cache || cache.payload.posts.length === 0) return [];
  return cache.payload.posts.map((post) => upsertTimelinePost(database, binding, post, {
    listId: binding.listId,
    listUrl: binding.canonicalUrl,
    collectedAt: new Date().toISOString(),
    fromCache: true,
    cacheFetchedAt: cache.fetchedAt,
    cacheSource: cache.source
  }));
}

function upsertTimelinePost(
  database: DatabaseSync,
  binding: XListBinding,
  post: XListTimelineCachePost,
  evidence: Record<string, unknown>
): string {
  return upsertSource(database, {
    feedId: binding.sourceFeedId,
    originalUrl: post.url,
    title: post.text.replace(/\s+/g, ' ').slice(0, 180) || `${binding.name} 动态`,
    author: post.authorHandle ?? undefined,
    publishedAt: post.postedAt ?? undefined,
    summary: post.text,
    evidence: JSON.stringify(evidence)
  }).id;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': OFFICIAL_BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        'cache-control': 'no-cache',
        pragma: 'no-cache'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function isBlockedChallengePage(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    // Some CDNs return soft-block HTML with 200; still inspect body below.
  }
  const sample = body.slice(0, 4000);
  return /attention required|just a moment|cf-browser-verification|cdn-cgi\/challenge|cloudflare/i.test(sample)
    && /captcha|challenge|blocked|access denied|attention required|just a moment/i.test(sample);
}

function describeFetchBlock(url: string, status: number, body: string): string {
  const sample = body.slice(0, 4000);
  const title = extractHtmlTitle(body);
  if (/cloudflare|attention required|just a moment|cf-browser-verification|cdn-cgi\/challenge/i.test(`${title}\n${sample}`)) {
    return `HTTP ${status} Cloudflare/challenge blocked (${safeHost(url)})`;
  }
  if (status === 403) return `HTTP 403 forbidden (${safeHost(url)})`;
  if (status === 401) return `HTTP 401 unauthorized (${safeHost(url)})`;
  if (status === 429) return `HTTP 429 rate limited (${safeHost(url)})`;
  if (!status) return `fetch failed (${safeHost(url)})`;
  return `HTTP ${status} (${safeHost(url)})`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown-host';
  }
}

type OfficialPageLoad = {
  body: string;
  title: string;
  status: number;
  finalUrl: string;
  mode: 'fetch' | 'browser';
};

async function loadOfficialSourcePage(input: {
  source: PrimaryReleaseSource;
  fetchImpl: typeof fetch;
  browserConfig: BrowserConfig | null;
}): Promise<OfficialPageLoad> {
  const candidates = uniqueStrings([input.source.url, ...input.source.fallbackUrls]);
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const response = await fetchWithTimeout(input.fetchImpl, candidate, OFFICIAL_FETCH_TIMEOUT_MS);
      const body = await response.text();
      if (!response.ok || isBlockedChallengePage(response.status, body)) {
        errors.push(describeFetchBlock(candidate, response.status, body));
        continue;
      }
      return {
        body,
        title: extractHtmlTitle(body),
        status: response.status,
        finalUrl: response.url || candidate,
        mode: 'fetch'
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (input.browserConfig) {
    for (const candidate of candidates) {
      try {
        const browserPage = await fetchOfficialPageViaBrowser(input.browserConfig, candidate);
        if (browserPage) return browserPage;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  throw new Error(errors[errors.length - 1] || `official source blocked (${input.source.id})`);
}

async function fetchOfficialPageViaBrowser(browserConfig: BrowserConfig, url: string): Promise<OfficialPageLoad | null> {
  const runtime = await ensurePyaireaderXBrowser(browserConfig, { mode: 'quiet' });
  const { chromium } = require('playwright-core') as typeof import('playwright-core');
  const browser = await chromium.connectOverCDP(runtime.cdpUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) return null;
    const page = await context.newPage();
    try {
      // Prefer markdown mirror when docs site exposes it.
      const mdUrl = url.endsWith('.md') ? url : (/changelog/i.test(url) ? `${url.replace(/\/$/, '')}.md` : null);
      const order = mdUrl && mdUrl !== url ? [mdUrl, url] : [url];
      let lastError = '';
      for (const target of order) {
        try {
          const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await page.waitForTimeout(3_500);
          const body = await page.evaluate(() => {
            const pre = document.querySelector('pre');
            if (pre?.innerText && pre.innerText.trim().length > 80) return pre.innerText;
            // Some docs apps mount markdown into article/main rather than pre.
            const main = document.querySelector('article, main, [role="main"]') as HTMLElement | null;
            const text = (main?.innerText || document.body?.innerText || '').trim();
            if (text.length > 80) return text;
            return document.documentElement?.outerHTML || '';
          });
          const title = await page.title().catch(() => '');
          const status = response?.status() ?? 200;
          if (!body || isBlockedChallengePage(status, body) || /403:\s*forbidden/i.test(title)) {
            lastError = describeFetchBlock(target, status, body || title);
            continue;
          }
          if (/changelog/i.test(target) && !/(update\s*·|model:|api:|jul |jan |feb |mar |apr |may |jun |aug |sep |oct |nov |dec )/i.test(body)) {
            lastError = `changelog body incomplete (${safeHost(target)})`;
            continue;
          }
          return {
            body,
            title,
            status,
            finalUrl: page.url() || target,
            mode: 'browser'
          };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (lastError) throw new Error(lastError);
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

export function extractOfficialItems(pageUrl: string, body: string, limit = OFFICIAL_ITEMS_PER_SOURCE): ReleaseItemCandidate[] {
  // Changelog/docs pages are denser as plain text/markdown than as anchor soup.
  const markdownFirst = /changelog|\.md(?:$|\?)|latest features and updates/i.test(`${pageUrl}\n${body.slice(0, 400)}`);
  if (markdownFirst) {
    const mdItems = extractMarkdownChangelogItems(pageUrl, body, limit);
    if (mdItems.length > 0) return mdItems;
  }
  const htmlItems = extractReleaseItems(pageUrl, body, limit);
  if (htmlItems.length > 0) return htmlItems;
  return extractMarkdownChangelogItems(pageUrl, body, limit);
}

function extractMarkdownChangelogItems(pageUrl: string, text: string, limit = OFFICIAL_ITEMS_PER_SOURCE): ReleaseItemCandidate[] {
  const plain = text.replace(/\r/g, '\n').replace(/\u00a0/g, ' ');
  if (!/(changelog|update ·|model:|api:|jul |jan |feb |mar |apr |may |jun |aug |sep |oct |nov |dec )/i.test(plain)) return [];
  const lines = plain.split('\n').map((line) => line.trim()).filter(Boolean);
  const out: ReleaseItemCandidate[] = [];
  const dateRe = /^(?:#{1,6}\s*)?(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?(?:\b(.*))?$/i;
  for (let i = 0; i < lines.length && out.length < limit; i += 1) {
    const line = lines[i] || '';
    const dateMatch = line.match(dateRe);
    if (!dateMatch) continue;
    const detailParts: string[] = [];
    const sameLineDetail = (dateMatch[4] || '').replace(/^[-–—:\s]+/, '').trim();
    if (sameLineDetail) detailParts.push(sameLineDetail);
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      const next = lines[j] || '';
      if (dateRe.test(next)) break;
      if (/^(January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4}$/i.test(next)) break;
      if (/^(home|api|docs|overview|resources|dashboard)$/i.test(next)) continue;
      if (/^#{1,6}\s+/.test(next) && !/update|model|api|feature|release/i.test(next)) break;
      detailParts.push(next.replace(/^[-*•]\s+/, ''));
      if (detailParts.join(' ').length > 220) break;
    }
    const detail = detailParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!detail || detail.length < 12) continue;
    if (/^(upcoming deprecations|for the complete documentation index)/i.test(detail)) continue;
    const stamp = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3] || 'current'}-${out.length + 1}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    const itemUrl = (() => {
      try {
        const url = new URL(pageUrl);
        url.searchParams.set('wmb_item', stamp);
        return url.toString();
      } catch {
        return `${pageUrl}?wmb_item=${encodeURIComponent(stamp)}`;
      }
    })();
    out.push({
      url: itemUrl,
      title: `${dateMatch[1]} ${dateMatch[2]}${dateMatch[3] ? `, ${dateMatch[3]}` : ''} · ${detail}`.slice(0, 180),
      summary: detail.slice(0, 500)
    });
  }
  return out;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return decodeBasicEntities(match[1]).replace(/\s+/g, ' ').trim();
}

type ReleaseItemCandidate = {
  url: string;
  title: string;
  summary?: string;
};

export function extractReleaseItems(pageUrl: string, html: string, limit = OFFICIAL_ITEMS_PER_SOURCE): ReleaseItemCandidate[] {
  const base = safeUrl(pageUrl);
  if (!base) return [];
  const seen = new Set<string>();
  const out: ReleaseItemCandidate[] = [];
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) && out.length < limit) {
    const href = decodeBasicEntities(match[1] || '').trim();
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/i.test(absolute.protocol)) continue;
    if (absolute.hostname.replace(/^www\./i, '') !== base.hostname.replace(/^www\./i, '')) continue;
    absolute.hash = '';
    // Drop pure homepages and obvious nav endpoints.
    const pathName = absolute.pathname.replace(/\/+$/, '') || '/';
    if (pathName === '/' || pathName === base.pathname.replace(/\/+$/, '')) continue;
    if (!looksLikeReleasePath(pathName, base.pathname)) continue;
    const normalized = absolute.toString();
    if (seen.has(normalized)) continue;
    const rawTitle = decodeBasicEntities(stripTags(match[2] || '')).replace(/\s+/g, ' ').trim();
    if (!rawTitle || rawTitle.length < 6) continue;
    if (isLowSignalLinkTitle(rawTitle)) continue;
    seen.add(normalized);
    out.push({
      url: normalized,
      title: rawTitle.slice(0, 180),
      summary: rawTitle.slice(0, 500)
    });
  }
  return out;
}

function looksLikeReleasePath(pathName: string, basePath: string): boolean {
  const path = pathName.toLowerCase();
  const base = (basePath || '/').toLowerCase().replace(/\/+$/, '') || '/';
  if (path.split('/').filter(Boolean).length < 2 && !/(changelog|blog|news|posts|releases|updates|research|papers)/i.test(path)) {
    // Single-segment paths are usually nav: /about /careers
    if (!/(changelog|blog|news|posts|releases|updates)/i.test(path)) return false;
  }
  if (/(login|signin|signup|careers|jobs|about|privacy|terms|cookies|support|help|contact|legal|brand|press-kit)/i.test(path)) return false;
  // Prefer article-like paths, including those under the source section.
  if (/(changelog|blog|news|posts|releases|updates|research|papers|product|announc)/i.test(path)) return true;
  if (base !== '/' && path.startsWith(`${base}/`) && path.length > base.length + 2) return true;
  // GitHub repo root links to releases/tags/issues etc.
  if (/^\/[^/]+\/[^/]+\/(releases|tags|commits|discussions|tree|blob)\b/i.test(path)) return true;
  return path.split('/').filter(Boolean).length >= 3;
}

function isLowSignalLinkTitle(title: string): boolean {
  const value = title.toLowerCase();
  if (title.length > 160) return true;
  return /^(home|about|careers|privacy|terms|login|sign in|sign up|subscribe|read more|learn more|docs|documentation|api reference|contact|cookie|back|next|previous)$/i.test(value)
    || /^(阅读更多|了解更多|首页|关于|加入我们|隐私|条款|登录|注册|文档|联系我们)$/i.test(title.trim());
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function extractTextSnippet(html: string, maxChars: number): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const text = decodeBasicEntities(withoutScripts.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.slice(0, maxChars);
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function asWireCheckpoint(value: unknown): WireCheckpoint {
  if (!value || typeof value !== 'object') {
    return {
      completedRoutes: [],
      completedListIds: [],
      completedSourceIds: [],
      sourceHealth: {}
    };
  }
  const record = value as Record<string, unknown>;
  return {
    completedRoutes: asStringArray(record.completedRoutes),
    completedListIds: asStringArray(record.completedListIds),
    completedSourceIds: asStringArray(record.completedSourceIds),
    sourceHealth: asSourceHealthMap(record.sourceHealth)
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === 'string'));
}

function asSourceHealthMap(value: unknown): Record<string, WireSourceHealth> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, WireSourceHealth> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.ok !== 'boolean' || typeof row.at !== 'string') continue;
    out[key] = {
      ok: row.ok,
      at: row.at,
      ...(typeof row.error === 'string' ? { error: row.error } : {}),
      ...(typeof row.saved === 'number' && Number.isFinite(row.saved) ? { saved: row.saved } : {})
    };
  }
  return out;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
