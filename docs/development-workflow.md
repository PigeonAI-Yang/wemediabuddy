# Development Workflow

Bare ideas without a `WMB-*` id must follow `docs/intake-routing.md` before this workflow. Construction starts only from a `TASKS.md` `doing` row (and, for ids ≥ 5001, `.ai/wmb-NNNN-contract.md`).

## Before editing

1. Run `node scripts/task-context.mjs <WMB-id>` for the selected task and use its machine-extracted output (ledger header contract, the task row, dependency rows, referenced `CAP-*` SPEC sections, PRD index lines) as the task context; read documents in full only when the change touches harness rules, the excerpt is insufficient, or the change spans multiple `CAP-*` (see `AGENTS.md` → Required reading).
2. Select one `todo` task and confirm its dependencies are `done`.
3. Move it to `doing`; at most one `doing` per Owner (Owner column; empty means `main`), so parallel work uses different Owners.
4. Inspect the relevant source, callers, tests, live configuration, and runtime state.
5. For a bug, write and run a minimal falsifiable reproduction before changing code.
6. If the change affects a WMB workflow, Pi/MCP tool, confirmation/state boundary, workspace identity or Skill packaging, read `docs/pi-operation-skill-maintenance.md` and freeze the operator Skill impact before editing.

## During editing

- Implement only the selected task's SPEC IDs.
- Reuse existing code and platform capabilities before adding helpers or dependencies.
- Keep renderer, MCP, and platform adapters behind business commands.
- Preserve dirty work and unrelated user changes.
- Update the task's evidence fields as checks complete.
- For changes covered by `docs/pi-operation-skill-maintenance.md`, update the canonical operator Skill in the same task or record a concrete no-change reason; do not hand-edit packaged/data-root copies.

## Desktop dev server isolation

WeMediaBuddy desktop **dev** loads the renderer from a local Vite server. Packaged apps do not. A recurring black-screen failure mode is Electron attaching to the wrong Vite app on a shared port.

Rules:

- Renderer port is fixed at **`127.0.0.1:27391`** (`vite.renderer.config.ts`, `strictPort: true`).
- Never rely on Vite defaults `5173/5174`.
- `npm start` preflight: `scripts/check-dev-port.mjs`.
- UI verification smoke: `node scripts/smoke-renderer.mjs` (must report WeMediaBuddy + `#root`).
- If the smoke title is another product, stop and fix port ownership before more UI work.
- Process “ready” is not proof the correct renderer is loaded.

## Error handling

- Preserve the distinction between `failed`, `needs_user`, and publication `unknown`.
- Never automatically retry an uncertain publication.
- Never convert missing metrics to zero.
- Return revision conflicts instead of overwriting newer content.
- Stop and report when live platform identity, login state, or success readback cannot be established.

## Verification

Run one focused check that directly covers the changed behavior. Add typecheck only for TypeScript/type-boundary changes. Do not run the full suite or Windows package merely because a file changed.

Subagent and wait discipline: hub waits return on any worker message, and every return is a full main-context re-bill. Task contracts must forbid progress messages (workers report only on completion or when blocked); waiting uses one long timeout (10+ minutes) with batch processing of all settled results per wake — no short-wait polling loops and no mid-flight steering.

Use `scripts/check.ps1` for the lightweight contract/ledger check. Use `scripts/check.ps1 -Full` only for release, final acceptance, or a change to packaging/startup/shared infrastructure.

Never repeat an unchanged successful check in the same task. Record and reuse its receipt.

Do not replace real platform acceptance with mocks, screenshots, a green unit test, or a successful click.

## Final response

Report task ID, delivered capability, files, checks, live receipts, failures, and remaining risks. For tasks at or above waterline WMB-4810, the Evidence cell must also carry the four receipts (exact formats in `docs/verification.md` → "Done receipt contract"): an existing repository-relative evidence path, a `Pi operator Skill impact:` line, an `Independent review:` line, and the 700-character limit. Narrative evidence goes in `.ai/wmb-XXXX-evidence.md`; the Evidence cell holds only the receipts and paths.

## Stop and ask

Stop when:

- a change would expand PRD scope;
- a platform flow requires a product decision not in SPEC;
- a destructive action or dependency outside the approved stack is required;
- account identity or publication target is ambiguous;
- acceptance needs user credentials or human confirmation currently unavailable.
