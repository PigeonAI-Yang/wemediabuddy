# WMB-5158 Contract

## Route
Legislate

## Goal
Persist one v2 topic-maintenance conflict contract and use it for precise, structured approval conflict decisions while preserving v1 behavior.

## Acceptance
- [ ] Unrelated graph drift approves; target revision, canonical and actual migration dependencies return structured stale with zero formal writes.
- [ ] Proposal generation and approval consume the same persisted conflict contract; approval does not infer scope from display snapshots.
- [ ] Existing v1 proposed/stale records remain readable and are neither rewritten nor revived.

## Allowed paths
- PRODUCT.md
- PRD.md
- SPEC.md
- PLAN.md
- TASKS.md
- docs/spark/2026-08-10-topic-maintenance-conflict-reproposal-design.md
- src/main/topic-maintenance.ts
- src/main/topic-maintenance-conflict.ts
- src/main/db/late-migrations.ts
- src/main/db/migrations.ts
- src/main/db/topic-maintenance-migrations.ts
- scripts/eval-029-fixtures.mjs
- tests/eval-029-fixtures.test.mjs
- tests/settings.test.mjs
- tests/fixtures/eval-029-workspaces.v1.json
- tests/wmb-5150-topic-maintenance.test.mjs
- .ai/wmb-5158-evidence.md

## Forbidden paths
- Platform adapters and publication code
- Auth or configurable permission UI

## Non-goals
- Automatic reproposal dispatch and UI lifecycle, delivered by WMB-5159/WMB-5160.

## Capability registry impact
no change — conflict calculation and decision semantics use existing proposal/Owner commands.

## Depends on
WMB-5157

## Design / lock
- Design: docs/spark/2026-08-10-topic-maintenance-conflict-reproposal-design.md
- Owner lock 2026-08-10:
  1. One persisted conflict contract is shared by proposal generation and approval.
  2. Only outcome-changing conflicts block approval.
  3. Non-goals: no generic workflow, automatic apply, permission UI or legacy stale revival.
