// WMB-5207: Studio 正文批注 —— 装饰层 / 交互层组件与富文本偏移映射。
// 所有权：UI agent。富文本映射把「渲染 DOM 位置」换算为正文 code-unit offset，
// 线性化规则与 studio-view-helpers.htmlToMarkdown 的逐节点规则保持一致；
// 偏移空间 = 当前可编辑草稿（editorBody），富文本展示剥离的首行标题长度单独计入。
// 装饰层绝不向正文 / DOM 编辑器插入批注语法：富文本用绝对定位矩形层，
// 源码模式用与 textarea 同几何的透明镜像层。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StudioAnnotation } from '../shared/studio-annotations';
import { normalizeBodyWhitespace } from './studio-annotations';

// ---------------------------------------------------------------------------
// 富文本偏移映射（Rich DOM ↔ body offsets）
// ---------------------------------------------------------------------------

type RichToken = {
  text: string;
  node: Node;
  /** 该 token 在所属文本节点内的 DOM offset（wrap token 恒为 0）。 */
  offset: number;
  kind: 'text' | 'wrap';
};

export type RichMapping = {
  raw: string;
  canonical: string;
  canonicalLen: number;
  rawToCanonical: Int32Array;
  canonicalToRaw: number[];
  tokens: RichToken[];
  starts: number[];
};

type DomPoint = { node: Node | null; offset: number };

const tokensText = (tokens: RichToken[]): string => {
  let out = '';
  for (const token of tokens) out += token.text;
  return out;
};

function sliceTokens(tokens: RichToken[], start: number, end: number): RichToken[] {
  const out: RichToken[] = [];
  let pos = 0;
  for (const token of tokens) {
    const tokenEnd = pos + token.text.length;
    if (tokenEnd > start && pos < end) {
      const from = Math.max(pos, start);
      const to = Math.min(tokenEnd, end);
      if (to > from) {
        out.push({
          text: token.text.slice(from - pos, to - pos),
          node: token.node,
          offset: token.offset + (from - pos),
          kind: token.kind
        });
      }
    }
    pos = tokenEnd;
    if (pos >= end) break;
  }
  return out;
}

function wrapTokens(node: HTMLElement, before: string, after = before): RichToken[] {
  return [
    { text: before, node, offset: 0, kind: 'wrap' },
    ...emitChildren(node),
    { text: after, node, offset: 0, kind: 'wrap' }
  ];
}

/** 块的 content.trim() 语义：去掉首尾空白后切片。 */
function emitBlockContent(el: HTMLElement, trim: boolean): RichToken[] {
  const tokens = emitChildren(el);
  if (!trim) return tokens;
  const text = tokensText(tokens);
  const length = text.length;
  let s = 0;
  let e = length;
  while (s < e && text.charCodeAt(s) <= 0x20) s += 1;
  while (e > s && text.charCodeAt(e - 1) <= 0x20) e -= 1;
  return s >= e ? [] : sliceTokens(tokens, s, e);
}

/** 把 target 的 textContent 区间 [start, end) 映射为其后代文本节点上的 token。 */
function emitTextContentRange(target: HTMLElement, start: number, end: number): RichToken[] {
  const out: RichToken[] = [];
  let pos = 0;
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      const from = Math.max(pos, start);
      const to = Math.min(pos + text.length, end);
      if (to > from) out.push({ text: text.slice(from - pos, to - pos), node, offset: from - pos, kind: 'text' });
      pos += text.length;
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(target);
  return out;
}

function emitBlockquote(el: HTMLElement): RichToken[] {
  const content = emitBlockContent(el, true);
  const text = tokensText(content);
  const lines: Array<{ start: number; end: number }> = [];
  let lineStart = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '\n') {
      if (i > lineStart) lines.push({ start: lineStart, end: i });
      lineStart = i + 1;
    }
  }
  const out: RichToken[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ text: '\n', node: el, offset: 0, kind: 'wrap' });
    out.push({ text: '> ', node: el, offset: 0, kind: 'wrap' });
    out.push(...sliceTokens(content, line.start, line.end));
  });
  out.push({ text: '\n\n', node: el, offset: 0, kind: 'wrap' });
  return out;
}

