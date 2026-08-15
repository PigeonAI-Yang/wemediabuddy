---
name: wemedia-buddy-operator
description: 通过 WeMediaBuddy 内置业务工具操作当前自媒体工作空间。用于读取工作台、配置官网与 X Lists、准备工作空间或渠道变更、采集资料、生成方案、创建或续写内容、读取指标与保存复盘；也用于处理 WMB 的登录、确认、revision、needs_user 和跨工作空间边界。
---

# WeMediaBuddy Operator

## 操作合同

1. 先调用 `wmb_get_current_workspace` 确认当前 workspace、profile、data-root，以及只读的 `browserProfileId / bindingRevision / state / expectedAccountSnapshots`；涉及现有业务对象时再读 `wmb_get_workbench` 或对应精确对象。
2. 业务读写只调用本 Skill 列出的 WMB/Pi 工具。禁止直接写文件、SQLite、data-root 或安装目录。
3. 复用同一次业务动作的 `requestId`；WMB 用 command、规范化输入和当前 workspace/runtime/actor/object 身份生成 `inputHash`，相同 ID 与 hash 返回原 `CommandReceiptV1`，不要用新 ID 重试同一动作。`REQUEST_REPLAY_CONFLICT` 表示该 ID 已绑定另一命令或输入，必须停止并重新读取现场，不能改 ID 绕过冲突。
4. Agent 可以准备变更，但不能把对话指令、task grant、chat/session 或一次 UI 点击当成平台执行授权。官网来源变更和 X List 创建、修改、删除、成员变更都必须先形成冻结提议；Owner 只能在 WMB UI 对准确 workspace、runtime epoch、actor、账号、browser binding revision、对象 revision、inputHash 和 readback 签发一次性 `PreciseExecutionGrantV1`。执行授权不可由 Pi、外部 Agent、MCP 或浏览器适配器签发或撤销；最终确认、激活和最终发布只由用户在 WMB UI 完成。
5. 写入后必须按返回 ID 精确回读。不要把工具调用成功、页面跳转或模型叙述当成完成。
6. 保留 `needs_user`、`failed`、`partial`、`unknown` 和 revision/stale 的区别。`PROFILE_STALE` 表示必须重读 binding revision；`ACCOUNT_MISMATCH` 表示实时账号与本根预期账号不同且业务写入必须为零；`BROWSER_NEEDS_USER` 才表示 Owner 需要在 Settings 修复绑定、登录或验证。数据库、并发取消或内部错误不是登录失效。
7. 只操作当前 MCP URL 绑定的工作空间。切换根或应用冷重启后重新读取当前身份、browser binding 和 MCP URL，旧提案、旧 revision、旧账号快照和旧 URL 全部废弃；不得静默换账号、根、physical profile、模型、协议或来源。

8. 切换工作空间或冷重启后，必须从当前 MCP 连接重新调用 `wmb_get_current_workspace`，核对 workspace、MCP 和 `runtimeEpoch` 后再继续。`WORKSPACE_STALE`、旧 `runtimeEpoch`、lease 和任务进度回调一律视为 stale 且业务写入为零；改读 `wmb_get_agent_task` 与 `wmb_get_workbench` 的持久事实。外部动作若终态不确定，先精确回读，绝不凭旧进度重放。
## 流程路由

### 了解现场

- 用 `wmb_get_current_workspace` 读取权威工作空间、能力和渠道摘要。
- 用 `wmb_get_workbench` 读取今日资料、方案和待办。`plan` 只代表请求日期的当前方案；`latestPlan` 仅供日期切换后的连续查看，不能冒充今日方案或当前任务写回结果。
- 用 `wmb_list_workspaces` 了解登记状态；不要自行切换或指定 data-root。

### 管理 Pi Skills

安装级普通 Pi Skills 只由用户在 `设置 → Pi Skills` 新增、编辑或删除；系统 operator 和当前工作空间 lane Skill 只读。Pi 可以解释当前已加载 Skill 的用途，但没有管理工具，不得直接修改安装目录、data-root 副本或伪称已经启用/删除。用户保存后，下一次 Pi 进程会读取新版本。

### 识别图片

- 当前主模型不能看图且用户明确给出本地图片路径并要求识别、读字、比较或分析视觉内容时，先调用 Pi 原生 `describe_image`，把路径和本次需要回答的准确问题传入；普通文字任务不得调用。
- 一般描述、OCR 和 UI 分析使用 `compress: true`；只有精确坐标、细小文字或颜色判断使用 `compress: false`。视觉模型默认不启用额外 reasoning，除非复杂图表或多步视觉推理确实需要。
- 只把 `describe_image` 返回的可见事实交给当前主模型继续工作。图片不存在、视觉模型拒绝或返回错误时如实报告，禁止猜图、静默切换模型/服务或把识图结果说成 WMB 业务写入。

### 配置情报渠道

官网与 X Lists 是固定共享模块，不是赛道 Skill 或可自由创建的模块。

