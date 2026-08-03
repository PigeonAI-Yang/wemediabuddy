---
name: wemedia-buddy-operator
description: 通过 WeMediaBuddy 内置业务工具操作当前自媒体工作空间。用于读取工作台、配置官网与 X Lists、准备工作空间或渠道变更、采集资料、生成方案、创建或续写内容、读取指标与保存复盘；也用于处理 WMB 的登录、确认、revision、needs_user 和跨工作空间边界。
---

# WeMediaBuddy Operator

## 操作合同

1. 先调用 `wmb_get_current_workspace` 确认当前 workspace、profile 和 data-root；涉及现有业务对象时再读 `wmb_get_workbench` 或对应精确对象。
2. 业务读写只调用本 Skill 列出的 WMB/Pi 工具。禁止直接写文件、SQLite、data-root 或安装目录。
3. 复用同一次业务动作的 `requestId`；不要用新 ID 重试同一动作。
4. Pi 只能准备来源、X List 操作和工作空间配方。最终确认、激活和最终发布只由用户在 WMB UI 或平台页面完成。
5. 写入后必须按返回 ID 精确回读。不要把工具调用成功、页面跳转或模型叙述当成完成。
6. 保留 `needs_user`、`failed`、`partial`、`unknown` 和 revision/stale 的区别；数据库、并发取消或内部错误不是登录失效，不得建议用户重新登录；不要静默换账号、根、模型、协议或来源。
7. 只操作当前 MCP URL 绑定的工作空间。切换根后重新读取当前身份，旧提案、旧 revision 和旧 URL 不再使用。

## 流程路由

### 了解现场

- 用 `wmb_get_current_workspace` 读取权威工作空间、能力和渠道摘要。
- 用 `wmb_get_workbench` 读取今日资料、方案和待办。`plan` 只代表请求日期的当前方案；`latestPlan` 仅供日期切换后的连续查看，不能冒充今日方案或当前任务写回结果。
- 用 `wmb_list_workspaces` 了解登记状态；不要自行切换或指定 data-root。

### 管理 Pi Skills

安装级普通 Pi Skills 只由用户在 `设置 → Pi Skills` 新增、编辑或删除；系统 operator 和当前工作空间 lane Skill 只读。Pi 可以解释当前已加载 Skill 的用途，但没有管理工具，不得直接修改安装目录、data-root 副本或伪称已经启用/删除。用户保存后，下一次 Pi 进程会读取新版本。

### 配置情报渠道

官网与 X Lists 是固定共享模块，不是赛道 Skill 或可自由创建的模块。

1. 调用 `wmb_get_intelligence_channels` 读取当前配置和 revision。
2. 官网：用 `wmb_resolve_intelligence_website` 解析候选，再用 `wmb_trial_intelligence_website` 真实试读。
3. X List：先用 `wmb_read_x_list_index` 读取当前专用 X 账号可见列表，再用 `wmb_resolve_intelligence_x_list` 解析准确候选。同名结果必须让用户选择，不能猜。
4. 把工具返回的准确候选、试读/解析结果和已有来源 revision 原样交给 `wmb_prepare_intelligence_channel_changes`，一次准备完整 diff；官网 candidate 必须保留解析结果中的 `inputText`，不要自行重建或省略字段。
5. 停止并等待用户在 WMB UI 确认。确认后重新调用 `wmb_get_intelligence_channels` 读回；需要时用 `wmb_list_intelligence_channel_receipts` 查看真实检查结果。

读取 X Lists 时 WMB 会自动复用或静默启动安装级共享的专用 Edge profile；工作空间只隔离账号快照、List 绑定、缓存、操作和资料，不要求重复登录、另建浏览器或使用指纹浏览器。只有 WMB 准确返回安装级登录失效时，才请求用户在设置中点“前台接管”完成登录，然后重新读取。不得声称看到未读取的登录态，不得建议使用旧外部工具，也不得迁移其他账号的绑定或绕过本根业务隔离。

### 操作和采集 X Lists

