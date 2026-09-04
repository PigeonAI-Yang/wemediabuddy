# WeMediaBuddy Workspace Orchestrator 反红队合并审计（2026-08-29）

- **审计基线**：approved commit `665f5ee`。该 commit 仍是本次审计基线，**未被修改**。
- **审计对象**：`docs/spark/2026-08-29-workspace-orchestrator-design.md` 及四份独立红队审查输出。
- **本次变更**：仅新增本审计报告；未修改批准的 spec、产品代码、测试、DB、runtime、`TASKS.md` 或其他文档。
- **结论**：**REJECT / NOT IMPLEMENTATION-READY**。在下列 BLOCKER 逐项补入 spec、补入可证伪的负向验收并完成一次后续对抗复审前，不得开始实现、切换或回滚操作。

## 1. 审计范围与方法

### 1.1 输入证据

本报告完整读取以下四个 agent 输出，并以其原始 finding 顺序建立 `C#`、`I#`、`O#`、`M#` 追踪号：

- `C#` = `agent://AuditConvergence`，8 条：并发收敛、资源公平、Actor/gate、spawn、F→J、source cap、successor、preflight liveness。
- `I#` = `agent://AuditIdentity`，7 条：identity/hash、spawn、effect sink、原子提交、epoch fence、lease deadline、schema/retention。
- `O#` = `agent://AuditOwner`，8 条：preflight credentials/policy、source provenance、Owner action、candidate repair、root visibility、notification、legacy worker。
- `M#` = `agent://AuditMigration`，8 条：migration journal、clean cutover、startup producer、rollback、installed identity、fresh causal acceptance、live channel、security/observability。

同时按需核读 approved spec 的相关段落与精确行号，重点覆盖 §3–§20.1；代码证据仅作为审查输出引用的现实风险旁证，不在本任务中修改。

### 1.2 证据规则

每条合并 finding 必须同时给出：

1. approved spec 的 exact section/line；
2. 可重现的 adversarial scenario；
3. 当前合同为何不能排除该结果；
4. 必须写入 spec 的修正合同；
5. 一个能失败的、单一且可证伪的 acceptance addition。

同一 crash window 或同一语义缺口只合并一次，但不同线性化边界不合并为一句泛化风险：

- spawn crash：`C#4 + I#2 → B-02`；
- epoch/fence：归为同一风险家族，但 Actor/gate authority、跨行旧 epoch、F→J cancel race、preflight credential drift 仍保留为 `B-05`–`B-08` 四个不同 failure mode；
- cutover：migration write isolation、跨版本拒绝、startup producer census、rollback 分别保留为 `B-11`–`B-14`，运行中的 legacy worker 另保留为 `H-12`；
- acceptance authenticity：installed-build identity 与 fresh-causal run 合并为 `H-13`，live channel 与 security/observability 仍是不同的证据合同。

## 2. Verdict

**REJECT / NOT IMPLEMENTATION-READY**。

四份审查共提出 31 条 source findings：15 条 BLOCKER、16 条 HIGH、0 条 MEDIUM。去重后仍有 29 条独立合并 finding：14 条 BLOCKER、15 条 HIGH。核心阻断不是“实现细节尚待决定”，而是当前 spec 对以下不可逆或跨边界事实没有可执行判定：

- 一个显式 invocation 与 replay/new root 的身份是否不同；
- 外部进程和外部 effect 在 DB crash window 中是否至多执行一次；
- epoch、lease、root、claim、gate、projection、terminal result 是否由同一当前 authority 共同 fencing；
- preflight 后的凭据/策略漂移是否会阻断旧快照；
- migration、clean cutover、rollback 时是否真正阻断所有旧 writer；
- 真实安装包、真实渠道、真实业务输出是否构成 acceptance 的唯一证据。

在 blocker 仅被口头解释、以测试声明代替机器合同、或只补正向场景的情况下，以上 verdict 不改变。

## 3. Quantitative summary

### 3.1 按 reviewer slice 的 source findings

| Reviewer slice | Source findings | BLOCKER | HIGH | MEDIUM | 主要范围 |
|---|---:|---:|---:|---:|---|
| `AuditConvergence` (`C#`) | 8 | 3 | 5 | 0 | mailbox/公平、Actor/gate、spawn、F→J、source cap、successor、preflight deadline |
| `AuditIdentity` (`I#`) | 7 | 5 | 2 | 0 | identity、spawn、effect exactly-once、原子提交、epoch、lease、schema/retention |
| `AuditOwner` (`O#`) | 8 | 3 | 5 | 0 | preflight policy/credential、provenance、Owner action、candidate、root visibility、notification、legacy |
| `AuditMigration` (`M#`) | 8 | 4 | 4 | 0 | migration/cutover/startup/rollback、installed identity、fresh run、live channel、security |
| **合计（source）** | **31** | **15** | **16** | **0** | — |

### 3.2 去重后的合并结果

| 结果集 | BLOCKER | HIGH | MEDIUM | 合并说明 |
|---|---:|---:|---:|---|
| 合并 findings | 14 | 15 | 0 | `C#4 + I#2` 合并为 `B-02`；`M#5 + M#6` 合并为 `H-13`；其余保持 distinct failure mode |
| 需要先修正的总条目 | **14** | **15** | **0** | 任一 BLOCKER 未补齐并复审，整体仍 REJECT |

## 4. Executive blocker list

以下 14 条是去重后的 blocker；括号内为全部可追踪 source finding。没有任何 source blocker 被删除：

1. **B-01 Identity registry 与 invocation uniqueness**（`I#1`）：不能证明 replay 与新显式 invocation 不相同，且 derive* preimage 未闭合。
2. **B-02 Durable spawn/adopt exactly-once**（`C#4`、`I#2`）：`task_bound → OS spawn → spawn_started` crash window 会重复进程或泄漏孤儿进程。
3. **B-03 External effect sink exactly-once**（`I#3`）：去重 consumption 行不能去重已发生的外部副作用。
4. **B-04 跨表原子提交与 durable outbox/inbox**（`I#4`）：receipt、scope、projection、root、checkpoint、event 可在崩溃后互相矛盾。
5. **B-05 Actor 与 reconcile gate 的唯一 authority/有界 takeover**（`C#3`）：heartbeat-only wedged owner 可无限阻塞新 runtime。
6. **B-06 跨行 epoch fence 与 terminal immutability**（`I#5`）：旧 epoch/旧 token 的 late result 可能只凭复制字段写成功，终态也未明确不可变。
7. **B-07 F→J handoff 与 cancel/supersede 的线性化**（`C#5`）：cancel 与 handoff 交错可在已取消 root 后创建 J。
8. **B-08 Preflight credential/config fence**（`O#1`）：preflight 后 auth/config drift 仍可能让旧 snapshot 进入 Reporter/Judge/waiting_owner。
9. **B-09 Required channel 不可被 intent 降级**（`O#2`）：未授权 producer 可把 required coverage 伪装为 optional gap。
10. **B-10 并发 root 可见性与 approval fence**（`O#6`）：scheduler root 可隐藏未点击的 waiting_owner，旧页面批准可能作用到错误 root。
11. **B-11 Migration 全局写隔离、journal 与 crash replay**（`M#1`）：迁移半提交时旧/新 writer 可制造跨表半套链。
12. **B-12 持久跨版本 cutover fence**（`M#2`）：旧 renderer/MCP/scheduler/binary 没有被 DB/store 层统一拒绝，双写可污染 canary。
13. **B-13 Startup producer census 与封闭**（`M#3`）：未列名的 scheduler、maintenance、timer、handoff sweeper 仍可能创建业务写入。
14. **B-14 Rollback barrier、drain 与版本兼容**（`M#4`）：rollback 可能留下旧进程/旧 token，或错误恢复 direct/legacy/date-only 路径。