1. 调用 `wmb_get_intelligence_channels` 读取当前配置和 revision。
2. 官网：用 `wmb_resolve_intelligence_website` 解析候选，再用 `wmb_trial_intelligence_website` 真实试读；不可读候选不提交。
3. X List：先用 `wmb_read_x_list_index` 读取当前专用 X 账号可见列表，再用 `wmb_resolve_intelligence_x_list` 解析准确候选。同名结果必须让用户选择，不能猜。
4. 新增官网同样只用 `wmb_prepare_intelligence_channel_changes` 准备精确 diff；Pi 不再拥有直接新增官网的工具。必须等待 Owner 在 WMB UI 核对冻结 diff 并签发一次性精确执行授权。
5. 准备成功后回读待确认 proposal；只有 UI 返回含 `executionGrantId` 的成功 `CommandReceiptV1` 且渠道按 canonical URL 读回存在，才能说已应用。`awaiting_confirmation` 仍表示业务写入为零。
6. X List 接入、官网新增/启停/移除一律走同一准备与 UI 精确授权路径，不存在“当前对话已授权”的旁路。

读取 X Lists 前，WMB 必须从当前 data-root 的显式 binding 解析 registry profile，并把实时 X 账号与该根的 `expectedAccountSnapshots.x` 匹配；registry default 只供创建新 root 时显式继承，绝不是运行时 fallback。已验证的 physical profile 可以被多个 root 复用，但账号快照、List 绑定、缓存、操作和资料始终归各 root。`ACCOUNT_MISMATCH` 或 `BROWSER_NEEDS_USER` 时停止业务动作，请 Owner 在 Settings 使用“验证当前账号”；创建、改绑或迁移旧登录态也只能由 Owner 在 Settings 确认并触发冷重启，Pi/MCP 没有这些写工具。X 是实时 X Lists 的前置验证账号，不得绕过。

### 操作和采集 X Lists
- 每次实时 X 读取或写入都先经当前 root binding、binding revision 和预期账号 guard；任何 mismatch 都不得保存来源、缓存、平台结果或推进 operation。统一 dispatcher 可以保留明确的零写失败回执，但这不表示平台动作发生。

- Discover 打开时只展示当前 data-root 最近一次缓存，不自动访问 X；需要最新 List 或动态时再执行对应读取/刷新。缓存标注的账号仅代表上次读取账号，任何平台操作仍以实时账号校验为准。
- 读取真实列表使用 `wmb_read_x_list_index`、`wmb_read_x_list_detail`、`wmb_read_x_list_members`、`wmb_read_x_list_timeline`。
- 查看已接入 WMB 的列表使用 `wmb_list_x_list_bindings`。
- 创建 List：先用 `wmb_read_x_list_index` 取得当前 `accountKey` 并排除同名 List，再以新的 `requestId`、当前 `taskId / grantId / workerLeaseId` 调用 `wmb_create_x_list` 生成冻结提议。工具名保留业务意图，但不会直接写平台；等待 Owner 在操作托盘核对账号、名称、可见性和冻结快照后签发一次性精确授权。
- 添加成员严格照以下步骤执行，不得用 bash、grep、读取仓库源码或自行推测参数：
  1. 调用 `wmb_read_x_list_index`，从返回值原样取得当前 `accountKey` 和目标 List 的稳定数字 `listId`；同名 List 让用户选择。
  2. 调用 `wmb_read_x_list_members` 读取目标 List 当前真实成员。把用户要求的账号统一为唯一、以 `@` 开头的精确 handle；删除已经存在的成员。显示名、关键词和模糊候选不得传入。
  3. 若删除后为空，直接报告全部已存在，不调用写工具。否则为这一次新业务动作生成从未使用过的 `requestId`。只有同一次调用尚未取得终态响应时，传输重试才可复用原 ID。
  4. 以新的 `requestId`、当前 `taskId / grantId / workerLeaseId` 调用一次 `wmb_add_x_list_members` 生成冻结提议；等待 Owner 在 WMB UI 核对逐 handle diff 并签发一次性精确授权。Pi 不得确认或执行。
  5. 工具返回 operation 后按 ID 回读：`prepared / preparing_snapshot` 表示快照尚未冻结，`prepared / awaiting_confirmation`（旧记录可能直接显示 `awaiting_confirmation`）表示等待 Owner UI，平台写入都为零。Owner 确认后，`execution_granted` 表示一次性 grant 已原子消费，`browser_leased` 表示当前根已取得浏览器 lease；只有随后进入 `running` 才表示浏览器开始执行。
  6. `partial / needs_user / failed / unknown` 必须按 operation 与逐 handle 证据汇报；继续处理前重新读取真实成员并形成新的精确提议，禁止复用已消费 grant 或把历史 replay 当成续跑。
- 移除成员遵循相同准备顺序：先读 index 与 members，只保留当前存在的唯一精确 handle，再以新的 `requestId` 和当前 task/worker authority 调用 `wmb_remove_x_list_members` 生成提议。不得把对话指令当成平台授权；最终执行只来自 Owner UI 的精确 grant。
- 修改、删除、创建和成员变更都使用持久提议并等待应用级操作托盘确认；`wmb_prepare_x_list_operation` 支持全部操作 kind，便捷工具也只负责准备。
- 用户因找不到 UI、按钮未出现或确认未完成而说“重新来一次”时，先回读原 operation；只要精确 diff 未变且仍为 `prepared / awaiting_confirmation`（含旧 `awaiting_confirmation` 状态），就继续引导同一 operation，禁止换 `requestId` 制造重复提议。只有用户明确改变账号、List 或成员 diff，才是新的业务动作。
- 状态解释必须准确：`prepared / preparing_snapshot` 是 WMB 正在读取确认快照，`prepared / awaiting_confirmation` 是应用级操作托盘等待用户一次确认且平台写入仍为零，`execution_granted` 是精确授权已消费，`browser_leased` 是当前根已持有浏览器，`running` 才是执行中；结束后按 operation 与逐项真实状态回读。应用在动作前中断转 `needs_user`，动作意图写入后无法确认结果转 `unknown`，两者都禁止自动重放。不得把等待或授权状态说成已经执行，也不得把 WMB 执行动态说成 Pi 正在回复。
- 采集已启用绑定使用 `wmb_collect_x_list_timeline`，不得采集任意未绑定 List。
- 趋势观察只在用户显式要求时调用 `wmb_start_x_list_observation`；开始和停止都必须携带当前 `requestId / taskId / grantId / workerLeaseId`，用 `wmb_get_x_list_observation` 读取状态，必要时用 `wmb_stop_x_list_observation` 停止。
- 帖子趋势只引用 `wmb_list_x_post_metric_snapshots` 和 `wmb_get_x_post_trend` 返回的真实快照、速度和不足原因，不制造热度分。

