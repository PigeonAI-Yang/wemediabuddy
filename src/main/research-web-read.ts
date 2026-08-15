/**
 * Research read surface (WMB-5169): wmb_search_web / wmb_read_web_page.
 *
 * Design: docs/spark/2026-08-10-agent-research-job-design.md §6.1/§6.2/§6.5, SPEC CAP-028 §1/§11/§14.
 * - searchWeb reuses resolveWebsiteCandidates (channel candidate resolution + URL normalization)
 *   under an independent tool name/params/audit semantics; channel resolve/trial stays untouched.
 * - readWebPage: static body extraction first; on static failure a controlled headless-browser
 *   fallback renders dynamic public pages (render-only, no user-script interaction, no cookie/
 *   session injection, no second-platform login state). Captcha/login walls are never bypassed —
 *   explicit failure source_unavailable (reason auth_required), no credential carrying.
 * - Static and fallback share fail-closed web safety: assertPublicUrl SSRF guard (private /
 *   loopback / internal / link-local), DNS post-resolution target-IP re-check, per-hop redirect
 *   re-validation, streaming 2 MiB cap, document-type whitelist, ≤15 s deadline.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import type { BrowserContext, BrowserType } from 'playwright-core';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  assertPublicDns,
  assertPublicUrl,
  errorCode,
  errorMessage,
  extractTitle,
  fetchWebText,
  hostnameOf,
  isTextResponse,
  looksLikeChallenge,
  normalizePublicFetchUrl,
  resolveWebsiteCandidates,
  textFromHtml,
  type WebFetchedText
} from './website-channel.ts';

export const RESEARCH_READ_TIMEOUT_MS = 15_000;
export const RESEARCH_MAX_BYTES = 2 * 1024 * 1024;
export const RESEARCH_SEARCH_DEFAULT_LIMIT = 8;
export const RESEARCH_SEARCH_MAX_LIMIT = 40;

export type ResearchFailureReason =
  | 'invalid_url' | 'ssrf' | 'dns' | 'redirect' | 'too_large'
  | 'unsupported_type' | 'timeout' | 'network' | 'auth_required' | 'parse' | 'render' | 'unavailable';

export type ResearchWebResult = {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: 'SOURCE_UNAVAILABLE'; reason: ResearchFailureReason; message: string } | null;
};

export type RenderedPage = { status: number; contentType: string | null; finalUrl: string; title: string; bodyText: string };

/** Injectable render backend so tests exercise the fallback without a real browser. */
export type ResearchWebRenderFn = (
  url: string,
  options: { signal: AbortSignal; deadlineMs: number; maxBytes: number; validateUrl: (value: string) => Promise<void> | void }
) => Promise<RenderedPage>;

export type ResearchWebReadInput = {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  lookupImpl?: typeof lookup;
  renderFn?: ResearchWebRenderFn;
};

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

function success(data: Record<string, unknown>): ResearchWebResult {
  return { ok: true, data, error: null };
}

function failure(reason: ResearchFailureReason, message: string): ResearchWebResult {
  return { ok: false, data: null, error: { code: 'SOURCE_UNAVAILABLE', reason, message } };
}

function clampLimit(value: number): number {
  return Math.min(Math.max(Math.floor(value), 1), RESEARCH_SEARCH_MAX_LIMIT);
}

function searchFailureReason(error: unknown): ResearchFailureReason {
  const code = errorCode(error, '');
  if (code === 'WEBSITE_URL_NOT_PUBLIC') return 'ssrf';
  if (code === 'WEBSITE_INPUT_REQUIRED' || code === 'WEBSITE_URL_INVALID') return 'invalid_url';
  return 'network';
}

/** Public search candidate resolution (research read surface; channel resolve/trial untouched). */
export async function searchWeb(input: { query: string; limit?: number; fetchImpl?: typeof fetch }): Promise<ResearchWebResult> {
  const limit = input.limit == null ? RESEARCH_SEARCH_DEFAULT_LIMIT : clampLimit(input.limit);
  try {
    const candidates = await resolveWebsiteCandidates({ inputText: input.query, fetchImpl: input.fetchImpl, limit, maxCandidates: limit });
    return success({ query: input.query, resultCount: candidates.length, candidates });
  } catch (error) {
    return failure(searchFailureReason(error), errorMessage(error));
  }
}

function deadlineError(message: string): Error {
  return Object.assign(new Error(message), { code: 'WEBSITE_TIMEOUT' });
}

