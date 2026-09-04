# 2026-08-24 日情报 `items=[]` / “今天没有新的内容机会” 根因追踪 — Wan 3.0 为例

> **只读核查，不改库/不重跑/不发布。业务日 2026-08-24，数据根 `J:/PigeonYang/WeMediaBuddyData/wmb.db` + `pi-agent/sessions/*.jsonl`。**

## 摘要（Primary Root Cause）

`items=[]` 并非“编辑判定拒绝 Wan 3.0”，而是 **先空写成功推进水印 → 后多机会写回被校验与幂等拦截 → 终态空方案被当成功投影** 的级联失败。

- **主因**：`e9743b55-251a-470f-9400-ff313e5288e2`（12:44-12:49）在源 revision 冲突两次后，降级保存了 **空 `plan` (`bf6c3c21`)** 并以 `succeeded/ completed` 推进了 `judgeWatermark=2026-08-24T12:45:16.606Z`。该水印把已入库的全部 Wan 3.0（`collected_at ~11:02:49`）永久排除出后续增量窗口（`collected_at > watermark`），导致 13:47 与 15:31 两轮真正的机会判定已看不到 Wan。
- **次因叠加**：`0451ecaa-6302-42a5-ab42-c86145068598`（13:47）在 `gateProcessed=20` 内确实生成了 **4 条可批机会**（`verified=4, opportunityCount=4`），但 `plans.save` 因新增 `scoreReasons_required` 校验连续三次失败，又因 **同一 `requestId` 复用不同 `inputHash` 复试**触发 `CommandDispatcher:190-191 → REQUEST_REPLAY_CONFLICT "同一 requestId 已绑定不同命令或输入。"`（`DAILY_INTELLIGENCE_FAILED`），整轮 `partial` 无落库。
- **终态误投影**：最终 `is_current=1` 的 `plan 45667dd7`（`21b3c3b9` 15:37 `succeeded`）与 `1544a508`（`76c151ea` 15:32 `succeeded`）均为 **水印后 17/27 条视角下的空方案**（仅剩知乎“Deepseek 能为我做什么？”一条但缺正文，无法过四问）。`getToday()` 与 `deriveTodayRunView()` 据 `opportunityCount==0 + status==succeeded` 走 `done 零机会` 分支，渲染 `today-run-view.ts:534` 文案“今天没有新的内容机会”。该文案对真实终态 **不真实**：真实终态是“有 4 机会未落库 + 1 轮空写抢占水印 + 档案中仍有 5 机会的未提交草稿（`b480`）”。

---

## 1. 单条 Wan 端到端追踪（信源真值）

选 **可视列表顶部可见**的 `@Alibaba_Wan` 代表项，其它 12 条同通道同判定：

| 字段 | 值 |
|---|---|
| **id** | `153162be-6b20-49ea-8c17-a2fc18fafe4d` |
| **author / account** | `@Alibaba_Wan`（`X List · AI前沿`，`listId 2082851520417255750`） |
| **title** | `Wan 3.0 is now live on @runware! One model for text-to-video, frame, and reference modes—with native 30-second generation and powerful multi-input capabilities. Create now ↓` |
| **published_at** | `2026-08-24T09:03:18.000Z` |
| **collected_at** | `2026-08-24T11:02:49.202Z` |
| **canonical_url** | `https://x.com/Alibaba_Wan/status/2091813588302503969` |
| **feed_id** | `88449ada-afb7-407e-a5c9-8b1c68ed9ebc` |
| **source_items.verification_status** | `pending` |
| **management_status** | `active`（未 `archived`） |
| **provenance** | `source_scan_receipts`：`task 76c151ea` 中 `X List AI前沿` `candidate 32 / saved 20`；同刻其它 Wan 5 条亦 `saved`。`pi-agent/sessions` 增量简报中 `b480` 与 `e9743` 均 `Wan 40` 次命中（prompt 明文含该 id） |

同日同通道其余可见项（采样，全部 `active/pending` 且 `relevant`）：