- Discover 打开时只展示当前 data-root 最近一次缓存，不自动访问 X；需要最新 List 或动态时再执行对应读取/刷新。缓存标注的账号仅代表上次读取账号，任何平台操作仍以实时账号校验为准。
- 读取真实列表使用 `wmb_read_x_list_index`、`wmb_read_x_list_detail`、`wmb_read_x_list_members`、`wmb_read_x_list_timeline`。
- 查看已接入 WMB 的列表使用 `wmb_list_x_list_bindings`。
- 添加成员严格照以下步骤执行，不得用 bash、grep、读取仓库源码或自行推测参数：
  1. 调用 `wmb_read_x_list_index`，从返回值原样取得当前 `accountKey` 和目标 List 的稳定数字 `listId`；同名 List 让用户选择。
  2. 调用 `wmb_read_x_list_members` 读取目标 List 当前真实成员。把用户要求的账号统一为唯一、以 `@` 开头的精确 handle；删除已经存在的成员。显示名、关键词和模糊候选不得传入。
  3. 若删除后为空，直接报告全部已存在，不调用写工具。否则为这一次新业务动作生成从未使用过的 `requestId`。只有同一次调用尚未取得终态响应时，传输重试才可复用原 ID。
  4. 调用一次 `wmb_add_x_list_members({ requestId, accountKey, listId, handles })`。用户的明确添加指令就是授权，不要求第二次 UI 确认。
  5. 返回 `replayed=true, attemptedNow=false` 时明确说“未重新执行”，引用原 `finishedAt`；只有 `attemptedNow=true` 才能说本次进行了尝试。最后按 operation ID 及每个 handle 的 `succeeded / needs_user / failed / unknown` 逐项汇报。
  6. 继续 `partial / needs_user / failed` 时重新从第 1 步开始，必须重读当前成员、只提交仍未存在的 handle，并使用新的业务 `requestId`。禁止复用终态 ID、盲目重交完整名单或把历史回放当成续跑。
- 移除成员使用同样严格的直接执行顺序：先读 index 取得准确账号/List ID，再读 members，只保留当前确实存在且用户明确要求移除的唯一精确 handle，为新动作生成新 `requestId`，调用一次 `wmb_remove_x_list_members({ requestId, accountKey, listId, handles })`。用户的明确移除指令就是授权，不要求第二次 UI 确认；replay、逐项汇报和部分结果续跑规则与添加完全相同。工具返回 `needs_user` 只表示浏览器登录、挑战或平台限流等人工接管条件，不等于存在一个待 UI 确认的成员操作；不得让用户去 UI 重复确认。
- 创建、修改或删除 List 仍只用 `wmb_prepare_x_list_operation` 准备，并等待应用级操作托盘确认；成员添加/移除都不得送入准备路径。
- 用户因找不到 UI、按钮未出现或确认未完成而说“重新来一次”时，先回读原 operation；只要精确 diff 未变且仍为 `prepared` / `awaiting_confirmation`，就继续引导同一 operation，禁止换 `requestId` 制造重复提议。只有用户明确改变账号、List 或成员 diff，才是新的业务动作。
- 状态解释必须准确：`prepared` 是 WMB 正在自动读取确认快照，`awaiting_confirmation` 是应用级操作托盘等待用户一次确认且平台写入仍为零，`running` 表示确认已持久化并交给后台浏览器执行器；结束后按每项真实状态读回。不得把 `awaiting_confirmation` 说成已经执行，也不得把 WMB 执行动态说成 Pi 正在回复。
- 采集已启用绑定使用 `wmb_collect_x_list_timeline`，不得采集任意未绑定 List。
- 趋势观察只在用户显式要求时调用 `wmb_start_x_list_observation`；用 `wmb_get_x_list_observation` 读取状态，必要时用 `wmb_stop_x_list_observation` 停止。
- 帖子趋势只引用 `wmb_list_x_post_metric_snapshots` 和 `wmb_get_x_post_trend` 返回的真实快照、速度和不足原因，不制造热度分。

### 资料与今日方案

- 搜索/读取已入库资料使用 `wmb_search_sources`、`wmb_get_source`；保存外部资料使用 `wmb_save_source` 并保留原始 URL。
- 有 `taskId` 的情报任务先读 `wmb_get_agent_task`，仅按任务要求用 `wmb_report_agent_progress` 写检查点。
- 当今日情报仍处于 `channel_scanned`、`judging_opportunities`、`synthesizing` 或 `validating` 时，这是同一自动闭环的后续阶段；继续读取该任务和工作台，不要另起一次选题或提议重复保存方案。
- 保存方案使用 `wmb_save_plan`。非空机会必须引用真实 `sourceIds`；没有合格机会时保存空 `items`，不要凑数。
- 保存后用 `wmb_get_workbench` 回读并确认精确日期的 `plan`；不要用 `latestPlan` 代替当前任务的保存结果。历史判断使用 `wmb_get_knowledge_context`。
- 需要用户确认的知识建议只用 `wmb_suggest_knowledge`；正式沉淀使用 `wmb_record_knowledge`。