/** Bound an operation by the shared deadline; also cancels the abort listener on settle. */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(deadlineError(message)); return; }
    const onAbort = () => reject(deadlineError(message));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

async function dnsCheck(urlValue: string, lookupImpl?: typeof lookup): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await assertPublicDns(hostnameOf(new URL(urlValue)), lookupImpl);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

type StaticPageData = { url: string; requestedUrl: string; title: string; bodyText: string; httpStatus: number; contentType: string | null };
type StaticOutcome =
  | { kind: 'ok'; data: StaticPageData }
  | { kind: 'fail'; reason: ResearchFailureReason; message: string; retryable: boolean };

async function staticRead(
  requestedUrl: string,
  options: { signal: AbortSignal; fetchImpl?: typeof fetch; lookupImpl?: typeof lookup; maxBytes: number }
): Promise<StaticOutcome> {
  let fetched: WebFetchedText;
  try {
    fetched = await fetchWebText({
      url: requestedUrl,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      lookupImpl: options.lookupImpl,
      maxBytes: options.maxBytes
    });
  } catch (error) {
    const code = errorCode(error, '');
    const message = errorMessage(error);
    if (options.signal.aborted) return { kind: 'fail', reason: 'timeout', message: '网页读取超过时限。', retryable: true };
    switch (code) {
      case 'WEBSITE_URL_NOT_PUBLIC': return { kind: 'fail', reason: 'ssrf', message, retryable: false };
      case 'WEBSITE_DNS_FAILED':
      case 'WEBSITE_DNS_REBINDING': return { kind: 'fail', reason: 'dns', message, retryable: false };
      case 'WEBSITE_REDIRECT_LIMIT':
      case 'WEBSITE_REDIRECT_INVALID':
      case 'WEBSITE_REDIRECT_PROTOCOL': return { kind: 'fail', reason: 'redirect', message, retryable: false };
      case 'WEBSITE_BODY_TOO_LARGE': return { kind: 'fail', reason: 'too_large', message, retryable: false };
      case 'WEBSITE_TIMEOUT': return { kind: 'fail', reason: 'timeout', message, retryable: true };
      default: return { kind: 'fail', reason: 'network', message, retryable: true };
    }
  }
  if (fetched.status === 401 || fetched.status === 403 || fetched.status === 429) {
    return { kind: 'fail', reason: 'auth_required', message: `HTTP ${fetched.status}：网页要求登录或验证。`, retryable: false };
  }
  if (fetched.status >= 400) {
    return { kind: 'fail', reason: 'network', message: `HTTP ${fetched.status}。`, retryable: true };
  }
  if (looksLikeChallenge(fetched.body)) {
    return { kind: 'fail', reason: 'auth_required', message: '网页要求登录、验证或通过反自动化挑战。', retryable: false };
  }
  if (!isTextResponse(fetched.contentType, fetched.body)) {
    return { kind: 'fail', reason: 'unsupported_type', message: `不支持的内容类型：${fetched.contentType || 'unknown'}。`, retryable: false };
  }
  const title = extractTitle(fetched.body);
  const bodyText = textFromHtml(fetched.body);
  if (!title.trim() || bodyText.trim().length < 20) {
    return { kind: 'fail', reason: 'parse', message: '页面没有可确认的标题和正文。', retryable: true };
  }
  return { kind: 'ok', data: { url: fetched.finalUrl, requestedUrl: fetched.requestedUrl, title, bodyText, httpStatus: fetched.status, contentType: fetched.contentType } };
}

/**
 * Read one public web page: static extraction first, controlled headless-browser fallback on
 * retryable static failures. Every path shares the fail-closed web safety boundary; login/
 * captcha walls fail with reason auth_required and are never bypassed.
 */
