# WMB-5142 Evidence — 实例运行投影（jobId 一等身份 · 活动期编号 · 终态顺序 · needs_user 保留 · 持久历史）

- 日期：2026-08-09
- 合同：`.ai/wmb-5142-contract.md`（实施阶段）；设计真源 `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` §5/§6.4/§7/§11-12/§14/§16-17、PRODUCT C9.2/C9.9/C9.10、PRD REQ-028/REQ-029、SPEC CAP-027（AC-024..AC-027）
- 改动文件（2 源码修改 + 1 新建投影 API + 1 测试适配 + 1 新建聚焦测试 + 本证据）：
  - `src/main/job-pool.ts`（maxWorkers 合法域 0..7：0=停用派工，submit 拒收）
  - `src/main/crew-instance-projection.ts`（**新建**：单一 CrewInstanceProjection DTO/read API，投影 API 唯一落点）
  - `src/main/role-roster.ts`（重建为实例驱动投影，保留既有行字段 + 新增 `instances` 活动实例数组）
  - `tests/job-pool-stress.test.mjs`（maxWorkers 边界断言从「拒绝 0」适配为「0=停用派工」新合同）
  - `tests/wmb-5142-instance-projection.test.mjs`（**新建**，8 条聚焦测试；评审修复轮 +3 → 11 条；生命周期收口轮 +3 → 14 条；终审 P3 轮 +1 → 15 条）
  - `.ai/wmb-5142-evidence.md`（本文件）
- 终审 P3 轮（FinalReviewWmb5142 唯一残留 P3 关闭）：`src/main/job-control.ts`（runCancellationSequence 关闭路径按 closeTaskId 清扫同任务兄弟 needs_user 卡）、`tests/wmb-5142-instance-projection.test.mjs`（T15 重复卡 close 回归）、`scripts/line-caps.json`（测试文件 766 只升登记）
- 评审修复轮（ReviewWmb5142 P1/P2/P3 关闭）：`src/main/crew-instance-projection.ts`（P1 按任务去重 needs_user 卡 + P3 单次读锚点加载）、`src/main/generic-employee-runner.ts`（P1 复用/前置任务回写 handle 任务引用）、`src/main/role-roster.ts`（P2 空角色中性文案）、`tests/wmb-5142-instance-projection.test.mjs`（T8 适配 + T9/T10/T11 新增）、`scripts/line-caps.json`（测试文件 580 只降登记）
- 生命周期收口轮（ReReviewWmb5142 三项 findings 关闭，见「生命周期收口轮」节）：`src/main/job-pool.ts`（cancel 迁移终态 needs_user）、`src/main/agent-tasks.ts`（cancelAgentTask 允许 needs_user + bindNeedsUserJobContract）、`src/main/agent-task-commands.ts`（dispatchBindNeedsUserJobContract）、`src/main/job-control.ts`（runCancellationSequence 关闭 needs_user 卡）、`src/main/generic-employee-runner.ts`（前置卡绑定工单合同 + closeStaleNeedsUserCards 处理路径）、`src/main/job-spawner.ts`（execute ctx 注入 pool）、`src/main/crew-instance-projection.ts`（任务终态卡退出 + 任务去重重建守卫）、`scripts/line-caps.json`（620/489/717 只升登记）

## Background / 复现（Change 1）

实施前以最新源码复核真实调用链（合同要求）：
- **按槽/角色聚合**：`buildRoleRoster` 只按 intent 取「每角色最近任务」聚合单行（`latestByRole`），同角色多实例无法表达；池内 queued/waiting_resource 工单在 roster 完全不可见（只在 jobs 板）。
- **终态/needs_user**：roster 仅把 needs_user 任务映射为 `blocked`，终态行靠 `getLatestAgentTask`（持久任务）而非实例投影；历史「最近流水」在 UI 侧读 `jobs:list`（**内存池**），重启即丢。
- **历史依赖池**：无独立历史 API；实例退出活动视图后只能靠 jobs:list 的内存终态记录指认。
- **maxWorkers 0**：`normalizeMaxWorkers` 拒绝 <1；`new JobPool(0)` / `new JobSpawner({maxWorkers:0})` 直接抛错，与「0=停用派工」合同域不符。

