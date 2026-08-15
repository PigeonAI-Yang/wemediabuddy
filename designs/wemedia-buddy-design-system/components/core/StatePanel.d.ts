/**
 * StatePanel — the universal four-state async region contract
 * (WMB-5258 §5): loading / error+retry / honest empty / content.
 * Loading must never render empty copy; loading regions expose
 * role="status". Source: wiki discovery panels + .empty-state.
 *
 * Usage:
 *   <StatePanel state="loading" />
 *   <StatePanel state="error" action={{label:'重试',onClick:reload}} />
 *   <StatePanel state="empty" title="今日还没有入库资料" body="先去发现页看看外面有什么值得跟的。" />
 *   <StatePanel state="content">{rows}</StatePanel>
 *
 * Props:
 * - state: 'loading' | 'error' | 'empty' | 'content'
 * - title, body: overridable copy (sensible defaults provided)
 * - action: { label, onClick } shown only in error state
 * - icon: custom glyph in the icon badge
 * - minHeight: panel minimum height (default 320)
 * - className, children (content state only)
 */
export interface StatePanelProps {
  state: 'loading' | 'error' | 'empty' | 'content';
  title?: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  icon?: React.ReactNode;
  minHeight?: number;
  className?: string;
  children?: React.ReactNode;
}
