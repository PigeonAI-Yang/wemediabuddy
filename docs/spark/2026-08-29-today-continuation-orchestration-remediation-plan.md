# Today「继续更新选题」与自动编排隔离整改方案

状态：v22/v23 复审未通过；v24 已补齐 retry superseding root、full→judge 双层 attempt、repair binding store、candidate admission 和 PlanScope 终态，待同一 SHA 双路放行复审；复核通过前不得进入实施台账  
版本：v24 · 2026-08-29  
性质：实施合同与安装态验收合同，不是完成回执

## 1. 问题与现场证据

本合同修复的不是“按钮文案不清”，而是继续动作、主管任务、定时编排和研究运行之间缺少明确因果归属。

2026-08-29 安装版真实运行已经证明：

- 用户在情报收集完成后点击“继续更新选题”，Renderer 仍调用通用 `startDailyIntelligence()`，新建了一轮 `daily_scan`，而不是只继续评分/策划。
- Manager 任务 `52968c9f-3291-47cc-b606-d57f170a76e5` 长期停在 `running / dispatch_planner`，但没有创建 planner 子任务。
- 本次重复扫描任务 `4c465d28-606a-41a1-b58c-7cfa24adfa30` 的 5 个来源全部失败，保存 0 条；本轮没有新增 judge，今日 plan 仍为 0。
- 09:00 自动编排与用户继续动作重叠后，Stage D 查询全库所有 `planning_status='approved'`，命中 451 条历史选题并开始批量派工。
- job 通知只按 `businessDate` 查找活动 Manager，导致 09:00 自动编排的历史工单被写入用户这次 Manager 的 children/checkpoint。
- Manager 用成功子任务数量充当 `opportunityCount`，曾显示 16，但今日方案实际为 0。
- 研究运行出现临时工作目录失效、同一 requestId 绑定不同命令或输入，以及旧 `running/resume_pending` 长期不终结。

## 2. 目标和非目标

### 2.1 目标

1. 用户点击“继续更新选题/继续评分”只续接 judge/planner，不得再次扫描。
2. 用户主动流程、09:00 自动编排和每个 Agent job 都有可持久读回的因果归属，不能只靠日期关联。
3. 自动编排只处理本次 cycle 明确选中的 target；无 target 时跳过，不得扫描全库历史 approved。
4. Manager 展示的机会数、阶段和终态来自真实今日 Projection/计划，不得从 child 成功数推断。
5. 研究任务在工作目录、requestId 冲突和恢复失败时 fail closed，并进入可解释终态。
6. 在真实安装版故意重叠“用户继续”和定时编排，闭环仍保持隔离、可终结、可审计。

### 2.2 非目标

- 不改品牌 Token、视觉体系、评分权重或传播价值合同。
- 不自动批准选题，不自动执行最终发布。
- 不批量修复无关历史数据；只为本合同涉及的 stale 任务提供确定的恢复/终结策略。
- 不以增加 fallback、静默降级或吞错方式换取表面成功。

## 3. 冻结的产品语义

### 3.1 强类型启动模式与入口合同

统一定义：

```ts
type DailyRootMode = 'owner' | 'scheduler'
type DailyAttemptStage = 'scan' | 'judge' | 'full'
type DailyRootSource = 'today_ui' | 'proposal_ui' | 'mcp' | 'scheduler_0900' | 'rolling_scan' | 'content_cycle' | 'orphan_reconcile'

type AcceptanceBinding =
  | { acceptanceMode: false; acceptanceScenarioId: null; barrierId: null; runnerEpoch: null }
  | { acceptanceMode: true; acceptanceScenarioId: string; barrierId: string; runnerEpoch: number };
```

四类入口合同互不混用：RootCreate、DailyStage、StageD、Research。`StageDAttemptInput={workspaceId,businessDate,rootRequestId,rootGeneration,managerTaskId,orchestrationId,cycleId,stageDGeneration,targetSetHash,effectSetHash,retryTargetIds,predecessorStageRequestId,predecessorEffectRequestId,acceptance}`；首次三项 retry 字段分别为 `[]/null/null`，effect retry 必须完整填写，生产 `acceptance={acceptanceMode:false,acceptanceScenarioId:null,barrierId:null,runnerEpoch:null}`。targetSetHash/effectSetHash 只使用 §3.4 的共享 registry。`stageRequestId=sha256(canonicalJson({version:1,input:StageDAttemptInput}))`，`requestId=operationRequestId=sha256(canonicalJson({version:1,command:'daily.stage_d',stageRequestId,input:StageDAttemptInput}))`。

`ResearchAttemptPreimage={workspaceId,businessDate,rootRequestId,rootGeneration,managerTaskId,orchestrationId,acceptance,parentTaskId,parentStageRequestId,gapId,sourceSnapshotHash,retryGeneration}`；`researchStageRequestId=sha256(canonicalJson({version:1,input:ResearchAttemptPreimage}))`，`researchRequestId=operationRequestId=sha256(canonicalJson({version:1,command:'research.run',stageRequestId:researchStageRequestId,input:ResearchAttemptPreimage}))`。共享 API 只导出 `deriveResearchAttemptIdentity`；gap、parent stage、snapshot 或 generation 任一变化都产生不同 attempt identity，而 active scope 仍由 parent+gap 限制单活。

legacy 是独立 `LegacyDailyRequest={workspaceId,businessDate,legacyPipeline:true}`，只在迁移开关开启且请求完全不含 managed root/stage 字段时可用；所有新 Root/Stage 请求类型都不含 `legacyPipeline` 字段。`DailyRootSource` 是唯一 source 枚举，旧 `'owner'/'scheduler'` 字符串不得再作为 source 值。

生产入口使用同一份请求合同（字段名在 Renderer、preload、IPC、MCP 和 Main 中保持一致）：

```ts
type DailyStageIdentity = {
  workspaceId: string;
  rootMode: DailyRootMode;
  source: DailyRootSource;
  businessDate: string;
  rootRequestId: string;
  rootGeneration: number;
  managerTaskId: string;
  orchestrationId: string;
  requestId: string;
  stageRequestId: string;
  operationRequestId: string;
  retryGeneration: number;
  acceptance: AcceptanceBinding;
};

type DailyScanStageRequest = DailyStageIdentity & {
  attemptStage: 'scan' | 'full';
  parentTaskId: string | null;
  sourceTaskId: null;
  modules: Array<'official_web' | 'x_lists'>;
  selectedChannelIds: string[];
  watermark: string;
  predecessorStageRequestId: string | null;
  baseSourceSnapshotHash: string | null;
  retryFailedChannelIds: string[];
  predecessorBinding: null;
};

type RepairSnapshotBinding = {
  predecessorScopeHash: string;
  sourceSnapshotHash: string;
  repairedPlanItemIds: string[];
  priorItemRevisions: Record<string, number>;
  repairedItemRevisions: Record<string, number>;
  priorItemContentHashes: Record<string, string>;
  repairedItemContentHashes: Record<string, string>;
  repairReceiptIds: string[];
  repairReceiptRevisions: Record<string, number>;
  repairReceiptPayloadHashes: Record<string, string>;
  repairSnapshotHash: string;
  status: 'frozen';
};

type JudgePredecessorBinding = {
  source: SnapshotBinding;
  repair: RepairSnapshotBinding | null;
  bindingHash: string;
  status: 'frozen';
};

type DailyJudgeStageRequest = DailyStageIdentity & {
  attemptStage: 'judge';
  parentTaskId: string;
  sourceTaskId: string;
  modules: null;
  watermark: null;
  selectedChannelIds: null;
  predecessorStageRequestId: string;
  baseSourceSnapshotHash: string;
  retryFailedChannelIds: null;
  predecessorBinding: JudgePredecessorBinding;
};

type DailyStageRequest = DailyScanStageRequest | DailyJudgeStageRequest;
```

`RepairSnapshotBinding` 是一次独立、不可变的修复事实，不是对旧 source snapshot 或 terminal receipt 的回写。其规范 preimage 固定为：

```ts
repairSnapshotHash = H({version: 1,
  predecessorScopeHash,
  sourceSnapshotHash,
  repairedPlanItemIds: sorted,
  priorItemRevisions: sortedEntries,
  repairedItemRevisions: sortedEntries,
  priorItemContentHashes: sortedEntries,
  repairedItemContentHashes: sortedEntries,
  repairReceiptIds: sorted,
  repairReceiptRevisions: sortedEntries,
  repairReceiptPayloadHashes: sortedEntries,
});
```

其中 `H(x)=sha256(canonicalJson(x))`，所有 `sortedEntries` 按 key 排序；`repairSnapshotHash` 必须等于该 preimage 的派生值，缺字段、数组未排序或调用方自报 hash 均拒绝。为避免 identity 循环，`JudgePredecessorBinding.bindingHash` 的唯一公式只依赖冻结 predecessor，不依赖尚未派生的当前 `stageRequestId`：`H({version:1,predecessorStageRequestId,sourceTaskId,sourceSnapshotHash,repairSnapshotHash})`，没有修复时 `repairSnapshotHash=null`。`PlanScope` 必须持久 `repairSnapshotHash` 与 `bindingHash`；Projection 必须读回并比较它们。修复提交只能创建新的 frozen binding，旧 source snapshot、receipt、scope 和 hash 保持不可变；旧 binding 加新 receipt、旧 scope 加新 item 或仅改变 revision 的伪修复均返回 `PLAN_SCOPE_MISMATCH` 并零写。

修复 binding 不能只存在于 Judge 请求 JSON 中。WMB-5366 必须提供独立的 `daily_repair_snapshot_bindings` store 及三个 API：`createRepairSnapshotBinding({bindingIdentity, predecessorScopeHash, sourceSnapshotHash, repairedItems, repairReceipts, claimFence})`、`freezeRepairSnapshotBinding({bindingIdentity, expectedBindingRevision, claimFence})`、`readRepairSnapshotBinding(bindingIdentity)`。`bindingIdentity` 的完整键集为 `{workspaceId,rootRequestId,rootGeneration,managerTaskId,orchestrationId,predecessorStageRequestId,predecessorScopeHash,sourceSnapshotHash,repairSnapshotHash}`；逻辑唯一键为 `(workspace_id,predecessor_stage_request_id,repair_snapshot_hash)`，不能按日期或最新记录查找。表至少持久 `bindingIdentity`、完整规范 preimage、`prior*`/`repaired*` revision 与 content hash、receipt revision 与 payload hash、`bindingRevision`、`ownerEpoch`、`leaseToken`、`status`、`createdAt`、`frozenAt`、`finishedAt`。create 只建立 `building` 记录并以 `bindingRevision=0` 幂等返回；freeze 在同一 claim fence 下重新读回每个 item/receipt，要求当前 revision/hash 与 preimage 完全相等，成功以 CAS `building→frozen` 且 revision+1，之后只读；任一字段不符、前代 scope 非 frozen、旧 root/claim/epoch/token 或重复 freeze 均返回 `PLAN_SCOPE_MISMATCH` 并零写。Owner 的“修复 item/receipt + freeze”必须由共享 mutation store 在一个事务完成；崩溃留下的 building binding 只能被同一 identity 接管后冻结或终结为 `failed/cancelled`，不能直接被 Judge 消费。read 只接受完整 identity 和 frozen 状态，不能以新 receipt 回填旧 binding。

`DailyStageRequest` 是生产边界的判别联合：`scan/full` 必须有非空 modules、`selectedChannelIds`、watermark，首次请求固定 `predecessorStageRequestId/baseSourceSnapshotHash=null,retryFailedChannelIds=[]`，失败渠道重试则三者必须引用原 predecessor/base snapshot 和精确失败 channel IDs；`judge` 必须有 parent/source/predecessor frozen binding，且 selectedChannelIds/retryFailedChannelIds 为空、modules/watermark 为 null。`DailyStageIdentity` 中的 ID 只由 root/attempt store 的 derive API 产生；Renderer、MCP 和 IPC 不得自报或随机生成派生 ID，边界必须重算并比较，不一致即拒绝。上述所有输入字段必须在同一 immutable envelope 持久化，不能从“最新渠道选择”或日期查询补齐。

Manager 根上下文的 `rootMode`、`businessDate`、`managerTaskId`、`orchestrationId`、`source` 和 `createdAt` 创建后不可变；每次阶段尝试只在 attempt 上持久化 `attemptStage`、`stageRequestId`、`retryGeneration`、`sourceTaskId`、快照 hash 和 deadline。阶段字段不得反写成 Manager 根字段，也不得用根字段推断本次阶段。`requestId` 是命令回执身份，`stageRequestId` 是该阶段尝试身份；同一尝试重放二者都不变，显式失败重试才生成新的 generation、stageRequestId 和 requestId。

`full` 是一个 Manager root 内的两个有序 attempt，而不是一个可重复覆盖的 request：F attempt (`attemptStage='full'`) 只负责 reporter/scan，持久自己的 `stageRequestId_F`、`requestId_F=operationRequestId_F`、source child、receipt 和 frozen `SnapshotBinding`；F 成功后在同一 root/Manager 内以原子 handoff 终结 predecessor 为 `succeeded/HANDOFF_CONSUMED/is_active=0`，再创建唯一 J attempt (`attemptStage='judge'`)。J 持久独立的 `stageRequestId_J`、`requestId_J=operationRequestId_J`、`parentTaskId=F sourceTaskId`、`predecessorStageRequestId=stageRequestId_F`、`sourceSnapshotHash` 和 `JudgePredecessorBinding`，只派 planner，不创建 reporter。F 与 J 的 command receipt、attempt ordinal、deadline 和 terminal readback 分开；J 的 receipt 永远不能冒充 F 的 scan receipt，F 的 snapshot 只能按 hash 被 J 引用。自动 full→judge 是一次内部 handoff，不增加 scan，也不把 F 的 requestId 改写成 J；同一 J 的双击/重启只读同一 J receipt。

managed IPC/MCP 中完整 root/stage identity 均为必填；只有 root create 命令可以先产生身份。`daily.readiness` 接收 `{workspaceId,source,orchestrationId?}`：Today 只查询 `today_ui`，Proposal 只查询 `proposal_ui`，MCP 必须传自己创建的 orchestrationId，automation/reconciler 也必须传显式 orchestrationId；任何 producer 不得跨 source 选择“最新”。历史终态 root 只按显式 ID 返回，禁止按日期猜测。缺失或不一致返回 `MANAGER_OWNERSHIP_REQUIRED` 且业务零写。

| 用户动作 | mode | 必须发生 | 禁止发生 |
|---|---|---|---|
| 首次开始今日情报 | `full` | scan 后按结果继续 judge/planner | 无依据跳阶段 |
| 重新侦察 | `scan` | 新建一次 scan | 隐式进入历史工单 |
| 继续更新选题/继续评分 | `judge` | 复用当天已有资料，只创建一次 judge 并继续 planner | 新建 reporter/daily_scan |

阶段由显式 `attemptStage` 决定，禁止根据按钮文字、已有 child 数量或泛化的 `scoringRecovery` 猜测。Renderer、preload、全局类型、IPC、Manager dispatch 必须使用同一联合类型；“继续更新选题”只构造 `attemptStage='judge'`，不能复用“开始今日情报”的 scan/full 请求。

`judge` 若没有可续接资料，原 judge attempt 必须先终结为 `partial/NO_CONTINUATION_MATERIAL` 或 `partial/SOURCE_SNAPSHOT_STALE`，动作 `retry_scan`（界面文案为“先重新侦察”）；不得静默降级为 `scan`，不得显示“验证浏览器”或启动新 reporter。Owner 明确点击 `retry_scan` 后创建新的 owner Manager/orchestration，首个 attempt 为 `full`、`retryGeneration=0`，并持久化 `supersedesManagerTaskId/supersedesOrchestrationId/supersedesStageRequestId` 指向旧 judge；旧 Manager 保持终态，不 rebind、不复活。新 full 扫描成功后只使用自己的新快照继续 judge/planner。双击 retry_scan 通过新 root claim 读回同一新 Manager；不得复用旧 Manager 或按日期寻找任意任务。

所有显式 retry 都遵守同一个终态单调规则：先以 fenced CAS 将旧 attempt/Manager/root 终结为 `failed|partial|needs_user|cancelled`，再由 root store 在同一业务域分配 `retryInvocationOrdinal` 和 `rootGeneration+1`，创建新的 superseding root、Manager 和首个 stage attempt；新 root 持久 `predecessorRootId` 及全部 `supersedes*` 身份。旧 root/Manager 永不回到 `running`，不原位重写、不复活、不把“同一 root”解释为相同 root ID；它只表示同一 business context。双击/IPC/重启重放通过新 root 的原始 receipt 读回同一 superseding root，只有对当前最新终态再次明确 retry 才能分配下一 ordinal。新 root 可以引用旧 frozen source/repair/scope 的不可变 hash，但不能回写旧记录；scan/judge 增量按新 root 的 attempt 计算。

### 3.2 Manager 状态机与 `channel_scanned` 语义

Manager 创建时必须在既有 `agent_tasks.context_refs_json` 和 `checkpoint_json` 同时持久化不可变根字段 `rootMode`、`businessDate`、自身 `managerTaskId`、`orchestrationId`、`source`、`createdAt`，以及当前 attempt 的 `attemptStage`、`stageRequestId`、`requestId`、`retryGeneration`、`acceptedAt` 和阶段 deadline。允许的主路径：

```text
full  -> dispatch_reporter -> monitor_reporter -> dispatch_planner -> monitor_planner -> succeeded/waiting_human | partial | failed | needs_user
scan  -> dispatch_reporter -> monitor_reporter -> awaiting_judge | partial | failed | needs_user
judge -> dispatch_planner  -> monitor_planner -> succeeded/waiting_human | partial | failed | needs_user
```