## Implementation（Change 2-5）

**`src/main/crew-instance-projection.ts`（新建，266 行）** — 单一投影 DTO/read API：
- `CrewInstance`：一等身份 `jobId` + 不可变 `roleId`；`brief/intent/status/waitReason/waitingSince/progressLabel/progressRatio/phase/taskId/sessionFile/piSessionId/businessDate/projectId/error/code/queuedAt/startedAt/finishedAt/source`；活动期 `displayNumber`（每角色 queuedAt 序 1..N，纯显示、不持久化、重启重新计数；历史实例恒 0）。
- `readCrewInstanceProjection({ database, pool, getHandle })`：
  - **active** = 池内 queued/waiting_resource/running/needs_user + **持久 needs_user**（重启后卡留「等你批」，按 jobId 与池实例去重）；
  - **history** 只从持久面重建（`context_refs_json` 含 jobId 的 agent_tasks → `readJobContractFromRefs` 锚点 + 任务行 status/errorCode/progress/phase/timestamps + 会话 ref `agent/sessions/job-<jobId>.jsonl`），**不从 JobPool**；
  - **scan→judge 归属规则**（§7.1）：活动实例的 taskId/进度解析优先 `context_refs_json.jobId` 锚点（rebind 后接续实例持有），handle 回落 → 同一任务同一时刻只归属一个活动实例，不双计；
  - `summary`（active/queued/waitingResource/running/needsUser/history）与 `byRole` 分组。

**`src/main/role-roster.ts`（重建，235 行）** — 实例驱动（§12.2.4 干净切换，无槽位 shim）：
- 经 `getActiveJobSpawner()` 取池构建投影；每角色行 = 活动期代表实例（queuedAt 序首个），行字段与既有 `AgentRosterRow` 完全兼容，**新增 `instances`**（该角色全部活动实例，同角色多实例显式可见）；无活动实例回落遗留任务（daily 编排/页任务不经 JobPool 的既有可见性，desk 零回归），再无则取最近历史实例；空角色显示中性文案「当前无任务」（评审修复轮：原「待命」虚构待命态已删除，§14 A4）。
- queued/waiting_resource 首次在 roster 行可见（summary「排队中/等资源 · reason」）。

**`src/main/job-pool.ts`（+4 行）** — `normalizeMaxWorkers` 合法域 0..7（0=停用派工）；`submit` 在 maxWorkers=0 时拒收（`JOB_SPAWN_DISABLED`，与 spawner `enabled` 双保险，覆盖 `new JobSpawner({maxWorkers:0})` 构造路径）。

## Review 修复轮（ReviewWmb5142 P1/P2/P3）

**P1 — 续派后旧 needs_user 池记录永留活动视图，同任务双实例（`crew-instance-projection.ts` + `generic-employee-runner.ts`）**
- 根因（实机探针复现，真实 GenericEmployeeRunner）：needs_user 是 pool 终态但被投影 ACTIVE_STATUSES 保留。真实续派路径 = 用户配置仍缺失时重新 spawn → `resolveAgentPiPrerequisite`/`getReusableNeedsUserAgentTask` **reuse 同一 needs_user 任务** → 新 job 重复 settle 出第二张 needs_user 卡（同一任务两张卡，双实例）；被 rebind 接替的旧卡（refs.jobId 移走）同样失去锚点仍卡 active。探针证实：前置（配置缺失）任务**无 jobId 合同**（refs 仅 projectId），report.taskId 原为 null——纯投影锚点过滤会把「配置缺失等你批」唯一卡误删，必须按任务身份去重。
- 修复：
  1. `generic-employee-runner.ts`：策略返回的复用/前置未绑定任务（`onTaskReady` 未触发）经 `ctx.onTaskBound?.(run.task.id, null)` 回写 handle 任务引用 → settle 报告携带 `report.taskId`（真实 runner 的 needs_user 报告从此可指认任务，T11 断言）。
  2. `crew-instance-projection.ts` 池循环：needs_user 记录按 `report.taskId` 去重（同一任务的新 settle 为重复卡，退出，只留最早一张——配置缺失单卡因唯一 taskRef 正常保留）；无任务引用且失去锚点/句柄的记录（被 rebind 接替的旧卡）退出。
