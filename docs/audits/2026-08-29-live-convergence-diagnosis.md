# 2026-08-29 WeMediaBuddy 今日情报工作流：实时收敛与取消审计

## 结论

**运行判定：生产性但不收敛（productive but non-convergent）；当前又处于“进程已退出、数据库仍残留 running/monitor_reporter”的幻影态。**

在进程仍可观察的两个有界截面中，确实出现了新的、互不重复的来源并完成了真实处理：`source_items` 从 544 条增至 563 条，新增 19 条且 canonical URL 也新增 19 条；截至第二截面已有 `research_claims`：contradicted 1、supported 56、unresolved 142，操作日志也有来源入库、正文归档、研究 successor 重整和任务进度读回。因此不能把它判为纯空转。

但它没有满足“收敛”：主管仍停在 `monitor_reporter`，没有进入 `dispatch_planner`，也没有进入 `report`/`waiting_human`/`done`。同一运行的来源、归档和 successor 任务持续增长，`pending`/`needs_user`/`failed` 记录大量存在，资源阻塞与补料调度没有一个可观察的、会减少的 backlog 或成功停止点。应用随后在执行正常取消前退出，留下 manager/child 的数据库幻影状态；因此退出后的“是否还有新 dispatch”不能声称已验证。

## 两个有界快照与变化

运行起点/主管创建时间：`2026-08-29T00:57:35.417Z`。第一截面约为 `2026-08-29T09:14:30`，第二截面为 `2026-08-29T09:34:04.300Z`。以下只写入已读回或由两次截面直接相减得到的值；未保留的毫秒级字段不补造。

| 指标（限定本 manager 起点之后） | 快照 A（约 09:14:30） | 快照 B（09:34:04.300Z） | 有界 delta / 含义 |
|---|---:|---:|---|
| `source_items` 新增行 | 544 | 563 | **+19** |
| `canonical_url` distinct | 544 | 563 | **+19**；新增不是同 URL 重复写入 |
| `source_items` 首条创建 | — | `01:04:58.669Z` | 已有持续输入 |
| `source_items` 末条创建 | — | `09:33:43.199Z` | 截面 B 前仍有新来源进入 |
| manager checkpoint | `running / monitor_reporter` | `running / monitor_reporter` | 未推进到 planner |
| `research_claims.contradicted` | — | 1 | 有实际判读结果 |
| `research_claims.supported` | — | 56 | 有实际支持证据读回 |
| `research_claims.unresolved` | — | 142 | 未解决项仍远大于 0 |
| jobs：`succeeded` | — | 4,843 | 有真实完成量 |
| jobs：`failed` | — | 1,172 | 失败量很大，非纯成功流水线 |
| jobs：`needs_user` | — | 118 | 人工门前积压 |
| jobs：`pending` | — | 979 | 队列仍有大量待处理 |
| jobs：`running` | — | 8 | B 截面仍有运行标记；退出后归属未再核验 |
| `operation_log`（起点至 B） | — | 22,989 | 大量实际调用/读回 |

B 截面还读到 `source_body_capture_jobs`：`ready=3997`、`needs_review=861`、`retry_wait=4`、`pending=1`。同一窗口的操作聚合包括：`media_archive.finish_job=6220`（最后 `09:31:56.380Z`）、`jobs.reconcile_research_successor=2996`（最后 `09:31:54.140Z`）、`agent_task.progress=1515`（最后 `09:34:00.480Z`）、`source_body_archive.finish_job=790`、`source_body_archive.claim_job=790`、`sources.upsert_batch=785`（最后 `09:33:44.068Z`）。这些数字同时证明了真实工作和高频补料/重整活动。

## 有用工作证据

1. `source_items` 与 distinct canonical URL 同步增加 19，排除了“只反复写同一来源”的最简单解释。
2. B 截面有 56 条 `supported` claim、1 条 `contradicted` claim，说明抓取结果实际进入了 claim 判读，而不是只有工单创建。
3. `source_body_archive.claim_job/finish_job`、`media_archive.finish_job`、`sources.upsert_batch`、`agent_task.progress` 都在第二快照前持续出现，说明部分来源确实完成归档、入库和进度读回。
4. jobs 有 4,843 条 succeeded；但该总量包含同运行窗口的各类角色工单，不能据此推断主管已完成审批链。

