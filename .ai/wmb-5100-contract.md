# WMB-5100 Contract

## Route
Legislate

## Goal
Land harness gates, product legislation, Capability registry v1, and CI check for CAP-026.

## Acceptance
- [x] AGENTS/ai-harness/intake/contract/verification updated
- [x] PRODUCT C8 + PRD §2.3 + SPEC CAP-026
- [x] `src/shared/agent-capabilities.ts` exists
- [x] `npm run check:capabilities` passes via check.ps1 hook

## Allowed paths
- AGENTS.md, docs/**, PRODUCT.md, PRD.md, SPEC.md, PLAN.md, TASKS.md
- src/shared/agent-capabilities.ts
- scripts/check-capability-registry.mjs, scripts/check.ps1, package.json
- .ai/wmb-5100-*

## Forbidden paths
- Configurable permission UI
- capability_overlays write IPC

## Non-goals
- daily_scan split (5104)
- live roster projection (5105)

## Capability registry impact
updated — registry v1 + CI gate

## Depends on
WMB-5004

## Design / lock
- Design: docs/spark/2026-08-07-role-permission-design.md
- Owner lock 2026-08-07: full agreement to design + harness-first then implement
