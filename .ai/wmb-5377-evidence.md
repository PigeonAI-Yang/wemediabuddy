# WMB-5377 Reporter request identity — acceptance evidence

Date: 2026-08-31

## Scope

- Changed `src/main/research-job-runner.ts` only for Reporter source-write request identity handling.
- Added the focused regression in `tests/wmb-5172-research-runner.test.mjs`.
- No Writer execution, direct SQLite mutation, seed rows, scheduler change, permission change, or schema change.

## Root cause and repair

One research round can produce several citation candidates for the same canonical URL. The previous loop reused the URL-stable `requestId` while resubmitting different title/summary/excerpt payloads, so the dispatcher correctly rejected the later command as `REQUEST_REPLAY_CONFLICT` and the Reporter ended as `RESEARCH_FAILED`.

The runner now keeps a per-run source-write cache keyed by the command request identity. A canonical URL dispatches `sources.upsert_batch` once; later candidates reuse its returned `sourceId` without rebinding the request identity to a different input. Distinct URLs keep distinct stable identities. Existing receipt replay and conflict semantics remain unchanged.

## Focused verification

- `node --test tests/wmb-5172-research-runner.test.mjs`: PASS 24/24.
- The WMB-5377 regression uses two candidates with one canonical URL but different title/summary/excerpt values under a strict dispatcher double. Result: terminal success, one source command, one request identity, two candidates truthfully processed, one verified source.
- `npm run typecheck`: PASS.

## Packaged real-data acceptance

Built the current source with:

- `npx electron-forge package --arch=x64 --platform=win32`
- Output: `J:/wmb-out-5377/WeMediaBuddy-win32-x64/WeMediaBuddy.exe`

Launched that packaged Electron app against the real workspace database and retried the existing project investigation:

- Project: `6ce12d8a-d12d-449d-baca-fcdc55b0f3c8`
- Final Reporter job: `bc242682-7e40-4080-a5ec-01a776a5f811`
- Final Reporter task: `2d46deeb-6996-4854-a2c2-ae536edb0347`
- Project revision: `10`
- Project status: `research_review`
- Reporter status: `partial`
- Terminal reason: `candidates_exhausted`
- ResearchEvidencePack: 3 claims, 8 source IDs, 1 unresolved required claim
- Persisted `research_claims`: 3 rows; all 3 terminal
- Command receipts: 16 receipts, 16 distinct request IDs, 0 conflicts
- Cross-command request identity reuse: 0

`partial` is the truthful research terminal: the Reporter produced a non-empty evidence pack and claims while retaining one unresolved claim. It is not `RESEARCH_FAILED` and no `REQUEST_REPLAY_CONFLICT` occurred.

Two preliminary launches failed before model execution with `ROLE_MODEL_AUTH_FAILED` because the isolated acceptance user-data directory lacked the installed profile's complete encryption state. The final launch copied the existing local `pi-api-config.json`, `Local State`, and `Preferences` into the isolated directory; no credential value was printed or persisted in this evidence file.

## Cleanup

- Packaged acceptance app closed cleanly.
- Process-level check found no running `WeMediaBuddy.exe`.
- Temporary acceptance user-data directory removed.