## churn / 非收敛证据

1. 主管 checkpoint 在两个截面都没有离开 `monitor_reporter`；没有可观察的 `dispatch_planner`、`report`、`waiting_human` 或 `done`。
2. `unresolved=142`，而 `pending=979`、`needs_user=118`、`failed=1172`；这与“素材/证据缺口驱动补料”以及失败/等待重排一致，不能视为已满足停止条件。
3. `jobs.reconcile_research_successor=2996`、`media_archive.finish_job=6220` 与 `source_body_capture_jobs.ready=3997`/`needs_review=861` 表明系统在做实事，但在主管主链未推进时仍继续补料和重整，形成“有产出、无主链收敛”的反馈风险。
4. 失败、pending、needs_user、running 记录同时存在；因此不能把增长全归类为单一 retry churn，也不能把它解释为正常的有限队列消耗。

## 停止条件与源代码追踪

### 1. 主管阶段转换

- `src/main/manager-task.ts:17-24` 定义阶段：`accepted → dispatch_reporter → monitor_reporter → dispatch_planner → monitor_planner → report → done`。
- `src/main/manager-dispatch.ts:390-408`：记者成功才把 manager 推到 `dispatch_planner`；planner 运行才到 `monitor_planner`；planner 成功/partial/needs_user 才进入 `report`/`waiting_human`；失败或取消才终止。当前数据库仍是 `running/monitor_reporter`，所以主链没有达到 planner 入口。
- `src/main/manager-dispatch.ts:204-345` 的创建路径会异步 `runDockManagerPrompt`，随后依靠真实 Pi 工具结果与 job/agent event 驱动 checkpoint；它没有给“不断增加的来源材料”自动提供一个独立的全局收敛计数器。
- `src/main/manager-dispatch.ts:226-252`：若当前计划有 unresolved 且未 exhausted，新的根采集会被 pending review gate 阻止；只有 scoring recovery 或计划明确 exhausted 才能开启下一轮。当前 `unresolved=142`，没有 `isExhausted` 的读回，因此该门不能自然变成“已批准”。

### 2. 研究/证据补料停止条件

- `src/main/research-job-runner.ts:486-488` 明确终止原因：`allAnswered()` 时 `claims_resolved`；否则仅在 `budgetExhausted` 时 `budget_exhausted`，或候选耗尽时 `candidates_exhausted`。只有 resolved 返回 `succeeded`，其余返回 `partial`。
- B 截面仍有 142 个 unresolved，并且存在大量 ready/needs_review/pending capture 行；没有证据证明 `claims_resolved`、`budget_exhausted` 或 `candidates_exhausted` 已成立。因此继续运行时，最可能路径是继续补候选/补正文，而不是自动进入主管审批。
- `src/main/research-dispatch.ts:1-10` 虽有三层止环：父角色限制、`jobs.dedupe_key` 唯一性、research successor 产物不得自动再次派研究；这些约束能防部分重复派单，却不等于主管主链有一个已满足的“材料总量上限”。

### 3. 资源阻塞路径

- `src/main/job-control.ts:193-209` 的 `parkDeferred` 在判定资源占用时释放 employee lease，把工单放入 `waiting_resource` 并记录 `RESOURCE_JUDGE_IN_FLIGHT`/`SCAN_JUDGE_IN_FLIGHT`。这解释了截图所见“Reporter 等待/持有资源、主管 blocked”的运行形态：等待资源的任务可以继续留在池中，补料工作则继续产生记录。
- `src/main/job-control.ts:69-143` 的正常取消序列是有边界且可追踪的：abort → 写入 `control_action=cancel` → bounded stopResource（2 秒上限）→ 释放 lease → `abortDailyIntelligence` → `dispatchCancelAgentTask` → `pool.cancel` → 清理句柄。该路径未被实际调用，因为应用在取消前已经退出。

