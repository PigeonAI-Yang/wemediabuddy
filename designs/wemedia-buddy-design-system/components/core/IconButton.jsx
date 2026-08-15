import React from 'react';

/**
 * IconButton — square icon-only action. Always requires an
 * accessible name (WMB-5258 Batch A: zero unnamed controls).
 * Source: .icon-button (38px) and .icon-action-button grammar.
 */
export function IconButton({
  /** Accessible name — required, never rely on the icon alone. */
  label,
  size = 'md',
  variant = 'default',
  disabled = false,
  className = '',
  children,
  onClick,
  title,
}) {
  const classes = ['ds-icon-button'];
  if (size === 'sm') classes.push('ds-icon-button--sm');
  if (variant !== 'default') classes.push(`ds-icon-button--${variant}`);
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(' ')}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
