/**
 * WMB-5244：统一媒体下载安全守卫（fetchWithMediaGuard）。
 * Design: docs/spark/2026-08-14-wmb-intelligence-media-production-pipeline-design.md §8。
 *
 * 逐跳执行：
 * 1. 只允许 HTTP/HTTPS；每次重定向重新解析主机与 DNS；拒绝环回、私网、链路本地、DNS rebinding。
 * 2. 先 HEAD；可信 Content-Length 超限直接 needs_user；HEAD 403/405 或缺长度才进入流式 GET。
 * 3. GET 写 staging，边读边计数，越限立即中止并清理。
 * 4. MIME 由响应头与文件签名共同确认；扩展名不作权威。MP4 检查 ftyp，WebM 检查 EBML，
 *    图片检查对应 magic bytes。
 * 5. 视频下载完成后做时长探测；超限 → needs_user，清理 staging，不登记 Asset。
 * 6. 校验完成后算 SHA-256、原子落位 assets/<sha256>.<ext>（内容寻址，幂等复用）。
 *
 * 注入缝：fetchImpl（默认全局 fetch）、resolveHost（默认 node:dns lookup）、
 * probeDurationMs（默认 media-archive-probe.ts）。测试经此三缝伪造 HTTP/DNS/时长。
 * 内存纪律：视频逐块写盘 + 流式哈希 + 仅头部 64KB 签名嗅探，绝不整文件进内存。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { promises as dnsPromises } from 'node:dns';
import { pipeline } from 'node:stream/promises';
import { pngDimensionsFromBytes } from './png-dimensions.ts';
import type { MediaLimits } from '../shared/media-limits.ts';
import { MEDIA_LIMITS_DEFAULT } from '../shared/media-limits.ts';

// ============================================================
// 模式与字节上限（限额单一真源 = shared/media-limits.ts；发现任务上限为 worker 运行时常量）
// ============================================================

export type MediaArchiveMode = 'image' | 'video' | 'html';

/** 发现任务（§7.3 净化 HTML 最大 1MiB）字节上限。 */
export const MEDIA_DISCOVERY_MAX_BYTES = 1024 * 1024;

/** 单 mode 字节上限（html = 发现任务上限；其余取 shared MEDIA_LIMITS_DEFAULT）。 */
export function maxBytesForMode(limits: MediaLimits, mode: MediaArchiveMode): number {
  if (mode === 'image') return limits.imageMaxBytes;
  if (mode === 'video') return limits.videoMaxBytes;
  return MEDIA_DISCOVERY_MAX_BYTES;
}

void MEDIA_LIMITS_DEFAULT;

// ============================================================
// 错误与状态分类
// ============================================================

export type MediaFetchErrorCode =
  | 'UNSUPPORTED_SCHEME'
  | 'UNSUPPORTED_STREAM'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MISLABELED_CONTENT'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'DURATION_LIMIT_EXCEEDED'
  | 'SSRF_BLOCKED'
  | 'DNS_FAILED'
  | 'TIMEOUT'
  | 'CONNECT_FAILED'
  | 'HTTP_401'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_408'
  | 'HTTP_425'
  | 'HTTP_429'
  | 'HTTP_5XX'
  | 'HTTP_ERROR'
  | 'REDIRECT_LIMIT'
  | 'REDIRECT_NO_LOCATION'
  | 'DISK_FAILED'
  | 'PROBE_FAILED'
  | 'FETCH_FAILED'
  | 'BODY_READ_FAILED';

/** fetch 层错误：已带确定性状态分类（candidate 七态中的 failed/needs_user/unsupported）。 */
export class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;
  /** candidate 落态（'failed' | 'needs_user' | 'unsupported'）。 */
  readonly candidateStatus: 'failed' | 'needs_user' | 'unsupported';
  /** 是否属临时失败（自动重试只处理 retryable=true 的 failed）。 */
  readonly retryable: boolean;

  constructor(code: MediaFetchErrorCode, message: string, overrides: Partial<Pick<MediaFetchError, 'candidateStatus' | 'retryable'>> = {}) {
    super(message);
    this.name = 'MediaFetchError';
    this.code = code;
    const classified = classifyMediaFetchCode(code);
    this.candidateStatus = overrides.candidateStatus ?? classified.candidateStatus;
    this.retryable = overrides.retryable ?? classified.retryable;
  }
}

