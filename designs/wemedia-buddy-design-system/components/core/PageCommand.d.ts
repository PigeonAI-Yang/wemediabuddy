/**
 * PageCommand — 96px room command card: room summary + stat
 * navigation + at most one primary action (source .page-command,
 * styles-workflow.css; WMB-5258 §4 One Violet).
 *
 * Usage:
 *   <PageCommand title="选题台账" summary="今日值得批的方案"
 *     stats={[{key:'today',label:'今日可批',value:3,active:true,onSelect:showToday},
 *             {key:'shelved',label:'待处理',value:9,onSelect:showShelved}]}
 *     actions={[{label:'新建选题',variant:'primary',onClick:create}]} />
 *
 * Props:
 * - title: room/command title (rendered as h1)
 * - summary: one-line muted description
 * - stats: PageCommandStat[] { key,label,value,active?,onSelect? }
 * - actions: PageCommandAction[] { label,onClick,variant?,size?,disabled? }
 * - className
 */
export interface PageCommandProps {
  title: string;
  summary?: string;
  stats?: PageCommandStat[];
  actions?: PageCommandAction[];
  className?: string;
}
export type PageCommandStat = {
  key: string;
  label: string;
  value: string | number;
  active?: boolean;
  onSelect?: () => void;
};
export type PageCommandAction = {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'text' | 'danger';
  size?: 'md' | 'sm';
  disabled?: boolean;
};