**源代码结论：**当前运行不能凭现有状态满足 `claims_resolved`/预算耗尽/候选耗尽，也不能满足 manager 的 planner→report→done 转换；继续运行的收敛理由不足。能证伪本结论的证据是：恢复应用后，读回同一 manager 在一次有界观察中进入 `dispatch_planner`，随后出现 planner 终态及 `report/waiting_human`，并且 pending/unresolved backlog 下降或停止条件明确成立。

## 授权变更后的取消尝试与当前安全状态

用户授权改为“现在干预并停止”，要求只走正常 WMB UI/业务取消路径。执行了取消前的连接确认，但**没有发出任何取消、重试、DB 写入、发布或进程终止动作**：

- 目标 manager：`52968c9f-3291-47cc-b606-d57f170a76e5`。
- 交接中保留的 phantom child 前缀：`1475998…`；关联 plan-item 前缀：`plan-item-1217…`。完整值未在本次交接文本中保留，不能臆造。
- 既有 DevTools 文件 `C:/Users/yangda01/AppData/Roaming/WeMediaBuddy/DevToolsActivePort` 仍写有端口 `9322`，但对 `127.0.0.1:9322` 的 TCP 连接返回 `False`。
- `tasklist /FI "PID eq 616904"` 返回“没有正在运行的任务匹配”；直接读取该 PID 的进程元数据无结果；也没有发现 `electron.exe`/`WeMediaBuddy` 进程。故 **WMB PID 616904 在正常取消尝试前已退出**，无法通过 UI 或 preload IPC 进入取消序列。
- 已读到的数据库 phantom 状态仍为 manager `running/monitor_reporter`，并保留上述 child/plan-item 的 running/monitor_reporter 影子；这是持久化状态，不代表仍有活的执行器。
- 应用退出后的“零新 child dispatch”没有做出声称：最后可用的有界 DB/日志截面到 `09:34:04.300Z`，进程退出后没有运行时事件源可供确认，故该项 **未验证**。
- 没有证据表明 source/claims/versions 被删除或重置；本次没有执行 destructive 操作。由于未走到 cancel，不能把任何数据库行称为“已取消”。

## 根因/假设

最符合全部证据的假设是：主管主链在 Reporter/资源等待阶段失去可推进性，而 evidence-gap/research-successor/正文归档活动仍在追加候选和任务。新增来源是真实的，但它们没有转化为 planner 的一次性、有限的可批方案；因此形成“生产性补料 + 资源阻塞 + 任务/素材持续增长”的非收敛反馈。`dedupe_key` 和 successor 三层止环降低了完全相同 request 的重复风险，但不能替代 manager 的 backlog stop predicate。

## 立即风险与当前安全

- 若进程仍活着，风险是继续增加 `source_items`、capture/archive/job/operation_log 行，继续产生外部工具调用，继续堆积 pending/needs_user/failed，并长期无法到达 Today approval；这不是成本估算，而是已有计数器和最后更新时间显示的直接风险。
- 目前已观测到 WMB 进程退出，因此当前没有证据证明外部调用仍在继续；但退出后的 no-new-dispatch 仍未验证。
- 未观察到删除、reset、seed、deduplicate、publish 或其他破坏性动作。数据库中的 running 幻影会影响下次启动时的可见状态和幂等门，不能直接当作真实运行完成。

## 精确安全下一步（现在不执行）

