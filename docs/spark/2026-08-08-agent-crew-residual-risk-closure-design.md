# WMB 智能体班组四项剩余风险收尾设计（WMB-5117..5122）

- Date: 2026-08-08（设计）/ 2026-08-09（定稿施工）
- Status: Owner lock 2026-08-08（§3）；供 WMB-5117..5122 合同与台账施工
- Route: Design。本任务只产出本文件；实现/台账/合同由后续任务施工。
- Related:
  - `docs/spark/2026-08-08-agent-crew-generic-runner-repair-design.md`（WMB-5116 canonical，本设计是其四项残余风险收尾）
  - `docs/spark/2026-08-07-desk-manager-job-runtime.md`（CAP-027 JobPool 运行时）
  - `docs/spark/2026-08-07-role-permission-design.md`（CAP-026 角色/注册表）
  - `docs/spark/2026-08-07-cap027-boundary-test-plan.md`（L0/L2 边界）
  - `.ai/wmb-5116-contract.md` / `.ai/wmb-5116-evidence.md`（WMB-5116 证据与 ReviewWmb5116 残余风险原文）

## 0. 一句话

**四名员工（记者/策划/写手/资料员）工单运行期的四项残余风险——scan/judge 并发读回竞态、running 取消不真终止 Pi、grant 终态不显式回收、librarian no-op 假阴性——按四条已锁方案收尾，拆 WMB-5117..5122 六任务施工，Capability registry 零改动，Pi operator Skill 仅 no-op 协议一处更新，一次性干净切换。**

## 1. 背景与证据

ReviewWmb5116 与四项调查（InvestigateScanJudgeRace / InvestigateHardCancellation / InvestigateGrantRevocation / InvestigateStructuredNoop，产出见 `agent://` 与 `local://` 证据）确认残余风险：

| # | 残余风险 | 证据 | 根因（一句话） |
|---|---|---|---|
| R1 | reporter 与 running daily_judge 同日并发 → `JOB_READBACK_MISSING` 伪失败；扫描完成读回被并发 judge rebind 顶掉 | `local://wmb5116-scan-judge-race-evidence.md`（临时 fixture 复现 2/2） | reporter 成功读回绑定在「当日共享 daily 任务的当前 phase」，可被并发 judge 改写（`daily-intelligence-channels.ts:112-126` 守卫把 judge 任务当扫描任务返回；`role-job-registry.ts:313-321 readbackScanPhase` 读当前 phase） |
| R2 | running 取消不真终止 Pi：writer 完全未接线（跑满 300s）；pre-bind 窗口漏杀 task；Pi 创建/fallback 窗口漏杀新实例 | `local://wmb5116-hard-cancel-evidence.md`（静态证据 + 行号） | `startStudioDraft` 不入 `activeDailyRuntimes`、无 abort 感知；`handle.taskId` 未绑定前 `cancel()` 空转；`job-spawner.ts:425 bindWorker(lease,{stop:async()=>{}})` stop 钩子为空操作 |
| R3 | grant 签发后无显式回收：终态后 `task_grants` 行保持 active 至 4h 过期，`wmb_list_task_grants` 误显示 | `local://wmb5116-grant-revocation-evidence.md` | 设计 §6 step 7「释放 grant」未实现；revoke 唯一调用点 = `ensureAutomaticTaskGrant` reissue（`task-grants.ts:249`） |
| R4 | librarian no-op 措辞假阴性：真实零变更但末条回复未命中正则 → 保守失败 | `local://wmb5116-noop-structured-signal.md` | `LIBRARIAN_NOOP_MARKERS`（`role-job-registry.ts:362`）只认自然语言措辞，机器不可校验 |

严重度：R2/R1 为功能缺陷（≤5s 门与并发正确性）；R3 为 LOW（终态后写已被 `requireRunningTask`（`task-grants.ts:357`）+ `isCurrentPiLease` 双重硬门拒绝，纯审计残留）；R4 为保守假阴性（不假成功，只误杀真 no-op）。

## 2. 目标 / 非目标

### 2.1 目标

1. R1：running judge 不再让 reporter 伪失败；reporter 扫描证据在返回瞬间快照，读回竞态归零；judge 终态触发晋升、60s 看门狗兜底。
2. R2：`JobExecuteContext` 建立单一 stoppable 注册协议；四角色 running cancel 真终止 Pi 子进程，取消总门 ≤5s；pre-bind / Pi 换实例窗口不再产生 pool 与 agent_task 双终态。
3. R3：grant 仅在 `agent_task` 终态幂等显式 revoke；复用 `task_grants.revoke` / receipt / operation audit；零迁移、零新命令。
4. R4：librarian no-op 仅接受末条 assistant 严格 fenced JSON `{"wmb_noop":true}`；删除自然语言 marker fallback；mutation receipt 永远优先。
5. 六任务可并行施工、独立验收；Capability registry no change；Pi Skill 仅 R4 输出协议一处更新；clean cutover。

### 2.2 非目标

- 不重做 daily pipeline（扫描/判定/水印/赛道门领域原语保持现状）。
- 不增加共享 planDate 锁（延续 WMB-5116 Owner lock #3：reporter 与 planner 不共享实体锁）。
- 不新增角色、不做可配置权限 UI、不新增命令/schema/表（`agent_tasks`/`task_grants`/`execution_grants` 结构零改动）。
- 不改人工发布边界（最终发布点击与硬删仍仅 Owner UI）。
- JobPool 不整体持久化（池内工单保持内存态，恢复沿用 `agent_tasks` interrupted 语义）。
- 不改 `agent-tasks.ts`（601 行已登记上限，终态语义不动）；不改 `mcp.ts`/`src/shared/*`。

## 3. Owner lock 2026-08-08（决策块，逐条锁定）

来源：Main Agent 2026-08-08 会话，用户明确实施指令——「出收尾方案、计入任务台账、设置 goal、实施完毕再汇报」；锁定的七点方案与以下分工为施工唯一依据，后续任务不得无明示改口偏离。