export async function readWebPage(input: ResearchWebReadInput): Promise<ResearchWebResult> {
  const timeoutMs = input.timeoutMs ?? RESEARCH_READ_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? RESEARCH_MAX_BYTES;
  const deadlineMs = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Per-hop validation shared by static and fallback: public URL + post-resolution IP re-check.
  const validateUrl = async (value: string) => {
    assertPublicUrl(value);
    await assertPublicDns(hostnameOf(new URL(value)), input.lookupImpl);
  };
  try {
    let requestedUrl: string;
    try {
      requestedUrl = normalizePublicFetchUrl(input.url);
    } catch (error) {
      return failure(errorCode(error, '') === 'WEBSITE_URL_NOT_PUBLIC' ? 'ssrf' : 'invalid_url', errorMessage(error));
    }
    const pre = await dnsCheck(requestedUrl, input.lookupImpl);
    if (!pre.ok) return failure('dns', pre.message);

    let staticOutcome: StaticOutcome;
    try {
      staticOutcome = await withDeadline(
        staticRead(requestedUrl, { signal: controller.signal, fetchImpl: input.fetchImpl, lookupImpl: input.lookupImpl, maxBytes }),
        controller.signal,
        '网页读取超过时限。'
      );
    } catch (error) {
      return failure('timeout', errorMessage(error));
    }
    if (staticOutcome.kind === 'ok') {
      return success({ ...staticOutcome.data, renderMode: 'static' });
    }
    if (!staticOutcome.retryable) return failure(staticOutcome.reason, staticOutcome.message);

    const renderFn = input.renderFn ?? headlessRenderPublicPage;
    let rendered: RenderedPage;
    try {
      rendered = await withDeadline(
        renderFn(requestedUrl, { signal: controller.signal, deadlineMs, maxBytes, validateUrl }),
        controller.signal,
        '网页读取超过时限。'
      );
    } catch (error) {
      if (controller.signal.aborted || errorCode(error, '') === 'WEBSITE_TIMEOUT') return failure('timeout', '网页读取超过时限。');
      const code = errorCode(error, '');
      if (code === 'WEBSITE_URL_NOT_PUBLIC') return failure('ssrf', errorMessage(error));
      if (code === 'WEBSITE_DNS_FAILED' || code === 'WEBSITE_DNS_REBINDING') return failure('dns', errorMessage(error));
      if (code === 'WEBSITE_BODY_TOO_LARGE') return failure('too_large', errorMessage(error));
      if (code === 'WEBSITE_NEEDS_USER' || code === 'WEBSITE_AUTH_REQUIRED') return failure('auth_required', errorMessage(error));
      return failure('render', errorMessage(error));
    }

    try { await validateUrl(rendered.finalUrl); }
    catch (error) {
      const code = errorCode(error, '');
      if (code === 'WEBSITE_DNS_FAILED' || code === 'WEBSITE_DNS_REBINDING') return failure('dns', errorMessage(error));
      return failure('ssrf', errorMessage(error));
    }
    if (Buffer.byteLength(rendered.bodyText, 'utf8') > maxBytes) return failure('too_large', '网页正文超过 2 MiB 上限。');
    if (rendered.status === 401 || rendered.status === 403 || rendered.status === 429 || looksLikeChallenge(rendered.bodyText)) {
      return failure('auth_required', '网页要求登录、验证或通过反自动化挑战。');
    }
    if (!isTextResponse(rendered.contentType, rendered.bodyText)) {
      return failure('unsupported_type', `不支持的内容类型：${rendered.contentType || 'unknown'}。`);
    }
    if (!rendered.title.trim() && rendered.bodyText.trim().length < 20) {
      return failure('parse', '页面没有可确认的标题和正文。');
    }
    return success({
      url: rendered.finalUrl,
      requestedUrl,
      title: rendered.title,
      bodyText: rendered.bodyText,
      httpStatus: rendered.status,
      contentType: rendered.contentType,
      renderMode: 'fallback'
    });
  } finally {
    clearTimeout(timer);
  }
}

const RENDER_EXECUTABLE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function resolveRenderExecutable(): string | undefined {
  return RENDER_EXECUTABLE_CANDIDATES.find((candidate) => existsSync(candidate));
}

export type ResearchRouteRequest = { url: () => string; resourceType: () => string };
export type ResearchRouteActions = { continue: () => Promise<void>; abort: () => Promise<void> };

/**
 * Fail-closed per-request guard for the render fallback: only document navigations
 * (the initial load and every redirect hop) are validated; other resource types pass
 * through untouched. On validation failure the request is aborted and the original
 * safety error is returned so the caller can surface it — the handler itself never
 * throws, so route handlers cannot produce unhandled rejections.
 */
export async function guardResearchDocument(
  request: ResearchRouteRequest,
  actions: ResearchRouteActions,
  validateUrl: (value: string) => Promise<void> | void
): Promise<unknown | null> {
  if (request.resourceType() !== 'document') {
    await actions.continue();
    return null;
  }
  try {
    await validateUrl(request.url());
  } catch (error) {
    await actions.abort();
    return error;
  }
  await actions.continue();
  return null;
}

