# 内置 Pi 页面级权限统一设计：dock 自由对话 × 页面作用域授权

日期：2026-08-07

状态：设计已定稿（Owner lock 2026-08-07：1A/2A/3A）。依据审计 `.ai/2026-08-07-pi-page-authority-audit.md`。**尚未实施代码。**

范围：dock 自由对话的「当前页 → 任务 → 自动 grant」统一框架；按页命令矩阵；资料库整理 P0 语义；PreciseExecutionGrant 边界；能力 chip 与失败体验；MCP/UI 工具缺口清单；P0/P1/P2 分阶段交付。

## 0. 一句话结论

把 `ensureStudioDraftAuthority` 的**单页特判**换成一张**页面 → 分页 intent → 命令作用域**的静态表（`PAGE_TASK_GRANT_SCOPES`），复用现有 `agent_tasks` + `task_grants` + `ensureAutomaticTaskGrant` 全套机制：任何页面进入 dock 对话即获得「该页最小写权」，资料库整理（软移出/恢复/状态）P0 放行，平台副作用（X List 变更、最终发布）继续只走 PreciseExecutionGrant。

## 1. 问题 / 目标 / 非目标

### 1.1 问题（审计 §6 根因逐条对应）

| 根因 | 现状证据 | 本设计对策 |
| --- | --- | --- |
| 1. Intent 模型过窄 | 仅 `daily_intelligence` / `studio_draft` / `results_review` 三个 runner intent，无「当前页协作」intent（`task-grants.ts:157-175`） | 新增 `page_<view>` intent 族（§3） |
| 2. Dock 授权是特判不是框架 | `ensureStudioDraftAuthority` 硬编码 `page=studio && objectType=project`（`ipc-pi-dock.ts:61-110`） | 通用 `ensurePageAuthority` + 静态页表（§3.2） |
| 3. 工具与 UI 命令不对齐 | `sources.lane_gate` / `sources.lane_restore` 在授权白名单（`task-grants.ts:24-25`）但**无 MCP 工具**；UI 有 `knowledge:lane-restore` / `updateKnowledgeSource`，Pi 无等价 | 补 MCP 工具（§8 P0） |
| 4. 危险操作分层未产品化 | 业务软写（移出资料）与平台副作用（X List/发布）共用「没 grant」一种体验 | 三层语义：页面自动写权 / 只读 / Precise 准备（§6） |
| 5. 上下文有、动作无 | 497x 页上下文已注入（`main.tsx:221-349`），grant 不跟进 | 上下文与授权同源同表（§3） |

### 1.2 目标（三条可验收体验）

1. 在**资料库页** dock 里说「把这条移出、恢复、标核验、挂主题」，Pi 直接执行成功，UI「已移出」视图（WMB-4944）同步可见；
2. 切到任意业务页，dock 头部 chip 明示「本页可写什么 / 只读 / 仅准备」，被拦截时给出「本页未授权 X」的明确原因，**不再静默**；
3. 平台副作用边界与今日一致：Pi 在发现页只能 prepare X List 操作，发布页零自动写权，最终动作永远 Owner 在 UI 精确确认。

### 1.3 非目标

- 不让 Pi 最终发布；不把 `x_lists.operation_execute`、`intelligence_channels.proposal_apply` 放进任何页面自动 scope；
- 不在无确认下硬删资料（硬删 = Owner UI only，见 §5.4）；
- 不新增第二 Agent / 不重做 runner 自治授权（`agent-runner.ts` onTaskReady 路径不动）；
- 不改 `agent_tasks` / `task_grants` 表结构（仅新增 intent 值与一处 context 扩展，见 §3.2）；
- 本设计不实施任何代码（§8 清单仅为实施排期输入）。

## 2. 审计 §7 问题 → 决策速查表

