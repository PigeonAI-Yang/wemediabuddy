# EVAL-CAP-020

- Capability: Root-local intelligence channel configuration — each data-root configures only its own websites and X List bindings; official-web scanning is pure HTTP and never browser-bound; per-channel failure is isolated and annotated.
- Tasks: WMB-4912 (channel failure isolation, rolling scan scheduler, scanOnly coordinator), earlier CAP-020 configuration surfaces unchanged (WMB-2100, WMB-3200, WMB-3300, WMB-4505).
- Preconditions: AI or UK root with at least one website source and/or X List binding; browser binding may be unverified.
- Steps:
  1. With every channel blocked (X binding without verified browser), run daily channels and confirm judgment still starts and finishes `partial` with needs_user receipts, never `needs_user` task.
  2. With a website scan throwing, confirm the run records a failed receipt and still returns `shouldRunJudgment: true`.
  3. With zero enabled sources, confirm preflight still blocks as `CHANNELS_NOT_CONFIGURED` (only true config blocker).
  4. Confirm `finishDailyIntelligenceFromReceipts` finishes `partial` with annotation for needs_user/failed aggregation instead of needs_user/failed task status.
  5. Confirm scheduler fires official_web and x_lists ticks independently, guards re-entry, skips when runtime is not current, and stops on activation failure / stopRuntime / before-quit.
  6. Confirm `scanOnly` coordinator path skips Pi prerequisite and judgment while still recording receipts and grants.
- Expected observable results: no channel failure blocks judgment; receipts carry per-channel truth; only unconfigured channels block; rolling scans reuse the same coordinator as the manual Today entry.
- Command evidence: `tests/daily-intelligence-channels.test.mjs` → 14 passed (incl. rewritten all-blocked and thrown-scan non-blocking contracts); `tests/daily-scan-scheduler.test.mjs` → 3 passed; full suite `npm test` → 288/288; `npx tsc --noEmit` → clean; `node scripts/check-ledger.mjs` → PASS after this file.
- Manual/live evidence: `wmb-dev` cold start on `127.0.0.1:27391` after clearing stale `wmb-package-final` instance; `node scripts/smoke-renderer.mjs` → ok; renderer still serving 12s later; scheduler boots with runtime activation (first tick 90s, scanOnly).
- Result: pass
- Failure reason: none.
- Pi operator Skill impact: no change — channel semantics are system-side; Pi workflow guidance unchanged.
