import { DatabaseSync } from 'node:sqlite';
import { isIP } from 'node:net';
import {
  createWebsiteSource,
  getWebsiteSource,
  recordSourceScanReceipt,
  type SourceScanReceipt,
  type WebsiteSource,
  type WebsiteTrialRead,
  updateWebsiteSourceResolution
} from './intelligence-channels.ts';
import { extractOfficialItems } from './intelligence-wire.ts';
import { canonicalizeUrl, upsertSource } from './sources.ts';

const SEARCH_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 8;
const MAX_ITEMS_PER_SOURCE = 8;
const WEBSITE_UA = 'WeMediaBuddyWebsiteChannel/1.0';

export type WebsiteCandidate = {
  inputText: string;
  name: string;
  url: string;
  canonicalUrl: string;
  origin: 'direct' | 'bing_search';
};

export type WebsiteScanResult = {
  source: WebsiteSource;
  receipt: SourceScanReceipt;
  sourceIds: string[];
};

type WebsitePage = {
  body: string | null;
  trialRead: WebsiteTrialRead;
};

type WebsiteChannelError = Error & { code: string };

export async function resolveWebsiteCandidates(input: {
  inputText: string;
  fetchImpl?: typeof fetch;
  limit?: number;
}): Promise<WebsiteCandidate[]> {
  const inputText = input.inputText.trim();
  if (!inputText) throw websiteError('WEBSITE_INPUT_REQUIRED', '请输入网站名称或 URL。');

  const directUrl = directCandidateUrl(inputText);
  if (directUrl) return [{
    inputText,
    name: new URL(directUrl).hostname,
    url: directUrl,
    canonicalUrl: canonicalizeUrl(directUrl),
    origin: 'direct'
  }];

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(inputText)}`;
  let response: Response;
  let body: string;
  try {
    response = await fetchWithTimeout(fetchImpl, searchUrl, SEARCH_TIMEOUT_MS);
    body = await response.text();
  } catch (error) {
    throw websiteError('SOURCE_SEARCH_FAILED', errorMessage(error));
  }
  if (!response.ok) throw websiteError('SOURCE_SEARCH_FAILED', `Bing 搜索返回 HTTP ${response.status}。`);
  if (!isTextResponse(response.headers.get('content-type'), body)) {
    throw websiteError('SOURCE_SEARCH_FAILED', 'Bing 搜索未返回可解析的 HTML。');
  }

  const resolved = parseBingCandidates(body, inputText, input.limit ?? MAX_CANDIDATES);
  if (!resolved.candidates.length) {
    if (resolved.rejectedPrivate) throw websiteError('WEBSITE_URL_NOT_PUBLIC', '搜索结果只包含非公开网站地址。');
    throw websiteError('SOURCE_SEARCH_FAILED', 'Bing 未返回可确认的公开网站候选。');
  }
  return resolved.candidates;
}

export async function trialReadWebsite(input: {
  url: string;
  fetchImpl?: typeof fetch;
}): Promise<WebsiteTrialRead> {
  const requestUrl = normalizePublicFetchUrl(input.url);
  return (await readWebsitePage(requestUrl, input.fetchImpl ?? globalThis.fetch)).trialRead;
}

export function confirmWebsiteSource(database: DatabaseSync, input: {
  inputText: string;
  candidate: WebsiteCandidate;
  trialRead: WebsiteTrialRead;
  sourceFeedId?: string;
  enabled?: boolean; transaction?: boolean; notify?: boolean;
}): WebsiteSource {
  if (!input.trialRead.readable || !input.trialRead.title.trim()) {
    throw websiteError('WEBSITE_TRIAL_READ_REQUIRED', '网站必须先完成成功的试读。');
  }
  assertPublicUrl(input.candidate.url);
  assertPublicUrl(input.trialRead.requestedUrl ?? input.trialRead.url);
  assertPublicUrl(input.trialRead.url);
  const requestedUrl = canonicalizeUrl(input.trialRead.requestedUrl ?? input.trialRead.url);
  if (requestedUrl !== input.candidate.canonicalUrl) {
    throw websiteError('WEBSITE_CANDIDATE_MISMATCH', '试读结果不属于当前确认的网站候选。');
  }
  const canonicalUrl = canonicalizeUrl(input.trialRead.url);
  const requestedFeed = input.sourceFeedId ?? findExistingFeedId(database, canonicalUrl);
  return createWebsiteSource(database, {
    inputText: input.inputText,
    name: input.trialRead.title.trim() || input.candidate.name,
    canonicalUrl,
    ...(requestedFeed ? { sourceFeedId: requestedFeed } : {}),
    resolutionStatus: 'ready',
    trialRead: input.trialRead,
    enabled: input.enabled,
    transaction: input.transaction,
    notify: input.notify
  });
}

export async function scanWebsiteSource(database: DatabaseSync, input: {
  taskId: string;
  workspaceId: string;
  sourceId: string;
  fetchImpl?: typeof fetch;
}): Promise<WebsiteScanResult> {
  assertWorkspace(database, input.workspaceId);
  const original = getWebsiteSource(database, input.sourceId);
  if (!original) throw websiteError('WEBSITE_SOURCE_NOT_FOUND', '官网来源不存在。');
  if (!original.enabled) throw websiteError('WEBSITE_SOURCE_DISABLED', '官网来源已停用。');

  const checkedAt = new Date().toISOString();
  const page = await readWebsitePage(original.trialRead.requestedUrl ?? original.canonicalUrl, input.fetchImpl ?? globalThis.fetch);
  const current = assertUnchangedEnabledSource(database, original);
  if (!page.trialRead.readable) {
    const needsUser = page.trialRead.errorCode === 'WEBSITE_NEEDS_USER';
    const source = updateWebsiteSourceResolution(database, {
      id: current.id,
      resolutionStatus: needsUser ? 'needs_user' : 'failed',
      trialRead: page.trialRead,
      errorCode: page.trialRead.errorCode ?? 'WEBSITE_TRIAL_FAILED',
      errorMessage: page.trialRead.errorMessage ?? '网站试读失败。',
      expectedRevision: current.revision
    });
    const receipt = recordSourceScanReceipt(database, {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      module: 'official_web',
      sourceId: source.id,
      sourceFeedId: source.sourceFeedId,
      checkedAt,
      status: needsUser ? 'needs_user' : 'failed',
      errorCode: source.lastErrorCode,
      errorMessage: source.lastErrorMessage
    });
    return { source, receipt, sourceIds: [] };
  }

  if (canonicalizeUrl(page.trialRead.url) !== current.canonicalUrl) {
    return recordScanFailure(database, input, current, checkedAt, page.trialRead, websiteError(
      'WEBSITE_CANONICAL_URL_CHANGED',
      '网站跳转到了新的规范 URL，请重新确认该来源。'
    ));
  }

  const items = extractOfficialItems(page.trialRead.url, page.body ?? '', MAX_ITEMS_PER_SOURCE);
  const sourceIds: string[] = [];
  try {
    for (const item of items) {
      sourceIds.push(upsertSource(database, {
        feedId: current.sourceFeedId,
        originalUrl: item.url,
        title: item.title,
        summary: item.summary ?? page.trialRead.summary ?? page.trialRead.title,
        categories: ['official_web', 'website_item'],
        clientLabel: current.id,
        verificationStatus: 'pending',
        managementStatus: 'active',
        evidence: JSON.stringify({
          channel: 'official_web',
          websiteSourceId: current.id,
          sourceFeedId: current.sourceFeedId,
          checkedAt,
          httpStatus: page.trialRead.httpStatus,
          fetchedUrl: page.trialRead.url
        })
      }).id);
    }
    const source = updateWebsiteSourceResolution(database, {
      id: current.id,
      resolutionStatus: 'ready',
      trialRead: page.trialRead,
      expectedRevision: current.revision
    });
    const receipt = recordSourceScanReceipt(database, {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      module: 'official_web',
      sourceId: source.id,
      sourceFeedId: source.sourceFeedId,
      checkedAt,
      status: 'succeeded',
      candidateCount: items.length,
      savedCount: sourceIds.length
    });
    return { source, receipt, sourceIds };
  } catch (error) {
    return recordScanFailure(database, input, current, checkedAt, page.trialRead, error, items.length, sourceIds);
  }
}

function directCandidateUrl(inputText: string): string | null {
  const explicitUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(inputText);
  if (explicitUrl) {
    try { return normalizePublicFetchUrl(inputText); }
    catch (error) {
      if (errorCode(error, '') === 'WEBSITE_URL_NOT_PUBLIC') throw error;
      throw websiteError('WEBSITE_URL_INVALID', errorMessage(error));
    }
  }
  if (/\s/.test(inputText)) return null;
  try {
    const candidate = new URL(`https://${inputText}`);
    const host = hostnameOf(candidate);
    if (!host.includes('.') && host !== 'localhost' && !host.endsWith('.localhost') && !isIP(host)) return null;
    return normalizePublicFetchUrl(candidate.toString());
  } catch (error) {
    if (errorCode(error, '') === 'WEBSITE_URL_NOT_PUBLIC') throw error;
    return null;
  }
}

