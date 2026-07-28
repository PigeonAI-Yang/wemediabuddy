import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import { SourceMark } from './source-mark';
import './styles.css';

type View = 'today' | 'library' | 'studio' | 'publish' | 'results' | 'diagnostics' | 'settings';
type Theme = 'dark' | 'light';
type PiContextRef = {
  page: View;
  pageLabel: string;
  objectType: string | null;
  objectId: string | null;
  objectTitle: string | null;
};

const platformNames: Record<string, string> = { x: 'X', xiaohongshu: '小红书', wechat: '微信公众号' };
const formatNames: Record<string, string> = { text: '观点短文', article: '文章', image: '图文', video: '视频', short_video: '口播视频' };
const logoUrl = new URL('../../images/logo.png', import.meta.url).href;

function Icon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, React.JSX.Element> = {
    today: <><path d="M3 5h18v16H3z"/><path d="M7 3v4M17 3v4M3 10h18"/></>,
    library: <><path d="M3 4h7l2 3h9v13H3z"/></>,
    studio: <><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10z"/><path d="m13.5 7 3.5 3.5"/></>,
    publish: <><path d="m3 11 18-8-7 18-3-7z"/><path d="m11 14 10-11"/></>,
    results: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
    diagnosis: <><path d="M12 2v4M5 5l3 3M2 12h4M5 19l3-3M12 22v-4M19 19l-3-3M22 12h-4M19 5l-3 3"/><circle cx="12" cy="12" r="3"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></>
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

function SourceList({ sources, ids, open, close, openLibrary }: { sources: TodaySource[]; ids: string[]; open: boolean; close: () => void; openLibrary: () => void }): React.JSX.Element {
  const selected = ids.map((id) => sources.find((source) => source.id === id)).filter(Boolean) as TodaySource[];
  return <aside className={`sources-panel${open ? ' open' : ''}`} aria-label="关联资料">
    <div className="panel-heading">
      <div><h2>首选机会的关联资料</h2><button className="close-sources" aria-label="关闭关联资料" onClick={close}>×</button></div>
      <p>已保存到终端，可追溯原始来源</p>
    </div>
    <div className="source-list">
      {selected.map((source) => <article className="source-row" key={source.id}>
        <SourceMark canonicalUrl={source.canonicalUrl}/>
        <div>
          <span className="source-type">{source.categories[0] || '入库资料'}</span>
          <h3>{source.title}</h3>
          <p>{source.author || domainOf(source.canonicalUrl) || source.summary || '已入库'}</p>
        </div>
        {source.canonicalUrl && <button className="text-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}
      </article>)}
      {!selected.length && <p className="empty-copy">当前机会没有可展示的关联资料。</p>}
    </div>
    <button className="wide-secondary" onClick={openLibrary}>查看全部入库资料 <span>›</span></button>
  </aside>;
}

function Opportunity({ item, primary, onCreate }: { item: TodayPlanItem; primary?: boolean; onCreate: (item: TodayPlanItem) => void }): React.JSX.Element {
  if (!primary) return <article className="opportunity-small">
    <div className="opportunity-tags"><strong>优先级 {item.priority}</strong><span>{item.timeliness}</span></div>
    <h3>{item.title}</h3>
    <dl><dt>为什么现在值得做</dt><dd>{item.whyNow}</dd><dt>建议表达角度</dt><dd>{item.angle}</dd></dl>
    <footer><span>关联资料 {item.sourceIds.length} 条</span><span>{item.platforms.map((value) => platformNames[value] || value).join('、')}</span><button onClick={() => onCreate(item)}>进入创作</button></footer>
  </article>;
  return <article className="opportunity-primary">
    <div className="opportunity-tags"><strong>优先级 {item.priority}</strong><span>{item.timeliness}</span><span>关联资料 {item.sourceIds.length} 条</span></div>
    <h2>{item.title}</h2>
    <div className="editorial-brief">
      <dl>
        <dt>为什么现在值得做</dt><dd>{item.whyNow}</dd>
        <dt>建议表达角度</dt><dd>{item.angle}</dd>
        <dt>核心观点</dt><dd>{item.pointOfView}</dd>
      </dl>
      <section className="how-to">
        <h3>怎么讲</h3>
        <dl>
          <dt>标题建议</dt><dd>{item.titleGuidance}</dd>
          <dt>开头建议</dt><dd>{item.openingGuidance}</dd>
          <dt>内容结构</dt><dd>{item.structureGuidance}</dd>
        </dl>
      </section>
    </div>
    <footer>
      <div className="meta-line">
        <span>建议平台：{item.platforms.map((value) => platformNames[value] || value).join('、')}</span>
        <span>内容形式：{item.formats.map((value) => formatNames[value] || value).join('、')}</span>
        <span>预计制作：{item.effortEstimate}</span>
      </div>
      <button className="primary-button" onClick={() => onCreate(item)}>就做这个，进入创作</button>
    </footer>
  </article>;
}

function TodayView({ today, refresh, openStudio, openLibrary, onPrimaryChange }: {
  today: Awaited<ReturnType<typeof window.wmb.getToday>>;
  refresh: () => void;
  openStudio: () => void;
  openLibrary: () => void;
  onPrimaryChange: (item: TodayPlanItem | null) => void;
}): React.JSX.Element {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const items = today?.plan?.items ?? [];
  const primary = items[0] ?? null;
  useEffect(() => { onPrimaryChange(primary); }, [primary?.id]);
  const create = async (item: TodayPlanItem) => { await window.wmb.createProjectFromPlanItem(item.id); openStudio(); };
  return <div className="today-layout">
    <section className="today-main">
      <header className="page-heading">
        <div><span>今日内容简报</span><h1>今天有什么值得做？</h1><p>{today?.plan?.summary || '今天还没有选题建议，可以先查看资料库中的内容线索。'}</p></div>
        <div className="heading-actions"><button className="sources-toggle" onClick={() => setSourcesOpen(true)}>查看资料</button><button className="refresh-button" onClick={refresh}>↻ 刷新</button></div>
      </header>
      {primary ? <>
        <Opportunity item={primary} primary onCreate={create}/>
        {items.length > 1 && <section className="other-opportunities"><h2>其他内容机会</h2><div>{items.slice(1, 3).map((item) => <Opportunity key={item.id} item={item} onCreate={create}/>)}</div></section>}
      </> : <section className="empty-state"><h2>今日内容机会还在准备中</h2><p>你可以先浏览已经保存的资料，寻找值得传播、讨论和分享的内容线索。</p><button onClick={openLibrary}>查看资料库</button></section>}
    </section>
    <button className={`drawer-backdrop${sourcesOpen ? ' open' : ''}`} aria-label="关闭关联资料" onClick={() => setSourcesOpen(false)}/>
    <SourceList sources={today?.sources ?? []} ids={primary?.sourceIds ?? []} open={sourcesOpen} close={() => setSourcesOpen(false)} openLibrary={openLibrary}/>
  </div>;
}

function LibraryView({ sources, selectedId, onSelect }: {
  sources: TodaySource[];
  selectedId: string | null;
  onSelect: (source: TodaySource) => void;
}): React.JSX.Element {
  const categories = Array.from(new Set(sources.flatMap((source) => source.categories))).slice(0, 6);
  return <section className="page library-page">
    <header className="page-heading"><div><span>内容资产</span><h1>值得长期使用的资料</h1><p>新闻、产品、工具、Skill 和项目，连同判断与原始来源一起保存。</p></div><div className="stat-summary"><strong>{sources.length}</strong><span>条入库资料</span></div></header>
    <div className="page-toolbar"><div className="filter-row"><button className="filter active">全部</button>{categories.map((category) => <button className="filter" key={category}>{category}</button>)}</div><span>按最新入库排序</span></div>
    {sources.length ? <div className="library-list">{sources.map((source) => <article key={source.id} className={source.id === selectedId ? 'selected' : ''} onClick={() => onSelect(source)}>
      <SourceMark canonicalUrl={source.canonicalUrl}/>
      <div><div className="library-meta"><span>{source.categories[0] || '入库资料'}</span>{source.publishedAt && <time>{source.publishedAt}</time>}</div><h2>{source.title}</h2><p>{source.summary || source.valueJudgment || '这条资料尚未补充摘要。'}</p><small>{source.author || domainOf(source.canonicalUrl) || '本地资料'}</small></div>
      {source.canonicalUrl && <button onClick={(event) => { event.stopPropagation(); void window.wmb.openExternal(source.canonicalUrl!); }}>打开原文 ↗</button>}
    </article>)}</div> : <section className="empty-state library-empty"><h2>资料库暂无内容</h2><p>保存的新闻、工具、项目和案例会集中显示在这里。</p></section>}
  </section>;
}

function StudioView({ studio, refresh, openPublish, selectedId, onSelect }: {
  studio: Awaited<ReturnType<typeof window.wmb.getStudio>>;
  refresh: () => void;
  openPublish: () => void;
  selectedId: string | null;
  onSelect: (projectId: string) => void;
}): React.JSX.Element {
  const projects = studio ?? [];
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;
  useEffect(() => { if (selected && selected.id !== selectedId) onSelect(selected.id); }, [selected?.id]);
  const latest = selected?.revisions[0];
  return <section className="studio-layout">
    <aside className="studio-projects">
      <header><div><span>创作工作区</span><h1>内容项目</h1></div><button className="icon-button" onClick={refresh} aria-label="刷新内容项目">↻</button></header>
      <div className="project-list">{projects.map((project) => <button key={project.id} className={project.id === selected?.id ? 'active' : ''} onClick={() => onSelect(project.id)}><strong>{project.title}</strong><span>核心版本 {project.revisions.length} · 平台版本 {Object.values(project.platforms).flat().length}</span></button>)}</div>
      {!projects.length && <div className="compact-empty"><h2>还没有内容项目</h2><p>从今日首选机会进入创作后，项目会出现在这里。</p></div>}
    </aside>
    <main className="studio-editor">
      {selected ? <><header className="editor-heading"><div><span>核心内容</span><h2>{selected.title}</h2></div><span className="version-chip">{latest ? `v${latest.number}` : '尚无版本'}</span></header>
        <div className="editor-tabs"><button className="active">核心内容</button>{Object.entries(selected.platforms).map(([platform, versions]) => <button key={platform}>{platformNames[platform]} <span>{versions.length}</span></button>)}</div>
        <section className="writing-surface"><label>标题</label><h3>{selected.title}</h3><label>正文</label><p>{latest?.body ?? '这个项目已经建立，但还没有核心内容版本。请让接入的创作助手写入首个版本。'}</p></section>
        <footer className="editor-footer"><span>{latest ? `当前显示核心版本 v${latest.number}` : '等待首个核心版本'}</span><button className="secondary-button" onClick={refresh}>读取最新内容</button></footer>
      </> : <section className="empty-state editor-empty"><h2>选择一个内容项目</h2><p>左侧会显示从今日机会创建的项目。</p></section>}
    </main>
    <aside className="studio-context">
      <section><span className="section-label">创作上下文</span><h2>这一篇为什么值得写</h2><p>项目继承今日方案中的判断和关联资料，创作时始终保留来源链路。</p></section>
      <section><h3>平台版本</h3>{selected ? <><div className="context-list">{Object.entries(selected.platforms).map(([platform, versions]) => <div key={platform}><span>{platformNames[platform]}</span><strong>{versions.length ? `${versions.length} 个版本` : '尚未适配'}</strong></div>)}</div>{selected.platforms.x[0] && <button className="primary-button full-button" onClick={async () => { const result = await window.wmb.prepareXPublication(selected.platforms.x[0].id); if (result.ok) openPublish(); }}>准备发布 X{selected.platforms.x[0].assets.length ? ' 单图' : ' 纯文字'}</button>}{selected.platforms.xiaohongshu[0] && <p className="muted">小红书 AI 操作由指定 MCP 处理，WMB 不再控制其浏览器。</p>}{selected.platforms.wechat[0] && <button className="primary-button full-button" onClick={async () => { const result = await window.wmb.prepareWechatArticlePublication(selected.platforms.wechat[0].id); if (result.ok) openPublish(); }}>准备发布公众号文章</button>}</> : <p className="muted">选择项目后显示平台适配状态。</p>}</section>
      <section><h3>媒体素材</h3><p className="muted">素材与具体版本绑定。没有真实素材时，这里不会显示占位图片。</p></section>
    </aside>
  </section>;
}

function PublishView({ publications, refresh, openStudio, takeover, selectedId, onSelect }: {
  publications: Awaited<ReturnType<typeof window.wmb.getPublications>>;
  refresh: () => void;
  openStudio: () => void;
  takeover: () => void;
  selectedId: string | null;
  onSelect: (publicationId: string) => void;
}): React.JSX.Element {
  const [articleUrl, setArticleUrl] = useState('');
  const selected = publications.find((item) => item.publication.id === selectedId) ?? publications[0] ?? null;
  useEffect(() => { if (selected && selected.publication.id !== selectedId) onSelect(selected.publication.id); }, [selected?.publication.id]);
  const publication = selected?.publication;
  const reconcile = async () => {
    if (!publication) return;
    const reconciled = await window.wmb.reconcileNotPublished(publication.id, publication.revision);
    if (!reconciled.ok) return;
    refresh();
  };
  const readBackWechat = async () => {
    if (!publication || !articleUrl.trim()) return;
    const result = await window.wmb.readBackWechatPublication(publication.id, publication.revision, articleUrl.trim());
    if (result.ok) {
      setArticleUrl('');
      refresh();
    }
  };
  return <section className="workflow-page">
    <header className="page-heading"><div><span>发布工作区</span><h1>确认你真正要发布的内容</h1><p>平台、账号、内容版本和素材必须在一次确认中完全一致。</p></div></header>
    <div className="publish-layout">
      <aside className="workflow-list"><div className="section-heading"><h2>发布任务</h2><span>{publications.length}</span></div>{publications.length ? <div className="publication-list">{publications.map((item) => <button className={item.publication.id === publication?.id ? 'active' : ''} key={item.publication.id} onClick={() => onSelect(item.publication.id)}><strong>{item.payload?.title || item.payload?.body.slice(0, 42) || '尚未准备内容'}</strong><span>{platformNames[item.publication.platform]} · {publicationStatus(item.publication.status)}</span></button>)}</div> : <div className="compact-empty"><h2>还没有发布任务</h2><p>从创作页准备平台版本后会出现在这里。</p><button onClick={openStudio}>回到创作</button></div>}</aside>
      <main className="publish-preview">{selected?.payload ? <article className="final-preview"><span className="section-label">最终内容预览</span>{selected.payload.title && <h2>{selected.payload.title}</h2>}<p>{selected.payload.body}</p><div className="asset-summary">媒体素材 {selected.payload.assets.length} 项</div><section className="timeline"><h3>状态时间线</h3>{selected.events.map((event, index) => <div key={index}><span>{publicationStatus(String(event.to_status))}</span><small>{String(event.reason || '')}</small></div>)}</section></article> : <div className="preview-placeholder"><span>最终内容预览</span><h2>尚未取得编辑器回读</h2><p>准备完成后，这里会原样显示标题、正文和媒体素材。</p></div>}</main>
      <aside className="confirmation-panel"><span className="section-label">人工发布</span><h2>{publication ? publicationStatus(publication.status) : '发布信息尚未就绪'}</h2><dl className="confirmation-list"><dt>平台</dt><dd>{publication ? platformNames[publication.platform] : '未选择'}</dd><dt>账号</dt><dd>{publication?.accountKey || '未识别'}</dd><dt>内容状态</dt><dd>{selected?.payload ? '已准备' : '未绑定'}</dd><dt>媒体素材</dt><dd>{selected?.payload ? `${selected.payload.assets.length} 项` : '未绑定'}</dd></dl><p className="notice">{publication?.platform === 'xiaohongshu' ? '小红书 AI 操作只通过指定 MCP；请在小红书客户端中人工发布。' : 'WMB 不会点击平台的最终发布按钮。请在专用浏览器核对内容并手动发布。'}</p>{publication?.status === 'awaiting_confirmation' && publication.platform !== 'xiaohongshu' && <button className="primary-button" onClick={takeover}>打开浏览器，人工发布</button>}{publication?.status === 'needs_user' && publication.platform !== 'xiaohongshu' && <button className="primary-button" onClick={takeover}>打开浏览器接管</button>}{publication?.platform === 'wechat' && ['awaiting_confirmation', 'needs_user', 'unknown'].includes(publication.status) && <div className="readback-form"><input value={articleUrl} onChange={(event) => setArticleUrl(event.target.value)} placeholder="粘贴已发布的公众号文章链接"/><button className="secondary-button full-button" disabled={!articleUrl.trim()} onClick={readBackWechat}>核对文章并记录结果</button></div>}{publication?.status === 'unknown' && publication.platform !== 'wechat' && <button className="secondary-button full-button" onClick={reconcile}>我已核对，确认未发布</button>}</aside>
    </div>
  </section>;
}

function ResultsView(): React.JSX.Element {
  return <section className="workflow-page">
    <header className="page-heading"><div><span>内容结果</span><h1>什么有效，下一次怎么做</h1><p>只根据真实发布和已采集的网页数据形成复盘。</p></div></header>
    <div className="results-layout">
      <aside className="workflow-list"><div className="section-heading"><h2>已发布内容</h2><span>0</span></div><div className="compact-empty"><h3>还没有可复盘内容</h3><p>取得真实发布地址后，内容会按发布时间显示在这里。</p></div></aside>
      <main className="results-main"><section className="metrics-empty"><span className="section-label">指标快照</span><h2>等待第一条真实发布</h2><p>数据会保留采集时间、来源页面和字段状态。暂不可见的指标不会被写成 0。</p></section><section className="review-grid"><article><span>Keep（保留）</span><p>有证据支持、下一次继续采用的做法。</p></article><article><span>Stop（停止）</span><p>结果表明不应继续投入的做法。</p></article><article><span>Change（改变）</span><p>下一次要明确调整的表达或执行方式。</p></article></section></main>
      <aside className="findings-panel"><span className="section-label">方法结论</span><h2>尚无结论</h2><p>复盘完成后，结论会回流到后续内容方案，并保留原始证据。</p></aside>
    </div>
  </section>;
}

function SettingsView({ dataRoot, settings, browserChoice, setBrowserChoice, refresh }: {
  dataRoot: string | null; settings: Awaited<ReturnType<typeof window.wmb.getSettings>>; browserChoice: string;
  setBrowserChoice: (value: string) => void; refresh: () => void;
}): React.JSX.Element {
  const [piBaseUrl, setPiBaseUrl] = useState(settings?.pi.baseUrl ?? '');
  const [piModel, setPiModel] = useState(settings?.pi.model ?? '');
  const [piApiKey, setPiApiKey] = useState('');
  useEffect(() => { setPiBaseUrl(settings?.pi.baseUrl ?? ''); setPiModel(settings?.pi.model ?? ''); }, [settings?.pi.baseUrl, settings?.pi.model]);
  return <section className="page settings-page"><header className="page-heading"><div><span>本地终端</span><h1>设置</h1><p>管理数据位置、专用浏览器和创作助手连接。</p></div></header>
    <div className="settings-grid"><section className="settings-block"><div><span className="section-label">数据与文件</span><h2>数据目录</h2><p>{dataRoot || '尚未选择数据根目录'}</p></div><button className="secondary-button" onClick={() => void window.wmb.chooseDataRoot().then(refresh)}>选择目录</button></section>
    {settings && <><section className="settings-block browser-setting"><div><span className="section-label">网页发布</span><h2>专用浏览器</h2><p>{settings.browser.status === 'ready' ? `已启动，配置目录：${settings.browser.profilePath}` : '浏览器尚未由本应用启动'}</p></div><div className="setting-actions"><select value={browserChoice} onChange={(event) => setBrowserChoice(event.target.value)}>{settings.browserOptions.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.profileDirectory}</option>)}</select><button className="secondary-button" disabled={!browserChoice} onClick={() => void window.wmb.configureBrowser(browserChoice).then(refresh)}>保存选择</button><button className="primary-button" onClick={() => void window.wmb.startBrowser().then(refresh)}>启动浏览器</button></div></section><section className="settings-block pi-setting"><div><span className="section-label">内置创作助手</span><h2>Pi API</h2><p>{settings.pi.configured ? `已配置 ${settings.pi.model}` : '填写 CPA 或其他 OpenAI-compatible API；不会读取其他 Agent 的登录态。'}</p></div><div className="setting-actions pi-fields"><input value={piBaseUrl} onChange={(event) => setPiBaseUrl(event.target.value)} placeholder="Base URL"/><input value={piModel} onChange={(event) => setPiModel(event.target.value)} placeholder="模型名称"/><input type="password" value={piApiKey} onChange={(event) => setPiApiKey(event.target.value)} placeholder={settings.pi.configured ? 'API Key（留空保持不变）' : 'API Key'}/><button className="primary-button" disabled={!piBaseUrl.trim() || !piModel.trim() || (!settings.pi.configured && !piApiKey.trim())} onClick={() => void window.wmb.savePiConfig({ baseUrl: piBaseUrl, model: piModel, apiKey: piApiKey || undefined }).then(() => { setPiApiKey(''); refresh(); })}>保存 Pi 配置</button></div></section><section className="settings-block"><div><span className="section-label">创作助手</span><h2>本地连接</h2><p>{settings.mcp.url ? '连接地址已经就绪，Pi 和其他创作助手可读取同一份资料与内容。' : '连接尚未启动。'}</p></div><span className={`status-text ${settings.mcp.url ? 'success' : ''}`}>{settings.mcp.url ? '已就绪' : '未启动'}</span></section></>}</div>
  </section>;
}

