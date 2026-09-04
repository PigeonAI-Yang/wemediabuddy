// WMB-5244：X Lists 时间线媒体候选接线（设计 §7.2）。
// 职责：
// - 把已解析的 XListPost 媒体字段（images/imageThumbs/videoUrl/videoPoster/quotedPost/postKind）
//   转换为 source_media_candidates 输入（kind/originalUrl/postKind/postOrdinal/ordinalInPost/ordinal/parentOrdinal），
//   在调用方事务内（persistBoundXListTimeline 的 BEGIN IMMEDIATE）经 db/media-archive-store 的
//   insertMediaCandidates 冻结 Candidate + 初始 Attempt + media_archive Job，与 upsertSource 同提交；
// - 图片 original_url 取解析器产出的最佳可用 URL（images[i]=medium，缺省退 imageThumbs[i]）；
//   video poster 取可确定性获得的最高质量（twimg `name=orig`）；
// - 引用帖媒体保留 post_kind='quote' 并按「主帖媒体在前、引用帖媒体在后」排序，绝不混进主帖媒体序列；
//   引用组内非首条媒体以组根候选为 parent，poster 始终以同组 video 为 parent。
//
// 本模块不 BEGIN/COMMIT、不下载、不建 Asset；下载/限额/SSRF 由 ArchiveWorker 异步执行。

import type { DatabaseSync } from 'node:sqlite';
import type { XListPost } from './platforms/x-list-browser-types.ts';
import { normalizeMediaUrl } from './platforms/x-list-browser-dom.ts';
import { articleText } from './x-post-enrichment.ts';
import { sourceRevisionKey } from '../shared/media-candidates.ts';
import {
  insertMediaCandidates,
  type InsertMediaCandidatesResult,
  type MediaCandidateInput
} from './db/media-archive-store.ts';

/** 单媒体槽位（X 解析结果 → 候选输入的中间形态；可单测）。 */
export type XMediaSlot = Readonly<{
  kind: 'image' | 'video' | 'video_poster';
  originalUrl: string;
  /** 有序下载回退链（original_url 之后；store 写入 alternate_urls_json，worker 按序回退）。 */
  alternateUrls: readonly string[];
  postKind: 'tweet' | 'repost' | 'quote';
  postOrdinal: number;
  ordinalInPost: number;
  ordinal: number;
  /** 父候选 ordinal（同 Source revision 批内）：poster→视频；引用组内后续媒体→组根。 */
  parentOrdinal: number | null;
  captionHint: string | null;
  surroundingText: string | null;
}>;

/** surrounding_text 有界长度（设计 §8 候选字段上限）。 */
const SURROUNDING_TEXT_LIMIT = 2000;

function boundedText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, SURROUNDING_TEXT_LIMIT);
}
function appendSupplementalMedia(
  slots: XMediaSlot[],
  input: {
    post: Pick<XListPost, 'images' | 'imageThumbs' | 'videoUrl' | 'videoPoster' | 'text'>;
    postKind: XMediaSlot['postKind'];
    postOrdinal: number;
    startOrdinal: number;
    startInPost: number;
    captionHint: string | null;
  }
): { nextOrdinal: number; nextInPost: number } {
  let ordinal = input.startOrdinal;
  let inPost = input.startInPost;
  const groupRootOrdinal = ordinal;
  const surroundingText = boundedText(input.post.text);
  const imageCount = Math.max(input.post.images.length, input.post.imageThumbs.length);
  let groupHasMedia = false;
  for (let index = 0; index < imageCount; index += 1) {
    const primary = input.post.images[index] ?? input.post.imageThumbs[index] ?? '';
    if (!primary) continue;
    const thumb = input.post.imageThumbs[index];
    slots.push({
      kind: 'image',
      originalUrl: primary,
      alternateUrls: thumb && thumb !== primary ? [thumb] : [],
      postKind: input.postKind,
      postOrdinal: input.postOrdinal,
      ordinalInPost: inPost,
      ordinal,
      parentOrdinal: groupHasMedia ? groupRootOrdinal : null,
      captionHint: input.captionHint,
      surroundingText
    });
    groupHasMedia = true;
    ordinal += 1;
    inPost += 1;
  }
  if (input.post.videoUrl) {
    const videoOrdinal = ordinal;
    slots.push({
      kind: 'video',
      originalUrl: input.post.videoUrl,
      alternateUrls: [],
      postKind: input.postKind,
      postOrdinal: input.postOrdinal,
      ordinalInPost: inPost,
      ordinal: videoOrdinal,
      parentOrdinal: groupHasMedia ? groupRootOrdinal : null,
      captionHint: input.captionHint,
      surroundingText
    });
    if (input.post.videoPoster) {
      const poster = highestQualityPoster(input.post.videoPoster);
      slots.push({
        kind: 'video_poster',
        originalUrl: poster,
        alternateUrls: poster === input.post.videoPoster ? [] : [input.post.videoPoster],
        postKind: input.postKind,
        postOrdinal: input.postOrdinal,
        ordinalInPost: inPost,
        ordinal: videoOrdinal,
        parentOrdinal: videoOrdinal,
        captionHint: input.captionHint,
        surroundingText
      });
    }
    ordinal += 1;
    inPost += 1;
  }
  return { nextOrdinal: ordinal, nextInPost: inPost };
}

