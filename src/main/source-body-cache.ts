import { DatabaseSync } from 'node:sqlite';
import { canonicalizeUrl, getSource } from './sources.ts';

export type SourceBodyCacheStatus = 'ready' | 'failed' | 'empty';

export type SourceBodyCacheRecord = {
  sourceId: string;
  url: string;
  status: SourceBodyCacheStatus;
  contentType: string | null;
  extractedText: string;
  extractedChars: number;
  errorMessage: string | null;
  fetchedAt: string;
  updatedAt: string;
};

const DEFAULT_MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;
const READY_TTL_MS = 24 * 60 * 60 * 1000;
const FAILED_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

type BodyRow = {
  sourceId: string;
  url: string;
  status: SourceBodyCacheStatus;
  contentType: string | null;
  extractedText: string;
  extractedChars: number;
  errorMessage: string | null;
  fetchedAt: string;
  updatedAt: string;
};

export function getSourceBodyCache(database: DatabaseSync, sourceId: string): SourceBodyCacheRecord | null {
  const row = database.prepare(`SELECT source_id AS sourceId, url, status, content_type AS contentType,
    extracted_text AS extractedText, extracted_chars AS extractedChars, error_message AS errorMessage,
    fetched_at AS fetchedAt, updated_at AS updatedAt
    FROM source_body_cache WHERE source_id = ?`).get(sourceId) as BodyRow | undefined;
  return row ?? null;
}

export function listSourceBodyCaches(database: DatabaseSync, sourceIds: string[]): SourceBodyCacheRecord[] {
  if (!sourceIds.length) return [];
  const unique = [...new Set(sourceIds.filter(Boolean))];
  const out: SourceBodyCacheRecord[] = [];
  for (const sourceId of unique) {
    const row = getSourceBodyCache(database, sourceId);
    if (row) out.push(row);
  }
  return out;
}

export async function fetchAndCacheSourceBody(
  database: DatabaseSync,
  input: { sourceId: string; force?: boolean; maxChars?: number; fetchImpl?: typeof fetch; now?: Date }
): Promise<SourceBodyCacheRecord> {
  const source = getSource(database, input.sourceId);
  if (!source) throw new Error('资料不存在。');
  const rawUrl = source.canonicalUrl || source.originalUrl;
  if (!rawUrl) throw new Error('这条资料没有可抓取的原文链接。');
  let url = rawUrl;
  try {
    url = canonicalizeUrl(rawUrl);
  } catch {
    url = rawUrl;
  }

  const existing = getSourceBodyCache(database, input.sourceId);
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  if (!input.force && existing) {
    const ageMs = Math.max(0, nowDate.getTime() - Date.parse(existing.fetchedAt));
    if (existing.status === 'ready' && existing.extractedText.trim() && ageMs < READY_TTL_MS) {
      return existing;
    }
    if ((existing.status === 'failed' || existing.status === 'empty') && ageMs < FAILED_RETRY_COOLDOWN_MS) {
      return existing;
    }
  }

  const maxChars = Math.max(500, Math.min(input.maxChars ?? DEFAULT_MAX_CHARS, 100_000));
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  try {
    const response = await fetchWithTimeout(fetchImpl, url, FETCH_TIMEOUT_MS);
    const contentType = response.headers.get('content-type');
    if (!response.ok) {
      return writeCache(database, {
        sourceId: input.sourceId,
        url,
        status: 'failed',
        contentType,
        extractedText: '',
        extractedChars: 0,
        errorMessage: `抓取失败 HTTP ${response.status}`,
        fetchedAt: now,
        updatedAt: now
      });
    }

    const raw = await response.text();
    const extracted = extractReadableText(raw, contentType, maxChars).trim();
    if (!extracted) {
      return writeCache(database, {
        sourceId: input.sourceId,
        url,
        status: 'empty',
        contentType,
        extractedText: '',
        extractedChars: 0,
        errorMessage: '页面没有提取到可读正文。',
        fetchedAt: now,
        updatedAt: now
      });
    }

    return writeCache(database, {
      sourceId: input.sourceId,
      url,
      status: 'ready',
      contentType,
      extractedText: extracted,
      extractedChars: extracted.length,
      errorMessage: null,
      fetchedAt: now,
      updatedAt: now
    });
  } catch (error) {
    return writeCache(database, {
      sourceId: input.sourceId,
      url,
      status: 'failed',
      contentType: null,
      extractedText: '',
      extractedChars: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
      fetchedAt: now,
      updatedAt: now
    });
  }
}

function writeCache(database: DatabaseSync, record: SourceBodyCacheRecord): SourceBodyCacheRecord {
  database.prepare(`INSERT INTO source_body_cache (
      source_id, url, status, content_type, extracted_text, extracted_chars, error_message, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      url = excluded.url,
      status = excluded.status,
      content_type = excluded.content_type,
      extracted_text = excluded.extracted_text,
      extracted_chars = excluded.extracted_chars,
      error_message = excluded.error_message,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
  `).run(
    record.sourceId,
    record.url,
    record.status,
    record.contentType,
    record.extractedText,
    record.extractedChars,
    record.errorMessage,
    record.fetchedAt,
    record.updatedAt
  );
  return record;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'WeMediaBuddySourceBody/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

export function extractReadableText(raw: string, contentType: string | null, maxChars: number): string {
  const type = (contentType || '').toLowerCase();
  if (type.includes('application/json') || looksLikeJson(raw)) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2).slice(0, maxChars);
    } catch {
      return raw.replace(/\s+/g, ' ').trim().slice(0, maxChars);
    }
  }
  if (type.includes('text/plain') && !/<html[\s>]/i.test(raw)) {
    return raw.replace(/\r\n/g, '\n').trim().slice(0, maxChars);
  }
  return extractHtmlText(raw, maxChars);
}

function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function extractHtmlText(html: string, maxChars: number): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ');
  const article = withoutNoise.match(/<article[\s\S]*?<\/article>/i)?.[0]
    || withoutNoise.match(/<main[\s\S]*?<\/main>/i)?.[0]
    || withoutNoise;
  const structured = article
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|section|article|main|header|footer|aside|blockquote|li|tr|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\s*li(\s[^>]*)?>/gi, '• ')
    .replace(/<\s*h[1-6](\s[^>]*)?>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeBasicEntities(structured)
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