## 5. Detailed findings table

> 表中 `C#`、`I#`、`O#`、`M#` 与 §1.1 的完整 agent 输出一一对应。每一行只给一个 acceptance addition；该 addition 可以是一个包含明确子步骤的 adversarial matrix，但必须有单一可判定结果。

| ID | Severity / reviewer trace | Exact spec evidence | Adversarial scenario + gap | Mandatory spec amendment | One falsifiable acceptance addition |
|---|---|---|---|---|---|
| **B-01** | **BLOCKER**<br>`I#1`「显式 invocation 唯一身份与完整 hash registry」 | §5.1 L135–157；`orchestrator_intents` §5.2 L179–199；roots L217–241；§7.3 L503–515；§18.2 L901–905 | 两个合法 full/scan invocation 的 workspace/date/mode/source/action/logicalInput/acceptance 相同，且初始 ordinal/predecessor 相同；root preimage 无 `intent_id`/外部 request，初次 ordinal 也未规定，可能撞同一 `rootRequestId` 或被误判 replay。`canonicalJson` 与 `canonicalBusinessJson` 混用，deriveScan/Judge/StageD、effect、child preimage 不完整。 | 发布 versioned identity/hash registry：固定 canonical bytes、UTF-8、NFC、数值、null/missing、未知字段、集合排序/重复规则；为每个 derive* 写完整 preimage。分离 command replay key、logicalInputHash、root invocation identity、stage/operation/effect/child identity；初次显式 invocation 必须使用唯一 request 或由 RootStore 原子分配并持久化 ordinal。 | **Identity-vector**：同 request replay 必须返回同 receipt；相同业务 payload 但不同显式 request 必须得不同 root；retry/repair 得新 generation；Unicode/1 vs 1.0/-0/map order/duplicate ID/unknown/null fixture 由独立 encoder 产生逐字节相同 bytes/hash。 |
| **B-02** | **BLOCKER**<br>`C#4 + I#2`「external spawn exactly-once / durable launch-adopt」 | managed dispatch §5.2 L312–328；reserve-before-spawn §10.2 L647–661；startup reconcile §12.2 L722–734；A22 L938 | DB 已写 `reserved/task_bound`，OS spawn 成功，但进程在 `spawn_started/running` 或 child register 前崩溃。按同 identity replay 会启动第二个 Reporter；按 orphan 则第一个进程仍可写 stdout/session/业务结果。现有 `child_identity_key` 只约束 DB 行，不识别外部进程。 | 在 spawn 前持久化不可复用 `launchAttemptId`/launch token，并传入 child；定义 process/session handle、PID/start time/argv hash、注册/heartbeat、进程发现、adopt-or-kill、不确定 spawn state、幂等 stop/drain/cwd 清理。重试前必须证明旧进程已 adopt 或终结。 | 在 `reserved/task_bound` 后、OS spawn 返回后、`spawn_started` 前、child register 前、stdout drain 前分别 crash；重启后 process inventory 与 dispatch readback 必须证明每个 identity 至多一个运行进程、一个结果、无孤儿 lease/写入，且不确定结果不重复 spawn。 |
| **B-03** | **BLOCKER**<br>`I#3`「external effect sink 幂等」 | consumptions §5.2 L330–345；Stage D effect §8.4 L563–565；cancel/late worker §12.1 L709–720；§18.2 L901–909；A20 L936 | Writer/Research/Review 的外部动作已成功，但进程死在 `consuming → consumed` 前；lease 过期后重放同一 consumption，DB 唯一键只能阻止第二行，不能阻止重复发布、写文件、请求或资源创建。cancel 后同样不知道副作用是否已发生。 | 定义稳定 `effectRequestId + payload hash`；每个 effect sink 必须原子记录/去重 token、绑定结果 hash、支持 unknown-result query。若 sink 不支持幂等，明确 at-most/at-least-once 与补偿，禁止宣称 exactly-once；增加 outbox/inbox、unknown-outcome、cancel 后不可盲目重放。 | 在 sink 已提交而 consumption 未 consumed 时 kill，随后 restart、lease expiry、duplicate event、cancel 后 replay；外部可观察 effect 必须恰好一次且 hash 稳定；相同 token+不同 payload 必须拒绝，failed/partial/cancelled 不得复用为成功。 |
| **B-04** | **BLOCKER**<br>`I#4`「receipt/scope/root/event 原子提交」 | 其他耐久对象 §5.2 L347–353；scope/projection §8.3 L548–561；自动推进 §9.1 L569–591；Today readback §11.3 L701–703；events §17.1 L866–885 | scope 已 frozen、projection 已算出，但 root settlement/checkpoint/event 前崩溃；或 root 已 succeeded 而 projection/scope 未提交。receipt 先写、intent 未写会返回 accepted 却没有任务；intent 先写、receipt 丢失又可能重复入口；in-memory broadcast 丢失。 | 发布 transaction bundle matrix、隔离级别与 CAS/锁顺序：至少 intent+receipt+event/outbox、source/receipt bind+snapshot、scope+projection+root terminal+Manager checkpoint、handoff+claim+event。引入同事务 outbox 与 consumer inbox 去重；projection 以单一 version/scopeHash 绑定，broadcast 只能作通知；规定 accepted/pending/terminal response 恢复。 | 对每个 bundle 的每个写入边界 crash/replay；最终 root/scope/projection/checkpoint/hash 必须相容，单逻辑 request 只有一个 receipt/terminal event，Manager/Today readback 与 projection hash 相同，outbox 重送不产生第二次 transition；snapshot 读写竞态只能得到绑定失败或确定旧版本。 |
| **B-05** | **BLOCKER**<br>`C#3`「Actor/gate authority 与 stalled takeover」 | Actor职责 §4.2 L104–120；actor row §5.2 L163–177；gate/其他对象 L347–353；硬停止 §9.3 L609–628；startup gate §12.2 L722–734 | Runtime R1 持 Actor/gate，但控制循环 wedged，heartbeat 仍续租；R2 在 lease-valid 与 lease-expired 两窗口启动。Actor 与 `daily_reconcile_gates` 是两套可能不一致的 authority，stall 检查又只围绕 Actor transaction，R2 可无限等待或错误完成 gate。 | 选择一个 sole authority，或定义原子 two-row lease：同一 token/epoch 必须同时保护 gate、Actor、root、claim。续租必须绑定业务进展/期限；增加独立 watchdog，可在 mailbox wedged 时 fence、settle 或 orphan；gate completion 与同一 authority 对齐。 | 运行 heartbeat-only R1、阻塞其 control loop，重复启动 R2；必须在有界时间内唯一选出 owner，Actor/gate epoch 相等，旧 epoch 无业务写、无重复 child，gate 可完成或明确 maintenance。 |
| **B-06** | **BLOCKER**<br>`I#5`「跨行 epoch fence 与 terminal immutable」 | actor epoch §5.2 L163–177；dispatch L312–328；consumption L330–345；§9.3 L609–628；§12.2 L722–734；§18.2 L901–905；A26 L942 | Actor A 的 claim revision/epoch/token 被复制到 child 行后暂停；B 接管到 epoch 2。若 mutation 只比较 child 的复制字段，A 的 late result 可能成功。root/claim 已 terminal 后可变 result_json 仍缺“terminal first writer only”；cancel cascade crash 也可留下 active child。 | 规定每个 business mutation 在同一 DB transaction 读取当前 Actor epoch/lease、父 claim revision/epoch/token 与目标 state，并列出精确 `WHERE state=… AND revision=…`。takeover 先原子推进 epoch/ownerEpoch 并撤销旧 envelope；terminal result/settlement/event append-only first-writer；cancel cascade 可恢复且同 fence。 | 两连接交错 takeover、worker result、watchdog settle、cancel、projection commit；每种顺序只允许一个 terminal winner，旧/late mutation 零业务写并有 rejection audit，terminal hash/result/finishedAt 不可变，cancel 恢复后 child 只能 terminal/orphaned。 |
| **B-07** | **BLOCKER**<br>`C#5`「F→J handoff 与 cancel/supersede」 | F/J 状态与 handoff §6.3 L408–448；推进 §9.1 L576–581；cancel §12.1 L709–718；Full恢复 §12.3 L736–738；stop predicate §9.3 L611–625 | Handoff H 读取 frozen F，commit 前 cancel C 把 root/stage CAS 为 cancelled 并开始 cascade；H 仅凭 F claim fence 继续创建 J。反向顺序又可能把 F 标为 consumed 后 root 被 cancel。 | handoff 必须是 serializable transaction/equivalent lock：一次 CAS 同时覆盖 root status/checkpoint、F revision、J creation；cancel 采用相同锁序并反复 rescan，late handoff 返回稳定 conflict、零 business rows。 | 暂停 H 于 commit 前，与 C 以两种顺序并含 restart 竞跑；若 C 线性化在先，不得有 J 且 F/J cancelled/orphaned；若 H 在先，C 必须观察并取消 J；不得有 post-cancel child 或矛盾 F/root 状态。 |
| **B-08** | **BLOCKER**<br>`O#1`「preflight credentials/config fence」 | preflight §7.1 L478–487；required/optional §7.2 L489–501；SourceSnapshot §8.1 L521–540；推进 §9.1 L572–590；retry identity §7.3 L503–515 | T0 preflight 通过 auth/config revision r；T1 Owner revoke login 或修改 profile；Reporter 排队/运行或 F→J 前仍使用旧 snapshot。并行 channel check 还可能读到不同 profile revision。当前只保存 revision/hash，不要求 admission、side effect、handoff 都 CAS。 | 在 snapshot 中加入 `preflightId`、policyHash、config/auth revision、短 TTL capability lease；root admission、每个 channel side effect、reserve/spawn、predecessor consumption 都比较该 fence。required drift 或 receipt 缺失必须 fail closed 为 needs_user/partial，禁止 Judge、waiting_owner、clean-empty。 | 在 Reporter queued、Reporter execution、F→J 前各 revoke 一次 required auth，并混用两版 profile；旧 snapshot 必须被拒绝，不得产生 Judge/waiting_owner/clean-empty，只有新 preflight/new root 可继续。 |
| **B-09** | **BLOCKER**<br>`O#2`「required channel policy 不可降级」 | 决策 §3 L47–60；preflight policy §7.1 L478–487；allowlist §14.1 L782–793；self-review §20.1 L961–964 | workspace profile 将 X 标为 required；buggy/unauthorized MCP/UI 提交 optional 或省略 X，Actor 便以 Y 的结果继续并把 X 作为 optional gap。当前“profile + explicit selection”没有 monotonicity/授权边界。 | requiredness 必须由 Actor 从 authorized workspace profile 归一化；intent 只能缩小 optional 集，不能 downgrade/omit/invent required channel。非单调 policy 返回 `CHANNEL_POLICY_INVALID`，root/worker 零写，并持久 normalized policy/policyHash。 | 提交 downgrade、omit、duplicate、unknown channel 及 unauthorized producer policy；每次 root 前稳定拒绝、无 claim/Reporter/Judge/clean-empty/waiting_owner，并 readback normalized policy 或 rejection reason。 |
| **B-10** | **BLOCKER**<br>`O#6`「并发 root 可见性与 approval fence」 | Manager定位 §4.3 L121–131；root identity/supersede §5.2 L217–241；Today/Owner §11.1–11.3 L672–703；公平 §10.3 L663–668；A18 L934 | R1 到 waiting_owner，Owner 未点击；09:00 scheduler 建 R2。Today 只描述 Actor current intent/root，没有 active-root index、排序或 supersession；R1 卡片可能被 R2 隐藏，旧页面 approval 可能作用到错误 root，或两 root 生成同 plan item。 | 定义 per-root Today projection index，或明确 background root 不得 supersede 未完成 waiting_owner。approval 必须携带 rootRequestId、stageRequestId、scopeHash、projectionHash、expected checkpoint revision、eligible ID set；stale/superseded 返回 stable conflict/zero write。UI 必须展示每个 active/waiting root、origin、next action 与控制归属。 | 运行 R1 waiting_owner→R2 scheduler overlap、相同 candidate、延迟 R1 approval、R1 cancel 与 R2 start；两个 root 都可读，每个 approval 只改指定 root，stale approval visible zero-write conflict，scheduler 不得静默替换 Owner 卡片。 |
| **B-11** | **BLOCKER**<br>`M#1`「migration global write isolation/journal」 | 历史迁移 §14.3 L808–812；阶段0–1 §15.1–15.2 L818–829；gate 前置 §12.2 L722–734 | 阶段1 扫描旧 task/scope/receipt 时旧 scheduler/startup producer 或新 Actor 仍写新行；migration 在 orphan 标记与 actor/root mapping 间崩溃后重放，读取到跨表半套链。现 spec 无 migration epoch/lock/journal/checkpoint 或未完成期间 zero-write 判据。 | 增加 `migration_epoch/status/manifest_hash` 与 append-only migration journal；迁移前持久 deployment fence 阻断旧/新业务写并验证进程已停；表族及 provenance 闭包用事务或可重放 checkpoint 提交；未完成迁移时 query/new root/direct store writer fail closed；将四阶段绑定既有 WMB-4801–4809 前置条件并以 FK/provenance/hash/count 校验开 gate。 | **Migration-Crash/Replay**：每个 migration commit boundary 注入 crash/restart/replay；winner、引用闭合、baseline hash/count 必须稳定。并发旧 scheduler、新 Actor、migration writer 只能得到 `MIGRATION_IN_PROGRESS`/零业务写；unknown/date-only/conflicting rows 只能 orphan。 |
| **B-12** | **BLOCKER**<br>`M#2`「persistent cross-version clean cutover fence」 | 旧路径 §14.2 L795–806；clean cutover §15.4 L836–845；rollout §16.1 L849–854；§18.2 L901–909 | 新 Main/Actor 已运行，但旧 renderer、MCP client、scheduler/binary 仍在；没有跨进程 generation/store fence，legacy task/job 与 Actor projection 双写。A25 静态枚举没有冻结完整 inventory，也未覆盖旧 app.asar/动态注册。 | data-root 持久化 `cutover_epoch/min_supported_build/schema_epoch`；IPC/MCP/scheduler/worker/store 统一校验，旧版本统一 `CUTOVER_REQUIRED` 或 `EXECUTION_AUTHORIZATION_INVALID` 且零业务写。阶段0 冻结 timer/start/spawn/IPC/MCP/store inventory、替代 intent、owner、拒绝证据；drain 后才能删旧分支。 | **Mixed-Version Cutover**：同时运行旧 renderer/MCP/scheduler 与新包，触发每个旧入口/timer；legacy/source/claim/plan 无业务 delta，只有拒绝/audit；新 Actor intent 可完成。分别核对源码、app.asar、运行路由、DB dispatch 四层 inventory。 |
| **B-13** | **BLOCKER**<br>`M#3`「startup producer census/closure」 | 无隐式 producer §3 L47–60；startup gate §12.2 L722–734；allowlist §14.1 L782–793；旧路径 §14.2 L795–806；现实旁证 `src/main/index.ts:416–419,485–603` | canary 取消/终结 root 后跨过首延迟，独立 `DailyScanScheduler`、archive/backfill/maintenance、handoff sweeper 仍创建 `daily_scan`/source/claim，且可被错误归因给 Actor root。allowlist 只有抽象类别，不能证明 constructor/timer/spawn 全覆盖。 | 阶段0 生成并冻结 startup producer registry：覆盖所有 callback、timer、sweeper、archive/backfill/lint/maintenance、side-effect table；未列出的 side effect 在 startup/canary/rollback 一律拒绝。启动只能纯读/reconcile；保留 maintenance 必须独立 scope/store fence，不能进入 Today Projection；首次业务 tick 必须经 Actor intent。 | **Startup-Census**：真实安装包启动后取消 root，跨过所有已知首延迟及一个完整 scheduler 周期，读取全量 intent/event/task/job/source/claim；除 allowlist intent 外零业务写，并逐 producer 触发一次得到 Actor intent 或明确拒绝 receipt。 |
| **B-14** | **BLOCKER**<br>`M#4`「rollback barrier/drain/compatibility」 | rollback §16.2 L856–864；reserve/spawn §10.2 L647–661；startup recovery §12.2 L722–734；A01–A28 无 rollback 场景 | rollback 停止新 Actor intent，但旧 Electron timer、已 spawn worker/MCP/browser 仍持 token；旧 binary 不认识新 epoch，继续写 legacy 或调用外部渠道。没有 PID/child/browser/MCP drain readback、schema compatibility 或失败即 maintenance 机器判据。 | rollback 前持久 `rollback_epoch/status`，全局禁止业务写并撤销 lease；枚举/停止 PID、child、port、browser、MCP，等待 dispatch/consumption/output drain；回退 binary 必须声明并校验 schema/cutover epoch，否则 maintenance；旧 token 仍 audit-only；记录 manifest/receipt/readback。 | **Rollback-Active**：F/J、research、consumption、独立 scheduler 同时 active 时 rollback；必须读回进程/端口/lease/dispatch 清空，旧 token/binary 全部 audit-only/零业务写；drain/compat 失败只能 maintenance，不能恢复 direct/legacy/date-only。 |
| **H-01** | **HIGH**<br>`C#1`「durable mailbox order/coalescing/backlog」 | 决策/Actor §3 L47–60、§4.2 L104–120；intent unique §5.2 L179–199；公平 §10.3 L663–668；预算 §10.1 L634–645 | MCP、scheduler、rolling scan、orphan reconcile 以 fresh request IDs 并发提交等价 work，重启发生在 dequeue，Owner repair/cancel 夹在 scheduler flood 中。只有 actor-level mailbox_sequence；intent 没有 durable order/priority/age/coalescing，未 admitted intent 也无 terminal outcome。 | durable mailbox envelope/intent fields：atomic sequence、priority、enqueue time、claim、causation、age、queue state、backlog limit。定义 logical-intent coalescing 与 intentional Owner/scheduler roots、source quota/backpressure、stale expiry、conflict/rejection receipt。 | 跨所有合法 producer race 至少 100 个 fresh-ID duplicate，dequeue 中 restart；必须只有一个 canonical root、稳定 replay/conflict receipt。再 flood scheduler 并注入 Owner repair/cancel，证明 FIFO/priority、bounded Owner service、stale terminal、无未 admitted nonterminal item。 |
| **H-02** | **HIGH**<br>`C#2`「single Judge queue fairness」 | Judge=1/预算 §10.1 L636–645；公平 §10.3 L663–668；A14 L930 | background root 占住唯一 Judge 超过 90s；Owner root 到达并排到 handoff，却没有针对已 admitted Judge claim 的 priority/aging/reservation/preemption，可能仅因 background job 得 `RESOURCE_WAIT_TIMEOUT`。 | 为已 admitted Judge claims 规定 interactive reservation/preemption 或 weighted fair queue with aging、Owner bounded wait，并精确定义抢占/取消/释放的 root/attempt 计数。 | 固定 Judge=1，让 background 超过 90s，再提交 Owner repair/approval 与 MCP；验证声明的 queue policy、无第二 Judge、Owner 不因 background 单独 timeout、winner/preemption/release durable，restart 后结果相同。 |
| **H-03** | **HIGH**<br>`C#6`「source cap 与 terminal predicate 分离」 | 自动推进 §9.1 L576–591；硬停止 §9.3 L609–628；source budget §10.1 L634–645；A15 L931 | Reporter 正好返回 80 个可信 source；`source_count >= 80` 被全局硬停止，可能在 F→J 前把正常 root 终止为 partial/failed。A15 只验证截断而未验证 Judge handoff。 | 将 `source_budget_exhausted` 限定为禁止继续采集；允许可信 frozen 80-source snapshot 完成一次 F→J handoff 并 settle；Judge resource failure 单独产生 resource outcome。 | 提供 80 个 trusted non-drifting sources 且 Judge 有容量；必须读回 F `HANDOFF_CONSUMED`、一个 J claim/dispatch、无第81 source。Judge unavailable 时必须是明确 resource outcome。 |
| **H-04** | **HIGH**<br>`C#7`「successor strict progress」 | evidence successor §9.2 L596–607；hard stop §9.3 L609–628；预算 §10.1 L639–645；A12 L928 | 首个 Judge 留下同一 pending/invalid gap；successor 虽有成功 receipt 但 projection/gap 未变，且 child/result 更新时间被误作 business progress，可能再开第二 successor；descendant fan-out 也未受 successor count 约束。 | 持久化 versioned `progressMeasure/gapHash` 前后值；successor 必须 strict improvement，不得以 quota 未用替代进展；限制 descendant evidence work，并在 settlement 保存 before/after。 | 运行 no-op successor：receipt 成功但 gap/projection hash 不变；必须不创建第二 successor、不更新 qualifying progress timestamp、终态 partial 且含 before/after。再运行真正改善 gap 的 successor，证明 measure 严格增加。 |
| **H-05** | **HIGH**<br>`C#8`「preflight deadline/recovery」 | Intent状态 §6.1 L357–386；preflight §7.1 L478–487；root wall clock §10.1 L641–645；startup gate §12.2 L722–734；A01–A03 L917–919 | intent 卡在 `preflight_running`；probe hang，或 crash 在 preflight write 后、freeze 前。root wall clock 尚未开始，startup 又不枚举 preflight，same-request replay 只读，stale row 可永久阻塞。 | 定义每 channel/aggregate monotonic preflight deadline、probe lease、cancel/reconcile transition、finished_at/reason/retry；startup 必须 settle 每个 nonterminal intent/preflight，且 hung probe 不得阻塞 unrelated mailbox work。 | hang 一个 probe 并在每个 preflight write boundary crash；restart 后 intent 必须 resume once 或 terminalize，replay 返回 terminal receipt，无 root/worker 提前创建，unrelated Owner/MCP 被服务，deadline 后无 `preflight_running`。 |
| **H-06** | **HIGH**<br>`I#6`「lease/gate hard upper bound」 | 预算 §10.1 L634–645；startup gate §12.2 L722–734；错误 §13 L762–765；rollback §16.2 L856–864 | 旧 runtime 的 lease expiry 晚于 root deadline；新 runtime 按“未过期等待原 owner”可能永远等已消失进程。普通 wall-clock 字段与机器时钟偏移也会让 takeover 不一致，gate 无 bounded maintenance outcome。 | 规定 DB/server monotonic time、TTL/max renewal、root/stage/gate unified deadline；恢复等待取最小 deadline，超时后 actor CAS 强制 fence/takeover/terminalize；定义多 runtime startup 竞争与 gate maintenance readback。 | 构造 expiry 晚于 root deadline、owner 永不恢复、两个 runtime 同启、机器时钟偏移；gate 必须 bounded 唯一选 epoch，旧 claim 被 takeover/terminalize，root 不遗留 running/resume_pending。 |
| **H-07** | **HIGH**<br>`I#7`「schema uniqueness/parent/retention」 | stage claims §5.2 L243–261；scope L280–295；dispatch L312–328；consumption L330–345；其他对象 L347–353；保留 §12.1 L709–720；迁移 §14.3 L808–812；evidence §19.1 L946–953 | terminal replay 后可插入同 stage_request_id 的 inactive claim；关键表缺完整 PK/unique/FK/check/nullability，child parent 可断裂。source/snapshot/receipt/event 要保留却无 retention/archive/tombstone，GC 会破坏 evidence chain，无界 append-only 又不可运行。 | 逐表规定 PK、logical unique、partial predicate、FK、非空/check、delete/cascade 禁止项、replay sequence；建立 archive/version/tombstone retention、rehydrate/backup/合法删除、orphan lifecycle，且 audit 链不因业务 GC 断裂。 | 并发/replay 插入同 stage/preflight/receipt/event 必须返回 canonical row 或 DB reject；尝试删除/归档 parent 后 active query/reconcile 仍确定，orphan 不可派工；archive/restore fixture 仍能验证 identity/hash/event chain 或明确 `archived`。 |
| **H-08** | **HIGH**<br>`O#3`「source provenance 绑定」 | SourceSnapshot §5.2 L263–278、§8.1 L521–540；candidate admission §8.3 L548–561；projection §11.3 L701–703 | optional X 先写 source 后 runtime failure；或全局旧 X source 被拿进本 root。现有 binding 只有 sourceId/revision/contentHash，不要求 channel/attempt/receipt/preflight/root 关系，failed coverage gap 与 trusted source 可同时出现。 | binding 必须含 channelId、scanAttemptId、receiptId/revision/payloadHash、preflightId、policyHash；验证 source 属于本 root/attempt 的 successful receipt。selected/successful/failed channel 必须是完整 disjoint partition；untrusted source 禁止进入 Judge/Projection。 | optional write-then-fail、旧 source、cross-root receipt、缺 channel mapping 四种 fixture 均必须得到 `SOURCE_PROVENANCE_MISMATCH`（或等价 stable reason），不进入 trusted snapshot/Judge/Projection，UI gap 与 source IDs 一致。 |
| **H-09** | **HIGH**<br>`O#4`「all-optional failure action」 | required/optional表 §7.2 L489–501；Owner边界 §11.1 L672–684；错误矩阵 §13 L744–778；旧路径 §14.2 L797–806 | intent 只选 optional channel 且全部 preflight fail；结果允许 partial/needs_user，但 Owner 表只定义 required repair，普通 retry/new root 又要求显式 intent，页面可能 terminal-looking 且无 action。 | 定义 `configure_optional_channels` 或 `start_new_intent` 的权限、输入、identity、idempotency、是否新 preflight；或者明确 terminal failed + explicit CTA。任何 needs_user/partial card 不得有空 `nextAction`。 | all-optional fail、repairable optional login fail、empty selected set：无 root/worker/clean-empty；Today 必须展示 gap 与 concrete action；无 action 就无 retry；选择 start_new_intent 只创建一个新 intent/root，旧 intent terminal 可审计。 |
| **H-10** | **HIGH**<br>`O#5`「valid candidate 与 invalid repair」 | projection priority §6.4 L458–472；scope admission §8.3 L548–561；推进/successor §9.1–9.2 L582–607；Owner §11.1 L672–684；A11 L927 | Projection 有一个 eligible 与一个 invalid，或 eligible+pending；优先级令 root partial 且停止，但 Owner 没有 invalid repair，也没有 valid-subset approval，导致真实候选永久不可操作。 | 明确两者之一：允许 eligible subset `waiting_owner`，同时阻断 I/P；或定义 `repair_invalid_candidate`。两者都需 nextAction、scope/projection fence、successor exhaustion 语义；stale approval 必须 zero-write。 | 对 E+I、E+P、E+P+I 三组合：若允许 subset，E 必须可批准且 I/P 不可批准；否则显示 invalid repair。预算耗尽后任何 eligible item 都不能无 route；批准 stale/blocked ID 必须 fenced conflict。 |
| **H-11** | **HIGH**<br>`O#7`「projection/terminal notification replay」 | Today透明度 §11.2 L686–699；cancel §12.1 L709–720；events §17.1 L866–885；现实 bus 旁证 `src/main/data-changed.ts:40–63` | Actor commit projection/waiting_owner/terminal 后、broadcast 前 crash；或无 subscriber 时 commit。in-memory publisher 不能 replay，Today 留在旧 running/empty，旧 approval 仍可点击。 | 增加 durable notification/outbox 或 projection/checkpoint cursor；attach/refresh/reconnect 先读最新 monotonic checkpoint，再消费事件；duplicate/missing/out-of-order 触发 resync，stale control visible disabled/conflict。 | 在每个关键 projection/terminal commit 后、notification 前 crash，并用无 subscriber、duplicate、out-of-order event 及旧 approval page 重复；reconnect 必须收敛到 committed state/CTA，任何 stale action 都不得 business write。 |
| **H-12** | **HIGH**<br>`O#8`「migration 中 legacy worker fence」 | 迁移 §14.3 L808–812；阶段0 §15.1 L818–822；cutover §15.4 L836–845；旧路径 §14.2 L797–806；现实旁证 `src/main/index.ts:502–523` | date-only legacy worker 被标 orphan，但旧 scheduler/process 仍活着；gate complete 后其 late source/receipt 到达。仅保留 row/orphan 与 normal reconcile 不足以阻止写入 active source/snapshot，静态 A25 仍可通过。 | cutover/migration 必须有 PID/session/lease drain readback；为 orphan task/receipt 持久 deny/tombstone；legacy identity 或缺 current actor epoch/lease 的 store write fail closed/audit-only；source admission 必须证明 current-root provenance，并把 migration fence 纳入 actor epoch。 | 迁移 live date-only worker，故意在 gate complete、restart 后投递 result 并重复 migration；source/receipt/snapshot/projection 零业务 delta，stable authorization rejection/audit，active state 不变，readback 证明 legacy PID/session 已停。 |
| **H-13** | **HIGH**<br>`M#5 + M#6`「installed-build identity + fresh causal acceptance」 | 非目标 §2.2 L24–45；阶段4 §15.5 L843–845；Acceptance §19 L911–944；唯一强证据 §19.1 L946–953；现实旁证为既有 packaged-vs-dev/stale app.asar 与 seeded UI 记录 | 验收读取磁盘新 app.asar hash，却复用旧进程/旧 renderer；或把历史 rows/seeded source/孤立 receipt/截图当作本轮成功。Projection 与 UI 看似一致，但没有证明当前 PID 实际加载 artifact、输入新鲜且 child 有 output delta。 | 构建不可变 build manifest（source commit、package/exe/app.asar hash、schema epoch）；运行时回报并交叉核验 buildId/sourceCommit/packageHash/resourcesPath/PID/startTime/dataRoot/runtimeEpoch。每轮持久 acceptance_run_id、baseline manifest、created-after/immutable input 约束；success/waiting_owner/clean-empty 必须有 required child terminal readback 与业务 output delta。 | **Installed-Build-Identity + Fresh-Causal-Run**：故意保留同版本旧 app.asar/旧进程、seeded row、旧 receipt、screenshot-only、partial child、孤立 output；只有当前安装路径/PID/loaded artifact/manifest/data-root/epoch 与本轮完整 causation/readback 全匹配才允许 A28。 |
| **H-14** | **HIGH**<br>`M#7`「live channel runtime failure matrix」 | preflight §7.1–7.3 L478–515；projection/clean-empty §6.4 L458–472、§8.3 L548–561；A01–A03 L917–919、A07–A10 L923–926、A28 L944 | 渠道 preflight healthy，但 scan 时 auth expiry、CDP/network timeout、malformed payload 或伪空 receipt；`failed_channels` 存在却仍构造 clean-empty。现有 A01–A03 只测 preflight，A28 未强制每 selected channel 的真实 scan receipt/result hash。 | 每 selected channel 固定 capability/preflight receipt 与 scan receipt/result hash；定义 auth expiry/timeout/malformed/zero payload fail-closed；optional gap+zero candidate 固定 partial，禁止 clean-empty；A28 必须记录真实外部调用 purpose/role/payload hash/causal chain，禁止 stub/headless substitution。 | **Live-Channel-Matrix**：逐渠道执行 ready/success、optional missing、required runtime failure、auth expiry、timeout、malformed、zero payload；仅全部 receipt 可信且无 forbidden gap 可 clean-empty，否则 partial/failed/needs_user 且 UI 显示 gap。 |
| **H-15** | **HIGH**<br>`M#8`「events/metrics/permissions acceptance」 | observability §17.1–17.2 L866–897；security/data integrity §18.2 L899–909；唯一强证据 §19.1 L946–953 | 实现可能遗漏 event 的 parent/epoch/fence 字段、把 cookie/token 写入 event；Manager 借 worker grant 写业务，失败外部调用被包装成成功，或无按 workspace/root/stage 的 metrics/alerts。终态/UI 正确并不能证明安全、redaction、告警与发布边界。 | 版本化 event/redaction schema、metric labels/thresholds、command/grant matrix；每个 event/metric/security rejection 关联 acceptance run；store 拒绝 Manager-as-worker、worker escalation、伪 hash、失败 receipt、手工 DB 修复和自动 publish 越权。 | **Audit-Security-Contract**：完整 root 逐 event 核对必需字段与敏感字段缺失、labels 不串 workspace；尝试 Manager 越权、worker 提权、伪 hash、失败包装成功、手工 DB update、自动 publish，全部 stable reject/zero write；触发 18m/60s/orphan 告警并读回对应 metric/event。 |

