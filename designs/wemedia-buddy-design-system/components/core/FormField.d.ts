/**
 * FormField — labelled field shell: label (13px/650), control
 * (42px, radius 7, strong border, raised surface), helper (12.5px
 * muted), error (danger, role=alert). Source: settings-form
 * grammar (styles-studio.css). Placeholder is never the label.
 *
 * Usage:
 *   <FormField label="工作区名称" htmlFor="ws-name" helper="给本地资料库起个名字">
 *     <input id="ws-name" value={name} onChange={e => setName(e.target.value)} />
 *   </FormField>
 *   <FormField label="Pi API Key" htmlFor="pi-key" error="Key 不能为空">
 *     <input id="pi-key" type="password" />
 *   </FormField>
 *
 * Props:
 * - label: visible label (also names the control)
 * - htmlFor / id: control association
 * - required: appends * marker
 * - error: error message (hides helper, tints control danger)
 * - helper: supporting copy
 * - className, children (the control itself)
 */
export interface FormFieldProps {
  label: string;
  htmlFor?: string;
  id?: string;
  required?: boolean;
  error?: string;
  helper?: string;
  className?: string;
  children: React.ReactNode;
}
