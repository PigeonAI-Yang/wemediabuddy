# X List 趋势机会雷达方案

- 状态：待按任务链实施
- 日期：2026-08-03
- 依赖：WMB-2107 完成
- 合同：REQ-023、AC-019、CAP-022、EVAL-024–025

## 1. 决策

WMB 在现有稳定 X List 读取链后增加根内指标历史、确定性趋势计算和有界观察任务，让今日内容机会能够回答“为什么是现在”。不引入 X 官方 API，不建设全网 X 监控平台，不复制 `source_items`、topics、plans 或内容项目。

用户显式启动一次今日情报或 List 趋势观察后，WMB 才可为本次所选 List 创建有限的非 AI 后续观察；未启动时不自行扫描。观察只在当前活动 data-root 运行，不唤醒 Pi，不在应用退出或工作空间非活动时运行。

## 2. 已证实基线

- 真实 WMB-1604 回执已证明当前账号可读 owned List、读回动态并将 5 条帖子写入 `source_items`。
- `readXListTimeline` 当前同时从 `ListLatestTweetsTimeline` 响应和 DOM fallback 解析 replies、reposts、likes、bookmarks、views；字段允许 `null`。
- `collectBoundXListTimeline` 在平台读取后重新验证 account、binding 和 revision，再写 `source_items` 与最新 List cache。
- `source_items` 不保存结构化 metrics；`x_list_timeline_cache` 按 `(account_key, list_id)` 单行覆盖，因此当前没有同一帖子的多时点指标。
- topics、`topic_source_links`、plan item 的 `whyNow/timeliness/angle/pointOfView/sourceIds/topicId` 以及 Today → Studio 已存在并可复用。

实施前仍须补两条当前证据：

1. 在当前 Windows 包和真实登录账号中读回至少一条 `posts[].metrics` 结构化非空值；旧回执只证明动态读取，不能替代该证据。
2. 用最小 fixture 证伪或确认 `captureListLatestTweetsTimeline` 的 List-ID 不匹配响应是否会串入当前读取；只有复现后才修。

## 3. 产品流程

```text
用户显式开始今日情报/趋势观察
→ 冻结 workspace/profile/account/List/binding revision
→ 串行读取所选 List，资料继续走 source_items 去重
→ 为返回帖子追加原始指标快照
→ 为每个所选 List 安排 +15m、+60m、+180m 三次有界观察
→ 确定性计算浏览流速与流速变化
→ Pi 基于真实趋势证据聚合同事件并判断内容机会
→ Today 展示“为什么是现在”并沿原链进入 Studio
```

后续观察重新读取完整的有界 List 时间线，因此既能更新已见帖子，也能发现观察窗口内的新帖子。每个 List 串行执行；不同活动根绝不并行。

## 4. 数据模型

新增一张根内 append-only 表 `x_post_metric_snapshots`，不修改 `source_items` 的资料身份语义：

| 字段 | 语义 |
| --- | --- |
| `id` | 稳定快照 ID |
| `source_item_id` | 规范帖子 URL 对应的现有资料 |
| `account_key` / `list_id` / `binding_id` | 采集身份与来源 |
| `captured_at` | 真实读取时间 |
| `scheduled_for` | 初次读取为空，后续任务记录目标时间 |
| `normalized_json` | views/likes/reposts/replies/bookmarks 的数值与字段状态 |
| `raw_json` | 页面/响应原始标签和值及解析来源 |
| `evidence_json` | workspace/profile/binding revision、页面 URL、读取方式 |
| `created_at` | 写入时间 |

约束：

- 同一 observation/job 重放只产生一个快照；不同真实 `captured_at` 追加而不覆盖。
- `value`、`unavailable`、`parse_failed` 沿用 CAP-011；缺失不能写成 `0`。
- 快照写入前再次核验当前活动 workspace、账号、List binding 和 revision；迟到结果零写入。
- List cache 继续只保存最新浏览状态，不能充当历史真相。

## 5. 趋势计算

趋势是业务读取时的确定性投影，不把派生分数写回原始快照：

```text
views_per_hour = (current.views - previous.views) / elapsed_hours
velocity_change = current_interval.views_per_hour - previous_interval.views_per_hour
```

- 至少两个相隔 10 分钟、views 均为 `value` 且计数不下降的快照才返回流速。
- 至少三个合格快照才返回 `velocity_change`，正值表示加速，负值表示减速，零表示持平。
- 计数下降、时间倒序、字段缺失或样本不足统一返回 `data_insufficient` 和稳定 reason，不制造负浏览量或 AI 猜测分数。
- 初版不加入黑盒综合热度公式；Today 同时展示当前值、时间窗、每小时增量、采集时间和证据来源。

## 6. 有界观察与恢复

