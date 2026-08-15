# WMB-5263 Evidence

Date: 2026-08-15

## Deliverable

- Added `designs/publish-workspace-alternatives/distribution-matrix-v2.html`.
- Preserved approved v1 `distribution-matrix.html` byte-for-byte; SHA-256 remained `595e96f59c8000692728a4291b9f01713420eb37e7f0bd3757b56ba840155220` before and after.
- Registered v2 in `designs/publish-workspace-alternatives/_d_meta.json` as a separate review version.
- Prototype-only change. Formal renderer, protocol, IPC, DB schema, permissions, Capability registry, dependencies, brand tokens, and manual final-publication boundary unchanged.

## Contract checks

- Removed the persistent right action rail; `.c-main` is a single full-width matrix canvas.
- Added publish-local hierarchy: room identity `发布台`, secondary tabs `分发总盘 / 待我处理 / 发布记录`, and matrix-only filter chips.
- Content title opens a full-canvas detail subpage with breadcrumb/back/Esc, content/version/media summary, five platform tasks, and associated feedback.
- Platform status cells open focused task modals. Authorization, manual publication, takeover, failure retry, reconciliation, receipt, and published states remain available on demand.
- Six-state matrix retained; Pi remains collapsed by default and overlays rather than consuming grid width; dark/light themes retained.

## Runtime verification

Real Chromium loaded `distribution-matrix-v2.html` with console/page errors `0`.

- 1600×960 matrix: document `overflowX=0`; no `.c-stage` / `.c-action-stage`; Pi `aria-hidden=true`.
- Failed cell opened `重试发布 · X`; task context included platform/account/content/version/status; primary action `重试发布`; matrix remained mounted behind the modal.
- Content drilldown occupied `1600×855`; matrix rect became `0×0`; breadcrumb `发布工作台 / 分发总盘 / AI 入门课：30 天从工具到工作流`; five platform tasks rendered; document `overflowX=0`.
- 1100×800 matrix: document `overflowX=0`; matrix width `1068px`; no persistent rail; Pi collapsed; all three secondary tabs visible.
- Light theme switched successfully; `待我处理 12` became the selected secondary view; document `overflowX=0`.
- Visual evidence: `J:/Users/yangda01/Temp/omp-sshots-1557ab1e77bc7017.webp` (detail subpage) and `J:/Users/yangda01/Temp/omp-sshots-1557ab364ffc7018.webp` (compact matrix).

## Resource cleanup

- Test tab closed.
- Managed test browser `omp.browser.headless` exited.
- Prototype preview server `wmb-publish-prototypes` exited.