1. **scan/judge 不共享实体锁**；running judge 让 reporter 产生**瞬时 deferred**（不写 agent_task 终态），pool 泊车 `RESOURCE_JUDGE_IN_FLIGHT`（waiting_resource 车道），judge terminal 触发 rescan，60s watchdog 兜底；scan 返回时捕获**不可变 readback snapshot**。
2. **`JobExecuteContext` 建立单一 stoppable 注册协议**；abort 后注册立即 stop；cancel 顺序 = abort → Pi `abortTurn`+`stop`（≤2s）→ `agent_task` cancel → pool cancel → lease finally；**所有四角色接线**，取消总门 ≤5s。
3. **grant 只在 `agent_task` 终态幂等显式 revoke**，绝不按 job `channel_scanned` 终态回收（保护 scan→judge 交接复用）；复用 `task_grants.revoke` / audit，无迁移、无新命令。
4. **librarian no-op 仅接受末条 assistant 严格 fenced JSON `{"wmb_noop":true}`**；移除自然语言 marker fallback；mutation receipt 永远优先，JSON 不能伪造写入。
5. **Capability registry no change**；Pi Skill 仅 no-op 输出协议更新。
6. **clean cutover**，无 shim、无双轨。
7. **分工**：WMB-5117 transient controls foundation；WMB-5118 scan/judge；WMB-5119 hard cancel；WMB-5120 grant revoke；WMB-5121 structured no-op；WMB-5122 integrated tests/live/review/evidence。

Non-goals（§2.2 全部成立）：不重做 daily pipeline、不增加共享 planDate 锁、不新增角色/权限 UI/命令/schema、不改人工发布边界、不持久化 JobPool。

## 4. 跨任务不变量

### 4.1 Capability registry / Pi Skill

- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts` 六任务零改动；每任务验收跑 `npm run check:capabilities`（A1）+ librarian effective grant 一致性（A2：`page_library` ∩ librarian 角色能力 ∩ precise gate，`plans.save`/`content.*`/`reviews.save`/硬删/发布不可达）——任一失败即构建失败。
- Pi operator Skill：仅 WMB-5121 `updated`（§8.3 三处文本）；其余五任务 `no change`（理由：R1 是 waitReason 事件语义、R2 是系统层动作、R3 是会话后回收、R5/5117 是池内部机制——均非提示词语义），证据行按 `docs/pi-operation-skill-maintenance.md` 逐任务注明。

### 4.2 500 行上限策略（不提升 cap，优先拆分）

- 登记文件规则：`scripts/line-caps.json` 内文件**只降不升**；任务触碰登记文件时，在自身变更集内把该文件登记为变更后精确行数（不得高于历史登记值）。
- `src/main/job-spawner.ts`（登记 523，现 523）：**WMB-5117 一次性拆分**——`cancel()`（现 L267-313 ≈47 行）整体迁入新文件 `src/main/job-control.ts`，spawner 保留薄委托；`registerStoppable`/`stopResource` 类型与接线同批落地。拆分后净减少，5117 将 line-caps.json 登记为拆分后精确行数（< 523）；此后 5118（runJob deferred 分支 ≤3 行）/5119（0 行）以就地替换为原则，任何净增仍 ≤ 5117 登记值且 < 500。
- 已登记测试文件 `tests/daily-intelligence-channels.test.mjs`（604）**不得增长**：5118 新增复现用例放新文件 `tests/job-scan-judge-race.test.mjs`（无 cap），既有用例只作回归。
- 其余触碰文件均 < 500 且未登记（现计数）：`job-pool.ts` 339、`role-job-registry.ts` 376、`generic-employee-runner.ts` 223、`role-job-policies.ts` 250、`task-grants.ts` 367、`agent-task-commands.ts` 144、`daily-intelligence-channels.ts` 457、`workspace-intelligence.ts` 219、`pi-operator-skill.ts` 103、`manager-job-notify.ts` 209、`role-roster.ts` 176。若某任务触碰后超 500，先拆分既有业务模块到新文件（先例：`AllowMcpJobSplit` 为 `mcp.ts` 拆出 `mcp-job-tools.ts`），不得提升 cap。

### 4.3 新文件清单（六任务合计）

| 文件 | 创建任务 | 职责 |
|---|---|---|
| `src/main/job-control.ts` | 5117 | 工单运行期控制：`runCancellationSequence`（cancel 序列）+ `createStoppableRegistrar`（registerStoppable 单槽）+ 5118 增 `parkDeferred`（deferred 泊车路由） |
| `tests/job-scan-judge-race.test.mjs` | 5118 | R1 复现与回归（守卫 deferred + 快照 + 晋升） |

## 5. R1 scan/judge 竞态收尾（WMB-5118）

### 5.1 根因（两条交叉 + 一条边界）

- **交叉 A（没扫却失败）**：`daily-intelligence-channels.ts:112-126` 守卫命中 running judge（phase 匹配 `/judg|synth|validat|running_pi/`，如 `judging_opportunities`）→ 把 judge 任务静默当 reporter 扫描任务返回（`reused:true, shouldRunJudgment:false`）→ reporter 未扫描、零回执 → `assembleOutcome`→`readbackScanPhase` 读 judge 任务 phase=judging → null → `failed(JOB_READBACK_MISSING)`。
- **交叉 B（读回竞态）**：reporter 扫描完成（phase=channel_scanned）→ 并发 judge `getActiveDailyIntelligenceTask` 命中同一 daily_scan 任务并 rebind 推进 `judging_opportunities`（`agent-tasks.ts:97-101` 优先 daily_scan）→ reporter 读回读到 judging → null → 伪失败。守卫本意（防 source revision 被扫写顶掉判定）正确，但「推迟」被表达成「缺读回证据」。
- **交叉 C（防伪成功边界）**：judge 自建任务（judgeOnly 路径无扫描收据）——reporter 在任何情况下不得对其判定 succeeded。

### 5.2 决策：deferred + 不可变快照（两半组合）

**半 1（交叉 A/C）**：守卫命中不再静默返回 judge 任务，而是打 `deferred` 标记 → `DailyChannelRun.deferred` → `DailyIntelligenceRun` 透传 → `EmployeePolicyRun.deferred` → runner 产出**瞬时** `JobExecutionOutcome{status:'deferred', code:'SCAN_JUDGE_IN_FLIGHT', readback:null}` → `runJob` 在 `mapOutcomeToTerminal` **之前**识别 deferred：释放 lease + 实体锁 → `pool.park(jobId, 'RESOURCE_JUDGE_IN_FLIGHT', …)` → emit `job.waiting_resource` → 清理返回（**不写 agent_task 终态、不进五态映射**）。晋升后重跑，守卫不再命中 → 真实独立扫描。

**半 2（交叉 B）**：`runScanPolicy` 在 `startWorkspaceDailyIntelligence` resolve **返回瞬间**捕获扫描证据快照（`EmployeePolicyRun.readback = {kind:'scan_phase_reached', phase}`，仅当 phase ∈ {channel_scanned, succeeded+completed}），`assembleOutcome` 对 scan 读回**优先用快照**，缺快照才回落 `readbackScanPhase` 重读。快照不可变（一次性捕获、Object.freeze），judge 后续 rebind 无法改写。

### 5.3 状态机（R1 相关）

```
reporter job: queued → running → [守卫命中] → waiting_resource(RESOURCE_JUDGE_IN_FLIGHT) → running → succeeded(scan_phase_reached)
                    └────────────────── 取消 ──→ cancelled（无 agent_task，lease 已零）
