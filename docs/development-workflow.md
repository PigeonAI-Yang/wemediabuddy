# Development Workflow

## Before editing

1. Read the required documents in `AGENTS.md`.
2. Select one `todo` task and confirm its dependencies are `done`.
3. Move it to `doing`; only one task may have that status.
4. Inspect the relevant source, callers, tests, live configuration, and runtime state.
5. For a bug, write and run a minimal falsifiable reproduction before changing code.

## During editing

- Implement only the selected task's SPEC IDs.
- Reuse existing code and platform capabilities before adding helpers or dependencies.
- Keep renderer, MCP, and platform adapters behind business commands.
- Preserve dirty work and unrelated user changes.
- Update the task's evidence fields as checks complete.

## Error handling

- Preserve the distinction between `failed`, `needs_user`, and publication `unknown`.
- Never automatically retry an uncertain publication.
- Never convert missing metrics to zero.
- Return revision conflicts instead of overwriting newer content.
- Stop and report when live platform identity, login state, or success readback cannot be established.

## Verification

Run the one-command check, then any task-specific live checks in `SPEC.md`.

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