1. **不要**手工改 DB，不删除/重置/去重来源、claims、versions 或 jobs；不要把 phantom 行强行改成 succeeded。
2. 在获得继续操作授权后，正常启动同一个 WeMediaBuddy 工作区；确认 data root 后，用 Today/Agents 的现有业务界面重新读回 manager `52968c9f-3291-47cc-b606-d57f170a76e5` 及其完整 child/job ID。
3. 先取消 manager：使用 Today 的“取消今日情报”业务动作（源码入口 `src/renderer/today-view.tsx:588` → `window.wmb.controlDailyIntelligence({ id, action: 'cancel' })` → `src/main/index.ts:1014-1055`），让系统执行 `abort → control cancel → stop → release → task cancel → pool cancel`；或在 Agents 详情中使用 `agent:cancel`（`src/main/index.ts:987-994`）。
4. 等待并读回 manager 为 terminal `cancelled`/`failed`；若 manager 没有级联清理，使用 Agents roster 的现有“取消/关闭”逐一取消该同一 run 的 active/queued child/job（UI 入口 `src/renderer/agents-roster-view.tsx:167-178`，底层 `jobsCancel`），不得触碰无关任务。
5. 以两个有界读回（建议间隔 30–60 秒）验收：manager terminal；该 run 的 active/queued child 为 0；无新的 `agent_task`/job dispatch；WMB 进程仍存活；source_items、claims、content_versions 保留。若普通取消不可用或不级联，立即停在该安全点并请求第二次明确的进程终止授权，不能自行杀 PID。
6. 只有上述 phantom 清理和“无新增 dispatch”验收成立后，才讨论是否开始新一轮；新一轮必须重新取得明确目标/上限，不能直接把旧的 running phantom 当作可续跑许可。

## Reporter 并发修复与综合结论

### 根因与源码修复

- **根因：** Reporter 共享 JobPool 的 authoritative default 是 `2`；runtime lease cap 总量是 `8`（1 个 reserved desk + 7 个 employees）。因此有效并发为 `2` 的原因是 pool default，而不是 lease ceiling。
- **源码修复：** `src/main/worker-limits.ts` 将 `MIN_REPORTER_CONCURRENCY=5`、`DEFAULT_MAX_WORKERS=5`；`src/main/job-pool.ts` 将每个正容量中低于 `5` 的值钳制为 `5`，`0` 仍表示禁用，高于 `5` 的值保留但最多为 `7`；IPC 返回 resolved capacity；Agents roster fallback 为 `5`。

### 行为证明

五个 Reporter job 可以与一个 desk lease 共存，第六个 job 排队；取消一个 job 后会释放一个 slot。`tests/job-spawner.test.mjs` **18/18**、`tests/job-pool-stress.test.mjs` **18/18** 已通过。

### 变更文件

- `src/main/worker-limits.ts`
- `src/main/job-pool.ts`
- `src/main/ipc-jobs.ts`
- `src/renderer/agents-roster-view.tsx`
- `tests/job-pool-stress.test.mjs`
- `tests/job-spawner.test.mjs`
- `tests/wmb-5145-crew-multi-instance-acceptance.test.mjs`

### 部署边界

本修复不需要 DB migration；必须 rebuild/restart，并重建 scheduler 才能生效。旧 run 和旧 installed app 从未采用 `5` 并发。

### 关键限定

提高并发只改善吞吐，不会修复非收敛反馈回路或 phantom state。任何新 run 之前，先做一次受控 restart，仅用于对 manager `52968c9f-3291-47cc-b606-d57f170a76e5` 及剩余 children 执行正常业务取消/清理；证明 manager 已 terminal、active/queued child 为 `0` 且无 redispatch 后，再安装并 restart 含并发修复的 build。不得声称旧 run 已取消，也不得声称旧 installed app 已经运行五路并发。

**最终建议：** 严格按以下顺序执行：**受控 restart 进行取消/清理 → 验证 terminal/zero children 且无新 dispatch → build/install repaired concurrency → 启动新的有界 run，并显式设置 backlog/stop limits。** 本次取消没有执行，因为目标 WMB 应用/PID/端口在取消动作前已消失。

## 2026-08-29 重建/安装尝试与取消验收证据

### 构建与安装边界（成功重建证据覆盖此前失败边界）

