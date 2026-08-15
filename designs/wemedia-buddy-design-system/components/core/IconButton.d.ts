/**
 * IconButton — square icon-only action with a mandatory accessible
 * name (WMB-5258: zero unnamed visible controls). Source:
 * .icon-button (styles-workflow) / .icon-action-button grammar.
 *
 * Usage:
 *   <IconButton label="否掉这个机会"><XGlyph/></IconButton>
 *   <IconButton label="开始创作" size="sm" variant="ghost"><PenGlyph/></IconButton>
 *
 * Props:
 * - label: REQUIRED accessible name (also becomes title when title omitted)
 * - size: 'md' (38px) | 'sm' (32px)
 * - variant: 'default' (bordered raised) | 'ghost' | 'danger'
 * - disabled, className, children (the SVG glyph), onClick, title
 */
export interface IconButtonProps {
  label: string;
  size?: 'md' | 'sm';
  variant?: 'default' | 'ghost' | 'danger';
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
}
