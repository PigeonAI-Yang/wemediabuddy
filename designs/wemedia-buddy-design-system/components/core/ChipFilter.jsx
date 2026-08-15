import React from 'react';

/**
 * ChipFilter — pressed-chip filter control, separate from tabs
 * (WMB-5258 §4). Source: .filter / .pill grammar. A chip is a
 * filter, not a navigation tab: aria-pressed toggles.
 */
export function ChipFilter({
  label,
  pressed = false,
  count,
  size = 'md',
  disabled = false,
  className = '',
  onToggle,
  title,
}) {
  const classes = ['ds-chip'];
  if (size === 'sm') classes.push('ds-chip--sm');
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(' ')}
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={() => onToggle?.(!pressed)}
    >
      <span>{label}</span>
      {count != null && <span className="ds-chip__count">{count}</span>}
    </button>
  );
}
