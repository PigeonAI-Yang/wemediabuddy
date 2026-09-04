import { useEffect, useMemo, useState } from 'react';
import { formatScoreWithPending, getScoreReasons } from './proposal-ledger';
type StageResult = {
  stage: string;
  name: string;
  status: string;
  count?: number;
  gap?: number;
  blocked?: number;
  skipped?: number;
  carried?: number;
  errorCode?: string | null;
  detail?: string;
};
type Settlement = {
  businessDate: string;
  workspaceId: string;
  source: string;
  status: 'paused' | 'needs_user' | 'partial' | 'completed' | 'failed';
  stages: StageResult[];
  counts: {
    targetCount: number;
    completed: number;
    gap: number;
    skipped: number;
    carried: number;
    blocked: number;
    autoSelected: number;
    ownerSelected: number;
  };
  readable: string;
  createdAt: string;
  updatedAt: string;
};

const STAGE_LABELS: Record<string, string> = { A: '昨日迭代', B: '热榜扫描', C: '评分选题', D: '研究与文章', E: '视频文案' };
const STAGE_STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  partial: '部分完成',
  needs_user: '需人工介入',
  failed: '失败',
  skipped: '已跳过',
  paused: '已暂停',
};
const SETTLEMENT_STATUS_LABEL: Record<Settlement['status'], string> = {
  completed: '已完成',
  needs_user: '需人工介入',
  partial: '部分完成',
  paused: '已暂停',
  failed: '失败',
};

