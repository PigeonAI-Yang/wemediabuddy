import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { projectSourceBodyRevision } from './wiki-index-triggers.ts';
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

// WMB-5237：Source 正文不可变 revision（append-only 历史身份；source_body_cache 仅作 latest 投影）。
export type SourceBodyRevision = {
  revisionId: string;
  sourceId: string;
  url: string;
  status: SourceBodyCacheStatus;
  contentType: string | null;
  extractedText: string;
  extractedChars: number;
  bodyHash: string;
  errorMessage: string | null;
  fetchedAt: string;
  createdAt: string;
  previousRevisionId: string | null;
};

export type SourceBodyRevisionListPage = {
  revisions: SourceBodyRevision[];
  nextCursor: string | null;
};

const DEFAULT_MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;
const READY_TTL_MS = 24 * 60 * 60 * 1000;
const FAILED_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

const REVISION_PURGE_FUNCTION = 'wmb_source_body_revision_purge_enabled';
const REVISION_IMMUTABLE_ERROR = 'SOURCE_BODY_REVISION_IMMUTABLE';
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

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

const REVISION_SELECT = `
  SELECT id AS revisionId, source_id AS sourceId, url, status, content_type AS contentType,
    extracted_text AS extractedText, extracted_chars AS extractedChars, body_hash AS bodyHash,
    error_message AS errorMessage, fetched_at AS fetchedAt, created_at AS createdAt,
    previous_revision_id AS previousRevisionId
  FROM source_body_revisions
`;

/** 删除闸门状态：DELETE 触发器 WHEN 引用；非 0 表示处于授权 purge 窗口。 */
const purgeGateStates = new WeakMap<DatabaseSync, { active: number }>();

/** 注册删除闸门 UDF（幂等，按连接）。迁移 run hook 与 purgeSourceBodyHistory 共用同一状态。 */
export function registerSourceBodyRevisionPurgeGate(database: DatabaseSync): void {
  if (purgeGateStates.has(database)) return;
  const state = { active: 0 };
  purgeGateStates.set(database, state);
  database.function(REVISION_PURGE_FUNCTION, () => state.active);
}

