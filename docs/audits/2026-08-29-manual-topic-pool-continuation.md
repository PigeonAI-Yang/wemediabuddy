# WeMediaBuddy「继续更新选题池」手动门槛审计

- 审计日期：2026-08-29
- 范围：Today renderer、每日情报 IPC/manager/scan→judge 编排、研究 successor、当前只读 DB
- 结论级别：已确认根因；不改代码、不改 DB、不点击 UI

## 一、结论先行

**当前按钮不是“批准选题”，也不是对同一个 Reporter 任务的真正 resume。** 它是 Today 页把一个终态 `partial` 任务重新送入 `startDailyIntelligence` 的通用入口。当前安装代码的默认入口是 **manager-first**：按钮请求先进入主管任务编排；主管可以再选择 `stage=scan`、`stage=judge`、`stage=full` 或 `wmb_continue_after_scan`。只有显式 `legacyPipeline: true` 或 manager 分发失败后的兼容回退，才进入 `daily-start-gate` 的旧路径，由 `partial → start_judge_only`。

**为什么 570 条资料后仍是 0 个机会：** 当前日期没有 `plans`、没有 `plan_items`，也没有已完成的当日 `daily_judge` 投影；Today 的机会列表不是直接从 `source_items` 或 `topics` 生成，而是从计划项经过 `today-recommendation` 过滤得到。570 只证明资料库存存在，不证明 planner/judge 已经写入方案。

**手动门槛的性质：** partial 终态要求人决定是否继续，作为“停止无限重试、避免继续消耗模型/渠道资源”的安全政策是有意的；但把“已有可用资料、没有活动中的 judge、只是未完成的 scan→judge 交接”也一律留给 owner 点击，是错误的恢复边界。当前场景没有待批准的候选方案，因此**不需要业务审批**；需要的是一个受限、幂等、只执行一次的自动 judge handoff。

## 二、截图状态与 Today 视图的精确对应

### 1. partial 文案和按钮

`src/renderer/today-run-view.ts:567-610`：

- 只有 `step === 'partial'` 且 `input.opportunityCount === 0` 时，返回：
  - `headline: '资料已入库，选题池还没更新完'`
  - `primaryCta: { kind: 'continue', label: '继续更新选题池' }`
  - `showOpportunityEmpty: true`
  - `opportunityEmptyBody` 明确说点击后“接着完成增量判断”。
- 同一函数在 `opportunityCount > 0` 时把 partial 降级展示为已有可批选题；所以截图中的 0 不是文案误判，而是该分支确实收到 0 个可展示机会。
- `src/renderer/today-run-view.ts:550-564` 的 `needs_user` 分支才是“选题已经生成、等待你确认”的业务审批态；其 CTA 是 `open_manager`，不是本次的 `continue`。
- `src/renderer/today-run-view.ts:613-628` 对 `MANAGER_WAITING_APPROVAL` 有独立文案，进一步证明本次 partial CTA 不等于 owner 批准候选题。

### 2. 点击语义

`src/renderer/today-view.tsx:458-521` 的 `startIntelligence`：

1. 防止已有运行或重复点击；
2. 先把 Today 本地状态乐观地置为 running；
3. 计算 Shanghai business date；
4. 调用 `window.wmb.startDailyIntelligence({ businessDate })`；本调用没有传 `taskId`、receiptIds 或 resume token；
5. 收到 manager `focus_existing` 时只聚焦已有主管任务，否则刷新 Today。

`src/renderer/today-view.tsx:523-540`：

- primary CTA 不是 `open_manager`/`open_studio` 时，最终都走 `startIntelligence()`；
- secondary id 为 `continue` 时也走同一个 `startIntelligence()`。

所以“继续更新选题池”在 UI 上只是**重新发起每日情报入口**，不是“继续这个 partial Reporter task”的专用按钮。partial 分支没有 `confirm` 字段，故没有业务确认对话框。

## 三、IPC 与当前安装路径

### 1. preload 契约

`src/preload/preload.ts:451-454`：

```ts
startDailyIntelligence: (input: {
  businessDate: string;
  modules?: Array<'official_web' | 'x_lists' | 'zhihu_hot'>;
  legacyPipeline?: boolean
}) => ipcRenderer.invoke('agent:start-daily-intelligence', input)
```

renderer 只传 `businessDate`，因此 `legacyPipeline` 默认未开启。

### 2. 默认 manager-first