- 语义保留：持有任务锚点的卡（`refs.jobId === rec.id`）、配置缺失前置卡（唯一 taskRef）不受影响；「卡留直至用户处理/关闭后退出」的完整生命周期（关闭/补配置处理退出）由生命周期收口轮实现（见下节）；重启后持久面仍只重建一张卡（T9/T11/T12 断言）。
- 回归证明：临时禁用去重块后 T9 + T11 均失败（`fail 2`），恢复后 11/11 通过——测试真实捕获原缺陷。**T9 模型同步修正**（评审 P3 第三项）：续派 execute 与真实 runner 同款回写 `ctx.onTaskBound(sharedTaskId)`（settle 报告携带 taskId）并断言 `done2.report?.taskId === sharedTaskId`——第二张卡真正走 `needsUserTaskIds` 去重分支（此前续派卡 taskRef=null 走锚点分支，未钉住去重）；禁用去重块后 T9 失败即钉住证明。

**P2 — roster 空角色输出「待命」虚构待命态（`role-roster.ts`）**
- 修复：`rowFromInstance` 删除死代码默认值 `'待命'`（活动实例四态 + 历史 else 分支全覆盖，`let summary: string` 由分支确定赋值）；`rowFromLegacy` 空任务默认值改为中性文案 `'当前无任务'`（§14 A4 / EVAL-CAP-027.5：全空状态无虚构待命/占位坐席文案）。API 层（agents:roster-status IPC / agents.roster MCP）经 `buildRoleRoster` 不再输出「待命」；renderer 未触碰（不改 UI）。
- 测试：T8 断言从 `'待命'` 改为 `'当前无任务'`，并新增 desk 空态同文案断言。

**P3 — loadTasksByJobId 每次投影全表 LIKE 扫描 + N+1（`crew-instance-projection.ts`）**
- 根因：`context_refs_json LIKE '%jobId%'`（前导通配符无法走索引）+ 每行 `getAgentTask` 二次查询（SELECT * + 6 个大 JSON 列重复解析），随 agent_tasks 无界增长延迟线性恶化。
- 修复：单次有界 SQL 读必要列（id/intent/business_date/status/phase/pi_session_id/context_refs_json/progress_json/error_code/error_message/created_at/updated_at/finished_at）+ 内存构建锚点 Map；**不新增 schema**；全量读取不牺牲历史完整性（重启后 needs_user/终态历史完整重建）。投影只消费上述列，resultRefs/checkpoint/events 等大 JSON 不再解析；每行至多 parse context_refs + progress 一次。防御性容错：损坏 refs 行跳过（原逐行路径会整体抛错）。
- 测试：T10 锁定锚点语义（带 jobId 合同的员工角色任务进锚点；无 jobId 合同任务、desk roleId 合同任务不进投影）。

## Commands / Results（评审修复轮）

- `node --test --test-concurrency=1 tests/wmb-5142-instance-projection.test.mjs`：**11/11 PASS**
  - T1..T8 原 8 条全部保持绿（T8 文案断言已适配「当前无任务」）
  - T9（新增）needs_user 续派 reuse 同任务（绑定任务路径）：重复卡退出，同任务只保留一张 needs_user 卡（active=1、taskId 引用计数=1、重启后仍单卡）
  - T10（新增）锚点读取语义：仅带 jobId 合同的员工角色任务进历史（desk roleId / 无 jobId 任务均排除）
  - T11（新增，真实 runner）配置缺失前置卡保留 + 续派 reuse 同任务：report.taskId 相同 → 重复卡按任务退出（needsUser=1，最早卡保留）
- 回归：`agents-roster-conflict` + `agent-work-paths` + `role-capability-p1` + `job-pool-stress`：**41/41 PASS**；`job-pool` + `job-spawner` + `job-scan-judge-race` + `wmb-5141-job-boundary` + `job-l2-integration` + `generic-employee-runner` + `agent-tasks` + `worker-lease-wiring`：**100/100 PASS**
- `npx tsc --noEmit`：PASS（0 错误）
- line-cap：`crew-instance-projection.ts` 333、`role-roster.ts` 237、`generic-employee-runner.ts` 323（均无注册 cap，≤500）；`tests/wmb-5142-instance-projection.test.mjs` 580 → 登记 `scripts/line-caps.json` cap 580（只降，与 wmb-5141 测试 525 登记同模式）；`job-pool.ts`/`job-spawner.ts`/`role-job-registry.ts`/`agent-tasks.ts`/`job-control.ts` 本轮零触碰（保持原 cap 值）

