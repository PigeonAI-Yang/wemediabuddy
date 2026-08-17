import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ContentProjectDetail, ContentProjectOrder, ContentProjectPlatform, ContentProjectStatus, ContentProjectSummary } from '../main/content';
import { PlatformMark } from './platform-mark';

export const statuses: Array<{ value: ContentProjectStatus; label: string }> = [
  { value: 'idea', label: '想法' }, { value: 'drafting', label: '创作中' },
  { value: 'review', label: '待审' }, { value: 'ready', label: '待发布' },
  { value: 'completed', label: '已完成' }
];
export const platformNames: Record<string, string> = { x: 'X', xiaohongshu: '小红书', wechat: '公众号', zhihu: '知乎' };
export const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN');
marked.setOptions({
  gfm: true,
  breaks: true
});

export const looksLikeMarkdown = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  return /(^|\n)\s{0,3}(#{1,6}\s+\S|```|~~~|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|(?:^|\n)(?:- |\* |\d+\. )|>\s+\S|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)|\|.+\|)/m.test(text);
};

// ---- WMB-5237 本文图片：单一解析器实现位于 src/shared/media-token.ts（main/renderer 共用）。
// 本文件仅 re-export，保持既有消费方（studio-view.tsx 等）同名导入不变；禁止在本文件内再建实现。

import { escapeAssetAlt } from '../shared/media-token';

export {
  ASSET_IMAGE_SCHEME,
  type StudioAssetImageRef,
  type AssetImageRef,
  parseAssetImages,
  replaceAssetImageToken,
  updateAssetImageAlt,
  removeAssetImageToken,
  referencedAssetIds,
  escapeAssetAlt,
  decodeAssetAlt,
  assetImageToken
} from '../shared/media-token';

import { contentBindingKey, type ContentMediaBinding, type ContentMediaBindingDraft, type MediaAlign, type MediaWidthPreset } from '../shared/media-bindings';

// ---- WMB-5237 核心媒体绑定草稿：布局纯函数（renderer key = assetId:occurrence）。
// 布局字段只写 ContentMediaBindingDraft，绝不修改正文 token / 批注偏移；
// 本文件是 renderer 侧唯一入口，共享类型来自 ../shared/media-bindings（禁止第二套同名类型）。

/** 更新指定 (assetId, occurrence) 的布局字段；不存在则按自然尺寸默认追加。返回新数组（幂等纯函数，可 setState 直用）。 */
export function updateContentMediaBinding(
  draft: ContentMediaBindingDraft[],
  assetId: string,
  occurrence: number,
  patch: Partial<Pick<ContentMediaBindingDraft, 'widthPreset' | 'align' | 'caption' | 'linkUrl'>>
): ContentMediaBindingDraft[] {
  const key = contentBindingKey(assetId, occurrence);
  const index = draft.findIndex((item) => contentBindingKey(item.assetId, item.occurrence) === key);
  if (index === -1) {
    // 新绑定默认 'large'（自然尺寸）：与未绑定 figure 的视觉一致，仅改对齐不会让图片突变。
    return [...draft, { assetId, occurrence, widthPreset: 'large', align: 'center', ...patch }];
  }
  const next = [...draft];
  next[index] = { ...next[index], ...patch };
  return next;
}

/** 由核心绑定（草稿或读模型）构建 figure 投影映射：key = contentBindingKey(assetId, occurrence)。 */
export function contentMediaLayoutMap(
  bindings: ReadonlyArray<ContentMediaBindingDraft | ContentMediaBinding>
): Map<string, { widthPreset: MediaWidthPreset; align: MediaAlign }> {
  const map = new Map<string, { widthPreset: MediaWidthPreset; align: MediaAlign }>();
  for (const binding of bindings) {
    map.set(contentBindingKey(binding.assetId, binding.occurrence), { widthPreset: binding.widthPreset, align: binding.align });
  }
  return map;
}

/** 字节数的人类可读格式（卡片次要信息）。 */
export const formatAssetSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

/** 把独立成段的 `wmb-asset://` 图片从 `<p>` 提升为带可见 figcaption 的 figure（不复制图注文本进 DOM）。 */
const ASSET_FIGURE_RE = /<p>\s*(<img[^>]*?src="wmb-asset:\/\/[^"]*"[^>]*>)\s*<\/p>/g;