`src/main/index.ts:1059-1126` 的 `agent:start-daily-intelligence` handler 在当前安装代码中先走 manager 日情报分发；`legacyPipeline` 是显式兼容 escape hatch。manager dispatch 的安全提示构造在 `src/main/manager-dispatch.ts:84-119`：主管可以选择：

- `wmb_run_daily_stage(stage=scan)` / reporter；
- `wmb_run_daily_stage(stage=judge)` / planner；
- `wmb_run_daily_stage(stage=full)`；
- `wmb_continue_after_scan`。

这条默认路径会创建或聚焦主管任务，**不会由 renderer 直接指定 judge-only**。因此点击按钮后“新 manager run / focus existing”才是当前实际语义；是否随后跑 judge 取决于主管编排和 manager runtime。

### 3. legacy/fallback 的 judge-only 语义

`src/main/index.ts:1127-1212` 是旧管线/回退分支：

- 读取 active/latest 当日任务并调用 `decideDailyStartGate`；
- active 运行时返回 active；孤儿 running 先 partial 收尸；
- `gate.action === 'start_judge_only'` 时设置 `judgeOnly: true`，以 planner 身份调用 `startWorkspaceDailyIntelligence`；
- 用 `tryAcquireDailyStageLock` 保护 scan/judge 阶段，结束后释放锁。

`daily-start-gate` 的核心决策是：已有可用的 partial/latest 扫描结果时，不重新扫描而建议 judge-only；但这只在该旧入口被调用时成立，不是当前 renderer 点击本身的直接 IPC 语义。

## 四、自动链路与断点

### 1. 正常 scan→judge

`src/main/daily-intelligence-channels.ts:138-178`：

- judge 正在 judging/synthesizing/validating 时，新的扫描被拒绝/延后为 `JUDGE_IN_FLIGHT`，防止 source revision 被并发写顶；
- 已复用的任务只有在 `phase === 'channel_scanned'` 时才返回 `shouldRunJudgment: true`；`resume_pending` 也必须已有足量 receipts；
- 其它复用状态不会自动跳到 judge。

`src/main/daily-intelligence-channels.ts:299-322`：完整扫描结束时聚合 receipts，写入 `phase: channel_scanned`、`planned/processed/failed/saved`，再返回 `shouldRunJudgment: true`。观察到的今日任务终态却是 `phase: partial`，说明该次运行没有把可供 `continue_after_scan` 消费的 `channel_scanned` 节点持久化为当前活动节点。

### 2. `continue_after_scan` 并非任意 partial resume

`src/main/manager-orchestration.ts:124-173`：

- 只取 `getActiveDailyIntelligenceTask`，即活动任务；
- 只有 `phase === 'channel_scanned'` 或匹配 `channel_scanned|ready_for_judge` 才可续；
- running 且不在该节点时直接返回“尚未到可续接节点”；
- 通过后才创建 `stage: 'judge'` 的 manager stage。

因此当前 terminal `partial` 任务不能被这个函数原地恢复。按钮点击的实际效果是让 manager/旧回退**新建一个 judge 方向的执行**，而非把原 Reporter 从中断点接上。

### 3. DailyScanScheduler 的自动 handoff 限制

启动时 `DailyScanScheduler` 的 `onNewSources(savedCount > 0)` 会在有本次扫描新增资料时尝试自动 judge；scheduler 维护 in-flight/judge-running 保护，且阶段锁防止重复 scan/judge。这个判断使用的是**该次 scan 的 savedCount**，不是 Today 页面展示的全库存数。

当前 DB 观察到的最新 daily scan `saved=0`/partial，故不会触发这个自动 handoff；即使窗口内存在 570 条历史/其它批次资料，也不会把全局库存倒推成一次新的 `onNewSources` 事件。`savedCount=0` 的 partial 保留人工 CTA，符合防循环设计；问题在于有资料由其他生产者/先前批次写入而没有新的 handoff 事件时，系统没有第二个受控补偿边界。

### 4. Reporter / research successor 是另一条链

`src/main/research-successor.ts` 与 `src/main/agent-runner.ts` 的 successor 逻辑只处理已有研究任务的 EvidencePack、evidence gap、narrow/supplement/accept 决策，并有请求去重、attempt 上限及 failed/cancelled 不继续的限制。当前 DB 的 `research_successor` 只有历史 succeeded/failed，没有 pending/running/needs_user successor。