planner job:  running(judging_opportunities) → 终态（succeeded/partial/needs_user/failed）→ pool settle → 触发晋升重扫
```
- `deferred` 是瞬时 outcome 变体，**不是** JobStatus、不是终态；pool 终态仍五态（`JobStatus` 不变）。
- `waiting_resource(RESOURCE_JUDGE_IN_FLIGHT)` 不占槽位、可取消、FIFO 公平（沿用 parked 车道 `submitSeq`）。

### 5.4 事件 / 晋升触发

| 事件 | 触发点 | 动作 |
|---|---|---|
| judge 工单 settle（主触发） | pool `recordTerminal → tryPromoteInternal(false)`；runner 先写 agent_task 终态再 settle（WMB-5116 §6 step 7 顺序） | judge-parked reporter 候选晋升 → runJob 守卫重查（judge task 已终态）→ 真实扫描，≤1s |
| 任意 pool 事件 | settle / complete / cancel / `releaseEntityLocks` | 重扫 parked 车道，守卫重查为权威 |
| 60s 看门狗（兜底） | spawner `watchdog`（`job-spawner.ts:135-136`）→ `pool.rescan()` | 覆盖非 pool 直调 judge（coordinator 直呼 `startDailyIntelligence`）终态不触发 pool 事件的情形，≤60s |
| 用户取消 parked | `cancel(jobId)` | waiting_resource → cancelled（复用 `pool.cancel` parked 分支） |
| reporter 重复 park | `park(jobId, RESOURCE_JUDGE_IN_FLIGHT)` 级联 | skip-self（同 lease-busy 模式），等待下一事件，不空转 |

### 5.5 接口类型变更

| 文件 | 符号 | 改动 |
|---|---|---|
| `src/main/role-job-registry.ts` | `JobExecutionOutcome`（L42-47） | status 联合加瞬时 `'deferred'`；`JOB_ERROR_CODES` 加 `SCAN_JUDGE_IN_FLIGHT`；`mapOutcomeToTerminal`（L260）签名不变（只收 `JobTerminalStatus`——deferred 传入为类型错误，编译期保证不误映射） |
| `src/main/daily-intelligence-channels.ts` | `DailyChannelRun` / `startDailyChannelRun` 守卫（L112-126） | 命中时 `deferred:{reason:'JUDGE_IN_FLIGHT', taskId: activeJudge.id}`；仍返回 judge task 引用（frozen/aggregation 供参考） |
| `src/main/workspace-intelligence.ts` | `DailyIntelligenceRun` / scanOnly 分支（L94-105） | 透传 `deferred` |
| `src/main/role-job-policies.ts` | `EmployeePolicyRun`（L50）/ `runScanPolicy`（L64） | 增只读 `deferred?`、`readback?`；resolve 后捕获快照 |
| `src/main/generic-employee-runner.ts` | `assembleOutcome`（L160）/ `readbackFor`（L192） | 首查 `run.deferred` → deferredOutcome（先于任务终态检查——judge 任务仍 running）；scan_phase 优先 `run.readback` 快照 |
| `src/main/job-pool.ts` | `RESOURCE_WAIT_CODES`（L63）/ `park`（L217）/ `nextCandidate`（L164） | 加 `RESOURCE_JUDGE_IN_FLIGHT`；park 第三码；skip-self 谓词扩展（lease-busy ∪ judge-in-flight） |
| `src/main/job-control.ts` | `parkDeferred`（5118 增） | 释放 lease/锁 → park + emit → 清理，返回「已处理」标志 |
| `src/main/job-spawner.ts` | `runJob`（L364，≤3 行就地） | execute resolve 后 `if (outcome.status==='deferred') return await parkDeferred(...)`——位于现有 releaseWorker/mapping 之前 |

### 5.6 取消竞态（R1）

- deferred 泊车中取消：`pool.cancel` parked 分支直接终态化 → cancelled，无 agent_task（从未创建/已释放）、lease 已归零（deferred 路径已释放）→ 复用 L0-3 取消矩阵加新 reason 分支。
- 晋升后再次守卫命中：re-park（skip-self），不产生错误终态，无死循环（每次只额外一次守卫重查）。
- 取消优先不变量保留：`signal.aborted` 置位后任何路径不得落 succeeded/failed/partial/needs_user（`mapOutcomeToTerminal` 首行 abort 判定不变）。

### 5.7 拒绝方案（调查原文 + 决策理由）

| 方案 | 拒绝理由 |
|---|---|
| 共享协调锁键（`daily:<ws>:<date>` 或恢复 planDate 锁） | 违反 Owner lock #3 与 WMB-5116 §8.1；串行化整条 scan→judge 管道，杀死并发意图 |
| 策略内持 lease 自旋等 judge | 等待期占槽占 lease（judge Pi 可跑 10min+），违背 waiting_resource 不占槽语义 |
| 读回改读任务 checkpoint（channelReceiptIds） | 多 channel 下第二 reporter 拿到 judge 任务后 checkpoint 含 channelA 收据 → 伪成功 |
| 删守卫放行并发扫描 | 回归 source revision 被扫写顶掉整轮判定的数据竞态 |

## 6. R2 硬取消收尾（WMB-5119）

### 6.1 根因（三个窗口）

| 窗口 | 现状 | 后果 |
|---|---|---|
| writer 全窗口 | `startStudioDraft`（`agent-runner.ts:781-859`）不入 `activeDailyRuntimes`、无 abort 监听、无 signal 传递 | 取消后 Pi 跑满 prompt 超时（300s），≤5s 门失败；`bindWorker(lease,{stop:no-op})`（`job-spawner.ts:425`）是「仅 lease 阻写非强杀」的代码级根因 |
| pre-bind 窗口 | `handle.taskId` 在 `onTaskBound` 前为 null，`cancel()` 的 `dispatchCancelAgentTask` 空转 | 任务继续 → mutation 照常提交 → agent_task succeeded / pool cancelled 双终态（WMB-5116 合同 §5.3 失效） |
| Pi 创建/fallback 窗口 | abort 在 `pi` 赋值前已触发（once 监听已消费） | 新 Pi 实例漏杀，跑满超时 |

兜底现状：Pi envelope 写路径被 `TASK_NOT_ACTIVE`/`WORKER_LEASE_STALE` 拦截（业务写入确实被阻），但进程不终止。

### 6.2 决策：单一 stoppable 注册协议

每工单至多一个活动 Pi；取消时优先硬停、先于 task 终态；注册时 signal 已 abort 立即停。复用 `PiRpcSupervisor.stop()`（`pi-runtime.ts:303-309`，内含 `stopProcessTree(child, 2_000)`，win32 `taskkill /T /F`），不建第二套 kill 注册表。

**取消序列（统一）**，取消总门 ≤5s：

```
1. handle.abort.abort()                     —— cancel-first 标志（幂等，重复 cancel 返回当前终态）
2. await handle.stopResource?.()            —— Pi abortTurn（若 active）+ stop() → stopProcessTree ≤2s
3. await abortDailyIntelligence(taskId)     —— 非 job 直呼 daily 的兜底（保留）
4. await dispatchCancelAgentTask(taskId)    —— task 仍 running 可取消；scheduler actor 旁路 grant 门；
                                              cancelAgentTask INVALID_STATE 守卫防双终态（agent-tasks.ts:349-353）≤1s
