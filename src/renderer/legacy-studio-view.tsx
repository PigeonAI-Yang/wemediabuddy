import { useEffect, useState } from 'react';
import { platformNames } from './app-types';
import { formatSourcePublishedAt } from './today-library-view';
function formatStudioTime(value?: string | null): string {
  if (!value) return '尚未保存';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatSourcePublishedAt(value) ?? value;
}

function formatStudioAuthor(author?: string | null): string {
  return author === 'user' ? '用户' : 'AI';
}

export function LegacyStudioView({ studio, refresh, openPublish, selectedId, onSelect, planDate }: {
  studio: Awaited<ReturnType<typeof window.wmb.getStudio>>;
  refresh: () => void;
  openPublish: () => void;
  selectedId: string | null;
  onSelect: (projectId: string) => void;
  planDate: string;
}): React.JSX.Element {
  const projects = studio ?? [];
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;
  const [draftStatus, setDraftStatus] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState('');
  const latest = selected?.revisions[0];
  const dirty = Boolean(selected) && (
    titleDraft.trim() !== (selected?.title ?? '').trim()
    || bodyDraft !== (latest?.body ?? '')
  );
  useEffect(() => { if (selected && selected.id !== selectedId) onSelect(selected.id); }, [selected?.id]);
  useEffect(() => {
    setTitleDraft(selected?.title ?? '');
    setBodyDraft(selected?.revisions[0]?.body ?? '');
    setDraftStatus('');
  }, [selected?.id, selected?.title, selected?.revisions[0]?.id, selected?.revisions[0]?.body]);
  const writeDraft = async () => {
    if (!selected || drafting || saving) return;
    setDrafting(true);
    setDraftStatus('Pi 正在写初稿…');
    try {
      const result = await window.wmb.startStudioDraft({ businessDate: planDate, projectId: selected.id }) as {
        ok: boolean;
        data?: { task?: { status?: string; phase?: string; errorMessage?: string | null; resultRefs?: { versionNumber?: number } }; reused?: boolean };
        error?: { message?: string } | null;
      };
      if (!result.ok) {
        setDraftStatus(result.error?.message || '初稿失败');
        return;
      }
      if (result.data?.reused) setDraftStatus('初稿任务已在运行');
      else if (result.data?.task?.phase === 'research_dispatched') setDraftStatus('已派外部研究，完成后将自动续写');
      else if (result.data?.task?.status === 'succeeded') setDraftStatus(`已保存核心版本 v${result.data.task.resultRefs?.versionNumber ?? ''}`.trim());
      else setDraftStatus(result.data?.task?.errorMessage || '初稿已完成');
      refresh();
    } catch (error) {
      setDraftStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDrafting(false);
      window.setTimeout(() => refresh(), 300);
    }
  };
  const saveManual = async () => {
    if (!selected || saving || drafting) return;
    const title = titleDraft.trim();
    const body = bodyDraft;
    if (!title) { setDraftStatus('标题不能为空'); return; }
    if (!body.trim()) { setDraftStatus('正文不能为空'); return; }
    setSaving(true);
    setDraftStatus('正在保存…');
    try {
      const result = await window.wmb.saveStudioCore({ projectId: selected.id, title, body, expectedRevision: selected.revision });
      if (!result.ok) {
        setDraftStatus(result.error?.message || '保存失败');
        return;
      }
      const versionNumber = (result.data as { version?: { versionNumber?: number } } | null)?.version?.versionNumber;
      setDraftStatus('已保存');
      refresh();
    } catch (error) {
      setDraftStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
      window.setTimeout(() => refresh(), 300);
    }
  };
  return <section className="studio-layout">
    <aside className="studio-projects">
      <header><div><span>创作工作区</span><h1>内容项目</h1></div><button className="icon-button" onClick={refresh} aria-label="刷新内容项目">↻</button></header>
      <div className="project-list">{projects.map((project) => <button key={project.id} className={project.id === selected?.id ? 'active' : ''} onClick={() => onSelect(project.id)}><strong>{project.title}</strong><span>核心版本 {project.revisions.length} · 平台版本 {Object.values(project.platforms).flat().length}</span></button>)}</div>
      {!projects.length && <div className="compact-empty"><h2>还没有内容项目</h2><p>从今日首选机会进入创作后，项目会出现在这里。</p></div>}
    </aside>
    <main className="studio-editor">
      {selected ? <>
        <header className="editor-heading">
          <div className="editor-heading-copy">
            <span>核心内容</span>
            <h2>{titleDraft.trim() || selected.title}</h2>
            <p className="editor-meta">
              {latest
                ? <>最近修改 {formatStudioTime(latest.createdAt)} · {formatStudioAuthor(latest.author)}</>
                : '尚未保存核心版本'}
              {dirty ? ' · 有未保存修改' : ''}
            </p>
          </div>
        </header>
        <div className="editor-tabs"><button className="active">核心内容</button>{Object.entries(selected.platforms).map(([platform, versions]) => <button key={platform}>{platformNames[platform]} <span>{versions.length}</span></button>)}</div>
        <section className="writing-surface">
          <label htmlFor="studio-title">标题</label>
          <input
            id="studio-title"
            className="studio-title-input"
            value={titleDraft}
            disabled={drafting || saving}
            onChange={(event) => setTitleDraft(event.target.value)}
            placeholder="输入标题"
          />
          <label htmlFor="studio-body">正文</label>
          <textarea
            id="studio-body"
            className="studio-body-input"
            value={bodyDraft}
            disabled={drafting || saving}
            onChange={(event) => setBodyDraft(event.target.value)}
            placeholder="在这里直接编写或修改正文。保存后会生成新的核心版本。"
          />
        </section>
        {draftStatus && <p className="task-status" data-running={(drafting || saving) ? 'true' : 'false'}>{draftStatus}</p>}
        <footer className="editor-footer">
          <span>{latest ? `最近由${formatStudioAuthor(latest.author)}保存于 ${formatStudioTime(latest.createdAt)}` : '还没有核心版本'}{dirty ? '，有未保存修改' : ''}</span>
          <div className="editor-actions">
            <button className="primary-button" disabled={!dirty || drafting || saving} onClick={() => void saveManual()}>{saving ? '保存中…' : '保存版本'}</button>
            <button className="secondary-button" disabled={drafting || saving} onClick={() => void writeDraft()}>{drafting ? '写作中…' : '让 Pi 写初稿'}</button>
            <button className="secondary-button" disabled={drafting || saving} onClick={refresh}>读取最新内容</button>
          </div>
        </footer>
      </> : <section className="empty-state editor-empty"><h2>选择一个内容项目</h2><p>左侧会显示从今日机会创建的项目。</p></section>}
    </main>
    <aside className="studio-context">
      <section><span className="section-label">创作上下文</span><h2>这一篇为什么值得写</h2><p>项目继承今日方案中的判断和关联资料，创作时始终保留来源链路。</p></section>
      <section><h3>平台版本</h3>{selected ? <><div className="context-list">{Object.entries(selected.platforms).map(([platform, versions]) => <div key={platform}><span>{platformNames[platform]}</span><strong>{versions.length ? `${versions.length} 个版本` : '尚未适配'}</strong></div>)}</div>{selected.platforms.x[0] && <button className="primary-button full-button" onClick={async () => { const result = await window.wmb.prepareXPublication(selected.platforms.x[0].id); if (result.ok) openPublish(); }}>准备发布 X{selected.platforms.x[0].assets.length ? ' 单图' : ' 纯文字'}</button>}{selected.platforms.wechat[0] && <button className="secondary-button full-button" onClick={async () => { const result = await window.wmb.prepareWechatArticlePublication(selected.platforms.wechat[0].id); if (result.ok) openPublish(); }}>准备发布微信</button>}</> : <p className="muted">选择项目后显示平台版本。</p>}</section>
      <section><h3>媒体素材</h3><p className="muted">素材与具体版本绑定。没有真实素材时，这里不会显示占位图片。</p></section>
    </aside>
  </section>;
}
