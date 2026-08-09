# WMB-5001–5004 Evidence — Continuous attention → topic progress

Date: 2026-08-07  
Milestone: M-5001  
Normative: PRODUCT C3/C4, PRD §2.0, SPEC §1.0, form constitution §5/§8

## Delivered

1. **Design + ledger** (`WMB-5001`)
   - `docs/spark/2026-08-07-continuous-attention-topic-progress-design.md`
   - `PLAN.md` M-5001
   - `TASKS.md` WMB-5001..5004

2. **Backend projection** (`WMB-5002`)
   - `listFermentingBundle` now projects **topics** only (never bare `source` / plan_item as long-horizon identity).
   - `seedCarryFromHighValueSources` no-op (stops bare high-value source desk promotion).
   - `createTopic` fills knowledge columns; `saveCurrentPlan` links `topic_source_links` + bumps `topics.last_seen_at`.
   - plan_item `work_carry_items` state machine kept for proposals dismiss/restore.

3. **Frontend** (`WMB-5003`)
   - `FermentingRail`: title `持续关注 · 主题 · N`; rows are topics; badge「主题」; empty copy 主题.
   - `createFromCarry` supports `topic` → create studio project + bind `topicId`.
   - `TodayView` accepts `openTopic`; main wires it.

4. **Tests** (`WMB-5004`)
   - `tests/ferment.test.mjs` rewritten for topic progress + bare-source ban.
   - `tests/ferment-aftershock-no-topic.test.mjs` rail assertions updated (aftershock still on carry; rail = topic).

## Commands

```text
node --test tests/ferment.test.mjs tests/ferment-aftershock-no-topic.test.mjs tests/today-desk-display.test.mjs tests/today-creation-actions.test.mjs
→ 16/16 pass

node --test tests/opportunity-pool.test.mjs tests/proposals-ledger.test.mjs
→ (see run log)

npx tsc --noEmit -p tsconfig.json
→ exit 0
```

## Pi operator Skill impact

no change — Today rail projection/UI; Skill copy already says 持续关注; no tool/grant change.

## Independent review

not required — test-only + typecheck evidence for implementation tasks; design was docs-only.

## Residual risks

- Legacy `source` carry rows may still exist in DB but are not projected.
- Topic induction still relies on multi-day plan bind / agent `topicId` (LLM path), not a new free-form merge agent in this milestone.
- editorial-brief inventory now receives topic-shaped fermenting.items; shape remains FermentingBundle-compatible.
