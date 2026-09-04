# Today「继续更新选题」与自动编排隔离：对抗性审计

日期：2026-08-29  
对象：`docs/spark/2026-08-29-today-continuation-orchestration-remediation-plan.md`  
审计类型：两路独立只读审计（产品状态机；并发与归属）

## 1. 审计结论

### 初审：BLOCKED

两路审计均独立返回 `BLOCKED`，没有 P0，但发现 3 个产品状态机 P1、5 个并发/归属 P1，以及若干 P2。初审期间没有修改代码、测试、台账或业务数据。

初审不能放行的原因不是整改方向错误，而是 v2 仍把关键决定留在“实现时再决定”：planner 成功不等于有可批准方案；重复操作没有明确 attempt/generation；job 归属字段没有从 spawn 贯通到持久读回；同日单 Manager 约束与双 orchestration 隔离互相冲突；scheduler 和 research 恢复仅有进程内或状态字符串语义。

### v3 回填状态：复审仍 BLOCKED

上述初审意见已回填整改方案 v3；v4 再次由两路独立复审，仍为 `BLOCKED / NOT_READY`。v4 新发现已回填方案 v5，等待第三轮独立复审。只有复审无 P0/P1 未决项，才允许写入 `TASKS.md`。

### v4 复审 Findings（P0=0，P1 未清）

1. 跨 runtime epoch 回放仍先被 `WORKSPACE_STALE` 拒绝；旧 input hash 混入 epoch/lease/grant，logical identity 与执行授权没有真正拆开。
2. `agent_tasks` 仍按 intent+businessDate 复用，和同日多 Manager 冲突；`agent-tasks.ts` 又被 Manager/research 两个并发任务共同依赖，缺少唯一前置 owner。
3. Stage D 的 `operationRequestId` 与 `effectRequestId` 未成为请求、持久化和校验中的两个正式字段。
4. Projection 仍声明未实现的 hardRejected 分类，可能把 invalid 伪装为合法 clean-empty。
5. `retry_scan` 只有 UI 动作，没有旧 judge 终态、新 root identity 和 supersedes 转移。
6. managed job 归属字段仍未从 MCP schema 贯通到 JobPool、boundary、agent task、event 和 Manager readback。
7. Manager、orchestration ID 和 settlement 仍按日期生成/覆盖；同日 owner 与 scheduler 可能共享 identity。
8. Stage D 仍查询全库 approved、依赖进程内 Map，且 `command_receipts` 没有 `(workspace,stageRequestId)` 唯一、lease、epoch、fencing 所需 schema。
9. overlap barrier 没有可执行的 ready/release receipt、PID/build/epoch 读回。
10. research 先按 intent+businessDate 复用、再检查 parent，requestId 仍随机；启动只恢复 latest daily task，其他 stale daily/research 会永久悬挂。
11. Manager 入口异常会继续 legacy pipeline，ownership/contract 错误仍可能回退成新 scan。

### v5 回填裁决

方案 v5 已据此：新增 `daily_stage_claims` 迁移与 CAS/fencing 合同；把 logical/execution hash 和 managed task selector 拆为共享前置任务；正式分离 operation/effect identity；删除 hardRejected；冻结 retry_scan 的 superseding root；补齐 orchestration/settlement identity、数据库 barrier、全量 stale reconcile 和 managed error fail-closed。v5 未经再次独立复审，当前仍不得入台账或实施。

### v8 最终复审：仍 BLOCKED

两路只读复审均以“合同是否足以实施”为标准，未把旧源码尚未实现当作 blocker。P0=0，仍发现：首次 scan identity 依赖未来快照；PlanScope 零候选无权威持久行；Manager/root checkpoint 无 fenced CAS；普通 managed job 无 reserve-before-spawn 崩溃边界；Stage D stageRequest/claim key 冲突；barrier 单消费无法让两侧都 dispatch；research 缺 claim scope/startup gate；daily producers 未封闭纳管；错误矩阵和任务文件 ownership 不完整。

### v9 回填状态：待最终复审

方案 v9 已新增并冻结：RootCreate/DailyStage/StageD/Research 四类入口；scan/full unbound→snapshot_frozen 两阶段绑定；`daily_plan_scopes` 空集合持久化；完整 reason/action 矩阵；Manager/root revision+epoch+lease CAS；retry invocation ordinal；`managed_job_dispatches` reserve-before-spawn；producer allowlist；barrier 双侧独立 consume；research claim kind 与 startup reconciliation gate；共享 API 和具体测试文件 ownership。最终复审通过前仍不写台账、不改业务代码。

### v9 复审：仍 BLOCKED；v10 已回填

v9 仍有 hash 自引用与字段落点矛盾：StageD request 自含 operationRequestId；scan binding 改变 operation hash；root retry 字段未进入固定 schema；普通 child 缺 canonical unique key；startup reconciler 未枚举 active claim；barrier ready slot 可被覆盖；ResearchAttempt/gap identity、workspace cycle 边界、startup reason 和 22 项验收引用不完整。

v10 已拆分 immutable operation identity 与 SnapshotBinding；冻结无派生字段的 StageD/Research preimage；固定 root/Manager 实体列和 retry canonical input；新增普通 childIdentityKey 唯一约束；startup gate 使用 fenced 表并 union 枚举 task/claim/job/root；barrier ready first-writer-wins；cycle/target 加 workspace；补齐 error matrix 和 1–22 验收引用。v10 待最终复审，未放行前仍不入台账。