- 初次读取由用户显式动作触发；只为本次冻结的 X Lists 创建 +15m、+60m、+180m metric jobs。
- jobs 复用现有 `due_at`、dedupe、claim、recover 机制，但使用独立 kind 和当前根 browser/account/binding payload。
- 观察只在活动根、WMB 正在运行时执行；切换前必须停止领取新 job 并排空当前原子读取。
- 非活动根零进程、零数据库/WAL/cache/snapshot 写入。
- 应用重开后，只执行仍处于帖子 24 小时观察期内的最近一个逾期窗口并记录真实 `captured_at`；更老窗口以 `OBSERVATION_WINDOW_EXPIRED` 结束且不补造快照。
- 登录、挑战或账号变化进入 `needs_user`；一个 List 失败不回滚其他 List 已提交快照。
- 不使用 Windows Service、云调度器、Redis、官方 X API 或隐藏浏览器。

## 7. 事件与机会复用

- Pi/Skill 继续通过现有 `knowledge.record_batch`、topic canonical key 和 `topic_source_links` 合并同一事件；不新增平行事件库。
- 一个机会继续引用多个真实 `sourceIds` 和可选 `topicId`。
- 趋势业务读取把快照 ID、流速、窗口和数据状态加入每日综合上下文；非空机会必须能回指真实 source 和 snapshot。
- Today 现有卡片保留等级、时效、入选理由、表达角度、观点和进入创作，只增加趋势证据与事件来源展开。
- “建议参与方式”仅表示内容形式和表达策略；不自动回复、点赞、引用、转发或最终发布。
- UI `createProjectFromPlanItem` 已保留 topic/source。外部 MCP 从 plan item 创建内容时也必须读回同一 topic、guidance 和 sources，不能只保存 `plan_item_id`。

## 8. 共享业务面

新增最小业务能力：

- 保存一次已核验的 X post metric observation；
- 按 source/post 读取有界快照和趋势；
- 显式开始/读取/停止一个有界观察 session；
- Today/workbench 返回机会引用的 trend evidence。

UI、IPC、MCP 和 Pi 复用这些业务函数，并可显式启动同一个有界观察命令。调用方只能选择当前根已启用的 List binding，不能传入任意 URL、账号、根、节奏或 job payload，也不获得任何 X 社交写入或确认能力。

## 9. 验收

### EVAL-024 X 帖子指标历史与趋势

- 当前 Windows 包用真实根、真实 X 登录和同一 List 完成至少三次真实读取。
- 同一规范帖子 URL 只对应一个 source item，但 SQLite 读回三个不同 `captured_at` 的快照。
- 结构化 views 与 raw label/page source 同时存在；两点流速和三点速度变化按公式精确读回。
- `null`、parse failure、计数下降、短间隔和不足样本均不产生假趋势。
- List-ID 响应隔离有 focused regression；若基线可复现串入，根因修复后通过。

### EVAL-025 有界观察、机会和根隔离

- 一次显式启动只创建冻结 List 的三个后续窗口，重复请求不重复建 job。
- AI/UK 相同 List/post/account fixture 的 job、snapshot、cache、source 和 topic 全部根内隔离。
- 冷切换后旧根不运行 job、不写 DB/WAL/cache；迟到响应零写入，旧 MCP/runtime 失效。
- 登录/账号变化得到准确 `needs_user`，部分 List 失败保留其他成功快照。
- 多帖同事件聚合为一个 topic/机会，Today 展示可审计趋势证据，UI 与 MCP 创建内容后保留相同 plan/topic/source 链。
- 1100×700、1366×768、1920×900 的 Today/Discover 正常命中测试、零横向溢出；最终 Windows 包完成真实读回。

## 10. 非目标

- 全中文 X 或任意账号的全网爬取；
- 24×7 后台服务、应用关闭后采集或多个工作空间并行；
- X 官方 API；
- 自动社交互动、自动发布、批量养号；
- 复制 xgrowth 的收益榜、粉丝导出、影子封禁或批量取关工具；
- 黑盒“爆款分”或用模型填补缺失指标；
- 为趋势另建资料库、事件库或 Agent 运行时。

## 11. 顺序任务链

1. `WMB-2200`：冻结合同、当前结构化 metrics 真实基线与 List-ID 响应最小复现。
2. `WMB-2201`：实现解析状态与 append-only 根内帖子指标快照。
3. `WMB-2202`：实现确定性趋势投影和共享只读业务 API。
4. `WMB-2203`：实现显式启动的有界观察 jobs、恢复、停止和根生命周期。
5. `WMB-2204`：把趋势证据接入事件聚合、Today/Discover、Pi/MCP 和原有创作链。
6. `WMB-2205`：完成 EVAL-024–025 的当前 Windows 包真实验收。
