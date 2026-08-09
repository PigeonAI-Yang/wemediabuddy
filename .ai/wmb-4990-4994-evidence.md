# WMB-4990–4994 Evidence — 今日情报控制鲁棒性 P0

Date: 2026-08-07  
Milestone: M-4990  
Design: `docs/spark/2026-08-07-daily-intelligence-control-robustness-design.md`

## Owner lock

- wall clock 30m auto partial (P1 WMB-4995)
- stall >10m auto partial (P1)
- cancel keeps ingested sources
- zombie primary CTA = 清理并保留结果
- start P0 immediately

## Delivered

### WMB-4990
- Design frozen; PLAN M-4990; ledger 4990–4998.
- Note: M-4980 was already Pi page-authority; control robustness is **M-4990** (not 4980).

### WMB-4991
- `agent:control-daily`: abort → sync partial/cancel; single-flight per `taskId:action`.
- Idempotent: `requestAgentTaskControl` / `partialAgentTask` / `cancelAgentTask` / `finishDailyIntelligenceFromReceipts` tolerate terminal re-entry.

### WMB-4992
- Today UI: `controlPending` disables buttons; await IPC; error surfaces; cancel copy clarifies sources kept.

### WMB-4993
- `abortDailyIntelligence`: abortTurn + stop + map delete.
- Synthesis catch: save_partial / already-terminal short-circuit.
- afterRun: if status ≠ running, return without overwrite.

### WMB-4994
- Zombie projection: heartbeat>600s or wall>1800s or `resume_pending` → headline + CTA「清理并保留结果」/「丢弃任务」.

## Verification

```text
node --test --test-concurrency=1 tests/agent-tasks.test.mjs tests/today-run-view.test.mjs
# 22/22 pass

npm run typecheck
# pass

node scripts/check-ledger.mjs
# pass
```

## Pi operator Skill impact

no change — control path is Owner UI + main runner; no Skill/tool surface change.

## Independent review

not required — test-only