- `judge` 路径不得产生 reporter/scan child。
- `channel_scanned` 是 reporter/daily task 的持久 predecessor/handoff 标记，不是“工作仍在运行”的无限状态：扫描回执、资料快照和 `handoffDeadlineAt` 已写入后，Manager 进入 `awaiting_judge`；在 deadline 内由同一 Manager 的 `judge` 请求把 predecessor 原位 rebind 为 planner，禁止另起 reporter。deadline 到期由 Manager watchdog 写入 `partial/SCAN_HANDOFF_EXPIRED`，并保留快照，不能继续保持 `running`。
- `scan` 的 `awaiting_judge` 是可观察的人机等待态；真正渠道失败、Pi 不可用或没有可信回执分别进入 `partial`、`needs_user` 或 `failed`。`full` 只有在同一 predecessor 快照存在时才自动进入 judge。
- planner 终态转移必须先读同一份 Today Recommendation Projection，按固定优先级执行：先处理 `pending`，再处理 `invalid`，然后才处理 `eligible` 和 clean-empty。也就是说，`eligible>0` 与 `pending>0` 混合时仍为 `partial/SCORING_INCOMPLETE`，`eligible>0` 与 `invalid>0` 混合时仍为 `partial/INVALID_NEEDS_REPAIR`（两者同时存在时 reason/action 为稳定的组合值）；只有 `eligible>0 && pending=0 && invalid=0` 才是 `waiting_human`，今日卡只展示可批准的 eligible IDs。只有 candidate 确实为零、没有 pending/invalid 且所有来源 receipt 可信，Manager 才 `succeeded + emptyQualified=true`；本合同不新增 `hardRejected` 分类。`NO_CURRENT_TARGETS` 只属于 Stage D 的 stage-level 结果：Stage D=`skipped` 时其所属 scheduler Manager 才以 `succeeded + stageStatus=skipped` 终结；它绝不能把 planner 的 Projection 直接判成 `emptyQualified`。若 PlanScope 中仍有 eligible，planner Manager 必须是 `waiting_human`；只有 Projection 自身满足“candidate=0、pending=0、invalid=0、回执全可信”才使用 planner 的 `NO_ELIGIBLE_OPPORTUNITY` clean-empty。派工失败、Pi 无响应或保存读回失败 → `failed`/`partial` 加稳定原因和动作。`needs_user` 只用于明确的配置/登录/人工决策阻塞，不得因为 planner child `succeeded` 就直接变成待批准。
- 超时、派工失败、候选不足和渠道失败都必须在可测试 deadline 内形成终态或可观察的 `waiting_human`，禁止无限 `running`/`resume_pending`。
- 每个 `(managerTaskId, orchestrationId, attemptStage, retryGeneration)` 最多派发一次。`retryGeneration=0` 是首次操作；同一 generation 的重复请求（包括双击、IPC 重放、重启后重放和已终态重读）按持久化的稳定 `requestId` 返回同一 Manager/child/receipt，不得重复创建 child。只有 Owner 明确点击“重试”且上一次为 `failed`/`partial` 时，才把 generation 加一并派生新的 stageRequestId/requestId；`succeeded`/`waiting_human`/`emptyQualified` 不得靠重复点击开启新 attempt。同一 requestId 绑定不同命令、日期、Manager、generation 或输入时返回 `REQUEST_REPLAY_CONFLICT`，并记录冲突双方摘要。

阶段终态集合固定为：`succeeded`（含 `emptyQualified`）、`waiting_human`（仅有完整方案待 Owner 批准）、`partial`（有可读部分结果但未满足全量）、`failed`（无可信结果或运行错误）、`needs_user`（配置/登录/明确人工决策阻塞）、`cancelled`。Stage-level 结果另外允许 `skipped`，但 Manager 根任务必须以 `succeeded + stageStatus=skipped + reasonCode=NO_CURRENT_TARGETS` 读回，不能留下未定义终态。Manager checkpoint 还必须持久化 `opportunityCount`、`projectionAsOf`、`projectionHash`、`retryGeneration` 和 `source`；机会数与 projection 字段必须由同一次 Today Recommendation Projection 读回，绝不能由 child 数量推断。`awaiting_judge` 只能出现在 scan Manager checkpoint，且必须带 deadline；它不是额外的终态或可长期悬挂状态。

Manager watchdog 由 `manager-dispatch` 的持久恢复/定时检查负责，不依赖 Pi 回应：每 15 秒检查；默认单阶段 10 分钟、整次 Manager 30 分钟、无业务进展 5 分钟，均允许测试通过 `WMB_MANAGER_STAGE_WALL_MS`、`WMB_MANAGER_WALL_MS`、`WMB_MANAGER_STALL_MS` 覆盖。超时写入 `MANAGER_STAGE_TIMEOUT`、`MANAGER_WALL_CLOCK` 或 `MANAGER_STALL`，终止/回收子任务并读回 `finished_at`；应用重启后先恢复同一 deadline，再执行相同判定。`channel_scanned` 使用 3 分钟 handoff deadline，原因码为 `SCAN_HANDOFF_EXPIRED`。

Manager checkpoint 不是普通 JSON 覆盖写。`agent_tasks` 的 Manager 行必须新增持久列或等价的 checkpoint 字段 `checkpointRevision, activeStageRequestId, ownerEpoch, leaseToken, leaseExpiresAt, lastBusinessProgressAt`；其中 `lastBusinessProgressAt` 只在成功提交 source snapshot、plan/item、child/result、scope/projection 或合法阶段迁移的同一事务更新。heartbeat、lease 续租、审计、普通 checkpoint 覆盖、重读和 watchdog 自身都不得刷新它。child event、watchdog、cancel、retry、projection settlement 和 reconciler 都只能执行 `WHERE id=? AND checkpointRevision=? AND activeStageRequestId=? AND ownerEpoch=? AND leaseToken=? AND status IN (允许前态)` 的条件更新，成功后 revision+1。Manager/root 状态迁移单调为 `created→running|awaiting_judge→waiting_human|succeeded|partial|failed|needs_user|cancelled`，任何终态不得回到非终态；现有 orchestration `completed/paused` 映射固定为 `succeeded/waiting_human`，不得另造并行状态。`daily_orchestration_roots.status` 使用相同 fenced CAS，并同步保存 `last_business_progress_at`；旧 token、旧 stage、迟到 child 和 watchdog 竞争失败均只写 audit、业务零写。watchdog 的 stall 判定只比较 `lastBusinessProgressAt`，因此持续 heartbeat 不能掩盖业务停滞。必须做两个 child 乱序、timeout 后迟到成功、cancel 与 settlement、接管后旧 owner 四类数据库竞争测试，并覆盖“heartbeat 每 15 秒但五分钟无业务提交”在 deadline 内得到 `MANAGER_STALL`。

#### 3.2.1 终态判定的唯一投影合同

`waiting_human` 只表示已经存在至少一个可批准的完整方案；它不能表示“planner 进程成功”或“还有一个候选”。Manager 在任何 planner 终态写入前，必须在同一数据库读事务中调用唯一的 `readTodayRecommendationProjection(businessDate, planScope)`，并将下面的完整快照同时写入 Manager checkpoint、task result/readback 和对应 receipt：

```ts
type TodayRecommendationProjection = {
  workspaceId: string;
  businessDate: string;
  managerTaskId: string;
  orchestrationId: string;
  stageRequestId: string;
  scopeHash: string;
  bindingHash: string;
  repairSnapshotHash: string | null;
  planIds: string[];
  asOf: string;
  entries: Array<{
    planItemId: string;
    planId: string;
    planDate: string;
    origin: 'today' | 'carry';
    sourceReceiptIds: string[];
    sourceReceiptRevisions: Record<string, number>;
    repairReceiptIds: string[];
    repairReceiptRevisions: Record<string, number>;
  }>;
  candidatePlanItemIds: string[];
  eligiblePlanItemIds: string[];
  pendingPlanItemIds: string[];
  invalidPlanItemIds: string[];
  trustedReceiptIds: string[];
  emptyQualified: boolean;
  projectionHash: string;
};
```

投影的范围不是隐含的日期查询。每次 attempt 必须先建立带不可变身份和 source snapshot 的唯一 `PlanScope`。首次 `judge` 只冻结 predecessor 的 source binding 和允许输入边界，先创建 `scopeStatus='building'`、空的 plan/item 集合；planner 在同一数据库事务中写入本次完整候选 plan/item 集合，再把 scope 从 `building` 原子转为 `frozen`。之后才允许以它作为 `readTodayRecommendationProjection` 的唯一输入。`building` 只能转为 `frozen`、`failed` 或 `cancelled`；`frozen` 只能保持只读、被 supersede 标记为 `superseded` 或在 root 取消时终结，不得重新变回 building 或扩展集合。纯重算 retry 不复制到旧 scope，而是在新 superseding root/attempt 中调用 `copyFrozenPlanScope`；它只复制 predecessor 的排序后 item/carry 集合、内容 hash、receipt 引用和 admission 结果，必须用新 stage identity 重新计算新的 `scopeHash`/`projectionHash`。因此“保持集合与内容”不等于“复用旧 hash”；任何新候选、修复 binding 或 source 变化一律创建新的 `building` scope。

```ts
type PlanScope = {
  businessDate: string;
  rootRequestId: string;
  rootGeneration: number;
  rootInputHash: string;
  managerTaskId: string;
  orchestrationId: string;
  attemptStage: 'full' | 'judge';
  stageRequestId: string;
  claimRevision: number;
  ownerEpoch: number;
  leaseToken: string;
  leaseExpiresAt: string;
  sourceSnapshotHash: string | null;
  repairSnapshotHash: string | null;
  bindingHash: string;
  allowedPlanIds: string[];
  allowedPlanItemIds: string[];
  carryPlanItemIds: string[];
  trustedReceiptIds: string[];
  scopeStatus: 'building' | 'frozen' | 'failed' | 'cancelled' | 'superseded';
  scopeHash: string;
};
```

新增权威表 `daily_plan_scopes(workspace_id,stage_request_id,root_request_id,root_generation,root_input_hash,manager_task_id,orchestration_id,claim_revision,attempt_stage,source_snapshot_hash,repair_snapshot_hash,binding_hash,status,scope_json,scope_hash,owner_epoch,lease_token,lease_expires_at,created_at,updated_at,frozen_at,finished_at)`，唯一键 `(workspace_id,stage_request_id)`；`status` 的允许值为 `building|frozen|failed|cancelled|superseded`，只有 `frozen` 可被 Projection 读取。`scope_json` 固定保存排序后的 plan/item/carry IDs、每个 item revision/contentHash 和 trusted receipt IDs/revisions。`scopeHash` 只调用 §3.4 的 `derivePlanScopeHash`。`PlanScope` 的 create、plan/item 写入、freeze、read、cancel 和 supersede 都必须在同一事务 join 当前 root 与 stage claim，校验 `rootRequestId/rootGeneration/rootInputHash/managerTaskId/orchestrationId/stageRequestId/claimRevision/ownerEpoch/leaseToken` 及允许状态；不能只校验 scope 自身 token。首次 judge 在 planner 写入计划项的同一事务中以 `claimRevision+ownerEpoch+leaseToken+expected status=building` 完成 `building → frozen`；零候选也必须冻结一行 `scope_json` 空集合，因此 clean-empty 可在重启后读回。事务失败写 `failed + finished_at`，不得留下可读 building scope。scope 一旦 frozen，禁止扩展；迟到写只能返回 `PLAN_SCOPE_MISMATCH` 并零写；retry 的新 root 创建新 stageRequestId/新 scope，纯重算才可复制集合而不得复制旧 hash。取消或 supersede 必须在同一 root/claim 事务撤销所有 building scope lease，并把未冻结 scope 终结为 `cancelled`/对应 reason，已 frozen scope 标记 `superseded`；旧 scope token 迟到只能写 audit。`plans/plan_items.provenance` 只保存 scope 外键和 hash，不是 scope SSOT。投影只读该 frozen scope，禁止按日期、`is_current` 或“最新 plan”扩展集合。新建计划项必须带当前 identity；carry 只能来自 scope 明列集合。WMB-5366 拥有表/迁移/CAS store，WMB-5367 拥有 planner/projection 接入，但不得直接绕过该 store 写 scope。

WMB-5366 必须提供唯一的原子提交入口 `commitPlanScopeCandidates({scopeIdentity, claimFence, candidates, trustedReceiptBindings, failureInjectionPoint?})`。它在一个数据库事务中完成：校验 root/Manager/stage claim 与 `scopeStatus='building'`；按本节的 candidate admission predicate、完整度、来源和评分门校验全部 `candidates`；写入 plans、plan_items、provenance 及本次 receipt 关联；生成排序后的 `scope_json`、`scopeHash`、`bindingHash`；把 scope CAS 为 `frozen` 并写 `frozenAt/finishedAt`；返回 scope identity、完整候选 ID 集合和 hash。`candidates=[]` 也必须提交一个冻结空 scope。任何候选写入、receipt 绑定或 freeze 前的 failpoint 都整体回滚，不能留下 plan/item、可读 `building` scope 或半条 provenance。WMB-5367 不得先调用 `plans.save` 再调用 `freezePlanScope`；首次 judge 的唯一生产路径必须使用这个 API。纯重算 retry 才能调用 `copyFrozenPlanScope({predecessorScopeIdentity,newScopeIdentity,claimFence})`，且只保持 predecessor 的排序后 item/carry 集合、内容 hash、receipt 关联和 admission 结果，必须按新 scope identity 重新计算新的 `scopeHash`/`projectionHash`；旧 scopeHash 不得复制。修复或新增候选一律走新的 `building` scope。

`eligiblePlanItemIds` 是唯一机会数来源，并保留当前 Today 的跨日递补合同：`planDate === businessDate` 的条目标记 `origin='today'`；符合现有递补规则的 `planDate < businessDate` 条目标记 `origin='carry'`。两类条目都必须出现在 `entries` 中，包含真实 `planId/planDate/来源回执及 revision`，不能把跨日条目误判成 clean-empty。每个条目共享 `validateProposalCompleteness`、`validatePlanSourceReferences`、`validateTruthGateSourceReferences` 和有效 `propagation_v2` 评分门，来源可读且未过期；所有数组和 entries 按 `planItemId` 稳定排序后计算 `projectionHash`。当前分类集合固定且互斥为 `eligible/pending/invalid`；任何 candidate 必须落入其中之一，禁止新增未实现的隐式排除类别。`trustedReceiptIds` 对普通 judge 必须来自本 attempt 的 source snapshot；带修复的 judge 还可包含 `RepairSnapshotBinding.repairReceiptIds`，但每个修复 receipt 必须逐项匹配该 binding 的 revision/payload hash，且全部 trusted IDs 必须属于 `PlanScope.trustedReceiptIds`。`entries` 同时读回 `sourceReceiptIds` 与 `repairReceiptIds`，禁止以 source snapshot 的旧 receipt 冒充修复后的可信资料。UI、Manager 和验收均比较这组 ID、bindingHash、repairSnapshotHash、scopeHash 和 projectionHash，而不是只比较数量；禁止“Today Projection 或 current plan”双权威。

候选准入谓词固定为：`Candidate(c,scope)` 必须同时满足 `c.planItemId ∈ scope.allowedPlanItemIds`、`c.planId ∈ scope.allowedPlanIds`、plan/item 的 revision 与 canonical content hash 等于 scope、`planDate` 命中 today/carry 边界、provenance 指向当前 scope、全部 source/repair receipt ID 属于 scope.trustedReceiptIds 且 revision/payload hash 相等，并且分类器返回且仅返回 `eligible|pending|invalid` 之一。字段缺失、来源过期、评分未完成、完整度门失败或 hash 不一致的“已出现候选”必须保留为 `invalid` 或 `pending`，绝不能在 admission 前静默丢弃；同一 `planItemId` 重复、scope 外 ID、未知分类或未绑定 receipt 直接返回 `CANDIDATE_ADMISSION_GAP` 并回滚整个 commit。`candidateInputCount` 是 planner 本次提交的原始候选行数，`classifiedCount=eligible+pending+invalid`；只有两者均为零、全部 selected channel receipt 已可信覆盖、scope 已 frozen 且没有被 admission 拒绝时，才允许 `NO_ELIGIBLE_OPPORTUNITY/emptyQualified=true`。任何“候选存在但被筛掉”、分类数量不相等、来源覆盖不完整或 scope 中有未解释 ID，都不是 clean-empty，而是 `partial/CANDIDATE_ADMISSION_GAP`（需修复或重试）。

终态转移固定如下：

| 当前事件 | 必须满足的 guard | 下一状态 | reason/action |
|---|---|---|---|
| planner 成功读回 | pending>0 且 invalid>0 | `partial` | `SCORING_INCOMPLETE_AND_INVALID / repair_or_retry` |
| planner 成功读回 | pending>0 且 invalid=0 | `partial` | `SCORING_INCOMPLETE / retry_judge` |
| planner 成功读回 | pending=0 且 invalid>0 | `partial` | `INVALID_NEEDS_REPAIR / repair_or_retry` |
| planner 成功读回 | eligible>0 且 pending=0 且 invalid=0 | `waiting_human` | `READY_FOR_OWNER_APPROVAL / approve` |
| planner 成功读回 | candidate=0，且 invalid=0、pending=0、`trustedReceiptIds` 覆盖本 attempt 的全部选定回执 | `succeeded` | `NO_ELIGIBLE_OPPORTUNITY + emptyQualified=true / no_action` |
| 派工失败、超时、保存读回失败 | 无可信完整投影 | `failed` 或 `partial` | 稳定 reasonCode + 明确 retry action |
| 配置、登录或明确 Owner 决策缺失 | 需要人补充外部条件 | `needs_user` | 稳定 reasonCode + 具体人工动作 |

`NO_CURRENT_TARGETS` 不出现在上表的 planner 判定中；它只表示 Stage D 已完成 target snapshot 读取但集合为空。Stage D 的 `skipped` 与 planner 的 `NO_ELIGIBLE_OPPORTUNITY` 是两个不同层级、不同 projection、不同 Manager 读回，任何实现不得把两者合并为一个“没有机会”分支。`INVALID_NEEDS_REPAIR` 与修复完成后的 `INVALID_REPAIR_VERIFIED` 是错误矩阵中的两行：前者表示 receipt 缺失、过期或不匹配，只能显示“修复选题资料”；Owner 修复并提交对应 receipt 后，系统在同一事务完成 item/revision/source 校验，冻结不可变的 `RepairSnapshotBinding`，才读回后者并显示“资料已修复，继续评分”。Owner 必须再次显式发出 `retry_judge`，先终结旧 partial Manager，再由 root store 创建 superseding owner root/Manager、`retryGeneration + 1`、新的 `stageRequestId/requestId` 和新的 `PlanScope`；新 judge 同时引用原 `sourceSnapshotHash` 与新的 `repairSnapshotHash`，不修改旧 source/receipt/scope，scan 增量为 0、judge 增量为 1。修复提交本身不自动派 judge，未提交修复或修复 receipt 不匹配则保持原 `partial` 且零写；旧 snapshot 与新 repair receipt 不能混成同一 binding。

因此 planner child `succeeded` 但投影为 pending/invalid 时不得进入 `waiting_human`；合法 clean-empty 是成功分支，不能用“至少一条”伪造方案。

所有可见错误使用下面唯一矩阵；“操作终态”是本次 command/claim 的终态，“Manager 终态”明确写为保持不变时不得误改根任务。`retry_*` 均为显式 Owner/scheduler 动作，不能由 UI 自动点击或后台隐式重试：

