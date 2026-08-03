# Development Workflow

## Before editing

1. Read the required documents in `AGENTS.md`.
2. Select one `todo` task and confirm its dependencies are `done`.
3. Move it to `doing`; only one task may have that status.
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

Use `scripts/check.ps1` for the lightweight contract/ledger check. Use `scripts/check.ps1 -Full` only for release, final acceptance, or a change to packaging/startup/shared infrastructure.

Never repeat an unchanged successful check in the same task. Record and reuse its receipt.

Do not replace real platform acceptance with mocks, screenshots, a green unit test, or a successful click.

## Final response

Report task ID, delivered capability, files, checks, live receipts, failures, and remaining risks.

## Stop and ask

Stop when:

- a change would expand PRD scope;
- a platform flow requires a product decision not in SPEC;
- a destructive action or dependency outside the approved stack is required;
- account identity or publication target is ambiguous;
- acceptance needs user credentials or human confirmation currently unavailable.