function emitList(el: HTMLElement): RichToken[] {
  const out: RichToken[] = [];
  const items = [...el.children].filter((child) => child.tagName === 'LI') as HTMLElement[];
  items.forEach((item, index) => {
    if (index > 0) out.push({ text: '\n', node: el, offset: 0, kind: 'wrap' });
    const bullet = el.tagName === 'OL' ? `${index + 1}.` : '-';
    out.push({ text: `${bullet} `, node: el, offset: 0, kind: 'wrap' });
    out.push(...emitBlockContent(item, true));
  });
  out.push({ text: '\n\n', node: el, offset: 0, kind: 'wrap' });
  return out;
}

function emitTable(el: HTMLElement): RichToken[] {
  const rows = [...el.querySelectorAll('tr')] as HTMLElement[];
  const out: RichToken[] = [];
  rows.forEach((row, rowIndex) => {
    const cells = [...row.children] as HTMLElement[];
    if (rowIndex > 0) out.push({ text: '\n', node: el, offset: 0, kind: 'wrap' });
    cells.forEach((cell, cellIndex) => {
      if (cellIndex > 0) out.push({ text: ' | ', node: el, offset: 0, kind: 'wrap' });
      out.push({ text: '| ', node: el, offset: 0, kind: 'wrap' });
      out.push(...emitBlockContent(cell, true));
    });
    out.push({ text: ' |', node: el, offset: 0, kind: 'wrap' });
  });
  out.push({ text: '\n\n', node: el, offset: 0, kind: 'wrap' });
  return out;
}

function emitPre(el: HTMLElement): RichToken[] {
  const codeEl = el.querySelector('code');
  const codeText = codeEl?.textContent ?? el.textContent ?? '';
  const trimmed = codeText.replace(/\n$/, '');
  const target = codeEl ?? el;
  return [
    { text: '```\n', node: el, offset: 0, kind: 'wrap' },
    ...emitTextContentRange(target, 0, trimmed.length),
    { text: '\n```\n\n', node: el, offset: 0, kind: 'wrap' }
  ];
}

function emitNode(node: Node): RichToken[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    return text ? [{ text, node, offset: 0, kind: 'text' }] : [];
  }
  if (!(node instanceof HTMLElement)) return [];
  const tag = node.tagName;
  if (tag === 'BR') return [{ text: '\n', node, offset: 0, kind: 'text' }];
  if (/^H[1-6]$/.test(tag)) {
    const prefix = `${'#'.repeat(Number(tag[1]))} `;
    return [
      { text: prefix, node, offset: 0, kind: 'wrap' },
      ...emitBlockContent(node, true),
      { text: '\n\n', node, offset: 0, kind: 'wrap' }
    ];
  }
  if (tag === 'P' || tag === 'DIV') {
    return [...emitBlockContent(node, true), { text: '\n\n', node, offset: 0, kind: 'wrap' }];
  }
  if (tag === 'STRONG' || tag === 'B') return wrapTokens(node, '**');
  if (tag === 'EM' || tag === 'I') return wrapTokens(node, '*');
  if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') return wrapTokens(node, '~~');
  if (tag === 'CODE') {
    return node.parentElement?.tagName === 'PRE' ? emitChildren(node) : wrapTokens(node, '`');
  }
  if (tag === 'PRE') return emitPre(node);
  if (tag === 'HR') return [{ text: '\n---\n\n', node, offset: 0, kind: 'wrap' }];
  if (tag === 'U') return wrapTokens(node, '<u>', '</u>');
  if (tag === 'IMG') {
    const alt = node.getAttribute('alt') || '图片';
    const src = node.getAttribute('src') || '';
    return src ? [{ text: `![${alt}](${src})\n\n`, node, offset: 0, kind: 'wrap' }] : [];
  }
  if (tag === 'BLOCKQUOTE') return emitBlockquote(node);
  if (tag === 'A') {
    const href = node.getAttribute('href') ?? '';
    return [
      { text: '[', node, offset: 0, kind: 'wrap' },
      ...emitChildren(node),
      { text: `](${href})`, node, offset: 0, kind: 'wrap' }
    ];
  }
  if (tag === 'UL' || tag === 'OL') return emitList(node);
  if (tag === 'LI') return emitChildren(node);
  if (tag === 'TABLE') return emitTable(node);
  return emitChildren(node);
}