| # | 审计问题 | 决策 | 详述 |
| --- | --- | --- | --- |
| Q1 | Dock 是否统一「当前页最小自动 grant」？ | **是**。9 个业务页按页表自动签发（发布/设置页为零写权），runner 授权保持原样 | §3、§4 |
| Q2 | 分页 scope 表？ | 是，`PAGE_TASK_GRANT_SCOPES` 静态表，9 页逐页列命令 | §4 |
| Q3 | 资料库整理默认软移出？硬删 Owner UI only？ | 软移出（archived）+ 恢复为默认；**硬删永远 Owner UI only**（无需新理由，归档已可审计可逆，硬删破坏证据链） | §5 |
| Q4 | 平台副作用保持 PreciseExecutionGrant？ | **保持**。X List 变更、发布只允许 prepare，自动 scope 永不包含 `x_lists.operation_execute` / 发布执行 | §6 |
| Q5 | 多选整理是否 P0？ | 归档（lane_gate 天然批量）**P0 支持多选**；批量恢复 P1（lane_restore 现为单条，需批量命令或循环） | §5.3 |
| Q6 | Intent 演进：扩 AgentIntent vs dock_session？ | **扩 AgentIntent**，新增 `page_<view>` intent 族；权衡见 §3.3 | §3.3 |
| Q7 | 失败体验：缺权明确提示？ | **是**。移除静默吞错；chip 能力段 + 拦截原因注入 + toast 三件套 | §7 |

## 3. 权威模型：页面 → 任务 → grant（替代 studio 特判）

### 3.1 统一管线（与现状逐行同构）

现有 studio 路径（`ipc-pi-dock.ts:61-110`）做四件事，全部可泛化：

```
读上下文(page/objectType/objectId) → 取/建当日 intent 任务 → rebind worker lease
→ ensureAutomaticTaskGrant(intent) → injectAuthority(taskId/grantId/workerLeaseId)
```

泛化后 `ensurePageAuthority(runtime, dataRoot, ensurePi, raw)`（新模块 `src/main/pi-page-authority.ts`，替换 `ensureStudioDraftAuthority`）：

1. `extractContextField(raw, 'page')`（现成函数）→ 查 `PAGE_TASK_GRANT_SCOPES[page]`；
2. 无页表项或 `writeScope: null`（publish / settings / 未知页）→ 原样返回 raw，不建任务、不签 grant，**注入只读标记**（§7.2）；
3. 有写权 → `getActiveAgentTask(db, 'page_<view>', businessDate)`：
   - 已有且 running → 直接复用（grant 由 `ensureAutomaticTaskGrant` 幂等重签，命令集变化时自动 revoke+reissue，`task-grants.ts:190-200`）；
   - 无 → `dispatchStartAgentTask({ intent: 'page_<view>', businessDate, contextRefs: { page, objectId }, piSessionId })`（与 studio 建任务同构）；
4. `rebindWorkerTask(lease, task.id)` → `ensureAutomaticTaskGrant(task.id)` → `injectAuthority(raw, {taskId, grantId, workerLeaseId})`。

关键点：`ensureAutomaticTaskGrant` 已是 intent→scope 查表 + 命令集变更即重签（`sameCommandSet` 判定），所以**授权机械零改动**，只新增 intent 值与页表。

### 3.2 PAGE_TASK_GRANT_SCOPES 表结构

```ts
// 新静态表（main 与 renderer 共享同一份，放 src/shared/page-authority.ts，防 chip 与授权漂移）
PAGE_TASK_GRANT_SCOPES: Record<Page, {
  intent: 'page_today' | 'page_discover' | 'page_proposals' | 'page_topic'
        | 'page_library' | 'page_canvas' | 'page_studio' | 'page_results' | 'page_publish';
  writeScope: readonly Command[] | null;   // null = 只读页，不建任务不签 grant
  chipLabel: string;                        // chip 能力摘要，如「归档/恢复/挂主题/存资料」
}>
```

- `AUTOMATIC_TASK_GRANT_SCOPES` 直接追加 9 个 `page_*` 条目（与 3 个 runner intent 同表，语义统一为「自动任务 grant」）；
- `ensureAutomaticTaskGrant` 的 `relevantContext` 从 `{ intent, businessDate, automatic }` 扩展为 `{ intent, businessDate, automatic, page, objectId }`（读 task.contextRefs，一行改动）——让每张 grant 可审计「当时在看哪一页、哪个对象」；
- 页面切换生命周期：**同页复用、跨页不 cancel**。`page_<view>` intent 已编码页面，切换页面即换 intent → 新旧任务并存，旧 grant 4h 自然过期（与现有 studio grant 行为一致，`AUTOMATIC_TASK_GRANT_EXPIRY_MS`）。不需要 studio 那种「错项目 cancel 再建」——那个特判只因为单日单 `studio_draft` 任务要复用给多个 projectId。P1 再补「页面离开显式撤销」清理（§9）；
- 无对象页（如今日页无选中项）也照常签：scope 是页面级的，不依赖 objectId。

