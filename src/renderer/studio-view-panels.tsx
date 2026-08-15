import type { ContentProjectDetail, ContentProjectPlatform, ContentProjectStatus, ContentProjectStatusSummary, ContentProjectSummary } from '../main/content';
import type { StudioAnnotation } from '../shared/studio-annotations';
import { AppModal } from './app-modal';
import { PlatformMark } from './platform-mark';
import { formatTime, platformNames, statuses } from './studio-view-helpers';
import { studioPlatformTab, type StudioTab } from './studio-platform-tabs';
import { StudioAnnotationsPanel } from './studio-annotation-layer';

export type StudioAnnotationViewProps = {
  tab: 'annotations' | 'versions';
  setTab: (value: 'annotations' | 'versions') => void;
  openCount: number;
  versionCount: number;
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
};

export function StudioLibraryHeader({ summary, projects, hasMore, status, archived, setStatus, setArchived, creating, onCreate }: {
  summary: ContentProjectStatusSummary | null; projects: ContentProjectSummary[]; hasMore: boolean;
  status?: ContentProjectStatus; archived: boolean; setStatus: (value?: ContentProjectStatus) => void;
  setArchived: (value: boolean) => void; creating?: boolean; onCreate: () => void;
}): React.JSX.Element {
  const actionLine = (() => {
    if (!summary) return '管理长期选题、稿件版本和平台内容。';
    if (summary.total === 0) return summary.archived > 0
      ? `进行中的项目已清空，${summary.archived} 个已归档项目可以恢复。`
      : '还没有创作项目，从「新建创作项目」开始。';
    const attention = [
      summary.byStatus.review ? `${summary.byStatus.review} 个待审` : '',
      summary.byStatus.ready ? `${summary.byStatus.ready} 个待发布` : ''
    ].filter(Boolean);
    const activity = summary.updatedWithin7Days ? `本周更新 ${summary.updatedWithin7Days} 个` : '';
    return [[attention.length ? attention.join(' · ') : activity ? '' : `${summary.total} 个项目`, activity].filter(Boolean).join('，'), '。'].join('');
  })();
  return <section className="page-command" aria-label="创作项目概览">
    <div className="page-command-main">
      <div className="page-command-copy">
        <div className="page-command-title-row">
          <h1>创作项目</h1>
          <p>{actionLine}</p>
        </div>
        <div className="page-command-stats" role="navigation" aria-label="项目状态">
          <button type="button" className={`page-command-stat${!status && !archived ? ' active' : ''}`} onClick={() => { setStatus(undefined); setArchived(false); }}>
            <strong>{summary ? summary.total : `${projects.length}${hasMore ? '+' : ''}`}</strong>
            <span>全部项目</span>
          </button>
          {statuses.filter((item) => item.value !== 'idea').map((item) => (
            <button
              type="button"
              key={item.value}
              className={`page-command-stat${status === item.value && !archived ? ' active' : ''}`}
              onClick={() => { setStatus(item.value); setArchived(false); }}
            >
              <strong>{summary ? summary.byStatus[item.value] : `${projects.filter((project) => project.status === item.value).length}${hasMore ? '+' : ''}`}</strong>
              <span>{item.label}</span>
            </button>
          ))}
          <button type="button" className={`page-command-stat${archived ? ' active' : ''}`} onClick={() => { setStatus(undefined); setArchived(true); }}>
            <strong>{summary ? summary.archived : archived ? projects.length : '—'}</strong>
            <span>已归档</span>
          </button>
        </div>
      </div>
      <div className="page-command-actions">
        <button type="button" className="primary-button" disabled={creating} onClick={onCreate}>新建创作项目</button>
      </div>
    </div>
  </section>;
}