### 资料与今日方案

- 搜索/读取已入库资料使用 `wmb_search_sources`、`wmb_get_source`。Pi 保存外部资料必须用 `wmb_save_source` 并传当前 task、grant 和 WMB 注入的 worker lease；它在 MCP 内执行 `sources.upsert_batch`。外部 Agent 直接调用 `sources.upsert_batch`。两条路径都必须保留原始 URL。可选字段（对齐 `sources.upsert_batch` 入参）：`originalUrl`（原始 URL，必填语义）、`author`、`publishedAt`、`summary`、`categories`、`keywords`、`valueJudgment`、`ipRelevance`、`creationAngles`、`recommendedPlatforms`、`recommendedFormats`、`timeliness`、`priority`、`evidence`、`expectedRevision`。研究补料（research 工单）写回只允许 title + originalUrl + 证据字段（author/publishedAt/summary），禁止传 feedId（研究证据禁止挂渠道 feed）。
- 有 `taskId` 的情报任务先读 `wmb_get_agent_task`，仅按任务要求用 `wmb_report_agent_progress` 写检查点；写入时遵守下方统一 task grant 与回执规则。
- 当今日情报仍处于 `channel_scanned`、`judging_opportunities`、`synthesizing` 或 `validating` 时，这是同一自动闭环的后续阶段；继续读取该任务和工作台，不要另起一次选题或提议重复保存方案。
- 今日情报判断以注入的「编辑简报」为唯一上下文：先对齐「身份」块的受众、内容目标与编辑简报（默认「AI × 个人商业化成长」），脱离身份的泛泛线索直接丢弃；「历史」块的已发布与复盘用于避免撞题并吸收教训；「增量」块是本轮要判断的新资料。简报已包含判断所需全部上下文；**判断任务中禁止调用 `wmb_get_workbench`（全量工作台几十万字会挤爆上下文）**，除查重（`wmb_get_knowledge_context`）与写回（`wmb_save_plan`）外不需要额外工具调用，写回成功即结束。
- 判断任务中臆造不存在的工具名是失败信号：可用的 wmb_* 工具只有本 Skill 列出的这些；一旦出现 Tool not found，立即停止臆造，回到简报继续判断，不得改用 bash 探索文件系统。
- 每个机会必须回答四问：为什么是现在（具体事实+时效分类：爆点/热点/长青）、为什么是你（与身份/历史发布/库存资料的具体关系）、你的独特说法、证据在哪（真实 sourceIds+具体事实点）。另须点明命中五维哪一环（时代认知/个人方向/AI 实践/公开验证/产品化）；说不出环节则降权或丢弃。`structureGuidance` 点名六栏目之一并套骨架（迷茫诊断/经典方法/AI 实战/项目日志/方向判断/商业化实验）。答不出四问的线索不得写入方案。
- 候选写入方案前必须先用 `wmb_get_knowledge_context` 查询同主题历史，写清它与库存资料、历史发布或复盘的具体关系；毫无关联的线索不得进入方案。
- 保存方案使用 `wmb_save_plan`，并携带当前 request/task/grant/worker authority。非空机会必须引用真实 `sourceIds`；没有合格机会时保存空 `items`，不要凑数。
- 保存后用 `wmb_get_workbench` 回读并确认精确日期的 `plan`；不要用 `latestPlan` 代替当前任务的保存结果。历史判断使用 `wmb_get_knowledge_context`。
- 需要用户确认的知识建议只用 `wmb_suggest_knowledge`；正式沉淀使用 `wmb_record_knowledge`。二者都是 task-authorized 业务写入，必须携带当前 request/task/grant/worker authority。
- 资料员发现重复、命名混乱或归属错误的主题时，先读真实主题与关联，再用 `wmb_propose_topic_maintenance` 提交有序 `create/update/merge/archive/reassign` 变更集（底层 `knowledge.topic_maintenance_propose`，含 task/grant/lease）。该工具只生成待批提案：不得直接改主题。主题审批是主管的内部职权：主管用 `wmb_list_topic_maintenance` / `wmb_get_topic_maintenance` 读取完整冻结清单并呈报，由主管在内部批准或驳回当前建议，批准后才原子迁移关联并归档旧主题；不再要求用户手工审批。若批准时出现会改变结果的真实冲突，系统会持久排队并自动派资料员读取最新现场；资料员必须提交带 `supersedesProposalId` 的新版建议，旧建议不复活、不自动批准，主管不得要求用户手工改主题。历史 stale 仅作记录，不主动重提。
- 资料员整理任务（librarian / page_library）无可整理内容时必须回报 no-op 确认：末条回复附 `` ```json {"wmb_noop": true} ``` `` 确认块；声明 wmb_noop 后不得执行任何写操作。

