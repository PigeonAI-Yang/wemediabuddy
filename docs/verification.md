# Verification

## Environment prerequisites

Observed:

- Windows PowerShell;
- Git repository;
- PRD and technical design documents.

Required after scaffold:

- Node.js version supported by the pinned Electron release;
- selected package manager;
- installed Chrome/Chromium for live platform checks.

## Lightweight default

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

This validates required contracts, task-ledger structure and traceability, idea-intake task contracts via `scripts/check-intake.mjs`, and the Capability registry gate via `scripts/check-capability-registry.mjs`. It intentionally does not run all package checks.

## Change-proportional checks

- Focused regression: required for the changed non-trivial behavior.
- Typecheck: run when TypeScript or a shared type boundary changed.
- Full tests: run only for shared business behavior, migrations, or harness changes.
- Windows package: run only for packaging resources/configuration, startup, preload/main boundaries, release, or final acceptance.
- Live readback: required whenever the acceptance claim concerns a real browser, MCP, database mutation, packaged runtime, or platform state.

Do not repeat a successful check when neither its inputs nor acceptance target changed. Reuse the recorded receipt.

## Desktop renderer identity smoke

Confirms the dev renderer on port `27391` is WeMediaBuddy, not a foreign Vite page. Run `node scripts/smoke-renderer.mjs`; pass/fail criteria, the `check-dev-port.mjs` preflight and the `vite.renderer.config.ts` port source of truth are specified canonically in `docs/development-workflow.md` → "Desktop dev server isolation".

## Independent execution

The pre-push git hook (`scripts/git-hooks/pre-push`) runs the lightweight harness below on every push, so contract gates execute without a human invoking them. Install it once per clone:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-hooks.ps1
```

Until the hook is installed, push-time enforcement is absent; run the lightweight harness manually instead.

## Done receipt contract

From waterline WMB-4810 on (compare the numeric part of the `Task` column), a `done` task row must satisfy all four receipts in its Evidence cell:

1. At least one existing repository-relative evidence path (for example `.ai/wmb-4810-xxx.json`, `tests/foo.test.mjs`).
2. `Pi operator Skill impact: (updated|no change) — <non-empty note>`
3. `Independent review: <name> — <non-empty conclusion>` or `Independent review: not required — (docs-only|test-only|evidence-only|copy-only)`
4. Evidence cell total at most 700 characters; narrative detail goes in `.ai/wmb-XXXX-evidence.md` (XXXX = numeric task part)

From waterline WMB-5100 on, when the task touches grants, page authority, MCP write tools, internal commands, roles, or `agent-capabilities.ts`, the Evidence cell (or linked evidence file) must also include:

`Capability registry impact: (updated|no change) — <non-empty note>`

CAP eval execution: for every `CAP-xxx` in `SPEC.md`, if all tasks referencing it in `TASKS.md` are `done` and the largest task number among them is ≥ 4810, `.ai/evals/EVAL-CAP-xxx.md` must exist (compare by the CAP number as lowercase 3 digits; file name uppercase, e.g. `EVAL-CAP-025.md`).

## Independent review (light)

- Input: the task diff and the `done` row's Evidence-cell claims.
- Responsibilities: check that each claimed evidence path really exists and its content supports the claim; do not read `PRD.md`/`SPEC.md` in full (excerpts from `node scripts/task-context.mjs <WMB-id>` are sufficient).
- Output: one verdict sentence plus a list of mismatches (missing path, content that does not support the claim, absent or malformed receipt line), at most 300 characters total; long evidence goes to files, the review cites paths.

A mismatch blocks marking the task `done`.

Acquisition discipline:

- Scope: this review is required only for tasks at or above the WMB-4810 waterline; earlier tasks need no review receipt.
- Spawn a fresh read-only reviewer task with the diff and the Evidence-cell claims as its only inputs. Never revive or wait on parked/idle agents, and never block on IRC waits for a reviewer.
- Timebox: if the reviewer fails or times out, respawn once with the same contract. If it still cannot complete, mark the task `blocked` with the reason instead of retrying in a loop or reviewing your own work.

## Full release check

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check.ps1 -Full
```

This runs typecheck, all tests and Windows packaging. It is a release/final gate, not a development-loop command.

## Manual and live checks

Required by capability:

- UI/MCP consistency: create or modify the same object through both transports and compare readback.
- Chrome: show process identity, profile path, CDP endpoint, and logged-in account.
- Publishing: exact human confirmation, real publish, stable publication identity readback.
- Metrics: real creator-page values, capture timestamp, source page, and unsupported/unavailable semantics.
- Recovery: restart application and verify persisted state and safe job transition.

## Pi operation Skill synchronization

Follow `docs/pi-operation-skill-maintenance.md` whenever a workflow, Pi/MCP tool, confirmation/state boundary, workspace identity or Skill packaging changes.

- Documentation-only rule changes: run the lightweight Harness and `git diff --check`.
- Operator Skill content changes: verify every named `wmb_*` tool against the current Pi registry and run one focused workflow/readback.
- Packaging/loader changes: build Windows and prove the shared Skill loads in both a fresh and an existing data root while lane Skills remain root-specific.

## Prohibited verification waste

- Packaging after an unrelated renderer or copy change.
- Running all tests when one focused regression covers the changed call path.
- Rebuilding the same unchanged Pi/runtime resource more than once in a task.
- Treating command count as evidence quality.
