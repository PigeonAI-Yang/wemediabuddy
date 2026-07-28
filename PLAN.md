# WeMediaBuddy Delivery Plan

This plan orders the complete current PRD. Phases are dependency gates, not reduced scope or an MVP.

## M-000 Harness and contracts

Scope: CAP-001–CAP-014 documentation and traceability.

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
- versioned intelligence-engine Skill with a graded source registry, collection SOPs, evidence verification, event clustering, and opportunity judgment;
- topics, plans, references, and current-plan rule;
- Today view and business commands.

Gate: duplicate or incremental source input does not lose prior analysis, complete source search/readback works, and a current plan cites stored sources with material gaps.

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

Deliver all three X platform-version formats and exact manual handoff.

Gate: EVAL-003, EVAL-004, and EVAL-005 pass with exact payloads and bound assets.

## M-600 Xiaohongshu vertical slice

Scope: CAP-009, CAP-011.

Deliver both Xiaohongshu formats through the required MCP/manual workflow.

Gate: EVAL-006 and EVAL-007 pass with exact payloads and bound assets.

## M-700 WeChat vertical slice

Scope: CAP-010, CAP-011.

Deliver the final article payload for manual publication and optional URL validation.

Gate: EVAL-008 passes with the exact article payload.

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
- six platform payload receipts;
- cross-Agent receipt;
- restart, unknown, stale confirmation, data-root, and feedback-loop receipts.

Gate: all current-scope TASKS are `done`, all EVAL-001–EVAL-013 pass under the manual-publication contract, and the harness check passes.

## M-1000 Built-in Pi executor

Scope: CAP-014 plus existing CAP-002–CAP-005 and CAP-013 business surfaces.

Deliver:

- pinned, independently replaceable Pi runtime using WMB's OpenAI-compatible connection;
- one supervised RPC process and thin WMB MCP extension;
- durable, idempotent Pi task state with business-object readback;
- one persistent collapsible Pi dock on every main page;
- Today intelligence and Studio draft intents without an external chat.

Gate: the packaged runtime starts, streams, aborts and exits; a real Pi task writes only through live WMB MCP; Today and Studio read back their required business objects; final publication remains manual.
