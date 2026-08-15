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

export const renderMarkdown = (value: string): string => {
  const html = marked.parse(value ?? '', { async: false }) as string;
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|wmb-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });
  return hoistAssetFigures(sanitized);
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
    if (node.tagName === 'UL' || node.tagName === 'OL') {
      return `${[...node.children].map((item, index) => {
        const bullet = node.tagName === 'OL' ? `${index + 1}.` : '-';
        return `${bullet} ${read(item).trim()}`;
      }).join('\n')}\n\n`;
    }
    if (node.tagName === 'LI') return content;
    if (node.tagName === 'TABLE') {
      const rows = [...node.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => cell.textContent?.trim() ?? ''));
      if (!rows.length) return '';
      const head = rows[0];
      const sep = head.map(() => '---');
      const bodyRows = rows.slice(1);
      return `| ${head.join(' | ')} |\n| ${sep.join(' | ')} |\n${bodyRows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
    }
    return content;
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