- `6b3885cc-1c43-46c2-b5a1-1da2db47d1f1` `@alibaba_cloud` `2026-08-24T07:52:10Z` / `11:02:49.209Z` `Wan3.0 is on @Segmind_ai`
- `9fe825ef-413a-460c-9585-faf1fbfd9030` `@alibaba_cloud` `07:53:27Z` `Nadou Pro`
- `dd164225-b414-4f05-b11c-e353805da25a` `07:56:03Z` `AskVenice`
- `92662d1c-5a58-47b7-b644-9c26b160be1b` `08:38:35Z` `runware D0`
- `dfd1a119-2d24-42b1-8f36-fd4423db7174` `@Alibaba_Wan` `09:06:11Z` `SeaArt`
- `a0ec2920-b882-4e85-b33e-ad1d81373975` `09:53:20Z` `Scenario_gg` 等，共 13 条在 `11:03:03.614Z` 同批 `Tier0 relevant`，见 §3

---

## 2. 候选输入（`105/100/60` 与截断）

- **扫描回执（`source_scan_receipts`）**：`76c151ea` 6 源 `candidate 114 / saved 106`（5 × X List `20` + `zhihu_hot 6`），`0451ecaa` 5 源 `108/100`，`b480` 5 源。Manager `55fe6cb7` `progress.saved=105` 为去重后口径，与 106 差 1 为 `canonical_url` 去重，符合“105-source run input”描述。
- **增量窗口定义**：`assembleEditorialBrief()` `increment since = watermark ?? now-24h`，`LIMIT 60` 最新优先，`management_status != 'archived'`。**文件** `src/main/editorial-brief.ts: since` 与 `src/main/lane-gate.ts:275-282 listLaneGateCandidates` 同窗口。
- **水印演进**：`readLatestJudgeWatermark()` 读 `agent_tasks.checkpoint_json like '%judgeWatermark%'`；`buildDailyGateRun()` / `buildDailyOpportunityPrompt()` 均先 `resolveJudgeWatermark()`。**文件** `src/main/agent-tasks.ts:223-235`，`src/main/agent-runner.ts:387-410`。
  - `b480 12:18` 与 `e9743 12:44` 的 `since = 2026-08-23T17:58:50.209Z`（上一次 `a43f3459 succeeded` 的水印），故 `increment 共 60 已截断` 且 **含 Wan**（`b480 prompt Wan 40，含 153162be`）。
  - `e9743 succeeded` 后 `checkpoint.judgeWatermark = 2026-08-24T12:45:16.606Z`（`agent-runner.ts:727`）。
  - `0451 13:47` `increment 共 27`（`since 12:45`）**不含 Wan**（Wan `11:02 < 12:45` 被窗口外）。
  - `76c151ea 15:31` `increment 共 17`（同水印）**不含 Wan**；`21b3c3b9 15:37` 同理。

结论：**首轮候选输入未缺 Wan，后轮被水印截掉**。非渠道/时间过滤（X List 均 `succeeded`），非 dedup（Wan 未去重），非 `archived` 状态过滤。

---

## 3. 各关卡判定（lane gate → 四问）

- **Lane Gate Tier0**：`isTier0AutoRelevantSource()` 对官方/赛道精选源直判 `relevant / official_source`。`11:03:03.614Z` 批判 60 条中，13 条 Wan 全部 `relevant/official_source/system`（`source_lane_judgments` 可查，例 `153162be relevant official_source`）。**文件** `src/main/lane-gate.ts:258-269`。
  - 7 日冷却 `shouldSkipJudgment()` 使后续 `buildDailyGateRun()` 中 Wan 进入 `autoRelevant` 但不在 `pending` 重判，故 `0451` 的 `pending 20` 不含 Wan，仅 `gateProcessed 20` 为非官方增量的 `pending` 数，Wan 在 `relevantIds` 池但未被后续四问利用因子窗口被清空。
