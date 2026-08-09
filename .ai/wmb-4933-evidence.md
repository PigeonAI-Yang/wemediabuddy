# WMB-4933 Evidence

Date: 2026-08-07

## Problem

Zero-update / re-scout wrote an empty `is_current=1` plan for the day. Chair blanked because:

1. `getOpportunityPool` only read `p.is_current = 1`
2. `getToday.latestPlan` was null whenever any today plan existed
3. `displayItems` trusted empty `todayPlan`

## Fix (read path only)

- Design: `.ai/2026-08-07-empty-current-plan-chair-fix.md`
- `getOpportunityPool`: per `plan_date`, latest **non-empty** plan (not `is_current`)
- `getToday.latestPlan`: latest non-empty plan when today plan missing/empty
- `resolveChairDisplayItems`: pool → non-empty todayPlan → latestPlan

Write path `saveCurrentPlan` unchanged (empty current remains a valid run record).

## Verification

```text
node --test tests/opportunity-pool.test.mjs tests/today-desk-display.test.mjs tests/workbench-rollover.test.mjs
# 17/17 pass

npm run typecheck
# clean
```

Live DB probe `getToday('2026-08-07')` after fix:

- `plan.items = 0` (empty current run record kept)
- `latestPlan.items = 1` → AMD 收购 Taalas…
- `pool.length = 2` including AMD card + prior non-empty day item

## Pi operator Skill impact

no change — workbench/renderer projection only; no Pi prompt or tool surface change.

## Independent review

not required — test-only read-path fix with focused fixtures + live DB probe.
