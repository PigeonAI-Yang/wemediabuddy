import React from 'react';

/**
 * TabList — real tablist/tab with roving tabindex and
 * Arrow / Home / End keyboard navigation (WMB-5258 §4; library
 * tabs contract). Selection is controlled by the caller.
 * Tab shape: { id, label, count? }.
 */
export function TabList({
  tabs,
  selectedId,
  onSelect,
  ariaLabel,
  className = '',
}) {
  const refs = React.useRef({});

  const onKeyDown = (event, currentId) => {
    const index = tabs.findIndex((tab) => tab.id === currentId);
    if (index < 0) return;
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const target = tabs[next];
    onSelect(target.id);
    refs.current[target.id]?.focus();
  };

  return (
    <div
      className={`ds-tablist${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(event) => onKeyDown(event, selectedId)}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(node) => { refs.current[tab.id] = node; }}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === selectedId}
          aria-controls={`tabpanel-${tab.id}`}
          tabIndex={tab.id === selectedId ? 0 : -1}
          className="ds-tab"
          onClick={() => onSelect(tab.id)}
        >
          <span>{tab.label}</span>
          {tab.count != null && <span className="ds-tab__count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