- **四问机会生成**（Pi 侧）：
  - `b480` 因 `REVISION_CONFLICT` 首写被拒，helper 提示“按真实 revision 重提”，但会话仅 2 条 assistant 文本、**0 个 ```json 围栏**，未产出 gate/plan，任务 `partial / saved 0 / verified 5 / opportunityCount 5` 悬挂，未写 `judgeWatermark`。证据：`J:/Pioneer.../sessions/daily-2026-08-24-b480e05e...jsonl`。
  - `e9743` 启动 16 条 `pending` 四问，`agent-runner.ts:718 applyDailyLaneGate` 因 `source revision conflict` 两次 `REVISION_CONFLICT`（`pi` 调 `sources.lane_gate`），编排层降级保存 **空 plan `bf6c3c21` summary="…source revision conflict 两次…未安全写回"**，`opportunityCount 0`，`succeeded`。
  - `0451` 在 **窗口外** 的 27 条上完成 `gate: relevant 9 / irrelevant 18`（`session gate` 明细），再产出 **4 条可批 items**（`plan summary="…把 AI 从一次性提示词推进到可复现规程…；WMB 方案写回因服务端要求未暴露的 scoreReasons 字段失败，当前未落库。"`），全部含 `scoreReasons` 缺失触发 **持久化失败**（下一节）。
  - `76c151ea / 21b3c3b9` 在 17/1 条窗口下仅剩知乎 Deepseek 单问，仅标题无正文，`系统判定 relevant 但 “缺少问题正文、具体场景和可验证案例，无法回答四问”`，故 **空方案 `1544a508 / 45667dd7` succeeded**（`todayView` 将其作“零机会有效结果”）。

---

## 4. 管理器/任务收据精确错误与时序（request replay）

| 任务 | intent | 时间 (created→finished) | status/phase/error | progress | 计划写回 | 关键事件 |
|---|---|---|---|---|---|---|
| `b480e05e-e577-48a2-95ed-9fbc20adf5b0` | `daily_judge` | 12:17:36 → 12:38:58 | `partial/partial / None` | `saved 0, verified 5, opportunityCount 5` | `0`（未发 `plans.save`） | `赛道门已完成，已查询 5 个候选主题…准备保存` 后悬挂；会话仅 revision 冲突提示 |
| `e9743b55-251a-470f-9400-ff313e5288e2` | `daily_judge` | 12:44:01 → 12:49:11 | `succeeded/completed / None` | `planned 16, processed 0, failed 16, saved 0, verified 0` | `plan bf6c3c21 空` `ok` `requestId e9743b55:plan` (`command_receipts c3041e04 ok`) | `开始逐条判定 16 条 → 两次 REVISION_CONFLICT → 方案已保存：今日没有合格机会。` **此后水印 12:45** |
| `0451ecaa-6302-42a5-ab42-c86145068598` | `daily_judge` | 13:47:09 → 13:53:24 | `partial/partial / DAILY_INTELLIGENCE_FAILED` `errorMessage="同一 requestId 已绑定不同命令或输入。"` | `saved 0, verified 4, opportunityCount 4, currentSource plans.save` | `3 次 error` `0451ecaa:plan / :plan:v2 / :plan:v3` 均 `validation_failed: scoreReasons_required` (`receipt d83a94c8, b5c243b6, b3474c15`)，随即 `partial` 归因于 replay | `完成20条逐条判定，形成4条可批机会 → plans.save 连续三次 scoreReasons_required 未写入 → 综合整理失败：同一 requestId…` **机会生成在失败之前** |
| `55fe6cb7-78fd-4074-a280-17a358275771` | `page_agents` (manager) | 15:18:11 → running/report | `running/report / None` `progress saved 105, verified 6, planned 6, processed 6` `message="今日情报·策划生成方案1/1·综合整理失败，保留已扫描结果：同一 requestId 已绑定不同命令或输入。·需要你回今日批准"` | — | — | 15:33:31 `完整编排已完成：可信渠道回执齐全；当日方案为空，原因是唯一相关线索证据不足。` 15:38:24 `验收达成：可信渠道回执齐全，当日方案已写入（空方案）；仅综合整理收尾阶段 partial。` |
| `76c151ea-68ab-4635-90fc-a0840beaa58d` | `daily_judge` | 15:31:13 → 15:32:24 | `succeeded/completed` | `saved 100` | `plan 1544a508 空` `ok` (`8cd9d576`) | `方案已保存：今日没有合格机会。` 窗口 17 条 |
| `21b3c3b9-b969-4de8-8159-5c4f5b5d4034` | `daily_judge` | 15:35:17 → 15:37:31 | `partial/partial / DAILY_INTELLIGENCE_FAILED` 同 replay | `saved 1, verified 1, opportunityCount 0` | `plan 45667dd7 空` `ok` (`ad237aa1`) | `唯一增量资料与赛道相关，但仅有问题标题…不形成机会 → 今日判断完成，已保存空方案 → 综合整理失败：同一 requestId…`（plan 已写，partial 仅为综合整理收尾） |

**`command-dispatcher.ts:190-193` / `x-list-command.ts:187-189` / `publication-commands.ts:151-153`** 为 `REQUEST_REPLAY_CONFLICT` 唯一抛出点；`0451` 的四条 `command_receipts`（`d83a94c8` 等）先 `validation_failed`，后同 `requestId` 不同 `inputHash`（`4f2223…` vs `e3dd32…` vs `65a9a6…`）复试直接命中该 guard。**失败发生在机会生成之后、持久化之时**。

`plans` 终态（业务日 2026-08-24，`updated_at` 序）：`1f098325`（23 日 18:00, 空, 0）→ `bf6c3c21`（12:49 空, revision-conflict）→ `1544a508`（15:32 空）→ `45667dd7`（15:37 空, **is_current=1**）。四份 `planItems 0`。

---

## 5. `items=[]` 是否编辑拒绝 / UI 文案是否真实

- **非编辑拒绝**：Wan 13 条在唯一一次可达到的机会生成窗口（`b480`）中 **被 Tier0 判 relevant 且曾进入增量简报增量 60**，未被 `off_lane_content / ad_promotion` 等驳回；`0451` 的 4 机会也非拒绝 Wan 而是 **窗口外 + 校验拦截**。
- **非 empty editorial rejection**：`e9743` 的空是 **revision conflict 降级**，`76c151ea/21b3c3b9` 的空是 **水印后极小窗口的文本不足**，均在 `command_receipts` 与 `events_json` 有明文，而非四问 scored 后判 `0-100` 低分拒绝。
- **`items=[]` 是不完全/失败运行被投影为成功**：最新 `succeeded` 空方案掩盖了 `0451 partial` 的 4 机会草稿（`plan summary` 自述“未落库”）与 `b480 partial` 的 5 机会未保存态。**UI 不应说“没有机会”**。
  - **应有状态**：`deriveTodayRunView` 对 `status partial/failed` 且 `!hasDeliveredPlan` 应走 `failed`/`partial` 分支（`today-run-view.ts:413-498`：`资料已入库，选题池还没更新完` / `今日情报未完成`），而非 `done 零机会` 的 `today-run-view.ts:520-537`。`mapTaskToStep():138-159` 将 `succeeded` 直接对 `done`，使空写 `succeeded` 劫持了 `partial` 的可见性。
  - 当前 `getToday()` 仅选 `is_current=1` 空 plan，未与 `agent_tasks` 终态与 `command_receipts.error` 交叉；`filterApprovedItems` / `latestPlanItemRowsByDate` 对空 plan 无过滤效果，台账层面也 `empty`。
  - Manager 任务 `55fe6cb7` 已明式 `partial` 与文案 `综合整理失败…同一 requestId…`，但 `Today` 顶部 `statusLine` 仍取空 plan 的 `summary`，未透出 `partial` 原因。

---

## 6. 行级判定点（精确断点）

- **候选截口**：`src/main/editorial-brief.ts` `assembleEditorialBrief` `since = watermark …` / `incrementRows WHERE collected_at > ? LIMIT 61`；`src/main/lane-gate.ts:275-282` `listLaneGateCandidates`；`src/main/agent-runner.ts:387-411` `resolveJudgeWatermark / buildDailyGateRun`。
- **水印推进**：`src/main/agent-runner.ts:726-727` `dispatchReportAgentTaskProgress({ checkpoint: { judgeWatermark: promptBuiltAt }})` 仅两关成功才应推进，当前 `e9743` 在 gate 冲突后仍以空写推进。
- **Tier0/冷却**：`src/main/lane-gate.ts:237-246 shouldSkipJudgment`（7d），`258-269 isTier0AutoRelevantSource`。
- **四问校验**：`src/main/planning-stage.ts:106-130 validateScoredReasons`（`scoreReasons_required / six_required / criteria_invalid`），`169-205 validatePlanItemForReview`；`src/main/planning.ts:39-54 saveCurrentPlan` 质量门“整批不写”。
- **幂等 guard**：`src/main/command-dispatcher.ts:190-191` `REQUEST_REPLAY_CONFLICT`，`src/main/x-list-command.ts:187-189` 同 guard；`pi` 复试用同 `planRequestId=agentRequestId(task.id,'plan')`（`agent-runner.ts:687`）导致 `inputHash` 变更即冲突。
- **投影**：`src/main/workbench.ts:132-144 loadLatestNonEmptyPlan`（空 current 不兜底逻辑存在但 `b480/0451` 未写库故无兜底）、`src/renderer/today-run-view.ts:138-159 mapTaskToStep`、`520-537 done 零机会` vs `413-456 partial` / `477-498 failed`，`src/renderer/today-view.tsx` `isManagerNonterminal` 优先但回退到 `daily_judge succeeded` 即视空为完成。

---

## 7. 边界归属判定

- **Wan sources absent from candidate input**：**后轮为真，前轮为假**。前轮（≤12:44）`present`；后轮（≥13:47）`absent` 因水印。
- **filtered by channel/time/dedup/topic/status**：**否**。通道 `succeeded`，`management_status active`，`verification pending` 未过滤，`dedup` 未命中。
- **judged but rejected**：**否**。13 条 `relevant official_source`。
- **plan persistence failed**：**是**。`0451` 4 机会 `validation_failed: scoreReasons_required`（`planning-stage.ts:106`）且未在工具声明暴露 `scoreReasons`，Pi 输出新旧 schema 不一致。
- **approval filter hid drafts**：**次要**。Plan 的 `ready_for_review` 与 `filterApprovedItems` 对空 plan 不生效；真正隐藏的是**未落库的内存草稿**（`0451` 的 4 items 仅在 session JSON，`b480` 的 5 未序列化为 plan）。
- **partial/failed projected as successful empty**：**是，终态决定因素**。`e9743` 空 `succeeded` 抢占 `is_current` 并推水印，`0451 partial` 被 `76c151ea succeeded` 覆盖，Today 取最新 `succeeded` 渲染。

---

## 8. UI 真实性回答

- **为何 Wan 3.0 未被提案**：并非赛道或编辑判定为无关，而是 **样本在前轮已判相关且已入增量，但首轮机会生成因子 revision 冲突未成文，第二轮空写以 `succeeded` 推开了水印，使后两轮增量窗口看不见 Wan**；唯一一次在窗口内产出 4 商业化成长机会的 `0451` 又在 `plans.save` 时被 `scoreReasons` 校验与 `REQUEST_REPLAY_CONFLICT` 双重拦截，4 机会从未落 `plans/plan_items`，故选题池保持 `items=[]`。
- **UI 是否该说“今天没有新的内容机会”**：**不应**。真实可验证状态是 **“今日情报未完成 / 资料已入库但选题池未更新完”**（`today-run-view.ts:413-498` 的 `partial/failed` 文案），且 manager 已给出 `综合整理失败：同一 requestId…`。当前 `done 零机会` 文案把 **失败/部分失败** 包装为 **有效零结果**，掩盖了 4+5 条待落库机会与仍在内存的 Wan 证据。
- **最小纠正层（不改数据/不重跑，仅加门槛与投影）**：

  1. **水印门**：`applyDailyLaneGate` 或 `savePlanFromSynthesisOutput` 后再评 `judgeWatermark` 是否推进；**空 `items` 的 `succeeded` 不得推进**（或至少在 `laneFiltered` 非零且 `gateProcessed` 含 `REVISION_CONFLICT` 时回滚），保留 Wan 所在窗口至真实非空落库。落点 `src/main/agent-runner.ts:726-727`。
  2. **持久化门**：统一 Pi 输出 schema 与 `planning-stage.ts:106` 校验；将 `scoreReasons` 作为 **服务端生成/补全** 或放宽为 `pending` 可落库待审，移除旧 prompt 与新校验的裂层；同时将 `plans.save` 重试改为 **新 `requestId`（`...:plan:vN`）或幂等 `inputHash` 更新**，规避 `command-dispatcher.ts:191` 的同 `requestId` 不同 `inputHash` 死锁。已有 `0451` 的 `v2/v3` 重试即证明同 Id 复试必冲突。
  3. **投影门**：`getToday()` / `deriveTodayRunView()` 的 `done` 判定需 **与 `agent_tasks` 终态与 `command_receipts.error` 交叉**：存在同日 `partial/ DAILY_INTELLIGENCE_FAILED / REQUEST_REPLAY_CONFLICT` 且 `command_receipts` 有 `validation_failed` 时，强制进入 `partial`（`资料已入库，选题池还没更新完`）或 `failed`（`今日情报未完成：…同一 requestId…`），禁止用最新空 `succeeded` 掩盖 `partial`。落点 `src/renderer/today-run-view.ts:138-159, 413-498, 520-537` 与 `src/main/workbench.ts:146-202 getToday`。
  4. **运营兜底（可选）**：`loadLatestNonEmptyPlan` 对 **`partial` 任务的内存草稿**（如 `0451` session 中的 4 items）提供只读预览或“一键用新 `requestId` 重放 `plans.save`”按钮，供今日批准页人工补推，避免 Wan 此类时效 2-3 天的热点错过窗口。

---

## 9. 证据清单（可复核路径）

- **库**：`J:/PigeonYang/WeMediaBuddyData/wmb.db` — `source_items` (Wan 13)、`source_scan_receipts` (6 源 114/106)、`source_lane_judgments` (11:03 批 60，Wan 13 `official_source`)、`agent_tasks`（20 行，含 `e9743/b480/0451/76c151ea/21b3c3b9/55fe6cb7`）、`plans`（4 空 `is_current` 链）、`command_receipts`（`e9743b55:plan ok`、`0451ecaa:plan* 3× error validation_failed: scoreReasons_required` + replay）、`operation_log`。
- **会话**：`J:/Pioneer.../pi-agent/sessions/daily-2026-08-24-{b480,e9743,0451,76c151ea,21b3c3b9}.jsonl` — `b480` 无围栏（revision 冲突）、`e9743` 含 Wan 40、`0451` 27/17 条增量不含 Wan 且产 4 items + `gate 27` 明细、`76c151ea` 空。
- **代码 SSOT**：上述 10+ 行级断点均在 `src/main/*` 与 `src/renderer/today-run-view.ts`，本次仅读不改。

---

## 10. 超时与完整性声明

本报告在 15 分钟只读约束内完成，覆盖 Visible Wan 13 项全链路、105/106 源计数口径、水印从 `2026-08-23T17:58:50.209Z`→`2026-08-24T12:45:16.606Z` 的精确切换点、4 机会未落库与空 `succeeded` 的终态劫持链。未触发 `formatter/linter/tests/build/package/reviewer`，未改库、未重放日情报、未外发。
