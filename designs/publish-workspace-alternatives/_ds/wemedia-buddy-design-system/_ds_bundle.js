/* @ds-bundle: {"format":3,"namespace":"WemediaBuddyDesignSystem_1c877c","components":[{"name":"AppModal","sourcePath":"components/core/AppModal.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"ChipFilter","sourcePath":"components/core/ChipFilter.jsx"},{"name":"FormField","sourcePath":"components/core/FormField.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"PageCommand","sourcePath":"components/core/PageCommand.jsx"},{"name":"RoleCard","sourcePath":"components/core/RoleCard.jsx"},{"name":"StatePanel","sourcePath":"components/core/StatePanel.jsx"},{"name":"StatusPill","sourcePath":"components/core/StatusPill.jsx"},{"name":"TabList","sourcePath":"components/core/TabList.jsx"},{"name":"WmbCreatureMark","sourcePath":"components/core/WmbCreatureMark.jsx"}],"sourceHashes":{"components/core/AppModal.jsx":"6c67dfa9cb07","components/core/Button.jsx":"4d0bcbe7148f","components/core/ChipFilter.jsx":"6e5e9fd9dbfa","components/core/FormField.jsx":"40f029e73392","components/core/IconButton.jsx":"b5ee25c19027","components/core/PageCommand.jsx":"76be137176ef","components/core/RoleCard.jsx":"b7268884d5b6","components/core/StatePanel.jsx":"894d6c6a7aaa","components/core/StatusPill.jsx":"3eb8a9435821","components/core/TabList.jsx":"ef96c91ad22a","components/core/WmbCreatureMark.jsx":"87c6d729ae9f"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.WemediaBuddyDesignSystem_1c877c = window.WemediaBuddyDesignSystem_1c877c || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/AppModal.jsx
try { (() => {
const FOCUSABLE_SELECTOR = ['a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'].join(',');

/**
 * AppModal — the shared modal layer (WMB-5251 contract): one
 * focus trap, Esc/backdrop policy, body scroll lock, return
 * focus, compact fullscreen degradation. Feature code customizes
 * children/footer/className only; never rebuild the layer.
 * Sizes: confirm / standard / large / fullscreen.
 */
function AppModal({
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
  initialFocusRef
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
    if (focusTarget) focusTarget.focus();else first?.focus();
    const onKeyDown = event => {
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
  const dialog = /*#__PURE__*/React.createElement("div", {
    className: "ds-modal-root"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "ds-modal-backdrop",
    "aria-label": "\u5173\u95ED\u5F39\u7A97",
    onClick: () => {
      if (closeOnBackdrop) onRequestClose();
    }
  }), /*#__PURE__*/React.createElement("div", {
    ref: dialogRef,
    className: `ds-modal-dialog ds-modal--${size}${className ? ` ${className}` : ''}`,
    role: role,
    "aria-modal": "true",
    "aria-label": title,
    "aria-describedby": ariaDescription
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-modal-head"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "ds-modal-title"
  }, title), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "ds-modal-close",
    "aria-label": "\u5173\u95ED",
    onClick: onRequestClose
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    className: "ds-modal-body"
  }, children), footer ? /*#__PURE__*/React.createElement("div", {
    className: "ds-modal-footer"
  }, footer) : null));
  return ReactDOM.createPortal(dialog, document.body);
}
Object.assign(__ds_scope, { AppModal });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/AppModal.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
/**
 * Button — one owner for action hierarchy (WMB-5258 §4).
 * Normal density 40px, compact 32px; at most one primary violet
 * action per view. Variants: primary / secondary / text / danger.
 */
