// WMB-5244 §7.3 / §8：官网渠道媒体发现与 Source 事务内冻结。
//
// 职责（只做官网渠道接线，不拥有迁移 DDL / 不下载字节）：
// - sanitizeMediaSnapshot：把抓回的页面 HTML 净化为有界媒体发现快照（≤1MiB），
//   只服务候选发现，绝不落库（Raw HTML 不是第二内容真源）；事务写完 Candidate 后即可丢弃。
// - discoverWebsiteMedia：按 DOM 顺序发现正文 img/srcset、video/source/poster、
//   og:image/og:video；相对 URL 按最终规范 URL 解析；排除 data/blob、favicon、头像、
//   广告位、已知 tracking pixel、声明宽或高 <64px；OG 图只在正文没有同 URL 时补入；
//   并按 MEDIA_LIMITS_DEFAULT 执行 20 图 / 4 视频策略（超限候选记 skipped_limit，不自动重试）。
// - persistWebsiteMediaCandidates：调用方事务内（dispatcher BEGIN IMMEDIATE，
//   transaction:false）经 db/media-archive-store.insertMediaCandidates 写入候选 +
//   初始 Attempt + media_archive Job，与 Source 保存同事务原子落库。
//
// 绑定规则（Main 2026-08-14）：候选只绑定 canonical URL 拥有所抓 DOM 的 Source；
// 列表页扫描产生的 item Source（URL 不等于抓取页规范 URL）不复制页面级媒体，
// 由 website-channel 在每次 Source 保存后按 item 原 URL 入队 media_discover 重发现。

import type { DatabaseSync } from 'node:sqlite';
import { MEDIA_LIMITS_DEFAULT, type MediaLimits } from '../shared/media-limits.ts';
import { normalizeRemoteUrl } from '../shared/media-candidates.ts';
import {
  insertMediaCandidates,
  type InsertMediaCandidatesInput,
  type MediaCandidateInput
} from './db/media-archive-store.ts';

/** 净化媒体发现快照上限（设计 §7.3：净化HTML最大1MiB）。 */
export const WEBSITE_MEDIA_SNAPSHOT_MAX_BYTES = 1024 * 1024;

export type WebsiteMediaKind = 'image' | 'video' | 'video_poster';

/** 发现来源（用于诊断/测试；不落库）。 */
export type WebsiteMediaSourceTag =
  | 'img'
  | 'srcset'
  | 'video'
  | 'source'
  | 'poster'
  | 'og:image'
  | 'og:video';

/** 一次发现出的有界媒体槽位（DOM 顺序；全局 ordinal 跨 kind 唯一，poster 复用父视频 ordinal）。 */
export type WebsiteDiscoveredMedia = Readonly<{
  kind: WebsiteMediaKind;
  url: string;
  /** 全局媒体序（DOM 顺序；跨 kind 唯一；poster 与父视频共享同一 ordinal）。 */
  ordinal: number;
  /** poster → 父视频 ordinal。 */
  parentOrdinal?: number;
  captionHint?: string | null;
  source: WebsiteMediaSourceTag;
}>;

// ---------------------------------------------------------------------------
// 净化快照（只服务发现；不落库）
// ---------------------------------------------------------------------------

/**
 * 把抓回的 HTML 净化为有界发现快照：剔除 script/style/noscript 内容（避免把 JS 字符串
 * 里的伪标签当媒体），再截断到 maxBytes。返回值只用于候选发现，绝不持久化。
 */
export function sanitizeMediaSnapshot(html: string, maxBytes = WEBSITE_MEDIA_SNAPSHOT_MAX_BYTES): string {
  if (!html) return '';
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  if (stripped.length <= maxBytes) return stripped;
  return stripped.slice(0, maxBytes);
}

// ---------------------------------------------------------------------------
// 排除规则（设计 §7.3）
// ---------------------------------------------------------------------------

/** 已知 tracking pixel / 遥测端点 URL 模式（大小写不敏感）。 */
const TRACKING_URL_RE = /(?:pixel|tracking|beacon|1x1|clear\.gif|transparent\.gif|spacer\.gif|blank\.gif|doubleclick|googletagmanager|google-analytics|googletag|gtag|piwik|matomo|mc\.yandex|segment\.io|amplitude|pxl|spx|beacons?)/i;
/** favicon / 图标捷径。 */
const FAVICON_URL_RE = /(?:favicon|apple-touch-icon|shortcut icon)/i;
/** 头像类 class/id/alt 提示。 */
const AVATAR_HINT_RE = /(?:avatar|profile-?photo|author-?photo|gravatar|user-?photo|account-?photo|headshot)/i;
/** 广告位 class/id 提示。 */
const AD_HINT_RE = /(?:^|[-_])(?:ad|ads|advert|sponsor|promo)(?:[-_]|$)|adsbygoogle|banner[-_]?ad|ad[-_]?slot|advertisement/i;

