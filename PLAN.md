# WeMediaBuddy Delivery Plan

This plan orders the complete current PRD. Phases are dependency gates, not reduced scope or an MVP.

## M-000 Harness and contracts

Scope: CAP-001–CAP-015 documentation and traceability.

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

Gate: duplicate or incremental source input does not lose prior analysis, complete source search/readback works, and a current plan cites stored sources with material gaps, retains every qualifying opportunity, and reads them back in `SSS → F` order without a fixed count cap.

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

## M-1100 Long-term Studio workbench

Scope: CAP-004, CAP-005 and CAP-014 at 1000+ content-project scale.

Detailed plan: `STUDIO_LONG_TERM_PLAN.md`.

Order:

1. correct Pi project/version semantics;
2. split project-list and single-project detail reads;
3. add project status, archive, search and bounded paging;
4. rebuild Studio around on-demand project detail and usable version history;
5. migrate existing data and pass the 1001-project desktop acceptance.

Gate: Pi creates a new project for a new article and leaves unrelated project versions unchanged; list payloads contain at most 50 summaries and no historical bodies; one project detail retains complete immutable versions; 1001-project search/filter/paging, revision conflict, migration integrity and real desktop operation pass.

## M-1200 Knowledge compounding

Scope: CAP-002, CAP-003, CAP-004, CAP-011, CAP-012 and CAP-015.

Deliver:

- dual-axis source lifecycle and independent paged Library;
- explicit cross-day topic/source aggregation;
- bounded historical contribution-chain context;
- deterministic rediscovery;
- shared UI, IPC and MCP/Pi business commands.

Detailed plan: `KNOWLEDGE_COMPOUNDING_PLAN.md`.

Gate: migration preserves existing objects; lifecycle revisions, topic idempotency, 250-item paging, and a real source-to-review feedback chain read back through the same business API.

## M-1300 Knowledge canvas

Scope: CAP-002, CAP-003, CAP-004, CAP-015 and CAP-016.

Deliver:

- persistent canvases containing references to real WMB objects and local notes;
- directed typed semantic relations with separate canvas visibility;
- drag, pan/zoom, multi-select and rectangular selection;
- direct current-page or explicit multi-selection Pi context with whitespace clear;
- direct current-page/selected context carried by the existing Pi turn, with evidence links stored on briefs/projects and no package or snapshot object;
- shared business, IPC and MCP commands with optimistic revisions and atomic idempotency.

Detailed plan: `KNOWLEDGE_CANVAS_PLAN.md`.

Gate: EVAL-015 passes on migrated real data, including restart restoration, current-page default, multi-select sentinel exclusion, whitespace clear, exact Pi-turn context identity, project evidence backlink and 250-node/1100px operation.

## M-1500 Frontend visual and experience redesign

Scope: renderer UI/UX only; no business-contract change. Baseline is the owner-approved interactive prototype in `prototype/` (「墨夜编辑台」, approved 2026-07-30).

Deliver:

- design tokens (elevation, accent discipline, priority/platform color scales, type scale) in `styles.css`;
- grouped rail navigation, refined topbar and status bar, collapsible Pi dock;
- per-view redesigns: Today, Studio, Publish, Results, Library/Domain Map, Canvas/Composer, Settings;
- amber "needs human" semantics, SSS→F grade badges, platform identity colors applied consistently.

Gate: every redesigned view keeps its existing business behavior and readbacks, shows zero document/body overflow at 1100×700 and 1920×900 in a real Electron window, and typecheck plus the lightweight harness pass.

## M-1400 Built-in Xiaohongshu collection for Pi

Scope: CAP-002, CAP-009, CAP-013 and CAP-014.

Deliver:

- pinned `xpzouying/xiaohongshu-mcp` binaries packaged as WMB resources without account cookies;
- one supervised loopback-only child process using the selected WMB data root for runtime state;
- explicit login, readiness, failure, restart, data-root switch and application-exit lifecycle;
- exactly four read-only Xiaohongshu tools exposed to every built-in Pi entry;
- Xiaohongshu search/detail/profile evidence saved and read back through the existing WMB source business API.

Detailed plan: `XIAOHONGSHU_MCP_PI_PLAN.md`.

Gate: a packaged Windows app starts its own pinned Xiaohongshu MCP without external installation, Pi performs one real read-only collection flow and saves a source through WMB MCP, cookies remain only under the selected data root, write tools are absent, and application exit leaves no child process.
