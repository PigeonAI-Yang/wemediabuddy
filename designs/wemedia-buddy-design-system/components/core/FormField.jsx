import React from 'react';

/**
 * FormField — labelled field shell (settings-form grammar:
 * label 13px/650, control 42px, radius 7px, helper 12.5px muted,
 * error in danger). The label is the accessible name — placeholder
 * is never the label (WMB-5258 §4).
 */
export function FormField({
  label,
  htmlFor,
  id,
  required = false,
  error,
  helper,
  className = '',
  children,
}) {
  const controlId = id ?? htmlFor;
  const fieldId = controlId ? `${controlId}-field` : undefined;
  return (
    <div
      className={`ds-field${className ? ` ${className}` : ''}`}
      data-invalid={error ? 'true' : undefined}
      id={fieldId}
    >
      <label className="ds-field__label" htmlFor={controlId}>
        {label}
        {required ? <span className="ds-field__required" aria-hidden="true">*</span> : null}
      </label>
      <div className="ds-field__control">{children}</div>
      {error ? (
        <p className="ds-field__error" role="alert">{error}</p>
      ) : helper ? (
        <p className="ds-field__helper">{helper}</p>
      ) : null}
    </div>
  );
}