**消费者兼容**：`agents:roster-status` IPC、`agents.roster` MCP、`jobs:list/jobs:get/wmb_list_jobs` 零改动——roster 经 `buildRoleRoster` 读投影（行字段兼容 + instances 附加），jobs 面保持 JobRecord+handle（业务字段：report/code/message/readback 不丢）；`mcp.ts`/`ipc-today-studio-business.ts`/`ipc-jobs.ts`/`manager-job-notify.ts` 未触碰。**manager-job-notify 无改动**：终态顺序与 JOB_EVENT 已由 runJob 既有顺序保证（agent_task 终态 → grant 回收钩子 → lease 释放 → settle 释放锁 + pool 终态 → emit JOB_EVENT），证据 T6 逐点断言。

## 生命周期收口轮（ReReviewWmb5142 三项 findings 关闭）

评审复检发现三项剩余项：P1 合同「卡留直至用户处理/关闭**后退出**」只闭合了「卡留/去重」半句（关闭/处理均无实现路径）；P3-a 无 jobId 合同的配置缺失前置卡重启后不重建（T11 无重启断言）；P3-b T9 未钉住 taskId 去重分支（证据对 T9 描述不实）。本轮全部关闭：

**F1（P1 剩余项）— needs_user 卡「关闭/处理后退出」合法生命周期（非仅投影过滤）**
- `src/main/job-pool.ts`：`cancel` 对终态 `needs_user` 记录真实迁移 `cancelled`（此前 `settle` 对终态 no-op，卡永留活动视图；succeeded/failed 等真终态保持 no-op 返回原记录不变，job-pool-stress 既有断言回归绿）。
- `src/main/agent-tasks.ts`：`cancelAgentTask` 允许 `needs_user → cancelled`（此前仅 running，关闭序列 INVALID_STATE 摸不到任务）；新增 `bindNeedsUserJobContract`（仅接受 needs_user，合并工单合同 refs，命令面审计）。
- `src/main/job-control.ts`：`runCancellationSequence` 对已 settle 的 needs_user 卡（无运行句柄）从终态报告取 `report.taskId` 一并转 cancelled——`jobs.cancel` 关闭一张卡 = 池卡 + 任务双侧真实退出；`before` 在 await 后重读（MINOR 3 去重保持原竞态语义，job-l2-integration T-11 / 5119 planner cancel race 回归绿）。
- `src/main/generic-employee-runner.ts`：**处理路径** `closeStaleNeedsUserCards`（导出，runner 在配置补齐续派、真实任务已建后调用）——按角色前置 intent 集 + businessDate（writer 加 projectId 精确匹配）关闭遗留 PI_CONFIG_REQUIRED 卡：任务转 cancelled（历史可追、不再复用），池内凡引用该任务（report.taskId）的 needs_user 记录全部转 cancelled（jobs:list 不残留）；`JobExecuteContext` 注入 `pool`（job-spawner.ts），取消命令准确作用 jobId 对应 task + 命令面审计。
- `src/main/crew-instance-projection.ts`：池循环 needs_user 卡增加「引用任务已终态 → 等待作废、卡退出」守卫（覆盖关闭单卡后同任务重复卡、被处理接替的旧卡，不依赖单卡迁移）；`instanceFromPool` 的 taskId 回落 `report.taskId`（终态卡句柄已清仍可指认任务）；持久 needs_user 重建增加 `activeTaskIds` 任务去重（池卡代表同任务时不重建重复卡）。

