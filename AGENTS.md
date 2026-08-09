# WeMediaBuddy Agent Guide

## Project goal

WeMediaBuddy is a Windows desktop **AI-driven self-media human-agent collaborative terminal** (形态对齐「Codex Desktop 型 Agent 主路径」，**拒绝**「VS Code 型人写为主、AI 侧栏辅助」). The human is editor-in-chief: goals, approvals, dispatch, supervision, publish confirmation, liability. Built-in Pi and authorized external agents do the primary labor: research, filing, topic induction, opportunity briefs, drafting, review prep — sharing one local workspace fact store. WMB does not embed model weights or provide model inference, and does not use platform APIs.

**Normative product form**: `PRODUCT.md` (constitution C1–C7) + `PRD.md` §2.0 + `SPEC.md` §1.0. Before designing or extending Today desk, continuous-attention, topics, opportunities, or Pi page work, re-read those clauses. Do not ship flows that dump untriaged sources onto the editor desk as a substitute for agent opportunity drafting, or that treat regex as the primary topic-induction engine.

**Role × Capability (Owner lock 2026-08-07)**: canonical design `docs/spark/2026-08-07-role-permission-design.md`. Five fixed roles (desk/reporter/planner/writer/librarian) are lane-stable. Authorization extends only via `src/shared/agent-capabilities.ts` (+ overlays later). Effective write = GrantScope ∩ role capabilities ∩ PreciseGate. Prompts/Skills never grant power. Before P0 registry+filter+readonly agents page completes: **no configurable permission UI**. New internal write commands must register a Capability or `scripts/check-capability-registry.mjs` / `npm run check:capabilities` fails.

Current feature scope is detailed by `PRD.md` and `SPEC.md`. X, Xiaohongshu, and WeChat Official Accounts are required. WMB embeds and supervises a pinned Pi RPC runtime.

## Idea intake (mandatory)

When the user brings an idea, adjustment, or complaint **without** a `WMB-*` task id:

1. Route first using `docs/intake-routing.md`: `Clarify | Patch | Design | Legislate`.
2. Default is proposal-only: **no code**, no `doing` row, no “chat ok = start coding”.
3. **Patch**: draft `.ai/wmb-NNNN-contract.md` from `docs/templates/change-contract.md`; after Owner confirms, add the ledger row.
4. **Design**: write a durable design under `docs/spark/` or `.ai/`; list numbered Owner-lock decisions; wait for a real `Owner lock` block; then contracts + `TASKS.md`.
5. **Legislate**: patch `PRD.md` / `SPEC.md` / `PRODUCT.md` (and `PLAN.md` order) before implementation tasks.
6. Only a `TASKS.md` row in `doing` grants code construction rights.
7. For task numbers ≥ 5001, every `doing`/`done` row must have `.ai/wmb-NNNN-contract.md` (enforced by `scripts/check-intake.mjs`).
8. Chat schemes have **zero** construction authority. `PLAN.md` is a map, not a work order.

## Required reading

Default flow:

1. Select one `todo` task from `TASKS.md`.
2. Run `node scripts/task-context.mjs <WMB-id>` and use its machine-extracted output as the task context: the ledger header contract, the target task row, its dependency rows, the referenced `CAP-*` SPEC sections, and the matching REQ/AC PRD index lines. The excerpts are byte-exact extracts and can be trusted as source text.

Read the full documents only when:

- the change modifies harness rules themselves (`AGENTS.md`, `docs/ai-harness.md`, `docs/development-workflow.md`, `docs/verification.md`, `docs/intake-routing.md`, `scripts/check.ps1`, `scripts/check-ledger.mjs`, `scripts/check-intake.mjs`, `scripts/check-capability-registry.mjs`);
- the change touches product form / Today desk / continuous-attention / topics / opportunities (`PRODUCT.md`, `PRD.md` §2.0, `SPEC.md` §1.0);
- the change touches roles, grants, page authority, MCP write tools, or internal commands (`docs/spark/2026-08-07-role-permission-design.md`, `src/shared/agent-capabilities.ts`, `src/shared/page-authority.ts`, `src/main/task-grants.ts`);
- `task-context.mjs` output is insufficient for the change;
- the change is an architecture change spanning multiple `CAP-*`.

Document map (one-line responsibility each; read on demand):

1. `PRODUCT.md` — product form constitution (C1–C7); Owner lock; must not drift without explicit revision.
2. `PRD.md` — product intent and boundaries (includes §2.0 form).
3. `SPEC.md` — normative behavior and acceptance (includes §1.0 form invariants).
4. `PLAN.md` — implementation order and gates.
5. `TASKS.md` — current task, ownership, evidence, and progress.
6. `TECHNICAL_DESIGN.md` — approved stack and architecture.
7. `docs/development-workflow.md` — editing workflow and desktop dev server isolation.
8. `docs/verification.md` — executable and manual gates.
9. `docs/intake-routing.md` — bare-idea routes and construction authority.
10. `docs/templates/change-contract.md` — Owner lock + task contract headings.
11. `docs/spark/2026-08-07-product-form-agent-desk-constitution.md` — form constitution detail + continuous-attention debt/follow-ups.
12. `docs/spark/2026-08-07-role-permission-design.md` — role roster + Capability registry + agents page (canonical auth extension).
13. `src/shared/agent-capabilities.ts` — Capability registry implementation (L2 truth).