- 早先一次 Forge Squirrel maker 因磁盘空间不足失败的记录仍保留为历史尝试；随后按项目 README 的同一官方路径完成了成功重建：`npm run build`（`verify:xhs-resources` → runtime preparation → `electron-forge make`）。本节以下以成功产物和成功安装日志为最终部署证据。
- 成功构建产物：`J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe`，782,723,072 bytes，SHA-256 `76A808A4572109349BFC2A1A402FE59BF40528248A1D20D13AD43C8D4598B63A`；`WeMediaBuddy-0.3.0-full.nupkg`，787,777,748 bytes，SHA-256 `BD7B7F4F8C978FAABA53A1085E9A253D645CF5BEF04BBF2835FBEA24451B4C7A`；`RELEASES`，83 bytes，SHA-256 `7A96F6CD18EEFCF8A71BD5EEED25AEAF3808B51C20A257B5D41E416DB08666D7`。
- 安装命令为 `Start-Process -FilePath "J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe" -ArgumentList "--silent" -Wait`；`C:/Users/yangda01/AppData/Local/SquirrelTemp/Squirrel-Install.log:847-859` 记录 `--install . --silent`、写入 `C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0`、创建执行 stub/快捷方式并正常 `Finished Squirrel Updater`。
- 安装后 `WeMediaBuddy.exe` 为 225,781,760 bytes、SHA-256 `AD06BF29B6B659FB62156DE8D8135DD14265E2995600B3A3CBA0E6260E176343`；`resources/app.asar` 为 5,882,476 bytes、SHA-256 `A98F811F0DEDF682540A04BBA73892AAC07F810CC0E3A330C04334B19E73F9FB`。二者与 `J:/wmb-out/WeMediaBuddy-win32-x64/` 对应文件逐字节一致；`app.asar:package.json` 版本为 `0.3.0`。
- 安装目标仅为 per-user 应用目录；既有 data root `J:/PigeonYang/WeMediaBuddyData` 未删除、重置、seed、去重或直接改 DB。

### 成功安装版清理复验与意外任务来源追踪

- 安装版进程于本次重建后启动：`C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe`；`2026-08-29T12:00:26.677Z` 读回仍有 PID `385496,454976,494996,559400,697364`，均 `HasExited=False`，9322 端口为 `Listen`。
- 安装版 live IPC 读回（`2026-08-29T12:00:19.775Z`，renderer URL 为 `file:///C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar/.vite/renderer/main_window/index.html`）为 `jobsPoolStatus={maxWorkers:5,running:0,queued:0,waitingResource:0,jobs:[]}`，`getManagerTask({businessDate:"2026-08-29"})` 返回 `{managerTask:null,legacyChild:null}`，`jobsList()` 返回 `[]`。因此 Reporter/shared employee pool 的安装版解析容量为 `5`，当前池空闲。

| 安装版读回 | 时间（UTC） | source / claims / versions | manager checkpoint | 同 run active/queued child | manager-linked 新 dispatch |
|---|---|---|---|---|---|
| Post-cancel 1 | `2026-08-29T11:48:23.422Z` | `5644 / 437 / 545` | `cancelled/done`；311 children：`succeeded=125, failed=185, cancelled=1` | `0`（空） | `0` |
| Post-cancel 2 | `2026-08-29T11:51:11.528Z` | `5644 / 437 / 545`，与 Post 1 相同 | 同上，未变化 | `0`（空） | `0`；但出现下述独立 `daily_scan`，不是 manager child |

- manager `52968c9f-3291-47cc-b606-d57f170a76e5` 的正常业务取消在 `2026-08-29T11:47:09.341Z` 以 `agent_tasks.cancel`、`actor=owner_ui/renderer`、`side_effect_state=committed` 完成；当前 DB 行为 `status=cancelled, phase=cancelled, error_code=CANCELLED`，checkpoint 为 `status=cancelled, phase=done`。两次读回均证明其 311 个 checkpoint children 全部 terminal，active/queued 为 `[]`。
- Post 1 与 Post 2 之间没有该 manager 的 child task/job；Post 2 之后截至 `2026-08-29T11:59:36.718Z` 也没有新的 `page_agents`、`daily_scan`、`daily_judge` 或 `daily_intelligence` task。此后 DB 新增的 128 个 jobs 是非 manager 的 `media_archive=127` 与 `knowledge_compile=1` pending jobs；安装版 live `jobsList()` 仍为空，不能把它们记作 manager redispatch。

#### 独立 startup auto-scan 的精确来源

