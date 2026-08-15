import React from 'react';

/**
 * RoleCard — full-card button for the crew roster (agents grammar,
 * WMB-5195/WMB-5258): no nested interactive elements, keyboard
 * reachable, avatar + name + room + progress rail + status line.
 */
export function RoleCard({
  labelZh,
  roomZh,
  status = 'idle',
  word,
  percent,
  indeterminate = false,
  summary,
  avatar,
  expanded = false,
  isDesk = false,
  className = '',
  onOpen,
}) {
  const classes = ['ds-role-card'];
  if (isDesk) classes.push('ds-role-card--desk');
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(' ')}
      data-tone={status}
      aria-expanded={expanded}
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      <span className="ds-role-card__avatar">{avatar ? <img src={avatar} alt="" /> : <span>{labelZh.slice(0, 1)}</span>}</span>
      <span className="ds-role-card__name">{labelZh}</span>
      <span className="ds-role-card__room">{roomZh}</span>
      <span
        className="ds-role-card__progress"
        role="progressbar"
        aria-label={`${labelZh}进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent ? Number.parseInt(percent, 10) || 0 : 0}
        data-indeterminate={indeterminate ? 'true' : undefined}
        data-determinate={indeterminate ? undefined : 'true'}
        style={!indeterminate ? { '--progress': percent ? (Number.parseInt(percent, 10) || 0) / 100 : 0 } : undefined}
      >
        <i />
      </span>
      <span className="ds-role-card__statusline">
        <span className="ds-role-card__dot" aria-hidden="true" />
        <span className="ds-role-card__word">{word ?? '当前无任务'}</span>
        {percent ? <span className="ds-role-card__pct">{percent}</span> : null}
        {summary ? <span className="ds-role-card__summary" title={summary}>{summary}</span> : null}
      </span>
    </button>
  );
}
