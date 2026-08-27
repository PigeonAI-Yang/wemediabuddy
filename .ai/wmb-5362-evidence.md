# WMB-5362 evidence

Date: 2026-08-28

## Result

- Real database: `J:\PigeonYang\WeMediaBuddyData\wmb.db`, schema version `78`.
- Frozen Sources: `c0ee77c3-173d-4ad3-83e9-cfa15ddfffb7` r16 (Ox Alpha / 100T) and `8844ca91-8b38-4c6f-ac9c-09537d20fb3e` r1 (Ox Alpha = GLM-5.3-Flash + task measurement).
- Entity: `ent-e9f78521313ace20144f706650d7f9e7`, canonical name `GLM-5.3-Flash`, alias `Ox Alpha`.
- Topic: `2d7438de-99b1-41f8-999f-8d142162dd58`; both frozen Sources are linked.
- Durable route, reactivation and compile jobs succeeded; three related Knowledge Receipts exist.
- Plan `4ec1419b-9032-44b1-89c8-8f6cdf9ae540`, item `66e77c11-8252-47d8-86f5-2e5515c022cb`; both Source decisions are `selected`.
- Six-dimensional score is `87`; `planning_status=ready_for_review`. Owner approval remains the only approval path.
- `COMPUTE_PROVIDER_UNVERIFIED` remains an Evidence Gap. The product does not state that a domestic-compute cluster provides the 100T quota as fact.
- Full readback: `.ai/wmb-5362-real-repair.json`.

## Confirmed root cause and repair

`findHistoricalKnowledgeSources` previously fetched only the newest `maxSources * 5` rows (normally 100) and then matched aliases in memory. On a high-volume database, newer unrelated rows hid the five-day-old 100T Source.

The query now prefilters title/summary/body cache in SQLite using at most 20 aliases before applying time and result bounds. Regression `tests/wmb-5359-knowledge-reactivation.test.mjs` proves an old matching Source is still found behind 120 newer noise Sources. The existing idempotency key prevented destructive replay of the original job, so `scripts/repair-wmb-5362-real.mjs` used the production `knowledge_reactivate_sources` service for one auditable compensation; no business table was edited directly.

## Verification

- Focused WMB-5358–5361 and repair checks: 28/28 PASS.
- Alias truncation suite: 7/7 PASS, including the 120-noise regression.
- `npm run typecheck`: PASS.
- `node --test tests/design-tokens-drift.test.mjs`: PASS.
- Full `npm test`: 2114 tests, 2012 pass, 102 fail, exit 1, duration 987731.9217 ms. Failures are retained honestly. They cluster around older direct-`approved` expectations, former planning/ferment/carry semantics, outdated Today component/source assertions, old research-mode prompts, historic fixtures and existing source-feed assumptions. The focused WMB-5358–5361 tests and the new truncation regression passed in the same run.
- `npm run build`: PASS, including XHS resource verification, Pi/media runtime packaging gates and Squirrel make.

## Package and installed readback

- Packaged app: `J:\wmb-out\WeMediaBuddy-win32-x64\WeMediaBuddy.exe`.
- Installer: `J:\wmb-out\make\squirrel.windows\x64\WeMediaBuddy Setup.exe`.
- Installer SHA-256: `AB23AA975E051B96BA7952BA1B93EC4F8CAFB0DE2732747D92415D03553D0BF5`.
- Packaged `resources\app.asar` SHA-256: `785BFAEF2A265BC13B13D519A5C93F2516646E1E90B9DF909127547C4C8B8C64`.
- Installed executable: `C:\Users\yangda01\AppData\Local\WeMediaBuddy\app-0.3.0\WeMediaBuddy.exe`.
- Installed `resources\app.asar` SHA-256: `785BFAEF2A265BC13B13D519A5C93F2516646E1E90B9DF909127547C4C8B8C64` (exact match).
- Installed process readback: main PID `505268`, exact installed executable path above; renderer loads the installed `app.asar`.
- Installed data-root readback: `J:\PigeonYang\WeMediaBuddyData`; real DOM verification read `J:/PigeonYang/WeMediaBuddyData/wmb.db`.
- Rollback: `J:\wmb-out\rollback-20260828-071506`; previous directory package: `J:\wmb-out\WeMediaBuddy-win32-x64-pre-wmb5362-20260828-0725`.

Installed DOM verification (`scripts/verify-wmb-5362-packaged-real.mjs`) read the full proposal, both Sources, all score reasons, score 87, `ready_for_review` and the Evidence Gap with zero page errors and zero console errors. Evidence: `tests/e2e/.artifacts/wmb-5362-packaged-real/result.json` and `proposal-detail-real.png`.

The verifier reproduced the known Electron shutdown-drain hang after it had written the successful DOM result and printed `closing`. The verifier was interrupted; no installed-path process remained. The installed app was then started normally and its exact process path was read back.