## 6. Adversarial timelines

### T1：显式 invocation 被误判 replay

1. **T0**：两个合法 producer 提交相同 workspace/date/mode/source/action/logicalInput/acceptance。
2. **T1**：两者的初始 `retryInvocationOrdinal`/`predecessorRootId` 相同；`rootRequestId` preimage 没有独立 invocation 身份。
3. **T2**：一个请求可能撞唯一键，另一个被当成同 request replay；也可能不同实现得到不同 canonical hash。
4. **可观察破坏**：新业务被吞成 replay，或同一业务出现两个 root；repair/new root 语义不可证明。
5. **关联**：`B-01`；spec §5.1 L135–157、§5.2 L179–241、§7.3 L503–515。

### T2：spawn 成功但 `spawn_started` 丢失

1. **T0**：Actor 完成 claim fence、lease reserve，写 dispatch=`task_bound`。
2. **T1**：OS 已创建 Reporter，返回值尚未写入 dispatch；进程 crash。
3. **T2**：reconcile 只看到 `task_bound`。同 identity replay 会再 spawn；orphan 分支又无法证明第一个进程已停止或不会写。
4. **T3**：两个 Reporter 竞争 session/stdout/receipt，或一个 process/lease 永远泄漏。
5. **关联**：`B-02`（`C#4 + I#2`）；spec §10.2 L647–661、§12.2 L722–734。