function parseBingCandidates(html: string, inputText: string, limit: number): { candidates: WebsiteCandidate[]; rejectedPrivate: boolean } {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_CANDIDATES);
  const seen = new Set<string>();
  const candidates: WebsiteCandidate[] = [];
  let rejectedPrivate = false;
  const blockRe = /<li\b[^>]*\bclass\s*=\s*["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) && candidates.length < boundedLimit) {
    const anchor = block[1].match(/<h2\b[\s\S]*?<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? block[1].match(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const title = textFromHtml(anchor[2]).slice(0, 180);
    if (!title) continue;
    let url: URL;
    try { url = new URL(decodeEntities(anchor[1]), 'https://www.bing.com'); }
    catch { continue; }
    if (!/^https?:$/.test(url.protocol) || isSearchNavigation(url)) continue;
    let candidateUrl: string;
    let canonicalUrl: string;
    try {
      candidateUrl = normalizeFetchUrl(url.toString());
      assertPublicUrl(candidateUrl);
      canonicalUrl = canonicalizeUrl(candidateUrl);
    }
    catch (error) {
      if (errorCode(error, '') === 'WEBSITE_URL_NOT_PUBLIC') rejectedPrivate = true;
      continue;
    }
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    candidates.push({ inputText, name: title, url: candidateUrl, canonicalUrl, origin: 'bing_search' });
  }
  return { candidates, rejectedPrivate };
}

async function readWebsitePage(url: string, fetchImpl: typeof fetch): Promise<WebsitePage> {
  try { assertPublicUrl(url); }
  catch (error) { return unreadableTrial(canonicalOrFallback(url, url), errorCode(error, 'WEBSITE_URL_NOT_PUBLIC'), errorMessage(error)); }
  let response: Response;
  let body = '';
  try {
    response = await fetchWithTimeout(fetchImpl, url, READ_TIMEOUT_MS);
    body = await response.text();
  } catch (error) {
    return unreadableTrial(url, 'WEBSITE_TRIAL_FAILED', errorMessage(error));
  }

  let requestedUrl: string;
  try {
    requestedUrl = normalizeFetchUrl(response.url || url);
    assertPublicUrl(requestedUrl);
  } catch (error) {
    const finalUrl = canonicalOrFallback(response.url || url, url);
    return unreadableTrial(finalUrl, errorCode(error, 'WEBSITE_URL_NOT_PUBLIC'), errorMessage(error), response.status,
      response.headers.get('content-type'), response.url || url);
  }
  const finalUrl = canonicalOrFallback(requestedUrl, url);
  const contentType = response.headers.get('content-type');
  if (!response.ok) {
    return unreadableTrial(finalUrl, response.status === 401 || response.status === 403 || response.status === 429 ? 'WEBSITE_NEEDS_USER' : 'WEBSITE_TRIAL_FAILED',
      `HTTP ${response.status}。`, response.status, contentType, requestedUrl);
  }
  if (!isTextResponse(contentType, body)) {
    return unreadableTrial(finalUrl, 'WEBSITE_CONTENT_TYPE_UNSUPPORTED', `不支持的内容类型：${contentType || 'unknown'}。`, response.status, contentType, requestedUrl);
  }
  if (looksLikeChallenge(body)) {
    return unreadableTrial(finalUrl, 'WEBSITE_NEEDS_USER', '网站要求登录、验证或通过反自动化挑战。', response.status, contentType, requestedUrl);
  }

  const summary = textFromHtml(body).slice(0, 500);
  const title = extractTitle(body) || summary.split(/\n|[。.!?]/)[0]?.trim().slice(0, 180) || '';
  if (!title || summary.length < 20) {
    return unreadableTrial(finalUrl, 'WEBSITE_TRIAL_UNREADABLE', '页面没有可确认的标题和正文。', response.status, contentType, requestedUrl);
  }
  const itemCount = extractOfficialItems(finalUrl, body, MAX_ITEMS_PER_SOURCE).length;
  return {
    body,
    trialRead: {
      title,
      url: finalUrl,
      requestedUrl,
      readable: true,
      itemCount,
      summary,
      httpStatus: response.status,
      contentType,
      errorCode: null,
      errorMessage: null
    }
  };
}

function recordScanFailure(
  database: DatabaseSync,
  input: { taskId: string; workspaceId: string; sourceId: string },
  current: WebsiteSource,
  checkedAt: string,
  trialRead: WebsiteTrialRead,
  error: unknown,
  candidateCount = 0,
  sourceIds: string[] = []
): WebsiteScanResult {
  const code = errorCode(error, trialRead.errorCode ?? 'WEBSITE_SCAN_FAILED');
  const message = errorMessage(error);
  const source = updateWebsiteSourceResolution(database, {
    id: current.id,
    resolutionStatus: code === 'WEBSITE_NEEDS_USER' ? 'needs_user' : 'failed',
    trialRead,
    errorCode: code,
    errorMessage: message,
    expectedRevision: current.revision
  });
  const receipt = recordSourceScanReceipt(database, {
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    module: 'official_web',
    sourceId: source.id,
    sourceFeedId: source.sourceFeedId,
    checkedAt,
    status: code === 'WEBSITE_NEEDS_USER' ? 'needs_user' : 'failed',
    candidateCount,
    savedCount: sourceIds.length,
    errorCode: code,
    errorMessage: message
  });
  return { source, receipt, sourceIds };
}

function assertWorkspace(database: DatabaseSync, workspaceId: string): void {
  const expected = workspaceId.trim();
  const stored = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
  if (!stored?.value) throw websiteError('WORKSPACE_ID_REQUIRED', '当前数据根没有工作空间身份。');
  if (!expected || stored.value !== expected) throw websiteError('WORKSPACE_ID_MISMATCH', '来源不属于当前工作空间。');
}

function assertUnchangedEnabledSource(database: DatabaseSync, original: WebsiteSource): WebsiteSource {
  const current = getWebsiteSource(database, original.id);
  if (!current || !current.enabled || current.revision !== original.revision) {
    throw websiteError('WEBSITE_SOURCE_STALE', '官网来源在扫描期间已变更。');
  }
  return current;
}

function findExistingFeedId(database: DatabaseSync, canonicalUrl: string): string | undefined {
  const rows = database.prepare('SELECT id FROM source_feeds WHERE url=? ORDER BY updated_at DESC, id DESC').all(canonicalUrl) as { id: string }[];
  if (rows.length > 1) throw websiteError('SOURCE_FEED_MATCH_REQUIRED', '同一规范 URL 存在多个资料来源，请明确选择要复用的来源。');
  return rows[0]?.id;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': WEBSITE_UA,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function unreadableTrial(url: string, code: string, message: string, httpStatus?: number, contentType?: string | null, requestedUrl = url): WebsitePage {
  return { body: null, trialRead: {
    title: '', url, requestedUrl, readable: false, itemCount: 0, summary: '', httpStatus, contentType: contentType ?? null,
    errorCode: code, errorMessage: message
  } };
}

function isTextResponse(contentType: string | null, body: string): boolean {
  const type = (contentType || '').toLowerCase();
  return /(?:^|\b)(text\/(html|plain|markdown)|application\/xhtml\+xml)(?:;|$)/.test(type)
    || (!type && /<(?:!doctype|html|head|body|article|main)\b/i.test(body));
}

function isSearchNavigation(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'bing.com' || host.endsWith('.bing.com') || host === 'go.microsoft.com' || host === 'r.bing.com') return true;
  return host === 'microsoft.com' && /\/(?:bing|search)(?:\/|$)/i.test(url.pathname);
}

