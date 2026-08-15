// WMB-5237: Markdown `wmb-asset://` 图片 token 解析与精确变换 —— 单一实现（main/renderer 共用）。
// 无 Node 依赖（纯字符串操作）；main 的 binding 对账/backfill 与 renderer 的编辑器变换共用本文件，
// 禁止在 main 或 renderer 再建第二套同名 parser。
// 原实现自 src/renderer/studio-view-helpers.ts 平移，行为保持逐字节一致。

export const ASSET_IMAGE_SCHEME = 'wmb-asset://';

export type StudioAssetImageRef = {
  /** wmb-asset:// 后的资产 id（去转义）。 */
  assetId: string;
  /** 图注：alt 的转义解码文本（用于展示与回写）。 */
  alt: string;
  /** 完整 token 原文（`![…](…)`，含可选 title）。 */
  raw: string;
  /** token 起点（`!` 的偏移）。 */
  start: number;
  /** token 终点（闭括号之后）。 */
  end: number;
  /** alt 区段起点（`![` 之后）。 */
  altStart: number;
  /** alt 区段终点（`]` 之前，含转义原文）。 */
  altEnd: number;
  /** 相同 assetId 的第几次出现（0 起）。 */
  occurrence: number;
};

export type AssetImageRef = StudioAssetImageRef;

/** 解码 alt 中的合理转义：`\[` `\]` `\\` → 字面量；其余保留原样。 */
export const decodeAssetAlt = (raw: string): string => {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length && (raw[i + 1] === '[' || raw[i + 1] === ']' || raw[i + 1] === '\\')) {
      out += raw[i + 1];
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
};

/** 回写 alt 时转义，保证 token 可被再次解析且结构不变。 */
export const escapeAssetAlt = (alt: string): string => alt.replace(/([\\[\]])/g, '\\$1');

/** 构建与 importStudioImage.markdown 一致的资产图片 token。 */
export const assetImageToken = (alt: string, assetId: string): string => `![${escapeAssetAlt(alt)}](${ASSET_IMAGE_SCHEME}${assetId})`;

/** 解析正文中所有 `wmb-asset://` 图片 token（跳过代码围栏内文本），保留重复出现与 occurrence 序号。 */
export function parseAssetImages(body: string): StudioAssetImageRef[] {
  const refs: StudioAssetImageRef[] = [];
  if (!body.includes('![')) return refs;
  // 行偏移与围栏状态：``` 或 ~~~ 块内不算图片。
  const lineOffsets: number[] = [0];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\n') lineOffsets.push(i + 1);
  }
  const lines = body.split('\n');
  const fenceAt: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) inFence = !inFence;
    fenceAt.push(inFence);
  }
  const lineOf = (pos: number): number => {
    let low = 0;
    let high = lineOffsets.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineOffsets[mid] <= pos) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const occurrenceCounts = new Map<string, number>();
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const bang = body.indexOf('![', searchFrom);
    if (bang === -1) break;
    if (fenceAt[lineOf(bang)]) { searchFrom = bang + 2; continue; }
    // alt：带转义与嵌套方括号的扫描，到深度 0 的未转义 `]` 结束。
    let i = bang + 2;
    let depth = 0;
    let altEnd = -1;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '\\' && i + 1 < body.length) { i += 2; continue; }
      if (ch === '[') { depth += 1; i += 1; continue; }
      if (ch === ']') {
        if (depth === 0) { altEnd = i; break; }
        depth -= 1;
        i += 1;
        continue;
      }
      i += 1;
    }
    if (altEnd === -1) break;
    if (body[altEnd + 1] !== '(') { searchFrom = bang + 2; continue; }
    // destination：深度 0 的空白或 `)` 结束。
    let j = altEnd + 2;
    let depth2 = 0;
    let destRaw = '';
    let destEnd = -1;
    while (j < body.length) {
      const ch = body[j];
      if (ch === '\\') { destRaw += ch + (body[j + 1] ?? ''); j += 2; continue; }
      if (ch === '(') { depth2 += 1; destRaw += ch; j += 1; continue; }
      if (ch === ')') {
        if (depth2 === 0) { destEnd = j - 1; break; }
        depth2 -= 1;
        destRaw += ch;
        j += 1;
        continue;
      }
      if (depth2 === 0 && /\s/.test(ch)) { destEnd = j - 1; break; }
      destRaw += ch;
      j += 1;
    }
    if (destEnd === -1) break;
    // 可选 title（引号串）后必须紧跟 `)`，构成 token 终点。
    let k = destEnd + 1;
    while (k < body.length && /\s/.test(body[k])) k += 1;
    let tokenEnd = -1;
    if (body[k] === ')') {
      tokenEnd = k + 1;
    } else if (body[k] === '"' || body[k] === "'") {
      const quote = body[k];
      let m = k + 1;
      let closed = false;
      while (m < body.length) {
        const ch = body[m];
        if (ch === '\\' && m + 1 < body.length) { m += 2; continue; }
        if (ch === quote) { closed = true; m += 1; break; }
        m += 1;
      }
      if (!closed) break;
      while (m < body.length && /\s/.test(body[m])) m += 1;
      if (body[m] === ')') tokenEnd = m + 1;
      else break;
    } else {
      searchFrom = bang + 2;
      continue;
    }
    if (!destRaw.startsWith(ASSET_IMAGE_SCHEME)) { searchFrom = bang + 2; continue; }
    const assetId = destRaw.slice(ASSET_IMAGE_SCHEME.length);
    if (!assetId) { searchFrom = bang + 2; continue; }
    const occurrence = occurrenceCounts.get(assetId) ?? 0;
    occurrenceCounts.set(assetId, occurrence + 1);
    refs.push({
      assetId,
      alt: decodeAssetAlt(body.slice(bang + 2, altEnd)),
      raw: body.slice(bang, tokenEnd),
      start: bang,
      end: tokenEnd,
      altStart: bang + 2,
      altEnd,
      occurrence
    });
    searchFrom = tokenEnd;
  }
  return refs;
}