/**
 * 单个帖子的媒体槽位（主帖媒体在前、引用帖媒体在后；video poster 与视频共享 ordinal）。
 * startOrdinal 为批内起始全局序；返回 nextOrdinal 便于跨帖子连续编号。
 */
export function xPostMediaSlots(
  post: XListPost,
  postOrdinal: number,
  startOrdinal = 0
): { slots: XMediaSlot[]; nextOrdinal: number } {
  const ownKind: XMediaSlot['postKind'] = post.postKind === 'repost' || post.postKind === 'quote' ? post.postKind : 'tweet';
  const ownText = boundedText(post.text);
  const slots: XMediaSlot[] = [];
  let ordinal = startOrdinal;
  let inPost = 0;

  // ---- 主帖媒体：图片（images 为解析器产出最佳 URL；缺省退 thumb）----
  const imageCount = Math.max(post.images.length, post.imageThumbs.length);
  for (let index = 0; index < imageCount; index += 1) {
    const primary = post.images[index] ?? post.imageThumbs[index] ?? '';
    if (!primary) continue;
    const thumb = post.imageThumbs[index];
    slots.push({
      kind: 'image',
      originalUrl: primary,
      alternateUrls: thumb && thumb !== primary ? [thumb] : [],
      postKind: ownKind,
      postOrdinal,
      ordinalInPost: inPost,
      ordinal,
      parentOrdinal: null,
      captionHint: null,
      surroundingText: ownText
    });
    ordinal += 1;
    inPost += 1;
  }

  // ---- 主帖视频 + poster（poster 与视频共享 ordinal，parent 指向视频）----
  const videoOrdinal = ordinal;
  const hasVideoUrl = typeof post.videoUrl === 'string' && post.videoUrl.length > 0;
  if (hasVideoUrl) {
    slots.push({
      kind: 'video',
      originalUrl: post.videoUrl as string,
      alternateUrls: [],
      postKind: ownKind,
      postOrdinal,
      ordinalInPost: inPost,
      ordinal: videoOrdinal,
      parentOrdinal: null,
      captionHint: null,
      surroundingText: ownText
    });
    if (typeof post.videoPoster === 'string' && post.videoPoster) {
      slots.push({
        kind: 'video_poster',
        originalUrl: highestQualityPoster(post.videoPoster),
        alternateUrls: post.videoPoster !== highestQualityPoster(post.videoPoster) ? [post.videoPoster] : [],
        postKind: ownKind,
        postOrdinal,
        ordinalInPost: inPost,
        ordinal: videoOrdinal,
        parentOrdinal: videoOrdinal,
        captionHint: null,
        surroundingText: ownText
      });
    }
    ordinal += 1;
    inPost += 1;
  }

  // ---- 引用帖媒体：post_kind='quote'，追加在主帖媒体之后；组根为首条引用媒体 ----
  const quoted = post.quotedPost;
  if (quoted && (quoted.images.length || quoted.imageThumbs.length || (typeof quoted.videoUrl === 'string' && quoted.videoUrl))) {
    const quotedText = boundedText(quoted.text) ?? ownText;
    const quotedCount = Math.max(quoted.images.length, quoted.imageThumbs.length);
    const quotedRootOrdinal = ordinal;
    for (let index = 0; index < quotedCount; index += 1) {
      const primary = quoted.images[index] ?? quoted.imageThumbs[index] ?? '';
      if (!primary) continue;
      const thumb = quoted.imageThumbs[index];
      slots.push({
        kind: 'image',
        originalUrl: primary,
        alternateUrls: thumb && thumb !== primary ? [thumb] : [],
        postKind: 'quote',
        postOrdinal,
        ordinalInPost: inPost,
        ordinal,
        parentOrdinal: index === 0 ? null : quotedRootOrdinal,
        captionHint: null,
        surroundingText: quotedText
      });
      ordinal += 1;
      inPost += 1;
    }
    const quotedVideoOrdinal = ordinal;
    if (typeof quoted.videoUrl === 'string' && quoted.videoUrl) {
      slots.push({
        kind: 'video',
        originalUrl: quoted.videoUrl,
        alternateUrls: [],
        postKind: 'quote',
        postOrdinal,
        ordinalInPost: inPost,
        ordinal: quotedVideoOrdinal,
        parentOrdinal: quotedRootOrdinal === quotedVideoOrdinal ? null : quotedRootOrdinal,
        captionHint: null,
        surroundingText: quotedText
      });
      if (typeof quoted.videoPoster === 'string' && quoted.videoPoster) {
        slots.push({
          kind: 'video_poster',
          originalUrl: highestQualityPoster(quoted.videoPoster),
          alternateUrls: quoted.videoPoster !== highestQualityPoster(quoted.videoPoster) ? [quoted.videoPoster] : [],
          postKind: 'quote',
          postOrdinal,
          ordinalInPost: inPost,
          ordinal: quotedVideoOrdinal,
          parentOrdinal: quotedVideoOrdinal,
          captionHint: null,
          surroundingText: quotedText
        });
      }
      ordinal += 1;
      inPost += 1;
    }
    // 引用帖视频 poster 必须指向同组 video；组根永远不被 poster 规则覆盖。
  }

  for (const threadPost of post.authorThread ?? []) {
    const appended = appendSupplementalMedia(slots, {
      post: threadPost,
      postKind: ownKind,
      postOrdinal,
      startOrdinal: ordinal,
      startInPost: inPost,
      captionHint: '作者 Thread'
    });
    ordinal = appended.nextOrdinal;
    inPost = appended.nextInPost;
  }
  for (const threadPost of quoted?.authorThread ?? []) {
    const appended = appendSupplementalMedia(slots, {
      post: threadPost,
      postKind: 'quote',
      postOrdinal,
      startOrdinal: ordinal,
      startInPost: inPost,
      captionHint: '引用作者 Thread'
    });
    ordinal = appended.nextOrdinal;
    inPost = appended.nextInPost;
  }
  const articleGroups = [
    ...(post.articles ?? []).map((article) => ({ article, postKind: ownKind })),
    ...(quoted?.articles ?? []).map((article) => ({ article, postKind: 'quote' as const }))
  ];
  for (const { article, postKind } of articleGroups) {
    const images = article.blocks.filter((block) => block.kind === 'image').map((block) => block.url);
    const appended = appendSupplementalMedia(slots, {
      post: { images, imageThumbs: [], videoUrl: null, videoPoster: null, text: articleText(article) },
      postKind,
      postOrdinal,
      startOrdinal: ordinal,
      startInPost: inPost,
      captionHint: article.title ? `X Article · ${article.title}` : 'X Article'
    });
    ordinal = appended.nextOrdinal;
    inPost = appended.nextInPost;
  }
  return { slots, nextOrdinal: ordinal };
}

