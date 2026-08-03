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
export const platformNames: Record<string, string> = { x: 'X', xiaohongshu: '小红书', wechat: '公众号' };
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

export const renderMarkdown = (value: string): string => {
  const html = marked.parse(value ?? '', { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|wmb-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });
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
    if (node.tagName === 'IMG') {
      const alt = node.getAttribute('alt') || '图片';
      const src = node.getAttribute('src') || '';
      return src ? `![${alt}](${src})\n\n` : '';
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

