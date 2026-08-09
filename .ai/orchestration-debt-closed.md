# Orchestration debt closed (2026-08-08)

Goal: finish remaining items from systemic audit.

## Done

### E1 — per-date stage lock
- `src/main/daily-stage-lock.ts`
- Wired into:
  - `runManagerDailyStage` (manager tools)
  - Today button start path (`index.ts`)
  - Scan scheduler auto-judge (`onNewSources`)

### C2 — rebind must not kill in-flight grants
- `workspace-runtime.ts`: lease keeps `boundTaskIds`
- `isCurrentWorkerLease` accepts primary **or** bound task ids
- `rebindWorkerTask` retains previous task ids
- `unbindWorkerTask` helper for cleanup

### E2 — WORKSPACE_BUSY requeue
- `job-spawner.ts`: busy lease → `pool.requeue(..., front:false)` + delayed `tryPromote`
- No longer fail-fast `JOB_SLOT_BUSY` on transient saturation

### F1 — stall uses live heartbeat
- `daily-control-policy.ts`: stall activity = max(lastActivityAt, streamActivityAt, heartbeatAt, updatedAt)
- Empty 15s heartbeats already bump `heartbeat_at`, so long streaming turns are not false-stalled

### F2 — job ↔ manager checkpoint
- `syncManagerTaskFromJob` in `manager-dispatch.ts`
- Called from `notifyDeskJobEvent` on job events (including waiting_judge)

## Residual risk (acceptable)
- boundTaskIds can grow until process end if unbind not called everywhere; low risk (memory only).
- Stage lock is in-process memory (correct for single desktop app instance).
- Full multi-instance distributed lock not required for this product.
