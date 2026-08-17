# WMB-5322 — AI model settings hierarchy redesign

## Delivered

- Designer reorganized Settings → AI 与模型 around two explicit stages: manage reusable Provider presets first, then assign ordered candidates to five roles.
- The selected Provider editor now belongs to the preset section; the secondary OpenCode template action is behind a native disclosure instead of competing with the primary add action.
- Five role blocks form one grouped surface with separators rather than five competing cards. Each candidate exposes Provider, model, priority, effective reasoning, and one primary reasoning selector.
- Reorder and remove actions moved into one accessible “管理” disclosure per candidate. The complete Provider/model add catalog remains inline and unchanged.
- The role-policy save bar is sticky and keeps dirty/version state visible. Existing selectors, save/readback behavior, one-candidate removal protection, and foundation tokens are preserved.

## Verification

- `npm run typecheck && node --test tests/design-tokens-drift.test.mjs`
  - PASS: TypeScript 0 diagnostics; design-token drift 3/3.
- `node tests/e2e/runner.mjs --file tests/e2e/settings.test.mjs --scenario STG-009-settings-role-provider-models`
  - PASS: 1/1 real Electron scenario.
  - Confirms complete Provider/model catalog, candidate reasoning save/reload/readback, one reasoning selector per candidate, and the consolidated management disclosure with three ordered actions.
  - Evidence: `tests/e2e/.artifacts/STG-009-settings-role-provider-models-PsVx9K/`
  - Screenshot: `tests/e2e/.artifacts/STG-009-settings-role-provider-models-PsVx9K/settings-role-provider-models-1100-screenshot.png`
- Visual inspection at 1100×800: Provider/model identity and priority lead each row; reasoning remains visible; reorder/remove no longer compete as permanent text actions; role groups scan as one list; sticky save state remains visible; no horizontal overflow.
- Cleanup: the isolated Electron scenario closed; process query found no command line matching `STG-009-settings-role-provider-models`. The existing managed development instance was intentionally untouched.
