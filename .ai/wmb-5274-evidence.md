# WMB-5274 Evidence

## Problem

Owner screenshot showed two Today source-detail defects:

- Source/tweet text was styled as a 28px heading, making body content disproportionately large.
- `在资料库中查看` used a transparent ghost treatment and lacked a recognizable button surface.

## Decision

- `src/renderer/styles-workflow-today.css`: `.detail-title` now uses body-level typography: `16px`, weight `500`, `1.7` line-height, normal letter spacing, `70ch` measure.
- `src/renderer/today-view-panels.tsx`: `在资料库中查看` now reuses the shared `secondary-button` component style.
- Removed the Today-only ghost-button override. `加入 Pi 上下文` remains the sole violet primary action.
- `tests/e2e/wmb-5251-modal-migration.test.mjs`: the real Electron contract now asserts 16px source text, readable line-height, two secondary actions, and a visible bordered/non-transparent library button surface.

## Verification

- `npm run typecheck`: PASS.
- `node --check tests/e2e/wmb-5251-modal-migration.test.mjs`: PASS.
- `node --test tests/design-tokens-drift.test.mjs`: 3/3 PASS.
- Real Electron:
  - `WMB-5270-today-inline-detail-contract`: 1/1 PASS.
  - Computed source text: 16px with body line-height.
  - Library action: shared secondary button, 1px border, non-transparent surface, 7px radius.
  - Pi context: sole violet action.
  - Horizontal overflow: 0; page errors: 0.
- Artifact: `tests/e2e/.artifacts/WMB-5270-today-inline-detail-contract-pFeLBV/inline-source-image-screenshot.png`.

The first two Electron attempts were blocked by a stale persistent Vite transform serving an empty `today-view-panels.tsx` module. The managed project app was restarted, the served module was confirmed to export `FermentingRail`, and the focused Electron acceptance then passed. The app is ready after restart.
