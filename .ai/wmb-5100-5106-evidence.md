# WMB-5100–5106 Evidence — Role × Capability system

Date: 2026-08-07  
Design: `docs/spark/2026-08-07-role-permission-design.md`  
SPEC: CAP-026

## Deliverables

### Harness / legislate
- AGENTS.md, docs/ai-harness.md, intake-routing.md, change-contract.md, verification.md
- PRODUCT C8, PRD §2.3, SPEC §1.1 CAP-026
- `scripts/check-capability-registry.mjs` + `check.ps1` + `npm run check:capabilities`

### Registry + grant filter
- `src/shared/agent-capabilities.ts`
- `ensureAutomaticTaskGrant` role filter + overlay intersection
- `src/main/capability-overlays.ts` + migration v49

### Daily scan/judge split
- intents `daily_scan` / `daily_judge` (+ legacy `daily_intelligence`)
- late migration v48
- channel run → `daily_scan` + `roleId: reporter`
- judgment → rebind/start `daily_judge` + `roleId: planner`
- AUTOMATIC scopes partitioned

### Runtime projection + UI
- lease `roleId` on `WorkspaceRuntimeLease`
- `src/main/role-roster.ts` + `agents:roster-status`
- Agents page live poll; settings safe overlays (disable default-bound agentGrantable only)
- page authority stamps roleId (desk/writer/librarian/reporter)

## Verification (2026-08-07)

```text
npm run check:capabilities
→ Capability registry check passed.

node --test tests/agent-capabilities.test.mjs tests/role-capability-p1.test.mjs
→ 10/10 pass

npx tsc --noEmit -p tsconfig.json
→ exit 0
```

## Capability registry impact
updated — full CAP-026 P0–P2 scaffold (registry, filter, scan/judge, roster, overlays).

## Pi operator Skill impact
no change — role-specific Skill packages not yet split into separate skill dirs; operator Skill unchanged. Follow-up: install role skills.

## Independent review
not required — test-only / docs harness; Owner live UI smoke recommended.

## Residual risks
- Single Pi worker mutex remains for concurrent heavy Pi sessions (lease carries roleId but still one worker slot).
- Overlay UI only disables default-bound caps (no privilege expansion).
- Legacy `daily_intelligence` still accepted for compatibility.
- Full `check.ps1` may still fail on pre-existing >500-line files unrelated to this milestone.