5. pool.cancel + job.cancelled 事件         —— MINOR 3 去重（before?.status !== 'cancelled'）
6. lease 释放                               —— runJob finally（幂等）；cancel() 内不再提前释放
7. grant                                   —— 不显式 revoke（R3 由 WMB-5120 在 agent_task 终态统一回收）
8. 会话保留 job-<jobId>.jsonl；workDir 由策略 finally 收尾（现状保留）
```

预算：2s 强停 + 1s task 终态 + 池操作 ≈ 3s < 5s；prompt 超时（300s/600s）仅在 stop 失败时兜底，不再依赖。

### 6.3 接口类型变更

| 文件 | 符号 | 改动 |
|---|---|---|
| `src/main/job-control.ts`（5117 建） | `runCancellationSequence` / `createStoppableRegistrar` | 5117 提取 cancel 语义并含 step 2（`handle.stopResource?.()` 现为可空）；5119 无需再改 spawner |
| `src/main/job-spawner.ts` | `JobExecuteContext`（L57）+ `InternalHandle`（L76）+ runJob ctx 组装 | +`registerStoppable?: (stop:()=>Promise<void>)=>void`；+`stopResource: (()=>Promise<void>)\|null`；`registerStoppable: createStoppableRegistrar(handle)`（5117 一次性落地） |
| `src/main/role-job-policies.ts` | `EmployeePolicyContext`（L35）/ 四策略 | +`registerStoppable`；`runScanPolicy`/`runJudgePolicy` 传 `onRuntime:(rt)=>ctx.registerStoppable(()=>rt.stop())`（`IntelligenceInput.onRuntime` 已存在，`agent-runner.ts`/`workspace-intelligence.ts` 零改动）；`runDraftPolicy` 同（`startStudioDraft` onRuntime L783）；`runOrganizePolicy`（L156）在 `pi=startedRuntime.runtime`（L228）与 `onRuntimeChanged`（L233）内注册；保留现有 onAbort（活跃 turn 内 abortTurn 更优雅） |
| `src/main/generic-employee-runner.ts` | `onTaskReady`（L93）/ runner 主函数 | 开头 `if (aborted(ctx.signal)) throw {code:JOB_ERROR_CODES.JOB_CANCELLED}`（关 pre-bind 窗口）；aborted 分支 `bestEffortCancelTask` 从 organize-only 扩展到全部角色（`cancelAgentTask` INVALID_STATE 守卫保无双终态） |
| `src/main/pi-runtime.ts` | — | 复用，零改动 |

`createStoppableRegistrar` 语义：单槽覆盖；注册时 `signal.aborted` 已置位 → 同步立即调用 stop（关 Pi 晚创建窗口）；重复注册覆盖旧槽。

### 6.4 竞态关闭表

| 竞态 | 关闭机制 |
|---|---|
| writer 取消不终止 | onRuntime → registerStoppable；stopResource 强杀 ≤2s |
| pre-bind 双终态 | onTaskReady abort 检查抛 JOB_CANCELLED → 策略 catch 链 → bestEffortCancelTask（全角色）→ agent_task cancelled |
| Pi 换实例漏杀 | 注册时已 abort 立即 stop；onRuntimeChanged 重注册覆盖 |
| cancel 后 late outcome | `mapOutcomeToTerminal` 取消优先 + settle no-op + MINOR 3 去重（保留现状双守卫） |
| 重复 cancel | 幂等：abort 幂等、pool.cancel 返回当前终态、事件不重复 |

## 7. R3 grant 终态显式 revoke（WMB-5120）

### 7.1 现状与严重度

- 终态后写已被三层独立拦截：`requireRunningTask`（任务非 running → `TASK_NOT_ACTIVE`）、`releaseWorker` 后 `isCurrentPiLease` false（`WORKER_LEASE_STALE`）、`ensureAutomaticTaskGrant` 复用只匹配 running。**无实际越权写路径**（LOW）。
- 残留面：`task_grants` 行保持 `status='active'` 至 4h 过期（`AUTOMATIC_TASK_GRANT_EXPIRY_MS`，`task-grants.ts:202`）；`listTaskGrants`/MCP `task_grants.get|list`（`mcp-task-grants.ts`，只读）投影 active → `wmb_list_task_grants` 对终态任务误显示「有效授权」。

### 7.2 触发点约束（关键）

- **绝不按 job 终态回收**：reporter 工单可 `succeeded`（scan_phase_reached）而 agent_task 仍 `running` 于 `channel_scanned`（`workspace-intelligence.ts:101`），judgeOnly 后续复用同一 running 任务与同一 grant 交接（`daily-intelligence-channels.ts:138-152`）；job 终态 revoke 会打断交接（`TASK_GRANT_REVOKED`）。
- **唯一触发点 = agent_task 终态**：该任务全部使用者已终结（写包已被 requireRunningTask 拦截），回收零破坏。

### 7.3 接口

| 文件 | 符号 | 改动 |
|---|---|---|
| `src/main/task-grants.ts` | `dispatchRevokeTaskGrantsForTask(runtime, {requestId, taskId})`（新增） | 复用 `TASK_GRANT_REVOKE_COMMAND`（L11）；actor `{type:'scheduler', id:'task-grant-reaper'}`（旁路 grant 门，同 owner_ui/scheduler 管理模式）；`boundIdentity:{taskId}`；handler：`UPDATE task_grants SET status='revoked', revoked_at=?, revision=revision+1 WHERE task_id=? AND runtime_epoch=? AND status='active'`——原子幂等（重复 0 行），读回剩余 active → receipt data=已撤销列表（重复=[]）；不要求 expectedRevision（任务终态=无并发写者）；保留 receipt + operation audit |
| `src/main/agent-task-commands.ts` | `dispatchTask`（L36）钩子 | `execute` 成功且 `isRuntime(dependency)` 且 command ∈ 终态集 `{agent_tasks.cancel, fail, needs_user, partial, finish_daily, complete}` → best-effort 调上述 revoke（try/catch 吞错，绝不破坏终态写；entityId 即 taskId） |

覆盖面：GenericEmployeeRunner（librarian `writeAgentTaskTerminal`）、JobSpawner.cancel（`dispatchCancelAgentTask`）、daily/studio 领域原语、desk 流程——全部 task 终态路径单点覆盖。**不需要改动**：`command-dispatcher.ts`、`workspace-runtime.ts`、`job-spawner.ts`、`generic-employee-runner.ts`、`mcp-task-grants.ts`。

### 7.4 job / task / grant 生命周期

```
job running ──(runner)──> agent_task running + grant active
   │                            │
   ├─ reporter succeeded        └─ channel_scanned（任务仍 running，grant 保持 active → judge 交接复用）
   │     （job 终态，task 未终态 → 不回收）      │ judge 完成
   │                                            ▼
   └─ 任一角色任务终态 ──> dispatchTask 终态钩子 ──> 幂等 revoke（status='revoked', revoked_at）
                              │
                              └─ 4h 过期兜底（中断/崩溃残留行；无迁移，可选 backfill 不做）
