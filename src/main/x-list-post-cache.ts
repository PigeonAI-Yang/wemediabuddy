import type { XListPostDetail } from './platforms/x-list-browser.ts';

const POST_DETAIL_TTL_MS = 10 * 60_000;
const POST_DETAIL_MAX = 80;

type CacheEntry = {
  value: { accountKey: string; post: XListPostDetail };
  fetchedAt: number;
  lastAccessedAt: number;
};

const cache = new Map<string, CacheEntry>();

function normalizeKey(statusUrl: string): string | null {
  try {
    const url = new URL(statusUrl);
    if (!/^(?:www\.)?(?:x|twitter)\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    if (!match) return null;
    return `https://x.com/${match[1]}/status/${match[2]}`.toLowerCase();
  } catch {
    return null;
  }
}

export function readXListPostCache(statusUrl: string): { accountKey: string; post: XListPostDetail; fetchedAt: string; stale: boolean } | null {
  const key = normalizeKey(statusUrl);
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.fetchedAt;
  if (age > POST_DETAIL_TTL_MS) {
    cache.delete(key);
    return null;
  }
  entry.lastAccessedAt = Date.now();
  return {
    accountKey: entry.value.accountKey,
    post: entry.value.post,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    stale: age > POST_DETAIL_TTL_MS / 2
  };
}

export function writeXListPostCache(statusUrl: string, value: { accountKey: string; post: XListPostDetail }): void {
  const key = normalizeKey(statusUrl);
  if (!key) return;
  const now = Date.now();
  cache.set(key, { value, fetchedAt: now, lastAccessedAt: now });
  if (cache.size <= POST_DETAIL_MAX) return;
  const ordered = [...cache.entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
  const overflow = ordered.slice(0, Math.max(0, cache.size - POST_DETAIL_MAX));
  for (const [itemKey] of overflow) cache.delete(itemKey);
}

export function clearXListPostCache(): number {
  const count = cache.size;
  cache.clear();
  return count;
}
