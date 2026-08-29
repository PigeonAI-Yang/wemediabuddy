# WeMediaBuddy Workspace Orchestrator 架构设计规范

- **日期**：2026-08-29
- **状态**：已批准的设计规范；本文件只定义架构、数据合同、状态机、验收与迁移边界，不启动实现。
- **适用范围**：一个 WeMediaBuddy workspace 内，从情报来源检查、资料扫描、判断/策划、证据补料、Today 投影到 Owner 审批的完整编排控制面；同时纳管 09:00 自动编排、滚动扫描、MCP、内容周期和恢复入口。
- **规范语言**：`MUST/必须` 表示不可违反的合同；`SHOULD/应` 表示默认实现；`MAY/可` 表示不改变正确性的不影响项。

## 1. 背景与问题

WeMediaBuddy 已从 2026-08-03 的直接渠道编排，逐步演进到滚动来源、增量判断和 Manager-first 控制面。但历史设计是多个局部管道叠加，不是一个有耐久边界的 workspace 控制器。2026-08-29 的历史重建和审计确认了以下事实：

1. Today 的“继续更新选题池”实际重新进入通用 `startDailyIntelligence`，可能再次创建 `daily_scan`，并不是同一个 Reporter 的 resume，也不是 Owner 审批。
2. Manager 可能长期停在 `monitor_reporter` 或 `dispatch_planner`；来源、归档和 research successor 仍在增长，却没有可观察的全局收敛点。
3. `source_items` 的数量、Manager 的成功 child 数和 Today 的 `plan_items`/Recommendation Projection 是不同业务对象。把任意一个当作机会数会制造“有 500 条资料却没有机会”或“成功 16 条”的假象。
4. 任务、job、event、Manager 过去可以只带 `businessDate` 或依赖进程内 `Map/Promise`，导致同日 scheduler 与 Owner 任务串单、重启后重复派工、旧 owner 迟到写覆盖新结果。
5. 09:00/启动 scheduler、内容周期、research successor 与 Manager 入口可以成为独立 producer；Manager 异常还可能 fallback 到 legacy scan。局部去重不能阻止“有产出但不收敛”的反馈环。
6. 资源等待、临时工作目录提前删除、缺少业务 readback、task 与 Job 状态不一致，会留下 `running`/`resume_pending` 幻影，不能证明四阶段闭环。
7. 渠道失败若没有 required/optional 分类，浏览器/X 的故障要么错误地阻断全部判断，要么被错误地当成可信 clean-empty。

本设计采用完整的**每 workspace 一个持久 Orchestrator Actor**，把所有入口收束到耐久 mailbox、root/stage claim、资源准入和 immutable snapshot。它保留 Manager-first 的业务呈现和审批语义，但不再允许 Manager、scheduler 或任意 producer 直接生产员工任务。

**证据依据**：`local://wmb-workflow-architecture-history.md` 的 §2–§7；`docs/audits/2026-08-29-manual-topic-pool-continuation.md`；`docs/audits/2026-08-29-live-convergence-diagnosis.md`；`docs/audits/2026-08-29-today-continuation-orchestration-adversarial-audit.md`；`docs/audits/2026-08-29-today-material-count-inflation.md`；`docs/audits/2026-08-29-real-machine-e2e-closure-audit.md`；`docs/spark/2026-08-29-today-continuation-orchestration-remediation-plan.md`。

## 2. 目标与非目标

### 2.1 目标

1. **单一 workspace 控制面**：每个 workspace 恰好一个持久 Actor 身份；所有 Owner、scheduler、MCP、content-cycle 和 reconcile 意图先入 Actor mailbox。
2. **自动收敛**：已接受的生产 intent 自动完成 `preflight → scan → judge → plan/projection`，必要时在硬预算内自动进行 evidence successor；不需要点击“Continue”。
3. **正确的 Owner 边界**：只有真实可批准候选题需要 `waiting_owner`；required channel 的配置/登录修复进入 `needs_user`。确定性的内部 handoff、重试、clean-empty 和 optional channel 排除不要求 Owner 决策。
4. **可证明的身份**：root、orchestration、stage、attempt、parent、job、event、source snapshot、PlanScope、projection 和副作用消费都能从同一 workspace、source、generation、hash、claim fence 追溯。
5. **不可漂移的输入**：Judge 只消费冻结 source snapshot；Stage D 只消费冻结 target/effect snapshot；Today 只读同一份 projection，不按日期、全库计数或 child 数猜测。
6. **有限成本**：实施并强制固定默认预算：每 root 最多 80 个 source、Reporter 并发 5、Judge 并发 1、最多 2 个 evidence successors、每个逻辑 stage 最多 2 次 attempt、root 最长 20 分钟、`waiting_resource` 最长 90 秒。
7. **失败可解释且可恢复**：所有失败、partial、needs_user、cancelled 和 clean-empty 都有稳定 reason、动作、finished time、剩余预算和可验证 readback；重启后不会复活旧 root 或产生 phantom running。
8. **全量后台透明**：Today 展示 preflight、自动派工、资源等待、快照、预算、覆盖缺口、Actor/Manager/root/stage 身份和终止理由；不隐藏启动 scheduler 或自动 successor。
9. **生产者封闭**：切换后不存在 direct scheduler starts、generic Continue、Manager legacy fallback、date-only recovery、direct producer 或 projection guess。

### 2.2 非目标

- 不改变品牌 Token、视觉体系、传播价值合同或评分权重。
- 不自动批准候选题、不自动最终发布；Writer/发布属于后续受控业务链。
- 不以全库清洗、删除、去重、reset 或手工改 DB 修复历史数据。
- 不把本设计变成新的通用分布式队列、跨 workspace 全局调度器或云端服务；Actor 的耐久边界是 workspace 级。
- 不以测试 fixture、seed 数据、headless 替代或隐藏 fallback 构造“完成”证据。
- 不保留一个“兼容期直通旧管道”作为生产行为；历史记录只做迁移、审计和 orphan 标记。

## 3. 已冻结的用户决策

以下决策是本设计的最高产品合同，后续实现不得重新解释：

1. **完整持久 per-workspace Actor**：Actor 的 mailbox、epoch、lease、intent、claim、资源预留、恢复和事件均持久化；进程内 timer/Map 只能优化，不能承担正确性。
2. **自动 scan→judge→plan**：Scheduler/Owner/MCP 接受的合法 intent 自动跑到真实候选题、合法 clean-empty 或明确终态；没有手动 Continue。
3. **`clean_empty` 不需要点击**：当且仅当所有选定且通过 preflight 的渠道有可信 receipt、candidate 为 0、pending/invalid 均为 0、snapshot/projection 完整时，自动写 `succeeded + emptyQualified=true`。
4. **`waiting_owner` 只允许真实候选**：`eligiblePlanItemIds.length > 0` 才能等待 Owner；planner child 成功、来源数量大或有一个未完成候选都不能进入该状态。
5. **Owner 仅处理两类交互**：批准/拒绝真实候选题，或修复 required channel 的配置/登录/授权阻塞。Optional channel 缺席、内部 handoff、evidence successor、clean-empty 和普通重试不得变成 Owner 审批门。
6. **全渠道先 preflight**：所有渠道都先按 required/optional 分类并完成 capability、配置、登录、授权和健康检查；检查完成前不得创建 Root、Reporter 或任何 worker。
7. **required/optional 政策**：required 失败阻断 root；optional 失败从本 root 的 selected channel 集合中排除，并在 Today 显示 coverage gap，不得伪装为全渠道 clean-empty。
8. **默认硬预算**：`maxSourcesPerRoot=80`、`reporterConcurrency=5`、`judgeConcurrency=1`、`maxEvidenceSuccessors=2`、`maxStageAttempts=2`、`rootWallClock=20m`、`waitingResource=90s`。
9. **Manager 不是独立 producer**：Manager 是 presentation/business controller，读取 Actor 的持久状态和 Projection，向 Today/Proposals 呈现并接收批准/修复命令；它不得直接 spawn、重扫、派 planner、访问 JobPool 或 fallback。
10. **无隐式生产者**：所有 scheduler、content-cycle、research recovery 和 MCP 都必须成为 Actor 的显式、可归属 intent；应用启动只做 reconcile，不因“最新日期”或库存数量自动创建新 root。

## 4. 总体架构

### 4.1 控制流

```text
┌────────────────────────────────────────────────────────────────────────────┐
│  Producer allowlist                                                        │
│  Today/Proposal UI | MCP | 09:00 | rolling scan | content cycle | reconcile│
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ typed OrchestratorIntent
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Durable Workspace Orchestrator Actor                                      │
│  mailbox + actor lease/epoch + intent receipt + root CAS + stage claims    │
│  preflight gate + resource admission + reserve-before-spawn               │
│  snapshot/binding store + watchdog + cancellation + startup reconcile       │
└───────────────┬────────────────────┬─────────────────────┬─────────────────┘
                │                    │                     │
                ▼                    ▼                     ▼
        Channel preflight      Root/Stage FSM        Durable resource queue
        required/optional      scan/full/judge       Reporter ≤ 5; Judge = 1
                │                    │                     │
                └────────────────────┴──────────────┬──────┘
                                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Managed workers                                                            │
│ Reporter/Scanner → immutable SourceSnapshot → Judge/Planner                │
│                                      ↘ bounded evidence successors         │
│ Stage D → immutable Target/EffectSet → Writer/Research/Review consumption  │
└───────────────────────────────┬────────────────────────────────────────────┘
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Projection and presentation                                                │
│ frozen PlanScope + TodayRecommendationProjection + fenced Manager readback │
└───────────────────────────────┬────────────────────────────────────────────┘
                                ▼
                      Today / Proposals / audit timeline

禁止路径：Producer ──X──> daily_scan/daily_judge/job；Manager ──X──> spawn；
          Today “Continue” ──X──> generic start；date ──X──> ownership。
```