### 主管派工与工单编排

- 多实例是常态：同一角色可能同时有多个工单实例（两个记者扫不同渠道、写手与资料员同日并行都合法）。实例一等身份是 `jobId`；一切指认、继续、取消、传话、续派都必须用精确 `jobId`，禁止用角色名、显示编号或「那个记者」模糊指认。显示编号只在活动期可见，跨重启、跨会话不可用作指认。员工实例只对当前 job 的上下文负责，不引用其他实例会话、不假设自己是唯一在岗员工。
- 读取 → 判断 → 精确动作：先读投影事实（`wmb_list_agents_roster` 读角色活动与进度摘要，`wmb_list_jobs` 读工单池，`wmb_get_job` 按 jobId 读单个工单与 monitor.task 进度），判断清楚状态后再按精确 `jobId` 执行动作；禁止凭空猜进度或把历史记录当当前状态。对进度/状态的回答只来自投影 API 返回的事实，禁止编造进度或状态。
- 状态语义必须准确：`queued`=排队等容量（池满等待）；`waiting_resource`=等资源（对象锁/lease/judge 占用，不占并发，释放后自动晋升）；`running`=工作中（进度见 monitor.task 的 N/M）；`needs_user`=等你批（终态：不占 worker、不持 lease/grant/锁，需用户处理或关闭后才闭环，不自动重试）；`succeeded`/`partial`/`failed`/`cancelled`=终态并退出活动视图。不要把 waiting_resource 说成失败，不要编造完成时间或猜测性进度。
- 活动与历史不混淆：活动视图=池内 queued/waiting_resource/running + 终态 needs_user；历史只从持久面重建（`agent_tasks.context_refs_json` 为锚 + 任务行），应用重启（池清空）后历史仍在。续派=从 context_refs_json 重建原 RoleJobRequest（jobId/roleId/brief/边界参数）+ 结果摘要，用 `wmb_spawn_job` 派新单（新 jobId）；不得对已终态工单直接继续，也不得伪称新单与旧单同一身份。
- 主管边界：主管是软件内主管/主编席（desk 行），持全站内部 standing 写权——全部可授权业务能力命令 ∪ 基建命令，含内部准备命令，不含三类红线执行命令（最终平台发布、硬删执行、外部平台变更执行）；红线动作只能准备，最终动作必须由用户在 UI 新鲜确认。班组投影（`wmb_list_agents_roster`）里 desk 行就是主管/主编席；若遇旧数据把 desk 标为「桌助/协调入口」，按历史文案处理，不改变主管身份与职权。主管不占员工执行容量、不进员工槽；`wmb_spawn_job` 的 roleId 只接受 reporter/planner/writer/librarian，不可派工给主管自己；留言（`wmb_message_job`）不等于内部审批，主题整理提案的批准/驳回是主管内部审批，不要求用户手工操作。`maxWorkers`（0..7）是全角色共享并发上限，不是每角色配额；0=派工停用（spawn 拒绝），调整它不改变任何角色或权限。
- 先调 `wmb_daily_readiness` 查看今日扫/判状态与建议下一阶段；续接方式由你决定：扫描完成后要续接策划用 `wmb_continue_after_scan`（只要单项采集就不要调用），按阶段编排用 `wmb_run_daily_stage`（scan=单项采集，judge=单项策划，full=一条龙），派单项执行用 `wmb_spawn_job`。
- `wmb_spawn_job` 只传角色与业务参数（不接受 intent）：写手必须带 `projectId`，并按目标明确传 `writerTask`——`core_draft` 写核心稿，`xiaohongshu_platform_version` 基于最新核心稿生成并保存小红书平台版本；资料员是真实执行任务，无可整理内容时回报 no-op 确认。
- 派单后等系统 JOB_EVENT 终态推送（succeeded/failed/cancelled/partial/needs_user，含 code/message/readback）再汇报；不要 sleep+bash 轮询 session，必要时才用 `wmb_get_job` 看 monitor.task。成功必须业务读回；partial 表示部分达成，needs_user 表示需用户处理或补料；取消优先。
- 监工与传话：`wmb_message_job`（参数 jobId、body）/ `wmb_list_job_messages`（参数 jobId）留言与回读（running 时写入 task 进度并带 [主管] 前缀），`wmb_cancel_job`（参数 jobId）取消工单。
- 工单是 WMB 内部业务编排，不构成平台执行授权：最终确认、激活和最终发布仍只由用户在 WMB UI 完成；平台写入继续走各自的精确 UI 授权路径。

### 研究补料与续派决策（research_successor）

- 父工单（写手/策划/资料员）在证据上有缺口时，系统会按证据缺口自动派生研究补料工单（reporter / research）：同父唯一（同一父工单至多一个活动研究）、businessDate/projectId 边界继承、三层止环（研究或续派产物不再自动再派）。补派与续派由系统按证据缺口自动编排，主管不直接派研究工单。
- 研究工单终态后自动进入 research_successor 续派：全部 required 声明已判定 → 续派直接恢复原角色（写手/策划/资料员）继续交付；仍有未解决 required 声明（unresolved / source_unavailable）→ 续派先进入「研究缺口 · 等你批」（needs_user），等待主编决策，不自动绕行、不自动重试。
- 三动作只能由主编在 WMB UI（今日页「研究缺口 · 等你批」卡）决策，主管对话只负责解释与引导：
  - 收窄（narrow）：未解决声明从本次续派验收范围剔除；本次续派只对已判定声明交付。若仍需核实，必须由主编显式再开研究工单（不自动绕行）。
  - 手动补料（supplement）：主编已手动补充材料；续派基于既有证据与补充材料继续完成剩余工作，不得编造缺失证据。
  - 接受并标注待核实（accept）：未解决声明以「待核实」标注交付；正文必须如实标注，不得将其表述为已核实事实。
