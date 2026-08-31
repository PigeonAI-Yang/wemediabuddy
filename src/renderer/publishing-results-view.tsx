import { useEffect, useMemo, useState } from 'react';
import { platformNames } from './app-types';
import { PlatformMark } from './platform-mark';
import { AppModal } from './app-modal';
import type { PublicationBrowserOperationV1, PublicationSnapshotV1 } from '../main/publication-operations';
import type { WmbSettingsSnapshot } from './wmb-settings-types';

/** 发布列表单项：与 global.d.ts `wmb.getPublications` 返回项同构的真实持久化行投影。 */
type PublicationItem = {
  publication: {
    id: string;
    platformVersionId: string;
    platform: 'x' | 'xiaohongshu' | 'wechat' | 'zhihu';
    accountKey: string;
    status: string;
    revision: number;
    externalUrl: string | null;
    externalId: string | null;
    publishedAt: string | null;
    projectId: string;
    format: string | null;
  };
  payload: { title: string | null; body: string; assets: Array<{ id: string; sha256: string; relativePath: string; mimeType: string }>; editorEvidenceUrl?: string } | null;
  snapshot?: PublicationSnapshotV1;
  operation?: PublicationBrowserOperationV1;
  attempts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  reconciliations: Array<Record<string, unknown>>;
};
type PublishTab = 'board' | 'todo' | 'history';

const PLATFORM_ORDER: Array<'x' | 'xiaohongshu' | 'wechat' | 'zhihu'> = ['x', 'xiaohongshu', 'wechat', 'zhihu'];

/** 需要人类介入的运行状态：待授权 / 等待人工发布 / 接管 / 对账 / 失败可重试。 */
function attentionOf(item: PublicationItem): boolean {
  const operationState = item.operation?.state ?? '';
  const status = item.publication.status;
  return ['prepared', 'execution_granted', 'browser_leased', 'executing', 'readback_pending', 'needs_user', 'unknown', 'failed'].includes(operationState)
    || ['awaiting_confirmation', 'needs_user', 'unknown', 'failed'].includes(status);
}

/** 单元/任务行的运行态：operation 未过期（非 succeeded）时以 operation 为准，退回后的 draft 以发布状态为准。 */
function cellStateKey(item: PublicationItem): string {
  const operation = item.operation;
  if (operation && operation.state !== 'succeeded') return operation.state;
  return item.publication.status;
}

/** 六种运行状态的语义色：published=绿 / prepared·awaiting·needs_user=琥珀 / unknown=蓝 / failed=红 / draft=灰。 */
const STATE_TONE: Record<string, string> = {
  prepared: 'amber',
  execution_granted: 'amber',
  browser_leased: 'amber',
  executing: 'amber',
  readback_pending: 'amber',
  needs_user: 'amber',
  awaiting_confirmation: 'amber',
  publishing: 'amber',
  unknown: 'blue',
  failed: 'red',
  published: 'green',
  succeeded: 'green',
  draft: 'gray'
};

/** 失败原因：优先取最新 attempt 的 error_message，其次取最后一次 failed 事件 reason。 */
function failedReasonOf(item: PublicationItem): string | null {
  const attemptError = item.attempts.find((attempt) => attempt.error_message)?.error_message;
  if (attemptError) return String(attemptError);
  const failedEvents = item.events.filter((event) => String(event.to_status) === 'failed');
  const lastReason = String(failedEvents[failedEvents.length - 1]?.reason ?? '');
  return lastReason.trim() || null;
}