### 4.2 Actor 的职责与边界

| 组件 | 唯一职责 | 权威输入/输出 | 明确禁止 |
|---|---|---|---|
| `WorkspaceOrchestratorActor` | 串行处理一个 workspace 的控制命令、持久化边界、准入和恢复 | intent/root/claim/lease/event | 依赖内存 Map、按日期找任务 |
| `IntentStore` | 写入命令回执、去重、输入冲突和 intent 状态 | `command_receipts`、`orchestrator_intents` | 用随机 UUID 覆盖逻辑 identity |
| `ChannelPreflight` | 对每个选定渠道做 required/optional 检查 | immutable preflight snapshot | 创建 root/worker 后再检查 |
| `RootStore` | 分配 rootGeneration、orchestration、Manager identity 和 superseding root | `daily_orchestration_roots` | terminal root 原位复活 |
| `StageClaimStore` | stage/attempt claim、snapshot bind、settlement、fencing | `daily_stage_claims` | 仅用进程锁或字符串状态 |
| `ResourceAdmission` | reserve-before-spawn、排队、租约、释放和公平 | `managed_job_dispatches`、Actor lease | 先 spawn 再登记、无限等待 |
| `Snapshot/ScopeStore` | 冻结 source、repair、PlanScope、target/effect 和 projection | hash + revision + immutable JSON | Judge/Stage D 反查实时全库 |
| `ManagerAdapter` | 把 Projection/终态呈现给 Manager/Today | fenced checkpoint/readback | 生产任何独立 child |
| `Reconciler` | 启动时枚举所有非终态并恢复/终结 | runtime epoch + parent fence | 恢复 cancelled ancestor 或验收 scenario |
| Manager | presentation/business controller；呈现候选、收 Owner 决策 | Actor read API、Projection | 直接 spawn、重扫、legacy fallback |

Actor 的单一性是**控制事务单一性**，不是把所有 worker 串行化。Actor 一次只执行一个持久控制命令；通过已持久的资源预留，它可同时运行最多 5 个 Reporter，但同一 workspace 同时只能有 1 个 Judge。Actor 的 live lease 失效后，新的 runtime epoch 只能接管同一 actor 行，旧 epoch 的命令全部变成 audit-only。

### 4.3 Manager 的确切定位

Manager 绑定一个 `managerTaskId + orchestrationId`，负责：

- 将 intent 的目标、阶段、预算、source 和 readback 呈现到 Today/Proposals；
- 从唯一 `readTodayRecommendationProjection` 读取 `eligible/pending/invalid/emptyQualified`；
- 只有 `eligiblePlanItemIds` 非空时把 root 显示为 `waiting_owner`；
- 接收 `approve_candidates`、`repair_required_channel`、`cancel_root` 或创建全新 intent 的用户命令，并转交 Actor；
- 显示 Actor 已经提交的阶段，不凭 child 成功数、资料总数或历史计划猜测。

Manager **不能**调用 `wmb_spawn_job`、`startDailyIntelligence`、`daily-start-gate`、`daily-orchestration` 直发函数或 JobPool。Manager 发出的“下一步”必须是 typed Actor command；Actor 决定是否有预算、是否有 claim、是否满足父级 fence。这样 Manager 是业务控制和呈现面，不是第二个调度器。

## 5. 持久数据模型

### 5.1 通用 identity 与 hash 合同

所有业务 JSON 使用同一个 `canonicalBusinessJson`：对象键递归字典序、字符串 Unicode NFC、缺失字段显式为 `null`、时间 UTC ISO、数值使用 JSON 最短十进制；集合语义数组按 stable ID/hash 排序去重，有序数组保持顺序。所有派生值只允许共享 registry 产生：

```text
H(x)                    = sha256(canonicalJson(x))
rootRequestId           = H({version:1, workspaceId, businessDate, rootMode, source,
                              requestedAction, logicalInput, acceptance,
                              retryInvocationOrdinal, predecessorRootId})
orchestrationId         = H({version:1, workspaceId, businessDate, rootMode,
                              source, rootGeneration, rootRequestId})
stageRequestId          = deriveScan/Judge/StageDAttemptIdentity(input)
operationRequestId      = requestId = H({version:1, command, stageRequestId, input})
sourceSnapshotHash      = deriveSourceSnapshotHash(frozen source/receipt preimage)
bindingHash             = deriveBindingHash(frozen predecessor binding)
scopeHash               = derivePlanScopeHash(frozen scope JSON)
projectionHash          = deriveProjectionHash(scope + classified entries)
targetSetHash           = deriveTargetSetHash(frozen target triples)
effectSetHash           = deriveEffectSetHash(frozen effects + coverage)
settlementHash          = deriveSettlementHash(frozen consumption results)
```

`logicalInputHash` 只包含业务输入、root/stage/parent/snapshot/generation，不包含 runtime epoch、lease 或 grant；`executionEnvelopeHash` 才包含本次执行授权。`operationRequestId` 严格等于 Manager attempt 的 `requestId`；`stageRequestId` 和 `effectRequestId` 绝不互作别名。

### 5.2 核心表与唯一约束

以下表为设计所需的逻辑 schema；实现可使用等价列或 JSON，但必须保留同样的不可变字段、CAS 条件和唯一性。

#### `workspace_orchestrator_actors`

```text
workspace_id PK
actor_status: active | stopping | failed
runtime_epoch
owner_epoch
lease_token, lease_expires_at
mailbox_sequence
checkpoint_revision
last_business_progress_at
created_at, updated_at
```

每个 workspace 只有一行。新 runtime 启动以 `checkpoint_revision + lease` CAS 接管；不能插入第二 actor，也不能沿用旧 epoch 的 `complete` gate。

#### `orchestrator_intents`

```text
intent_id PK
workspace_id, business_date
source: today_ui | proposal_ui | mcp | scheduler_0900 | rolling_scan |
        content_cycle | orphan_reconcile
root_mode: owner | scheduler
requested_action: full | scan | judge | approve_candidates |
               repair_required_channel | cancel_root | start_new_intent
logical_input_hash, request_id, causation_id
channel_policy_json: 每个 channelId 的 required/optional 分类
preflight_id, root_request_id NULL, orchestration_id NULL
status: received | preflight_pending | preflight_running | waiting_resource |
        admitted | running | waiting_owner | succeeded | partial | failed |
        needs_user | cancelled
budget_json, coverage_gap_json, stop_reason_json
created_at, updated_at, finished_at
```

唯一键：`(workspace_id, request_id)`；同 request 重放只读原 intent。`business_date` 只作业务维度，绝不作为 ownership selector。

#### `channel_preflight_snapshots`

```text
preflight_id PK
workspace_id, intent_id, business_date, source
selected_channels_json: [{channelId, requiredness, module}]
results_json: [{channelId, requiredness, status, reasonCode, capability,
                configRevision, authRevision, checkedAt}]
ready_channel_ids_json, excluded_optional_channel_ids_json
required_failures_json, coverage_gap_json
preflight_hash, status: frozen | failed | needs_user
created_at, finished_at
```

预检结果一旦 frozen 不回写；配置/登录修复生成新的 preflight snapshot，不改变旧记录。

#### `daily_orchestration_roots`

```text
workspace_id, business_date, root_mode, source
root_generation, root_request_id, root_input_hash
orchestration_id, manager_task_id
retry_invocation_ordinal, predecessor_root_id
supersedes_manager_task_id, supersedes_orchestration_id, supersedes_stage_request_id
status: created | running | waiting_owner | succeeded | partial | failed |
        needs_user | cancelled
checkpoint_revision, owner_epoch, lease_token, lease_expires_at
acceptance_scenario_id NULL, barrier_id NULL, runner_epoch NULL
last_business_progress_at
created_at, updated_at, finished_at
```

唯一键：`(workspace_id, business_date, root_mode, source, root_generation)`；`root_request_id` 与 `orchestration_id` 另有唯一约束。rootGeneration 只能由 RootStore 在事务中分配；retry 的线性化顺序是：

```text
finalize predecessor CAS
  → allocate retryInvocationOrdinal + rootGeneration
  → create superseding root + Manager + first stage
```

三步同一事务完成。旧 root 永远 terminal，只读，不 rebind。

#### `daily_stage_claims`

```text
workspace_id, claim_kind, cycle_id NULL, gap_id NULL, claim_scope_key
stage_request_id, request_id, root_request_id, root_generation, root_input_hash
manager_task_id, orchestration_id, parent_task_id, parent_stage_request_id
root_mode, attempt_stage: scan | full | judge | stage_d | research
retry_generation, logical_input_hash
status: claimed_unbound | claimed | dispatching_scan | snapshot_frozen |
        awaiting_judge | dispatching_judge | manifest_frozen | dispatching |
        settling | running | succeeded | skipped | partial | failed |
        needs_user | cancelled | orphaned
is_active, claim_revision, owner_epoch, lease_token, lease_expires_at
snapshot_json, child_ids_json, result_json
acceptance_scenario_id NULL, barrier_id NULL, runner_epoch NULL
created_at, updated_at, finished_at
```

