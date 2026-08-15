# WMB-5258 — Whole-frontend consistency audit

Date: 2026-08-14
Status: audit complete; no product UI, business contract, DB schema, permission, dependency, or brand-token change

## Decision

The frontend is **brand-consistent but not yet system-consistent**.

What already holds:

- `src/renderer/styles-foundation.css` is visibly in control: 墨夜/白昼 themes, Inter stack, 56px topbar, One Violet, shared chrome, and semantic colors are coherent.
- All inspected navigation surfaces rendered in both themes without horizontal overflow at 1600×960; all rendered without horizontal overflow at the product minimum width 1100×720.
- Page CSS is token-clean: the drift gate found no page-level hex/rgb/hsl and its allowlist is empty.
- The shared `AppModal`, `.page-command`, Agents full-card button pattern, Wiki discovery four-state panels, Topic Wiki reading layout, honest compile states, and Canvas full-canvas exception are strong reusable precedents.

What does not hold:

- Layout, component ownership, accessibility semantics, loading/error behavior, terminology, and responsive density have multiple competing contracts.
- The same semantic class is often redefined in page sheets; import order and `!important` patches are part of the effective UI API.
- At the supported 1100px minimum width, keeping the 216px sidebar and 380px Pi dock leaves only 504px for the workspace. Nothing overflows, but the main work area is materially compressed.
- Core clickable rows/cards on Today, Discover/X Lists, Proposals, and parts of Library are mouse-only. The persistent Pi composer has no accessible name.

No P0 was found. The migration should preserve the current visual identity and product room semantics; it should not introduce a new palette or make every room look identical.

## Scope and method

Inspected source:

- Shared shell and entry: `src/renderer/main.tsx`, `app-shell.tsx`, `styles.css`, `styles-foundation.css`, `styles-modal.css`, `styles-pi.css`, shared modal/confirm components.
- Formal navigation surfaces: Today, Agents, Discover (rankings and X Lists), Proposals, Topics, Relationship Canvas, Studio, Publish, Results, Library, Settings.
- Supporting surfaces: onboarding, browser settings, Pi settings, update banner, crop/confirm overlays, shared empty/loading/error/status patterns.
- Authority: foundation CSS, `docs/design/living-style-guide.html`, `DESIGN.md`, and `PRODUCT.md` C1–C7/C8.

Runtime verification:

- Real Electron E2E visited all 11 formal navigation views at 1600×960, captured DOM metrics and screenshots, then repeated at 1100×720.
- Representative Today, Agents, Studio, Publish, Library, and Settings surfaces were also captured in the light theme.
- Runtime result: 1/1 scenario passed in 14.6s; temporary scenario removed after the run.
- Evidence directory: `tests/e2e/.artifacts/frontend-consistency-audit-D33KUC/`
  - `desktop-dark-montage.jpg`
  - `compact-dark-montage.jpg`
  - `light-montage.jpg`
  - individual page screenshots and `evidence.jsonl`

## Mechanical census

| Measure | Result |
| --- | ---: |
| CSS files | 23 |
| CSS lines | 9,935 |
| Page-sheet lines excluding foundation/hub | 9,319 |
| TSX files | 59 |
| Selector occurrences / distinct selectors | 3,844 / 3,500 |
| Approximate declarations | 11,600 |
| `!important` | 60 |
| Media queries | 41 |
| Distinct viewport widths | 15 |
| Font sizes used | 25 |
| Radius values used | 25 |
| Padding values used | 209 |
| Gap values used | 45 |
| z-index values | 28 (`-1` through `4100`) |
| Hard-coded colors outside foundation | 0 |

Three undefined variable names currently degrade silently:

- `--topbar` and `--text-secondary` in `styles-knowledge.css`; the authority names are `--topbar-bg`/other ink tokens.
- `--font-mono` in `styles-pi.css` and `styles-workflow-library.css`; the authority name is `--mono`.

## Existing frontend grammar

### Shell

- Grid: 216px sidebar, flexible workspace, Pi `clamp(340px, 24vw, 400px)`; topbar 56px; status bar 34px.
- Settings and Studio intentionally use shell variants. Canvas intentionally uses a free-form full workspace.
- Dark/light token pairs and focus-visible styles are generally present.
- Current responsive behavior is mostly “compress internal columns”; it does not protect a minimum workspace width while Pi is open.

### Strong patterns to standardize