| reasonCode | 操作/Manager 终态 | retryable | action | 中文 CTA | 新 generation/root | scan/judge 增量 |
|---|---|---:|---|---|---|---|
| `NO_CONTINUATION_MATERIAL` | `partial` / Manager `partial` | 是 | `retry_scan` | 先重新侦察 | 新 owner full root | +1 / 0 |
| `SOURCE_SNAPSHOT_STALE` | `partial` / Manager `partial` | 是 | `retry_scan` | 资料已变化，重新侦察 | 新 owner full root | +1 / 0 |
| `SCAN_HANDOFF_EXPIRED` | `partial` / Manager `partial` | 是 | `retry_scan` | 交接已过期，重新侦察 | 新 owner full root | +1 / 0 |
| `SCORING_INCOMPLETE` | `partial` / Manager `partial` | 是 | `retry_judge` | 继续评分 | superseding owner root/Manager，generation+1 | 0 / +1 |
| `SCORING_INCOMPLETE_AND_INVALID` | `partial` / Manager `partial` | 否（先修复） | `repair_or_retry` | 先修复资料，再继续评分 | 修复后 superseding owner root/Manager，generation+1 | 0 / 修复后+1 |
| `INVALID_NEEDS_REPAIR` | `partial` / Manager `partial` | 否（先修复） | `repair_or_retry` | 修复选题资料 | 不自动创建 | 0 / 0 |
| `INVALID_REPAIR_VERIFIED` | `partial` / Manager `partial` | 是 | `retry_judge` | 资料已修复，继续评分 | superseding owner root/Manager，generation+1 | 0 / +1 |
| `MANAGER_STAGE_TIMEOUT` | 无可信结果=`failed`，有可读部分=`partial` | 是 | `retry_stage` | 重试本阶段 | superseding root/Manager，generation+1 | 按 stage |
| `MANAGER_WALL_CLOCK` | 无可信结果=`failed`，有可读部分=`partial` | 是 | `retry_stage` | 重试本阶段 | superseding root/Manager，generation+1 | 按 stage |
| `MANAGER_STALL` | 无可信结果=`failed`，有可读部分=`partial` | 是 | `retry_stage` | 重试本阶段 | superseding root/Manager，generation+1 | 按 stage |
| `CURRENT_TARGET_BINDING_MISSING` | `failed` / Manager `failed` | 否（先修复 target） | `repair_target` | 修复当前周期绑定 | 不自动创建 | 0 / 0 |
| `TARGET_SNAPSHOT_STALE` | `partial` / Manager `partial` | 是 | `retry_stage_d` | 重新编排当前周期 | scheduler generation+1（前代必须先终态） | 0 / 0 |
| `REQUEST_REPLAY_CONFLICT` | 操作 receipt=`failed`；Manager 保持原状态 | 否 | `read_original_attempt` | 刷新并查看原任务 | 不创建 | 0 / 0 |
| `WORKSPACE_STALE` | 新执行/接管=`failed`；已终态 receipt 仍只读返回；Manager 保持原状态 | 是 | `refresh_workspace` | 工作区已变化，请刷新 | 不创建 | 0 / 0 |
| `ROOT_REPLAY_CONFLICT` | 操作 receipt=`failed`；既有 root 保持原状态 | 否 | `read_original_root` | 输入已绑定到另一轮编排 | 不创建 | 0 / 0 |
| `MANAGER_OWNERSHIP_REQUIRED`、`MANAGER_ORCHESTRATION_MISMATCH` | 操作 receipt=`failed`；Manager 保持原状态 | 否 | `open_bound_manager` | 回到对应任务 | 不创建 | 0 / 0 |
| `MANAGER_OPERATION_IDENTITY_MISMATCH` | 操作 receipt=`failed`；Manager 保持原状态 | 否 | `open_bound_manager` | 任务身份不一致，查看原任务 | 不创建 | 0 / 0 |
| `PLAN_SCOPE_MISMATCH` | 操作 receipt=`failed`；Manager 保持原状态 | 否 | `read_original_attempt` | 选题范围已变化，请查看原任务 | 不创建 | 0 / 0 |
| `CANDIDATE_ADMISSION_GAP` | 操作/Manager=`failed`；本次 scope commit 整体回滚 | 是 | `retry_stage` | 选题准入不完整，请重试评分 | superseding owner root/Manager，generation+1 | 0 / +1 |
| `CHANNELS_ALL_FAILED` | 有失败回执=`partial` / Manager `partial` | 是 | `retry_scan` | 情报来源全部失败，重新侦察 | 新 owner full root | +1 / 0 |
| `CHANNELS_PARTIAL_FAILED` | scan/full 当前 attempt=`partial` / Manager `partial`，冻结成功渠道与失败 channel IDs；禁止自动 judge/clean-empty | 是 | `retry_failed_channels` | 部分情报来源失败，重试失败来源 | superseding root/Manager generation+1，只扫描失败 modules；全部成功后合并为新 frozen snapshot 再允许 judge | +1 / 0 |
| `PI_UNAVAILABLE` | 操作=`needs_user` / Manager `needs_user` | 是 | `retry_stage` | Pi 暂不可用，恢复后重试 | superseding root/Manager generation+1 | 按 stage |
| `CHANNEL_CONFIGURATION_REQUIRED`、`CHANNEL_LOGIN_REQUIRED` | 操作=`needs_user` / Manager `needs_user` | 是 | `open_channel_settings` | 配置或登录情报来源 | 不自动创建 | 0 / 0 |
| `MANAGER_ENTRY_FAILED` | root/attempt 接受前仅控制面 receipt=`failed`；不存在 Manager/claim/child | 是 | `retry_managed_entry` | 主管入口失败，请重试 | 显式重试按 root retry invocation CAS 创建新 root；原命令重放仍读原失败 receipt | 0 / 0；legacy 增量 0 |
| `MANAGER_CONTRACT_ERROR` | root/attempt 已接受后：无可信已提交结果=`failed`，有可信已提交结果=`partial`；当前 attempt 与 Manager fenced terminal | 是 | `retry_stage` | 主管任务失败，请重试 | superseding root/Manager generation+1 | 按必填 failedStage；legacy 增量 0 |
| `EFFECT_REUSE_MISMATCH` | consumption=`failed`，Stage D claim/settlement=`failed`，scheduler Manager=`failed` | 是 | `retry_effect` | 复用结果校验失败，重新执行该目标 | 前代 consumption/effect attempt terminal 后显式分配 effectAttemptOrdinal+1；不新建 scan/judge | 0 / 0 |
| `STALE_RESUME_EXPIRED` | 无可读结果=`failed`，有可读部分=`partial` | 是 | `retry_stage` | 重新开始本阶段 | superseding root/Manager，generation+1 | 按已持久 failedStage |
| `RESUME_CONTEXT_INVALID` | 操作/Manager=`failed`；禁止猜测原阶段 | 是 | `start_new_root` | 恢复信息不完整，请重新开始 | Owner 显式新 root/full；scheduler 显式新 root/Stage D | 新 root 按其 stage；原记录零写 |
| `NO_CURRENT_TARGETS` | 仅 Stage D=`skipped`；scheduler Manager=`succeeded + stageStatus=skipped` | 否 | `no_action` | 当前周期没有待派工目标 | 不创建 | 0 / 0 |
| `NO_ELIGIBLE_OPPORTUNITY` | `succeeded` / Manager `succeeded+emptyQualified` | 否 | `no_action` | 今天没有新的内容机会 | 不创建 | 0 / 0 |
| `STARTUP_RECONCILIATION_PENDING` | 操作=`needs_user`；Manager/root 保持原状态 | 是 | `wait_and_retry` | 正在恢复未完成任务，请稍后重试 | 不创建 | 0 / 0 |
| `BARRIER_READY_CONFLICT` | 验收操作=`failed`；两侧 Manager 保持原状态 | 否 | `restart_acceptance_scenario` | 验收场景身份冲突 | 新 barrier scenario | 0 / 0 |
| `ACCEPTANCE_RUNNER_RESTARTED` | acceptance-only scenario/root/claim/dispatch/consumption=`failed`；生产 Manager 保持原状态 | 是 | `restart_acceptance_scenario` | 验收进程已重启，请重新开始验收 | 新 barrier scenario；不复活旧 scenario | 0 / 0 |
| `EXECUTION_AUTHORIZATION_INVALID` | 新执行/接管=`failed`；已终态 receipt 可只读 | 是 | `refresh_workspace` | 执行授权已失效，请刷新 | 不创建 | 0 / 0 |
| `CANCELLED_BY_OWNER` | `cancelled` / Manager `cancelled` | 否（可另选“重新开始”） | `start_new_root` | 已取消；重新开始 | 新 root 仅由 Owner 明确选择 | 按新 root |

`MANAGER_*` 与恢复错误的“有可读部分”判定必须来自同一份 frozen projection/source receipt，不得凭 child 数量猜测。所有 post-accept `MANAGER_CONTRACT_ERROR` 必须在终结事务持久化 `failedStage` 与 `lastCommittedBoundary`；异常观测前已合法提交且仍通过 frozen identity/hash 校验的结果保留并使终态为 `partial`，异常观测后先撤销 claim/job/consumption lease，再禁止任何 child/内容新写。缺失 `failedStage` 时不得猜测重试路径，归一为 `RESUME_CONTEXT_INVALID` 并零写。`REQUEST_REPLAY_CONFLICT`、ownership mismatch 是命令拒绝，不得把 Manager 伪装为新的失败阶段；`cancelled` 必须在同一事务将 root/Manager/claim 置 cancelled、active dispatch 与 consumption 置 `orphaned/CANCELLED_BY_OWNER`、清空 lease 并写 `finished_at`/终态 receipt，再终止外部进程；reconciler 遇到 cancelled ancestor 只能确认终态，不能接管，迟到结果只进 audit 且零业务写。Renderer/preload/global 类型、Manager readback 和 focused tests 必须消费同一 `action`/`retryable` 枚举，不得各自翻译 reasonCode。

Projection 读取、终态判定、Manager checkpoint、task result 和 receipt 写入必须在同一数据库事务中，以同一 scopeHash/projectionHash 和 Manager fenced CAS 完成；其中任一步失败整笔回滚。矩阵之外的 managed 错误统一归一为 `MANAGER_CONTRACT_ERROR`，禁止 fallback；不得出现未列 reasonCode 的可见终态。

`INVALID_NEEDS_REPAIR` 与 `INVALID_REPAIR_VERIFIED` 是同一修复流程的两个可观察状态：前者表示 receipt 缺失、过期或不匹配，只能显示“修复选题资料”；后者表示修复 receipt 已在同一事务通过 item/revision/source 校验并生成不可变 `RepairSnapshotBinding`，才显示“资料已修复，继续评分”并允许 Owner 显式 `retry_judge`。UI、preload、Manager readback 和 focused tests 必须消费这两行，不得把 `repair_or_retry` 当成自动重试。`CHANNELS_PARTIAL_FAILED` 的成功 source/receipt 只作为待合并 snapshot 保存，不能进入 planner Projection、不能 clean-empty；显式 `retry_failed_channels` 先终结旧 root，再由新 superseding root 只扫描失败 modules，全部选定渠道可信后在新 generation 原子冻结合并 snapshot，才允许 judge。超时/contract 类错误的“按 stage”具体展开为唯一增量矩阵：`failedStage=reporter`（`full` 或 `scan` 尚未形成 handoff）→ `retry_stage`、新 superseding root、scan `+1`/judge `0`；`failedStage=planner|settlement`（`full` 已有 frozen source snapshot 或当前 `judge`）→ `retry_stage`、新 superseding root、scan `0`/judge `+1`；Stage D 不计入 scan/judge，均为 `0/0`。任何 post-accept `MANAGER_*` receipt 都必须持久化 `failedStage`；缺失时不得猜测重试阶段，返回 `RESUME_CONTEXT_INVALID` 并零写。

#### 3.2.2 continuation operation 的持久幂等合同

Owner UI 首次创建 Manager/orchestration 时，在同一事务中生成并持久化身份；后续按钮只从 `daily.readiness` 读回该身份，不能每次生成随机根 `requestId`。scan/full 与 judge 使用明确的两层身份：scan/full 的 `stageRequestId` 只由 root identity、attemptStage、modules、watermark、parent 和 generation 生成，初始 `snapshotBindingState='unbound'`，不得依赖尚不存在的 source snapshot；judge 的 `stageRequestId` 必须包含 predecessor 已冻结的 `sourceSnapshotHash/sourceTaskId`。重放先按已持久化的 `stageRequestId` 找原 claim，不能用实时 plan revision 重建 identity。一次阶段操作的规范输入固定为：

```ts
type ScanAttemptPreimage = { workspaceId: string; rootRequestId: string; rootGeneration: number; managerTaskId: string; orchestrationId: string; source: DailyRootSource; businessDate: string; attemptStage: 'scan'|'full'; acceptance: AcceptanceBinding; parentTaskId: string|null; modules: Array<'official_web'|'x_lists'>; selectedChannelIds: string[]; watermark: string; predecessorStageRequestId: string|null; baseSourceSnapshotHash: string|null; retryFailedChannelIds: string[]; retryGeneration: number };
type JudgeAttemptPreimage = { workspaceId: string; rootRequestId: string; rootGeneration: number; managerTaskId: string; orchestrationId: string; source: DailyRootSource; businessDate: string; attemptStage: 'judge'; acceptance: AcceptanceBinding; parentTaskId: string; predecessorStageRequestId: string; sourceTaskId: string; sourceSnapshotHash: string; repairSnapshotHash: string | null; bindingHash: string; frozenPlanScopeSeed: string; retryGeneration: number };
type SnapshotBinding = { stageRequestId: string; sourceTaskId: string; sourceSnapshotHash: string; snapshotJson: unknown; bindingHash: string; status: 'frozen' };
```

scan/full claim 的持久状态固定为 `claimed_unbound → dispatching_scan → snapshot_frozen → dispatching_judge|awaiting_judge → terminal`。扫描 child、receipt 和 `sourceSnapshot` 在同一 `BEGIN IMMEDIATE` 中以 `stageRequestId + ownerEpoch + leaseToken + expected status=dispatching_scan` 绑定到原 claim，并同时写 `sourceTaskId/snapshotHash/snapshotJson`；stageRequestId 不因绑定而改变。绑定前崩溃由同一 claim 接管；旧 child 迟到、重复绑定、hash 不同或 lease/fencing 不匹配均零业务写并记录 audit。judge claim 只能从 `snapshot_frozen/awaiting_judge` predecessor 在同一事务派生；没有 frozen predecessor 统一 `NO_CONTINUATION_MATERIAL`。必须覆盖“scan 已启动未绑定崩溃、绑定后崩溃、旧 child 迟到、judge 与绑定竞争”。

scan/full 必须提供非空、排序去重的 modules/selectedChannelIds 和持久 watermark；首次 scan 的 predecessor/base 为 null、retryFailedChannelIds=[]。`retry_failed_channels` 必须引用原 predecessorStageRequestId/baseSourceSnapshotHash，并把精确失败 channel IDs 排序写入 preimage；两个不同成功基线不得得到同一 stageRequestId。judge 必须提供 frozen predecessor binding，禁止实时 plan revision 进入 identity。`stageRequestId=sha256(canonicalJson({version:1,input:ScanAttemptPreimage|JudgeAttemptPreimage}))`；`requestId=operationRequestId=sha256(canonicalJson({version:1,command,stageRequestId,preimage}))`。SnapshotBinding 永不进入原 scan operation hash；judge 只引用其 frozen hash。共享 API 只导出 `deriveScanAttemptIdentity/deriveJudgeAttemptIdentity`，字段变化必须产生新 identity 或 replay conflict。

retry 允许前态固定为 `failed|partial`，以及错误矩阵明确 retryable 的 `needs_user/PI_UNAVAILABLE`；后者也必须先终结旧 root，再创建 superseding root、generation+1。配置/登录类 needs_user 必须先完成外部条件并发出新的校验 command，不得后台自动 retry。任何旧句中“只有 failed/partial”均按本段扩展解释。

`daily_stage_claims` 最终 schema：`workspace_id,claim_kind,cycle_id,gap_id,claim_scope_key,stage_request_id,request_id,root_request_id,root_generation,root_input_hash,manager_task_id,orchestration_id,parent_task_id,parent_stage_request_id,root_mode,attempt_stage,retry_generation,logical_input_hash,status,is_active,claim_revision,owner_epoch,lease_token,lease_expires_at,acceptance_scenario_id,barrier_id,runner_epoch,snapshot_json,child_ids_json,result_json,created_at,updated_at,finished_at`。生产 claim 的验收字段必须为 `null`；验收 claim 必须与 acceptance barrier 的 scenario/barrier/runner epoch 完整相等。scope：daily=`daily:${workspaceId}:${managerTaskId}:${orchestrationId}:${attemptStage}`（不含 generation）；Stage D=`daily-stage-d-claim:${workspaceId}:${cycleId}`；research=`research:${workspaceId}:${parentTaskId}:${gapId}`。每次 read/reconcile/settle 必须 join root 并逐项校验 rootRequestId/generation/inputHash；terminal 状态必须同事务写 finished_at。scan→judge 交接必须在一个事务中以 predecessor 的 `claimRevision+ownerEpoch+leaseToken+expected status=awaiting_judge|snapshot_frozen` CAS 写入 `succeeded/HANDOFF_CONSUMED`、`is_active=0`、`finished_at`，并创建 judge claim、切换 Manager `activeStageRequestId`；任一步失败整笔回滚。交接完成后 predecessor 不得再出现在 startup selector，迟到 handoff watchdog 只能写 audit。

active 状态固定：daily=`claimed_unbound,dispatching_scan,snapshot_frozen,awaiting_judge,dispatching_judge,settling,running`；stage_d=`claimed,snapshot_frozen,dispatching,settling,running`；research=`claimed,manifest_frozen,dispatching,running`；终态统一=`succeeded,skipped,partial,failed,needs_user,cancelled,orphaned`。`is_active` 由 store 按该枚举同事务维护，并创建 `CREATE UNIQUE INDEX daily_stage_claims_one_active_scope ON daily_stage_claims(workspace_id,claim_scope_key) WHERE is_active=1`。generation N+1 只能在同一事务确认 N is_active=0；lease 过期只能接管 N。旧 running/resume_pending/channel_scanned 按映射迁移，冲突 loser 原位 orphaned。

旧 daily/Stage D claim 冲突也必须在唯一索引前确定性收敛：完整 root/Manager/orchestration/inputHash/snapshot 校验通过者优先，其次状态进度序 `settling > running > dispatching_judge > snapshot_frozen > dispatching_scan > claimed_unbound`，再按 `updated_at DESC, stage_request_id ASC`；仅第一名保留 active，其他写 `orphaned/DAILY_SCOPE_MIGRATION_LOSER`。无合法行则全部 orphaned。迁移重放必须选择同一 winner，并在建索引后读回每 scope 最多一个 active。