日常 claim 的 active scope：`daily:${workspaceId}:${managerTaskId}:${orchestrationId}:${attemptStage}`；Stage D：`daily-stage-d-claim:${workspaceId}:${cycleId}`；research：`research:${workspaceId}:${parentTaskId}:${gapId}`。同一 active scope 的 partial unique index 只允许一个 active claim；generation+1 必须先看到前代 `is_active=0`。

#### `source_snapshots`

```text
snapshot_id PK
workspace_id, business_date, source_task_id, stage_request_id
selected_channel_ids_json
successful_channels_json: [{channelId, receiptId, receiptRevision, receiptPayloadHash}]
failed_channels_json: [{channelId, reasonCode, requiredness}]
source_ids_json
source_bindings_json: [{sourceId, sourceRevision, sourceContentHash}]
receipt_ids_json, receipt_bindings_json
watermark, captured_at, snapshot_hash
status: frozen | stale | superseded
```

`sourceContentHash` 覆盖 source 的完整业务 payload；`receiptPayloadHash` 覆盖 receipt 的完整业务 payload。正常 mutation 必须 revision+hash 同事务变化；内容变而 revision 不变也必须被 Judge 判为 stale。

#### `daily_plan_scopes` 与 Projection

`daily_plan_scopes` 是 PlanScope 的唯一范围边界，不新增一个猜测性的 `recommendations` 表：

```text
workspace_id, stage_request_id, root_request_id, root_generation, root_input_hash
manager_task_id, orchestration_id, attempt_stage
claim_revision, owner_epoch, lease_token, lease_expires_at
source_snapshot_hash, repair_snapshot_hash, binding_hash
allowed_plan_ids_json, allowed_plan_item_ids_json, carry_plan_item_ids_json
trusted_receipt_ids_json
scope_status: building | frozen | failed | cancelled | superseded
scope_json, scope_hash, created_at, updated_at, frozen_at, finished_at
```

唯一键：`(workspace_id, stage_request_id)`。`scope_status=building` 只能由 `commitPlanScopeCandidates` 原子地转为 `frozen/failed/cancelled`；只有 frozen scope 能被 Projection 读取。Projection 作为 frozen `scope_json/result_json` 中的 versioned object 保存，并同时写 Manager checkpoint/readback：

```ts
TodayRecommendationProjection = {
  workspaceId, businessDate, managerTaskId, orchestrationId, stageRequestId,
  scopeHash, bindingHash, repairSnapshotHash, planIds, asOf,
  entries: [{ planItemId, planId, planDate, origin: 'today'|'carry',
              sourceReceiptIds, sourceReceiptRevisions,
              repairReceiptIds, repairReceiptRevisions,
              itemRevision, itemContentHash, classification }],
  candidatePlanItemIds, eligiblePlanItemIds, pendingPlanItemIds,
  invalidPlanItemIds, trustedReceiptIds, emptyQualified, projectionHash
}
```

`eligible/pending/invalid` 必须互斥且覆盖每一个 admitted candidate。`opportunityCount = eligiblePlanItemIds.length`，UI、Manager、数据库只使用这一个 projection。

#### `managed_job_dispatches`

```text
workspace_id, job_id, child_identity_key, child_ordinal, role_id
operation_request_id, effect_request_id NULL, effect_logical_key NULL
manager_task_id, orchestration_id, parent_task_id, parent_stage_request_id
root_request_id, root_generation, root_input_hash
stage_request_id, retry_generation
expected_parent_claim_revision, expected_parent_owner_epoch, expected_parent_lease_token
state: reserved | task_bound | spawn_started | running | terminal | orphaned
result_status, result_hash, envelope_json, result_json
owner_epoch, lease_token, lease_expires_at
acceptance_scenario_id NULL, barrier_id NULL, runner_epoch NULL
created_at, updated_at, finished_at
```

唯一键：`(workspace_id, child_identity_key)`；`job_id` 不足以绕过 child identity。顺序固定为 `reserve → task_bound → spawn_started → running → terminal`，崩溃由 reconcile 接管或 orphan，不重复 spawn。

#### `managed_effect_consumptions`

Stage D 的“执行事实”和“当前 orchestration 的消费事实”分离：

```text
workspace_id, operation_request_id, effect_request_id
manager_task_id, orchestration_id, stage_request_id
source_dispatch_job_id, source_result_hash
state: reserved | consuming | consumed | failed | orphaned
consumption_revision, expected_stage_claim_revision
owner_epoch, lease_token, lease_expires_at
error_json, acceptance_scenario_id NULL, barrier_id NULL, runner_epoch NULL
created_at, updated_at, finished_at
```

唯一键：`(workspace_id, operation_request_id, effect_request_id)`。只有 source dispatch 的完整 `succeeded + result_hash` 可被跨 orchestration 消费；复用方新增自己的 consumption，绝不修改源 dispatch。

#### 其他耐久对象

- `command_receipts`：保存 `request_id`、command、logical hash、execution envelope、原始响应、terminal status 和冲突摘要；重放返回同一结果。
- `orchestrator_events`：append-only，保存 `workspaceId/businessDate/source/root/stage/attempt/parent/job/causation/request/epoch/lease` 全字段；不得按日期补关联。
- `daily_repair_snapshot_bindings`：独立保存修复前后 item revision/content hash、receipt revision/payload hash、`repairSnapshotHash` 和 binding revision；修复不能回写旧 source/scope。
- `ResearchResumeManifest`：与 research claim/checkpoint 同事务保存 parent stage、gap、snapshot、session、cwd fingerprint、剩余 deadline 和 manifest hash；不能只写 `resume_pending`。
- `daily_reconcile_gates`：每 workspace 一行，runtime epoch、owner epoch、lease、revision 和 status；每次新启动都必须从本 epoch 的 pending 开始。

## 6. 状态机与精确转移

### 6.1 Intent 状态机

Preflight 前不存在 root 或 worker；intent 是唯一可持久化的前置对象。

```text
received
   │ actor receipt accepted
   ▼
preflight_pending ──cancel──► cancelled
   │ claim actor lease
   ▼
preflight_running
   ├─ required config/login/auth failure ─────────► needs_user
   ├─ unrecoverable preflight contract/runtime ───► failed
   ├─ no ready channel after policy ──────────────► partial/CHANNELS_ALL_FAILED
   └─ all required ready (optional may be excluded)
                                                    ▼
                                                admitted
                                                    │ create root + first stage atomically
                                                    ▼
running ──real candidates──► waiting_owner ──approve/reject──► succeeded
   ├─ trusted clean-empty ────────────────────────────────► succeeded/emptyQualified
   ├─ readable incomplete result ─────────────────────────► partial
   ├─ runtime/config/authorization block ─────────────────► needs_user
   ├─ no trusted result/contract error ────────────────────► failed
   ├─ Owner/system cancel ────────────────────────────────► cancelled
   └─ resource wait > 90s ───────────────────────────────► partial|failed
```

允许的终态集合为 `succeeded/partial/failed/needs_user/cancelled`；`waiting_owner` 不是“有任务未完成”的泛称，只能在 Projection 已有真实 eligible candidate 时出现。终态不可回到 running；retry 是新的 intent/root，不是状态回退。

### 6.2 Root 状态机

```text
(created)
   │ first stage claim accepted
   ▼
running
   ├─ planner Projection eligible>0, pending=invalid=0 ─► waiting_owner
   ├─ candidate=0, pending=invalid=0, receipts complete ─► succeeded/emptyQualified
   ├─ pending or invalid or coverage gap without complete proof ► partial
   ├─ configuration/login/required repair needed ────────► needs_user
   ├─ no trusted result / contract / wall-clock failure ──► failed
   └─ fenced cancel ──────────────────────────────────────► cancelled

waiting_owner ──approve/reject candidate set──► succeeded
waiting_owner ──cancel────────────────────────► cancelled
```

`waiting_owner` 只接收候选业务决定；required channel preflight 修复不把 root 变为 waiting_owner，而是发生在 root 创建前的 intent `needs_user`，修复后 Actor 自动生成新 preflight/new intent。

### 6.3 Stage/Attempt 状态机

#### Scan / Full 的 F（Reporter）attempt

```text
claimed_unbound
   └─ actor reserve accepted ─► dispatching_scan
                                  ├─ reserve/spawn crash ─► same claim reconcile
                                  ├─ required channel runtime failure ─► settling
                                  └─ reporter terminal + receipts ─────────► snapshot_frozen

snapshot_frozen
   ├─ trusted source IDs > 0 and judge budget available ─► dispatching_judge
   ├─ trusted source IDs = 0 ────────────────────────────► terminal/partial
   ├─ optional gap + trusted source IDs > 0 ─────────────► dispatching_judge + coverage gap
   ├─ no progress / stale snapshot ─────────────────────► terminal/partial
   └─ root cancel/supersede ─────────────────────────────► terminal/cancelled
```

`full` 的 F attempt 在 `snapshot_frozen` 后必须与 J attempt 原子 handoff；F predecessor 变为 `succeeded/HANDOFF_CONSUMED/is_active=0/finished_at`，再创建 J claim。F receipt 永远不能冒充 J receipt。

#### Judge / Full 的 J（Planner）attempt

