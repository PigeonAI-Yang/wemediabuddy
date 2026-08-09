# Orchestration systemic fixes (2026-08-08)

Audit: `.ai/orchestration-systemic-audit.md` (S0=3, S1=6, S2=4)

## Closed this pass

### S0
- **A1 lease bind**: job execute `onTaskReady` binds `workerLease` to child taskId before grant; `onTaskBound` writes handle.taskId back for cancel/notify/roster.
- **A2 stage tools**: `runManagerDailyStage` acquires a dedicated **employee** lease, binds the child task, and no longer treats every partial as success.
- **A3 manager ghost**: dock prompt failure fails the manager task (`MANAGER_DOCK_FAILED`) so serial gate can clear; today-view stops faking `daily_intelligence` (uses child intent or `page_agents`).

### S1 (partial / related)
- **B1 waiting_judge push**: scan finishing at `channel_scanned` emits `job.waiting_judge` with correct copy (need continue/judge), not “job fully done”.
- **B2 cancel coupling**: job cancel calls `abortDailyIntelligence` plus task cancel when handle.taskId is bound.
- **C1 session isolation**: studio draft uses job `sessionFile`; results-review uses per-task session file.
- **Push not poll**: terminal job events notify desk via followUp/short turn; prompts forbid sleep/bash polling.
- **Monitor path**: `jobs.get` returns `monitor.task` progress.

### S2
- **D1**: default job execute throws `JOB_EXECUTE_NOT_CONFIGURED` (no silent success).
- **C3**: `ensureJobSpawner` rebuilds when workspace identity mismatches.

## Deferred (still real)
- **C2** desk lease rebind on page switch can stale in-flight grants (needs grant model change).
- **E1** unified per-date judge lock across scheduler / manager / button.
- **E2** WORKSPACE_BUSY should requeue instead of fail-fast.
- **F1** stall watchdog ignores pure streaming deltas.
- **F2** manager checkpoint.children full jobId-taskId sync beyond legacy bridge.
- Continuous orphan sweeper cadence (restart path still heavier).

## Expected operator loop now
1. Dispatch with tools (`spawn` / `run_stage` / `continue_after_scan`).
2. Wait for `JOB_EVENT` push; optional `get_job` -> `monitor.task`.
3. Accept with `get_content` / readiness.
4. Do not bash session files or sleep-poll.
