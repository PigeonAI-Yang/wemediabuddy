# WMB-5118 Evidence — scan/judge 并发读回竞态收尾（R1）

- 日期：2026-08-09
- 设计：docs/spark/2026-08-08-agent-crew-residual-risk-closure-design.md §5（Owner lock #1）
- 依赖：WMB-5117（pool 第三泊车码 / deferred 类型 / cancel 抽取 / 看门狗）已就位

## 变更（仅 Allowed paths）

| 文件 | 符号 | 改动 |
|---|---|---|
| src/main/role-job-registry.ts | `DeferredSignal`（新增类型）、`snapshotScanReadback`（新增，Object.freeze 快照）、`readbackScanPhase`（改委托 snapshotScanReadback，语义不变） | deferred 信号契约 + 快照派生；mapOutcomeToTerminal 对 deferred 拒收（5117 已落，T-07 验证） |
| src/main/daily-intelligence-channels.ts | `DailyChannelRun.deferred`、守卫命中分支 | 守卫不再把 judge 任务静默当扫描任务返回（交叉 A/C）→ 打 `{reason:'JUDGE_IN_FLIGHT', taskId}` |
| src/main/workspace-intelligence.ts | `WorkspaceDailyIntelligenceRun`（= DailyIntelligenceRun & {deferred?}）、scanOnly 两分支 | 透传 deferred；不触碰 agent-runner.ts（禁改） |
| src/main/role-job-policies.ts | `EmployeePolicyRun.deferred?/readback?`、`runScanPolicy`（async） | resolve 返回瞬间 `snapshotScanReadback(run.task)` 捕获不可变快照 |
| src/main/generic-employee-runner.ts | `assembleOutcome`（deferred 首查）、`readbackFor`（scan 优先 `run.readback ?? readbackScanPhase`） | 瞬时 deferred outcome（先于任务终态检查）；快照优先、重读兜底 |
| src/main/job-control.ts | `parkDeferred` + `ParkDeferredDeps`（新增） | 释放 lease → pool.park(RESOURCE_JUDGE_IN_FLIGHT) → emit waiting_resource → 返回已处理标志 |
| src/main/job-spawner.ts | `runJob` deferred 分支（2 行就地） | outcome deferred → parkDeferred 后直接返回；不写 agent_task 终态、不进五态映射 |
| scripts/line-caps.json | job-spawner.ts 488 → 486 | 只降登记（486 为变更后精确行数） |
| tests/job-scan-judge-race.test.mjs | 新增（无 cap） | T-01..T-09 复现与回归 |

## 验收对照

- 守卫命中 → run.deferred 为真且零 source 回执：T-01（红转绿：旧代码 deferred=undefined）
- running judge 下 spawn reporter → waiting_resource（RESOURCE_JUDGE_IN_FLIGHT / SCAN_JUDGE_IN_FLIGHT）非 failed：T-04
- judge settle ≤1s 事件触发晋升 → 真实扫描 → succeeded(scan_phase_reached)：T-05（pool settle 同步晋升；60s 看门狗兜底为 5117 既有 rescan）
- channel_scanned 快照在 judge rebind 后仍判定成功（无快照回落重读）：T-08 / T-09
- deferred 不写 agent_task 终态、lease/实体锁归零：T-04
- 泊车中取消 → cancelled 且无 agent_task：T-06
- 交叉 C（judge 自建任务带自身回执）仍 defer 无伪成功：T-03
- deferred 无法进五态：T-07（mapOutcomeToTerminal 拒收；abort 优先不变量保留）
- L0-6 读回规则 / job-pool-stress 锁矩阵：job-pool.ts 未改动；readbackScanPhase 语义等价重构

## 验证（2026-08-09）

- `node --test --test-concurrency=1 tests/job-scan-judge-race.test.mjs`：9/9 pass（T-01..T-09）
- 回归 `tests/job-pool.test.mjs`：16/16；`tests/job-spawner.test.mjs`：16/16
- `tests/daily-intelligence-channels.test.mjs` 加载失败为既有工作树状态（非本任务引入）：
  mcp.ts 未提交变更新增 manager-orchestration → manager-dispatch → ipc-pi-dock.ts → 无后缀
  `'./pi-conversation'`（HEAD 已存在该无后缀 import，但 HEAD mcp.ts 不经过此链）；
  ipc-pi-dock.ts / mcp.ts 均不在 5118 Allowed paths，未改动，已上报 Main 归属主修。

## 无回归面

- 未改：agent-runner.ts、agent-tasks.ts、mcp.ts、src/shared/*、Capability registry、Pi Skill（R1 为 waitReason 事件语义）
- 无新增共享 planDate 锁、无自旋、无伪成功路径；deferred 为瞬时 outcome 变体，非 JobStatus
- 与 WMB-5120 已协调：本任务不触碰 tests/job-l2-integration.test.mjs（5120 独占 L2-12..16）