```text
claimed
   └─ frozen predecessor + claim fence ─► dispatching_judge
                                             │ planner/evidence work
                                             ▼
                                           settling
                                             ├─ eligible>0, pending=invalid=0 ─► succeeded + approvalRequired
                                             ├─ candidate=0, pending=invalid=0,
                                             │  receipts complete, no forbidden gap ─► succeeded + emptyQualified
                                             ├─ pending/invalid ─► auto evidence successor if budget/progress allows
                                             ├─ pending/invalid after successor limit ─► partial
                                             ├─ snapshot drift ─► partial/SOURCE_SNAPSHOT_STALE
                                             ├─ no material ─► partial/NO_CONTINUATION_MATERIAL
                                             ├─ runtime/contract error ─► failed|partial
                                             └─ fenced cancel ─► cancelled
```

Judge 不创建 Reporter/scan child。`judge` 的 predecessor 必须是 frozen `SnapshotBinding`；没有 predecessor 不能降级成 scan。

#### Stage D

```text
claimed → snapshot_frozen → dispatching → settling → terminal
```

`terminalStatus` 只有 `succeeded/skipped/partial/failed/cancelled`。无 target 只产生 `skipped/NO_CURRENT_TARGETS`，不是 Planner 的 clean-empty；target/effect 变化、跨 generation 双活或旧 fence 写入都 `EFFECT_REUSE_MISMATCH/TARGET_SNAPSHOT_STALE` 并零业务写。

### 6.4 Projection 分类与终态优先级

Planner 终态写入前必须在同一事务读取 frozen Projection，按以下优先级判定：

| Projection 条件 | Root/Manager 状态 | reason/action |
|---|---|---|
| `pending>0 && invalid>0` | `partial` | `SCORING_INCOMPLETE_AND_INVALID / auto_bounded_successor_or_stop` |
| `pending>0 && invalid=0` | `partial` 或 successor 运行中 | `SCORING_INCOMPLETE / auto_bounded_successor_or_stop` |
| `pending=0 && invalid>0` | `partial` | `INVALID_NEEDS_REPAIR / stop_without_owner_approval` |
| `eligible>0 && pending=0 && invalid=0` | `waiting_owner` | `READY_FOR_OWNER_APPROVAL / approve_candidates` |
| candidate=0、pending=invalid=0、receipt 全可信、无禁止 coverage gap | `succeeded` | `NO_ELIGIBLE_OPPORTUNITY + emptyQualified=true / no_action` |
| 选定渠道有 optional coverage gap 且 candidate=0 | `partial` | `OPTIONAL_CHANNEL_COVERAGE_GAP / no_action_until_next_intent` |
| Stage D 无 target | Stage D `skipped`；其 scheduler root `succeeded` | `NO_CURRENT_TARGETS / no_action` |

所有 7 个非空组合（eligible、pending、invalid 的单独与组合）都必须遵守此优先级：任何含 pending/invalid 的组合都不是 waiting_owner；eligible 只有在 pending=invalid=0 时才可批准。

## 7. Channel Required/Optional Preflight

### 7.1 预检步骤

Actor 接受 intent 后，先生成不可变的 channel policy：每个 `channelId` 必须有 `requiredness ∈ {required, optional}`，该分类来自 workspace profile + intent 显式选择，不能由运行时错误临时改变。对所有选定渠道并行做预检，再由 Actor 单事务汇总：

1. 模块/adapter 存在且版本兼容；
2. workspace/data-root 绑定一致；
3. 配置字段、权限 grant、凭据和登录状态可用；
4. 浏览器/CDP/网络能力可用（仅对需要它的渠道）；
5. channel health probe 返回稳定 capability；
6. 记录 config/auth revision、checkedAt、reasonCode 和 coverage。

预检期间只允许产生 `orchestrator_intents`、`channel_preflight_snapshots` 和 audit event；**不得插入 `daily_orchestration_roots`、`daily_stage_claims`、`managed_job_dispatches`，不得 spawn Reporter/Manager worker**。

### 7.2 Required/Optional 规则

| 情形 | Root | Worker | Intent/读回 | Owner 动作 |
|---|---|---|---|---|
| 所有 required ready，optional 全 ready | 创建 | 可创建 | 正常运行 | 无 |
| required ready，optional preflight 失败/缺席 | 创建；排除失败 optional | 只用 ready 集合 | 运行 + 明显 coverage gap；不得称全渠道 | 无，Actor 不等待 Owner |
| 任一 required 配置/登录/授权失败 | 不创建 | 0 | `needs_user/CHANNEL_CONFIGURATION_REQUIRED` 或 `CHANNEL_LOGIN_REQUIRED` | 修复 required channel；修复后 Actor 自动重跑 preflight |
| 任一 required 不可恢复契约错误 | 不创建 | 0 | `failed/CHANNEL_PREFLIGHT_FAILED` | 不自动绕过；新 intent 必须重新检查 |
| 全部选定渠道均无 ready channel | 不创建 | 0 | `partial/CHANNELS_ALL_FAILED` 或 `needs_user`（若可修复） | 只对 required 修复；optional 不单独开审批门 |
| root 已创建后 optional runtime 失败 | 保留 root，移除该 channel | 不再向该 channel 派工 | 保存失败 receipt + coverage gap；有可信材料可继续 Judge | 无 |
| root 已创建后 required runtime 失败 | 当前 stage 终止 | 停止依赖该渠道的 worker | `partial` 或 `needs_user`，不可 clean-empty | required repair 后新 intent |

Optional 渠道被排除后，Actor 仍可以用剩余可信渠道自动走 Judge；但存在 coverage gap 时，**候选可进入 waiting_owner，零候选不可进入 clean-empty**。这样既不让 optional 故障阻断全部工作，也不把不完整覆盖伪装成“今天没有机会”。

### 7.3 预检与重试身份

配置/登录修复不会修改旧 preflight、旧 root 或旧 snapshot。Owner 修复 required channel 后，Actor 在同一 workspace 中：

```text
needs_user intent
  → verify repair receipt + new config/auth revision
  → new preflight snapshot
  → new rootGeneration/rootRequestId/orchestrationId
  → full F scan (only now may create Reporter)
```

原 intent 保持 `needs_user`，新 intent 的 `predecessorIntentId` 可读回；双击修复只读同一新 intent。不得从日期或“最新可用渠道”补字段。

## 8. Immutable Snapshot 与边界

### 8.1 SourceSnapshot

Reporter 完成后，Actor 在同一事务冻结：

```json
{
  "selectedChannelIds": ["sorted ready channel ids"],
  "successfulChannels": [{"channelId":"...","receiptId":"...","receiptRevision":1,"receiptPayloadHash":"..."}],
  "failedChannels": [{"channelId":"...","reasonCode":"...","requiredness":"optional"}],
  "sourceIds": ["at most 80, stable order"],
  "sourceRevisions": {"source-id": 3},
  "sourceContentHashes": {"source-id": "..."},
  "receiptIds": ["..."],
  "receiptRevisions": {"receipt-id": 1},
  "receiptPayloadHashes": {"receipt-id": "..."},
  "watermark": "...",
  "capturedAt": "...",
  "snapshotHash": "deriveSourceSnapshotHash(...)"
}
```

Source 选择最多 80 个。超过上限时按 Reporter 已返回的业务优先级，再按 `sourceId ASC` 稳定截断；`excludedByBudgetCount` 写入快照和 UI。Judge 开始后新增 source/receipt、近 24 小时全量查询、前一日资料和库存数量都不得进入本轮。revision 或 content/payload hash 任一不匹配即 `SOURCE_SNAPSHOT_STALE`，不静默重扫。

### 8.2 RepairSnapshotBinding

修复 binding 是独立事实，包含 predecessor scope、source snapshot、修复 item 的 prior/repaired revision/content hash、receipt revision/payload hash 和 `repairSnapshotHash`。创建、freeze、read 分三步 CAS；旧 source/receipt/scope 永远不变。Judge 只引用 frozen binding，不接受调用方自报 hash。

### 8.3 PlanScope 与 Candidate Admission

首次 Judge：

```text
create PlanScope(building, predecessor binding)
  → planner 原始 candidates
  → commitPlanScopeCandidates 单事务校验/写入 plan + plan_item + provenance
  → 每个 candidate 恰好分类 eligible|pending|invalid
  → scope building → frozen
  → readTodayRecommendationProjection(scope)
```

任一 candidate 重复、scope 外、未知分类、缺 receipt、revision/hash 不匹配或未解释，整笔 commit 回滚并返回 `CANDIDATE_ADMISSION_GAP`；不得静默丢候选。只有 `candidateInputCount=0 && classifiedCount=0`、scope frozen、选定渠道 receipt 完整可信且无 forbidden coverage gap 才允许 clean-empty。

纯重算 retry 可 `copyFrozenPlanScope`，但必须按新 stage identity 重算新的 scope/projection hash；新增 candidate、修复 receipt 或 source 变化不能 copy 到旧 scope。

### 8.4 Stage D Target/Effect Snapshot

Stage D 只从当前 `daily_content_cycle` 的已绑定 target 读取：每个 target 冻结 `targetId/targetRevision/targetContentHash/planItemId/planItemRevision/planItemContentHash`，并在 claim 前冻结 `StageDEffectSpec[]` 的 role/action/effect logical key/attempt ordinal。禁止 dispatch、重启或 settlement 时查询全库 approved 或实时 research claim 来重新决定角色。`retry_subset` 只能覆盖显式 `retryTargetIds`，不能拿完整 targetSetHash 冒充子集。

## 9. 自动推进与停止

### 9.1 Actor 自动推进算法

