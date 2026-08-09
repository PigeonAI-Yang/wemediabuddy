# WeMediaBuddy × Pi 融合实施计划

- 状态：实施中
- 日期：2026-07-28
- 范围变更来源：用户明确要求 WMB 内置能够响应界面业务意图的 Pi Agent
- 目标：用户在 WMB 点击智能业务按钮后，Pi 自动接手并把结果写回原页面，不再依赖聊天窗口转述

## 1. 产品裁决

WMB 保持业务工作台和唯一事实源；Pi 成为默认内置执行者；Skill 定义工作方法；WMB MCP 是 Pi 读写业务数据的唯一入口。

首版不建设聊天产品、通用工作流引擎或多 Agent 编排，只打通：

> Today 点击“开始今日情报” → Pi 执行资讯 Skill → 资料与当日方案写入 WMB → Today 自动显示内容机会

确定性按钮继续直接调用现有业务命令。只有寻找、判断、研究、创作、改写和复盘等需要推理的显式操作才创建 Pi 任务。

## 2. 运行架构

```text
React UI
  └─ narrow IPC: start/get/cancel Agent task
       └─ Electron Main
            ├─ agent_tasks: durable execution envelope
            ├─ Pi RPC supervisor
            │    └─ Pi process + fixed Skill
            │         └─ thin WMB MCP proxy extension
            └─ existing WMB MCP
                 └─ existing business commands
                      └─ SQLite / files
```

Pi 首版使用 RPC 子进程，不把 AgentSession 直接运行在 Electron Main：

- Pi 故障不拖垮窗口、数据库、MCP 和浏览器；
- RPC 提供严格 JSONL 通信、流式事件、中止和会话操作；
- WMB 可在退出时先中止任务，再终止子进程；
- 只有真实测试证明 RPC 不满足需求时，才重新评估 SDK 或 Electron Utility Process。

Pi 随 WMB 安装包放在独立 `resources/.r` 目录，像内置 Python 一样由 WMB 使用固定路径启动。它不被编译进 `app.asar`，因此后续可单独下载、校验并原子替换；短目录名同时规避 Squirrel.Windows 对安装包内部路径的 260 字符限制，升级失败时继续使用现有版本。

### 2.1 模型与认证

WMB 不复用、复制或刷新其他 Agent 的 OAuth 凭证。Pi 使用用户在 WMB 中单独配置的 OpenAI-compatible API：

- Base URL；
- API Key；
-模型名称。

用户可用 CPA 反向代理统一管理上游 Agent 登录态。WMB 只保存这组 Pi 连接配置，并在启动 Pi 时注入；产品不再要求用户进入独立终端执行 `/login`。

Pi 的默认任意 shell、文件编辑和数据库访问不得用于 WMB 业务操作。Pi 仅获得：

- WMB MCP 代理工具；
- 当前任务明确允许的研究工具；
- 绑定的版本化 Skill。

## 3. 第一条业务闭环

### 3.1 用户操作

Today 空态或标题区域显示“开始今日情报”。点击本身即授权本次研究以及资料、方案写入，不增加第二次确认。

### 3.2 最小任务信封

```json
{
  "task_id": "stable-id",
  "intent": "daily_intelligence",
  "plan_date": "2026-07-28",
  "skill": "wemedia-intelligence-engine",
  "wmb_mcp_url": "http://127.0.0.1:PORT/mcp",
  "acceptance": {
    "sources_min": 1,
    "plan_required": true,
    "opportunities_max": 3
  }
}
```

任务信封不包含完整资料、历史正文、页面快照或模型历史。Pi 必须先通过 `context.get_workbench` 读取最新业务上下文。

### 3.3 完成判定

Pi 的文本输出或 `agent_end` 不能单独代表完成。WMB 只有在业务回读同时证明以下事实后才把任务标记为成功：

1. 至少一条真实、可追溯资料已经落库；
2. 指定日期存在 current plan；
3. plan item 引用了真实 source ID；
4. plan item 数量为 1–3；
5. Today 能读取并显示同一结果。

## 4. 最小持久状态

新增 `agent_tasks`，不复用只承载确定性任务的现有 `jobs`：

```text
id
intent
status
phase
pi_session_id
context_refs_json
result_refs_json
error_code
error_message
created_at
updated_at
finished_at
```

首版状态只保留：

- `running`
- `succeeded`
- `failed`
- `interrupted`

同一 intent 和业务日期已有 `running` 任务时，重复点击返回原任务。MCP 写入使用 `task_id + logical_step` 形成稳定 `request_id`，继续依赖现有幂等与 revision conflict。

应用或 Pi 在运行中退出时，任务转为 `interrupted`。首版允许用户重新执行，不建设自动断点续跑。

## 5. 全局 Pi 对话区

每一个主页面的右侧固定保留同一个 Pi 对话区。切换 Today、资料库、Studio、发布、结果、诊断或设置时，会话和正在执行的任务不丢失。

- 宽屏展开宽度约 360–400px；
- 左侧边缘提供一个很小的箭头按钮；
- 收起后只保留箭头，不遮挡页面内容；
- 展开状态本地记忆；
- 对话默认继承当前页面和当前选中业务对象作为引用，不复制完整页面内容；
- 页面原有辅助资料、发布确认和方法结论移入主内容区域或按需抽屉，不与 Pi 长期争抢右栏。