### v10 复审：仍 BLOCKED；v11 已回填

v10 仍残留旧公式/作用域：root 唯一键漏 source；continuation preimage 漏 modules/watermark/predecessor binding；Stage D 有第二套 hash；research active scope 含 stageRequestId；startup gate 按 runtimeEpoch 唯一且只扫 lease 过期 root；workspace cycle 消费者清单不全。

v11 已固定 ScanAttemptPreimage/JudgeAttemptPreimage 及共享派生函数，废止 Stage D 第二公式；root generation/CAS 域加入 source；research active scope 改为 workspace+parent+gap；startup gate 改为每 workspace 单行跨 epoch 接管且枚举全部非终态 root；补齐全部 workspace 消费者 owner 与 1–27 失败验收。v11 待最终复审。

### v11 复审：仍 BLOCKED；v12 已回填

v11 仅余：claim schema 仍残留旧 research scope；daily active scope 含 stageRequestId 不能限制同 generation；claim 无 revision；research manifest 缺 parentStage/gap；startup gate 未规定每次新 epoch 重置；cycle migration/zhihu scoring owner 漏列。

v12 以单一最终 claim schema 覆盖旧定义，daily scope 固定四元组、research scope 固定 workspace+parent+gap，并加 claimRevision；manifest 保存完整父阶段/gap/preimage；每次新 runtimeEpoch 强制 CAS 进入 pending 后重跑；WMB-5369 纳入 cycle migration 和 scoring；验收扩为 1–32。v12 待最终复审。

### v12 复审：仍 BLOCKED；v13 已回填

v12 余项：daily scope 含 generation 可双活；claim 缺 root identity/active SQL；research 迁移 winner 未 rekey；settlement 未带 claimRevision；target/effect hash 仍是无字段边界字符串。

v13 最终 claim schema 增加 root identity、isActive、claimRevision 和明确状态集合/partial unique index；daily scope 去 generation，research winner 同事务 rekey；settlement CAS 加 expectedClaimRevision；target/effect identity 改为 versioned canonical object；验收扩为 1–37。v13 待放行复审。

### v13 复审：仍 BLOCKED；v14 已清理

v13 架构合同已闭合，但全文还残留三套旧公式：target/effect 字符串拼接、缺 retry 字段的旧 root preimage、带 ownerEpoch 的 barrier ready ID。v14 已删除这些旧公式，只保留共享 versioned canonical object 派生，并新增静态检索/跨 epoch 重放验收 38–40。v14 待放行复审。

### v5 独立复审结论：BLOCKED（P0=0，P1=6）

两路独立只读复审均针对同一 v5 快照返回 `BLOCKED / NOT_READY`：产品状态机路线发现 `PlanScope` 未定义且错误码到终态/CTA 未闭合；并发与归属路线发现 operation identity 定义冲突、rootGeneration 无原子分配、Stage D 跨 generation 可并存、settlement 缺 fenced CAS。复审期间未修改源码、测试、台账或业务数据。详细 finding、反例、责任文件和负例验收见本文 §5；这些意见已回填整改方案 v6，必须再次复审后才可入台账。

## 2. 初审 Findings

### 产品状态机路线

#### P1-SM-01：planner 成功可能伪装成 `waiting_human`

- 证据：旧实现只看 child 状态，`src/main/manager-dispatch.ts:401`、`:486`；现有 `tests/today-run-view.test.mjs:199` 曾接受 `hasTodayPlan=true + opportunityCount=0`。
- 反例：planner 进程成功退出但没有写入条目，或所有条目仍为 `scoring_pending/proposal_incomplete`；Manager 仍进入待批准状态，Owner 没有可批准对象。
- 修订：方案 v3 §3.2.1 固定 `TodayRecommendationProjection` schema 和转移矩阵。`waiting_human` 只允许 `eligiblePlanItemIds.length > 0`；pending/invalid 为 `partial`；可信零候选为 `succeeded + emptyQualified=true`。

#### P1-SM-02：幂等与显式重试没有分离

- 证据：旧 `manager-dispatch.ts:267`、`src/main/agent-runner.ts:737` 生成随机 requestId；旧 focused test 只检索提示词，不做双击/重启读回。
- 反例：第一次 judge 已派发但 root 尚未持久化时双击，两个随机 requestId 创建两个 child；或者失败后复用同一 requestId，永久读回旧失败而不能合法重试。
- 修订：方案 v3 §3.2.2 固定 `ContinuationIdentity`、canonical JSON hash、`command_receipts` SSOT、`retryGeneration` 和 `REQUEST_REPLAY_CONFLICT`。同 generation 重放必须返回同一 attempt，只有 Owner 明确重试才 generation+1。

#### P1-SM-03：超时、handoff 和空态缺少可执行收敛责任

- 证据：旧 `manager-task.ts:37` checkpoint 没有 requestedStage/deadline/attempt；`src/main/manager-task.ts:127` 把 waiting/running 都视为活动；旧 dispatch 在 planner 恢复时存在 phase 写入不一致。
- 反例：judge 被接受但 planner child 未创建，Manager 永久卡在 `running/dispatch_planner`，再次点击又被串行门聚焦旧任务。
- 修订：方案 v3 §3.2、§3.2.1 固定 deadline、reasonCode、终态矩阵和 watchdog；每个阶段必须在超时、派工失败、空候选、Pi 无响应时进入可读终态或明确动作。