function looksLikeChallenge(body: string): boolean {
  const sample = body.slice(0, 5000);
  return /(?:captcha|cloudflare|cf-browser-verification|cdn-cgi\/challenge|attention required|just a moment|access denied)/i.test(sample);
}

function extractTitle(body: string): string {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ?? '';
  return textFromHtml(title).slice(0, 180);
}

function textFromHtml(value: string): string {
  return decodeEntities(value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}
function decodeEntities(value: string): string {
  return value.replace(/&(amp|quot|#39|lt|gt);/gi, (_match, entity: string) => ({
    amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>'
  })[entity.toLowerCase()] ?? _match);
}
function canonicalOrFallback(value: string, fallback: string): string {
  try { return canonicalizeUrl(value); }
  catch { return canonicalizeUrl(fallback); }
}
function normalizeFetchUrl(value: string): string {
  canonicalizeUrl(value);
  const url = new URL(value.trim());
  url.hash = '';
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith('utm_') || ['fbclid', 'gclid', 'msclkid'].includes(normalized)) url.searchParams.delete(key);
  }
  return url.toString();
}
function normalizePublicFetchUrl(value: string): string {
  const url = normalizeFetchUrl(value);
  assertPublicUrl(url);
  return url;
}
function assertPublicUrl(value: string): void {
  const host = hostnameOf(new URL(value));
  if (!isNonPublicHost(host)) return;
  throw websiteError('WEBSITE_URL_NOT_PUBLIC', `不支持非公开网站地址：${host}。`);
}
function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}
function isNonPublicHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = isIP(host);
  if (version === 4) return isNonPublicIpv4(host);
  if (version !== 6) return false;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return isNonPublicIpv4(mapped);
  if (host === '::1') return true;
  const first = Number.parseInt(host.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
function isNonPublicIpv4(host: string): boolean {
  const [first, second] = host.split('.').map(Number);
  return first === 127 || first === 10 || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254);
}
function websiteError(code: string, message: string): WebsiteChannelError {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
function errorCode(error: unknown, fallback: string): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : fallback;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