/** 矩阵单元文案（v3 action+meaning cell）：动作词 + 含义，不暴露状态机词条/版本号。 */
const CELL_WORDS: Record<string, { action: string; meaning: string }> = {
  prepared: { action: '继续发布', meaning: '内容已准备好' },
  execution_granted: { action: '打开并发布', meaning: '已授权，等待签发' },
  browser_leased: { action: '打开并发布', meaning: '浏览器已锁定' },
  executing: { action: '打开并发布', meaning: '编辑器执行中' },
  readback_pending: { action: '看看结果', meaning: '等待核对发布结果' },
  awaiting_confirmation: { action: '打开并发布', meaning: '内容已准备好' },
  publishing: { action: '打开并发布', meaning: '发布中' },
  needs_user: { action: '打开页面', meaning: '需要你完成验证' },
  unknown: { action: '看看结果', meaning: '还没确认是否发布' },
  failed: { action: '再试一次', meaning: '上次没有发出' },
  published: { action: '查看内容', meaning: '已发布' },
  succeeded: { action: '打开并发布', meaning: '编辑器已准备' },
  draft: { action: '查看', meaning: '已退回创作' }
};

/** 矩阵单元时间：M/D HH:mm 紧凑格式。 */
function formatCellTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 首行有意义正文：按行抽首个非空行并裁至 42 字（与详情任务标题复用同一截断）。 */
function firstMeaningfulBodyLine(body: string): string | null {
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 42);
  }
  const trimmed = body.trim();
  return trimmed ? trimmed.slice(0, 42) : null;
}

/** 纯确定性兜底解析器：authoritative → payload/snapshot title → 正文首行 → 项目短ID。永不返回裸 `创作项目`。 */
export function resolvePublicationProjectTitle(projectId: string, titleMap: Record<string, string>, publications: PublicationItem[]): string {
  const authoritative = titleMap[projectId]?.trim();
  if (authoritative) return authoritative;
  const related = publications.filter((item) => item.publication.projectId === projectId);
  for (const item of related) {
    const t = item.payload?.title?.trim() || item.snapshot?.payload?.title?.trim() || '';
    if (t) return t;
  }
  for (const item of related) {
    const body = item.payload?.body ?? item.snapshot?.payload?.body ?? null;
    if (typeof body === 'string') {
      const line = firstMeaningfulBodyLine(body);
      if (line) return line;
    }
  }
  return `项目 ${projectId.slice(0, 8)}`;
}

/** 单元动作词/含义：已发布项把发布时间放进含义行。 */
function cellWordsOf(item: PublicationItem): { action: string; meaning: string } {
  const words = CELL_WORDS[cellStateKey(item)];
  if (!words) return { action: '查看', meaning: publicationLabel(item.publication, item.operation) };
  if (item.publication.status === 'published' && item.publication.publishedAt) {
    return { ...words, meaning: `${formatCellTime(item.publication.publishedAt)} 已发布` };
  }
  return words;
}


