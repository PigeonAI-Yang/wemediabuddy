# Full-path stall / empty-plan / grant fixes (2026-08-08)

## Live result
- UI: `今日运营方案已就绪`
- Opportunities: 8
- No zombie running tasks
- Detail: partial channels tolerated; plan retained

## Root causes fixed
1. **Dead coordinator + starting gate**
   - `decideDailyStartGate` returned `return_active` for `starting/scanning` without live coordinator → fake running.
   - Fix: dead starting/scanning → `start_full`; dead judging → `start_judge_only`.
   - Start handler partial-clears orphan before restart; sweeper restarts full scan after clearing starting orphans.

2. **Task grant role stuck on reporter after scan→judge**
   - Grant issued with caller `roleId=reporter` → only `agent_tasks.report_progress` → `plans.save` TASK_SCOPE_BROADENED.
   - Fix: `ensureAutomaticTaskGrant` prefers intent role (`daily_judge`→planner, `daily_scan`→reporter).

3. **Lane gate revision conflict**
   - Write path refreshes live `source_items.revision` before `sources.lane_gate`.

4. **Empty plan clobber**
   - Empty synthesis overwrote non-empty same-day current plan.
   - Fix: preserve existing non-empty current plan; validation accepts preserved plan.

5. **UI partial-with-opportunities**
   - Showed "方案还没生成完" even with 8 opportunities.
   - Fix: partial + opportunityCount>0 → ready state + 去创作.

## Tests
- `tests/daily-start-gate.test.mjs` pass
- `tests/task-grants.test.mjs` pass
- `tests/today-run-view.test.mjs` pass
- `tests/lane-gate-run.test.mjs` pass
- `tests/daily-intelligence-channels.test.mjs` pass