function declaredDimensionTooSmall(widthRaw: string | undefined, heightRaw: string | undefined, minPx: number): boolean {
  const numeric = (value: string | undefined): number | null => {
    if (!value) return null;
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const width = numeric(widthRaw);
  const height = numeric(heightRaw);
  if (width !== null && width < minPx) return true;
  if (height !== null && height < minPx) return true;
  return false;
}

function isExcludedMedia(
  url: string,
  element: Readonly<{ width?: string; height?: string; className?: string; class?: string; id?: string; alt?: string }>,
  minPx: number
): boolean {
  if (TRACKING_URL_RE.test(url)) return true;
  if (FAVICON_URL_RE.test(url)) return true;
  if (declaredDimensionTooSmall(element.width, element.height, minPx)) return true;
  const hints = `${element.className ?? element.class ?? ''} ${element.id ?? ''} ${element.alt ?? ''}`;
  if (AVATAR_HINT_RE.test(hints)) return true;
  if (AD_HINT_RE.test(hints)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTML 扫描（正则，与 intelligence-wire-pages.extractReleaseItems 同风格）
// ---------------------------------------------------------------------------

type RawElement = Readonly<{
  tag: 'img' | 'video' | 'source' | 'meta';
  attrs: Readonly<Record<string, string>>;
  /** video 元素内的 source 子元素 src 集合。 */
  childSources: string[];
}>;

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function parseAttributes(tagText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(tagText))) {
    const key = match[1]?.toLowerCase();
    if (!key) continue;
    attrs[key] = (match[3] ?? match[4] ?? match[5] ?? '').trim();
  }
  return attrs;
}

function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((entry) => (entry.trim().split(/\s+/)[0] ?? '').trim())
    .filter(Boolean);
}

/**
 * 按 DOM 顺序扫描快照中的 img / video（含 source 子元素）/ meta(og:*) 标签。
 * video 与 img 以出现顺序交错返回；meta 也按文档顺序。
 */
