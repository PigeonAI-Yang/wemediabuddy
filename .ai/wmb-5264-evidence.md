# WMB-5264 Evidence — Matrix-first Publish Workspace

Date: 2026-08-15

## Delivered

- Replaced the formal Electron Publish page's legacy queue/preview/confirmation-rail composition with the Owner-approved matrix-first model.
- Primary canvas: real content-project rows × real enabled/data-present platform columns.
- Page hierarchy: `分发总盘` / `待我处理` / `发布记录`; board-only status and platform filters.
- Project title opens an in-page detail subpage with breadcrumb, back action, and Esc return.
- Platform task cell opens shared `AppModal`; the dialog retains real account/version/media facts, payload, timeline, failure reason, and existing authorize/edit/takeover/reconcile/WeChat-readback actions.
- Preserved six-state semantics, disabled-platform history, Xiaohongshu/Zhihu manual-final-publication boundaries, and returned-draft history.
- Preserved formal left navigation and sibling right Pi dock. Pi expansion changes the shell grid width; it does not overlay or remove the publish matrix.
- Empty publish state still reaches Studio.

## Changed files

- `src/renderer/publishing-results-view.tsx`
- `src/renderer/styles-studio.css`
- `src/renderer/styles-pi.css`
- `tests/e2e/publish.test.mjs`

No DB schema, IPC, permission, Capability registry, dependency, foundation token, or brand-token change.

## Verification

- `npm run typecheck` — PASS.
- `node --test tests/design-tokens-drift.test.mjs` — PASS, 3/3.
- `npm run e2e -- --file tests/e2e/publish.test.mjs` against the production Vite renderer — PASS, 7/7:
  - matrix/list normal
  - empty state
  - prepared authorization/edit actions
  - needs-user takeover
  - unknown reconciliation
  - operation failure
  - return-to-edit
- PB-001 additionally proves:
  - formal left navigation and right Pi both exist;
  - expanding Pi narrows the workspace/matrix and collapsing it widens them;
  - 1600×960 and 1100×800 preserve shell containment with no document-level horizontal overflow;
  - compact horizontal expansion is owned by `.publish-matrix-scroller`.

## Visual evidence

- Desktop 1600×960: `tests/e2e/.artifacts/PB-001-publish-list-normal-TjRCfJ/publish-matrix-desktop-screenshot.png`
- Compact 1100×800: `tests/e2e/.artifacts/PB-001-publish-list-normal-TjRCfJ/publish-matrix-compact-screenshot.png`
- Full focused run result: `tests/e2e/.runtime/results.json`

Visual inspection: desktop keeps the matrix as the center workspace between the 216px navigation and open Pi; compact keeps both shell rails, wraps page filters, and confines platform columns to the matrix scroller.

## Build note

`npm run package` could not pass its preflight because the local Xiaohongshu MCP executable resource is absent. A direct `npx electron-forge package` completed the production Vite renderer build and Electron packaging, then stopped at the existing post-package skill-mirror revision gate. This did not affect the focused Electron E2E run, which loaded the generated production renderer and passed 7/7.

## Resource cleanup

The temporary managed `wmb-publish-dev` process was stopped. Focused E2E apps close through the harness after each scenario; no test Electron instance remains from the run.
