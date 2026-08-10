# WMB-5159 Evidence

## Delivered

- Migration 53 adds a durable one-row-per-parent reproposal outbox, stable logical `job_id`, rotating unique `run_id`, and a unique successor link.
- A true v2 stale decision persists proposal status, structured conflict evidence, outbox work and command receipt in one dispatcher transaction; injected outbox failure rolls everything back.
- Agent dispatch starts only after commit. Scheduler recovery consumes persisted due work after cold start, freezes at `maxWorkers=0`, advances terminal runs with bounded 5s/30s retries, and ends at `needs_user` after three failures.
- Successor creation is idempotent, completes the parent outbox in the same transaction, and never revives or auto-approves the stale parent. Legacy v1 stale rows are not enqueued.

## Verification

- `node --test --experimental-strip-types tests/wmb-5150-topic-maintenance.test.mjs tests/job-spawner.test.mjs` — 30/30 PASS before the final terminal-run regression was added.
- `node --test --experimental-strip-types tests/wmb-5150-topic-maintenance.test.mjs` — 13/13 PASS, including stable `job_id`, rotating `run_id`, real retry delay, cold pool, rollback and disabled capacity.
- `node --test --experimental-strip-types tests/eval-029-fixtures.test.mjs tests/settings.test.mjs` — 10/10 PASS; schema 53 readback.
- `node --test --experimental-strip-types tests/task-grants.test.mjs` — 7/7 PASS after synchronizing the canonical internal-command assertion.
- `npm run typecheck`, `npm run check:capabilities`, `powershell -ExecutionPolicy Bypass -File scripts/check.ps1`, `git diff --check` — PASS; diff check reported only existing LF/CRLF warnings.
- Full serial suite reached 682/683; the sole failure was the stale task-grant command-list assertion. That assertion was updated and its complete file then passed 7/7. Full was not rerun a third time because the first complete run took 542 seconds and no production code changed afterward.

## Independent review

- `wmb_5159_final_data`: PASS; no BLOCKER/HIGH/MEDIUM across transactionality, stable identities, one-successor constraints, late-event behavior, legacy isolation and dispatcher enforcement.
- `wmb_5159_final_reliability`: PASS; no BLOCKER/HIGH/MEDIUM or remaining lifecycle gap.

## Pi operator Skill impact

No change in WMB-5159: this task adds backend persistence and scheduling. The user-visible supersession/recovery wording and canonical operator Skill update are explicitly WMB-5160.