- 新任务 `05d2370f-8a3d-409c-8811-088606f1d6d3` 于 `2026-08-29T11:49:42.239Z` 创建，`intent=daily_scan`、`pi_session_id=daily-2026-08-29-05d2370f-8a3d-409c-8811-088606f1d6d3`、`roleId=reporter`、`modules=[x_lists]`、冻结 5 个来源；于 `11:50:18.510Z` 以 `partial/partial`、`CHANNEL_SCAN_FAILED` 终止，`saved=0`。它没有 manager id、没有复用 manager checkpoint，且没有加入 manager 的 311-child 集合。
- 其 command receipt 为 `agent_tasks.start`、`actor=scheduler/daily-intelligence`、request id `daily_intelligence:2026-08-29:a755adf2-4e8d-4abd-b616-4d7934f730f1:channels:start:5d1c3153-d1b1-48b8-be0d-9f8cd0dd475c`；对应 `daily-intelligence-channels.ts:121-123,157-160` 固定 scheduler actor/context。`operation_log` 同时留有同一实体的 UI start 记录，但实际 start command receipt 与 task events 均为 scheduler/daily-intelligence。
- 这不是同 run manager redispatch，而是安装版启动时 `DailyScanScheduler` 的独立滚动扫描：`src/main/index.ts:503-523` 注册 `scanOnly: true` 的 reporter 回调；`src/main/daily-scan-scheduler.ts:35-43` 默认 `firstDelayMs=90s`，`x_lists` 首 tick 为 `firstDelayMs*2=180s`。本次安装版进程在本地 `19:46:40` 左右启动，任务在 UTC `11:49:42.239Z` 创建，时间差约 182s，与该定时器吻合。`saved=0` 也没有进入 `index.ts:525-549` 的新来源 judge 回调。

### 成功安装版严格判定

- **构建/安装：通过。** Setup、nupkg、RELEASES、安装目录和版本/哈希均已读回，安装日志显示 Squirrel 完成。
- **Reporter/shared employee pool：通过。** 安装版 live IPC 解析 `maxWorkers=5`，池为 `5/0/0/0`。
- **manager 正常取消与同 run child 收敛：通过。** manager 为 terminal `cancelled/done`，311 个 checkpoint children 全部 terminal，两个 post-cancel 截面 active/queued 均为 `0`，没有 manager-linked redispatch。
- **数据保全：通过。** 两个 post-cancel 截面的 `source_items / research_claims / content_versions` 均为 `5644 / 437 / 545`，未发生业务计数变化。
- **首次启动 cleanup-only 的全局判定：不通过。** 观察到上述独立 startup `daily_scan`（不是 manager child）；因此不能把“启动后没有任何新任务”写成通过。该独立扫描已于 `11:50:18.510Z` partial 终止，安装版在 `12:00:19.775Z` 读回时池和 live jobs 均为空，且自 Post 2 后没有新的 manager/daily task。

### 历史 partial package 启动与正常业务控制（已由上方成功安装版证据 supersede）

- 使用同一 data root `J:/PigeonYang/WeMediaBuddyData` 启动 partial package 的清理-only 场景，并通过 `--remote-debugging-port=9322` 连接 Browser CDP；观察到进程 `WeMediaBuddy.exe` PID `684280`，页面为 `file:///J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar/.vite/renderer/main_window/index.html`。
- 启动前只读基线（`2026-08-29T10:16:09.241Z`）：`source_items=5644`、`research_claims=437`、`content_versions=545`；manager `52968c9f-3291-47cc-b606-d57f170a76e5` 为 `running/monitor_reporter`，checkpoint children 共 311，状态为 `succeeded=125`、`failed=185`、`running=1`。
- 先调用正常业务 IPC：`window.wmb.controlDailyIntelligence({ id: "52968c9f-3291-47cc-b606-d57f170a76e5", action: "cancel" })`，调用时间 `2026-08-29T10:25:51.240Z`，返回 `ok=true`；但返回快照已是 `status=interrupted`、`phase=interrupted`、`errorCode=INTERRUPTED`（“应用重启时任务仍在运行”），没有转成严格验收要求的 `cancelled`/`failed`。
- 随后仅针对同一 run 的 reporter child 调用 `window.wmb.jobsCancel("plan-item-1217fd6f-7b1d-4912-a3ac-cdf1b4eb6ba5-reporter")`（`2026-08-29T10:26:06.821Z`）；正常 jobs 池返回 `null`、无异常，说明没有可用的 live job handle。随后对其唯一可定位的 task `1475998a-3171-43b0-af4b-b7113cb4791d` 调用正常 `window.wmb.cancelAgentTask(...)`（`2026-08-29T10:27:43.943Z`），返回 `ok=true`、`status=cancelled`、`phase=cancelled`、`errorCode=CANCELLED`。没有 kill 进程，没有直接写 DB。
- fallback packaged runtime 的两次 `window.wmb.jobsPoolStatus()` 都解析为 `maxWorkers=5`、`running=0`、`queued=0`、`waitingResource=0`；这证明 partial package 的运行时容量为 5，但不等同于 installed build 验收。

