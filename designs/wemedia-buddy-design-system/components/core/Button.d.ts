/**
 * Button — the shared action control. One primary violet action per
 * view; normal 40px / compact 32px density (WMB-5258 §4).
 * Source: .primary-button / .secondary-button / .text-button and
 * .primary-button.danger-button in styles-foundation/workflow.
 *
 * Usage:
 *   <Button variant="primary" onClick={start}>开始今日情报</Button>
 *   <Button variant="secondary" size="sm">重新侦察</Button>
 *   <Button variant="danger" size="sm">删除并归档</Button>
 *
 * Props:
 * - variant: 'primary' | 'secondary' | 'text' | 'danger' (default primary)
 * - size: 'md' (40px) | 'sm' (32px)
 * - type: button | submit | reset
 * - disabled: bool
 * - className: extra class
 * - children: label / icon + label
 * - onClick, ariaLabel, title
 */
export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'text' | 'danger';
  size?: 'md' | 'sm';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  ariaLabel?: string;
  title?: string;
}
