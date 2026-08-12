// WMB-5207: Studio 正文批注 —— UI 侧纯逻辑（无 DOM / 无 React）。
// 所有权：UI agent。数据模型来自 ../shared/studio-annotations.ts（Data agent 所有）。
// 职责：选择区间校验、增量锚点迁移、指纹、上下文窗口、展示标签。
// 偏移量一律为正文 code-unit offset（UTF-16，与 textarea selectionStart/End、String.slice 一致）。

import type { StudioAnnotation, StudioDocumentScope } from '../shared/studio-annotations';

export type { StudioAnnotation, StudioDocumentScope };
export type StudioAnnotationRow = StudioAnnotation;

/** 批注上下文窗口：quotedText 前后各取多少个字符作为 prefix/suffixContext。 */
export const ANNOTATION_CONTEXT_WINDOW = 120;

/** 富文本展示会剥离的「首行标题」前缀长度（bodyWithoutLeadingTitle 的正则匹配长度）。 */
export const leadingTitleLength = (body: string): number => {
  const match = /^#\s+.+\r?\n+/.exec(body);
  return match ? match[0].length : 0;
};

/** 把选区收缩到首尾非空白字符；全空白/空选区返回 null。 */
export function trimToNonWhitespace(body: string, start: number, end: number): { start: number; end: number } | null {
  const length = body.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > length) return null;
  let s = start;
  let e = end;
  while (s < e && isWhitespace(body.charCodeAt(s))) s += 1;
  while (e > s && isWhitespace(body.charCodeAt(e - 1))) e -= 1;
  if (s >= e) return null;
  return { start: s, end: e };
}

export const isWhitespace = (code: number): boolean => code <= 0x20;

/** 选区文本是否包含 markdown 标题行（标题不可批注）。 */
export const containsHeadingLine = (text: string): boolean => /(^|\n)\s{0,3}#{1,6}\s+/.test(text);

export type SelectionValidation = { ok: true } | { ok: false; reason: 'empty' | 'out_of_bounds' | 'heading' | 'overlap' };

/**
 * 创建批注前的选区校验：
 * - 非空、不越界、含至少一个非空白字符；
 * - 不含标题行（markdown heading）；
 * - 不与任何未解决批注区间重叠（半开区间 [start, end)）。
 */
export function validateAnnotationSelection(
  body: string,
  start: number,
  end: number,
  openAnnotations: ReadonlyArray<Pick<StudioAnnotation, 'startOffset' | 'endOffset'>>
): SelectionValidation {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > body.length || start >= end) {
    return { ok: false, reason: start < 0 || end > body.length ? 'out_of_bounds' : 'empty' };
  }
  const slice = body.slice(start, end);
  if (!slice.trim()) return { ok: false, reason: 'empty' };
  if (containsHeadingLine(slice)) return { ok: false, reason: 'heading' };
  for (const annotation of openAnnotations) {
    if (start < annotation.endOffset && annotation.startOffset < end) return { ok: false, reason: 'overlap' };
  }
  return { ok: true };
}

/**
 * 增量锚点迁移（设计 §7.1）：以最长公共前后缀确定单一变更区间。
 * - 变更完全在标记之前：起止位置按净字符变化量平移；
 * - 变更完全在标记之后：位置不变；
 * - 变更与标记内部相交：立即以 reason='edited' 解决。
 * 只处理 open 行；resolved 行原样保留（历史记录）。
 */
export function shiftAnnotationRanges(
  rows: readonly StudioAnnotationRow[],
  previousBody: string,
  nextBody: string,
  nowIso = new Date().toISOString()
): StudioAnnotationRow[] {
  if (previousBody === nextBody) return rows.map((row) => ({ ...row }));
  const commonPrefix = longestCommonPrefix(previousBody, nextBody);
  const commonSuffix = longestCommonSuffix(previousBody, nextBody);
  const oldEnd = previousBody.length - commonSuffix;
  const newEnd = nextBody.length - commonSuffix;
  const net = newEnd - oldEnd;
  return rows.map((row) => {
    if (row.status !== 'open') return { ...row };
    const a = row.startOffset;
    const b = row.endOffset;
    if (oldEnd <= a && commonPrefix < a) {
      // 变更严格完全发生在标记之前；插入恰在标记起点属于边界相交。
      return { ...row, startOffset: a + net, endOffset: b + net };
    }
    if (commonPrefix > b) {
      // 变更严格完全发生在标记之后；在标记终点插入属于边界相交。
      return { ...row };
    }
    // 变更与标记内部相交（净变化不为 0 且交叉区间非空）
    return { ...row, status: 'resolved', resolvedReason: 'edited', resolvedAt: nowIso, updatedAt: nowIso };
  });
}

export function longestCommonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

export function longestCommonSuffix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
  return i;
}

/** 稳定正文指纹（FNV-1a 32 位，hex）。Data agent 的指纹推导以本值语义兼容即可。 */
export function computeBodyFingerprint(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** quotedText 前后各 window 个字符的邻近上下文。 */
export function annotationContextAround(body: string, start: number, end: number, windowSize = ANNOTATION_CONTEXT_WINDOW): { prefixContext: string; suffixContext: string } {
  const prefixStart = Math.max(0, start - windowSize);
  const suffixEnd = Math.min(body.length, end + windowSize);
  return {
    prefixContext: body.slice(prefixStart, start),
    suffixContext: body.slice(end, suffixEnd)
  };
}

/** 归一化正文空白：连续 3+ 换行折叠为 2、去除首尾空白 —— 与 htmlToMarkdown 的收尾一致。 */
export const normalizeBodyWhitespace = (body: string): string => body.replace(/\n{3,}/g, '\n\n').trim();

/** 文档 scope 稳定键，用于 effect 依赖与「当前文档」比对。 */
export const annotationScopeKey = (scope: StudioDocumentScope): string =>
  `${scope.projectId}|${scope.documentKind}|${scope.documentId ?? ''}|${scope.platform ?? ''}`;

/** 解决原因展示文案。 */
export const resolveReasonLabel = (reason: StudioAnnotation['resolvedReason']): string => {
  switch (reason) {
    case 'edited': return '正文修改后自动解决';
    case 'deleted': return '原文已不存在';
    case 'ambiguous': return '无法唯一定位原文';
    case 'user_removed': return '手动移除';
    default: return '已解决';
  }
};