旧 research scope 迁移必须在建立唯一索引前同一事务完成。每个 canonical scope 的 winner 排序固定为：完整 manifest/hash 与父 stage/gap/snapshot 校验通过者优先，其次 `updated_at DESC`，最后 `task_id ASC`；仅第一名可回填 workspace/root/parentStage/gap 并改写 canonical claim_scope_key，其他行原位 `orphaned/RESEARCH_SCOPE_MIGRATION_LOSER`。若没有任何通过身份校验的行，则全部 orphaned，不保留 active winner。commit 后按相同排序读回每 scope 最多一个 active winner，并验证所选 taskId；迁移重放必须选择相同结果。所有 claim 写入 CAS 包含 stageRequestId+claimRevision+ownerEpoch+leaseToken+expected status，成功 revision+1。

`retryGeneration=0` 为首次操作；只有 Owner 对 `failed`/`partial` 明确点击重试，才先终结旧 root/Manager，再由 root store 在同一事务内递增 generation 并创建 superseding root，同时派生新的 `stageRequestId`、`requestId`。对 `succeeded`、`waiting_human`、`emptyQualified` 重复点击只读回原结果。相同 stageRequestId/requestId 对应不同 command、rootMode、attemptStage、日期、Manager、orchestration、generation、snapshot 或输入时返回 `REQUEST_REPLAY_CONFLICT`，记录冲突双方摘要，绝不通过换一个 UUID 绕过冲突。验收必须分别证明双击/IPC 重放=同一 stageRequestId、重启重放=同一 attempt、部分写入后重启仍读原冻结 identity、显式失败重试=旧 root terminal + 新 superseding root/generation 和新 stageRequestId。

命令回放必须区分业务输入与本次执行授权：`logicalInputHash` 只包含 command、规范化业务输入、root/Manager/orchestration/parent、attemptStage、snapshot、generation 和 stageRequestId，跨 runtime epoch 保持不变，用于 replay/冲突判断；`executionEnvelopeHash` 才包含 runtimeEpoch、lease、grant 等本次执行字段，只用于执行授权。`command-dispatcher.ts` 的顺序固定为：先按 `requestId` 查 receipt/claim 并比较 logical hash；已终态 receipt 直接只读返回，不因旧 runtime epoch 变成 `WORKSPACE_STALE`；未完成 claim 的恢复或接管才验证新的 execution envelope、lease 和 epoch。logical hash 不同返回 `REQUEST_REPLAY_CONFLICT`，授权无效返回授权错误，二者不得混用。跨 epoch 终态重放、未完成接管和旧 owner 迟到提交都必须有数据库级测试。

### 3.3 因果归属与同日并发模型

本合同选择“同日多 orchestration、每个 orchestration 一个 Manager”的模型：同一 `businessDate` 允许多个不同 orchestration 并发，但每个 `(businessDate, orchestrationId)` 只有一个 Manager；同一 orchestration 的重复启动仍由串行门拒绝/聚焦。Manager 根的 `rootMode` 固定为 `owner` 或 `scheduler`，不能在阶段续接时改变。实现必须把 `manager-task.ts` 的活动唯一性从 `businessDate` 改为 `(businessDate, orchestrationId)`，并为历史按日期活动记录提供一次性迁移/孤儿标记；不得保留按日期找任意 Manager 的兼容 fallback。共享 `agent-tasks.ts` identity selector 固定为 `(intent, businessDate, managerTaskId, orchestrationId, parentTaskId, stageRequestId)`；managed task 缺任一身份字段即拒绝复用，standalone legacy task 走单独 selector 且永不回写 Manager。该 selector 与 claim store 必须先完成并冻结，Manager、Stage D 和 research 才能并发实现。

Owner 与 automation 各自创建并携带不同完整身份。09:00 使用 `source='scheduler_0900',rootMode='scheduler'`；用户 Today 使用 `source='today_ui',rootMode='owner'`，Proposal/MCP/rolling/cycle/reconciler 使用各自 `DailyRootSource` 枚举；不同 source 不能互相同步。所有读取/同步必须传完整 identity。用户 judge 不执行 Stage D；Stage D 每个 generation 只有一个持久 claim。

`rootGeneration` 只由 root store 在 `(workspace,businessDate,rootMode,source)` 域内 CAS 分配。`rootRequestId` 唯一公式为 `sha256(canonicalJson({version:1,workspaceId,businessDate,rootMode,source,requestedAction,logicalInput,acceptance,retryInvocationOrdinal,predecessorRootId}))`；首次固定 ordinal=0/predecessor=null，retry 使用服务端已持久分配值。同一次 command receipt 重放读回同 root，下一次显式 retry 才产生下一 ordinal/generation。任何不含 retry/predecessor 的旧 root preimage 废止。scheduler tick/triggerNow 对同周期使用相同 input；不同 input 返回 root replay conflict。root schema/CAS 以随后 v10/v11 固定段为准，由 WMB-5366 唯一拥有。

`orchestrationId=sha256(canonicalJson({version:1,workspaceId,businessDate,rootMode,source,rootGeneration,rootRequestId}))` 是唯一公式，由共享 `deriveOrchestrationIdentity` 生成；所有 producer、tick、triggerNow 和重放禁止自行拼接。相同 root 必须读回同 orchestrationId，不同 source/generation 必须不同。

Root retry 的线性化边界固定为 `finalizePredecessorRoot CAS → allocate retryInvocationOrdinal/rootGeneration → create superseding root/Manager`，三步必须同一事务完成；任何中途失败整体回滚。新 root 的 `predecessorRootId` 必须指向已终态旧 root，旧 root/Manager 的 status、checkpoint、scope、receipt 和 child 只读不变；新 root 只继承明确列出的 frozen hash/receipt 引用，不继承可变集合。由此“generation+1”永远不是在 terminal Manager 上原位续跑，任何实现若使 terminal root 回到 running 或让 retry 共享旧 managerTaskId，都返回 `MANAGER_CONTRACT_ERROR` 并零业务写。

显式 retry/new-root 使用服务端持久 `retryInvocationOrdinal`，不靠客户端新随机 ID。事务以 `predecessorRootId + requestedAction + expected predecessor status + expected latest rootGeneration` CAS 分配下一 ordinal，并先写 command receipt；同一次点击/IPC 重放携带原 receipt requestId，读回同一 ordinal/root；只有前一 retry root 已终态且 Owner 再次对“当前最新终态 root”发出新命令，才分配 ordinal+1。`retryInvocationOrdinal`、`predecessorRootId` 和 supersedes identities 必须进入 root canonical input、root row 和 receipt。

`daily_orchestration_roots` 的 v10 固定 schema 以此处为准：`workspace_id,business_date,root_mode,source,root_generation,orchestration_id,manager_task_id,root_request_id,root_input_hash,retry_invocation_ordinal,predecessor_root_id,status,checkpoint_revision,owner_epoch,lease_token,lease_expires_at,acceptance_scenario_id,barrier_id,runner_epoch,last_business_progress_at,supersedes_manager_task_id,supersedes_orchestration_id,supersedes_stage_request_id,created_at,updated_at,finished_at`。生产 root 的验收字段必须为 `null`；只有 `acceptanceMode=true` 的验收 root 才能填写三者，且必须与 barrier 一致。root canonical input 固定为 `{workspaceId,businessDate,rootMode,source,requestedAction,logicalInput,acceptance,retryInvocationOrdinal,predecessorRootId}`；首次 root ordinal=0/predecessor=null。root 更新 CAS 固定为 `root_request_id + checkpoint_revision + owner_epoch + lease_token + expected status`，业务进展字段只能由成功业务提交事务更新。

v11 将 root generation/CAS 域固定为 `(workspace_id,business_date,root_mode,source)`；唯一键是 `(workspace_id,business_date,root_mode,source,root_generation)`，并保留 orchestrationId/rootRequestId 唯一。每个 source 独立从 generation 0 分配，因此 Today/Proposal/MCP 并发顺序不影响 identity；前文缺 source 的旧唯一键废止。必须做同日双 owner source 并发创建测试。

Manager `agent_tasks` 的 fencing 固定使用数据库列 `checkpoint_revision,owner_epoch,lease_token,lease_expires_at,active_stage_request_id`，不得选择性只藏在 JSON；checkpoint JSON 只保存业务快照。迁移/store 由 WMB-5366 唯一拥有。

Manager checkpoint 的 `lastCommittedBoundary` 固定为 `{version:1,stageRequestId,failedStage,stageClaimRevision,managerCheckpointRevision,childIds:sorted,effectConsumptionKeys:sorted,planScopeHash,projectionHash,committedAt}`。它只能由成功提交 child/result/scope/projection 的同一数据库事务，以新的 stageClaimRevision 与 managerCheckpointRevision 写入；跨进程业务提交必须先落 managed dispatch/consumption，再由 Manager fenced consumer 事务更新 boundary。异常处理只保留能由 boundary 中 ID/hash/revision 逐项读回的结果；boundary 前/后 failpoint 测试必须证明不重复派工、不丢已提交结果。缺失或读回不一致统一 `RESUME_CONTEXT_INVALID`。

所有 managed job 使用既有 JSON 元数据持久化（standalone/legacy job 若缺字段只能进入 orphan/audit，不得回写任意 Manager）：

```text
managerTaskId
orchestrationId
parentTaskId
businessDate
attemptStage
stageRequestId
requestId
retryGeneration
effectRequestId (Stage D child only)
operationRequestId
```

`operationRequestId` 唯一且严格等于该 Manager attempt 的 `requestId`，只用于 causation、归属和 Manager 同步；不得在任何层将 `stageRequestId` 当作 `operationRequestId`。`effectRequestId` 是 Stage D 单 target/role 的业务副作用幂等键，只用于防止跨 orchestration 重复生产。`retryGeneration`、`operationRequestId` 和 `effectRequestId` 在 `RoleJobRequest/RoleJobSpec/JobInput/JobRecord/job-object-boundary/agent task/event/receipt` 中都是独立字段，禁止丢弃、别名或二选一；非 Stage D job 的 `effectRequestId=null`。Manager 同步同时校验 operation identity 和 `retryGeneration`；副作用执行和 command receipt 只按 effect identity CAS。若 `operationRequestId` 缺失或不等于 `requestId`，必须返回 `MANAGER_OPERATION_IDENTITY_MISMATCH` 并零写。

Manager 自身的 `context_refs_json` 是归属 SSOT，子 job/task 必须复制同一 `managerTaskId`、`orchestrationId`、`attemptStage`、`stageRequestId`、`retryGeneration` 和 `requestId`。`syncManagerTaskFromJob()` 只接受同时满足以下条件的 job：

1. `managerTaskId` 等于目标 Manager，并能由 `getManagerTaskById` 精确读回；
2. `orchestrationId`、`attemptStage`、`stageRequestId`、`retryGeneration`、`requestId` 与 Manager 当前 attempt 记录一致；
3. parent/child 关系可从持久数据读回，且 child 的 task/job 身份一致；
4. `businessDate` 相同只能作为校验，不能作为归属依据；
5. 没有这些字段的 legacy job 只能进入 orphan/audit 统计，不得绑定到当天任意 active Manager。

缺失或冲突的归属必须拒绝同步并记录稳定原因 `MANAGER_OWNERSHIP_REQUIRED` 或 `MANAGER_ORCHESTRATION_MISMATCH`，不得“找当天任意 active manager”。

归属字段的贯通由同一实现任务负责，不能只改通知器：`wmb_spawn_job` 的 MCP schema → `RoleJobRequest/RoleJobSpec` → `JobInput/JobRecord` → `job-object-boundary` 持久 envelope → `agent_tasks.context_refs_json` → job event/report → `syncManagerTaskFromJob()` readback，必须逐段保留上述字段和 `parentTaskId`。WMB-5368 的 focused test 从 spawn 输入开始，读回 JobPool/持久事件、agent task context、Manager checkpoint，且覆盖跨 Manager 和缺字段零写。

普通 managed job 采用持久 reserve-before-spawn 边界。新增 `managed_job_dispatches(workspace_id,job_id,effect_request_id,effect_logical_key,effect_attempt_ordinal,operation_request_id,manager_task_id,orchestration_id,parent_task_id,parent_stage_request_id,root_request_id,root_generation,root_input_hash,expected_parent_claim_revision,expected_parent_owner_epoch,expected_parent_lease_token,stage_request_id,retry_generation,acceptance_scenario_id,barrier_id,runner_epoch,agent_task_id,state,result_status,result_hash,owner_epoch,lease_token,lease_expires_at,envelope_json,result_json,created_at,updated_at,finished_at)`，唯一键 `(workspace_id,job_id)`、非空时 `(workspace_id,effect_request_id)`。生产 dispatch 的验收字段为 `null`；验收 dispatch 必须与 barrier 完整绑定。状态固定 `reserved→task_bound→spawn_started→running→terminal|orphaned`，`result_status` 固定 `succeeded|failed|partial|cancelled` 且仅 terminal 可非空；`result_hash=sha256(canonicalBusinessJson({version:1,resultStatus,resultJson}))`，terminal 的 status/hash/resultJson 不可变，不同写返回冲突。只有 `state=terminal && result_status=succeeded && result_hash/result_json` 完整匹配的 dispatch 可被 effect consumption 复用；failed/partial/cancelled/缺结果一律不可复用。同一事务先 reserve envelope 并创建/bind agent task，提交后才启动进程；启动成功 fenced CAS 写 running。reserve、bind、spawn、每个 event/result 和每个业务 mutation 都必须以 `root_request_id+root_generation+root_input_hash+parent_stage_request_id+expected_parent_claim_revision+expected_parent_owner_epoch+expected_parent_lease_token` join 在线 parent root/stage claim；父 stage/root 已 terminal、superseded、cancelled 或 claim revision/epoch 不匹配时立即 `orphaned`/稳定错误，禁止启动或业务写。父 retry/supersede/cancel 必须同事务级联终结 active dispatch、撤销 lease 并终止可证明属于该 dispatch 的进程；无法证明进程身份则 orphaned，不能盲目重派。崩溃在 reserve/task_bound 时由 reconciler 只在 parent fence 仍有效且 startup gate 完成后幂等启动；进程已启动但 running 未写时以 agent task/session handle 认领，不得启动第二个；事件到达但 Manager 未提交时事件/terminal result 留在 dispatch row，由 Manager fenced consumer 重放；接管后旧 epoch/lease 迟到事件零业务写。WMB-5366 拥有表/迁移，WMB-5368 拥有 store 接入和 reserve/bind/spawn/reconcile failpoint tests。

普通 managed job 的确定性 child identity 以本段补充为准：`childOrdinal` 是同一 operation/role 下由服务端事务分配并写入 parent claim 的稳定序号；`childIdentityKey=sha256(canonicalJson({operationRequestId,parentTaskId,roleId,childOrdinal}))`。同一次重放复用原 ordinal，只有合同明确允许的第二 child 才分配下一 ordinal。`managed_job_dispatches` 额外包含 `child_identity_key,child_ordinal,role_id`，唯一键 `(workspace_id,child_identity_key)`；调用方换 jobId 不能绕过它创建第二个 child。

Stage D effect 的失败重试使用独立、持久的逻辑身份。`effectLogicalKey=sha256(canonicalJson({version:1,workspaceId,cycleId,targetId,targetRevision,targetContentHash,planItemId,planItemRevision,planItemContentHash,roleId,action}))`；`action` 是冻结的业务副作用类型，不能在重启或 retry 时静默改变；`effectAttemptOrdinal` 首次固定为 0。`succeeded` effect 在后续 orchestration 中直接复用既有 result，不再派 child；`failed/orphaned` 只有收到显式 retry 命令时，才能在前代已 terminal 且无 active attempt 的条件下以事务 CAS 分配 `effectAttemptOrdinal+1`。同一次 retry 命令重放必须读回原 ordinal，调用方不得自报或跳号；前代 active 时禁止下一 attempt。`effectRequestId=sha256(canonicalJson({version:1,effectLogicalKey,effectAttemptOrdinal}))`，唯一键同时约束 `(workspace_id,effect_logical_key,effect_attempt_ordinal)`。新 attempt 接管后，旧 child 的 epoch/lease 迟到事件只写 audit，业务与 result 均零写。

`retry_effect` 不复活旧终态。它以旧 Stage D settlement 为 predecessor，创建新的 scheduler root/Manager 和 target-scoped Stage D generation；新 `StageDAttemptInput` 使用同一 cycle 的当前冻结 targetSetHash，并额外持久 `retryTargetIds=[targetId]`、`predecessorStageRequestId`、`predecessorEffectRequestId`，派生新的 operationRequestId/stageRequestId，claim active 后才 CAS 分配下一 effectAttemptOrdinal。新 settlement 只覆盖 retryTargetIds，并引用旧失败 consumption；同一 retry command 重放读回同一新 root/claim/ordinal。target/plan item hash 已变化时不得 retry 旧 effect，返回 `TARGET_SNAPSHOT_STALE` 并要求新 cycle/root。

effect 的执行事实与每个 orchestration 的消费事实分表持久化，禁止修改原 dispatch 来伪装新归属。新增 `managed_effect_consumptions(workspace_id,operation_request_id,effect_request_id,manager_task_id,orchestration_id,stage_request_id,source_dispatch_job_id,source_result_hash,acceptance_scenario_id,barrier_id,runner_epoch,state,consumption_revision,expected_stage_claim_revision,owner_epoch,lease_token,lease_expires_at,error_json,created_at,updated_at,finished_at)`，唯一键 `(workspace_id,operation_request_id,effect_request_id)`。生产 consumption 的验收字段为 `null`；验收 consumption 必须与 barrier/root/claim 一致。状态固定为 active=`reserved,consuming`，terminal=`consumed,failed,orphaned`；consumption 自身的 reserve/consume/fail/takeover 使用 `operation_request_id+effect_request_id+expected state+consumption_revision+owner_epoch+lease_token` CAS，成功只递增 `consumption_revision`。`expected_stage_claim_revision` 是 reservation 时观察到的 Stage D claim 版本，只用于向 claim/settlement 附加 consumption key；该附加操作另以 Stage claim 的 expected revision CAS，竞争失败必须重读 claim 并重试，绝不能由 consumption CAS 暗改 Stage claim revision。产生 effect 的 operation 和之后复用成功 effect 的 operation 都必须各写一条自己的 consumption；写入前在同一事务校验 source dispatch 为 `terminal+succeeded`、effectRequestId 与 canonical result hash 匹配，并以当前 stage claim epoch/lease CAS `reserved→consuming→consumed`。后续 orchestration 只新增自己的 consumption 并在自己的 settlement 引用它，不改 A 的 dispatch/consumption；重放读回 B 原 consumption。进程在 reserve/consuming 后崩溃时 startup reconciler 必须枚举该 active 行：lease 未过期等待，过期后以新 epoch/token 接管同一行，重新校验 source dispatch/result 后消费或终结 `failed/orphaned`，不得创建第二行；旧 token 迟到零写。source result 不成功、hash 不符或无法证明 source dispatch 时由 `failManagedEffect` 写 `EFFECT_REUSE_MISMATCH` 并终结 consumption/Stage D/Manager，内容业务零写。WMB-5366 拥有表/迁移与 `reserve/consume/fail/takeover/reconcile/readManagedEffect` API，WMB-5369 只通过该 API 消费。

