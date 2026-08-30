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

### 5.1 Versioned identity 与 hash registry（规范修正）

本节的 registry v1 是所有 identity/hash 的唯一派生权威；后文的 `canonicalBusinessJson`、`canonicalJson` 或未列入 registry 的 `derive*` 均不得作为实现接口。实现必须把 registry version、preimage schema version、canonical bytes hash 一并写入对应 durable row，不能由调用方自报派生值。

`canonicalJsonV1(x)` 的输入先按 registry schema 校验：未知字段、重复对象键、`undefined`、NaN、Infinity 和超出 schema 的枚举值直接拒绝；缺失的已声明字段归一为 `null`，但“缺失”与业务上显式 `null` 的区分若属于业务语义，必须在 schema 中用显式 presence 字段表达。对象键按 Unicode code point 递归升序；字符串先 Unicode NFC；语义时间统一以 DB 持久化 instant 的 UTC ISO-8601 毫秒序列化（客户端时间不得写入），而 DB monotonic tick 只作为独立的 deadline/watermark 字段；数值使用最短十进制，`-0` 归一为 `0`；二进制使用标准 base64。集合数组必须按 registry 指定的 stable key（通常为 ID，再为 hash）升序并去重；同一 stable key 携带不同 payload 时拒绝，声明为有序数组的数组保持原顺序。不得使用本地化排序、浮点格式、时区、随机字段或数据库返回顺序。

```text
canonicalBytesV1(x) = UTF8(canonicalJsonV1(x))
H_v1(x)             = hex_lower(sha256(canonicalBytesV1(x)))
```

下面是完整的 v1 派生注册表。花括号内是完整 preimage 字段，不得用“input”“context”或实时全库查询替代；`null` 仅表示该字段按 registry schema 明确为空。

```text
commandReplayKey  = H_v1({r:"command-replay/v1", workspaceId, producer, requestId})
invocationId      = H_v1({r:"invocation/v1", workspaceId, intentId, producer,
                          requestId, invocationOrdinal})
logicalInputHash  = H_v1({r:"logical-input/v1", workspaceId, businessDate, source,
                          rootMode, requestedAction, normalizedPolicyHash,
                          logicalInput, acceptance, predecessorIntentId,
                          predecessorRootId})
rootRequestId     = H_v1({r:"root-invocation/v1", workspaceId, intentId,
                          invocationId, businessDate, source, rootMode,
                          rootGeneration, retryInvocationOrdinal,
                          predecessorRootId, logicalInputHash})
orchestrationId   = H_v1({r:"orchestration/v1", workspaceId, rootRequestId,
                          rootGeneration, businessDate, source, rootMode})
stageRequestId    = H_v1({r:"stage/v1", workspaceId, rootRequestId,
                          orchestrationId, rootGeneration, stageFamily,
                          stageAttemptOrdinal, retryGeneration,
                          parentStageRequestId, predecessorHash,
                          logicalInputHash})
operationRequestId = H_v1({r:"operation/v1", workspaceId, stageRequestId,
                           operationKind, operationOrdinal, operationInputHash})
effectRequestId   = H_v1({r:"effect/v2", workspaceId, orchestrationId,
                          stageRequestId, effectLogicalKey,
                          effectAttemptOrdinal, effectSetHash, roleId,
                          sinkName, sinkContractVersion, deliveryMode})
childIdentityKey  = H_v1({r:"child/v1", workspaceId, operationRequestId,
                          effectRequestId, roleId, childOrdinal})
preflightId        = H_v1({r:"preflight/v1", workspaceId, intentId,
                            profileRevision, policyHash, preflightVersion})
preflightHash      = H_v1({r:"preflight-snapshot/v1", workspaceId, intentId,
                            preflightId, profileRevision, policyHash,
                            preflightVersion, orderedSelectedChannels,
                            orderedChannelResults, readyChannelIds,
                            excludedOptionalChannelIds, requiredFailures,
                            coverageGap, aggregateDeadline, status})
executionEnvelopeHash = H_v1({r:"execution-envelope/v2", workspaceId,
                              actorEpoch, ownerEpoch, authorityRevision,
                              leaseTokenFingerprint, rootRequestId,
                              rootGeneration, stageRequestId, claimRevision,
                              operationRequestId, effectRequestId,
                              childIdentityKey, jobId, launchAttemptId, roleId,
                              parentFence, issuedAtUtc, expiresAtUtc,
                              expiresAtMono, rootDeadlineUtc, rootDeadlineMono,
                              stageDeadlineUtc, stageDeadlineMono,
                              gateDeadlineUtc, gateDeadlineMono,
                              producerAttestationHash, buildId, schemaEpoch,
                              argvHash, cwdFingerprint, sessionKey})
producerAttestationHash = H_v1({r:"producer-attestation/v1", workspaceId,
                               requestId, producerId, registryEntryHash,
                               censusHash, triggerId, processId,
                               processStartTimeUtc, processStartTimeMono,
                               processImagePath, resourcesPath, buildId,
                               sourceCommit, packageHash, appAsarHash,
                               schemaEpoch, cutoverEpoch, runtimeEpoch,
                               writePrincipal, authorizerRevision})
effectToken        = H_v1({r:"sink-token/v2", workspaceId,
                            effectRequestId, roleId, sinkName,
                            sinkContractVersion, deliveryMode, payloadHash})
mailboxEnvelopeHash = H_v1({r:"mailbox-envelope/v1", workspaceId,
                            mailboxSequence, commandReplayKey, requestId,
                            intentId, producer, priority, coalescingKey,
                            coalescingMode, causationId, logicalInputHash,
                            normalizedPolicyHash, payloadHash})
sourceSnapshotHash = H_v1({r:"source-snapshot/v1", workspaceId, rootRequestId,
                           stageRequestId, preflightId, policyHash,
                           selectedChannelPartition, successfulReceipts,
                           failedChannelPartition, unresolvedChannelPartition,
                           orderedSourceBindings, sourceCap, watermarkUtc,
                           watermarkMono})
repairSnapshotId  = H_v1({r:"repair-snapshot-id/v1", workspaceId,
                          predecessorStageRequestId, predecessorScopeHash,
                          sourceSnapshotHash, repairOrdinal,
                          orderedRepairIdentityKeys})
repairBindingChildHash = H_v1({r:"repair-binding-child/v1", workspaceId,
                               repairSnapshotId, childOrdinal, planItemId,
                               priorItemRevision, priorItemContentHash,
                               repairedItemRevision, repairedItemContentHash,
                               receiptId, receiptRevision,
                               receiptPayloadHash})
repairSnapshotHash = H_v1({r:"repair-snapshot/v2", workspaceId,
                           repairSnapshotId, predecessorStageRequestId,
                           predecessorScopeHash, sourceSnapshotHash,
                           orderedRepairBindingChildHashes})
bindingHash       = H_v1({r:"repair-binding/v2", workspaceId,
                          predecessorStageRequestId, predecessorScopeHash,
                          sourceSnapshotHash, repairSnapshotId,
                          repairSnapshotHash,
                          orderedRepairBindingChildHashes})
scopeHash         = H_v1({r:"plan-scope/v1", workspaceId, stageRequestId,
                          rootRequestId, sourceSnapshotHash, bindingHash,
                          orderedAllowedPlanIds, orderedAllowedItemIds,
                          orderedCarryItemIds, trustedReceiptIds, scopeJson})
projectionHash    = H_v1({r:"projection/v2", workspaceId, businessDate,
                          managerTaskId, orchestrationId, stageRequestId,
                          scopeHash, bindingHash, repairSnapshotHash,
                          planIds, asOf, orderedEntries,
                          candidatePlanItemIds, eligiblePlanItemIds,
                          pendingPlanItemIds, invalidPlanItemIds,
                          trustedReceiptIds, emptyQualified})
eligibleIdsHash   = H_v1({r:"eligible-ids/v1", workspaceId, rootRequestId,
                          stageRequestId, scopeHash, projectionHash,
                          orderedEligiblePlanItemIds})
targetSetHash     = H_v1({r:"target-set/v1", workspaceId, cycleId,
                          orderedTargetTriples})
effectSetHash     = H_v1({r:"effect-set/v1", workspaceId, stageRequestId,
                          targetSetHash, orderedEffectSpecs, coverage})
settlementHash    = H_v1({r:"settlement/v1", workspaceId, stageRequestId,
                          orderedTerminalResults, consumptionResults,
                          projectionHash, effectSetHash})
```

`requestId` 是显式命令的 replay key，不是业务输入 hash。相同 `(workspaceId, requestId)` 且 command/logicalInput/policy hash 相同的重放只读原 `command_receipts`/intent；相同 requestId 携带任何不同字段必须返回 `REQUEST_REPLAY_CONFLICT`，不得创建第二 intent。两个合法显式 invocation 即使所有业务字段相同，只要 requestId 不同，Actor 必须在同一控制事务中分配不同的 `invocationOrdinal`（首个为 1，之后严格递增）和不同 `intentId/invocationId/rootRequestId`；因此不能误判 replay，也不能把新 invocation 合并掉。retry 必须使用新 requestId、新 intent、新 ordinal、新 rootGeneration，`predecessorRootId` 只表达血缘，不改变旧 root 的 terminal 性。

`logicalInputHash` 永远不含 runtime epoch、owner epoch、lease token、PID、grant 或 wall-clock；这些只进入 versioned `executionEnvelopeHash`。`stageRequestId`、`operationRequestId`、`effectRequestId`、`childIdentityKey` 是不同 registry 项，绝不互作别名。所有 registry 项必须在 DB 中以 `(registryName, registryVersion, preimageHash, derivedValue)` 记录，验收可按同一 preimage 重算并逐字节比较；没有 registry 记录的派生值一律 fail closed。
`repairSnapshotId` 是 Actor 在创建一次修复 binding 时按 `repair-snapshot-id/v1` preimage 一次生成的稳定 identity；`repairOrdinal` 在同一 predecessor stage 严格递增，`orderedRepairIdentityKeys` 是按 stable key 排序的待修复 item/receipt identity，不能使用随机 UUID、当前时间或数据库返回顺序。相同 preimage 必须重放同一 ID；不同 predecessor、ordinal、item key 或 source snapshot 必须得到不同 ID，冲突只返回原 canonical row。

修复 hash 严格按以下非循环顺序派生：先对每个 child 只用 `repair-binding-child/v1` 的字段计算 `repairBindingChildHash`；该 child preimage 明确排除 `repairSnapshotHash`、`bindingHash`、parent row 的创建时间、数据库自增值和任何回填后的 hash。再按 `childOrdinal` 计算 `repairSnapshotHash`，最后用 `repairSnapshotHash + orderedRepairBindingChildHashes` 计算 `bindingHash`。`orderedRepairBindings` 不再作为含 parent hash 的直接 preimage。三个派生值及其完整 canonical preimage/schema version/canonical bytes hash 必须在同一 freeze transaction 写入 `identity_hash_registry`，`daily_repair_snapshot_bindings` 以 FK/registry name+version 引用它们；缺任一 registry row、bytes 回读不等或顺序不一致即 fail closed。

`projectionHash` 覆盖 `TodayRecommendationProjection` 的每一个语义字段（包括 `workspaceId,businessDate,managerTaskId,orchestrationId,stageRequestId,scopeHash,bindingHash,repairSnapshotHash,planIds,asOf,entries,candidatePlanItemIds,eligiblePlanItemIds,pendingPlanItemIds,invalidPlanItemIds,trustedReceiptIds,emptyQualified`）；`projectionHash` 自身不进入 preimage。initial scope 的 `bindingHash/repairSnapshotHash` 可按 §8.3 的 nullable variant 为 `null`，该 `null` 也必须进入 canonical preimage。


### 5.2 核心表与唯一约束

以下表为设计所需的逻辑 schema；实现可使用等价列或 JSON，但必须保留同样的不可变字段、CAS 条件和唯一性。

#### `workspace_orchestrator_actors`

```text
workspace_id PK
actor_status: active | stopping | failed
runtime_epoch, owner_epoch, authority_revision
lease_token, lease_expires_at_utc, lease_expires_mono,
control_stall_deadline_utc, control_stall_deadline_mono,
gate_deadline_utc, gate_deadline_mono
invocation_ordinal
mailbox_sequence, checkpoint_revision
migration_epoch, write_fence, current_build_id
last_business_progress_at
acceptance_run_id NULL, baseline_event_sequence NULL,
baseline_checkpoint_revision NULL, created_after_event_sequence NULL,
created_after_checkpoint_revision NULL, created_after_mono NULL
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
               repair_required_channel | configure_optional_channels |
               select_channel | repair_invalid_candidate | cancel_root |
               start_new_intent
request_id, command_replay_key, invocation_id, invocation_ordinal, causation_id
producer_id, producer_registry_entry_hash, producer_census_hash, trigger_id,
producer_attestation_hash
logical_input_hash, normalized_policy_hash, predecessor_intent_id
channel_policy_json: 每个 channelId 的 required/optional 分类
preflight_id, root_request_id NULL, orchestration_id NULL
next_action_json, checkpoint_revision, acceptance_run_id NULL
baseline_event_sequence NULL, baseline_checkpoint_revision NULL,
created_after_event_sequence NULL, created_after_checkpoint_revision NULL,
created_after_mono NULL
status: received | preflight_pending | preflight_running | waiting_resource |
        admitted | running | waiting_owner | succeeded | partial | failed |
        needs_user | cancelled
preflight_deadline_utc, preflight_deadline_mono, budget_json,
coverage_gap_json, stop_reason_json
created_at, updated_at, finished_at
```

唯一键：`(workspace_id, request_id)`；同 request 重放只读原 intent。`business_date` 只作业务维度，绝不作为 ownership selector。

#### `channel_preflight_snapshots`

```text
preflight_id PK
workspace_id, intent_id, business_date, source
profile_revision, policy_hash, preflight_version
selected_channels_json: [{channelId, requiredness, module}]
results_json: [{channelId, requiredness, status, reasonCode, capability,
                configRevision, authRevision, capabilityRevision,
                capabilityLeaseId, probeRequestId, probeReceiptHash,
                checkedAtUtc, expiresAtUtc, expiresAtMono}]
ready_channel_ids_json, excluded_optional_channel_ids_json
required_failures_json, coverage_gap_json,
aggregate_deadline_utc, aggregate_deadline_mono
preflight_hash, status: frozen | failed | needs_user
acceptance_run_id NULL, baseline_event_sequence NULL,
baseline_checkpoint_revision NULL, created_after_event_sequence NULL,
created_after_checkpoint_revision NULL, created_after_mono NULL
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
checkpoint_revision, owner_epoch, lease_token,
lease_expires_at_utc, lease_expires_mono,
root_deadline_utc, root_deadline_mono, gate_deadline_utc, gate_deadline_mono
acceptance_scenario_id NULL, acceptance_run_id NULL, barrier_id NULL, runner_epoch NULL
baseline_event_sequence NULL, baseline_checkpoint_revision NULL,
created_after_event_sequence NULL, created_after_checkpoint_revision NULL,
created_after_mono NULL
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
is_active, claim_revision, owner_epoch, lease_token,
lease_expires_at_utc, lease_expires_mono,
stage_deadline_utc, stage_deadline_mono,
control_stall_deadline_utc, control_stall_deadline_mono
snapshot_json, child_ids_json, result_json
acceptance_scenario_id NULL, acceptance_run_id NULL, barrier_id NULL, runner_epoch NULL
baseline_event_sequence NULL, baseline_checkpoint_revision NULL,
created_after_event_sequence NULL, created_after_checkpoint_revision NULL,
created_after_mono NULL
created_at, updated_at, finished_at
```

日常 claim 的 active scope：`daily:${workspaceId}:${managerTaskId}:${orchestrationId}:${attemptStage}`；Stage D：`daily-stage-d-claim:${workspaceId}:${cycleId}`；research：`research:${workspaceId}:${parentTaskId}:${gapId}`。同一 active scope 的 partial unique index 只允许一个 active claim；generation+1 必须先看到前代 `is_active=0`。