export function emitChildren(el: HTMLElement): RichToken[] {
  const out: RichToken[] = [];
  for (const child of el.childNodes) out.push(...emitNode(child));
  return out;
}

/** 一次遍历得到：原始线性化、归一化正文、双向偏移映射。 */
export function richMapping(editor: HTMLElement): RichMapping {
  const tokens = emitChildren(editor);
  const raw = tokensText(tokens);
  const canonical = normalizeBodyWhitespace(raw);
  const rawToCanonical = new Int32Array(raw.length).fill(-1);
  const canonicalToRaw: number[] = [];
  let ri = 0;
  let ci = 0;
  while (ri < raw.length) {
    if (raw[ri] === '\n' && raw[ri + 1] === '\n' && raw[ri + 2] === '\n') {
      let run = ri;
      while (run < raw.length && raw[run] === '\n') run += 1;
      const keep = Math.min(2, run - ri);
      for (let k = 0; k < keep; k += 1) {
        rawToCanonical[ri + k] = ci;
        canonicalToRaw.push(ri + k);
        ci += 1;
      }
      ri = run;
    } else {
      rawToCanonical[ri] = ci;
      canonicalToRaw.push(ri);
      ci += 1;
      ri += 1;
    }
  }
  const starts: number[] = [];
  let pos = 0;
  for (const token of tokens) {
    starts.push(pos);
    pos += token.text.length;
  }
  return {
    raw,
    canonical,
    canonicalLen: canonical.length,
    rawToCanonical,
    canonicalToRaw,
    tokens,
    starts
  };
}

export const richCanonicalOf = (editor: HTMLElement): string => richMapping(editor).canonical;

/** 正文偏移（含首行标题前缀）→ 富文本 DOM 点。 */
export function domPointAtBodyOffset(mapping: RichMapping, bodyOffset: number, leadingTitleLen: number): DomPoint {
  const canonical = Math.max(0, Math.min(bodyOffset - leadingTitleLen, mapping.canonicalLen));
  const raw = canonical === mapping.canonicalLen
    ? (mapping.canonicalLen > 0 ? mapping.canonicalToRaw[mapping.canonicalLen - 1] + 1 : 0)
    : (mapping.canonicalToRaw[canonical] ?? 0);
  return domPointAtRawOffset(mapping, raw);
}

function domPointAtRawOffset(mapping: RichMapping, rawOffset: number): DomPoint {
  const clamped = Math.max(0, Math.min(rawOffset, mapping.raw.length));
  if (!mapping.tokens.length) return { node: null, offset: 0 };
  let lo = 0;
  let hi = mapping.tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (mapping.starts[mid] <= clamped) lo = mid + 1;
    else hi = mid;
  }
  const index = Math.max(0, lo - 1);
  const token = mapping.tokens[index];
  if (token.kind === 'text') {
    const within = Math.min(clamped - mapping.starts[index], token.text.length);
    return { node: token.node, offset: within };
  }
  const next = mapping.tokens[index + 1];
  if (next && next.kind === 'text') return { node: next.node, offset: 0 };
  const prev = mapping.tokens[index - 1];
  if (prev && prev.kind === 'text') return { node: prev.node, offset: prev.text.length };
  return { node: mapping.tokens[0].node, offset: 0 };
}

/** 富文本 DOM 点 → 正文偏移（含首行标题前缀）。 */
export function bodyOffsetAtDomPoint(mapping: RichMapping, node: Node, offset: number, leadingTitleLen: number): number {
  const raw = rawOffsetAtDomPoint(mapping, node, offset);
  if (raw < 0 || raw >= mapping.rawToCanonical.length) return leadingTitleLen + mapping.canonicalLen;
  const canonical = mapping.rawToCanonical[raw];
  const clamped = canonical < 0 ? mapping.canonicalLen : Math.min(canonical, mapping.canonicalLen);
  return leadingTitleLen + clamped;
}