#### P2-SM-01：机会数有两个可能权威来源

- 证据：旧方案允许 Today Projection“或”current plan；旧 `src/main/manager-dispatch.ts:179` 使用 child 成功数。
- 修订：v3 §3.2.1/§3.5 指定唯一 `readTodayRecommendationProjection` 和 eligible ID 集合，UI、Manager、数据库验收比较集合而非 count。

#### P2-SM-02：安装验收不应强制合法数据必有一条

- 证据：旧验收把 planner 至少产出一条与 judge 增量绑定，未拆分 clean-empty 和重复重放。
- 修订：v3 §3.2.1、§6.2 明确真实候选、合法 clean-empty、invalid/pending 三分支；首次 judge 增量=1、同 generation 重放增量=0、显式重试才新增 attempt。

### 并发与归属路线

#### P1-CA-01：spawn→job→agent task→Manager 的归属字段没有真实贯通

- 证据：`src/main/mcp-job-tools.ts:100-145`、`src/main/role-job-registry.ts:98-103`、`src/main/job-pool.ts:27-59`、`src/main/job-object-boundary.ts:91-125` 旧接口未接收/持久化完整的 managerTaskId、orchestrationId、parentTaskId、requestedStage；旧测试还固化了无归属字段 payload。
- 反例：即使同步函数要求强校验，job 事件和 agent task 也没有字段证明自己属于哪个 Manager，最终只能按日期误写。
- 修订：v3 §3.3 明确 MCP schema、RoleJob、JobPool、boundary、agent task context、event/report 和 readback 的单一 owner 及逐段字段测试；缺字段只能 orphan/audit，零回写。

#### P1-CA-02：同日单 Manager 与隔离模型矛盾

- 证据：旧 `src/main/manager-task.ts:118-138` 按 `(intent, businessDate)` 找唯一活动 Manager；旧 `src/main/manager-dispatch.ts:442` 只按日期同步；方案同时要求用户流程和 scheduler 完全隔离。
- 反例：scheduler 建第二个 Manager 违反旧唯一约束；不建第二个 Manager 又无法做到 root/checkpoint/children 隔离。
- 修订：v3 §3.3 明确选择“同日多 orchestration、每个 orchestration 一个 Manager”，把唯一键改为 `(businessDate, orchestrationId)`，scheduler/owner 写入不同 source，删除日期 fallback，并处理历史按日期活动记录。

#### P1-CA-03：Stage D 没有冻结集合的可追溯身份

- 证据：旧 `src/main/daily-orchestration.ts:271-304` 查询全库 `planning_status='approved'`；旧测试只覆盖同进程冷重试，不覆盖运行中 target 漂移。
- 反例：Stage D 启动时 target=A，运行中 A 被 skip、B 被选中；重试可能改派 B，无法证明本次处理集合。
- 修订：v3 §3.4 固定 `cycleId/cycleRevision/targetIds/planItemIds/targetRevisions/targetSetHash` 的一次性 snapshot；缺绑定直接 `CURRENT_TARGET_BINDING_MISSING`，无 target `NO_CURRENT_TARGETS`，不反查全库。

#### P1-CA-04：scheduler 去重只存在于进程内

- 证据：旧 `src/main/daily-orchestration.ts:388-409` 使用模块 `Map<string, Promise>`；旧 `daily-orchestration-scheduler.ts:46,72` 只有 timer；现有并发测试只共享同一进程 Promise。
- 反例：进程 A 在 Stage C 后崩溃，进程 B 重启 Map 为空；或两个安装版实例同时触发，均派出 D。
- 修订：v3 §3.4 将 scheduler 纳入 WMB-5368 owner，要求 `command_receipts` 持久 CAS claim、owner epoch、崩溃接管、双连接竞争测试和已完成 cycle 重放测试。

#### P1-CA-05：research `resume_pending` 不是恢复或终结

- 证据：旧 `src/main/agent-tasks.ts:440` 只把 running 改为 resume_pending；启动接线 `src/main/index.ts:408` 没有随后的恢复派工；旧 `research-job-runtime.ts:301` 使用随机 requestId，`:309-320` 的 parent/job context 不完整。
- 反例：应用重启后旧任务停在 resume_pending，因没有新 research spawn 永久悬挂；后续任务又按 `(intent,businessDate)` 错复用。
- 修订：v3 §3.6 要求启动前执行 `reconcileStaleResearchTasks()`，以 CAS claim 校验原 parent/orchestration、快照、session、deadline；可恢复则原 identity 重建，不可恢复则原位 failed/partial 并写 `finished_at`。

#### P2-CA-01：安装版重叠实验不可重复

- 证据：旧方案要求同一 time window，但没有 barrier、可控 scheduler 触发、起止事件或 causation 快照定义。
- 修订：v3 §3.4、§6.2 要求以两个 root 的持久 `orchestration_started`/claim 事件作为 barrier，读回起止区间和完整 causation IDs，禁止仅以日志时间接近判定重叠。

#### P2-CA-02：现有 focused tests 的绿灯不代表新合同成立

