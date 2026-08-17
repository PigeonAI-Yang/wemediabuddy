# WMB-5284 Browser settings copy and control-height cleanup

## Delivered

- Removed the repeated descriptions beneath `登录环境` and `平台账号`.
- Removed the non-actionable `当前正在使用此环境` helper when the selected environment is already active.
- Kept actionable empty-state reasons, including selecting/creating an environment and setting one before account verification.
- Set selects, account summaries, and their same-row action buttons to an explicit `40px` height. This applies equally to create, switch, migrate, and verify buttons.

## Verification

- `npm run typecheck` — PASS.
- `node --check tests/e2e/settings.test.mjs` — PASS.
- `node --test tests/design-tokens-drift.test.mjs` — 3/3 PASS.
- Real Electron `STG-001-settings-sections-nav`, `STG-005-settings-browser-bind`, and `STG-005B-settings-browser-bound-layout` — 3/3 PASS.
- E2E measures every same-row select/account summary/button and requires the maximum height difference to be at most 1px.
- Both crossed step descriptions are absent; active-environment redundant feedback is absent.
- 1100×800 screenshots inspected; horizontal overflow 0 and page errors 0.

## Evidence

- `tests/e2e/.artifacts/STG-001-settings-sections-nav-eELzXn/settings-browser-1100-screenshot.png`
- `tests/e2e/.artifacts/STG-005-settings-browser-bind-nU9tjg/`
- `tests/e2e/.artifacts/STG-005B-settings-browser-bound-layout-O7RWJe/settings-browser-bound-1100-screenshot.png`