function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled = false,
  className = '',
  children,
  onClick,
  ariaLabel,
  title
}) {
  const classes = ['ds-button', `ds-button--${variant}`];
  if (size === 'sm') classes.push('ds-button--sm');
  if (className) classes.push(className);
  return /*#__PURE__*/React.createElement("button", {
    type: type,
    className: classes.join(' '),
    disabled: disabled,
    onClick: onClick,
    "aria-label": ariaLabel,
    title: title
  }, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/ChipFilter.jsx
try { (() => {
/**
 * ChipFilter — pressed-chip filter control, separate from tabs
 * (WMB-5258 §4). Source: .filter / .pill grammar. A chip is a
 * filter, not a navigation tab: aria-pressed toggles.
 */
function ChipFilter({
  label,
  pressed = false,
  count,
  size = 'md',
  disabled = false,
  className = '',
  onToggle,
  title
}) {
  const classes = ['ds-chip'];
  if (size === 'sm') classes.push('ds-chip--sm');
  if (className) classes.push(className);
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: classes.join(' '),
    "aria-pressed": pressed,
    disabled: disabled,
    title: title,
    onClick: () => onToggle?.(!pressed)
  }, /*#__PURE__*/React.createElement("span", null, label), count != null && /*#__PURE__*/React.createElement("span", {
    className: "ds-chip__count"
  }, count));
}
Object.assign(__ds_scope, { ChipFilter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/ChipFilter.jsx", error: String((e && e.message) || e) }); }

// components/core/FormField.jsx
try { (() => {
/**
 * FormField — labelled field shell (settings-form grammar:
 * label 13px/650, control 42px, radius 7px, helper 12.5px muted,
 * error in danger). The label is the accessible name — placeholder
 * is never the label (WMB-5258 §4).
 */
function FormField({
  label,
  htmlFor,
  id,
  required = false,
  error,
  helper,
  className = '',
  children
}) {
  const controlId = id ?? htmlFor;
  const fieldId = controlId ? `${controlId}-field` : undefined;
  return /*#__PURE__*/React.createElement("div", {
    className: `ds-field${className ? ` ${className}` : ''}`,
    "data-invalid": error ? 'true' : undefined,
    id: fieldId
  }, /*#__PURE__*/React.createElement("label", {
    className: "ds-field__label",
    htmlFor: controlId
  }, label, required ? /*#__PURE__*/React.createElement("span", {
    className: "ds-field__required",
    "aria-hidden": "true"
  }, "*") : null), /*#__PURE__*/React.createElement("div", {
    className: "ds-field__control"
  }, children), error ? /*#__PURE__*/React.createElement("p", {
    className: "ds-field__error",
    role: "alert"
  }, error) : helper ? /*#__PURE__*/React.createElement("p", {
    className: "ds-field__helper"
  }, helper) : null);
}
Object.assign(__ds_scope, { FormField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/FormField.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
/**
 * IconButton — square icon-only action. Always requires an
 * accessible name (WMB-5258 Batch A: zero unnamed controls).
 * Source: .icon-button (38px) and .icon-action-button grammar.
 */
function IconButton({
  /** Accessible name — required, never rely on the icon alone. */
  label,
  size = 'md',
  variant = 'default',
  disabled = false,
  className = '',
  children,
  onClick,
  title
}) {
  const classes = ['ds-icon-button'];
  if (size === 'sm') classes.push('ds-icon-button--sm');
  if (variant !== 'default') classes.push(`ds-icon-button--${variant}`);
  if (className) classes.push(className);
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: classes.join(' '),
    "aria-label": label,
    title: title ?? label,
    disabled: disabled,
    onClick: onClick
  }, children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/PageCommand.jsx
try { (() => {
/**
 * PageCommand — 96px room command card with room summary/stat
 * navigation and AT MOST one primary action (WMB-5258: `.page-command`
 * / One Violet). Source: styles-workflow.css .page-command.
 * Stat shape: { key, label, value, active?, onSelect? }.
 * Action shape: { label, onClick?, variant?, size?, disabled? }.
 */
function PageCommand({
  title,
  summary,
  stats = [],
  actions = [],
  className = ''
}) {
  const primaryCount = actions.filter(action => action.variant === 'primary').length;
  const statEls = stats.map(stat => stat.onSelect ? /*#__PURE__*/React.createElement("button", {
    key: stat.key,
    type: "button",
    className: "ds-page-command__stat",
    "aria-pressed": Boolean(stat.active),
    onClick: stat.onSelect
  }, /*#__PURE__*/React.createElement("strong", null, stat.value), /*#__PURE__*/React.createElement("span", null, stat.label)) : /*#__PURE__*/React.createElement("span", {
    key: stat.key,
    className: "ds-page-command__stat"
  }, /*#__PURE__*/React.createElement("strong", null, stat.value), /*#__PURE__*/React.createElement("span", null, stat.label)));
  return /*#__PURE__*/React.createElement("section", {
    className: `ds-page-command${className ? ` ${className}` : ''}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-page-command__main"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-page-command__copy"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-page-command__title-row"
  }, /*#__PURE__*/React.createElement("h1", {
    className: "ds-page-command__title"
  }, title), summary ? /*#__PURE__*/React.createElement("p", {
    className: "ds-page-command__summary"
  }, summary) : null), statEls.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "ds-page-command__stats"
  }, statEls)), /*#__PURE__*/React.createElement("div", {
    className: "ds-page-command__actions"
  }, actions.map(action => /*#__PURE__*/React.createElement("button", {
    key: action.label,
    type: "button",
    className: `ds-button ds-button--${action.variant ?? 'secondary'}${action.size === 'sm' ? ' ds-button--sm' : ''}`,
    disabled: action.disabled,
    onClick: action.onClick
  }, action.label)))), primaryCount > 1 ? /*#__PURE__*/React.createElement("span", {
    hidden: true
  }, "\u4EC5\u5141\u8BB8\u4E00\u4E2A\u4E3B\u64CD\u4F5C") : null);
}
Object.assign(__ds_scope, { PageCommand });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/PageCommand.jsx", error: String((e && e.message) || e) }); }

// components/core/RoleCard.jsx
try { (() => {
/**
 * RoleCard — full-card button for the crew roster (agents grammar,
 * WMB-5195/WMB-5258): no nested interactive elements, keyboard
 * reachable, avatar + name + room + progress rail + status line.
 */
function RoleCard({
  labelZh,
  roomZh,
  status = 'idle',
  word,
  percent,
  indeterminate = false,
  summary,
  avatar,
  expanded = false,
  isDesk = false,
  className = '',
  onOpen
}) {
  const classes = ['ds-role-card'];
  if (isDesk) classes.push('ds-role-card--desk');
  if (className) classes.push(className);
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: classes.join(' '),
    "data-tone": status,
    "aria-expanded": expanded,
    "aria-haspopup": "dialog",
    onClick: onOpen
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-role-card__avatar"
  }, avatar ? /*#__PURE__*/React.createElement("img", {
    src: avatar,
    alt: ""
  }) : /*#__PURE__*/React.createElement("span", null, labelZh.slice(0, 1))), /*#__PURE__*/React.createElement("span", {
    className: "ds-role-card__name"
  }, labelZh), /*#__PURE__*/React.createElement("span", {
    className: "ds-role-card__room"
  }, roomZh), /*#__PURE__*/React.createElement("span", {
    className: "ds-role-card__progress",
    role: "progressbar",
    "aria-label": `${labelZh}进度`,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": indeterminate ? undefined : percent ? Number.parseInt(percent, 10) || 0 : 0,
    "data-indeterminate": indeterminate ? 'true' : undefined,
    "data-determinate": indeterminate ? undefined : 'true',
    style: !indeterminate ? {
      '--progress': percent ? (Number.parseInt(percent, 10) || 0) / 100 : 0
    } : undefined
  }, /*#__PURE__*/React.createElement("i", null)), /*#__PURE__*/React.createElement("span", {
    className: "ds-role-card__statusline"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-role-card__dot",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("span", {
    className: "ds-role-card__word"
  }, word ?? '当前无任务'), percent ? /*#__PURE__*/React.createElement("span", {
    className: "ds-role-card__pct"
  }, percent) : null, summary ? /*#__PURE__*/React.createElement("span", {
    className: "ds-role-card__summary",
    title: summary
  }, summary) : null));
}
Object.assign(__ds_scope, { RoleCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/RoleCard.jsx", error: String((e && e.message) || e) }); }

// components/core/StatePanel.jsx
try { (() => {
/**
 * StatePanel — the universal four-state contract for async regions
 * (WMB-5258 §5): loading / error with retry / honest empty /
 * content. Loading never renders empty copy. Source: wiki
 * discovery panels + .empty-state grammar.
 */
function StatePanel({
  state,
  title,
  body,
  action,
  icon,
  minHeight = 320,
  className = '',
  children
}) {
  if (state === 'content') {
    return /*#__PURE__*/React.createElement("div", {
      className: `ds-state-panel${className ? ` ${className}` : ''}`,
      style: {
        '--ds-panel-min-h': `${minHeight}px`
      }
    }, children);
  }
  const copy = {
    loading: {
      title: title ?? '正在读取…',
      body: body ?? '正在从本地资料库读取内容。'
    },
    error: {
      title: title ?? '读取失败',
      body: body ?? '没能读取到内容，请重试。'
    },
    empty: {
      title: title ?? '还没有内容',
      body: body ?? '这里还没有内容，先去「发现」看看外面。'
    }
  }[state];
  return /*#__PURE__*/React.createElement("div", {
    className: `ds-state-panel${className ? ` ${className}` : ''}`,
    "data-state": state,
    style: {
      '--ds-panel-min-h': `${minHeight}px`
    },
    role: state === 'loading' ? 'status' : undefined
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-state-panel__icon",
    "aria-hidden": "true"
  }, icon), /*#__PURE__*/React.createElement("h3", null, copy.title), /*#__PURE__*/React.createElement("p", null, copy.body), state === 'error' && action ? /*#__PURE__*/React.createElement("span", {
    className: "ds-state-panel__action"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "ds-button ds-button--secondary ds-button--sm",
    onClick: action.onClick
  }, action.label ?? '重试')) : null);
}
Object.assign(__ds_scope, { StatePanel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatePanel.jsx", error: String((e && e.message) || e) }); }

// components/core/StatusPill.jsx
try { (() => {
/**
 * StatusPill — status dot + word double encoding; never color alone
 * (WMB-5258 §5 / PRODUCT accessibility). Tones map to semantic
 * tokens: ok=success, warn=status-running, needs-user=info,
 * bad=danger, active=accent, idle=muted.
 */
function StatusPill({
  tone = 'idle',
  children,
  live = false,
  className = ''
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `ds-status-pill${className ? ` ${className}` : ''}`,
    "data-tone": tone,
    role: live ? 'status' : undefined
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-status-pill__dot",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("span", null, children));
}
Object.assign(__ds_scope, { StatusPill });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatusPill.jsx", error: String((e && e.message) || e) }); }

// components/core/TabList.jsx
try { (() => {
/**
 * TabList — real tablist/tab with roving tabindex and
 * Arrow / Home / End keyboard navigation (WMB-5258 §4; library
 * tabs contract). Selection is controlled by the caller.
 * Tab shape: { id, label, count? }.
 */
function TabList({
  tabs,
  selectedId,
  onSelect,
  ariaLabel,
  className = ''
}) {
  const refs = React.useRef({});
  const onKeyDown = (event, currentId) => {
    const index = tabs.findIndex(tab => tab.id === currentId);
    if (index < 0) return;
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;else if (event.key === 'Home') next = 0;else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const target = tabs[next];
    onSelect(target.id);
    refs.current[target.id]?.focus();
  };
  return /*#__PURE__*/React.createElement("div", {
    className: `ds-tablist${className ? ` ${className}` : ''}`,
    role: "tablist",
    "aria-label": ariaLabel,
    onKeyDown: event => onKeyDown(event, selectedId)
  }, tabs.map(tab => /*#__PURE__*/React.createElement("button", {
    key: tab.id,
    ref: node => {
      refs.current[tab.id] = node;
    },
    type: "button",
    role: "tab",
    id: `tab-${tab.id}`,
    "aria-selected": tab.id === selectedId,
    "aria-controls": `tabpanel-${tab.id}`,
    tabIndex: tab.id === selectedId ? 0 : -1,
    className: "ds-tab",
    onClick: () => onSelect(tab.id)
  }, /*#__PURE__*/React.createElement("span", null, tab.label), tab.count != null && /*#__PURE__*/React.createElement("span", {
    className: "ds-tab__count"
  }, tab.count))));
}
Object.assign(__ds_scope, { TabList });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/TabList.jsx", error: String((e && e.message) || e) }); }

// components/core/WmbCreatureMark.jsx
try { (() => {
/**
 * WMB Creature Mark — the product's brand creature.
 * Geometry is copied exactly from src/renderer/wmb-brand-mark.tsx
 * (viewBox 0 0 751 510, identical paths and classes); motion CSS
 * lives in styles/components.css (source: styles-foundation.css).
 * Decorative only — always aria-hidden.
 * States: idle / connect / working / settling / sleep / scout.
 */
function WmbCreatureMark({
  state = 'idle',
  className = ''
}) {
  const eyeClipId = React.useId();
  return /*#__PURE__*/React.createElement("span", {
    className: `wmb-creature-mark is-${state}${className ? ` ${className}` : ''}`,
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("svg", {
    className: "wmb-creature-logo",
    viewBox: "0 0 751 510"
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("clipPath", {
    id: eyeClipId
  }, /*#__PURE__*/React.createElement("path", {
    d: "M216,264 L229,248 L256,221 L274,207 L297,193 L317,184 L341,177 L359,174 L392,174 L411,177 L434,184 L454,193 L474,205 L496,222 L512,237 L532,259 L536,266 L490,304 L465,320 L445,330 L427,337 L402,343 L386,345 L363,345 L331,339 L311,332 L285,319 L251,296 L216,266Z"
  }))), /*#__PURE__*/React.createElement("g", {
    className: "wmb-creature-body"
  }, /*#__PURE__*/React.createElement("path", {
    className: "wmb-creature-purple",
    d: "M749,0 L615,1 L534,200 L531,203 L540,210 L540,212 L538,213 L544,213 L553,222 L552,225 L556,225 L556,230 L557,228 L559,228 L564,233 L563,238 L569,239 L578,248 L577,252 L579,253 L579,255 L584,255 L596,268 L594,272 L599,277 L604,277 L603,280 L607,281 L606,284 L609,284 L612,287 L611,291 L615,295 L618,294 L621,298 L621,300 L618,302 L623,301 L625,307 L643,267 L751,2Z"
  }), /*#__PURE__*/React.createElement("path", {
    className: "wmb-creature-white",
    fillRule: "evenodd",
    d: "M0,1 L211,510 L216,509 L246,455 L309,349 L357,373 L371,377 L380,377 L396,371 L415,361 L442,343 L445,343 L450,350 L534,505 L538,510 L541,510 L543,508 L626,306 L589,261 L529,200 L377,77 L374,77 L226,197 L220,200 L216,194 L138,1Z M216,264 L229,248 L256,221 L274,207 L297,193 L317,184 L341,177 L359,174 L392,174 L411,177 L434,184 L454,193 L474,205 L496,222 L512,237 L532,259 L536,266 L490,304 L465,320 L445,330 L427,337 L402,343 L386,345 L363,345 L331,339 L311,332 L285,319 L251,296 L216,266Z"
  }), /*#__PURE__*/React.createElement("g", {
    className: "wmb-creature-pupil-track"
  }, /*#__PURE__*/React.createElement("path", {
    className: "wmb-creature-pupil",
    d: "M370,213 L358,216 L350,220 L340,228 L331,242 L328,252 L327,264 L331,280 L336,289 L343,297 L356,305 L365,308 L378,309 L392,306 L403,300 L411,293 L420,278 L423,258 L420,244 L414,233 L407,225 L400,220 L386,214Z"
  })), /*#__PURE__*/React.createElement("g", {
    className: "wmb-creature-lids",
    clipPath: `url(#${eyeClipId})`
  }, /*#__PURE__*/React.createElement("path", {
    className: "wmb-creature-upper-lid",
    d: "M180,-200 H570 V174 C485,242 285,242 180,174 Z"
  })))), /*#__PURE__*/React.createElement("svg", {
    className: "wmb-creature-connect-current",
    viewBox: "0 0 230 158"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18 88 L48 88 L58 72 L72 103 L88 80"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M212 70 L183 70 L171 53 L157 91 L142 76"
  })), /*#__PURE__*/React.createElement("span", {
    className: "wmb-creature-work-fx"
  }, /*#__PURE__*/React.createElement("i", {
    className: "work-item one"
  }), /*#__PURE__*/React.createElement("i", {
    className: "work-item two"
  }), /*#__PURE__*/React.createElement("i", {
    className: "work-progress"
  })));
}
Object.assign(__ds_scope, { WmbCreatureMark });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/WmbCreatureMark.jsx", error: String((e && e.message) || e) }); }

__ds_ns.AppModal = __ds_scope.AppModal;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.ChipFilter = __ds_scope.ChipFilter;

__ds_ns.FormField = __ds_scope.FormField;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.PageCommand = __ds_scope.PageCommand;

__ds_ns.RoleCard = __ds_scope.RoleCard;

__ds_ns.StatePanel = __ds_scope.StatePanel;

__ds_ns.StatusPill = __ds_scope.StatusPill;

__ds_ns.TabList = __ds_scope.TabList;

__ds_ns.WmbCreatureMark = __ds_scope.WmbCreatureMark;

})();