- 证据：独立审计运行 Manager/job/orchestration/research focused tests 共 51 项通过，但旧测试覆盖的是旧 payload、进程内 Promise 和 `resume_pending` 字符串。
- 修订：v3 §5/§6 要求先红后绿的负例覆盖归属、双 scheduler、cycle 漂移、重启 stale research、投影终态和重放语义。

## 3. 复审门

复审必须由两条独立路线重新读取当前版本方案和当前源码，不引用对方中间结论。放行条件：

1. 产品状态机路线无 P0/P1 未决项；
2. 并发与归属路线无 P0/P1 未决项；
3. 每个复审 finding 都有“已回填章节 + 负例验收 + 责任文件”；
4. 复审通过前 `TASKS.md` 不写入 WMB-5365..WMB-5371。

## 4. 实际初审证据

- 产品状态机审计线程：`01a04b2a-d6c2-7192-adac-3099b27d4ac1`，结论 `BLOCKED`。
- 并发/归属审计线程：`01a04b2b-469c-7a33-998d-a5e4e7a3092c`，结论 `BLOCKED`。
- 两路均只读；没有修改工作区、数据库、台账或提交。
- 共同执行过的 focused 命令：`node --test tests/manager-orchestration.test.mjs tests/pi-manager-job-payload.test.mjs tests/wmb-5337-orchestration.test.mjs tests/wmb-5171-research-storage.test.mjs tests/wmb-5172-research-runner.test.mjs`，结果 51 pass，但不能替代新合同的负例验收。

## 5. v5 复审 Findings（两路独立）

### 产品状态机路线（`01a04b40-5293-7fa1-8391-02f50e4f231f`）

#### P1-SM-04：`PlanScope` 未定义，日期级投影仍可串单

- 证据：v5 要求 `readTodayRecommendationProjection(businessDate, planScope)`，但未定义 `planScope` 的类型、来源、冻结内容或归属校验；当前 `workbench.ts:305` 的投影按日期构建。
- 反例：Owner judge 无产出，而同日 scheduler 产生 eligible；Owner Manager 读到日期级投影并错误进入 `waiting_human`，机会数和主推荐来自 scheduler。
- 回填：方案 §3.2.1、§3.3、§3.5、§6.2；固定 `PlanScope`、scopeHash、显式 carry/allowed ID 集合，projection 只读冻结 ID。责任文件：`today-recommendation.ts`、`workbench.ts`、`manager-dispatch.ts`；新增同日双 root projection 隔离负例。

#### P1-SM-05：错误码—终态—CTA 合同不闭合

- 证据：v5 只映射 `NO_CONTINUATION_MATERIAL`、`SOURCE_SNAPSHOT_STALE`，未固定 timeout、handoff、scope/ownership、replay conflict、stale resume、cancelled 的操作/Manager 终态、重试动作和 CTA。
- 反例：`SCAN_HANDOFF_EXPIRED` 可被实现成“继续评分”或“重新侦察”；`REQUEST_REPLAY_CONFLICT` 被当成普通重试会循环冲突；`MANAGER_STALL` 的 partial/failed 判定无合同。
- 回填：方案 §3.2、§3.7、§5、§6；固定 reasonCode 矩阵、action 枚举、CTA、generation/root 和 scan/judge 增量，明确 cancelled 的回收/fencing。责任文件：Manager dispatch、Today/proposals UI、preload/types 和 focused tests。

### 并发与归属路线（`01a04b40-7124-77f2-bdbe-a40d2e6cb071`）

#### P1-CA-06：`operationRequestId` 定义冲突

- 证据：v5 §3.2.2/§3.3 定义 `operationRequestId=requestId`，但 Stage D 条目仍写成 `requestId/stageRequestId`。
- 反例：Spawner 传 `stageRequestId`、Manager 保存 `requestId`；正确 orchestration 的 job event 也会因 identity 不一致被拒绝或无法同步。
- 回填：方案 §3.3、§3.4 明确 `operationRequestId === requestId`，`stageRequestId` 只能独立表示 attempt；不等时 `MANAGER_OPERATION_IDENTITY_MISMATCH` 零写，并加入逐段字段测试。

#### P1-CA-07：rootGeneration 没有持久原子分配

- 证据：v5 要求 orchestration ID 包含 `rootGeneration`，却未规定 rootGeneration 持久表、CAS、唯一索引或重放规则；当前创建路径先查后建并使用随机 requestId，`manager-task.ts:118` 仍只按日期选择。
- 反例：两个 scheduler 连接同时观察无 root，各自创建 generation 0，或在无显式重试时生成 generation 1，破坏同 orchestration 唯一 Manager。
- 回填：方案 §3.2.2、§3.3、§3.4；新增 `daily_orchestration_roots` 和 `BEGIN IMMEDIATE`/唯一键/稳定 root request 规则，补双连接、tick/triggerNow 竞争负例。

#### P1-CA-08：Stage D 跨 generation 可并存

- 证据：v5 只约束同一 cycle/generation 一个 lease，同时允许 target 集合变化创建 generation+1，未要求 generation N 先终态/fence。
- 反例：generation 0 冻结 target A 后，generation 1 因 revision/集合变化并存；`effectRequestId` 包含 revision，A 可能被重复派 reporter/writer。
- 回填：方案 §3.4；同一 workspace/cycle 跨 generation 单活 claim，generation+1 只能在前代终态、lease 失效且显式授权后创建；补跨代竞争负例。

