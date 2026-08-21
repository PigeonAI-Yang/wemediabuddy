// extracted from studio-view.tsx (structural split)
import { useEffect, useMemo, useState } from 'react';
import type { ContentProjectDetail } from '../main/content';
import type { StudioPlatform } from '../shared/studio-annotations';
import type { StudioAnnotation } from '../shared/studio-annotations';
import type { IllustrationRatio, IllustrationRun } from '../shared/illustration-workflow';

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
  if (activePlatform || readOnlyVersion || runs.length === 0) return null;
  return <section className="studio-illustration-panel" aria-label="配图运行">
    {runs.map((run) => <div className="studio-illustration-run" key={run.id}>
      <span>运行 {run.status}{run.failureMessage ? ` · ${run.failureMessage}` : ''}</span>
      <div className="studio-illustration-items">{run.items.map((item) => <div className="studio-illustration-item" key={item.id}>
        <span>{item.kind === 'source' ? '来源图' : '配图'} · {item.state}{item.errorMessage ? ` · ${item.errorMessage}` : ''}</span>
        {item.state === 'failed' && <button type="button" className="secondary-button" disabled={busy} onClick={() => void onRetry(run.id, item.id)}>重试</button>}
        {item.kind === 'generated' && item.state === 'completed' && <><select aria-label="重新生成比例" value={ratio} onChange={(event) => setRatio(event.target.value as IllustrationRatio)}>{(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21'] as IllustrationRatio[]).map((r) => <option key={r} value={r}>{r}</option>)}</select><input aria-label="重新生成要求" value={request} onChange={(event) => setRequest(event.target.value)} placeholder="可选修改要求" /><button type="button" className="secondary-button" disabled={busy} onClick={() => void onRegenerate(run.id, item.id)}>重新生成</button>{item.previousAssetId && <button type="button" className="secondary-button" disabled={busy} onClick={() => void onUndo(run.id, item.id)}>撤销</button>}</>}
      </div>)}</div>
    </div>)}
  </section>;
}
