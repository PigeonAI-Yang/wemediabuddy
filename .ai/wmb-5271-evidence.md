# WMB-5271 verification evidence

Date: 2026-08-15
Status: complete

## Delivered contract

- Today source detail now uses one reading flow: source identity/title → work summary → archived media → body excerpt/archive state → provenance/copyright.
- Removed the previous split/floating side-card layout, nested-card treatment, body-to-Pi/manual-fetch actions, and obsolete feed body-status pill.
- Preserved global navigation, Pi dock, return/Esc focus restoration, library/original links, independent Pi source selection, local image/video preview, and automatic body-archive states.
- Media evidence stays in the main reading flow. When all media are preserved, the redundant status-distribution chip is suppressed; mixed states still show the distribution.
- Detail column is the actual vertical scroll container, preventing body/provenance clipping inside `today-layout`.
- Long source/body text wraps; media/body sections have explicit accessible headings; archived excerpt is a named region.

## Changed files

- `src/renderer/today-view-panels.tsx`
- `src/renderer/today-view.tsx`
- `src/renderer/styles-workflow-today.css`
- `tests/e2e/wmb-5251-modal-migration.test.mjs`

## Verification

- `npm run typecheck`: PASS.
- `node --test tests/design-tokens-drift.test.mjs`: 3/3 PASS.
- Real Electron `WMB-5270-today-inline-detail-contract`: 1/1 PASS.
  - Final evidence: `tests/e2e/.artifacts/WMB-5270-today-inline-detail-contract-OYXhGe/`
  - Screenshot: `inline-source-image-screenshot.png`
  - Covers single-source isolation, no modal/legacy split DOM, preserved image/video assets, semantic section order, real seeded ready body cache, no body CTA/Pi coupling, Esc focus return, source-2 empty media/body-state independence, page errors 0.
- Real Electron `WMB-5270-inline-detail-responsive`: 1/1 PASS.
  - Run evidence directory: `tests/e2e/.artifacts/WMB-5270-inline-detail-responsive-MrXISv/`
  - Covers Pi-open 1183×871 and minimum 1100×800, scroll-to-provenance, actions present, horizontal overflow 0, modal count 0, page errors 0.

## Visual review

Final 1600×960 Electron screenshot inspected. The page presents a clear single hierarchy with one source identity/title, separated summary/media/body/provenance regions, no floating detail card, and no duplicate all-saved distribution chip. The white media field is the intentional 1×1 white PNG E2E fixture, not a rendering failure.

## Runtime cleanup

- Managed process `wmb-5271-verify` stopped and verified `exited`.
- E2E Electron windows exited with their scenarios; no managed test browser remains running.

## Capability / schema impact

None. No Source contract, IPC, DB schema, permission, Capability registry, dependency, or foundation brand-token change.