#### P1-CA-09：settlement 无 fenced CAS 和终态单调性

- 证据：v5 规定 settlement 唯一键和 token 携带，但未规定写入比较 `ownerEpoch/leaseToken` 或禁止旧 owner 覆盖终态；现有 `daily-orchestration.ts:411-417` 直接 update/insert。
- 反例：A lease 过期后 B 接管并成功；A 恢复后以旧 token 写 partial 覆盖 B 的 settlement，UI/DB 读回倒退。
- 回填：方案 §3.4、§6.2；settlement 写入必须 fenced CAS，终态后仅幂等读回，迟到写只进 audit 且零业务写；补旧 owner 迟到写负例。

## 6. v6 复审状态

v6 已将 §5 的六项 P1 回填为 `PlanScope`、完整错误矩阵、root 表/CAS、operation identity、跨 generation 单活规则和 settlement fenced CAS。两路 v6 复审均仍为 `BLOCKED / NOT_READY`，结论保持不变，`TASKS.md` 不得写入本合同任务。

### v6 复审 Findings（P0=0，P1 未清）

#### 产品状态机路线

1. **P1-SM-05：PlanScope 虽已出现，但隔离条件仍需逐项落到实现验收。** 若 projection 仍按日期/current plan 扩展集合，两个同日 orchestration 会互相看到 eligible/pending。反例是 A 冻结 item-A、B 冻结 item-B，任一方按日期读回两项；机会数与终态同时污染。责任：`today-recommendation.ts`、`workbench.ts`、`manager-dispatch.ts`。要求：scope identity、allowed IDs、scopeHash 不匹配时零写，并有同日双 scope 负例。

2. **P1-SM-06：`NO_CURRENT_TARGETS` 与 planner clean-empty 仍可能被一张错误码表合并。** Stage D 无 target 只能是 stage-level skipped；如果 Planner PlanScope 有 eligible，Manager 必须是 `waiting_human`；只有自身 Projection candidate=0 且回执全可信才可 `NO_ELIGIBLE_OPPORTUNITY/emptyQualified`。责任：`daily-orchestration.ts`、`manager-dispatch.ts`、Today readback/UI。要求：三分支（Stage D 无 target、Planner 有 eligible、Planner 合法空）逐一读回。

3. **P1-SM-07：`INVALID_NEEDS_REPAIR` 缺少修复后的正式转移。** 只有提交匹配 receipt 后 Owner 显式 `retry_judge` 才能同 root generation+1，scan=0/judge=1；自动续派会把修复动作与评分混为一体。责任：`plan-item-approval.ts`、`today-run-view.ts`、`manager-dispatch.ts`。

4. **P1-SM-08：ContinuationIdentity 缺 parentTaskId 会允许同 parent 之外的任务碰撞。** 逻辑 hash 必须包含持久 parent identity，root attempt 为 null，child/research attempt 必须可读回；缺失时零写。责任：`agent-tasks.ts`、`research-job-runtime.ts`、identity tests。

#### 并发与归属路线

5. **P1-CA-10：`daily_stage_claims` 仍缺明确 cycle/claim scope 与跨 generation active 唯一实现。** 仅写 stageRequestId 唯一不能阻止 generation N 与 N+1 同时 active。责任：WMB-5366 的 migration/claim store；要求 `(workspace,claim_scope_key)` active 唯一、CAS/fencing 和双连接竞争负例。

6. **P1-CA-11：rootGeneration 的 canonical 输入、持久 root 表和 migration owner 未闭合。** 若各业务任务自行 max+1，tick/triggerNow 仍可产生不同 root。责任唯一归 WMB-5366；WMB-5369 只能消费 root API。要求并发首次 root 读回同一 rootGeneration/orchestrationId。

7. **P1-CA-12：Stage D settlement 没有可验证的状态序列与终态单调写入合同。** 旧 owner 迟到写必须 CAS 失败、只记 audit、业务零写；terminal 后不得回退或被不同 hash 重写。责任：`daily-orchestration.ts`、claim/settlement store。

8. **P1-CA-13：ResearchResumeManifest 的字段、存储、hash 和原子边界未固定。** 只保存 `resume_pending` 仍可在重启后丢 parent/cwd/session，造成永久悬挂。责任：WMB-5370，复用 WMB-5366 claim CAS；要求 manifest 与 checkpoint/lease 原子提交及全量 stale reconcile。

9. **P1-CA-14：overlap barrier 仍缺固定 schema、ready 挂点和 build/PID/data-root 隔离。** 日志时间接近不能证明同一安装版真实重叠；错误 barrier 可能释放错误进程。责任：WMB-5366 barrier store、WMB-5369 scheduler hook、WMB-5371 安装验收。

上述 v6 findings 已回填整改方案 v7；在 v7 两路审计完成前仍不写入 `TASKS.md`。

## 7. v7 独立复审结果

复审对象 SHA：`6E1808537380B23CC36F8FC534DD72E56D1EE33133CB8003384E4EE9792D7C66`。

### 产品状态机路线：REJECT（P0=0，P1=4，P2=1）