#### `source_snapshots`

```text
snapshot_id PK
workspace_id, business_date, source_task_id, root_request_id, root_generation,
stage_request_id, scan_attempt_id, preflight_id, policy_hash, profile_revision
selected_channel_ids_json
successful_channels_json: [{channelId, preflightId, scanAttemptId, receiptId,
                             receiptRevision, receiptPayloadHash, resultHash}]
failed_channels_json: [{channelId, reasonCode, requiredness, receiptId}]
unresolved_channels_json: [{channelId, reasonCode, requiredness, receiptId}]
source_ids_json
source_bindings_json: [{workspaceId, rootRequestId, rootGeneration, stageRequestId,
                        scanAttemptId, preflightId, policyHash, channelId,
                        receiptId, receiptRevision, receiptPayloadHash, sourceId,
                        sourceRevision, sourceContentHash, provenanceOrdinal,
                        acceptanceRunId, baselineEventSequence,
                        baselineCheckpointRevision, createdAfterEventSequence,
                        createdAfterCheckpointRevision, createdAfterMono}]
receipt_ids_json
receipt_bindings_json: [{workspaceId, rootRequestId, stageRequestId, scanAttemptId,
                         preflightId, channelId, receiptId, receiptRevision,
                         receiptPayloadHash, resultHash, acceptanceRunId,
                         baselineEventSequence, baselineCheckpointRevision,
                         createdAfterEventSequence, createdAfterCheckpointRevision,
                         createdAfterMono}]
watermark_utc, watermark_mono, captured_at_utc, excluded_by_budget_count, snapshot_hash
acceptance_run_id NULL, baseline_event_sequence NULL,
baseline_checkpoint_revision NULL, created_after_event_sequence NULL,
created_after_checkpoint_revision NULL, created_after_mono NULL
status: frozen | stale | superseded

`sourceContentHash` 覆盖 source 的完整业务 payload；`receiptPayloadHash` 覆盖 receipt 的完整业务 payload。正常 mutation 必须 revision+hash 同事务变化；内容变而 revision 不变也必须被 Judge 判为 stale。

#### `daily_plan_scopes` 与 Projection

`daily_plan_scopes` 是 PlanScope 的唯一范围边界，不新增一个猜测性的 `recommendations` 表：

```text
workspace_id, stage_request_id, root_request_id, root_generation, root_input_hash
manager_task_id, orchestration_id, attempt_stage
claim_revision, owner_epoch, lease_token, lease_expires_at_utc, lease_expires_mono
source_snapshot_hash, binding_kind: initial_source | repaired
repair_snapshot_hash NULL, binding_hash NULL
allowed_plan_ids_json, allowed_plan_item_ids_json, carry_plan_item_ids_json
trusted_receipt_ids_json
scope_status: building | frozen | failed | cancelled | superseded
scope_json, scope_hash, acceptance_run_id NULL,
baseline_event_sequence NULL, baseline_checkpoint_revision NULL,
created_after_event_sequence NULL, created_after_checkpoint_revision NULL,
created_after_mono NULL, created_at, updated_at, frozen_at, finished_at
```

唯一键：`(workspace_id, stage_request_id)`。`scope_status=building` 只能由 `commitPlanScopeCandidates` 原子地转为 `frozen/failed/cancelled`；只有 frozen scope 能被 Projection 读取。Projection 作为 frozen `scope_json/result_json` 中的 versioned object 保存，并同时写 Manager checkpoint/readback：

```ts
TodayRecommendationProjection = {
  workspaceId, businessDate, managerTaskId, orchestrationId, stageRequestId,
  scopeHash, bindingHash: string|null, repairSnapshotHash: string|null,
  planIds, asOf,
  entries: [{ planItemId, planId, planDate, origin: 'today'|'carry',
              sourceReceiptIds, sourceReceiptRevisions,
              repairReceiptIds, repairReceiptRevisions,
              itemRevision, itemContentHash, classification }],
  candidatePlanItemIds, eligiblePlanItemIds, pendingPlanItemIds,
  invalidPlanItemIds, trustedReceiptIds, emptyQualified,
  acceptanceRunId, baselineEventSequence, baselineCheckpointRevision,
  createdAfterEventSequence, createdAfterCheckpointRevision, createdAfterMono,
  projectionHash
}
```

`eligible/pending/invalid` 必须互斥且覆盖每一个 admitted candidate。`opportunityCount = eligiblePlanItemIds.length`，UI、Manager、数据库只使用这一个 projection。

#### `managed_job_dispatches`

```text
workspace_id, job_id, child_identity_key, child_ordinal, role_id
operation_request_id, effect_request_id NULL, effect_logical_key NULL
manager_task_id, orchestration_id, parent_task_id, parent_stage_request_id
root_request_id, root_generation, root_input_hash, preflight_id, policy_hash
stage_request_id, retry_generation
expected_parent_claim_revision, expected_parent_owner_epoch, expected_parent_lease_token
launch_attempt_id, launch_token_hash, process_handle, pid,
process_start_time_utc, process_start_time_mono,
argv_hash, cwd_fingerprint, session_key,
spawn_deadline_utc, spawn_deadline_mono, register_at,
stdout_drain_watermark, stderr_drain_watermark
state: reserved | task_bound | spawn_uncertain | spawn_started | running | terminal | cancelled | orphaned
result_status, result_hash, envelope_json, result_json
owner_epoch, lease_token, lease_expires_at_utc, lease_expires_mono
acceptance_scenario_id NULL, acceptance_run_id NULL, barrier_id NULL, runner_epoch NULL
baseline_event_sequence NULL, baseline_checkpoint_revision NULL,
created_after_event_sequence NULL, created_after_checkpoint_revision NULL,
created_after_mono NULL
created_at, updated_at, finished_at
```

唯一键：`(workspace_id, child_identity_key)`；`job_id` 不足以绕过 child identity。顺序固定为 `reserve → task_bound → launchAttempt → OS spawn → inventory/register → running`；spawn crash 进入 `spawn_uncertain`，按 §6.7 adopt-or-kill，不可直接重放或凭 DB 行 orphan。

#### `managed_effect_consumptions`

Stage D 的“执行事实”和“当前 orchestration 的消费事实”分离：

```text
consumption_id PK
workspace_id, operation_request_id, effect_request_id, effect_logical_key,
effect_set_hash, effect_token, payload_hash
manager_task_id, orchestration_id, root_request_id, root_generation, stage_request_id
source_dispatch_job_id, source_result_hash, role_id, sink_name,
sink_role_id, sink_contract_version, delivery_mode,
sink_capability_proof_hash, compensation_request_key, compensation_result_hash
outcome_query_key, outcome_hash
state: reserved | consuming | unknown | consumed | failed | cancelled | orphaned
consumption_revision, expected_stage_claim_revision
owner_epoch, lease_token, lease_expires_at_utc, lease_expires_mono, unknown_since
error_json, acceptance_scenario_id NULL, acceptance_run_id NULL, barrier_id NULL, runner_epoch NULL
baseline_event_sequence NULL, baseline_checkpoint_revision NULL,
created_after_event_sequence NULL, created_after_checkpoint_revision NULL,
created_after_mono NULL
created_at, updated_at, finished_at
```

唯一键：`(workspace_id, operation_request_id, effect_request_id)`。只有 source dispatch 的完整 `succeeded + result_hash` 可被跨 orchestration 消费；复用方新增自己的 consumption，绝不修改源 dispatch。

#### 其他耐久对象

- `command_receipts`：保存 `request_id`、command、logical hash、execution envelope、原始响应、terminal status 和冲突摘要；重放返回同一结果。
- `orchestrator_events`：append-only，保存 `workspaceId/businessDate/source/root/stage/attempt/parent/job/causation/request/epoch/lease` 全字段、`acceptanceRunId` 和 baseline/created-after 字段；不得按日期补关联。
- `daily_repair_snapshot_bindings`：独立保存 `repairSnapshotId`、predecessor scope/source snapshot、修复前后 item revision/content hash、receipt revision/payload hash、child hashes、`repairSnapshotHash`、`bindingHash`、registry FKs、acceptance/baseline 字段和 binding revision；修复不能回写旧 source/scope。
- `ResearchResumeManifest`：与 research claim/checkpoint 同事务保存 parent stage、gap、snapshot、session、cwd fingerprint、剩余 deadline（UTC/monotonic pair）和 manifest hash；不能只写 `resume_pending`。
- `daily_reconcile_gates`：每个 `(workspace_id,runtime_epoch)` 一行，字段为 `runtime_epoch, owner_epoch, lease_token, lease_expires_at_utc, lease_expires_mono, gate_deadline_utc, gate_deadline_mono, checkpoint_revision, status, reason, finished_at_utc, finished_at_mono`；`status ∈ {pending,running,complete,maintenance,failed}`。旧 epoch 行 append-only terminal；新启动由当前 Actor 为新 runtime epoch 插入新的 pending 行，不回退或覆盖旧 complete/failed 行。
`command_receipts`、`orchestrator_events`、`orchestrator_outbox`、`orchestrator_inbox` 以及上述业务对象在 acceptance namespace 中都带 `acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision, created_after_event_sequence, created_after_checkpoint_revision, created_after_mono`；生产行这些字段可为 `NULL`，但不得只填其中一部分。
文中的 camelCase API/JSON 字段与逻辑 schema 的 snake_case 列一一对应（例如 `acceptanceRunId=acceptance_run_id`、`freshAfterMono=fresh_after_mono`、`createdAfterMono=created_after_mono`）；这是同一字段的序列化别名，不得实现为两套可漂移字段。

### 5.3 Schema、PK/unique/FK/check 与 retention 合同（规范修正）

以下是逻辑 schema 的完整约束；实现可用等价列或 JSON，但不得省略约束。所有 FK 均 `ON DELETE RESTRICT`，禁止数据库 cascade、手工 delete、直接改终态或以日期补 FK。`created_at`、`updated_at`、`finished_at`、`checkedAtUtc`、`occurredAtUtc` 等 canonical instant 由 DB/server 产生并以 UTC ISO-8601 毫秒序列化；每个 lease/deadline/watermark 同时持久化对应的 UTC instant 与 DB monotonic tick，超时/接管比较只使用 monotonic tick，hash/readback 同时校验两者的配对关系。所有 hash、ID、revision、epoch 字段 `NOT NULL`，只有下表和字段明确标注 `NULL` 的业务/验收/血缘字段可为空。
| 表 | PK | UNIQUE/partial unique | 必须 FK | 必须 CHECK |
|---|---|---|---|---|
| `identity_hash_registry` | `(workspace_id,registry_name,registry_version,preimage_hash)` | `(workspace_id,registry_name,registry_version,derived_value)` | `workspace_id → actors` | registry name/version/preimage schema, canonical bytes hash and derived value are non-empty and immutable; one preimage cannot derive two values |
| `workspace_orchestrator_actors` | `workspace_id` | 每 workspace 恰一行 | — | `runtime_epoch>=1`、`owner_epoch>=1`、`mailbox_sequence>=0`、`checkpoint_revision>=0`；UTC/monotonic lease pair 一致；lease 只在 active/stopping |
| `orchestrator_mailbox` | `(workspace_id, mailbox_sequence)` | `(workspace_id, commandReplayKey)`；未终态 envelope 的 `coalescingKey` partial unique 只对声明可合并的 scheduler work 生效 | `workspace_id → actors`、`intent_id → intents` | sequence 严格递增；`claimed` 必有 claim epoch/token；terminal 必有 finishedAt；acceptance baseline 字段成套出现 |
| `command_receipts` | `(workspace_id, request_id)` | `(workspace_id, commandReplayKey)` | `workspace_id → actors`、`intent_id → intents`（若已接受） | response/hash/terminalStatus 同一 first-writer；conflict 不得创建 intent；acceptanceRunId 与 baseline/created-after 成套 |
| `orchestrator_intents` | `intent_id` | `(workspace_id, request_id)`、`(workspace_id, invocationId)` | actor、preflight、root 均按存在关系 | terminal CAS 仅允许 `status IN (received,preflight_pending,preflight_running,waiting_resource,admitted,running,waiting_owner)`；`finishedAt` 当且仅当 `status IN (succeeded,partial,failed,needs_user,cancelled)`；`needs_user` 必有 nextAction；root 前 status 不得为 running |
| `channel_preflight_snapshots` | `preflight_id` | `(workspace_id, intent_id, preflightVersion)` | actor、intent | selected/ready/excluded/failure/unresolved 是完整互斥分区；frozen/failed/needs_user 行 insert-only；UTC/monotonic deadline pair 一致 |
| `daily_orchestration_roots` | `root_id` | `(workspace_id, root_request_id)`、`(workspace_id, orchestration_id)`、`(workspace_id,business_date,root_mode,source,root_generation)` | actor、intent、preflight、predecessorRoot（可空） | terminal CAS 仅允许 `status IN (created,running,waiting_owner)`；`finishedAt` 当且仅当 `status IN (succeeded,partial,failed,needs_user,cancelled)`；generation/ordinal 非负；terminal 后不可变；active root 只能由当前 actor epoch 持有 |
| `daily_stage_claims` | `claim_id` | `(workspace_id, stage_request_id)`；`(workspace_id,claim_scope_key) WHERE is_active=1` | root、parent claim/stage、actor | terminal CAS 仅允许 `status IN (claimed_unbound,claimed,dispatching_scan,snapshot_frozen,awaiting_judge,dispatching_judge,manifest_frozen,dispatching,settling,running)`；`is_active=1` 当且仅当 `status NOT IN (succeeded,skipped,partial,failed,needs_user,cancelled,orphaned)`；attempt 在 1..maxStageAttempts |
| `source_snapshots` | `snapshot_id` | `(workspace_id, stage_request_id)`、`(workspace_id,snapshot_hash)` | root、stage、preflight、receipt/source provenance | `successful`、`failed`、`unresolved` 三者两两互斥且并集恰等于 `selected`；三类及其 reason 都进入 `sourceSnapshotHash`；frozen/stale/superseded insert-only；`source_ids` 长度≤80；source/receipt binding 的 acceptance baseline 字段成套出现 |
| `daily_repair_snapshot_bindings` | `repair_snapshot_id` | `(workspace_id, binding_hash)` | predecessor scope/source snapshot/stage、identity registry | child hashes 先于 parent hashes；prior/repaired revision/hash 成对；只追加不覆盖；acceptance baseline 成套 |
| `daily_plan_scopes` | `scope_id` | `(workspace_id, stage_request_id)`、`(workspace_id,scope_hash)` | root、stage、source snapshot；`daily_repair_snapshot_bindings` 仅 `binding_kind=repaired` 时必需 | `binding_kind=initial_source` 时 `repair_snapshot_hash IS NULL AND binding_hash IS NULL AND repair FK IS NULL`；`binding_kind=repaired` 时三者均 NOT NULL 且 FK/registry 匹配；terminal CAS 仅允许 `scope_status=building`；分类互斥且覆盖 candidates |
| `managed_job_dispatches` | `job_id` | `(workspace_id,child_identity_key)`、`(workspace_id,launch_attempt_id)` | actor、root、stage、parent task/claim | terminal CAS 仅允许 `state IN (reserved,task_bound,spawn_uncertain,spawn_started,running)`；`spawn_started` 必有 launchAttempt/handle；terminal/cancelled/orphaned 只 first-writer；expected parent fence 必全 |
| `managed_effect_consumptions` | `consumption_id` | `(workspace_id,operation_request_id,effect_request_id)`、`(workspace_id,effect_token)` | source dispatch、stage、root、actor、identity registry | terminal CAS 仅允许 `state IN (reserved,consuming,unknown)`；consumed 必有 outcome hash；unknown 必有 query key；deliveryMode/sink identity/proof 成套；failed/cancelled/orphaned 不得转 consumed |
| `orchestrator_events` | `(workspace_id,event_sequence)` | `event_id`、`(workspace_id,causationId,eventType,eventOrdinal)` | actor；root/stage/job/intent 按存在关系 | append-only；sequence 单调；敏感字段不得出现；acceptanceRunId/baseline/created-after 成套 |
| `orchestrator_outbox` | `outbox_id` | `(workspace_id,aggregateId,aggregateRevision,eventType,eventOrdinal)` | event/actor | `eventOrdinal>=1`；payload hash 与 bytes 相等；同 aggregate revision 的不同 eventType 必须不同 ordinal；delivered 后不可改 |
| `orchestrator_inbox` | `(consumer_id,message_id)` | `(consumer_id,aggregateId,aggregateRevision,eventType,eventOrdinal)` | outbox/event | duplicate 只能返回原处理结果；cursor 不回退；同 revision 多 event 不得按 revision 单字段互相吞并 |
| `daily_reconcile_gates` | `(workspace_id,runtime_epoch)` | `(workspace_id,runtime_epoch)`；当前 Actor epoch 最多一行 | `workspace_id → actors` | status 仅 `pending|running|complete|maintenance|failed`；同一 epoch 只允许 `pending→running→complete|maintenance|failed`，terminal 不回退；新 runtime epoch 插入新 pending 行；reason/finishedAt 与 terminal status 一致；token/revision 必须逐字段等于该 epoch 的 Actor fence，不得独立 takeover |
| `workspace_active_root_index` | `(workspace_id,root_request_id)` | `(workspace_id,root_request_id)`; read index `(workspace_id,is_active,priority,mailbox_sequence,root_generation)` | actor、root；stage/scope/projection 条件 FK（若存在） | `projection_state=absent` 当且仅当 `scopeHash,projectionHash,eligibleIdsHash` 均 NULL，且可达于 created/running/partial/failed/needs_user/cancelled 的无 projection root；`projection_state=not_applicable` 仅允许 Stage D scheduler root 以 `succeeded/NO_CURRENT_TARGETS` 终态且三种 hash/FK 均 NULL；`projection_state=frozen` 时三者均非 NULL，`eligibleIdsHash` 必须按 registry `eligible-ids/v1` 可重算，且 FK/hash/checkpoint 与当前 root/projection 相等；waiting_owner、clean-empty 及其他 succeeded 必须 frozen；projection-only、index revision 由当前 Actor fence CAS，不得写 lifecycle state |
| `workspace_migration_state` | `(workspace_id,migration_epoch)` | `(workspace_id,migration_epoch)` | actor | migration epoch 单调；`writeFence` 与 status 相容；complete/failed/maintenance terminal 不可回退或承载后续 rollback mutation |
| `workspace_rollback_state` | `(workspace_id,rollback_epoch)` | 当前 rollback partial unique `(workspace_id) WHERE status IN (requested,fencing,draining,verifying)` | actor；source migration state、target build manifest | status 仅 `requested|fencing|draining|verifying|complete|maintenance|rollback_required`；同一 rollback epoch 单向 first-writer；target/barrier/UTC+mono 字段创建时冻结；不得修改已 terminal migration row |
| `workspace_migration_journal` | `(workspace_id,migration_epoch,step_seq)` | `(workspace_id,migration_epoch,step_key)` | migration_state、actor | append-only；step terminal 后 hash/count 不可改 |
| `producer_registry` | `(workspace_id,producer_id,build_id)` | `(workspace_id,producer_id,census_hash)`、`(workspace_id,producer_id,build_id,registry_entry_hash)` | migration_state | entry/census/process/resource/trigger/authorizer attestation 必须完整；`enabled` 仅 allowlist；未知 writer 不得存在 active |
| `build_manifests` | `build_id` | `(package_hash,app_asar_hash,schema_epoch)` | — | manifest hash、source commit、resource path 必须匹配 |
| `acceptance_runs` | `acceptance_run_id` | `(workspace_id,acceptance_run_id)` | build_manifests、actor | `acceptance_namespace,baseline_event_sequence,baseline_checkpoint_revision,baseline_table_hashes,baseline_counts,baseline_data_root_hash,fresh_after_mono` 必须完整；生产 reconcile 不得终结 acceptance-only |
所有表的状态 CHECK 只允许本文列出的枚举；未知状态/reason、负 revision、跨 workspace FK、`finishedAt`/terminal 不一致、active parent 已 terminal、hash 长度或编码不符均在事务内拒绝。任何业务写必须先锁定当前 Actor 行，再按 §6.5 的当前 parent/fence CAS；复制在 child 行的 epoch/token 不是授权。
`identity_hash_registry` 的逻辑列为 `workspace_id, registry_name, registry_version, preimage_schema_version, preimage_hash, canonical_bytes_hash, preimage_bytes, derived_value, created_at`；`preimage_bytes` 与 `canonical_bytes_hash` 必须逐字节可回读，`derived_value` 只能由 registry 计算，任何调用方自报或覆盖均拒绝。

Retention 固定为：event、command receipt、identity registry、outbox/inbox cursor、terminal root/stage/scope/projection、effect settlement 和其 chain anchor 永久保留；source/repair/dispatch/consumption 热数据保留 365 日后可转不可变 archive，但 archive manifest 必须包含完整 FK/provenance/hash/count 链并永久保留；orphan/deny/tombstone 永久保留。归档只能通过版本化 migration/store API、逐行校验 chain anchor 后执行，rehydrate 只读；有任何 active 引用、acceptance_run 或未完成 reconciliation 时不得归档。GC 不得破坏 root→stage→snapshot→receipt→projection→effect 的证明链。

### 5.4 Durable outbox/inbox 与 external effect sink（规范修正）

所有跨进程通知和外部动作均先写 durable outbox；in-memory broadcast 只能是加速提示，丢失、重复或乱序都必须可由 cursor/resync 修复。`orchestrator_outbox` 至少包含 `outboxId, workspaceId, aggregateId, aggregateRevision, eventType, eventOrdinal, causationId, payloadHash, payloadBytes, status, attempt, lease, createdAt, deliveredAt`；同一 aggregate revision 可有多个 eventType，但每个必须有唯一的 `eventOrdinal`。consumer inbox 保存 `consumerId,messageId,aggregateId,aggregateRevision,eventType,eventOrdinal`、处理结果 hash 和 cursor，并以 `(consumerId,aggregateId,aggregateRevision,eventType,eventOrdinal)` 去重。

每个 Stage D effect 必须有稳定 `effectRequestId`、`effectToken=H_v1({r:"sink-token/v2",workspaceId,effectRequestId,roleId,sinkName,sinkContractVersion,deliveryMode,payloadHash})`、`roleId`、`sinkName`、`sinkContractVersion`、`deliveryMode ∈ {exactly_once,at_most_once,at_least_once}`、payloadHash、outcomeQueryKey 和 `sinkCapabilityProofHash`。`reserve consumption + outbox(effect)` 与当前 stage fence 同一事务提交；sink 调用必须携带完整 effectToken；sink 回执必须返回 token、payloadHash、resultHash。进程在 sink 已提交而 `consumed` 未提交时，reconcile 必须先用 outcomeQueryKey 查询；查询为 committed 才补写同一 consumption，unknown 不得盲目重放。相同 token+不同 payloadHash、sink identity、contract version 或 delivery mode 必须稳定拒绝；同 token+同 hash 只能产生一个由该 mode 允许的可观察 effect。

三种 delivery mode 的证明合同固定如下：`exactly_once` 必须同时有 sink 的 token 幂等证明、outcome query 证明和单一 committed result readback，A31 才能判定外部 effect 恰一次；`at_most_once` 禁止 unknown 后自动重试，必须以 query 证明已提交或以声明的 compensation proof/unknown terminal readback 结束，不能把未知包装为成功；`at_least_once` 可按同一 token 重试，但必须提供 sink dedupe、outcome query 或声明 compensation 的 proof hash，并在 A31 中证明重复被查询/去重/补偿、最终状态不伪称 exactly-once。无 query、幂等或可验证 compensation 的 sink 只能保持 `unknown/partial`，不得宣称任何成功保证。

`reserve consumption + outbox(effect)` 与当前 stage fence 同一事务提交；`failed/partial/cancelled/orphaned` consumption 的 token 不得被新 effect 复用；cancel 只阻止尚未提交的 effect，已 unknown 的 effect 必须按上述 mode 完成查询/补偿后才可终结。

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
   ├─ authorized system cancel ───────────────────────────► cancelled
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
waiting_owner ──authorized system cancel────────────────► cancelled
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
### 6.5 Sole authority、epoch/lease/deadline 与 current-row CAS（规范修正）

`workspace_orchestrator_actors` 是 workspace 唯一 control authority。`daily_reconcile_gates` 只是该行的 gate projection，不能独立获取、续租、接管或完成；gate 的 `runtimeEpoch/ownerEpoch/leaseToken/checkpointRevision` 必须逐字段等于 Actor 当前行。Manager、Reconciler、scheduler、worker 和 acceptance runner 都没有第二套 authority。

每一次业务执行 envelope 必须携带 `workspaceId, actorEpoch, ownerEpoch, leaseToken, authorityRevision, rootRequestId, rootGeneration, stageRequestId, claimRevision, parentFence, issuedAtUtc, expiresAtUtc, expiresAtMono, rootDeadlineUtc, rootDeadlineMono, stageDeadlineUtc, stageDeadlineMono, gateDeadlineUtc, gateDeadlineMono, producerId, registryEntryHash, censusHash, triggerId, processId, processStartTimeUtc, processStartTimeMono, processImagePath, resourcesPath, producerAttestationHash`。`*Utc` 是同一 DB 持久化 instant 的 UTC 序列化，`*Mono` 是 DB/server monotonic tick；超时、接管和 lease 比较只使用 `*Mono`。`expiresAtMono` 不得晚于 `min(rootDeadlineMono, stageDeadlineMono, gateDeadlineMono)`，对应 UTC 字段只能由 DB 同事务生成。lease 续租有固定最大 TTL 30 秒，且只有在同一事务提交了业务进展或明确的 fenced settle 后才能续租。heartbeat、广播、普通 checkpoint 和 stdout 活动不能刷新 `lastBusinessProgressAt` 或延长任何 deadline。

获取/接管协议固定为：

1. Actor 以 `SELECT ... FOR UPDATE` 读取自己唯一的当前行。lease 仍有效且 `controlStallDeadlineMono` 未到时，第二 runtime 只能记录 `AUTHORITY_BUSY` 并等待；不得插入第二行或执行业务写。
2. lease 到期，或 watchdog 观察到 `nowMono >= controlStallDeadlineMono`（即便 heartbeat 仍在刷）时，watchdog 与启动 runtime 竞争同一 Actor 行；胜者在一个事务中把 `runtimeEpoch`、`ownerEpoch`、`authorityRevision` 各加一，旋转不可复用的 `leaseToken`，将旧 envelope 标记 revoked，并同步更新 gate projection。失败者只能读回胜者。
3. `controlStallDeadlineMono = min(leaseExpiresMono, rootDeadlineMono, stageDeadlineMono, gateDeadlineMono)`；对应 UTC instant 只作 readback，不参与裁决，旧 owner 不得将 mono deadline 向后写。若所有可接管记录都无法在其 deadline 前恢复，胜者必须在同一 epoch 将其 fenced terminal/orphaned 并把 gate 置 `maintenance`，不得无限等待。
4. 任何业务 mutation 都必须在同一个 DB transaction 首先读取当前 Actor 行，再读取当前 root/claim/target 行，并以当前值组成 `WHERE workspace_id=? AND revision=? AND owner_epoch=? AND lease_token=? AND status IN (...)` 的 CAS；affected rows 必须恰为 1。仅比较 child 上复制的 epoch/token、内存锁、日期或 PID 均不构成授权。

每次 CAS 失败返回稳定 `EXECUTION_AUTHORIZATION_INVALID`、`WORKSPACE_STALE` 或 `STATE_CONFLICT`（按矩阵归一），只写 audit；不得部分写 scope、projection、receipt、result、event 或 outbox。终态 first-writer 使用下列逐表谓词，且每条 UPDATE 还必须带当前 Actor/root/claim revision、owner epoch 和 lease token：

```text
orchestrator_intents:       status IN (received,preflight_pending,preflight_running,waiting_resource,admitted,running,waiting_owner)
daily_orchestration_roots:  status IN (created,running,waiting_owner)
daily_stage_claims:         status IN (claimed_unbound,claimed,dispatching_scan,snapshot_frozen,awaiting_judge,dispatching_judge,manifest_frozen,dispatching,settling,running)
source_snapshots:           insert-only; frozen/stale/superseded rows never update
daily_plan_scopes:          scope_status = building
managed_job_dispatches:     state IN (reserved,task_bound,spawn_uncertain,spawn_started,running)
managed_effect_consumptions: state IN (reserved,consuming,unknown)
command_receipts:            terminalStatus IS NULL (or insert-only if status is set at accept)
orchestrator_outbox:         delivered_at IS NULL
orchestrator_events:         append-only; expected eventSequence is absent and `(causationId,eventType,eventOrdinal)` is unique
orchestrator_inbox:          full `(consumerId,aggregateId,aggregateRevision,eventType,eventOrdinal)` message identity is absent
workspace_active_root_index: indexRevision = expected AND actorEpoch/ checkpointRevision match current Actor/root
daily_reconcile_gates:       current epoch row status IN (pending,running); new runtime epoch inserts a new pending row and never updates an old terminal gate row
workspace_migration_state:   status NOT IN (complete,failed,maintenance)
workspace_rollback_state:    status IN (requested,fencing,draining,verifying)
`daily_stage_claims` 的终态集合是 `succeeded/skipped/partial/failed/needs_user/cancelled/orphaned`；dispatch 的终态集合是 `terminal/cancelled/orphaned`；consumption 的终态集合是 `consumed/failed/cancelled/orphaned`。首个提交者一次性写入对应 `resultHash/settlementHash/finishedAtUtc/finishedAtMono/terminalReason/terminalEnvelope`；随后任何 result/settlement/checkpoint 不可更新，只能返回 canonical terminal readback 并追加 audit event。gate 仅按 §12.2 的状态转换 CAS；outbox 已 delivery 的 payload 不可更新，inbox 以完整 message identity first-write。cancel cascade 同样以当前 Actor/root/claim fence 执行、可重放，直到所有 active child/lease 都已 terminal 或 orphaned。