### T3：preflight drift 穿过 F→J 与 Owner 状态

1. **T0**：所有 selected channel 在 auth/config revision r 通过 preflight，snapshot frozen。
2. **T1**：Owner revoke required login 或修改 profile；Reporter queued、running 或 handoff 前仍持 r。
3. **T2**：旧 snapshot 被用于 source/receipt，甚至 J projection；optional/required 分类也可能由 producer 降级。
4. **可观察破坏**：旧授权进入 Judge、`waiting_owner` 或 `clean-empty`，而 UI 仍显示正常 coverage。
5. **关联**：`B-08`、`B-09`、`H-08`、`H-14`；spec §7.1–7.3 L478–515、§8.1 L521–540。

### T4：旧 epoch 与 cancel/handoff 交错

1. **T0**：A 持 claim revision 7/epoch 1/token T1，F 已 frozen；B 启动 takeover 到 epoch 2。
2. **T1**：A 的 late result 只比较 child 复制字段；或 H 读取 F 后，C 把 root CAS 为 cancelled。
3. **T2**：A 可能写入新 terminal/projection；H 可能在 cancel cascade 后创建 J。
4. **可观察破坏**：两个 terminal winner、cancel 后 child、terminal row 被覆盖，或旧 epoch 业务写入。
5. **关联**：`B-05`、`B-06`、`B-07`；spec §9.3 L609–628、§12.2–12.3 L722–738、§18.2 L901–905。

