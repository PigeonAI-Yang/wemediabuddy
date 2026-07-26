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

## One-command check

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

This currently validates the harness and traceability documents. After scaffold, it must also call the real package scripts.

## Typecheck

No command exists yet. The scaffold task must add a package script and wire it into `scripts/check.ps1`.

## Lint

No command exists yet. Add only if the scaffold includes a linter; do not introduce one solely to satisfy this heading.

## Tests

No command exists yet. Each non-trivial business task must add the smallest runnable regression check required by `SPEC.md`.

## Build

No command exists yet. Electron packaging and application build commands are established by the scaffold task.

## Manual and live checks

Required by capability:

- UI/MCP consistency: create or modify the same object through both transports and compare readback.
- Chrome: show process identity, profile path, CDP endpoint, and logged-in account.
- Publishing: exact human confirmation, real publish, stable publication identity readback.
- Metrics: real creator-page values, capture timestamp, source page, and unsupported/unavailable semantics.
- Recovery: restart application and verify persisted state and safe job transition.

## Known gaps

- No application code or manifest.
- No pinned dependency versions.
- No automated typecheck, test, or build command.
- Live platform selectors and metric fields require inspection of the user's authenticated pages.

