# WMB-5319 — Role model preset assignment

## Delivered

- Installation-level Pi config v2 stores `modelPolicyRevision` plus independent ordered profile chains for `desk`, `reporter`, `planner`, `writer`, and `librarian`; v1 `fallbackOrder` migrates once into every role.
- Role jobs persist a frozen `modelPolicySnapshot` in task context and resolve only that role’s chain. Runtime fallback never crosses role chains.
- Missing policy/profile, authentication failure, invalid model/configuration, and exhausted chains use stable `ROLE_MODEL_*` errors and transition active work to `needs_user` with the real reason.
- Settings → AI 与模型 keeps one reusable preset area and adds five role assignment rows with ordered candidates, add/remove/reorder controls, revision-checked atomic save, stale-write protection, and deletion guards.
- Existing illustration-model configuration and foundation brand tokens remain unchanged.

## Verification

- `node --test --test-concurrency=1 tests/pi-config-fallback.test.mjs tests/pi-config.test.mjs tests/settings.test.mjs tests/design-tokens-drift.test.mjs && npm run typecheck`
  - PASS: 17/17 tests; TypeScript 0 diagnostics.
  - Covers v1 migration, revisioned atomic saves, role-chain isolation, transient fallback, prompt/start authentication failures, exhausted-chain `needs_user`, settings readback, and design-token drift.
- `npm run e2e -- --file tests/e2e/settings.test.mjs --scenario STG-001-settings-sections-nav`
  - PASS: 1/1 real Electron scenario.
  - Confirms five role rows, five independent ordered chains, visible strategy revision, unchanged-save disabled state, settings navigation, both themes, 1100×800 layout, and no page errors.
  - Evidence: `tests/e2e/.artifacts/STG-001-settings-sections-nav-gqkLhq/`
  - Role UI screenshot: `tests/e2e/.artifacts/STG-001-settings-sections-nav-gqkLhq/settings-ai-icons-1100-screenshot.png`
- Isolated E2E process check after completion: no process matching `tests.e2e`, E2E user-data, or `STG-001-settings`; the user’s existing WeMediaBuddy process was observed and deliberately left untouched.

## Notes

Node emitted the repository’s existing typeless-package and experimental SQLite warnings; neither affected the passing contracts. The first E2E attempt stopped on the obsolete global `.settings-fallback-active` assertion removed by this clean cutover; the assertion was deleted and the role-specific surface then passed.