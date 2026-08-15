# WMB-5266 evidence

Date: 2026-08-15

## Corrections

- `src/renderer/styles-studio.css`
  - Publish tab focus no longer draws the global rectangular outline. Keyboard focus remains visible through the same accent underline used for the active tab.
  - `.publish-matrix-scroller` is now only the scrolling mechanism; it has no border, radius, or panel fill.
  - `.publish-matrix` now owns the single 1px border, 12px radius, panel surface, and clipping boundary, so rectangular cells terminate at the actual rounded table edge.
- `tests/e2e/publish.test.mjs`
  - PB-001 now asserts the active tab has no outline but retains its underline.
  - PB-001 now asserts the scroller has no frame and the matrix itself owns the single rounded boundary.

## Verification

- Command: `npm run e2e -- --file tests/e2e/publish.test.mjs --scenario PB-001-publish-list-normal`
- Result: 1/1 PASS, 0 failures.
- Evidence directory: `tests/e2e/.artifacts/PB-001-publish-list-normal-gTlbWO/`
- Desktop screenshot: `publish-matrix-desktop-screenshot.png`
- Compact screenshot: `publish-matrix-compact-screenshot.png`
- Visual inspection: no selected-tab rectangle; only the violet underline remains. Table border and cell clipping share one 12px rounded contour at desktop and compact widths.
- Protocol, IPC, DB schema, permissions, Capability registry, dependencies, and foundation brand tokens: unchanged.