1. `.page-command`: a 96px room command card with room summary/stat navigation and at most one primary action.
2. Agents `.agents-role-card`: a real full-card button with keyboard and focus behavior.
3. `AppModal`: one focus trap, Esc/backdrop policy, scroll lock, return focus, and compact fullscreen degradation.
4. Library tabs: actual `tablist`/`tab`, selected state, and arrow/Home/End keyboard behavior.
5. Wiki discovery panels: explicit loading, empty, error+retry, and content states with race guards.
6. Topic Wiki: centered 1080px reading column and honest uncompiled/legacy/compiled states.
7. Status dot plus text: never color alone.
8. One Violet: one primary action per view; current inspected screens respect it.

## Severity matrix

### P1 — fix before broad visual migration

| Gap | Evidence | User/risk impact |
| --- | --- | --- |
| Primary decision cards/rows are click-only | Today opportunity `<article onClick>` and feed `<div onClick>`; Discover ranking/X timeline cards; Proposal rows; removed Library rows | Keyboard users cannot execute core review/navigation paths. Use a real button/link; cards with nested actions must expose an explicit primary button rather than an interactive parent. |
| Persistent Pi composer lacks an accessible name | `pi-composer.tsx` textarea has role/expanded/controls and placeholder, but no label or `aria-label`; runtime found one unnamed visible field on every normal Pi-open room | A shared accessibility failure propagates across most of the product. |
| Generic component classes are page-owned and cascade-dependent | `.chip` in `styles-knowledge.css`; `.empty-state`, `.pill-status`, `.danger-button` in `styles-studio.css`; `.muted !important` in Library; `.eyebrow` defined differently in three files | Reordering/removing one feature sheet silently changes unrelated rooms. This is the main maintainability blocker. |
| Buttons have no single owner | `.primary-button` and `.secondary-button` are defined in eight sheets each and render at roughly 26–40px depending on container | Same action hierarchy has different density and hit targets. |
| Supported minimum width does not protect workspace | Electron measurement at 1100×720: sidebar 216px, Pi 380px, workspace 504px | No overflow, but the principal room is squeezed below a practical working width. |
| Undefined foundation variables | Three undefined names/four references listed above | Styles silently fall back or inherit; current gates do not detect this. |

### P2 — systemic consistency debt

| Gap | Evidence | User/risk impact |
| --- | --- | --- |
| Page identity/heading contract is absent | 7 of 11 runtime views had no visible H1; Discover had no heading at all; Settings repeats “设置” in topbar, nav and content | Weak visual/assistive landmarks and inconsistent room identity. |
| Scroll ownership has at least five models | full page, fixed-height inner scroller, grid-child scrollers, fixed canvas, and settings body scroll | Sticky regions, scroll restoration, and compact behavior vary by page. |
| Four-state loading contract is not universal | Library saved/watching/pending/removed sections render empty copy while loading and have no error path; Wiki panels already implement the correct four states | Users can be told “没有资料” when data is merely loading or IPC failed. |
| Modal/confirmation contract has exceptions | Topic restore uses `window.confirm`; Publish has custom crop dialogs; Canvas health uses a custom role=dialog popover without the shared focus/Esc contract; `AppConfirm` is another overlay implementation | Focus behavior and visual treatment differ for equivalent overlays. |
| Tabs/filters/status have several semantics and looks | Library proper tabs; Topic aria-pressed/plain tabs; Proposal plain buttons; chip/filter/status-dot families vary | Same control behaves differently across adjacent rooms. |
| User language leaks implementation detail | task IDs/intent/state, raw receipt/topic IDs, DB/assets paths, browser-lock wording; MCP is named “小红书 MCP / 外部 MCP / MCP Bridge” | Product shifts from 主编台 language toward an engineering console. |
| Status can be color-only | Publish `.health-dot` | State is inaccessible and ambiguous without color. |
| Scale and breakpoint values are unconstrained | 25 font sizes, 25 radii, 209 padding values, 45 gaps, 15 viewport widths; 1279 and 1280 both used | Small local changes continue to create new visual dialects. |

### P3 — localized cleanup

- Canvas page naming is split among “关系画布”, “全局知识网络”, “知识网络”, and PRODUCT “关系墙”.
- Knowledge health status says both “未处理” and “未解决”; label maps are duplicated.
- Library and Topic sibling detail pages use different title/body scales without a declared reason.
- Settings always returns to Today instead of the entry room and does not mark its current nav item with `aria-current`.
- Legacy Canvas/Topic selectors remain globally imported; dead selector families and `!important` patches obscure ownership.
- Foundation contains component-level hard-coded danger colors (including a dark-oriented value that does not adapt in light theme); these should consume existing semantic tokens without changing the token values.
- Several loading regions lack `role="status"`; a few small click targets still have partial keyboard behavior.

## Surface matrix