### 6.6 Transaction bundle、outbox/inbox 与 F→J/cancel 线性化（规范修正）

所有 bundle 使用 `SERIALIZABLE` 或等价的显式行锁；统一锁序为 `Actor → migration/cutover fence → root → parent claim → child dispatch/consumption → snapshot/scope/projection → Manager checkpoint → active-root index → event/outbox`。同一 bundle 只允许全提交或全回滚；所有本次生成的 identity/hash 都必须把其 registry row（含完整 preimage bytes/schema version/canonical bytes hash）写入同一 bundle。`orchestrator_intents.checkpoint_revision/status`、适用时的 `workspace_active_root_index` row、Manager checkpoint 和 terminal/readback 必须与业务行同事务提交；T1/T2 尚无 root 时显式写 `index=N/A (pre-root)`，不得伪造 root/index。崩溃后的恢复依据唯一键、registry first-writer 和 index checkpoint/hash readback，不依据内存广播。bundle 矩阵如下：

| Bundle | 同事务写入 | 入口 CAS/隔离 | 崩溃或重放结果 |
|---|---|---|---|
| T1 intent accept | mailbox envelope、`command_receipt`、intent（`status=received,checkpoint_revision+1`）、`commandReplayKey/invocationId/logicalInputHash/mailboxEnvelopeHash/producerAttestationHash` registry rows、received event、accept outbox；无 root，index 明确 N/A | Actor epoch + `(workspace,requestId)` replay key + producer attestation | 全部存在则返回原 accepted/pending；全部不存在才可用同一 identity 重试；payload/attestation 不同返回 conflict；不产生 root/index |
| T2 preflight close | channel results、normalized policy/hash、preflight snapshot 及 `preflightId/preflightHash` registry rows、intent checkpoint/status（admitted 或 needs_user/failed/partial）、events/outbox；无 root，index 明确 N/A | intent revision + current Actor fence + policy/capability fence | 未完整提交不得产生 root；重启 resume once 或 terminalize；registry、intent、event 不得半套 |
| T3 root/claim admission | intent→root binding、root、first claim、resource reservation、`rootRequestId/orchestrationId/stageRequestId/operationRequestId/childIdentityKey` registry rows、intent `status=admitted/running` checkpoint、root event/outbox、`workspace_active_root_index(projection_state=absent,scopeHash/projectionHash/eligibleIdsHash=NULL)` | intent/root CAS + normalized policy fence + current Actor | 全部存在返回 canonical root/index；任一缺失由 Actor 按同一 identity 补齐；不能新 root，不能把 absent index 当作 projection |
| T4 source freeze | receipt/source bindings、SourceSnapshot、`sourceSnapshotHash` registry row、F claim settlement、intent checkpoint、active-root index 当前 stage/checkpoint（projection 仍 absent）、snapshot event/outbox | F claim revision + capability fence + current Actor | source、receipt、registry、snapshot、intent/index 要么成套 frozen，要么保持 predecessor active；不得半套 Judge |
| T5 F→J handoff | root checkpoint、F `HANDOFF_CONSUMED/is_active=0`、J `stageRequestId/operationRequestId` registry rows、唯一 J claim、intent checkpoint、active-root index current stage/checkpoint、handoff event/outbox | 同时锁 root+F claim+index；root status 必须非 cancelled/superseded | H 先线性化则只产生一个 J；cancel 先线性化则零 J；冲突为 zero-write stable conflict；index 不得指向不存在 J |
| T6 scope/Stage-D settle | PlanScope/Projection（适用时）、Stage-D TargetSet/EffectSet（适用时）、`scopeHash/projectionHash/eligibleIdsHash/targetSetHash/effectSetHash/settlementHash` 的全部适用 registry rows、root/stage terminal 或 waiting_owner、intent terminal/checkpoint、Manager checkpoint、active-root index（Projection frozen 时写 scope/projection/eligible；Stage D `NO_CURRENT_TARGETS` 时写 `projection_state=not_applicable` 与 NULL hashes；其他缺 Projection 时保持 absent）、settlement/event/outbox | current J/Stage/Actor fence + frozen scope/target/effect hash + index revision CAS | Projection/TargetSet/EffectSet、registry、terminal/readback、intent、checkpoint、index 同时可见或同时不可见；broadcast 丢失可由 outbox/cursor/resync 及 index rebuild 修复 |
| T7 effect consume | consumption reserve/state、`effectRequestId/effectToken` registry rows、effect outbox/token、sink result settlement、intent checkpoint、active-root index checkpoint、event/outbox | stage fence + effect token/payload/sink identity hash + current Actor | sink unknown 只进入 mode-specific query/compensation 流程；同 token replay 返回原结果；registry/consumption/outbox 不出现半套或重复外部 effect |
| T8 cancel/drain | root/intent cancel CAS、child/consumption terminalization、lease release、terminal/settlement registry rows、intent terminal checkpoint、active-root index terminal/isActive update、checkpoint/event/outbox | current Actor/root/index lock before handoff or spawn | cancel 与 handoff/spawn 只有一个先行者；晚到 worker 只 audit；重放返回 canonical cancelled readback，不复活 root/index/child |