export function hoistAssetFigures(html: string): string {
  const occurrenceCounts = new Map<string, number>();
  return html.replace(ASSET_FIGURE_RE, (_match, imgTag: string) => {
    const src = /src="([^"]*)"/.exec(imgTag)?.[1] ?? '';
    const assetId = src.replace(/^wmb-asset:\/\//, '');
    const altRaw = /alt="([^"]*)"/.exec(imgTag)?.[1] ?? '';
    // marked 已把 alt 转义为适合属性的形式；直接复用，避免二次解码/编码。
    const idAttr = altRaw.includes('&') ? assetId.replace(/&/g, '&amp;') : assetId;
    const occurrence = occurrenceCounts.get(assetId) ?? 0;
    occurrenceCounts.set(assetId, occurrence + 1);
    const caption = altRaw ? `<figcaption data-wmb-caption="${altRaw}"></figcaption>` : '';
    return `<figure class="studio-figure" data-wmb-asset="${idAttr}" data-wmb-occurrence="${occurrence}">${imgTag}${caption}</figure>`;
  });
}

// ---- WMB-5286 CJK 紧贴强调修复 ----
// CommonMark 的 flanking 规则要求「闭合分隔符后紧跟空白或标点」；中文正文常见写法
// 「**已确认：**2026 年…」（闭合 ** 后紧跟字母/数字，或「价格**优惠**活动」两侧紧贴
// 汉字）会整体保持字面文本。marked v18 完全遵循该规则，因此这里在 sanitize 之后对渲染
// DOM 做一次宽松配平：只处理 marked 未解析的字面分隔符对，插入 strong/em/del 包裹。
// 不增删任何字符，故 htmlToMarkdown / 批注线性化（wrap token 规则一致）与保存协议不变。

const EMPHASIS_BLOCK_TAGS: Record<string, true> = { P: true, DIV: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, LI: true, TD: true, TH: true, BLOCKQUOTE: true, FIGURE: true, FIGCAPTION: true, TABLE: true, TR: true, UL: true, OL: true, DL: true, DT: true, DD: true, HR: true, SECTION: true, HEADER: true, FOOTER: true, MAIN: true, ASIDE: true, ARTICLE: true, NAV: true };
const EMPHASIS_RUN_RE = /(\*{1,3}|_{1,3}|~{2})/g;

type EmphasisTextUnit = { kind: 'text'; text: string; node: Text };
type EmphasisRunUnit = { kind: 'run'; run: string; node: Text; offset: number; prev: string | null; next: string | null };
type EmphasisUnit = EmphasisTextUnit | EmphasisRunUnit;

/** Unicode 空白（CommonMark flanking 的 whitespace 语义）。 */
const emphasisSpace = (ch: string | null): boolean => ch !== null && /\s/.test(ch);

/** Unicode 字母/数字（intraword 判定：@shao__meng、a_b_c 不得配对）。 */
const emphasisAlnum = (ch: string | null): boolean => ch !== null && /[\p{L}\p{N}]/u.test(ch);

/** 标点/符号（不含分隔符本身；CommonMark punctuation 语义）。 */
const emphasisPunct = (ch: string | null): boolean => ch !== null && !/[*_~]/.test(ch) && /[\p{P}\p{S}]/u.test(ch);

function canOpenEmphasis(unit: EmphasisRunUnit): boolean {
  const { run } = unit;
  // 开放分隔符：后接非空白且非同一分隔符即可（中文常让强调紧贴汉字/字母）。
  return Boolean(unit.next) && !emphasisSpace(unit.next) && unit.next !== run[0];
}

function canCloseEmphasis(unit: EmphasisRunUnit): boolean {
  const { run } = unit;
  if (!unit.prev || emphasisSpace(unit.prev) || unit.prev === run[0]) return false;
  // 下划线类分隔符的 intraword 情形（前后皆字母/数字）保持字面：@shao__meng、a_b_c。
  if (run[0] === '_' && emphasisAlnum(unit.prev) && unit.next !== null && emphasisAlnum(unit.next)) return false;
  // 单星号/单下划线：仅修复「闭合分隔符前为标点」的 CommonMark flanking 失败
  // （如 *斜体：*内容）；其余紧贴场景 marked 自身已按宽松规则处理。
  if (run.length === 1 && !emphasisPunct(unit.prev)) return false;
  return true;
}

function emphasisContentOk(units: EmphasisUnit[], open: EmphasisRunUnit, close: EmphasisRunUnit): boolean {
  let inside = false;
  let text = '';
  for (const unit of units) {
    if (unit === open) { inside = true; continue; }
    if (unit === close) break;
    if (!inside) continue;
    text += unit.kind === 'text' ? unit.text : unit.run;
  }
  if (!text || emphasisSpace(text[0]) || emphasisSpace(text[text.length - 1])) return false;
  return true;
}

