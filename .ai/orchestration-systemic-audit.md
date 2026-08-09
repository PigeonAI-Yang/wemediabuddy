# WeMediaBuddy 主管/员工编排系统性审计

日期：2026-08-08 · 只读审计 · 范围：`src/main`（job-spawner / job-pool / manager-* / agent-runner / workspace-runtime / pi-runtime / daily-* / pi-page-authority / mcp.ts / index.ts / ipc-pi-dock / manager-job-notify / pi-context-payload）、`.pi/extensions/wmb-mcp`、`src/renderer`（today / agents / pi-dock）

按模式分组。每个发现：严重度 / 证据 / 失败模式 / 修复方向。

---

## 模式 A：子任务 worker lease 从未绑定 → 员工 Pi 写权结构性失效（S0）

**核心缺陷**：`assertTaskGrantForEnvelope`（src/main/task-grants.ts:286-322）要求 actor=pi 的写包携带 `workerLeaseId`，且 `runtime.isCurrentWorkerLease(leaseId, taskId)`（workspace-runtime.ts:157-161）要求**该 lease 当前绑定的 taskId 与包内 taskId 一致**。凡是"由 execute 自建权威 task"的路径（job-spawner 的 pipelineOwned 分支、manager 的 daily.run_stage）都没有把 lease 绑定到子任务，导致子任务 Pi 的**每一次业务写入都被拒**。

### A1（S0）主管派 writer/planner 工单必然失败
- 证据：`job-spawner.ts:392-396`（pipelineOwned → `taskId=null; grantId=null`，不 bind）；`job-execute-daily.ts:56-62`（onTaskReady 只 `ensureAutomaticTaskGrant`，无 `bindWorkerTask`）；对照 `index.ts:119-123`（withRuntimeWorker.onTaskReady 先 `bindWorkerTask` 再发 grant——唯一能工作的路径）；`agent-task-commands.ts` 无任何隐式绑定。
- 失败模式：writer 工单的 Pi 调 `wmb_save_core_version` 时 lease L.taskId 仍为 null → `WORKER_LEASE_STALE` → 写入被拒 → `validateStudioDraft`（agent-tasks.ts:524-533）失败 → 任务 failed。planner 工单同理（`plans.save` 被拒 → `validateDailyIntelligence` agent-tasks.ts:484-522 失败）。**desk 新编排的全部写稿/策划工单 100% 失败，与模型表现无关**；错误被包装成 `STUDIO_DRAFT_FAILED`/`DAILY_INTELLIGENCE_FAILED`，用户看到的是"员工失败"，实为编排层 bug。
- 修复方向：pipelineOwned 工单也走"execute 内 onTaskReady → `runtime.bindWorkerTask(ctx.lease, taskId)`"（把 job-execute-daily 的 onTaskReady 改为先 bind 再 grant），或在 runJob 中为 writer/planner 预留 bind 回调；同时给 `piTaskAuthorityPrompt` 的 workerLeaseId 传参改为"由绑定后的 lease 派生"。

### A2（S0）主管工具 `wmb_run_daily_stage(judge/full)` 与 `wmb_continue_after_scan` 必然失败
- 证据：`mcp.ts:503-519`（daily.run_stage handler 调 `runManagerDailyStage` **不传 workerLeaseId**）；`manager-orchestration.ts:45-70` 原样透传 undefined；`agent-runner.ts:604-612`（startDailyIntelligence.createRuntime → `piTaskAuthorityPrompt({...workerLeaseId: undefined})` → **抛 `PI_TASK_AUTHORITY_REQUIRED`**，pi-operator-skill.ts:13-15）。且 `manager-orchestration.ts:74-76` 把 `partial` 计入 `ok: true`。
- 失败模式：manager Pi 按系统提示调用 judge/full 阶段 → 后台 `startDailyIntelligence` 抛 `PI_TASK_AUTHORITY_REQUIRED` → 任务被 forcePartial 收尾 → **工具返回 `ok: true`（partial 算成功）**，manager 误以为阶段已完成；今日页显示 partial。scan 阶段不 spawn Pi 所以能过，停在 channel_scanned 后继续调 judge 又必失败。
- 修复方向：MCP 层把调用方 Pi 的 workerLeaseId（envelope 上下文）转发给 runManagerDailyStage，并像 withRuntimeWorker 一样 bind 到子任务；或改为给阶段子任务分配独立 employee lease。`runManagerDailyStage` 的 ok 判定不应把 partial 当成功，至少带回 errorCode。