```text
accept intent + durable receipt
  → run all channel preflight (no root/worker yet)
  → if required blocked: needs_user; stop
  → exclude failed optional; persist coverage gap
  → create root + F/scan claim atomically
  → reserve Reporter slot(s), spawn managed Reporter
  → settle receipts and freeze SourceSnapshot (≤80 sources)
  → if trusted source exists and judge budget remains:
       atomically consume scan predecessor and create one J claim
       dispatch exactly one Judge (no new Reporter)
  → read frozen PlanScope/Projection
  → if eligible>0 and pending=invalid=0:
       settle root waiting_owner; show candidates
  → else if candidate=0, pending=invalid=0, complete receipts, no forbidden gap:
       settle succeeded/emptyQualified; show no-action empty state
  → else if evidence gap and bounded successor + progress remain:
       dispatch successor (≤2 total), then re-read frozen scope and continue
  → else:
       settle partial/failed/needs_user with reason/action; stop
```
每个 root 只允许一个初始 F/scan attempt；自动“直到候选”指在同一 frozen source boundary 内完成 Judge、必要的 evidence successor 和 plan settlement，不指按库存反复重扫。再次侦察必须是新的显式 intent，重新经过 preflight 和新的 root identity；它不属于 Continue，也不复活旧 root。

“继续更新选题池”不再是命令。Today 只读 Actor 当前 intent/root；如果 root 在 `awaiting_judge` 或 stage claim 仍为 `awaiting_judge`，Actor 自动完成 handoff；若 root/stage 已按 `NO_CONTINUATION_MATERIAL`、超时、stale 或 contract error 终态化，页面只显示终止原因/required repair，不会偷偷新建 scan，也不会重新激活 terminal root。任何新扫描都必须是新的、显式 source-bound intent，经完整 preflight。

### 9.2 Evidence successor

Evidence successor 只有在以下条件全部满足时才能自动创建：

- frozen Projection 含 pending/invalid，且当前 root 尚未超时；
- 本次 successor 的父 stage、gap、source snapshot、root/claim fence 可重算；
- 上一次 successor 带来新的可信 receipt/claim progress，或尚未消耗 successor 配额；
- `maxEvidenceSuccessors=2` 未达到；
- Reporter/Judge 资源可以在 90 秒内获得；
- successor 不会创建新的 scan，也不会改变旧 snapshot。

成功 successor 必须重新读取并产生新的 immutable binding；没有新可信进展、候选集合不减少或预算耗尽时立即 partial，不继续补料。`research_successor` 不能越权写 Today Projection，也不能把自己的任务数当作机会数。

### 9.3 硬停止谓词

Actor 在每次控制事务前后检查以下谓词；任一为真即终止当前 root/stage，不再生产新 child：

```text
root_elapsed >= 20 minutes
stage_attempt_count >= 2
source_count >= 80
successor_count >= 2
waiting_resource_elapsed >= 90 seconds
no trusted source / no complete receipt
snapshot revision/hash drift
no business progress since last successor
required channel blocked
candidate admission gap
parent/root cancelled, superseded, or fence invalid
Actor runtime epoch no longer current
```

“全库还有更多 source”“source_items 总数增长”“child 成功数增长”“历史 approved 数量增加”均不是继续谓词。`lastBusinessProgressAt` 只能由 source snapshot、plan/item、child/result、scope/projection 或合法 stage transition 的提交更新；heartbeat、lease renewal、audit 和普通 checkpoint 不算业务进展。

## 10. 预算、资源准入与公平

### 10.1 默认预算表

| 资源/预算 | 默认硬值 | 计数范围 | 超限动作 |
|---|---:|---|---|
| `maxSourcesPerRoot` | **80** | 一个 root 的 frozen source IDs | 稳定截断并记录 `SOURCE_BUDGET_EXHAUSTED`；不扩 snapshot |
| Reporter 并发 | **5** | 一个 workspace Actor 的 active Reporter leases | 第 6 个进入 durable waiting_resource |
| Judge 并发 | **1** | 一个 workspace Actor 的 active Judge claim | 其他 Judge 排队；不创建第二 claim |
| `maxEvidenceSuccessors` | **2** | 一个 root 的 successor attempts（失败/重放也计数） | `partial/EVIDENCE_SUCCESSOR_BUDGET_EXHAUSTED` |
| `maxStageAttempts` | **2** | 每个逻辑 stage family（F/scan/J/judge/Stage D） | 不再隐式 retry；terminal |
| root wall clock | **20 分钟** | intent admitted 到 root terminal | 可信部分 `partial`，无可信结果 `failed` |
| `waiting_resource` | **90 秒** | durable reserve 排队时间 | 释放等待 claim，terminal `RESOURCE_WAIT_TIMEOUT` |
| stage wall clock | `min(10 分钟, root 剩余)` | 单次 stage attempt | `MANAGER_STAGE_TIMEOUT`；由 root budget 优先裁决 |

阶段 10 分钟是 root 20 分钟内的单次上限；两次 attempt、successor 和资源等待不能突破 root 20 分钟。所有预算都持久化到 root/claim/result，重启不能重置计数。

### 10.2 Reserve-before-spawn

资源准入的线性顺序固定为：

```text
Actor claim
  → check root/stage/parent fence
  → reserve durable lease with expiry
  → persist managed_job_dispatch(state=reserved)
  → bind task identity
  → spawn external process
  → state=spawn_started/running
```

任何 spawn 前崩溃都由同一 dispatch identity 重放或 orphan；禁止先启动 Pi 再补登记。取消、超时、supersede 和 lease 失效都必须释放 Reporter/Judge lease。外部进程停止后等待 stdout/stderr drain 和 session 写入，再清理 cwd。

### 10.3 公平与防饥饿

- Owner intent、required repair 后 intent 优先于 scheduler；同优先级按 durable mailbox sequence FIFO。
- Background scheduler 不能占满 5 个 Reporter 槽；Actor 至少保留一个交互保留槽，或在交互 intent 到达时抢占尚未 spawn 的 background reserve。
- Judge 永远单例，但不同 root 不能互相修改对方 snapshot；排队记录预计等待和剩余 root budget。
- 超过 90 秒的等待不继续留在 `running`；它转为 `partial/failed`，并明确是资源不足而非“仍在工作”。

## 11. Owner、Manager 与 Today 透明度

### 11.1 Owner 交互边界

| 需要 Owner 的事项 | 状态 | Actor 行为 |
|---|---|---|
| 真实 eligible 候选题审批 | `waiting_owner` | 暂停业务推进，不再派新研究；批准/拒绝后完成当前 root |
| required channel 配置/登录/授权修复 | `needs_user` | 不创建 root/worker；修复 receipt 后自动重新 preflight |
| optional channel 缺席 | 不进入 `waiting_owner` | 排除、显示 coverage gap、继续或 partial |
| scan→judge handoff | 无 Owner 门 | Actor 自动、一次性、幂等完成 |
| evidence successor | 无 Owner 门 | Actor 在 2 次上限内自动完成 |
| clean-empty | `succeeded/emptyQualified` | 无 CTA、无点击要求 |
| 普通 retry/新 root | 不属于审批 | 只能由新的显式 intent 入口产生，绝不作为 Continue/resume 隐式发生 |

候选拒绝是对候选对象的业务结果，不会复活旧 root；若需要重新侦察，必须创建新 intent、新 root、新 snapshot。

### 11.2 Today 必须显示的完整状态

Today 的每个 workspace card 至少显示：

- `intentId`、`rootRequestId`、`orchestrationId`、`managerTaskId`、当前 `stageRequestId`（UI 可短显，详情可复制完整值）；
- producer source、rootMode、businessDate、创建时间、当前 actor runtime epoch；
- 每个 channel 的 required/optional、preflight status、receipt、失败原因和 coverage gap；
- 当前阶段、attempt `n/2`、root `elapsed/20m`、source `used/80`、successors `used/2`；
- Reporter `running/queued/waiting_resource` 与 `5` 上限、Judge `running/queued` 与单例状态；
- frozen source count、snapshot hash、PlanScope/projection hash、eligible/pending/invalid IDs；
- `lastBusinessProgressAt`、waiting resource 剩余秒数、stop predicate 和 finishedAt；
- 触发 origin：Owner、scheduler、MCP 或 reconcile；不得显示“今日最新任务”这种无法归属的标签。

状态文案必须区分：`preflight`、`scanning`、`judging`、`waiting_resource`、`waiting_owner`、`clean_empty`、`partial`、`failed`、`needs_user`、`cancelled`。不存在“资料已入库但请点击继续”这一泛化 CTA。

### 11.3 Projection 透明度

Today/Proposals/Manager 都从相同的 `readTodayRecommendationProjection(scopeIdentity)` 读回；机会数必须等于 `eligiblePlanItemIds.length`，并展示 eligible IDs 的集合摘要。原始 source 数、研究 claim 数、成功 child 数、历史 approved 数不出现在“机会数”字段中；如展示，必须使用不同业务标签。

## 12. 取消、重启与恢复

### 12.1 取消序列

```text
Owner/authorized system cancel command
  → Actor receipt + single-flight claim
  → fenced root/intent/stage CAS to cancelled
  → cascade active research claims, dispatches, consumptions to orphaned/CANCELLED_BY_OWNER
  → abort external workers; bounded stop and stdout/stderr drain
  → release all leases and queue reservations
  → write finished_at + terminal readback + event
  → broadcast Today/Manager update
```

