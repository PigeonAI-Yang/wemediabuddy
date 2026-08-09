# Pi 页面上下文 × 工具 × 自动授权 全量排查

Date: 2026-08-07  
Mode: audit only (no code changes in this note)  
Trigger: 资料库整理要靠外部 AI，WMB 内置 Pi 无权限 —— 同类问题需一次性设计

## 1. 一句话结论

**看得到 ≠ 做得到。**

- 多数业务页已经能把「你在看什么」注入 Pi（`[WMB_CONTEXT]`）。
- 但 **dock 自由对话自动签发 grant 的路径目前几乎只有创作页（studio + 已聚焦 project）**。
- 写工具本身大量存在，却卡在 `taskId/grantId/workerLeaseId`；缺 grant 就 `TASK_GRANT_REQUIRED` / `TASK_SCOPE_BROADENED`。
- 因此用户感知是：「WMB 自己有 AI，却不能整理资料库 / 落主题 / 写复盘……还得找外部开发 AI。」

## 2. 架构三层

| 层 | 现状 | 关键文件 |
|---|---|---|
| A. 页面上下文 | 按 view 组装 page/object/focus/selection | `src/renderer/main.tsx` piContext；`pi-context-payload.ts`；`pi-focus.ts` |
| B. 工具面 | ~54 `wmb_*` + 4 `xhs_*`；写工具多数要 authority | `.pi/extensions/wmb-mcp/*`；`src/main/mcp*.ts` |
| C. 自动授权 | 仅 3 个 intent 自动 scope；dock 只给 studio_draft | `task-grants.ts`；`ipc-pi-dock.ts` ensureStudioDraftAuthority；`agent-runner.ts` onTaskReady |

## 3. 页面上下文矩阵（A）

| 页 | objectType | 上下文形态 | 点选/多选 | 正文摘录 |
|---|---|---|---|---|
| 今日 | plan_item / source / fermenting | selectedItems + selectedSources + fermenting | 多选 | 资料可 fetch body |
| 发现 | x_list / ranking | xList 全量可见帖 或 ranking 多选 | 有 | 无 |
| 选题 | plan_item | selectedItems 单元素 | 单选 toggle | 无 |
| 主题 | topic | libraryTopicContext | 进详情 | 无 focus 正文 |
| 资料库 | source | pageFocus 单选 | 单选 toggle | 有（至 6000） |
| 画布 | canvas | directContext nodeIds | 节点多选 | 无 |
| 创作 | project | focus + studioContext | 列表 focus / 打开编辑 | 有 |
| 发布 | publication | main 从 publishSelected 合成 | 列表选中 | 无 |
| 结果 | publication | 点选图表/行 | 单选 | 无（指标/复盘 meta） |
| 设置 | — | PiDock 不渲染 | — | — |

证据：scout `AuditPiContext`；`main.tsx` 221–349。

## 4. 工具与授权矩阵（B+C）

### 4.1 自动 grant scope（仅这些会自动签发）

- `daily_intelligence`: report_progress, knowledge.record_batch, suggestion_create, plans.save, sources.upsert_batch, sources.lane_gate
- `studio_draft`: report_progress, content.save_version
- `results_review`: report_progress, knowledge.record_batch, reviews.save

### 4.2 白名单内但从不自动 grant 的命令（摘）

`content.create`, `sources.lane_restore`, `knowledge.creative_brief_*`, `knowledge.domain_*`, `x_lists.operation_execute`, `x_lists.observation_*`, `intelligence_channels.proposal_apply`, …

### 4.3 Dock 自由对话实际注入

**仅当** `page=studio && objectType=project && objectId`：

1. 复用/创建当日 `studio_draft` task（错项目会 cancel 再建）
2. rebind worker lease
3. `ensureAutomaticTaskGrant(studio_draft)`
4. 把 taskId/grantId/workerLeaseId 写入消息上下文

其它页：上下文有，**grant 无**。

