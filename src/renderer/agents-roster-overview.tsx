import type { JSX } from 'react';
import { ROLE_CATALOG, type RoleId } from '../shared/agent-capabilities';
import { instanceStatusWord, roleOverviewStatus, sortInstancesForDisplay, type CrewProjection, type EmployeeRole } from './agents-instance-logic';
import { progressPresentation, StatusDot, type ProgressPresentation, type RosterRow } from './agents-roster-parts';

/** 员工高卡骨架：整卡 button（无嵌套交互元素），头像居中，进度轨主导，状态行收尾。 */
function RoleCard({
  roleId,
  meta,
  avatar,
  className,
  dotStatus,
  word,
  present,
  summary,
  expanded,
  onOpenRole
}: {
  roleId: RoleId;
  meta: { labelZh: string; roomZh: string };
  avatar?: string;
  className?: string;
  dotStatus: string;
  word: string;
  present: ProgressPresentation;
  summary: string | null;
  expanded: boolean;
  onOpenRole: (roleId: RoleId) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`agents-role-card${className ? ` ${className}` : ''}`}
      data-role={roleId}
      aria-expanded={expanded}
      aria-haspopup="dialog"
      aria-controls="agents-detail-modal-dialog"
      onClick={() => onOpenRole(roleId)}
    >
      <span className="agents-card-avatar">{avatar ? <img src={avatar} alt="" /> : <span>{meta.labelZh.slice(0, 1)}</span>}</span>
      <span className="agents-card-name">{meta.labelZh}</span>
      <span className="agents-card-room">{meta.roomZh}</span>
      <span className="agents-card-progress">
        <span
          className={`agents-work-progress${present.indeterminate ? ' indeterminate' : ''}`}
          role="progressbar"
          aria-label={`${meta.labelZh}进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={present.determinate && present.ratio != null ? Math.round(present.ratio * 100) : undefined}
          style={present.determinate && present.ratio != null ? { ['--progress' as string]: present.ratio } : undefined}
        >
          <i />
        </span>
      </span>
      <span className="agents-card-statusline">
        <StatusDot status={dotStatus} />
        {word === '当前无任务' ? (
          <span className="agents-role-empty">当前无任务</span>
        ) : (
          <span className={`agents-status-word status-${dotStatus}`}>{word}</span>
        )}
        <span className="agents-card-pct">{present.percent}</span>
        {summary ? <span className="agents-card-summary" title={summary}>{summary}</span> : null}
      </span>
    </button>
  );
}

/**
 * 概览高卡：五角色始终可见的等宽卡片（WMB-5195）。
 * 主管 = 主管/主编席（非实例，空轨 0%）；员工行由真实投影实例驱动：leader 状态词 + 真实进度，
 * running 无真实比例 → 不确定轨且不显示百分比；空角色空轨 0%（不占大段文字）。
 */
export function RoleOverviewRow({
  roleId,
  row,
  deskOccupied,
  deskConflict,
  projection,
  avatarByRole,
  expanded,
  onOpenRole
}: {
  roleId: RoleId;
  row: RosterRow | null;
  deskOccupied: boolean;
  deskConflict: boolean;
  projection: CrewProjection | null;
  avatarByRole: Partial<Record<RoleId, string>>;
  expanded: boolean;
  onOpenRole: (roleId: RoleId) => void;
}): JSX.Element {
  const deskRow = roleId === 'desk' ? row : null;
  const meta = roleId === 'desk' ? { labelZh: deskRow?.labelZh ?? ROLE_CATALOG.desk.labelZh, roomZh: deskRow?.roomZh ?? ROLE_CATALOG.desk.roomZh } : ROLE_CATALOG[roleId];
  const avatar = avatarByRole[roleId];
  if (roleId === 'desk') {
    const deskState = deskOccupied ? (deskConflict ? '受阻' : '工作中') : '当前无任务';
    const present = progressPresentation(row?.progressRatio, deskOccupied && !deskConflict);
    const summary = deskOccupied && !deskConflict && row?.summary && row.summary !== '当前无任务' ? row.summary : null;
    return (
      <button
        type="button"
        className="agents-role-card is-desk"
        data-role={roleId}
        aria-expanded={expanded}
        aria-haspopup="dialog"
        aria-controls="agents-detail-modal-dialog"
        onClick={() => onOpenRole(roleId)}
      >
        <span className="agents-card-avatar">{avatar ? <img src={avatar} alt="" /> : <span>{meta.labelZh.slice(0, 1)}</span>}</span>
        <span className="agents-card-name">{meta.labelZh}</span>
        <span className="agents-card-room">{meta.roomZh}</span>
        <span className="agents-card-progress">
          <span
            className={`agents-work-progress${present.indeterminate ? ' indeterminate' : ''}`}
            role="progressbar"
            aria-label={`${meta.labelZh}进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={present.determinate && present.ratio != null ? Math.round(present.ratio * 100) : undefined}
            style={present.determinate && present.ratio != null ? { ['--progress' as string]: present.ratio } : undefined}
          >
            <i />
          </span>
        </span>
        <span className="agents-card-statusline">
          <StatusDot status={deskOccupied ? (deskConflict ? 'blocked' : 'running') : 'idle'} />
          <span className={`agents-status-word status-${deskOccupied ? (deskConflict ? 'blocked' : 'running') : 'idle'}`}>{deskState}</span>
          <span className="agents-card-pct">{present.percent}</span>
          {summary ? <span className="agents-card-summary" title={summary}>{summary}</span> : null}
        </span>
      </button>
    );
  }
  const role = roleId as EmployeeRole;
  const active = projection?.byRole[role].active ?? [];
  const overview = roleOverviewStatus(active, 'all');
  const leader = overview.kind === 'active' ? sortInstancesForDisplay(active)[0] ?? null : null;
  const legacyBusy = active.length === 0 && (row?.status === 'running' || row?.status === 'blocked');
  let dotStatus: string;
  let word: string;
  let present: ProgressPresentation;
  let summary: string | null = null;
  if (leader) {
    const running = leader.status === 'running';
    dotStatus = leader.status;
    word = instanceStatusWord(leader);
    present = progressPresentation(leader.progressRatio, running);
    if (running) summary = leader.progressLabel ?? leader.phase;
  } else if (legacyBusy) {
    dotStatus = row?.status === 'blocked' ? 'needs_user' : 'running';
    word = row?.status === 'blocked' ? '等你批' : '工作中';
    present = progressPresentation(row?.progressRatio, row?.status === 'running');
    summary = row?.summary && row.summary !== '当前无任务' ? row.summary : null;
  } else {
    dotStatus = 'idle';
    word = '当前无任务';
    present = progressPresentation(null, false);
  }
  return (
    <RoleCard
      roleId={roleId}
      meta={meta}
      avatar={avatar}
      className={active.length > 0 ? 'has-instances' : undefined}
      dotStatus={dotStatus}
      word={word}
      present={present}
      summary={summary}
      expanded={expanded}
      onOpenRole={onOpenRole}
    />
  );
}