function rawOffsetAtDomPoint(mapping: RichMapping, node: Node, offset: number): number {
  const isElement = node.nodeType === Node.ELEMENT_NODE;
  for (let i = 0; i < mapping.tokens.length; i += 1) {
    const token = mapping.tokens[i];
    if (token.kind !== 'text' || token.node !== node) continue;
    if (!isElement) {
      if (offset >= token.offset && offset <= token.offset + token.text.length) {
        return mapping.starts[i] + Math.max(0, Math.min(offset - token.offset, token.text.length));
      }
    } else if (offset <= 1) {
      return mapping.starts[i] + Math.min(offset, 1);
    }
  }
  if (isElement) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < mapping.tokens.length; i += 1) {
      const token = mapping.tokens[i];
      if (token.kind !== 'text') continue;
      if (node === token.node || node.contains(token.node)) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0) {
      if (offset === 0) return mapping.starts[first];
      if (last >= 0) return mapping.starts[last] + mapping.tokens[last].text.length;
    }
  }
  for (let i = 0; i < mapping.tokens.length; i += 1) {
    const token = mapping.tokens[i];
    if (token.kind === 'text') return mapping.starts[i];
  }
  return 0;
}

/** 正文区间 → 富文本渲染区矩形（viewport 坐标）。 */
export function richAnnotationRects(editor: HTMLElement, mapping: RichMapping, bodyStart: number, bodyEnd: number, leadingTitleLen: number): DOMRect[] {
  if (bodyStart >= bodyEnd) return [];
  const startPoint = domPointAtBodyOffset(mapping, bodyStart, leadingTitleLen);
  const endPoint = domPointAtBodyOffset(mapping, bodyEnd, leadingTitleLen);
  if (!startPoint.node || !endPoint.node) return [];
  try {
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return [...range.getClientRects()];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 装饰层：富文本模式（绝对定位矩形层）与源码模式（镜像层）
// ---------------------------------------------------------------------------

export type SourceHitTest = (x: number, y: number) => string | null;

export type AnnotationOverlayProps = {
  mode: 'rich' | 'source';
  editorRef: React.RefObject<HTMLElement | null>;
  wrapRef: React.RefObject<HTMLElement | null>;
  body: string;
  leadingTitleLen: number;
  rows: StudioAnnotation[];
  selectedAnnotationId: string | null;
  flashAnnotationId: string | null;
  hitTestRef?: React.MutableRefObject<SourceHitTest | null>;
  onSelectAnnotation: (annotationId: string) => void;
  onAnnotationMenu: (annotationId: string, x: number, y: number) => void;
};

export function StudioAnnotationOverlay(props: AnnotationOverlayProps): React.JSX.Element | null {
  if (!props.rows.length) return null;
  return props.mode === 'rich'
    ? <RichAnnotationLayer {...props} />
    : <SourceAnnotationLayer {...props} />;
}

type MeasuredRect = { id: string; rects: Array<{ left: number; top: number; width: number; height: number }> };

function RichAnnotationLayer({ editorRef, wrapRef, body, leadingTitleLen, rows, selectedAnnotationId, flashAnnotationId, onSelectAnnotation, onAnnotationMenu }: AnnotationOverlayProps): React.JSX.Element {
  const [measured, setMeasured] = useState<MeasuredRect[]>([]);
  const measure = () => {
    const editor = editorRef.current;
    const wrap = wrapRef.current;
    if (!editor || !wrap) { setMeasured([]); return; }
    const wrapRect = wrap.getBoundingClientRect();
    const mapping = richMapping(editor);
    const next = rows.map((row) => ({
      id: row.id,
      rects: richAnnotationRects(editor, mapping, row.startOffset, row.endOffset, leadingTitleLen).map((rect) => ({
        left: rect.left - wrapRect.left,
        top: rect.top - wrapRect.top,
        width: rect.width,
        height: rect.height
      }))
    }));
    setMeasured(next);
  };
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(editor, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(measure);
    resize.observe(editor);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); resize.disconnect(); window.removeEventListener('resize', measure); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, body, leadingTitleLen]);
  return (
    <div className="studio-annotation-layer">
      {measured.map((entry) => {
        const row = rows.find((item) => item.id === entry.id);
        if (!row) return null;
        const selected = selectedAnnotationId === entry.id;
        const flash = flashAnnotationId === entry.id;
        const noteClass = row.note ? 'has-note' : 'no-note';
        const last = entry.rects[entry.rects.length - 1];
        const first = entry.rects[0];
        return (
          <span key={entry.id}>
            {entry.rects.map((rect, index) => (
              <span
                key={index}
                data-studio-annotation-id={entry.id}
                aria-hidden="true"
                className={`studio-annotation-rect ${noteClass}${selected ? ' selected' : ''}${flash ? ' flash' : ''}`}
                style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                onClick={() => onSelectAnnotation(entry.id)}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onAnnotationMenu(entry.id, event.clientX, event.clientY); }}
              />
            ))}
            {first && (
              <button
                type="button"
                className="studio-annotation-hit"
                data-studio-annotation-id={entry.id}
                aria-label={row.note ? `问题标记：${row.note}` : '问题标记：仅标记'}
                style={{ left: Math.max(0, first.left - 3), top: first.top - 2 }}
                onClick={(event) => { event.stopPropagation(); onSelectAnnotation(entry.id); }}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onAnnotationMenu(entry.id, event.clientX, event.clientY); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectAnnotation(entry.id); }
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); onAnnotationMenu(entry.id, first.left, first.top); }
                }}
              />
            )}
            {last && row.note && (
              <span className="studio-annotation-dot" aria-hidden="true" style={{ left: last.left + last.width - 3, top: last.top + last.height - 6 }} />
            )}
          </span>
        );
      })}
    </div>
  );
}