```

- 迁移：无 schema 变更（migration v41 CHECK 已含 `revoked`，`revoked_at`/`revision` 已存在）。
- 遗留残留行：4h 自过期或下个 runtime 转 stale；一次性 backfill 明确不做（最小变更）。

## 8. R4 librarian 结构化 no-op（WMB-5121）

### 8.1 根因

`readbackLibraryMutation`（`role-job-registry.ts:369-393`）零收据时用 `LIBRARIAN_NOOP_MARKERS`（L362）匹配末条 assistant 文本；措辞未命中（如「无需处理」的「处理」不在词典）、末条只总结未复述、模型忽略提示词约定 → 真实零变更也被保守判 `JOB_READBACK_MISSING`。

### 8.2 决策（严格协议，删除回退）

- 复用既有 ```` ```json ```` 围栏 + zod 输出协议（`agent-runner.ts` `parseLaneGateOutput`/`parseDailyPlanOutput` 同款惯例）。
- **仅接受**末条 assistant 文本的**最后一个** ```` ```json ```` 块声明 `{"wmb_noop":true}`（zod `z.literal(true)` 严格校验，允许附加键如 scope）。
- **移除 `LIBRARIAN_NOOP_MARKERS` 正则回退**（Owner lock #4；一次性删除面搜索作为迁移收口证据，不建 CI grep 门禁）。
- **mutation receipt 永远优先**：收据 ≥1 → `sources_mutated`（围栏被忽略——agent 又写又声明 noop 时 mutation 赢）。
- 失败策略：缺围栏/围栏非法（JSON 坏、`wmb_noop:false`、键错、非末条）→ null → `JOB_READBACK_MISSING`（保守失败保留，绝不放宽为假成功）；会话文件缺失且无内存文本 → null。

### 8.3 接口

| 文件 | 符号 | 改动 |
|---|---|---|
| `src/main/role-job-registry.ts` | `noopDeclarationSchema` / `parseNoopDeclaration(lastText): boolean`（新增）；`readbackLibraryMutation`（L369，+`finalText?: string\|null`）；删除 `LIBRARIAN_NOOP_MARKERS`（L362） | 末条最后围栏 → JSON.parse → schema.safeParse；读回顺序：收据 ≥1 → sources_mutated；零收据 → `finalText ?? lastAssistantText(读文件)` → parseNoopDeclaration → noop_confirmed；否则 null |
| `src/main/role-job-policies.ts` | `EmployeePolicyRun`（+`finalAssistantText?: string\|null`）；`runOrganizePolicy`（L236-238 现丢弃 `promptUntilSettled` 返回值） | 捕获 `result.text` 存入返回；`libraryOrganizePrompt`（L125）第 3/4 点加「末条回复必须附 ```` ```json {"wmb_noop": true} ```` 确认块；声明 wmb_noop 后不得执行任何写操作」 |
| `src/main/generic-employee-runner.ts` | `readbackFor`（L192）`library_mutation` 分支 | 传 `run.finalAssistantText` |
| `src/main/pi-operator-skill.ts` | `PI_AUTHORITY_SYSTEM_PROMPT`（L12） | librarian no-op 回报升级：「无可整理内容时必须回报 no-op 确认——末条回复附 ```` ```json {"wmb_noop": true} ```` 确认块」 |
| `skills/wemedia-buddy-operator/SKILL.md` | 「资料与今日方案」段 | 加一行围栏要求（canonical operator Skill，依 `docs/pi-operation-skill-maintenance.md` 更新规程） |

### 8.4 防伪造论证

- 围栏是**输出侧文本协议**：零新命令、零新工具、零新 grant 路径（不进 `agent-capabilities.ts`/`AUTOMATIC_TASK_GRANT_SCOPES`）。
- `sources_mutated` 只认 dispatcher 写出的 `command_receipts`（grant/lease/envelope/role 过滤后由机器写）——**伪造 mutation 不可能**。
- 围栏唯一解释 = noop_confirmed，且被「零收据前置」门控：伪造围栏最多得到 no-op，永远得不到 mutation。
- no-op 只证明「本轮请求零变更」（收据窗口 = sinceIso 起），不证明资料库全局无变更。

## 9. 任务分解 WMB-5117..5122

依赖与波次：`5117 ← 5116`；`5118 ← 5117`；`5119 ← 5118`（与 5118 共享 policies/runner，符号不相交，可在 5118 同波）；`5120 ← 5117`（文件不相交，可与 5118 并行）；`5121 ← 5118`（与 5118 共享 registry/policies，串行）；`5122 ← {5118,5119,5120,5121}`。
波次 1：5117；波次 2：5118 + 5120（并行）；波次 3：5119 + 5121（并行）；波次 4：5122。

| 任务 | 内容 | 依赖 |
|---|---|---|
| **WMB-5117** | transient controls foundation：pool `RESOURCE_JUDGE_IN_FLIGHT` 三码 + skip-self；`JobExecutionOutcome` 瞬时 deferred 变体（类型）；`job-control.ts` 抽取 cancel 序列 + stoppable 注册协议；job-spawner 拆分与 line-caps 登记 | WMB-5116 |
| **WMB-5118** | scan/judge：守卫 deferred + 透传；scan 快照捕获；assembleOutcome deferred/快照路由；`parkDeferred`；runJob 就地分支；晋升/看门狗验证 | WMB-5117 |
| **WMB-5119** | hard cancel：四角色 registerStoppable 接线；onTaskReady abort 门；bestEffortCancelTask 全角色；取消序列与 ≤5s 预算测试 | WMB-5118 |
| **WMB-5120** | grant revoke：`dispatchRevokeTaskGrantsForTask` + `dispatchTask` 终态钩子 + 幂等/交接回归测试 | WMB-5117 |
| **WMB-5121** | structured no-op：fenced JSON 协议 + 删正则回退 + 三处提示词 + 测试矩阵 | WMB-5118 |
| **WMB-5122** | integrated：聚焦套件 + typecheck + check:capabilities + lightweight check + 隔离实机验收 + 独立复审 + 证据包 + ledger | 5118/5119/5120/5121 |

### 9.1 Allowed paths（逐任务）

- **5117**：`src/main/job-pool.ts`（RESOURCE_WAIT_CODES/park/nextCandidate）、`src/main/role-job-registry.ts`（deferred 类型 + JOB_ERROR_CODES 码）、`src/main/job-control.ts`（新增）、`src/main/job-spawner.ts`（cancel 抽取 + registerStoppable 接线）、`scripts/line-caps.json`（只降登记）、`tests/job-pool.test.mjs`、`tests/job-spawner.test.mjs`、`.ai/wmb-5117-*`
- **5118**：`src/main/daily-intelligence-channels.ts`、`src/main/workspace-intelligence.ts`、`src/main/role-job-policies.ts`、`src/main/role-job-registry.ts`、`src/main/generic-employee-runner.ts`、`src/main/job-control.ts`、`src/main/job-spawner.ts`（≤3 行就地）、`tests/job-scan-judge-race.test.mjs`（新增）、`tests/job-l2-integration.test.mjs`、`tests/job-pool.test.mjs`、`.ai/wmb-5118-*`
- **5119**：`src/main/job-control.ts`、`src/main/role-job-policies.ts`、`src/main/generic-employee-runner.ts`、`tests/job-spawner.test.mjs`、`tests/job-l2-integration.test.mjs`、`.ai/wmb-5119-*`
- **5120**：`src/main/task-grants.ts`、`src/main/agent-task-commands.ts`、`tests/job-l2-integration.test.mjs`、`tests/command-dispatcher.test.mjs`、`.ai/wmb-5120-*`
- **5121**：`src/main/role-job-registry.ts`、`src/main/role-job-policies.ts`、`src/main/generic-employee-runner.ts`、`src/main/pi-operator-skill.ts`、`skills/wemedia-buddy-operator/SKILL.md`、`tests/job-pool.test.mjs`、`tests/job-l2-integration.test.mjs`、`tests/pi-extension.test.mjs`、`.ai/wmb-5121-*`
- **5122**：§10 测试文件、`tests/job-scan-judge-race.test.mjs`、`.ai/wmb-5117-5122-evidence.md`、`TASKS.md`（ledger 六行）、`scripts/line-caps.json`（最终复核登记）

**Forbidden（全部任务）**：`PRODUCT.md`/`PRD.md`/`SPEC.md`/`TECHNICAL_DESIGN.md`；`src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`；`src/main/agent-tasks.ts`、`src/main/mcp.ts`；发布类/硬删路径；`package.json`/`package-lock.json`/`node_modules`；真实 data root。

### 9.2 Acceptance（逐任务，可证伪）

- **5117**：RESOURCE_WAIT_CODES 含第三码且 park 接受三码；judge-park 工单自身泊车级联不原地拉起（skip-self）；`JobExecutionOutcome.status` 含 `'deferred'` 且不在 `JobTerminalStatus`、deferred 传 `mapOutcomeToTerminal` 为类型错误；`runCancellationSequence` 与原 cancel() 行为等价（queued/waiting/running 三态取消、重复取消幂等、MINOR 3 去重）；job-spawner 行数 < 523 且 line-caps.json 同步登记；tests/job-pool + job-spawner 全绿。
- **5118**：守卫命中 → `run.deferred` 为真且零 source 回执（复现用例由红转绿）；running judge 下 spawn reporter → `waiting_resource`（waitReason 含 SCAN_JUDGE_IN_FLIGHT）非 failed；释放 judge ≤1s 晋升 → 真实扫描 → succeeded(scan_phase_reached)；channel_scanned 快照在 judge rebind 推进 phase 后仍判定成功；deferred 不写 agent_task 终态、lease/锁归零；泊车中取消 → cancelled 无 agent_task；交叉 C 仍 defer（无伪成功）；L0-6 读回规则与 job-pool-stress 锁矩阵不回归。
- **5119**：四角色 running cancel ≤5s（Pi 进程树终止、pool cancelled、agent_task cancelled、lease 归零）；writer 取消不再跑满 300s；registerStoppable 单槽覆盖 + 已 abort 注册立即 stop；pre-bind 窗口取消 → agent_task cancelled（非 succeeded）且无取消后 mutation；cancel 后 late outcome 仍 cancelled、`job.cancelled` 事件计数 =1。
- **5120**：终态后 `listTaskGrants` 无 active（row revoked、revoked_at 非空）；带旧 grantId envelope → `TASK_GRANT_REVOKED`（或 `TASK_NOT_ACTIVE`）拒绝；重复回收幂等（第二次 ok data=[]）；channel_scanned（saved>0）时 grant 仍 active（交接不误回收）；`check:capabilities` pass。
- **5121**：末条最后围栏 `{"wmb_noop":true}`（含附加键）→ noop_confirmed；围栏非法/非末条 → null（JOB_READBACK_MISSING）；`LIBRARIAN_NOOP_MARKERS` 全仓库删除且无调用方；收据 ≥1 → sources_mutated（围栏被忽略）；finalText 内存路径免读文件；三处提示词含 `wmb_noop` 围栏指令；存量无围栏 no-op 会话 → 保守 failed。
- **5122**：§10 全 focused 套件绿 + typecheck 0 + `check:capabilities` pass + `scripts/check.ps1` lightweight pass；§11 实机验收全项通过；独立复审结论 approved；`.ai/wmb-5117-5122-evidence.md` 落盘；TASKS.md 六行 done（含 Pi Skill impact 证据行）。

## 10. 测试矩阵（L0/L1/A/E 分层，沿用 node:test + 临时 DB 模式）

| # | 用例 | 文件 | 断言 |
|---|---|---|---|
| T-01 | 三码 park + skip-self（锁冲突/lease 忙/judge in flight 各自泊车不再原地拉起） | job-pool.test.mjs | parked 状态、waitReason 前缀、FIFO 序 |
| T-02 | cancel 抽取后三态取消回归 + 幂等 + 事件去重 | job-spawner.test.mjs | 复用 L0-3/L0-5 断言全绿 |
| T-03 | 守卫命中 deferred（预置 running judge phase=judging_opportunities） | job-scan-judge-race.test.mjs（复现） | `run.deferred` 真、零回执（现红） |
| T-04 | judge running → reporter waiting_resource(SCAN_JUDGE_IN_FLIGHT)；释放 ≤1s 晋升 → 真实扫描 succeeded | job-l2-integration.test.mjs | 非 failed；读回 scan_phase_reached |
| T-05 | channel_scanned 快照 vs judge rebind 推进 phase | job-scan-judge-race.test.mjs | 快照仍成功；无快照回落 readbackScanPhase 兜底 |
| T-06 | deferred 泊车取消 → cancelled、无 agent_task、lease 归零 | job-l2-integration.test.mjs | L0-3 模式 + 新 reason 分支 |
| T-07 | 交叉 C：judge 自建任务无收据仍 defer | job-scan-judge-race.test.mjs | 不 succeeded |
| T-08 | running cancel 调 stopResource 恰一次 | job-spawner.test.mjs | spy.callCount=1；pool cancelled；lease=0 |
| T-09 | pre-bind 取消：onTaskReady gate 挂起 → cancel → 抛 JOB_CANCELLED → agent_task cancelled | job-l2-integration.test.mjs | 非 succeeded；无业务读回 |
| T-10 | registerStoppable 时 signal 已 aborted → 立即 stop | job-spawner.test.mjs | stop 在注册返回前被调 |
| T-11 | 四角色 running cancel（writer/planner/librarian stub stoppable；reporter 无 stop 注册） | job-l2-integration.test.mjs | pool/task cancelled + stop 被调 |
| T-12 | 双终态：cancel 后 late failed outcome → 仍 cancelled、事件不重复 | job-spawner.test.mjs | job.cancelled=1 |
| T-13 | 慢 stopResource（>2s）→ cancel 仍 ≤5s | job-spawner.test.mjs | 计时断言 |
| T-14 | 终态后 listTaskGrants 无 active；row revoked | job-l2-integration.test.mjs | T1（grant 调查） |
| T-15 | 终态后旧 grantId envelope 拒绝 | command-dispatcher.test.mjs | TASK_GRANT_REVOKED / TASK_NOT_ACTIVE |
| T-16 | 重复回收幂等；cancel 路径回收 | job-l2-integration.test.mjs | 第二次 ok data=[]；T3/T4 |
| T-17 | channel_scanned 不误回收（交接回归） | job-l2-integration.test.mjs | T5：grant 仍 active |
| T-18 | 围栏 noop / 附加键 / 非法 / 非末条 / finalText 免读文件 / 正则回退删除 | job-pool.test.mjs（readback 块扩展） | 矩阵 1-8（noop 调查） |
| T-19 | 围栏 + 收据 ≥1 → sources_mutated（mutation 赢） | job-pool.test.mjs | 矩阵 7 |
| T-20 | 提示词契约：libraryOrganizePrompt / PI_AUTHORITY_SYSTEM_PROMPT 含 wmb_noop | job-l2-integration + pi-extension.test.mjs | L2-10 追加 + 矩阵 11 |
| A1 | `npm run check:capabilities` | — | registry no change |
| A2 | librarian effective grant 一致性（排除清单不可达） | — | §4.1 |
| E-1..E-7 | 隔离实机（§11） | 隔离 data root | 逐项 |

## 11. 实机验收脚本（5122，隔离 data root，不碰真实数据）

先例：`.ai/wmb-5110-l3-e0-probe.mjs`、`node scripts/smoke-renderer.mjs`（地址 `http://127.0.0.1:27391`）。

