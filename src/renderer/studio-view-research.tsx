// extracted from studio-view.tsx (structural split)
import { useEffect, useMemo, useState } from 'react';
import type { ContentProjectDetail } from '../main/content';
import type { StudioPlatform } from '../shared/studio-annotations';
import type { StudioAnnotation } from '../shared/studio-annotations';
import type { IllustrationRatio, IllustrationRun } from '../shared/illustration-workflow';
import { AppModal } from './app-modal';

/** WMB-5296 Studio「研究缺口 · 等你批」行投影（与 src/main/research-successor-projection.ts 同构，含 projectId）。 */
export type StudioResearchGapItem = Readonly<{
  id: string;
  parentJobId: string;
  parentTaskId: string;
  researchTaskId: string;
  parentRoleId: 'writer' | 'planner' | 'librarian';
  projectId: string | null;
  unresolvedClaims: ReadonlyArray<Readonly<{ key: string; text: string | null; type: 'fact' | 'price' | 'policy' | null }>>;
  decision: 'narrow' | 'supplement' | 'accept' | null;
  createdAt: string;
  updatedAt: string;
}>;

/** 三动作可读标签（与 research-successor RESEARCH_SUCCESSOR_ACTIONS / Today 同值，精确映射 narrow/supplement/accept）。 */
export const RESEARCH_DECISION_LABEL: Readonly<Record<'narrow' | 'supplement' | 'accept', string>> = Object.freeze({
  narrow: '收窄范围',
  supplement: '补充材料后继续',
  accept: '接受并标注待核实'
});

export type StudioFocusObject = {
  type: string; id: string; title: string; summary?: string | null;
  bodyStatus?: 'none' | 'ready' | 'failed' | 'empty'; bodyExcerpt?: string | null; bodyChars?: number;
  studioDocument?: { projectId: string; documentKind: 'core' | 'platform'; documentId: string | null; platform: StudioPlatform | null; title: string; currentBody: string; bodyFingerprint: string; dirty: boolean };
  openAnnotations?: Array<Pick<StudioAnnotation, 'id' | 'startOffset' | 'endOffset' | 'quotedText' | 'prefixContext' | 'suffixContext' | 'note'>>;
};

export function useStudioResearchGaps(selectedId: string | null) {
  const [researchGapRows, setResearchGapRows] = useState<StudioResearchGapItem[]>([]);
  const [researchGapsError, setResearchGapsError] = useState<string | null>(null);
  const [researchBusyId, setResearchBusyId] = useState<string | null>(null);
  const [researchGapMessage, setResearchGapMessage] = useState<string | null>(null);

  const researchGapForProject = useMemo(() => {
    if (!selectedId) return [];
    return researchGapRows.filter((row) => row.projectId === selectedId);
  }, [researchGapRows, selectedId]);

  useEffect(() => {
    setResearchGapRows([]); setResearchGapsError(null); setResearchGapMessage(null);
    if (!selectedId) return;
    let active = true;
    const loadGaps = () => void window.wmb.listResearchSuccessorsNeedsUser().then((items) => {
      if (!active) return;
      setResearchGapRows(items ?? []);
      setResearchGapsError(null);
    }).catch(() => {
      if (active) setResearchGapsError('研究缺口读取失败，请稍后重试');
    });
    loadGaps();
    const unsubscribe = window.wmb.onDataChanged((event) => {
      const scopes = event.scopes ?? [];
      if (scopes.includes('agent') || scopes.includes('today') || scopes.length === 0) loadGaps();
    });
    return () => { active = false; unsubscribe(); };
  }, [selectedId]);

  const decideResearchGap = async (jobId: string, decision: keyof typeof RESEARCH_DECISION_LABEL) => {
    if (researchBusyId) return;
    setResearchBusyId(jobId);
    setResearchGapMessage(null);
    setResearchGapsError(null);
    try {
      const result = await window.wmb.decideResearchSuccessor({ jobId, decision });
      if (result && typeof result === 'object' && result.ok) {
        setResearchGapMessage(`已选择「${RESEARCH_DECISION_LABEL[decision]}」：写作将自动继续（原角色续派已恢复待调度）。`);
        const items = await window.wmb.listResearchSuccessorsNeedsUser().catch(() => null);
        if (items) setResearchGapRows(items);
      } else {
        const error = result && typeof result === 'object' && result.error ? result.error : null;
        setResearchGapsError(error ? `决策未生效（${error.code}）：${error.message}` : '决策未生效：未知错误。');
      }
    } catch (error) {
      setResearchGapsError(error instanceof Error ? error.message : String(error));
    } finally {
      setResearchBusyId(null);
    }
  };

  return { researchGapRows, researchGapForProject, researchGapsError, researchBusyId, researchGapMessage, decideResearchGap, setResearchGapRows };
}

