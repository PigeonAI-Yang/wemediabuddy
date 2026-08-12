import { DatabaseSync } from 'node:sqlite';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
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

export type WebsiteSourceScanRead = { original: WebsiteSource; checkedAt: string; page: { body: string | null; trialRead: WebsiteTrialRead } };
type WebsitePage = WebsiteSourceScanRead['page'];

type WebsiteChannelError = Error & { code: string };

export async function resolveWebsiteCandidates(input: {
  inputText: string;
  fetchImpl?: typeof fetch;
  limit?: number;
  maxCandidates?: number;
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

  const resolved = parseBingCandidates(body, inputText, input.limit ?? input.maxCandidates ?? MAX_CANDIDATES, input.maxCandidates ?? MAX_CANDIDATES);
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

export type ScanWebsiteSourceInput = { taskId: string; workspaceId: string; sourceId: string; fetchImpl?: typeof fetch };

export async function readWebsiteSourceScan(database: DatabaseSync, input: ScanWebsiteSourceInput): Promise<WebsiteSourceScanRead> {
  assertWorkspace(database, input.workspaceId);
  const original = getWebsiteSource(database, input.sourceId);
  if (!original) throw websiteError('WEBSITE_SOURCE_NOT_FOUND', '官网来源不存在。');
  if (!original.enabled) throw websiteError('WEBSITE_SOURCE_DISABLED', '官网来源已停用。');
  const checkedAt = new Date().toISOString();
  const page = await readWebsitePage(original.trialRead.requestedUrl ?? original.canonicalUrl, input.fetchImpl ?? globalThis.fetch);
  return { original, checkedAt, page };
}

export function persistWebsiteSourceScan(database: DatabaseSync, input: ScanWebsiteSourceInput, read: WebsiteSourceScanRead): WebsiteScanResult {
  assertWorkspace(database, input.workspaceId);
  if (read.original.id !== input.sourceId) throw websiteError('WEBSITE_SOURCE_STALE', '官网来源身份已变化。');
  const current = assertUnchangedEnabledSource(database, read.original);
  const { checkedAt, page } = read;
  if (!page.trialRead.readable) {
    const needsUser = page.trialRead.errorCode === 'WEBSITE_NEEDS_USER';
    const source = updateWebsiteSourceResolution(database, {
      id: current.id, resolutionStatus: needsUser ? 'needs_user' : 'failed', trialRead: page.trialRead,
      errorCode: page.trialRead.errorCode ?? 'WEBSITE_TRIAL_FAILED', errorMessage: page.trialRead.errorMessage ?? '网站试读失败。',
      expectedRevision: current.revision
    });
    const receipt = recordSourceScanReceipt(database, {
      taskId: input.taskId, workspaceId: input.workspaceId, module: 'official_web', sourceId: source.id,
      sourceFeedId: source.sourceFeedId, checkedAt, status: needsUser ? 'needs_user' : 'failed',
      errorCode: source.lastErrorCode, errorMessage: source.lastErrorMessage
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

export async function scanWebsiteSource(database: DatabaseSync, input: ScanWebsiteSourceInput): Promise<WebsiteScanResult> {
  return persistWebsiteSourceScan(database, input, await readWebsiteSourceScan(database, input));
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

function parseBingCandidates(html: string, inputText: string, limit: number, maxCandidates = MAX_CANDIDATES): { candidates: WebsiteCandidate[]; rejectedPrivate: boolean } {
  const boundedLimit = Math.min(Math.max(limit, 1), Math.max(maxCandidates, 1));
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
  let response: Response; let body = '';
  try {
    response = await fetchWithTimeout(fetchImpl, url, READ_TIMEOUT_MS);
    body = await response.text();
  } catch (error) {
    return unreadableTrial(url, 'WEBSITE_TRIAL_FAILED', errorMessage(error));
  }

  const requestedUrl = normalizePublicFetchUrl(url);
  let finalUrl: string;
  try {
    const responseUrl = normalizeFetchUrl(response.url || requestedUrl);
    assertPublicUrl(responseUrl);
    finalUrl = canonicalOrFallback(responseUrl, requestedUrl);
  } catch (error) {
    const finalUrl = canonicalOrFallback(response.url || requestedUrl, requestedUrl);
    return unreadableTrial(finalUrl, errorCode(error, 'WEBSITE_URL_NOT_PUBLIC'), errorMessage(error), response.status,
      response.headers.get('content-type'), requestedUrl);
  }
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

export const WEB_READ_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_READ_DEFAULT_MAX_REDIRECTS = 10;

export type WebFetchedText = {
  status: number;
  contentType: string | null;
  body: string;
  finalUrl: string;
  requestedUrl: string;
  hops: string[];
};

/**
 * DNS-rebinding guard: resolve every address for the host and reject when any
 * resolved target is a non-public address (fail-closed). Literal IP hosts are
 * already covered by the hostname-level assertPublicUrl check.
 */
export async function assertPublicDns(host: string, lookupImpl: typeof lookup = lookup): Promise<void> {
  if (isIP(host)) return;
  let addresses: LookupAddress[];
  try {
    addresses = await lookupImpl(host, { all: true });
  } catch (error) {
    throw websiteError('WEBSITE_DNS_FAILED', `无法解析主机：${host}。`);
  }
  if (!addresses.length) throw websiteError('WEBSITE_DNS_FAILED', `主机无解析记录：${host}。`);
  for (const { address } of addresses) {
    // Classify the raw address directly — IPv6 literals must not go through URL parsing
    // (bare forms like `2001:db8::1` would throw ERR_INVALID_URL without brackets).
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (isNonPublicHost(normalized)) {
      throw websiteError('WEBSITE_DNS_REBINDING', `主机 ${host} 解析到非公开地址：${address}。`);
    }
  }
}

/**
 * Safe web text read for research use: manual redirects with per-hop public-URL
 * re-validation, DNS resolution re-check before each hop and after the final
 * response, streaming 2 MiB body cap, and document-type whitelisting by the caller.
 * Throws WebsiteChannelError with a stable code; never follows non-http(s) redirects.
 */
export async function fetchWebText(input: {
  url: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  lookupImpl?: typeof lookup;
  maxBytes?: number;
  maxRedirects?: number;
}): Promise<WebFetchedText> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const lookupImpl = input.lookupImpl ?? lookup;
  const maxBytes = input.maxBytes ?? WEB_READ_DEFAULT_MAX_BYTES;
  const maxRedirects = input.maxRedirects ?? WEB_READ_DEFAULT_MAX_REDIRECTS;
  const hops: string[] = [];
  let currentUrl = normalizePublicFetchUrl(input.url);
  hops.push(currentUrl);
  for (let hop = 0; ; hop++) {
    await assertPublicDns(hostnameOf(new URL(currentUrl)), lookupImpl);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        signal: input.signal,
        redirect: 'manual',
        headers: {
          'user-agent': WEBSITE_UA,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1'
        }
      });
    } catch (error) {
      if (input.signal?.aborted) throw websiteError('WEBSITE_TIMEOUT', '网页读取超过时限。');
      throw websiteError('WEBSITE_NETWORK_FAILED', errorMessage(error));
    }
    if (response.status >= 300 && response.status < 400) {
      if (hop >= maxRedirects - 1) throw websiteError('WEBSITE_REDIRECT_LIMIT', '网页重定向次数过多。');
      const location = response.headers.get('location');
      if (!location) throw websiteError('WEBSITE_REDIRECT_INVALID', '重定向缺少目标地址。');
      let next: URL;
      try { next = new URL(location, currentUrl); }
      catch { throw websiteError('WEBSITE_REDIRECT_INVALID', '重定向目标地址无效。'); }
      if (!/^https?:$/.test(next.protocol)) throw websiteError('WEBSITE_REDIRECT_PROTOCOL', '重定向目标协议不受支持。');
      currentUrl = normalizePublicFetchUrl(next.toString());
      hops.push(currentUrl);
      continue;
    }
    const finalUrl = normalizeFetchUrl(response.url || currentUrl);
    assertPublicUrl(finalUrl);
    await assertPublicDns(hostnameOf(new URL(finalUrl)), lookupImpl);
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await readBodyCapped(response, maxBytes),
      finalUrl,
      requestedUrl: hops[0],
      hops
    };
  }
}

/** Stream the response body, aborting as soon as the byte cap is exceeded (never buffers past the limit). */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw websiteError('WEBSITE_BODY_TOO_LARGE', `网页正文超过 ${maxBytes} 字节上限。`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }
  return chunks.join('');
}

function unreadableTrial(url: string, code: string, message: string, httpStatus?: number, contentType?: string | null, requestedUrl = url): WebsitePage {
  return { body: null, trialRead: {
    title: '', url, requestedUrl, readable: false, itemCount: 0, summary: '', httpStatus, contentType: contentType ?? null,
    errorCode: code, errorMessage: message
  } };
}

export function isTextResponse(contentType: string | null, body: string): boolean {
  const type = (contentType || '').toLowerCase();
  return /(?:^|\b)(text\/(html|plain|markdown)|application\/xhtml\+xml)(?:;|$)/.test(type)
    || (!type && /<(?:!doctype|html|head|body|article|main)\b/i.test(body));
}

function isSearchNavigation(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'bing.com' || host.endsWith('.bing.com') || host === 'go.microsoft.com' || host === 'r.bing.com') return true;
  return host === 'microsoft.com' && /\/(?:bing|search)(?:\/|$)/i.test(url.pathname);
}

export function looksLikeChallenge(body: string): boolean {
  const sample = body.slice(0, 5000);
  return /(?:captcha|cloudflare|cf-browser-verification|cdn-cgi\/challenge|attention required|just a moment|access denied)/i.test(sample);
}

export function extractTitle(body: string): string {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ?? '';
  return textFromHtml(title).slice(0, 180);
}

export function textFromHtml(value: string): string {
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
export function normalizePublicFetchUrl(value: string): string {
  const url = normalizeFetchUrl(value);
  assertPublicUrl(url);
  return url;
}
export function assertPublicUrl(value: string): void {
  const host = hostnameOf(new URL(value));
  if (!isNonPublicHost(host)) return;
  throw websiteError('WEBSITE_URL_NOT_PUBLIC', `不支持非公开网站地址：${host}。`);
}
export function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}
function isNonPublicHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = isIP(host);
  if (version === 4) return isNonPublicIpv4(host);
  if (version !== 6) return false;
  return isNonPublicIpv6(host);
}
/** Normalize an IPv6 literal to exactly 8 hextets; a dotted-quad tail counts as two hextets. */
function ipv6ToHextets(host: string): string[] | null {
  const lower = host.toLowerCase();
  const doubleColon = lower.indexOf('::');
  const expandTail = (segments: string[]): string[] | null => {
    const last = segments[segments.length - 1] ?? '';
    if (!last.includes('.')) return segments;
    const bytes = last.split('.').map(Number);
    if (bytes.length !== 4 || !bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
    return [...segments.slice(0, -1), ((bytes[0] << 8) | bytes[1]).toString(16), ((bytes[2] << 8) | bytes[3]).toString(16)];
  };
  const countHextets = (segments: string[]): number => {
    const last = segments[segments.length - 1] ?? '';
    return last.includes('.') ? segments.length - 1 + 2 : segments.length;
  };
  if (doubleColon === -1) {
    const expanded = expandTail(lower.split(':'));
    return expanded && expanded.length === 8 ? expanded : null;
  }
  const left = lower.slice(0, doubleColon).split(':').filter((s) => s !== '');
  const right = lower.slice(doubleColon + 2).split(':').filter((s) => s !== '');
  const missing = 8 - countHextets(left) - countHextets(right);
  const expandedLeft = expandTail(left);
  const expandedRight = expandTail(right);
  if (!expandedLeft || !expandedRight || missing < 1) return null;
  return [...expandedLeft, ...new Array(missing).fill('0'), ...expandedRight];
}
/** Loopback, ULA/link-local prefixes, and IPv4-mapped/compatible tails whose embedded IPv4 is private (incl. hex/compressed forms). */
function isNonPublicIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === '::1') return true;
  const first = Number.parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
  const hextets = ipv6ToHextets(lower);
  if (!hextets) return false;
  // Mapped (::ffff:x.x.x.x) and compatible (::x.x.x.x) forms embed a 32-bit IPv4 tail.
  const prefix = hextets.slice(0, 6);
  const mapped = prefix[5] === 'ffff' && prefix.slice(0, 5).every((h) => h === '0');
  const compatible = prefix.every((h) => h === '0');
  if (mapped || compatible) {
    const a = Number.parseInt(hextets[6], 16);
    const b = Number.parseInt(hextets[7], 16);
    return isNonPublicIpv4(`${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`);
  }
  return false;
}
function isNonPublicIpv4(host: string): boolean {
  const [first, second] = host.split('.').map(Number);
  return first === 127 || first === 10 || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254);
}
export function websiteError(code: string, message: string): WebsiteChannelError {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
export function errorCode(error: unknown, fallback: string): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : fallback;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
