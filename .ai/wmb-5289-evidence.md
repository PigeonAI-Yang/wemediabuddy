# WMB-5289 — Studio annotation popup scroll stability

## Problem and root cause

Real Electron reproduction in `ST-004-studio-annotations` established a rich-editor selection deep in a long document. Opening `标记并说明` changed `.studio-canvas.scrollTop` from `1492` to `0`.

`StudioAnnotationMenu` and `StudioAnnotationNoteInput` used ordinary `HTMLElement.focus()` for autofocus and focus restoration. During the menu-to-note transition, restoring focus to the tall rich editor made Chromium scroll the editor's beginning into view before the fixed note input received focus.

## Repair

`src/renderer/studio-annotation-layer.tsx` now uses `focus({ preventScroll: true })` for:

- initial annotation-menu focus;
- menu focus restoration;
- note textarea autofocus;
- note-input focus restoration.

The existing selection snapshot, menu semantics, Esc/cancel behavior, annotation IPC, overlay, and database contract are unchanged.

## Verification

- Pre-fix real Electron reproduction: FAIL with `before=1492, after=0`.
  - Artifact: `tests/e2e/.artifacts/ST-004-studio-annotations-qKLPbN`
- `pnpm run typecheck` — PASS.
- `node --check tests/e2e/studio.test.mjs` — PASS.
- `node --test tests/design-tokens-drift.test.mjs` — 3/3 PASS.
- Real Electron `ST-004-studio-annotations` — PASS.
  - Long rich document, selection at paragraph 36.
  - Right-click menu and note textarea rendered at the selected reading position.
  - Exact scroll delta `<=2px`.
  - Note input accepted text and created the annotation.
  - SQLite readback confirmed the persisted note.
  - Existing source-mode annotation, annotation list, note edit, and persistence path also passed.
  - Page errors: `[]`.

## Evidence

- Screenshot: `tests/e2e/.artifacts/ST-004-studio-annotations-fkPk4p/studio-annotation-scroll-stable-screenshot.png`
- Page errors: `tests/e2e/.artifacts/ST-004-studio-annotations-fkPk4p/studio-annotation-scroll-stable-pageerrors.json`
- Debug report: `.ai/frontend-debug-loop/reports/2026-08-16-wmb-5289-annotation-scroll.md`

The inspected 1600×960 screenshot shows the note input beside paragraph 36 while paragraphs 26–36 remain visible; the editor did not jump to the document start.

## Runtime cleanup

The isolated Electron/Playwright process created by ST-004 exited through the runner. Existing supervised `wemedia-buddy-app` and pre-existing `omp.browser.headless` processes were not created or modified by this acceptance run.
