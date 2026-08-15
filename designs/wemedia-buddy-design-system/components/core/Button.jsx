import React from 'react';

/**
 * Button — one owner for action hierarchy (WMB-5258 §4).
 * Normal density 40px, compact 32px; at most one primary violet
 * action per view. Variants: primary / secondary / text / danger.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled = false,
  className = '',
  children,
  onClick,
  ariaLabel,
  title,
}) {
  const classes = ['ds-button', `ds-button--${variant}`];
  if (size === 'sm') classes.push('ds-button--sm');
  if (className) classes.push(className);
  return (
    <button
      type={type}
      className={classes.join(' ')}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
    >
      {children}
    </button>
  );
}