### 两次取消后读回

| 读回 | 时间（UTC） | source / claims / versions | manager 行 | checkpoint active/queued child | child task | 新增 dispatch 读回 | 进程/池状态 |
|---|---|---|---|---|---|---|---|
| Post-cancel 1 | `2026-08-29T10:28:06.127Z` | `5644 / 437 / 545`，与基线相同 | `interrupted/interrupted`，`finished_at=10:16:36.036Z` | `1`：reporter，job `plan-item-1217…`，checkpoint 仍记 `running` | `cancelled/cancelled` | child cancel 后无新增 `agent_tasks` 或 `jobs` | PID `684280` 存活；9322 `Listen`；app shell 可见；`5/0/0/0` |
| Post-cancel 2 | `2026-08-29T10:29:34.874Z` | `5644 / 437 / 545`，与 Post 1 相同 | `interrupted/interrupted`，未再变化 | 仍为同一 `1` 个 stale `running` checkpoint child | 仍为 `cancelled/cancelled` | Post 1 至 Post 2 无新增 `agent_tasks` 或 `jobs`；自 child cancel 起也无新增 | PID `684280` 存活；9322 `Listen`；app shell 可见；`5/0/0/0` |

- 启动 delta 的可解释部分：从 `jobsCancel` 调用后到 child task 正常取消前的窗口 `2026-08-29T10:26:06.821Z..10:27:43.943Z` 新建 45 条 `jobs.kind=media_archive,status=pending`；没有新建 `agent_tasks`。child task 取消后直到第二次读回没有新增 `agent_tasks` 或 `jobs`。因此没有观察到新的 manager reporter child dispatch，但不能把“manager cancel 时刻之后所有 jobs 都为零”写成通过；上述 45 条是启动恢复期间的非 manager `media_archive` delta。
- 数据保全：两次读回的 `source_items`、`research_claims`、`content_versions` 均与启动前 `5644/437/545` 完全一致；没有执行 seed、reset、delete、deduplicate、publish 或 DB 直接变更。

### 历史 partial package 严格验收判定（不作为最终部署判定）

- **构建/安装：未通过。** Squirrel maker 因磁盘空间不足失败，没有 Setup.exe，也没有 per-user installed executable/app.asar；仅有 partial package 直接运行证据。
- **运行时容量：通过（限定 partial package）。** 两次 live IPC 读回均为 `maxWorkers=5` 且池空闲。
- **应用存活/空闲：通过（限定 partial package）。** 两次读回均有 PID `684280`、9322 listener、app shell，且 `running=queued=waitingResource=0`。
- **数据保全：通过。** 三个业务表计数两次均未变。
- **严格取消/child 收敛：未通过，不能声称 clean cancellation。** manager 已在启动恢复时变为 terminal-like `interrupted`，正常 cancel 返回既有快照而没有 `cancelled`/`failed`；manager checkpoint 仍保留 1 个 `running` reporter child，尽管可定位 child task 已经正常取消。由于普通业务路径没有把 stale checkpoint 清成零，本次在安全点停止，未 kill、未改 DB、未重启新 run。