const FETCH_CODE_CLASSIFICATION: Readonly<Record<MediaFetchErrorCode, { candidateStatus: 'failed' | 'needs_user' | 'unsupported'; retryable: boolean }>> = Object.freeze({
  UNSUPPORTED_SCHEME: { candidateStatus: 'unsupported', retryable: false },
  UNSUPPORTED_STREAM: { candidateStatus: 'unsupported', retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { candidateStatus: 'unsupported', retryable: false },
  MISLABELED_CONTENT: { candidateStatus: 'unsupported', retryable: false },
  SIZE_LIMIT_EXCEEDED: { candidateStatus: 'needs_user', retryable: false },
  DURATION_LIMIT_EXCEEDED: { candidateStatus: 'needs_user', retryable: false },
  SSRF_BLOCKED: { candidateStatus: 'failed', retryable: false },
  DNS_FAILED: { candidateStatus: 'failed', retryable: true },
  TIMEOUT: { candidateStatus: 'failed', retryable: true },
  CONNECT_FAILED: { candidateStatus: 'failed', retryable: true },
  HTTP_401: { candidateStatus: 'needs_user', retryable: false },
  HTTP_403: { candidateStatus: 'failed', retryable: true },
  HTTP_404: { candidateStatus: 'failed', retryable: false },
  HTTP_408: { candidateStatus: 'failed', retryable: true },
  HTTP_425: { candidateStatus: 'failed', retryable: true },
  HTTP_429: { candidateStatus: 'failed', retryable: true },
  HTTP_5XX: { candidateStatus: 'failed', retryable: true },
  HTTP_ERROR: { candidateStatus: 'failed', retryable: false },
  REDIRECT_LIMIT: { candidateStatus: 'failed', retryable: false },
  REDIRECT_NO_LOCATION: { candidateStatus: 'failed', retryable: false },
  DISK_FAILED: { candidateStatus: 'failed', retryable: true },
  PROBE_FAILED: { candidateStatus: 'needs_user', retryable: false },
  FETCH_FAILED: { candidateStatus: 'failed', retryable: true },
  BODY_READ_FAILED: { candidateStatus: 'failed', retryable: true }
});

export function classifyMediaFetchCode(code: MediaFetchErrorCode): { candidateStatus: 'failed' | 'needs_user' | 'unsupported'; retryable: boolean } {
  return FETCH_CODE_CLASSIFICATION[code];
}

function fetchError(code: MediaFetchErrorCode, message: string): MediaFetchError {
  return new MediaFetchError(code, message);
}

// ============================================================
// SSRF 防护：IP 与主机名判定
// ============================================================

function ipv4IsBlocked(bytes: readonly number[]): boolean {
  const [a, b, c, d] = bytes;
  if (a === 0) return true;                              // 0.0.0.0/8 本网络
  if (a === 10) return true;                             // 10/8 私网
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64/10 CGNAT
  if (a === 127) return true;                            // 127/8 环回
  if (a === 169 && b === 254) return true;               // 169.254/16 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16/12 私网
  if (a === 192 && b === 0 && c === 0) return true;      // 192.0.0/24 IANA 保留
  if (a === 192 && b === 0 && c === 2) return true;      // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 168) return true;               // 192.168/16 私网
  if (a === 198 && b === 18) return true;                // 198.18/15 基准
  if (a === 198 && b === 51 && c === 100) return true;   // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;    // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true;                             // 224/4 组播 + 240/4 保留
  void d;
  return false;
}

function ipv6IsBlocked(bytes: readonly number[]): boolean {
  const [a, b] = bytes;
  // ::1 环回、:: 未指定
  if (bytes.slice(0, 15).every((v) => v === 0) && bytes[15] <= 1) return true;
  // ::ffff:0:0/96 IPv4-mapped → 转 IPv4 判定
  if (bytes.slice(0, 10).every((v) => v === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return ipv4IsBlocked([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }
  if (a === 0xfc || a === 0xfd) return true;             // fc00::/7 唯一本地
  if (a === 0xfe && (b & 0xc0) === 0x80) return true;    // fe80::/10 链路本地
  if (a === 0xff) return true;                           // ff00::/8 组播
  if (a === 0x20 && b === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 文档
  if (a === 0x20 && b === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // 2001::/32 Teredo 隧道
  return false;
}

/** 判定 IP 是否属于环回/私网/链路本地/保留/组播（SSRF 黑名单）。 */
export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    return ipv4IsBlocked(ip.split('.').map((part) => Number(part)));
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true; // 解析失败按拒绝处理（fail-closed）
    return ipv6IsBlocked(bytes);
  }
  return true;
}

function ipv6ToBytes(ip: string): number[] | null {
  const zone = ip.indexOf('%');
  const address = zone >= 0 ? ip.slice(0, zone) : ip;
  const doubleColon = address.indexOf('::');
  if (doubleColon === -1) {
    const groups = address.split(':');
    if (groups.length !== 8) return null;
    return expandGroups(groups);
  }
  const left = doubleColon === 0 ? [] : address.slice(0, doubleColon).split(':');
  const right = doubleColon === address.length - 2 ? [] : address.slice(doubleColon + 2).split(':');
  if (left.length + right.length > 7) return null;
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  return expandGroups(groups);
}

function expandGroups(groups: string[]): number[] | null {
  const bytes: number[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      // 内嵌 IPv4 尾组（::ffff:1.2.3.4）
      if (group.includes('.') && index === groups.length - 1 && bytes.length === 12) {
        const parts = group.split('.').map((part) => Number(part));
        if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
        bytes.push(...parts);
        return bytes;
      }
      return null;
    }
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/** 主机名级预检：IP 字面量、localhost、*.local 直接判定；普通主机名走 DNS 解析。 */
export async function resolveHostAddresses(hostname: string, resolveHost?: (host: string) => Promise<string[]>): Promise<string[]> {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (net.isIP(host)) return [host];
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    // 保留名直接拒绝（不依赖 DNS，防测试环境 DNS 回环）。
    return ['127.0.0.1'];
  }
  if (resolveHost) return resolveHost(host);
  const records = await dnsPromises.lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** 对一批地址做 SSRF 判定；任一命中黑名单即拒绝（DNS rebinding：解析结果含私网即拒）。 */
function assertAddressesAllowed(addresses: string[], hostname: string): void {
  for (const address of addresses) {
    if (isPrivateIp(address)) {
      throw fetchError('SSRF_BLOCKED', `拒绝连接私网/环回/链路本地地址 ${address}（主机 ${hostname}）。`);
    }
  }
}

// ============================================================
// 媒体签名识别（magic bytes 权威；扩展名不作权威）
// ============================================================

export type SniffedMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/svg+xml'
  | 'video/mp4'
  | 'video/webm';

const IMAGE_ALLOWED: Readonly<Record<string, true>> = Object.freeze({
  'image/jpeg': true, 'image/png': true, 'image/gif': true, 'image/webp': true, 'image/svg+xml': true
});
const VIDEO_ALLOWED: Readonly<Record<string, true>> = Object.freeze({ 'video/mp4': true, 'video/webm': true });

export const MIME_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm'
});

const STREAM_HTTP_TYPES: Readonly<Record<string, true>> = Object.freeze({
  'application/vnd.apple.mpegurl': true,
  'application/x-mpegurl': true,
  'application/x-mpegURL': true,
  'application/dash+xml': true,
  'video/mp2t': true,
  'audio/mpegurl': true
});

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** 响应头 Content-Type（去参数、小写）。 */
export function declaredContentType(headerValue: string | null | undefined): string {
  return (headerValue ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * 文件签名识别。declaredType（响应头）仅用于「共同确认」：若声明为已知媒体类型但与
 * 签名家族不符 → 视为伪装内容（调用方据此拒绝）；签名本身决定最终类型。
 */
export function sniffMediaType(bytes: Buffer, _declaredType?: string | null): SniffedMediaType | null {
  const length = bytes.length;
  if (length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (length >= 6) {
    const header = bytes.toString('latin1', 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }
  if (length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
  if (length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    // EBML（WebM）：DocType 应为 'webm'，出现在文件头部 4KB 内。
    const head = bytes.subarray(0, Math.min(length, 4096)).toString('latin1');
    if (head.includes('webm')) return 'video/webm';
    return null; // EBML 但非 WebM DocType → 非允许格式
  }
  // SVG：文本型（XML 声明或 <svg 开头），跳过 BOM/空白。
  const head = bytes.subarray(0, Math.min(length, 512)).toString('utf8');
  const trimmed = head.replace(/^\uFEFF?\s*/, '');
  if (trimmed.startsWith('<svg') || trimmed.startsWith('<?xml') || trimmed.startsWith('<!DOCTYPE svg')) {
    return 'image/svg+xml';
  }
  return null;
}

/** 校验声明类型与签名的一致性；返回 sniffed 类型或抛 UNSUPPORTED/MISLABELED。 */
export function confirmMediaType(bytes: Buffer, mode: MediaArchiveMode, declared?: string | null): SniffedMediaType {
  const sniffed = sniffMediaType(bytes, declared);
  if (!sniffed) throw fetchError('UNSUPPORTED_MEDIA_TYPE', '文件签名不是允许的图片/视频格式。');
  const allowed = mode === 'image' ? IMAGE_ALLOWED : VIDEO_ALLOWED;
  if (!allowed[sniffed]) throw fetchError('UNSUPPORTED_MEDIA_TYPE', `签名类型 ${sniffed} 与请求模式 ${mode} 不符。`);
  const declaredType = declaredContentType(declared);
  if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== '') {
    const declaredFamily = declaredType.startsWith('image/') ? 'image' : declaredType.startsWith('video/') ? 'video' : null;
    if (!declaredFamily) throw fetchError('MISLABELED_CONTENT', `响应头声明非媒体类型 ${declaredType}。`);
    if (declaredFamily !== (sniffed.startsWith('image/') ? 'image' : 'video')) {
      throw fetchError('MISLABELED_CONTENT', `响应头 ${declaredType} 与文件签名 ${sniffed} 家族不符。`);
    }
  }
  return sniffed;
}

// ============================================================
// 逐跳受控请求（HEAD/GET 共用）
// ============================================================

type GuardedResponse = { response: Response; finalUrl: string };

async function fetchWithRedirectGuard(
  input: {
    url: string;
    method: 'HEAD' | 'GET';
    limits: MediaLimits;
    fetchImpl: typeof fetch;
    resolveHost: (hostname: string) => Promise<string[]>;
    externalSignal?: AbortSignal;
  }
): Promise<GuardedResponse> {
  let currentUrl = input.url;
  for (let hop = 0; hop <= input.limits.maxRedirects; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw fetchError('UNSUPPORTED_SCHEME', `URL 无法解析：${currentUrl}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw fetchError('UNSUPPORTED_SCHEME', `只允许 http/https，收到 ${parsed.protocol}//（${currentUrl}）。`);
    }
    // 每跳重新解析主机与 DNS（DNS rebinding 防护：解析结果含私网即拒）。
    // 主机名级保留名/IP 字面量检查与注入 resolveHost 无关（防测试/定制 DNS 缝绕过）。
    const hostname = parsed.hostname.replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw fetchError('SSRF_BLOCKED', `拒绝保留主机名 ${hostname}。`);
    }
    if (net.isIP(hostname) && isPrivateIp(hostname)) {
      throw fetchError('SSRF_BLOCKED', `拒绝私网/环回 IP 字面量 ${hostname}。`);
    }
    let addresses: string[];
    try {
      addresses = await input.resolveHost(hostname);
    } catch (error) {
      throw fetchError('DNS_FAILED', `DNS 解析失败 ${hostname}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!addresses.length) throw fetchError('DNS_FAILED', `DNS 解析无结果：${hostname}`);
    assertAddressesAllowed(addresses, hostname);

    const controller = new AbortController();
    if (input.externalSignal?.aborted) controller.abort();
    const onExternalAbort = (): void => controller.abort();
    input.externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const firstByteTimer = setTimeout(() => controller.abort(), input.limits.connectTimeoutMs);
    let response: Response;
    try {
      response = await input.fetchImpl(currentUrl, {
        method: input.method,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'WMB-MediaArchive/1.0' }
      });
    } catch (error) {
      const code = (error as { name?: string })?.name === 'AbortError' ? 'TIMEOUT' : 'CONNECT_FAILED';
      throw fetchError(code, `${input.method} ${currentUrl} 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(firstByteTimer);
      input.externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw fetchError('REDIRECT_NO_LOCATION', `跳转 ${response.status} 无 Location（${currentUrl}）。`);
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        throw fetchError('REDIRECT_NO_LOCATION', `跳转 Location 无法解析：${location}`);
      }
      continue;
    }
    return { response, finalUrl: currentUrl };
  }
  throw fetchError('REDIRECT_LIMIT', `重定向超过 ${input.limits.maxRedirects} 跳。`);
}

// ============================================================
// 下载结果与主入口
// ============================================================

export type StagedDownload = Readonly<{
  /** 最终落位绝对路径（image/video：assets/<sha256>.<ext>；html：staging 原路径）。 */
  filePath: string;
  /** staging .part 路径（调用方完成事务后清理；html 模式即 filePath）。 */
  stagingPath: string;
  /** assets 相对路径（html 模式为 null）。 */
  relativePath: string | null;
  sha256: string;
  mimeType: string;
  byteCount: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  runtimeName: string | null;
  runtimeVersion: string | null;
  /** 目标 assets 文件已存在（内容寻址复用）。 */
  reused: boolean;
}>;

export type MediaDurationProbeResult = Readonly<{ durationMs: number; runtimeName: string; runtimeVersion: string }>;

export type FetchWithMediaGuardInput = Readonly<{
  url: string;
  mode: MediaArchiveMode;
  limits: MediaLimits;
  dataRoot: string;
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  probeDurationMs?: (filePath: string, mimeType: string) => Promise<MediaDurationProbeResult>;
  signal?: AbortSignal;
  /** staging 文件标签（<candidateId>.a<attempt>），用于 GC 关联；缺省随机。 */
  downloadLabel?: string;
}>;

export type FetchWithMediaGuardResult =
  | { ok: true; staged: StagedDownload }
  | { ok: false; error: MediaFetchError };

/** 流式下载到 staging 文件，边写边计数；越限中止抛 SIZE_LIMIT_EXCEEDED。 */
async function streamBodyToFile(response: Response, filePath: string, maxBytes: number): Promise<number> {
  if (!response.body) throw fetchError('BODY_READ_FAILED', '响应无 body。');
  const out = createWriteStream(filePath, { flags: 'wx' });
  let total = 0;
  const source = new ReadableStreamToAsyncIterable(response.body);
  try {
    await pipeline(
      source,
      async function* (iterable: AsyncIterable<Uint8Array>) {
        for await (const chunk of iterable) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            throw fetchError('SIZE_LIMIT_EXCEEDED', `下载超过 ${maxBytes} 字节上限，已中止并清理。`);
          }
          yield chunk;
        }
      },
      out
    );
  } catch (error) {
    try { await out.destroy(); } catch { /* 已销毁 */ }
    throw error;
  } finally {
    // 提前终止（限额/超时/body 失败）时必须取消 Web 流 reader，避免泄漏底层 socket；
    // cancel 失败不影响原始错误（不掩蔽）。
    await source.cancelIfActive().catch(() => {});
  }
  return total;
}

/** 把 Web ReadableStream 适配为 async iterable（Node 运行时差异兼容），带取消传播。 */
class ReadableStreamToAsyncIterable implements AsyncIterable<Uint8Array> {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private cancelled = false;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      // 迭代提前退出（for-await 中断/消费者抛错）时取消 reader；正常读完时 cancel 为无害幂等。
      await this.cancelIfActive();
    }
  }
  async return(): Promise<IteratorReturnResult<undefined>> {
    await this.cancelIfActive();
    return { done: true, value: undefined };
  }
  async cancelIfActive(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    await this.reader.cancel().catch(() => {});
  }
}

/** 流式 SHA-256（大文件不进内存）。 */
async function sha256OfFile(filePath: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), async function* (iterable: AsyncIterable<Buffer>) {
    for await (const chunk of iterable) hash.update(chunk);
    yield Buffer.alloc(0);
  });
  return hash.digest('hex');
}

