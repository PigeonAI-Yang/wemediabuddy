# WMB-5119 Evidence — 四角色硬取消收尾（R2）

- 日期：2026-08-09
- 设计：docs/spark/2026-08-08-agent-crew-residual-risk-closure-design.md §6（Owner lock #2）
- 依赖：WMB-5117（job-control.ts 抽取 cancel 序列 + createStoppableRegistrar）已就位；WMB-5118（deferred/泊车）已就位

## 变更（仅 Allowed paths）

| 文件 | 符号 | 改动 |
|---|---|---|
| src/main/role-job-policies.ts | `EmployeePolicyContext.registerStoppable`（新增字段）、`runScanPolicy` / `runJudgePolicy` / `runDraftPolicy` | 原语 `onRuntime` 接线：`(rt) => ctx.registerStoppable(() => rt.stop())`（workspace-intelligence / agent-runner 已支持 onRuntime，零改动） |
| src/main/role-job-policies.ts | `runOrganizePolicy`（新增 `registerPiStop`） | `pi = startedRuntime.runtime` 后与 `onRuntimeChanged` 内注册（abortTurn+stop 同 onAbort 语义；闭包读可变 pi 变量；single slot last wins）；onAbort 监听保留 |
| src/main/generic-employee-runner.ts | `onTaskReady`（pre-bind abort 门） | 开头 `createdTaskId = taskId` 后 `if (aborted(ctx.signal)) throw JOB_CANCELLED`——拒绝 bind/grant，由 catch 链 bestEffortCancelTask 收尾（关 pre-bind 窗口） |
| src/main/generic-employee-runner.ts | runner 主函数 aborted 两分支 | `bestEffortCancelTask` 从 organize-only 扩展为全角色（`createdTaskId` 非空即尽力取消；cancelAgentTask INVALID_STATE 守卫保无双终态） |
| src/main/generic-employee-runner.ts | `policyContext` 组装 | 传 `registerStoppable: ctx.registerStoppable ?? (() => {})`（自定义 execute 缺省 no-op） |
| tests/job-l2-integration.test.mjs | `T-09`、`T-11`（追加，行 611/676） | pre-bind 取消；四角色 running cancel（writer/planner/librarian stub stoppable；reporter 无 stop 注册） |
| tests/job-spawner.test.mjs | `T-12`（追加，行 611） | cancel 后 late failed outcome 仍 cancelled + job.cancelled 事件 =1 |