daily producer 清单为封闭 allowlist，新增入口必须先改合同：

| Producer | rootMode/source | 唯一路径 | Owner |
|---|---|---|---|
| Today/Proposal UI | `owner/today_ui|proposal_ui` | RootCreate→DailyStage | WMB-5367 |
| MCP 显式人机请求 | `owner/mcp` | RootCreate→DailyStage；禁止 legacy fallback | WMB-5368 |
| 09:00 scheduler | `scheduler/scheduler_0900` | RootCreate→StageDAttempt | WMB-5369 |
| `daily-scan-scheduler.ts` / `workspace-intelligence.ts` | `scheduler/rolling_scan` | RootCreate→full；不得直接 judgeOnly | WMB-5369 |
| `ipc-daily-content-cycle.ts` | `scheduler/content_cycle` 或显式 owner identity | 只能调用共享 root/claim API | WMB-5369 |
| orphan/reconcile producer | `scheduler/orphan_reconcile` | 只恢复原 identity，不创建无前代 full/judge | WMB-5370 |

静态测试枚举 `startDailyIntelligence/dispatchManagerDailyIntelligence/runDailyOrchestration/dispatchStartAgentTask` 的所有生产调用者；allowlist 外调用失败。上述文件各由表中 owner 独占；不携带完整 root/attempt identity 的旧 producer 必须禁用并以负例证明 scan/judge 增量为 0。

### 3.4 研究资料快照与 09:00 自动编排

扫描完成进入 `channel_scanned` 时，在该 scan task 的 `checkpoint_json`/`result_refs_json` 持久化不可变 `sourceSnapshot`：

```json
{
  "selectedChannelIds": ["..."],
  "successfulChannels": [{"channelId":"...","receiptId":"..."}],
  "failedChannels": [{"channelId":"...","reasonCode":"..."}],
  "sourceIds": ["..."],
  "sourceRevisions": {"source-id": 3},
  "sourceContentHashes": {"source-id": "derive content_hash"},
  "receiptIds": ["..."],
  "receiptRevisions": {"receipt-id": 1},
  "receiptPayloadHashes": {"receipt-id": "derive payload_hash"},
  "capturedAt": "...",
  "watermark": "...",
  "snapshotHash": "deriveSourceSnapshotHash(preimage)"
}
```

`canonicalBusinessJson` 的规范固定为：对象键递归字典序，字符串 Unicode NFC，缺失字段转显式 `null`，时间转 UTC ISO，数值使用 JSON 最短十进制；语义为 set 的数组按 stable ID/hash 排序去重，语义有序数组保持顺序。Source 持久 `content_json` 必须覆盖除 `revision/content_hash/created_at/updated_at` 外的完整业务 payload（包括身份、source type/platform/url、title/author/publishedAt、summary/body、evidence、categories/topics/tags、source/provenance refs 和业务 metadata）；receipt 持久 `payload_json` 必须覆盖除 `revision/payload_hash/created_at/updated_at` 外的完整业务 payload（channel/status/source IDs、error、metrics、provenance、started/finished）。`content_hash=sha256(canonicalBusinessJson({version:1,contentJson}))`，`payload_hash=sha256(canonicalBusinessJson({version:1,payloadJson}))`；terminal receipt payload 不可变。

`canonicalJson` 与 `canonicalBusinessJson` 使用同一个规范化引擎；区别仅在于前者输入是本合同明确列出的 identity preimage，后者输入是完整业务 payload。所有派生值只允许调用共享 registry，以下公式覆盖正文任何模糊写法：

```ts
sourceSnapshotHash = H({version:1, workspaceId, businessDate, sourceTaskId, watermark,
  selectedChannelIds: sorted, successfulChannels: sorted[{channelId,receiptId,receiptRevision,receiptPayloadHash}],
  failedChannels: sorted[{channelId,reasonCode}], sources: sorted[{sourceId,sourceRevision,sourceContentHash}]})
repairSnapshotHash = H({version:1, predecessorScopeHash, sourceSnapshotHash,
  repairedPlanItemIds: sorted, priorItemRevisions: sortedEntries,
  repairedItemRevisions: sortedEntries, priorItemContentHashes: sortedEntries,
  repairedItemContentHashes: sortedEntries, repairReceiptIds: sorted,
  repairReceiptRevisions: sortedEntries, repairReceiptPayloadHashes: sortedEntries})
bindingHash = H({version:1, predecessorStageRequestId, sourceTaskId, sourceSnapshotHash, repairSnapshotHash})
frozenPlanScopeSeed = H({version:1, predecessorStageRequestId, bindingHash})
scopeHash = H({version:1, workspaceId, stageRequestId, managerTaskId, orchestrationId,
  businessDate, attemptStage, sourceSnapshotHash, repairSnapshotHash, bindingHash, scopeJson})
projectionHash = H({version:1, workspaceId, stageRequestId, scopeHash,
  bindingHash, repairSnapshotHash,
  entries: sorted[{planId,planItemId,planDate,origin,itemRevision,itemContentHash,classification,scoreHash,
    sourceReceiptIds,sourceReceiptRevisions,repairReceiptIds,repairReceiptRevisions,sourceRefsHash}]})
targetSetHash = H({version:1, workspaceId, cycleId,
  targets: sorted[{targetId,planItemId,targetRevision,targetContentHash,planItemRevision,planItemContentHash}]})
effectSetHash = H({version:1, workspaceId, cycleId, targetSetHash,
  coverage: 'all' | 'retry_subset', retryTargetIds: sorted,
  effects: sorted[{targetId,targetRevision,targetContentHash,planItemId,planItemRevision,
    planItemContentHash,roleId,action,effectLogicalKey,effectAttemptOrdinal}]})
settlementHash = H({version:1, workspaceId, businessDate, orchestrationId,stageRequestId,
  terminalStatus,targetSetHash,effectSetHash,settlementTargetIds:sorted,
  effectConsumptions:sorted[{operationRequestId,effectRequestId,sourceResultHash}],resultJson})
```

`H(x)=sha256(canonicalJson(x))`。`capturedAt/createdAt/updatedAt` 不进入上述 identity；只作为审计时间。`targetSetSeed` 是 `targetSetHash` 的废弃旧名，类型/API/表中统一只保留 `targetSetHash`。共享 registry 导出 `deriveSourceSnapshotHash/deriveRepairSnapshotHash/deriveBindingHash/derivePlanScopeSeed/derivePlanScopeHash/deriveProjectionHash/deriveTargetSetHash/deriveEffectSetHash/deriveSettlementHash`，禁止各 producer 自算；每个函数必须有跨进程固定向量测试。`effectSetHash` 的 `coverage='all'` 必须覆盖冻结 target 的全部 effect；`coverage='retry_subset'` 只能覆盖 `retryTargetIds`，且每个 effect spec 的 role/action/effectLogicalKey/ordinal 在 claim 前冻结。role/action 不得在 dispatch 或重启时根据实时 research claim 重新决定；若业务需要研究结果决定角色，角色决定输入及其 hash 必须先写入 target snapshot，再由 registry 派生 effect set。

`judge` 必须接收并校验这份快照，只按 `sourceIds + sourceRevisions + sourceContentHashes + receiptIds + receiptRevisions + receiptPayloadHashes` 读取；judge 开始后新增的 source/receipt、重新查询的近 24 小时资料和前一日资料均不得进入本轮。所有 source 内容和 receipt payload 的正式 mutation 只能通过共享 store，并在同一事务更新完整 JSON、递增 revision、重算上述 hash；judge 同时比较 revision 与 hash，任一变化或“内容变化但 revision 未变”的 legacy/corruption 情况都返回 `SOURCE_SNAPSHOT_STALE`，不静默重扫；没有成功 receipt 的快照返回 `NO_CONTINUATION_MATERIAL`。迁移为旧行计算初始 hash，任何绕过共享 store 的正式写入由静态测试拒绝。

渠道聚合优先级固定为：任一 selected channel 为配置/登录阻塞→`CHANNEL_CONFIGURATION_REQUIRED|CHANNEL_LOGIN_REQUIRED`；否则 Pi 全局不可用→`PI_UNAVAILABLE`；否则成功与普通失败混合→`CHANNELS_PARTIAL_FAILED`；全部普通失败→`CHANNELS_ALL_FAILED`；全部成功才允许 judge。每条 channel receipt 都持久 status/reason，重启只按 snapshot 的 selected/successful/failed 集合恢复，禁止从 modules 粗粒度反推。配置/登录解除后仍走引用 base snapshot 的 `retry_failed_channels`，不重扫成功渠道。

Stage D 的输入必须来自当前 `daily_content_cycle` 持久化的 targets/plan item IDs。只允许对该集合派 writer/reporter。

workspace 边界不依赖“一库只有一个 workspace”的隐含假设：`daily_content_cycles` 与 `daily_content_targets` 必须持久 `workspace_id`，所有 cycle/target/plan scope 查询和唯一键都以 workspaceId 开头。迁移先按可读 provenance（现有 workspace_id、root/plan/source/receipt 所属 workspace 与 data-root enrollment）做 preflight；只有所有可验证外键一致且唯一指向当前 `app_meta.workspace_id` 的行才回填。归属冲突或无法证明的历史行写 `migration_status='orphaned' / WORKSPACE_PROVENANCE_UNKNOWN`，不进入 active 查询；绝不把整库盲填为当前 workspace。跨 workspace cycle/target 绑定返回 `MANAGER_ORCHESTRATION_MISMATCH`、零写。

Stage D 身份只允许调用 §3.1 的 `deriveStageDAttemptIdentity(StageDAttemptInput)`；本节只补充 `claimScopeKey=daily-stage-d-claim:${workspaceId}:${cycleId}`。任何其他 StageDAttemptRequest/hash 公式均废止；`operationRequestId` 严格等于该派生结果的 requestId，`stageDGeneration=retryGeneration`。

Stage D 在 claim 成功前必须冻结完整的 `StageDEffectSpec[]`，不得在 dispatch、重启恢复或 settlement 时重新查询实时 research claim/approved 全库来决定角色：

```ts
type StageDEffectSpec = {
  targetId: string;
  targetRevision: number;
  targetContentHash: string;
  planItemId: string;
  planItemRevision: number;
  planItemContentHash: string;
  roleId: string;
  action: 'research' | 'write' | 'review';
  effectLogicalKey: string;
  effectAttemptOrdinal: number;
};

type StageDEffectSet = {
  coverage: 'all' | 'retry_subset';
  targetSetHash: string;
  retryTargetIds: string[];
  effects: StageDEffectSpec[];
  effectSetHash: string;
};
```

`StageDEffectSet` 与 target snapshot 在同一 claim 事务冻结并写入 `snapshot_json`；`coverage='all'` 时 `effects` 必须一一覆盖冻结 target，`coverage='retry_subset'` 时只能覆盖排序后的 `retryTargetIds`，且不能包含其他 target。每个 spec 的 role/action、target/plan item 三元组、logical key 和服务端分配的 ordinal 均参与 `effectSetHash`。普通首次执行的 settlement `settlementTargetIds` 必须等于全部冻结 target；`retry_effect` 的新 claim 只允许等于 retry 子集，settlement 只验证该子集，并同时引用 predecessor settlement/failed consumption。若 effect 集合或 coverage 与 claim snapshot、`effectSetHash` 或 settlementTargetIds 不一致，返回 `EFFECT_REUSE_MISMATCH`，Stage D/Manager fenced 终结，业务零写；不得用完整 targetSetHash 掩盖子集 retry。
effect set 的生成顺序固定为：先由共享 effect store 在 predecessor/target fence 下为每个 logical key 读回或 CAS 分配 `effectAttemptOrdinal`，再计算 `effectSetHash`、`stageRequestId` 和 `requestId`，最后创建 Stage D claim；因此 `effectSetHash` 不反向依赖 stage/claim identity。相同 retry command 重放复用已分配 ordinal，只有 predecessor settlement 已 terminal 且 Owner 明确 retry 才分配下一 ordinal；任一分配或 claim 失败均零业务写。

每个 target 持久 `target_content_hash=sha256(canonicalBusinessJson({version:1,targetJson}))`；`targetJson` 覆盖除 revision/hash/时间外的完整 target 业务字段。`targetSetHash` 只调用 §3.4 的 `deriveTargetSetHash`，targets 按 targetId 稳定排序。`effectRequestId` 只使用 §3.3 的 `effectLogicalKey + effectAttemptOrdinal` 唯一公式，本节不再定义第二套公式；任何不含 ordinal 的旧 effect 公式及字符串拼接公式明确废止。必须用构造边界碰撞 fixture 证明不同字段对象不碰撞，并证明显式失败重试得到新 ID。

- 创建/补齐 `daily_content_targets` 时，必须在同一事务先得到确定的 `plan_item_id`，并写入 target；`new_content` target 缺失绑定、绑定的 plan 不属于该 cycle 的 `plan_id` 或绑定的 source 不一致时，Stage D=`failed / CURRENT_TARGET_BINDING_MISSING`，不得按 source 反查或猜测一对多关系。
- target snapshot 同时冻结关联 `planItemId/planItemRevision/planItemContentHash`；StageHandler 只能按这组三元组读取 plan item，不能重新读取“当前版本”。plan item revision 或 canonical content hash 任一变化均 `TARGET_SNAPSHOT_STALE`，不得把新内容送入旧 target。targetSetHash/effectLogicalKey/settlement 都必须携带该 plan item 三元组。
- Stage D 以本节定义的 hash `stageRequestId` 在 `daily_stage_claims` 做 CAS，以明文 `claimScopeKey` 做跨 generation active 唯一；`stageDGeneration=0` 为首次运行，只有显式 scheduler 重试且上一次为 `failed/partial`，或明确形成了新的 target 集合时才递增。通用 `cycleRevision` 变化不能暗自开启新 generation。同一 workspace/cycle 跨所有 generation 只能有一个非终态 claim；generation+1 只能在 N 已原子终结、旧 lease 失效且新 target set 经显式授权后创建。数据库以 `(workspace_id,claim_scope_key)` active 唯一保证，进程内 Map 仅作优化。claim 成功后冻结包含 targetRevision+targetContentHash 的完整 target snapshot；revision 或 hash 任一变化（含内容变但 revision 未变）返回 `TARGET_SNAPSHOT_STALE`；无 target 为 `skipped/NO_CURRENT_TARGETS`，已处理 target 按 effectRequestId 幂等读回；重启只读 claim snapshot，不重新计算。
- 每个 target child 同时持久化两个不可混用的身份：`effectRequestId` 只调用本节 versioned canonical object 公式；`operationRequestId` 严格等于 Manager attempt requestId。target 冻结后变化返回 `TARGET_SNAPSHOT_STALE`；业务副作用在同一事务以 effectRequestId、workspace/cycle/target/revision 和 claim revision/epoch/lease 做 CAS。Job/task/event/receipt 读回两种 ID；旧字符串拼接公式全文废止。
- 只按冻结集合查询，禁止使用 `WHERE planning_status='approved'` 无 cycle 条件查询全库；冻结后新加入 cycle 的 target 留给下一轮。
- 用户流程与定时流程同日重叠时，各自的 Manager/orchestration/children 必须完全隔离。

`daily-orchestration-scheduler.ts` 是 Stage D 生产 owner。09:00 和 `triggerNow` 必须先创建或读回 `rootMode=scheduler` 的 scheduler orchestration root，再取得 `daily_stage_claims` 的 lease。`orchestrationId` 的确定性输入固定包含 `workspaceId + businessDate + rootMode + source + rootGeneration`；jobId 还包含 orchestrationId，Owner 与 scheduler 同日不得相同。settlement 唯一键固定为 `(workspaceId,businessDate,orchestrationId,stageRequestId)`，禁止只用 workspace+日期覆盖另一 root。settlement 的持久状态序列固定为 `claimed → snapshot_frozen → dispatching → settling → terminal`；只有 `terminal` 可对外报告完成，`succeeded/skipped/failed/partial/cancelled` 一旦写入不得被任何 token 改写或回退。settlement 写入必须在同一事务以 `stage_request_id + owner_epoch + lease_token + expected claim status` 做 fenced CAS；terminal settlement 的 `effectConsumptionKeys` 必须完整列出冻结 target 对应的 `(operationRequestId,effectRequestId)`，并在同一事务验证每条 consumption=`consumed`、sourceResultHash 匹配当前 target/result；缺失、active、failed 或 hash 不符时不得 terminal。CAS 失败只写 audit event 且业务写入为零，终态后同一 `stageRequestId + settlementHash` 只能幂等读回原结果，hash 不同返回冲突。`settlementHash`、effectConsumptionKeys、owner epoch、lease token、stageRequestId 和 causation IDs 必须进入 settlement readback。`OrchestrationContext` 和每个 StageHandler 必须携带并写回 `managerTaskId/orchestrationId/rootMode/attemptStage/stageRequestId/operationRequestId/claim ownerEpoch+leaseToken`；A-E、settlement 和 mutation 任一步缺身份都 fail closed。scheduler 启动、Stage C 后崩溃重启、双连接竞争和已完成 cycle 重放都从持久 claim 恢复，最多一个 D child 集合；只有明确允许的 generation+1 才能建立新 claim。