| Surface | Current form | Preserve | Normalize |
| --- | --- | --- | --- |
| Today | fixed-height decision desk with own scroller and 96px command card | desk semantics, one main action, opportunity/feed hierarchy | use canonical command header; keyboard-safe cards; canonical states/status/filter density |
| Agents | bespoke roster/work-ledger room | role-card accessibility pattern, orchestration semantics | one page title; shared state and button primitives; remove operator jargon from default view |
| Discover | centered list with command stats and Rankings/X Lists modes | source switching and rank/list distinction | visible H1; keyboard-safe rows; canonical tabs/filters/loading |
| Proposals | command card, tabs, batch list | batch decision flow and One Violet | real tab semantics; keyboard-safe rows; canonical buttons/status |
| Topics | home/detail modes plus 1080px Wiki reading page | honest compile state, reading hierarchy, evidence/deep modes | one room/detail heading contract; shared labels/tabs/states |
| Relationship Canvas | full-canvas graph with floating controls | explicit canvas exception, 2.5D graph, keyboard nodes, reduced motion | one product name/H1; shared dialog/popover contract; delete legacy CSS |
| Studio | complex editor/project workspace | editor-specific multi-pane exception and version/annotation modal | shared chrome/buttons/status/empty-error language; declare its scroll owners |
| Publish | review/confirmation workspace | manual final publishing boundary and platform preparation | semantic status text; shared crop modal; user-language terminology; canonical control density |
| Results | result/review panels | output grouping and health summary | one page identity; shared loading/error/empty and action hierarchy |
| Library | tab-first knowledge repository | correct tab keyboard pattern, Wiki tooling | truthful four states; visible page title; one row interaction pattern; shared labels |
| Settings | full-width settings room with secondary nav | form patterns and grouped sections | one “设置” identity, return-to-origin, `aria-current`, canonical helper/error copy |

## Unified frontend contract

### 1. Authority and ownership

- Foundation remains the only color/font/chrome authority. Do not change `--accent*`, app background, Inter stack, topbar height, or core ink/surface/border scales in this migration.
- `styles-foundation.css`: tokens, reset, shell chrome, theme pairing only.
- `styles-workflow.css`: owner for reusable product primitives already shared across rooms: buttons, icon buttons, chips/filters, tabs, status, field shell, empty/loading/error, page command/header, cards, and compact density.
- Feature sheets may style only namespaced feature structures. They must not define unscoped shared primitives.
- Every generic class has one definition owner. Overrides require a named modifier, not a later import or container-specific recreation.

### 2. Three approved room forms

1. **Desk/list room** — shell + one room scroll owner + canonical page command/header + content sections. Used by Today, Discover, Proposals, Agents, Results, and Library where applicable.
2. **Reading/detail room** — centered bounded reading column, explicit back/breadcrumb, one title, document hierarchy. Used by Topic Wiki and source details.
3. **Workspace exception** — Canvas and Studio may be edge-to-edge/multi-pane, but must declare pane scroll owners and consume the same primitives, modal contract, status language, focus, themes, and responsive shell rules.

No fourth ad-hoc page skeleton.

### 3. Identity and hierarchy

- Exactly one page-level H1 per room state; Canvas may visually integrate it into the breadcrumb but must expose the same landmark.
- H2 for primary sections; H3 for cards/subsections. Do not use eyebrow text as a substitute for a heading.
- Use the established 34/25/18/13 hierarchy plus one 12px metadata tier. New arbitrary font sizes require a documented exception.
- Page title, sidebar label, Pi page label, and PRODUCT room name come from one shared label map.

### 4. Actions and controls

- One primary violet action per view. Primary = 40px normal density; compact = 32px. Navigation-row 38px is a shell exception.
- Secondary, text, icon, danger, and destructive-confirm actions each have one shared variant.
- A card without nested controls may be a real full-card button/link. A card with nested controls is not itself clickable; expose an explicit real primary button/link.
- Tabs use one `tablist/tab` contract with selected state and arrow/Home/End navigation. Filters use one separate pressed-chip contract.
- All form fields have programmatic names; placeholder text is never the label.

### 5. States and overlays

- Every async region has exactly four states: loading, error with retry, honest empty, content. Loading must not render empty copy.
- Status always pairs icon/dot with a word. Use the shared semantic status vocabulary.
- Modal dialogs and confirmations use the shared modal/focus infrastructure. Popovers that do not need trapping use a separate named popover contract with Esc, focus return, outside-dismiss, and `aria-expanded`/`aria-controls`.
- No native `window.confirm` and no page-owned focus trap.

### 6. Responsive behavior

- Product remains desktop-first; no mobile redesign.
- At widths below 1280px, Pi must not permanently subtract from the room width: default it collapsed or open it as a non-resizing overlay. Explicit Pi use remains available.
- At the Electron minimum width, sidebar and workspace must not create horizontal overflow, and the workspace should remain at least 760px when Pi is not actively overlaid.
- Use a small named breakpoint set; remove the 1279/1280 split and duplicate 799/699 contracts.
- Each room has one vertical scroll owner. Nested scrolling is allowed only for declared editor/canvas panes.