1. **E-0 冒烟**：`node scripts/smoke-renderer.mjs` → 页面身份 WeMediaBuddy（`<title>` + `#root`）。
2. **E-1 四角色并发成功**：经 `wmb_spawn_job`/`jobs:spawn` 派 reporter+writer+librarian 同 businessDate → 终态 JOB_EVENT 携带 report：`scan_phase_reached` / `content_version` / `sources_mutated|noop_confirmed` 业务读回可见（复用 WMB-5116 实机证据模式）。
3. **E-2 R1 实机**：先派 planner（judge 桩保持 running）→ 派 reporter → 断言 `waiting_resource(SCAN_JUDGE_IN_FLIGHT)` 且 desk 收到「等资源」JOB_EVENT；释放 judge → ≤1s 晋升 → reporter succeeded(scan_phase_reached)；watchdog 路径用非 pool judge 验证（≤60s）。
4. **E-3 R2 实机**：四角色各一次 running cancel → ≤5s 落 cancelled；Pi 进程树退出（任务管理器/taskkill 观察）；lease 归零；agent_task cancelled；writer 取消后无后续 mutation。
5. **E-4 R3 实机**：任一任务终态后 `wmb_list_task_grants` → 该 taskId 无 active（revoked）；带旧 grantId 的 envelope 实机写 → 拒绝；channel_scanned 交接场景 grant 保持 active。
6. **E-5 R4 实机**：librarian 空整理任务（无可整理内容）→ 会话末条附 `{"wmb_noop":true}` 围栏 → succeeded(noop_confirmed)；删除围栏重跑 → failed(JOB_READBACK_MISSING)（保守失败）。
7. **E-6 回归**：`node --test tests/job-pool.test.mjs tests/job-spawner.test.mjs tests/job-l2-integration.test.mjs tests/job-scan-judge-race.test.mjs tests/command-dispatcher.test.mjs tests/pi-extension.test.mjs` + `npm run typecheck` + `npm run check:capabilities` + `powershell -ExecutionPolicy Bypass -File scripts/check.ps1`（lightweight）。
8. **E-7 收尾**：独立复审（reviewer）关闭全部 finding；`.ai/wmb-5117-5122-evidence.md` 记录 E-0..E-6 实测输出；TASKS.md 六行 done 回执（含 `Pi operator Skill impact: no change|updated` 逐任务证据行）。