### T5：migration/cutover/rollback 中的旧 writer

1. **T0**：migration 扫描旧 rows；旧 scheduler、旧 renderer/MCP、startup timer 仍存活。
2. **T1**：迁移在 actor/root/orphan mapping 中间 crash；或新 Actor 已 canary，旧 writer 迟到写 legacy/source。
3. **T2**：clean cutover 只切应用路由，没有 data-root/store fence；rollback 又停止新 intent 但未 drain child/browser/MCP。
4. **可观察破坏**：active inventory 污染、双写、错误归因、rollback 重新启用 direct/date-only 路径。
5. **关联**：`B-11`–`B-14`、`H-12`；spec §14.2–§16.2 L795–864；现实旁证 `src/main/index.ts:416–419,485–603`。

### T6：旧安装包/seeded row 伪造 A28

1. **T0**：验收读取磁盘上新 app.asar hash，但现有旧 PID/renderer 仍加载旧 artifact；data-root 预先存在历史 source/plan/receipt。
2. **T1**：child 返回 succeeded 或只产生 screenshot/孤立 receipt，没有本轮 output delta/readback。
3. **T2**：UI 与旧 projection 一致，A09/A10/A28 表面通过。
4. **可观察破坏**：验收证明的是文件/截图，不是当前安装进程、真实渠道与本轮 causation chain。
5. **关联**：`H-13`、`H-14`、`H-15`；spec §15.5 L843–845、§19–§19.1 L911–953。

