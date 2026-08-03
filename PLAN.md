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
- native Pi dock turn controls: no ordinary-chat deadline, stop/steer/follow-up, native queue display and forked conversation branches;
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

## M-1600 X List workspace

Scope: CAP-017.

Deliver:

- fixed, visible, serial X List executor using the active data-root's selected dedicated X profile;
- persisted List bindings, confirmation-bound operation records and per-member readback;
- owned/followed/member List read model and permission-bounded management commands;
- UI-only confirmation, MCP/Pi read-and-prepare commands, and Discover List workspace;
- explicit bounded List-timeline collection into existing sources.

Gate: EVAL-016 passes with a real selected X profile, an owned List mutation with exact readback, stale confirmation rejection, safe stop/unknown behavior, and a bound List source readback. X Lists remains available independently of the publishing-platform subset; workspace acceptance additionally proves the same X List identity/cache fixture is root-local and never reused across roots.

## M-1700 Official-release intelligence wire

Scope: CAP-002, CAP-003, CAP-014 and CAP-017.

Deliver: expand and validate the official AI source index, run the enabled AI-frontier X List and primary-source checklist before judgment routes, persist per-source health, and prove named release evidence enters existing sources. M-2100 later migrates these accepted source identities into the AI root's ordinary website/X Lists configuration and replaces this AI-only execution route without losing the accepted source readback.

Gate: source-index validation, focused wire tests, durable source-item readback and List-operation evidence pass without creating a second intelligence store.

## M-1800 Durable source foundation

Scope: CAP-002 and CAP-014.

Deliver: canonical source identity and upsert semantics, registry-to-feed binding, root-local bounded source-body cache rules with no cross-root hit, and a shared wire-health read API.

Gate: source/migration/settings focused tests and typecheck prove every ingress resolves to one durable source and the latest wire health is readable through the shared business surface.

## M-1900 Modular data-root workspaces

Scope: CAP-002, CAP-003, CAP-004, CAP-006, CAP-011, CAP-012, CAP-013, CAP-014, CAP-015, CAP-016, CAP-017, CAP-018 and CAP-019.

Detailed design: `docs/spark/2026-08-02-modular-workspace-content-terminal-design.md`.

Order:

1. `WMB-1900` — approve the product/implementation/architecture contracts and this sequential task chain;
2. `WMB-1901` — seal the dirty baseline, its acceptance code and a repeatable pre-enrollment AI-root manifest with an explicit allowed-difference set;
3. `WMB-1902` — add the minimal registry, root identity, moved-root relink and zero-business-migration AI enrollment;
4. `WMB-1903` — deliver the complete relaunch-based workspace switch slice: mutation drain, switch journal, list/switch UI, old MCP/process shutdown, rollback and inactive-root proof;
5. `WMB-1904` — add finite compile-time AI/UK profiles, route discovered AI-only choices through the active profile, create a fresh UK root and prove a linked X pure-text chain with exhaustive AI-only sentinel coverage;
6. `WMB-1905` — extract only the intelligence/creation catalog boundaries proven by AI/UK, then add session-bound proposals and read-or-prepare-only application MCP tools with the full stale negative matrix;
7. `WMB-1906` — add UI result/diff confirmation and prove an Owner-supplied third self-media goal through manual confirmation, cold reopen and a linked X pure-text chain;
8. `WMB-1907` — run focused packaged acceptance for enrollment, relaunch switching, failure recovery, UK, the third lane and truthful `needs_user`, reusing unchanged legacy receipts.
9. `WMB-1908` — publish one authoritative workspace capability snapshot; make active-profile changes replace every bound runtime and old MCP URL; make generic X Lists available in every root while keeping caches, accounts and AI fixed-List policy root/pack isolated;
10. `WMB-1909` — render Discover from a finite intelligence-pack mapping, keep rankings/then-current AI source presentation AI-only, and expose the shared root-local X Lists workspace in AI, UK and game without a plugin loader; M-2100 later migrates source presentation to shared root-local channels;
11. `WMB-1910` — enforce profile publishing-platform subsets at shared write/runtime boundaries and make missing-model/login task states truthful without disabling generic X List inputs;
12. `WMB-1911` — isolate workspace-bound renderer selections and remove mount-time business writes;
13. `WMB-1912` — run the packaged AI/UK/game module, generic X Lists, platform, process and zero-cross-root acceptance matrix.

Gate: EVAL-017–EVAL-019 pass. The AI root retains its current data and accepted behavior; AI, UK and the third lane use one WMB codebase but isolated roots; inactive roots have no process or write; Agents can prepare but never activate a profile. Generic `x_lists.*` is available in every active self-media root independently of publishing platforms, while accounts, bindings, caches, operations and collected sources stay root-local. M-2100 subsequently replaces the fixed AI source wire with the shared root-local channel configuration while retaining AI rankings. Legacy UK-terminal data import, rename/archive/delete lifecycle, third-party plugins, shared-database tenancy, parallel workspace runtimes, profile history/old-pack compatibility and native media editors are not part of M-1900.