### A3（S0）Today 按钮 → 幽灵 manager 任务常驻 + serial gate 永久锁死 + 渲染层假投影
- 证据：`index.ts:737-760`（`legacyPipeline !== true` 走 manager 路径，返回 `task: null, managerOwned: true`）；`manager-dispatch.ts:258-268`（`void runDockManagerPrompt(...).catch(console.error)`——**fire-and-forget，无兜底**）；`manager-task.ts:128-140`（`managerTaskSerialDecision`：running/waiting_human/reporting 一律 `focus_existing`，**无超时无看门狗**）；渲染层 `today-view.tsx:163-190`（manager running 时合成 `{ intent: 'daily_intelligence', phase: 'manager' }` 的**假 task 快照**写入 `writeTodayRunCache`）。
- 失败模式：Pi 未配置 / 对话回合失败 / manager 选择不动作时，manager 任务永远 `running`，Today 按钮永远 `focus_existing`，今日情报**永不执行**；今日页却显示一个"运行中的 daily_intelligence"幽灵（id 复用 manager 任务 id），用户无法区分真跑与假跑。假快照的 id 还可能被传给 `agent:control-daily` 打到 page_agents 任务上。
- 修复方向：dock prompt 失败时把 manager 任务 fail/partial 并**回退 legacy 管道**（`shouldStartLegacyPipeline: true` 的真实兜底）；给 manager 任务加 stall 看门狗（复用 daily-control-policy 模式）；渲染层停止合成 daily_intelligence 假投影，改为诚实展示 manager 状态。

---

## 模式 B：终态推送缺位 + 停驻任务无人接力（silent auto-handoff）

### B1（S1）reporter 工单"成功"但 daily 任务停在 channel_scanned，且无任何推送
- 证据：`job-execute-daily.ts:92-95`（`scanOnly && (status==='running' || phase==='channel_scanned') → return 'succeeded'`）；`workspace-intelligence.ts:86-97`（scanOnly 有新入库时任务保持 running/channel_scanned）；`manager-job-notify.ts:88-113`（只对 job.started/finished/failed/cancelled 推送，**对停驻任务零推送**）；`buildNotifyText`（manager-job-notify.ts:63-82）对 succeeded 工单写"员工工单已结束。请立即向用户汇报结果"。
- 失败模式：reporter 工单终态推送到达 desk 时，实际 daily 任务仍在 running（channel_scanned）。desk 被告知"汇报结果"，但方案并不存在；续接策划的工具又全部失效（A2）。孤儿 `channel_scanned` 任务只在**应用重启**时被 sweeper（index.ts:255-290）捡起。整个 scan→judge 接力依赖"manager 恰好用对工具"或"重启"，无人兜底。
- 修复方向：工单终态与任务终态解耦——reporter 成功后若任务仍 running，推送 `job.waiting_judge` 事件（文案改为"扫描完成，需续接策划"）；sweeper 改为定时（不只重启时）；A2 修复后 manager 才有可用的接力工具。

### B2（S1）取消不传导：job cancelled 与底层任务/task 状态撕裂
- 证据：`job-spawner.ts:220-250`（cancel → abort signal + release lease + pool.cancel；pipelineOwned 的 `taskId=null` → 无 `dispatchCancelAgentTask`、无 `abortDailyIntelligence`）；`job-execute-daily.ts`（execute **从不检查 `ctx.signal`**）；`agent-runner.ts:779-873`（startStudioDraft 不受 signal 影响，跑完自行 complete）。
- 失败模式：用户/主管取消 writer 工单 → 工单立刻 cancelled，但 Pi 初稿继续在后台跑完并 `dispatchCompleteAgentTask` 成功（校验通过）→ **job=cancelled、task=succeeded 并存**，正文仍被写入。reporter 取消同理：浏览器扫描继续，任务可能落成 channel_scanned 孤儿。
- 修复方向：execute 内用 `Promise.race([run, abortEvent])`，abort 时对已建 task 调 `abortDailyIntelligence(taskId)` / `dispatchCancelAgentTask`；pipelineOwned 路径把 execute 自建的 taskId 回传给 spawner（handle.taskId），或由 execute 负责取消。

---

## 模式 C：desk/员工隔离洞