**F2（P3-a）— 配置缺失前置卡重启即丢（真实最常见 needs_user 场景）**
- 根因：`resolveAgentPiPrerequisite` 创建的前置任务从不走 onTaskReady → 无 jobId 合同 → `loadTasksByJobId` 对 `readJobContractFromRefs` 返回 null 的行跳过 → 池清空后持久重建找不到该卡。
- 修复：`generic-employee-runner.ts` 在策略返回复用/前置未绑定任务时调用 `bindWaitingTaskContract`——仅当任务仍 needs_user 且尚无合同（新建前置卡 / 旧版无合同卡修复；reuse 旧卡已带合同不覆写 jobId，续派卡仍归属最早 job），把 jobId/roleId/brief/边界合并写入 context_refs（`dispatchBindNeedsUserJobContract` 命令面审计）→ 重启后投影按 jobId 重建「等你批」卡。
- 测试：**T12**（真实 runner 配置缺失卡带合同 + 重启后仍一张卡）；T11 补重启断言（同卡仍一张）。T11/T12 的「重启后仍一张卡」禁用合同绑定均失败（fail 2，钉住）。

**F3（P3-b）— T9 未钉住 taskId 去重分支**
- 根因：T9 续派 execute 不建任务也不调 `ctx.onTaskBound` → 第二张卡 report.taskId=null → 走「无任务引用且失去锚点/句柄」分支，与 `needsUserTaskIds` 去重无关。
- 修复：T9 续派路径与真实 runner 同款回写 `ctx.onTaskBound(sharedTaskId)` 并断言 `done2.report?.taskId === sharedTaskId`——第二张卡携带任务引用、真正走去重分支；证据对 T9 的描述同步更正。禁用去重块后 T9 + T11 均失败（fail 2，钉住证明与 P1 轮证据一致）。

**先失败复现（Change 1 要求）**
- 逐项 mutation 复现（每项独立禁用对应修复 → 对应新测试失败，恢复后绿）：
  1. 禁用投影去重块（`needsUserTaskIds.has` 恒 false）→ **T9 + T11 fail**；
  2. 禁用前置卡合同绑定（bindWaitingTaskContract 直接 return）→ **T11（重启断言）+ T12 fail**；
  3. 禁用 `JobPool.cancel` needs_user 迁移 → **T13 fail**；
  4. 恢复 cancelAgentTask 拒绝 needs_user → **T13 + T14 fail**。
- 全量回退（stash 六源码文件）后测试文件整体无法加载（新 API 不存在），证明新测试依赖本轮实现，非既有行为。

## Commands / Results（生命周期收口轮）

- `node --test --test-concurrency=1 tests/wmb-5142-instance-projection.test.mjs`：**14/14 PASS**
  - T1..T8 原 8 条保持绿；T9（模型修正后走去重分支 + taskRef 断言）；T10 保持绿；T11（真实 runner + 重启断言）
  - T12（新增）配置缺失前置卡带工单合同（jobId/roleId/brief 断言）+ 重启后持久重建仍一张卡（修复重启即丢）
  - T13（新增）用户关闭 needs_user 卡：`spawner.cancel` → 池卡 + 任务双 cancelled、active=0、history 可追（cancelled 行 jobId/taskId 指认）、重启不复发
  - T14（新增）补配置续派（处理）：`closeStaleNeedsUserCards`（runner 配置补齐续派执行同一函数）→ 旧任务/旧池卡 cancelled 退出、新实例唯一（新 jobId + 新任务，旧 jobId 不残留，旧卡留 history）
- 回归（24 个聚焦套件）：`job-pool` + `job-spawner` + `job-pool-stress` + `job-scan-judge-race` + `job-l2-integration` + `agent-tasks` + `generic-employee-runner` + `worker-lease-wiring` + `wmb-5141-job-boundary` + `agents-roster-conflict` + `basic-agent-paths` + `command-dispatcher` + `workspace-needs-user` + `daily-intelligence-channels` + `manager-orchestration` + `role-capability-p1` + `agent-capabilities` + `metrics-jobs` + `x-observation-jobs` + `agent-work-paths` + `task-grants` + `execution-grants` + `pi-config` + `wmb-5142-instance-projection`：**233/233 PASS**（含既有 5116/5119/5120/5121 取消优先与事件去重用例）
- `npx tsc --noEmit`：PASS（0 错误）
- line-cap：`tests/wmb-5142-instance-projection.test.mjs` 717、`src/main/agent-tasks.ts` 620、`src/main/job-spawner.ts` 489 → `scripts/line-caps.json` 登记同值（只升）；`crew-instance-projection.ts` 341、`generic-employee-runner.ts` 424、`job-pool.ts` 384、`job-control.ts` 223、`agent-task-commands.ts` 179（均无注册 cap，≤500）。跳过 formatter/lint/build/项目级全套/check.ps1（主 Agent 统一执行）。