### 7. Theme, motion, and language

- Dark and light consume the same semantic variables; component rules never hard-code theme colors.
- Reduced-motion has a static equivalent for every nonessential transition/animation.
- Default copy is Chinese user language. Machine IDs, paths, revisions, intent/state codes, and runtime diagnostics live under an explicit “技术详情” disclosure.
- Standardize product nouns, including one public Xiaohongshu MCP label and one public Canvas room name.

## Migration sequence

Each batch is independently reversible and must not change business logic, IPC contracts, DB schema, permissions, capability registry, publishing boundary, or brand-level token values.

### Batch A — accessibility and broken contracts

Scope:

- `pi-composer.tsx`
- Today/Discover/X Lists/Proposals/Library interactive rows
- Publish status markers
- undefined token references

Deliver:

- Named Pi composer, keyboard-complete primary cards/rows, text-encoded status, resolved variables.

Acceptance:

- Zero unnamed visible fields on all 11 rooms.
- Every primary row/card path works with Tab and Enter/Space without double-triggering nested actions.
- Undefined-variable gate reports zero.
- Dark/light 1600×960 and compact 1100×720 Electron smoke passes.

### Batch B — primitive ownership and finite scales

Scope:

- `styles-workflow.css`, `styles-foundation.css`, `styles.css`
- all feature sheets that currently define generic buttons/chips/tabs/status/empty-state/eyebrow classes

Deliver:

- One owner per generic primitive; named normal/compact variants; generic classes removed from feature sheets; page `!important` patch layer reduced.

Acceptance:

- Same action variant has the same computed height/padding/radius in every room.
- No generic exact selector is defined in multiple CSS files.
- Existing token-drift gate remains 3/3 with empty allowlist.
- No brand-level token value changes.

### Batch C — shell, page identity, scroll, and compact Pi

Scope:

- `main.tsx`, `app-shell.tsx`, foundation shell CSS, Pi dock shell CSS
- room root/header wrappers

Deliver:

- Three approved room forms, exactly one room H1, single scroll-owner declarations, and compact Pi behavior that preserves workspace width.

Acceptance:

- All 11 views: one H1/accessible room name, no horizontal overflow.
- At 1100×720, non-overlaid workspace width is at least 760px.
- Pi remains openable, closable, focusable, and state-persistent; overlay does not resize the room.
- Canvas and Studio exceptions remain functional.

### Batch D — workflow rooms

Scope:

- Today, Agents, Discover, Proposals, Studio, Publish, Results renderer/CSS files

Deliver:

- Canonical page command/header, buttons, tabs/filters, status, and four-state regions; user-language copy; preserve each room’s PRODUCT role.

Acceptance:

- Each room has at most one primary violet action in a state.
- Shared tabs and filters have identical keyboard semantics and computed geometry.
- Loading/error/empty/content branches are distinguishable and exercised.
- No operator-only field is exposed outside “技术详情”.

### Batch E — knowledge, settings, and overlays

Scope:

- Library, Topics, Canvas, Settings, onboarding, AppModal/AppConfirm, crop and health overlays

Deliver:

- Truthful Library states; shared label maps; one Canvas name; one modal/confirm contract; return-to-origin Settings; dead legacy CSS removal.

Acceptance:

- IPC failure never renders as empty data.
- No `window.confirm`; dialogs pass focus trap/Esc/backdrop/return-focus checks; popovers pass their lighter contract.
- Library/Topic status labels are byte-identical from a shared map.
- Settings returns to the invoking room and marks current section.

### Batch F — enforcement and final visual acceptance

Scope:

- focused tests, design gates, Electron E2E journeys, verification documentation

Deliver:

- Gates for undefined variables, one-owner generic selectors, finite scales/breakpoints, `!important` budget, accessible names, and representative dark/light/compact visual contracts.

Acceptance:

- Design-token drift 3/3.
- TypeScript pass.
- Focused behavior suites pass.
- Real Electron matrix: 11 rooms at 1600×960 dark; representative six at 1600×960 light; all 11 at 1100×720; Pi open/collapsed/overlay; zero horizontal overflow and zero unnamed visible controls.
- Test tabs closed and isolated Electron/Chromium processes exited.

## Final assessment

Do not redesign the product from scratch. Preserve the visual authority and the best existing room-specific patterns. The high-leverage correction is to make ownership, semantics, states, and responsive behavior singular; page-by-page cosmetic restyling before those contracts would recreate the same drift.