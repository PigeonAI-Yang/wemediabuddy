# WMB-5271 work checkpoint

Date: 2026-08-15
State: stopped by Owner; implementation incomplete; `TASKS.md` remains `doing`.

## Goal

Correct the Today source-detail information architecture from the Owner's annotated screenshot: one reading sequence for source identity, title, summary, archived media, body, and provenance; remove floating cards, nested-card clutter, duplicated metadata, unreasonable calls to action, and body/Pi coupling. Preserve global navigation, Pi, return, library/original links, Pi selection semantics, media preview, and automatic body-archive states.

## Changes currently present

- `src/renderer/today-view-panels.tsx`
  - Rebuilt `TodaySourceDetail` as a single article flow: source identity/title → work summary → archived media → body excerpt/status → provenance/copyright.
  - Removed the old split-grid/floating-side-card structure.
  - Removed body-to-Pi and manual body-fetch calls to action from the body section.
  - Kept page-level return, library, original-link, and Pi-context selection controls.
- `src/renderer/today-view.tsx`
  - Removed the obsolete `attachBodyToSelection` callback and `onAttachBody` wiring.
- `src/renderer/styles-workflow-today.css`
  - Replaced the previous card-heavy detail styling with a restrained 900px reading column, section dividers, inline media evidence, plain body excerpt, and responsive single-column behavior.
  - Reused foundation variables; no brand token changes.
- `tests/e2e/wmb-5251-modal-migration.test.mjs`
  - Partially migrated the WMB-5270 Today-detail assertions to the WMB-5271 hierarchy contract.
  - The current test expects an archived body excerpt, but `seedTodayFixture()` does not seed `source_body_cache`; this is the known unfinished mismatch.

## Verification observed before stop

- `npm run typecheck`: PASS.
- `node --test tests/today-sources-modal.test.mjs tests/design-tokens-drift.test.mjs`: reported design-token checks 3/3 PASS; the referenced Today test file is not currently present, so this is not component coverage.
- Real Electron scenario `WMB-5270-today-inline-detail-contract`: FAIL.
  - Latest failure: `已归档正文应保留可阅读摘录`.
  - Cause: E2E fixture has media bindings but no seeded archived body; the redesigned UI correctly shows an automatic archive state instead of an excerpt.
  - Latest artifact: `tests/e2e/.artifacts/WMB-5270-today-inline-detail-contract-SOzTa7/`.
- Earlier E2E artifact `tests/e2e/.artifacts/WMB-5270-today-inline-detail-contract-KigrBe/` failed against a superseded assertion that still required an independent refresh action.
- No successful final screenshot review exists for WMB-5271.

## Runtime cleanup

- Managed process `wmb-5271-dev` stopped and verified `exited`.
- No test browser process remains running.

## Exact resume point

1. Do not redesign again before opening the latest Electron artifact and inspecting the actual hierarchy.
2. Resolve the E2E body-state contract deliberately:
   - preferred: seed a real `source_body_cache` ready record in `seedTodayFixture()` so the archived-body visual state is exercised;
   - additionally keep a separate assertion for the automatic pending/failed/empty states if needed.
3. Run `npm run typecheck` and `node --test tests/design-tokens-drift.test.mjs`.
4. Run both Electron scenarios:
   - `WMB-5270-today-inline-detail-contract`
   - `WMB-5270-inline-detail-responsive`
5. Inspect the 1600×960 and 1100×800 screenshots for hierarchy, spacing, media prominence, long URL handling, Pi-open geometry, and horizontal overflow.
6. Only after visual and behavioral PASS: write final `.ai/wmb-5271-evidence.md` and change WMB-5271 from `doing` to `done`.

## Risks / cautions

- The source body scheduler on the normal user-data development shell emitted pre-existing `REQUEST_REPLAY_CONFLICT` errors. The isolated E2E fixture is the correct verification surface; do not treat the normal-user-data scheduler noise as WMB-5271 evidence.
- The current E2E file was edited during the stop sequence and has not been rerun after the final assertion repair.
- WMB-5271 is not complete and must not be reported as complete.
