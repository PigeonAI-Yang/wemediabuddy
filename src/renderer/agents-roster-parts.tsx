import type { JSX } from 'react';
import { ROLE_CATALOG, type RoleId } from '../shared/agent-capabilities';

/** 旧式 roster 行（IPC `getAgentsRoster` 形状的展示子集；与投影实例并存，仅视图消费）。 */
export type RosterRow = {
  roleId: RoleId;
  labelZh?: string;
  roomZh?: string;
  status: 'idle' | 'running' | 'blocked' | 'unknown';
  summary: string;
  taskId?: string | null;
  intent?: string | null;
  phase?: string | null;
  progressLabel?: string | null;
};

export function roleLabel(roleId: string): string {
  if (roleId in ROLE_CATALOG) return ROLE_CATALOG[roleId as RoleId].labelZh;
  return roleId;
}

export function clock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return '—';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (sameDay) return time;
  const day = d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  return `${day} ${time}`;
}

export function stampLine(label: string, iso: string | null): string {
  return `${label} ${clock(iso)}`;
}

export function StatusDot({ status }: { status: string }): JSX.Element {
  return <span className={`agents-status-dot status-${status}`} aria-hidden="true" />;
}
