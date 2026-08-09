# Idea Intake Routing

This document is the project gate between a raw idea and code construction.

## Routes

| Route | Use when | Required outputs | Code allowed? |
| --- | --- | --- | --- |
| Clarify | Acceptance unclear | Numbered Owner questions | No |
| Patch | Same product promises; one small task | Task contract + TASKS row | Only after `doing` |
| Design | Multi-task or behavioral fork; constitution unchanged | Design file + Owner lock + tasks | Only after lock + `doing` |
| Legislate | PRD/SPEC/authority/architecture change | PRD/SPEC (+ PLAN) then tasks | Only after legislation + `doing` |

## Authorization / Capability routing (mandatory)

| Change | Minimum route | Notes |
| --- | --- | --- |
| New internal write command / MCP write tool | Legislate or Design + registry update | Must edit `src/shared/agent-capabilities.ts` same change |
| Edit `PAGE_TASK_GRANT_SCOPES` or `AUTOMATIC_TASK_GRANT_SCOPES` only | **Forbidden as Patch** | Derive from registry; do not hand-expand scopes |
| Role default bindings / red lines | Design → Owner lock | Canonical: `docs/spark/2026-08-07-role-permission-design.md` |
| Lane pack / 赛道文案与信源 | Patch or Design | **Zero** command names or role bindings in lane packs |
| Configurable permission UI | Blocked until P0 done | Design §11.4 |

## Authority ladder

```text
Chat scheme     → draft only
Design doc      → blueprint after Owner lock
PLAN.md         → order and gates
TASKS.md doing  → sole construction permit
```

## Owner lock format

```text
Owner lock YYYY-MM-DD:
1. ...
2. ...
3. Non-goals: ...
4. Route: Design | Legislate
5. Design path: docs/spark/... or .ai/...
```

Chat "ok" is not a lock.

## Task contract

For task ids at/above the intake waterline, every `doing`/`done` row needs:

```text
.ai/<task-id-lower>-contract.md
```

Copy structure from `docs/templates/change-contract.md`.

## Agent default

Bare idea → route label first → proposal artifacts only → wait for Owner → ledger → `task-context` → code.
