# WMB-5290 — Project investigation writing workflow

## Delivered

- Added a project-owned investigation state machine with immutable outline/direction versions, package/history persistence, optimistic revision checks, and restart readback.
- Added reporter job construction/execution, project-scoped evidence-pack capture, truthful `partial` / `needs_user` / `failed` terminals, explicit retry/supplement rounds, and suppression of the generic research successor for desk-owned investigation jobs.
- Added IPC/preload/renderer contracts and the Studio `调查` work surface.
- Enforced two Owner approvals: outline approval before reporter dispatch; direction approval before writer dispatch.
- Enforced the writer gate in both the investigation domain and `JobSpawner`; legacy projects without an investigation remain compatible.
- Projected investigation state into Studio without creating a parallel source store; completed reporter sources link through existing `content_project_sources`.
- Fixed `needs_user` recovery so a reporter terminal without a package exposes the valid explicit `retry-reporter` action instead of an invalid research-review action.

## Verification

- `node --test --test-concurrency=1 tests/wmb-5290-investigation.test.mjs` — PASS, 1/1. Covers immutable versions, both approvals, reporter binding/rounds, truthful terminals, writer gate, JobSpawner compatibility, source linkage, successor suppression, and restart persistence.
- `npm run typecheck` — PASS.
- `node --test tests/design-tokens-drift.test.mjs` — PASS, 3/3.
- `node tests/e2e/runner.mjs --file tests/e2e/investigation.test.mjs` — PASS, 2/2 in real Electron.
  - `tests/e2e/.artifacts/INV-001-studio-investigation-init-approve-ohA393/`
  - `tests/e2e/.artifacts/INV-002-studio-investigation-writer-gate-tsfS4o/`
- Electron coverage includes initialization, outline edit/save/approval, reporter dispatch and explicit terminal recovery, structured package/source linkage, research acceptance, direction approval, explicit writer confirmation/dispatch, reload persistence, `1100×800`, zero horizontal overflow, and zero page errors.

## Scope checks

- No foundation brand token or dependency change.
- Existing Source storage remains the SSOT.
- No automatic reporter-to-writer chain; writer dispatch remains an explicit Owner action.
