import type { ContentProjectDetail, ContentProjectStatus, ContentProjectStatusSummary, ContentProjectSummary } from '../main/content';
import { PlatformMark } from './platform-mark';
import { formatTime, platformNames, statuses } from './studio-view-helpers';

export function StudioLibraryHeader({ summary, projects, hasMore, status, archived, setStatus, setArchived, onCreate }: {
  summary: ContentProjectStatusSummary | null; projects: ContentProjectSummary[]; hasMore: boolean;
  status?: ContentProjectStatus; archived: boolean; setStatus: (value?: ContentProjectStatus) => void;
  setArchived: (value: boolean) => void; onCreate: () => void;
}): React.JSX.Element {
  const actionLine = (() => {
    if (!summary) return '管理长期选题、稿件版本和平台内容。';
    if (summary.total === 0) return summary.archived > 0
      ? `进行中的项目已清空，${summary.archived} 个已归档项目可以恢复。`
      : '还没有创作项目，从「新建创作项目」开始。';
    const attention = [
      summary.byStatus.review ? `${summary.byStatus.review} 个待审` : '',
      summary.byStatus.ready ? `${summary.byStatus.ready} 个待发布` : '',
      summary.byStatus.drafting ? `${summary.byStatus.drafting} 个创作中` : ''
    ].filter(Boolean);
    const activity = summary.updatedWithin7Days ? `本周更新 ${summary.updatedWithin7Days} 个` : '';
    return [[attention.length ? attention.join(' · ') : `${summary.total} 个项目`, activity].filter(Boolean).join('，'), '。'].join('');
  })();
  return <><header className="studio-library-heading">
    <div><h1>创作项目</h1><p>{actionLine}</p></div>
    <button className="primary-button" onClick={onCreate}>新建创作项目</button>
  </header><nav className="studio-library-summary" aria-label="项目状态">
    <button className={!status && !archived ? 'active' : ''} onClick={() => { setStatus(undefined); setArchived(false); }}><strong>{summary ? summary.total : `${projects.length}${hasMore ? '+' : ''}`}</strong><span>全部项目</span></button>
    {statuses.filter((item) => item.value !== 'idea').map((item) => <button key={item.value} className={status === item.value && !archived ? 'active' : ''} onClick={() => { setStatus(item.value); setArchived(false); }}><strong>{summary ? summary.byStatus[item.value] : `${projects.filter((project) => project.status === item.value).length}${hasMore ? '+' : ''}`}</strong><span>{item.label}</span></button>)}
    <button className={archived ? 'active' : ''} onClick={() => { setStatus(undefined); setArchived(true); }}><strong>{summary ? summary.archived : archived ? projects.length : '—'}</strong><span>已归档</span></button>
  </nav></>;
}

export function StudioEditorTop({ selected, dirty, latestCreatedAt, onBack, toggleContext, preview, setPreview, viewedVersion, editorMode, setEditorMode, busy, save }: {
  selected: ContentProjectDetail | null; dirty: boolean; latestCreatedAt?: string; onBack: () => void; toggleContext: () => void;
  preview: boolean; setPreview: (value: boolean | ((current: boolean) => boolean)) => void; viewedVersion: boolean;
  editorMode: 'rich' | 'source'; setEditorMode: (value: 'rich' | 'source') => void; busy: boolean; save: () => Promise<void>;
}): React.JSX.Element {
  return <div className="studio-editor-top"><div className="studio-head-copy">
    <div className="studio-crumbs"><button className="studio-top-back" onClick={onBack}>创作 / 项目库</button><span className="crumb-sep">/</span><b>{selected?.title ?? '正在读取'}</b></div>
    <span className={`studio-doc-state${dirty ? ' dirty' : ''}`}>{selected ? <>第 {selected.versionCount} 版 · <b>{dirty ? '有未保存修改' : '已保存'}</b>{selected.creativeBrief && <> · 来自创作简报 <span className="pill violet">简报 v{selected.creativeBrief.revision} 已确认</span></>} · {formatTime(latestCreatedAt ?? selected.updatedAt)}</> : '正在读取项目…'}</span>
  </div><div className="studio-grow"/><button className="secondary-button" onClick={toggleContext}>项目资料</button>
  {!preview && !viewedVersion ? <div className="studio-mode-switch" role="group" aria-label="编辑模式"><button type="button" className={editorMode === 'source' ? 'active' : ''} onClick={() => setEditorMode('source')}>源码</button><button type="button" className={editorMode === 'rich' ? 'active' : ''} onClick={() => setEditorMode('rich')}>渲染编辑</button></div> : null}
  <button className="secondary-button" onClick={() => setPreview((value) => !value)}>{preview ? '继续编辑' : '预览'}</button>
  <button className="primary-button" disabled={!selected || busy || viewedVersion || preview} onClick={() => void save()} title={viewedVersion ? '历史版本只读，请返回最新版后再保存' : preview ? '预览模式下不能保存' : dirty ? '保存当前修改' : '内容未改动'}>保存</button></div>;
}

