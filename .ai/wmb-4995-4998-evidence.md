# WMB-4995–4998 Evidence — 今日情报控制鲁棒性 P1/P2

Date: 2026-08-07  
Milestone: M-4990  
Design: `docs/spark/2026-08-07-daily-intelligence-control-robustness-design.md`  
P0 evidence: `.ai/wmb-4990-4994-evidence.md`

## WMB-4995
- Module `src/main/daily-control-policy.ts`: wall clock default 30m (`WMB_DAILY_WALL_MS`), stall default 10m on `progress.lastActivityAt` (`WMB_DAILY_STALL_MS`).
- Heartbeat in `startDailyIntelligence` applies watchdog → abort + `forcePartial` with `DAILY_WALL_CLOCK` / `DAILY_STALL`.
- Auto partial kill-switch: `WMB_DAILY_AUTO_PARTIAL=0`.

## WMB-4996
- `startDailyChannelRun` website/X scan loops check control_action + watchdog **before each source**; break on cancel/save_partial/auto-partial.

## WMB-4997
- `tests/daily-control-policy.test.mjs` wall/stall/off.
- Existing control idempotency tests.
- `tests/pi-runtime.test.mjs`: stop rejects hanging `promptUntilSettled`.

## WMB-4998
- Control audit event on `agent:control-daily` when `WMB_DAILY_CONTROL_AUDIT` enabled (default on): progress message `控制动作：… · owner_ui`.
- Env switches: `WMB_DAILY_AUTO_PARTIAL`, `WMB_DAILY_CONTROL_AUDIT`, wall/stall ms overrides.

## Verification

```text
node --test --test-concurrency=1 \
  tests/daily-control-policy.test.mjs \
  tests/agent-tasks.test.mjs \
  tests/today-run-view.test.mjs \
  tests/pi-runtime.test.mjs
# 32/32 pass

npm run typecheck
# pass

node scripts/check-ledger.mjs
# pass
```

## Pi operator Skill impact
no change — Owner UI/main runner/watchdog only.

## Independent review
not required — test-only
