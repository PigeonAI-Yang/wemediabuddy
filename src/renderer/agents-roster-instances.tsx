import type { JSX } from 'react';
import { ROLE_CATALOG } from '../shared/agent-capabilities';
import { instanceDetail, instanceTiming, statusWord, type ActiveRoleSection, type CrewInstance } from './agents-instance-logic';
import { StatusDot, clock, roleLabel, stampLine } from './agents-roster-parts';

/** 历史折叠区最近条数（只展示终态实例，越近越相关）。 */
const HISTORY_LIMIT = 5;

/** 单张实例卡：同角色可并列（组内 wrap 网格），状态双编码 + 进度 + 时间戳 + 动作。 */
export function InstanceCard({
  inst,
  busy,
  onCopyJobId,
  onRedispatch,
  onCancel
}: {
  inst: CrewInstance;
  busy: boolean;
  onCopyJobId: (jobId: string) => void;
  onRedispatch: (instance: CrewInstance) => void;
  onCancel: (jobId: string) => void;
}): JSX.Element {
  const timing = instanceTiming(inst);
  const detail = instanceDetail(inst);
  const canCancel = inst.status === 'queued' || inst.status === 'waiting_resource' || inst.status === 'running';
  return (
    <li className={`agents-instance-card status-${inst.status}`} data-job={inst.jobId}>
      <header className="agents-instance-head">
        <StatusDot status={inst.status} />
        <strong className="agents-instance-name">
          {roleLabel(inst.roleId)}
          {inst.displayNumber > 0 ? <span className="agents-instance-number"> #{inst.displayNumber}</span> : null}
        </strong>
        <span className={`agents-job-status-word status-${inst.status}`}>{statusWord(inst.status)}</span>
      </header>
      <p className="agents-instance-brief" title={inst.brief}>{inst.brief}</p>
      {inst.status === 'running' && inst.progressRatio != null ? (
        <div className="agents-instance-progress">
          <div
            className="agents-work-progress"
            style={{ ['--progress' as string]: inst.progressRatio }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(inst.progressRatio * 100)}
          >
            <i />
          </div>
          {inst.progressLabel ? <span className="agents-instance-step">{inst.progressLabel}</span> : null}
        </div>
      ) : inst.status === 'running' && inst.progressLabel ? (
        <p className="agents-instance-step">{inst.progressLabel}</p>
      ) : null}
      {detail ? <p className="agents-instance-detail">{detail}</p> : null}
      <div className="agents-instance-meta">
        <span className="agents-job-stamp">
          {stampLine(inst.status === 'running' ? '开始' : '排队', inst.status === 'running' ? inst.startedAt : inst.queuedAt)}
        </span>
        <span className="agents-job-stamp">{timing.prefix} {timing.label}</span>
        {inst.intent ? <span className="agents-job-intent">{inst.intent}</span> : null}
        {inst.code ? <span className="agents-job-intent">{inst.code}</span> : null}
      </div>
      <footer className="agents-instance-actions">
        <button type="button" className="agents-row-action" disabled={busy} onClick={() => void onCopyJobId(inst.jobId)}>
          复制任务编号
        </button>
        {inst.status === 'needs_user' ? (
          <>
            <button type="button" className="agents-row-action strong" disabled={busy} onClick={() => void onRedispatch(inst)}>
              续派
            </button>
            <button type="button" className="agents-row-action" disabled={busy} onClick={() => void onCancel(inst.jobId)}>
              关闭
            </button>
          </>
        ) : canCancel ? (
          <button type="button" className="agents-row-action" disabled={busy} onClick={() => void onCancel(inst.jobId)}>
            取消
          </button>
        ) : null}
      </footer>
    </li>
  );
}

/** 活动实例区角色节：有可见实例的角色才占区（无实例角色不渲染）。 */
export function ActiveRoleInstances({
  section,
  busy,
  onCopyJobId,
  onRedispatch,
  onCancel
}: {
  section: ActiveRoleSection;
  busy: boolean;
  onCopyJobId: (jobId: string) => void;
  onRedispatch: (instance: CrewInstance) => void;
  onCancel: (jobId: string) => void;
}): JSX.Element {
  const { roleId } = section;
  const meta = ROLE_CATALOG[roleId];
  return (
    <section className="agents-role-group" data-role={roleId} aria-labelledby={`agents-role-${roleId}-active`}>
      <header className="agents-active-head">
        <h3 id={`agents-role-${roleId}-active`} className="agents-role-title">{meta.labelZh}</h3>
        {section.total ? <span className="agents-role-count">{section.total}</span> : null}
      </header>
      <ul className="agents-instance-list" aria-label={`${meta.labelZh}任务列表`}>
        {section.visible.map((inst) => (
          <InstanceCard key={inst.jobId} inst={inst} busy={busy} onCopyJobId={onCopyJobId} onRedispatch={onRedispatch} onCancel={onCancel} />
        ))}
      </ul>
    </section>
  );
}

/** 统一历史区：每角色一个折叠（历史 · N，最近 HISTORY_LIMIT 条终态实例；只从持久面投影）。 */
export function RoleHistoryList({
  roleId,
  history,
  busy,
  onCopyJobId,
  onRedispatch
}: {
  roleId: ActiveRoleSection['roleId'];
  history: readonly CrewInstance[];
  busy: boolean;
  onCopyJobId: (jobId: string) => void;
  onRedispatch: (instance: CrewInstance) => void;
}): JSX.Element | null {
  if (!history.length) return null;
  return (
    <details className="agents-role-history">
      <summary>{roleLabel(roleId)} · 历史 · {history.length}</summary>
      <ul className="agents-history-list">
        {history.slice(0, HISTORY_LIMIT).map((h) => (
          <li key={h.jobId} className={`agents-history-row status-${h.status}`}>
            <span className="agents-term-mark" aria-hidden="true">
              {h.status === 'succeeded' ? '✓' : h.status === 'failed' || h.status === 'cancelled' ? '✕' : '◐'}
            </span>
            <span className={`agents-job-status-word status-${h.status}`}>{statusWord(h.status)}</span>
            <span className="agents-history-time">{clock(h.finishedAt)}</span>
            <span className="agents-history-brief" title={h.brief}>{h.brief}</span>
            <span className="agents-history-actions">
              <button type="button" className="agents-row-action" disabled={busy} onClick={() => void onCopyJobId(h.jobId)}>
                复制任务编号
              </button>
              <button type="button" className="agents-row-action strong" disabled={busy} onClick={() => void onRedispatch(h)}>
                续派
              </button>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