/** 原位替换指定（assetId, occurrence）token 为 nextToken；找不到则返回原样。 */
export function replaceAssetImageToken(body: string, assetId: string, occurrence: number, nextToken: string): string {
  const ref = parseAssetImages(body).find((item) => item.assetId === assetId && item.occurrence === occurrence);
  if (!ref || nextToken === ref.raw) return body;
  return `${body.slice(0, ref.start)}${nextToken}${body.slice(ref.end)}`;
}

/** 原位更新指定（assetId, occurrence）token 的 alt（自动转义）；找不到则返回原样。 */
export function updateAssetImageAlt(body: string, assetId: string, occurrence: number, alt: string): string {
  const ref = parseAssetImages(body).find((item) => item.assetId === assetId && item.occurrence === occurrence);
  if (!ref) return body;
  const encoded = escapeAssetAlt(alt);
  if (encoded === body.slice(ref.altStart, ref.altEnd)) return body;
  return `${body.slice(0, ref.altStart)}${encoded}${body.slice(ref.altEnd)}`;
}

/** 移除指定（assetId, occurrence）token；独立成段时顺带收掉一个相邻空行，行内时收掉一个空格。 */
export function removeAssetImageToken(body: string, assetId: string, occurrence: number): string {
  const ref = parseAssetImages(body).find((item) => item.assetId === assetId && item.occurrence === occurrence);
  if (!ref) return body;
  const newlineRun = (from: number, direction: 1 | -1): number => {
    let count = 0;
    let pos = direction === 1 ? from : from - 1;
    while (pos >= 0 && pos < body.length && (body[pos] === '\n' || body[pos] === '\r')) {
      count += 1;
      pos += direction;
    }
    return count;
  };
  let start = ref.start;
  let end = ref.end;
  const after = newlineRun(end, 1);
  if (after >= 2) end += Math.min(after, 4); // 一个空行单位（\r\n\r\n 或 \n\n）
  else if (after === 1) end += 1;
  if (start > 0 && end >= body.length) {
    const before = newlineRun(start, -1);
    if (before >= 2) start -= Math.min(before, 4);
    else if (before === 1) start -= 1;
  }
  if (start > 0 && body[start - 1] === ' ' && end < body.length && body[end] === ' ') end += 1;
  return `${body.slice(0, start)}${body.slice(end)}`;
}

/** 正文当前引用的去重资产 id 列表（顺序 = 首次出现顺序）。 */
export const referencedAssetIds = (body: string): string[] => [...new Set(parseAssetImages(body).map((ref) => ref.assetId))];