export function StudioOutline({ outline, tab, setTab, platformVersions }: {
  outline: Array<{ level: number; title: string; index: number }>; tab: string; setTab: (value: 'core' | 'platforms') => void;
  platformVersions: ContentProjectDetail['platformVersions'];
}): React.JSX.Element {
  return <aside className="studio-outline"><p className="studio-panel-title">文章纲要</p><button className="active">开头</button>
    {outline.map((item) => <button key={`${item.index}-${item.title}`} className={item.level >= 3 ? 'sub' : ''}>{item.title}</button>)}
    {!outline.length && <p>标题会显示在这里。</p>}<p className="studio-panel-title platform-title">平台内容</p>
    <button className={tab === 'core' ? 'active' : ''} onClick={() => setTab('core')}>核心正文</button>
    {Object.entries(platformVersions).map(([platform, versions]) => <button key={platform} onClick={() => setTab('platforms')}><span className={`pf-tag ${platform}`}><PlatformMark platform={platform}/>{platformNames[platform]}</span> <small>{versions.length ? `${versions.length} 个版本` : '未创建'}</small><i className="st-dot" data-state={versions.length ? 'ready' : 'none'} aria-hidden="true"/></button>)}
  </aside>;
}

export function StudioFormatBar({ busy, execRich, formatSelection, insertMarkdown, insertImageFile, toggleFind }: {
  busy: boolean; execRich: (command: string, value?: string) => void; formatSelection: (before: string, after?: string, placeholder?: string) => void;
  insertMarkdown: (value: string) => void; insertImageFile: (file?: File) => Promise<void>; toggleFind: () => void;
}): React.JSX.Element {
  return <div className="studio-formatbar" role="toolbar" aria-label="正文格式" onMouseDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
    <span className="studio-formatbar-group" role="group" aria-label="段落">
      <select aria-label="段落格式" defaultValue="p" onChange={(event) => execRich('formatBlock', event.target.value)}><option value="p">正文</option><option value="h2">二级标题</option><option value="h3">三级标题</option><option value="blockquote">引用</option></select>
    </span>
    <span className="studio-divider"/>
    <span className="studio-formatbar-group" role="group" aria-label="行内格式">
      <button type="button" title="粗体" aria-label="粗体" onClick={() => execRich('bold')}><strong>B</strong></button>
      <button type="button" title="斜体" aria-label="斜体" onClick={() => execRich('italic')}><em>I</em></button>
      <button type="button" title="删除线" aria-label="删除线" onClick={() => formatSelection('~~')}>S</button>
      <button type="button" title="行内代码" aria-label="行内代码" onClick={() => formatSelection('`')}>{'<>'}</button>
    </span>
    <span className="studio-divider"/>
    <span className="studio-formatbar-group" role="group" aria-label="列表">
      <button type="button" title="无序列表" onClick={() => execRich('insertUnorderedList')}>• 列表</button>
      <button type="button" title="有序列表" onClick={() => execRich('insertOrderedList')}>1. 列表</button>
    </span>
    <span className="studio-divider"/>
    <span className="studio-formatbar-group" role="group" aria-label="插入">
      <button type="button" title="插入链接" onClick={() => formatSelection('[', '](https://)', '链接文字')}>链接</button>
      <button type="button" title="插入代码块" onClick={() => insertMarkdown('\n```\n代码\n```\n')}>代码块</button>
      <button type="button" title="插入表格" onClick={() => insertMarkdown('\n| 列1 | 列2 |\n| --- | --- |\n| A | B |\n')}>表格</button>
      <button type="button" title="插入分割线" onClick={() => insertMarkdown('\n---\n')}>分割线</button>
      <button type="button" title="插入图片" disabled={busy} onClick={() => void insertImageFile()}>图片</button>
    </span>
    <span className="studio-divider"/>
    <span className="studio-formatbar-group" role="group" aria-label="编辑">
      <button type="button" title="清除格式" onClick={() => execRich('removeFormat')}>清除</button>
      <button type="button" title="撤销" aria-label="撤销" onClick={() => execRich('undo')}>↶</button>
      <button type="button" title="重做" aria-label="重做" onClick={() => execRich('redo')}>↷</button>
      <button type="button" title="查找替换" onClick={toggleFind}>查找替换</button>
    </span>
  </div>;
}

