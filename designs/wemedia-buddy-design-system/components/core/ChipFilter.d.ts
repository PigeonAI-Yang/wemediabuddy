/**
 * ChipFilter — pressed-chip filter with optional count. Filters and
 * tabs have separate contracts (WMB-5258 §4): chips toggle with
 * aria-pressed; tabs navigate with roving tabindex. Source:
 * .filter (styles-workflow) / .pill grammar.
 *
 * Usage:
 *   <ChipFilter label="仅看可批" pressed={onlyApproval} onToggle={setOnlyApproval} />
 *   <ChipFilter label="全部" count={12} pressed />
 *
 * Props:
 * - label: chip text
 * - pressed: bool (aria-pressed)
 * - count: optional numeric badge
 * - size: 'md' (40px) | 'sm' (32px)
 * - disabled, className, onToggle(pressed), title
 */
export interface ChipFilterProps {
  label: string;
  pressed?: boolean;
  count?: number;
  size?: 'md' | 'sm';
  disabled?: boolean;
  className?: string;
  onToggle?: (pressed: boolean) => void;
  title?: string;
}
