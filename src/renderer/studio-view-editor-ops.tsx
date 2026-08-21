// extracted from studio-view.tsx (structural split)
import { useCallback } from 'react';
import { htmlToMarkdown, insertTextAtCursor, looksLikeMarkdown, renderMarkdown, wrapTextareaSelection } from './studio-view-helpers';
import type { EditorInsertionBookmark } from './studio-view-dom';
import { captureRichInsertionBookmark } from './studio-view-dom';

export function useStudioEditorOps(params: {
  selected: unknown;
  busy: boolean;
  readOnlyVersion: unknown;
  editorMode: 'rich' | 'source';
  editorBody: string;
  changeBody: (next: string) => void;
  bodyInput: React.RefObject<HTMLDivElement | null>;
  sourceInput: React.RefObject<HTMLTextAreaElement | null>;
  richDomSyncedRef: React.MutableRefObject<boolean>;
  bodyHistory: React.MutableRefObject<string[]>;
  bodyHistoryIndex: React.MutableRefObject<number>;
  applyEditorBody: (next: string) => void;
  insertImageFile: (file?: File) => Promise<void>;
}) {
  const { selected, busy, readOnlyVersion, editorMode, editorBody, changeBody, bodyInput, sourceInput, richDomSyncedRef, bodyHistory, bodyHistoryIndex, applyEditorBody, insertImageFile } = params;

  const moveHistory = (direction: -1 | 1) => {
    const next = bodyHistory.current.length ? bodyHistoryIndex.current + direction : -1;
    if (next < 0 || next >= bodyHistory.current.length) return;
    bodyHistoryIndex.current = next;
    applyEditorBody(bodyHistory.current[next]);
  };

  const insertMarkdown = (snippet: string) => {
    if (readOnlyVersion) return;
    if (editorMode === 'source') {
      const textarea = sourceInput.current;
      if (!textarea) {
        changeBody(`${editorBody}${editorBody.endsWith('\n') || !editorBody ? '' : '\n\n'}${snippet}`);
        return;
      }
      textarea.focus();
      changeBody(insertTextAtCursor(textarea, snippet));
      return;
    }
    const editor = bodyInput.current;
    if (!editor) {
      changeBody(`${editorBody}${editorBody.endsWith('\n') || !editorBody ? '' : '\n\n'}${snippet}`);
      return;
    }
    editor.focus();
    document.execCommand('insertHTML', false, renderMarkdown(snippet));
    changeBody(htmlToMarkdown(editor));
    richDomSyncedRef.current = true;
  };

  const formatSelection = (before: string, after = before, placeholder = '文字') => {
    if (readOnlyVersion) return;
    if (editorMode === 'source') {
      const textarea = sourceInput.current;
      if (!textarea) return;
      textarea.focus();
      changeBody(wrapTextareaSelection(textarea, before, after, placeholder));
      return;
    }
    const editor = bodyInput.current;
    if (!editor) return;
    editor.focus();
    const command = before === '**' ? 'bold' : before === '*' ? 'italic' : before === '~~' ? 'strikeThrough' : before === '- ' ? 'insertUnorderedList' : before === '> ' ? 'formatBlock' : '';
    if (command === 'formatBlock') document.execCommand(command, false, 'blockquote');
    else if (command) document.execCommand(command);
    else if (before === '## ') document.execCommand('formatBlock', false, 'h2');
    else if (before === '### ') document.execCommand('formatBlock', false, 'h3');
    else if (before === '[') {
      const url = window.prompt('粘贴链接地址');
      if (url) document.execCommand('createLink', false, url);
    } else if (before.startsWith('```')) {
      insertMarkdown(`\n\`\`\`\n${placeholder}\n\`\`\`\n`);
      return;
    } else document.execCommand('insertText', false, `${before}${placeholder}${after}`);
    changeBody(htmlToMarkdown(editor));
    richDomSyncedRef.current = true;
  };

  const execRich = (command: string, value?: string) => {
    if (editorMode === 'source') {
      if (command === 'bold') return formatSelection('**');
      if (command === 'italic') return formatSelection('*');
      if (command === 'strikeThrough') return formatSelection('~~');
      if (command === 'insertUnorderedList') return insertMarkdown('\n- 列表项\n');
      if (command === 'insertOrderedList') return insertMarkdown('\n1. 列表项\n');
      if (command === 'formatBlock' && value === 'h2') return insertMarkdown('\n## 二级标题\n\n');
      if (command === 'formatBlock' && value === 'h3') return insertMarkdown('\n### 三级标题\n\n');
      if (command === 'formatBlock' && value === 'blockquote') return insertMarkdown('\n> 引用\n\n');
      if (command === 'formatBlock' && value === 'p') return insertMarkdown('\n');
      if (command === 'undo') return moveHistory(-1);
      if (command === 'redo') return moveHistory(1);
      return;
    }
    const editor = bodyInput.current;
    if (!editor || readOnlyVersion) return;
    editor.focus();
    document.execCommand(command, false, value);
    changeBody(htmlToMarkdown(editor));
    richDomSyncedRef.current = true;
  };

  const handleEditorPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (readOnlyVersion || busy) return;
    const editor = bodyInput.current;
    if (!editor) return;
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'));
    if (file) {
      event.preventDefault();
      void insertImageFile(file);
      return;
    }
    const html = event.clipboardData.getData('text/html');
    const text = event.clipboardData.getData('text/plain');
    if (html && !looksLikeMarkdown(text)) return;
    if (!text || !looksLikeMarkdown(text)) return;
    event.preventDefault();
    document.execCommand('insertHTML', false, renderMarkdown(text));
    changeBody(htmlToMarkdown(editor));
    richDomSyncedRef.current = true;
  };

  const handleSourcePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (readOnlyVersion || busy) return;
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void insertImageFile(file);
  };

  return { moveHistory, insertMarkdown, formatSelection, execRich, handleEditorPaste, handleSourcePaste };
}
