# EVAL-CAP-002

- Capability: Sources and daily workbench — `source_feeds`/`source_items` model, website and X List channel modules writing through it, canonical URLs as the traceability anchor, workbench reads for Today and Pi.
- Tasks: WMB-4910 (brief increment reads), WMB-4912 (channel failure isolation), WMB-4914 (pool reads), WMB-4916 (canonicalUrl citation constraint); earlier source foundations (M-200, M-1800) unchanged.
- Preconditions: seed DB with feeds/items across channels; items with and without canonical URLs.
- Steps:
  1. Upsert sources via website scan, X List collect and Pi/MCP writes; confirm all land in `source_items` with canonical URLs where an origin URL exists.
  2. Confirm channel failures record per-source receipts and never block judgment or drop previously stored items.
  3. Confirm `saveCurrentPlan` rejects items citing sources with NULL/empty canonical_url and accepts URL-backed citations.
  4. Confirm workbench pool and brief increment read the same `source_items` without mutation.
- Expected observable results: one source model for every channel; receipts carry per-channel truth; plans cite only traceable sources.
- Command evidence: `tests/opportunity-pool.test.mjs` → 6 passed (incl. canonicalUrl reject/accept); `tests/daily-intelligence-channels.test.mjs` → 15 passed; `tests/editorial-brief.test.mjs` → 5 passed; full suite `npm test` → 301/301; `npx tsc --noEmit` → clean.
- Manual/live evidence: live CDP run on the real AI root — 5/5 website scan saved 100 items and judgment proceeded; pool cards cited sources with `引用资料 ×N` (`.ai/today-pool-final.png`).
- Result: pass
- Failure reason: none.
- Pi operator Skill impact: no change in this eval slice beyond WMB-4915's whitelist/brief guidance (see EVAL-CAP-014).