## 7. Invariant-to-gap matrix

下表将 spec §20.1 L976–987 的最终不变量与合并 finding 对齐。`未闭合` 表示当前自检文字存在，但没有足以排除右侧 adversarial path 的机器合同。

| Spec invariant | 当前合同文字 | 未闭合 gap | 受影响 findings |
|---|---|---|---|
| I-1 | 全渠道 preflight 前无 Root/Reporter/worker（L978） | preflight deadline/recovery、credential drift、policy downgrade、source provenance 与 live runtime receipt 仍可在后续边界失效 | `B-08`、`B-09`、`H-05`、`H-08`、`H-14` |
| I-2 | 无 frozen predecessor 无 Judge；无 frozen target/effect 无 Stage D child（L979） | F→J 与 cancel 不是同一线性化事务；spawn/effect crash 及 source cap 可能在 handoff 前后制造重复/错误 child | `B-02`、`B-03`、`B-04`、`B-07`、`H-03` |
| I-3 | 无真实 eligible 无 `waiting_owner`（L980） | 并发 root 可隐藏当前候选；eligible+invalid/pending 没有 valid-subset 或 repair action | `B-10`、`H-10` |
| I-4 | 无完整可信 receipt 且无 pending/invalid/gap 无 clean-empty（L981） | preflight 旧凭据、failed channel source、伪空 receipt、optional all-failed action 与 source cap 语义未封闭 | `B-08`、`H-08`、`H-09`、`H-14`、`H-03` |
| I-5 | 无 durable receipt/claim/fence 无可重放/恢复/验收写入（L982） | identity preimage、cross-row current fence、transaction bundle、spawn/effect sink 与 schema/retention 不可执行 | `B-01`–`B-06`、`H-07` |
| I-6 | 无新可信业务进展无 successor（L983） | `lastBusinessProgressAt`/child success 可伪造 progress；没有 durable before/after measure 或 descendant bound | `H-04` |
| I-7 | 无当前 runtime epoch/lease 无业务写（L984） | Actor/gate authority 分裂；copied child fence、lease/gate deadline、legacy/cutover writer 未统一拒绝 | `B-05`、`B-06`、`B-11`–`B-14`、`H-06`、`H-12` |
| I-8 | terminal root/stage/scope/projection/dispatch/consumption 不回退（L985） | terminal result mutable、跨表 commit crash、external effect unknown、archive/delete 与 orphan lifecycle 未定义 | `B-03`、`B-04`、`B-06`、`H-07`、`H-11` |
| I-9 | Manager 只呈现/控制，不是 producer（L986） | approval 未绑定 root/projection；startup/legacy/direct producer inventory 不闭合，Owner action 可能无 route | `B-10`、`B-13`、`H-09`、`H-10`、`H-11`、`H-12` |
| I-10 | spec 之外入口/状态/reason/projection 必须拒绝零写（L987） | migration/cutover/rollback 旧版本、动态 startup producer、acceptance-only、event/metric/security proof 尚无统一 store-level rejection | `B-11`–`B-14`、`H-13`–`H-15` |

