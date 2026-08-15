/**
 * WMB-5237 发布正文编译（纯函数，无 DB / 无浏览器依赖）。
 *
 * 真源约定：正文 token 永远保持 `![alt](wmb-asset://assetId)`；尺寸/对齐/裁切
 * 不进入 Markdown title/query/style。编译只消费「源 platform version 正文 + 平台媒体
 * 绑定」，产出平台可交付的正文与冻结的附件顺序（derivedAssetId || assetId，按 ordinal）。
 *
 * 平台规则：
 * - X / 小红书：移除全部 wmb-asset 图片 token（独立成段连同相邻空行一起收敛），
 *   图片只进附件/顺序；编译后正文不得残留任何内部 token。
 * - 知乎：首期仅接受一张明确标记为封面的图片；对应正文 token 被移除，图片作为封面上传。
 * - 微信：把 token 编译为真实图片表示 `<img src="wmb-asset://assetId">`（可被富文本
 *   适配器投递的形式）；当前适配器仅支持纯文本编辑器时必须在发布前 fail-closed，
 *   绝不把字面 token 发布，也绝不静默删图。
 * - 纯文本正文（无 token）逐字节不变。
 *
 * Token 解析/删除复用共享单一 parser（src/shared/media-token.ts），禁止第二套同名 parser。
 */
import { ASSET_IMAGE_SCHEME, parseAssetImages, removeAssetImageToken } from '../shared/media-token.ts';
import type { StudioAssetImageRef } from '../shared/media-token.ts';
import { buildAssetIdsFromPlatformBindings } from '../shared/media-bindings.ts';
import type { PlatformMediaBinding } from '../shared/media-bindings.ts';

export type PublicationMediaPlatform = 'x' | 'xiaohongshu' | 'wechat' | 'zhihu';

export type CompilePlatformBodyInput = Readonly<{
  /** 目标发布平台。 */
  platform: PublicationMediaPlatform;
  /** 源 platform version 正文（含 `![alt](wmb-asset://id)` token）。 */
  body: string;
  /** 该 platform version 的完整平台媒体绑定（按 ordinal 排序；缺行时由调用方按 asset_ids_json 合成）。 */
  bindings: readonly PlatformMediaBinding[];
}>;

export type CompilePlatformBodyResult = Readonly<{
  /** 编译后的可发布正文：无内部 markdown token；微信含真实图片表示时带 `<img>`。 */
  body: string;
  /** 冻结的附件顺序（derivedAssetId || assetId，按 ordinal）。 */
  assetIds: readonly string[];
  /** 被编译处理掉的图片 token 数。 */
  imageTokens: number;
  /** 编译后的正文是否包含真实图片表示（微信富文本图片）。 */
  inlineImages: boolean;
}>;

/** 编译后的正文仍包含 `wmb-asset://` markdown 图片 token。 */
export function containsInternalMediaToken(body: string): boolean {
  return parseAssetImages(body).length > 0;
}

/** 发布通道契约：已编译正文不得残留内部 token，否则明确拒绝执行。 */
export function assertNoInternalMediaToken(body: string): void {
  if (containsInternalMediaToken(body)) {
    throw new Error('发布正文仍包含内部图片标记，发布通道拒绝执行。请重新编译或检查平台版本。');
  }
}

const ESCAPED_ASSET_SCHEME = ASSET_IMAGE_SCHEME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const INLINE_ASSET_IMAGE_ELEMENT_RE = new RegExp(`<img\\b[^>]*\\bsrc="${ESCAPED_ASSET_SCHEME}[^"]*"`);

/** 编译后的正文是否包含真实图片表示（`<img src="wmb-asset://…">`，微信富文本图片）。 */
export function hasInlineAssetImageElement(body: string): boolean {
  return INLINE_ASSET_IMAGE_ELEMENT_RE.test(body);
}

