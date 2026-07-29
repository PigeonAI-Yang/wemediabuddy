import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type SourceInput = {
  feedId?: string;
  originalUrl?: string; title: string; author?: string; publishedAt?: string; summary?: string; categories?: string[]; keywords?: string[];
  valueJudgment?: string; ipRelevance?: string; creationAngles?: string; recommendedPlatforms?: string[]; recommendedFormats?: string[];
  timeliness?: string; priority?: number; evidence?: string; clientLabel?: string; expectedRevision?: number;
  verificationStatus?: 'pending' | 'verified' | 'disputed' | 'rejected';
  managementStatus?: 'active' | 'watching' | 'expired' | 'archived';
};

export type SourceRecord = {
  id: string; feedId: string | null; originalUrl: string | null; canonicalUrl: string | null; title: string; author: string | null;
  publishedAt: string | null; collectedAt: string; summary: string | null; categories: string[]; keywords: string[]; valueJudgment: string | null;
  ipRelevance: string | null; creationAngles: string | null; recommendedPlatforms: string[]; recommendedFormats: string[];
  timeliness: string | null; priority: number | null; evidence: string | null; clientLabel: string | null; revision: number;
  verificationStatus: 'pending' | 'verified' | 'disputed' | 'rejected';
  managementStatus: 'active' | 'watching' | 'expired' | 'archived';
};

export function createSourceFeed(database: DatabaseSync, input: { name: string; url?: string }): { id: string; revision: number } {
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare('INSERT INTO source_feeds (id, name, url, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.name, input.url ?? null, now, now, 1);
  return { id, revision: 1 };
}

export function upsertSource(database: DatabaseSync, input: SourceInput): { id: string; created: boolean; revision: number } {
  const canonicalUrl = input.originalUrl ? canonicalizeUrl(input.originalUrl) : null;
  const fingerprint = canonicalUrl ? null : fingerprintFor(input);
  const existing = database.prepare(`SELECT id, revision, feed_id AS feedId, original_url AS originalUrl, title, author,
    published_at AS publishedAt, summary, categories_json AS categories, keywords_json AS keywords, value_judgment AS valueJudgment,
    ip_relevance AS ipRelevance, creation_angles AS creationAngles, recommended_platforms_json AS recommendedPlatforms,
    recommended_formats_json AS recommendedFormats, timeliness, priority, evidence, client_label AS clientLabel
    FROM source_items WHERE ${canonicalUrl ? 'canonical_url = ?' : 'content_fingerprint = ?'}`)
    .get(canonicalUrl ?? fingerprint) as (Omit<SourceRecord, 'canonicalUrl' | 'collectedAt'> & {
      categories: string; keywords: string; recommendedPlatforms: string; recommendedFormats: string;
    }) | undefined;
  if (existing && input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) throw new Error('REVISION_CONFLICT');
  const now = new Date().toISOString();
  const values = [input.feedId ?? existing?.feedId ?? null, input.originalUrl ?? existing?.originalUrl ?? null, canonicalUrl, fingerprint, input.title,
    input.author ?? existing?.author ?? null, input.publishedAt ?? existing?.publishedAt ?? null, now, input.summary ?? existing?.summary ?? null,
    JSON.stringify(input.categories ?? (existing ? JSON.parse(existing.categories) : [])),
    JSON.stringify(input.keywords ?? (existing ? JSON.parse(existing.keywords) : [])),
    input.valueJudgment ?? existing?.valueJudgment ?? null, input.ipRelevance ?? existing?.ipRelevance ?? null,
    input.creationAngles ?? existing?.creationAngles ?? null,
    JSON.stringify(input.recommendedPlatforms ?? (existing ? JSON.parse(existing.recommendedPlatforms) : [])),
    JSON.stringify(input.recommendedFormats ?? (existing ? JSON.parse(existing.recommendedFormats) : [])),
    input.timeliness ?? existing?.timeliness ?? null, input.priority ?? existing?.priority ?? null, input.evidence ?? existing?.evidence ?? null,
    input.clientLabel ?? existing?.clientLabel ?? null];
  if (existing) {
    database.prepare(`UPDATE source_items SET feed_id=?, original_url=?, canonical_url=?, content_fingerprint=?, title=?, author=?, published_at=?, collected_at=?, summary=?, categories_json=?, keywords_json=?, value_judgment=?, ip_relevance=?, creation_angles=?, recommended_platforms_json=?, recommended_formats_json=?, timeliness=?, priority=?, evidence=?, client_label=?, updated_at=?, revision=? WHERE id=?`)
      .run(...values, now, existing.revision + 1, existing.id);
    return { id: existing.id, created: false, revision: existing.revision + 1 };
  }
  const id = randomUUID();
  database.prepare(`INSERT INTO source_items (id, feed_id, original_url, canonical_url, content_fingerprint, title, author, published_at, collected_at, summary, categories_json, keywords_json, value_judgment, ip_relevance, creation_angles, recommended_platforms_json, recommended_formats_json, timeliness, priority, evidence, client_label, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ...values, now, now, 1);
  return { id, created: true, revision: 1 };
}

export function getSource(database: DatabaseSync, id: string): SourceRecord | null {
  const row = database.prepare(`${sourceSelect} WHERE id = ?`).get(id) as SourceRow | undefined;
  return row ? parseSource(row) : null;
}

export function searchSources(database: DatabaseSync, query = '', limit = 50): SourceRecord[] {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const pattern = `%${query}%`;
  const rows = database.prepare(`${sourceSelect}
    WHERE ? = '' OR title LIKE ? OR summary LIKE ? OR keywords_json LIKE ?
    ORDER BY collected_at DESC LIMIT ?`).all(query, pattern, pattern, pattern, boundedLimit) as unknown as SourceRow[];
  return rows.map(parseSource);
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value); url.hash = ''; return url.toString();
}

function fingerprintFor(input: SourceInput): string {
  return createHash('sha256').update(JSON.stringify([input.title, input.author ?? '', input.publishedAt ?? '', input.summary ?? ''])).digest('hex');
}

type SourceRow = Omit<SourceRecord, 'categories' | 'keywords' | 'recommendedPlatforms' | 'recommendedFormats'> & {
  categories: string; keywords: string; recommendedPlatforms: string; recommendedFormats: string;
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