## 8. Acceptance coverage gaps

当前 A01–A28 的正向/局部场景不能覆盖以下关键负向合同。A 编号引用 spec §19 L915–944。

| 领域 | 现有场景 | 缺失的可证伪覆盖 | 应新增/扩展 |
|---|---|---|---|
| Identity/replay | A04–A06、A22–A23、A27 | 没有不同显式 request 的 invocation vector、canonical bytes、重复集合冲突、null/missing/unknown 规则 | `Identity-vector`（对应 `B-01`） |
| Spawn/recovery | A04–A06、A22 | 没有 OS spawn 成功后 DB 状态丢失、child register 丢失、process inventory/adopt-or-kill | `Spawn-Crash-Matrix`（`B-02`） |
| Effect sink | A20–A21 | 只验证 consumption identity/复用，不验证外部 sink 已提交而 consumption 未 consumed 的 unknown outcome | `Effect-Unknown-Replay`（`B-03`） |
| Atomicity/event | A04–A06、A09–A12、A20–A22 | 没有逐写入边界 crash、receipt/intent 丢序、scope/projection/root/checkpoint 不一致、lost broadcast/reconnect | `Transaction-Bundle-Crash` + `Notification-Replay`（`B-04`、`H-11`） |
| Authority/fence | A06、A21、A22、A26 | 没有 Actor/gate heartbeat-only wedge、跨行 current epoch 读取、terminal first-writer、F→J/cancel 两顺序 | `Authority-Takeover-Fence` + `Handoff-Cancel-Race`（`B-05`–`B-07`） |
| Preflight | A01–A03 | 没有 credential/config revocation、mixed profile revision、policy downgrade/unknown channel、probe hang/crash recovery | `Preflight-Drift-Policy-Deadline`（`B-08`、`B-09`、`H-05`） |
| Source provenance/live channel | A01、A07、A08、A10、A28 | 没有 failed channel write-then-fail、old/cross-root source、runtime auth expiry/timeout/malformed/zero payload | `Source-Provenance` + `Live-Channel-Matrix`（`H-08`、`H-14`） |
| Optional/Owner action | A01、A03、A07、A11 | 没有 all-optional failure action、eligible+invalid repair route、empty nextAction、stale approval zero-write | `Optional-Failure-Action` + `Candidate-Repair-Arbitration`（`H-09`、`H-10`） |
| Resource fairness | A13–A14 | 只测 5 Reporter/1 Judge 上限，不测 mailbox coalescing/backpressure、Judge interactive aging/preemption、Owner bounded wait | `Mailbox-Admission` + `Judge-Fairness`（`H-01`、`H-02`） |
| Budget/progress | A12、A15–A16 | A15 未证明 80 source 仍可一次 F→J；A12 未证明 strict progress/no-op stop/descendant bound；A16 未覆盖 lease > root deadline | `Source-Cap-Handoff` + `Successor-Progress` + `Lease-Gate-Deadline`（`H-03`、`H-04`、`H-06`） |
| Root/UI arbitration | A18、A24 | 没有 waiting_owner 与 scheduler root overlap、active-root index、delayed page approval、supersede/cancel arbitration | `Concurrent-Root-Approval`（`B-10`） |
| Migration/cutover | A25、A26、A27 | 没有 migration commit crash/replay、旧 process late write、跨版本 old app.asar/renderer/MCP、producer census、rollback active/drain/compat | `Migration-Crash/Replay`、`Mixed-Version-Cutover`、`Startup-Census`、`Rollback-Active`（`B-11`–`B-14`、`H-12`） |
| Real acceptance authenticity | A28 | 没有 acceptance_run_id/baseline/created-after、loaded artifact/PID/resourcesPath、required child output delta；声明不使用 seed 不等于机器阻断 | `Installed-Build-Identity + Fresh-Causal-Run`（`H-13`） |
| Security/observability | A01–A28 无逐项 authoritative proof | 没有完整 event/redaction/metric/grant matrix、失败 receipt、手工 DB 修复、自动 publish 越权的负向检查 | `Audit-Security-Contract`（`H-15`） |