function buildMirrorSegments(body: string, rows: StudioAnnotation[]): Array<{ text: string; row: StudioAnnotation | null }> {
  const sorted = rows
    .filter((row) => row.startOffset >= 0 && row.endOffset <= body.length && row.startOffset < row.endOffset)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const segments: Array<{ text: string; row: StudioAnnotation | null }> = [];
  let cursor = 0;
  for (const row of sorted) {
    if (row.startOffset < cursor) continue;
    if (row.startOffset > cursor) segments.push({ text: body.slice(cursor, row.startOffset), row: null });
    segments.push({ text: body.slice(row.startOffset, row.endOffset), row });
    cursor = row.endOffset;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor), row: null });
  return segments;
}

function SourceAnnotationLayer({ wrapRef, body, rows, selectedAnnotationId, flashAnnotationId, hitTestRef, onSelectAnnotation, onAnnotationMenu }: AnnotationOverlayProps): React.JSX.Element {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [hits, setHits] = useState<Record<string, { left: number; top: number; dotLeft: number; dotTop: number }>>({});
  const segments = useMemo(() => buildMirrorSegments(body, rows), [body, rows]);
  const measure = () => {
    const wrap = wrapRef.current;
    const mirror = mirrorRef.current;
    if (!wrap || !mirror) { setHits({}); return; }
    const wrapRect = wrap.getBoundingClientRect();
    const next: Record<string, { left: number; top: number; dotLeft: number; dotTop: number }> = {};
    for (const row of rows) {
      const span = mirror.querySelector(`[data-annotation-mirror-id="${row.id}"]`);
      if (!span) continue;
      const rects = span.getClientRects();
      const first = rects[0];
      const last = rects[rects.length - 1];
      if (!first) continue;
      next[row.id] = {
        left: first.left - wrapRect.left,
        top: first.top - wrapRect.top,
        dotLeft: last ? last.left + last.width - wrapRect.left - 3 : first.left + first.width - wrapRect.left - 3,
        dotTop: last ? last.top + last.height - wrapRect.top - 6 : first.top + first.height - wrapRect.top - 6
      };
    }
    setHits(next);
  };
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    measure();
    if (!wrap) return;
    const resize = new ResizeObserver(measure);
    resize.observe(wrap);
    window.addEventListener('resize', measure);
    return () => { resize.disconnect(); window.removeEventListener('resize', measure); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, rows]);
  useLayoutEffect(() => {
    if (hitTestRef) {
      hitTestRef.current = (x: number, y: number): string | null => {
        const wrap = wrapRef.current;
        if (!wrap) return null;
        const wrapRect = wrap.getBoundingClientRect();
        const localX = x - wrapRect.left;
        const localY = y - wrapRect.top;
        const mirror = mirrorRef.current;
        if (!mirror) return null;
        for (const row of rows) {
          const span = mirror.querySelector(`[data-annotation-mirror-id="${row.id}"]`);
          if (!span) continue;
          for (const rect of span.getClientRects()) {
            if (localX >= rect.left - wrapRect.left && localX <= rect.right - wrapRect.left && localY >= rect.top - wrapRect.top && localY <= rect.bottom - wrapRect.top) {
              return row.id;
            }
          }
        }
        return null;
      };
    }
    return () => { if (hitTestRef) hitTestRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, body]);
  return (
    <>
      <div ref={mirrorRef} className="studio-annotation-mirror" aria-hidden="true">
        {segments.map((segment, index) => {
          if (!segment.row) return <span key={index}>{segment.text}</span>;
          const selected = selectedAnnotationId === segment.row.id;
          const flash = flashAnnotationId === segment.row.id;
          const noteClass = segment.row.note ? 'has-note' : 'no-note';
          return (
            <span
              key={index}
              data-annotation-mirror-id={segment.row.id}
              className={`studio-annotation-mark ${noteClass}${selected ? ' selected' : ''}${flash ? ' flash' : ''}`}
            >
              {segment.text}
            </span>
          );
        })}
      </div>
      <div className="studio-annotation-hit-layer">
        {rows.map((row) => {
          const pos = hits[row.id];
          if (!pos) return null;
          return (
            <button
              key={row.id}
              type="button"
              className="studio-annotation-hit"
              data-studio-annotation-id={row.id}
              aria-label={row.note ? `问题标记：${row.note}` : '问题标记：仅标记'}
              style={{ left: Math.max(0, pos.left - 3), top: pos.top - 2 }}
              onClick={(event) => { event.stopPropagation(); onSelectAnnotation(row.id); }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onAnnotationMenu(row.id, event.clientX, event.clientY); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectAnnotation(row.id); }
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); onAnnotationMenu(row.id, pos.left, pos.top); }
              }}
            />
          );
        })}
        {rows.filter((row) => row.note).map((row) => {
          const pos = hits[row.id];
          if (!pos) return null;
          return <span key={row.id} className="studio-annotation-dot" aria-hidden="true" style={{ left: pos.dotLeft, top: pos.dotTop }} />;
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 应用内上下文菜单与说明输入层（同一套交互体系，创建/编辑复用）
// ---------------------------------------------------------------------------

export type AnnotationMenuItem = { id: string; label: string; onSelect: () => void; disabled?: boolean };

export function StudioAnnotationMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: AnnotationMenuItem[];
  onClose: () => void;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      previousFocus.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const left = Math.min(x, Math.max(8, window.innerWidth - 196));
  const top = Math.min(y, Math.max(8, window.innerHeight - 132));
  return (
    <div ref={menuRef} className="studio-annotation-menu" role="menu" style={{ left, top }} onContextMenu={(event) => event.preventDefault()}>
      {items.map((item) => (
        <button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={() => { onClose(); item.onSelect(); }}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function StudioAnnotationNoteInput({ x, y, title, initial, submitLabel, busy, onConfirm, onCancel }: {
  x: number;
  y: number;
  title: string;
  initial: string;
  submitLabel: string;
  busy: boolean;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [note, setNote] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { previousFocus.current?.focus(); };
  }, []);
  const left = Math.max(8, Math.min(x, window.innerWidth - 324));
  const top = Math.max(8, Math.min(y, window.innerHeight - 196));
  return (
    <div className="studio-annotation-note-pop" role="dialog" aria-label={title} style={{ left, top }}>
      <p className="studio-annotation-note-title">{title}</p>
      <textarea
        ref={inputRef}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="写下你想让 Pi 注意的问题（可选）"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onConfirm(note); }
        }}
      />
      <div className="studio-annotation-note-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => onConfirm(note)}>{submitLabel}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 批注侧栏（右栏「批注 N」页签内容）
// ---------------------------------------------------------------------------

export function StudioAnnotationsPanel({ rows, loading, error, onRetry, selectedId, onSelectCard, onLocate, onEditNote, onRemove, onReopen, onDiscussPi, busy }: {
  rows: StudioAnnotation[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedId: string | null;
  onSelectCard: (annotationId: string) => void;
  onLocate: (annotationId: string) => void;
  onEditNote: (annotationId: string, x: number, y: number) => void;
  onRemove: (annotationId: string) => void;
  onReopen: (annotationId: string) => void;
  onDiscussPi: () => void;
  busy: boolean;
}): React.JSX.Element {
  const openRows = rows.filter((row) => row.status === 'open');
  const resolvedRows = rows.filter((row) => row.status === 'resolved');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [resolvedOpen, setResolvedOpen] = useState(false);
  if (loading) return <p className="studio-annotation-loading">正在读取批注…</p>;
  if (error) return <div className="studio-annotation-error">{error}<button type="button" className="secondary-button" onClick={onRetry}>重试</button></div>;
  return (
    <div className="studio-annotation-panel">
      <div className="studio-annotation-panel-head">
        <button type="button" className="secondary-button studio-annotation-discuss" disabled={!openRows.length || busy} onClick={onDiscussPi}>
          {openRows.length ? `和 Pi 讨论这 ${openRows.length} 处` : '没有未解决批注'}
        </button>
      </div>
      {!openRows.length && !resolvedRows.length && <p className="studio-annotation-empty">在正文中拖选文字后右键，即可添加问题标记；标记会随你的下一条消息带给 Pi。</p>}
      {openRows.map((row) => (
        <AnnotationCard
          key={row.id}
          row={row}
          selected={selectedId === row.id}
          expanded={Boolean(expanded[row.id])}
          busy={busy}
          onToggleExpanded={() => setExpanded((current) => ({ ...current, [row.id]: !current[row.id] }))}
          onSelectCard={() => onSelectCard(row.id)}
          onLocate={() => onLocate(row.id)}
          onEditNote={(x, y) => onEditNote(row.id, x, y)}
          onRemove={() => onRemove(row.id)}
        />
      ))}
      {resolvedRows.length > 0 && (
        <details className="studio-annotation-resolved" open={resolvedOpen} onToggle={(event) => setResolvedOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary>已解决（{resolvedRows.length}）</summary>
          {resolvedRows.map((row) => (
            <article className="studio-annotation-resolved-card" key={row.id}>
              <p>「{row.quotedText}」</p>
              {row.note && <p>说明：{row.note}</p>}
              <small>{resolveReasonLabel(row.resolvedReason)} · {row.resolvedAt ? formatTime(row.resolvedAt) : ''}</small>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => onReopen(row.id)}>重新打开</button>
            </article>
          ))}
        </details>
      )}
    </div>
  );
}

function AnnotationCard({ row, selected, expanded, busy, onToggleExpanded, onSelectCard, onLocate, onEditNote, onRemove }: {
  row: StudioAnnotation;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  onToggleExpanded: () => void;
  onSelectCard: () => void;
  onLocate: () => void;
  onEditNote: (x: number, y: number) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const longQuote = row.quotedText.length > 56;
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <article ref={ref} className={`studio-annotation-card${selected ? ' selected' : ''}`} data-studio-annotation-card-id={row.id}>
      <button
        type="button"
        className="studio-annotation-card-quote"
        aria-label={`定位正文：${row.quotedText}`}
        onClick={() => { onSelectCard(); onLocate(); }}
      >
        <p className={expanded ? 'expanded' : ''}>「{row.quotedText}」</p>
      </button>
      {longQuote && (
        <button type="button" className="studio-annotation-expand" onClick={onToggleExpanded}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
      <div className="studio-annotation-card-note">
        {row.note ? <span>{row.note}</span> : <span className="only-mark">仅标记</span>}
      </div>
      <div className="studio-annotation-card-meta">
        <span>{row.documentKind === 'platform' && row.platform ? platformNameOf(row.platform) : '核心正文'}</span>
        <span>{formatTime(row.createdAt)}</span>
      </div>
      <div className="studio-annotation-card-actions">
        <button type="button" disabled={busy} onClick={(event) => onEditNote(event.clientX, event.clientY)}>{row.note ? '编辑说明' : '添加说明'}</button>
        <button type="button" disabled={busy} onClick={onRemove}>移除标记</button>
      </div>
    </article>
  );
}

const platformNameOf = (platform: string): string => ({ x: 'X', xiaohongshu: '小红书', wechat: '公众号', zhihu: '知乎' }[platform] ?? platform);
const formatTime = (value: string): string => new Date(value).toLocaleString('zh-CN');
const resolveReasonLabel = (reason: StudioAnnotation['resolvedReason']): string => {
  switch (reason) {
    case 'edited': return '正文修改后自动解决';
    case 'deleted': return '原文已不存在';
    case 'ambiguous': return '无法唯一定位原文';
    case 'user_removed': return '手动移除';
    default: return '已解决';
  }
};