## 终审 P3 轮（FinalReviewWmb5142 唯一残留 P3 关闭）

评审唯一残留 P3：关闭同任务重复 needs_user 卡中的一张后，共享任务已 cancelled，兄弟池卡仍以 needs_user 残留 terminal map——投影守卫将其隐藏，但 jobs:list（JobPool.list 原始池记录）显示「等你批」幽灵卡，关闭路径未像处理路径（closeStaleNeedsUserCards 按 report.taskId 扫全池）那样清扫，重启或再关闭才自愈。

**修复（`src/main/job-control.ts`，runCancellationSequence）**
- 在目标 `pool.cancel(jobId, report)` 之后，以 `closeTaskId` 扫全池：`status === 'needs_user' && report.taskId === closeTaskId` 的兄弟记录逐一 `pool.cancel(rec.id, null)`（与 closeStaleNeedsUserCards 同款清扫）。
- 语义约束逐条落实：**纯池侧终态迁移**——只 pool.cancel，不再 dispatch 任务（任务 cancel 只一次，上文已按 closeTaskId 取消）；**不误取消其他 task/job**——命中键 = 正在取消的任务 id，只触碰引用同一任务的兄弟卡（独立卡/其他任务零影响）；**审计/竞态保留**——取消报告沿用原 needs_user 报告（taskId 可追、history 从持久面重建），已终态记录 pool.cancel 为 no-op（MINOR 3 去重与并发竞态语义不变）。
- 作用域：handle 路径（closeTaskId=handle.taskId）与 needs_user 关闭路径（closeTaskId=report.taskId）统一生效；`closeTaskId` 为 null 时跳过。

**测试（T15，重复卡 close 回归）**
- 真实 runner 造三张卡：独立卡（P15-other → 独立任务 T2）+ 兄弟对（P15 初稿 → T、续派 reuse 同任务 → 第二张卡 report.taskId=T），断言原始池记录（jobs:list 数据源）两张同任务 needs_user 兄弟卡。
- 关闭其中一张（respawn）：目标 cancelled + 共享任务 T cancelled（任务 cancel 只一次）+ **兄弟卡（first）同步 cancelled**（修复前残留 needs_user 幽灵）+ jobs:list 无同任务 needs_user 幽灵（仅独立卡仍 needs_user，未误取消其他 job/task）+ 其他任务 T2 不受影响 + 投影 active=1（仅独立卡）、history=1（T cancelled 按任务计一条）。
- **先失败证明**：临时禁用清扫块（env 门控）→ T15 fail 1（兄弟卡仍 needs_user）；恢复后 15/15 绿。

## Commands / Results（终审 P3 轮）

- `node --test --test-concurrency=1 tests/wmb-5142-instance-projection.test.mjs`：**15/15 PASS**（T1..T14 保持绿，T15 新增）
- 回归（取消路径相关聚焦套件）：`job-l2-integration` + `job-spawner` + `job-pool` + `job-pool-stress` + `job-scan-judge-race` + `generic-employee-runner` + `wmb-5141-job-boundary` + `agent-tasks` + `worker-lease-wiring`：**117/117 PASS**（含 5116/5119/5120/5121 取消优先与事件去重、MINOR 3 竞态用例）
- line-cap：`tests/wmb-5142-instance-projection.test.mjs` 717 → 766 → `scripts/line-caps.json` 登记同值（只升）；`src/main/job-control.ts` 234（无注册 cap，≤500）。跳过 formatter/lint/build/项目级全套/check.ps1（主 Agent 统一执行）。

## Commands / Results

