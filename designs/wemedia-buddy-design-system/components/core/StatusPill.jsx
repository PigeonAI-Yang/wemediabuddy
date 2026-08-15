import React from 'react';

/**
 * StatusPill — status dot + word double encoding; never color alone
 * (WMB-5258 §5 / PRODUCT accessibility). Tones map to semantic
 * tokens: ok=success, warn=status-running, needs-user=info,
 * bad=danger, active=accent, idle=muted.
 */
export function StatusPill({
  tone = 'idle',
  children,
  live = false,
  className = '',
}) {
  return (
    <span
      className={`ds-status-pill${className ? ` ${className}` : ''}`}
      data-tone={tone}
      role={live ? 'status' : undefined}
    >
      <span className="ds-status-pill__dot" aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