- 决策后续派恢复 pending，调度器随即派生原角色续派工单（新 jobId、同一边界），终态以 JOB_EVENT 推送。对「研究缺口 · 等你批」的进度/状态回答只来自班组投影 API 的持久事实，禁止编造。
- 研究工单执行时只走白名单只读工具（web/x/xhs）与唯一写回 `wmb_save_source`；禁止编造无出处数字或来源 URL；禁止调用 `wmb_get_workbench`（防上下文挤爆）。

### 任务授权与统一回执

- `agent task`、Pi session 和聊天记录都不是独立授权。Owner 在 WMB 明确启动或继续收集、创作、复盘任务时，WMB 会自动为该任务签发最小范围 `task grant` 并绑定当前 worker lease；这是同一个人机协作动作，不得再要求用户点击“授权 AI 协作”。Agent 不能签发、扩大或撤销 grant。
- `task grant` 仅授权当前任务所需的业务事实写入，绝不授权平台副作用。来源配置、账号/Profile、X List 变更、浏览器动作和最终发布继续使用各自的精确 UI 确认；`PreciseExecutionGrantV1` 与 task grant 分离，只能由 Owner UI 签发/撤销，且只能消费一次。目标 command、规范化 `inputHash`、完整 `boundIdentity`、target actor、browser profile/binding revision、expected account、允许状态转换、过期时间和 required readback 任一不匹配时写入必须为零。
- `EXECUTION_GRANT_REQUIRED`、`EXECUTION_GRANT_STALE`、`EXECUTION_GRANT_EXPIRED`、`EXECUTION_GRANT_REVOKED`、`EXECUTION_GRANT_SCOPE_MISMATCH`、`EXECUTION_GRANT_ACTOR_MISMATCH`、`EXECUTION_GRANT_REVISION_CONFLICT` 都必须停止并重新读取现场。不能复用已消费 grant、换 request ID 绕过、由 Agent 自签或把历史 replay 当成本次执行。
- 已知 `taskId` 时先调用 `wmb_list_task_grants({ taskId })`，只选择 `status=active`、worker 与自己匹配、`allowedCommands` 包含本次工具对应底层命令且 `expiresAt` 未过期的 grant；已知准确 `grantId` 时用 `wmb_get_task_grant({ grantId })` 回读。不要创建新 task 来绕过缺失授权。两者在 Pi 中分别只读映射到底层 MCP `task_grants.list` 与 `task_grants.get`；raw MCP 名不是 Pi 可直接调用的工具。
- 当前 Agent 可写命令为 `agent_tasks.report_progress`、`content.create`、`content.save_version`、`intelligence_channels.proposal_apply`、`knowledge.creative_brief_create`、`knowledge.creative_brief_create_project`、`knowledge.creative_brief_update`、`knowledge.domain_create`、`knowledge.domain_update`、`knowledge.record_batch`、`knowledge.suggestion_create`、`knowledge.topic_maintenance_propose`、`plans.save`、`reviews.save`、`sources.upsert_batch`、`x_lists.observation_start`、`x_lists.observation_stop`、`x_lists.operation_execute`。每次新业务动作必须携带新的 `request_id`、原任务 `task_id`、回读得到的 `grant_id` 和完整业务输入；Pi 还必须携带本次 worker 的 `worker_lease_id`。缺任一必需 authority 或 grant 未列出对应 command 时写入必须为零。MCP 服务器由有效 lease 派生 Pi 身份；没有 lease 的调用固定归属 `external_agent:mcp`，调用方不能自报或改写 worker 身份。
- 成功结果是完整 `CommandReceiptV1`，必须核对 `ok=true`、`workspaceId`、`runtimeEpoch`、`taskId`、`grantId`、`actor`、`inputHash`、`data` 和 `readback`。同一 `request_id` 加同一规范化输入只会回放原回执；改变命令或输入会返回 `REQUEST_REPLAY_CONFLICT`，必须生成新的 request id，不得把冲突说成重试成功。
- `TASK_GRANT_REQUIRED`、`TASK_GRANT_STALE`、`TASK_GRANT_EXPIRED`、`TASK_GRANT_REVOKED`、`TASK_SCOPE_BROADENED`、`TASK_WORKER_MISMATCH`、`WORKER_LEASE_STALE` 或 `WORKSPACE_STALE` 都表示本次业务写入为零。自动任务授权缺失或失效时停止并由 WMB 在同一任务的继续动作中恢复准确 grant；不得要求用户管理 grant，也不得改 task、worker、root、epoch 或省略身份字段绕过。
- Grant 到期或撤销后，只有完全相同的既有 request/hash 可以读取原回执；任何新写入仍须当前有效 grant。回放是历史证据，不表示本次再次执行。

### 创建和续写内容