### 3.3 Intent 演进决策与权衡（审计 Q6）

**决策：扩 `AgentIntent`，新增 `page_<view>` intent 族。** 三个候选：

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| A. 扩 AgentIntent（`page_*` 每页一个 intent） | 授权机械零改动（intent→scope 查表现成）；幂等重签现成；worker lease/rebind 现成；`injectAuthority` 现成；grant 审计（task_grants 表 + relevantContext）现成；Pi skill 无需学习新 authority 形状 | `agent_tasks` 每页每日多一行（9 页/日）；page 任务不跑 runner 阶段机，需从任务列表面排除 | **采用** |
| B. 单个 `page_copilot` intent + 外部页表算 scope | 任务行少 | 需给 `ensureAutomaticTaskGrant` 引入「scope 由页计算」的第二路径，破坏单一查表；页面并集 = 全量写权（违反最小权限，本设计核心） | 否 |
| C. 新增并行 `dock_session` 实体 + 独立 grant | 与 runner 语义彻底分离、无幻影任务 | 新表、新签发/撤销路径重复实现 task_grants；Pi 提示词要学新 authority 块；审计要新查询；成本最高 | 否（记为终态方向，若未来 dock 需要独立生命周期再评估） |

否决 B 的另一个理由：本设计卖点就是**逐页最小权限**，并集 scope 直接把「发现页能写今日方案」这类越权放进来。否决 C 的理由是复用成本：`task_grants` 已提供签发/撤销/过期/worker/审计全套，再造一套并行机制纯属重复。

## 4. 页面 → 允许命令矩阵（审计 Q2）

原则：只读工具（`wmb_search_sources` / `wmb_get_source` / `wmb_get_knowledge_context` / `wmb_get_workbench` / `wmb_get_content` / `wmb_get_metrics` / `wmb_get_reviews` / `wmb_get_brief_lineage` / `wmb_read_x_list_*` / `wmb_get_x_list_operation` / `wmb_get_x_post_trend` / `wmb_list_x_post_metric_snapshots` / `xhs_*` 读类等）**永不需要 grant**；下表只列写命令（均须在 `TASK_INTERNAL_COMMANDS` 白名单内，`task-grants.ts:10-28`）。

| 页 | intent | 自动写权（allowedCommands） | 用户意图依据（审计 §5） |
| --- | --- | --- | --- |
| 今日 | `page_today` | `agent_tasks.report_progress`, `sources.upsert_batch`, `sources.lane_gate`, `knowledge.record_batch`, `knowledge.suggestion_create`, `plans.save` | 对话中存资料/改方案/判定归档（= daily_intelligence scope 镜像，独立 grant） |
| 发现 | `page_discover` | `agent_tasks.report_progress`, `sources.upsert_batch`, `knowledge.record_batch`, `x_lists.observation_start`, `x_lists.observation_stop` | 把帖存库/归主题/启动有界观察；**`x_lists.operation_execute` 绝不进 scope**（§6） |
| 选题 | `page_proposals` | `agent_tasks.report_progress`, `sources.upsert_batch`, `knowledge.record_batch`, `knowledge.suggestion_create`, `content.create`, `content.save_version` | 从 plan_item 立项开写（MCP `content.create` 已支持 `plan_item_id`，`mcp-business-commands.ts:191`） |
| 主题 | `page_topic` | `agent_tasks.report_progress`, `sources.upsert_batch`, `knowledge.record_batch`, `knowledge.suggestion_create`, `knowledge.domain_create`, `knowledge.domain_update` | 把资料沉到当前主题/建域改域（audit 缺口行） |
| 资料库 | `page_library` | `agent_tasks.report_progress`, `sources.upsert_batch`, `sources.lane_gate`, `sources.lane_restore`, `knowledge.record_batch`, `knowledge.suggestion_create` | 整理：移出/恢复/状态/挂主题（§5） |
| 画布 | `page_canvas` | `agent_tasks.report_progress`, `knowledge.suggestion_create`, `knowledge.record_batch`, `knowledge.creative_brief_create`, `knowledge.creative_brief_update`, `knowledge.creative_brief_create_project`, `content.save_version` | 简报→立项（audit 缺口行）；`domain_create/update` 留 P1 可选 |
| 创作 | `page_studio` | `agent_tasks.report_progress`, `content.create`, `content.save_version` | 写正文 + 新建项目（`content.create` 补进 scope，修 audit 缺口行；与现 `studio_draft` 行为完全一致，属回归保护） |
| 发布 | `page_publish` | **null（零自动写权）** | 只读 + 准备；最终发布走 Precise（§6） |
| 结果 | `page_results` | `agent_tasks.report_progress`, `knowledge.record_batch`, `reviews.save` | 对话中写复盘（= results_review scope 镜像） |
| 设置 | — | dock 不渲染，不适用 | — |

