/**
 * StatusPill — semantic status as dot + word (never color alone,
 * WMB-5258 §5). Source: foundation .status-dot/.pill and the
 * agents status-word mapping.
 *
 * Usage:
 *   <StatusPill tone="warn">扫描中</StatusPill>
 *   <StatusPill tone="needs-user">等你批</StatusPill>
 *   <StatusPill tone="bad" live>入库失败，可重试</StatusPill>
 *
 * Props:
 * - tone: 'idle' | 'ok' | 'warn' | 'needs-user' | 'bad' | 'active'
 * - children: the status word
 * - live: role="status" for async announcements
 * - className
 */
export interface StatusPillProps {
  tone?: 'idle' | 'ok' | 'warn' | 'needs-user' | 'bad' | 'active';
  children: React.ReactNode;
  live?: boolean;
  className?: string;
}
