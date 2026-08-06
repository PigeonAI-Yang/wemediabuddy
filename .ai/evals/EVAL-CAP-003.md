# EVAL-CAP-003

- Capability: Topics and daily plans — one current plan per date with fully-shaped items (title, priority, whyNow, timeliness, audience, angle, pointOfView, platforms/formats, guidance, effort, cited source_ids, materials, topic/review/method-finding links); rolling opportunity pool reads across dates with truthful termination.
- Tasks: WMB-4910 (editorial brief assembly), WMB-4911 (four-question judgment mandate), WMB-4914 (opportunity pool semantics + dismiss path); earlier plan foundations (M-200 chain) unchanged.
- Preconditions: seed DB with sources, plans across dates, carry rows, projects, publications.
- Steps:
  1. Save plans on two dates and confirm exactly one current plan per date; items keep all required fields and validate real sourceIds.
  2. Assemble the editorial brief and confirm identity/history/inventory/increment blocks with bounded SQL.
  3. Confirm the judgment prompt carries the four-question mandate and knowledge-context-first rule.
  4. Read the opportunity pool and confirm adopted (project-linked), dismissed, expired-carry, and timeliness-expired items are excluded; evergreen items are not recency-bound.
  5. Dismiss a non-seeded plan item and confirm a dismissed fingerprint row is written and reseeding never revives it.
  6. Publish on a topic and confirm same-topic pool items demote to the tail with annotation within 24h.
- Expected observable results: pool membership equals "unterminated" exactly; dismiss is permanent against reseeding; plan validation unchanged (real sources, current-per-date).
- Command evidence: `tests/opportunity-pool.test.mjs` → 5 passed (union/termination, no-revive, demotion, expired-carry, getToday pool); `tests/editorial-brief.test.mjs` → 5 passed; `tests/agent-runner.test.mjs` → 3 passed; full suite `npm test` → 295/295; `npx tsc --noEmit` → clean; `node scripts/check-ledger.mjs` → PASS after this file.
- Manual/live evidence: none required for this capability slice (unit/fixture coverage with real SQLite; UI projection lands in WMB-4915).
- Result: pass
- Failure reason: none.
- Pi operator Skill impact: updated at WMB-4911 — brief/four-question/knowledge-context mandate added to operator Skill.
