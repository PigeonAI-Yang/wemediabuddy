import { broadcastDataChanged } from './data-changed.ts';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type SourceVerificationStatus = 'pending' | 'verified' | 'disputed' | 'rejected';
export type SourceManagementStatus = 'active' | 'watching' | 'expired' | 'archived';

export type SourceInput = {
  feedId?: string;
  originalUrl?: string;
  title: string;
  author?: string;
  publishedAt?: string;
  summary?: string;
  categories?: string[];
  keywords?: string[];
  valueJudgment?: string;
  ipRelevance?: string;
  creationAngles?: string;
  recommendedPlatforms?: string[];
  recommendedFormats?: string[];
  timeliness?: string;
  priority?: number;
  evidence?: string;
  clientLabel?: string;
  expectedRevision?: number;
  verificationStatus?: SourceVerificationStatus;
  managementStatus?: SourceManagementStatus;
};

export type SourceRecord = {
  id: string;
  feedId: string | null;
  originalUrl: string | null;
  canonicalUrl: string | null;
  title: string;
  author: string | null;
  publishedAt: string | null;
  collectedAt: string;
  summary: string | null;
  categories: string[];
  keywords: string[];
  valueJudgment: string | null;
  ipRelevance: string | null;
  creationAngles: string | null;
  recommendedPlatforms: string[];
  recommendedFormats: string[];
  timeliness: string | null;
  priority: number | null;
  evidence: string | null;
  clientLabel: string | null;
  revision: number;
  verificationStatus: SourceVerificationStatus;
  managementStatus: SourceManagementStatus;
};
const TRACKING_QUERY_EXACT = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'igsh',
  'mkt_tok',
  'vero_id',
  'yclid',
  'msclkid',
  '_ga',
  '_gl',
  'ncid',
  'ocid',
  // X/Twitter share wrappers
  's',
  'si',
  'ref_src',
  'ref_url'
]);