矩阵推导规则（可审阅的判定标准）：
1. 每个 scope 只含「该页用户合理意图」对应的写命令；
2. runner 镜像页（today / results / studio）与 runner scope 同命令集，但**独立任务独立 grant**（不与 runner 共享，避免任务冲突与阶段机纠缠）；
3. 平台副作用命令（`x_lists.operation_execute` / `intelligence_channels.proposal_apply` / 发布执行）在全部 9 页中一律缺省；
4. 页面级统一含 `agent_tasks.report_progress`：page 任务自己的 checkpoint 是免费审计面，且与 runner 语义一致。

## 5. 资料库整理 P0 语义（审计 Q3、Q5）

### 5.1 软移出（默认）= `sources.lane_gate`

- Pi 调用（P0 新增 MCP 工具）`sources.lane_gate`：`decision='irrelevant'` 判定 → `management_status='archived'` + `source_lane_judgments` 流水行，同一事务（`lane-gate.ts:12-13`，`applyLaneGateBatch` 已保证整批原子，任一失败零写）；
- `judged_by='agent'`，`reason` 必填（lane-gate 校验：irrelevant 必须携带一句话 reason，`lane-gate.ts:151-152`）——Pi 的移出天然带理由，进审计；
- **批量 = P0**：lane_gate 输入本身是 judgments 数组，多选移出零新增命令；
- 幂等：同 requestId 重放原回执；重复判同一条受 7 日冷却保护（§5.5）。

### 5.2 恢复 = `sources.lane_restore`

- 单条：`restoreFilteredSource`（archived → active + `judged_by='editor'` 流水行 + 7 日冷却，`lane-gate.ts:357-358`）；workspaceLane 复用 UI `knowledge:lane-restore` 的派生逻辑（当前工作空间配方快照，`ipc-knowledge-content.ts:71-74`）；
- 幂等：已是 active → `restored=false` 零写（`lane-gate.ts:358`）；
- **批量恢复 = P1**：现命令单 sourceId；P0 用 N 次串行调用兜底（恢复频率低），P1 评估 `sources.lane_restore_batch`（仅在串行被证伪时立项，见 §11 风险）；
- 语义说明：Pi 代 Owner 恢复写 `judged_by='editor'`，UI「已移出」视图已支持该行（WMB-4944），无需新语义；备选方案是给 lane_restore 增加 `judged_by='agent'`，但会破坏「editor = 主编覆写」的既有判定语义，不取。

### 5.3 可选状态 = `knowledge.record_batch` + 新增 `sources.update_status`

- 挂主题 + 顺带核验/管理状态：`knowledge.record_batch`（现成 MCP，`mcp-business-commands.ts:169-186`）；
- **纯状态（不动主题）**：现 MCP `record_batch` 每项强制要求 `topic` 对象（`mcp-business-commands.ts:171-172`），纯改 `verificationStatus` / `managementStatus` 无法表达 → P0 新增命令 `sources.update_status`（包装 `updateKnowledgeSource`，仅校验 id/revision/status 字段）+ MCP 工具 `wmb_update_source_status`。**不改** record_batch 的 topic 必填不变量（避免弱化知识挂接约束）。

### 5.4 硬删除 = Owner UI only（审计 Q3）

- `deleteKnowledgeSource`（`knowledge.ts:6` 引入，UI `knowledge:delete` 路径）**不进任何页面 scope，永远 Owner UI only**；
- 理由：归档已可审计可逆（judgment 流水 + 7 日冷却 + 恢复命令），硬删破坏证据链且不可逆；「需要 Pi 硬删」在可预见的整理意图中不存在；
- 若未来 Owner 明确要 Pi 硬删：仅允许走 PreciseExecutionGrant 单次授权（boundIdentity=sourceId + UI 确认），本设计不预置。

