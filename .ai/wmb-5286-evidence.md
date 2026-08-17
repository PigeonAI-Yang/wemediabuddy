# WMB-5286 Studio editor usability repair

## Delivered

- Format toolbar wraps by control group; no horizontal scrolling at the supported 1100px window.
- Markdown rendering repairs CJK-adjacent emphasis that `marked` leaves literal, while preserving sanitization, asset figures, nested lists, table inline formatting, and code/pre content.
- Rich editing no longer replaces `innerHTML` on every input. The active DOM keeps its caret/IME state; `editorBody` remains the canonical unsaved draft and `save()` remains the persistence boundary.
- Historical versions use one compact read-only action strip. `返回最新版` is the single primary action; `基于此版本另存` and `复制为新项目…` use consistent secondary-button styling. Project copy expands its title field on demand. The unrelated disabled topbar Save is absent.

No Studio IPC, DB schema, permission, Capability registry, dependency, or foundation token change.

## Verification

- `pnpm run typecheck` — PASS.
- `node --check tests/e2e/studio.test.mjs` — PASS.
- `node --test tests/design-tokens-drift.test.mjs` — 3/3 PASS.
- `node --test tests/wmb-5237-studio-image-menu.test.mjs tests/wmb-5207-studio-annotations-ui.test.mjs` — 47/47 PASS.
- Real Electron `ST-001-studio-project-normal` — PASS: 1100×800 toolbar wrapping, zero horizontal overflow, rendered heading/emphasis/nested list, editable rich surface, page errors 0.
- Real Electron `ST-002-studio-save-persist` — PASS: typed `RICH_EDIT_ABC` at the document end without caret reversal/reset; Save; reload; UI and SQLite persistence read-back.
- Real Electron `ST-008-studio-image-editing` — PASS: historical read-only behavior, equal-height styled actions, copy disclosure/recovery, image-edit restrictions, no horizontal overflow.

## Visual evidence

- `tests/e2e/.artifacts/ST-001-studio-project-normal-HlM8G4/studio-editor-markdown-toolbar-1100-screenshot.png`
- `tests/e2e/.artifacts/ST-008-studio-image-editing-Yd15wd/studio-historical-version-actions-screenshot.png`