## M-2000 Pi model contract correction

Scope: CAP-014.

Deliver: state the built-in Pi boundary accurately, retain only OpenAI Responses and OpenAI Chat Completions configuration, store one encrypted preset set for the WMB installation, reject unsupported protocols at the shared config boundary, and keep model selection bound to the provider catalog or explicit user input without fallback.

Gate: focused Pi configuration tests, Windows packaging and live configuration readback prove the removed protocol is unavailable while the existing OpenAI-compatible profile remains unchanged. Run typecheck and record unrelated baseline failures without expanding this task.

## M-2100 Workspace intelligence channels

Scope: CAP-002, CAP-003, CAP-014, CAP-017, CAP-018, CAP-019, CAP-020 and CAP-021.

Detailed design: `docs/spark/2026-08-03-workspace-intelligence-channel-modules-design.md`.

Order:

1. `WMB-2100` — approve REQ-020–022, AC-016–018, CAP-020–021, EVAL-020–023 and this sequential task chain;
2. `WMB-2101` — add root-local website source configuration, generic per-source scan receipts, shared readiness readback and migrations while reusing existing source/List objects;
3. `WMB-2102` — add arbitrary public website name/URL candidate resolution, canonical trial read, confirmation, management and truthful zero-item scans;
4. `WMB-2103` — add current-account X List name/URL/ID resolution, same-name candidate selection and existing-binding reuse;
5. `WMB-2104` — move deterministic channel preflight/scans above pack-specific judgment, freeze selected source revisions, aggregate per-source receipts and replace the zero-source/non-empty-plan completion gate;
6. `WMB-2105` — deliver Discover intelligence-channel management and the original Today default-all/per-run selection/preflight UI from the authoritative shared snapshot; WMB-2300 later removes the Today management surface while retaining automatic default-all preflight;
7. `WMB-2106` — expose read/prepare-only channel MCP/Pi tools and UI-only exact batched source confirmation with stale zero-write behavior;
8. `WMB-2107` — run focused packaged AI/UK acceptance for arbitrary websites, same-name X Lists, cold-switch isolation, zero-update success, partial preservation, all-blocked preflight and exact authorization.

Gate: EVAL-020–EVAL-023 pass. AI/UK use the same two fixed channel modules and shared daily scan path; the AI source-index/List fixtures are retained as visible AI-root configuration rather than a privileged collector. At least one truthful source check may succeed with zero new items and an empty plan, while no trustworthy receipt cannot claim success. Source configuration, account identity, receipts and collected items stay root-local; Agents prepare but UI confirms exact source changes. X accounts, Xiaohongshu, communities, third-party modules, plugin loading and the separate Pi stale temporary-working-directory BUG are outside M-2100.

## M-2200 X List trend opportunity radar

Scope: CAP-002, CAP-003, CAP-011, CAP-015, CAP-017, CAP-018, CAP-021 and CAP-022.

Detailed design: `docs/spark/2026-08-03-x-list-trend-opportunity-radar-design.md`.

Order:

1. `WMB-2200` — freeze REQ-023/AC-019/CAP-022/EVAL-024–025, capture one current real structured-metrics baseline and falsifiably test List-ID response isolation;
2. `WMB-2201` — add per-field parsing status and append-only root-local X post metric snapshots after account/binding revalidation;
3. `WMB-2202` — add deterministic bounded snapshot/trend reads with exact insufficient-data semantics and shared IPC/MCP/Pi access;
4. `WMB-2203` — add explicit-start +15m/+60m/+180m observation jobs, idempotency, stop/restart/expiry and active-root lifecycle;
5. `WMB-2204` — feed trend evidence into existing event/topic aggregation, Today/Discover and the plan-to-content chain without social automation or a second source/event store;
6. `WMB-2205` — run focused current-Windows-package EVAL-024–025 acceptance with real X metrics, root switching, partial/needs_user and responsive UI readback.

Gate: EVAL-024–EVAL-025 pass. One explicit run creates only bounded active-root observation work; the same post retains one source identity and multiple truthful metric snapshots; deterministic speed evidence reaches an existing multi-source opportunity and survives UI/MCP creation into the same topic/source lineage. Missing metrics, app exit, root switch and late responses never create fake trends or cross-root writes. Full-network monitoring, X official APIs, background services, automatic social interaction and unrelated X utility tools remain outside M-2200.

## M-2300 Today information-first restoration

Scope: CAP-020 and CAP-021.

1. `WMB-2300` — remove channel selection, source counts, readiness management and configuration guidance from Today; start every enabled Discover channel automatically and report preflight failure only after an explicit start.

Gate: Today contains no channel checkbox/count/name/readiness/configuration surface, its start payload cannot deselect modules, Discover retains the full management surface, and a renderer readback confirms content opportunities remain the primary first-screen hierarchy.
