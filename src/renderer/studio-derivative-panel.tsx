import { useEffect, useRef, useState } from 'react';
import { AppModal } from './app-modal';

type Dual = {
  projectId: string;
  article: { latestVersionId: string | null; status: string | null; versionCount: number; versions?: unknown[] };
  derivative: { id: string | null; latestVersion: Record<string, unknown> | null; isStale: boolean; readiness: string; formatDecision: Record<string, unknown> | null; versions?: unknown[] };
  compare: { articleVersionId: string | null; scriptSourceVersionId: string | null; isAligned: boolean };
  isStale: boolean;
  readiness: string;
};

const readinessLabel: Record<string, string> = {
  no_article: '文章尚未定稿',
  no_script: '待生成视频文案',
  script_draft: '视频文案草稿',
  script_ready: '视频文案已就绪',
  stale: '视频文案已过期'
};

function DualDetailModal({ open, onClose, dual, projectId, returnFocusRef }: { open: boolean; onClose: () => void; dual: Dual; projectId: string; returnFocusRef?: React.RefObject<HTMLElement | null> }): React.JSX.Element {
  const latest = dual.derivative.latestVersion as { title?: string; body?: string; status?: string; source_content_version_id?: string; version_number?: number } | null;
  const articleVersions = (dual.article.versions ?? []) as Array<{ id?: string; version_number?: number }>;
  const scriptVersions = (dual.derivative.versions ?? []) as Array<{ id?: string; version_number?: number; status?: string }>;
  const decision = dual.derivative.formatDecision as { suitableForm?: string; reason?: string; narrativeStructure?: string } | null;
  return <AppModal open={open} title="产物详情" size="large" onRequestClose={onClose} returnFocusRef={returnFocusRef} testId="studio-dual-detail-modal" ariaDescription="主产物与衍生产物完整详情">
    <section className="studio-dual-detail" data-project={projectId} data-readiness={dual.readiness}>
      <article className="studio-dual-detail-card">
        <header><span>主产物</span><h4>文章主稿</h4></header>
        <dl>
          <div><dt>状态</dt><dd>{dual.article.status ?? '—'}</dd></div>
          <div><dt>版本</dt><dd>{dual.article.versionCount}</dd></div>
          <div><dt>最新</dt><dd>{dual.article.latestVersionId?.slice(0, 8) ?? '—'}</dd></div>
        </dl>
        <ol className="studio-dual-versions" aria-label="文章版本">
          {articleVersions.map((version) => <li key={version.id}>v{version.version_number} · {version.id?.slice(0, 8)}</li>)}
        </ol>
        {articleVersions.length === 0 && <p className="studio-dual-detail-empty">暂无文章版本</p>}
      </article>
      <article className="studio-dual-detail-card">
        <header><span>衍生产物</span><h4>视频文案</h4></header>
        <dl>
          <div><dt>就绪</dt><dd data-testid="dual-readiness">{readinessLabel[dual.readiness] ?? dual.readiness}</dd></div>
          <div><dt>最新</dt><dd>{latest ? `v${latest.version_number} · ${latest.status}` : '—'}</dd></div>
          <div><dt>引用</dt><dd>{latest?.source_content_version_id?.slice(0, 8) ?? '—'}</dd></div>
        </dl>
        <ol className="studio-dual-versions" aria-label="视频文案版本">
          {scriptVersions.map((version) => <li key={version.id}>v{version.version_number} · {version.status}</li>)}
        </ol>
        {latest && <section className="studio-dual-script" data-testid="dual-script">
          <h5>{latest.title || '未命名视频文案'}</h5>
          <p>{latest.body || '暂无视频文案正文'}</p>
        </section>}
        {decision && <div className="studio-format-decision"><b>{decision.suitableForm}</b><p>{decision.reason}</p><small>{decision.narrativeStructure}</small></div>}
        <div className="studio-dual-alignment" data-testid="dual-compare">{dual.compare.isAligned ? '已对齐最新文章版本' : '未对齐最新文章版本'}</div>
        {dual.isStale && <div className="studio-dual-stale" data-testid="dual-stale">文章已新定稿，旧视频文案不能继续视为完成。</div>}
      </article>
    </section>
  </AppModal>;
}