export function useStudioIllustrations(selected: ContentProjectDetail | null, selectedId: string | null, latest: ContentProjectDetail['revisions'][number] | undefined) {
  const [illustrationRuns, setIllustrationRuns] = useState<IllustrationRun[]>([]);
  const [illustrationRatio, setIllustrationRatio] = useState<IllustrationRatio>('16:9');
  const [illustrationMaxGenerated, setIllustrationMaxGenerated] = useState(6);
  const [illustrationBusy, setIllustrationBusy] = useState(false);
  const [illustrationRequest, setIllustrationRequest] = useState('');
  const [illustrationImageModel, setIllustrationImageModel] = useState('');
  const [illustrationProfileId, setIllustrationProfileId] = useState('');

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const loadIllustrations = async () => {
      if (!selectedId) { if (live) setIllustrationRuns([]); return; }
      const [runs, config] = await Promise.all([
        window.wmb.listIllustrationRuns(selectedId).catch(() => [] as IllustrationRun[]),
        window.wmb.getIllustrationImageConfig().catch(() => null)
      ]);
      if (!live) return;
      setIllustrationRuns(runs ?? []);
      if (config) { setIllustrationProfileId(config.profileId); setIllustrationImageModel(config.model); }
      if (runs?.some((run) => ['pending', 'planning', 'running'].includes(run.status))) timer = window.setTimeout(loadIllustrations, 1200);
    };
    void loadIllustrations();
    return () => { live = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [selectedId, selected?.revisions[0]?.id]);

  return {
    illustrationRuns, setIllustrationRuns,
    illustrationRatio, setIllustrationRatio,
    illustrationMaxGenerated, setIllustrationMaxGenerated,
    illustrationBusy, setIllustrationBusy,
    illustrationRequest, setIllustrationRequest,
    illustrationImageModel, setIllustrationImageModel,
    illustrationProfileId, setIllustrationProfileId
  };
}

export function StudioResearchGate({ gaps, message, error, busyId, onDecide }: {
  gaps: StudioResearchGapItem[];
  message: string | null;
  error: string | null;
  busyId: string | null;
  onDecide: (jobId: string, decision: keyof typeof RESEARCH_DECISION_LABEL) => void;
}): React.JSX.Element | null {
  if (gaps.length === 0 && !error && !message) return null;
  return <div className="studio-research-gate" aria-label="研究缺口 · 等你批">
    {gaps.map((gap) => (
      <div className="studio-research-gate-row" key={gap.id} data-successor={gap.id}>
        <span className="studio-research-gate-title">研究缺口 · 等你批</span>
        <span className="studio-research-gate-hint">研究返回时含未解决声明，需你决策后写作才会自动继续</span>
        <span className="studio-research-gate-claims">
          {gap.unresolvedClaims.map((claim) => (
            <span className="studio-research-gate-claim" key={claim.key} title={claim.text ?? undefined}>
              <b>{claim.key}</b>
              {claim.text ? <span className="studio-research-gate-claim-text">{claim.text}</span> : null}
            </span>
          ))}
        </span>
        <span className="studio-research-gate-actions">
          <button type="button" className="secondary-button" disabled={busyId !== null} onClick={() => void onDecide(gap.id, 'narrow')}>收窄范围</button>
          <button type="button" className="secondary-button" disabled={busyId !== null} onClick={() => void onDecide(gap.id, 'supplement')}>补充材料后继续</button>
          <button type="button" className="primary-button" disabled={busyId !== null} onClick={() => void onDecide(gap.id, 'accept')}>接受并标注待核实</button>
        </span>
      </div>
    ))}
    {message ? <p className="studio-research-gate-msg" role="status">{message}</p> : null}
    {error ? <p className="studio-research-gate-error" role="alert">{error}</p> : null}
  </div>;
}

