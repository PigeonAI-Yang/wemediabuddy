import { createRequire } from 'node:module';
import type { BrowserConfig } from './browser.ts';
import { ensurePyaireaderXBrowser } from './browser.ts';
import {
  OFFICIAL_FETCH_TIMEOUT_MS, OFFICIAL_ITEMS_PER_SOURCE, describeFetchBlock, fetchWithTimeout,
  isBlockedChallengePage, safeHost,
  type PrimaryReleaseSource, type WireCheckpoint, type WireSourceHealth
} from './intelligence-wire.ts';

const require = createRequire(import.meta.url);

type OfficialPageLoad = {
  body: string;
  title: string;
  status: number;
  finalUrl: string;
  mode: 'fetch' | 'browser';
};

export async function loadOfficialSourcePage(input: {
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

export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}

export function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return decodeBasicEntities(match[1]).replace(/\s+/g, ' ').trim();
}

export type ReleaseItemCandidate = {
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

export function extractTextSnippet(html: string, maxChars: number): string {
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

export function asWireCheckpoint(value: unknown): WireCheckpoint {
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

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
