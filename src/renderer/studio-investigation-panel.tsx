// 项目“依据与进度”详情：默认只展示生产状态，完整调查档案渐进披露。
// 正常链路由生产授权自动推进；Owner 操作仅用于 needs_user / failed 等异常恢复。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentProjectDetail } from '../main/content';
import { appConfirm } from './app-confirm';
import { formatTime } from './studio-view-helpers';
import {
  blankDirection,
  blankOutline,
  CLAIM_STATUS_LABELS,
  directionsEqual,
  HISTORY_KIND_LABELS,
  INVESTIGATION_DIRECTION_FIELDS,
  INVESTIGATION_OUTLINE_FIELDS,
  investigationStatusLabel,
  investigationStatusTone,
  outlinesEqual,
  RECOMMENDATION_LABELS,
  TERMINAL_REASON_LABELS,
  unwrapInvestigationResult,
  wmbInvestigation,
  type StudioInvestigationCommandResult,
  type StudioInvestigationDirection,
  type StudioInvestigationEvidencePack,
  type StudioInvestigationModel,
  type StudioInvestigationOutline,
  type StudioInvestigationStatus
} from './studio-investigation';
import { studioInvestigationIndicator, type StudioInvestigationIndicator } from './studio-investigation-indicator';

const REPORTER_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  waiting_resource: '等待资源',
  running: '调查中',
  needs_user: '需要用户处理',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消'
};

const STATUS_HINTS: Record<StudioInvestigationStatus, string> = {
  outline_pending_approval: '主管已拟定调查提纲，等待 Owner 确认调查范围；批准后才可派记者。',
  outline_rejected: '提纲被驳回：修改后重新保存将形成新版本，再次呈报审批。',
  researching: '记者正在按已批准提纲开展专项调查；完成后进入主管验收。',
  research_review: '记者已交付调查资料包；主管验收并综合判断后，形成调查后写作方向。',
  needs_more_research: '主管验收认为覆盖不足：按已确认范围补派记者，无需 Owner 重批。',
  needs_user: '现有证据无法安全支撑自动写作，或核心方向发生实质变化。请明确选择恢复路径。',
  direction_pending_approval: '旧项目仍有待确认方向；确认后系统将自动进入写作。',
  ready_to_write: '调查与方向均已冻结，系统正在自动派写手。',
  writing: '写手任务已派出；正文完成后在「正文」工作面查看。',
  completed: '调查流程已完成，项目进入写作与审稿阶段。',
  abandoned: '调查已停止；项目不会继续派写手。',
  failed: '记者执行失败且无可用交付；可重试或停止。'
};

const outlineEmpty = (outline: StudioInvestigationOutline): boolean =>
  !outline.scope.trim()
  && outline.exclusions.length === 0
  && outline.known.length === 0
  && outline.hypotheses.length === 0
  && outline.questions.length === 0
  && outline.dimensions.length === 0
  && outline.materialRequirements.length === 0
  && outline.truthRisks.length === 0
  && outline.disconfirmingConditions.length === 0
  && outline.completionCriteria.length === 0;

/** 后端契约：方向必填核心问题/受众价值/文章范围（trimmed 非空）+ 合法建议结果；数组可为空。 */
const directionValid = (draft: StudioInvestigationDirection | null): boolean =>
  Boolean(draft && draft.coreQuestion.trim() && draft.audienceValue.trim() && draft.scope.trim());