function PiDock({ collapsed, toggle, configured, context }: {
  collapsed: boolean;
  toggle: () => void;
  configured: boolean;
  context: PiContextRef;
}): React.JSX.Element {
  const contextLabel = context.objectTitle
    ? `${context.pageLabel} · ${context.objectType} · ${context.objectTitle}`
    : context.pageLabel;
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed' }>>([]);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running' | 'failed' | 'stopped'>('idle');
  const [statusText, setStatusText] = useState(configured ? '已配置' : '等待配置');
  useEffect(() => {
    void window.wmb.getPiConversation().then((conversation) => {
      if (conversation.messages.length) setMessages(conversation.messages);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    setStatusText(configured ? (phase === 'idle' ? '已配置' : statusText) : '等待配置');
  }, [configured]);
  useEffect(() => window.wmb.onPiEvent((event) => {
    if (event.type === 'starting') {
      setPhase('starting');
      setStatusText('正在启动');
      return;
    }
    if (event.type === 'running') {
      setPhase('running');
      setStatusText('正在回复');
      return;
    }
    if (event.type === 'delta') {
      setPhase('running');
      setStatusText('正在回复');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { ...last, text: event.text ?? '' };
        else next.push({ role: 'assistant', text: event.text ?? '', status: 'streaming' });
        return next;
      });
      return;
    }
    if (event.type === 'stopped') {
      setPhase('stopped');
      setStatusText('已停止');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        const text = (event.text && event.text.trim()) || last?.text || '已停止生成。';
        if (last?.role === 'assistant') next[next.length - 1] = { role: 'assistant', text, status: 'stopped' };
        else next.push({ role: 'assistant', text, status: 'stopped' });
        return next;
      });
      return;
    }
    if (event.type === 'failed') {
      setPhase('failed');
      setStatusText('失败');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        const text = event.error || 'Pi 回复失败。';
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { role: 'assistant', text, status: 'failed' };
        else next.push({ role: 'assistant', text, status: 'failed' });
        return next;
      });
      return;
    }
    if (event.type === 'idle') {
      setPhase('idle');
      setStatusText(configured ? '已配置' : '等待配置');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'streaming') {
          next[next.length - 1] = { role: 'assistant', text: event.text || last.text };
        }
        return next;
      });
    }
  }), [configured]);
  const busy = phase === 'starting' || phase === 'running';
  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((items) => [...items, { role: 'user', text }, { role: 'assistant', text: '', status: 'streaming' }]);
    setPhase('starting');
    setStatusText('正在启动');
    const prompt = [
      '[WMB_CONTEXT]',
      `page=${context.page}`,
      `pageLabel=${context.pageLabel}`,
      `objectType=${context.objectType ?? ''}`,
      `objectId=${context.objectId ?? ''}`,
      `objectTitle=${context.objectTitle ?? ''}`,
      'instruction=只用上述引用理解当前页面和选中对象，不要假设未提供的正文，不要要求用户重复当前页面。',
      '[USER_MESSAGE]',
      text
    ].join('\n');
    try {
      const result = await window.wmb.chatPi(prompt);
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant') {
          next[next.length - 1] = {
            role: 'assistant',
            text: result.text || (result.stopped ? '已停止生成。' : 'Pi 没有返回文字。'),
            status: result.stopped ? 'stopped' : undefined
          };
        }
        return next;
      });
      setPhase(result.stopped ? 'stopped' : 'idle');
      setStatusText(result.stopped ? '已停止' : (configured ? '已配置' : '等待配置'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { role: 'assistant', text: message, status: 'failed' };
        else next.push({ role: 'assistant', text: message, status: 'failed' });
        return next;
      });
      setPhase('failed');
      setStatusText('失败');
    }
  };
  const stop = async () => {
    if (!busy) return;
    await window.wmb.stopPi();
  };
  return <aside className={`pi-dock${collapsed ? ' collapsed' : ''}`} aria-label="Pi 对话">
    <button className="pi-dock-toggle" onClick={toggle} aria-label={collapsed ? '展开 Pi 对话' : '收起 Pi 对话'} title={collapsed ? '展开 Pi' : '收起 Pi'}>{collapsed ? '‹' : '›'}</button>
    <header><div><strong>Pi</strong><span data-phase={phase}>{statusText}</span></div><small title={contextLabel}>正在查看：{contextLabel}</small></header>
    <div className="pi-conversation">{messages.length ? messages.map((message, index) => <p className={`${message.role}${message.status ? ` ${message.status}` : ''}`} key={index}>{message.text || (message.status === 'streaming' ? '…' : '')}</p>) : <p>{configured ? '现在可以直接和我对话。' : '请先在设置中填写 Pi API。'}</p>}</div>
    <footer>
      <textarea disabled={!configured || busy} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={configured ? (busy ? 'Pi 正在回复…' : phase === 'failed' ? '失败后可以直接重试' : phase === 'stopped' ? '已停止，可以继续发送' : '给 Pi 发消息') : '配置 Pi API 后可以对话'}/>
      {busy
        ? <button className="stop-button" onClick={() => void stop()}>停止</button>
        : <button disabled={!configured || !input.trim()} onClick={() => void send()}>发送</button>}
    </footer>
  </aside>;
}