## 12. 回滚 / 失败策略

| 风险 | 缓解 |
|---|---|
| deferred 永久泊车（晋升事件丢失） | 三通道：judge settle 级联 + 任意 pool 事件重扫 + 60s 看门狗（§5.4）；T-04/T-06 覆盖 |
| deferred 误伤正常扫描（守卫漏判/误判） | 守卫仅命中 running + phase 正则（现状条件）；deferred 仍携带 judge task 引用供审计；交叉 C 测试钉死 |
| 快照伪成功 | 快照只在 policy 返回瞬间、phase ∈ {channel_scanned, succeeded+completed} 时捕获；无快照回落 DB 重读；T-05 双向断言 |
| 取消序列遗漏窗口 | stopResource 单槽覆盖 + 已 abort 立即 stop + onTaskReady 门 + 全角色 bestEffortCancelTask；T-08..T-13 矩阵 |
| revoke 误伤交接 | 触发点唯一=agent_task 终态；T-17 交接回归；actor=scheduler 旁路门设计保证终态后写已不可达 |
| no-op 协议误伤存量会话 | 存量无围栏会话保守 failed（不假成功）；提示词先行上线（libraryOrganizePrompt + PI_AUTHORITY_SYSTEM_PROMPT + SKILL.md 同变更集） |
| 500 行/cap 破坏 | §4.2 规则：先拆分后增长；5117 一次性拆分 job-spawner；line-caps 只降登记；5122 复核 |
| 任务间文件冲突 | 依赖表 + 波次划分（§9）；5119 与 5118、5121 与 5118 共享文件但符号不相交，边界按 §5.5/§6.3/§8.3 path:symbol 表执行 |

**回滚**：每任务为独立变更集；5118/5119/5120/5121 各自 revert 即回到 5117 基线；5117 revert = 恢复 job-spawner.cancel 原实现 + line-caps 还原 523。全链回滚顺序 5122→5121→5120→5119→5118→5117，任一步以 A1/A2 + 聚焦套件为回归基线；无双轨窗口（R4 正则删除为一次性变更集，不做行为回退开关）。

## 13. 文档路线

- 本设计为 WMB-5117..5122 施工唯一依据；合同（`.ai/wmb-5117-contract.md` …）与 TASKS 六行由 Main 按 §3/§9 生成。
- 完成后更新：`docs/pi-operation-skill-maintenance.md` 影响表对应行（no-op 输出协议）；TECHNICAL_DESIGN 仅在 5122 确认行为契约稳定后按需补充（不在六任务 Allowed paths 内，另行登记）。
