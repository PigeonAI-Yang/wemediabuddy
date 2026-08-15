import React from 'react';

/**
 * StatePanel — the universal four-state contract for async regions
 * (WMB-5258 §5): loading / error with retry / honest empty /
 * content. Loading never renders empty copy. Source: wiki
 * discovery panels + .empty-state grammar.
 */
export function StatePanel({
  state,
  title,
  body,
  action,
  icon,
  minHeight = 320,
  className = '',
  children,
}) {
  if (state === 'content') {
    return <div className={`ds-state-panel${className ? ` ${className}` : ''}`} style={{ '--ds-panel-min-h': `${minHeight}px` }}>{children}</div>;
  }
  const copy = {
    loading: { title: title ?? '正在读取…', body: body ?? '正在从本地资料库读取内容。' },
    error: { title: title ?? '读取失败', body: body ?? '没能读取到内容，请重试。' },
    empty: { title: title ?? '还没有内容', body: body ?? '这里还没有内容，先去「发现」看看外面。' },
  }[state];
  return (
    <div
      className={`ds-state-panel${className ? ` ${className}` : ''}`}
      data-state={state}
      style={{ '--ds-panel-min-h': `${minHeight}px` }}
      role={state === 'loading' ? 'status' : undefined}
    >
      <span className="ds-state-panel__icon" aria-hidden="true">{icon}</span>
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      {state === 'error' && action ? (
        <span className="ds-state-panel__action">
          <button type="button" className="ds-button ds-button--secondary ds-button--sm" onClick={action.onClick}>{action.label ?? '重试'}</button>
        </span>
      ) : null}
    </div>
  );
}