function collectEmphasisUnits(root: HTMLElement, segments: EmphasisUnit[][]): void {
  let units: EmphasisUnit[] = [];
  const flush = () => { if (units.length) { segments.push(units); units = []; } };
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        if (!text) continue;
        EMPHASIS_RUN_RE.lastIndex = 0;
        let last = 0;
        let match: RegExpExecArray | null;
        while ((match = EMPHASIS_RUN_RE.exec(text))) {
          if (match.index > last) units.push({ kind: 'text', text: text.slice(last, match.index), node: child as Text });
          units.push({ kind: 'run', run: match[0], node: child as Text, offset: match.index, prev: null, next: null });
          last = match.index + match[0].length;
        }
        if (last < text.length) units.push({ kind: 'text', text: text.slice(last), node: child as Text });
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      if (child.tagName === 'CODE' || child.tagName === 'PRE') continue;
      if (EMPHASIS_BLOCK_TAGS[child.tagName]) {
        flush();
        walk(child);
        flush();
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  flush();
  for (const segment of segments) {
    for (let i = 0; i < segment.length; i += 1) {
      const unit = segment[i];
      if (unit.kind !== 'run') continue;
      const prevUnit = segment[i - 1];
      const nextUnit = segment[i + 1];
      unit.prev = prevUnit ? (prevUnit.kind === 'text' ? prevUnit.text[prevUnit.text.length - 1] : prevUnit.run[prevUnit.run.length - 1]) : null;
      unit.next = nextUnit ? (nextUnit.kind === 'text' ? nextUnit.text[0] : nextUnit.run[0]) : null;
    }
  }
}

/** 对 sanitize 后的 HTML 修复 CJK 紧贴强调（无 DOMParser 环境原样返回）。 */
export function repairCjkEmphasis(html: string): string {
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') return html;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.body;
    const segments: EmphasisUnit[][] = [];
    collectEmphasisUnits(body, segments);
    const matches: Array<{ open: EmphasisRunUnit; close: EmphasisRunUnit; tag: string }> = [];
    for (const units of segments) {
      const stack: Array<{ run: string; unit: EmphasisRunUnit }> = [];
      for (const unit of units) {
        if (unit.kind !== 'run') continue;
        const top = stack[stack.length - 1];
        if (top && top.run === unit.run && canCloseEmphasis(unit) && emphasisContentOk(units, top.unit, unit)) {
          stack.pop();
          matches.push({ open: top.unit, close: unit, tag: top.run === '***' || top.run === '___' ? 'EM_STRONG' : (top.run === '~~' ? 'DEL' : (top.run.length === 1 ? 'EM' : 'STRONG')) });
        } else if (canOpenEmphasis(unit)) {
          stack.push({ run: unit.run, unit });
        }
      }
    }
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const { open, close, tag } = matches[i];
      try {
        const len = open.run.length;
        // 1) 删除闭合分隔符；2) 包裹区间内容；3) 删除开放分隔符（自右向左，偏移稳定）。
        const closer = document.createRange();
        closer.setStart(close.node, close.offset);
        closer.setEnd(close.node, close.offset + len);
        closer.deleteContents();
        const range = document.createRange();
        range.setStart(open.node, open.offset + len);
        range.setEnd(close.node, close.offset);
        const content = range.extractContents();
        if (!content.textContent) continue;
        if (tag === 'EM_STRONG') {
          const strong = document.createElement('STRONG');
          strong.appendChild(content);
          const em = document.createElement('EM');
          em.appendChild(strong);
          range.insertNode(em);
        } else {
          const wrapper = document.createElement(tag);
          wrapper.appendChild(content);
          range.insertNode(wrapper);
        }
        const opener = document.createRange();
        opener.setStart(open.node, open.offset);
        opener.setEnd(open.node, open.offset + len);
        opener.deleteContents();
      } catch {
        // 区间非法（罕见 DOM 结构）则跳过该对，保持字面文本。
      }
    }
    return body.innerHTML;
  } catch {
    return html;
  }
}

export const renderMarkdown = (value: string): string => {
  const html = marked.parse(value ?? '', { async: false }) as string;
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|wmb-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });
  return hoistAssetFigures(repairCjkEmphasis(sanitized));
};

