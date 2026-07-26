# AI Development Harness

## Objective

Keep product intent, implementation contracts, execution order, task progress, and verification evidence connected throughout development.

## Artifact map

```text
PRD.md
  └─ SPEC.md
       └─ PLAN.md
            └─ TASKS.md
                 └─ code + checks + evidence
```

- `PRD.md`: why the product exists and what is in scope.
- `SPEC.md`: normative behavior, states, interfaces, and acceptance.
- `PLAN.md`: dependency-aware implementation order and phase gates.
- `TASKS.md`: the only development progress ledger.
- `TECHNICAL_DESIGN.md`: approved architecture and stack.
- `AGENTS.md`: mandatory entrypoint for future Agents.
- `docs/verification.md`: executable and manual gates.
- `.ai/evals/README.md`: feature and regression evidence format.

## Traceability

Every normative SPEC requirement has a stable `CAP-*` ID. Every implementation task has a stable `WMB-*` ID and references one or more `CAP-*` IDs.

A task cannot be `Done` without:

- changed-file evidence;
- command results;
- required live/manual receipts;
- no unresolved acceptance item for its referenced capability.

## Rule source standard

- **Project fact**: observed in committed project files or later in source/config/tests.
- **User requirement**: explicitly approved in conversation, PRD, SPEC, or project rules.
- **Recommendation**: engineering judgment that can be revised when evidence changes.

Do not turn a recommendation into a mandatory rule without evidence.

## Soft rules and hard checks

Prose explains intent and stop conditions. Scripts, tests, database constraints, state transitions, and live readback prove behavior.

If a rule can prevent data loss, duplicate publication, stale overwrites, or false completion, prefer a hard check.

## Update policy

- Product scope changes update PRD first, then SPEC, PLAN, and TASKS in the same change.
- A discovered implementation constraint updates TECHNICAL_DESIGN only after user approval when it changes the approved architecture.
- A repeated failure adds the smallest regression check and a short lesson to the relevant harness document.
- Task progress changes only in `TASKS.md`; do not create parallel todo lists.

