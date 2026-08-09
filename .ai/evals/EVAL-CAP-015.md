# EVAL-CAP-015

- Capability: Long-term knowledge compounding — every source keeps independent verification and management states; opportunity/content/publication use derives from existing relations; library reads are bounded/paged with search and both state filters; topics carry canonical keys and explicit source relations; historical-context reads follow the existing chain; rediscovery is deterministic. WMB-4940…4945 harden the effective-library boundary: post-ingest lane relevance moves out-of-lane noise to `management_status='archived'` with an audit row, and every CAP-015 consumer (library default view, knowledge context, rediscovery/ferment, brief increment, Today stats) reads effective sources only.
- Tasks: WMB-4940 … WMB-4945 (M-4940 lane-relevance gate chain, CAP-015 surfaces)
- Preconditions: migrated DB (v46 `source_lane_judgments`); workspace profile with intelligencePackId; official/registry + AI-frontier X List feeds for Tier 0 fixtures.
- Steps:
  1. Seed a mixed batch (official feed, AI-frontier list, lifestyle/generic feed) and run `buildDailyGateRun` + `applyDailyLaneGate`.
  2. Confirm lifestyle content becomes `management_status='archived'` (revision+1) with an `irrelevant` judgment row carrying reasonCode/reason/judged_by/judged_at/source_revision; official and lane posts stay `active` with `judged_by=system` rows.
  3. Confirm archived items disappear from default `listKnowledgeSources`, `getKnowledgeContext`, brief increment block and Today feed/stats; `searchSources` excludes them by default and `includeArchived=true` restores visibility; ferment `refreshWorkCarry`/rediscovery do not seed archived sources.
  4. Restore an archived source via `sources.lane_restore`: back to `active`, latest judgment row is `judged_by=editor` (append-only), next brief increment shows it again, and `shouldSkipJudgment` blocks re-judgment for 7 days (even if re-collected).
  5. Break the structured gate output: the round fails closed with zero archive and zero judgment rows; a later valid round re-judges without duplicate rows.
  6. Run with zero new sources and an empty plan: gate is a no-op with zero writes and the daily task finishes `succeeded` (AC-017).
- Expected observable results: management status remains the single exclusion hook (no new enum), the judgment ledger is append-only and idempotent, all CAP-015 consumers stay on effective sources only, and M-4930 opportunity-pool/ferment/chair invariants are unchanged (zero schema change to plan/carry/pool).
- Command evidence: `tests/lane-gate-e2e.test.mjs` → 4 passed (mixed batch, restore+cooldown, empty-run no-op, parse-fail retry); `tests/lane-gate-run.test.mjs` → 6 passed; `tests/lane-gate-contract.test.mjs` → 11 passed; `tests/brief-increment-effective-only.test.mjs` + `tests/today-stats-effective-only.test.mjs` + `tests/search-sources-effective-only.test.mjs` → 11 passed; `tests/lane-gate-removed-view.test.mjs` → 2 passed; full `npm test` → 359 passed; `npm run typecheck` → exit 0.
- Manual/live evidence: none required for this eval — all acceptance criteria (design §9 A–E) are covered by the focused fixtures above; the removed-view UI badge/restore flow was separately accepted in WMB-4944.
- Result: pass
- Failure reason: none for WMB-494x lane-gate scope.
- Pi operator Skill impact: no change — gate orchestration and effective-library reads are system-side; Pi-facing prompts were finalized in WMB-4942.