## 9. Required spec amendment order

这是**spec-only** 的依赖顺序，不是实现计划；每一步都必须先满足上一步的文字合同与 acceptance 增量，才能进入下一步：

1. **Identity、hash、schema 与 retention 基线**：先修 `B-01`、`B-03`、`B-04`、`B-06`、`H-07`。冻结 versioned canonical/derive registry、PK/unique/FK/check/terminal immutability、effect token、transaction bundle、outbox/inbox 与 archival/tombstone 语义。没有这些，后续 fence 与 acceptance 无法引用稳定字段。
2. **Authority、epoch、lease、handoff 的统一线性化合同**：修 `B-05`–`B-08`、`H-06`，并把 `H-11` 的 checkpoint/outbox 绑定到同一 authority。明确 Actor/gate sole authority、current-row fence、takeover、terminal first-writer、F→J/cancel lock、preflight capability fence、bounded deadline。
3. **Preflight policy、provenance 与运行时渠道证据**：修 `B-09`、`H-05`、`H-08`、`H-09`、`H-14`。规定 requiredness 归一化、config/auth drift、selected/successful/failed partition、source receipt binding、optional failure nextAction、每 channel 的真实 runtime result。
4. **Mailbox、resource fairness、source budget 与 successor progress**：修 `H-01`–`H-04`。补 durable order/coalescing/backpressure、Judge queue aging/preemption、source cap 与 handoff 分离、strict progress measure、descendant bound；所有等待和计数要与第 2 步的 deadline/fence 相容。
5. **Root arbitration、Projection、Owner/Today readback**：修 `B-10`、`H-10`、`H-11`。定义 active-root index、supersession、approval command fence、valid subset/invalid repair action、reconnect resync；每个 CTA 必须指向具体 root/stage/scope/projection。
6. **Migration、clean cutover、startup census、rollback**：修 `B-11`–`B-14`、`H-12`。把 migration epoch/journal、跨版本 store fence、完整 producer inventory、PID/session/lease drain、rollback compatibility/maintenance 变成持久且可读回的合同。此步不得用静态“删除路径”替代动态拒绝证据。
7. **Acceptance、observability、security 与真机证据闭环**：最后修 `H-13`–`H-15`，并把 A01–A28 重新绑定到上述 identity/fence/causation chain。必须有 acceptance_run_id、baseline、loaded build identity、真实 selected-channel receipt、required child output delta、事件/指标/redaction/grant proof。完成前不得把“截图一致”“child 成功”“全库计数”当作通过。

完成顺序的唯一依赖原则是：**先定义可持久、可比较、可 fencing 的身份和状态，再定义跨表/跨进程线性化，再定义真实渠道与 UI 读回，最后才能定义真机 acceptance**。任何把第 7 步的声明提前替代第 1–6 步合同的做法都不能解除 REJECT。

## 10. Explicit non-authorized next steps

本次任务只交付审计报告，以下动作明确**未授权**：

- 不修改 approved spec `docs/spark/2026-08-29-workspace-orchestrator-design.md`；
- 不修改 `src/**`、测试、DB、runtime、`TASKS.md`、package/app.asar 或其他文档；
- 不实现 Actor、spawn/adopt、effect sink、migration、cutover、rollback、UI CTA 或 acceptance harness；
- 不启动 clean cutover、migration、rollback、真实渠道调用或生产调度；
- 不以 seed、手工 DB、截图、headless substitution、旧包或 fallback 形成任何“通过”证据；
- 不运行 formatter、linter、build、package、全量测试或应用验收作为本报告的替代证明。

**有界下一动作（需获得后续授权）**：只对 approved spec 做一次按 §9 顺序的 spec amendment；随后只做**一次** follow-up adversarial review，逐条复核 14 个 blocker 的新文字合同与新增 acceptance。若任一 blocker 仍缺少可执行 fence、唯一强证据或负向场景，verdict 保持 REJECT；不得跳到实现。

## 11. Evidence sources

### 11.1 Four complete agent outputs

- `agent://AuditConvergence`：8 source findings；其报告附 `local://wmb-audit-convergence.md`。
- `agent://AuditIdentity`：7 source findings；完整 findings 已在 agent output 返回，附带 `local://wmb-audit-identity-recovery.md` 的持久化失败说明；本报告以 agent output 为准。
- `agent://AuditOwner`：8 source findings；其报告附 `local://wmb-audit-owner-preflight.md`。
- `agent://AuditMigration`：8 source findings；其报告附 `local://wmb-audit-migration-acceptance.md`。

### 11.2 Approved spec and runtime corroboration

- `docs/spark/2026-08-29-workspace-orchestrator-design.md`：§3–§20.1，尤其 L135–157、L179–353、L408–472、L478–565、L569–668、L672–738、L780–845、L856–909、L911–989。
- `src/main/index.ts:416–419,485–603`：`AuditMigration` 引用的启动 scheduler/maintenance/backfill/orphan sweep 现实旁证。
- `src/main/data-changed.ts:40–63`：`AuditOwner` 引用的 in-memory coalescing/broadcast 现实旁证。
- 既有审查输出引用的 `docs/audits/2026-08-29-live-convergence-diagnosis.md`、`docs/audits/2026-08-29-real-machine-e2e-closure-audit.md`、`docs/audits/2026-08-29-manual-topic-pool-continuation.md` 作为 packaged-vs-dev、startup auto-scan、seeded/孤立 receipt 与 legacy handoff 的旁证来源；本任务未修改这些文件。

### 11.3 Baseline integrity

`665f5ee` remains the audited approved baseline and was not modified. 本次仅创建 `docs/audits/2026-08-29-workspace-orchestrator-adversarial-audit.md`。

**最终处置：REJECT / NOT IMPLEMENTATION-READY。只有 spec-only amendment 完成并通过一次后续 adversarial review 后，才可重新评估；本报告不授权开始实现。**