export function StudioEditorTop({ selected, dirty, latestCreatedAt, documentLabel, onBack, onToggleHistory, historyOpen, viewedVersion, editorMode, setEditorMode, busy, save, preparePublication, prepareLabel, prepareDisabled }: {
  selected: ContentProjectDetail | null; dirty: boolean; latestCreatedAt?: string; documentLabel?: string; onBack: () => void; onToggleHistory: () => void; historyOpen: boolean;
  viewedVersion: boolean;
  editorMode: 'rich' | 'source'; setEditorMode: (value: 'rich' | 'source') => void; busy: boolean; save: () => Promise<void>;
  preparePublication?: () => Promise<void>; prepareLabel?: string; prepareDisabled?: boolean;
}): React.JSX.Element {
  return <div className="studio-editor-top"><div className="studio-head-copy">
    <div className="studio-crumbs"><button className="studio-top-back" onClick={onBack}>创作库</button><span className="crumb-sep">/</span><b>{selected?.title ?? '正在读取'}</b></div>
    <span className={`studio-doc-state${dirty ? ' dirty' : ''}`}>{selected ? <>{documentLabel ?? `核心正文 · 第 ${selected.versionCount} 版`} · <b>{dirty ? '有未保存修改' : '已保存'}</b>{selected.creativeBrief && <> · 来自创作简报 <span className="pill violet">简报 v{selected.creativeBrief.revision} 已确认</span></>} · {formatTime(latestCreatedAt ?? selected.updatedAt)}</> : '正在读取项目…'}</span>
  </div><div className="studio-grow"/><button className="secondary-button" onClick={onToggleHistory} aria-expanded={historyOpen} aria-controls="studio-history-modal-dialog">版本</button>
  {!viewedVersion ? <div className="studio-mode-switch" role="group" aria-label="编辑模式"><button type="button" className={editorMode === 'source' ? 'active' : ''} onClick={() => setEditorMode('source')}>源码</button><button type="button" className={editorMode === 'rich' ? 'active' : ''} onClick={() => setEditorMode('rich')}>渲染编辑</button></div> : null}
  {preparePublication && <button className="secondary-button" disabled={busy || prepareDisabled} onClick={() => void preparePublication()}>{prepareLabel ?? '准备发布'}</button>}
  <button className="primary-button" disabled={!selected || busy || viewedVersion} onClick={() => void save()} title={viewedVersion ? '历史版本只读，请返回最新版后再保存' : dirty ? '保存当前修改' : '内容未改动'}>保存</button></div>;
}

export function StudioOutline({ outline, tab, setTab, platformVersions, onJumpToStart, onJumpToHeading }: {
  outline: Array<{ level: number; title: string; index: number }>; tab: StudioTab; setTab: (value: StudioTab) => void;
  platformVersions: ContentProjectDetail['platformVersions'];
  onJumpToStart?: () => void;
  onJumpToHeading?: (item: { level: number; title: string; index: number }) => void;
}): React.JSX.Element {
  return <aside className="studio-outline">
    <section className="studio-outline-section studio-outline-section--outline" aria-label="文章纲要">
      <p className="studio-panel-title">文章纲要</p>
      <button type="button" onClick={() => { setTab('core'); onJumpToStart?.(); }}>开头</button>
      {outline.map((item) => <button
        type="button"
        key={`${item.index}-${item.title}`}
        className={item.level >= 3 ? 'sub' : ''}
        title={item.title}
        onClick={() => { setTab('core'); onJumpToHeading?.(item); }}
      >{item.title}</button>)}
      {!outline.length && <p>标题会显示在这里。</p>}
    </section>
    <section className="studio-outline-section studio-outline-section--content" aria-label="内容版本">
      <p className="studio-panel-title platform-title">平台内容</p>
      <button type="button" className={`studio-core-button${tab === 'core' ? ' active' : ''}`} onClick={() => setTab('core')}><span className="pf-tag core"><i className="studio-core-mark" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M4 2.5h5.25L12 5.25v8.25H4z"/><path d="M9 2.5v3h3M6 8h4M6 10.5h4"/></svg></i>核心正文</span></button>
      {Object.entries(platformVersions).map(([platform, versions]) => {
        const platformTab = studioPlatformTab(platform as ContentProjectPlatform);
        return <button type="button" className={tab === platformTab ? 'active' : ''} key={platform} onClick={() => setTab(platformTab)}><span className={`pf-tag ${platform}`}><PlatformMark platform={platform}/>{platformNames[platform]}</span> <small>{versions.length ? `${versions.length} 个版本` : '未创建'}</small><i className="st-dot" data-state={versions.length ? 'ready' : 'none'} aria-hidden="true"/></button>;
      })}
    </section>
  </aside>;
}

