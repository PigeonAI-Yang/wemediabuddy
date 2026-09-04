import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { XArticleContent, XListPost } from './platforms/x-list-browser-types.ts';

export const X_LIST_TIMELINE_CACHE_SCHEMA_VERSION = 3;
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

export type XListTimelineCachePost = Omit<XListPost, 'metricEvidence'>;

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
  options: { touch?: boolean; cleanup?: boolean; now?: Date } = {}
): XListTimelineCacheRecord | null {
  const row = database.prepare(`
    SELECT account_key, list_id, payload_json, posts_count, payload_bytes, fetched_at, last_accessed_at, source, schema_version, fingerprint
    FROM x_list_timeline_cache
    WHERE account_key = ? AND list_id = ?
  `).get(accountKey, listId) as CacheRow | undefined;
  if (!row) return null;
  const parsed = parseRow(row, options.now ?? new Date());
  if (!parsed) {
    if (options.cleanup !== false) database.prepare('DELETE FROM x_list_timeline_cache WHERE account_key = ? AND list_id = ?').run(accountKey, listId);
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
  if (!existing?.payload.posts.length) return writeXListTimelineCache(database, input);
  const seen = new Set(input.posts.map((post) => post.url.replace(/[?#].*$/, '')));
  const posts = [...input.posts, ...existing.payload.posts.filter((post) => !seen.has(post.url.replace(/[?#].*$/, '')))];
  return writeXListTimelineCache(database, { ...input, posts, detail: input.detail ?? existing.payload.detail });
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
  if (![2, X_LIST_TIMELINE_CACHE_SCHEMA_VERSION].includes(Number(row.schema_version))) return null;
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

function normalizeArticle(item: XArticleContent): XArticleContent | null {
  const canonicalUrl = typeof item?.canonicalUrl === 'string' ? item.canonicalUrl.trim() : '';
  const id = typeof item?.id === 'string' ? item.id.trim() : canonicalUrl.match(/\/i\/article\/(\d+)/)?.[1] ?? '';
  if (!id || !canonicalUrl) return null;
  const blocks: XArticleContent['blocks'] = [];
  for (const block of Array.isArray(item.blocks) ? item.blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.kind === 'image') {
      if (typeof block.url === 'string' && /^https?:\/\//i.test(block.url)) {
        blocks.push({ kind: 'image', url: block.url, alt: typeof block.alt === 'string' ? block.alt.slice(0, 500) : null });
      }
      continue;
    }
    if (typeof block.text !== 'string') continue;
    const text = block.text.trim().slice(0, X_LIST_TIMELINE_CACHE_LIMITS.maxTextChars);
    if (!text) continue;
    if (block.kind === 'heading') blocks.push({ kind: 'heading', text, level: Math.max(1, Math.min(Number(block.level) || 2, 6)) });
    else if (block.kind === 'paragraph' || block.kind === 'list_item' || block.kind === 'quote') blocks.push({ kind: block.kind, text });
    if (blocks.length >= 400) break;
  }
  return {
    id,
    canonicalUrl,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 500) : null,
    authorHandle: typeof item.authorHandle === 'string' && item.authorHandle.trim() ? item.authorHandle.trim() : null,
    displayName: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim().slice(0, 300) : null,
    publishedAt: typeof item.publishedAt === 'string' && item.publishedAt ? item.publishedAt : null,
    blocks,
    status: item.status === 'ready' || item.status === 'partial' || item.status === 'needs_user' ? item.status : 'unavailable',
    source: item.source === 'graphql' || item.source === 'mixed' ? item.source : 'dom',
    capturedAt: typeof item.capturedAt === 'string' && item.capturedAt ? item.capturedAt : new Date(0).toISOString(),
    errorMessage: typeof item.errorMessage === 'string' && item.errorMessage ? item.errorMessage.slice(0, 1000) : null
  };
}

function normalizePost(item: XListTimelineCachePost, allowQuote = true, allowEnrichment = true): XListTimelineCachePost | null {
  const url = typeof item?.url === 'string' ? item.url.trim() : '';
  if (!url) return null;
  const images = Array.isArray(item.images)
    ? item.images.filter((src): src is string => typeof src === 'string' && /^https?:\/\//i.test(src)).slice(0, 4)
    : [];
  const imageThumbs = Array.isArray(item.imageThumbs)
    ? item.imageThumbs.filter((src): src is string => typeof src === 'string' && /^https?:\/\//i.test(src)).slice(0, 4)
    : images;
  const metricValue = (value: unknown): number | null => Number.isFinite(Number(value)) ? Number(value) : null;
  const metrics = {
    replies: metricValue(item.metrics?.replies),
    reposts: metricValue(item.metrics?.reposts),
    likes: metricValue(item.metrics?.likes),
    bookmarks: metricValue(item.metrics?.bookmarks),
    views: metricValue(item.metrics?.views)
  };
  const repostedBy = item.repostedBy && typeof item.repostedBy === 'object' ? {
    handle: typeof item.repostedBy.handle === 'string' && item.repostedBy.handle ? item.repostedBy.handle : null,
    displayName: typeof item.repostedBy.displayName === 'string' && item.repostedBy.displayName ? item.repostedBy.displayName : null,
    avatarUrl: typeof item.repostedBy.avatarUrl === 'string' && /^https?:\/\//i.test(item.repostedBy.avatarUrl) ? item.repostedBy.avatarUrl : null
  } : null;
  const nested = (values: XListTimelineCachePost[] | undefined): XListTimelineCachePost[] => (Array.isArray(values) ? values : [])
    .map((value) => normalizePost(value, false, false))
    .filter((value): value is XListTimelineCachePost => Boolean(value))
    .slice(0, 40);
  const articles = (Array.isArray(item.articles) ? item.articles : [])
    .map(normalizeArticle)
    .filter((value): value is XArticleContent => Boolean(value));
  const links = (Array.isArray(item.links) ? item.links : []).flatMap((link) => {
    if (!link || typeof link.url !== 'string' || !/^https?:\/\//i.test(link.url)) return [];
    return [{
      url: link.url,
      expandedUrl: typeof link.expandedUrl === 'string' && /^https?:\/\//i.test(link.expandedUrl) ? link.expandedUrl : null,
      displayUrl: typeof link.displayUrl === 'string' ? link.displayUrl.slice(0, 500) : null,
      source: link.source === 'graphql' || link.source === 'text' ? link.source : 'dom' as const
    }];
  }).slice(0, 30);
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
    quotedPost: allowQuote && item.quotedPost ? normalizePost(item.quotedPost, false, allowEnrichment) : null,
    statusId: typeof item.statusId === 'string' && item.statusId ? item.statusId : null,
    parentStatusId: typeof item.parentStatusId === 'string' && item.parentStatusId ? item.parentStatusId : null,
    conversationId: typeof item.conversationId === 'string' && item.conversationId ? item.conversationId : null,
    ...(Number.isInteger(item.captureOrdinal) ? { captureOrdinal: item.captureOrdinal } : {}),
    ...(Number.isInteger(item.conversationOrdinal) ? { conversationOrdinal: item.conversationOrdinal } : {}),
    ...(typeof item.isRootAuthor === 'boolean' ? { isRootAuthor: item.isRootAuthor } : {}),
    ...(typeof item.isAuthorThread === 'boolean' ? { isAuthorThread: item.isAuthorThread } : {}),
    links,
    authorThread: allowEnrichment ? nested(item.authorThread) : [],
    comments: allowEnrichment ? nested(item.comments) : [],
    articles,
    ...(item.replyCapture ? { replyCapture: {
      status: item.replyCapture.status === 'ready' || item.replyCapture.status === 'partial' || item.replyCapture.status === 'needs_user' ? item.replyCapture.status : 'unavailable',
      replyLimit: Math.max(0, Math.min(Number(item.replyCapture.replyLimit) || 0, 40)),
      hasMoreReplies: Boolean(item.replyCapture.hasMoreReplies),
      fetchedAt: typeof item.replyCapture.fetchedAt === 'string' ? item.replyCapture.fetchedAt : new Date(0).toISOString(),
      source: item.replyCapture.source === 'graphql' || item.replyCapture.source === 'mixed' ? item.replyCapture.source : 'dom',
      errorMessage: typeof item.replyCapture.errorMessage === 'string' ? item.replyCapture.errorMessage.slice(0, 1000) : null
    } } : {}),
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
