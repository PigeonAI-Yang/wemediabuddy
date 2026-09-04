# Scoring recovery final report — 2026-08-25

Status: partial / packaging and installed visual acceptance blocked by the 30-minute hard stop.

## Compile recovery

- `npm run typecheck`: PASS.
- Focused: `node --test tests/scoring-recovery.test.mjs tests/today-run-view.test.mjs tests/proposals-compact-ledger.test.mjs`: 40/40 PASS.
- Broader focused run exposed two pre-existing planning-stage fixture failures (`score_total_mismatch` expectation and thesis duplicate); they are outside this recovery scope and were not changed.

## Implemented contract

- Approval eligibility requires `ready_for_review` plus the exact six current propagation reasons, exact weights, bounded dimension scores, and exact total.
- Proposal ledger splits eligible `今日可批` from `待评分`; pending rows expose the reason and use the existing `startDailyIntelligence` action for `继续评分`.
- Today derives `scoring_incomplete`, active scoring, and exact retryable error from current-plan pending rows/task state.
- Manager detects current-plan scoring pending before collection, freezes plan/item/source IDs, dispatches one judge continuation, and explicitly forbids reporter/scan/new plan.
- Daily judge recovery skips lane gate and `plans.save`; successful output is matched to frozen title/sourceIds and applied through existing `plan_item.submit` domain commands.
- Partial/needs-user remains pending and manager summary says `评分未完成，可重试`.

## Production readback

- Current plan before and after: `cc34c3b8-33bb-4ed8-b021-1defa9ba9c0a`, revision 1, still current.
- Four frozen items remained revision 1, `draft`, score status `pending`, pending reason `insufficient_evidence`; source IDs were preserved.
- Exactly one recovery task was created: `749461ac-1cd3-4262-8998-41ecb865f402`, intent `daily_judge`.
- Terminal: `needs_user / ROLE_MODEL_POLICY_REQUIRED`.
- Exact retryable error: `Cannot read properties of undefined (reading 'getPath')`.
- No new plan was created and no current plan ID changed.

## Packaging / install / visual

- `npm run build` was started once and produced no stage output for about seven minutes. It was terminated to honor the 30-minute hard stop.
- Therefore no new installer was installed and no installed-build screenshot is claimed.
- The previously installed 0.3.0 app was closed only to release the shared data root for the single development recovery trigger, then relaunched normally.

## Blockers

1. Headless development trigger cannot resolve Electron `app.getPath`, so production scoring did not reach the model recovery prompt.
2. Canonical make did not complete within the bounded window; installed visual/error acceptance remains unverified.
