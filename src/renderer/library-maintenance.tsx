// WMB-5239：资料库「全库整理」原位入口 + 统一搜索全部资料 + 最近变化（library-view.tsx 消费）。
// 定位：资料库是唯一维护执行面（Review 边界）—— 全库整理入口、阶段进度、暂停/继续、
//   失败项、整理报告、批量摄取反馈、统一搜索入口；主题/画布绝不出现维护控件。
// 契约：
// - 只读复用 WMB-5236 维护 IPC（start/status/pause/resume）+ WMB-5238 搜索/日志（经
//   wiki-discovery 共享面板），无任何写通道之外的调用；start 幂等（活动 run 重复 start 返回同一 run）；
// - 进度刷新：run 生命周期广播 scopes=['knowledge','topics','health','receipt','library']（经
//   shouldRefreshLibrary 判定即刷）；tick 无专播 → 有界轮询 getKnowledgeMaintenanceStatus，
//   节奏 MAINTENANCE_POLL_INTERVAL_MS=10s（≥ 调度器 INTERVAL），暂停/完成/卸载即清理；
//   data_changed 50ms burst 合并，不依赖单 reason；
// - 用户语言：全库整理/搜索全部资料/最近变化/整理报告/失败项/暂停/继续；禁 compiled/receipt/
//   changeset/hot-cache/index/cursor/scan_compile/lint/phase 等工程词（映射见 library-maintenance-parts）；
// - 深链：统一搜索/日志结果经 wiki-discovery 的 CustomEvent 桥（main.tsx 已由 Wire 注册监听），
//   本组件不新增顶层路由/导航；
// - WIKI_MAINTENANCE_EVENT：日志条目（maintenance 事件）点击 → 展开全库整理面板（可选监听）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeMaintenanceStatusView } from '../shared/knowledge-maintenance';
import {
  KnowledgeLogPanel,
  WIKI_MAINTENANCE_EVENT,
  WikiSearchPanel,
} from './wiki-discovery';
import { shouldRefreshLibrary } from './library-view-parts';
import {
  MAINTENANCE_PHASE_ORDER,
  MAINTENANCE_POLL_INTERVAL_MS,
  maintenanceFailureLabel,
  maintenanceIngestionSummary,
  maintenanceIngestionText,
  maintenanceLintText,
  maintenancePhaseIndex,
  maintenancePhaseLabel,
  maintenanceReportSummary,
  maintenanceStatusCls,
  maintenanceStatusLabel,
  maintenanceUserText,
} from './library-maintenance-parts';

export type MaintenanceAction = 'start' | 'pause' | 'resume';

export type MaintenanceStatusHook = ReturnType<typeof useMaintenanceStatus>;

/** 全库维护状态 hook：首载 + data_changed 刷新 + running 时有界轮询（≥10s；暂停/完成/卸载清理）。 */
export function useMaintenanceStatus() {
  const [view, setView] = useState<KnowledgeMaintenanceStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<MaintenanceAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (mode: 'initial' | 'background') => {
    const requestSeq = ++seq.current;
    if (mode === 'initial') setLoading(true);
    setError(null);
    try {
      const next = await window.wmb.getKnowledgeMaintenanceStatus();
      if (requestSeq !== seq.current) return;
      setView(next);
    } catch (cause) {
      if (requestSeq !== seq.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestSeq === seq.current) setLoading(false);
    }
  }, []);

  // 首载 + data_changed 订阅刷新（维护生命周期广播均含 library/knowledge 等 scope）。
  useEffect(() => {
    void load('initial');
    const api = window.wmb;
    if (!api?.onDataChanged) return;
    return api.onDataChanged((event) => {
      if (!shouldRefreshLibrary(event.scopes)) return;
      void load('background');
    });
  }, [load]);

  // 有界轮询：仅 running 时 ≥10s 一查；暂停/完成/失败/卸载即清理（tick 无专播，轮询补进度）。
  const running = view?.run?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load('background'), MAINTENANCE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const act = useCallback(async (action: MaintenanceAction) => {
    setActionBusy(action);
    setActionError('');
    try {
      if (action === 'start') await window.wmb.startKnowledgeMaintenance({});
      else if (action === 'pause') await window.wmb.pauseKnowledgeMaintenance();
      else await window.wmb.resumeKnowledgeMaintenance();
      await load('initial');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionBusy(null);
    }
  }, [load]);

  const retry = useCallback(() => {
    void load('initial');
  }, [load]);

  return { view, loading, error, actionBusy, actionError, act, retry };
}