1. `DailyStageRequest.parentTaskId` 在根请求类型中为 `string`，但 continuation identity 又规定根 attempt 为 `null`；必须统一为 `string | null` 并固定 null 的 canonical 编码。
2. `PlanScope` 同时要求“先冻结”和“planner 写入事务中建立/更新”，没有 `building → frozen` 的原子边界；冻结后迟到 plan/item 写可能改变 scope/hash。
3. Stage D 的 `NO_CURRENT_TARGETS` 虽与 planner clean-empty 分离，但错误矩阵 CTA 仍为“今天没有新的内容机会”，会把无派工目标误报为无内容机会。
4. `INVALID_NEEDS_REPAIR` 的矩阵是 retryable=false/不创建，但正文又要求修复 receipt 后显式 `retry_judge`、generation+1、0/+1；缺一条“修复已验证”状态无法让 UI/Manager 取得唯一动作。

P2：超时类矩阵写“按 stage”，但未展开 full/scan/judge/settlement 对应的 scan/judge 增量；应固定 `failedStage` 与唯一增量映射。

### 并发与归属路线：REJECT（P0=0，P1=2，P2=2）

1. tick 与 `triggerNow` 的 canonical root input 可能不同，但唯一键冲突时合同要求直接复用既有 root，缺少 `root_input_hash` 比较和 `ROOT_REPLAY_CONFLICT` 零写路径。
2. overlap barrier 的 release 与 cancel/timeout 没有线性化状态和 dispatch 消费 fencing；两侧 ready 后 release 被读到后仍可能被取消，或取消后继续 dispatch。

P2：managed identity 的逐层字段清单漏列 `retryGeneration`；Stage D 只规定 target revision 进入 effect identity，未规定副作用提交前的 target revision + claim fencing CAS。

两路 v7 复审均不放行；上述 finding 已回填整改方案 v8，`TASKS.md` 仍不得写入 WMB-5365～WMB-5371。

## 8. v8 独立复审（待执行）

复审对象必须是整改方案 v8 的同一 SHA，且两路线不共享中间结论：产品状态机路线审查 PlanScope、状态/错误矩阵、continuation 与完整/空结果；并发与归属路线审查 claim/root/barrier、managed identity、Stage D settlement 和 research 生命周期。每路必须给出 P0/P1/P2、证据行、可证伪反例、责任文件和是否放行。只有两路均为无 P0/P1，主 Agent 完成回填并复核 SHA 后，才把 WMB-5365～WMB-5371 写入唯一台账。

## 9. v15 最终复审与 v16 回填

v15 仍为 `BLOCKED / NOT_READY`，P0=0，存在两个必须在实施前冻结的 P1：

1. **P1-CA-Effect-Retry：effect 失败后的下一次尝试无稳定身份。** v15 只有 target/revision/role 的 effect 去重，未定义 failed/orphaned 后显式 retry 如何获得新而稳定的幂等键。若直接换 requestId，会重复副作用；若永远复用旧键，又无法合法重试。v16 已在方案 §3.3 与失败测试 41 固定 `effectLogicalKey + effectAttemptOrdinal`、前代单活、显式 retry CAS、成功跨 orchestration 复用和旧 epoch/lease 迟到零写；责任为 WMB-5366 schema/store、WMB-5368 managed dispatch、WMB-5369 Stage D consumer。
2. **P1-CA-Manager-Fallback：生产入口会在 Manager 异常后绕回 legacy scan。** 当前 `index.ts:1107-1114` 对 `dispatchManagerDailyIntelligence` 任意异常只记录日志后继续 legacy pipeline，ownership/contract/服务异常会重新触发旧 scan，直接破坏“继续 judge 不新增 scan”和因果归属。v16 已在方案 §3.6、WMB-5371 ownership 与失败测试 42 固定 managed 分支 fail closed；只有解析前明确识别且迁移开关开启的 `LegacyDailyRequest` 可走独立 legacy 分支。

v16 复审对象必须是同一文件 SHA；两路分别给出 `READY/NOT_READY`、P0/P1/P2、证据行与责任文件。双路均 `READY / P0=0 / P1=0` 前，继续禁止写入 `TASKS.md` 或修改业务代码。

## 10. v16 产品状态机复审与 v17 回填

v16 产品状态机路线核对 SHA `A7960E94FE129928885A786539922999ADC0367F6E6CBE4128239CCC7928F490` 后给出 `NOT_READY / P0=0 / P1=3 / P2=0`。三个 P1 均已回填 v17：

1. Stage D 仍保留不含 ordinal 的旧 effectRequestId 公式；v17 删除第二套公式，唯一引用 §3.3。
2. `MANAGER_CONTRACT_ERROR` 同时写“Manager 保持原状态”和“可 generation+1 重试”；v17 以 root/attempt 原子接受事务为边界拆分接受前 `MANAGER_ENTRY_FAILED` 与接受后 fenced `MANAGER_CONTRACT_ERROR`，并固定不同 CTA/重试路径。
3. Research 生命周期重新列出的字段集不完整；v17 删除该第二套描述，只引用 §3.1 完整 preimage/derive，并固定持久字段映射。

v17 必须重新计算 SHA 并由两路对同一对象独立复审；旧 SHA 的任一路结果不能替代 v17 放行。

## 11. v16 并发/归属复审与 v18 回填