export function StudioContext({ selected, contextTab, setContextTab, setTab, setViewedVersionId, latestId, busy, update, topics, writeDraft, reload }: {
  selected: ContentProjectDetail | null; contextTab: 'versions' | 'sources' | 'assets';
  setContextTab: (value: 'versions' | 'sources' | 'assets') => void; setTab: (value: 'versions') => void;
  setViewedVersionId: (value: string) => void; latestId?: string; busy: boolean; topics: Array<{ id: string; title: string }>;
  update: (change: { status?: ContentProjectDetail['status']; archived?: boolean; topicId?: string | null }) => Promise<void>;
  writeDraft: () => Promise<void>; reload: () => Promise<void>;
}): React.JSX.Element {
  return <aside className="studio-context-v2"><div className="studio-context-tabs"><button className={contextTab === 'versions' ? 'active' : ''} onClick={() => setContextTab('versions')}>版本</button><button className={contextTab === 'sources' ? 'active' : ''} onClick={() => setContextTab('sources')}>来源</button><button className={contextTab === 'assets' ? 'active' : ''} onClick={() => setContextTab('assets')}>素材</button></div><div className="studio-context-body">
    {!selected && <p className="studio-panel-title">正在读取项目资料…</p>}
    {selected && contextTab === 'versions' && <><p className="studio-panel-title">版本历史</p>{selected.revisions.map((version) => <button className="studio-context-version" key={version.id} onClick={() => { setTab('versions'); setViewedVersionId(version.id); }}><strong>第 {version.number} 版{version.id === latestId ? ' · 最新' : ''}</strong><small>{formatTime(version.createdAt)} · {version.author === 'user' ? '你修改' : 'Pi 创建'}</small></button>)}<div className="studio-context-hint">选择历史版本后进入只读查看，可另存为新版本或复制成新项目。</div><div className="studio-project-controls"><label>长期主题<select aria-label="项目长期主题" value={selected.topicId ?? ''} disabled={busy} onChange={(event) => void update({ topicId: event.target.value || null })}><option value="">未归入主题</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}</select></label><label>工作状态<select value={selected.status} disabled={busy} onChange={(event) => void update({ status: event.target.value as ContentProjectDetail['status'] })}>{statuses.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><button className="secondary-button" disabled={busy} onClick={() => void update({ archived: !selected.archivedAt })}>{selected.archivedAt ? '恢复项目' : '归档项目'}</button><button className="secondary-button" disabled={busy} onClick={() => void writeDraft()}>让 Pi 写初稿</button><button className="secondary-button" disabled={busy} onClick={() => void reload()}>读取最新内容</button></div></>}
    {selected && contextTab === 'sources' && <>{selected.creativeBrief && <article><strong>{selected.creativeBrief.title}</strong><small>创作简报 · 第 {selected.creativeBrief.revision} 版 · {selected.creativeBrief.contextNodeIds.length} 项证据</small></article>}{selected.sources.length ? selected.sources.map((source) => <article key={source.id}><strong>{source.title}</strong><small>{source.author || '资料来源'}</small></article>) : <p>没有关联来源。</p>}</>}
    {selected && contextTab === 'assets' && (selected.assets.length ? selected.assets.map((asset) => <article key={asset.id}><strong>{asset.relativePath}</strong><small>{asset.mimeType}</small></article>) : <p>没有关联素材。</p>)}
  </div></aside>;
}
