import { useEffect, useState } from 'react';
import { platformNames } from './app-types';
import { PlatformMark } from './platform-mark';
export function PublishView({ publications, refresh, openStudio, onEditProject, takeover, selectedId, onSelect, settings, enabledPlatforms }: {
  publications: Awaited<ReturnType<typeof window.wmb.getPublications>>;
  refresh: () => void;
  openStudio: () => void;
  onEditProject: (projectId: string) => void;
  takeover: () => void;
  selectedId: string | null;
  onSelect: (publicationId: string) => void;
  settings: Awaited<ReturnType<typeof window.wmb.getSettings>>;
  enabledPlatforms: Array<'x' | 'xiaohongshu' | 'wechat'>;
}): React.JSX.Element {
  const [articleUrl, setArticleUrl] = useState('');
  const selected = publications.find((item) => item.publication.id === selectedId) ?? publications[0] ?? null;
  useEffect(() => { if (selected && selected.publication.id !== selectedId) onSelect(selected.publication.id); }, [selected?.publication.id]);
  const publication = selected?.publication;
  const platformEnabled = publication ? enabledPlatforms.includes(publication.platform) : false;
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
  const awaitingCount = publications.filter((item) => item.publication.status === 'awaiting_confirmation').length;
  const delivered = publications
    .filter((item) => item.publication.id !== publication?.id)
    .sort((a, b) => (b.publication.status === 'published' ? 1 : 0) - (a.publication.status === 'published' ? 1 : 0));
  const accountMap = new Map<string, { platform: string; accountKey: string; statuses: string[] }>();
  for (const item of publications) {
    const key = `${item.publication.platform}:${item.publication.accountKey}`;
    const entry = accountMap.get(key) ?? { platform: item.publication.platform, accountKey: item.publication.accountKey, statuses: [] };
    entry.statuses.push(item.publication.status);
    accountMap.set(key, entry);
  }
  const accounts = [...accountMap.values()].slice(0, 4);
  const accountHealth = (statuses: string[]) => statuses.includes('awaiting_confirmation') || statuses.includes('needs_user') ? 'warn' : statuses.includes('published') ? 'ok' : 'off';
  const browserReady = settings?.browser.status === 'ready';
  const mcpReady = settings?.mcp.status === 'ready';
  return <section className="workflow-page publish-page">
    <div className="publish-layout">
      <main className="publish-preview">
      {!publications.length && <div className="compact-empty"><h2>还没有发布任务</h2><p>从创作页准备平台版本后会出现在这里。</p><button onClick={openStudio}>回到创作</button></div>}
      <p className="eyebrow preview-eyebrow">{publication?.status === 'awaiting_confirmation' ? `待确认 · ${awaitingCount}` : publication?.status === 'published' ? '已交付' : '当前任务'}</p>
      {selected?.payload ? <article className={`pub-card${publication?.status === 'awaiting_confirmation' ? ' awaiting' : ''}`}>
        <div className="pub-head">
          <span className={`pf-tag ${publication?.platform}`}><PlatformMark platform={publication?.platform}/>{platformNames[publication?.platform ?? ''] ?? publication?.platform}</span>
          <div className="pub-head-text">
            <div className="pub-title-line">{selected.payload.title || selected.payload.body.slice(0, 42)}</div>
            <div className="pub-sub">rev {publication?.revision} · 绑定 {selected.payload.assets.length} 项素材</div>
          </div>
          <span className={`pill-status ${publication?.status === 'awaiting_confirmation' ? 'amber' : publication?.status === 'published' ? 'green' : 'gray'}`}><span className="dot"/>{publication ? publicationStatus(publication.status) : ''}</span>
        </div>
        <div className="pub-body">
          <div className="pub-payload">{selected.payload.body}</div>
          {selected.payload.assets.length > 0 && <div className="pub-assets">{selected.payload.assets.map((asset) => <div className="asset-thumb" key={asset.id}><span>{asset.mimeType}</span><span className="num">SHA {asset.sha256.slice(0, 4)}…</span></div>)}</div>}
        </div>
        <div className="pub-foot">
          <span className="pub-account">账号身份已核对：<b>{publication?.accountKey || '未识别'}</b></span>
          {platformEnabled && publication?.status === 'awaiting_confirmation' && publication.platform !== 'xiaohongshu' && <><button className="secondary-button" onClick={() => onEditProject(publication.projectId)}>继续编辑</button><button className="primary-button" onClick={takeover}>我已核对，去平台发布</button></>}
          {platformEnabled && publication?.status === 'needs_user' && publication.platform !== 'xiaohongshu' && <button className="primary-button" onClick={takeover}>打开浏览器接管</button>}
          {platformEnabled && publication?.status === 'unknown' && publication.platform !== 'wechat' && <button className="secondary-button" onClick={reconcile}>我已核对，确认未发布</button>}
        </div>
        <section className="timeline"><h3>状态时间线</h3>{selected.events.map((event, index) => <div className="tl-item" key={index}><span className={`tl-dot ${timelineDot(String(event.to_status))}`}/><div className="tl-text"><b>{publicationStatus(String(event.to_status))}</b><span className="faint">{event.created_at ? `${new Date(String(event.created_at)).toLocaleString('zh-CN')} · ` : ''}{String(event.reason || '')}</span></div></div>)}</section>
      </article> : <div className="preview-placeholder"><span>最终内容预览</span><h2>尚未取得编辑器回读</h2><p>准备完成后，这里会原样显示标题、正文和媒体素材。</p></div>}
      {delivered.length > 0 && <>
        <p className="eyebrow delivered-title">已交付 · 最近</p>
        {delivered.map((item) => <article className={`pub-card pub-card-compact${item.publication.id === publication?.id ? ' selected' : ''}`} key={item.publication.id} onClick={() => onSelect(item.publication.id)}>
          <div className="pub-head">
            <span className={`pf-tag ${item.publication.platform}`}><PlatformMark platform={item.publication.platform}/>{platformNames[item.publication.platform]}</span>
            <div className="pub-head-text">
              <div className="pub-title-line">{item.payload?.title || item.payload?.body.slice(0, 42) || '尚未准备内容'}</div>
              <div className="pub-sub">{item.publication.publishedAt ? `${new Date(item.publication.publishedAt).toLocaleString('zh-CN')} 人工发布` : publicationStatus(item.publication.status)}{item.publication.externalUrl ? ` · ${item.publication.externalUrl}` : ''}</div>
            </div>
            <span className={`pill-status ${item.publication.status === 'published' ? 'green' : item.publication.status === 'awaiting_confirmation' ? 'amber' : 'gray'}`}><span className="dot"/>{publicationStatus(item.publication.status)}</span>
          </div>
        </article>)}
      </>}
      </main>
      <aside className="confirmation-panel" data-state={publication?.status ?? 'none'}>
        <p className="eyebrow">平台账号</p>
        {accounts.length ? accounts.map((account) => {
          const current = publication && account.platform === publication.platform && account.accountKey === publication.accountKey;
          return <div className={`account-card${current ? ' current' : ''}`} key={`${account.platform}:${account.accountKey}`}>
            <span className={`account-avatar pf-${account.platform}`}><PlatformMark platform={account.platform}/></span>
            <div className="account-card-text"><b>{account.accountKey || '未识别'}</b><small>{platformNames[account.platform]}{current ? ` · ${publication ? publicationStatus(publication.status) : ''}` : ''}</small></div>
            <span className={`health-dot ${accountHealth(account.statuses)}`}/>
          </div>;
        }) : <div className="rail-empty">尚未识别平台账号</div>}
        <p className="eyebrow rail-section">执行环境</p>
        <div className="env-list">
          <div className="env-row"><div className="env-text"><b>专用浏览器</b><small>{browserReady ? '已由本应用启动' : '浏览器未启动'}</small></div><span className={`pill-status ${browserReady ? 'green' : 'gray'}`}><span className="dot"/>{browserReady ? '已连接' : '未启动'}</span></div>
          <div className="env-row"><div className="env-text"><b>MCP 服务</b><small>{mcpReady ? settings?.mcp.url ?? '仅本机' : '本地服务未启动'}</small></div><span className={`pill-status ${mcpReady ? 'green' : 'gray'}`}><span className="dot"/>{mcpReady ? '运行中' : '未启动'}</span></div>
        </div>
        {!platformEnabled && publication && <p className="notice">当前工作空间未启用该发布平台，仅保留历史记录。</p>}
        {platformEnabled && publication?.platform === 'xiaohongshu' && <p className="notice">请在小红书客户端中人工发布。</p>}
        {platformEnabled && publication?.platform === 'wechat' && ['awaiting_confirmation', 'needs_user', 'unknown'].includes(publication.status) && <div className="readback-form"><input value={articleUrl} onChange={(event) => setArticleUrl(event.target.value)} placeholder="粘贴已发布的公众号文章链接"/><button className="secondary-button full-button" disabled={!articleUrl.trim()} onClick={readBackWechat}>核对文章并记录结果</button></div>}
      </aside>
    </div>
  </section>;
}

function publicationStatus(status: string): string {
  return ({ prepared: '已准备', awaiting_confirmation: '等待人工发布', published: '已发布', failed: '失败', needs_user: '需要接管', unknown: '待对账' } as Record<string, string>)[status] || status;
}

function timelineDot(status: string): string {
  if (status === 'published' || status === 'prepared') return 'ok';
  if (status === 'awaiting_confirmation' || status === 'needs_user') return 'wait';
  if (status === 'failed' || status === 'unknown') return 'err';
  return 'idle';
}