v16 并发/归属路线核对同一 SHA 后给出 `NOT_READY / P0=0 / P1=2 / P2=1`。其中 effect 双公式已由 v17 修复；其余项在 v18 回填：

1. 成功 effect 跨 orchestration 复用缺少 operation-local 归属。v18 新增 `managed_effect_consumptions` 和 fenced consume API；源 dispatch 保持原 operation，复用方以自己的完整 identity/claim token 持久消费并在 settlement 引用 source result hash。
2. source snapshot 只信 revision，无法发现 revision 未递增的内容变化。v18 增加 source content hash 与 receipt payload hash，正式 mutation 必须原子更新 revision+hash，judge 双校验并覆盖 legacy/corruption 负例。

v18 必须由两路对同一 SHA 独立复审，双路均 `READY / P0=0 / P1=0` 前继续禁止写台账和实施。

## 12. v18 并发/归属复审与 v19 回填

v18 并发/归属路线给出 `NOT_READY / P0=0 / P1=3 / P2=1`。v19 已逐项回填：

1. consumption schema/state/revision/lease/reconciler/settlement 原子引用闭合，并新增 reserve/consuming crash、接管、失败 result 和迟到 token 测试所有权。
2. barrier schema 补 `revision`，所有状态操作明确 expected revision CAS 与递增。
3. 自动门覆盖范围从 1–40 更正为 1–44，并在任务拆分列出 effect consumption 与 snapshot integrity focused tests。
4. research 旧 scope migration winner 使用确定排序；无合法 winner 时全部 orphaned，重放选择稳定。

v19 仍需两路对同一 SHA 独立复审，未双路 READY 前不写台账、不实施。

## 13. v19 双路复审与 v20 回填

v19 产品状态机路线为 `NOT_READY / P0=0 / P1=5 / P2=1`，并发/归属路线为 `NOT_READY / P0=0 / P1=4 / P2=1`。去重后 v20 统一回填：

1. 为 effect reuse mismatch 与部分渠道失败补齐错误矩阵、终态、CTA、重试与 clean-empty 禁止条件。
2. post-accept contract error 必填 failedStage/lastCommittedBoundary，保留异常观测前可信提交，观测后撤销 lease 并零新增写。
3. source/receipt hash 使用完整 canonicalBusinessJson 与共享 mutation store；target 同样增加完整 content hash。
4. cancel 原子级联 active dispatch/consumption，startup reconciler 不恢复 cancelled ancestor。
5. managed dispatch 明确 result_status/result_hash 与 terminal 不可变性；只有 succeeded 可复用。
6. consumption 自身 revision 与 Stage claim revision 分离，补齐 fail/takeover/reconcile API 和并发/崩溃测试。
7. acceptance barrier 明确不属于正常生产恢复面，runner restart 必须终结旧 scenario。
8. 自动门扩展为 §5 的 1–53。

v20 必须重新计算 SHA 并由两路独立复审；旧版本任何 READY/部分通过均不能放行。

## 14. v20 双路复审与 v21 回填

v20 产品状态机路线为 `NOT_READY / P0=0 / P1=5 / P2=3`，并发/归属路线为 `NOT_READY / P0=0 / P1=7 / P2=0`。v21 已统一回填：

1. 集中冻结全部 snapshot/binding/scope/projection/target/settlement hash 公式与共享 derive registry。
2. Stage D target snapshot 加入 plan item revision/contentHash，effect key 同时覆盖 target/plan item hash。
3. effect retry 使用新 scheduler root/Manager/target-scoped Stage D 生命周期。
4. partial channel snapshot/preimage 持久精确 channel 集合、base snapshot 和错误优先级。
5. invalid resume 改显式 new root；daily claim 与 workspace migration 增加确定性/provenance 门。
6. lastCommittedBoundary 固定 tuple/CAS；claim 增 finished_at；barrier 补 acceptance-only fail/cancel/reconcile API。
7. 自动门扩为 §5 的 1–63。

v21 复审只应把会导致实现产生多种行为、数据错误或验收不可证伪的问题列 P1；纯措辞、可由既有共享规则唯一推出的实现细节列 P2，不再无边界扩张方案范围。

## 15. v22 双路独立审计与 v23 回填

### 15.1 审计对象与结果

- 对象：方案 v22，SHA-256 `D4534EAB26A77DA0CBC4685C0AAC911433956159A41697174A33E3D4AC125A13`。
- 产品状态机路线：`BLOCKED`，P0=0、P1=5、P2=2；线程 `01a04bbb-238f-7383-9d52-5b7fa0e889fa`。
- 并发与归属路线：`BLOCKED`，P0=0、P1=5、P2=2；线程 `01a04bbb-b596-7023-bdfe-ae72397d5730`。
- 两路均只读，未修改源码、测试、TASKS 或业务数据库；既有 24 项 focused tests 通过不能替代下列新合同的红灯证据。

### 15.2 产品状态机路线 findings