未改：src/main/job-control.ts / job-spawner.ts（5117 已建，取消序列与单槽注册协议原样复用）；agent-tasks.ts（终态定义零改动）；src/shared/*；Capability registry；Pi Skill。

## 验收对照

- 四角色 running cancel ≤5s（Pi 进程树终止 ≤2s、pool cancelled、agent_task cancelled、lease 归零）：T-11（四角色并发 cancel 实测 <5s 计时断言；stop 恰一次；task cancelled；lease=0）
- writer 取消不再跑满 300s（startStudioDraft 经 onRuntime → registerStoppable）：runDraftPolicy `onRuntime` 接线；T-11 writer 分支 stop 被调
- registerStoppable 单槽覆盖 + 已 abort 注册同步立即 stop：5117 既有 `T-10` / `registerStoppable last registration wins` 回归（未改动）
- pre-bind 窗口取消 → 抛 JOB_CANCELLED → agent_task cancelled（非 succeeded）且无取消后 mutation：T-09（门挂起 → cancel → task cancelled、零 source 回执、事件=1）
- cancel 后 late outcome 仍 cancelled、job.cancelled 事件计数 =1：T-12（late failed outcome 不改写终态、不产生 job.failed、事件恰一次）；T-02 重复取消幂等回归
- 取消序列：abort → stopResource（≤2s 有界）→ lease → daily 兜底 → task cancel → pool.cancel（MINOR 3 去重）——job-control.ts 原样（5117 验收已绿），5119 不改动

## 协调（与 WMB-5121 共享文件）

- role-job-policies.ts：5119 只动 `EmployeePolicyContext.registerStoppable` / 四策略 onRuntime 接线 / `registerPiStop`（WMB-5119 §6.3 注释标记）；5121 的 `EmployeePolicyRun.finalAssistantText` / `runOrganizePolicy` finalAssistantText 捕获 / `libraryOrganizePrompt` 围栏文本已保留未动（同函数不同区域）。
- generic-employee-runner.ts：5119 只动 `onTaskReady` 开头 / aborted 两分支 / policyContext；5121 的 `readbackFor` library_mutation 分支（传 finalAssistantText）保留未动。
- tests/job-l2-integration.test.mjs：5119 仅在文件末尾 L2-17 之后追加 T-09/T-11；5121 的 L2-10 函数体内改动不受影响（双方已通过 hub 声明并确认）。

## 重开修复（Main 实机验收：planner cancel 双终态 partial）

实机证据：runCancellationSequence 先 stopResource → planner domain abort 异常 forcePartial 抢先提交 → 后续 dispatchCancelAgentTask INVALID_STATE 无法覆盖 → agent_task partial + pool cancelled 双终态；writer 同类在 cancelled/failed 间轮动；reporter cancel 后仍落 1 条 saved_count=0 通道回执。

根因：域对 job abort 信号不可见，Pi 强停触发的异常路径在任务取消落盘前抢先写终态/回执。

修复（三层，全在 Allowed paths，保持 §6.2 序列整体顺序——终态 cancelled 仍由 Pi 停后落盘）：

| 文件 | 符号 | 改动 |
|---|---|---|
| src/main/job-control.ts | `runCancellationSequence`（marker 前置） | abort 后、stopResource 前 `dispatchRequestAgentTaskControl(taskId,'cancel')`——非终态取消请求标记（幂等、异常吞并）；daily 域 abort 路径（cancelIfRequested/stopScanIfControlled）据此转 cancelled 而非 forcePartial（确定性、可测） |
| src/main/generic-employee-runner.ts | `onAbortCancel` abort 门（全角色） | abort 一触发即 bestEffortCancelTask(createdTaskId)——终态 cancelled 先于 Pi 强停落盘；域异常路径见任务已终态即跳过 forcePartial/forceFail；取消后 mutation（扫描回执等）被 TASK_NOT_ACTIVE 拦截；finally 移除监听 |
| src/main/role-job-policies.ts | `runOrganizePolicy` catch | `ctx.signal.aborted` 时走 bestEffortCancelTask 而非 dispatchFailAgentTask（runner abort 门兜底） |

验收对照（重开）：
- 新增测试 `WMB-5119 planner cancel race`（l2）：stub daily 域 stop 时按真实语义检查 controlAction——'cancel' → cancel，否则 forcePartial。**旧实现（无 marker）实测 fail：actual 'partial'，与实机证据一致**；修复后 pass。全角色 agent_task 终态 cancelled、lease 归零、job.cancelled 事件 =1。
- reporter 取消后回执：任务在 abort 即 cancelled → 在飞 commitWebsiteScan/recordAttemptFailure 经 dispatcher TASK_NOT_ACTIVE 门拒绝（无取消后 mutation 落库）。
- coordinator 非 pool judge lease：`manager-orchestration.ts` finally 在域返回时释放 lease（不在 5119 Allowed paths，未改动）；若域因 Pi 死未返回而残留 lease，属该路径既有行为，已记录待 5122 实机复核。

## 验证状态（重开）

- 实测：`--test-name-pattern="T-09|T-11|T-12|planner cancel race"` → 4/4 pass（T-09 449ms、T-11 542ms、T-12 433ms、race 454ms）
- 旧实现失败证明：临时禁用 marker 后 race 测试 actual='partial' 失败（还原后 pass）
- 语法/加载：node --check 两测试文件 pass；job-control.ts + role-job-policies.ts 模块加载 OK
- 待主 Agent：typecheck + check:capabilities + 其余聚焦套件

## 无回归面

- 未改：job-control.ts、job-spawner.ts、agent-tasks.ts、mcp.ts、src/shared/*、agent-runner.ts、workspace-intelligence.ts、daily-intelligence-channels.ts、pi-runtime.ts
- 无新增共享 planDate 锁、无自旋、无双轨；registerStoppable 复用既有 PiRpcSupervisor.stop（内含 stopProcessTree ≤2s）
- reporter scanOnly 无 Pi → 不注册 stop（T-11 断言 `ctx.stopResource === null`）；取消走 abort + agent_task cancel
