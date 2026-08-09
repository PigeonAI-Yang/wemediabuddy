# WMB-5100–5103 Evidence — Role × Capability P0 foundation

Date: 2026-08-07  
Milestone: M-5100  
Design: `docs/spark/2026-08-07-role-permission-design.md`

## Delivered in this batch

### WMB-5100 Harness + legislate + registry + CI
- AGENTS.md Role×Capability iron rules + doc map
- docs/ai-harness.md, intake-routing.md, change-contract.md, verification.md
- PRODUCT C8, PRD §2.3, SPEC §1.1 CAP-026
- `src/shared/agent-capabilities.ts` registry v1
- `scripts/check-capability-registry.mjs` + check.ps1 + `npm run check:capabilities`

### WMB-5101 Grant filter
- `ensureAutomaticTaskGrant(..., roleId?)` uses `filterCommandsForRole`
- Reads `task.contextRefs.roleId` when present; desk/null = pass-through

### WMB-5102 Readonly Agents page
- View `agents`, sidebar「智能体」, `AgentsRosterView` five cards
- No permission switches; settings jump only

## Commands

```text
node scripts/check-capability-registry.mjs  → pass
node --test tests/agent-capabilities.test.mjs → pass
npx tsc --noEmit → (see run log)
```

## Capability registry impact
updated — registry v1; grant filter; CI gate.

## Pi operator Skill impact
no change — no operator Skill packaging change yet (role skills P1).

## Independent review
not required — docs/test foundation; full P0 package closes on WMB-5103.