### 5.5 7 日冷却的产品语义

Pi 归档/恢复后，`LANE_JUDGMENT_COOLDOWN_MS = 7d`（`lane-gate.ts:19`）内 Tier 0/1 系统判定不再重判同 source_id。UI 与 Pi 提示词都要传达：「这条 7 日内不再自动重判」——这正是泊车语义（与 dismiss 一致），不是缺陷。P0 在 chip 或回复中体现即可，不需新机制。

## 6. 平台副作用边界：PreciseExecutionGrant 保持不动（审计 Q4）

三层写权在产品上彻底分开，chip 与拦截文案据此分层：

| 层 | 命令/工具 | 授权路径 | 页面自动 scope 含？ |
| --- | --- | --- | --- |
| 业务软写（可逆、仅当前根） | `sources.lane_gate/restore/update_status/upsert_batch`, `knowledge.*`, `plans.save`, `reviews.save`, `content.*`, `x_lists.observation_start/stop` | 页面自动 TaskGrant（本设计） | 是（按 §4 矩阵） |
| 平台副作用（X List 变更、渠道配方） | `x_lists.operation_execute`, `intelligence_channels.proposal_apply` | PreciseExecutionGrant：Pi 只调 prepare 工具（`wmb_prepare_x_list_operation` / `wmb_add/remove_x_list_members` / `wmb_create_x_list` / `wmb_prepare_intelligence_channel_changes`）→ Owner UI 对冻结操作签发单次授权并确认（`issueExecutionGrant`，boundIdentity/inputHash/expectedAccount/requiredReadback） | **永不** |
| 最终发布 | `publication.editor_prepare_execute` | 同上 Precise，发布页零自动写权 | **永不** |

不变项（回归保护）：`wmb_collect_x_list_timeline` 维持现状（无 authority schema，只读平台、只写当前根）——审计 §4.4 标记为风险，本设计不扩大，仅在 P2 由 Owner 决定是否补 authority schema（§9、§11）。

## 7. UX：能力 chip 与失败提示（审计 Q7）

### 7.1 chip 显示授权能力

- 复用 `PiDockHeader` 的 `.pi-context-chip`（`pi-dock-header.tsx:65`），在其后追加**授权段**：
  - `绿点 · 可写：归档/恢复/挂主题/存资料`（library）
  - `灰点 · 只读`（publish：只读+可准备）
  - `黄点 · 仅准备（平台动作需 UI 确认）`（discover 的 X List 部分）
- 数据源：renderer 直接 import `src/shared/page-authority.ts` 的 `PAGE_TASK_GRANT_SCOPES[view].chipLabel`——**与 main 授权同源单份表**，杜绝两处漂移；工具级明细（点了展开看每条命令）P2 再做，P0 只显示页级摘要；
- 需要一个小 IPC（`pi:authority-status`）回传「当前页 grant 是否实际生效（task 已建、grant active）」，避免 chip 显示与真实授权不一致（例如 Pi 未配置时显示只读）。

### 7.2 拦截与错误：禁止静默吞掉

现状问题：`authorize` 的 `catch { return message; }`（`ipc-pi-dock.ts:131-132`）把授权失败静默吞掉，Pi 拿到无 authority 的原文继续答，用户不知道「本页没写权」。P0 改为：

1. **移除静默吞错**：`ensurePageAuthority` 失败时（未配置 Pi / 无 lease / 任务建不起）向 raw 注入 `[WMB_AUTHORITY_BLOCKED] reason=<code>`（`extractContextField`/`injectAuthority` 同款机制），Pi 按提示词向用户说明「本页未授权 X，可用 UI 完成或前往相应页面」，**不得伪造 authority 字段**（扩展 `PI_AUTHORITY_SYSTEM_PROMPT`，`pi-operator-skill.ts:12`）；
2. **toast 同步**：`broadcastPiEvent({ type: 'authority-blocked', page, reason })`，dock 头部 `pi-toast`（`pi-dock-header.tsx:66`）显示「本页未授权自动写权 · 原因」；
3. 命令级兜底不动：`assertTaskGrantForEnvelope` 缺 grant 即 `TASK_GRANT_REQUIRED` / `TASK_SCOPE_BROADENED` 抛错（fail-closed，`task-grants.ts`），这些错误已作为工具结果回给 Pi——现在它们会**有 chip + 拦截块解释**，不再裸奔；
4. 只读页（publish）也注入 `[WMB_AUTHORITY_BLOCKED] reason=readonly_page`，让 Pi 主动说明「发布页只读，写正文请到创作页」——把「少写需求」翻译成可操作指引。

