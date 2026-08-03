import type { RefObject } from 'react';
import { formatPiMessageTime } from './pi-dock-transcript';

export type PiSessionItem = { id: string; title: string; preview: string; createdAt: string; updatedAt: string; active: boolean };

export function PiDockHeader({
  headerRef,
  sessionMenuOpen,
  sessions,
  activeSessionId,
  activeTitle,
  phase,
  statusText,
  contextChip,
  toast,
  onToggleSessions,
  onNewConversation,
  onOpenSession
}: {
  headerRef: RefObject<HTMLElement | null>;
  sessionMenuOpen: boolean;
  sessions: PiSessionItem[];
  activeSessionId: string | null;
  activeTitle: string;
  phase: 'idle' | 'starting' | 'running' | 'failed' | 'stopped';
  statusText: string;
  contextChip: string;
  toast: string;
  onToggleSessions: () => void;
  onNewConversation: () => void;
  onOpenSession: (id: string) => void;
}): React.JSX.Element {
  return <header className="pi-dock-header" ref={headerRef}>
    <div className="pi-dock-title-row">
      <button type="button" className={`pi-session-trigger${sessionMenuOpen ? ' open' : ''}`} onClick={onToggleSessions} aria-haspopup="listbox" aria-expanded={sessionMenuOpen} title="会话管理">
        <strong>Pi</strong>
        <span className="pi-session-current" title={activeTitle}>{activeTitle === 'Pi' ? '会话' : activeTitle}</span>
        <em className="pi-session-caret" aria-hidden="true">▾</em>
      </button>
      <span data-phase={phase}>状态：{statusText}</span>
    </div>
    {sessionMenuOpen && <div className="pi-session-menu" role="listbox" aria-label="会话列表">
      <div className="pi-session-menu-head"><span>会话</span><button type="button" onClick={onNewConversation}>新建</button></div>
      <div className="pi-session-list">
        {sessions.length ? sessions.map((session) => <button
          key={session.id}
          type="button"
          role="option"
          aria-selected={session.id === activeSessionId}
          className={session.id === activeSessionId ? 'active' : ''}
          onClick={() => onOpenSession(session.id)}
        ><strong>{session.title || '新会话'}</strong><span>{formatPiMessageTime(session.updatedAt) || session.preview}</span><small>{session.preview}</small></button>)
          : <p className="pi-session-empty">还没有历史会话</p>}
      </div>
    </div>}
    <div className="pi-context-chip" title={`当前会带给 Pi 的对象：${contextChip}`}><em>当前:</em><span>{contextChip}</span></div>
    {toast && <small className="pi-toast">{toast}</small>}
  </header>;
}