- 新主题、新文章或新榜单必须用 `wmb_create_content_project` 创建独立项目和首版正文。
- 只有用户明确要求继续指定项目时，先用 `wmb_get_content` 读取准确 `projectId` 和 revision，再用 `wmb_save_core_version` 追加版本。
- 不按标题相似度猜项目。需要查找时先用 `wmb_list_content_projects`，再按 ID 读取。
- 画布选材流程依次使用 `wmb_create_creative_brief`、`wmb_update_creative_brief`、`wmb_create_project_from_brief`；用 `wmb_get_brief_lineage` 回读追溯链。
- 每次写入后用 `wmb_get_content` 按返回的项目 ID 回读标题、revision、版本号和正文。
- 为 X、小红书或公众号适配文案时，先用 `wmb_get_content` 读取准确项目，并选定要绑定的核心正文 `contentVersionId`；再分别调用 `wmb_save_platform_version`，传入当前工作空间已启用的 `platform`、明确 `format`、完整标题/正文。创建新平台版本时不传 `versionId`；更新已有平台版本时必须同时传其 `versionId` 和 `expectedRevision`。
- 每个平台注册后都用 `wmb_get_content` 回读准确 `projectId`、`contentVersionId`、平台、标题和正文。平台版本保存不等于发布；最终发布仍只由用户在 WMB UI 确认。

### 准备发布编辑器

- 平台版本保存不等于平台发布。Owner 在发布页授权的只是把一个不可变 `PublicationSnapshotV1` 填入 X 或公众号编辑器；快照冻结 workspace/runtime、平台版本及 revision、账号及 revision、browser profile/binding revision、标题、正文、素材 ID/SHA 和 `inputHash`。Pi、外部 Agent、MCP 与聊天文本都不能签发此授权或直接调用发布适配器。
- 编辑器准备按 `prepared → execution_granted → browser_leased → executing → readback_pending → succeeded` 持久化。只有实时浏览器账号与快照账号一致、精确 grant 原子消费且当前根 browser lease 有效时才能调用适配器；完成必须回读同一标题、正文、素材和编辑器证据。源平台版本随后变化也不能改写已冻结快照。
- 应用在浏览器动作前中断时 operation 转 `needs_user`；动作或回读是否完成不确定时转 `unknown`。冷重启只恢复状态并要求 Owner 核对，绝不自动再次填充。相同 request/hash 只回放原回执，不能再次打开或填写编辑器。
- `succeeded` 只表示编辑器已按快照准备并回读，publication 保持 `awaiting_confirmation`。最终点击发布始终由用户在平台执行；WMB 只在用户提供稳定平台 URL/ID 或公众号文章链接并完成真实回读后记录发布结果，不得把编辑器证据当成已发布。

### 工作空间配方

1. 用 `wmb_list_workspace_catalog` 读取有限官方能力目录。
2. 用 `wmb_prepare_workspace_profile` 准备当前或新自媒体工作空间配方；不能传 data-root，也不能准备、选择或写 browser profile。新 root 由 Owner UI transaction 显式继承 installation default。
3. 等待用户在 Settings 确认。应用冷重启后用 `wmb_get_current_workspace` 重新读取 workspace、binding、账号快照和 MCP URL；Owner-only profile 改绑/迁移不能由 Agent 代办。

### 小红书只读研究

- 只可调用 `xhs_check_login_status`、`xhs_search_feeds`、`xhs_get_feed_detail` 和 `xhs_user_profile`。
- 禁止发布、评论、回复、点赞、收藏或取消收藏。
- 保存研究资料时按当前 task grant 调用 `sources.upsert_batch`，保留 note ID、`xsec_token`、URL、时间和可见指标；成功后用 `sources.get` 回读。

### 指标与复盘

1. 用 `wmb_get_metrics` 读取真实发布指标快照。
2. 用 `wmb_get_reviews` 读取已有复盘。
3. 用 `wmb_save_review` 保存 Keep/Stop/Change；final 复盘必须引用真实 `metricSnapshotIds`。`summary`（或 notes）固定追加商业化信号模板（无新字段）：
   - 【商业化信号】追问原话（平台/篇目+原话≥2）｜重复问题（问题+次数；≥3→需求信号候选）｜需求信号（是否有人问工具/模板/服务；最小形态假设）
   - 【本周】兑现了什么｜图景是否还真｜五维偏科｜K/S/C
4. 再次用 `wmb_get_reviews` 回读最终状态。

### 创作栏目骨架（Studio）

- 起草/改稿时 `structureGuidance` 与正文结构优先套六栏目之一（迷茫诊断/经典方法/AI 实战/项目日志/方向判断/商业化实验），禁止空话扩写冒充实测。
- 商业化实验栏目仅在真实成交或真实失败后写；不得把「有人问」写成「很多人买」。

### Pi 知识问答写回（wmb_query_writeback 协议）

与工作空间知识对话（真实读取 Wiki / Note / Evidence 后回答）时，WMB 按协议解析末条回复中的结构化清单，机器校验后原子落库；未按协议声明时本轮零写，但「知识使用与沉淀」面板会显示可读的未写回原因，轮次回答不被阻断。