export function PublishView({ publications, refresh, openStudio, onEditProject, takeover, selectedId, onSelect, settings, enabledPlatforms }: {
  publications: PublicationItem[];
  refresh: () => void;
  openStudio: () => void;
  onEditProject: (projectId: string) => void;
  takeover: () => void;
  selectedId: string | null;
  onSelect: (publicationId: string) => void;
  settings: WmbSettingsSnapshot | null;
  enabledPlatforms: Array<'x' | 'xiaohongshu' | 'wechat' | 'zhihu'>;
}): React.JSX.Element {
  const [tab, setTab] = useState<PublishTab>('board');
  const [detailProjectId, setDetailProjectId] = useState<string | null>(null);
  const [modalTaskId, setModalTaskId] = useState<string | null>(null);
  const [articleUrl, setArticleUrl] = useState('');
  const [authorizing, setAuthorizing] = useState(false);
  const [returning, setReturning] = useState(false);
  const [projectTitles, setProjectTitles] = useState<Record<string, string>>({});

  const selected = publications.find((item) => item.publication.id === selectedId) ?? publications[0] ?? null;
  useEffect(() => { if (selected && selected.publication.id !== selectedId) onSelect(selected.publication.id); }, [selected?.publication.id]);

  // 项目行标题来自真实创作项目（只读查询，无协议/schema 变更）。合并 active+archived 避免归档项目显示裸 `创作项目`。
  useEffect(() => {
    let active = true;
    Promise.all([
      window.wmb.listStudioProjects({ limit: 500 }),
      window.wmb.listStudioProjects({ archived: true, limit: 500 }),
    ]).then(([activeResult, archivedResult]) => {
      if (!active) return;
      const map: Record<string, string> = {};
      for (const result of [activeResult, archivedResult]) {
        if (!result || !Array.isArray(result.items)) continue;
        for (const project of result.items) if (project.id && typeof project.title === 'string') map[project.id] = project.title;
      }
      setProjectTitles(map);
    }).catch(() => {});
    return () => { active = false; };
  }, [publications]);

  const resolveTitle = (projectId: string): string => resolvePublicationProjectTitle(projectId, projectTitles, publications);

  // 详情子页 Esc 返回矩阵（弹窗打开时 Esc 归弹窗处理，不触发返回）。
  useEffect(() => {
    if (!detailProjectId) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !modalTaskId) setDetailProjectId(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detailProjectId, modalTaskId]);

  const attentionCount = publications.filter(attentionOf).length;

  const matrixPlatforms = useMemo(() => {
    const present = new Set(publications.map((item) => item.publication.platform));
    return PLATFORM_ORDER.filter((platform) => enabledPlatforms.includes(platform) || present.has(platform));
  }, [publications, enabledPlatforms]);

  const visibleItems = useMemo(() => {
    if (tab === 'todo') return publications.filter(attentionOf);
    if (tab === 'history') return publications.filter((item) => item.publication.status === 'published' || item.publication.status === 'draft');
    return publications;
  }, [publications, tab]);

  const groups = useMemo(() => {
    const byProject = new Map<string, PublicationItem[]>();
    for (const item of visibleItems) {
      const pid = item.publication.projectId;
      const list = byProject.get(pid);
      if (list) list.push(item); else byProject.set(pid, [item]);
    }
    return [...byProject.entries()].map(([projectId, items]) => ({ projectId, items }));
  }, [visibleItems]);

  const detailItems = useMemo(() => {
    if (!detailProjectId) return null;
    return publications.filter((item) => item.publication.projectId === detailProjectId);
  }, [publications, detailProjectId]);

  const detailByPlatform = useMemo(() => {
    if (!detailItems) return [];
    const byPlatform = new Map<string, PublicationItem[]>();
    for (const item of detailItems) {
      const list = byPlatform.get(item.publication.platform) ?? [];
      list.push(item);
      byPlatform.set(item.publication.platform, list);
    }
    return PLATFORM_ORDER.filter((platform) => byPlatform.has(platform)).map((platform) => ({ platform, items: byPlatform.get(platform) as PublicationItem[] }));
  }, [detailItems]);

  const modalTask = modalTaskId ? (publications.find((item) => item.publication.id === modalTaskId) ?? null) : null;

  const openTask = (item: PublicationItem) => {
    onSelect(item.publication.id);
    setArticleUrl('');
    setModalTaskId(item.publication.id);
  };

  // 房间头部主操作：打开第一篇需要人工介入的任务。
  const continuePublish = () => {
    const next = publications.find(attentionOf);
    if (next) openTask(next);
  };

  const authorizeEditor = async () => {
    if (!modalTask || !modalTask.operation || authorizing) return;
    setAuthorizing(true);
    try {
      const result = await window.wmb.authorizePublicationEditor({ publicationId: modalTask.publication.id, expectedRevision: modalTask.publication.revision });
      if (result.ok) refresh();
    } finally { setAuthorizing(false); }
  };
  const returnToEdit = async () => {
    if (!modalTask || returning) return;
    setReturning(true);
    try {
      const result = await window.wmb.returnPublicationToEdit(modalTask.publication.id, modalTask.publication.revision);
      if (!result.ok) return;
      refresh();
      onEditProject(modalTask.publication.projectId);
    } finally { setReturning(false); }
  };
  const reconcile = async () => {
    if (!modalTask) return;
    const reconciled = await window.wmb.reconcileNotPublished(modalTask.publication.id, modalTask.publication.revision);
    if (!reconciled.ok) return;
    refresh();
  };
  const readBackWechat = async () => {
    if (!modalTask || !articleUrl.trim()) return;
    const result = await window.wmb.readBackWechatPublication(modalTask.publication.id, modalTask.publication.revision, articleUrl.trim());
    if (result.ok) {
      setArticleUrl('');
      refresh();
    }
  };
  const browserReady = settings?.browser.status === 'ready';
  const mcpReady = settings?.mcp.status === 'ready';

  const cellOf = (groupId: string, platform: string): PublicationItem | null => {
    const group = groups.find((g) => g.projectId === groupId);
    if (!group) return null;
    return group.items.find((item) => item.publication.platform === platform) ?? null;
  };

  // 平台列头下的账号行：取该列最新一条的账号；无数据时退化为接入状态。
  const colAccountOf = (platform: string): string => {
    const first = publications.find((item) => item.publication.platform === platform);
    if (first?.publication.accountKey) return first.publication.accountKey;
    return enabledPlatforms.includes(platform as 'x' | 'xiaohongshu' | 'wechat' | 'zhihu') ? '已启用' : '仅历史记录';
  };

  const TABS: Array<{ id: PublishTab; label: string }> = [
    { id: 'board', label: '全部' },
    { id: 'todo', label: '待我处理' },
    { id: 'history', label: '已发布' }
  ];

  return <section className="workflow-page publish-page">
    {!publications.length ? (
      <div className="compact-empty publish-empty">
        <h2>还没有发布任务</h2>
        <p>先在创作页完成平台版本和媒体素材，再回到这里签发。</p>
        <button type="button" className="secondary-button" onClick={openStudio}>回到创作</button>
      </div>
    ) : (
      <>
        <section className="publish-room-head" aria-label="发布概览">
          <div className="publish-room-copy">
            <div className="publish-room-titleline">
              <h1>发布</h1>
            </div>
            <p>选择一篇内容，再选择要发布的平台。</p>
          </div>
          <div className="publish-room-actions">
            <button type="button" className="secondary-button" onClick={refresh}>刷新</button>
            <button type="button" className="primary-button" disabled={attentionCount === 0} onClick={continuePublish}>继续发布</button>
          </div>
        </section>

        <nav className="proposal-tabs publish-tabs" role="tablist" aria-label="发布内容">
          {TABS.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id}
              className={`proposal-tab${tab === entry.id ? ' active' : ''}`}
              onClick={() => { setTab(entry.id); setDetailProjectId(null); }}>
              {entry.label}
            </button>
          ))}
        </nav>

        {detailItems ? (
          <div className="publish-detail">
            <div className="publish-detail-bar">
              <button type="button" className="secondary-button publish-back" onClick={() => setDetailProjectId(null)} aria-label="返回矩阵">← 返回</button>
              <nav className="publish-breadcrumb" aria-label="面包屑">
                <button type="button" onClick={() => setDetailProjectId(null)}>发布</button>
                <span className="publish-breadcrumb-sep" aria-hidden="true">/</span>
                <span className="publish-breadcrumb-current">{detailProjectId ? resolveTitle(detailProjectId) : '项目'}</span>
              </nav>
            </div>
            <div className="publish-detail-body">
              {detailByPlatform.map((section) => (
                <section className="publish-detail-section" key={section.platform} aria-label={`${platformNames[section.platform] ?? section.platform} 任务`}>
                  <h3><PlatformMark platform={section.platform}/>{platformNames[section.platform] ?? section.platform}</h3>
                  <div className="publish-detail-tasks">
                    {section.items.map((item) => {
                      const stateKey = cellStateKey(item);
                      const isPublished = item.publication.status === 'published';
                      const failedReasonText = item.publication.status === 'failed' ? failedReasonOf(item) : null;
                      return (
                        <div className="publish-detail-task" key={item.publication.id}>
                          <button type="button" className="publish-detail-task-main" onClick={() => openTask(item)}>
                            <span className="publish-detail-task-top">
                              <b>{item.payload?.title || item.payload?.body.slice(0, 42) || '尚未准备内容'}</b>
                              <span className={`pill-status ${STATE_TONE[stateKey] ?? 'gray'}`}><span className="dot"/>{publicationLabel(item.publication, item.operation)}</span>
                            </span>
                            <small>{item.publication.accountKey || '未识别账号'} · v{item.publication.revision}{isPublished && item.publication.publishedAt ? ` · ${new Date(item.publication.publishedAt).toLocaleString('zh-CN')} 人工发布` : ''}{failedReasonText ? ` · ${failedReasonText}` : ''}</small>
                          </button>
                          {isPublished && item.publication.externalUrl ? <a className="publish-detail-link" href={item.publication.externalUrl} target="_blank" rel="noreferrer">查看原文</a> : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : (
          <div className="publish-matrix-wrap">
            <div className="publish-matrix-scroller">
              <div className="publish-matrix" role="table" aria-label="内容和发布平台"
                style={{ gridTemplateColumns: `var(--publish-col-content, minmax(220px, 1.45fr)) repeat(${matrixPlatforms.length}, var(--publish-col-platform, minmax(0, 1fr)))` }}>
                <div className="publish-matrix-head" role="row">
                  <div className="publish-matrix-corner" role="columnheader"><strong>内容</strong></div>
                  {matrixPlatforms.map((platform) => (
                    <div className="publish-platform-head" role="columnheader" key={platform}>
                      <PlatformMark platform={platform}/>
                      <span className="publish-platform-copy">
                        <strong>{platformNames[platform] ?? platform}</strong>
                        <small>{colAccountOf(platform)}</small>
                      </span>
                    </div>
                  ))}
                </div>
                {groups.map((group) => (
                  <div className="publish-matrix-row" role="row" key={group.projectId}>
                    <div className="publish-matrix-project" role="rowheader">
                      <button type="button" className="publish-project-name" onClick={() => setDetailProjectId(group.projectId)}>
                        {resolveTitle(group.projectId)}
                      </button>
                      <div className="publish-project-meta">
                        <small>{group.items.some(attentionOf) ? '有任务待处理' : '已全部处理'}</small>
                      </div>
                    </div>
                    {matrixPlatforms.map((platform) => {
                      const rep = cellOf(group.projectId, platform);
                      if (!rep) return <div className="publish-cell-empty" role="cell" key={platform}>—</div>;
                      const stateKey = cellStateKey(rep);
                      const words = cellWordsOf(rep);
                      return (
                        <div className="publish-cell-slot" role="cell" key={platform}>
                          <button type="button" className="publish-cell" data-status={stateKey}
                            onClick={() => openTask(rep)}
                            aria-label={`${resolveTitle(group.projectId)} ${platformNames[platform] ?? platform}：${words.action}，${words.meaning}`}>
                            <span className="publish-cell-action">{words.meaning}</span>
                            <span className="publish-cell-meta">{rep.publication.accountKey || '未识别账号'}</span>
                            <span className="publish-cell-extra publish-cell-more" aria-hidden="true">›</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
                {!groups.length && (
                  <div className="publish-empty-note">
                    <b>{tab === 'todo' ? '没有需要处理的任务' : '没有符合条件的发布任务'}</b>
                    <span>{tab === 'todo' ? '需要你处理的任务会出现在这里。' : '在创作页准备平台版本后，会进入这里等待签发。'}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </>
    )}

    <AppModal
      open={modalTask !== null}
      title={modalTask ? `${cellWordsOf(modalTask).action} · ${platformNames[modalTask.publication.platform] ?? modalTask.publication.platform}` : '发布任务'}
      size="large"
      className="publish-task-modal"
      testId="publish-task-modal"
      ariaDescription={modalTask ? `发布任务 · ${platformNames[modalTask.publication.platform] ?? modalTask.publication.platform}` : undefined}
      onRequestClose={() => setModalTaskId(null)}
    >
      {modalTask ? (
        <PublishTaskDialogBody
          item={modalTask}
          platformEnabled={enabledPlatforms.includes(modalTask.publication.platform)}
          browserReady={browserReady}
          mcpReady={mcpReady}
          articleUrl={articleUrl}
          onArticleUrlChange={setArticleUrl}
          authorizing={authorizing}
          returning={returning}
          onAuthorize={authorizeEditor}
          onReturnToEdit={returnToEdit}
          onReconcile={reconcile}
          onTakeover={takeover}
          onReadBackWechat={readBackWechat}
          onEditProject={onEditProject}
        />
      ) : null}
    </AppModal>
  </section>;
}

function PublishTaskDialogBody({ item, platformEnabled, browserReady, mcpReady, articleUrl, onArticleUrlChange, authorizing, returning, onAuthorize, onReturnToEdit, onReconcile, onTakeover, onReadBackWechat, onEditProject }: {
  item: PublicationItem;
  platformEnabled: boolean;
  browserReady: boolean;
  mcpReady: boolean;
  articleUrl: string;
  onArticleUrlChange: (value: string) => void;
  authorizing: boolean;
  returning: boolean;
  onAuthorize: () => void;
  onReturnToEdit: () => void;
  onReconcile: () => void;
  onTakeover: () => void;
  onReadBackWechat: () => void;
  onEditProject: (projectId: string) => void;
}): React.JSX.Element {
  const { publication, operation } = item;
  const payload = item.payload ?? (item.snapshot ? { title: item.snapshot.payload.title, body: item.snapshot.payload.body, assets: item.snapshot.assets } : null);
  const stateKey = cellStateKey(item);
  const errorText = publication.status === 'failed' ? failedReasonOf(item) : null;
  return <>
    <div className="publish-task-modal-head">
      <span className={`pf-tag ${publication.platform}`}><PlatformMark platform={publication.platform}/>{platformNames[publication.platform] ?? publication.platform}</span>
      <span className={`pill-status ${STATE_TONE[stateKey] ?? 'gray'}`}><span className="dot"/>{publicationLabel(publication, operation)}</span>
    </div>
    <dl className="publish-task-facts">
      <div><dt>账号</dt><dd>{publication.accountKey || '未识别'}</dd></div>
      <div><dt>内容版本</dt><dd>v{publication.revision}</dd></div>
      <div><dt>媒体素材</dt><dd>{payload ? (payload.assets.length ? `${payload.assets.length} 项` : '无媒体素材') : '—'}</dd></div>
    </dl>
    {payload ? (
      <div className="publish-task-payload">
        <h4>{payload.title || '正文内容'}</h4>
        <p>{payload.body}</p>
        {payload.assets.length > 0 ? (
          <div className="publish-task-assets" aria-label="媒体素材">
            {payload.assets.map((asset, index) => <span className="publish-task-asset" key={asset.id}>素材 {index + 1} · {asset.mimeType}</span>)}
          </div>
        ) : null}
      </div>
    ) : null}
    {errorText ? <p className="publish-task-error">失败原因：{errorText}</p> : null}
    <details className="publish-task-history" open>
      <summary>流转记录 · {item.events.length}</summary>
      <div className="publish-task-history-list">
        {item.events.map((event, index) => (
          <div className="publish-task-history-item" key={index}>
            <span className={`publish-task-history-dot ${timelineDot(String(event.to_status))}`} aria-hidden="true"/>
            <div>
              <b>{publicationStatus(String(event.to_status))}</b>
              <span>{event.created_at ? `${new Date(String(event.created_at)).toLocaleString('zh-CN')} · ` : ''}{String(event.reason || '')}</span>
            </div>
          </div>
        ))}
      </div>
    </details>
    <div className="publish-task-actions">
      {platformEnabled && operation?.state === 'prepared' && publication.platform !== 'xiaohongshu' && <>
        <button type="button" className="secondary-button" onClick={() => onEditProject(publication.projectId)}>继续编辑</button>
        <button type="button" className="primary-button" disabled={authorizing} onClick={onAuthorize}>{authorizing ? '授权中…' : '授权打开并填充编辑器'}</button>
      </>}
      {platformEnabled && publication.status === 'awaiting_confirmation' && operation?.state !== 'prepared' && publication.platform !== 'xiaohongshu' && (
        <button type="button" className="secondary-button" disabled={returning} onClick={onReturnToEdit}>{returning ? '退回中…' : '退回创作修改'}</button>
      )}
      {platformEnabled && (operation?.state === 'needs_user' || publication.status === 'needs_user') && publication.platform !== 'xiaohongshu' && (
        <button type="button" className="primary-button" onClick={onTakeover}>打开浏览器接管</button>
      )}
      {platformEnabled && (operation?.state === 'unknown' || publication.status === 'unknown') && publication.platform !== 'wechat' && (
        <button type="button" className="secondary-button" onClick={onReconcile}>我已核对，确认未发布</button>
      )}
      {!platformEnabled && <p className="notice">当前工作空间未启用该发布平台，仅保留历史记录。</p>}
      {platformEnabled && publication.platform === 'xiaohongshu' && <p className="notice">请在小红书客户端中人工发布。</p>}
      {platformEnabled && publication.platform === 'zhihu' && publication.status === 'awaiting_confirmation' && <p className="notice">知乎编辑器内容已就绪，请在浏览器中人工点击发布。本应用不会替你完成最终发布。</p>}
      {platformEnabled && publication.platform === 'wechat' && ['awaiting_confirmation', 'needs_user', 'unknown'].includes(publication.status) && (
        <div className="readback-form">
          <label htmlFor="wechat-publication-url">已发布文章链接</label>
          <input id="wechat-publication-url" value={articleUrl} onChange={(event) => onArticleUrlChange(event.target.value)} placeholder="粘贴公众号文章链接"/>
          <button type="button" className="secondary-button full-button" disabled={!articleUrl.trim()} onClick={onReadBackWechat}>核对文章并记录结果</button>
        </div>
      )}
      {platformEnabled && (
        <div className="publish-task-env">
          <span>专用浏览器 · {browserReady ? '已连接' : '未启动'}</span>
          <span>本地接入服务 · {mcpReady ? '运行中' : '未启动'}</span>
        </div>
      )}
    </div>
  </>;
}

function publicationStatus(status: string): string {
  return ({ prepared: '已准备', awaiting_confirmation: '等待人工发布', published: '已发布', failed: '失败', needs_user: '需要接管', unknown: '待对账' } as Record<string, string>)[status] || status;
}
function operationStatus(status: string): string {
  return ({ prepared: '待授权', execution_granted: '已授权', browser_leased: '浏览器已锁定', executing: '编辑器执行中', readback_pending: '等待核对', succeeded: '编辑器已准备', needs_user: '需要人工处理', unknown: '结果未知', failed: '失败' } as Record<string, string>)[status] || status;
}

/** 退回创作后的 draft 记录以发布状态为准，覆盖已过期的浏览器操作 succeeded 标签（已退回创作）。 */
function publicationLabel(publication: { status: string } | null | undefined, operation?: { state: string } | null | undefined): string {
  if (!publication) return '';
  if (operation && operation.state !== 'succeeded') return operationStatus(operation.state);
  return publication.status === 'draft' ? '已退回创作' : publicationStatus(publication.status);
}

function timelineDot(status: string): string {
  if (status === 'published' || status === 'prepared') return 'ok';
  if (status === 'awaiting_confirmation' || status === 'needs_user') return 'wait';
  if (status === 'failed' || status === 'unknown') return 'err';
  return 'idle';
}