export function scanWebsiteMediaElements(html: string): RawElement[] {
  const out: RawElement[] = [];
  // 每次匹配一个标签：img / video 开始标签 / source / meta；</video> 闭合 video 上下文。
  const TAG_RE = /<(img|video|source|meta)\b[^>]*>|<\/video>/gi;
  let match: RegExpExecArray | null;
  let videoIndex: number | null = null;
  while ((match = TAG_RE.exec(html))) {
    const tagText = match[0];
    if (tagText === '</video>') {
      videoIndex = null;
      continue;
    }
    const name = (match[1] ?? '').toLowerCase() as RawElement['tag'];
    if (name === 'source') {
      // 仅作为 video 子元素收集（<picture> 内的 source 不纳入官网发现）。
      if (videoIndex !== null) {
        const attrs = parseAttributes(tagText);
        if (attrs.src) out[videoIndex].childSources.push(attrs.src);
      }
      continue;
    }
    // 非 source 标签闭合当前 video 上下文（HTML 中 video 不嵌套）。
    videoIndex = null;
    if (name === 'video') {
      out.push({ tag: 'video', attrs: parseAttributes(tagText), childSources: [] });
      videoIndex = out.length - 1;
      continue;
    }
    out.push({ tag: name, attrs: parseAttributes(tagText), childSources: [] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 发现主流程（设计 §7.3：DOM 顺序 + OG 兜底 + 限额）
// ---------------------------------------------------------------------------

export function discoverWebsiteMedia(input: {
  html: string;
  /** 抓取页最终规范 URL（相对 URL 的解析基准）。 */
  baseUrl: string;
  limits?: MediaLimits;
}): WebsiteDiscoveredMedia[] {
  const limits = input.limits ?? MEDIA_LIMITS_DEFAULT;
  let base: URL;
  try {
    base = new URL(input.baseUrl);
  } catch {
    return [];
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return [];

  const snapshot = sanitizeMediaSnapshot(input.html);
  const elements = scanWebsiteMediaElements(snapshot);

  const discovered: WebsiteDiscoveredMedia[] = [];
  // stable identity → 已入列 URL（OG 兜底按同 URL 去重；正文内同 URL 也去重）。
  const seenIdentity = new Set<string>();
  // 全局媒体序（设计 §6.1/§7.3：DOM 顺序，跨 kind 唯一；poster 复用父视频 ordinal，
  // 与父视频共享 → store 按 (revKey, ordinal) 解析 parent_candidate_id 不会歧义）。
  let ordinal = 0;
  let videoOrdinal = 0;
  let imageOrdinal = 0;
  const maxImages = limits.maxImagesPerRevision;
  const maxVideos = limits.maxVideosPerRevision;
  // 超限候选也保留（skipped_limit），但行数有界：同策略上限再各留一份。
  const maxImageRows = maxImages * 2;
  const maxVideoRows = maxVideos * 2;

  const resolveUrl = (raw: string): string | null => {
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return null;
    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      return null;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    resolved.hash = '';
    return resolved.toString();
  };

  const addMedia = (kind: WebsiteMediaKind, url: string, source: WebsiteMediaSourceTag, parentOrdinal?: number, captionHint?: string | null): number | null => {
    const identity = normalizeRemoteUrl(url);
    if (seenIdentity.has(identity)) return null;
    if (kind === 'video') {
      if (videoOrdinal >= maxVideoRows) return null;
    } else if (kind === 'image' && imageOrdinal >= maxImageRows) return null;
    // video_poster 只随父视频产生（parentOrdinal 非空），天然 ≤ 视频行数，无需额外上限。
    seenIdentity.add(identity);
    const assigned = kind === 'video_poster' ? (parentOrdinal ?? ordinal) : ordinal;
    discovered.push({
      kind,
      url,
      ordinal: assigned,
      ...(parentOrdinal !== undefined ? { parentOrdinal } : {}),
      ...(captionHint ? { captionHint } : {}),
      source
    });
    if (kind === 'video') {
      videoOrdinal += 1;
      ordinal += 1;
    } else if (kind === 'image') {
      imageOrdinal += 1;
      ordinal += 1;
    }
    // video_poster 与父视频共享 ordinal，不推进全局序。
    return assigned;
  };

  const addImageIfAllowed = (
    urlRaw: string,
    source: WebsiteMediaSourceTag,
    element: Readonly<{ width?: string; height?: string; className?: string; id?: string; alt?: string }>
  ): void => {
    const url = resolveUrl(urlRaw);
    if (!url) return;
    if (isExcludedMedia(url, element, limits.minMediaDimensionPx)) return;
    addMedia('image', url, source, undefined, element.alt || undefined);
  };

  // 设计 §7.3：Candidate 按 DOM 顺序；OG 图只在正文没有同 URL 时补入。
  // 先处理正文 img/video（DOM 顺序），再补 og:image/og:video —— 正文同 URL 优先，OG 去重兜底。
  for (const element of elements) {
    if (element.tag === 'img') {
      const attrs = element.attrs;
      if (attrs.src) addImageIfAllowed(attrs.src, 'img', attrs);
      if (attrs.srcset) {
        for (const candidate of srcsetUrls(attrs.srcset)) addImageIfAllowed(candidate, 'srcset', attrs);
      }
      continue;
    }
    if (element.tag === 'video') {
      const attrs = element.attrs;
      const videoUrls: Array<{ url: string; tag: 'video' | 'source' }> = [];
      if (attrs.src) videoUrls.push({ url: attrs.src, tag: 'video' });
      for (const src of element.childSources) videoUrls.push({ url: src, tag: 'source' });
      let firstVideoOrdinal: number | null = null;
      for (const { url: raw, tag } of videoUrls) {
        const url = resolveUrl(raw);
        if (!url) continue;
        if (isExcludedMedia(url, attrs, limits.minMediaDimensionPx)) continue;
        const assigned = addMedia('video', url, tag, undefined, undefined);
        if (firstVideoOrdinal === null && assigned !== null) firstVideoOrdinal = assigned;
      }
      // poster：单独归档为 video_poster，父引用指向该元素第一个 video 候选 ordinal。
      if (attrs.poster && firstVideoOrdinal !== null) {
        const posterUrl = resolveUrl(attrs.poster);
        if (posterUrl && !isExcludedMedia(posterUrl, attrs, limits.minMediaDimensionPx)) {
          addMedia('video_poster', posterUrl, 'poster', firstVideoOrdinal, attrs.alt || undefined);
        }
      }
      continue;
    }
  }
  // OG 兜底（正文处理完后补入；seenIdentity 保证正文同 URL 已占用时不重复）。
  for (const element of elements) {
    if (element.tag !== 'meta') continue;
    const property = (element.attrs.property ?? element.attrs.name ?? '').toLowerCase().trim();
    const content = element.attrs.content ?? '';
    if (property === 'og:image' && content) {
      addImageIfAllowed(content, 'og:image', element.attrs);
    } else if (property === 'og:video' && content) {
      const url = resolveUrl(content);
      if (url && !isExcludedMedia(url, element.attrs, limits.minMediaDimensionPx)) {
        addMedia('video', url, 'og:video');
      }
    }
  }
  return discovered;
}

// ---------------------------------------------------------------------------
// 同事务持久化（设计 §7.1：Candidate + 初始 Attempt + Job 与 Source 同事务）
// ---------------------------------------------------------------------------

export type WebsiteMediaPersistResult = Readonly<{
  candidateIds: readonly string[];
  inserted: readonly string[];
  reused: readonly string[];
  pendingCount: number;
  skippedLimitCount: number;
  archiveJobCount: number;
}>;

/**
 * 把页面发现结果冻结为候选 + 首个 Attempt + media_archive Job。
 * transaction:false —— 调用方（website-channel persistWebsiteSourceScan，位于
 * dispatcher BEGIN IMMEDIATE 或显式事务内）持有事务，与 Source 同提交。
 * 超限候选以 status='skipped_limit' 落库（无 Attempt/Job，不自动重试）。
 */
export function persistWebsiteMediaCandidates(
  database: DatabaseSync,
  input: {
    sourceId: string;
    sourceRevisionKey: string;
    requestId: string;
    discoveredAt: string;
    html: string;
    baseUrl: string;
    limits?: MediaLimits;
  }
): WebsiteMediaPersistResult {
  const limits = input.limits ?? MEDIA_LIMITS_DEFAULT;
  const discovered = discoverWebsiteMedia({ html: input.html, baseUrl: input.baseUrl, limits });
  if (!discovered.length) {
    return { candidateIds: [], inserted: [], reused: [], pendingCount: 0, skippedLimitCount: 0, archiveJobCount: 0 };
  }

  const maxImages = limits.maxImagesPerRevision;
  const maxVideos = limits.maxVideosPerRevision;
  let imageSeen = 0;
  let videoSeen = 0;
  const candidates: MediaCandidateInput[] = discovered.map((media) => {
    let status: 'skipped_limit' | undefined;
    if (media.kind === 'video') {
      status = videoSeen >= maxVideos ? 'skipped_limit' : undefined;
      videoSeen += 1;
    } else {
      // poster 计入图片策略配额（ResearchMediaWiring 同口径：image+video_poster ≤ 20）。
      status = imageSeen >= maxImages ? 'skipped_limit' : undefined;
      imageSeen += 1;
    }
    return {
      kind: media.kind,
      originalUrl: media.url,
      ordinal: media.ordinal,
      ...(media.parentOrdinal !== undefined ? { parentOrdinal: media.parentOrdinal } : {}),
      ...(media.captionHint ? { captionHint: media.captionHint } : {}),
      ...(status ? { status } : {})
    };
  });

  // 分批写入：store 单批上限 = maxImages + maxVideos；pending 与 skipped_limit 各一批。
  const pending = candidates.filter((candidate) => !candidate.status);
  const skipped = candidates.filter((candidate) => candidate.status === 'skipped_limit');
  const storeInput = (batch: MediaCandidateInput[]): InsertMediaCandidatesInput => ({
    sourceId: input.sourceId,
    sourceRevisionKey: input.sourceRevisionKey,
    channel: 'official_web',
    requestId: input.requestId,
    discoveredAt: input.discoveredAt,
    candidates: batch
  });
  const pendingResult = pending.length ? insertMediaCandidates(database, storeInput(pending)) : { candidateIds: [], inserted: [], reused: [] };
  const skippedResult = skipped.length ? insertMediaCandidates(database, storeInput(skipped)) : { candidateIds: [], inserted: [], reused: [] };
  return {
    candidateIds: [...pendingResult.candidateIds, ...skippedResult.candidateIds],
    inserted: [...pendingResult.inserted, ...skippedResult.inserted],
    reused: [...pendingResult.reused, ...skippedResult.reused],
    pendingCount: pending.length,
    skippedLimitCount: skipped.length,
    archiveJobCount: pending.length
  };
}
