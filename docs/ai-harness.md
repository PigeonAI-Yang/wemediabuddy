# AI Development Harness

## Objective

Keep product intent, implementation contracts, execution order, task progress, and verification evidence connected throughout development.

## Artifact map

```text
idea (chat draft)
  └─ route: Clarify | Patch | Design | Legislate   ← docs/intake-routing.md
       └─ Owner lock + design file (Design/Legislate)
            └─ PRD.md / SPEC.md (Legislate only)
                 └─ PLAN.md (multi-task order / gates)
                      └─ TASKS.md + .ai/wmb-NNNN-contract.md
                           └─ code + checks + evidence
```

- `PRD.md`: why the product exists and what is in scope.
- `SPEC.md`: normative behavior, states, interfaces, and acceptance.
- `PLAN.md`: dependency-aware implementation order and phase gates — a **map**, not a work order. Update for multi-task chains, dependency reorders, or Legislate; do **not** update for single-task Patch.
- `TASKS.md`: the only development progress ledger; `doing` is the only construction permit.
- Chat schemes: drafts only; zero construction authority.
- `docs/intake-routing.md`: bare-idea routing.
- `docs/templates/change-contract.md`: Owner lock + task contract template.
- `.ai/wmb-NNNN-contract.md`: required for `doing`/`done` when task number ≥ 5001 (`scripts/check-intake.mjs`).
- `TECHNICAL_DESIGN.md`: approved architecture and stack.
- `AGENTS.md`: mandatory entrypoint for future Agents.
- `docs/verification.md`: executable and manual gates.
- `docs/pi-operation-skill-maintenance.md`: impact matrix and synchronization contract for the installation-wide Pi operation Skill.
- `.ai/evals/README.md`: feature and regression evidence format.
- `TASKS.archive.md`: archived `done` rows; validated together with `TASKS.md` as one union by `scripts/check-ledger.mjs`.
- `scripts/task-context.mjs`: machine-extracted minimal task context (`node scripts/task-context.mjs <WMB-id>`).
- `scripts/tasks-archive.mjs`: moves eligible `done` rows from `TASKS.md` into `TASKS.archive.md` (append-only, idempotent).
- `scripts/check-intake.mjs`: intake contracts for task numbers ≥ 5001.
- `docs/spark/2026-08-07-role-permission-design.md`: role roster + Capability registry + agents page (canonical).
- `src/shared/agent-capabilities.ts`: L2 Capability registry truth (commands → caps → default roles).
- `scripts/check-capability-registry.mjs` / `npm run check:capabilities`: hard gate against unregistered write commands and red-line leakage.

## Traceability

Every normative SPEC requirement has a stable `CAP-*` ID. Every implementation task has a stable `WMB-*` ID and references one or more `CAP-*` IDs.

A task cannot be `Done` without:

- changed-file evidence;
- command results;
- required live/manual receipts;
- no unresolved acceptance item for its referenced capability;
- (WMB-4810 and later) at least one existing repository-relative evidence path (for example `.ai/wmb-4810-xxx.json`, `tests/foo.test.mjs`);
- (WMB-4810 and later) a `Pi operator Skill impact: (updated|no change) — <non-empty note>` line;
- (WMB-4810 and later) an `Independent review: <name> — <non-empty conclusion>` or `Independent review: not required — (docs-only|test-only|evidence-only|copy-only)` line;
- (WMB-4810 and later) Evidence cell total at most 700 characters; narrative detail goes in `.ai/wmb-XXXX-evidence.md` (XXXX = numeric task part).

## Rule source standard

- **Project fact**: observed in committed project files or later in source/config/tests.
- **User requirement**: explicitly approved in conversation, PRD, SPEC, or project rules.
- **Recommendation**: engineering judgment that can be revised when evidence changes.

Do not turn a recommendation into a mandatory rule without evidence.

## Soft rules and hard checks

Prose explains intent and stop conditions. Scripts, tests, database constraints, state transitions, and live readback prove behavior.

If a rule can prevent data loss, duplicate publication, stale overwrites, false completion, or chat-bypass construction, prefer a hard check.

## Update policy

- Product scope changes update PRD first, then SPEC, PLAN, and TASKS in the same change.
- A discovered implementation constraint updates TECHNICAL_DESIGN only after user approval when it changes the approved architecture.
- A repeated failure adds the smallest regression check and a short lesson to the relevant harness document.
- A change to user workflows, Pi/MCP tools, confirmation/state boundaries, workspace identity or Skill packaging follows `docs/pi-operation-skill-maintenance.md` and records its Skill impact decision in the same task receipt.
- A change that introduces or renames an internal write command, or edits automatic/page grant command lists, **must** update `src/shared/agent-capabilities.ts` in the same change and pass `npm run check:capabilities`. Record `Capability registry impact: (updated|no change) — <note>` on the task evidence (waterline WMB-5100+).
- Do not ship configurable permission/role UI before P0 registry + grant filter + readonly agents roster (design §11.4).
- Task progress changes only in `TASKS.md`; do not create parallel todo lists.
- A harness rule change updates the machine enforcement (`scripts/check.ps1` / `scripts/check-ledger.mjs` / `scripts/check-intake.mjs` / `scripts/check-capability-registry.mjs`) in the same change; changing prose alone is not allowed.
