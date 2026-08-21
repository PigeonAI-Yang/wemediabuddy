// extracted from studio-view.tsx (structural split)
import { htmlToMarkdown } from './studio-view-helpers';

export type EditorInsertionBookmark = Readonly<{
  body: string;
  offset: number;
  sourceSelection?: Readonly<{ start: number; end: number }>;
}>;
export type StudioSelectionSnapshot = { start: number; end: number; basis: string };

export const RICH_INSERTION_MARKER = '\uE000WMB_IMAGE_INSERT\uE001';

export function nodePath(root: Node, target: Node): number[] | null {
  const path: number[] = [];
  let current: Node | null = target;
  while (current && current !== root) {
    const parent: ParentNode | null = current.parentNode;
    if (!parent) return null;
    const index = Array.prototype.indexOf.call(parent.childNodes, current) as number;
    if (index < 0) return null;
    path.unshift(index);
    current = parent as Node;
  }
  return current === root ? path : null;
}

export function nodeFromPath(root: Node, path: readonly number[]): Node | null {
  let current = root;
  for (const index of path) {
    const child = current.childNodes[index];
    if (!child) return null;
    current = child;
  }
  return current;
}

export function captureRichInsertionBookmark(editor: HTMLElement, fallbackBody: string): EditorInsertionBookmark {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !editor.contains(range.startContainer)) return { body: fallbackBody, offset: fallbackBody.length };
  const path = nodePath(editor, range.startContainer);
  if (!path) return { body: fallbackBody, offset: fallbackBody.length };
  const clone = editor.cloneNode(true) as HTMLElement;
  const target = nodeFromPath(clone, path);
  if (!target) return { body: fallbackBody, offset: fallbackBody.length };
  const offsetLimit = target.nodeType === Node.TEXT_NODE ? (target.textContent?.length ?? 0) : target.childNodes.length;
  const markerRange = document.createRange();
  markerRange.setStart(target, Math.min(range.startOffset, offsetLimit));
  markerRange.collapse(true);
  markerRange.insertNode(document.createTextNode(RICH_INSERTION_MARKER));
  const markedBody = htmlToMarkdown(clone);
  const offset = markedBody.indexOf(RICH_INSERTION_MARKER);
  if (offset < 0) return { body: fallbackBody, offset: fallbackBody.length };
  return { body: markedBody.replace(RICH_INSERTION_MARKER, ''), offset };
}
