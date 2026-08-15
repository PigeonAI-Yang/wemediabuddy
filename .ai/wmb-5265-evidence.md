# WMB-5265 evidence

Date: 2026-08-15

## Delivered

- Restored the Owner-approved Baoyu v3 distribution-matrix hierarchy into the formal Electron publish renderer.
- `src/renderer/publishing-results-view.tsx`
  - One `发布` heading, one queue instruction, `刷新` and `继续发布` actions.
  - Flat content × supported-platform matrix; no repeated task/tab/column/+N counts.
  - User-facing action/meaning cells; `prepared` is truthfully rendered as `继续发布 / 内容已准备好` rather than claiming the authenticated account is logged out.
  - Existing content detail subpage, task modal, six-state projection, platform-disabled history behavior, X/知乎/微信/小红书 manual boundaries, authorize/takeover/reconcile/readback/return-to-edit callbacks retained.
- `src/renderer/styles-studio.css`
  - Formal v3 room header, view tabs, sticky matrix header/content column, 108px project rows, 88px minimum action cells, compact detail/modal styling.
  - Responsive column floors: 1600 = 288/178; 1366 = 260/165; 1100 = 240/160 (content/platform).
  - `.publish-matrix-scroller` remains the sole horizontal overflow owner; page shell does not overflow.
  - Corrected nested grid rows to span the matrix (`grid-column: 1 / -1`); visual inspection confirms platform headers and project cells align in separate rows.
- `tests/e2e/publish.test.mjs`
  - Added formal Electron assertions for 1600×960, 1366×960, and 1100×800 geometry, shell overflow, internal matrix scrolling, v3 copy, removed duplicate counts, details, modal actions, DB transitions, and manual publication boundaries.

No DB schema, IPC, permission, Capability registry, dependency, foundation brand token, or final-publication boundary changed.

## Verification

- `npm run typecheck` — PASS.
- `node --test tests/design-tokens-drift.test.mjs` — PASS, 3/3.
- `npm run e2e -- --file tests/e2e/publish.test.mjs` — PASS, 7/7:
  - PB-001 matrix, Pi, responsive geometry, details, modal, persistence.
  - PB-002 empty state.
  - PB-003 prepared actions and disabled-platform history.
  - PB-004 takeover.
  - PB-005 unknown reconciliation.
  - PB-009 failure/recovery.
  - PB-010 return to edit and audit persistence.

## Real Electron visual evidence

Final run root:

- `tests/e2e/.artifacts/PB-001-publish-list-normal-ylzqfu/`
- Desktop: `publish-matrix-desktop-screenshot.png` (1600×960).
- Mid: `publish-matrix-mid-screenshot.png` (1366×960).
- Compact: `publish-matrix-compact-screenshot.png` (1100×800).
- Page-error files are empty for all three captures.

The corrected layout was visually inspected at all three viewports: one formal title/instruction, one flat matrix, aligned platform columns and project row, no duplicated counts, no shell overflow.

## Runtime cleanup

- E2E test Electron instances exited after each scenario through the runner.
- `wmb-5265-final-e2e`: exited.
- Obsolete prototype preview `wmb-publish-redesign-4313`: exited.
- Managed process check shows no live test browser or publish preview process.