### C1（S1）员工 Pi（studio/results）复用主编 dock 会话文件
- 证据：`agent-runner.ts:816-826`（startStudioDraft：`--session layout.sessionFile`，`piSessionId: conversation.sessionId`）；`agent-runner.ts:910-920`（startResultsReview 同）；对照 `agent-runner.ts:592-594`（daily 用 `dailyAgentSessionId(businessDate, task.id)` 独立会话）；`pi-conversation.ts:75-78`（sessionFilePath 默认 dock.jsonl）。
- 失败模式：两个并发 writer 工单（maxWorkers≥2）的 Pi 进程**同时 append 同一 JSONL** → 行交错、JSONL 解析失败（pi-runtime.ts read 遇坏行直接 kill）。员工初稿/复盘文本还混入 Owner 的 dock 会话，Owner 对话被污染；同步时可能把员工内容当用户消息回放。
- 修复方向：studio/results 员工运行改用 per-task 会话文件（`agentRunnerSessionId(intent, taskId)`），与 dock 会话彻底隔离。

### C2（S1）单 desk lease 随页面 rebind，切页使在飞任务写权失效
- 证据：`pi-page-authority.ts:134`（每次 ensurePageAuthority `rebindWorkerTask(lease, active.id)`）；`workspace-runtime.ts:157-161`（isCurrentWorkerLease 只认 lease 当前 taskId）；`workspace-runtime.ts:231-238`（rebind 无"旧任务仍持有"保护）。
- 失败模式：manager 回合进行中，用户切到 studio/画布页 → dock 回合走 ensurePageAuthority 把 desk lease 改绑到新页任务 → 仍在跑的 manager 任务（或其子任务）的后续 `wmb_*` 写包全部 `WORKER_LEASE_STALE`。**写权与单个可变 lease 强绑定，页面切换即可杀死在飞任务授权**。
- 修复方向：grant 校验改为 task→lease 映射（多任务可共享一 lease 但不互相覆盖），或每个运行中任务持有独立 employee lease；rebind 前先 revoke/解绑旧任务。

### C3（S2）ensureJobSpawner 忽略 runtime 身份，可能跨工作空间复用
- 证据：`job-spawner.ts:509-519`（`if (activeSpawner) return activeSpawner`，不校验 `runtime.identity`）；`mcp.ts:371-399`（managerSpawner 闭包捕获 runtime）。
- 失败模式：旧工作空间 MCP server 的迟到请求（切换竞态窗口内）会拿到**另一工作空间**的 spawner，工单落进错误库。窗口被 gate（startMcp 用 gate.run 包裹）收窄，但隔离无显式保障。
- 修复方向：ensureJobSpawner 校验 `activeSpawner` 的 runtime 身份（workspaceId+epoch），不匹配则重建。

---

## 模式 D：noop 执行与假成功地雷

### D1（S2）JobSpawner 默认 execute 即"无操作成功"
- 证据：`job-spawner.ts:85-89`（默认 `execute = async () => 'succeeded'`，注释自认"骨架可测"）；`job-spawner.ts:509-519`（升级仅当"先前无 execute 且后来带 execute"；反之若先带 execute 后不带，旧 execute 被保留——方向不对称）。
- 失败模式：生产两条路径（ipc-jobs.ts:21-49、mcp.ts:371-399）都注入了真 execute，当前无实弹；但任何新调用点忘记传 execute（如测试/脚本/未来工具）都会让**工单"秒成功"且无任何副作用**，且 `notifyDeskJobEvent` 照常推"已结束、请汇报结果"。
- 修复方向：默认 execute 改为 throw（或返回 'failed' 且记 error），让"忘注入"立刻显性失败，而不是假成功。

---

## 模式 E：并发与队列一致性

### E1（S1）调度器自动 judge 与主管/按钮 judge 无互斥，双跑竞争
- 证据：`daily-scan-scheduler.ts:88-114`（onNewSources → judgeOnly，无 per-date 锁、不查 manager 在场）；`agent-runner.ts:565-575`（startDailyIntelligence 对 channel_scanned 任务 rebind 复用，两个 runner 可同时驱动同一任务）；`manager-task.ts` serial gate 只管 manager 任务。
- 失败模式：调度器扫到新源触发 judge 的同时，主管也点 judge/派 planner → 两个 Pi 进程同写一任务，进度互相覆盖，`dispatchCompleteAgentTask` 双写（后者 INVALID_STATE → partial/失败），方案可能被二次覆盖。
- 修复方向：judge 入口统一走 per-(businessDate) 执行锁（借 JobPool entityLock 语义），调度器触发前检查"当日已有 running judge/manager 任务"。

