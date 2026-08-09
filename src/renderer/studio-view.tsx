import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContentProjectDetail, ContentProjectOrder, ContentProjectPlatform, ContentProjectStatus, ContentProjectStatusSummary, ContentProjectSummary } from '../main/content';
import { bodyWithoutLeadingTitle, formatTime, htmlToMarkdown, insertTextAtCursor, looksLikeMarkdown, platformNames, renderMarkdown, statuses, wrapTextareaSelection } from './studio-view-helpers';
import { StudioContext, StudioEditorTop, StudioFormatBar, StudioLibraryHeader, StudioOutline } from './studio-view-panels';
import { appConfirm } from './app-confirm';
import { priorityGrade } from './today-view-parts';
export function LongTermStudioView({ openPublish, selectedId, onSelect, onContext, onFocusChange, onOpenSource, planDate, enabledPlatforms }: {
  openPublish: () => void; selectedId: string | null; onSelect: (projectId: string | null) => void;
  onContext: (project: { id: string; title: string } | null) => void;
  onFocusChange?: (focus: { type: string; id: string; title: string; summary?: string | null; bodyStatus?: 'none' | 'ready' | 'failed' | 'empty'; bodyExcerpt?: string | null; bodyChars?: number } | null) => void;
  onOpenSource?: (sourceId: string) => void;
  planDate: string; enabledPlatforms: Array<'x' | 'xiaohongshu' | 'wechat'>;
}): React.JSX.Element {
  const [projects, setProjects] = useState<ContentProjectSummary[]>([]); const [topics,setTopics]=useState<any[]>([]);
  const [listFocusId, setListFocusId] = useState<string | null>(null);
  const [statusSummary, setStatusSummary] = useState<ContentProjectStatusSummary | null>(null);
  const [selected, setSelected] = useState<ContentProjectDetail | null>(null); const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState(''); const [status, setStatus] = useState<ContentProjectStatus | undefined>();
  const [archived, setArchived] = useState(false); const [order, setOrder] = useState<ContentProjectOrder>('recent');
  const [platform, setPlatform] = useState<ContentProjectPlatform | undefined>(); const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0); const [loading, setLoading] = useState(true); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [title, setTitle] = useState(''); const [body, setBody] = useState('');
  const [tab, setTab] = useState<'core' | 'versions' | 'sources' | 'platforms' | 'assets'>('core');
  const [contextTab, setContextTab] = useState<'versions' | 'sources' | 'assets'>('versions'); const [viewedVersionId, setViewedVersionId] = useState<string | null>(null);
  const [copyTitle, setCopyTitle] = useState(''); const [findOpen, setFindOpen] = useState(false); const [findText, setFindText] = useState('');
  const [contextOpen, setContextOpen] = useState(false); const [editorMode, setEditorMode] = useState<'rich' | 'source'>('source');
  const [creating, setCreating] = useState(false); const [newTitle, setNewTitle] = useState('');
  const bodyInput = useRef<HTMLDivElement>(null); const sourceInput = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const imageInput = useRef<HTMLInputElement>(null); const importInput = useRef<HTMLInputElement>(null);
  const bodyHistory = useRef<string[]>(['']); const bodyHistoryIndex = useRef(0);
  const latest = selected?.revisions[0]; const viewedVersion = selected?.revisions.find((version) => version.id === viewedVersionId) ?? null;
  const dirty = Boolean(selected) && (title.trim() !== selected?.title.trim() || body !== (latest?.body ?? '')); const input = { query: query || undefined, status, archived, order, platform, limit: 50 };
  const loadFirst = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [result, nextSummary] = await Promise.all([
        window.wmb.listStudioProjects({ ...input, offset }),
        window.wmb.getStudioSummary()
      ]);
      const page = result?.items ?? [];
      setProjects(page);
      setHasMore(Boolean(result?.hasMore));
      setStatusSummary(nextSummary);
      setMessage('');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  const loadDetail = async (id: string) => {
    try {
      const detail = await window.wmb.getStudioProject(id);
      setSelected(detail);
      setTitle(detail?.title ?? '');
      const latestBody = detail?.revisions[0]?.body ?? '';
      setBody(latestBody);
      bodyHistory.current = [latestBody];
      bodyHistoryIndex.current = 0;
      setViewedVersionId(null);
      setMessage(detail ? '' : '项目不存在或已被删除');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  useEffect(() => { if (!contextOpen) return; const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setContextOpen(false); }; window.addEventListener('keydown', handleKeyDown); return () => window.removeEventListener('keydown', handleKeyDown); }, [contextOpen]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryDraft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryDraft]);
  useEffect(() => {
    const requestImport = () => importInput.current?.click(); window.addEventListener('studio-import-request', requestImport);
    return () => window.removeEventListener('studio-import-request', requestImport);
  }, []);
  useEffect(() => {
    void loadFirst();
  }, [query, status, archived, order, platform, offset]);
  useEffect(() => {
    return window.wmb.onDataChanged((event) => {
      const scopes = event.scopes ?? [];
      const touchesStudio = scopes.includes('studio') || scopes.includes('agent') || scopes.length === 0;
      if (!touchesStudio) return;
      void loadFirst(true);
      // Pi may save a new core version while this project is open; reload unless user has local dirty edits.
      if (selectedId && !dirty) void loadDetail(selectedId);
    });
  }, [query, status, archived, order, platform, offset, dirty, selectedId]);
  useEffect(()=>{void window.wmb.listKnowledgeTopics({limit:100}).then((page)=>setTopics(page?.items ?? []));},[]);
  useEffect(() => { setOffset(0); }, [query, status, archived, order, platform]);
  useEffect(() => { if (!selectedId) { setSelected(null); onContext(null); } }, [selectedId]);
  const summary = projects.find((item) => item.id === selectedId);
  useEffect(() => {
    if (!selectedId) return;
    if (dirty && selected?.id === selectedId) return;
    if (!selected || selected.id !== selectedId || selected.updatedAt !== summary?.updatedAt) void loadDetail(selectedId);
  }, [selectedId, summary?.updatedAt, dirty, selected?.id, selected?.updatedAt]);
  useEffect(() => { onContext(selected ? { id: selected.id, title: selected.title } : null); }, [selected?.id, selected?.title]);
  useEffect(() => {
    if (!onFocusChange) return;
    if (selected) {
      const latestBody = selected.revisions[0]?.body ?? '';
      const excerpt = latestBody.trim() ? latestBody.slice(0, 6000) : null;
      onFocusChange({
        type: 'project',
        id: selected.id,
        title: selected.title,
        summary: `状态 ${selected.status} · ${selected.revisions.length} 版`,
        bodyStatus: excerpt ? 'ready' : 'empty',
        bodyExcerpt: excerpt,
        bodyChars: excerpt?.length ?? 0
      });
      return;
    }
    if (listFocusId) {
      const project = projects.find((item) => item.id === listFocusId);
      if (project) {
        onFocusChange({
          type: 'project',
          id: project.id,
          title: project.title,
          summary: `${project.archivedAt ? '已归档' : project.status} · ${project.versionCount} 版 · 列表焦点（未打开编辑器）`,
          bodyStatus: 'none',
          bodyExcerpt: null,
          bodyChars: 0
        });
        return;
      }
    }
    onFocusChange(null);
  }, [selected?.id, selected?.title, selected?.status, selected?.revisions[0]?.id, listFocusId, projects, onFocusChange]);
  useEffect(() => {
    setTitle(selected?.title ?? '');
    const latestBody = selected?.revisions[0]?.body ?? '';
    setBody(latestBody);
    bodyHistory.current = [latestBody];
    bodyHistoryIndex.current = 0;
    setViewedVersionId(null);
    setCopyTitle(selected ? `${selected.title}（独立项目）` : '');
  }, [selected?.id, selected?.title, selected?.revisions[0]?.id]);
  const outline = useMemo(() => bodyWithoutLeadingTitle(body).split('\n').flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2], index }] : [];
  }), [body]);
  const characterCount = body.replace(/\s/g, '').length; const displayBody = viewedVersion?.body ?? body;
  useEffect(() => {
    // 平台/来源等页会卸载编辑器 DOM；回到 core 时必须按 tab 重新灌入，不能只依赖 body 不变。
    if (tab !== 'core' && tab !== 'versions') return;
    if (editorMode !== 'rich' && !viewedVersion) return;
    const editor = bodyInput.current;
    if (!editor) return;
    // 正在输入时保光标；从其他 tab 切回时 activeElement 不是 editor，会正常灌入。
    if (document.activeElement === editor && editorMode === 'rich' && !viewedVersion) return;
    editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
  }, [tab, displayBody, viewedVersion?.id, editorMode]);
  useEffect(() => {
    if (tab !== 'core' && tab !== 'versions') return;
    if (!(viewedVersion || editorMode === 'rich')) return;
    const editor = bodyInput.current;
    if (!editor) return;
    editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
  }, [tab, editorMode, viewedVersion?.id, displayBody]);
  const fitSourceEditor = () => {
    const textarea = sourceInput.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const minHeight = Math.max(window.innerHeight - 360, 420);
    textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
  };
  useEffect(() => {
    if (tab !== 'core' && tab !== 'versions') return;
    if (editorMode !== 'source' || viewedVersion) return;
    // 下一帧再量高：textarea 刚挂回 DOM 时 scrollHeight 可能仍是 0。
    const id = window.requestAnimationFrame(() => fitSourceEditor());
    return () => window.cancelAnimationFrame(id);
  }, [tab, body, editorMode, viewedVersion]);
  const changeBody = (next: string) => {
    const history = bodyHistory.current.slice(0, bodyHistoryIndex.current + 1);
    if (history[history.length - 1] !== next) history.push(next);
    bodyHistory.current = history;
    bodyHistoryIndex.current = history.length - 1;
    setBody(next);
  };
  const moveHistory = (direction: -1 | 1) => {
    const next = bodyHistoryIndex.current + direction;
    if (next < 0 || next >= bodyHistory.current.length) return;
    bodyHistoryIndex.current = next;
    setBody(bodyHistory.current[next]);
  };
  const insertMarkdown = (snippet: string) => {
    if (viewedVersion) return;
    if (editorMode === 'source') {
      const textarea = sourceInput.current;
      if (!textarea) {
        changeBody(`${body}${body.endsWith('\n') || !body ? '' : '\n\n'}${snippet}`);
        return;
      }
      textarea.focus();
      changeBody(insertTextAtCursor(textarea, snippet));
      return;
    }
    const editor = bodyInput.current;
    if (!editor) {
      changeBody(`${body}${body.endsWith('\n') || !body ? '' : '\n\n'}${snippet}`);
      return;
    }
    editor.focus();
    document.execCommand('insertHTML', false, renderMarkdown(snippet));
    changeBody(htmlToMarkdown(editor));
  };
  const formatSelection = (before: string, after = before, placeholder = '文字') => {
    if (viewedVersion) return;
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
    if (!editor || viewedVersion) return;
    editor.focus();
    document.execCommand(command, false, value);
    changeBody(htmlToMarkdown(editor));
  };
  const handleEditorPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (viewedVersion || busy) return;
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
  };
  const handleSourcePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (viewedVersion || busy) return;
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void insertImageFile(file);
  };
  const insertImageFile = async (file?: File) => {
    if (!selected || busy || viewedVersion) return;
    setBusy(true);
    setMessage(file ? '正在插入图片…' : '选择图片…');
    try {
      let result: Awaited<ReturnType<typeof window.wmb.importStudioImage>>;
      if (file) {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (const byte of buffer) binary += String.fromCharCode(byte);
        result = await window.wmb.importStudioImage({
          projectId: selected.id,
          fileName: file.name,
          mimeType: file.type,
          bytesBase64: btoa(binary),
          alt: file.name.replace(/\.[^.]+$/, '')
        });
      } else {
        result = await window.wmb.importStudioImage({ projectId: selected.id });
      }
      if (!result.ok) {
        setMessage(result.cancelled ? '' : '插入图片失败');
        return;
      }
      insertMarkdown(`${result.markdown}\n\n`);
      setMessage(result.reused ? '已插入已有图片素材' : '图片已插入');
      await loadDetail(selected.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      if (imageInput.current) imageInput.current.value = '';
    }
  };
  const createProject = async () => {
    if (!newTitle.trim() || busy) return;
    setBusy(true);
    try {
      const detail = await window.wmb.createStudioProject({ title: newTitle.trim(), body: '开始写作。' });
      setCreating(false);
      setNewTitle('');
      await loadFirst(true);
      onSelect(detail.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const importProject = async (file: File) => {
    setBusy(true);
    try {
      const body = await file.text();
      const title = file.name.replace(/\.(md|markdown|txt)$/i, '').trim() || '导入稿件';
      const detail = await window.wmb.createStudioProject({ title, body: body.trim() || '开始写作。' });
      await loadFirst(true);
      onSelect(detail.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); if (importInput.current) importInput.current.value = ''; }
  };

  const reload = async () => { if (selectedId) await loadDetail(selectedId); await loadFirst(true); };
  const deleteRow = async (project: ContentProjectSummary) => {
    if (busy) return;
    if (!await appConfirm({ title: '删除项目', message: `彻底删除项目「${project.title}」？此操作不可恢复。`, confirmLabel: '彻底删除', danger: true })) return;
    setBusy(true);
    try {
      const result = await window.wmb.deleteStudioProject({ projectId: project.id, expectedRevision: project.revision });
      setMessage(result.ok ? '项目已彻底删除' : result.error?.message || '删除失败');
      if (result.ok) await loadFirst(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const archiveRow = async (project: ContentProjectSummary) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.wmb.updateStudioProject({ projectId: project.id, expectedRevision: project.revision, archived: !project.archivedAt });
      setMessage(result.ok ? (project.archivedAt ? '已恢复项目' : '已归档项目，可在「已归档」中恢复') : result.error?.message || '操作失败');
      if (result.ok) await loadFirst(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!selected || busy || viewedVersion) return;
    if (!title.trim() || !body.trim()) { setMessage(!title.trim() ? '标题不能为空' : '正文不能为空'); return; }
    if (!dirty) {
      setMessage('内容没有改动');
      window.setTimeout(() => setMessage((current) => current === '内容没有改动' ? '' : current), 1600);
      return;
    }
    setBusy(true); setMessage('正在保存…');
    try {
      const result = await window.wmb.saveStudioCore({ projectId: selected.id, title: title.trim(), body, expectedRevision: selected.revision });
      setMessage(result.ok ? '已保存' : result.error?.code === 'REVISION_CONFLICT' ? '内容已在其他位置更新，请读取最新内容后再保存' : result.error?.message || '保存失败');
      if (result.ok) await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const writeDraft = async () => {
    if (!selected || busy) return;
    setBusy(true); setMessage('Pi 正在写初稿…');
    try {
      const result = await window.wmb.startStudioDraft({ businessDate: planDate, projectId: selected.id });
      setMessage(result.ok ? result.data?.task.status === 'needs_user' ? result.data.task.errorMessage || '需要用户处理' : 'Pi 初稿任务已完成' : result.error?.message || '初稿失败');
      await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const update = async (change: { status?: ContentProjectStatus; archived?: boolean; topicId?:string|null }) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const result = await window.wmb.updateStudioProject({ projectId: selected.id, expectedRevision: selected.revision, ...change });
      if (result.ok) {
        setSelected(result.data);
        setMessage(change.archived === true ? '已归档' : change.archived === false ? '已恢复' : change.topicId!==undefined?'长期主题已更新':'工作状态已更新');
        await loadFirst();
      } else {
        setMessage(result.error?.code === 'REVISION_CONFLICT' ? '项目已在其他位置更新，已读取最新状态' : result.error?.message || '项目更新失败');
        setSelected(result.error?.details?.current ?? null);
        if (!result.error?.details?.current) await reload();
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const saveFromVersion = async () => {
    if (!selected || !viewedVersion || busy) return;
    setBusy(true); setMessage(`正在基于 v${viewedVersion.number} 另存…`);
    try {
      const result = await window.wmb.saveStudioCore({
        projectId: selected.id, title: selected.title, body: viewedVersion.body, expectedRevision: selected.revision
      });
      if (!result.ok) setMessage(result.error?.code === 'REVISION_CONFLICT' ? '项目已更新，请读取最新版后重试' : result.error?.message || '另存失败');
      else { setMessage(`已基于 v${viewedVersion.number} 新增一个版本`); await reload(); setViewedVersionId(null); }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const copyVersion = async () => {
    if (!selected || !viewedVersion || busy) return;
    setBusy(true); setMessage(`正在复制 v${viewedVersion.number}…`);
    try {
      const result = await window.wmb.copyStudioVersionToProject({
        sourceProjectId: selected.id, contentVersionId: viewedVersion.id, title: copyTitle
      });
      if (!result.ok || !result.data) setMessage(result.error?.message || '复制失败');
      else {
        setProjects((current) => [result.data!, ...current.filter((item) => item.id !== result.data!.id)]);
        onSelect(result.data.id);
        setMessage(`已创建独立项目：${result.data.title}`);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };


  const jumpToStart = () => {
    const canvas = canvasRef.current;
    if (canvas) canvas.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const jumpToHeading = (item: { level: number; title: string; index: number }) => {
    // 确保在核心正文页；DOM 可能下帧才挂上
    const run = () => {
      const canvas = canvasRef.current;
      const title = item.title.trim();
      // 富文本 / 只读历史 / 源码预览：按标题文本定位
      const roots = [
        bodyInput.current,
        canvas?.querySelector('.studio-live-false-body') as HTMLElement | null
      ].filter(Boolean) as HTMLElement[];
      for (const root of roots) {
        const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
        const hit = headings.find((node) => (node.textContent || '').trim() === title)
          ?? headings.find((node) => (node.textContent || '').trim().includes(title));
        if (hit) {
          hit.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
      }
      // 源码模式：按纲要行号估算滚动
      const ta = sourceInput.current;
      if (ta && canvas) {
        const lines = bodyWithoutLeadingTitle(body).split('\n');
        const ratio = lines.length ? Math.min(1, Math.max(0, item.index / lines.length)) : 0;
        const top = Math.max(0, (ta.scrollHeight - ta.clientHeight) * ratio);
        ta.focus();
        ta.scrollTop = top;
        // 同步画布，避免外层仍停在顶部
        canvas.scrollTo({ top: Math.max(0, ta.offsetTop - 24), behavior: 'smooth' });
        // 尝试选中标题行
        const lineStart = lines.slice(0, item.index).join('\n').length + (item.index > 0 ? 1 : 0);
        const lineText = lines[item.index] ?? '';
        try { ta.setSelectionRange(lineStart, lineStart + lineText.length); } catch { /* */ }
      }
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(run));
  };

  if (!selectedId) {
    return <section className="studio-library">
    <input ref={importInput} className="studio-import-input" type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProject(file); }}/>
    <input ref={imageInput} className="studio-import-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertImageFile(file); }}/>
    <StudioLibraryHeader summary={statusSummary} projects={projects} hasMore={hasMore} status={status} archived={archived} setStatus={setStatus} setArchived={setArchived} onCreate={() => setCreating(true)}/>
    <div className="studio-library-body">
      {creating && <div className="studio-create-row"><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createProject(); }} placeholder="输入新项目标题"/><button className="primary-button" disabled={!newTitle.trim() || busy} onClick={() => void createProject()}>创建并开始写作</button><button className="secondary-button" onClick={() => { setCreating(false); setNewTitle(''); }}>取消</button></div>}
      <div className="studio-library-tools">
        <label className="studio-search-wrap">⌕ <input className="studio-search" type="search" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="搜索项目标题或正文" aria-label="搜索内容项目"/></label>
        <select aria-label="项目排序" value={order} onChange={(event) => setOrder(event.target.value as ContentProjectOrder)}><option value="recent">最近更新</option><option value="oldest">最早更新</option><option value="versions">版本最多</option></select>
        <select aria-label="平台筛选" value={platform ?? 'all'} onChange={(event) => setPlatform(event.target.value === 'all' ? undefined : event.target.value as ContentProjectPlatform)}><option value="all">全部平台</option>{enabledPlatforms.map((value) => <option key={value} value={value}>{platformNames[value]}</option>)}</select>
        <span>找到 {projects.length}{hasMore || offset ? '+' : ''} 个项目</span>
      </div>
      <div className="studio-project-table" role="table">
        <div className="studio-project-row head" role="row"><span>项目</span><span>工作状态</span><span>平台内容</span><span>最近更新</span><span>版本</span><span/></div>
        {projects.map((project) => <div className={`studio-project-row${listFocusId === project.id ? ' selected' : ''}`} role="row" tabIndex={0} key={project.id}
          title={listFocusId === project.id ? '再次点击取消 Pi 焦点；双击或点「打开」进入编辑' : '单击设为 Pi 焦点；双击或点「打开」进入编辑'}
          onClick={() => setListFocusId((current) => current === project.id ? null : project.id)}
          onDoubleClick={() => onSelect(project.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); onSelect(project.id); }
            if (event.key === ' ') { event.preventDefault(); setListFocusId((current) => current === project.id ? null : project.id); }
          }}>
          <span className="studio-project-title-cell"><span className="studio-project-title-line">{(() => { const g = priorityGrade(project.planItemPriority as number | null | undefined); const n = Number(project.planItemPriority); return Number.isFinite(n) ? <strong className="opp-grade" data-grade={g}>{g}</strong> : null; })()}<strong className="studio-project-name">{project.title}</strong></span><small>项目 {project.id.slice(0, 8)} · 最新正文按需读取</small></span>
          <span className="studio-project-state"><i data-status={project.status}/>{project.archivedAt ? '已归档' : statuses.find((item) => item.value === project.status)?.label}</span>
          <span className="studio-project-platform">{enabledPlatforms.filter((value) => project.platforms[value] > 0).length} / {enabledPlatforms.length}<i><b style={{ width: `${enabledPlatforms.filter((value) => project.platforms[value] > 0).length / Math.max(1, enabledPlatforms.length) * 100}%` }}/></i></span>
          <time>{formatTime(project.updatedAt)}</time>
          <span>{project.versionCount} 个版本</span>
          <span className="studio-row-actions">
            <button className="studio-row-action" aria-label={`打开项目 ${project.title}`} onClick={(event) => { event.stopPropagation(); onSelect(project.id); }}>打开</button>
            <button className="studio-row-action" aria-label={`${project.archivedAt ? '恢复' : '归档'}项目 ${project.title}`} onClick={(event) => { event.stopPropagation(); void archiveRow(project); }}>{project.archivedAt ? '恢复' : '归档'}</button>
            {Object.values(project.platforms).every((count) => !count) && <button className="studio-row-action danger" aria-label={`删除项目 ${project.title}`} onClick={(event) => { event.stopPropagation(); void deleteRow(project); }}>删除</button>}
          </span>
        </div>)}
      </div>
      {loading && !projects.length && <p className="studio-loading">正在读取项目…</p>}
      {!loading && !projects.length && <div className="compact-empty"><h2>没有符合条件的项目</h2><p>调整搜索或状态条件后重试。</p></div>}
      <footer className="studio-library-pagination"><span>第 {projects.length ? offset + 1 : 0}–{offset + projects.length} 项，每页最多 50 项</span><div><button className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button className="secondary-button" disabled={!hasMore} onClick={() => setOffset(offset + 50)}>下一页</button></div></footer>
    </div>
  </section>;
  }

  return <section className={`studio-editor-view${contextOpen ? ' context-open' : ''}`}>
    <input ref={imageInput} className="studio-import-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertImageFile(file); }}/>
    <StudioEditorTop selected={selected} dirty={dirty} latestCreatedAt={latest?.createdAt} onBack={() => onSelect(null)} toggleContext={() => setContextOpen((value) => !value)} viewedVersion={Boolean(viewedVersion)} editorMode={editorMode} setEditorMode={setEditorMode} busy={busy} save={save}/>
    <div className="studio-editor-grid">
    <StudioOutline outline={outline} tab={tab} setTab={setTab} platformVersions={selected?.platformVersions ?? {}} onJumpToStart={jumpToStart} onJumpToHeading={jumpToHeading}/>
    <main className="studio-document">
      {selected ? <>
        {(tab === 'core' || tab === 'versions') && <>
          {viewedVersion && <section className="historical-version-notice"><span>正在查看不可修改的版本 v{viewedVersion.number}</span><div><button className="secondary-button" onClick={() => setViewedVersionId(null)}>返回最新版</button><button className="secondary-button" disabled={busy} onClick={() => void saveFromVersion()}>基于此版本另存</button></div><label>新项目标题<input value={copyTitle} onChange={(event) => setCopyTitle(event.target.value)}/></label><button className="primary-button" disabled={busy || !copyTitle.trim()} onClick={() => void copyVersion()}>复制版本为新项目</button></section>}
          {!viewedVersion && <StudioFormatBar busy={busy} execRich={execRich} formatSelection={formatSelection} insertMarkdown={insertMarkdown} insertImageFile={insertImageFile} toggleFind={() => setFindOpen((value) => !value)}/>}
            {findOpen && <div className="studio-findbar"><input value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="查找正文"/><input id="studio-replace" placeholder="替换为"/><span>{findText ? body.split(findText).length - 1 : 0} 处匹配</span><button disabled={!findText || !body.includes(findText)} onClick={() => { const replacement = (document.querySelector('#studio-replace') as HTMLInputElement)?.value ?? ''; changeBody(body.split(findText).join(replacement)); }}>全部替换</button><button onClick={() => setFindOpen(false)}>关闭</button></div>}
          <div className="studio-canvas" ref={canvasRef}><article className="studio-paper">
            <textarea id="studio-title" className="studio-title-input" value={title} rows={1} disabled={busy || Boolean(viewedVersion)} onChange={(event) => setTitle(event.target.value)} onInput={(event) => { const el = event.currentTarget; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }} ref={(node) => { if (!node) return; node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }}/>
            <div className="studio-doc-meta">
              <span>核心正文</span>
              <span>{statuses.find((item) => item.value === selected.status)?.label}</span>
              <span>{selected.sources.length} 条来源</span>
              {selected.creativeBrief && <span>来自创作简报</span>}
              <span>{selected.assets.length} 个素材</span>
              <span>{false ? '预览' : editorMode === 'source' ? 'Markdown 源码' : '富文本'}</span>
            </div>
            {viewedVersion || editorMode === 'rich' ? (
              <div
                ref={(node) => {
                  bodyInput.current = node;
                  // 从平台页切回会重建 DOM；挂载时立即灌入，避免空白一帧/漏 effect。
                  if (node && (viewedVersion || editorMode === 'rich')) {
                    const html = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
                    if (node.innerHTML !== html) node.innerHTML = html;
                  }
                }}
                id="studio-body"
                className="studio-rich-editor"
                contentEditable={!viewedVersion && !busy && editorMode === 'rich'}
                suppressContentEditableWarning
                onInput={(event) => changeBody(htmlToMarkdown(event.currentTarget))}
                onPaste={handleEditorPaste}
                onBlur={(event) => {
                  if (viewedVersion || editorMode !== 'rich') return;
                  event.currentTarget.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(body));
                }}
              />
            ) : (
              <div className="studio-source-stack">
                <textarea
                  ref={sourceInput}
                  id="studio-body-source"
                  className="studio-source-editor"
                  value={body}
                  disabled={busy}
                  spellCheck={false}
                  placeholder={"在这里写完整 Markdown。\n\n## 二级标题\n\n正文段落。"}
                  onChange={(event) => {
                    changeBody(event.target.value);
                    const textarea = event.currentTarget;
                    textarea.style.height = 'auto';
                    const minHeight = Math.max(window.innerHeight - 360, 420);
                    textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
                  }}
                  onPaste={handleSourcePaste}
                />
                <section className="studio-live-false" aria-label="Markdown 实时预览">
                  <div className="studio-live-false-label">实时预览</div>
                  <div
                    className="studio-rich-editor studio-live-false-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyWithoutLeadingTitle(body)) || '<p class="studio-live-false-empty">输入 Markdown 后这里会实时渲染</p>' }}
                  />
                </section>
              </div>
            )}
          </article></div>
          <div className="studio-writing-status" data-running={busy ? 'true' : 'false'}>
            <div className="studio-status-left">
              <span className="studio-status-metrics">字数 {characterCount} · 约 {Math.max(1, Math.ceil(characterCount / 500))} 分钟</span>
              <span className="studio-status-sep" aria-hidden="true">·</span>
              <div className="studio-status-links" aria-label="关联来源与素材">
                <button type="button" className="studio-status-link" title="查看全部关联来源" onClick={() => setTab('sources')}>来源 {selected.sources.length}</button>
                {selected.sources.slice(0, 3).map((source) => (
                  <button type="button" key={source.id} className="studio-status-chip" title={source.title} onClick={() => {
                    if (onOpenSource) onOpenSource(source.id);
                    else if (source.canonicalUrl) void window.wmb.openExternal(source.canonicalUrl);
                    else setTab('sources');
                  }}>{source.title.length > 16 ? source.title.slice(0, 16) + '…' : source.title}</button>
                ))}
                {selected.sources.length > 3 ? <span className="studio-status-more">+{selected.sources.length - 3}</span> : null}
                <span className="studio-status-sep" aria-hidden="true">·</span>
                <button type="button" className="studio-status-link" title="查看关联素材" onClick={() => setTab('assets')}>素材 {selected.assets.length}</button>
                {selected.assets.slice(0, 2).map((asset) => (
                  <button type="button" key={asset.id} className="studio-status-chip" title={asset.relativePath} onClick={() => setTab('assets')}>
                    {(asset.relativePath.split(/[/\\]/).pop() || asset.relativePath).slice(0, 14)}
                  </button>
                ))}
              </div>
            </div>
            <span className={message ? 'studio-status-message' : undefined}>
              {message || (viewedVersion ? '历史版本只读' : dirty ? '未保存' : '已保存')}
            </span>
          </div>
        </>}
        {tab === 'sources' && <section className="studio-detail-list">{selected.sources.length ? selected.sources.map((source) => <article key={source.id}><span>资料来源</span><h3>{source.title}</h3><p>{source.summary || '暂无摘要'}</p><small>{[source.author, source.publishedAt && formatTime(source.publishedAt)].filter(Boolean).join(' · ')}</small>{source.canonicalUrl && <button className="secondary-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}</article>) : <div className="compact-empty"><h2>没有关联资料</h2><p>该项目尚未绑定资料来源。</p></div>}</section>}
        {tab === 'platforms' && <section className="studio-detail-list">{Object.entries(selected.platformVersions).flatMap(([platform, versions]) => versions.map((version) => <article key={version.id}><span>{platformNames[platform]} · {version.format}</span><h3>{version.title || `平台版本 ${version.id.slice(0, 8)}`}</h3><p>{version.body}</p><small>绑定核心版本 第 {selected.revisions.find((item) => item.id === version.contentVersionId)?.number ?? version.contentVersionId} 版 · 素材 {version.assets.length} 项</small></article>))}{!Object.values(selected.platformVersions).flat().length && <div className="compact-empty"><h2>没有平台版本</h2><p>平台适配内容会在这里按真实绑定关系显示。</p></div>}</section>}
        {tab === 'assets' && <section className="studio-detail-list">{selected.assets.length ? selected.assets.map((asset) => <article key={asset.id}><span>{asset.mimeType}</span><h3>{asset.relativePath}</h3><p>素材指纹 {asset.sha256}</p><small>{asset.byteCount} 字节{asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}{asset.durationMs ? ` · ${asset.durationMs} 毫秒` : ''} · {asset.origin}</small></article>) : <div className="compact-empty"><h2>没有关联素材</h2><p>只有被平台版本真实引用的素材才会显示。</p></div>}</section>}
      </> : <section className="empty-state editor-empty"><h2>{message ? '项目详情读取失败' : '选择一个内容项目'}</h2><p>{message || '左侧会显示符合当前条件的项目。'}</p>{selectedId && message && <button onClick={() => void loadDetail(selectedId)}>重新读取</button>}</section>}
    </main>
    <StudioContext selected={selected} setTab={setTab} setViewedVersionId={setViewedVersionId} latestId={latest?.id}/>
    </div>
  </section>;
}