- `node --test --test-concurrency=1 tests/wmb-5142-instance-projection.test.mjs`：**8/8 PASS**
  - T1 同角色多实例独立投影：3 张记者单 → running×2 + waiting_resource×1 并排可见、jobId 唯一、displayNumber 1..3 按 queuedAt 稳定派生（同毫秒 jobId 决胜）
  - T2 空投影 summary 全 0、active/history 空
  - T3 活动期编号纯显示：运行中 #1；refs 不含 displayNumber（不落库）；重启（新 epoch + 空池）历史从持久面重建（failed/jobId/brief/taskId/会话 ref）且编号 0；新活动期从 1 重新计数
  - T4 scan→judge 共享同一 agent_task：reporter 终态退出（pool succeeded、任务保持 running）、judge rebind 接管进度（judging_opportunities）与等你批（needs_user）；同一任务同一时刻只归属一个活动实例（active 引用计数=1）；重启后 persisted needs_user 仍卡留活动视图
  - T5 重启历史可读 + 续派输入可建：jobId 指认（writer/needs_user/PI_CONFIG_REQUIRED/projectId）；`rebuildRoleJobRequest` 重建原请求（与 5141 合同一致）；再 spawn 成功
  - T6 终态顺序（四角色）+ needs_user 零资源：JOB_EVENT 触发瞬间断言 agent_task 终态先落 + grant 已回收（task_grants active=0）+ 本工单 lease 已释放 + pool 终态已落；executeCalls=4 无自动重试；needs_user×4 停留活动视图带编号；同锁键新单可直接运行（零锁）；lease 归零
  - T7 maxWorkers 域 0..7：`new JobPool(0).submit` 与 `new JobSpawner({maxWorkers:0}).spawn` 均 JOB_SPAWN_DISABLED；8/-1/1.5 拒收
  - T8 desk 不可 spawn（ROLE_NOT_SPAWNABLE）且不进员工投影；roster 实例驱动（同角色 2 实例行 displayNumber 1/2、空角色「当前无任务」（原「待命」断言已按评审 P2 适配）、desk instances=0）；无 spawner 时 roster 仍可用（5 行不崩）
- 回归：`job-pool` + `job-spawner` + `job-scan-judge-race` + `wmb-5141-job-boundary` + `agents-roster-conflict`：**66/66 PASS**；`job-pool-stress` + `wmb-5142` + `job-l2-integration` + `generic-employee-runner` + `agent-tasks` + `worker-lease-wiring` + `manager-orchestration`：**70/70 PASS**；`task-grants` + `execution-grants` + `command-dispatcher` + `role-capability-p1` + `agent-capabilities` + `metrics-jobs` + `x-observation-jobs` + `agent-work-paths` + `basic-agent-paths`：**66/66 PASS**（累计 210 条）
- `npx tsc --noEmit`：PASS（0 错误）
- 按合同跳过 formatter/lint/build/项目级全套/check.ps1（主 Agent 统一执行）。line-cap 面：`job-pool.ts` 378（无注册 cap，≤500）、`role-roster.ts` 235（≤500）、`crew-instance-projection.ts` 266（新文件 ≤500）、`tests/wmb-5142-instance-projection.test.mjs` 471（≤500）；`job-spawner.ts`/`role-job-registry.ts`/`agent-tasks.ts` 零触碰（保持 486/498/601 cap 原值）。

## Acceptance 对照

