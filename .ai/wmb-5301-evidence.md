# WMB-5301 Archive scheduler dispatch integrity repair

## Problem

The live workspace repeatedly emitted two scheduler failures:

- `WMB_WRITE_REQUIRES_COMMAND_DISPATCH`: `MediaArchiveScheduler` called `recoverInterruptedMediaArchiveJobs()` directly while the active-runtime write guard was installed.
- `REQUEST_REPLAY_CONFLICT`: archive claim/finish and source-body recovery request IDs were reused after a retry reset or a new runtime epoch even though the command envelope input hash had changed.

`commandInputHash()` includes `runtimeEpoch`; job retry APIs also reset `attempts` / `attempt_count` to zero. IDs based only on job ID and attempt count therefore did not uniquely identify one command envelope lifecycle.

## Repair

- `src/main/media-archive-worker.ts`
  - Added `MEDIA_ARCHIVE_RECOVER_COMMAND`.
  - Startup recovery now runs through `dispatchBusinessCommand()` with scheduler actor, bound workspace identity, and `media_archive_job` entity scope.
  - Claim and finish IDs now bind runtime epoch plus the pending/claimed row lifecycle timestamp.
- `src/main/source-body-archive.ts`
  - Claim and finish IDs now bind runtime epoch plus the pending/claimed row lifecycle timestamp.
  - Startup recovery ID now binds runtime epoch and scheduler generation, so every runtime activation executes recovery once instead of replaying an old receipt.
  - Manual retry preserves attempt history safely: claim allocates the next unused attempt row, and finish receives that claim-issued attempt number.
- `tests/wmb-5301-archive-scheduler-regression.test.mjs`
  - Real `ActiveWorkspaceRuntime` regressions cover media retry reset, source-body retry reset, media guarded startup recovery across two epochs, and source-body recovery across two epochs.

## Verification

- `npm run typecheck`: PASS.
- `node --test --test-concurrency=1 tests/wmb-5301-archive-scheduler-regression.test.mjs`: 4/4 PASS.
- Related suites, run by the implementation worker: `tests/wmb-5269-source-body-archive.test.mjs` + `tests/wmb-5244-archive-worker.test.mjs`: 42/42 PASS.
- Real Electron restart: `wemedia-buddy-final` ready, PID 94660, zero restarts.
- Live recovery receipts at `2026-08-16T15:25:25Z`:
  - `media_archive.recover`: `ok`
  - `source_body_archive.recover`: `ok`
- Live command receipts after restart:
  - `media_archive.claim_job`: 379 `ok`
  - `media_archive.finish_job`: 377 `ok`
  - `source_body_archive.backfill_page`: 8 `ok`
  - `source_body_archive.claim_job`: 10 `ok`
  - `source_body_archive.finish_job`: 10 `ok`
- Fresh-process log observation found no `REQUEST_REPLAY_CONFLICT` or `WMB_WRITE_REQUIRES_COMMAND_DISPATCH` after startup and active draining. One transient SQLite `database is locked` was logged while both archive schedulers were draining the existing backlog; the scheduler remained ready and continued producing successful receipts. This is outside the two repaired failure modes and was not suppressed.