- 声明方式：本轮确实通过知识读取工具（如 `wmb_get_knowledge_context`）冻结读取固定版本后，末条回复必须以 ```json 围栏块携带 wmb_query_writeback 清单（协议键，非工具名），且必须是回复中最后一个 JSON 围栏；WMB 会把该围栏从用户可见正文中剥离。禁止把清单写在 thinking、工具调用中间或非末条回复里。
- 冻结读取版本：readWikiVersionIds / readNoteVersionIds / readEvidenceIds 只允许填本轮真实读取的冻结版本 id，每个 id 必须在知识库中真实存在；回答本身不是证据，禁止把回答摘要、内部候选或模型记忆当作读取版本。
- 三分决策（classification 三选一，互斥）：
  - restatement（纯复述）：仅复述既有知识，零新知识；只落 Artifact 与回执，不得携带 synthesis 或 experience。纯复述零 Note、零 Wiki、零 Evidence 写。
  - new_synthesis（新综合）：必须携带 synthesis（canonicalKey / statement / valueRationale，可选 title / basedOnNoteVersionIds）；basedOnNoteVersionIds 必须 ⊆ readNoteVersionIds；系统沉淀为 insight Note + Synthesis Wiki，只对冻结读取版本建立 derived_from 证据。
  - user_experience（用户经验）：必须携带 experience.body（用户自己的表述，不得与回答正文相同）；系统先保存不可变 FreeNote，不伪造知识。
- 不得伪造：本轮未真实读取任何冻结知识时禁止产出 wmb_query_writeback 清单；无读取、无清单或清单非法时 WMB 零写并在面板显示原因。

### Wiki 自然语言操作（wmb_wiki_action 协议，WMB-5240）

用户用自然语言操作整个 Wiki 知识库时——维护整个 Wiki、单条/批量摄取（Ingest）、基于固定版本引用的 Query、全局 Lint、统一搜索、维护报告读取——只经本协议路由：**自由文本永不触发任何 Wiki 动作**，唯一触发面是末条回复中严格 ```json {"wmb_wiki_action": …} ``` 围栏清单（协议键，非工具名；与 wmb_query_writeback 同款机器校验，**一个轮次至多一个协议围栏**，与 wmb_query_writeback 互斥）。WMB 机器校验后按 action 经既有授权管线（dispatcher + grant / 正式只读 API）执行；解析失败、键错、结构非法、未知动作、额外字段或越界 → 零写零执行，面板显示用户可见原因，轮次回答不阻断。动作 → 底层命令的映射封闭在系统侧，清单内不含命令字符串。

- 路由（用户意图 → action → 必填）：
  | 用户意图 | action | 必填 | 边界 |
  | --- | --- | --- | --- |
  | 「维护整个 Wiki / 全库整理 / 重建知识」 | maintain subaction=start | requestId + taskId/grantId/workerLeaseId | config 可选且各项有界（batchLimit 1..50、maxTopicsPerSource 1..20、stallLimit 1..20） |
  | 「维护进度 / 还在跑吗」 | maintain subaction=status | requestId | — |
  | 「暂停维护 / 继续维护」 | maintain subaction=pause / resume | requestId + taskId/grantId/workerLeaseId | 只在批次边界生效 |
  | 「上次维护的最终报告」 | maintain subaction=report | requestId | — |
  | 「收录这条资料 / 批量收录这几条」 | ingest | requestId + taskId/grantId/workerLeaseId；每条 title 与 originalUrl（http(s)）必填 | items 1..50 条；禁止 feedId 与主机凭据 |
  | 「基于固定版本问 Wiki / 查这一版知识」 | query | requestId；wikiVersionRefs / noteVersionRefs / evidenceRefs 至少一个非空（固定版本必填） | 每类 ≤64 个；引用为 `type:objectId:versionRef` 语法且必须真实存在、归属正确（漂移拒绝）；回答本身不是证据 |
  | 「全局 Lint / 健康检查」 | lint run=false（状态）或 run=true（触发） | run=true 需 taskId/grantId/workerLeaseId | — |
  | 「搜索知识库 / 找 XX 的资料」 | search | requestId + query | limit 1..100；objectTypes 限六类索引对象 |
  | 「最近有什么变化 / 看全局日志」 | log | requestId | filter 字段受限；limit 1..100 |
  | 「读维护报告」 | report | requestId | — |

- 拒绝条件（全部零写零执行并给出用户可见原因）：回复无 ```json 围栏或围栏 JSON 非法；围栏键不是 wmb_wiki_action；action 未知；出现协议未列出的字段（含 workspaceId / rootPath / 本地路径 / 命令字符串）；必填字段缺失；ingest 批量超过上限（50 条）或条目字段非法（含 feedId）；query 未声明任何冻结版本；写动作缺少 taskId/grantId/workerLeaseId 任一；search/log limit 或 maintain config 越界。解析期 authority 非空只是第一道防线：系统执行面仍会对照真实 task grant 深度复核，伪造或失效授权一律零写（TASK_GRANT_REQUIRED / TASK_GRANT_STALE / TASK_SCOPE_BROADENED / REQUEST_REPLAY_CONFLICT）。
- 固定版本不可漂移：query 只能引用本轮 wmb_get_knowledge_context 真实读取的冻结版本，引用格式 `wiki_page:<pageId>:<versionId>` / `knowledge_note:<noteId>:<versionId>` / `evidence:<id>`，系统校验存在性与归属（FIXED_VERSION_REF_INVALID / FIXED_VERSION_NOT_FOUND / FIXED_VERSION_DRIFT 一律零写）；回答与后续写回只基于冻结版本，禁止用记忆或当前未冻结内容冒充版本引用。
- 人工发布禁令：ingest 只把来源存入资料库，maintain 只跑扫描/编译/Lint/报告，任何 Wiki 操作都不触发、不代签、不替代平台最终发布；最终发布仍只由用户在 WMB UI 确认。
- 幂等与回读：每次业务动作携带 requestId；同 requestId 同输入重放原回执，改变输入返回冲突，必须换新 requestId。执行后按回执 ID 精确回读，不得把工具调用成功或模型叙述当成完成。
- 等价工具面：下列登记 wmb_wiki_* 工具是同一协议的结构化等价入口（工具调用同样受 grant/dispatcher、批量与版本边界约束），自由文本仍不触发任何动作。

