# EVAL-CAP-021

- Capability: Shared daily intelligence orchestration and receipts — freeze enabled channels, durable per-source receipts, succeeded/partial/needs_user/failed aggregation, empty plan may succeed.
- Tasks: WMB-4900 … WMB-4904 (Today mainline UX convergence and cross-day fact-boundary repair on CAP-021 surfaces)
- Preconditions: Settings has channel readiness; Today can start daily intelligence; Pi config optional for projection tests.
- Steps:
  1. Project idle/running/partial/needs_user/failed/done task fixtures through `deriveTodayRunView`.
  2. Confirm no fake「创建今日运营方案」pending card when plan is missing.
  3. Confirm partial primary CTA is「继续生成方案」and needs_user primary is「继续今日情报」with actionable blocker.
  4. Confirm empty-success (`succeeded` + 0 opportunities) is not shown as「还在准备中」.
  5. Confirm command-bar/statusLine share one headline source.
  6. With no current-day plan/sources, project a historical plan plus five fermenting items and confirm each region names its actual date boundary.
  7. Confirm internal dispatcher/request identifiers never enter user-facing command or empty-state copy.
- Expected observable results: single narrative source; contradictory idle/start copy does not appear on failed/partial; current-day counts exclude historical plan/source fallbacks; recent plan/source surfaces carry dates; blockers navigate settings sections; CAP-021 receipt semantics unchanged in backend tests.
- Command evidence: `tests/today-run-view.test.mjs` → 13 passed; `tests/daily-intelligence-channels.test.mjs` (prior CAP-021 channel suite); `npm run typecheck` → pass; `node scripts/smoke-renderer.mjs` → ok; `.ai/wmb-4901-evidence.md`; `.ai/wmb-4904-evidence.md`.
- Manual/live evidence: cold-started Electron on isolated renderer `127.0.0.1:27391`; live DOM showed current-day sources/opportunities 0, historical plan explicitly labeled, fermenting 5, no competing old sentence or internal error code, and no horizontal overflow. Screenshot `J:/Users/yangda01/Temp/omp-sshots-154c6740acc1c665.webp`.
- Result: pass
- Failure reason: none for WMB-490x Today mainline scope.
- Pi operator Skill impact: no change — presentation/navigation only.