当前 `agent_tasks` 中大量 `intent=research` 的 partial/failed 是内容项目/计划项研究任务，不等同于 Today 的 `daily_judge`。截图右侧 Reporter 的 `partial/PARTIAL` 卡可以是真实的研究/记者部分结果，但它不构成“已产生候选题、等待 owner 批准”；研究证据待决策与 Today scan→judge handoff 必须分开。

## 五、当前只读 DB 对账

口径：Today 使用 Shanghai 日期；资料窗口为 `2026-08-28T16:00:00.000Z` 至 `2026-08-29T15:59:59.999Z`，并排除 `management_status='archived'`。

| 对象 | 当前观测 | 对截图的含义 |
|---|---:|---|
| `source_items` | 570 条；distinct id/canonical/original 均为 570；均为 active | 570 是资料库存，不是机会数 |
| `plans`（`plan_date=2026-08-29`） | 0；current plan 0 | 没有当日方案容器 |
| `plan_items`（上述 plans） | 0 | 没有任何可供 Today 展示/审批的候选题 |
| `recommendations` | 当前 schema 查询返回 `no such table` | 不是缺一张 recommendations 表；Today 用的是派生 recommendation projection |
| `topics`（当日窗口） | 8 条，状态为 `active`；`candidate/approved/pending` active-like 为 0 | topic library 记录不等于当日 plan item，不会直接填 Today 机会池 |
| `daily_content_cycles` | 当日有 partial，`plan_id=NULL`，`target_count=2`，`last_error_code=CANDIDATE_SHORTAGE` | 目标循环没有落出方案，和 0 opportunities 一致 |
| 当日 `agent_tasks` | 9 个 `daily_scan` 为 partial；没有当日 `daily_judge` | scan 终态没有完成当前日期的 judge 投影 |
| 最新 `daily_scan` | `05d2370f…`，`partial/partial`，`CHANNEL_SCAN_FAILED`，本次 saved=0 | 不满足 scheduler 的 `savedCount>0` 自动 handoff 条件 |
| 最新 `daily_judge` | `92b18bc…` 为历史日期的 partial；不是当前日期完成的 judge | 不能为 2026-08-29 生成 plan |
| 当日 manager/page_agents | 最新为 cancelled，无 live manager coordinator | 当前没有主管运行可自动接管此 partial |
| source scan receipts | 当前聚合可见 `x_lists` failed 49、needs_user 1、`zhihu_hot` succeeded 2 | 渠道有失败/缺席，但不能把失败 receipt 自动当成已完成方案 |
| `research_successor` jobs | 6 failed、2 succeeded；无 pending/running/needs_user | 没有待 owner 决策的 successor 在等待填充 Today |

**零机会的直接根因判定：**

1. 不是 `plan_items` 被 Today 的 status filter 全过滤：因为根本没有当日 plan/plan_items；
2. 不是“有 judge 但 projection stale”：当日没有 judge；
3. 不是缺少 `recommendations` 表：该表不是当前实现的持久化来源；
4. 是 scan partial/终态 saved=0 + 没有自动 handoff，随后 planner 没有写入当日 plan。

`src/main/workbench.ts:116-145, 243-259` 负责读取 plans/plan_items 和 Today 投影；`src/main/today-recommendation.ts` 的候选收集/去重/状态过滤最终返回 `eligible=[]`。所以 UI 的 `opportunityCount=0` 与 DB 是一致的，而不是单纯前端 stale cache。

## 六、三种 gate 的边界判定

### A. owner 业务审批：本场景不成立

真正的 owner approval 是已有方案项之后的 `needs_user`/`MANAGER_WAITING_APPROVAL`：Today 会显示“选题池已更新，等待你确认”，CTA 为打开 manager/proposals。当前 `plans=0`、`plan_items=0`，没有任何 proposed topic 可批准；所以不能把截图中的“继续更新选题池”解释成业务审批。

### B. partial 安全/重试 gate：有意存在

partial 会保存已入库资料、终止不可靠或被控制的 worker，并保留显式继续入口；阶段锁、active-judge 检查、receipt 去重及 successor attempt 上限都在防止“失败→自动无限重跑→重复写入/重复花费”。这一层政策是合理的。

### C. 未完成自动工作的 continuation：当前边界过宽