export function StudioDerivativePanel({ projectId }: { projectId: string | null }): React.JSX.Element | null {
  const [dual, setDual] = useState<Dual | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<'article' | 'derivative' | null>(null);
  const articleButtonRef = useRef<HTMLButtonElement | null>(null);
  const derivativeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!projectId) { setDual(null); return; }
    let alive = true;
    setLoading(true);
    const loadProjection = window.wmb.getStudioDualProjection;
    if (!loadProjection) { setLoading(false); return; }
    loadProjection(projectId)
      .then((result) => { if (alive) setDual(result); })
      .catch(() => { if (alive) setDual(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId]);

  if (!projectId) return null;
  if (loading) return <section className="studio-dual-ledger loading" aria-label="产物概览">加载文章与视频文案…</section>;
  if (!dual) return <section className="studio-dual-ledger empty" aria-label="产物概览">暂无双产物数据</section>;

  const latest = dual.derivative.latestVersion as { title?: string; body?: string; status?: string; source_content_version_id?: string; version_number?: number } | null;
  const openDetail = (target: 'article' | 'derivative') => { setDetailTarget(target); setDetailOpen(true); };
  const closeDetail = () => setDetailOpen(false);
  const articleStatus = dual.article.status ?? '—';
  const derivativeStatus = readinessLabel[dual.readiness] ?? dual.readiness;
  const returnRef = detailTarget === 'article' ? articleButtonRef : detailTarget === 'derivative' ? derivativeButtonRef : undefined;

  return (
    <>
      <section className={`studio-dual-ledger${dual.isStale ? ' is-stale' : ''}`} data-project={projectId} data-readiness={dual.readiness} data-stale={String(dual.isStale)} aria-label="产物概览" data-testid="studio-dual-ledger">
        <div role="button" tabIndex={0} className="studio-dual-ledger-row" data-kind="article" onClick={() => openDetail('article')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail('article'); } }} aria-label="主产物 文章主稿 查看详情">
          <span className="studio-dual-ledger-type">主产物</span>
          <strong className="studio-dual-ledger-name">文章主稿</strong>
          <span className="studio-dual-ledger-status" data-testid="dual-ledger-article-status">{articleStatus}</span>
          <span className="studio-dual-ledger-version">{dual.article.versionCount === 0 ? '尚未生成正文' : `v${dual.article.versionCount} · ${dual.article.latestVersionId?.slice(0, 8) ?? '—'}`}</span>
          <button ref={articleButtonRef} type="button" className="studio-dual-ledger-action" onClick={(e) => { e.stopPropagation(); openDetail('article'); }} aria-label="查看主产物详情">查看详情</button>
        </div>
        <div role="button" tabIndex={0} className="studio-dual-ledger-row" data-kind="derivative" onClick={() => openDetail('derivative')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail('derivative'); } }} aria-label="衍生产物 视频文案 查看详情">
          <span className="studio-dual-ledger-type">衍生产物</span>
          <strong className="studio-dual-ledger-name">视频文案</strong>
          <span className="studio-dual-ledger-status" data-testid="dual-readiness">{derivativeStatus}</span>
          <span className="studio-dual-ledger-version">{latest ? `v${latest.version_number} · ${latest.status}` : '—'} · {latest?.source_content_version_id?.slice(0, 8) ?? '—'}</span>
          <button ref={derivativeButtonRef} type="button" className="studio-dual-ledger-action" onClick={(e) => { e.stopPropagation(); openDetail('derivative'); }} aria-label="查看衍生产物详情">查看详情</button>
        </div>
      </section>
      {detailOpen && dual && <DualDetailModal open={detailOpen} onClose={closeDetail} dual={dual} projectId={projectId} returnFocusRef={returnRef} />}
    </>
  );
}