/** 阶段进度条：整理资料 → 检查健康 → 生成报告 → 已完成（无工程词；当前阶段 aria-current）。 */
function MaintenancePhases({ phase, status }: { phase: string | null; status: string | null }): React.JSX.Element {
  const activeIndex = maintenancePhaseIndex(phase);
  const completed = status === 'completed';
  const hasRun = Boolean(phase);
  return (
    <ol className="library-maintenance-phases" aria-label="整理阶段">
      {MAINTENANCE_PHASE_ORDER.map((id, index) => {
        const state = !hasRun ? 'pending' : completed || index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending';
        return (
          <li
            key={id}
            className={`library-maintenance-phase ${state}`}
            data-maintenance-phase={id}
            aria-current={hasRun && index === activeIndex && !completed ? 'step' : undefined}
          >
            <span className="library-maintenance-phase-dot" aria-hidden="true" />
            {maintenancePhaseLabel(id)}
          </li>
        );
      })}
    </ol>
  );
}

/** 全库整理面板：状态 + 阶段进度 + 开始/暂停/继续 + 批量摄取反馈 + 失败项 + 整理报告。 */
function MaintenancePanel({ hook }: { hook: MaintenanceStatusHook }): React.JSX.Element {
  const { view, loading, error, actionBusy, actionError, act, retry } = hook;
  if (loading && !view) {
    return <section className="library-wiki-panel" data-wiki-panel="maintenance"><p className="library-maintenance-loading">正在读取整理状态…</p></section>;
  }
  if (error && !view) {
    return (
      <section className="library-wiki-panel" data-wiki-panel="maintenance">
        <div className="wiki-discovery-error" role="alert">
          <strong>整理状态读取失败</strong>
          <p>{error}</p>
          <button type="button" className="wiki-discovery-retry" onClick={retry}>重试</button>
        </div>
      </section>
    );
  }
  const run = view?.run ?? null;
  const phase = run?.phase ?? null;
  const status = run?.status ?? null;
  const summary = maintenanceIngestionSummary(view?.backfill);
  const reportSummary = maintenanceReportSummary(view?.report);
  const canStart = !run || status === 'completed';
  const canPause = status === 'running';
  const canResume = status === 'paused' || status === 'failed';

  return (
    <section className="library-wiki-panel library-maintenance-panel" data-wiki-panel="maintenance" aria-label="全库整理">
      <div className="library-maintenance-head">
        <span className={`pill-status ${maintenanceStatusCls(status)}`} data-maintenance-status={status ?? 'none'}>
          <span className="dot" />
          {maintenanceStatusLabel(status)}
          {run ? ` · ${maintenancePhaseLabel(phase)}` : ''}
        </span>
      </div>

      <MaintenancePhases phase={phase} status={status} />

      <div className="library-maintenance-actions">
        {canStart ? (
          <button
            type="button"
            className="primary-button"
            data-maintenance-action="start"
            disabled={actionBusy !== null}
            onClick={() => void act('start')}
          >
            {actionBusy === 'start' ? '开始中…' : run ? '再次整理' : '开始全库整理'}
          </button>
        ) : null}
        {canPause ? (
          <button
            type="button"
            className="secondary-button"
            data-maintenance-action="pause"
            disabled={actionBusy !== null}
            onClick={() => void act('pause')}
          >
            {actionBusy === 'pause' ? '暂停中…' : '暂停'}
          </button>
        ) : null}
        {canResume ? (
          <button
            type="button"
            className="secondary-button"
            data-maintenance-action="resume"
            disabled={actionBusy !== null}
            onClick={() => void act('resume')}
          >
            {actionBusy === 'resume' ? '继续中…' : '继续'}
          </button>
        ) : null}
      </div>

      {actionError ? <p className="library-maintenance-action-error" role="alert">{actionError}</p> : null}

      {!run ? (
        <p className="library-maintenance-empty">尚未进行过全库整理。开始后会在后台依次整理资料、检查健康，并生成整理报告；可随时暂停或继续。</p>
      ) : (
        <>
          <div className="library-ingestion-feedback" data-ingestion-feedback>
            <strong>批量摄取反馈</strong>
            <span className="ok">成功整理 {summary.success} 条</span>
            {summary.keptRaw > 0 ? <span className="warn">低价值保留原始 {summary.keptRaw} 条</span> : null}
            {summary.failed > 0 ? <span className="bad">失败 {summary.failed} 条{summary.retry > 0 ? `（${summary.retry} 条待重试）` : ''}</span> : null}
            {summary.scanned > 0 ? <span className="scan">已检查 {summary.scanned} 条</span> : null}
          </div>

          {status === 'failed' && run.error ? (
            <div className="library-maintenance-failure" role="alert" data-maintenance-failed>
              <strong>{maintenanceFailureLabel(run.error.code)}</strong>
              <p>{maintenanceUserText(run.error.message)}</p>
            </div>
          ) : null}

          {view?.report ? (
            <details className="library-maintenance-report" data-maintenance-report>
              <summary>整理报告</summary>
              <dl className="library-maintenance-report-grid">
                <div><dt>本轮整理</dt><dd>{maintenanceIngestionText(maintenanceIngestionSummary(view.report.backfill))}</dd></div>
                <div><dt>检查健康</dt><dd>{maintenanceLintText(view.report.lint)}</dd></div>
                <div><dt>改动资料</dt><dd>{reportSummary.changed} 条</dd></div>
                {reportSummary.failures.length > 0 ? (
                  <div><dt>失败项</dt><dd>{reportSummary.failures.map((failure) => maintenanceFailureLabel(failure.code)).join('；')}</dd></div>
                ) : null}
                {reportSummary.risks.length > 0 ? (
                  <div><dt>风险</dt><dd><ul className="library-maintenance-risks">{reportSummary.risks.map((risk, index) => <li key={index}>{maintenanceUserText(risk)}</li>)}</ul></dd></div>
                ) : null}
              </dl>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

type WikiToolKey = 'maintenance' | 'search' | 'log';

/** 资料库全库工具条：全库整理（默认闭合显示状态）+ 搜索全部资料 + 最近变化（渐进展开，一次一项）。 */
export function LibraryWikiTools(): React.JSX.Element {
  const [open, setOpen] = useState<WikiToolKey | null>(null);
  const hook = useMaintenanceStatus();
  const status = hook.view?.run?.status ?? null;
  const phase = hook.view?.run?.phase ?? null;

  // 日志条目（maintenance 事件）点击 → 展开全库整理面板。
  useEffect(() => {
    const openMaintenance = () => setOpen('maintenance');
    window.addEventListener(WIKI_MAINTENANCE_EVENT, openMaintenance);
    return () => window.removeEventListener(WIKI_MAINTENANCE_EVENT, openMaintenance);
  }, []);

  const toggle = (key: WikiToolKey) => setOpen((current) => (current === key ? null : key));

  return (
    <div className="library-wiki-tools" role="group" aria-label="资料库工具">
      <div className="library-wiki-toolbar">
        <button
          type="button"
          className={`library-wiki-tool-toggle${open === 'maintenance' ? ' on' : ''}`}
          data-wiki-tool="maintenance"
          aria-expanded={open === 'maintenance'}
          aria-controls="library-maintenance-panel"
          onClick={() => toggle('maintenance')}
        >
          全库整理
          <span className={`pill-status ${maintenanceStatusCls(status)}`} data-maintenance-status={status ?? 'none'}>
            <span className="dot" />
            {maintenanceStatusLabel(status)}
            {status ? ` · ${maintenancePhaseLabel(phase)}` : ''}
          </span>
        </button>
        <button
          type="button"
          className={`library-wiki-tool-toggle${open === 'search' ? ' on' : ''}`}
          data-wiki-tool="search"
          aria-expanded={open === 'search'}
          aria-controls="library-search-panel"
          onClick={() => toggle('search')}
        >
          搜索全部资料
        </button>
        <button
          type="button"
          className={`library-wiki-tool-toggle${open === 'log' ? ' on' : ''}`}
          data-wiki-tool="log"
          aria-expanded={open === 'log'}
          aria-controls="library-log-panel"
          onClick={() => toggle('log')}
        >
          最近变化
        </button>
      </div>

      {open === 'maintenance' ? <div id="library-maintenance-panel"><MaintenancePanel hook={hook} /></div> : null}
      {open === 'search' ? (
        <section className="library-wiki-panel" id="library-search-panel" data-wiki-panel="search" aria-label="搜索全部资料">
          <WikiSearchPanel compact />
        </section>
      ) : null}
      {open === 'log' ? (
        <section className="library-wiki-panel" id="library-log-panel" data-wiki-panel="log" aria-label="最近变化">
          <KnowledgeLogPanel compact />
        </section>
      ) : null}
    </div>
  );
}