// Helper to compute aggregate illustration summary
function computeIllustrationSummary(runs: IllustrationRun[]): { total: number; completed: number; generating: number; failed: number; pending: number; hasRunning: boolean } {
  let total = 0, completed = 0, generating = 0, failed = 0, pending = 0;
  let hasRunning = false;
  for (const run of runs) {
    if (['pending', 'planning', 'running'].includes(run.status)) hasRunning = true;
    for (const item of run.items) {
      total += 1;
      if (item.state === 'completed') completed += 1;
      else if (item.state === 'generating') { generating += 1; hasRunning = true; }
      else if (item.state === 'failed') failed += 1;
      else if (item.state === 'pending') { pending += 1; if (run.status === 'running' || run.status === 'pending' || run.status === 'planning') hasRunning = true; }
    }
  }
  return { total, completed, generating, failed, pending, hasRunning };
}

function illustrationStatusLabel(runs: IllustrationRun[], summary: ReturnType<typeof computeIllustrationSummary>, busyFlag: boolean): string {
  if (busyFlag || summary.hasRunning) return '生成中';
  if (runs.length === 0 || summary.total === 0) return '暂无配图';
  if (summary.failed > 0 && summary.completed === 0) return '配图失败';
  if (summary.failed > 0) return '部分完成';
  if (summary.completed === summary.total && summary.total > 0) return '配图已完成';
  if (summary.completed > 0) return '部分完成';
  // check run-level failure
  if (runs.some((r) => r.status === 'failed')) return '配图失败';
  if (runs.some((r) => r.status === 'partial')) return '部分完成';
  return '待生成';
}

