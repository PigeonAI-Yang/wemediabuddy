import { useState, type RefObject } from 'react';
import { formatPiMessageTime } from './pi-dock-transcript';

export type PiSessionItem = { id: string; title: string; preview: string; createdAt: string; updatedAt: string; active: boolean; archivedAt: string | null };

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
  onOpenSession,
  onArchiveSession,
  busy
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
  onArchiveSession: (id: string, archived: boolean) => void;
  busy: boolean;
}): React.JSX.Element {
  const [archivedView, setArchivedView] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const visible = sessions.filter((session) => Boolean(session.archivedAt) === archivedView);
  const archivedCount = sessions.filter((session) => session.archivedAt).length;
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
      <div className="pi-session-menu-head"><span>{archivedView ? '已归档会话' : '会话'}</span>{archivedView
        ? <button type="button" onClick={() => { setArchivedView(false); setActionId(null); }}>返回</button>
        : <button type="button" onClick={onNewConversation}>新建</button>}</div>
      <div className="pi-session-list">
        {visible.length ? visible.map((session) => <div key={session.id} data-session-id={session.id} className={`pi-session-row${session.id === activeSessionId ? ' active' : ''}`}>
          <button type="button" role="option" aria-selected={session.id === activeSessionId} disabled={archivedView} onClick={() => onOpenSession(session.id)}>
            <strong>{session.title || '新会话'}</strong><span>{formatPiMessageTime(session.updatedAt) || session.preview}</span><small>{session.preview}</small>
          </button>
          <button type="button" className="pi-session-more" aria-label={`${archivedView ? '恢复' : '管理'}会话 ${session.title}`} disabled={busy} onClick={() => setActionId((id) => id === session.id ? null : session.id)}>···</button>
          {actionId === session.id && <div className="pi-session-actions"><button type="button" disabled={busy} onClick={() => { setActionId(null); onArchiveSession(session.id, !archivedView); }}>{archivedView ? '恢复会话' : '归档会话'}</button></div>}
        </div>) : <p className="pi-session-empty">{archivedView ? '还没有已归档会话' : '还没有历史会话'}</p>}
      </div>
      {!archivedView && archivedCount > 0 && <button type="button" className="pi-session-archived-link" onClick={() => { setArchivedView(true); setActionId(null); }}>已归档会话 <span>{archivedCount}</span></button>}
    </div>}
    <div className="pi-context-chip" title={`当前会带给 Pi 的对象：${contextChip}`}><em>当前:</em><span>{contextChip}</span></div>
    {toast && <small className="pi-toast">{toast}</small>}
  </header>;
}
