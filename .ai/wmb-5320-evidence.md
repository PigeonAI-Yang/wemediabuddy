# WMB-5320 — Role provider-model candidate correction

## Delivered

- Role policies now store ordered `{ profileId, model }` candidates for all five roles; v1 and v2 configuration migrate once to v3 using each preset’s then-current model.
- Settings → AI 与模型 fetches every configured Provider’s model catalog, renders all Provider + model combinations, prevents duplicate pairs per role, and atomically saves/readbacks the selected order.
- Frozen policy snapshots and runtime fallback resolve the exact Provider + model pair. A later preset-current-model change cannot alter an existing task snapshot; fallback deduplication and skip identity are pair-aware.
- Provider credentials remain stored once on the preset. No cross-role fallback, Provider creation, illustration-model change, permission change, publishing change, dependency change, or foundation-token change.

## Verification

- `node --test --test-concurrency=1 tests/pi-config.test.mjs tests/pi-config-fallback.test.mjs tests/settings.test.mjs`
  - PASS: 16/16.
  - Covers v1/v2 migration, atomic pair-policy save/readback, frozen pair snapshots, same-Provider second-model fallback, pair-aware retry identity, model catalog and settings snapshot.
- `npm run typecheck`
  - PASS: TypeScript 0 diagnostics.
- `node tests/e2e/runner.mjs --file tests/e2e/settings.test.mjs --scenario STG-009-settings-role-provider-models`
  - PASS: 1/1 real Electron scenario.
  - Confirms every configured Provider model appears for every role, duplicate pair choices are excluded, an alternate model can be saved and read back, strategy revision advances, 1100×800 layout has no horizontal overflow, and page errors are empty.
  - Evidence: `tests/e2e/.artifacts/STG-009-settings-role-provider-models-Ayh7YX/`
  - Screenshot: `tests/e2e/.artifacts/STG-009-settings-role-provider-models-Ayh7YX/settings-role-provider-models-1100-screenshot.png`
- Cleanup: the isolated scenario closed its test window/application; process query found no command line matching `STG-009-settings-role-provider-models`. The existing managed `wemediabuddy-dev` instance was intentionally preserved.

## Packaging note

`npm run package` stopped before compilation because the local checkout lacks the required external release resource `resources/xiaohongshu-mcp/xiaohongshu-mcp-windows-amd64.exe`. No bypass or fake resource was introduced. The managed Forge development application was restarted to produce the current real bundles used by the passing Electron scenario.