function App(): React.JSX.Element {
  const [view, setView] = useState<View>('today');
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('wmb.theme') === 'light' ? 'light' : 'dark');
  const [dataRoot, setDataRoot] = useState<string | null>(null);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof window.wmb.getSettings>>>(null);
  const [today, setToday] = useState<Awaited<ReturnType<typeof window.wmb.getToday>>>(null);
  const [studio, setStudio] = useState<Awaited<ReturnType<typeof window.wmb.getStudio>>>(null);
  const [publications, setPublications] = useState<Awaited<ReturnType<typeof window.wmb.getPublications>>>([]);
  const [browserChoice, setBrowserChoice] = useState('');
  const [piDockCollapsed, setPiDockCollapsed] = useState(() => localStorage.getItem('wmb.piDockCollapsed') === 'true');
  const [todayPrimary, setTodayPrimary] = useState<TodayPlanItem | null>(null);
  const [librarySelectedId, setLibrarySelectedId] = useState<string | null>(null);
  const [studioSelectedId, setStudioSelectedId] = useState<string | null>(null);
  const [publishSelectedId, setPublishSelectedId] = useState<string | null>(null);
  const planDate = useMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), []);
  const dateLabel = useMemo(() => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: 'Asia/Shanghai' }).format(new Date()), []);
  const refreshSettings = () => void window.wmb.getSettings().then((value) => { setSettings(value); setBrowserChoice(value?.selectedBrowser?.id ?? value?.browserOptions[0]?.id ?? ''); });
  const refreshToday = () => void window.wmb.getToday(planDate).then(setToday);
  const refreshStudio = () => void window.wmb.getStudio().then(setStudio);
  const refreshPublications = () => void window.wmb.getPublications().then(setPublications);
  useEffect(() => { void window.wmb.getDataRoot().then((root) => setDataRoot(root?.path ?? null)); refreshSettings(); refreshToday(); refreshStudio(); refreshPublications(); const poll = window.setInterval(() => { refreshToday(); refreshStudio(); refreshPublications(); }, 5000); return () => window.clearInterval(poll); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('wmb.theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('wmb.piDockCollapsed', String(piDockCollapsed)); }, [piDockCollapsed]);
  const navigate = (next: View) => { setView(next); if (next === 'studio') refreshStudio(); if (next === 'publish') refreshPublications(); };
  const nav = [{ id: 'today', label: '今日' }, { id: 'studio', label: '创作' }, { id: 'publish', label: '发布' }, { id: 'results', label: '结果' }] as const;
  const pageLabels: Record<View, string> = { today: '今日内容', library: '资料库', studio: '创作', publish: '发布', results: '结果', diagnostics: '系统诊断', settings: '设置' };
  const librarySelected = (today?.sources ?? []).find((source) => source.id === librarySelectedId) ?? null;
  const studioSelected = (studio ?? []).find((project) => project.id === studioSelectedId) ?? (studio ?? [])[0] ?? null;
  const publishSelected = publications.find((item) => item.publication.id === publishSelectedId) ?? publications[0] ?? null;
  const piContext: PiContextRef = (() => {
    if (view === 'today') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: todayPrimary ? 'plan_item' : null,
        objectId: todayPrimary?.id ?? null,
        objectTitle: todayPrimary?.title ?? null
      };
    }
    if (view === 'library') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: librarySelected ? 'source' : null,
        objectId: librarySelected?.id ?? null,
        objectTitle: librarySelected?.title ?? null
      };
    }
    if (view === 'studio') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: studioSelected ? 'project' : null,
        objectId: studioSelected?.id ?? null,
        objectTitle: studioSelected?.title ?? null
      };
    }
    if (view === 'publish') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: publishSelected ? 'publication' : null,
        objectId: publishSelected?.publication.id ?? null,
        objectTitle: publishSelected?.payload?.title || publishSelected?.payload?.body.slice(0, 42) || publishSelected?.publication.id || null
      };
    }
    return { page: view, pageLabel: pageLabels[view], objectType: null, objectId: null, objectTitle: null };
  })();
  return <main className={`app-shell${piDockCollapsed ? ' pi-collapsed' : ' pi-open'}`}>
    <header className="topbar">
      <div className="brand"><img src={logoUrl} alt=""/><strong>WeMediaBuddy</strong></div>
      <time>{dateLabel}</time>
      <div className="titlebar-actions">
        <button aria-label={theme === 'dark' ? '切换到白昼紫罗兰' : '切换到黑夜紫罗兰'} title={theme === 'dark' ? '白昼紫罗兰' : '黑夜紫罗兰'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀' : '☾'}</button>
        <button aria-label="最小化窗口" onClick={() => void window.wmb.windowControl('minimize')}>−</button>
        <button aria-label="最大化或还原窗口" onClick={() => void window.wmb.windowControl('maximize')}>□</button>
        <button className="window-close" aria-label="关闭窗口" onClick={() => void window.wmb.windowControl('close')}>×</button>
      </div>
    </header>
    <aside className="sidebar"><nav><button className={view === 'today' ? 'active' : ''} onClick={() => navigate('today')} title="今日"><Icon name="today"/><span>今日</span></button><button className={view === 'library' ? 'active' : ''} onClick={() => navigate('library')} title="资料库"><Icon name="library"/><span>资料库</span></button>{nav.slice(1).map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)} title={item.label}><Icon name={item.id}/><span>{item.label}</span></button>)}</nav><nav className="sidebar-bottom"><button className={view === 'diagnostics' ? 'active' : ''} onClick={() => navigate('diagnostics')} title="系统诊断"><Icon name="diagnosis"/><span>系统诊断</span></button><button className={view === 'settings' ? 'active' : ''} onClick={() => navigate('settings')} title="设置"><Icon name="settings"/><span>设置</span></button></nav></aside>
    <section className="workspace">
      {view === 'today' && <TodayView today={today} refresh={refreshToday} openStudio={() => navigate('studio')} openLibrary={() => navigate('library')} onPrimaryChange={setTodayPrimary}/>}
      {view === 'library' && <LibraryView sources={today?.sources ?? []} selectedId={librarySelectedId} onSelect={(source) => setLibrarySelectedId(source.id)}/>}
      {view === 'studio' && <StudioView studio={studio} refresh={refreshStudio} openPublish={() => navigate('publish')} selectedId={studioSelectedId} onSelect={setStudioSelectedId}/>}
      {view === 'publish' && <PublishView publications={publications} refresh={refreshPublications} openStudio={() => navigate('studio')} takeover={() => void window.wmb.startBrowser().then(refreshSettings)} selectedId={publishSelectedId} onSelect={setPublishSelectedId}/>}
      {view === 'results' && <ResultsView/>}
      {view === 'settings' && <SettingsView dataRoot={dataRoot} settings={settings} browserChoice={browserChoice} setBrowserChoice={setBrowserChoice} refresh={refreshSettings}/>}
      {view === 'diagnostics' && <section className="page diagnostics-page"><header className="page-heading"><div><span>仅在异常时使用</span><h1>系统诊断</h1><p>检查本地数据、创作助手连接和专用浏览器。</p></div><button className="secondary-button" onClick={() => void window.wmb.openLogs()}>打开日志目录</button></header><div className="diagnostic-list"><article><div><h2>本地数据</h2><p>资料、内容和运行记录的存储状态</p></div><strong>{String(settings?.health.database ?? '未连接')}</strong></article><article><div><h2>创作助手连接</h2><p>外部创作助手能否读取当前终端</p></div><strong>{settings?.mcp.status === 'ready' ? '正常' : settings?.mcp.status ?? '未启动'}</strong></article><article><div><h2>专用浏览器</h2><p>用于登录平台、发布和读取结果</p></div><strong>{settings?.browser.status === 'ready' ? '已连接' : '未启动'}</strong></article></div></section>}
    </section>
    <PiDock collapsed={piDockCollapsed} toggle={() => setPiDockCollapsed((value) => !value)} configured={settings?.pi.configured ?? false} context={piContext}/>
  </main>;
}

function domainOf(value: string | null): string | null {
  if (!value) return null;
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return null; }
}

function publicationStatus(status: string): string {
  return ({ draft: '草稿', prepared: '已准备', awaiting_confirmation: '等待确认', publishing: '正在发布', published: '已发布', failed: '发布失败', needs_user: '需要你处理', unknown: '结果待核对' } as Record<string, string>)[status] || status;
}

createRoot(document.getElementById('root')!).render(<App />);
