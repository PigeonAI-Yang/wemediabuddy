import { useEffect, useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

export type AppModalSize = 'confirm' | 'standard' | 'large' | 'fullscreen';

export type AppModalProps = {
  open: boolean;
  title: string;
  size: AppModalSize;
  onRequestClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  /** 追加到弹窗面板（.app-modal-dialog）上的 feature 类。 */
  className?: string;
  ariaDescription?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  role?: 'dialog' | 'alertdialog';
  /** 渲染为根元素 data-testid；同时派生稳定面板 id `${testId}-dialog` 供触发按钮 aria-controls 引用。 */
  testId?: string;
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0
  );
}

/**
 * 共享模态层（WMB-5251）：全应用唯一 focus trap / 背景滚动锁 / Esc / 遮罩实现。
 * feature 只允许通过 children / footer / className 定制内容，不得重建
 * backdrop、焦点、Esc、滚动锁行为。禁止嵌套 AppModal。
 */
export function AppModal({
  open,
  title,
  size,
  onRequestClose,
  children,
  footer,
  className,
  ariaDescription,
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
  returnFocusRef,
  role = 'dialog',
  testId,
}: AppModalProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // 最新值 refs：open 效应只依赖 open，避免 onRequestClose 等内联闭包导致
  // 打开期间反复重建监听器而重置焦点/滚动锁。
  const onRequestCloseRef = useRef(onRequestClose);
  const closeOnBackdropRef = useRef(closeOnBackdrop);
  const closeOnEscapeRef = useRef(closeOnEscape);
  const initialFocusRefRef = useRef(initialFocusRef);
  const returnFocusRefRef = useRef(returnFocusRef);

  useEffect(() => {
    onRequestCloseRef.current = onRequestClose;
    closeOnBackdropRef.current = closeOnBackdrop;
    closeOnEscapeRef.current = closeOnEscape;
    initialFocusRefRef.current = initialFocusRef;
    returnFocusRefRef.current = returnFocusRef;
  });

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    (initialFocusRefRef.current?.current ?? focusableElements(dialog)[0] ?? closeRef.current)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (closeOnEscapeRef.current) {
          event.preventDefault();
          onRequestCloseRef.current();
        }
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusables = focusableElements(dialog);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      (returnFocusRefRef.current?.current ?? previouslyFocused)?.focus();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const dialogClassName = ['app-modal-dialog', `app-modal-${size}`, className]
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <div className="app-modal-root" role="presentation" data-testid={testId}>
      <div
        className="app-modal-backdrop"
        onClick={() => {
          if (closeOnBackdropRef.current) onRequestCloseRef.current();
        }}
      />
      <div
        ref={dialogRef}
        id={testId ? `${testId}-dialog` : undefined}
        className={dialogClassName}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ariaDescription ? descriptionId : undefined}
        data-size={size}
      >
        <header className="app-modal-head">
          <h2 id={titleId} className="app-modal-title">
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="app-modal-close"
            aria-label="关闭"
            onClick={() => onRequestCloseRef.current()}
          >
            ×
          </button>
        </header>
        <div id={descriptionId} className="app-modal-body">
          {children}
        </div>
        {footer != null && <footer className="app-modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}