## 8. 工具缺口清单（MCP/UI 对齐，仅设计不实现）

| # | 缺口 | 现状证据 | 建议（P0/P1/P2） |
| --- | --- | --- | --- |
| G1 | `sources.lane_gate` 无 MCP 工具（归档） | 白名单有（`task-grants.ts:24`），仅 runner 裸库调用（`agent-runner.ts:438`）；`mcp-source-commands.ts` 只注册 `sources.upsert_batch` | **P0**：MCP 注册 `sources.lane_gate`（judgments 批量、judged_by='agent'、reason 必填）+ wmb 包装 `wmb_judge_sources`（label「移出资料库」） |
| G2 | `sources.lane_restore` 无 MCP 工具（恢复） | 白名单有；仅 UI IPC（`ipc-knowledge-content.ts:74`） | **P0**：MCP 注册 `sources.lane_restore`（单条、expectedRevision、workspaceLane 复用 UI 派生）+ wmb 包装 `wmb_restore_source` |
| G3 | 纯状态更新无命令 | `record_batch` MCP 强制 topic（`mcp-business-commands.ts:171-172`）；`updateKnowledgeSource` 仅 UI（`knowledge.ts:59`） | **P0**：新增 `sources.update_status` 命令（进白名单）+ MCP/wmb 工具 `wmb_update_source_status` |
| G4 | 批量恢复 | `restoreFilteredSource` 单 sourceId（`lane-gate.ts:357`） | **P1**：评估 `sources.lane_restore_batch`；P0 用 N 次串行兜底 |
| G5 | 选题页立项无 wmb 包装 | MCP `content.create` 已支持 `plan_item_id`（`mcp-business-commands.ts:191`），wmb 层无对应 wrapper | **P1**：`wmb_create_project_from_plan_item`（配合 page_proposals scope） |
| G6 | 发布页只读「准备稿」 | 无 prepare 工具 | **P1**（可选）：`publication.editor_prepare`（只准备，不落库发布） |
| G7 | wmb 观察工具形状与 MCP 不一致 | `wmb_start_x_list_observation` 参数形状 ≠ `x_lists.observation_start`（`mcp.ts:231-234`） | **P2**：对齐并验证 |
| G8 | `wmb_collect_x_list_timeline` 无 authority schema | `wmb-mcp-tools-x-lists.ts:131-135` | **P2**：Owner 决定是否补 authority（现为已知风险，见 §11） |
| G9 | chip 与授权状态联动 | `.pi-context-chip` 仅显示对象（`pi-dock-header.tsx:65`） | **P0**：§7.1 授权段 + `pi:authority-status` IPC |

## 9. 分阶段交付

### P0 —— 资料库整理 + 与 studio 模式同构（本设计的核心放行）

1. `src/shared/page-authority.ts`：`PAGE_TASK_GRANT_SCOPES` 静态表（§3.2、§4），main 与 renderer 共享；
2. `AUTOMATIC_TASK_GRANT_SCOPES` 追加 `page_*` 条目；`ensureAutomaticTaskGrant` 的 `relevantContext` 带 page/objectId；
3. `src/main/pi-page-authority.ts`：`ensurePageAuthority` 替换 `ensureStudioDraftAuthority`（`ipc-pi-dock.ts` 两处调用点：`pi:chat` 的 authorize 钩子），studio 行为逐行等价（回归保护）；
4. 资料库 scope 生效（G1/G2/G3 工具补齐）；
5. UX：chip 授权段 + `pi:authority-status` + 移除静默吞错 + BLOCKED 块 + toast（G9、§7）；
6. 7 日冷却文案进 Pi 提示词（§5.5）。

### P1 —— today / results / topic / canvas / proposals

1. 开启 `page_today`（= daily scope 镜像）、`page_results`（= results_review 镜像）、`page_topic`、`page_canvas`、`page_proposals` scope；
2. G5 选题立项 wrapper；G4 批量恢复评估；
3. 页面离开显式撤销：renderer 在 view 切换时调 `pi:authority-drop`，cancel 旧 page 任务 + revoke 其 grant（清理 agent_tasks 幻影行）；`page_*` 任务从 runner 任务列表/今日命令栏排除；
4. canvas 页 `knowledge.domain_create/update` 若选题阶段有真实诉求再放行（当前 P1 可选）。

