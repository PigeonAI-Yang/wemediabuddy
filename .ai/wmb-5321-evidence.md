# WMB-5321 — Role candidate reasoning-strength control

## Delivered

- Every role candidate now carries optional `thinking` beside `{ profileId, model }`; candidate identity and deduplication remain Provider + model only.
- Settings → AI 与模型 renders one accessible reasoning selector per candidate. A candidate may explicitly select off/minimal/low/medium/high/xhigh/max or inherit its Provider preset default.
- Save/readback preserves explicit candidate overrides. Legacy candidates without `thinking` remain compatible and inherit the Provider default only when the frozen policy snapshot is resolved.
- Frozen snapshots store the effective reasoning level, so later Provider-default changes cannot alter an already-started task.
- No Provider credential duplication, cross-role fallback, illustration-model change, permission/publishing change, dependency, DB schema, or foundation-token change.

## Verification

- `node --test --test-concurrency=1 tests/pi-config.test.mjs tests/pi-config-fallback.test.mjs tests/settings.test.mjs && npm run typecheck`
  - PASS: focused tests 16/16; TypeScript 0 diagnostics.
  - Covers explicit `off`/`high`/`xhigh`, legacy inheritance, invalid-level rejection, pair-only duplicate identity, frozen effective reasoning, fallback consumption, and settings snapshot compatibility.
- `node tests/e2e/runner.mjs --file tests/e2e/settings.test.mjs --scenario STG-009-settings-role-provider-models`
  - PASS: 1/1 real Electron scenario.
  - Adds an alternate Provider/model candidate, confirms every candidate has an accessible reasoning selector, verifies inherited-default copy, selects `high`, saves, reloads, and reads back the override.
  - Evidence: `tests/e2e/.artifacts/STG-009-settings-role-provider-models-75UzG5/`
  - Screenshot: `tests/e2e/.artifacts/STG-009-settings-role-provider-models-75UzG5/settings-role-provider-models-1100-screenshot.png`
- Visual inspection: the candidate selector and inherited/override summary are visible within the existing 1100×800 role-assignment surface without horizontal overflow.
- Cleanup: the isolated Electron scenario closed; process query found no command line matching `STG-009-settings-role-provider-models`. The existing managed development instance was intentionally untouched.
