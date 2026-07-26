# WeMediaBuddy Delivery Plan

This plan orders the complete current PRD. Phases are dependency gates, not reduced scope or an MVP.

## M-000 Harness and contracts

Scope: CAP-001–CAP-013 documentation and traceability.

Gate:

- PRD, SPEC, technical design, plan, and task ledger agree;
- harness check passes;
- task ledger contains every capability.

## M-100 Desktop foundation

Scope: CAP-001, CAP-013.

Deliver:

- Electron + React + TypeScript scaffold;
- selected package manager and pinned runtime versions;
- sandboxed renderer and narrow preload;
- data-root first run/open flow;
- SQLite migrations;
- Settings health, paths, usage, counts, and logs;
- package typecheck, test, and build scripts.

Gate: packaged Windows app reopens one selected data root with persisted objects and truthful health/readback.

## M-200 Sources, plans, and Today

Scope: CAP-002, CAP-003.

Deliver:

- source feed/item persistence and dedupe;
- topics, plans, references, and current-plan rule;
- Today view and business commands.

Gate: duplicate source input does not create duplicate identity, and a current plan cites stored sources.

## M-300 Studio, assets, and MCP

Scope: CAP-004, CAP-005.

Deliver:

- content projects, immutable versions, platform versions;
- atomic asset import and preview;
- Studio view;
- loopback MCP tools;
- revision and request-id behavior.

Gate: Agent A creates work, Agent B continues it, stale Agent A write conflicts, and UI reflects the latest revision.

## M-400 Browser, accounts, and safe publishing core

Scope: CAP-006, CAP-007, CAP-013.

Deliver:

- managed visible Chrome/profile/CDP;
- account identification and mismatch blocking;
- prepare/readback contract;
- UI-only confirmation;
- publication attempts, unknown reconciliation, takeover, and state timeline.

Gate: a local controlled page proves state transitions and restart safety; no real platform is claimed complete here.

## M-500 X vertical slice

Scope: CAP-008, CAP-011.

Deliver all three X formats with real account identity, publish readback, metrics, and recovery.

Gate: EVAL-003, EVAL-004, and EVAL-005 pass with real status identities.

## M-600 Xiaohongshu vertical slice

Scope: CAP-009, CAP-011.

Deliver both Xiaohongshu formats with real account identity, publish readback, metrics, and recovery.

Gate: EVAL-006 and EVAL-007 pass with real note identities.

## M-700 WeChat vertical slice

Scope: CAP-010, CAP-011.

Deliver actual article publication, human takeover when required, accessible article readback, and metrics.

Gate: EVAL-008 passes; a saved draft alone fails.

## M-800 Results and learning loop

Scope: CAP-011, CAP-012.

Deliver:

- 1h/6h/24h/72h snapshots and overdue recovery;
- account snapshots;
- Results view;
- final review and method findings;
- later plan backlink.

Gate: EVAL-011 and EVAL-012 pass.

## M-900 Full acceptance and delivery

Scope: CAP-001–CAP-013.

Deliver:

- all command checks;
- packaged app;
- six live publication receipts;
- cross-Agent receipt;
- restart, unknown, stale confirmation, data-root, and feedback-loop receipts.

Gate: all TASKS are `done`, all EVAL-001–EVAL-013 pass, and the harness check passes.