### P2 —— discover prepare-only + 打磨

1. 开启 `page_discover` scope（观察 + 存库 + 归主题，operation_execute 仍 Precise）；
2. G7 观察工具对齐；G8 collect_timeline authority schema 决策；
3. chip 工具级明细展开；逐页手动 QA 矩阵（§10）。

## 10. 验收标准

P0（资料库 + 模式等价）：

1. 资料库页 dock：Pi「把这条移出资料库」→ `sources.lane_gate` archived + judgment 行（judged_by=agent、reason 非空），UI「已移出」视图可见该条；多选一次移出 N 条成功（fixture + 实机）；
2. Pi「恢复这条」→ `sources.lane_restore` active + judged_by=editor 行，7 日内系统重判被冷却拦截；
3. Pi「把这条核验为已核实 / 标为观察中」→ `sources.update_status` 落库（不改 topic）；
4. 发布页 dock：Pi 尝试写 → BLOCKED（readonly_page）+ toast + chip 灰点只读，无任何写命令被签发；
5. 创作页回归：`content.save_version` / 新建项目行为与现状逐项一致（原 studio_draft 用例全绿）；
6. 授权失败不静默：人为制造无 lease 场景 → 消息带 `[WMB_AUTHORITY_BLOCKED]`，Pi 说明原因，无伪造 authority；
7. chip 与真实授权一致：`pi:authority-status` 返回 active 时 chip 显示绿点可写，Pi 未配置时显示只读。

P1：今日/结果/主题/画布/选题五页各自最小意图可执行（§4 矩阵逐行 fixture）；页面离开后旧 grant 撤销、任务列表无幻影行。

P2：发现页观察/存库可执行；prepare 全流程（prepare → Owner UI 确认 → Precise 执行）不回归；逐页 QA 矩阵全绿。

## 11. 风险

- **grant 积累**：每页每日一条 page 任务 + grant；Owner lock 2A = 不因换页撤销、约 4h 过期回收。审计按 `relevantContext.page` 过滤即可。
- **7 日冷却的双刃**：Pi 误判移出后 7 日内不能重判恢复语义——这是泊车设计意图；误判恢复路径是 lane_restore（不受冷却限制，随时可恢复），因此风险可控，只需 UI 文案说明。
- **record_batch topic 耦合**：纯状态更新若走 record_batch 会弱化不变量，故 P0 新增 `sources.update_status`（§5.3），不碰既有校验。
- **跨页残留 authority**：Pi 会话历史里保留旧页 authority 块，换页后可能用旧 grant 续写；4h 过期 + P1 离开即撤销 + BLOCKED 语义三重收敛；P0 接受（与现有 studio 行为一致）。
- **chip 与授权漂移**：单一共享表（G9）根治，禁止 renderer 另写标签。
- **workspaceLane 派生**：lane_restore 依赖工作空间配方快照，复用 UI 已实现派生函数，不新增逻辑面。
- **collect_timeline 无 authority**（已知现状）：只读平台、只写当前根，风险有限；P2 由 Owner 决策是否补 schema，本设计不扩大。

## 12. Owner 锁定（2026-08-07 · 1A / 2A / 3A）

口语确认后写入，实施不得改口：

| # | 决策 | 含义 |
| --- | --- | --- |
| **1A** | **硬删永远只在 Owner UI** | Pi 只能软移出（archived）/ 恢复 / 改状态；`deleteKnowledgeSource` 永不进入任何 page scope，也不预置 Precise 硬删路径 |
| **2A** | **grant 不因换页立刻撤销，约 4 小时过期** | 与现有创作页一致；P0/P1 都不做「离开页面即收回工牌」。换页后靠新页 scope + 过期回收；不在 P0 做强制 revoke-on-leave |
| **3A** | **发现页「观察/盯 List」可进自动 scope** | `x_lists.observation_start/stop` 允许放进 `page_discover` 自动写权（有界窗口、只写当前根）。**改 List 成员/新建 List 等平台变更仍必须 Owner UI Precise 确认**，Pi 最多 prepare |

开放问题已关闭。实施以本文 + 审计文档为准。