/**
 * poster 最高质量：twimg 命名 URL 升级到 `name=orig`（解析器只保留 thumb），
 * 非 twimg 原样返回（不做猜测性改写）。
 */
export function highestQualityPoster(value: string): string {
  let hostname = '';
  try {
    hostname = new URL(value).hostname;
  } catch {
    return value;
  }
  if (!/twimg\.com$/i.test(hostname)) return value;
  return normalizeMediaUrl(value, 'orig');
}

/** 整条时间线的媒体槽位（帖子顺序 → 媒体顺序；供测试与 wiring 复用）。 */
export function xTimelineMediaSlots(posts: readonly XListPost[]): XMediaSlot[][] {
  const result: XMediaSlot[][] = [];
  let ordinal = 0;
  for (const [postOrdinal, post] of posts.entries()) {
    const mapped = xPostMediaSlots(post, postOrdinal, ordinal);
    result.push(mapped.slots);
    ordinal = mapped.nextOrdinal;
  }
  return result;
}

function slotToCandidateInput(slot: XMediaSlot): MediaCandidateInput {
  return {
    kind: slot.kind,
    originalUrl: slot.originalUrl,
    channel: 'x_lists',
    postKind: slot.postKind,
    ...(slot.parentOrdinal != null ? { parentOrdinal: slot.parentOrdinal } : {}),
    postOrdinal: slot.postOrdinal,
    ordinalInPost: slot.ordinalInPost,
    ordinal: slot.ordinal,
    ...(slot.captionHint != null ? { captionHint: slot.captionHint } : {}),
    ...(slot.surroundingText != null ? { surroundingText: slot.surroundingText } : {}),
    ...(slot.alternateUrls.length > 0 ? { alternateUrls: slot.alternateUrls } : {})
  };
}

export type FreezeXTimelineMediaInput = Readonly<{
  sourceId: string;
  sourceRevision: number;
  post: XListPost;
  postOrdinal: number;
  /** 采集/观察键：候选 request_id（确定性，跨重放幂等）。 */
  requestId: string;
  discoveredAt: string;
}>;

/**
 * 冻结单个 Source（一条时间线帖）的媒体候选：调用方事务内写 Candidate + 初始 Attempt +
 * media_archive Job。无媒体槽位 → 零写入并返回空结果。
 */
export function freezeXTimelineMediaCandidates(
  database: DatabaseSync,
  input: FreezeXTimelineMediaInput
): InsertMediaCandidatesResult {
  const { slots } = xPostMediaSlots(input.post, input.postOrdinal);
  if (slots.length === 0) return { candidateIds: [], inserted: [], reused: [] };
  return insertMediaCandidates(database, {
    sourceId: input.sourceId,
    sourceRevisionKey: sourceRevisionKey(input.sourceId, input.sourceRevision),
    channel: 'x_lists',
    requestId: input.requestId,
    discoveredAt: input.discoveredAt,
    candidates: slots.map(slotToCandidateInput)
  });
}