如果命令到达时已 terminal，返回原 terminal 快照，不产生新写。旧 worker 的 event/result/mutation 只允许进入 audit，不能写新 root、PlanScope、Projection 或 content。source_items、已冻结 snapshot 和已提交的可信业务数据默认保留，不做删除/重置。

### 12.2 启动 gate 与恢复

应用接受任何新派工前必须：

1. 为当前 workspace 生成新的 runtime epoch，并以 CAS 接管唯一 `daily_reconcile_gates` 行；
2. 枚举 `agent_tasks running/resume_pending`、所有 active `daily_stage_claims`、managed dispatch/consumption 非终态和所有非终态 roots，不能只找 latest daily task；
3. 对每条记录校验 parent/root/stage/snapshot/cwd/session/hash/fence；
4. 未过期 lease 等待原 owner，过期 lease 才能同 identity 接管；
5. `cancelled` 或 superseded ancestor 的 child 全部 terminal/orphaned，不得恢复；
6. acceptance-only scenario 只能由 acceptance runner 终结，生产 reconciler 不 spawn；
7. 全部普通记录完成恢复或明确终结后，gate 才从本 epoch `pending → running → complete`，Actor 才接收新生产命令。

跨 epoch 的 terminal receipt 仍可只读重放，不因旧 epoch 变成 `WORKSPACE_STALE`；未完成 claim 的接管必须验证新 execution envelope。旧 epoch 的 tick、triggerNow、event、result、mutation 统一 `EXECUTION_AUTHORIZATION_INVALID`，只写 audit。

### 12.3 Full F→J 恢复

F 与 J 是同一 root 的两个独立 attempt：F 先冻结 source snapshot；handoff 事务同时把 F predecessor 置为 `succeeded/HANDOFF_CONSUMED/is_active=0/finished_at`，再创建唯一 J claim。崩溃恢复时只要看到 F 已消费，就不能再次创建 F 或 J；看到 F frozen 未消费，只有一个 fence owner 能完成 handoff。`channel_scanned` 是有 deadline 的 predecessor，不是无限 running。

### 12.4 Research 恢复

Research claim 的 active scope 是 `workspace + parentTaskId + gapId`，不是 stageRequestId 或日期。manifest、claim、task checkpoint 同事务提交；临时 cwd 在进程退出和输出 drain 前不得删除。父 stage supersede/cancel 时先 fenced 终结 research claim，旧 event 只能 audit，不可提交到新 parent。

## 13. 错误语义与动作矩阵

所有可见错误必须来自以下稳定矩阵；矩阵外错误统一为 `ORCHESTRATOR_CONTRACT_ERROR`，fail closed。`retry_*` 在本架构中是 Actor 内部的有界动作或新的显式 intent，绝不由 Continue 隐式触发。

| reasonCode | 操作/Root 终态 | Actor 动作 | Owner 是否需要决策 | 增量 |
|---|---|---|---|---|
| `CHANNEL_CONFIGURATION_REQUIRED` | needs_user；无 root | 等 required repair，重新 preflight | **是：修 required channel** | scan 0/judge 0 |
| `CHANNEL_LOGIN_REQUIRED` | needs_user；无 root | 等登录 repair，重新 preflight | **是：修 required channel** | 0/0 |
| `CHANNEL_PREFLIGHT_FAILED` | failed；无 root | fail closed，不绕过 | 否 | 0/0 |
| `OPTIONAL_CHANNEL_EXCLUDED` | root 可 running/partial | 排除 optional，显示 coverage gap | 否 | 不增加 scan |
| `CHANNELS_ALL_FAILED` | partial；无 worker | 终止 intent，等待新 intent | 否 | 0/0 |
| `NO_CONTINUATION_MATERIAL` | partial | 不创建 Reporter；显示“无可续接资料” | 否 | 0/0 |
| `SOURCE_SNAPSHOT_STALE` | partial | 丢弃当前 Judge，不重扫旧 root | 否 | 0/0 |
| `SCAN_HANDOFF_EXPIRED` | partial | 终止 predecessor，禁止再次 handoff | 否 | 0/0 |
| `SCORING_INCOMPLETE` | partial 或 successor 运行 | 自动 successor，最多 2 个且须有进展 | 否 | judge +1/以内 |
| `SCORING_INCOMPLETE_AND_INVALID` | partial | 只允许 bounded successor；额度耗尽即停 | 否 | judge +1/以内 |
| `INVALID_NEEDS_REPAIR` | partial | 保留 invalid 及原因，不伪造批准题 | 否 | 0 |
| `CANDIDATE_ADMISSION_GAP` | failed；scope commit 全回滚 | 不保留半条 plan/item；内部 bounded retry 或终止 | 否 | 0/0 |
| `RESOURCE_WAIT_TIMEOUT` | 有可信部分=partial；否则 failed | 释放 lease，停止派工 | 否 | 不增加 |
| `MANAGER_STAGE_TIMEOUT` | 无可信=failed；有可信=partial | fenced settle，不能 heartbeat 延期 | 否 | 按 failedStage |
| `MANAGER_WALL_CLOCK` | failed/partial | root 20m 硬终止 | 否 | 0 |
| `MANAGER_STALL` | failed/partial | 由 `lastBusinessProgressAt` 判定 | 否 | 0 |
| `PI_UNAVAILABLE` | needs_user | 不 spawn；恢复后新 intent | 否；配置/环境修复不是审批 | 0 |
| `MANAGER_ENTRY_FAILED` | control receipt failed；无 Manager/root/child | 不 fallback；显式新 intent 才能再试 | 否 | 0 |
| `MANAGER_CONTRACT_ERROR` | accepted 后 fenced failed/partial | 保存 `failedStage + lastCommittedBoundary`，撤销 lease | 否 | 观测前可信提交保留 |
| `REQUEST_REPLAY_CONFLICT` | receipt failed；原任务不变 | 只读原 attempt 或报告冲突 | 否 | 0 |
| `MANAGER_OWNERSHIP_REQUIRED` / `MANAGER_ORCHESTRATION_MISMATCH` | receipt failed；原任务不变 | 零写；打开绑定任务 | 否 | 0 |
| `WORKSPACE_STALE` / `EXECUTION_AUTHORIZATION_INVALID` | 新执行拒绝；terminal receipt 可读 | audit-only，等待当前 epoch | 否 | 0 |
| `PLAN_SCOPE_MISMATCH` | receipt failed；旧 scope 不变 | 零写，读原 scope | 否 | 0 |
| `TARGET_SNAPSHOT_STALE` / `EFFECT_REUSE_MISMATCH` | Stage D failed | 终止当前 claim；显式新 target/effect attempt | 否 | 0 |
| `NO_CURRENT_TARGETS` | Stage D skipped；scheduler root succeeded | no_action | 否 | 0 |
| `NO_ELIGIBLE_OPPORTUNITY` | succeeded + emptyQualified | no_action；Today 无 CTA | 否 | 0 |
| `CANCELLED_BY_OWNER` | cancelled | 级联停止、保留数据、不可恢复旧 root | 仅取消动作 | 0 |

任何错误不得默认翻译成“验证浏览器账号”。`MANAGER_CONTRACT_ERROR` 若缺 `failedStage` 或 `lastCommittedBoundary`，进一步归一为 `RESUME_CONTEXT_INVALID`，不猜重试路径、不扫描。

## 14. Producer 隔离与 clean cutover

### 14.1 封闭 allowlist

| Producer | rootMode/source | 唯一路径 | 是否可直接创建 worker |
|---|---|---|---|
| Today/Proposal UI | owner / `today_ui`、`proposal_ui` | `CreateIntent → Actor → preflight → Root/Stage` | 否 |
| MCP 显式人机请求 | owner / `mcp` | 同上，必须完整 identity | 否 |
| 09:00 scheduler | scheduler / `scheduler_0900` | `CreateIntent → Actor → Stage D` | 否 |
| rolling scan / workspace intelligence | scheduler / `rolling_scan` | `CreateIntent → Actor → full` | 否 |
| content cycle | scheduler 或显式 owner source | `CreateIntent → Actor → cycle-scoped Stage D` | 否 |
| orphan/reconcile | scheduler / `orphan_reconcile` | 只恢复原 identity | 否 |

新增 producer 必须先扩充此合同、字段、scope、事件和验收；allowlist 外调用一律拒绝并零业务写。

### 14.2 必须删除/禁用的旧路径

切换完成后，下列路径从生产执行面移除，不保留隐式兼容：

1. **direct scheduler starts**：scheduler 不得直接调用 `startDailyIntelligence`、`daily_scan` 或 `daily_judge`；只投递 Actor intent。
2. **generic Continue**：Today 不再把“继续更新选题池”映射到通用 start；不再创建无身份的 scan。没有 Continue/resume 按钮语义。
3. **manager legacy fallback**：Manager dispatch 异常不能 `catch → legacy pipeline`；接受前写 `MANAGER_ENTRY_FAILED`，接受后写 `MANAGER_CONTRACT_ERROR`。
4. **date-only recovery**：禁止按 `businessDate`、latest task、latest plan 或成功 child 数选择 root/Manager/job；缺 identity 只能 orphan/audit。
5. **direct producers**：任何 UI、MCP、content cycle、research successor 或 scheduler 直接生产 Reporter/Planner/Writer 都必须禁用。
6. **projection guesses**：禁止用 source count、child success count、research claim count、历史 approved count 或 current plan 猜机会数；唯一来源是 frozen PlanScope Projection。
7. **旧 `legacyPipeline` 运行分支**：新 managed request 类型不含 `legacyPipeline`；历史 legacy 仅可在离线迁移/审计模式读取，不可生产派工。
8. **进程内唯一性**：删除把 Map/Promise/timer 当作 durable dedupe、recovery 或 ownership 的行为。