## 工具清单

当前工作空间与现场：`wmb_get_current_workspace`（只读包含 browser binding 快照）、`wmb_get_workbench`、`wmb_list_workspaces`、`wmb_list_workspace_catalog`、`wmb_prepare_workspace_profile`。不存在 browser profile 创建、改绑、验证或迁移工具。

渠道：`wmb_get_intelligence_channels`、`wmb_list_intelligence_channel_receipts`、`wmb_resolve_intelligence_website`、`wmb_trial_intelligence_website`、`wmb_resolve_intelligence_x_list`、`wmb_prepare_intelligence_channel_changes`。所有渠道写入只在 WMB UI 精确授权后执行。

X Lists：`wmb_read_x_list_index`、`wmb_read_x_list_detail`、`wmb_read_x_list_members`、`wmb_read_x_list_timeline`、`wmb_list_x_list_bindings`、`wmb_get_x_list_operation`、`wmb_prepare_x_list_operation`、`wmb_create_x_list`、`wmb_add_x_list_members`、`wmb_remove_x_list_members`、`wmb_collect_x_list_timeline`、`wmb_list_x_post_metric_snapshots`、`wmb_get_x_post_trend`、`wmb_start_x_list_observation`、`wmb_get_x_list_observation`、`wmb_stop_x_list_observation`。

主管派工与工单编排：`wmb_list_agents_roster`、`wmb_list_jobs`、`wmb_get_job`、`wmb_spawn_job`、`wmb_cancel_job`、`wmb_message_job`、`wmb_list_job_messages`、`wmb_daily_readiness`、`wmb_continue_after_scan`、`wmb_run_daily_stage`。



## 页面 dock 自动授权（M-4980）

- 在业务页与内置 Pi 自由对话时，WMB 会按当前 `page` 自动签发 task grant 并在消息中注入 `taskId` / `grantId` / `workerLeaseId`：主管（desk）任一页 dock（含发布/智能体页）签发全量内部 grant；员工按页签发最小 `page_*` task grant。
- 资料库页可写：`wmb_judge_sources`（软移出 archived，`irrelevant` 必填 reason）、`wmb_restore_source`（恢复）、`wmb_update_source_status`（核验/管理状态）、`wmb_save_source`、`wmb_record_knowledge` / `wmb_suggest_knowledge`。
- **禁止硬删资料**；硬删仅 Owner UI。
- 发布页对主管可写（红线执行除外）：主管可在发布页执行内部写命令，`readonly_page` 只拦员工；`publication.editor_prepare_execute` 与最终发布点击仍须用户在 UI 新鲜确认，不得自动执行。若见 `[WMB_AUTHORITY_BLOCKED] reason=readonly_page`（员工会话），说明本页只读，引导用户去创作/资料库等页。
- 发现页可启动/停止有界观察；**不得**在无 Owner UI Precise 确认时执行 X List 创建/改成员（operation_execute）。
- 创作页可 `wmb_save_core_version` / `wmb_create_content_project`（page_studio scope）。
- 消息含 `[WMB_AUTHORITY_BLOCKED]` 时：向用户说明原因，**不得伪造** taskId/grantId/workerLeaseId。
- 软移出后系统判定 7 日冷却：向用户说明「7 日内不会自动重判」；恢复始终可用 `wmb_restore_source`。


资料、任务和知识：`wmb_search_sources`、`wmb_get_source`、`wmb_save_source`（底层命令 `sources.upsert_batch`）、`wmb_get_task_grant`（底层只读映射 `task_grants.get`）、`wmb_list_task_grants`（底层只读映射 `task_grants.list`）、`wmb_get_agent_task`、`wmb_report_agent_progress`、`wmb_save_plan`、`wmb_get_knowledge_context`、`wmb_suggest_knowledge`、`wmb_record_knowledge`。Pi 只能调用这里列出的 `wmb_*` 名称。

Wiki 知识库（WMB-5240，wmb_wiki_action 协议的等价工具面）：`wmb_wiki_maintenance_start`、`wmb_wiki_maintenance_status`、`wmb_wiki_maintenance_pause`、`wmb_wiki_maintenance_resume`、`wmb_wiki_maintenance_report`、`wmb_wiki_ingest`、`wmb_wiki_lint`、`wmb_wiki_search`、`wmb_wiki_log`、`wmb_wiki_report`、`wmb_get_fixed_versions`（固定版本只读，按 `type:objectId:versionRef` 引用读取冻结版本）。写工具（start/pause/resume、ingest、lint run）必须携带当前 taskId/grantId/workerLeaseId 并经 grant/dispatcher；只读工具（status/report、search、log、lint 状态、fixed_versions）直达正式只读 API，不接受 workspaceId / rootPath / 本地路径参数。

内容：`wmb_create_content_project`、`wmb_save_core_version`、`wmb_save_platform_version`、`wmb_get_content`、`wmb_list_content_projects`、`wmb_create_creative_brief`、`wmb_update_creative_brief`、`wmb_create_project_from_brief`、`wmb_get_brief_lineage`。

指标与复盘：`wmb_get_metrics`、`wmb_get_reviews`、`wmb_save_review`。

小红书只读：`xhs_check_login_status`、`xhs_search_feeds`、`xhs_get_feed_detail`、`xhs_user_profile`。

Web 研究只读：`wmb_search_web`、`wmb_read_web_page`。