/** 正文 sha256（hex，64 字符），用于 revision 幂等与血缘。 */
export function bodyHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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
  input: { sourceId: string; force?: boolean; maxChars?: number; fetchImpl?: typeof fetch; now?: Date; persist?: boolean }
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
  const finish = (record: SourceBodyCacheRecord) => input.persist === false ? record : writeSourceBodyCache(database, record);

  try {
    const response = await fetchWithTimeout(fetchImpl, url, FETCH_TIMEOUT_MS);
    const contentType = response.headers.get('content-type');
    if (!response.ok) {
      return finish({
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
      return finish({
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

    return finish({
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
    return finish({
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

/** 与最新 revision 身份相同（幂等判定）：url 变更、正文（ready）变更、错误信息（failed/empty）变更均视为新身份。 */
function sameRevisionIdentity(latest: SourceBodyRevision, record: SourceBodyCacheRecord, bodyHash: string): boolean {
  if (latest.url !== record.url || latest.status !== record.status) return false;
  if (latest.status === 'ready') return latest.bodyHash === bodyHash;
  return latest.errorMessage === record.errorMessage;
}

function appendSourceBodyRevision(database: DatabaseSync, record: SourceBodyCacheRecord, bodyHash: string, createdAt: string): SourceBodyRevision {
  const previous = database.prepare('SELECT id FROM source_body_revisions WHERE source_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(record.sourceId) as { id: string } | undefined;
  const revision: SourceBodyRevision = {
    revisionId: randomUUID(),
    sourceId: record.sourceId,
    url: record.url,
    status: record.status,
    contentType: record.contentType,
    extractedText: record.extractedText,
    extractedChars: record.extractedChars,
    bodyHash,
    errorMessage: record.errorMessage,
    fetchedAt: record.fetchedAt,
    createdAt,
    previousRevisionId: previous?.id ?? null
  };
  database.prepare(`INSERT INTO source_body_revisions (
      id, source_id, url, status, content_type, extracted_text, extracted_chars, body_hash, error_message, fetched_at, created_at, previous_revision_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.revisionId, revision.sourceId, revision.url, revision.status, revision.contentType,
    revision.extractedText, revision.extractedChars, revision.bodyHash, revision.errorMessage,
    revision.fetchedAt, revision.createdAt, revision.previousRevisionId
  );
  return revision;
}

/** latest 投影 upsert（source_body_cache 是投影，可被覆盖；历史在 source_body_revisions）。 */
function upsertSourceBodyCacheProjection(database: DatabaseSync, record: SourceBodyCacheRecord): void {
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
}

// WMB-5237：唯一正式写路径 —— 追加 revision 历史 + 更新 latest 投影。
// - ready 正文变化 → 追加 revision 并刷新投影；相同正文重复写 → 幂等（不产生新 revision，仅刷新抓取时间）。
// - failed/empty 写入 → 追加失败 revision（供健康/溯源消费），但绝不覆盖最后成功正文投影。
// - 必须在调用方事务内执行（dispatcher 的 sources:fetch-body 已在 BEGIN IMMEDIATE 内调用本函数）。
export function writeSourceBodyCache(database: DatabaseSync, record: SourceBodyCacheRecord): SourceBodyCacheRecord {
  const bodyHash = bodyHashOf(record.extractedText);
  const latest = database.prepare(`${REVISION_SELECT} WHERE source_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(record.sourceId) as SourceBodyRevision | undefined;

  if (latest && sameRevisionIdentity(latest, record, bodyHash)) {
    if (record.status === 'ready') {
      database.prepare(`UPDATE source_body_cache SET url = ?, content_type = ?, fetched_at = ?, updated_at = ? WHERE source_id = ?`)
        .run(record.url, record.contentType, record.fetchedAt, record.updatedAt, record.sourceId);
    }
    return record;
  }

  appendSourceBodyRevision(database, record, bodyHash, record.updatedAt);
  // WMB-5238：新正文 revision 落地 → 刷新 source 索引条目（正文进 searchableText）；
  // 同 hash 幂等路径（无新 revision）在上面 early-return，不会走到这里；
  // 正文摄取日志由 source_body_revisions 派生覆盖（knowledge-global-log sourceRows 源）。
  projectSourceBodyRevision(database, record.sourceId);

  if (record.status === 'ready') {
    upsertSourceBodyCacheProjection(database, record);
    return record;
  }
  const projection = getSourceBodyCache(database, record.sourceId);
  const hasSuccess = Boolean(projection && projection.status === 'ready' && projection.extractedText.trim());
  if (!hasSuccess) upsertSourceBodyCacheProjection(database, record);
  return record;
}

/** 存量 source_body_cache 行的可追溯基线回填：无 revision 的行生成一条 baseline revision（幂等）。 */
export function backfillSourceBodyRevisionBaselines(database: DatabaseSync): number {
  const rows = database.prepare(`
    SELECT source_id AS sourceId, url, status, content_type AS contentType,
      extracted_text AS extractedText, extracted_chars AS extractedChars, error_message AS errorMessage,
      fetched_at AS fetchedAt, updated_at AS updatedAt
    FROM source_body_cache c
    WHERE NOT EXISTS (SELECT 1 FROM source_body_revisions r WHERE r.source_id = c.source_id)
  `).all() as SourceBodyCacheRecord[];
  let created = 0;
  for (const row of rows) {
    database.prepare(`INSERT INTO source_body_revisions (
        id, source_id, url, status, content_type, extracted_text, extracted_chars, body_hash, error_message, fetched_at, created_at, previous_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      `baseline-${row.sourceId}`, row.sourceId, row.url, row.status, row.contentType,
      row.extractedText, row.extractedChars, bodyHashOf(row.extractedText), row.errorMessage,
      row.fetchedAt, row.updatedAt
    );
    created += 1;
  }
  return created;
}

/** source 删除生命周期的历史清理：仅在授权窗口内放行 DELETE（触发器 WHEN 引用闸门 UDF）。 */
export function purgeSourceBodyHistory(database: DatabaseSync, sourceId: string): void {
  registerSourceBodyRevisionPurgeGate(database);
  const state = purgeGateStates.get(database);
  if (!state) return;
  state.active += 1;
  try {
    database.prepare('DELETE FROM source_body_revisions WHERE source_id = ?').run(sourceId);
  } finally {
    state.active -= 1;
  }
}

/** 取该 source 最近一次成功（ready）正文 revision。 */
export function getLatestSourceBodyRevision(database: DatabaseSync, sourceId: string): SourceBodyRevision | null {
  const row = database.prepare(`${REVISION_SELECT} WHERE source_id = ? AND status = 'ready' ORDER BY rowid DESC LIMIT 1`)
    .get(sourceId) as SourceBodyRevision | undefined;
  return row ?? null;
}

/** 按 revision ID 取 revision（跨 source 唯一）。 */
export function getSourceBodyRevision(database: DatabaseSync, revisionId: string): SourceBodyRevision | null {
  const row = database.prepare(`${REVISION_SELECT} WHERE id = ?`).get(revisionId) as SourceBodyRevision | undefined;
  return row ?? null;
}

/** 分页列出 source 的 revision 历史（新→旧）；cursor 为上一页最后一条 revisionId（keyset）。 */
export function listSourceBodyRevisions(
  database: DatabaseSync,
  input: { sourceId: string; limit?: number; cursor?: string | null }
): SourceBodyRevisionListPage {
  const limit = Math.min(Math.max(input.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const rows = (input.cursor
    ? database.prepare(`${REVISION_SELECT} WHERE source_id = ? AND rowid < (SELECT rowid FROM source_body_revisions WHERE id = ?) ORDER BY rowid DESC LIMIT ?`)
      .all(input.sourceId, input.cursor, limit + 1)
    : database.prepare(`${REVISION_SELECT} WHERE source_id = ? ORDER BY rowid DESC LIMIT ?`)
      .all(input.sourceId, limit + 1)) as SourceBodyRevision[];
  const hasMore = rows.length > limit;
  const revisions = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? revisions[revisions.length - 1]?.revisionId ?? null : null;
  return { revisions, nextCursor };
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