### 14.3 历史迁移规则

迁移只处理可证明 provenance 的行：workspace、root、plan、source、receipt、data-root 必须形成唯一一致链。无法证明、冲突或仅有日期的行写 `orphaned/WORKSPACE_PROVENANCE_UNKNOWN` 或对应 migration reason，不盲填当前 workspace，不注入 active 查询。旧 daily/research scope 冲突按固定排序选 winner，loser 原位 orphan；迁移重放必须选同一 winner。

迁移期间不得删除 source、claims、versions 或历史 receipt；不得把旧 `running/resume_pending` 强行改成 succeeded。恢复/终结必须经过正常 Actor/reconcile fence。

## 15. 部署顺序

本节是后续实现和发布的唯一部署顺序，设计阶段不执行这些动作。

### 15.1 阶段 0：冻结与基线

1. 冻结本设计、identity/hash registry、状态/错误矩阵和 producer allowlist。
2. 对现有 workspace 做只读基线：data-root、包/app.asar hash、active task/root、source/claim/version 计数和已知 phantom；不把计数当机会数。
3. 对运行中的旧任务走正常 cancel/reconcile；不手工改 DB，不启动第二条直通管道。

### 15.2 阶段 1：新增耐久存储与 gate

1. 添加 actor、intent、preflight、root/claim、snapshot、PlanScope、managed dispatch/consumption、receipt、event 和 reconcile gate schema。
2. 加唯一键、partial active index、revision/epoch/lease CAS 和 append-only event；旧行只按 provenance 迁移或 orphan。
3. 运行 workspace migration 读回：同一 workspace 只一 actor；每个 scope 最多一个 active；unknown provenance 全部不进入 active 查询。

### 15.3 阶段 2：接入 Actor 与共享 API

1. 先上线 Root/Stage/identity/claim/snapshot/job/effect 的共享 API 和 startup gate。
2. 接入 ManagerAdapter，让 Manager 只读 Actor/Projection；接入 reserve-before-spawn 和 parent fence。
3. 在 staging/验收环境验证失败先行的最小 fixture；不以旧 focused tests 代替新合同。

### 15.4 阶段 3：一次性 clean cutover

1. 停止接受旧 direct producer；切换所有 allowlist producer 到 Actor typed intent。
2. 删除 generic Continue、legacy fallback、date-only selector 和 projection guess；新 managed 请求不再携带 legacy 字段。
3. 开启每 workspace startup reconcile；只有本 epoch gate complete 后允许新 root。
4. 先 canary 一个真实 workspace，再扩到其他 workspace；每个 root、stage、projection、coverage gap 和终态都可读回。

### 15.5 阶段 4：真实验收与扩容

在当前安装包中执行真实 Windows path：记录 package/app.asar hash、data-root、runtime epoch、root/stage/job IDs；验证 Owner 与 scheduler 同日重叠时仍由同一个 workspace Actor 控制、不同 orchestration 隔离，并走完整 `preflight → scan → judge → projection → waiting_owner/clean_empty`。不要使用 seed/fabricated data、headless substitution、旧包或隐藏 fallback。

## 16. Rollout 与 Rollback

### 16.1 Rollout

- **Canary gate**：required/optional preflight、Actor 单 lease、Reporter 5/Judge 1、root 20m 和 projection hash 全部读回后才扩大。
- **渐进开关**：开关只控制是否接受新的 Actor intent，不恢复旧 direct path；关闭时当前 root 仍必须正常 terminal/cancel/reconcile。
- **成功标准**：连续真实 roots 在预算内 terminal；无 date-only ownership、无长期 running、无 Manager fallback、无 opportunity count mismatch；clean-empty 不需要点击，candidate 才等待 Owner。
- **证据保留**：保留完整 event/receipt/snapshot/projection/settlement 链，安装包与 app.asar hash 相符。

### 16.2 Rollback

Rollback 是**安全停机/回到上一版已支持 Actor 的版本**，不是恢复已删除的 legacy 行为：

1. 停止接受新 intent；不删除、不重置、不去重业务数据。
2. Actor 让 active roots 在 root deadline 内 terminal，或走正常 cancel；撤销所有 lease，旧进程迟到写入 audit-only。
3. 若当前版本已有上一版 Actor-compatible binary，部署该版本并以新 runtime epoch 重新 reconcile；若没有，保持服务停在 gate/maintenance，而不是启用 direct scheduler 或 date-only recovery。
4. 保留新 schema 和 immutable snapshots；只有经过 schema-aware backup restore、active root 为零且审计批准时才回滚数据，禁止手工 SQL 覆盖终态。
5. 修复后从新 intent/new root 重新开始；旧 root、旧 projection、旧 effect 不复活。

## 17. Observability 与审计

### 17.1 事件

Actor 必须追加以下事件并带全量 identity：

```text
intent.received / intent.replayed / intent.conflict
preflight.started / preflight.channel_result / preflight.completed
root.created / root.superseded / root.cancelled / root.terminal
stage.claimed / resource.waiting / resource.reserved / worker.spawned
snapshot.frozen / snapshot.stale / scan.handoff_consumed
plan_scope.building / candidate.admitted / plan_scope.frozen
projection.computed / evidence.successor.created
manager.checkpoint / owner.waiting / owner.decision
settlement.committed / reconcile.taken_over / reconcile.orphaned
error.normalized / lease.released / terminal.readback
```

每条事件必须保存 `workspaceId, businessDate, source, intentId, rootRequestId, rootGeneration, orchestrationId, managerTaskId, stageRequestId, requestId, operationRequestId, parentTaskId, jobId, causationId, actorEpoch, ownerEpoch, leaseToken fingerprint, projection/snapshot hash`。日志禁止写完整凭据和不必要的原始正文。

### 17.2 指标和告警

- root terminal ratio：succeeded/empty、waiting_owner、partial、failed、needs_user、cancelled；
- preflight required/optional failure 与 coverage gap 数；
- Reporter `running/queued/waiting_resource`、Judge queue depth、最长等待、lease churn；
- source 80 上限命中、successor 0/1/2、`lastBusinessProgressAt` 停滞；
- snapshot stale、candidate admission gap、ownership/replay conflict、old epoch rejected；
- Manager/UI/Projection 的 eligible ID set/hash 一致性；
- active root 超过 18 分钟、resource wait 超过 60 秒、无业务进展接近 stage deadline、actor lease 冲突或 orphan 增长时告警。

所有指标按 workspace、source、root、stage 分组，不按日期把不同 orchestration 合并。

## 18. Security 与数据完整性

1. workspace/data-root 是所有查询、唯一键、hash preimage 和授权的第一维度；跨 workspace binding 直接 `MANAGER_ORCHESTRATION_MISMATCH`、零写。
2. Actor lease、root/stage claim、Manager checkpoint、PlanScope、dispatch、consumption、settlement 全部使用 revision + ownerEpoch + leaseToken fenced CAS；终态单调且不可覆盖。
3. Manager 的 presentation grant 与 Reporter/Planner/Writer 的 role grant 分离；Manager 不能借 worker 身份写业务结果；员工不能提升权限。
4. source/receipt/plan item/target 的完整业务 payload 都有 revision + canonical content hash；hash 漂移、内容变而 revision 不变、未知字段边界或伪造 hash 均 fail closed。
5. command identity 与 execution authorization 分离；旧 epoch 不能提交新业务写，terminal replay 不因授权变化而重复派工。
6. 凭据、cookie、token、原始私密正文不写普通 event/log；Today 只展示 Owner 有权读取的摘要和稳定 ID。
7. 外部工具调用必须记录目的、role、root/stage/parent 和结果 hash；失败不会被包装成成功，孤立 receipt 不能计入 claims/version/机会。
8. 任何数据库修复必须走版本化迁移或共享 store；禁止手工 delete/reset/seed/“把 running 改 succeeded”。
9. 内容发布不属于本编排 root 的自动终态；即使候选获得批准，也只能进入既有受控项目/Writer 流程，不能绕过发布授权。

## 19. Acceptance Scenarios

每个场景都必须用持久 receipt、数据库行、event、hash 和真实业务 readback 证明；单张截图、child 数、全库计数或旧测试绿灯不构成通过。