如果 root/projection bundle 已提交而 index 缺失、落后或 hash/checkpoint 不匹配，startup reconcile 必须在同一当前 Actor fence 下追加可重放的 `active_root_index.rebuild_requested` event/outbox，按 `rootRequestId` 从 root→stage→scope/projection 重建同一 index row，并以 `index_revision + checkpoint_revision + actor epoch` CAS 写回；重建结果再次写 `active_root_index.rebuilt` readback。重建完成前 approval/supersede 不得执行，但 unrelated mailbox 可继续服务；任意 crash 都从同一 event/row identity resume，不创建新 root、不把 index 当 authority。`A32/A38/A53` 必须覆盖 root/projection/cancel/terminal 四个边界的 index 缺失、落后和重建恢复。

`accepted` 只表示 T1 已提交 durable receipt；`pending` 表示 receipt 已提交但后续 bundle 尚未终态；`terminal` 必须同时读到终态行、finishedAtUtc/finishedAtMono、terminal event、checkpoint 和关联 projection/settlement（适用时）。所有 command response 都可用 requestId 从 receipt 重建，不依赖 websocket/broadcast；inbox 以完整 `(consumerId,aggregateId,aggregateRevision,eventType,eventOrdinal)` 幂等，重复/乱序 event 触发 §11.5 resync。

F→J 与 cancel 的线性化不是两个先后 API：handoff 事务必须按 T5 同时 CAS root 当前状态、F claim revision/owner fence，并插入唯一 J claim；cancel 必须取得相同锁序，先把 root/F/相关 active claims 置 cancelled，再反复扫描并 orphan child。若 cancel 先提交，handoff affected rows=0 且不得插入任何 J；若 handoff 先提交，cancel 必须观察该 J 并在同一 cascade 中终结它。任一顺序都不得出现 post-cancel child、F 已 consumed 但 root cancelled 前后矛盾或两个 terminal winner。

### 6.7 Durable spawn/adopt-or-kill 协议（规范修正）

`managed_job_dispatches` 在 `reserved` 前必须持久化不可复用的 `launchAttemptId`、随机 launch secret 的 hash、完整 execution envelope、`argvHash`、`cwdFingerprint`、`sessionKey` 和 `spawnDeadlineUtc/spawnDeadlineMono`；launch secret 原文只通过受保护启动参数/环境传入 child，不写普通 event。一个 child identity 只能有一个 launchAttemptId；任何重试必须先结清前 attempt。

线性顺序固定为：`reserve → task_bound → persist launchAttempt → OS spawn → inventory/register → running`。OS spawn 返回前后的所有 crash window 都视为 `spawn_uncertain`，不是可安全重放的 `reserved`。重启/看门狗必须按 `(workspace, launchAttemptId, argvHash, cwdFingerprint, sessionKey)` 查询 OS process/session inventory：

- 恰有一个匹配进程且 start time/parent/session 可证明时，原子写 `spawn_started/running` 并 adopt；不得再次 spawn。
- 无匹配进程时，只有在确认 spawn 未发生或旧 attempt 已被幂等终止后，才能写 `orphaned` 并以新 launchAttempt 重试；不能仅凭 DB 行推断。
- 多个匹配、PID/argv/session 不一致或 inventory 不可确定时，全部标 `spawn_uncertain`，停止该 identity 的新 spawn，执行幂等 stop→stdout/stderr drain→session close→cwd cleanup；读回 confirmed termination 后才允许新 attempt。

child 首次业务写必须提交与当前 envelope 相符的 register/heartbeat；缺 register、旧 epoch、旧 token、旧 launch secret 或错误 workspace 的输出只能 audit。stop/drain/close/cleanup 都是可重放命令并保留 process handle、PID、start time、exit code、drain watermark 和清理结果。验收必须在 `reserved/task_bound/OS spawn return/spawn_started/register/stdout drain` 每个边界注入 crash，并证明 process inventory 与 dispatch 各 identity 一一对应。

## 7. Channel Required/Optional Preflight

### 7.1 预检步骤

Actor 接受 intent 后，先生成不可变的 channel policy：每个 `channelId` 必须有 `requiredness ∈ {required, optional}`，该分类来自 workspace profile + intent 显式选择，不能由运行时错误临时改变。对所有选定渠道并行做预检，再由 Actor 单事务汇总：

1. 模块/adapter 存在且版本兼容；
2. workspace/data-root 绑定一致；
3. 配置字段、权限 grant、凭据和登录状态可用；
4. 浏览器/CDP/网络能力可用（仅对需要它的渠道）；
5. channel health probe 返回稳定 capability；
6. 记录 config/auth revision、checkedAtUtc、reasonCode 和 coverage。

预检期间只允许产生 `orchestrator_intents`、`channel_preflight_snapshots` 和 audit event；**不得插入 `daily_orchestration_roots`、`daily_stage_claims`、`managed_job_dispatches`，不得 spawn Reporter/Manager worker**。

### 7.2 Required/Optional 规则

| 情形 | Root | Worker | Intent/读回 | Owner 动作 |
|---|---|---|---|---|
| 所有 required ready，optional 全 ready | 创建 | 可创建 | 正常运行 | 无 |
| required ready，optional preflight 失败/缺席 | 创建；排除失败 optional | 只用 ready 集合 | 运行 + 明显 coverage gap；不得称全渠道 | 无，Actor 不等待 Owner |
| 任一 required 配置/登录/授权失败 | 不创建 | 0 | `needs_user/CHANNEL_CONFIGURATION_REQUIRED` 或 `CHANNEL_LOGIN_REQUIRED` | 修复 required channel；修复后 Actor 自动重跑 preflight |
| 任一 required 不可恢复契约错误 | 不创建 | 0 | `failed/CHANNEL_PREFLIGHT_FAILED` | 不自动绕过；新 intent 必须重新检查 |
| 全部选定渠道均无 ready channel | 不创建 | 0 | `partial/CHANNELS_ALL_FAILED` 或 `needs_user`（若可修复） | 只对 required 修复；optional 不单独开审批门 |
| root 已创建后 optional runtime 失败 | 保留 root，移除该 channel | 不再向该 channel 派工 | 保存失败 receipt + coverage gap；若仍有可信材料继续 Judge，并在 eligible>0 且无 pending/invalid 时进入 waiting_owner | 无 |
| root 已创建后 required runtime 失败 | 当前 stage 终止 | 停止依赖该渠道的 worker | `partial` 或 `needs_user`，不可 clean-empty | required repair 后新 intent |

Optional 渠道被排除后，Actor 仍可以用剩余可信渠道自动走 Judge；若剩余 trusted material 产生 eligible candidate 且 pending/invalid=0，root 可以进入 `waiting_owner` 并显式显示 coverage gap。若 candidate=0 或没有剩余 trusted material，则只能 `partial`（分别为 `OPTIONAL_CHANNEL_COVERAGE_GAP` 或 `NO_CONTINUATION_MATERIAL`）；任何 optional gap 都禁止 `clean-empty`。

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
### 7.4 Normalized requiredness、capability/config/auth fence 与 preflight deadline（规范修正）

`workspace profile` 的已授权 policy 是 requiredness 的唯一来源。Actor 在接收 intent 的 T1 事务中读取 `profileRevision`，计算 `requiredSet R` 与显式请求的 optional 子集 `O`，并持久化 `normalizedPolicy = R ∪ O`、`policyHash`、`policyRevision`。intent 只能缩小 optional 集，不能把 R 降为 optional、遗漏 R、发明未知 channel、重复 channel 或自行指定 module；任何非单调输入均返回 `CHANNEL_POLICY_INVALID`，只保留 rejection receipt/audit，root、claim、worker、projection 和 Owner CTA 均为零。空 selected set 也必须得到显式 `NO_CHANNEL_SELECTED` 或 `CHANNELS_ALL_FAILED` 终态和可执行 nextAction，不能静默成功。

每个 channel preflight result 必须绑定 `preflightId, policyHash, profileRevision, configRevision, authRevision, capabilityRevision, capabilityLeaseId, checkedAtUtc, expiresAtUtc, expiresAtMono, probeRequestId, probeReceiptHash`。capability lease 的 TTL 固定不超过 30 秒；单 channel probe deadline 为 30 秒，aggregate preflight deadline 为 90 秒，`expiresAtUtc/expiresAtMono` 同时保存 DB 持久化 instant 与 monotonic tick，所有 deadline 比较只使用 DB/server monotonic tick 且不能被 heartbeat 延长。root admission、reserve、spawn、channel side effect、source receipt bind、F→J handoff、Judge start、PlanScope/Projection settle 和 waiting_owner/clean-empty 之前，Actor 必须重新读取当前 profile/config/auth revision 与 capability lease，并在同一事务以 `policyHash + revision + capabilityLeaseId + expiresAtMono > nowMono` 做 CAS。

required revision/auth/capability 发生 drift、lease 过期或 receipt 不完整时，当前 stage 必须 fail closed：无 Judge、无 waiting_owner、无 clean-empty；可修复的变为 `needs_user` 并给出 required repair action，不可修复的变为 `partial/CHANNEL_RUNTIME_AUTH_FAILED` 或 `failed`。optional drift 只可从本 root selected set 排除并写 coverage gap/失败 receipt；不能把失败当成成功的空结果。旧 snapshot/preflight 仍 immutable，修复只能生成新 preflight/new intent/new root。

probe hang、probe process crash 或 aggregate commit crash 的恢复固定为：Actor 将该 probe lease 标为 expired/unknown，写 `PRECHECK_DEADLINE` 或 `PRECHECK_INTERRUPTED`，重启时最多以同一 `preflightId/probeRequestId` resume 一次；第二次仍超时就 terminalize intent 为 `needs_user`（可修复）或 `failed`，写 finishedAtUtc/finishedAtMono/nextAction，并释放 probe 资源。startup reconcile 必须枚举所有 nonterminal intent 和 preflight；一个 hung probe 不得阻塞 unrelated mailbox command。preflight 未完成前只允许 intent、preflight、event/outbox 写入，绝不产生 root/claim/dispatch。

### 7.5 Live-channel failure matrix 与 per-source receipt provenance（规范修正）

selected channel 的 runtime 结果只能归入下表之一；每个结果都必须包含真实外部调用的 `purpose, role, channelId, requestId, causalChain, configRevision, authRevision, capabilityLeaseId, startedAtUtc, finishedAtUtc, payloadHash, resultHash, receiptId`。空数组只有在渠道明确返回并签名/校验通过的 `valid_zero` 时才是可信 zero；缺 body、截断、解析失败、伪造或超时不是 zero。

| runtime outcome | required channel | optional channel | 可产生的 trusted source/Judge/终态 |
|---|---|---|---|
| `ready + success` 且 receipt/result hash 完整 | 继续 | 继续 | 仅该 receipt 的 source 可进 snapshot/Judge |
| `optional_missing`/preflight excluded | 不适用 | 排除并写 gap | 若有其他 trusted source 可继续 Judge；产生 eligible 且 pending/invalid=0 可 `waiting_owner`；零候选只能 partial |
| `auth_expired`/`config_changed`/capability lease expired | `needs_user` 或 partial，停止依赖 worker | 排除并写 gap | required 不得 Judge/waiting_owner/clean-empty；optional 有剩余 trusted source 时可 Judge/waiting_owner，无候选只能 partial |
| `timeout`/probe hang/网络或 CDP 断开 | partial/failed，按可恢复性动作 | 排除并写 gap | 没有可信 receipt 的 channel 不得计入 clean-empty；optional 有剩余 trusted source 时可 Judge/waiting_owner，无候选只能 partial |
| `malformed`/schema/hash mismatch | failed closed | 排除并写 gap | 不得把失败 payload 当 source 或 zero；optional 仍按剩余 trusted source 分支 |
| `valid_zero`，receipt 与当前 fence 完整 | 可继续 | 可继续 | 只有 selected 全部有可信完整结果且无 gap 才可 clean-empty |
| write-then-fail 或 outcome unknown | `needs_user`/partial | 排除并标 unknown | 不得进入 trusted snapshot；先查询/补偿；optional 有剩余 trusted source 时可 Judge/waiting_owner，无候选只能 partial |