/** 微信投递能力门：正文含真实图片表示但当前适配器无法投递时，发布前 fail-closed。 */
export function assertInlineAssetImageDeliverable(body: string): void {
  if (hasInlineAssetImageElement(body)) {
    throw new Error('正文包含图片，但当前公众号发布适配器仅支持纯文本编辑器填充，无法投递正文图片。已停止发布：请先在创作页移除正文图片，或手动发布本文。');
  }
}

/** 纯发布正文编译：平台版本正文 + 平台媒体绑定 → 可发布正文 + 冻结附件顺序。 */
export function compilePlatformBody(input: CompilePlatformBodyInput): CompilePlatformBodyResult {
  const tokens = parseAssetImages(input.body);
  const assetIds = buildAssetIdsFromPlatformBindings(input.bindings);
  if (input.platform === 'zhihu') {
    const cover = input.bindings[0];
    if (input.bindings.length > 1 || (cover && (!cover.isCover || cover.mediaKind !== 'image'))
      || tokens.some((token) => !cover || token.assetId !== cover.assetId)) {
      throw new Error('知乎首期试点仅支持一张明确标记为封面的图片；其他正文图片或附件暂不支持。');
    }
    const body = tokens.length > 0 ? normalizeBlankLines(removeAllAssetTokens(input.body, tokens)) : input.body;
    assertNoInternalMediaToken(body);
    return { body, assetIds, imageTokens: tokens.length, inlineImages: false };
  }
  if (tokens.length === 0) {
    // 纯文本正文逐字节不变。
    return { body: input.body, assetIds, imageTokens: 0, inlineImages: false };
  }
  const compiled = input.platform === 'wechat'
    ? compileWechatBody(input.body, tokens)
    : normalizeBlankLines(removeAllAssetTokens(input.body, tokens));
  assertNoInternalMediaToken(compiled);
  return { body: compiled, assetIds, imageTokens: tokens.length, inlineImages: input.platform === 'wechat' };
}

/** 按 token 起点倒序删除全部 token（共享 removeAssetImageToken：独立成段收相邻空行，行内收空格）。 */
function removeAllAssetTokens(body: string, tokens: readonly StudioAssetImageRef[]): string {
  let out = body;
  for (const ref of [...tokens].sort((a, b) => b.start - a.start)) {
    out = removeAssetImageToken(out, ref.assetId, ref.occurrence);
  }
  return out;
}

/** X/XHS 规范空行：段落间最多一个空行，去掉首部空行，尾部至多一个换行。 */
function normalizeBlankLines(body: string): string {
  const collapsed = body.replace(/\n{3,}/g, '\n\n');
  const noLeading = collapsed.replace(/^\n+/, '');
  return noLeading.replace(/\n+$/, '\n');
}

/** 微信编译：token → 真实图片表示 `<img>`；独立成段提升为 `<p><img></p>`。 */
function compileWechatBody(body: string, tokens: readonly StudioAssetImageRef[]): string {
  const standalone = new Set<number>();
  tokens.forEach((ref, index) => {
    if (isStandaloneParagraphToken(body, ref)) standalone.add(index);
  });
  let out = body;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const ref = tokens[index];
    const img = `<img src="${ASSET_IMAGE_SCHEME}${ref.assetId}" alt="${escapeHtmlAttribute(ref.alt)}">`;
    const replacement = standalone.has(index) ? `<p>${img}</p>` : img;
    out = `${out.slice(0, ref.start)}${replacement}${out.slice(ref.end)}`;
  }
  return out;
}

/** token 是否独占其所在段落（行内只有该 token 与空白）。 */
function isStandaloneParagraphToken(body: string, ref: StudioAssetImageRef): boolean {
  const lineStart = body.lastIndexOf('\n', ref.start - 1) + 1;
  const relativeEnd = body.indexOf('\n', ref.end);
  const lineEnd = relativeEnd === -1 ? body.length : relativeEnd;
  return body.slice(lineStart, lineEnd).trim() === ref.raw;
}

/** HTML 属性转义（img alt 中不允许出现裸引号/尖括号/&）。 */
function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