Stage D 入口一次性冻结并读回 `cycleId/cycleRevision/targetIds/planItemIds/targetRevisions/targetContentHashes/targetSetHash`；以后只消费该 snapshot。overlap barrier 只属于显式 `acceptanceMode=true` 的安装验收控制面，正常生产调度不创建、不等待也不读取它；验收 runner 崩溃后由 runner 自己把非终态 scenario fenced 终结 `failed/ACCEPTANCE_RUNNER_RESTARTED`，不得由生产 startup reconciler 恢复并触发业务派工。barrier schema 固定为 `orchestration_overlap_barriers(barrier_id, workspace_id, business_date, scenario_id, expected_app_asar_hash, expected_data_root, owner_ready_json, scheduler_ready_json, release_json, status, revision, release_epoch, release_token, owner_consumed_at, scheduler_consumed_at, created_at, released_at, failed_at)`，canonical `barrier_id=sha256(canonicalJson({workspaceId,businessDate,scenarioId,buildHash}))`；创建 scenario 时冻结 expected app.asar hash、规范化 data-root、runner epoch，ready/consume 必须逐项匹配，错误 build、PID、epoch 或 data-root 返回 `BARRIER_READY_CONFLICT` 且零 dispatch。状态机固定为 `collecting→released→consuming→consumed`，以及 `collecting→cancelled|failed`、`released→failed`、`consuming→failed`；只有 acceptance runner 的当前 epoch 可将 released/consuming fenced 失败为 `ACCEPTANCE_RUNNER_RESTARTED`，普通业务取消/超时不能静默覆盖已释放 token。ready/release/consume/cancel/fail 每次都必须带 expected revision，成功后 revision+1；Owner 和 scheduler 各自再以 token、side、expected own consumed_at IS NULL 做独立 CAS ack。两侧 ready 后验收器只写一次 release；第一侧 ack 把 released 变 consuming，第二侧 ack 把 consuming 变 consumed；任一侧不能消费对方 slot，重复 ack 只读回。每侧完成自己的 ack 后才进入验收触发的真实 dispatch，因此两侧都可消费同一 release 而不会互斥失败。runner 在一侧 ack/dispatch 后崩溃时，fail API 必须原子阻止另一侧 ack，并把 acceptance-only Manager/claim/child 置 `cancelled` 或终态失败；已合法提交的观察前记录保留为 audit，观察后不得有新增业务写，不能留下 consuming 悬挂。每个 ready/consume receipt 必须写完整 root/attempt identity、ownerEpoch、pid、buildHash、dataRoot 和时间；barrier store/迁移由 WMB-5366 所有，WMB-5367 实现 Owner 挂点，WMB-5369 实现 scheduler 挂点；验收读回两个 ready、一个 release、两个 consume 或一个 failure、每次 revision、重叠区间和完整 causation IDs。terminal settlement 的 `effectConsumptionKeys` 不要求机械覆盖全部 target，而必须精确覆盖同一 claim snapshot 的 `settlementTargetIds`：首次 `coverage='all'` 等于全部冻结 target，retry `coverage='retry_subset'` 等于 `retryTargetIds`；该集合和 `effectSetHash` 在同一 fenced settlement 事务校验。

settlement 的状态转移也固定为 `claimed→snapshot_frozen→dispatching→settling→terminal`；`terminal` 只允许相同 `settlementHash` 的只读重放，任何同 token 的不同终态、retry 原位覆盖、旧 epoch/lease 更新都返回稳定冲突并零业务写。`terminalStatus` 仅允许 `succeeded|skipped|failed|partial|cancelled`，不存在另一个 `settled` 状态；每种终态只由前一状态按该序列进入，不存在 `partial→succeeded` 的原位覆盖；修复或重试必须新 claim/新 generation。WMB-5366 的 settlement CAS API 返回状态序列冲突，WMB-5369 负责在 child 迟到时重读 claim revision 后重试，而不是使用旧 revision 结算。

### 3.5 真实机会数

`settleDailyStage` 的 v13 CAS 必须携带 `expectedClaimRevision`；完整谓词为 `stageRequestId+expectedClaimRevision+ownerEpoch+leaseToken+expected status`，成功后 revision+1。child 先提交导致 revision 变化时，settlement 必须重读全部 child/result 后重试，不能用旧 revision 提前终结。

barrier ready slot 采用 first-writer-wins：每侧以 `readyReceiptId=sha256(canonicalJson({version:1,barrierId,side,stageRequestId}))` 绑定逻辑 identity；ownerEpoch/leaseToken 仅进入 fenced CAS envelope，不进入 receipt ID。同一 acceptance runner epoch 重放同一 ready 读回原 slot；runner 重启必须先 fenced 终结旧 scenario 为 failed，再使用新 scenarioId，不得跨 epoch 继续旧 release；不同 stage/root 覆盖返回 `BARRIER_READY_CONFLICT`。barrier 行带 revision，所有 ready/release/consume 校验 revision 和 acceptance runner epoch/token。

`opportunityCount` 只能来自同一 businessDate 的 Today Recommendation Projection 的 `eligible.length`（即 `planning_status='ready_for_review'`、共享 `validateProposalCompleteness` 通过、六维 `propagation_v2` 评分有效、source 可读且未过期的条目），UI、Manager readback、Today 经营指标复用同一个投影读取函数。若 projection 为零，必须读回 `emptyQualified`/`scoring_incomplete`/`invalid_needs_repair`/`run_active` 的具体原因，不能用 child 成功数代替。

成功 child 数、扫描保存数、历史 approved 总数都不是机会数。UI、Manager readback 和数据库查询必须一致；已批准条目不再次计入“待批准机会”。

### 3.6 研究运行生命周期

- 临时工作目录在 spawn 前创建，传给 Pi/研究子进程，并在进程确认退出、stdout/stderr drain 和 session 写入完成后才清理；异常退出也必须先等待/杀死该进程再 `rm`。cwd 提前删除的实验必须失败而不留下假成功。
- research 使用 §3.1 的 `ResearchAttemptPreimage`、`deriveResearchAttemptIdentity()` 和两条 canonical hash 作为唯一身份来源；本节不允许重新枚举字段或拼接字符串。attempt row 的 `stage_request_id` 严格等于 §3.1 的 `researchStageRequestId`，`request_id=operation_request_id=researchRequestId`，`logical_input_hash=researchStageRequestId`；runtime epoch/lease/grant 只进入 execution envelope。start 前先按完整 identity CAS 复用或拒绝，禁止先按 `intent+businessDate` 拿到别的 parent 的任务后再校验，也禁止 `randomUUID` 作为业务 requestId。
- research 的 active `claim_scope_key=research:${workspaceId}:${parentTaskId}:${gapId}`，绝不包含 stageRequestId/generation；stageRequestId 只保存在 attempt row。generation N 非终态时 N+1 必须拒绝或接管 N，不能并存；不同 gap/parent 可并发。状态固定 `claimed→manifest_frozen→dispatching→running→terminal`，并对该逻辑 scope 建 active 唯一约束。每次 research event、claim progress、result、claim terminal 和业务 mutation 都必须在同一事务 join 当前 parent root/stage，校验 parentStageRequestId、rootRequestId/rootGeneration、sourceSnapshotHash、parent claim revision/ownerEpoch/lease；只校验 research 自身 token 不足以提交。父 stage 的 retry/supersede/cancel 必须在同一事务 fenced 终结其 active research claims（`orphaned`/稳定 reason），撤销 lease 后旧 research 事件只能写 audit，不能提交到新 parent。
- 旧 `resume_pending/running` 必须复用原 identity。`ResearchResumeManifest` 固定为 `{manifestVersion,taskId,parentTaskId,parentStageRequestId,gapId,managerTaskId,orchestrationId,stageRequestId,requestId,attemptPreimageJson,logicalInputHash,sourceSnapshotHash,sessionId,cwd,cwdFingerprint,remainingDeadlineAt,resumeState,manifestHash,createdAt,updatedAt}`，存于 task checkpoint；claim 行同步保存 parentStageRequestId/gapId。manifestHash 覆盖完整 preimage。manifest、claim revision/lease 和 task checkpoint 同一事务提交；恢复逐项校验父阶段/gap/snapshot/cwd/session/hash，父阶段已被 supersede 或 gap 不匹配则原位终结，禁止错恢复。
- 不允许通过生成新 requestId 掩盖冲突或通过重扫绕过恢复失败。WMB-5366 提供带 parent identity/revision 的 research claim CAS、supersede/cancel cascade 和 readback；WMB-5370 只能通过该 API 写 research 状态，不能自行更新 claim 或以 startup reconciler 代替在线 parent fencing。

应用启动必须在接受任何新派工前运行持久 reconciler。selector 固定为 `agent_tasks running/resume_pending UNION daily_stage_claims 所有 active status UNION managed_job_dispatches 非终态 UNION managed_effect_consumptions active UNION daily_orchestration_roots 全部非终态`；lease 只决定等待/接管，不决定是否被枚举。selector 必须同时读出 `acceptance_scenario_id/barrier_id/runner_epoch`：验收专用记录进入 gate 的待处理集合，但生产 reconciler 对它们只能 audit/等待，不能 spawn、resume 或消费；只有 acceptance runner 通过自己的 fenced `fail/cancel/reconcile` 终结旧 scenario 后，gate 才可完成。普通生产记录才按 parent/root fence 恢复。gate 表固定为 `daily_reconcile_gates(workspace_id,status,runtime_epoch,owner_epoch,lease_token,lease_expires_at,revision,started_at,finished_at,error_json)`，每 workspace 只有一行/唯一键 `(workspace_id)`。新 runtimeEpoch 以 revision+旧 lease 做 CAS 接管同一行，禁止创建第二行；运行中崩溃后等待 lease 或显式失效再接管，旧 owner 迟到零写。新派工在 gate 非 complete 时返回 pending。除 gate 的 claim/takeover/complete 与 acceptance runner 的 fenced 终结外，所有 `createRoot/claim/reserve/bind/spawn/tick/triggerNow/event/result/mutation/settlement` 都必须在同一事务调用 `assertStartupGateComplete(workspaceId, callerRuntimeEpoch)`；该断言比较 gate.status=`complete` 且 gate.runtime_epoch=callerRuntimeEpoch，缺失、过期或非当前 epoch 返回 `EXECUTION_AUTHORIZATION_INVALID` 并业务零写。只有 union selector 全部恢复或终结才 complete。必须覆盖 root-only crash、effect consumption reserve/consuming crash、未过期 root/consumption 等待后接管、验收记录隔离和 gate 跨 epoch 单行恢复。

每次应用启动都必须先以新 runtimeEpoch 对 gate 做启动 CAS：旧 `complete` → `pending(newEpoch)`；旧 `failed` → `pending(newEpoch)` 仅在记录上一次 error 并取得新 lease 后允许；旧 `running/pending` 则等待旧 lease 或接管同一行。只有本 epoch 从 pending→running→complete 后才放行，绝不能沿用前一 epoch 的 complete。正常重启、failed 后恢复和双进程同时启动均需测试。

`assertStartupGateComplete(workspaceId, callerRuntimeEpoch)` 是共享 store 的唯一放行函数；调用者不得只读取 `status` 或缓存上一次的 complete。A epoch 在 B epoch 接管并完成后执行 tick、`triggerNow`、迟到 event、result 或 mutation，均必须因 epoch 不等返回 `EXECUTION_AUTHORIZATION_INVALID`，只记 audit。该断言的调用者 epoch 必须从当前进程启动 gate lease 传入，禁止由请求体、日期或 job metadata 自报；WMB-5366 提供 API，WMB-5367～5370 的所有生产入口和 WMB-5371 的集成入口统一调用。

Manager 新入口错误必须 fail closed。只有独立 `LegacyDailyRequest` 在显式迁移开关开启且不含任何 managed identity 时可走 legacy；managed 类型不接受 `legacyPipeline` 字段。`index.ts` 的生产入口不得以 `try dispatchManagerDailyIntelligence / catch / continue legacy pipeline` 处理异常。边界固定为：root/attempt 的原子接受事务提交前，ownership/identity 错误使用原稳定 reason，contract/Manager 服务/未知异常统一为 `MANAGER_ENTRY_FAILED`，只允许写控制面失败 receipt，Manager/root/claim/child 与业务写增量均为 0；提交后发生的合同异常统一为 `MANAGER_CONTRACT_ERROR`，必须记录 `failedStage/lastCommittedBoundary`，先撤销当前 claim/job/consumption lease，再以 revision/epoch/lease 把 attempt 与 Manager 原子终结为 `failed` 或（存在可信已提交结果时）`partial`。异常观测点前的合法提交保留，观测点后 child/内容新增量为 0；不得声称整个 attempt 历史增量为 0。两者都立即终止当前入口，后续 scan/judge 与 legacy 增量为 0；前者只能显式 `retry_managed_entry` 创建新的 root retry invocation，后者只有前代已终态且 failedStage 可读回才能 `retry_stage` 生成 generation+1。只有请求在解析前就被严格判定为 `LegacyDailyRequest`，且迁移开关为真时，才能进入独立 legacy 分支；managed 分支运行后永远不能动态 fallback 到 legacy。该入口与负例由 WMB-5371 的 `index.ts` 集成 owner 负责，WMB-5367 提供 Manager fenced terminal API。

### 3.7 方案完整度、错误 UI 与合法空结果

- 方案的“完整”不是字段非空，而是所有写入/提交/恢复/导入入口共享 `validateProposalCompleteness`、`validatePlanSourceReferences`、`validateTruthGateSourceReferences` 和有效 `propagation_v2` 评分门；占位词、过短 `whyNow`/受众、角度/观点重复、结构不足三段、空平台/格式/source 均拒绝。验证结果写入稳定原因数组，不能只显示一个计数。
- `NO_CONTINUATION_MATERIAL` 映射为“没有可续接的扫描资料 / 先重新侦察”，动作显式为 `retry_scan`；`SOURCE_SNAPSHOT_STALE` 映射为“资料已变化 / 重新侦察”，动作同样是显式 scan；任何未知错误不得默认映射到“验证浏览器账号”。
- 合法空结果是正式成功分支：所有选定渠道产生可信 receipt、当前投影的 candidate 集合确实为空、且不存在 invalid/pending 项时，Manager/Today 写 `succeeded + emptyQualified=true + opportunityCount=0`，页面显示“今天没有新的内容机会”。当前合同不新增未被现有分类器支持的 hard-reject 类别；任何候选被未定义的硬门静默排除、字段缺失、占位、评分异常等都必须保留为可读 candidate/invalid 并进入 `partial/needs_user`，不能伪装成 clean-empty。不得为了满足“至少一条”伪造标题或方案。只要存在合格候选，验收才要求至少一个完整、可批准的方案；测试必须同时覆盖“一条真实候选”“合法 clean_empty”和“invalid_needs_repair”三条分支。

## 4. 任务拆分与文件所有权

审计通过后，按以下任务写入唯一台账 `TASKS.md`：

| ID | 任务 | 主要文件所有权 | 依赖 |
|---|---|---|---|
| WMB-5365 | 冻结合同、失败复现与两轮独立审计 | 本文、审计报告、最小复现证据 | WMB-5364 |
| WMB-5366 | 共享 identity/claim/root/scope/job/effect/barrier schema 与 CAS/fencing API | `command-dispatcher.ts`、`agent-tasks.ts`、`daily_stage_claims`/`daily_orchestration_roots`/`daily_plan_scopes`/`managed_job_dispatches`/`managed_effect_consumptions`/barrier store 与迁移；PlanScope 必须 join root/claim 并支持 cancel/supersede，research claim 提供 parent fence；测试 `tests/daily-identity-claims.test.mjs`、`tests/daily-plan-scope-store.test.mjs`、`tests/managed-job-dispatch-store.test.mjs`、`tests/managed-effect-consumption.test.mjs` | WMB-5365 |
| WMB-5367 | 强类型 UI stage、scan 快照绑定、Manager fenced 状态机、PlanScope/Projection 与错误矩阵 | `today-view.tsx`、`today-run-view.ts`、`proposals-view.tsx`、`preload.ts`、`global.d.ts`、`manager-task.ts`、`manager-dispatch.ts`、`today-recommendation.ts`、`proposals.ts`、`workbench.ts`、`planning.ts`、`planning-stage-intake.ts`、Today IPC；测试 `tests/today-continuation-stage.test.mjs`、`tests/manager-fenced-terminal.test.mjs`、`tests/today-plan-scope-projection.test.mjs`、`tests/source-snapshot-integrity.test.mjs` | WMB-5366 |
| WMB-5368 | managed job reserve-before-spawn、因果归属贯通与 Manager job 同步 | `manager-job-notify.ts`、`mcp-job-tools.ts`、`.pi/extensions/wmb-mcp/wmb-mcp-tools-manager.ts`、`role-job-registry.ts`、`job-spawner.ts`、`job-pool.ts`、`job-object-boundary.ts`、`generic-employee-runner.ts`；测试 `tests/managed-job-causation.test.mjs`、`tests/managed-job-crash-recovery.test.mjs` | WMB-5366 |
| WMB-5369 | 所有 automation/cycle producer、workspace-scoped Stage D 与 barrier scheduler 挂点 | `daily-content-cycle.ts`、`daily-orchestration.ts`、`daily-orchestration-scheduler.ts`、`daily-scan-scheduler.ts`、`workspace-intelligence.ts`、`ipc-daily-content-cycle.ts`、`daily-iteration.ts`、`daily-content-article.ts`、`content-derivative.ts`、`db/zhihu-hot-content-loop-migrations.ts`、`zhihu-hot-scoring.ts`；测试 `tests/daily-producer-allowlist.test.mjs`、`tests/stage-d-fenced-snapshot.test.mjs`、`tests/orchestration-overlap-barrier.test.mjs`、`tests/cycle-workspace-isolation.test.mjs` | WMB-5366 |
| WMB-5370 | research claim/cwd/manifest、在线 parent supersede fence、全量 stale reconcile 与 startup gate | `agent-runner.ts`、`research-job-runtime.ts`、research session/resume/reconciler 模块；所有 event/result/mutation 必须经 WMB-5366 parent-fenced API，父 stage supersede/cancel 只走共享级联；测试 `tests/research-identity-reconcile.test.mjs`、`tests/research-parent-fence.test.mjs`、`tests/startup-reconcile-gate.test.mjs`；`index.ts` 只由集成 owner 接线 | WMB-5366 |
| WMB-5371 | 串行接线、Manager 入口 fail-closed、全量 gate、打包安装、真实重叠闭环 | `index.ts`、必要集成冲突、`tests/manager-entry-fail-closed.test.mjs`、安装验收脚本与证据文件 | WMB-5367..5370 |

WMB-5366 是共享前置，不与业务任务并发。5367–5370 仅在 5366 验收并冻结接口后并发；同一物理文件只有一个写入 owner，`index.ts` 始终留给主 Agent/WMB-5371。子 Agent 不修改 `TASKS.md`、不 commit/push、不宣布完成；主 Agent串行集成并更新台账。

