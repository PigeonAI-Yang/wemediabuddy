# WMB-5272 — Today source detail shell unification

Date: 2026-08-15

## Delivered

- `src/renderer/today-view-panels.tsx`: the source detail is one page-owned card; back and all source actions live in its header.
- `src/renderer/styles-workflow-today.css`: one `var(--surface)` boundary with 12px radius, `var(--page-space)` four-sided inset, natural overflow, 36px controls, one violet primary action, responsive single-column media.
- Preserved source identity, summary, archived image/video evidence, body-archive states/excerpt, provenance, library/original/Pi actions, Esc/back focus, themes, and minimum-width behavior.
- Corrected the E2E bottom-inset measurement to use section-relative geometry rather than viewport coordinates.

## Verification

- `npm run typecheck`: PASS.
- `node --test tests/design-tokens-drift.test.mjs`: 3/3 PASS.
- Real Electron: `WMB-5270-today-inline-detail-contract` 1/1 PASS after the shell correction. It covers 1600×960, Pi-expanded 1183×871, 1100×800, image/video/processing states, bottom reachability, horizontal overflow 0, and page errors 0.
- Evidence: `tests/e2e/.artifacts/WMB-5270-today-inline-detail-contract-UFVBxy/inline-source-image-screenshot.png` and `inline-source-video-screenshot.png`.

## Boundaries

No Source, IPC, database schema, permission, Capability, dependency, or foundation brand-token changes.
