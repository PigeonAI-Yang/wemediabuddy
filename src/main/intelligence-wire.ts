import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BrowserConfig } from './browser.ts';
import {
  asWireCheckpoint, extractHtmlTitle, extractOfficialItems, extractTextSnippet, loadOfficialSourcePage,
  readStringList, uniqueStrings
} from './intelligence-wire-pages.ts';
export { extractOfficialItems, extractReleaseItems } from './intelligence-wire-pages.ts';
import { ensureRegistrySourceFeed, upsertSource } from './sources.ts';
import { collectBoundXListTimeline } from './x-list-execution.ts';
import { readXListTimelineCache, type XListTimelineCachePost } from './x-list-timeline-cache.ts';
import { listXListBindings, type XListBinding } from './x-lists.ts';


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

export const OFFICIAL_FETCH_TIMEOUT_MS = 15_000;
export const OFFICIAL_ITEMS_PER_SOURCE = 8;
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
    const url = entry.url.trim();
    const fallbackUrls = readStringList(entry.fallback_urls ?? entry.fallbackUrls)
      .map((value) => value.trim())
      .filter((value) => value && value !== url);
    // Built-in escape hatch for known Cloudflare-gated OpenAI platform docs.
    if (entry.id.trim() === 'openai-changelog') {
      for (const extra of [
        'https://developers.openai.com/api/docs/changelog.md',
        'https://developers.openai.com/api/docs/changelog'
      ]) {
        if (!fallbackUrls.includes(extra) && extra !== url) fallbackUrls.push(extra);
      }
    }
    out.push({
      id: entry.id.trim(),
      name: entry.name.trim(),
      url,
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
    evidence: JSON.stringify({
      ...evidence,
      avatarUrl: post.avatarUrl ?? (typeof evidence.avatarUrl === 'string' ? evidence.avatarUrl : null),
      displayName: post.displayName ?? (typeof evidence.displayName === 'string' ? evidence.displayName : null)
    })
  }).id;
}

export async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
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

export function isBlockedChallengePage(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    // Some CDNs return soft-block HTML with 200; still inspect body below.
  }
  const sample = body.slice(0, 4000);
  return /attention required|just a moment|cf-browser-verification|cdn-cgi\/challenge|cloudflare/i.test(sample)
    && /captcha|challenge|blocked|access denied|attention required|just a moment/i.test(sample);
}

export function describeFetchBlock(url: string, status: number, body: string): string {
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

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown-host';
  }
}