WMB-5366 的交接产物必须是可编译的共享 API：`create/read/retryDailyRoot`、`claim/bindSnapshot/settleDailyStage`、`create/freeze/readPlanScope/commitPlanScopeCandidates/copyFrozenPlanScope`、`createRepairSnapshotBinding/freezeRepairSnapshotBinding/readRepairSnapshotBinding`、`reserve/bind/start/reconcileManagedJob`、`reserve/consume/fail/takeover/reconcile/readManagedEffect`、`ready/release/consume/cancel/fail/reconcileOverlapBarrier`、`selectManagedAgentTask`、`claim/read/completeStartupReconcileGate/assertStartupGateComplete`、`listActiveReconciliationWork`、`cascadeParentSupersedeOrCancel`。每个 effect API 明确接收 expected state、consumptionRevision、stageClaimRevision、epoch/lease、`effectSetHash` 和 `settlementTargetIds` 并返回稳定 terminal/error；每个 PlanScope API 必须接收 root/claim fence，`commitPlanScopeCandidates` 必须保证候选写入与 `building→frozen` 同事务，`copyFrozenPlanScope` 必须在新 scope identity 下重算 hash；每个 RepairSnapshotBinding API 必须接收完整 binding identity、predecessor scope/hash、claim fence 和 expected binding revision，并保证修复事实与 freeze 的 revision CAS；每个 barrier API 必须接收 `acceptanceMode=true`、scenario/runner epoch/token/expected revision，store 在非 acceptanceMode 直接拒绝且零写。每个共享 API 返回 identity、revision/epoch/lease 和稳定错误码。5367–5370 禁止直接写共享表。WMB-5371 只做 index 接线，不重设计 API。

## 5. 失败测试先行

实施前必须稳定复现以下负例，测试应先红后绿：

1. `judge` continuation 当前会创建 `daily_scan`；修复后首次请求 scan 增量为 0、judge 增量为 1，同 generation 重放 judge 增量为 0，显式 retry 才是 generation+1。
2. `channel_scanned` predecessor 可被同一 Manager 唯一续接，超时则 `SCAN_HANDOFF_EXPIRED` 终态。
3. 同日另一个 orchestration 的 job 会被写入用户 Manager；修复后缺归属/跨归属均零写并有 audit 原因。
4. Stage D 在当前 cycle 无 target 时会选中历史 approved；修复后只 `NO_CURRENT_TARGETS` skipped。
5. cycle target 缺失 `plan_item_id` 时不能全库扫描或 source 反查，必须 `CURRENT_TARGET_BINDING_MISSING`。
6. judge 开始后插入新 source/receipt 不得进入 frozen snapshot；revision 变化必须 `SOURCE_SNAPSHOT_STALE`。
7. Manager child 成功数与今日机会数不一致；修复后 Manager、Today 与数据库返回同一 eligible ID 集合，合法空结果为 `emptyQualified`。
8. planner 未派出、Pi 无响应或 Manager 重启后必须在 watchdog deadline 内进入稳定终态；planner child `succeeded` 但 projection 为 pending/invalid 时不得进入 `waiting_human`。
9. 临时 cwd 提前删除导致研究失败；相同 requestId 不同输入/命令/绑定身份产生冲突；stale resume 无终态。
10. `NO_CONTINUATION_MATERIAL` 不得走浏览器设置动作；未知错误不得伪装成浏览器验证。
11. 同日两个 orchestration 使用不同 PlanScope，各自产生 eligible/pending/invalid/clean-empty 时，彼此 projection、机会数、hash 和 Manager 终态不得串入；scope 缺失或不匹配必须零写并返回 `PLAN_SCOPE_MISMATCH`。
12. `operationRequestId` 只能等于 Manager attempt 的 `requestId`；传入 `stageRequestId` 或跨字段别名必须零写并返回 `MANAGER_OPERATION_IDENTITY_MISMATCH`。
13. 两个数据库连接同时首次创建 owner/scheduler root、tick 与 `triggerNow` 竞争或重放时，只能读回同一 rootGeneration/orchestrationId/Manager；没有明确授权不得生成 generation+1。
14. Stage D generation N 仍运行或仅 lease 过期时，generation N+1 必须被拒绝/等待；前代未终态不得并存。接管者完成后旧 owner 的 settlement、checkpoint、child 迟到写必须零写。
15. 逐项覆盖错误矩阵中的 timeout、handoff、scope/ownership、replay conflict、stale resume、cancelled，断言操作/Manager 终态、CTA、generation、scan/judge 增量和持久 finished_at。
16. scan/full 预 claim 在进程崩溃、快照绑定、旧 child 迟到和 judge 竞争下只能绑定一次 frozen snapshot。
17. managed job 在 reserved、task_bound、spawn_started、event-before-manager 四个 failpoint 重启后不重复 spawn，或唯一 orphan 终结。
18. producer allowlist 静态覆盖 UI、MCP、09:00、rolling scan、workspace intelligence、content-cycle IPC、orphan reconcile；任一旧直发入口均零写。
19. overlap barrier 两侧分别 consume 同一 release token；第一侧不得阻止第二侧，重复侧 ack 幂等。
20. managed Manager/contract 异常注入后断言 legacy pipeline 未启动、scan/judge 增量 0、无业务写且 reasonCode 可读。
21. Manager checkpoint/watchdog/child/cancel/reconciler 乱序竞争必须按 revision+epoch+lease 单调终结，旧 token 零写。
22. clean-empty 仍持久存在 frozen `daily_plan_scopes` 空集合行，重启读回 scopeHash/projectionHash 一致。
23. scan/full modules 或 watermark 不同、judge predecessor binding 不同必须得到不同 identity/冲突，不能复用旧 claim。
24. scheduler/triggerNow/replay 对同一 StageDAttemptInput 派生完全相同三种 ID；任何旧公式静态检索为零。
25. today_ui 与 proposal_ui 同日并发 generation=0 均成功且 identity 稳定；source 间不冲突。
26. research generation N active 时 N+1 被拒绝/接管，不能因新 stageRequestId 并存。
27. startup gate 新 runtimeEpoch 接管同一 workspace 行，root-only crash 和尚未过期 root 均不会漏出 selector；跨 workspace cycle/target/所有列明消费者零串写。
28. 同一 Manager/orchestration/stage/generation 即使 modules/watermark 不同也只能一个 active daily claim，第二个返回 replay conflict。
29. 同 owner 两个 child 同时更新 claim 时 revision CAS 保留两者或明确重试，禁止丢结果。
30. 旧 research scope 迁移后同一 workspace/parent/gap 只留一个 active owner；父 stage supersede 和多 gap 恢复按 manifest 精确终结/恢复。
31. 每次新 runtimeEpoch 都把旧 complete/failed gate CAS 回本 epoch pending 并重新 reconcile，不能沿用旧 complete。
32. cycle/target migration 唯一键加入 workspace；zhihu scoring 及全部列明消费者跨 workspace 读写为零。
33. daily generation N 任一 active 状态时 N+1 被拒绝/接管，所有 terminal 状态才允许新 generation；同 generation 不同 watermark 仍只一个 active scope。
34. claim read/reconcile/settle 的 rootRequestId/generation/inputHash join 不一致零写；同 owner child-vs-settlement 通过 claimRevision 不丢结果。
35. 旧 research winner 在同事务 rekey 为 canonical scope，loser orphaned，唯一索引后新 claim 不能双活；旧进程迟到零写。
36. active status 映射和 partial unique index SQL 逐状态验证：所有 active 冲突，所有 terminal 允许合法下一 generation。
37. versioned targetSetHash/effectRequestId 使用字段对象，构造字符串边界碰撞样本仍生成不同 hash。
38. 静态检索旧 target/effect 字符串拼接公式和旧 root preimage 为零；所有调用只用共享 derive 函数。
39. 首次 root、同 retry 重放、下一次 retry 的 rootRequestId/generation 分别满足稳定/稳定/递增。
40. barrier ready 后 acceptance runner 崩溃，旧 scenario fenced `failed/ACCEPTANCE_RUNNER_RESTARTED` 且不能 dispatch；新 runner 使用新 scenarioId。仅同一 runner epoch 的 ready 重放读回相同 readyReceiptId，不重复 slot。
41. Stage D effect 首次失败后，重复同一命令仍读回 ordinal 0；只有显式 retry 在前代 terminal 后 CAS 得到 ordinal 1 并成功，成功结果可被下一 orchestration 复用；旧 ordinal/epoch/lease 的迟到事件业务零写。
42. `index.ts` 分别在接受事务前、child 派出前、child 已合法提交后注入 ownership/contract/Manager 服务/未知异常：接受前只产生 `MANAGER_ENTRY_FAILED`/原 ownership receipt 且 Manager/root/claim/child/业务写为 0；接受后持久 failedStage/lastCommittedBoundary 并 fenced `failed|partial/MANAGER_CONTRACT_ERROR`，保留观测前可信提交、观测后 child/内容增量为 0；所有分支后续 scan/judge/legacy 增量为 0。只有显式 `LegacyDailyRequest + migration flag` 命中独立 legacy 分支。
43. Orchestration A 产生成功 effect 后，B 复用时不得改 A 的 dispatch/consumption；B 以自己的 operation/Manager/orchestration/stage 和 claim token 新增唯一 consumption 并在 settlement 引用同一 source result hash，B 重放不新增；hash 不符或旧 token 零业务写。
44. 冻结 source/receipt 后分别模拟正常 mutation（revision+hash 同变）和 legacy/corruption mutation（内容/hash 变但 revision 不变），judge 两种都必须 `SOURCE_SNAPSHOT_STALE`，不得读入新内容或重扫。
45. effect source dispatch 分别为 succeeded、failed、partial、cancelled、缺 result、resultHash 冲突；只有完整 succeeded 可消费，其他稳定终结 `EFFECT_REUSE_MISMATCH`，Stage D/Manager failed，显式 retry 才分配下一 ordinal。
46. 选定渠道一成一败时必须 `CHANNELS_PARTIAL_FAILED`：不自动 judge、不 clean-empty；只重试失败 modules，全部成功后才冻结合并 snapshot，scan +1/judge 0。
47. post-accept `MANAGER_CONTRACT_ERROR` 必须读回 failedStage/lastCommittedBoundary；缺 failedStage 返回 `RESUME_CONTEXT_INVALID` 且不扫描。
48. source evidence/categories 与 receipt metrics/provenance 的 canonicalBusinessJson mutation 均改变 hash；对象键序与 set 数组输入顺序变化不改变 hash。
49. Stage D consuming 时取消 root，root/Manager/claim 级联 cancelled，dispatch/consumption orphaned、lease 清空、finished_at 存在；重启 reconciler 不接管，旧进程迟到零写。
50. consumption 在 reserved/consuming 崩溃后，未过期 lease 等待、过期 lease 接管同一行；fail/takeover/reconcile API 的 revision/epoch/token 读回唯一。
51. 两 target 并发 reserve/consume 使用独立 consumptionRevision；向同一 Stage claim 附加 keys 的 revision 冲突必须重读重试，不丢任一 key。跨 orchestration consumption 不共享 revision 域。
52. acceptance barrier 仅在 acceptanceMode 创建；正常生产静态/动态读写为零，runner 重启终结旧 scenario 而非由 startup reconciler 触发业务。
53. target 业务内容正常 mutation 与 revision 未变的 corruption mutation都改变/破坏 targetContentHash，并在 Stage D 返回 `TARGET_SNAPSHOT_STALE`。
54. barrier cancel/fail/reconcile 仅接受 acceptanceMode+runner identity；released/consuming 崩溃能终结旧 scenario，生产模式调用零写。
55. snapshot/binding/planScopeSeed/scope/projection/targetSet/settlement 七个 registry derive 函数对固定向量跨进程返回相同 hash；任一 preimage 字段变化产生不同 hash。
56. target 冻结后 plan item revision 或 contentHash 变化，StageHandler 零写并返回 `TARGET_SNAPSHOT_STALE`；不得重新读取当前 plan item。
57. child/result 提交边界前后分别注入 Manager 异常，`lastCommittedBoundary` 的 claim/checkpoint revision 与 ID/hash 可读回；重试不重复已提交 child/result。
58. workspace migration 对可证明单 workspace 行回填；冲突或无 provenance 行 orphaned，禁止盲填；迁移重放结果稳定。
59. legacy daily/Stage D 同 scope 多 active 按身份有效性、状态进度、updatedAt、stageRequestId 固定 winner；无有效行全 orphan，重放 winner 不变。
60. 两个不同 baseSourceSnapshotHash 对同一失败 channels 生成不同 retry stage identity；登录/配置+普通失败混合按优先级 needs_user，解除后只重试精确 failedChannelIds。
61. `retry_effect` 从旧 failed settlement 创建新 scheduler root/Manager/target-scoped Stage D claim/new operation，并只处理 retryTargetIds；同命令重放读回同 root/claim/ordinal，旧终态不复活。
62. `RESUME_CONTEXT_INVALID` 不显示 retry_stage；Owner/scheduler 显式 start_new_root，原任务零写且新 root identity 可读回。
63. 所有 claim terminal 写 finished_at；managed dispatch orphaned 不能复用，进入 effect mismatch/显式 retry 路径。
64. 首次 `scan→judge` 创建 `building` PlanScope 时，scope 先锁定 predecessor source binding，planner 写入的新 plan/item 在同一事务进入 scope 后才 `frozen`；首次 judge 至少有一个真实候选时 scope/projection 可读回，scan 增量为 0。
65. 同一 frozen projection 同时含 pending 与 invalid 时，所有入口稳定返回 `SCORING_INCOMPLETE_AND_INVALID/repair_or_retry`；未修复前零 judge，修复并显式 retry 后才 generation+1/judge +1。
66. PlanScope create/freeze/read/settle/cancel/supersede 分别注入旧 root、旧 claim revision、旧 epoch/token 和 cancelled ancestor；全部必须 `PLAN_SCOPE_MISMATCH`/稳定取消并零业务写，building scope 不得残留可读 active。
67. barrier 在 released 与 consuming 各自注入 acceptance runner 崩溃；当前 epoch fenced `failed/ACCEPTANCE_RUNNER_RESTARTED`，已消费侧 acceptance-only dispatch 终结、未消费侧不得 ack，重启新 scenario，不能悬挂或触发生产派工。
68. research 运行中父 stage supersede/cancel，旧 research event/result/mutation 与 parent 同时竞争；父级联先终结/撤销 active claim，旧 token 只能 audit，不能写入新 parent；不同 parent/gap 仍可并发。
69. DailyStageRequest 的非法 stage 组合、伪造派生 ID、跨层 `operationRequestId=stageRequestId` 在类型门和原始 IPC/MCP 门分别失败；合法 payload 的 root/attempt derive 与 readback 一致，错误分支业务零写。
70. 表驱动穷举 `eligible/pending/invalid` 的全部 7 个非空组合及 clean-empty：`eligible` 单独才 `waiting_human`；`pending` 只、`invalid` 只、eligible+pending、eligible+invalid、pending+invalid、三者同时存在分别读回稳定 Manager 终态/reason/action/CTA；任何含 pending/invalid 的组合都不是 waiting_human，批准控件只出现于 eligible IDs，机会数等于 eligible 集合长度。
71. 修复流程用两个不同 item/receipt revision、payload hash 和顺序构造 binding：完整 `repairSnapshotHash/bindingHash` 跨进程稳定；旧 source snapshot 混新 repair receipt、旧 scope 混新 item、伪造 hash 均 `PLAN_SCOPE_MISMATCH` 零写；合法修复只生成新 frozen binding/new scope，旧 scope/hash 不变，显式 retry 才 scan 0/judge 1。
72. Stage D 冻结 T1/T2 的完整 `StageDEffectSpec[]` 后插入/删除 research claim、重启或改变实时 role 输入，effectSetHash、role/action 和 settlementTargetIds 仍保持冻结；T1 失败的 retry 只覆盖 T1 consumption，T2 不重派；完整 targetSetHash 冒充 retry 子集返回 `EFFECT_REUSE_MISMATCH`。
73. root、claim、dispatch、consumption 的 `acceptanceScenarioId/barrierId/runnerEpoch` 必须完整贯通；正常生产值全为 null，错误 build/PID/data-root/runner epoch 零 dispatch；验收一侧 consume/dispatch 后应用崩溃时 startup gate 继续 pending，生产 reconciler 不 spawn，runner fenced fail 后旧 token 全部零写。
74. scan predecessor 与 judge 创建、handoff timeout 两连接竞争只能一个事务成功：成功交接同时写 predecessor `succeeded/HANDOFF_CONSUMED/is_active=0/finished_at` 和 judge claim；失败一侧不能产生第二 judge，judge 建立后旧 scan 不在 startup selector，迟到 watchdog 只写 audit。
75. managed job 在 parent generation N `task_bound` 时崩溃，N 终态后创建 N+1 再运行 reconciler：N 不得 spawn；旧 event/result/mutation 因 parent root/stage revision/epoch/token 失败而业务零写，N+1 Manager 和 projection 不变；父 supersede/cancel 必须级联 orphan dispatch/consumption 并结束可证明进程。
76. heartbeat/lease 每 15 秒持续写入但 `lastBusinessProgressAt` 五分钟不变时，watchdog 在 deadline 内返回 `MANAGER_STALL` 并写 finished_at；heartbeat、审计、普通 checkpoint 不能刷新 stall 时间。B runtime epoch 完成 gate 后 A 的 tick/triggerNow/event/result/mutation 全部 `EXECUTION_AUTHORIZATION_INVALID`。
77. acceptance runner 在 barrier `released` 或 `consuming` 时崩溃，当前 scenario 必须 fenced 进入 `failed/ACCEPTANCE_RUNNER_RESTARTED`，已消费侧只保留观察前 receipt、未消费侧不得 ack，startup gate 不得把验收记录当生产任务恢复；新 runner 必须使用新 scenarioId，旧 token/epoch 零写，且错误矩阵 CTA 为 `restart_acceptance_scenario`。
78. 同一 target/plan item 的 `research` 与 `write` action、不同 role、不同 revision/hash 必须产生不同 `effectLogicalKey/effectRequestId/effectSetHash`；字段对象边界碰撞、重启重放和显式失败 retry 均不能复用错误 action 的成功结果。
79. `partial/failed/needs_user` 的每一种显式 retry 都先终结旧 root/Manager，再原子创建唯一 superseding root/Manager；旧记录保持 terminal，旧 token 迟到零写；双击/重启重放只读同一新 root，不能把 terminal Manager 原位改回 running。
80. `copyFrozenPlanScope` 在新 superseding attempt 中保持 predecessor 的排序 item/carry 集合、内容 hash、receipt 引用和 admission 结果，但必须按新 scope identity 得到不同的 `scopeHash/projectionHash`；旧 scope 只读，新增候选/修复不得走 copy。
81. `full` 的 F reporter attempt 与 J judge attempt 必须各有独立 stage/request/operation receipt；F handoff 只终结 predecessor 并创建一个 J，J 不再派 reporter；同一 J 重放不新增 scan/judge，F receipt 不能冒充 J receipt。
82. RepairSnapshotBinding 必须经独立 create(building)/freeze(CAS revision)/read(frozen) API；item/receipt revision、content/payload hash、predecessor scope 和完整 identity 任一变化均零写，崩溃 building 不可被 judge 消费，旧 binding/scope 不可变。
83. candidate admission 对每个 planner 原始候选给出且仅给出 eligible/pending/invalid；重复、scope 外、未知分类、未绑定 receipt 或未解释行整笔 `CANDIDATE_ADMISSION_GAP` 回滚。只有原始候选数与分类数均为零、渠道 receipt 完整可信且 scope frozen 时才可 clean-empty。