function resolveBusinessDate(explicit?: string): string {
  if (explicit && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}


function storageKey(businessDate: string): string {
  return `wmb.daily-orchestration.settlement:${businessDate}`;
}

function loadPersisted(businessDate: string): Settlement | null {
  try {
    const raw = window.localStorage.getItem(storageKey(businessDate));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Settlement;
    if (parsed && parsed.businessDate === businessDate && Array.isArray(parsed.stages)) return parsed;
    return null;
  } catch { return null; }
}


export function TodayDailyCycle({
  businessDate: businessDateProp,
  openStudio,
  openSettings,
}: {
  businessDate?: string;
  openStudio?: (projectId?: string) => void;
  openSettings?: (sectionId: string) => void;
  refreshTick?: number;
}) {
  const businessDate = useMemo(() => resolveBusinessDate(businessDateProp), [businessDateProp]);
  const [settlement, setSettlement] = useState<Settlement | null>(() => loadPersisted(businessDate));


  useEffect(() => {
    setSettlement(loadPersisted(businessDate));
  }, [businessDate]);


  const s = settlement;
  const stageRows: StageResult[] = (() => {
    if (s && Array.isArray(s.stages) && s.stages.length === 5) return s.stages;
    if (s && Array.isArray(s.stages) && s.stages.length > 0) {
      const map = new Map(s.stages.map((x) => [x.stage, x] as const));
      return (['A','B','C','D','E'] as const).map((k) => map.get(k) ?? { stage: k, name: STAGE_LABELS[k], status: 'completed' as const });
    }
    return (['A','B','C','D','E'] as const).map((k) => ({ stage: k, name: STAGE_LABELS[k], status: '—' }));
  })();

  const needsUserStages = stageRows.filter((r) => r.status === 'needs_user');
  const hasNeedsUser = s?.status === 'needs_user' || needsUserStages.length > 0;

  return (
    <section className="today-daily-cycle today-orchestration" aria-labelledby="today-daily-cycle-title">
      <header className="today-daily-cycle-head today-orchestration-head">
        <h2 id="today-daily-cycle-title" className="today-daily-cycle-title">每日编排</h2>
        <span className="today-orchestration-schedule-label" aria-live="polite">
          完整链路入口已暂停
        </span>
      </header>

      <div className="today-orchestration-controls">
        <p className="today-orchestration-run-hint">请从资料、选题台账和创作入口分步处理；已有结算记录仍可查看。</p>
      </div>


      {s ? (
        <div className="today-orchestration-settlement" aria-live="polite">
          <div className="today-orchestration-settlement-head">
            <span className="today-orchestration-settlement-label">最近结算</span>
            <span className={`today-orchestration-status today-orchestration-status--${s.status}`}>{SETTLEMENT_STATUS_LABEL[s.status] ?? s.status}</span>
            <span className="today-orchestration-date">{s.businessDate} · {s.source}</span>
            <span className="today-orchestration-counts">目标 {s.counts.targetCount} · 已完成 {s.counts.completed} · 缺口 {s.counts.gap} · 跳过 {s.counts.skipped} · 顺延 {s.counts.carried} · 阻塞 {s.counts.blocked}</span>
          </div>
          <p className="today-orchestration-readable">{s.readable}</p>

          {s.status === 'needs_user' ? (
            <div className="today-orchestration-banner today-orchestration-banner--needs_user" role="status">
              <span>需人工介入：{needsUserStages.length ? `${needsUserStages.map((x) => `${x.stage}${STAGE_LABELS[x.stage] ?? ''}`).join('、')} 需要处理` : '请检查浏览器登录或渠道配置'}</span>
              <div className="today-orchestration-banner-actions">
                {openSettings ? <button type="button" className="secondary-button" onClick={() => openSettings('browser')}>去设置检查浏览器</button> : null}
              </div>
            </div>
          ) : null}
          {s.status === 'partial' ? (
            <div className="today-orchestration-banner today-orchestration-banner--partial" role="status">
              <span>部分完成：{s.counts.gap > 0 ? `缺口 ${s.counts.gap} 条` : ''}{s.counts.blocked > 0 ? ` · 阻塞 ${s.counts.blocked}` : ''} · 可继续完善或顺延</span>
              <div className="today-orchestration-banner-actions">
                <button type="button" className="secondary-button" onClick={() => openStudio?.()}>去选题</button>
              </div>
            </div>
          ) : null}
          {s.status === 'paused' ? (
            <div className="today-orchestration-banner today-orchestration-banner--paused" role="status">
              <span>完整链路入口已暂停，请改用资料、选题台账和创作入口。</span>
            </div>
          ) : null}
          {s.status === 'failed' ? (
            <div className="today-orchestration-banner today-orchestration-banner--failed" role="status">
              <span>执行失败：请重试或检查日志</span>
            </div>
          ) : null}

          <ul className="today-orchestration-stages" role="list" aria-label="五段编排明细 A–E">
            {stageRows.map((st) => (
              <li key={st.stage} className="today-orchestration-stage" role="listitem" data-stage={st.stage}>
                <div className="today-orchestration-stage-main">
                  <span className="today-orchestration-stage-key">{st.stage}</span>
                  <span className="today-orchestration-stage-name">{STAGE_LABELS[st.stage] ?? st.name ?? st.stage}</span>
                  <span className={`today-orchestration-stage-status today-orchestration-stage-status--${st.status}`}>{STAGE_STATUS_LABEL[st.status] ?? st.status}</span>
                </div>
                <div className="today-orchestration-stage-meta">
                  {typeof st.count === 'number' ? <span>计数 {st.count}</span> : null}
                  {typeof st.gap === 'number' ? <span>缺口 {st.gap}</span> : null}
                  {typeof st.blocked === 'number' && st.blocked > 0 ? <span>阻塞 {st.blocked}</span> : null}
                  {typeof st.skipped === 'number' && st.skipped > 0 ? <span>跳过 {st.skipped}</span> : null}
                  {typeof st.carried === 'number' && st.carried > 0 ? <span>顺延 {st.carried}</span> : null}
                  {st.errorCode ? <span className="today-orchestration-stage-error">{st.errorCode}</span> : null}
                  {st.stage === 'C' && (st.status === 'partial' || st.status === 'needs_user' || (typeof st.gap === 'number' && st.gap > 0) || st.count === 0) ? (
                    <span className="today-orchestration-pending-score" aria-label="评分待补证据">评分：待补证据（—）</span>
                  ) : null}
                </div>
                {st.stage === 'C' && typeof st.count === 'number' && st.count > 0 && st.status === 'completed' ? (
                  <p className="today-orchestration-score-honest" role="status">评分已完成 · 仅已批准计入正式选题</p>
                ) : null}
                {st.detail ? <p className="today-orchestration-stage-detail">{st.detail}</p> : null}
                <div className="today-orchestration-stage-actions">
                  {st.stage === 'A' && st.status !== 'completed' ? <button type="button" className="text-button" onClick={() => openStudio?.()}>打开工作室</button> : null}
                  {st.stage === 'B' && st.status === 'needs_user' && openSettings ? <button type="button" className="text-button" onClick={() => openSettings('browser')}>检查登录</button> : null}
                  {st.stage === 'D' && typeof st.blocked === 'number' && st.blocked > 0 ? <button type="button" className="text-button" onClick={() => openStudio?.()}>查看阻塞</button> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="today-orchestration-empty">暂无结算记录 · 点击“立即执行”触发 A–E 五段编排</p>
      )}
      {hasNeedsUser && !s ? null : null}
    </section>
  );
}
