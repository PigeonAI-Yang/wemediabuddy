import React from 'react';

/**
 * PageCommand — 96px room command card with room summary/stat
 * navigation and AT MOST one primary action (WMB-5258: `.page-command`
 * / One Violet). Source: styles-workflow.css .page-command.
 * Stat shape: { key, label, value, active?, onSelect? }.
 * Action shape: { label, onClick?, variant?, size?, disabled? }.
 */
export function PageCommand({
  title,
  summary,
  stats = [],
  actions = [],
  className = '',
}) {
  const primaryCount = actions.filter((action) => action.variant === 'primary').length;
  const statEls = stats.map((stat) =>
    stat.onSelect ? (
      <button
        key={stat.key}
        type="button"
        className="ds-page-command__stat"
        aria-pressed={Boolean(stat.active)}
        onClick={stat.onSelect}
      >
        <strong>{stat.value}</strong>
        <span>{stat.label}</span>
      </button>
    ) : (
      <span key={stat.key} className="ds-page-command__stat">
        <strong>{stat.value}</strong>
        <span>{stat.label}</span>
      </span>
    ),
  );
  return (
    <section className={`ds-page-command${className ? ` ${className}` : ''}`}>
      <div className="ds-page-command__main">
        <div className="ds-page-command__copy">
          <div className="ds-page-command__title-row">
            <h1 className="ds-page-command__title">{title}</h1>
            {summary ? <p className="ds-page-command__summary">{summary}</p> : null}
          </div>
          {statEls.length > 0 && <div className="ds-page-command__stats">{statEls}</div>}
        </div>
        <div className="ds-page-command__actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`ds-button ds-button--${action.variant ?? 'secondary'}${action.size === 'sm' ? ' ds-button--sm' : ''}`}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
      {primaryCount > 1 ? <span hidden>仅允许一个主操作</span> : null}
    </section>
  );
}
