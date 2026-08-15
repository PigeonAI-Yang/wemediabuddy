import React from 'react';
import ReactDOM from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * AppModal — the shared modal layer (WMB-5251 contract): one
 * focus trap, Esc/backdrop policy, body scroll lock, return
 * focus, compact fullscreen degradation. Feature code customizes
 * children/footer/className only; never rebuild the layer.
 * Sizes: confirm / standard / large / fullscreen.
 */
export function AppModal({
  open,
  title,
  size = 'standard',
  onRequestClose,
  children,
  footer,
  className = '',
  ariaDescription,
  closeOnBackdrop = true,
  closeOnEscape = true,
  role = 'dialog',
  initialFocusRef,
}) {
  const dialogRef = React.useRef(null);
  const lastFocused = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    lastFocused.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTarget = initialFocusRef?.current ?? dialogRef.current;
    const candidates = dialogRef.current?.querySelectorAll(FOCUSABLE_SELECTOR);
    const first = candidates?.[0] ?? null;
    const last = candidates?.[candidates.length - 1] ?? null;
    if (focusTarget) focusTarget.focus();
    else first?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape' && closeOnEscape) {
        event.preventDefault();
        onRequestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      lastFocused.current?.focus();
    };
  }, [open, closeOnEscape, onRequestClose, initialFocusRef]);

  if (!open) return null;

  const dialog = (
    <div className="ds-modal-root">
      <button
        type="button"
        className="ds-modal-backdrop"
        aria-label="关闭弹窗"
        onClick={() => { if (closeOnBackdrop) onRequestClose(); }}
      />
      <div
        ref={dialogRef}
        className={`ds-modal-dialog ds-modal--${size}${className ? ` ${className}` : ''}`}
        role={role}
        aria-modal="true"
        aria-label={title}
        aria-describedby={ariaDescription}
      >
        <div className="ds-modal-head">
          <h2 className="ds-modal-title">{title}</h2>
          <button type="button" className="ds-modal-close" aria-label="关闭" onClick={onRequestClose}>×</button>
        </div>
        <div className="ds-modal-body">{children}</div>
        {footer ? <div className="ds-modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
  return ReactDOM.createPortal(dialog, document.body);
}