每一个 source binding 必须含 `workspaceId, rootRequestId, rootGeneration, stageRequestId, scanAttemptId, preflightId, policyHash, channelId, receiptId, receiptRevision, receiptPayloadHash, sourceId, sourceRevision, sourceContentHash, provenanceOrdinal, acceptanceRunId, baselineEventSequence, baselineCheckpointRevision, createdAfterEventSequence`。`successfulChannels` 与 `failedChannels` 按 channelId 互斥，二者都必须是 `selectedChannels` 的子集；`selectedChannels` 是请求渠道全集，可严格大于 `successfulChannels ∪ failedChannels`，其差集必须出现在 `unresolvedChannels`（未运行/unknown/被排除）并写出 reason。冻结 SourceSnapshot 时 required 的 unresolved 不允许存在，optional unresolved 必须计入 coverage gap；`failed` 或 `unknown` receipt 的 source 永远不进入 `trustedSourceIds`、PlanScope、Projection 或 opportunity count。跨 root、跨 attempt、旧 preflight、缺 channel mapping 或仅凭 sourceId 的绑定一律 `SOURCE_PROVENANCE_MISMATCH`，零业务写。

若 selected 集合只含 optional 且全部失败，intent 必须 terminal `partial/CHANNELS_ALL_FAILED`，Today 显示 coverage gap 与非空 `nextAction`：`configure_optional_channels`（携带 workspace/profile revision，生成新 preflight）或 `start_new_intent`（携带新 requestId，生成新 root）；两者均是显式、可授权、幂等命令，不能偷偷重试。若 selected 集合为空，同样显示 `select_channel` 或 `start_new_intent`；任何 `partial/needs_user/failed` card 都不得返回空 nextAction，也不得显示 clean-empty 或 waiting_owner。

## 8. Immutable Snapshot 与边界

### 8.1 SourceSnapshot

Reporter 完成后，Actor 在同一事务冻结：

```json
{
  "preflightId": "...",
  "policyHash": "...",
  "profileRevision": 1,
  "selectedChannelIds": ["sorted selected channel ids"],
  "successfulChannels": [{"channelId":"...","preflightId":"...","scanAttemptId":"...","receiptId":"...","receiptRevision":1,"receiptPayloadHash":"...","resultHash":"...","configRevision":1,"authRevision":1,"capabilityLeaseId":"..."}],
  "failedChannels": [{"channelId":"...","reasonCode":"...","requiredness":"optional","receiptId":null}],
  "unresolvedChannels": [{"channelId":"...","reasonCode":"optional_missing|unknown|not_run","requiredness":"optional","receiptId":null}],
  "sourceIds": ["at most 80, stable order"],
  "sourceBindings": [{"workspaceId":"...","rootRequestId":"...","rootGeneration":1,"stageRequestId":"...","scanAttemptId":"...","preflightId":"...","policyHash":"...","channelId":"...","receiptId":"...","receiptRevision":1,"receiptPayloadHash":"...","sourceId":"...","sourceRevision":3,"sourceContentHash":"...","provenanceOrdinal":1,"acceptanceRunId":"...","baselineEventSequence":1,"baselineCheckpointRevision":1,"createdAfterEventSequence":2}],
  "receiptIds": ["..."],
  "receiptRevisions": {"receipt-id": 1},
  "receiptPayloadHashes": {"receipt-id": "..."},
  "watermarkUtc": "...",
  "watermarkMono": 123,
  "capturedAtUtc": "...",
  "excludedByBudgetCount": 0,
  "snapshotHash": "sourceSnapshotHash from §5.1 registry"
}
```

Source 选择最多 80 个。超过上限时按 Reporter 已返回的业务优先级，再按 `sourceId ASC` 稳定截断；`excludedByBudgetCount` 写入快照和 UI。Judge 开始后新增 source/receipt、近 24 小时全量查询、前一日资料和库存数量都不得进入本轮。revision 或 content/payload hash 任一不匹配即 `SOURCE_SNAPSHOT_STALE`，不静默重扫。

### 8.2 RepairSnapshotBinding

修复 binding 是独立事实；repaired variant 包含 predecessor scope、source snapshot、修复 item 的 prior/repaired revision/content hash、receipt revision/payload hash、child hashes 和 `repairSnapshotHash`，并按 §5.1 顺序生成 `bindingHash`。创建、freeze、read 分三步 CAS；旧 source/receipt/scope 永远不变。Judge 只引用 frozen binding，不接受调用方自报 hash。首次 Judge 不创建修复 row，使用 `binding_kind=initial_source` 的 nullable variant。

### 8.3 PlanScope 与 Candidate Admission

首次 Judge：

```text
create PlanScope(building, binding_kind=initial_source,
                 source_snapshot_hash=frozen SourceSnapshotHash,
                 repair_snapshot_hash=NULL, binding_hash=NULL)
  → planner 原始 candidates
  → commitPlanScopeCandidates 单事务校验/写入 plan + plan_item + provenance
  → 每个 candidate 恰好分类 eligible|pending|invalid
  → scope building → frozen
  → readTodayRecommendationProjection(scope)
```

initial invariant 是 `binding_kind=initial_source ⇒ source_snapshot_hash IS NOT NULL AND repair_snapshot_hash IS NULL AND binding_hash IS NULL AND repair FK IS NULL`；repaired variant 必须三者均非 NULL、具有对应 `daily_repair_snapshot_bindings`/registry FK，且 `bindingHash` 与 repair child hashes 可重算。不能只填其中一个 nullable hash；Projection 的对应字段按相同 `null` 参与 canonical hash。

任一 candidate 重复、scope 外、未知分类、缺 receipt、revision/hash 不匹配或未解释，整笔 commit 回滚并返回 `CANDIDATE_ADMISSION_GAP`；不得静默丢候选。只有 `candidateInputCount=0 && classifiedCount=0`、scope frozen、选定渠道 receipt 完整可信、`unresolvedChannels=[]` 且无 forbidden coverage gap 才允许 clean-empty。

纯重算 retry 可 `copyFrozenPlanScope`，但必须按新 stage identity 重算新的 scope/projection hash；新增 candidate、修复 receipt 或 source 变化不能 copy 到旧 scope。

### 8.4 Stage D Target/Effect Snapshot

Stage D 只从当前 `daily_content_cycle` 的已绑定 target 读取：每个 target 冻结 `targetId/targetRevision/targetContentHash/planItemId/planItemRevision/planItemContentHash`，并在 claim 前冻结 `StageDEffectSpec[]` 的 role/action/effect logical key/attempt ordinal。`targetSetHash/effectSetHash` 及完整 canonical preimage 必须按 T6 与 Stage-D claim/settlement、index、event/outbox 同事务写入 `identity_hash_registry`；缺任一 registry row 不得 dispatch。禁止 dispatch、重启或 settlement 时查询全库 approved 或实时 research claim 来重新决定角色。`retry_subset` 只能覆盖显式 `retryTargetIds`，不能拿完整 targetSetHash 冒充子集。

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
- 本次 successor 必须绑定新的显式 gap 输入，并在 settlement 证明 `progressAfter.primary < progressBefore.primary`；只改变 tie-breaker、receipt 数、child terminal、更新时间或 quota 未耗尽不构成 progress；若 successorOrdinal>1，前一 successor 也必须已 strict progress；
- `maxEvidenceSuccessors=2` 未达到；
- Reporter/Judge 资源可以在 90 秒内获得；
- successor 不会创建新的 scan，也不会改变旧 snapshot；每次 successor 只允许为其直接 `gapItemIds` 创建 descendant evidence，`descendantCount ≤ min(80, gapItemIds.length)`，不允许 descendant 再创建 successor，且一个 root 的累计 descendant evidence 不得超过 `2×80`。

成功 successor 必须重新读取并产生新的 immutable binding；没有新的可信 primary progress、预算耗尽或任何 fence/时间失败时立即 partial，不继续补料。`research_successor` 不能越权写 Today Projection，也不能把自己的任务数当作机会数。

### 9.3 硬停止谓词

Actor 在每次控制事务前后检查以下谓词；任一为真即终止当前 root/stage，不再生产新 child：

```text
root_elapsed >= 20 minutes
stage_attempt_count >= 2
source_collection_closed_without_frozen_snapshot
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
`source_count >= 80` 只关闭本 root 的 Reporter collection：Actor 必须按已返回业务优先级、`sourceId ASC` 截断并在同一 T4 bundle 冻结至多 80 个 trusted source，然后仍允许一次 F→J handoff 和一次 Judge settle。只有达到上限却无法冻结可信 snapshot，或后续试图采集第 81 个 source，才进入 `SOURCE_BUDGET_EXHAUSTED`/partial；Judge 资源不足另走 `RESOURCE_WAIT_TIMEOUT`，不与 source cap 混淆。`lastBusinessProgressAt` 只有在 progressMeasure 严格改善时更新。


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
  → bind task identity and persist launchAttempt/envelope
  → OS spawn external process
  → inventory/register
  → state=spawn_started/running, or spawn_uncertain until adopt-or-kill
```

任何 spawn window（包括“OS 已返回但 DB 尚未回写”）都进入 §6.7 的 `spawn_uncertain`/adopt-or-kill 协议，不得仅按同一 dispatch identity 直接重放或凭 DB 行 orphan；只有 process inventory 证明无匹配进程且旧 attempt 已确认终止后才能新建 launchAttempt。禁止先启动 Pi 再补登记。取消、超时、supersede 和 lease 失效都必须释放 Reporter/Judge lease；外部进程停止后等待 stdout/stderr drain 和 session 写入，再清理 cwd。

### 10.3 公平与防饥饿

- Owner intent、required repair 后 intent 优先于 scheduler；同优先级按 durable mailbox sequence FIFO。
- Background scheduler 不能占满 5 个 Reporter 槽；Actor 至少保留一个交互保留槽，或在交互 intent 到达时抢占尚未 spawn 的 background reserve。
- Judge 永远单例，但不同 root 不能互相修改对方 snapshot；排队记录预计等待和剩余 root budget。
- 超过 90 秒的等待不继续留在 `running`；它转为 `partial/failed`，并明确是资源不足而非“仍在工作”。
### 10.4 Durable mailbox order、coalescing、backpressure 与 bounded backlog（规范修正）
所有 producer 只能写 `orchestrator_mailbox`，不得直接调用 worker。envelope 必须包含 `workspaceId,mailboxSequence,commandReplayKey,requestId,intentId,producer,priority,enqueuedAtUtc,enqueuedAtMono,expiresAtUtc,expiresAtMono,coalescingKey,coalescingMode,causationId,logicalInputHash,normalizedPolicyHash,payloadHash,state,claimedActorEpoch,claimedAtUtc,claimedAtMono,finishedAtUtc,finishedAtMono`。`mailboxSequence` 在 T1 事务由 Actor 行原子递增，跨重启不回退；同一 priority 按 sequence FIFO，candidate/required-repair/authorized-cancel 的 priority 高于 scheduler。

仅 `coalescingMode=equivalent_scheduler_work` 的 envelope 可按 `(workspaceId, coalescingKey, logicalInputHash, normalizedPolicyHash)` 合并；合并必须保留最早 sequence、所有 requestId 的 replay receipt 和 causation 列表，并指向一个 canonical intent。candidate decision、required repair、authorized cancel、不同 rootMode/source 或任何不同 logical/policy hash 永不 coalesce。duplicate/replay 不得重置 deadline 或增加 root/claim/child。
Actor 必须持久化 `maxMailboxDepth=256`、每 producer quota、当前 depth、oldest age 和 `backpressureReason`。超过 quota/depth 时，新 envelope 返回 `MAILBOX_BACKPRESSURE`（含 retryAfter/可执行 action）并只写 rejection receipt；不得丢弃旧 command、内存排队或绕过 mailbox。超过 `expiresAtMono` 的未 claim envelope 由 Actor terminalize 为 `MAILBOX_EXPIRED`，保留 receipt/event，不创建 root；deadline 的 UTC instant 只作配对 readback，dequeue 只允许当前 actor epoch 以 CAS claim；crash/restart 后未完成 envelope 由同一 request/sequence resume once 或 terminalize，不生成新 sequence。

### 10.5 Judge fairness、interactive aging 与 successor progress（规范修正）

Judge=1 是硬上限，但队列采用可审计的两级策略：candidate/required-repair/authorized-cancel 为 interactive，scheduler/rolling/reconcile 为 background；interactive 等待一旦出现，禁止新增 background reservation。尚未 spawn 的 background Judge 可被 interactive 原子抢占并转回 queued；已运行 background Judge 只在安全 checkpoint（最长 10 秒）释放，超时由 watchdog fence/settle 后再授予 interactive。每个 queued claim 保存 `priority, enqueueSequence, age, rootDeadline, interactiveWaitDeadline`；interactive 的 `interactiveWaitDeadline=min(rootDeadline, enqueue+60s)`，不可因 background 单独耗尽。若到期仍无安全释放，Actor 写 `JUDGE_INTERACTIVE_BLOCKED` 与 maintenance/partial 结果，绝不创建第二个 Judge 或静默丢命令；重启按同一排序继续。