### E2（S1）WORKSPACE_BUSY fail-fast：突发工单直接失败而非排队；requeue 是死代码
- 证据：`job-spawner.ts:349-366`（`WORKSPACE_BUSY` → `pool.fail('JOB_SLOT_BUSY')`，注释明言"prefer fail-fast over requeue"）；`job-pool.ts:174-207`（`requeue()` 无任何调用方）；`worker-limits.ts`（MAX_WORKER_LEASES=8，desk 槽靠算术预留，非强制）。
- 失败模式：外部 lease 持有者（今日按钮/调度器 withRuntimeWorker 并发跑）占满 8 槽时，新派工单**直接 failed**（JOB_SLOT_BUSY），desk 收到"工单失败"而不知只是瞬时忙；与"排队等待"的产品语义相悖。
- 修复方向：忙时 `requeue(jobId, 'WORKSPACE_BUSY', { promote: false })` 回队尾并延迟 tryPromote；把 requeue 接入 runJob 或删除死代码。

---

## 模式 F：看门狗与投影的次生问题

### F1（S2）watchdog stall 不看流式输出，健康长回合可能被掐断
- 证据：`daily-control-policy.ts:44-62`（stall 以 `progress.lastActivityAt` 为准）；`agent-tasks.ts:320-321`（lastActivityAt 仅在有 phase/progress/checkpoint/message 时刷新）；`agent-runner.ts:642-665`（heartbeat 每 15s 发 `{}`，不刷 lastActivityAt）。
- 失败模式：judge 回合模型连续思考/流式输出超过 10 分钟而没调 `wmb_report_agent_progress`（一次长回复）→ `DAILY_STALL` → `abortDailyIntelligence` 掐断进行中的 Pi。长回复被误杀。
- 修复方向：stall 判定纳入"流式 delta 时间戳"（pi-runtime 事件里带 at）或把 heartbeat 升级为携带 message 刷新活动性。

### F2（S2）manager checkpoint children 不反映工单子任务，job→task 链接丢失
- 证据：`manager-dispatch.ts:276-330`（syncManagerTaskFromLegacyChild 只桥接 legacy daily 子任务）；`job-spawner.ts:392-396`（pipelineOwned job 的 handle.taskId=null）；`agents-roster-view.tsx:210-218`（roster 对 taskId 为 null 的 job 无法镜像任务状态）。
- 失败模式：desk 用 wmb_spawn_job 派出 reporter 后，manager 卡片 children 仍显示"queued"，工单终态不落入 checkpoint；主管只能靠 wmb_list_jobs 手工对账。
- 修复方向：job 事件（含 execute 自建 taskId）回写 manager checkpoint.children（jobId→taskId 映射），handle.taskId 在 pipelineOwned 路径也补全。

---

## 优先修复清单（Top 10）

1. **A1**：pipelineOwned 工单把 job lease 绑定到 execute 自建 task（onTaskReady 先 bindWorkerTask 再 grant）——writer/planner 工单立即可用。
2. **A2**：daily.run_stage / continue_after_scan 转发调用方 Pi workerLeaseId 并 bind 子任务；partial 不再计 ok。
3. **A3**：dock prompt 失败/manager 静默 → fail manager 任务 + 回退 legacy 管道；manager 任务加 stall 看门狗；渲染层去掉 daily_intelligence 假投影。
4. **B2**：execute 与 ctx.signal 竞速，取消时 abortDailyIntelligence / cancel 子任务，杜绝孤儿后跑。
5. **B1**：reporter 工单成功后若任务停驻 channel_scanned，推送 job.waiting_judge 事件并修正通知文案；孤儿 sweeper 改定时。
6. **C1**：studio/results 员工运行改 per-task 会话文件，隔离 dock 会话。
7. **C2**：grant 校验改 task→lease 映射或子任务独立 lease；rebind 不覆盖在飞任务。
8. **E1**：judge 入口统一 per-date 执行锁，调度器/主管/按钮共用。
9. **E2**：WORKSPACE_BUSY 走 requeue（回队尾）而非 fail；删死代码或接入。
10. **D1+F2**：默认 execute 改显性失败；pipelineOwned job 补 taskId 回写，工单子任务落入 manager checkpoint。

---

## 统计

- S0：3（A1、A2、A3）
- S1：6（B1、B2、C1、C2、E1、E2）
- S2：4（C3、D1、F1、F2）

> 计数口径：A/B/C/D/E/F 分组下共 13 项发现，S0=3，S1=6，S2=4。