For browser/platform work, also read the matching platform contract in `SPEC.md`.

For any change to user workflows, IPC/MCP/Pi tools, confirmation boundaries, task states, workspace isolation, Skill packaging or Pi launch behavior, also read `docs/pi-operation-skill-maintenance.md` and record the required Pi operator Skill impact decision in `TASKS.md`.

For any change that adds/renames an internal write command, changes `PAGE_TASK_GRANT_SCOPES` / `AUTOMATIC_TASK_GRANT_SCOPES`, or alters role bindings: update `src/shared/agent-capabilities.ts` in the **same** change, run `npm run check:capabilities`, and record `Capability registry impact:` in the task evidence.

## Work protocol

1. Select one `todo` task from `TASKS.md`; move only that task to `doing`. At most one `doing` per Owner (Owner column; empty means `main`); parallel work uses different Owners.
2. Read every referenced requirement and the real call path before editing.
3. For a bug, first create and run a minimal falsifiable reproduction; do not patch before the root cause is confirmed.
4. Make the smallest implementation that satisfies the referenced SPEC IDs.
5. Run the smallest check that can disprove the current change.
6. Record verification evidence in `TASKS.md`; mark `done` only when every acceptance item passes.
7. Report files read, files changed, rationale, verification, and remaining risks.

## Change boundaries

- User requirement: preserve `PRD.md`, `SPEC.md`, and `TECHNICAL_DESIGN.md` as approved product contracts. Change them only when the user changes scope.
- User requirement: do not implement PRD section 10 future items.
- User requirement: do not add an embedded LLM, Agent runtime, platform API integration, cloud service, auth system, or multi-user features.
- User requirement: publishing always requires a fresh human confirmation bound to the exact account, content version, and assets.
- User requirement: final publish click and hard-delete never enter automatic role grants (`agentGrantable: false` red lines).
- Project fact: runtime data belongs under the configured data root, never in the Git repository.
- Project rule: no source file may exceed 500 lines; split by existing business boundaries before crossing the limit.
- Project rule: do not add write commands only to page/automatic grant tables without Capability registry registration.
- Project rule: lane packs carry zero authorization commands/role bindings.
- Recommendation: do not add dependencies unless an active task cannot be completed with the approved stack or existing dependencies; record the reason in `TASKS.md`.
- Never run destructive Git or filesystem commands against broad paths.

## Local desktop dev isolation

Project fact: WeMediaBuddy desktop **dev** uses Electron + Vite. Packaged builds do not. Black screens after edits are often **renderer port collisions**, not product UI bugs.

Hard rules for Agents:

1. Renderer dev server is locked to **`127.0.0.1:27391`** in `vite.renderer.config.ts` with `strictPort: true`.
2. Do **not** use/share default Vite ports (`5173`, `5174`, …). Other local apps (for example py-polymarket) already occupy them.
3. Before claiming a UI/desktop change works, smoke-check the page identity:
   - `node scripts/smoke-renderer.mjs`
   - must be title `WeMediaBuddy` and `#root`
   - if title is another project, treat as failed verification, not “user should refresh”
4. `npm start` runs `scripts/check-dev-port.mjs` first. If port `27391` is owned by a foreign page, refuse to start.
5. After CSS/HMR thrash or unexplained black window: stop `wmb-dev`, confirm nothing foreign is on `27391`, cold-start, then re-run smoke. Do not declare success from process “ready” alone.
6. When restarting desktop for main-process changes, use this project’s isolated runtime only; never assume a generic Vite URL is WeMediaBuddy.

## Verification

Verification is proportional to the change:

- During implementation, run only the focused regression or live readback that directly covers the changed path.
- Run typecheck only when TypeScript code or a shared type boundary changed.
- Run the full test suite only when shared business behavior, migrations, or the test harness changed.
- Run Windows packaging only when packaging configuration, packaged resources, startup, preload/main boundaries, or release delivery changed.
- Do not repeat an unchanged check or rebuild an unchanged artifact in the same task. Reuse its recorded receipt.
- A task-specific real readback is stronger than repeating unrelated tests.

The lightweight harness entrypoint is:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

Push-time enforcement: the pre-push git hook (`scripts/git-hooks/pre-push`) runs this lightweight check on every push; install it once per clone with `powershell -ExecutionPolicy Bypass -File scripts/install-hooks.ps1`.

The release/final-acceptance entrypoint is explicit and must not be used as the default development loop:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check.ps1 -Full
```

## Final report

Include:

- task ID and SPEC IDs;
- files read and changed;
- behavior delivered;
- commands and results;
- live/manual evidence where required;
- failures, skipped checks, and remaining risks.

## Harness index

- `docs/ai-harness.md`
- `docs/architecture.md`
- `docs/development-workflow.md`
- `docs/verification.md`
- `docs/pi-operation-skill-maintenance.md`
- `docs/intake-routing.md`
- `docs/templates/change-contract.md`
- `.ai/evals/README.md`