export function StudioFormatBar({ busy, execRich, formatSelection, insertMarkdown, insertImageFile, toggleFind, onMarkSelection, canMark }: {
  busy: boolean; execRich: (command: string, value?: string) => void; formatSelection: (before: string, after?: string, placeholder?: string) => void;
  insertMarkdown: (value: string) => void; insertImageFile: (file?: File) => Promise<void>; toggleFind: () => void;
  onMarkSelection?: () => void; canMark?: boolean;
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
      {onMarkSelection && <button type="button" title="把所选文字标记为有问题" aria-label="标记所选文字为有问题" disabled={!canMark} onClick={onMarkSelection}>标记</button>}
    </span>
  </div>;
}

export function StudioHistoryModal({ open, selected, setTab, setViewedVersionId, latestId, activePlatform, selectedPlatformVersionId, setSelectedPlatformVersionId, annotationView, onRequestClose }: {
  open: boolean;
  selected: ContentProjectDetail | null;
  setTab: (value: StudioTab) => void;
  setViewedVersionId: (value: string) => void; latestId?: string;
  activePlatform?: ContentProjectPlatform | null;
  selectedPlatformVersionId?: string | null;
  setSelectedPlatformVersionId?: (value: string) => void;
  annotationView: StudioAnnotationViewProps;
  onRequestClose: () => void;
}): React.JSX.Element {
  const platformVersions = activePlatform && selected ? selected.platformVersions[activePlatform] ?? [] : [];
  const showAnnotations = annotationView.tab === 'annotations';
  return <AppModal
    open={open}
    title="创作记录"
    size="large"
    className="studio-history-modal"
    ariaDescription="版本历史与批注"
    testId="studio-history-modal"
    onRequestClose={onRequestClose}
  >
    <div className="studio-history-tabs" role="tablist" aria-label="创作记录">
      <button type="button" role="tab" aria-selected={showAnnotations} className={showAnnotations ? 'active' : ''} onClick={() => annotationView.setTab('annotations')}>批注 {annotationView.openCount}</button>
      <button type="button" role="tab" aria-selected={!showAnnotations} className={!showAnnotations ? 'active' : ''} onClick={() => annotationView.setTab('versions')}>版本 {annotationView.versionCount}</button>
    </div>
    <div className="studio-history-body">
      {showAnnotations && <StudioAnnotationsPanel
        rows={annotationView.rows}
        loading={annotationView.loading}
        error={annotationView.error}
        onRetry={annotationView.onRetry}
        selectedId={annotationView.selectedId}
        onSelectCard={annotationView.onSelectCard}
        onLocate={annotationView.onLocate}
        onEditNote={annotationView.onEditNote}
        onRemove={annotationView.onRemove}
        onReopen={annotationView.onReopen}
        onDiscussPi={annotationView.onDiscussPi}
        busy={annotationView.busy}
      />}
      {!showAnnotations && <>
        {!selected && <p className="studio-panel-title">正在读取项目…</p>}
        {selected && activePlatform && <>
          <p className="studio-panel-title">{platformNames[activePlatform]}版本</p>
          {platformVersions.map((version, index) => (
            <button type="button" className={`studio-history-version${(selectedPlatformVersionId ?? platformVersions[0]?.id) === version.id ? ' active' : ''}`} key={version.id} onClick={() => { setSelectedPlatformVersionId?.(version.id); onRequestClose(); }}>
              <strong>{version.title || `平台版本 ${version.id.slice(0, 8)}`}{index === 0 ? ' · 最新' : ''}</strong>
              <small>版本 {version.revision} · {formatTime(version.updatedAt)} · 绑定核心第 {selected.revisions.find((item) => item.id === version.contentVersionId)?.number ?? version.contentVersionId} 版</small>
            </button>
          ))}
          {!platformVersions.length && <div className="studio-history-hint">尚无平台版本；在中央编辑器输入正文并保存即可创建首版。</div>}
          {!!platformVersions.length && <div className="studio-history-hint">点击任一平台版本，在中央编辑器继续修改。</div>}
        </>}
        {selected && !activePlatform && <>
          <p className="studio-panel-title">版本历史</p>
          {selected.revisions.map((version) => (
            <button type="button" className="studio-history-version" key={version.id} onClick={() => { setTab('versions'); setViewedVersionId(version.id); onRequestClose(); }}>
              <strong>第 {version.number} 版{version.id === latestId ? ' · 最新' : ''}</strong>
              <small>{formatTime(version.createdAt)} · {version.author === 'user' ? '你修改' : 'Pi 创建'}</small>
            </button>
          ))}
          <div className="studio-history-hint">点版本进入只读查看。关联来源与素材在底部状态条，可点击跳转。</div>
        </>}
      </>}
    </div>
  </AppModal>;
}