export function StudioIllustrationDetailModal({ open, onClose, runs, busy, ratio, setRatio, request, setRequest, onRetry, onRegenerate, onUndo, returnFocusRef }: {
  open: boolean; onClose: () => void; runs: IllustrationRun[]; busy: boolean;
  ratio: IllustrationRatio; setRatio: (v: IllustrationRatio) => void;
  request: string; setRequest: (v: string) => void;
  onRetry: (runId: string, itemId: string) => void;
  onRegenerate: (runId: string, itemId: string) => void;
  onUndo: (runId: string, itemId: string) => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element | null {
  return <AppModal open={open} title="配图详情" size="large" onRequestClose={onClose} returnFocusRef={returnFocusRef} testId="studio-illustration-detail-modal" ariaDescription="配图运行与单项操作详情">
    <div className="studio-illustration-detail">
      {runs.length === 0 ? <p className="studio-illustration-detail-empty">暂无配图运行记录。点击“定稿配图”开始生成。</p> : runs.map((run) => (
        <section key={run.id} className="studio-illustration-detail-run" data-run={run.id} data-status={run.status}>
          <header className="studio-illustration-detail-run-head">
            <strong>运行 {run.status}</strong>
            <span className="studio-illustration-detail-meta">比例 {run.defaultRatio} · 最多 {run.maxGenerated} 张 · {run.items.length} 项</span>
            {run.failureMessage ? <span className="studio-illustration-detail-error">{run.failureMessage}</span> : null}
          </header>
          <div className="studio-illustration-detail-items">
            {run.items.map((item) => (
              <div key={item.id} className="studio-illustration-detail-item" data-item={item.id} data-state={item.state}>
                <div className="studio-illustration-detail-item-main">
                  <span className="studio-illustration-detail-kind">{item.kind === 'source' ? '来源图' : '配图'}</span>
                  <span className="studio-illustration-detail-state">{item.state}</span>
                  <span className="studio-illustration-detail-ratio">{item.ratio}</span>
                  {item.errorMessage ? <span className="studio-illustration-detail-item-error">{item.errorMessage}</span> : null}
                </div>
                <div className="studio-illustration-detail-item-actions">
                  {item.state === 'failed' && <button type="button" className="secondary-button" disabled={busy} onClick={() => void onRetry(run.id, item.id)}>重试</button>}
                  {item.kind === 'generated' && item.state === 'completed' && <>
                    <label className="studio-illustration-detail-regen-label"><span>比例</span><select aria-label="重新生成比例" value={ratio} onChange={(event) => setRatio(event.target.value as IllustrationRatio)}>{(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21'] as IllustrationRatio[]).map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
                    <input aria-label="重新生成要求" className="studio-illustration-detail-request" value={request} onChange={(event) => setRequest(event.target.value)} placeholder="可选修改要求" />
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => void onRegenerate(run.id, item.id)}>重新生成</button>
                    {item.previousAssetId && <button type="button" className="secondary-button" disabled={busy} onClick={() => void onUndo(run.id, item.id)}>撤销</button>}
                  </>}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  </AppModal>;
}

export function StudioIllustrationSummaryBar({ runs, busy, ratio, setRatio, maxGenerated, setMaxGenerated, onStart, latest, canStartBusy, onOpenDetails, detailOpen }: {
  runs: IllustrationRun[];
  busy: boolean;
  ratio: IllustrationRatio; setRatio: (v: IllustrationRatio) => void;
  maxGenerated: number; setMaxGenerated: (v: number) => void;
  onStart: () => void;
  latest: ContentProjectDetail['revisions'][number] | undefined;
  canStartBusy: boolean;
  onOpenDetails: () => void;
  detailOpen: boolean;
}): React.JSX.Element {
  const summary = computeIllustrationSummary(runs);
  const statusLabel = illustrationStatusLabel(runs, summary, busy);
  const statusTone = summary.hasRunning || busy ? 'running' : summary.failed > 0 ? 'partial' : summary.completed === summary.total && summary.total > 0 ? 'done' : 'idle';
  const completedText = summary.total > 0 ? `${summary.completed}/${summary.total}` : '0/0';
  const startDisabled = canStartBusy || !latest;
  return <section className="studio-illustration-summary-bar" aria-label="配图摘要" data-status={statusTone} data-testid="illustration-summary-bar">
    <span className="studio-illustration-summary-status" data-tone={statusTone}>
      <i className="studio-illustration-summary-dot" aria-hidden="true" />
      <span>{statusLabel}</span>
    </span>
    <span className="studio-illustration-summary-count" aria-label={`完成 ${completedText}`}>{completedText}</span>
    <span className="studio-illustration-summary-sep" aria-hidden="true">·</span>
    <label className="studio-illustration-summary-field"><span>比例</span><select aria-label="比例" value={ratio} onChange={(event) => setRatio(event.target.value as IllustrationRatio)} disabled={busy}>{(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21'] as IllustrationRatio[]).map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
    <label className="studio-illustration-summary-field"><span>张数</span><input aria-label="生成张数" type="number" min={0} max={6} value={maxGenerated} onChange={(event) => setMaxGenerated(Math.min(6, Math.max(0, Number(event.target.value) || 0)))} disabled={busy} /></label>
    <span className="studio-illustration-summary-actions">
      <button type="button" className="primary-button studio-illustration-summary-start" onClick={() => void onStart()} disabled={startDisabled} title="固定当前正文并开始配图">定稿配图</button>
      {runs.length > 0 && <button type="button" className="secondary-button studio-illustration-summary-detail" onClick={onOpenDetails} aria-expanded={detailOpen} aria-controls="studio-illustration-detail-modal-dialog">查看详情</button>}
      {runs.length === 0 && <span className="studio-illustration-summary-hint">详情在生成后可查看</span>}
    </span>
  </section>;
}

export function StudioIllustrationPanel({ runs, busy, ratio, setRatio, maxGenerated, setMaxGenerated, request, setRequest, onStart, onRetry, onRegenerate, onUndo, latest, activePlatform, readOnlyVersion }: {
  runs: IllustrationRun[];
  busy: boolean;
  ratio: IllustrationRatio; setRatio: (v: IllustrationRatio) => void;
  maxGenerated: number; setMaxGenerated: (v: number) => void;
  request: string; setRequest: (v: string) => void;
  onStart: () => void;
  onRetry: (runId: string, itemId: string) => void;
  onRegenerate: (runId: string, itemId: string) => void;
  onUndo: (runId: string, itemId: string) => void;
  latest: ContentProjectDetail['revisions'][number] | undefined;
  activePlatform: string | null | undefined;
  readOnlyVersion: unknown;
}): React.JSX.Element | null {
  const [detailOpen, setDetailOpen] = useState(false);
  if (activePlatform || readOnlyVersion) return null;
  // Always show summary, even when runs empty, to keep explicit idle/loading/error state
  return <>
    <StudioIllustrationSummaryBar runs={runs} busy={busy} ratio={ratio} setRatio={setRatio} maxGenerated={maxGenerated} setMaxGenerated={setMaxGenerated} onStart={onStart} latest={latest} canStartBusy={busy} onOpenDetails={() => setDetailOpen(true)} detailOpen={detailOpen} />
    <StudioIllustrationDetailModal open={detailOpen} onClose={() => setDetailOpen(false)} runs={runs} busy={busy} ratio={ratio} setRatio={setRatio} request={request} setRequest={setRequest} onRetry={onRetry} onRegenerate={onRegenerate} onUndo={onUndo} />
  </>;
}