1. **P1-SM-09：公开 `DailyStageRequest` 无法重算完整 stage identity。** 文档要求 `selectedChannelIds`、predecessor/base snapshot 和失败渠道 retry 字段进入 identity，但 v22 的公开 union 没有完整、可判别的字段落点。两个 modules 相同而 channel 选择不同的请求无法得到可验证的不同 hash。v23 在 §3.1 补齐字段绑定，并要求伪造/遗漏字段零写；负例验收为 §5-69。
2. **P1-SM-10：修复 receipt 与 frozen source/PlanScope 不可同时成立。** terminal receipt 和 frozen scope 不可变，但修复又要求复用旧 source snapshot；新 receipt 因不在旧 snapshot 中永远不可信。v23 在 §3.1、§3.2.1、§3.4 固定独立 `RepairSnapshotBinding`、完整 `repairSnapshotHash/bindingHash`、新 scope/new generation 与旧 scope 不变；负例验收为 §5-71。
3. **P1-SM-11：首次 judge 没有可调用的原子候选提交 API。** v22 要求 planner 写候选与 `building→frozen` 同事务，却只交接 `create/freeze/readPlanScope`，实现者只能先写计划再 freeze。v23 在 §3.2.1、§4 新增 `commitPlanScopeCandidates`，候选、provenance、scope freeze 全部回滚/提交；负例验收为 §5-64、§5-71。
4. **P1-SM-12：组合优先级没有被验收完整证伪。** v22 文字提到 pending/invalid/eligible，但未覆盖 eligible+pending、eligible+invalid、三者同时存在；错误实现可以先看到 eligible 就进入 waiting_human。v23 将 7 个非空组合和 clean-empty 固化为 §5-70 表驱动测试。
5. **P1-SM-13：watchdog 的业务进展时间没有持久语义。** heartbeat/updatedAt 可持续刷新而没有业务提交，导致五分钟 stall 不触发。v23 在 §3.2 固定 `lastBusinessProgressAt` 及可刷新事件，heartbeat/lease/audit 不得刷新；负例验收为 §5-76。

### 15.3 并发与归属路线 findings

1. **P1-CA-15：Stage D effect 集合未冻结。** role/action 依赖实时 research claim，但 `targetSetHash` 不含 role 集合；retry 又复用完整 target hash 却只结算子集，导致重启/并发时 stage identity 与实际 child 集合不一致。v23 在 §3.4 冻结 `StageDEffectSpec[]/StageDEffectSet/effectSetHash`，明确 all 与 retry_subset 的 settlement 覆盖；负例验收为 §5-72。
2. **P1-CA-16：acceptance barrier 与 root/claim/job 没有持久关联，startup reconciler 可绕过 barrier。** 一侧 consume/dispatch 后崩溃时，普通 startup selector 可能恢复验收专用派工。v23 在 root、claim、dispatch、consumption schema 增加 `acceptanceScenarioId/barrierId/runnerEpoch`，并规定验收记录只由 acceptance runner fenced 终结，生产 reconciler 不 spawn；负例验收为 §5-73。
3. **P1-CA-17：startup gate 没有校验调用者 runtime epoch。** B 接管并完成 gate 后，旧 A 仍可看到 complete 并继续 tick/triggerNow。v23 在 §3.6、§4 固定 `assertStartupGateComplete(workspaceId, callerRuntimeEpoch)`，所有入口以同事务 guard，旧 epoch 零写；负例验收为 §5-76。
4. **P1-CA-18：scan→judge 没有原子终结 predecessor claim。** `awaiting_judge` 是 active，judge 创建与 handoff timeout 竞争可留下 scan/judge 双活，startup selector 和 watchdog 可再次处理旧 scan。v23 在 §3.2.2、§4 固定 predecessor `succeeded/HANDOFF_CONSUMED/is_active=0/finished_at` 与 judge claim 同事务提交；负例验收为 §5-74。
5. **P1-CA-19：普通 managed job 没有在线 parent root/stage fence。** 只有自身 lease 不能阻止父 generation 已终态后 reconciler 启动旧 child，Manager 事后拒绝同步也无法撤销 child 先写的业务结果。v23 在 §3.3 增加 root/stage/claim revision/epoch/token 字段、reserve/spawn/event/result/mutation 全链路 parent join 与 supersede/cancel cascade；负例验收为 §5-75。

P2：旧 `wmb-5337` 测试仍假设所有 producer 共用同一 in-flight promise，需由 WMB-5369 改为同 source 重放复用、跨 source 隔离；安装态 `triggerNow` 的验收专用入口、PID 与 data-root readback 需由 WMB-5369/WMB-5371 固定。两项已纳入 v23 的 barrier/allowlist 条款和任务 ownership，不单独阻塞方案放行。

### 15.4 v23 回填清单与复审门

v23 已将上述 finding 回填为可执行合同：

- `RepairSnapshotBinding` 的全量 hash、Judge identity、PlanScope、Projection 绑定；
- `commitPlanScopeCandidates` 原子候选写入与 freeze；
- `StageDEffectSpec[]/effectSetHash` 及 retry target 子集 settlement；
- root/claim/dispatch/consumption 的 acceptance identity 和 startup 隔离；
- `assertStartupGateComplete` 的 caller epoch guard；
- scan predecessor 与 judge claim 同事务终结/切换；
- managed dispatch 的 parent fence 与 supersede/cancel cascade；
- 持久 `lastBusinessProgressAt` 和全组合终态测试。

本节只记录 v22 审计与 v23 回填，不宣称 v23 已通过。必须由两路对 v23 同一 SHA 重新独立复审，双路均无 P0/P1，并核对每个 finding 的回填章节、责任文件和 §5 负例后，才能写入 `TASKS.md`。
