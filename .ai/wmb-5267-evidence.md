# WMB-5267 evidence

Date: 2026-08-15

## Change

- `src/renderer/styles-studio.css`
  - `.publish-matrix-wrap` now uses one `12px` inset on all four sides, using the approved top spacing as the single reference.
  - Removed the compact breakpoint's separate `16px` horizontal matrix inset.
  - `.publish-matrix` now has `min-height: 100%` with `align-content: start`: rows remain naturally sized at the top while the single rounded matrix boundary expands to the available bottom edge.
  - More rows can still grow beyond the viewport and use the existing matrix scroller.
- `tests/e2e/publish.test.mjs`
  - PB-001 asserts 12px top/right/bottom/left spacing at 1600, 1366, and 1100 widths.
  - PB-001 asserts the matrix rounded boundary fills the scroller's available height.

## Verification

- `npm run e2e -- --file tests/e2e/publish.test.mjs --scenario PB-001-publish-list-normal`
- Result: 1/1 PASS, 0 failures.
- Evidence: `tests/e2e/.artifacts/PB-001-publish-list-normal-rMBWDE/`
- Desktop and compact screenshots confirm the rounded matrix stays 12px from the top, left, right, and bottom edges, while cell rows remain compact at the top.
- No protocol, IPC, DB schema, permission, capability, dependency, or foundation token change.