Pi 对话区不是独立聊天首页。它是贯穿业务页面的协作通道，回答、任务状态和需要用户补充的内容都回到当前业务现场。

## 6. 页面反馈

Today 在原页面显示一条轻量任务状态：

```text
今日情报正在生成
正在核验官方发布和开源项目……
已保存 3 条资料
```

用户切页后，标题栏只保留一个可返回原页面的简短运行状态。不得保存或展示模型思维链、完整 transcript 或第二份业务内容。

失败时显示具体原因和“重新开始”。Pi 不可用时显示“设置创作助手”，不得静默失败。

## 7. 安全与产品边界

- Pi 不得直接访问 SQLite 或数据根业务文件；
- Renderer 不得提交任意 prompt、Skill 路径或命令；
- Agent 任务使用固定 intent、固定 Skill 和固定验收器；
- Pi 不得获得任何最终发布确认或执行能力；
- 现有人工发布边界、MCP 幂等和 revision conflict 保持不变；
- 不新增认证、权限系统、审批流或云服务。

## 8. 实施任务

### WMB-1001：真实 Pi 技术探针

在不修改业务结构的前提下验证本机真实 Pi：

1. 锁定官方包名和准确版本；
2. 启动 RPC 子进程；
3. 从 WMB 配置 OpenAI-compatible Base URL、API Key 和模型；
4. 发送固定任务并读取流式事件；
5. 通过薄 MCP 代理调用 WMB MCP；
6. 写入一条隔离数据根测试资料并回读；
7. 验证 abort、进程退出和打包后启动路径。

未取得真实写入与回读证据前，不开始后续实现。

### WMB-1002：更新批准契约

根据已验证的 Pi 能力更新 `PRD.md`、`SPEC.md`、`TECHNICAL_DESIGN.md` 和 `PLAN.md`：

- 增加内置默认 Pi 执行器；
- 保留外部 Agent 通过 MCP 接续；
- 增加 Agent task、UI 意图触发和业务回读验收；
- 删除“不内置 Agent runtime”和“不唤醒 Agent”的冲突表述；
- 保持“不是聊天壳”和“不得自动最终发布”。

### WMB-1003：Pi RPC Supervisor

实现一个单例子进程管理器：

- start/reuse；
- 严格 LF JSONL 解析；
- prompt/abort；
- 当前任务与流式事件关联；
- 退出和管道错误传播；
- WMB 退出时中止并终止；
- 首版同一时间只允许一个 active prompt。

### WMB-1004：WMB MCP Proxy Extension

实现只连接当前 loopback MCP URL 的薄扩展：

- tool list；
- tool call；
- 结构化错误透传；
- 禁止直接业务访问；
- 禁用 Pi 默认任意写文件和执行命令的工具。

### WMB-1005：Agent Task 业务对象

实现 migration、业务命令、窄 IPC 和读取模型：

- start daily intelligence；
- get active/latest；
- cancel；
- renderer 状态事件；
- 重复点击复用；
- 重启将 running 转为 interrupted；
- 成功必须经过业务对象回读验收。

### WMB-1006：Today 端到端闭环

接入“开始今日情报”：

- 全局可收起 Pi 对话区；
- 真实 Pi；
- 真实 `wemedia-intelligence-engine`；
- 真实 WMB MCP；
- 原页状态；
- 自动刷新；
- 资料和 plan 一致回读；
- 错误和重新开始。

### WMB-1007：Studio 首稿闭环

只有 WMB-1006 稳定后实现：

> 选中内容机会 → 让 Pi 写初稿 → 通过 MCP 保存核心版本 → Studio 原页显示正文

该任务不扩展为自由聊天或通用 Agent 操作面。

## 9. 首版验收

打包版必须提供以下真实证据：

1. 不打开 Codex 或其他聊天窗口；
2. Today 点击一次只创建一个真实 Pi task；
3. 页面立即显示运行状态；
4. Pi 通过当前 WMB MCP 读取 workbench；
5. Pi 使用版本化资讯 Skill；
6. 至少一条真实资料和一份引用它的当日方案落库；
7. SQLite、MCP 回读和 Today UI 一致；
8. 快速双击不产生第二个任务或重复业务对象；
9. 初始任务信封不包含完整资料和历史正文；
10. Pi 不可用或退出时显示真实失败，已有写入不丢；
11. Pi 声称成功但业务对象缺失时 WMB 不显示成功；
12. Pi 无法触发任何最终发布动作。
13. Pi 不读取或修改任何其他 Agent 的 OAuth 凭证。
14. 所有页面共享同一个 Pi 对话区，收起、展开和切页不丢失当前会话。

## 10. 明确不做

- 所有按钮 Agent 化；
- Agent 聊天首页或独立聊天中心；右侧 Pi 对话区属于业务现场的一部分；
- 多 Agent 编排；
- 后台定时自动唤醒；
- 通用工作流引擎；
- Prompt 编辑器；
- 第二套 Agent 记忆或业务数据库；
- 保存模型思维链；
- 每次资料或方案写入再确认；
- Agent 自动确认或最终发布；
- 首版自动断点续跑；
- 自研 Agent runtime。
