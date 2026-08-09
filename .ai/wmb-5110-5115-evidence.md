# WMB-5110–5115 Evidence — Desk manager + employee job pool (CAP-027)

Date: 2026-08-07  
Design: `docs/spark/2026-08-07-desk-manager-job-runtime.md`  
Designer: DeskSubagentDesigner (session)

## Product model

- **Desk（主对话 Pi）** = 经理席：编排/派单/盯单；desk lease 不占员工槽。
- **reporter/planner/writer/librarian** = 员工 subagent：工单（job）一次雇佣、独立 session 路径、角色过滤 grant（CAP-026）。
- **JobPool** `maxWorkers=2` FIFO；实体锁 `planDate:*` / `projectId:*`。
- 业务写仍经 CommandDispatcher；单一 `wmb.db`。

## Deliverables

| ID | 内容 |
| --- | --- |
| WMB-5111 | `job-pool.ts`；`workspace-runtime.ts` multi-lease Map；desk 独占 + employee 池 |
| WMB-5112 | `job-spawner.ts`：spawn→lease+task+grant+session 路径；默认 execute 骨架可注入 Pi |
| WMB-5113 | `ipc-jobs.ts` + preload + global types：`jobs:spawn/list/get/await/cancel/pool-status/set-max-workers` |
| WMB-5114 | Agents 页工单看板 + 派单 UI；今日 command bar「班组工单」chip → agents |
| WMB-5115 | 本证据 + 聚焦测试 |

## Verification (2026-08-07)

```text
node --test tests/job-pool.test.mjs tests/job-spawner.test.mjs tests/workspace-runtime.test.mjs
→ 27/27 pass

npx tsc --noEmit -p tsconfig.json
→ exit 0
```

Covered:

1. maxWorkers=2：第三工单 queued，释放后 FIFO 晋升  
2. multi-lease：desk 与 employee 并存；stopWorker 只停 desk  
3. spawner 双员工 succeeded；grant 含 workspaceId  
4. 同 planDate 预检 `JOB_LOCK_CONFLICT`  
5. desk 角色 `ROLE_NOT_SPAWNABLE`

## Capability registry impact

no change — CAP-026 复用；仅 grant wiring 带 roleId/workspaceId。

## Pi operator Skill impact

updated — Desk 可通过 IPC/UI 派员工工单；默认 execute 为可注入骨架（真 Pi 长跑可挂 `options.execute`）。斜杠命令 `/派单` 未绑 pi-commands（UI 派单已交付）。

## Independent review

not required — test-only + UI wiring.

## Residual / next

- 默认 `execute` 不拉起完整 Pi 子进程长跑；生产可把 `startDailyIntelligence` / studio runner 注入 JobSpawner。  
- `jobs.maxWorkers` 设置页持久化未做（IPC `jobs:set-max-workers` 有，进程内生效）。  
- 仍非五路无界并行；硬上限默认 2。

## Boundary / stress (2026-08-07)

```text
node --test tests/job-pool-stress.test.mjs tests/job-pool.test.mjs tests/job-spawner.test.mjs
→ 30/30 pass
```

Findings:
- Default maxWorkers=2; pool accepts 1..N; rejects 0/negative/float.
- Soft lease cap MAX_WORKER_LEASES=8 (includes desk).
- Burst maxWorkers=8 × 24 jobs: initially failed — complete-before-release raced into soft cap; fixed: release employee lease before pool.complete/fail promote.
- 200 FIFO drain max4: ~2ms; cancel churn 100 ok; planDate storm 10/10 CONFLICT; desk exclusive under load.
- Shrink maxWorkers does not kill running; only blocks new promote.

## Fix pass after stress (same day)

Root causes fixed:

1. **complete-before-release race** — `pool.complete` promoted next job while old employee lease still held → hit `MAX_WORKER_LEASES=8`. **Fix:** release lease before complete/fail.
2. **maxWorkers vs lease cap desync** — pool allowed maxWorkers up to unbounded while runtime hard-caps 8 total leases (desk+employees). **Fix:** `worker-limits.ts` shared constants; `maxWorkers` clamped to `MAX_EMPLOYEE_LEASES=7`.
3. **busy requeue spin** — requeue+immediate tryPromote while saturated caused OOM. **Fix:** on `WORKSPACE_BUSY`/软上限 fail-fast `JOB_SLOT_BUSY` (no spin); keep `JobPool.requeue` API for controlled use.

Verification:

```text
node --test tests/job-pool-stress.test.mjs tests/job-pool.test.mjs tests/job-spawner.test.mjs
→ 33/33 pass
tsc --noEmit → 0
```