export function createSourceFeed(database: DatabaseSync, input: { name: string; url?: string; registryId?: string }): { id: string; revision: number } {
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare('INSERT INTO source_feeds (id, name, url, created_at, updated_at, revision, registry_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.name, input.url ?? null, now, now, 1, input.registryId ?? null);
  return { id, revision: 1 };
}

export function ensureRegistrySourceFeed(
  database: DatabaseSync,
  input: { registryId: string; name: string; url: string }
): { id: string; revision: number; created: boolean } {
  const registryId = input.registryId.trim();
  if (!registryId) throw new Error('REGISTRY_ID_REQUIRED');
  const existing = database.prepare(
    'SELECT id, revision FROM source_feeds WHERE registry_id = ?'
  ).get(registryId) as { id: string; revision: number } | undefined;
  const now = new Date().toISOString();
  const canonical = canonicalizeUrl(input.url);
  if (existing) {
    database.prepare(
      'UPDATE source_feeds SET name = ?, url = ?, updated_at = ?, revision = revision + 1 WHERE id = ?'
    ).run(input.name, canonical, now, existing.id);
    return { id: existing.id, revision: existing.revision + 1, created: false };
  }
  const created = createSourceFeed(database, {
    name: input.name,
    url: canonical,
    registryId
  });
  return { ...created, created: true };
}

export function upsertSource(database: DatabaseSync, input: SourceInput, notify = true): { id: string; created: boolean; revision: number } {
  const canonicalUrl = input.originalUrl ? canonicalizeUrl(input.originalUrl) : null;
  const fingerprint = canonicalUrl ? null : fingerprintFor(input);
  const existing = database.prepare(`SELECT id, revision, feed_id AS feedId, original_url AS originalUrl, title, author,
    published_at AS publishedAt, collected_at AS collectedAt, summary, categories_json AS categories, keywords_json AS keywords,
    value_judgment AS valueJudgment, ip_relevance AS ipRelevance, creation_angles AS creationAngles,
    recommended_platforms_json AS recommendedPlatforms, recommended_formats_json AS recommendedFormats, timeliness, priority,
    evidence, client_label AS clientLabel, verification_status AS verificationStatus, management_status AS managementStatus
    FROM source_items WHERE ${canonicalUrl ? 'canonical_url = ?' : 'content_fingerprint = ?'}`)
    .get(canonicalUrl ?? fingerprint) as (Omit<SourceRecord, 'canonicalUrl'> & {
      categories: string;
      keywords: string;
      recommendedPlatforms: string;
      recommendedFormats: string;
    }) | undefined;

  if (existing && input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
    throw new Error('REVISION_CONFLICT');
  }

  const now = new Date().toISOString();
  const verificationStatus = input.verificationStatus
    ?? existing?.verificationStatus
    ?? 'pending';
  const managementStatus = input.managementStatus
    ?? existing?.managementStatus
    ?? 'active';
  const values = [
    input.feedId ?? existing?.feedId ?? null,
    input.originalUrl ?? existing?.originalUrl ?? null,
    canonicalUrl,
    fingerprint,
    input.title,
    input.author ?? existing?.author ?? null,
    input.publishedAt ?? existing?.publishedAt ?? null,
    input.summary ?? existing?.summary ?? null,
    JSON.stringify(input.categories ?? (existing ? JSON.parse(existing.categories) : [])),
    JSON.stringify(input.keywords ?? (existing ? JSON.parse(existing.keywords) : [])),
    input.valueJudgment ?? existing?.valueJudgment ?? null,
    input.ipRelevance ?? existing?.ipRelevance ?? null,
    input.creationAngles ?? existing?.creationAngles ?? null,
    JSON.stringify(input.recommendedPlatforms ?? (existing ? JSON.parse(existing.recommendedPlatforms) : [])),
    JSON.stringify(input.recommendedFormats ?? (existing ? JSON.parse(existing.recommendedFormats) : [])),
    input.timeliness ?? existing?.timeliness ?? null,
    input.priority ?? existing?.priority ?? null,
    input.evidence ?? existing?.evidence ?? null,
    input.clientLabel ?? existing?.clientLabel ?? null,
    verificationStatus,
    managementStatus
  ];

  if (existing) {
    const revision = existing.revision + 1;
    database.prepare(`UPDATE source_items SET
      feed_id=?, original_url=?, canonical_url=?, content_fingerprint=?, title=?, author=?, published_at=?,
      summary=?, categories_json=?, keywords_json=?, value_judgment=?, ip_relevance=?, creation_angles=?,
      recommended_platforms_json=?, recommended_formats_json=?, timeliness=?, priority=?, evidence=?, client_label=?,
      verification_status=?, management_status=?, updated_at=?, revision=?
      WHERE id=?`)
      .run(...values, now, revision, existing.id);
    if (notify) broadcastDataChanged({ scopes: ['sources', 'library', 'today'], reason: 'source.upsert' });
    return { id: existing.id, created: false, revision };
  }

  const id = randomUUID();
  database.prepare(`INSERT INTO source_items (
      id, feed_id, original_url, canonical_url, content_fingerprint, title, author, published_at, collected_at,
      summary, categories_json, keywords_json, value_judgment, ip_relevance, creation_angles,
      recommended_platforms_json, recommended_formats_json, timeliness, priority, evidence, client_label,
      verification_status, management_status, created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ...values.slice(0, 7), now, ...values.slice(7), now, now, 1);
  if (notify) broadcastDataChanged({ scopes: ['sources', 'library', 'today'], reason: 'source.upsert' });
  return { id, created: true, revision: 1 };
}

export function getSource(database: DatabaseSync, id: string): SourceRecord | null {
  const row = database.prepare(`${sourceSelect} WHERE id = ?`).get(id) as SourceRow | undefined;
  return row ? parseSource(row) : null;
}

/**
 * 搜索资料：默认只返回有效资料库（management_status != 'archived'），
 * 传 includeArchived=true 可含已移出条目（资料库「已移出」视图等场景）。
 */
export function searchSources(database: DatabaseSync, query = '', limit = 50, includeArchived = false): SourceRecord[] {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const pattern = `%${query}%`;
  const rows = database.prepare(`${sourceSelect}
    WHERE (? = '' OR title LIKE ? OR summary LIKE ? OR keywords_json LIKE ?)
      AND (? = 1 OR management_status != 'archived')
    ORDER BY collected_at DESC LIMIT ?`).all(query, pattern, pattern, pattern, includeArchived ? 1 : 0, boundedLimit) as unknown as SourceRow[];
  return rows.map(parseSource);
}

export function listSourcesByFeed(
  database: DatabaseSync,
  feedId: string,
  input: { limit?: number; offset?: number } = {}
): { items: SourceRecord[]; limit: number; offset: number; hasMore: boolean } {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  const rows = database.prepare(`${sourceSelect}
    WHERE feed_id = ?
    ORDER BY collected_at DESC, id DESC
    LIMIT ? OFFSET ?`).all(feedId, limit + 1, offset) as unknown as SourceRow[];
  return {
    items: rows.slice(0, limit).map(parseSource),
    limit,
    offset,
    hasMore: rows.length > limit
  };
}

export function canonicalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('SOURCE_URL_EMPTY');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('SOURCE_URL_INVALID');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('SOURCE_URL_UNSUPPORTED');
  }

  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = normalizeHostname(parsed.hostname);

  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }

  let pathname = parsed.pathname || '/';
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  parsed.pathname = pathname;

  const pairs = [...parsed.searchParams.entries()]
    .filter(([key]) => !isTrackingQueryKey(key))
    .sort(([aKey, aVal], [bKey, bVal]) => aKey.localeCompare(bKey) || aVal.localeCompare(bVal));
  parsed.search = '';
  for (const [key, val] of pairs) parsed.searchParams.append(key, val);

  return parsed.toString();
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);
  if (host === 'mobile.twitter.com' || host === 'm.twitter.com') host = 'twitter.com';
  if (host === 'mobile.x.com' || host === 'm.x.com') host = 'x.com';
  return host;
}

function isTrackingQueryKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith('utm_')) return true;
  if (normalized.startsWith('pk_')) return true;
  if (normalized.startsWith('mtm_')) return true;
  if (normalized.startsWith('vero_')) return true;
  return TRACKING_QUERY_EXACT.has(normalized);
}

function fingerprintFor(input: SourceInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.title.trim(),
    (input.author ?? '').trim(),
    input.publishedAt ?? '',
    (input.summary ?? '').trim()
  ])).digest('hex');
}

type SourceRow = Omit<SourceRecord, 'categories' | 'keywords' | 'recommendedPlatforms' | 'recommendedFormats'> & {
  categories: string;
  keywords: string;
  recommendedPlatforms: string;
  recommendedFormats: string;
};

const sourceSelect = `SELECT id, feed_id AS feedId, original_url AS originalUrl, canonical_url AS canonicalUrl, title, author,
  published_at AS publishedAt, collected_at AS collectedAt, summary, categories_json AS categories, keywords_json AS keywords,
  value_judgment AS valueJudgment, ip_relevance AS ipRelevance, creation_angles AS creationAngles,
  recommended_platforms_json AS recommendedPlatforms, recommended_formats_json AS recommendedFormats, timeliness, priority,
  evidence, client_label AS clientLabel, verification_status AS verificationStatus,
  management_status AS managementStatus, revision FROM source_items`;

function parseSource(row: SourceRow): SourceRecord {
  return {
    ...row,
    categories: JSON.parse(row.categories) as string[],
    keywords: JSON.parse(row.keywords) as string[],
    recommendedPlatforms: JSON.parse(row.recommendedPlatforms) as string[],
    recommendedFormats: JSON.parse(row.recommendedFormats) as string[]
  };
}