每个 evidence successor 必须保存 `progressBefore={gapHash,projectionHash,missingRequiredEvidenceCount,invalidCount,pendingCount,coverageGapCount,trustedReceiptCount,eligibleCount,orderedMissingEvidenceIds,orderedGapItemIds,orderedCandidatePlanItemIds}`、同结构的 `progressAfter`、`progressMeasureVersion=2` 和 `progressOrdinal`。所有 count 均为有限非负整数，所有 ID 数组按 stable ID 排序去重，数组比较采用 length-prefixed UTF-8 字节序的字典序，hash 使用固定 lowercase hex；因此完整 measure 对任意两个快照都是总序且可复算。比较方向固定为 `missingRequiredEvidenceCount ASC`、`invalidCount ASC`、`pendingCount ASC`、`coverageGapCount ASC`、`trustedReceiptCount DESC`、`eligibleCount DESC`，再以 `orderedMissingEvidenceIds ASC`、`orderedGapItemIds ASC`、`orderedCandidatePlanItemIds ASC`、`gapHash ASC`、`projectionHash ASC` 作为确定性 tie-breakers。`strict progress` 只有上述 primary 六元组按声明方向严格改善且 `gapHash` 变化时成立；tie-breaker 变化单独不得算进展，完整 measure 相等就是 no-op。`

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
### 11.4 Durable active-root index 与 approval fence（规范修正）

`workspace_active_root_index` 是每 workspace 的可读 projection，不是第二 authority；其每行至少包含 `workspaceId,rootRequestId,orchestrationId,managerTaskId,rootGeneration,source,rootMode,status,terminalReason,isActive,priority,mailboxSequence,checkpointRevision,indexRevision,stageRequestId,projectionState,scopeHash,projectionHash,eligibleIdsHash,nextAction,visibleSince,updatedAt,acceptanceRunId,baselineEventSequence,baselineCheckpointRevision,createdAfterEventSequence,createdAfterCheckpointRevision,createdAfterMono`。`eligibleIdsHash` 必须按 `eligible-ids/v1` 用 ordered eligible IDs 写 registry 并可独立重算。root/first claim 创建且 Projection 尚不存在时三种 hash 和 nextAction 可为 NULL，T3 插入 `projectionState=absent`；Stage D scheduler root 以 `succeeded/NO_CURRENT_TARGETS` 结束且从未产生 Projection 时，T6 原子写 `projectionState=not_applicable`、三种 hash/FK 为 NULL。除此之外 waiting_owner、clean-empty 和 succeeded 均必须 `projectionState=frozen`。

T3 root admission、T4 source freeze、T5 F→J、T6 Projection/terminal、T8 cancel/drain 都必须在同一当前 Actor fence 与各自 bundle 原子写或更新 index；root/checkpoint/projection/cancel/terminal 任一已提交而 index 缺失或落后，都只能由 §6.6 的 `active_root_index.rebuild_requested`/`rebuilt` durable event 在同一 Actor fence 下按 root→stage→scope/projection 重建并 CAS 回读，重建前禁止 approval/supersede。background scheduler root 不能静默覆盖、隐藏或自动 supersede waiting_owner root；supersession 只能由 Actor 接受的显式 typed command 完成，并写 predecessor/successor identity；未完成 waiting_owner 未经显式 supersede 一直可见。

每个 Owner approval command 必须携带并由 Actor 在同一事务校验：`workspaceId, rootRequestId, rootGeneration, orchestrationId, stageRequestId, scopeHash, projectionHash, expectedCheckpointRevision, eligiblePlanItemIdsHash, decision, approvedPlanItemIds`。校验要求当前 index/root/stage 均匹配、`projectionState=frozen`、status 仍为 `waiting_owner`、scope/projection 仍 frozen、`approvedPlanItemIds` 是当前 eligible 集合的子集且不含 pending/invalid；Projection 尚不存在时 approval 必须稳定返回 `OWNER_APPROVAL_STALE`，不能用 nullable index 越过投影。任何 stale root、superseded root、旧页面、错误 workspace、旧 hash、集合漂移或已写 terminal 状态统一返回 `OWNER_APPROVAL_STALE`/`STATE_CONFLICT`，只写 receipt/audit，业务 affected rows=0。候选 decision 是 candidate 的 first-writer immutable result，不可借另一 root 的相同 planItemId 覆盖。

Manager/Today 的 read API 必须返回 index 中所有 active roots（包括 `projectionState=absent`）的 origin、nextAction、coverage gap、控制归属和 checkpoint cursor，而不是一个“最新任务”。同日 Owner、scheduler、MCP 的 root 可并存，但每个 root 的 rootRequestId/orchestrationId/stage/scope/projection/eligible set 必须独立可读；任何 UI CTA 都必须绑定一个具体 root/stage/scope/projection identity。

### 11.5 Valid candidate、invalid repair 与 notification replay/resync（规范修正）

Projection 含 invalid 时，Actor 不得把 invalid 当 eligible，也不得让 valid candidate 永久无动作。默认动作是 `partial/INVALID_NEEDS_REPAIR`，并生成非空 `nextAction={kind:"repair_invalid_candidate",rootRequestId,stageRequestId,scopeHash,projectionHash,invalidPlanItemIds,repairDeadline}`；该 CTA 属于 Owner 的候选处理边界，不是 generic Continue。`repair_invalid_candidate` 命令必须携带上述 fence、invalid item IDs、修复 receipt/payload hash 和新 requestId；Actor 以 T6/T2 方式建立 immutable repair binding，验证 revision/hash 后生成新 scope/projection 或稳定 `CANDIDATE_REPAIR_REJECTED`，不修改旧 scope/projection。若只存在 eligible 且 pending/invalid=0 才可 `waiting_owner`；若仍有 pending/invalid，eligible 不能被批准，必须保留 repair/successor action。

每次 projection、root terminal、owner waiting、cancel、checkpoint 或 rejection commit 都必须在同一 T6/T8 transaction 写 monotonic `managerCheckpointRevision`、`projectionCursor`、index `checkpointRevision/indexRevision` 和 durable outbox notification；broadcast 仅作 hint。客户端 attach/refresh/reconnect 先读取最新 checkpoint/index，再从 cursor 消费 inbox；event 重复、乱序、sequence gap、未知 projection hash 或 checkpoint 回退均触发一次 full resync，而不是按局部事件猜状态。resync 返回完整 root/stage/scope/projection（或明确 `projectionState=absent`）、CTA fence 和 `asOf`，并将旧页面 approval 标为 disabled/stale。
notification 在 commit 后丢失、无 subscriber、consumer crash、重复或乱序时，outbox 必须可重放且 inbox 只能按完整 `(consumerId,aggregateId,aggregateRevision,eventType,eventOrdinal)` 一次生效。旧 approval、旧 cancel、旧 repair 在 resync 后即使再次提交，也只能得到原 terminal/stale receipt 和零业务写；不得因为 UI 仍显示 `running` 而新建 root、重复 stage 或恢复 terminal root。

## 12. 取消、重启与恢复

### 12.1 取消序列

```text
authorized system cancel command（不属于 Owner 审批交互）
  → Actor receipt + single-flight claim
  → fenced root/intent/stage CAS to cancelled
  → cascade active research claims, dispatches, consumptions to cancelled/orphaned with `CANCELLED_BY_AUTHORIZED_SYSTEM`
  → abort external workers; bounded stop and stdout/stderr drain
  → release all leases and queue reservations
  → write finished_at + terminal readback + event
  → broadcast Today/Manager update