/** 读取头部 N 字节用于签名嗅探（≤64KB）。 */
async function readHeaderBytes(filePath: string, size = 64 * 1024): Promise<Buffer> {
  const { open } = await import('node:fs/promises');
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 统一媒体抓取守卫。成功：字节已校验（magic/MIME/大小/时长/SHA-256）并原子落位
 * assets/<sha256>.<ext>（html 模式仅落在 staging，调用方解析后清理）。
 * 失败：返回 {ok:false, error: MediaFetchError}（已确定性分类）。
 */
export async function fetchWithMediaGuard(input: FetchWithMediaGuardInput): Promise<FetchWithMediaGuardResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const resolveHost = input.resolveHost ?? ((hostname: string) => resolveHostAddresses(hostname));
  const stagingDir = path.join(input.dataRoot, 'staging', 'media');
  const label = (input.downloadLabel ?? randomUUID()).replace(/[:\\/]/g, '_');
  const stagingPath = path.join(stagingDir, `${label}.${randomUUID()}.part`);
  let keepStaging = false;

  try {
    // 1. URL 级预检：流媒体清单（m3u8/DASH/TS）确定性 unsupported。
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false, error: fetchError('UNSUPPORTED_SCHEME', `URL 无法解析：${input.url}`) };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: fetchError('UNSUPPORTED_SCHEME', `只允许 http/https，收到 ${url.protocol}//。`) };
    }
    const pathname = url.pathname.toLowerCase();
    if (pathname.endsWith('.m3u8') || pathname.endsWith('.m3u') || pathname.endsWith('.mpd') || pathname.endsWith('.ts')) {
      return { ok: false, error: fetchError('UNSUPPORTED_STREAM', 'HLS/DASH 分片流（m3u8/mpd/ts）不在直接归档范围。') };
    }

    await mkdir(stagingDir, { recursive: true });

    // 2. HEAD 预检：可信 Content-Length 超限直接 needs_user；403/405/缺长度才流式 GET。
    let head: GuardedResponse;
    try {
      head = await fetchWithRedirectGuard({
        url: input.url, method: 'HEAD', limits: input.limits, fetchImpl, resolveHost, externalSignal: input.signal
      });
    } catch (error) {
      if (error instanceof MediaFetchError) return { ok: false, error };
      throw error;
    }
    const headStatus = head.response.status;
    const headType = declaredContentType(head.response.headers.get('content-type'));
    if (STREAM_HTTP_TYPES[headType]) {
      return { ok: false, error: fetchError('UNSUPPORTED_STREAM', `响应类型 ${headType} 为流媒体清单，不支持直接归档。`) };
    }
    const headLength = head.response.headers.get('content-length');
    const maxBytes = maxBytesForMode(input.limits, input.mode);
    if (headStatus >= 200 && headStatus < 300 && headLength !== null && /^\d+$/.test(headLength)) {
      const declaredBytes = Number(headLength);
      if (declaredBytes > maxBytes) {
        return { ok: false, error: fetchError('SIZE_LIMIT_EXCEEDED', `HEAD 声明 ${declaredBytes} 字节超过上限 ${maxBytes}。`) };
      }
    }

    // 3. 流式 GET（HEAD 403/405 或 200 均继续——HEAD 无 body，字节以 GET 为准）。
    let get: GuardedResponse;
    try {
      get = await fetchWithRedirectGuard({
        url: input.url, method: 'GET', limits: input.limits, fetchImpl, resolveHost, externalSignal: input.signal
      });
    } catch (error) {
      if (error instanceof MediaFetchError) return { ok: false, error };
      throw error;
    }
    const status = get.response.status;
    const contentType = declaredContentType(get.response.headers.get('content-type'));
    if (STREAM_HTTP_TYPES[contentType]) {
      return { ok: false, error: fetchError('UNSUPPORTED_STREAM', `响应类型 ${contentType} 为流媒体清单，不支持直接归档。`) };
    }
    if (status === 401) return { ok: false, error: fetchError('HTTP_401', '需要登录授权（401）。') };
    if (status === 403) return { ok: false, error: fetchError('HTTP_403', '访问被拒绝（403）。') };
    if (status === 404) return { ok: false, error: fetchError('HTTP_404', '资源不存在（404）。') };
    if (status === 408) return { ok: false, error: fetchError('HTTP_408', '请求超时（408）。') };
    if (status === 425) return { ok: false, error: fetchError('HTTP_425', '服务器拒绝（425）。') };
    if (status === 429) return { ok: false, error: fetchError('HTTP_429', '请求过频（429）。') };
    if (status >= 500) return { ok: false, error: fetchError('HTTP_5XX', `服务器错误（${status}）。`) };
    if (status < 200 || status >= 300) {
      return { ok: false, error: fetchError('HTTP_ERROR', `意外 HTTP 状态 ${status}。`) };
    }

    let byteCount: number;
    try {
      byteCount = await streamBodyToFile(get.response, stagingPath, maxBytes);
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => {});
      if (error instanceof MediaFetchError) return { ok: false, error };
      return { ok: false, error: fetchError('BODY_READ_FAILED', `读取 body 失败：${error instanceof Error ? error.message : String(error)}`) };
    }

    if (input.mode === 'html') {
      // 发现任务：只落在 staging（不进入 assets），由调用方解析后清理。
      if (byteCount === 0) {
        await rm(stagingPath, { force: true }).catch(() => {});
        return { ok: false, error: fetchError('UNSUPPORTED_MEDIA_TYPE', '发现任务抓取为空页面。') };
      }
      const sha256 = await sha256OfFile(stagingPath);
      keepStaging = true;
      return {
        ok: true,
        staged: Object.freeze({
          filePath: stagingPath,
          stagingPath,
          relativePath: null,
          sha256,
          mimeType: contentType || 'text/html',
          byteCount,
          width: null,
          height: null,
          durationMs: null,
          runtimeName: null,
          runtimeVersion: null,
          reused: false
        })
      };
    }

    // 4. 签名 + MIME 共同确认（仅头部 64KB；类型由签名决定）。
    const headerBytes = await readHeaderBytes(stagingPath);
    let sniffed: SniffedMediaType;
    try {
      sniffed = confirmMediaType(headerBytes, input.mode, get.response.headers.get('content-type'));
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => {});
      if (error instanceof MediaFetchError) return { ok: false, error };
      throw error;
    }
    const extension = MIME_EXTENSION[sniffed] ?? '.bin';
    const sha256 = await sha256OfFile(stagingPath);
    const relativePath = path.posix.join('assets', `${sha256}${extension}`);
    const finalPath = path.join(input.dataRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(finalPath), { recursive: true });
    let reused = false;
    // 内容寻址：目标已存在视为同一字节（路径即 sha）→ 复用（跨平台确定性；Windows rename 会覆盖而非 EEXIST）。
    const existingDest = await stat(finalPath).catch(() => null);
    if (existingDest) {
      await rm(stagingPath, { force: true }).catch(() => {});
      reused = true;
    } else {
      try {
        await rename(stagingPath, finalPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY') {
          // 竞争窗口：另一连接刚落位同字节 → 复用。
          await rm(stagingPath, { force: true }).catch(() => {});
          reused = true;
        } else {
          await rm(stagingPath, { force: true }).catch(() => {});
          return { ok: false, error: fetchError('DISK_FAILED', `写入 assets 失败：${error instanceof Error ? error.message : String(error)}`) };
        }
      }
    }

    // 5. 视频时长探测（固定运行时；超 30 分钟 → needs_user，清理落位文件，不登记 Asset）。
    let durationMs: number | null = null;
    let runtimeName: string | null = null;
    let runtimeVersion: string | null = null;
    if (input.mode === 'video' && sniffed.startsWith('video/')) {
      try {
        const probe = input.probeDurationMs
          ? await input.probeDurationMs(finalPath, sniffed)
          : await import('./media-archive-probe.ts').then((m) => m.probeMediaDurationMs(finalPath, sniffed));
        durationMs = probe.durationMs;
        runtimeName = probe.runtimeName;
        runtimeVersion = probe.runtimeVersion;
        if (durationMs > input.limits.videoMaxDurationMs) {
          await rm(finalPath, { force: true }).catch(() => {});
          return { ok: false, error: fetchError('DURATION_LIMIT_EXCEEDED', `视频时长 ${Math.round(durationMs / 1000)}s 超过上限 ${Math.round(input.limits.videoMaxDurationMs / 1000)}s。`) };
        }
      } catch (error) {
        await rm(finalPath, { force: true }).catch(() => {});
        if (error instanceof MediaFetchError) return { ok: false, error };
        return { ok: false, error: fetchError('PROBE_FAILED', `视频时长探测失败：${error instanceof Error ? error.message : String(error)}`) };
      }
    }

    let width: number | null = null;
    let height: number | null = null;
    if (sniffed === 'image/png') {
      const dimensions = pngDimensionsFromBytes(headerBytes);
      width = dimensions?.width ?? null;
      height = dimensions?.height ?? null;
    }

    return {
      ok: true,
      staged: Object.freeze({
        filePath: finalPath,
        stagingPath,
        relativePath,
        sha256,
        mimeType: sniffed,
        byteCount,
        width,
        height,
        durationMs,
        runtimeName,
        runtimeVersion,
        reused
      })
    };
  } finally {
    // 失败路径已各自清理；html 成功路径保留 staging 供调用方解析；其余成功路径 staging 已被 rename/删除。
    if (!keepStaging) {
      try {
        const exists = await stat(stagingPath).catch(() => null);
        if (exists) await rm(stagingPath, { force: true });
      } catch {
        // 忽略清理失败（staging 残留由 GC 兜底）
      }
    }
  }
}
