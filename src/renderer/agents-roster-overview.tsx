import type { JSX } from 'react';
import { ROLE_CATALOG, type RoleId } from '../shared/agent-capabilities';
import { roleOverviewStatus, statusWord, type CrewProjection, type EmployeeRole, type StatusFilter } from './agents-instance-logic';
import { StatusDot, type RosterRow } from './agents-roster-parts';

/** 角色卡头：头像（可点换）+ 角色名 + 房间 + 计数；桌助标签只来自 roster 投影行。 */
export function RoleHead({
  roleId,
  deskRow,
  count,
  avatar,
  onPickAvatar
}: {
  roleId: RoleId;
  deskRow: RosterRow | null;
  count?: number;
  avatar?: string;
  onPickAvatar: (roleId: RoleId) => void;
}): JSX.Element {
  const meta = roleId === 'desk' ? { labelZh: deskRow?.labelZh ?? '桌助', roomZh: deskRow?.roomZh ?? '协调入口' } : ROLE_CATALOG[roleId];
  return (
    <header className="agents-role-head">
      <button type="button" className="agents-role-avatar" title={`设置${meta.labelZh}头像`} onClick={() => onPickAvatar(roleId)}>
        {avatar ? <img src={avatar} alt="" /> : <span>{meta.labelZh.slice(0, 1)}</span>}
      </button>
      <h3 id={`agents-role-${roleId}`} className="agents-role-title">{meta.labelZh}</h3>
      <span className="agents-room">{meta.roomZh}</span>
      {count ? <span className="agents-role-count">{count}</span> : null}
    </header>
  );
}

/** 概览行：五角色始终可见的连续紧凑目录；桌助 = 协调入口（非实例），员工行三态（空/被筛选隐藏/有实例）。 */
export function RoleOverviewRow({
  roleId,
  row,
  deskOccupied,
  deskConflict,
  projection,
  filter,
  avatarByRole,
  onJump,
  onPickAvatar
}: {
  roleId: RoleId;
  row: RosterRow | null;
  deskOccupied: boolean;
  deskConflict: boolean;
  projection: CrewProjection | null;
  filter: StatusFilter;
  avatarByRole: Partial<Record<RoleId, string>>;
  onJump: (roleId: string) => void;
  onPickAvatar: (roleId: RoleId) => void;
}): JSX.Element {
  if (roleId === 'desk') {
    const deskState = deskOccupied ? (deskConflict ? '受阻' : '工作中') : '当前无任务';
    return (
      <div className="agents-overview-row is-desk" data-role={roleId}>
        <RoleHead roleId="desk" deskRow={row} avatar={avatarByRole[roleId]} onPickAvatar={onPickAvatar} />
        <p className="agents-state-line">
          <StatusDot status={deskOccupied ? (deskConflict ? 'blocked' : 'running') : 'idle'} />
          <span className={`agents-status-word status-${deskOccupied ? (deskConflict ? 'blocked' : 'running') : 'idle'}`}>{deskState}</span>
          {row?.summary && row.summary !== '当前无任务' ? (
            <span className="muted agents-state-summary" title={row.summary}>{row.summary}</span>
          ) : null}
        </p>
        <p className="agents-role-hint">协调入口 · 派工与盯梢请到桌助对话</p>
      </div>
    );
  }
  const role = roleId as EmployeeRole;
  const active = projection?.byRole[role].active ?? [];
  const overview = roleOverviewStatus(active, filter);
  const legacyBusy = active.length === 0 && (row?.status === 'running' || row?.status === 'blocked');
  if (overview.kind === 'active') {
    return (
      <div className="agents-overview-row has-instances" data-role={roleId}>
        <RoleHead roleId={roleId} deskRow={row} count={overview.total} avatar={avatarByRole[roleId]} onPickAvatar={onPickAvatar} />
        <div className="agents-overview-status">
          <StatusDot status={overview.leaderStatus} />
          <span className={`agents-status-word status-${overview.leaderStatus}`}>{statusWord(overview.leaderStatus)}</span>
          <button type="button" className="agents-overview-jump" onClick={() => onJump(roleId)}>
            查看实例
          </button>
        </div>
      </div>
    );
  }
  if (legacyBusy) {
    return (
      <div className="agents-overview-row has-instances" data-role={roleId}>
        <RoleHead roleId={roleId} deskRow={row} avatar={avatarByRole[roleId]} onPickAvatar={onPickAvatar} />
        <p className="agents-state-line">
          <StatusDot status={row?.status === 'blocked' ? 'needs_user' : 'running'} />
          <span className={`agents-status-word status-${row?.status === 'blocked' ? 'needs_user' : 'running'}`}>
            {row?.status === 'blocked' ? '等你批' : '工作中'}
          </span>
          <span className="muted agents-state-summary" title={row?.summary}>{row?.summary}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="agents-overview-row" data-role={roleId}>
      <RoleHead
        roleId={roleId}
        deskRow={row}
        count={overview.kind === 'filtered' ? active.length : undefined}
        avatar={avatarByRole[roleId]}
        onPickAvatar={onPickAvatar}
      />
      {overview.kind === 'filtered' ? (
        <p className="agents-role-empty muted">当前筛选无匹配实例</p>
      ) : (
        <p className="agents-role-empty">当前无任务</p>
      )}
    </div>
  );
}
