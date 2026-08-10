# WMB-5150 Evidence

- Task: WMB-5150
- SPEC: CAP-003, CAP-026, EVAL-031; PRD REQ-030, AC-028
- Delivered: librarian creates frozen create/update/merge/archive/reassign proposals; desk reads and presents them; Topic exposes the complete paged ledger; Today exposes pending decisions; only Owner UI can approve/reject; approval is atomic and stale/reject paths write no business facts.
- Data integrity: merge migrates source links, plan items, content projects, real review lineage, carry items (including fingerprint/story key), canvases, canvas topic nodes and domain-topic links; old topics are archived and a postcondition requires zero remaining formal references. Chain/cycle/contradictory merge graphs and nonexistent reassign links fail before proposal creation.
- Authority: librarian receives only `knowledge.topic_maintenance_propose`; approve/reject are non-grantable Owner commands and are unavailable to desk/planner/librarian/MCP agents. Owner UI uses one stable request ID per proposal revision and decision.
- Pi/MCP: read list/get plus propose wrappers registered; canonical operator Skill, both installed data roots and `J:\wmb-out` packaged resource all read back revision `a0ed3996344a3ef79f7e0f0618abbb9fa2e011a9aad059737966086e822241f6`.
- Focused: `node --test --test-concurrency=1 tests/wmb-5150-topic-maintenance.test.mjs` → 5/5 PASS; Pi/operator + adjacent dispatcher batch → 61/61 after mirror refresh.
- Global: `npm test` → 670/670 PASS; `npm run typecheck`, `npm run check:capabilities`, `check-intake`, `check-ledger`, `scripts/check.ps1`, `git diff --check` → PASS; `npm run package` → PASS.
- Live: `node scripts/smoke-renderer.mjs` → WeMediaBuddy/#root; `.ai/wmb-5150-ui-acceptance.mjs` → Topic full frozen diff and enabled Owner decision at 1440 and minimum 1100 widths, no document or inner-pane horizontal overflow; Today pending entry visible. Screenshots: `.ai/wmb-5150-topic-1440.png`, `.ai/wmb-5150-topic-1100.png`, `.ai/wmb-5150-today-pending.png`.
- Owner feedback closure: removed the wasteful instructional command card from Topic and replaced it with a compact one-line title.
- Independent review: `wmb_5150_rereview` PASS; all prior canvas/carry/merge/reassign/pagination/idempotency/responsive findings closed.
- Skipped: no real user proposal was created or approved during acceptance; UI evidence uses an isolated temporary data root.
