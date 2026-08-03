import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const X_LIST_TIMELINE_CACHE_SCHEMA_VERSION = 2;
export const X_LIST_TIMELINE_CACHE_LIMITS = {
  maxPosts: 50,
  maxTextChars: 12_000,
  maxPayloadBytes: 256 * 1024,
  maxRowsPerAccount: 30,
  maxRowsGlobal: 80,
  softTtlMs: 12 * 60 * 60 * 1_000,
  emptyTtlMs: 45 * 60 * 1_000,
  accessTouchMinMs: 10 * 60 * 1_000,
  futureSkewMs: 5 * 60 * 1_000
} as const;

export type XListTimelineCachePost = {
  url: string;
  authorHandle: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  text: string;
  postedAt: string | null;
  images?: string[];
  imageThumbs?: string[];
  hasVideo?: boolean;
  videoPoster?: string | null;
  videoUrl?: string | null;
  postKind?: 'tweet' | 'repost' | 'quote';
  repostedBy?: { handle: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
  quotedPost?: XListTimelineCachePost | null;
  metrics?: {
    replies?: number | null;
    reposts?: number | null;
    likes?: number | null;
    bookmarks?: number | null;
    views?: number | null;
  };
};

export type XListTimelineCachePayload = {
  accountKey: string;
  listId: string;
  detail?: { name?: string; canonicalUrl?: string } | null;
  posts: XListTimelineCachePost[];
};

export type XListTimelineCacheRecord = {
  accountKey: string;
  listId: string;
  payload: XListTimelineCachePayload;
  postsCount: number;
  payloadBytes: number;
  fetchedAt: string;
  lastAccessedAt: string;
  source: 'live' | 'collect';
  schemaVersion: number;
  fingerprint: string;
  stale: boolean;
};

type CacheRow = {
  account_key: string;
  list_id: string;
  payload_json: string;
  posts_count: number;
  payload_bytes: number;
  fetched_at: string;
  last_accessed_at: string;
  source: string;
  schema_version: number;
  fingerprint: string;
};

export function readXListTimelineCache(
  database: DatabaseSync,
  accountKey: string,
  listId: string,
  options: { touch?: boolean; now?: Date } = {}
): XListTimelineCacheRecord | null {
  const row = database.prepare(`
    SELECT account_key, list_id, payload_json, posts_count, payload_bytes, fetched_at, last_accessed_at, source, schema_version, fingerprint
    FROM x_list_timeline_cache
    WHERE account_key = ? AND list_id = ?
  `).get(accountKey, listId) as CacheRow | undefined;
  if (!row) return null;
  const parsed = parseRow(row, options.now ?? new Date());
  if (!parsed) {
    database.prepare('DELETE FROM x_list_timeline_cache WHERE account_key = ? AND list_id = ?').run(accountKey, listId);
    return null;
  }
  if (options.touch !== false) touchAccess(database, parsed, options.now ?? new Date());
  return parsed;
}

export function writeXListTimelineCache(
  database: DatabaseSync,
  input: {
    accountKey: string;
    listId: string;
    posts: XListTimelineCachePost[];
    detail?: { name?: string; canonicalUrl?: string } | null;
    source: 'live' | 'collect';
    fetchedAt?: string;
  }
): XListTimelineCacheRecord {
  const now = new Date();
  const fetchedAt = normalizeTimestamp(input.fetchedAt) ?? now.toISOString();
  const payload = normalizePayload({
    accountKey: input.accountKey,
    listId: input.listId,
    detail: input.detail ?? null,
    posts: input.posts
  });
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
  if (payloadBytes > X_LIST_TIMELINE_CACHE_LIMITS.maxPayloadBytes) {
    throw new Error('List 浏览缓存单条过大。');
  }
  const fingerprint = fingerprintPosts(payload.posts);

  const existing = database.prepare(`
    SELECT payload_json, fingerprint, last_accessed_at FROM x_list_timeline_cache WHERE account_key = ? AND list_id = ?
  `).get(input.accountKey, input.listId) as { payload_json: string; fingerprint: string; last_accessed_at: string } | undefined;

  if (existing?.fingerprint === fingerprint && existing.payload_json === payloadJson) {
    database.prepare(`
      UPDATE x_list_timeline_cache
      SET fetched_at = ?, last_accessed_at = ?, source = ?, posts_count = ?, payload_bytes = ?, schema_version = ?
      WHERE account_key = ? AND list_id = ?
    `).run(
      fetchedAt,
      now.toISOString(),
      input.source,
      payload.posts.length,
      payloadBytes,
      X_LIST_TIMELINE_CACHE_SCHEMA_VERSION,
      input.accountKey,
      input.listId
    );
  } else {
    database.prepare(`
      INSERT INTO x_list_timeline_cache (
        account_key, list_id, payload_json, posts_count, payload_bytes, fetched_at, last_accessed_at, source, schema_version, fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_key, list_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        posts_count = excluded.posts_count,
        payload_bytes = excluded.payload_bytes,
        fetched_at = excluded.fetched_at,
        last_accessed_at = excluded.last_accessed_at,
        source = excluded.source,
        schema_version = excluded.schema_version,
        fingerprint = excluded.fingerprint
    `).run(
      input.accountKey,
      input.listId,
      payloadJson,
      payload.posts.length,
      payloadBytes,
      fetchedAt,
      now.toISOString(),
      input.source,
      X_LIST_TIMELINE_CACHE_SCHEMA_VERSION,
      fingerprint
    );
  }
  enforceXListTimelineCacheCaps(database, now);
  const record = readXListTimelineCache(database, input.accountKey, input.listId, { touch: false, now });
  if (record) return record;
  // Empty snapshots past empty-TTL are intentionally dropped by enforce; treat as successful no-op.
  if (payload.posts.length === 0) {
    return {
      accountKey: input.accountKey,
      listId: input.listId,
      payload,
      postsCount: 0,
      payloadBytes,
      fetchedAt,
      lastAccessedAt: now.toISOString(),
      source: input.source,
      schemaVersion: X_LIST_TIMELINE_CACHE_SCHEMA_VERSION,
      fingerprint,
      stale: true
    };
  }
  throw new Error('写入 List 浏览缓存后读取失败。');
}

/** Successful live/collect only. Never call on needs_user / cooldown / parse failure. */
export function writeXListTimelineCacheIfImproved(
  database: DatabaseSync,
  input: {
    accountKey: string;
    listId: string;
    posts: XListTimelineCachePost[];
    detail?: { name?: string; canonicalUrl?: string } | null;
    source: 'live' | 'collect';
    fetchedAt?: string;
  }
): XListTimelineCacheRecord | null {
  const existing = readXListTimelineCache(database, input.accountKey, input.listId, { touch: false });
  if (existing && existing.postsCount > 0 && input.posts.length === 0) {
    // Do not replace a good snapshot with an empty live miss.
    return existing;
  }
  return writeXListTimelineCache(database, input);
}

export function clearXListTimelineCache(database: DatabaseSync, accountKey?: string): { deleted: number } {
  if (accountKey) {
    const result = database.prepare('DELETE FROM x_list_timeline_cache WHERE account_key = ?').run(accountKey);
    return { deleted: Number(result.changes ?? 0) };
  }
  const result = database.prepare('DELETE FROM x_list_timeline_cache').run();
  return { deleted: Number(result.changes ?? 0) };
}

export function summarizeXListTimelineCache(database: DatabaseSync, accountKey?: string): { rows: number; bytes: number; accounts: number } {
  const row = database.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(payload_bytes), 0) AS bytes, COUNT(DISTINCT account_key) AS accounts
    FROM x_list_timeline_cache${accountKey ? ' WHERE account_key = ?' : ''}
  `).get(...(accountKey ? [accountKey] : [])) as { rows: number; bytes: number; accounts: number };
  return { rows: Number(row.rows), bytes: Number(row.bytes), accounts: Number(row.accounts) };
}

export function enforceXListTimelineCacheCaps(database: DatabaseSync, now = new Date()): void {
  // Cheap invalid-row sweep: only inspect rows that can expire/skew without full JSON work first.
  const candidates = database.prepare(`
    SELECT account_key, list_id, payload_json, posts_count, payload_bytes, fetched_at, last_accessed_at, source, schema_version, fingerprint
    FROM x_list_timeline_cache
    WHERE schema_version != ?
       OR source NOT IN ('live', 'collect')
       OR posts_count = 0
       OR fetched_at > ?
  `).all(
    X_LIST_TIMELINE_CACHE_SCHEMA_VERSION,
    new Date(now.getTime() + X_LIST_TIMELINE_CACHE_LIMITS.futureSkewMs).toISOString()
  ) as CacheRow[];
  for (const row of candidates) {
    if (!parseRow(row, now)) {
      database.prepare('DELETE FROM x_list_timeline_cache WHERE account_key = ? AND list_id = ?').run(row.account_key, row.list_id);
    }
  }

  // Per-account LRU only when over cap.
  const accountCounts = database.prepare(`
    SELECT account_key, COUNT(*) AS count FROM x_list_timeline_cache GROUP BY account_key HAVING count > ?
  `).all(X_LIST_TIMELINE_CACHE_LIMITS.maxRowsPerAccount) as Array<{ account_key: string; count: number }>;
  for (const { account_key } of accountCounts) {
    const keep = database.prepare(`
      SELECT list_id FROM x_list_timeline_cache
      WHERE account_key = ?
      ORDER BY last_accessed_at DESC, fetched_at DESC
      LIMIT ?
    `).all(account_key, X_LIST_TIMELINE_CACHE_LIMITS.maxRowsPerAccount) as Array<{ list_id: string }>;
    const kept = new Set(keep.map((item) => item.list_id));
    const accountRows = database.prepare('SELECT list_id FROM x_list_timeline_cache WHERE account_key = ?').all(account_key) as Array<{ list_id: string }>;
    for (const item of accountRows) {
      if (kept.has(item.list_id)) continue;
      database.prepare('DELETE FROM x_list_timeline_cache WHERE account_key = ? AND list_id = ?').run(account_key, item.list_id);
    }
  }

  // Global LRU only when over cap.
  const total = Number((database.prepare('SELECT COUNT(*) AS count FROM x_list_timeline_cache').get() as { count: number }).count);
  if (total <= X_LIST_TIMELINE_CACHE_LIMITS.maxRowsGlobal) return;
  const keepGlobal = database.prepare(`
    SELECT account_key, list_id FROM x_list_timeline_cache
    ORDER BY last_accessed_at DESC, fetched_at DESC
    LIMIT ?
  `).all(X_LIST_TIMELINE_CACHE_LIMITS.maxRowsGlobal) as Array<{ account_key: string; list_id: string }>;
  const keepKeys = new Set(keepGlobal.map((item) => `${item.account_key}\u0000${item.list_id}`));
  const all = database.prepare('SELECT account_key, list_id FROM x_list_timeline_cache').all() as Array<{ account_key: string; list_id: string }>;
  for (const item of all) {
    if (keepKeys.has(`${item.account_key}\u0000${item.list_id}`)) continue;
    database.prepare('DELETE FROM x_list_timeline_cache WHERE account_key = ? AND list_id = ?').run(item.account_key, item.list_id);
  }
}

function touchAccess(database: DatabaseSync, record: XListTimelineCacheRecord, now: Date): void {
  const last = Date.parse(record.lastAccessedAt);
  if (Number.isFinite(last) && now.getTime() - last < X_LIST_TIMELINE_CACHE_LIMITS.accessTouchMinMs) return;
  database.prepare(`
    UPDATE x_list_timeline_cache SET last_accessed_at = ? WHERE account_key = ? AND list_id = ?
  `).run(now.toISOString(), record.accountKey, record.listId);
  record.lastAccessedAt = now.toISOString();
}

function parseRow(row: CacheRow, now: Date): XListTimelineCacheRecord | null {
  if (Number(row.schema_version) !== X_LIST_TIMELINE_CACHE_SCHEMA_VERSION) return null;
  if (row.source !== 'live' && row.source !== 'collect') return null;
  const fetchedAtMs = Date.parse(row.fetched_at);
  if (!Number.isFinite(fetchedAtMs)) return null;
  if (fetchedAtMs > now.getTime() + X_LIST_TIMELINE_CACHE_LIMITS.futureSkewMs) return null;
  const postsCount = Number(row.posts_count);
  if (postsCount === 0 && now.getTime() - fetchedAtMs > X_LIST_TIMELINE_CACHE_LIMITS.emptyTtlMs) return null;
  let payload: XListTimelineCachePayload;
  try {
    payload = normalizePayload(JSON.parse(row.payload_json) as XListTimelineCachePayload);
  } catch {
    return null;
  }
  if (payload.accountKey !== row.account_key || payload.listId !== row.list_id) {
    payload.accountKey = row.account_key;
    payload.listId = row.list_id;
  }
  const stale = now.getTime() - fetchedAtMs > X_LIST_TIMELINE_CACHE_LIMITS.softTtlMs;
  return {
    accountKey: row.account_key,
    listId: row.list_id,
    payload,
    postsCount: payload.posts.length,
    payloadBytes: Number(row.payload_bytes) || Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    fetchedAt: row.fetched_at,
    lastAccessedAt: row.last_accessed_at,
    source: row.source,
    schemaVersion: X_LIST_TIMELINE_CACHE_SCHEMA_VERSION,
    fingerprint: row.fingerprint || fingerprintPosts(payload.posts),
    stale
  };
}

function normalizePayload(value: XListTimelineCachePayload): XListTimelineCachePayload {
  const posts: XListTimelineCachePost[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value.posts) ? value.posts : []) {
    const post = normalizePost(item);
    if (!post || seen.has(post.url)) continue;
    seen.add(post.url);
    posts.push(post);
    if (posts.length >= X_LIST_TIMELINE_CACHE_LIMITS.maxPosts) break;
  }
  // Ensure payload bytes stay under cap by dropping trailing posts if needed.
  let payload: XListTimelineCachePayload = {
    accountKey: String(value.accountKey ?? ''),
    listId: String(value.listId ?? ''),
    detail: value.detail ?? null,
    posts
  };
  while (Buffer.byteLength(JSON.stringify(payload), 'utf8') > X_LIST_TIMELINE_CACHE_LIMITS.maxPayloadBytes && payload.posts.length > 1) {
    payload = { ...payload, posts: payload.posts.slice(0, -1) };
  }
  return payload;
}

function normalizePost(item: XListTimelineCachePost, allowQuote = true): XListTimelineCachePost | null {
  const url = typeof item?.url === 'string' ? item.url.trim() : '';
  if (!url) return null;
  const images = Array.isArray(item.images)
    ? item.images.filter((src): src is string => typeof src === 'string' && /^https?:\/\//i.test(src)).slice(0, 4)
    : [];
  const imageThumbs = Array.isArray(item.imageThumbs)
    ? item.imageThumbs.filter((src): src is string => typeof src === 'string' && /^https?:\/\//i.test(src)).slice(0, 4)
    : images;
  const metrics = item && typeof item.metrics === 'object' && item.metrics
    ? {
      replies: Number.isFinite(Number(item.metrics.replies)) ? Number(item.metrics.replies) : null,
      reposts: Number.isFinite(Number(item.metrics.reposts)) ? Number(item.metrics.reposts) : null,
      likes: Number.isFinite(Number(item.metrics.likes)) ? Number(item.metrics.likes) : null,
      bookmarks: Number.isFinite(Number(item.metrics.bookmarks)) ? Number(item.metrics.bookmarks) : null,
      views: Number.isFinite(Number(item.metrics.views)) ? Number(item.metrics.views) : null
    }
    : undefined;
  const repostedBy = item.repostedBy && typeof item.repostedBy === 'object' ? {
    handle: typeof item.repostedBy.handle === 'string' && item.repostedBy.handle ? item.repostedBy.handle : null,
    displayName: typeof item.repostedBy.displayName === 'string' && item.repostedBy.displayName ? item.repostedBy.displayName : null,
    avatarUrl: typeof item.repostedBy.avatarUrl === 'string' && /^https?:\/\//i.test(item.repostedBy.avatarUrl) ? item.repostedBy.avatarUrl : null
  } : null;
  return {
    url,
    authorHandle: typeof item.authorHandle === 'string' && item.authorHandle ? item.authorHandle : null,
    displayName: typeof item.displayName === 'string' && item.displayName ? item.displayName : null,
    avatarUrl: typeof item.avatarUrl === 'string' && /^https?:\/\//i.test(item.avatarUrl) ? item.avatarUrl : null,
    text: String(item.text ?? '').slice(0, X_LIST_TIMELINE_CACHE_LIMITS.maxTextChars),
    postedAt: typeof item.postedAt === 'string' && item.postedAt ? item.postedAt : null,
    images,
    imageThumbs,
    hasVideo: Boolean(item.hasVideo),
    videoPoster: typeof item.videoPoster === 'string' && /^https?:\/\//i.test(item.videoPoster) ? item.videoPoster : null,
    videoUrl: typeof item.videoUrl === 'string' && /^https?:\/\//i.test(item.videoUrl) ? item.videoUrl : null,
    postKind: item.postKind === 'repost' || item.postKind === 'quote' ? item.postKind : 'tweet',
    repostedBy,
    quotedPost: allowQuote && item.quotedPost ? normalizePost(item.quotedPost, false) : null,
    metrics
  };
}

function fingerprintPosts(posts: XListTimelineCachePost[]): string {
  const material = posts.map((post) => `${post.url}\n${post.text.slice(0, 64)}\n${(post.images ?? []).join(',')}\n${post.hasVideo ? 'v' : ''}`).join('\n---\n');
  return createHash('sha256').update(material).digest('hex');
}

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