export const bodyWithoutLeadingTitle = (value: string) => value.replace(/^#\s+.+\r?\n+/, '');

export function htmlToMarkdown(root: HTMLElement): string {
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof HTMLElement)) return '';
    const content = [...node.childNodes].map(read).join('');
    if (/^H[1-6]$/.test(node.tagName)) return `${'#'.repeat(Number(node.tagName[1]))} ${content.trim()}\n\n`;
    if (node.tagName === 'P' || node.tagName === 'DIV') return `${content.trim()}\n\n`;
    if (node.tagName === 'STRONG' || node.tagName === 'B') return `**${content}**`;
    if (node.tagName === 'EM' || node.tagName === 'I') return `*${content}*`;
    if (node.tagName === 'S' || node.tagName === 'DEL' || node.tagName === 'STRIKE') return `~~${content}~~`;
    if (node.tagName === 'CODE') {
      if (node.parentElement?.tagName === 'PRE') return content;
      return `\`${content}\``;
    }
    if (node.tagName === 'PRE') {
      const code = node.querySelector('code')?.textContent ?? content;
      return `\`\`\`\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`;
    }
    if (node.tagName === 'HR') return `\n---\n\n`;
    if (node.tagName === 'U') return `<u>${content}</u>`;
    if (node.tagName === 'FIGURE') {
      // WMB-5237：figure 只回写单个图片 token，绝不复制 figcaption（图注文本存在于
      // data-wmb-caption 属性，由 CSS 显示，线性化规则与 studio-annotation-layer 一致）。
      const figureImg = node.querySelector(':scope > img');
      return figureImg ? read(figureImg) : content;
    }
    if (node.tagName === 'IMG') {
      const alt = node.getAttribute('alt') || '图片';
      const src = node.getAttribute('src') || '';
      if (!src) return '';
      // 资产图片 token 需转义 alt 以保证「富文本→token」无损往返；外链图片语义保持不变。
      const altText = src.startsWith('wmb-asset://') ? escapeAssetAlt(alt) : alt;
      return `![${altText}](${src})\n\n`;
    }
    if (node.tagName === 'BLOCKQUOTE') {
      return `${content.trim().split('\n').filter(Boolean).map((line) => `> ${line}`).join('\n')}\n\n`;
    }
    if (node.tagName === 'A') return `[${content}](${node.getAttribute('href') ?? ''})`;
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'UL' || node.tagName === 'OL') return emitListToMarkdown(node, 0);
    if (node.tagName === 'LI') return content;
    if (node.tagName === 'TABLE') {
      const rows = [...node.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => read(cell).trim().replace(/\n+/g, ' ')));
      if (!rows.length) return '';
      const head = rows[0];
      const sep = head.map(() => '---');
      const bodyRows = rows.slice(1);
      return `| ${head.join(' | ')} |\n| ${sep.join(' | ')} |\n${bodyRows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
    }
    return content;
  };
  // 嵌套列表按深度缩进输出，保持层级结构（避免 `- 顶层- 子项` 式坍缩）。
  const emitListToMarkdown = (list: HTMLElement, depth: number): string => {
    const indent = '  '.repeat(depth);
    const lines = [...list.children].map((item, index) => {
      const bullet = list.tagName === 'OL' ? `${index + 1}.` : '-';
      return `${indent}${bullet}${emitListItemToMarkdown(item as HTMLElement, depth)}`;
    });
    return `${lines.join('\n')}\n\n`;
  };
  const emitListItemToMarkdown = (item: HTMLElement, depth: number): string => {
    let inline = '';
    let nested = '';
    for (const child of item.childNodes) {
      if (child instanceof HTMLElement && (child.tagName === 'UL' || child.tagName === 'OL')) {
        nested += emitListToMarkdown(child, depth + 1);
      } else {
        inline += read(child);
      }
    }
    const text = inline.trim();
    if (!nested) return text ? ` ${text}` : '';
    const nestedText = nested.replace(/\n{3,}/g, '\n\n').trimEnd();
    return text ? ` ${text}\n${nestedText}` : `\n${nestedText}`;
  };
  return [...root.childNodes].map(read).join('').replace(/\n{3,}/g, '\n\n').trim();
}

export function insertTextAtCursor(textarea: HTMLTextAreaElement, text: string): string {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const next = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  const caret = start + text.length;
  textarea.value = next;
  textarea.selectionStart = caret;
  textarea.selectionEnd = caret;
  return next;
}

export function wrapTextareaSelection(textarea: HTMLTextAreaElement, before: string, after = before, placeholder = '文字'): string {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const selected = textarea.value.slice(start, end) || placeholder;
  const next = `${textarea.value.slice(0, start)}${before}${selected}${after}${textarea.value.slice(end)}`;
  textarea.value = next;
  textarea.selectionStart = start + before.length;
  textarea.selectionEnd = start + before.length + selected.length;
  return next;
}