`daily_intelligence` / `results_review` 的 grant 只挂在 **agent-runner 自治会话**，不挂 dock。

### 4.4 无 grant 仍可写的例外（缺口/风险）

- `wmb_collect_x_list_timeline`：无 authority schema（仅 account-key）
- proposal prepare 类：只生成待 Owner UI 确认的提议（合理）

## 5. 按页用户意图 vs 阻断（核心缺口表）

| 页 | 用户合理意图 | 阻断原因 | 已有半成品 |
|---|---|---|---|
| **资料库** | 整理：移出/恢复/改状态/挂主题 | dock 无 grant；`lane_restore` 不在 auto scope；UI 有 `updateKnowledgeSource`/lane-restore，Pi 工具面不完整 | 读源 + focus 正文 OK；UI 可移出/恢复 |
| **主题** | 把资料沉到当前主题 | `record_batch` 只在 daily_intelligence 自动给 | 可读 dossier |
| **画布** | 简报→立项 | creative_brief_* 从不 auto grant | directContext 节点上下文 OK |
| **创作** | 写正文 / 新建项目 | 写正文已通；`content.create` 不在 studio_draft | save_version OK |
| **发现** | 管 List / 观察 | operation_execute / observation_* 从不 auto；且属 Precise 边界需厘清 | 读 List/时间线 OK；collect_timeline 无 grant |
| **今日** | 对话中存资料/改方案 | dock 不注入 daily_intelligence | runner 自治任务有 grant |
| **选题** | 从 plan_item 立项开写 | `content.create` 无 auto；页无注入 | UI createProjectFromPlanItem 已通 |
| **结果** | 对话中写复盘 | results_review 不注入 dock | runner 复盘环有 grant |
| **发布** | 少写需求 | 最终发布本就该 Owner/精确授权 | 只读/准备编辑器 |

## 6. 根因归类（给方案用，不实施）

1. **Intent 模型过窄**：只有 3 个 runner intent，没有「当前页协作」intent（如 `page_copilot` / 分页 intent）。
2. **Dock 授权是特判不是框架**：`ensureStudioDraftAuthority` 单页硬编码，不是 page→scope 表。
3. **工具与 UI 命令不对齐**：UI 能 `knowledge:update-source` / `lane-restore` / `createProjectFromPlanItem`，Pi 无等价、或无 grant。
4. **危险操作分层未产品化**：业务软写（移出资料）vs 平台副作用（X List 变更/发布）共用「没 grant」体验，用户分不清。
5. **上下文有、动作无**：497x 点选 focus 已做；授权未跟进，落差最大。

## 7. 设计必须一次回答的问题

1. Dock 自由对话是否统一「当前页最小自动 grant」，还是继续仅 runner 有写权？
2. 分页 scope 表：library / topic / today / proposals / results / canvas / discover 各允许哪些 command？
3. 资料库整理默认 **软移出（archived）+ 恢复**，硬删是否永远 Owner UI only？
4. 平台副作用（X List 变更、发布）是否保持 PreciseExecutionGrant，仅允许 prepare？
5. 多选整理（资料库批量）是否 P0？还是先单选 focus？
6. Intent 演进：扩 `AgentIntent` vs 新增与 runner 并行的 `dock_session` grant？
7. 失败体验：缺权时是否明确提示「本页未授权 X」，禁止静默吞掉？

## 8. 非目标（审计建议）

- 不让 Pi 最终发布
- 不让 dock 静默获得 `x_lists.operation_execute` 的自动平台写入（除非 Owner 明确改 Precise 模型）
- 不在无确认下硬删资料

## 9. 证据索引

- Context scout: agent AuditPiContext
- Tools/grants scout: agent AuditPiToolsGrants
- Key code: `ipc-pi-dock.ts` ensureStudioDraftAuthority；`task-grants.ts` AUTOMATIC_TASK_GRANT_SCOPES；`main.tsx` piContext；`.pi/extensions/wmb-mcp/*`
