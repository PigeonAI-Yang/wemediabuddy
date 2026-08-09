import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type AppConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PendingConfirm = AppConfirmOptions & {
  resolve: (value: boolean) => void;
};

let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 应用内确认框。替代原生 window.confirm，统一套 WeMediaBuddy UI 皮。 */
export function appConfirm(options: string | AppConfirmOptions): Promise<boolean> {
  const normalized: AppConfirmOptions = typeof options === 'string' ? { message: options } : options;
  if (pending) {
    pending.resolve(false);
    pending = null;
  }
  return new Promise<boolean>((resolve) => {
    pending = { ...normalized, resolve };
    emit();
  });
}

/** 挂在 App 根上，全局唯一确认层。 */
export function AppConfirmHost(): React.JSX.Element | null {
  const [request, setRequest] = useState<PendingConfirm | null>(pending);
  const titleId = useId();
  const messageId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const sync = () => setRequest(pending);
    listeners.add(sync);
    return () => { listeners.delete(sync); };
  }, []);

  useEffect(() => {
    if (!request) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [request]);

  if (!request || typeof document === 'undefined') return null;

  const finish = (value: boolean) => {
    const current = pending;
    pending = null;
    setRequest(null);
    current?.resolve(value);
    emit();
  };

  return createPortal(
    <div className="app-confirm-root" role="presentation">
      <button type="button" className="app-confirm-backdrop" aria-label="关闭确认" onClick={() => finish(false)} />
      <div
        className={`app-confirm-dialog${request.danger ? ' danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <header className="app-confirm-head">
          <strong id={titleId}>{request.title?.trim() || '请确认'}</strong>
          <button type="button" className="app-confirm-close" aria-label="关闭" onClick={() => finish(false)}>×</button>
        </header>
        <p id={messageId} className="app-confirm-message">{request.message}</p>
        <footer className="app-confirm-actions">
          <button type="button" className="secondary-button" onClick={() => finish(false)}>
            {request.cancelLabel?.trim() || '取消'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`primary-button${request.danger ? ' danger-button' : ''}`}
            onClick={() => finish(true)}
          >
            {request.confirmLabel?.trim() || '确定'}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