/**
 * Default fallback: render a dynamic public page in a fresh, isolated headless browser
 * (temp user-data-dir via launchPersistentContext → zero cookies/session), render-only
 * extraction. Every document navigation (initial + redirect hops) is intercepted and
 * validated fail-closed before dispatch; the final URL is re-validated by the caller.
 * Never performs user-script interaction or credential injection.
 */
export async function headlessRenderPublicPage(
  url: string,
  options: { signal: AbortSignal; deadlineMs: number; maxBytes: number; validateUrl: (value: string) => Promise<void> | void }
): Promise<RenderedPage> {
  const load = createRequire(import.meta.url);
  let isPackaged = false;
  if (process.versions.electron) {
    const electron = load('electron') as { app?: { isPackaged?: boolean } };
    isPackaged = Boolean(electron.app?.isPackaged);
  }
  const { chromium } = load(isPackaged
    ? path.join(process.resourcesPath, 'playwright-core')
    : 'playwright-core') as { chromium: BrowserType };
  const executablePath = resolveRenderExecutable();
  if (!executablePath) throw Object.assign(new Error('未找到可用的无头浏览器可执行文件。'), { code: 'WEBSITE_RENDER_UNAVAILABLE' });
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-research-render-'));
  const remainingMs = () => Math.max(0, options.deadlineMs - Date.now());
  let context: BrowserContext | undefined;
  try {
    // WMB-5175: playwright-core 1.62 forbids `--user-data-dir` inside chromium.launch args
    // (throws a misuse error before spawn), so the fresh temp profile is passed through the
    // official launchPersistentContext(userDataDir, …) API instead. The returned context
    // owns the browser process and starts with zero cookies/session (brand-new temp dir);
    // closing it releases the profile lock and our finally removes the temp directory.
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: true,
      args: ['--no-first-run', '--disable-gpu', '--disable-extensions', '--no-default-browser-check'],
      locale: 'en-US',
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    let status = 0;
    let contentType: string | null = null;
    let safetyError: unknown = null;
    // Intercept before dispatch: every document navigation (initial + redirect hops) is
    // validated fail-closed; a violating hop is aborted and its original safety error is
    // surfaced through goto instead of an opaque network error.
    await page.route('**/*', (route) => guardResearchDocument(
      route.request(),
      {
        continue: () => route.continue().catch(() => {}),
        abort: () => route.abort('blockedbyclient').catch(() => {})
      },
      options.validateUrl
    ).then((error) => { if (error) safetyError = error; }));
    page.on('response', (response) => {
      if (response.request().resourceType() === 'document') {
        status = response.status();
        contentType = response.headers()['content-type'] ?? null;
      }
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, remainingMs()) });
      if (safetyError) throw safetyError;
      await page.waitForLoadState('networkidle', { timeout: Math.min(3000, Math.max(1, remainingMs())) }).catch(() => {});
      if (safetyError) throw safetyError;
      const finalUrl = page.url();
      const title = (await page.title().catch(() => '')) || '';
      const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      // Cap by UTF-8 bytes, not JS string length — multi-byte text must not bypass the 2 MiB limit.
      if (Buffer.byteLength(bodyText, 'utf8') > options.maxBytes) {
        throw Object.assign(new Error('网页正文超过 2 MiB 上限。'), { code: 'WEBSITE_BODY_TOO_LARGE' });
      }
      return { status, contentType, finalUrl, title, bodyText };
    } catch (error) {
      if (safetyError) throw safetyError;
      throw error;
    }
  } finally {
    if (context) await context.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** MCP registration for the research read surface (stateless; no db/runtime needed). */
export function registerResearchWebMcp(server: McpServer): void {
  server.registerTool('research.search_web', {
    description: '研究读面（只读）：公网搜索候选解析，复用渠道候选解析底层；不写渠道、不创建来源。',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(RESEARCH_SEARCH_MAX_LIMIT).optional() }
  }, async ({ query, limit }) => text(await searchWeb({ query, limit })));
  server.registerTool('research.read_web_page', {
    description: '研究读面（只读）：公网页面静态正文提取优先；静态失败时受控无头浏览器渲染动态公网页（仅渲染只读、不注入会话、不绕验证码/登录墙）。',
    inputSchema: { url: z.string().min(1) }
  }, async ({ url }) => text(await readWebPage({ url })));
}