```

如果命令到达时已 terminal，返回原 terminal 快照，不产生新写。旧 worker 的 event/result/mutation 只允许进入 audit，不能写新 root、PlanScope、Projection 或 content。source_items、已冻结 snapshot 和已提交的可信业务数据默认保留，不做删除/重置。

### 12.2 启动 gate 与恢复

应用接受任何新派工前必须：

1. 当前 Actor 先生成新的 runtime epoch；随后为 `(workspaceId,newRuntimeEpoch)` 插入一条新的 `daily_reconcile_gates(status=pending)`，写入与该 epoch/owner epoch/lease token/checkpoint revision 相等的 gate projection。旧 epoch 的 complete/failed/maintenance gate 行保持 append-only terminal，不在原位 reset；gate 不是第二 authority。
2. 枚举所有 `orchestrator_intents`/`channel_preflight_snapshots` 非终态、`orchestrator_mailbox` 未终态 envelope、`agent_tasks running/resume_pending`、所有 active `daily_stage_claims`、managed dispatch/consumption 非终态和所有非终态 roots，不能只找 latest daily task。
3. 对每条记录校验 parent/root/stage/snapshot/cwd/session/hash/fence；所有时间 readback 同时校验 UTC instant 与 monotonic tick。
4. 若 lease 仍有效但未到 `controlStallDeadlineMono`，有界等待原 owner；到达 `min(leaseExpiresMono,rootDeadlineMono,stageDeadlineMono,gateDeadlineMono)` 即由 watchdog/胜者 fenced takeover，不得无限等待。Actor 以 CAS 将 gate `pending→running`，并把 gate `runtime_epoch/owner_epoch/lease_token/checkpoint_revision` 逐字段锁定为当前行。
5. `cancelled` 或 superseded ancestor 的 child 全部 terminal/orphaned，不得恢复；若任一记录无法在 deadline 前恢复，当前 Actor 将其终结并把 gate `running→maintenance`，写稳定 reason/finishedAtUtc/finishedAtMono。
6. acceptance-only scenario 只能由 acceptance runner 终结，生产 reconciler 不 spawn；不可恢复的 gate contract/error 进入 `running→failed`，写 reason/finishedAtUtc/finishedAtMono。
7. 全部普通记录完成恢复或明确终结后，当前 epoch gate 才以 Actor CAS 从 `running→complete`；`maintenance/failed` 不得伪称 complete，也不在同一 epoch 回退。后续启动必须创建新 runtime epoch 和新的 pending gate 行；只有当前 epoch gate `complete` 时 Actor 才接收新生产命令。

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
| `CHANNEL_POLICY_INVALID` | receipt failed；无 root | 丢弃非单调 policy，保留 normalized profile/rejection evidence | 否 | 0/0 |
| `NO_CHANNEL_SELECTED` | partial；无 root | 显示 `select_channel` 或 `start_new_intent`，不自动重试 | 否 | 0/0 |
| `PRECHECK_DEADLINE` / `PRECHECK_INTERRUPTED` | needs_user 或 failed；无 root | probe lease 终结；同一 preflight 最多 resume 一次 | 否 | 0/0 |
| `CHANNEL_RUNTIME_AUTH_FAILED` | needs_user/partial；当前 stage 终止 | required repair；optional 排除并写 gap | 是（required 时） | 不增加 |
| `SOURCE_PROVENANCE_MISMATCH` | failed；scope/Judge 零写 | 丢弃 untrusted source/receipt，保留审计 | 否 | 0/0 |
| `EFFECT_OUTCOME_UNKNOWN` | consumption unknown；不宣称成功 | 先按 outcomeQueryKey 查询或执行声明的补偿 | 否 | 0/0 |
| `STATE_CONFLICT` / `AUTHORITY_BUSY` | receipt failed；原行不变 | 按当前 row 重读或 bounded wait，禁止第二 authority | 否 | 0/0 |
| `OWNER_APPROVAL_STALE` | receipt failed；candidate decision 零写 | 返回当前 index/projection fence | 否 | 0/0 |
| `CANDIDATE_REPAIR_REJECTED` | partial；旧 scope 不变 | 保留 invalid 原因，继续显示 repair action 或终止 | 是（候选处理） | 0 |
| `MAILBOX_BACKPRESSURE` | receipt failed；不入队 | 返回 retryAfter/可执行 action，不丢旧 envelope | 否 | 0/0 |
| `MAILBOX_EXPIRED` | partial/failed；无 root | 终结过期 envelope，保留 receipt/event | 否 | 0/0 |
| `JUDGE_INTERACTIVE_BLOCKED` | partial/maintenance；不创建第二 Judge | watchdog/安全停机，Owner 命令可重放 | 否 | 0 |
| `NO_BUSINESS_PROGRESS` | partial；无 successor | 保存 progressBefore/After，停止 churn | 否 | 0 |
| `SOURCE_BUDGET_EXHAUSTED` | partial 仅在无法冻结可信 snapshot 时 | 关闭 collection；已 frozen 80 source 仍允许一次 F→J | 否 | 0 |
| `MIGRATION_IN_PROGRESS` | receipt failed；业务零写 | 等 migration journal complete/maintenance | 否 | 0/0 |
| `CUTOVER_REQUIRED` | receipt failed；业务零写 | 只接受满足 store fence 的 build/epoch | 否 | 0/0 |
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
| `CANCELLED_BY_AUTHORIZED_SYSTEM` | cancelled | 级联停止、保留数据、不可恢复旧 root | 否 | 0 |

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
### 14.4 Migration epoch、journal 与全局 zero-write fence（规范修正）

每个 workspace 的每次迁移必须有 `workspace_migration_state((workspaceId,migrationEpoch) PK, status, manifestHash, schemaEpoch, cutoverEpoch, ownerRuntimeEpoch, fenceTokenHash, checkpointSeq, beforeHash, afterHash, startedAtUtc, startedAtMono, finishedAtUtc, finishedAtMono, failureReason)`，以及 append-only `workspace_migration_journal(workspaceId, migrationEpoch, stepSeq PK, stepKey, inputHash, beforeHash, afterHash, rowCount, winnerSetHash, status, committedAtUtc, committedAtMono)`。journal 的 logical unique 为 `(workspaceId,migrationEpoch,stepKey)`；所有引用 workspace 的迁移行必须 FK 到对应 migration state/Actor，禁止 delete/cascade。迁移 state 不包含 rollback 字段；后续 rollback 只能使用 §16.3 的独立 `workspace_rollback_state`。

迁移开始时，Actor 在一个事务中分配新 `migrationEpoch`、写 manifest/checkpoint、设置 `writeFence=deny` 并撤销旧 execution envelope；随后由当前 authority 验证 producer/process census、持久化 fence receipt，才可扫描和提交迁移 bundle。fence 未完成、journal 非 terminal 或 verify 未通过期间，所有新旧业务 writer（包括 Actor intent/root、store、IPC、MCP、scheduler、worker、Manager、startup timer）必须得到 `MIGRATION_IN_PROGRESS`/`CUTOVER_REQUIRED` 并零业务写；只有带当前 `fenceTokenHash + migrationEpoch` 的 migration API 可写 migration journal、orphan/tombstone 和目标映射。

每个迁移 step 采用与 §6.6 等价的 serializable bundle，先记录 before hash/count，再一次性提交 provenance mapping、FK 闭包、winner/orphan 标记和 after hash/count；崩溃后只按 `(migrationEpoch,stepKey)` replay，若 before/after 不匹配即进入 maintenance，不猜测性继续。完成 gate 以前必须验证 workspace/root/plan/source/receipt/data-root 唯一链、所有 FK 闭合、unknown provenance 不在 active query、winnerSetHash 稳定，并读回 `migrationEpoch, checkpointSeq, manifestHash, beforeHash, afterHash`。迁移不能删除 source/claim/version/receipt，也不能把 running/resume_pending 改成 succeeded。

### 14.5 Startup producer census 与持久跨版本 store fence（规范修正）

阶段 0 必须生成并冻结 `producer_registry` manifest 与全局 `censusHash`，逐项列出 constructor、IPC handler、MCP route、scheduler callback、timer/cron、startup hook、handoff sweeper、archive/backfill/lint/maintenance、browser/CDP session、child spawn 和每张 side-effect table 的 writer；每项包含不可变的 `producerId, buildId, sourceLocation, trigger, triggerId, allowedIntentKind, owner, replacementRoute, writeTables, writePrincipal, authorizerRevision, processImagePath, resourcesPath, registryEntryHash, enabled, censusHash`。allowlist 外 callback、动态注册、未知 side effect 或 census hash 漂移，在 startup、canary、rollback 和正常运行都只能 audit/reject，不能写业务行。

每个 producer request 在 T1 及每次业务 mutation 前都必须提交由 registry 绑定的 `producerAttestationHash=H_v1(producer-attestation/v1)`，并携带 `producerId,registryEntryHash,censusHash,triggerId,processId,processStartTimeUtc,processStartTimeMono,processImagePath,resourcesPath,buildId,sourceCommit,packageHash,appAsarHash,schemaEpoch,cutoverEpoch,runtimeEpoch,writePrincipal,authorizerRevision`。Actor/store 必须从冻结 manifest 和实时 process inventory 重新计算并校验 attestation；调用方自报但未被 registry/process proof 支持的字段一律拒绝。

data-root 必须持久化 `cutoverEpoch, minSupportedBuild, schemaEpoch, acceptedBuildManifestHash, writeFence`。DB/store 写边界固定为：`wmb_actor_store` 仅可通过带当前 Actor fence 的授权 Store API 写业务表；`wmb_migration_store` 仅可在当前 migration fence 写 migration/orphan/tombstone；`wmb_acceptance_store` 仅可写 acceptance namespace；其他 renderer、MCP client、scheduler、worker、Manager、用户/手工 SQL 连接均为只读或拒绝。每个写 session 必须由 DB authorizer/不可绕过的 BEFORE trigger 校验 `writePrincipal,triggerId,authorizerRevision,producerAttestationHash,workspaceId,actorEpoch,ownerEpoch,leaseToken,migrationEpoch/writeFence` 与当前 Actor/manifest；principal、trigger、authorizer、workspace 或 attestation 任一不匹配时返回稳定 `STORE_WRITE_AUTHORIZATION_REQUIRED`/`CUTOVER_REQUIRED`，affected business rows=0，并追加 redacted security event。未知 dynamic producer、错误 schema/cutover/runtime epoch 同样拒绝；直接 DELETE、绕过 Store API 的 UPDATE/INSERT、用新路由部署代替授权均无效。

clean cutover 的 gate 顺序固定为：冻结并保存 census → 全局 zero-write fence → 停止/验证旧 producer → drain process/session/port → 校验 schema/provenance/journal → 启用新 Actor gate → 只经 Actor intent 放行。新 Actor canary 期间旧 writer 仍必须被 store authorizer 拒绝；禁止双写、legacyPipeline、date-only selector、generic Continue 或 projection guess。以上步骤分别绑定 WMB-4801–WMB-4809 的持久 receipt 和 manifest hash，缺任一 receipt 只能 maintenance，不得开业务 gate。

### 14.6 Legacy process、session drain 与 active inventory proof（规范修正）

cutover/migration/rollback 必须枚举并持久化所有 PID、parent PID、start time、argv hash、workspace/session key、browser/CDP port、MCP connection、child launchAttemptId、lease token fingerprint、cwd 和 stdout/stderr drain watermark。只看到 DB 的 orphan row 不算 drain；每个 process/session 都必须得到 confirmed exit/close、最后输出水位和 store authorization reject readback。date-only 或缺 Actor epoch 的 worker 必须写不可删除 deny/tombstone；其迟到 source/receipt/result 只能 audit，source admission 必须证明当前 root/preflight/provenance。

inventory 不完整、PID 重用无法区分、端口仍监听、child 仍持旧 token、browser/MCP 未关闭或 stdout 未 drain 时，cutover gate/rollback gate 必须保持 `maintenance`，不得删除旧分支或接受新 root。process stop、drain、session close、cwd cleanup 可重放但每一步都要有 journal evidence；不得用 sleep、进程名或日期推断已停止。

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
### 16.3 Rollback barrier、drain、schema compatibility 与 maintenance outcome（规范修正）

Rollback 不修改已 terminal 的 `workspace_migration_state`。Actor 必须新建不可复用的 `workspace_rollback_state(workspace_id,rollback_epoch)`，一次写入 `source_migration_epoch,target_build_manifest_hash,target_schema_epoch,target_min_supported_build,target_cutover_epoch,status=requested,startedAtUtc,startedAtMono,barrierReceiptHash`；同一事务设置全局 `writeFence=deny`、停止接受新 intent、撤销当前 leases，并向所有旧 envelope 写 revoked。没有该独立 rollback barrier receipt，不得停止或切换任何进程。

随后固定执行 `workspace_rollback_state.status: requested → fencing → draining → verifying → complete`，失败只能到 `maintenance/rollback_required`：枚举并停止全部 Reporter/Judge/research/consumption child、独立 scheduler/timer、renderer/MCP/browser/CDP session 和监听端口，按 §14.6 读回 PID/start time/argv/session/launchAttempt/lease/stdout drain/exit/close/cwd cleanup。所有 active dispatch/consumption 必须为 terminal/orphaned，所有旧 token 的迟到写必须得到 `EXECUTION_AUTHORIZATION_INVALID` audit-only；任何 inventory 不确定、端口仍监听、stdout 未 drain 或 process 仍 alive 时不得进入 complete，并必须写 `reason,finishedAtUtc,finishedAtMono`。

目标 binary 必须声明并由 store 校验 `buildId,sourceCommit,packageHash,appAsarHash,schemaEpoch,readSchemaMin/readSchemaMax,writeSchemaEpoch,cutoverEpoch`，且目标 manifest hash 必须等于 `target_build_manifest_hash`。若目标版本不能读写当前 schema、不能理解当前 cutover/migration epoch 或没有 Actor/gate 协议，rollback 必须保持 maintenance，不能启动该 binary，也不能恢复 direct scheduler、legacyPipeline、date-only recovery 或 generic Continue。数据 restore 只能使用 schema-aware backup/manifest，在 active root=0、journal complete、chain hash/count/FK 全部一致并有审计 receipt 后执行；禁止手工 SQL 覆盖终态。

rollback 完成后的新 runtime 必须以新 epoch 和新的 pending gate 行启动、重新跑 gate/reconcile，并且只能从新显式 intent/new root 开始；旧 root、projection、effect、requestId 不复活。rollback acceptance 需要同时读回独立 `workspace_rollback_state`、source migration journal（只读）、全部 target/rollback 字段、process drain、schema compatibility、store authorizer rejection、maintenance 或 complete outcome；只看到应用窗口切换或旧进程消失不能算通过。

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
### 17.3 Versioned event/redaction、metric label 与 grant matrix（规范修正）

`orchestrator_events` 固定 `eventSchemaVersion=1`。每条 event 必须含 `eventId,eventSequence,eventType,eventOrdinal,workspaceId,businessDate,source,intentId,invocationId,rootRequestId,rootGeneration,orchestrationId,managerTaskId,stageRequestId,requestId,operationRequestId,parentTaskId,jobId,causationId,actorEpoch,ownerEpoch,leaseTokenFingerprint,claimRevision,checkpointRevision,snapshotHash,scopeHash,projectionHash,producerId,registryEntryHash,censusHash,triggerId,processId,processStartTimeUtc,processStartTimeMono,processImagePath,resourcesPath,writePrincipal,authorizerRevision,producerAttestationHash,acceptanceRunId,baselineEventSequence,baselineCheckpointRevision,createdAfterEventSequence,createdAfterCheckpointRevision,createdAfterMono,occurredAtUtc`；不适用字段写 `null`，不得省略。event payload 先按同一 canonical bytes 计算 hash，并通过 `redactionSchemaVersion=1` 删除 cookie/token/password/session secret、原始私密正文和完整授权 header；redaction 后仍需保存 payloadHash，禁止把 secret 的 hash 当作 secret 本文。

指标 label 只允许 `workspaceId,source,rootRequestId,rootGeneration,orchestrationId,stageRequestId,actorEpoch,buildId`，禁止用日期、用户正文、token 或无限 cardinality 的动态 label。至少固定阈值为 active root 18m、resource wait 60s、preflight aggregate 90s、lease TTL 30s、orphan>0、old-epoch reject、projection ID/hash mismatch；每条告警持久保存 `metricId,threshold,observedAtUtc,observedAtMono,labels,acceptanceRunId,causationId`，并能从 event/outbox readback。

权限矩阵固定为：Manager 只能 `read_projection/read_index/submit_candidate_decision/submit_required_repair`；Owner command 只能通过 Actor mailbox；authorized system 只能通过 Actor mailbox 提交 `cancel_root`；Reporter/Planner/Writer 只能使用其 stage grant 写自己的 dispatch/result/effect sink；Reconciler 只能用当前 epoch 恢复原 identity；acceptance runner 只能写 `acceptance_runs` 和带 scenario/barrier 的测试 namespace。DB 的 `wmb_actor_store`、`wmb_migration_store`、`wmb_acceptance_store` 是唯一可写 principal，分别受 Actor fence、migration fence、acceptance namespace 限制；所有业务表的不可绕过 DB authorizer/BEFORE trigger 必须校验 `writePrincipal,triggerId,authorizerRevision,producerAttestationHash,workspaceId,actorEpoch,ownerEpoch,leaseToken,migrationEpoch/writeFence`。任何 Manager-as-worker、worker grant escalation、自动 publish、手工 DB update、伪 hash、失败 receipt 包装成功、跨 workspace binding、unknown principal/trigger/attestation 都必须在 store 层返回稳定 `STORE_WRITE_AUTHORIZATION_REQUIRED`/`CUTOVER_REQUIRED`，affected business rows=0，并记录 redacted security event；直接 SQL、直接 DELETE 或“新路由已部署”均不能绕过该 authorizer。

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
### 19.2 Acceptance run、build manifest 与 fresh causal delta（规范修正）

`build_manifests` 是不可变构建事实，至少包含 `buildId,sourceCommit,packageHash,appAsarHash,resourcesPath,schemaEpoch,readSchemaMin,readSchemaMax,writeSchemaEpoch,cutoverEpoch,manifestHash,createdAtUtc`；manifest hash 必须覆盖这些字段的 canonical bytes。验收不能只 hash 磁盘文件：当前运行进程必须返回并由验收器交叉校验 `pid,startTimeUtc,startTimeMono,processImagePath,resourcesPath,loadedBuildId,loadedSourceCommit,loadedPackageHash,loadedAppAsarHash,dataRoot,schemaEpoch,cutoverEpoch,runtimeEpoch`，且 PID/start time 在整个 run 内不变。进程加载的 artifact hash 与磁盘 manifest、data-root fence 和 build manifest 不一致时，验收立即失败，不能复用旧 renderer、旧 app.asar 或 dev process。

每一轮验收开始必须先持久化 `acceptance_runs(acceptance_run_id PK, acceptance_namespace, workspaceId, scenarioId, buildId, manifestHash, baselineEventSequence, baselineCheckpointRevision, baselineTableHashes, baselineCounts, baselineDataRootHash, startedAtUtc, startedAtMono, freshAfterMono, status, resultHash, finishedAtUtc, finishedAtMono)`；`freshAfterMono` 是 DB/server monotonic watermark，不是客户端时间。`acceptance_run_id` 及 `baselineEventSequence,baselineCheckpointRevision,createdAfterEventSequence,createdAfterCheckpointRevision,createdAfterMono` 必须传播到每个参与本轮的 command receipt、mailbox envelope、intent、preflight、root、claim、source/receipt binding、repair binding、scope/Projection、dispatch、effect result、event、outbox/inbox row；生产行可全部为 `NULL`，但不能只填其中一部分。run 必须使用隔离 namespace 和新 requestId，禁止绑定历史 root、seed、孤立 receipt 或旧 projection；本轮 row 的 created-after 值必须严格晚于 baseline 并沿 `causationId → rootRequestId → stageRequestId → job/effect → readback` 闭合。

只有以下 fresh causal delta 才能证明真实闭环：每个 required selected channel 有本轮真实调用 receipt/payloadHash/resultHash；**状态合同要求创建的** child 有当前 launch/process identity、terminal result 和业务 output delta；frozen snapshot/scope/projection/checkpoint 在 baseline 后首次提交且 hash 可重算；终态与 UI/Manager readback 的 checkpoint、ID set、hash 一致。若某状态按 §7/§9 明确禁止创建 child（例如 required preflight 阻断、无 trusted material、全 optional 失败），验收必须提供 baseline 后的 durable `creation_forbidden_reason` event/checkpoint、对应 child 查询为零和终态 readback，不能不可能地要求 child。`succeeded`、`waiting_owner`、`clean_empty`、`partial`、`failed`、`needs_user` 都必须按其 expected-child contract 列出 terminal/readback 或 forbidden-child proof、fresh delta、build identity 和 redaction/security proof；历史 source、预先存在的 plan/receipt、只有截图的变化、孤立成功 child、没有本轮 causation 的 projection 或全库计数均不能计入 acceptance，任何证据缺失都 fail closed。

### 19.3 新增可证伪 adversarial scenarios（A29–A57）

下表每行是一个独立、可执行且只有一个判定结果的负向/边界 acceptance。每行必须注入所列 crash、并发、版本或伪造条件，读取持久 row/event/hash/process inventory；“通过”只指表中唯一条件成立，不能用一般性“流程完成”替代。

| ID | 对应 finding | 执行注入 | 唯一通过条件（失败即拒绝） |
|---|---|---|---|
| A29 | B-01/N-01 | 用两个不同 requestId 提交完全相同 logical input，再用同一 requestId 提交不同 payload；重放、retry 并发并重启 Actor；另造 repaired binding 并交错写 child。 | 两个新 invocation 各有唯一 ordinal/intent/invocationId/rootRequestId；同 requestId 只读同一 receipt；payload 改变稳定 `REQUEST_REPLAY_CONFLICT` 且零新 root；projectionHash 覆盖 Projection 每个语义字段；repairSnapshotId identity 稳定，child hashes→repairSnapshotHash→bindingHash 顺序非循环，三者 registry preimage/derived/readback 逐字节相等。 |
| A30 | B-02 | 在 `reserved`、`task_bound`、OS spawn 已成功未回写、`spawn_started` 前、register 前、stdout drain 前分别 crash；人为保留匹配及不匹配 PID/session。 | 每个 launchAttempt 恰有一个 child：匹配进程只 adopt、不匹配或不确定状态先 stop/drain/close 并确认终结；无第二 spawn、无泄漏 cwd/session，dispatch/process inventory 一一对应；旧 token 输出只有 audit。 |
| A31 | B-03 | 对同一 effect 分别声明 `exactly_once`、`at_most_once`、`at_least_once`，在 sink 已提交但本地未 settle、lease expiry、restart、duplicate event、cancel 后 replay，并用同 token 改 sink identity/payload。 | 三种分支均绑定 `roleId/sinkName/sinkContractVersion/deliveryMode`：`exactly_once` 必须有 token 幂等+outcome query proof 且外部 effect 恰一次；`at_most_once` 不盲重试，query 或声明 compensation/unknown terminal proof 后不得伪称成功；`at_least_once` 只能同 token 重试并以 dedupe/query/compensation proof 证明重复已处理；任何 token/sink identity/payload 冲突稳定拒绝，failed/partial/cancelled 不转成功。 |
| A32 | B-04/N-03 | 在 T1–T8 每个写入边界 crash，特别在 Stage-D target/effect freeze 与 registry 写入之间 crash；丢弃 broadcast、重复 request/event，并删除或延迟 active-root index row。 | 每个 bundle 的全部适用 registry rows（含 `targetSetHash/effectSetHash/eligibleIdsHash`）、intent checkpoint/status、业务行、index、checkpoint、event/outbox 只能全成套或全回滚；index rebuild 后 `eligibleIdsHash` 按 registry preimage 可独立重算；重放只返回 canonical response，不产生半套 Stage-D dispatch、重复 effect 或隐藏 root。 |
| A33 | B-05 | Runtime R1 阻塞 control loop 但继续 heartbeat；R2 在 lease-valid、stall-deadline 和 lease-expired 三个窗口启动，watchdog 同时竞争。 | 有界时间内唯一胜者推进 Actor 与 gate 同一 epoch/token/revision；旧 R1 无业务写/新 child，pending 可恢复或明确 maintenance；R2 不无限等待、不完成另一套 gate。 |
| A34 | B-06/N-03 | 两连接交错 takeover、旧 worker late result、watchdog settle、cancel、projection commit；终态结果故意写不同 hash，并覆盖每个 lifecycle table。 | 每个业务 mutation 都以当前 Actor/parent row 和表专属 first-writer predicate CAS；旧 epoch/token 全部 `EXECUTION_AUTHORIZATION_INVALID` audit-only；每个终态 winner 的 result/finishedAt/terminal reason 不可改，cancel cascade 后无 active child/lease，dispatch/consumption/claim/scope/intent/root/gate 均不被终态覆盖。 |
| A35 | B-07 | 暂停 F→J handoff commit 前执行 cancel，反向再跑 handoff→cancel，并在任一边界 restart。 | cancel 先线性化时 F/J 均 cancelled/orphaned 且零 J；handoff 先线性化时 cancel 必发现并终结唯一 J；不出现 post-cancel child、F/J/root 矛盾或双 terminal winner。 |
| A36 | B-08 | 分别在 Reporter queued、执行中、F→J 前 revoke required auth/改 config，并混用旧/new profile revision；让 capability lease 过期。 | 每种 drift 都 fail closed 为 needs_user/partial，旧 receipt/snapshot 不进入 Judge/waiting_owner/clean-empty；required repair 生成新 preflight/root；optional 只形成 gap；无旧 fence 业务写。 |
| A37 | B-09 | 由 UI/MCP 提交 required→optional、遗漏 required、重复、unknown、伪 module 和未授权 policy。 | 每次在 root 前稳定 `CHANNEL_POLICY_INVALID`；normalized profile policy/policyHash 可读；无 root/claim/Reporter/Judge/projection/waiting_owner/clean-empty，只有 rejection receipt/audit。 |
| A38 | B-10 | 分别创建 Projection 尚不存在的普通 root、Stage-D `NO_CURRENT_TARGETS` root 和正常 candidate root；在 T3/T6 前后 crash、延迟 index，启动同日 scheduler R2，并重放旧 approval。 | 普通 pre-projection root 可读为 `projectionState=absent`；Stage-D no-target terminal 只能是 `succeeded/NO_CURRENT_TARGETS + projectionState=not_applicable` 且三种 hash/FK 为 NULL；waiting_owner、clean-empty 和其他 succeeded 必须 frozen 且 `eligibleIdsHash` 可重算；index 缺失由同 Actor fence 重建，旧 approval stable conflict/零写。 |
| A39 | B-11 | 在 migration 每个 journal commit boundary crash/restart/replay，同时运行旧 scheduler、新 Actor 和 migration worker。 | global zero-write fence 生效；journal winner、before/after hash/count、FK/provenance 闭包重放稳定；未完成 migration 的业务 query/new root/direct store writer 全部拒绝；无跨表半套链。 |
| A40 | B-12 | 同时运行旧 renderer、旧 MCP、旧 scheduler/binary 与新包，触发所有旧入口、timer、动态 route 和 store write。 | 每个旧请求均 `CUTOVER_REQUIRED`/`EXECUTION_AUTHORIZATION_INVALID` 且业务 delta=0，仅 redacted audit；新 Actor intent 可完成；source/claim/plan/dispatch 无双写，app.asar/manifest/store epoch 一致。 |
| A41 | B-13 | 真实安装启动后取消 root，跨过所有已知首延迟和完整 scheduler 周期，触发未列名 maintenance/backfill/sweeper/timer，伪造 registry entry/census/process/trigger/authorizer attestation 并尝试直接写 store。 | producer registry 覆盖全部 callback/constructor/timer/spawn/table writer；每个 request 有可重算 `producerAttestationHash` 且与 frozen manifest/process inventory 相等；未知 writer、动态 callback、伪造 attestation 或取消后新业务写被 DB/store authorizer 拒绝，只有可归属 audit；startup 只 read/reconcile。 |
| A42 | B-14 | 在 migration 已 complete 后，令 F/J、research、consumption、scheduler、browser/MCP active 并触发 rollback；模拟旧 binary 不兼容、端口/PID/旧 token 未 drain。 | 已 terminal migration row 逐字节不变；独立 `workspace_rollback_state` 先持久化新 rollback epoch、source migration epoch、target manifest/schema/build/cutover、barrier receipt 和 requested 状态，再按单向状态机 drain；全局 deny、process/session/lease/dispatch/consumption readback 完整；不兼容或未 drain 为 maintenance/rollback_required，兼容目标才 complete 并以新 runtime epoch/new gate 启动。 |
| A43 | H-01 | 让 MCP、09:00、rolling、reconcile 以至少 100 个 fresh requestId 提交等价 scheduler work，在 dequeue/restart/candidate/required-repair/authorized-cancel 交错时超过 quota。 | mailbox sequence 无缺口且跨重启单调；仅等价 scheduler work 合并为一个 canonical intent 并保留每个 replay receipt；candidate/repair/authorized-cancel 不合并；backpressure/expiry 有稳定 receipt，不丢旧命令或绕过 mailbox。 |
| A44 | H-02 | Judge=1 被 background 占住超过 90 秒，再提交 Owner approval/required repair/MCP interactive work，重启并触发 safe checkpoint。 | 始终仅一个 Judge；interactive queue 按 priority/age 抢占 queued 或在≤10s safe checkpoint 释放 background；Owner 不因 background 单独 timeout；preemption/release/winner 持久且重启顺序相同。 |
| A45 | H-03 | Reporter 正好返回 80 个 trusted non-drifting sources，Judge 有容量；另测 Judge unavailable 与尝试第 81 个 source。 | 80-source snapshot frozen 后仍完成一次 F `HANDOFF_CONSUMED`、一个 J claim/dispatch；无第 81 source；Judge unavailable 只产生明确 resource outcome，不能把 source cap 误作 root terminal。 |
| A46 | H-04 | 运行 no-op successor：receipt 成功但 primary progress tuple、gap/projection hash 与 evidence IDs 不变；再运行真正减少 missing/pending/invalid 或 coverage gap 的 successor，并尝试超出 direct descendant 上限。 | measure v2 对任意快照总序且 tie-breaker 不能单独算 progress；no-op 不更新 progress、不创建第二 successor，终态 partial 含 before/after；primary 严格改善且 gapHash 变化才增加 progressOrdinal/lastBusinessProgressAt；descendant 仅 direct、每次≤`min(80,gapItemIds.length)`、root≤`2×80`。 |
| A47 | H-05 | hang 一个 channel probe，并在每个 preflight write boundary crash；提交 unrelated Owner/MCP command，超过 channel/aggregate deadline 后重启。 | hung probe lease 到期并 resume once 或 terminalize；无 root/worker，最终无 `preflight_running`；replay 返回 terminal receipt；unrelated mailbox 继续服务且无永久阻塞。 |
| A48 | H-06/N-02 | 构造 lease expiry 晚于 root/stage/gate deadline、owner 永不恢复、两个 runtime 同启和 wall-clock 偏移；让旧 epoch gate 分别 complete/maintenance/failed 后再次启动。 | 所有裁决只用 DB monotonic pair；每次启动分配新 runtime epoch 并插入新的 pending gate 行，旧 terminal gate 行逐字节不变；当前 epoch 只按 `pending→running→complete|maintenance|failed`，reason/finishedAt 可读；不得执行 complete→pending 原位回退或因旧 lease 无限等待。 |
| A49 | H-07 | 并发/replay 插入相同 initial/repaired scope、stage/preflight/receipt/event，尝试删除/归档 parent、重建 inactive claim 并触发 GC。 | initial scope 允许且仅允许 `binding_kind=initial_source,sourceSnapshotHash!=NULL,repairSnapshotHash=NULL,bindingHash=NULL,repair FK=NULL`；repaired scope 三者/registry/FK 全部存在且可重算；DB 返回 canonical row 或明确 uniqueness/FK/check reject；archive/tombstone chain anchor 完整，orphan 不可派工且无 FK 断裂。 |
| A50 | H-08 | optional write-then-fail、旧 root source、cross-root receipt、缺 channel mapping 和 selected 部分完成分别送入 snapshot/Judge；再保持其他字段相同只改变 unresolved partition。 | `successful`、`failed`、`unresolved` 两两互斥且并集恰为 selected；每个 source/receipt binding provenance 与 acceptance baseline 字段完整；越界或缺 mapping 稳定 `SOURCE_PROVENANCE_MISMATCH`；改变 unresolved partition 必须改变 `sourceSnapshotHash`，untrusted source 不进 Judge/Projection/opportunity count。 |
| A51 | H-09 | 只选 optional 且全部 preflight fail；分别模拟可修复 optional login fail 和 empty selected set。 | 无 root/worker/clean-empty；Today 显示 coverage gap 与非空 `configure_optional_channels`/`select_channel`/`start_new_intent`；选择 action 只产生一个新 request/root，旧 intent 可审计且不隐式重试。 |
| A52 | H-10 | 产生 E+I、E+P、E+P+I 三种 Projection 组合，耗尽 successor，再提交 eligible/invalid 的旧或错误 approval。 | 含 pending/invalid 不进入 waiting_owner；每种组合都有 `repair_invalid_candidate` 或 bounded successor nextAction；invalid 不可批准，stale/blocked ID stable conflict/零写；修复后新 binding/scope hash 可重算。 |
| A53 | H-11/N-03 | 在 projection/waiting_owner/terminal/cancel commit 后、notification 前 crash；同一 aggregate revision 写两个 eventType、重复/乱序 event、index 缺失、旧页面 approval 重放。 | 同一 revision 的不同 eventType 以不同 eventOrdinal 各自进入 outbox/inbox；相同完整 message identity 只生效一次；checkpoint/index/outbox 可读且 cursor resync 到 committed state，index 可由 durable rebuild 修复；旧 CTA disabled/stale，重复 approval/cancel 只有原 receipt/零业务写，不创建 root/child。 |
| A54 | H-12 | 迁移 live date-only legacy worker，在 gate complete、restart 后迟到投递 source/receipt/result，并重复 migration。 | PID/session/lease drain 与 deny/tombstone 可读；迟到写 stable authorization reject/audit-only；active source/snapshot/projection zero delta；重复 migration winner/journal 不变。 |
| A55 | H-13 | 磁盘有新 app.asar 但复用旧 PID/renderer；data-root 有历史 rows；分别运行要求 child 与禁止 child 的分支，并伪造缺 created-after 字段的 source/receipt binding。 | acceptance_run、所有参与对象及每个 nested source/receipt binding 都具有一致的 acceptanceRunId、baselineEvent/checkpoint 和 createdAfterEvent/checkpoint/mono；loaded artifact/PID/resourcesPath/manifest 一致。要求 child 的状态必须有本轮 terminal/readback；禁止 child 的状态以 `creation_forbidden_reason` 加 baseline 后零 child 证明。任一 binding 字段缺失或早于 baseline，run 必须 fail。 |
| A56 | H-14 | 每 selected channel 分别注入 ready success、optional missing/auth expiry/timeout/malformed/write-then-fail、required auth expiry。 | 每渠道都有真实 purpose/role/request/payload/result/receipt hash；required failure 阻断 Judge/waiting_owner/clean-empty；optional failure 写 gap，若仍有 trusted material 且产生 eligible 则可继续 Judge 并进入 waiting_owner，若零候选/无 trusted material 则 partial，任何 optional gap 都不 clean-empty；malformed/伪 zero 不计 trusted；Live-channel readback 与 projection 一致。 |
| A57 | H-15 | 完整 root 逐 event/metric 检查字段与 redaction，并尝试 Manager 越权、worker 提权、伪 hash、失败包装成功、手工 DB update/DELETE、伪造 producer attestation 和自动 publish。 | 所有 event schema/identity/producer attestation/acceptanceRunId 字段齐全且无 secret；metric labels/threshold/alert 可读且不串 workspace；DB principal/trigger/authorizer 对每次越权、伪造、失败包装、手工 SQL 均 stable reject、affected business rows=0 并留下 redacted security event，发布仍需既有授权。 |

### 19.4 Findings → normative amendment → acceptance traceability matrix

下表是本次 amendment 的封闭追踪合同；每个 finding 和 N-01/N-02/N-03 amendment contradiction 都同时指向至少一个具体规范段落和一个可失败的新增 acceptance，禁止以 §20 自检文字单独关闭 finding。

| Finding | 严格对应的规范修正 | 唯一新增 acceptance |
|---|---|---|
| B-01/N-01 | §5.1 versioned canonical bytes、invocation/replay 分离、Projection 全语义字段、repair ID/hash 非循环 derive registry | A29 |
| B-02 | §6.7 launchAttempt/process inventory/adopt-or-kill | A30 |
| B-03 | §5.4 effectToken、unknown outcome、sink contract | A31 |
| B-04/N-03 | §6.6 T1–T8 bundle、registry/index/checkpoint 写集、outbox/inbox、first-writer | A32 |
| B-05 | §6.5 sole Actor authority、watchdog/stall takeover | A33 |
| B-06/N-03 | §6.5 current-row CAS、逐表 terminal predicate、terminal immutability、cancel fence | A34 |
| B-07 | §6.6 T5 F→J/cancel same lock order | A35 |
| B-08 | §7.4 capability/config/auth fence 与 deadlines | A36 |
| B-09 | §7.4 normalized requiredness、policy monotonicity | A37 |
| B-10 | §11.4 active-root index、approval fence | A38 |
| B-11 | §14.4 migration epoch/journal/global zero-write | A39 |
| B-12 | §14.5 persistent cross-version store/cutover fence | A40 |
| B-13 | §14.5 producer census 与 startup closure | A41 |
| B-14 | §16.3 rollback barrier/drain/schema compatibility | A42 |
| H-01 | §10.4 durable mailbox sequence/coalescing/backpressure | A43 |
| H-02 | §10.5 Judge interactive aging/preemption/fairness | A44 |
| H-03 | §9.3 source cap 与 F→J handoff 分离 | A45 |
| H-04 | §10.5 strict progressMeasure/descendant bound | A46 |
| H-05 | §7.4 probe/aggregate deadline 与 startup recovery | A47 |
| H-06/N-02 | §6.5 unified monotonic lease/gate/root deadlines、UTC persisted-instant pairs、gate transitions | A48 |
| H-07 | §5.3 PK/unique/FK/check/retention/archive contract | A49 |
| H-08 | §7.5 per-source provenance 与 channel partition | A50 |
| H-09 | §7.5 all-optional nextAction contract | A51 |
| H-10 | §11.5 invalid repair route与 valid-subset fence | A52 |
| H-11 | §11.5 durable checkpoint/outbox/replay/resync | A53 |
| H-12 | §14.6 legacy PID/session drain与deny tombstone | A54 |
| H-13 | §19.2 loaded-build identity、acceptance_run、fresh delta | A55 |
| H-14 | §7.5 live-channel failure matrix、§19.2 real receipt proof | A56 |
| H-15 | §17.3 event/redaction/metric/grant matrix | A57 |

矩阵验收规则：A29–A57 的每个 scenario 必须引用对应 finding、写入 acceptance_run_id、输出唯一 pass/fail 和 durable evidence pointer；缺 scenario、缺负向断言、缺 identity/fence/hash/process readback 任一项即 overall reject。这样 14 个 BLOCKER 均有 MUST-level 执行合同和负向 acceptance，15 个 HIGH 也不可仅凭 prose 关闭。

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
### 20.2 Amendment inline consistency self-review（规范修正）

| 检查维度 | 可证伪结论 |
|---|---|
| 术语 | `accepted` 仅表示 T1 receipt 已提交；`pending` 表示后续 bundle 未终态；`running` 仅表示当前 fenced attempt；`waiting_resource` 是 durable queue；`waiting_owner` 仅表示 frozen Projection 有真实 eligible 且无 pending/invalid；`needs_user` 仅表示 required repair 或明确可修复环境动作；`partial` 表示有可信部分但 coverage/evidence 不完整；`clean_empty` 只对应无 gap 的 `succeeded/emptyQualified`；`spawn_uncertain`/effect `unknown` 都是不可盲重放的中间态。 |
| 状态可达性 | intent 必须先经过 preflight；root 只能由 admitted intent 创建；F 必须先 frozen snapshot，J 必须由 T5 handoff；Stage D 必须先 frozen target/effect；terminal first-writer 后只能 readback/audit。cancel、supersede、deadline、drain 和 migration failure 均有明确 terminal/maintenance 去向，任何未列状态在 store CHECK 中拒绝。 |
| authority 数量 | 只有一个 `workspace_orchestrator_actors` 当前行拥有 control authority；gate、active-root index、PlanScope、Projection、Manager checkpoint、outbox/inbox 都是受其 epoch/revision 写入的 projection/transport，不能独立 takeover 或推断 lifecycle。所有业务 mutation 必须先读当前 Actor 行。 |
| 循环单调性 | `mailboxSequence`、invocationOrdinal、rootGeneration、stageAttemptOrdinal、successor count、checkpoint/event cursor 只增不减；root/stage/scope/projection/dispatch/consumption terminal 不回退；successor 只有 progressMeasure 严格改善才增加，source cap 只封闭采集不阻断一次 F→J；无进展、超时或 budget exhaust 都停止，不产生 churn。 |
| 事务边界 | T1–T8 明确 row lock、CAS、写集合、crash 结果和 outbox/inbox；F→J 与 cancel 使用同锁序；effect sink 的未知结果先 query；terminal result/event/checkpoint 只 first-writer。广播丢失不会改变 durable truth，重复/乱序只触发 replay/resync。 |
| 占位与范围 | 全文没有未完成占位、待实现语句、隐式“实现时决定”或空 nextAction；每个可见失败都有 reason、deadline、owner/system action、finishedAt 和 readback。migration/cutover/rollback、真实渠道、build identity、acceptance_run 和安全权限均有独立合同，不新增 legacy/date-only/第二 authority 路径。 |
| 追踪闭合 | B-01..B-14 与 H-01..H-15 共 29 行，并在相关行显式覆盖 N-01/N-02/N-03 amendment contradictions；每行均映射到具体修正与 A29–A57，所有 BLOCKER 均同时有 MUST-level 合同和 negative acceptance，缺任一 durable evidence 时 overall reject。 |


**结论**：WeMediaBuddy 的唯一生产编排路径是“producer intent → durable per-workspace Actor → required/optional preflight → fenced root/stage → immutable snapshot → bounded automatic progression → exact Projection → Manager/Today presentation and candidate approval”。该路径在预算、身份、恢复、权限、透明度和 clean cutover 上闭合；实现必须以本文为单一设计合同，不得恢复已明确删除的旧路径。
