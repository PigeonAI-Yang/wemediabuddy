# WMB-5270 evidence

Date: 2026-08-15

## Problem reproduced

The previous Today source detail opened as a viewport-sized `AppModal`. Real Electron evidence showed the dialog covering the working surface and imposing modal-only behavior (backdrop, body scroll lock, focus trap) on a normal read-and-act flow.

Baseline evidence: `tests/e2e/.artifacts/WMB-5251-today-modal-contract-jnx916/focused-source-image-screenshot.png`.

## Decision and implementation

- Replaced `TodaySourcesModal` with the inline `TodaySourceDetail` subpage inside Today.
- Preserved the global sidebar, top chrome, and Pi dock while reading a source.
- Added explicit `返回今日`; `Escape` also returns and restores focus to the exact feed source trigger.
- Preserved source identity, title, summary, body archive state/actions, local image/video evidence preview, copyright/source URL, library jump, original URL, and Pi context toggle.
- Removed the obsolete source-detail modal component, open state, footer action cluster, backdrop, scroll lock, and focus trap.
- Reused foundation variables only. No Source/IPC/schema/permission/Capability/dependency/brand-token changes.

Changed files:

- `src/renderer/today-view.tsx`
- `src/renderer/today-view-panels.tsx`
- `src/renderer/styles-workflow-today.css`
- `tests/e2e/wmb-5251-modal-migration.test.mjs`

## Verification

- `npm run typecheck` — PASS.
- `node --test tests/design-tokens-drift.test.mjs` — 3/3 PASS.
- `node --test tests/e2e/wmb-5251-modal-migration.test.mjs` — PASS.
- Real Electron `WMB-5270-today-inline-detail-contract` — 1/1 PASS: no modal DOM, no body scroll lock, sidebar and Pi remain present, local image/video previews use `wmb-asset://`, Pi/body actions work, Escape returns and restores focus, empty-media source remains truthful, page errors 0.
- Real Electron `WMB-5270-inline-detail-responsive` — 1/1 PASS: Pi expanded at 1183×871 and minimum 1100×800, detail remains inside viewport, horizontal overflow 0, core actions remain available, page errors 0.

Final evidence:

- `tests/e2e/.artifacts/WMB-5270-today-inline-detail-contract-YgCfja/inline-source-image-screenshot.png`
- `tests/e2e/.artifacts/WMB-5270-today-inline-detail-contract-YgCfja/inline-source-video-screenshot.png`
- `tests/e2e/.artifacts/WMB-5270-inline-detail-responsive-vZBsa7/`
