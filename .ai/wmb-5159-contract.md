# WMB-5159 Contract

## Route
Legislate

## Goal
Atomically persist true-conflict reproposal work and automatically dispatch/recover one librarian job after commit.

## Acceptance
- [ ] True stale, structured conflict, one domain outbox and approval receipt commit atomically; injected failure rolls all back.
- [ ] Agent dispatch starts only after commit; duplicate click/kick and cold restart produce at most one successor.
- [ ] Retry is bounded and successor creation completes the outbox without reviving or auto-applying the parent.

## Allowed paths
- TASKS.md
- src/main/db/late-migrations.ts
- src/main/topic-maintenance.ts
- src/main/topic-maintenance-reproposal.ts
- src/main/job-pool.ts
- src/main/job-spawner.ts
- src/main/ipc-jobs.ts
- src/main/ipc-knowledge-business.ts
- src/main/index.ts
- src/main/mcp-business-commands.ts
- .pi/extensions/wmb-mcp/wmb-mcp-tools-content.ts
- src/main/role-job-policies.ts
- tests/wmb-5150-topic-maintenance.test.mjs
- tests/job-spawner.test.mjs
- tests/task-grants.test.mjs
- .ai/wmb-5159-evidence.md

## Forbidden paths
- Generic approval/workflow engines
- Platform adapters and publication code

## Non-goals
- Visual ledger polish and final EVAL integration, delivered by WMB-5160.

## Capability registry impact
updated — add only the scheduler-infrastructure outbox failure/retry command if required; no role gains authority.

## Depends on
WMB-5158

## Design / lock
- Design: docs/spark/2026-08-10-topic-maintenance-conflict-reproposal-design.md
- Owner lock 2026-08-10:
  1. True conflict persists reproposal work in the approval transaction and runs Agent only after commit.
  2. Successor is a new librarian proposal requiring Owner approval.
  3. Non-goals: no auto-rebase/apply, generic workflow or manual Owner reconstruction.
