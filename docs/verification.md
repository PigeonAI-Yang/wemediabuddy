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

This validates required contracts, task-ledger structure and traceability. It intentionally does not run all package checks.

## Change-proportional checks

- Focused regression: required for the changed non-trivial behavior.
- Typecheck: run when TypeScript or a shared type boundary changed.
- Full tests: run only for shared business behavior, migrations, or harness changes.
- Windows package: run only for packaging resources/configuration, startup, preload/main boundaries, release, or final acceptance.
- Live readback: required whenever the acceptance claim concerns a real browser, MCP, database mutation, packaged runtime, or platform state.

Do not repeat a successful check when neither its inputs nor acceptance target changed. Reuse the recorded receipt.

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

## Prohibited verification waste

- Packaging after an unrelated renderer or copy change.
- Running all tests when one focused regression covers the changed call path.
- Rebuilding the same unchanged Pi/runtime resource more than once in a task.
- Treating command count as evidence quality.