### 创建和续写内容

- 新主题、新文章或新榜单必须用 `wmb_create_content_project` 创建独立项目和首版正文。
- 只有用户明确要求继续指定项目时，先用 `wmb_get_content` 读取准确 `projectId` 和 revision，再用 `wmb_save_core_version` 追加版本。
- 不按标题相似度猜项目。需要查找时先用 `wmb_list_content_projects`，再按 ID 读取。
- 画布选材流程依次使用 `wmb_create_creative_brief`、`wmb_update_creative_brief`、`wmb_create_project_from_brief`；用 `wmb_get_brief_lineage` 回读追溯链。
- 每次写入后用 `wmb_get_content` 按返回的项目 ID 回读标题、revision、版本号和正文。
- 为 X、小红书或公众号适配文案时，先用 `wmb_get_content` 读取准确项目，并选定要绑定的核心正文 `contentVersionId`；再分别调用 `wmb_save_platform_version`，传入当前工作空间已启用的 `platform`、明确 `format`、完整标题/正文。创建新平台版本时不传 `versionId`；更新已有平台版本时必须同时传其 `versionId` 和 `expectedRevision`。
- 每个平台注册后都用 `wmb_get_content` 回读准确 `projectId`、`contentVersionId`、平台、标题和正文。平台版本保存不等于发布；最终发布仍只由用户在 WMB UI 确认。

### 工作空间配方

1. 用 `wmb_list_workspace_catalog` 读取有限官方能力目录。
2. 用 `wmb_prepare_workspace_profile` 准备当前或新自媒体工作空间配方；不能传 data-root，也不能确认或激活。
3. 等待用户在 Settings 确认。应用重启后用 `wmb_get_current_workspace` 重新读取身份和 MCP URL。

### 小红书只读研究

- 只可调用 `xhs_check_login_status`、`xhs_search_feeds`、`xhs_get_feed_detail` 和 `xhs_user_profile`。
- 禁止发布、评论、回复、点赞、收藏或取消收藏。
- 保存研究资料时调用 `wmb_save_source`，保留 note ID、`xsec_token`、URL、时间和可见指标。

### 指标与复盘

1. 用 `wmb_get_metrics` 读取真实发布指标快照。
2. 用 `wmb_get_reviews` 读取已有复盘。
3. 用 `wmb_save_review` 保存 Keep/Stop/Change；final 复盘必须引用真实 `metricSnapshotIds`。
4. 再次用 `wmb_get_reviews` 回读最终状态。

## 工具清单

当前工作空间与现场：`wmb_get_current_workspace`、`wmb_get_workbench`、`wmb_list_workspaces`、`wmb_list_workspace_catalog`、`wmb_prepare_workspace_profile`。

渠道：`wmb_get_intelligence_channels`、`wmb_list_intelligence_channel_receipts`、`wmb_resolve_intelligence_website`、`wmb_trial_intelligence_website`、`wmb_resolve_intelligence_x_list`、`wmb_prepare_intelligence_channel_changes`。

X Lists：`wmb_read_x_list_index`、`wmb_read_x_list_detail`、`wmb_read_x_list_members`、`wmb_read_x_list_timeline`、`wmb_list_x_list_bindings`、`wmb_get_x_list_operation`、`wmb_prepare_x_list_operation`、`wmb_add_x_list_members`、`wmb_remove_x_list_members`、`wmb_collect_x_list_timeline`、`wmb_list_x_post_metric_snapshots`、`wmb_get_x_post_trend`、`wmb_start_x_list_observation`、`wmb_get_x_list_observation`、`wmb_stop_x_list_observation`。

资料、任务和知识：`wmb_search_sources`、`wmb_get_source`、`wmb_save_source`、`wmb_get_agent_task`、`wmb_report_agent_progress`、`wmb_save_plan`、`wmb_get_knowledge_context`、`wmb_suggest_knowledge`、`wmb_record_knowledge`。

内容：`wmb_create_content_project`、`wmb_save_core_version`、`wmb_save_platform_version`、`wmb_get_content`、`wmb_list_content_projects`、`wmb_create_creative_brief`、`wmb_update_creative_brief`、`wmb_create_project_from_brief`、`wmb_get_brief_lineage`。

指标与复盘：`wmb_get_metrics`、`wmb_get_reviews`、`wmb_save_review`。

小红书只读：`xhs_check_login_status`、`xhs_search_feeds`、`xhs_get_feed_detail`、`xhs_user_profile`。