export function StudioInvestigationPanel({ projectId, sources, onOpenSource, onOpenWriting, onIndicatorChange }: {
  projectId: string;
  sources: ContentProjectDetail['sources'];
  onOpenSource?: (sourceId: string) => void;
  onOpenWriting?: () => void;
  onIndicatorChange?: (indicator: StudioInvestigationIndicator) => void;
}): React.JSX.Element {
  const [model, setModel] = useState<StudioInvestigationModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; kind: 'success' | 'error' } | null>(null);
  const [outlineDraft, setOutlineDraft] = useState<StudioInvestigationOutline | null>(null);
  const [directionDraft, setDirectionDraft] = useState<StudioInvestigationDirection | null>(null);
  const lastLoadedProjectRef = useRef<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await wmbInvestigation().investigationGet(projectId);
      const next = unwrapInvestigationResult(result);
      setModel(next);
      onIndicatorChange?.(studioInvestigationIndicator(next));
    } catch (cause) {
      onIndicatorChange?.({ state: 'error', label: '调查状态读取失败' });
      if (!quiet) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [projectId, onIndicatorChange]);

  useEffect(() => {
    if (lastLoadedProjectRef.current !== projectId) {
      lastLoadedProjectRef.current = projectId;
      setModel(null);
      setError(null);
      void load();
    }
  }, [projectId, load]);

  // 外部变更（记者终态、Pi 保存等）静默刷新；草稿未保存时不覆盖编辑中的内容。
  useEffect(() => {
    return window.wmb.onDataChanged((event) => {
      const scopes = event.scopes ?? [];
      const touchesInvestigation = scopes.includes('studio') || scopes.includes('agent') || scopes.length === 0;
      if (!touchesInvestigation) return;
      const hasDirtyDraft = (outlineDraft && !outlinesEqual(outlineDraft, model?.outline ?? blankOutline()))
        || (directionDraft && !directionsEqual(directionDraft, model?.direction ?? blankDirection()));
      if (hasDirtyDraft) return;
      void load(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, model?.revision, outlineDraft, directionDraft, load]);

  // 模型 revision 变化（读取/变更返回）→ 重新播种草稿；编辑期间 revision 不变则不覆盖。
  useEffect(() => {
    setOutlineDraft(model ? (model.outline ?? blankOutline()) : null);
    setDirectionDraft(model ? (model.direction ?? blankDirection()) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.revision]);

  useEffect(() => {
    if (feedback?.kind !== 'success') return undefined;
    const timeout = window.setTimeout(() => setFeedback(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  const outlineDirty = outlineDraft ? !outlinesEqual(outlineDraft, model?.outline ?? blankOutline()) : false;
  const directionDirty = directionDraft ? !directionsEqual(directionDraft, model?.direction ?? blankDirection()) : false;

  const runMutation = useCallback(async (message: string, call: () => Promise<StudioInvestigationCommandResult>): Promise<StudioInvestigationModel | null> => {
    if (actionBusy) return null;
    setActionBusy(true);
    setFeedback(null);
    try {
      const result = await call();
      if (!result.ok || !result.data) {
        setFeedback({ message: result.error?.message ?? '操作失败，请重试', kind: 'error' });
        return null;
      }
      setModel(result.data);
      onIndicatorChange?.(studioInvestigationIndicator(result.data));
      setFeedback({ message, kind: 'success' });
      return result.data;
    } catch (cause) {
      setFeedback({ message: cause instanceof Error ? cause.message : String(cause), kind: 'error' });
      return null;
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, onIndicatorChange]);

  const requestOutline = useCallback(() => {
    setFeedback({ message: '已请主管拟定调查提纲', kind: 'success' });
    window.dispatchEvent(new CustomEvent('wmb:pi-dock-expand'));
    window.dispatchEvent(new CustomEvent('wmb-pi-generate', { detail: {
      prompt: `当前创作项目 ${projectId} 已建立专项调查，但尚无调查提纲。你现在是主管：先读取这个项目的标题、最新正文、关联来源、批注和已有研究证据，生成问题导向而不是文章章节导向的完整调查提纲。使用 wmb_get_content 读取项目，再调用 wmb_get_investigation 取得当前 revision，最后调用 wmb_save_investigation_outline 保存草稿；requestId 使用本次操作的新唯一值，taskId、grantId 和 workerLeaseId 使用任务要求中提供的精确值。scope 和 questions 必填，并完整填写当前已知、当前假设、事实维度、材料要求、真实性风险、推翻条件、完成标准与暂不调查。保存后停止，不派记者、不批准提纲、不写正文。`,
      orchestration: {
        originLabel: '创作 · 调查',
        title: '主管拟定调查提纲',
        goal: '基于当前项目真实内容形成可供 Owner 审批的专项调查提纲',
        acceptance: '调查提纲已保存为项目版本，全部字段可在调查工作面读取'
      }
    } }));
  }, [projectId]);

  const initialize = async () => {
    const initialized = await runMutation('已建立调查档案', () => wmbInvestigation().investigationInitialize(projectId));
    if (initialized && !initialized.outline) requestOutline();
  };
  const saveOutline = () => {
    if (!model || !outlineDraft) return;
    void runMutation('调查提纲已保存', () => wmbInvestigation().investigationSaveOutline({ projectId, expectedRevision: model.revision, outline: outlineDraft }));
  };
  const approveOutline = () => {
    if (!model) return;
    void runMutation('已批准调查提纲，可以派记者', () => wmbInvestigation().investigationDecideOutline({ projectId, expectedRevision: model.revision, decision: 'approve' }));
  };
  const rejectOutline = async () => {
    if (!model) return;
    if (!await appConfirm({ title: '驳回调查提纲', message: '驳回后提纲保持可修改；修改保存将形成新版本再次呈报审批。', confirmLabel: '驳回提纲', danger: true })) return;
    void runMutation('已驳回调查提纲', () => wmbInvestigation().investigationDecideOutline({ projectId, expectedRevision: model.revision, decision: 'reject' }));
  };
  const saveDirection = () => {
    if (!model || !directionDraft) return;
    void runMutation('写作方向草稿已保存', () => wmbInvestigation().investigationSaveDirection({ projectId, expectedRevision: model.revision, direction: directionDraft }));
  };
  const acceptResearch = () => {
    if (!model || !directionDraft) return;
    void runMutation('已按当前证据收窄方向并继续自动写作', () => wmbInvestigation().investigationReviewResearch({
      projectId,
      expectedRevision: model.revision,
      decision: 'accept',
      direction: directionDraft
    }));
  };
  const supplementResearch = () => {
    if (!model) return;
    void runMutation('已要求记者按原范围补查', () => wmbInvestigation().investigationReviewResearch({ projectId, expectedRevision: model.revision, decision: 'supplement' }));
  };
  const expandResearch = () => {
    if (!model) return;
    void runMutation('已扩展调查范围，提纲将形成新版本', () => wmbInvestigation().investigationReviewResearch({ projectId, expectedRevision: model.revision, decision: 'expand' }));
  };
  const stopResearch = async () => {
    if (!model) return;
    if (!await appConfirm({ title: '停止调查', message: '停止后本次调查结束，项目进入已停止状态。', confirmLabel: '停止调查', danger: true })) return;
    void runMutation('已停止调查', () => wmbInvestigation().investigationReviewResearch({ projectId, expectedRevision: model.revision, decision: 'stop' }));
  };
  const approveDirection = () => {
    if (!model) return;
    void runMutation('已批准写作方向，项目可以开始写作', () => wmbInvestigation().investigationDecideDirection({ projectId, expectedRevision: model.revision, decision: 'approve' }));
  };
  const supplementDirection = () => {
    if (!model) return;
    void runMutation('已要求补充调查', () => wmbInvestigation().investigationDecideDirection({ projectId, expectedRevision: model.revision, decision: 'supplement' }));
  };
  const stopDirection = async () => {
    if (!model) return;
    if (!await appConfirm({ title: '停止写作方向', message: '停止后项目进入已停止状态，不再派写手。', confirmLabel: '停止项目', danger: true })) return;
    void runMutation('已停止写作方向', () => wmbInvestigation().investigationDecideDirection({ projectId, expectedRevision: model.revision, decision: 'stop' }));
  };
  const startWriter = async () => {
    if (!model) return;
    if (!await appConfirm({ title: '开始写作', message: '将按已批准的方向与资料包派出写手完成正文。', confirmLabel: '派写手开始写作' })) return;
    void runMutation('写手任务已派出', () => wmbInvestigation().investigationStartWriter({ projectId, expectedRevision: model.revision }));
  };
  const retryReporter = () => {
    if (!model) return;
    void runMutation('已重新派记者', () => wmbInvestigation().investigationRetryReporter({ projectId, expectedRevision: model.revision }));
  };

  const openSource = (sourceId: string) => {
    if (sources.some((source) => source.id === sourceId)) onOpenSource?.(sourceId);
  };

  const sourceChips = useMemo(() => {
    if (!model?.package) return [] as string[];
    return [...new Set([...(model.package.pack?.sourceIds ?? []), ...model.package.sourceIds])];
  }, [model?.package]);

  const outlineFields = INVESTIGATION_OUTLINE_FIELDS;
  const directionFields = INVESTIGATION_DIRECTION_FIELDS;

  if (loading && !model) {
    return <section className="studio-investigation" aria-label="项目调查"><div className="investigation-loading">正在读取调查…</div></section>;
  }

  if (error && !model) {
    return <section className="studio-investigation" aria-label="项目调查"><div className="investigation-error" role="alert"><h3>调查读取失败</h3><p>{error}</p><button type="button" className="secondary-button" disabled={actionBusy} onClick={() => void load()}>重试</button></div></section>;
  }

  if (!model) {
    return <section className="studio-investigation" aria-label="依据与进度"><div className="investigation-empty">
      <h3>暂无生产依据档案</h3>
      <p>手动创建的项目可直接编辑正文；需要证据调查时再展开高级操作。</p>
      <details className="investigation-legacy-actions"><summary>高级操作</summary><button type="button" className="secondary-button" data-action="initialize" disabled={actionBusy} onClick={() => void initialize()}>建立调查档案</button></details>
    </div></section>;
  }

  const status = model.status;
  const tone = investigationStatusTone(status);
  const hint = status === 'outline_pending_approval' && !model.outline
    ? '调查档案已经建立，但主管尚未提交提纲。请主管基于当前项目真实内容拟定后，再由你审批。'
    : STATUS_HINTS[status];
  const approvedOutline = model.outline;
  const approvedDirection = model.direction;

  const renderReadonlyOutline = () => (
    <dl className="investigation-readonly">
      {outlineFields.map((field) => (
        <div className="investigation-readonly-row" key={field.key}>
          <dt>{field.label}</dt>
          <dd>{field.kind === 'text'
            ? (approvedOutline?.[field.key] as string).trim() || '未填写'
            : (approvedOutline?.[field.key] as string[]).length
              ? (approvedOutline?.[field.key] as string[]).map((line) => <span key={line} className="investigation-line">{line}</span>)
              : '未填写'}</dd>
        </div>
      ))}
    </dl>
  );

  const renderReadonlyDirection = () => (
    <dl className="investigation-readonly">
      <div className="investigation-readonly-row"><dt>建议结果</dt><dd>{RECOMMENDATION_LABELS[approvedDirection?.recommendation ?? 'continue']}</dd></div>
      {directionFields.filter((field) => field.key !== 'recommendation').map((field) => (
        <div className="investigation-readonly-row" key={field.key}>
          <dt>{field.label}</dt>
          <dd>{field.kind === 'text'
            ? (approvedDirection?.[field.key] as string).trim() || '未填写'
            : (approvedDirection?.[field.key] as string[]).length
              ? (approvedDirection?.[field.key] as string[]).map((line) => <span key={line} className="investigation-line">{line}</span>)
              : '未填写'}</dd>
        </div>
      ))}
    </dl>
  );

  const renderEditor = (isDirection: boolean) => {
    if (isDirection) {
      const draft = directionDraft;
      if (!draft) return null;
      return (
        <div className="investigation-editor">
          {directionFields.map((field) => {
            const raw = draft[field.key];
            const value = Array.isArray(raw) ? raw.join('\n') : raw;
            return (
              <div className="investigation-field" key={field.key}>
                <label className="investigation-field-label" htmlFor={`dir-${field.key}`}>{field.label}{field.kind === 'list' ? <small>每行一项</small> : null}</label>
                <textarea id={`dir-${field.key}`} className="investigation-textarea" rows={3} value={value}
                  disabled={actionBusy}
                  onChange={(event) => {
                    const lines = event.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
                    setDirectionDraft(field.kind === 'list' ? { ...draft, [field.key]: lines } : { ...draft, [field.key]: event.target.value });
                  }} />
              </div>
            );
          })}
          <div className="investigation-field">
            <label className="investigation-field-label" htmlFor="dir-recommendation">建议结果</label>
            <select id="dir-recommendation" className="investigation-select" value={draft.recommendation} disabled={actionBusy}
              onChange={(event) => setDirectionDraft({ ...draft, recommendation: event.target.value as StudioInvestigationDirection['recommendation'] })}>
              {(Object.keys(RECOMMENDATION_LABELS) as StudioInvestigationDirection['recommendation'][]).map((value) => (
                <option key={value} value={value}>{RECOMMENDATION_LABELS[value]}</option>
              ))}
            </select>
          </div>
        </div>
      );
    }
    const draft = outlineDraft;
    if (!draft) return null;
    return (
      <div className="investigation-editor">
        {outlineFields.map((field) => {
          const raw = draft[field.key];
          const value = Array.isArray(raw) ? raw.join('\n') : raw;
          return (
            <div className="investigation-field" key={field.key}>
              <label className="investigation-field-label" htmlFor={`out-${field.key}`}>{field.label}{field.kind === 'list' ? <small>每行一项</small> : null}</label>
              <textarea id={`out-${field.key}`} className="investigation-textarea" rows={3} value={value}
                disabled={actionBusy}
                onChange={(event) => {
                  const lines = event.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
                  setOutlineDraft(field.kind === 'list' ? { ...draft, [field.key]: lines } : { ...draft, [field.key]: event.target.value });
                }} />
            </div>
          );
        })}
      </div>
    );
  };

  const renderPackage = () => {
    const pack = model.package;
    if (!pack) return null;
    const evidence = pack.pack;
    const claimRows = evidence?.claims ?? [];
    const contradicted = claimRows.filter((claim) => claim.status === 'contradicted');
    const unknownClaims = claimRows.filter((claim) => claim.status === 'unresolved' || claim.status === 'source_unavailable');
    const pendingClaims = claimRows.filter((claim) => claim.status === 'pending');
    return (
      <section className="investigation-section" aria-label="调查资料包">
        <h3 className="investigation-section-title">调查资料包</h3>
        {evidence && (
          <p className="investigation-meta-line">
            {evidence.round ? `第 ${evidence.round} 轮 · ` : ''}有效来源 {evidence.validSourceCount} · 候选 {evidence.candidateCount} · 用时 {evidence.timeSpentMinutes} 分钟 · {TERMINAL_REASON_LABELS[evidence.terminalReason] ?? evidence.terminalReason}
          </p>
        )}
        {pack.review && (
          <p className="investigation-meta-line">主管验收：{pack.review.decision === 'defer' ? '暂缓，等待 Owner 决定' : pack.review.decision}{pack.review.summary ? ` — ${pack.review.summary}` : ''}</p>
        )}
        {contradicted.length > 0 && (
          <div className="investigation-claim-group" data-kind="conflict">
            <h4>冲突事实（被反驳）</h4>
            {contradicted.map((claim) => renderClaim(claim))}
          </div>
        )}
        {unknownClaims.length > 0 && (
          <div className="investigation-claim-group" data-kind="unknown">
            <h4>未知项（无法确认）</h4>
            {unknownClaims.map((claim) => renderClaim(claim))}
          </div>
        )}
        {pendingClaims.length > 0 && (
          <div className="investigation-claim-group" data-kind="incomplete">
            <h4>未完成项（必答问题未判定）</h4>
            {pendingClaims.map((claim) => renderClaim(claim))}
          </div>
        )}
        {(evidence?.unresolvedRequiredClaims.length ?? 0) > 0 && (
          <div className="investigation-claim-group" data-kind="incomplete">
            <h4>未解决必答问题</h4>
            <ul className="investigation-key-list">{evidence?.unresolvedRequiredClaims.map((key) => <li key={key}>{key}</li>)}</ul>
          </div>
        )}
        {sourceChips.length > 0 && (
          <div className="investigation-source-row">
            <h4>关联来源 {sourceChips.length}</h4>
            <div className="investigation-source-chips">
              {sourceChips.map((sourceId) => {
                const known = sources.some((source) => source.id === sourceId);
                return known
                  ? <button key={sourceId} type="button" className="investigation-source-chip" title={`打开来源 ${sourceId}`} onClick={() => openSource(sourceId)}>{sourceId.slice(0, 10)}</button>
                  : <span key={sourceId} className="investigation-source-chip plain" title={`来源 ${sourceId} 未关联到本项目资料`}>{sourceId.slice(0, 10)}</span>;
              })}
            </div>
          </div>
        )}
        {claimRows.length === 0 && (evidence?.unresolvedRequiredClaims.length ?? 0) === 0 && sourceChips.length === 0 && (
          <p className="investigation-meta-line">资料包为空：记者没有交付可展示的结构化内容。</p>
        )}
      </section>
    );
  };

  const renderClaim = (claim: StudioInvestigationEvidencePack['claims'][number]) => (
    <div className="investigation-claim" key={claim.id} data-claim-status={claim.status}>
      <span className="investigation-claim-status">{CLAIM_STATUS_LABELS[claim.status] ?? claim.status}</span>
      <div className="investigation-claim-main">
        <strong>{claim.key}</strong>
        {claim.verdictReason ? <p>{claim.verdictReason}</p> : null}
        {claim.evidenceSourceIds.length > 0 && (
          <span className="investigation-claim-evidence">证据：
            {claim.evidenceSourceIds.map((sourceId) => sources.some((source) => source.id === sourceId)
              ? <button key={sourceId} type="button" className="investigation-source-chip" onClick={() => openSource(sourceId)}>{sourceId.slice(0, 10)}</button>
              : <span key={sourceId} className="investigation-source-chip plain">{sourceId.slice(0, 10)}</span>)}
          </span>
        )}
      </div>
    </div>
  );

  const renderHistory = () => (
    <section className="investigation-section" aria-label="审批与版本记录">
      <h3 className="investigation-section-title">审批与版本记录</h3>
      {model.history.length === 0 && <p className="investigation-meta-line">暂无记录。</p>}
      <ol className="investigation-history">
        {model.history.map((row, index) => (
          <li key={`${row.at}-${index}`} className="investigation-history-row">
            <time>{formatTime(row.at)}</time>
            <span>{HISTORY_KIND_LABELS[row.kind] ?? row.kind}</span>
            {row.version ? <small>v{row.version}</small> : null}
            {row.note ? <small className="investigation-history-note">{row.note}</small> : null}
          </li>
        ))}
      </ol>
    </section>
  );

  // ---- 每状态一个 violet 主操作；其余为 secondary/danger ----
  const primaryAction: { label: string; dataAction: string; onClick: () => void } | null = (() => {
    switch (status) {
      case 'outline_pending_approval':
        if (outlineDirty) return { label: '保存提纲', dataAction: 'save-outline', onClick: saveOutline };
        if (!model.outline || outlineEmpty(outlineDraft ?? blankOutline())) return { label: '请主管拟定提纲', dataAction: 'request-outline', onClick: requestOutline };
        return { label: '批准提纲', dataAction: 'approve-outline', onClick: approveOutline };
      case 'outline_rejected':
        return { label: '保存提纲（新版本）', dataAction: 'save-outline', onClick: saveOutline };
      case 'research_review':
        return null;
      case 'needs_more_research': {
        const reporterActive = model.reporter?.status === 'queued' || model.reporter?.status === 'running';
        return reporterActive ? null : { label: '补派记者', dataAction: 'retry-reporter', onClick: retryReporter };
      }
      case 'needs_user':
        return model.package
          ? {
              label: model.package.review?.decision === 'defer' ? '按当前证据收窄写作' : '确认方向并继续',
              dataAction: 'accept-research',
              onClick: acceptResearch
            }
          : { label: '补派记者', dataAction: 'retry-reporter', onClick: retryReporter };
      case 'direction_pending_approval':
        return { label: '确认旧方向并继续', dataAction: 'approve-direction', onClick: approveDirection };
      case 'ready_to_write':
        return null;
      case 'failed':
        return { label: '重试记者', dataAction: 'retry-reporter', onClick: retryReporter };
      default:
        return null;
    }
  })();

  const renderActionRow = () => {
    const secondaryActions: Array<{ label: string; dataAction: string; onClick: () => void; danger?: boolean; disabled?: boolean }> = [];
    const acceptDisabled = !directionValid(directionDraft);
    if (status === 'outline_pending_approval' && model.outline) {
      if (primaryAction?.dataAction !== 'save-outline') secondaryActions.push({ label: '保存提纲', dataAction: 'save-outline', onClick: saveOutline });
      secondaryActions.push({ label: '驳回提纲', dataAction: 'reject-outline', onClick: () => { void rejectOutline(); }, danger: true });
    }
    if (status === 'research_review') {
      if (directionDirty) secondaryActions.push({ label: '保存方向草稿', dataAction: 'save-direction', onClick: saveDirection, disabled: !directionValid(directionDraft) });
      secondaryActions.push({ label: '需要补查', dataAction: 'supplement-research', onClick: supplementResearch });
      secondaryActions.push({ label: '扩展范围', dataAction: 'expand-research', onClick: expandResearch });
      secondaryActions.push({ label: '停止调查', dataAction: 'stop-research', onClick: () => { void stopResearch(); }, danger: true });
    }
    if (status === 'needs_more_research') {
      secondaryActions.push({ label: '扩展范围', dataAction: 'expand-research', onClick: expandResearch });
      secondaryActions.push({ label: '停止调查', dataAction: 'stop-research', onClick: () => { void stopResearch(); }, danger: true });
    }
    if (status === 'needs_user' && model.package) {
      secondaryActions.push({ label: '补查关键事实', dataAction: 'supplement-research', onClick: supplementResearch });
      secondaryActions.push({ label: '调整核心方向', dataAction: 'expand-research', onClick: expandResearch });
      secondaryActions.push({ label: '停止项目', dataAction: 'stop-research', onClick: () => { void stopResearch(); }, danger: true });
    }
    if (status === 'needs_user' && !model.package) {
      secondaryActions.push({ label: '停止调查', dataAction: 'stop-research', onClick: () => { void stopResearch(); }, danger: true });
    }
    if (status === 'direction_pending_approval') {
      if (directionDirty) secondaryActions.push({ label: '保存方向', dataAction: 'save-direction', onClick: saveDirection, disabled: !directionValid(directionDraft) });
      secondaryActions.push({ label: '补充调查', dataAction: 'supplement-direction', onClick: supplementDirection });
      secondaryActions.push({ label: '停止项目', dataAction: 'stop-direction', onClick: () => { void stopDirection(); }, danger: true });
    }
    if (status === 'failed') {
      secondaryActions.push({ label: '停止调查', dataAction: 'stop-research', onClick: () => { void stopResearch(); }, danger: true });
    }
    if (status === 'ready_to_write' || status === 'writing' || status === 'completed' || status === 'abandoned') {
      secondaryActions.push({ label: '回到正文', dataAction: 'back-to-writing', onClick: () => onOpenWriting?.() });
    }
    if (secondaryActions.length === 0 && !primaryAction) return null;
    return (
      <div className="investigation-actions">
        {primaryAction && (
          <button type="button" className="primary-button investigation-primary-action" data-action={primaryAction.dataAction}
            disabled={actionBusy
              || (primaryAction.dataAction === 'save-outline' && !outlineDirty)
              || (primaryAction.dataAction === 'save-direction' && !directionDirty)
              || (primaryAction.dataAction === 'accept-research' && acceptDisabled)}
            onClick={primaryAction.onClick}>
            {actionBusy ? '处理中…' : primaryAction.label}
          </button>
        )}
        {secondaryActions.map((action) => (
          <button key={action.dataAction} type="button" className={action.danger ? 'danger-button' : 'secondary-button'} data-action={action.dataAction}
            disabled={actionBusy || action.disabled === true}
            onClick={action.onClick}>
            {action.label}
          </button>
        ))}
      </div>
    );
  };

  const renderOutlineEditor = () => (
    <section className="investigation-section" aria-label="调查提纲">
      <h3 className="investigation-section-title">调查提纲{model.outlineVersion ? ` v${model.outlineVersion}` : ''}</h3>
      <p className="investigation-meta-line">调查地图而非文章提纲：先明确要弄清什么、已知与假设、必答问题、材料要求、真实性风险、推翻条件与完成标准。</p>
      {renderEditor(false)}
    </section>
  );

  const renderReporterCard = () => (
    <section className="investigation-section" aria-label="调查进度">
      <h3 className="investigation-section-title">调查进度</h3>
      <div className="investigation-progress-line">
        {model.reporter?.round ? <span>第 {model.reporter.round} 轮</span> : null}
        <span>{REPORTER_STATUS_LABELS[model.reporter?.status ?? 'queued'] ?? model.reporter?.status ?? '排队中'}</span>
        {model.reporter?.startedAt && <small>开始 {formatTime(model.reporter.startedAt)}</small>}
        {model.reporter?.finishedAt && <small>结束 {formatTime(model.reporter.finishedAt)}</small>}
      </div>
      {model.reporter?.jobId && (
        <details className="investigation-job-details">
          <summary>任务详情</summary>
          <small>工单 {model.reporter.jobId}</small>
        </details>
      )}
      {model.reporter?.errorMessage && <p className="investigation-note danger">{model.reporter.errorMessage}</p>}
      <p className="investigation-meta-line">正在核验来源与冲突信息，完成后将提交资料包供你验收。</p>
    </section>
  );

  const renderApprovedOutline = () => (
    <section className="investigation-section" aria-label="已批准提纲">
      <h3 className="investigation-section-title">已批准提纲{model.outlineVersion ? ` v${model.outlineVersion}` : ''}（不可修改）</h3>
      {renderReadonlyOutline()}
    </section>
  );

  const renderDirectionEditor = () => (
    <section className="investigation-section" aria-label="调查后写作方向">
      <h3 className="investigation-section-title">调查后写作方向{model.directionVersion ? ` v${model.directionVersion}` : ''}</h3>
      <p className="investigation-meta-line">基于全部最新材料重新判断本稿应当写什么；记者不对原角度负责，未知必须保持未知。</p>
      {!directionValid(directionDraft) && (status === 'research_review' || status === 'needs_user' || directionDirty) && (
        <div className="investigation-note amber" role="status">验收/保存前需填写：新的核心问题、受众价值、文章范围（其余列表可为空）。</div>
      )}
      {renderEditor(true)}
    </section>
  );

  return (
    <section className="studio-investigation" aria-label="依据与进度">
      <header className="investigation-header">
        <div className="investigation-status" data-status={status}>
          <span className={`investigation-status-pill investigation-status-data tone-${tone}`} data-status={status}><i className="investigation-dot" aria-hidden="true" />{status === 'outline_pending_approval' && !model.outline ? '调查提纲待生成' : investigationStatusLabel(status)}</span>
          <span className="investigation-status-meta">调查档案修订 {model.revision}{model.outlineVersion ? ` · 提纲 v${model.outlineVersion}` : ''}{model.directionVersion ? ` · 方向 v${model.directionVersion}` : ''}</span>
        </div>
        {status !== 'researching' && <p className="investigation-hint">{hint}</p>}
        {feedback && <p className={`investigation-feedback ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}
        {renderActionRow()}
      </header>
      <details className="investigation-evidence-details" open={status === 'needs_user' || status === 'failed'}>
        <summary>查看完整依据与调查记录</summary>
      <div className="investigation-body">
        {status === 'outline_pending_approval' && renderOutlineEditor()}
        {status === 'outline_rejected' && (
          <>
            <div className="investigation-note danger" role="status">提纲已被驳回：修改后保存将形成新版本，再次呈报审批。</div>
            {renderOutlineEditor()}
          </>
        )}
        {status === 'researching' && (
          <>
            {renderReporterCard()}
            {approvedOutline && renderApprovedOutline()}
          </>
        )}
        {(status === 'research_review' || status === 'needs_more_research') && (
          <>
            {approvedOutline && renderApprovedOutline()}
            {renderPackage()}
            {status === 'needs_more_research' && (
              <>
                <div className="investigation-note amber" role="status">主管验收要求补查：已按原已批准范围补派记者，无需 Owner 重新批准。</div>
                {model.reporter ? renderReporterCard() : null}
              </>
            )}
            {renderDirectionEditor()}
          </>
        )}
        {status === 'needs_user' && (
          <>
            <div className="investigation-note amber" role="status">{model.package?.review?.decision === 'defer'
              ? '当前证据不足以安全进入自动写作，或调查结果要求实质调整核心方向。请选择：按当前证据收窄写作、补查关键事实、调整核心方向或停止项目。数字、引语、具体案例和归因等外部可验证事实仍必须由证据支持。'
              : '调查遇到范围变化、关键访问阻塞、外部权限或费用边界，系统已停止自动推进并等待你的明确决策。'}</div>
            {model.package && renderPackage()}
            {approvedOutline && renderApprovedOutline()}
            {model.package && renderDirectionEditor()}
          </>
        )}
        {status === 'direction_pending_approval' && (
          <>
            {approvedOutline && renderApprovedOutline()}
            {renderPackage()}
            {model.directionStatus === 'supplemented' && <div className="investigation-note amber" role="status">方向被退回补充调查：请基于补查结果修改写作方向，保存后重新呈报审批。</div>}
            {renderDirectionEditor()}
          </>
        )}
        {status === 'ready_to_write' && (
          <>
            {approvedOutline && renderApprovedOutline()}
            {renderPackage()}
            {approvedDirection && (
              <section className="investigation-section" aria-label="已批准写作方向">
                <h3 className="investigation-section-title">已批准写作方向{model.directionVersion ? ` v${model.directionVersion}` : ''}（不可修改）</h3>
                {renderReadonlyDirection()}
              </section>
            )}
          </>
        )}
        {status === 'writing' && (
          <>
            <div className="investigation-note accent" role="status">写手任务已派出，正文写作中。完成后请到「正文」工作面查看与审稿。</div>
            {model.writer && (
              <section className="investigation-section" aria-label="写手状态">
                <h3 className="investigation-section-title">写手任务</h3>
                <div className="investigation-reporter">
                  <span className="investigation-reporter-status">{REPORTER_STATUS_LABELS[model.writer.status ?? 'queued'] ?? model.writer.status ?? '排队中'}</span>
                  {model.writer.jobId && <small>工单 {model.writer.jobId.slice(0, 10)}</small>}
                  {model.writer.startedAt && <small>开始 {formatTime(model.writer.startedAt)}</small>}
                  {model.writer.finishedAt && <small>结束 {formatTime(model.writer.finishedAt)}</small>}
                </div>
              </section>
            )}
            {approvedOutline && renderApprovedOutline()}
            {approvedDirection && (
              <section className="investigation-section" aria-label="已批准写作方向">
                <h3 className="investigation-section-title">已批准写作方向{model.directionVersion ? ` v${model.directionVersion}` : ''}（不可修改）</h3>
                {renderReadonlyDirection()}
              </section>
            )}
          </>
        )}
        {status === 'completed' && (
          <>
            <div className="investigation-note success" role="status">调查流程已完成；项目进入正文写作与审稿阶段。</div>
            {approvedDirection && (
              <section className="investigation-section" aria-label="已批准写作方向">
                <h3 className="investigation-section-title">已批准写作方向{model.directionVersion ? ` v${model.directionVersion}` : ''}（不可修改）</h3>
                {renderReadonlyDirection()}
              </section>
            )}
          </>
        )}
        {status === 'abandoned' && (
          <div className="investigation-note gray" role="status">调查已停止：写作方向未获确认，或调查结果表明不值得继续。项目不再派写手。</div>
        )}
        {status === 'failed' && (
          <div className="investigation-note danger" role="status">记者执行失败且无可用交付；可重试或停止调查。</div>
        )}
        {renderHistory()}
      </div>
      </details>
    </section>
  );
}