不得删除、skip 或放宽仍代表现行产品合同的失败测试。旧合同若确已被本合同替代，只能改写为等价的新行为覆盖，并记录替代理由。

## 6. 验收合同

### 6.1 自动化门

- 新增 focused tests 全部通过，并证明 §5 编号 1–83 的全部失败场景由红转绿；测试先用最小 fixture 红灯，再在同一变更中转绿。
- `npm run typecheck` 通过。
- `npm test` 全量通过，0 fail/skip/todo；若存在任务前已知失败，必须逐项判定，不能把部分通过写成完成。
- `npm run build` 与项目 package gate 通过。
- 如改动 CSS，追加 design token drift gate；本任务默认不改 CSS/品牌 Token。

### 6.2 真实安装版重叠闭环

必须重新打包、安装并启动安装版，在同一 businessDate 做一次可读回实验：

1. 冻结点击前的 plan/source/task IDs、scan/judge 数量、当前 cycle、Manager 根 `rootMode` 和当前 attempt identity。
2. 准备已有情报、尚未完成选题的可续接现场。
3. 通过真实安装版已有的用户动作与 scheduler `triggerNow`，在同一 barrier/time window 触发“继续更新选题（judge）”和 09:00 自动编排；不能用两个隔离 fixture 代替重叠实验。两条流程必须携带不同、可读回的 `managerTaskId/orchestrationId`，共享同一真实 data root 和 businessDate；持久 `orchestration_started`/claim receipt 的时间区间必须证明确实重叠。
4. 读回 UI、任务树、数据库和日志，必须同时满足：
   - scan 增量 = 0；
   - 首次 judge attempt 增量 = 1；同一 `stageRequestId` 的双击/IPC/重启重放 judge 增量 = 0 且读回同一 receipt；仅显式失败重试允许 generation+1、新 attempt；
   - 用户 Manager children 只含自己的 judge/planner；
   - 自动 cycle 未卷入任何非本 cycle 的历史 approved；
   - 若冻结候选集中存在合格候选，planner 产生至少一个字段完整、评分有效的今日方案，Manager 才进入 `waiting_human` 且页面出现可批准的 AI 主推荐；若候选为空，必须为合法 `succeeded/emptyQualified`，若 pending/invalid 则为 `partial` 并给出动作，不得凑题或伪装待批准；
   - UI、Manager 和数据库的机会数一致；
   - UI、Manager 和数据库的 eligible `planItemId` 集合一致，而非只比较数量；
   - 所有本轮任务在时限内进入终态，无新增长期 `running/resume_pending`；
   - 自动编排无 target 时明确 skipped，有 target 时只处理冻结集合；
   - 两个同日 orchestration 的 PlanScope、eligible IDs、projectionHash、机会数和终态互不污染；
   - Stage D generation+1 只有在前代终态且显式授权后成立；接管后旧 epoch/token 的 settlement、Manager checkpoint 和 child 迟到写全部零写；
   - Stage D 每个冻结 target 都能从本 orchestration settlement 读回唯一 `effectConsumptionKey`；跨 orchestration 复用时源 dispatch 不变、当前 operation consumption 独立存在且 sourceResultHash 一致；
   - 错误矩阵中每个 reasonCode 的 CTA、操作/Manager 终态、是否新 generation/root 及 scan/judge 增量与持久读回一致；
   - 安装目录 `app.asar` 与本次构建产物哈希一致。
5. 批准主推荐后只验证进入已批准/项目启动及递补读回，不执行最终发布。

任一条件不成立即为 `partial` 或 `blocked`，不得交付“已完成”。

## 7. 审计放行条件

独立审计至少覆盖两条互不共享中间结论的路线：

1. 产品状态机审计：检查阶段语义、重复扫描、幂等、终态、空态与用户可恢复动作。
2. 并发与归属审计：检查 Manager/job/orchestration 因果关系、09:00 current-cycle scope、竞态、研究生命周期和重叠验收可证伪性。

只有两路均无 P0/P1 未决项，且主 Agent 将有效意见回填本文后，才可把 WMB-5365..WMB-5371 写入 `TASKS.md` 并开始实施。若审计发现新 P1，必须先在本文固定字段、状态转移、错误码、责任组件和负例验收，再重新审计；不能以“实现时再决定”放行。

## 8. v1 → v2 → v3 → v4 → v5 → v6 回填记录

本版已把上一轮审计指出的缺口逐项变成合同：

1. 明确 `channel_scanned` 是有 deadline 的持久 predecessor，不是终态也不是无限 running。
2. 明确 current cycle target 在同一事务写入 `plan_item_id`，Stage D 只读冻结 target/plan item 集合。
3. 明确 scan source/receipt snapshot、revision 和 hash，judge 禁止按 watermark/近 24 小时重新扩集合。
4. 明确稳定 requestId 的组成、持久位置、同输入回放、异输入冲突、重启复用规则。
5. 明确 MCP/IPC 必须携带并校验 `managerTaskId/orchestrationId`，日期不能建立归属。
6. 明确 `NO_CONTINUATION_MATERIAL`、`SOURCE_SNAPSHOT_STALE` 等错误码及 Today 动作映射。
7. 明确完整方案复用共享语义门，合法 clean-empty 不再被“至少一个方案”验收错误阻断。
8. 明确 Manager watchdog 的 cadence、deadline、责任组件、原因码和终态读回。

本次两路对抗审计在 v2 放行前提出的缺口，已在 v3 固化为以下可执行合同：

9. 产品状态机增加唯一 `TodayRecommendationProjection` schema、eligible/pending/invalid/clean-empty 转移矩阵；`waiting_human` 不再由 planner child 成功单独触发。
10. continuation operation 增加规范 identity、持久 `command_receipts` 读回、generation、双击/重启重放/显式重试三种不同语义及 `REQUEST_REPLAY_CONFLICT`。
11. 明确选择“同日多 orchestration、每个 orchestration 一个 Manager”，要求唯一性键、scheduler source 和历史按日期记录迁移，禁止日期 fallback。
12. 将归属字段所有权扩展到 MCP schema、RoleJob、JobPool、boundary、agent task、事件和 Manager readback，形成 spawn→持久化→读回的闭环测试。
13. 将 scheduler 纳入 WMB-5369 owner，明确持久 claim、owner epoch、崩溃接管、双连接竞争和 target snapshot barrier；安装验收改为可重复的持久事件重叠实验。
14. 将 stale research 的启动恢复接线、CAS claim、原 parent identity、cwd/session 校验和必达终态纳入 WMB-5370，禁止仅写 `resume_pending`。
15. 将 Manager 不可变 `rootMode` 与 attempt 的 `attemptStage/stageRequestId/retryGeneration` 分离；冻结 mixed projection 优先级、Stage D claim key、stage-level `skipped` 与 Manager `succeeded` 的映射，并把重复 judge 的验收拆成首次=1、重放=0、显式重试=新 generation。
16. v4 复审后新增共享 WMB-5366 identity/claim 前置；业务任务不得并发修改 `agent-tasks.ts`、`command-dispatcher.ts` 或自建 claim。
17. 删除未实现的 hardRejected clean-empty 分支；当前 candidate 必须互斥落入 eligible/pending/invalid。
18. 冻结 `retry_scan` 为旧 judge 终态后新建 superseding owner/full root，不允许日期复用。
19. 明确 operationRequestId 与 effectRequestId 双字段、Stage D settlement/orchestration root identity、数据库 barrier 和 managed error fail-closed。
20. v5 复审后定义 `PlanScope` 及其持久 identity、scopeHash、显式 carry 边界；projection 只读冻结 ID 集合，禁止同日 orchestration 串单。
21. v5 复审后冻结完整 reasonCode→操作/Manager 终态→retryable→action/CTA→generation/root→scan/judge 增量矩阵，并补齐 cancelled、timeout、handoff、冲突和恢复失败。
22. 统一 `operationRequestId === requestId`；`stageRequestId` 只能作为独立 attempt 身份，不得作为 operation 别名；`effectRequestId` 只负责 Stage D 副作用去重。
23. 新增持久 `daily_orchestration_roots` 的 rootGeneration CAS、唯一键和稳定重放规则；并发首次启动及 tick/`triggerNow` 竞争不得创建重复 root。
24. Stage D 由“同 generation 唯一”收紧为同一 workspace/cycle 跨 generation 单活 claim；新 generation 前代必须终态、fenced 且有显式授权；settlement 使用 owner epoch/lease token fenced CAS 并保持终态单调。

本版 v7 回填 v6 复审的可执行缺口：

25. 明确 `NO_CURRENT_TARGETS` 只属于 Stage D skipped，并与 planner 的 `NO_ELIGIBLE_OPPORTUNITY` 分离；补齐 `INVALID_NEEDS_REPAIR` 的 receipt→显式 `retry_judge`→generation+1 转移及 scan/judge 增量。
26. `ContinuationIdentity` 增加 `parentTaskId`，并将它纳入 logical/stage hash；缺失父身份不得通过日期或 current task 猜测。
27. `daily_stage_claims` 增加 `cycle_id/claim_scope_key`，规定跨 generation active 唯一约束、SQLite 等价实现和唯一 owner；补齐 root canonical input、`root_input_hash`、持久 CAS、migration owner。
28. 固定 settlement 状态序列、terminal 单调性、旧 token 零业务写；固定 overlap barrier schema、canonical ID、两侧 ready 挂点、PID/build/data-root 隔离和 release/timeout/取消语义。
29. 固定 `ResearchResumeManifest` 字段、存储位置、hash、原子提交边界及 WMB-5370 owner，禁止 `resume_pending` 成为悬挂终态。

本版 v8 回填 v7 两路审计的可执行缺口：

30. 根与 child 的 `parentTaskId` 统一为 `string | null`，并把根 `null`、child 持久父身份和 canonical hash 作为跨 Renderer/preload/IPC/Main 的同一合同。
31. PlanScope 增加 `building → frozen` 原子状态；同一 attempt 冻结后禁止扩展，修复重试必须新建 generation/scope；超时 retry 的 `failedStage` 与 scan/judge 增量展开为唯一矩阵。
32. 新增 `INVALID_REPAIR_VERIFIED` 与 `ROOT_REPLAY_CONFLICT` 矩阵行，并将 Stage D 无目标 CTA 与 planner clean-empty 文案分离。
33. 明确 tick/triggerNow 相同 canonical input 才复用 root，不同 `root_input_hash` 返回冲突；managed envelope 显式贯通 `retryGeneration`。
34. 固定 overlap barrier 的 collecting/released/consumed 或 cancelled/failed 状态机、release token 消费 CAS；Stage D 副作用提交增加 target revision 与 claim fencing CAS。

本版 v16 回填 v15 最终复审的两个可执行缺口：

35. 为 Stage D effect 冻结 `effectLogicalKey + effectAttemptOrdinal` 的持久失败重试合同：成功跨 orchestration 复用，失败/孤儿仅显式 retry 分配下一 ordinal，active 前代阻止新 attempt，旧 epoch/lease 迟到零写。
36. 将 `index.ts` 任意 Manager 异常后继续 legacy pipeline 的现有反例收进合同；managed 入口一律 fail closed，只有解析前明确识别且迁移开关开启的 `LegacyDailyRequest` 可进入独立 legacy 分支。

本版 v17 回填 v16 产品状态机复审的三个 P1：

37. 删除 Stage D 中不含 ordinal 的第二套 effectRequestId 公式，唯一引用 §3.3 的 `effectLogicalKey + effectAttemptOrdinal`。
38. 将 Manager 异常按原子接受事务拆成 `MANAGER_ENTRY_FAILED`（接受前、无 Manager/业务写、重试新 root invocation）和 `MANAGER_CONTRACT_ERROR`（接受后、fenced failed、重试 stage generation+1），消除“Manager 保持 running 却可重试”的矛盾。
39. Research 生命周期不再重新枚举不完整字段，只引用 §3.1 的完整 `ResearchAttemptPreimage` 与 derive 函数，并固定持久列与派生身份一一对应。

本版 v18 回填 v16 并发/归属复审的剩余 P1 与 P2：

40. 新增 `managed_effect_consumptions`，把唯一 effect 执行结果与每个 operation 的消费归属分开；跨 orchestration 复用只新增本 operation 的 fenced consumption，不篡改源 dispatch。
41. source snapshot 增加 content/payload hash，并要求正式 mutation 原子递增 revision+hash；judge 双校验，因此 revision 未变的静默内容变化也会 fail closed。

本版 v19 回填 v18 并发/归属复审的三个 P1 与 migration P2：

42. `managed_effect_consumptions` 增加 claim revision、lease expiry、完整状态机和 startup reconcile selector；terminal settlement 原子验证并引用全部 consumption keys/result hashes。
43. barrier schema 正式增加 revision，所有 ready/release/consume/cancel/fail 使用 expected revision CAS 且成功递增。
44. 自动门从 1–40 更新为 1–44，并为 effect consumption 与 snapshot integrity 指定 focused test owner；安装闭环必须读回 consumption/settlement 关联。
45. 旧 research canonical scope winner 采用“身份有效优先、updated_at DESC、task_id ASC”的确定排序；无有效行时全部 orphan，迁移重放结果稳定。

本版 v20 回填 v19 两路复审的九个 P1 与两个 P2：

46. `EFFECT_REUSE_MISMATCH`、`CHANNELS_PARTIAL_FAILED` 进入统一错误矩阵，固定 Stage/Manager 终态、CTA、retry ordinal/generation 和 scan/judge 增量。
47. 所有 post-accept contract error 必填 `failedStage/lastCommittedBoundary`；区分观测前可信提交与观测后零新增写。
48. 冻结 `canonicalBusinessJson` 规范、source/receipt 完整 business payload、持久 revision/hash 字段和共享 mutation store。
49. cancel 在同一事务级联 root/Manager/claim/dispatch/consumption，撤销 lease；reconciler 禁止恢复 cancelled ancestor。
50. managed dispatch 增加不可变 `result_status/result_hash`，只有完整 succeeded 可被 effect 复用。
51. consumption revision 与 Stage claim revision 分域，并补齐 fail/takeover/reconcile API、双 target 竞争和崩溃接管。
52. overlap barrier 明确为 acceptanceMode 专用控制面；runner 重启终结旧 scenario，生产 startup reconciler 不消费 barrier。
53. target snapshot 增加 canonical targetContentHash，revision/hash 任一变化均 fail closed。
54. 自动门同步扩展为失败场景 1–53。

本版 v21 回填 v20 两路复审的十二个 P1 与三个 P2：

55. 新增统一派生值 registry，精确冻结 source snapshot、binding、PlanScope seed/scope、Projection、target set 与 settlement 的 versioned canonical preimage；废止 targetSetSeed 旧名。
56. Stage D snapshot 同时冻结 plan item revision/contentHash；effect identity 同时覆盖 target 与 plan item hash。
57. `retry_effect` 创建新 scheduler root/Manager/target-scoped Stage D attempt，旧终态不复活。
58. partial channel snapshot 持久 selected/successful/failed channel，retry preimage 引用 predecessor/base snapshot，并固定配置/登录/PI/普通失败优先级。
59. `RESUME_CONTEXT_INVALID` 改为显式 start_new_root，不再展示无法执行的 retry_stage。
60. daily/Stage D legacy claim migration 增加确定 winner；workspace migration 增加 provenance preflight 与 orphan 路径。
61. Manager `lastCommittedBoundary` 固定 tuple、提交来源和 CAS readback；claim schema增加 finished_at。
62. barrier API 补 cancel/fail/reconcile 并强制 acceptanceMode；新增 plan item/workspace/migration/boundary/registry/effect-retry 负例，自动门扩为 1–63。

本版 v22 回填 v21 两路复审的九个 P1：

63. 首次 judge 的 PlanScope 明确为 `building → planner 写入 → frozen`；只有不新增 plan/item 的纯重算 retry 才能复制 frozen 集合。
64. pending+invalid 增加最高优先级组合转移，统一 `SCORING_INCOMPLETE_AND_INVALID/repair_or_retry`，消除终态与 CTA 分歧。
65. `DailyStageRequest` 改为 scan/full 与 judge 的判别联合，冻结每个 stage 的 predecessor/modules/watermark 必填关系，并禁止调用方自报派生 ID。
66. PlanScope schema 增加 root identity、claim revision、lease 字段；所有 mutation join root/claim，取消/supersede 原子撤销 building scope。
67. barrier 增加 expected build/data-root 字段及 `released|consuming → failed` 的 acceptance runner fenced 路径，规定一侧已消费后的清理和零新增写。
68. settlement 明确唯一状态序列和 terminal hash-only replay，禁止同 token 原位覆盖和 retry 原地改写。
69. research event/result/mutation 改为在线 parent root/stage fence，父 supersede/cancel 同事务级联 active research claim。

本版 v24 回填 v23 复审仍未闭合的六项合同；这些条款覆盖当前正文，旧版本描述仅作为历史记录：

70. 所有显式 retry 统一采用 `finalizePredecessorRoot CAS → allocate retryInvocationOrdinal/rootGeneration → create superseding root/Manager` 的原子边界；旧 Manager/root 保持 terminal，retry 不原位复活，重放只读同一新 root。
71. `copyFrozenPlanScope` 只复制排序后的 item/carry 集合、内容 hash、receipt 引用和 admission 结果；新 scope identity 必须重新计算 `scopeHash/projectionHash`，旧 scope/hash 永不改写。
72. `full` 明确拆为同一 root 内 F reporter attempt 与 J judge attempt，两套 stage/request/operation receipt 独立；F handoff 原子终结 predecessor 后只创建一个 J，J 不创建 reporter。
73. 新增 `daily_repair_snapshot_bindings` 及 create/build、freeze/CAS revision、read/frozen 三个 API，固定完整 identity、preimage、revision/hash 和崩溃终结语义；修复事实不可回写旧 snapshot/receipt/scope。
74. 固定 candidate admission predicate、`candidateInputCount/classifiedCount` 与 `CANDIDATE_ADMISSION_GAP`；所有原始候选必须唯一归入 eligible/pending/invalid，只有零候选且 receipt 覆盖完整才允许 clean-empty。
75. PlanScope 状态扩展为 `building|frozen|failed|cancelled|superseded`，固定允许转移与 Projection 只读 frozen；自动失败测试门扩展为 1–83。