- 实例一等身份：投影以 jobId 唯一标识、roleId 不可变；活动期编号纯显示（T1/T3：编号不落库、重启重新计数）✓
- 终态顺序（四角色）：agent_task 终态 → grant 回收 → lease/锁释放 → pool 终态 + JOB_EVENT（T6 事件瞬间逐点断言；取消优先/五态映射既有 5116/5119 用例回归）✓
- scan→judge 不双计：共享 agent_task 时 reporter 终态退出、judge 接管进度/等你批，同一任务同一时刻只归属一个活动实例（T4）✓
- 历史重建：池清空（重启）后从 context_refs_json + agent_tasks + 会话 ref 重建并可指认（jobId + 结果）；续派参数与 5141 合同一致（rebuildRoleJobRequest），无第二份写源（T3/T5）✓
- desk 零回归：默认桌助 dock 流程不触碰（roster 遗留路径原语义保留、manager-job-notify/desk 编排零改动）；`spawn(roleId:'desk')` 拒绝（T8 + L1-1 回归）；值班条投影无 action 不上条逻辑在 dock 侧未改 ✓
- 评审 P1（续派双实例）关闭：needs_user 卡按任务（report.taskId）去重——续派 reuse 同任务的重复卡退出、配置缺失前置卡保留、被 rebind 接替的旧卡退出，同任务至多一个活动实例（T9/T11；禁用去重复现失败 → 恢复后绿；实机探针确认单卡）✓
- 评审 P2（待命文案）关闭：roster API 空角色/空任务输出「当前无任务」，无虚构待命态；`rowFromInstance` 死默认删除（T8 适配 + desk 空态断言；UI 未触碰）✓
- 评审 P3（LIKE+N+1）关闭：锚点加载改为单次有界 SQL 读必要列 + 内存构建，无 LIKE 全表扫描/N+1/大 JSON 重复解析，不新增 schema、历史完整性不牺牲（T10 锁定锚点语义）✓
- **生命周期收口（ReReviewWmb5142 三项 findings）**：
  - **重启仍一张卡**：配置缺失前置卡带工单合同（`bindWaitingTaskContract`），重启后持久面仍只重建一张卡（T11 重启断言 + T12；禁用合同绑定两测均失败）✓
  - **close 后 active=0 且 history 可追**：`jobs.cancel` 对 needs_user 卡真实迁移（pool.cancel + cancelAgentTask + runCancellationSequence 报告任务引用），池卡与任务双 cancelled、active=0、history 从持久面重建可指认、重启不复发（T13）✓
  - **处理后旧卡退出、新实例唯一**：配置补齐续派经 `closeStaleNeedsUserCards`（runner 在真实任务已建后调用）关闭旧任务 + 旧池卡，新实例独立新任务且唯一（T14）✓
  - **零资源**：关闭/处理路径无新增 slot/lease/grant/锁占用（needs_user 零资源保留语义不变；关闭序列复用既有 lease 释放路径，T13/T14 池内无残留活动记录）✓
  - **取消命令准确作用 jobId 对应 task + 审计**：`runCancellationSequence` 经报告 taskId 精确关闭该工单任务，命令面 receipt/operation_log 审计（T13 断言池卡与任务同 cancelled）✓
  - **T9 真钉分支 / T11 重启声明真实**：T9 续派卡携带 taskRef 走去重分支（断言 `done2.report?.taskId`），禁用去重 T9+T11 均失败；T11 补重启断言 ✓
  - **终审 P3（关闭路径兄弟卡清扫）**：关闭同任务重复 needs_user 卡中的一张 → 目标/兄弟卡 + 共享任务三侧真实 cancelled，jobs:list 无 needs_user 幽灵、独立卡/其他任务零影响（T15；禁用清扫 T15 失败，恢复后绿）✓
- 一致性门禁：typecheck 0（自验）；`check:capabilities`（G1）由主 Agent 统一执行（本变更零触碰 registry 文件）✓

## Impact

- **Capability registry**：no change —— `agent-capabilities.ts`/`page-authority.ts` 零触碰（实例投影/终态顺序为运行层语义）。
- **Pi operator Skill**：no change —— 按 `docs/pi-operation-skill-maintenance.md` 影响表属「内部重构且可观察行为不变」类：`wmb_*` 工具名/参数/序列/读回不变（roster 行字段兼容 + 附加 instances 字段）；不新增命令/能力/角色/依赖；三表 schema 零改动（T10 回归）。
- **已知边界**（与设计 §7.3/5141 风险一致）：scan→judge rebind 覆写 refs.jobId 后，被接续实例（judge）持有锚点，scan 实例经会话文件 `job-<jobId>.jsonl` / 审计指认——投影 history 以 refs 锚点为准（归属接续实例，不双计）；无 agent_task 的取消工单（queued/parked 取消）无持久痕迹，不进投影历史（历史只从持久面重建）。**关闭/处理路径对无合同旧卡**（本轮修复前遗留、refs 无 jobId）：池卡与任务均转 cancelled、退出活动视图，但历史行以任务合同为锚（无合同则无历史行，仅 operation_log 审计可追）——新卡全部带合同，历史可追。desk 行维持遗留任务语义（desk 永不进员工投影）。
