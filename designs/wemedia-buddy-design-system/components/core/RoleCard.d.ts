/**
 * RoleCard — full-card crew button (agents grammar): the whole card
 * is a real button with no nested interactive elements; keyboard
 * reachable; avatar + name + room + progress rail + status line.
 * Source: .agents-role-card (styles-agents-overview.css).
 *
 * Usage:
 *   <RoleCard labelZh="记者" roomZh="前线 · 发现" status="running" word="扫描中"
 *             percent="42%" summary="今日热点扫描" onOpen={openRole} />
 *
 * Props:
 * - labelZh: role display name (e.g. 桌助/记者/策划/写手/资料员)
 * - roomZh: which room this role works in
 * - status: 'idle' | 'running' | 'needs-user' | 'ok' | 'bad'
 * - word: status word (default 当前无任务 — never invent idle text)
 * - percent: e.g. "42%"; omitted when indeterminate
 * - indeterminate: animated uncertain progress rail
 * - summary: one-line current work, truncated
 * - avatar: image URL; fallback = first char of labelZh
 * - expanded / isDesk: expanded state + desk variant
 * - className, onOpen
 */
export interface RoleCardProps {
  labelZh: string;
  roomZh: string;
  status?: 'idle' | 'running' | 'needs-user' | 'ok' | 'bad';
  word?: string;
  percent?: string;
  indeterminate?: boolean;
  summary?: string | null;
  avatar?: string;
  expanded?: boolean;
  isDesk?: boolean;
  className?: string;
  onOpen?: () => void;
}
