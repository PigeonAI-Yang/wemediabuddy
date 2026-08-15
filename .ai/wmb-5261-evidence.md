# WMB-5261 evidence

## Scope

Focused refactor of the formal Publish page only. Publication IPC, persistence, state transitions, permission/capability contracts, platform enablement, manual-final-publication boundary, Pi behavior, dependencies, and foundation brand tokens are unchanged.

## Delivered

- Replaced the undifferentiated preview + system-health rail with a three-part signing flow: signing queue, final-content preview, and pre-publication confirmation.
- Queue preserves every publication state and makes each row directly selectable by keyboard or pointer.
- Confirmation makes platform, account, content revision, media count, and one-time confirmation scope explicit.
- Exactly one primary action is exposed for the selected state; a `prepared` operation no longer competes with the return-to-edit action.
- Account and runtime diagnostics remain available behind a collapsed disclosure instead of competing with the signing decision.
- Final content no longer exposes SHA fingerprints; history is available behind a collapsed disclosure.
- At <=1279px and while Pi is open, the queue becomes a horizontal first step above preview + confirmation. Full-width layout remains three columns.

## Verification

- `npm run typecheck`: PASS.
- `node --test tests/design-tokens-drift.test.mjs`: 3/3 PASS.
- `node tests/e2e/runner.mjs --file tests/e2e/publish.test.mjs`: 7/7 PASS (`PB-001`, `PB-002`, `PB-003`, `PB-004`, `PB-005`, `PB-009`, `PB-010`). This covers populated, empty, prepared, needs-user, unknown/reconcile, failed, and return-to-edit behavior with real Electron + persisted DB assertions.
- Real Electron, dark, 1600x960 with Pi open: queue 1004x132, preview 704x625, confirmation 300x625; one visible primary action; horizontal overflow 0. Screenshot `J:/Users/yangda01/Temp/omp-sshots-15579bf14d2e2d71.webp`.
- Real Electron, dark, 1600x960 with Pi closed: columns 260/804/320; horizontal overflow 0. Screenshot `J:/Users/yangda01/Temp/omp-sshots-15579c01e9ee2d72.webp`.
- Real Electron, light, 1600x960: columns 260/804/320; horizontal overflow 0. Screenshot `J:/Users/yangda01/Temp/omp-sshots-15579c14222e2d73.webp`.
- Real Electron, light, 1100x800: queue first row 884x132; preview 584x453; confirmation 300x453; horizontal overflow 0; content surface `rgb(255, 255, 255)`. Screenshot `J:/Users/yangda01/Temp/omp-sshots-15579c485fae2d74.webp`.
- Test tabs closed: 1. Managed test process `wmb-publish-visual`: exited. Existing owner preview process was not touched.
