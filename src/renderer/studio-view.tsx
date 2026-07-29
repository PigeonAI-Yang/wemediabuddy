import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ContentProjectDetail, ContentProjectOrder, ContentProjectPlatform, ContentProjectStatus, ContentProjectSummary } from '../main/content';

const statuses: Array<{ value: ContentProjectStatus; label: string }> = [
  { value: 'idea', label: '想法' }, { value: 'drafting', label: '创作中' },
  { value: 'review', label: '待审' }, { value: 'ready', label: '待发布' },
  { value: 'completed', label: '已完成' }
];
const platformNames: Record<string, string> = { x: 'X', xiaohongshu: '小红书', wechat: '微信' };
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN');
const renderMarkdown = (value: string) => DOMPurify.sanitize(marked.parse(value, { async: false }) as string);
const bodyWithoutLeadingTitle = (value: string) => value.replace(/^#\s+.+\r?\n+/, '');
function htmlToMarkdown(root: HTMLElement): string {
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof HTMLElement)) return '';
    const content = [...node.childNodes].map(read).join('');
    if (/^H[1-3]$/.test(node.tagName)) return `${'#'.repeat(Number(node.tagName[1]))} ${content.trim()}\n\n`;
    if (node.tagName === 'P' || node.tagName === 'DIV') return `${content.trim()}\n\n`;
    if (node.tagName === 'STRONG' || node.tagName === 'B') return `**${content}**`;
    if (node.tagName === 'EM' || node.tagName === 'I') return `*${content}*`;
    if (node.tagName === 'U') return `<u>${content}</u>`;
    if (node.tagName === 'BLOCKQUOTE') return `${content.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
    if (node.tagName === 'A') return `[${content}](${node.getAttribute('href') ?? ''})`;
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'UL' || node.tagName === 'OL') return `${[...node.children].map((item, index) => `${node.tagName === 'OL' ? `${index + 1}.` : '-'} ${item.textContent?.trim() ?? ''}`).join('\n')}\n\n`;
    if (node.tagName === 'LI') return content;
    return content;
  };
  return [...root.childNodes].map(read).join('').replace(/\n{3,}/g, '\n\n').trim();
}

export function LongTermStudioView({ openPublish, selectedId, onSelect, onContext, planDate }: {
  openPublish: () => void;
  selectedId: string | null;
  onSelect: (projectId: string | null) => void;
  onContext: (project: { id: string; title: string } | null) => void;
  planDate: string;
}): React.JSX.Element {
  const [projects, setProjects] = useState<ContentProjectSummary[]>([]);
  const [topics,setTopics]=useState<any[]>([]);
  const [selected, setSelected] = useState<ContentProjectDetail | null>(null);
  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ContentProjectStatus | undefined>();
  const [archived, setArchived] = useState(false);
  const [order, setOrder] = useState<ContentProjectOrder>('recent');
  const [platform, setPlatform] = useState<ContentProjectPlatform | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tab, setTab] = useState<'core' | 'versions' | 'sources' | 'platforms' | 'assets'>('core');
  const [contextTab, setContextTab] = useState<'versions' | 'sources' | 'assets'>('versions');
  const [viewedVersionId, setViewedVersionId] = useState<string | null>(null);
  const [copyTitle, setCopyTitle] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const bodyInput = useRef<HTMLDivElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const bodyHistory = useRef<string[]>(['']);
  const bodyHistoryIndex = useRef(0);
  const latest = selected?.revisions[0];
  const viewedVersion = selected?.revisions.find((version) => version.id === viewedVersionId) ?? null;
  const dirty = Boolean(selected) && (title.trim() !== selected?.title.trim() || body !== (latest?.body ?? ''));
  const input = { query: query || undefined, status, archived, order, platform, limit: 50 };

  const loadFirst = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await window.wmb.listStudioProjects({ ...input, offset });
      const page = result?.items ?? [];
      setProjects(page);
      setHasMore(Boolean(result?.hasMore));
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

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryDraft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryDraft]);
  useEffect(() => {
    const requestImport = () => importInput.current?.click();
    window.addEventListener('studio-import-request', requestImport);
    return () => window.removeEventListener('studio-import-request', requestImport);
  }, []);
  useEffect(() => {
    void loadFirst();
    const poll = window.setInterval(() => void loadFirst(true), 5000);
    return () => window.clearInterval(poll);
  }, [query, status, archived, order, platform, offset]);
  useEffect(()=>{void window.wmb.listKnowledgeTopics({limit:100}).then(setTopics);},[]);
  useEffect(() => { setOffset(0); }, [query, status, archived, order, platform]);
  useEffect(() => { if (!selectedId) { setSelected(null); onContext(null); } }, [selectedId]);
  const summary = projects.find((item) => item.id === selectedId);
  useEffect(() => {
    if (selectedId && (!selected || selected.id !== selectedId || selected.updatedAt !== summary?.updatedAt)) void loadDetail(selectedId);
  }, [selectedId, summary?.updatedAt]);
  useEffect(() => { onContext(selected ? { id: selected.id, title: selected.title } : null); }, [selected?.id, selected?.title]);
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
    const match = /^(#{2,3})\s+(.+)$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2], index }] : [];
  }), [body]);
  const characterCount = body.replace(/\s/g, '').length;
  useEffect(() => {
    const editor = bodyInput.current;
    if (editor && document.activeElement !== editor) editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(viewedVersion?.body ?? body));
  }, [body, viewedVersion?.body]);
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
  const formatSelection = (before: string, after = before, placeholder = '文字') => {
    const editor = bodyInput.current;
    if (!editor || viewedVersion) return;
    editor.focus();
    const command = before === '**' ? 'bold' : before === '*' ? 'italic' : before === '- ' ? 'insertUnorderedList' : before === '> ' ? 'formatBlock' : '';
    if (command === 'formatBlock') document.execCommand(command, false, 'blockquote');
    else if (command) document.execCommand(command);
    else if (before === '## ') document.execCommand('formatBlock', false, 'h2');
    else if (before === '[') {
      const url = window.prompt('粘贴链接地址');
      if (url) document.execCommand('createLink', false, url);
    } else document.execCommand('insertText', false, placeholder);
    changeBody(htmlToMarkdown(editor));
  };
  const execRich = (command: string, value?: string) => {
    const editor = bodyInput.current;
    if (!editor || viewedVersion) return;
    editor.focus();
    document.execCommand(command, false, value);
    changeBody(htmlToMarkdown(editor));
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
  const save = async () => {
    if (!selected || busy) return;
    if (!title.trim() || !body.trim()) { setMessage(!title.trim() ? '标题不能为空' : '正文不能为空'); return; }
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
      setMessage(result.ok ? 'Pi 初稿任务已完成' : result.error?.message || '初稿失败');
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

  if (!selectedId) return <section className="studio-library">
    <input ref={importInput} className="studio-import-input" type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProject(file); }}/>
    <header className="studio-library-heading">
      <div><h1>创作项目</h1><p>管理长期选题、稿件版本和平台内容。</p></div>
      <button className="primary-button" onClick={() => setCreating(true)}>新建创作项目</button>
    </header>
    <nav className="studio-library-summary" aria-label="项目状态">
      <button className={!status && !archived ? 'active' : ''} onClick={() => { setStatus(undefined); setArchived(false); }}><strong>{projects.length}{hasMore ? '+' : ''}</strong><span>全部项目</span></button>
      {statuses.filter((item) => item.value !== 'idea').map((item) => <button key={item.value} className={status === item.value && !archived ? 'active' : ''} onClick={() => { setStatus(item.value); setArchived(false); }}><strong>{projects.filter((project) => project.status === item.value).length}{hasMore ? '+' : ''}</strong><span>{item.label}</span></button>)}
      <button className={archived ? 'active' : ''} onClick={() => { setStatus(undefined); setArchived(true); }}><strong>{archived ? projects.length : '—'}</strong><span>已归档</span></button>
    </nav>
    <div className="studio-library-body">
      {creating && <div className="studio-create-row"><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createProject(); }} placeholder="输入新项目标题"/><button className="primary-button" disabled={!newTitle.trim() || busy} onClick={() => void createProject()}>创建并开始写作</button><button className="secondary-button" onClick={() => { setCreating(false); setNewTitle(''); }}>取消</button></div>}
      <div className="studio-library-tools">
        <label className="studio-search-wrap">⌕ <input className="studio-search" type="search" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="搜索项目标题或正文" aria-label="搜索内容项目"/></label>
        <select aria-label="项目排序" value={order} onChange={(event) => setOrder(event.target.value as ContentProjectOrder)}><option value="recent">最近更新</option><option value="oldest">最早更新</option><option value="versions">版本最多</option></select>
        <select aria-label="平台筛选" value={platform ?? 'all'} onChange={(event) => setPlatform(event.target.value === 'all' ? undefined : event.target.value as ContentProjectPlatform)}><option value="all">全部平台</option><option value="xiaohongshu">小红书</option><option value="wechat">微信公众号</option><option value="x">X</option></select>
        <span>找到 {projects.length}{hasMore || offset ? '+' : ''} 个项目</span>
      </div>
      <div className="studio-project-table" role="table">
        <div className="studio-project-row head" role="row"><span>项目</span><span>工作状态</span><span>平台内容</span><span>最近更新</span><span>版本</span></div>
        {projects.map((project) => <button className="studio-project-row" role="row" key={project.id} onClick={() => onSelect(project.id)}>
          <span><strong>{project.title}</strong><small>项目 {project.id.slice(0, 8)} · 最新正文按需读取</small></span>
          <span className="studio-project-state"><i data-status={project.status}/>{project.archivedAt ? '已归档' : statuses.find((item) => item.value === project.status)?.label}</span>
          <span className="studio-project-platform">{Object.values(project.platforms).filter(Boolean).length} / 3<i><b style={{ width: `${Object.values(project.platforms).filter(Boolean).length / 3 * 100}%` }}/></i></span>
          <time>{formatTime(project.updatedAt)}</time>
          <span>{project.versionCount} 个版本</span>
        </button>)}
      </div>
      {loading && !projects.length && <p className="studio-loading">正在读取项目…</p>}
      {!loading && !projects.length && <div className="compact-empty"><h2>没有符合条件的项目</h2><p>调整搜索或状态条件后重试。</p></div>}
      <footer className="studio-library-pagination"><span>第 {projects.length ? offset + 1 : 0}–{offset + projects.length} 项，每页最多 50 项</span><div><button className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button className="secondary-button" disabled={!hasMore} onClick={() => setOffset(offset + 50)}>下一页</button></div></footer>
    </div>
  </section>;

  return <section className={`studio-editor-view${contextOpen ? ' context-open' : ''}`}>
    <div className="studio-editor-top">
      <button className="studio-top-back" onClick={() => onSelect(null)}>← 返回项目库</button>
      <span className={`studio-doc-state${dirty ? ' dirty' : ''}`}>{selected ? <><b>{dirty ? '有未保存修改' : '✓ 已保存'}</b> · 第 {selected.versionCount} 版 · {formatTime(latest?.createdAt ?? selected.updatedAt)}</> : '正在读取项目…'}</span>
      <div className="studio-grow"/>
      <button className="secondary-button" onClick={() => setContextOpen((value) => !value)}>项目资料</button>
      <button className="secondary-button" onClick={() => setPreview((value) => !value)}>{preview ? '继续编辑' : '预览'}</button>
      <button className="primary-button" disabled={!dirty || busy || Boolean(viewedVersion)} onClick={() => void save()}>保存为新版本</button>
    </div>
    <div className="studio-editor-grid">
    <aside className="studio-outline">
      <p className="studio-panel-title">文章纲要</p>
      <button className="active">开头</button>
      {outline.map((item) => <button key={`${item.index}-${item.title}`} className={item.level === 3 ? 'sub' : ''}>{item.title}</button>)}
      {!outline.length && <p>二级、三级标题会显示在这里。</p>}
      <p className="studio-panel-title platform-title">平台内容</p>
      <button className={tab === 'core' ? 'active' : ''} onClick={() => setTab('core')}>核心正文</button>
      {Object.entries(selected?.platformVersions ?? {}).map(([platform, versions]) => <button key={platform} onClick={() => setTab('platforms')}>{platformNames[platform]} <small>{versions.length ? `${versions.length} 个版本` : '未创建'}</small><i className="st-dot" data-state={versions.length ? 'ready' : 'none'} aria-hidden="true"/></button>)}
    </aside>
    <main className="studio-document">
      {selected ? <>
        {(tab === 'core' || tab === 'versions') && <>
          {viewedVersion && <section className="historical-version-notice"><span>正在查看不可修改的版本 v{viewedVersion.number}</span><div><button className="secondary-button" onClick={() => setViewedVersionId(null)}>返回最新版</button><button className="secondary-button" disabled={busy} onClick={() => void saveFromVersion()}>基于此版本另存</button></div><label>新项目标题<input value={copyTitle} onChange={(event) => setCopyTitle(event.target.value)}/></label><button className="primary-button" disabled={busy || !copyTitle.trim()} onClick={() => void copyVersion()}>复制版本为新项目</button></section>}
          {!preview && !viewedVersion && <div className="studio-formatbar" role="toolbar" aria-label="正文格式" onMouseDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
              <select aria-label="段落格式" defaultValue="p" onChange={(event) => execRich('formatBlock', event.target.value)}><option value="p">正文</option><option value="h2">二级标题</option><option value="h3">三级标题</option><option value="blockquote">引用</option></select>
              <span className="studio-divider"/>
              <button onClick={() => execRich('bold')}><strong>B</strong></button>
              <button onClick={() => execRich('italic')}><em>I</em></button>
              <button onClick={() => execRich('underline')}><u>U</u></button>
              <span className="studio-divider"/>
              <button onClick={() => execRich('insertUnorderedList')}>• 列表</button>
              <button onClick={() => execRich('insertOrderedList')}>1. 列表</button>
              <button onClick={() => formatSelection('[', '](https://)', '链接文字')}>链接</button>
              <button onClick={() => execRich('removeFormat')}>清除格式</button>
              <span className="studio-divider"/>
              <button onClick={() => execRich('undo')}>↶</button>
              <button onClick={() => execRich('redo')}>↷</button>
              <button onClick={() => setFindOpen((value) => !value)}>查找替换</button>
            </div>}
            {findOpen && <div className="studio-findbar"><input value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="查找正文"/><input id="studio-replace" placeholder="替换为"/><span>{findText ? body.split(findText).length - 1 : 0} 处匹配</span><button disabled={!findText || !body.includes(findText)} onClick={() => { const replacement = (document.querySelector('#studio-replace') as HTMLInputElement)?.value ?? ''; changeBody(body.split(findText).join(replacement)); }}>全部替换</button><button onClick={() => setFindOpen(false)}>关闭</button></div>}
          <div className="studio-canvas"><article className="studio-paper">
            <input id="studio-title" className="studio-title-input" value={title} disabled={busy || Boolean(viewedVersion)} onChange={(event) => setTitle(event.target.value)}/>
            <div className="studio-doc-meta"><span>核心正文</span><span>{statuses.find((item) => item.value === selected.status)?.label}</span><span>{selected.sources.length} 条来源</span>{selected.creativeBrief&&<span>来自创作简报</span>}<span>{selected.assets.length} 个素材</span></div>
            <div ref={bodyInput} id="studio-body" className="studio-rich-editor" contentEditable={!preview && !viewedVersion && !busy} suppressContentEditableWarning onInput={(event) => changeBody(htmlToMarkdown(event.currentTarget))}/>
          </article></div>
          <div className="studio-writing-status"><span>字数 {characterCount} · 预计阅读 {Math.max(1, Math.ceil(characterCount / 500))} 分钟</span><span>{preview ? '预览模式' : '自动保存已开启'}</span><span className="right">Markdown 兼容格式</span></div>
        </>}
        {tab === 'sources' && <section className="studio-detail-list">{selected.sources.length ? selected.sources.map((source) => <article key={source.id}><span>资料来源</span><h3>{source.title}</h3><p>{source.summary || '暂无摘要'}</p><small>{[source.author, source.publishedAt && formatTime(source.publishedAt)].filter(Boolean).join(' · ')}</small>{source.canonicalUrl && <button className="secondary-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}</article>) : <div className="compact-empty"><h2>没有关联资料</h2><p>该项目尚未绑定资料来源。</p></div>}</section>}
        {tab === 'platforms' && <section className="studio-detail-list">{Object.entries(selected.platformVersions).flatMap(([platform, versions]) => versions.map((version) => <article key={version.id}><span>{platformNames[platform]} · {version.format}</span><h3>{version.title || `平台版本 ${version.id.slice(0, 8)}`}</h3><p>{version.body}</p><small>绑定核心版本 {selected.revisions.find((item) => item.id === version.contentVersionId)?.number ?? version.contentVersionId} · revision {version.revision} · 素材 {version.assets.length}</small></article>))}{!Object.values(selected.platformVersions).flat().length && <div className="compact-empty"><h2>没有平台版本</h2><p>平台适配内容会在这里按真实绑定关系显示。</p></div>}</section>}
        {tab === 'assets' && <section className="studio-detail-list">{selected.assets.length ? selected.assets.map((asset) => <article key={asset.id}><span>{asset.mimeType}</span><h3>{asset.relativePath}</h3><p>SHA-256 {asset.sha256}</p><small>{asset.byteCount} bytes{asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}{asset.durationMs ? ` · ${asset.durationMs} ms` : ''} · {asset.origin}</small></article>) : <div className="compact-empty"><h2>没有关联素材</h2><p>只有被平台版本真实引用的素材才会显示。</p></div>}</section>}
        {message && <p className="task-status" data-running={busy ? 'true' : 'false'}>{message}</p>}
      </> : <section className="empty-state editor-empty"><h2>{message ? '项目详情读取失败' : '选择一个内容项目'}</h2><p>{message || '左侧会显示符合当前条件的项目。'}</p>{selectedId && message && <button onClick={() => void loadDetail(selectedId)}>重新读取</button>}</section>}
    </main>
    <aside className="studio-context-v2">
      <div className="studio-context-tabs"><button className={contextTab === 'versions' ? 'active' : ''} onClick={() => setContextTab('versions')}>版本</button><button className={contextTab === 'sources' ? 'active' : ''} onClick={() => setContextTab('sources')}>来源</button><button className={contextTab === 'assets' ? 'active' : ''} onClick={() => setContextTab('assets')}>素材</button></div>
      <div className="studio-context-body">
        {!selected && <p className="studio-panel-title">正在读取项目资料…</p>}
        {selected && contextTab === 'versions' && <><p className="studio-panel-title">版本历史</p>{selected.revisions.map((version) => <button className="studio-context-version" key={version.id} onClick={() => { setTab('versions'); setViewedVersionId(version.id); }}><strong>第 {version.number} 版{version.id === latest?.id ? ' · 最新' : ''}</strong><small>{formatTime(version.createdAt)} · {version.author === 'user' ? '你修改' : 'Pi 创建'}</small></button>)}<div className="studio-context-hint">选择历史版本后进入只读查看，可另存为新版本或复制成新项目。</div><div className="studio-project-controls"><label>长期主题<select aria-label="项目长期主题" value={selected.topicId??''} disabled={busy} onChange={(event)=>void update({topicId:event.target.value||null})}><option value="">未归入主题</option>{topics.map(topic=><option key={topic.id} value={topic.id}>{topic.title}</option>)}</select></label><label>工作状态<select value={selected.status} disabled={busy} onChange={(event) => void update({ status: event.target.value as ContentProjectStatus })}>{statuses.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><button className="secondary-button" disabled={busy} onClick={() => void update({ archived: !selected.archivedAt })}>{selected.archivedAt ? '恢复项目' : '归档项目'}</button><button className="secondary-button" disabled={busy} onClick={() => void writeDraft()}>让 Pi 写初稿</button><button className="secondary-button" disabled={busy} onClick={() => void reload()}>读取最新内容</button></div></>}
        {selected && contextTab === 'sources' && <>{selected.creativeBrief&&<article><strong>{selected.creativeBrief.title}</strong><small>创作简报 · 第 {selected.creativeBrief.revision} 版 · {selected.creativeBrief.contextNodeIds.length} 项证据</small></article>}{selected.sources.length ? selected.sources.map((source) => <article key={source.id}><strong>{source.title}</strong><small>{source.author || '资料来源'}</small></article>) : <p>没有关联来源。</p>}</>}
        {selected && contextTab === 'assets' && (selected.assets.length ? selected.assets.map((asset) => <article key={asset.id}><strong>{asset.relativePath}</strong><small>{asset.mimeType}</small></article>) : <p>没有关联素材。</p>)}
      </div>
    </aside>
    </div>
  </section>;
}