| ID | 场景 | 必须观察到的结果 |
|---|---|---|
| A01 | required 与 optional preflight 混合，required ready、optional 缺登录 | preflight 在 root/worker 前完成；root 只含 ready channels；optional coverage gap 可读；无 Owner waiting_owner |
| A02 | required channel 缺登录 | 只有 intent/preflight/audit；无 root、claim、Reporter/job；`needs_user/CHANNEL_LOGIN_REQUIRED`；修复后新 preflight/new root |
| A03 | 所有选定渠道 preflight 失败 | 无 root/worker；稳定 `CHANNELS_ALL_FAILED` 或 needs_user；不伪造 clean-empty |
| A04 | 首次 full | F scan 与 J judge 各自拥有独立 stage/request/operation receipt；F handoff 原子消费；J 不创建 Reporter |
| A05 | scan 冻结后自动 judge | 不点击 Continue；scan 增量 1、judge 增量 1；只创建一个 J；重复 event/restart 不新增 |
| A06 | Actor/应用在 handoff 前崩溃，持久 predecessor 仍为 `awaiting_judge` 且有 trusted source | Actor 通过显式 predecessor/snapshot identity 自动完成一次受限 judge handoff；不重新 scan；无日期猜测；已 terminal 的 partial root 不被重新激活 |
| A07 | scan 没有 trusted material | `partial/NO_CONTINUATION_MATERIAL`；不创建 judge/Reporter；不显示继续按钮 |
| A08 | Judge 开始后 source revision/hash 变化 | `SOURCE_SNAPSHOT_STALE`；不读入新 source，不重扫旧 root；snapshot/hash 旧记录不变 |
| A09 | Planner 输出一个完整 eligible candidate | Projection eligible 集合非空且无 pending/invalid；root `waiting_owner`；Today 候选数等于 eligible ID 数，出现审批入口 |
| A10 | Planner 输出合法零候选 | frozen empty PlanScope/Projection 持久存在；`succeeded + emptyQualified=true`；Today 显示无新机会且无点击要求 |
| A11 | pending、invalid 与 eligible 七种组合 | 每种组合按固定优先级读回；含 pending/invalid 均非 waiting_owner；批准控件只覆盖 eligible IDs |
| A12 | evidence gap 有新进展 | successor 自动运行，最多 2 个；每次 parent/snapshot/claim identity 可追溯；无新进展或第 2 个后 partial，不继续 churn |
| A13 | Reporter 资源竞争 | 同 workspace 最多 5 个 active Reporter；第 6 个 durable waiting_resource；90 秒后 terminal 并释放 lease |
| A14 | Judge 资源竞争 | 同 workspace 始终最多 1 个 active Judge；另一个 root 排队；不创建双活 claim |
| A15 | root 达到 80 sources | source snapshot 恰好最多 80；超额数和排序可读；不按全库库存扩容 |
| A16 | root 达到 20 分钟或 stage 第 2 attempt | 在 deadline 内写 finished_at、终态、stop reason；heartbeat 不能延长；不创建第 3 attempt |
| A17 | Manager 异常发生在 accept 前/后 | accept 前仅 `MANAGER_ENTRY_FAILED` receipt、root/child/业务写为 0；accept 后保存 failedStage/lastCommittedBoundary，旧可信提交保留，后续 zero write；绝不 fallback |
| A18 | 同日 Owner 与 scheduler 并发 | 同一 Actor 串行控制但创建不同 source/root/orchestration；Manager/job/event/projection 不串单；不按日期选 latest |
| A19 | Stage D 无 target / 有 target | 无 target 只 `skipped/NO_CURRENT_TARGETS`，不选全库 approved；有 target 只处理 frozen target IDs/triples |
| A20 | Stage D effect 成功跨 orchestration 复用 | 源 dispatch 不变；消费方有自己的 consumption identity；sourceResultHash 相同；重放不新增；失败/partial/cancelled 不可复用 |
| A21 | cancel 在 Reporter/Judge/consumption 中途发生 | root/Manager/claim cancelled；dispatch/consumption orphaned；lease 清空、finished_at 存在；重启不接管；迟到 token 零业务写 |
| A22 | Actor/应用崩溃后重启 | 新 epoch 运行 startup gate；枚举 root/claim/dispatch/consumption 全部 active；同 identity 接管或终结；不创建第二 root，不遗留 running |
| A23 | research cwd 提前失效、requestId 冲突、父级 supersede | 失败可读；无假成功；父 fence 级联终结；旧 event/result 只 audit；不会按日期复用其他 parent |
| A24 | projection/source/job 计数不同 | Today、Manager、DB 使用同一 eligible ID set/hash；source/claim/child 分别以自己的标签显示；不出现“成功 child=机会” |
| A25 | clean cutover 静态与动态检查 | direct scheduler、generic Continue、manager legacy fallback、date-only recovery、direct producer、projection guess 的调用为零或明确拒绝；allowlist 外 intent 零写 |
| A26 | 新 runtime epoch 接管旧 epoch | 旧 tick/trigger/event/result/mutation 均 `EXECUTION_AUTHORIZATION_INVALID` audit-only；terminal receipt 可读；当前 epoch 正常继续 |
| A27 | old root retry | 旧 root fenced terminal；新 retry root 有新 generation/ordinal/identity；双击只读同一新 root；旧 root 不回 running |
| A28 | 安装版真实透明闭环 | 包/app.asar/data-root/runtime/root/stage IDs 可读；自动阶段在预算内终态；候选、clean-empty、partial 的 UI 与 Projection 一致；无 seeded/fallback/headless substitution |

### 19.1 Acceptance 的唯一强证据

- 阶段推进：`orchestrator_events + daily_stage_claims + managed_job_dispatches` 的同一 identity 链；
- 候选终态：frozen `daily_plan_scopes.scope_hash + projection_hash + eligible/pending/invalid IDs` 与 Manager/Today readback 一致；
- 资源预算：Actor lease/reservation rows 和 bounded timestamps；
- 恢复：新 runtime epoch 的 reconcile gate、旧 claim revision/epoch 失败和新 owner 的唯一接管行；
- clean cutover：静态调用者枚举 + 运行中拒绝记录 + 无 legacy/direct dispatch；
- 真机：当前安装包/app.asar hash、data-root、PID/runtime epoch、root/stage/job/readback/业务产出形成同一 causation chain。

## 20. 已决策的风险与自检

本节是设计写入前的 inline self-review；每一项都已给出唯一决策，不留双重解释。

| 自检项 | 发现的风险 | 本设计的决定与修复 |
|---|---|---|
| 占位/未完成项 | 过往方案以“实现时再决定”留下字段和状态空洞 | 本文固定 schema、状态、reason、动作、预算、acceptance；无未定义占位项 |
| 术语矛盾 | `waiting_owner`、`needs_user`、`partial` 可能混用 | waiting_owner 仅候选审批；required repair 是 needs_user；资料/证据不完整是 partial；clean-empty 是 succeeded |
| 双重 authority | Manager、Actor、UI、DB 都可能猜状态 | Actor/claim/root 是生命周期 SSOT；PlanScope/Projection 是机会 SSOT；Manager 只呈现/转发；Today 不自行推断 |
| optional channel 与 clean-empty | optional 失败后零候选可能被误报为全局空 | optional 失败排除并显示 gap；有候选可 waiting_owner；零候选只能 partial，不得 clean-empty |
| full 的双 attempt | F scan 与 J judge 可能复用同一 request/receipt | F/J 各自 stage/request/operation/receipt；F handoff 原子消费并创建唯一 J |
| 重试与幂等 | 同 request 重放、显式 retry、跨 epoch 容易混淆 | replay 复用同一 receipt；retry 是新 intent/root/generation；logical hash 与 execution envelope 分离 |
| 资源 starvation | 等待任务可无限堆积、heartbeat 掩盖无进展 | Reporter=5、Judge=1、reserve-before-spawn、waiting_resource=90s、lastBusinessProgressAt 不被 heartbeat 刷新 |
| scope 漂移 | Judge/Stage D 运行中读实时全库 | source/PlanScope/target/effect 全部 immutable；revision+content hash 双校验 |
| Manager 独立生产 | Manager 可能变成第二个 scheduler | Manager 无 spawn/JobPool 权限；所有命令回 Actor；allowlist 外零写 |
| 背景透明 | scheduler/恢复可能制造用户未知任务 | 每个 intent 显示 source、root、预算和 causation；启动只 reconcile，不新建 root |
| 迁移污染 | 旧日期数据可能盲填 workspace 或串 Manager | 只迁移可证明 provenance；冲突/未知 orphan；不删除、不伪造、不按日期恢复 |
| acceptance 可证伪性 | 截图、child count、focused test 可能被误当闭环 | 每个场景绑定 durable event/row/hash/readback；真机要求 package/data-root/causation chain |
| 设计范围失控 | 可能顺手改发布、品牌或全库数据 | 非目标明确排除；本文只设计 Orchestrator 控制面及其纳管边界 |
| rollback 复活旧风险 | 回滚可能重新启用 legacy/direct path | rollback 只回到 Actor-compatible 版本或安全停机；永不恢复 direct/legacy/date-only 行为 |

### 20.1 最终不变量

1. 没有完成全渠道 preflight，就没有 Root、Reporter 或 worker。
2. 没有 frozen predecessor，就没有 Judge；没有 frozen target/effect，就没有 Stage D child。
3. 没有真实 eligible candidate，就没有 `waiting_owner`。
4. 没有完整可信 receipts 且不存在 pending/invalid/coverage gap，就没有 clean-empty。
5. 没有 durable receipt/claim/fence，就没有可重放、可恢复或可验收的业务写入。
6. 没有新的可信业务进展，就没有新的自动 successor。
7. 没有当前 runtime epoch/lease，就没有业务写入。
8. terminal root、stage、scope、projection、dispatch、consumption 永不原位回退；新尝试必须是新 identity。
9. Manager 只呈现和控制业务决策，不是独立 task producer。
10. 本文定义之外的入口、状态、reason 或 projection 来源均视为非法，必须拒绝并零业务写。

**结论**：WeMediaBuddy 的唯一生产编排路径是“producer intent → durable per-workspace Actor → required/optional preflight → fenced root/stage → immutable snapshot → bounded automatic progression → exact Projection → Manager/Today presentation and candidate approval”。该路径在预算、身份、恢复、权限、透明度和 clean cutover 上闭合；实现必须以本文为单一设计合同，不得恢复已明确删除的旧路径。
