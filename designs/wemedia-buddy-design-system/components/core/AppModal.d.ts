/**
 * AppModal — the shared modal layer (WMB-5251 contract): portal to
 * body, one focus trap, Esc + backdrop policy, body scroll lock,
 * return focus, compact fullscreen degradation below 800x700.
 * Source: src/renderer/app-modal.tsx + styles-modal.css.
 *
 * Usage:
 *   <AppModal open={open} title="智能体详情" size="large" onRequestClose={close}>
 *     <p>…</p>
 *   </AppModal>
 *
 * Props:
 * - open: render gate
 * - title: dialog accessible name (h2)
 * - size: 'confirm' 520 | 'standard' 700 | 'large' min(1040, vw-64) | 'fullscreen'
 * - onRequestClose: called on Esc / backdrop / close button
 * - children: dialog body
 * - footer: fixed footer slot
 * - className: appended to .ds-modal-dialog
 * - ariaDescription: aria-describedby target id
 * - closeOnBackdrop / closeOnEscape: policy flags (default true)
 * - role: 'dialog' | 'alertdialog'
 * - initialFocusRef: element focused on open
 */
export interface AppModalProps {
  open: boolean;
  title: string;
  size?: AppModalSize;
  onRequestClose: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  ariaDescription?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  role?: 'dialog' | 'alertdialog';
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}
export type AppModalSize = 'confirm' | 'standard' | 'large' | 'fullscreen';