当满足“本次/可信来源边界内有可用资料、无 active judge、无 pending approval、没有重复 handoff”时，scan→judge 是确定性的内部交接，不是需要 owner 决策的业务动作。当前系统只在 scheduler 看见本次 `savedCount>0` 时自动交接；对 terminal partial 或其它生产者已写入的资料没有受控补偿，于是把可安全恢复的动作暴露成 owner 必须点击。

**最终分类：安全政策本身有意；本场景的 manual gate 是错误的 recovery boundary/accidental coupling，不是业务审批。**

## 七、最小正确修复契约（只提议，不实施）

修复应在后端 handoff 层，不是把 Today 的按钮偷偷改成自动点击，也不应删除 partial 安全态。

1. **触发点**：在 daily scan 终态聚合 receipts 后，或在 source commit 发出同一可追踪事件后，计算本次 task 的 `savedCount`、可用 source IDs 与 receipt 边界。
2. **自动条件**：`savedCount > 0` 且至少一个 source 可供 judge；无 active `daily_judge/daily_intelligence`；无 `MANAGER_WAITING_APPROVAL`；无活动 manager stage 冲突；当前 scan task 尚未进行过自动 handoff。
3. **执行动作**：只做一次 judge handoff。若任务仍为 `channel_scanned/ready_for_judge`，复用现有 `continueAfterScan`/stage=judge；若已是 terminal `partial`，使用显式 `fromTaskId + receipt/source snapshot` 的 judge-only 入口，不重新 scan，也不声称原 task 已原地 resume。
4. **持久幂等**：以 `businessDate + scanTaskId`（再绑定 source snapshot/revision）写入 command receipt 或等价持久 dedupe key；跨重启也只能自动尝试一次。保留现有 stage lock/in-flight guard 作为并发保护，而不是唯一去重依据。
5. **保留人工 gate**：`savedCount=0`、只有 failed/needs_user 来源、judge 已在运行、manager 正在等待批准、source snapshot 无法证明可用、或一次自动 handoff 已失败且没有新进展时，保持 partial 并要求 owner 继续/处理原因；不得自动循环。
6. **保持业务审批**：只有在 plan items 已生成且进入 `ready_for_review`/`MANAGER_WAITING_APPROVAL`，或 research successor 明确处于 evidence-gap 需要人选 narrow/supplement/accept 时，才要求 owner 决策。
7. **UI 语义**：自动 handoff 成功后 Today 应进入 judging/完成态；只有上述安全阻塞才继续显示“资料已入库，选题池还没更新完”。不要用“570”全库存数替代本次 source boundary。

建议涉及边界：`daily-scan-scheduler` 的 `onNewSources`/handoff、scan terminalization（`daily-intelligence-channels`/runner）、`manager-orchestration`/`daily-start-gate` 的 judge-only 入口及持久 dedupe。**不需要改 topics 表，不需要新增 recommendations 表，不需要削弱 owner approval。**

## 八、唯一强验证场景

1. 构造一个 `daily_scan` 已终态 partial、receipt 有 `savedCount>0`、无 active judge、无当日 plan 的状态；启动/刷新 scheduler，不点击 Today 按钮。
2. 断言只创建一次 judge handoff（同一 `businessDate + scanTaskId` 重复事件、刷新、重启都不再创建第二次），且不重新 scan。
3. 断言 planner 成功后 `plans` 与 `plan_items` 写入，Today 从 `partial/0` 变为 judging 或有机会；owner 没有点击“继续更新选题池”。
4. 对照组：`savedCount=0` 或全是 failed/needs_user 时仍为 partial；active judge、pending approval、自动 handoff 已尝试时不自动再开任务。
5. 另验 research successor 的 needs_user/failed/cancelled 不会被这条 Today handoff 越权吞掉。

## 九、审计收束

- **按钮语义**：通用 `startDailyIntelligence` 重入口；默认 manager-first，非原 task resume，非 owner approval。
- **确认根因**：最新 scan partial/saved=0，未进入可消费的 `channel_scanned` handoff；当日无 judge/plan/plan_items；Today 的 `eligible` 因此为空。
- **DB 对账**：570 active sources 与 0 plan_items 可以同时成立；570 不等于 570 个 topic opportunities。
- **manual approval**：当前 Today pool 不需要业务审批；partial 安全 gate 有意，但对“已有可用资料、无 judge”的恢复覆盖过宽。
- **repair boundary**：新增一次性、持久幂等、source-bound 的自动 judge handoff；保留无进展 partial 和真正的 owner/research 决策门。
