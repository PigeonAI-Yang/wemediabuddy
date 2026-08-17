# WMB-5283 Browser settings workflow layout redesign

## Delivered

- Replaced the split browser cards with one ordered `登录环境 → 平台账号` workflow.
- Aligned each step as `step identity → select/account summary → grouped actions` at desktop widths, with a compact single-column fallback.
- Kept create, switch, legacy migration, account verification, and X Lists cache maintenance behavior unchanged.
- Preserved one enabled violet primary action in both empty and verified states.
- Moved paths, legacy state, verified-account detail, and cache maintenance behind `环境详情与维护`.
- Replaced implementation-facing copy (`绑定`, `改绑`, raw error codes, `登录态识别`, `预期账号`) in the default path with user-goal language (`设置/使用/切换登录环境`, `WMB 将使用的账号`).
- Reused foundation variables only; no foundation token, IPC, database schema, permission, capability, or dependency changes.

## Verification

- `npm run typecheck` — PASS.
- `node --check tests/e2e/settings.test.mjs` — PASS.
- `node --test tests/design-tokens-drift.test.mjs` — 3/3 PASS.
- Real Electron `STG-001-settings-sections-nav` — PASS:
  - 1100×800 dark and light screenshots.
  - unified two-step workflow, aligned grouped actions, one enabled primary action.
  - advanced detail closed by default.
  - internal implementation phrases absent from visible main-path copy.
  - horizontal overflow 0 and page errors 0.
- Real Electron `STG-005-settings-browser-bind` — PASS for empty/unconfigured state.
- Real Electron `STG-005B-settings-browser-bound-layout` — PASS for a persisted verified binding:
  - current environment and verified account read back from real registry/SQLite fixtures.
  - verification is the only enabled primary action.
  - repeated switch to the current environment is truthfully disabled.
  - horizontal overflow 0 and page errors 0.

## Evidence

- `tests/e2e/.artifacts/STG-001-settings-sections-nav-1D1kLK/settings-browser-1100-screenshot.png`
- `tests/e2e/.artifacts/STG-001-settings-sections-nav-1D1kLK/settings-browser-light-1100-screenshot.png`
- `tests/e2e/.artifacts/STG-005-settings-browser-bind-HvKF5L/`
- `tests/e2e/.artifacts/STG-005B-settings-browser-bound-layout-Ynoj9v/settings-browser-bound-1100-screenshot.png`
