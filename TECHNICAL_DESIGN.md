# WeMediaBuddy 技术设计

- 产品：WeMediaBuddy（WMB）
- 状态：已确认
- 日期：2026-07-27
- 对应需求：`PRD.md` 第 1–9 节、第 10 节“当前产品范围”和第 11–12 节

## 1. 技术目标

完整实现 PRD 当前产品契约：

- Windows 桌面应用；
- 本地资料、创作、发布和复盘工作台；
- 外部 Agent 通过 MCP 操作同一业务数据；
- WMB 管理独立 Chrome 和持久登录状态；
- 通过网页完成 X、小红书和微信公众号的发布与数据采集；
- 不依赖内容平台官方 API；
- 不内置 LLM 或 Agent 运行时。

PRD 第 10 节“后续阶段”列出的能力不在当前实现范围内。

## 2. 技术栈

| 领域 | 选择 |
| --- | --- |
| 桌面应用 | Electron |
| 编程语言 | TypeScript |
| 界面 | React + Vite |
| 本地核心 | Electron Main Process |
| 数据库 | Node.js `node:sqlite` |
| 浏览器控制 | Playwright `connectOverCDP` |
| 平台浏览器 | WMB 启动的独立 Chrome/Chromium |
| Agent 接入 | 官方 MCP TypeScript SDK |
| MCP 传输 | 仅监听 `127.0.0.1` 的 Streamable HTTP |
| 桌面调用 | Electron IPC + `contextBridge` |
| 文件存储 | 本地文件系统 |
| 打包 | Electron Forge |

不使用 Next.js、云数据库、Docker、Python 后端、Rust Sidecar、微服务、自研浏览器自动化框架或自研 Agent 运行时。

React 状态优先使用组件状态和 Context。只有出现被多个页面共享的服务端状态需求时，才引入最小的数据查询库；不预先引入 Redux。

## 3. 运行架构

WMB 是一个 Electron 模块化单体。

### 3.1 Electron 主进程

主进程负责：

- 应用和窗口生命周期；
- 业务命令；
- SQLite 访问与迁移；
- 本地素材管理；
- 持久任务调度；
- MCP HTTP 服务；
- Chrome 启动、状态检查和关闭；
- Playwright CDP 连接；
- 平台发布与指标采集。

业务代码按领域拆分，但不拆成独立服务或额外进程。

如果未来真实证明浏览器任务会阻塞或拖垮主进程，再把浏览器执行器迁移到 Electron Utility Process。当前不提前建设。

### 3.2 React 界面进程

Renderer 只负责显示和用户交互：

- 不直接访问 SQLite；
- 不直接读写素材目录；
- 不直接操作 Chrome；
- 不直接启动任务；
- 通过 `contextBridge` 暴露的窄 IPC 接口调用业务命令。

Renderer 保持 sandbox 和 context isolation，不启用 Node integration。

### 3.3 统一业务入口

界面 IPC 和 MCP 工具调用同一批业务函数：

```text
React UI ──IPC──┐
                ├── Business Commands ── SQLite / Files / Jobs / Browser
External Agent ─MCP─┘
```

MCP、IPC 和浏览器适配器都不能绕过业务命令直接修改数据库。

## 4. 领域模块

主进程内部只保留 PRD 必需模块：

- `sources`：资料、来源、摘要、标签和创作角度；
- `planning`：选题和每日运营方案；
- `content`：内容项目、不可变版本和平台版本；
- `assets`：本地图片、视频和其他素材；
- `accounts`：平台账号身份和登录状态；
- `publishing`：发布准备、确认、执行和结果回写；
- `metrics`：平台页面指标和时间快照；
- `reviews`：复盘与方法结论；
- `jobs`：持久任务和恢复；
- `operations`：最小业务操作记录；
- `mcp`：MCP 工具到业务命令的映射；
- `browser`：Chrome 生命周期、CDP 连接和平台适配器。

不建设通用工作流引擎、事件溯源系统、平台 DSL 或选择器配置平台。

## 5. 本地数据

### 5.1 数据目录

用户选择一个明确的数据根目录，WMB 集中保存：

```text
<data-root>/
├─ wmb.db
├─ assets/
├─ browser-profile/
├─ logs/
└─ exports/
```

设置页显示实际路径、用途、占用空间和项目数量。运行数据不进入 Git 仓库。

数据库和文件只保存相对数据根目录的路径，允许用户整体移动或备份数据目录。

### 5.2 SQLite

使用单个 SQLite 数据库、顺序迁移和事务，不增加 ORM。

核心表族：

- `sources`
- `topics`
- `plans`
- `plan_items`
- `content_projects`
- `content_versions`
- `assets`
- `platform_accounts`
- `publications`
- `metric_snapshots`
- `account_metric_snapshots`
- `reviews`
- `method_findings`
- `jobs`
- `operation_log`

平台特有字段和原始指标使用 JSON 保存；跨平台稳定字段使用普通列。不同平台不建立重复业务表。

内容修改创建新版本。更新命令携带当前 revision，旧版本写入返回冲突和最新版本，防止不同 Agent 用旧上下文覆盖新内容。

## 6. MCP 接入

WMB 运行时启动本地 Streamable HTTP MCP Server：

```text
http://127.0.0.1:<port>/mcp
```

设置页显示 MCP 地址、运行状态和连接说明。

MCP 工具按业务能力组织：

- 资料查询、保存和整理；
- 选题与运营方案读写；
- 内容项目和版本读写；
- 素材查询与关联；
- 发布准备和状态查询；
- 指标快照查询；
- 复盘和方法结论读写；
- 待处理工作查询。

WMB 不为 Codex、Claude Code、OpenCode、Oh My Pi 或 WorkBuddy 编写业务专用连接器。支持 Streamable HTTP MCP 的 Agent 直接连接；只有真实目标 Agent 仅支持 stdio 时，才增加薄转发程序。

每日侦察、运营方案和复盘由用户打开任意外部 Agent 后发起。WMB 提供待处理工作、资料上下文和写入工具，不定时唤醒 Agent，也不执行模型推理。

## 7. 浏览器执行器

### 7.1 Chrome 生命周期

WMB 负责：

1. 使用专用 `browser-profile` 启动可见 Chrome/Chromium；
2. 启用仅本机可访问的远程调试端口；
3. 通过 Playwright `connectOverCDP` 连接；
4. 保持浏览器可见，允许用户随时接管；
5. 检测浏览器退出、登录失效和连接中断；
6. 在设置页显示浏览器进程、数据目录、端口和账号状态。

不连接用户日常 Chrome，不复制其 Cookie，不隐藏浏览器用户目录。

### 7.2 平台适配器

当前实现三个薄适配器：

- X；
- 小红书；
- 微信公众号。

每个适配器只实现共同业务契约：

- `identifyAccount`
- `prepare`
- `publish`
- `readBackPublication`
- `collectMetrics`

适配器内部直接实现对应网页流程。出现第二处真实重复后再抽取公共辅助函数，不预建通用网页自动化框架。

### 7.3 当前发布格式

- X：文字、图片和视频帖子；
- 小红书：图文和视频笔记；
- 微信公众号：文章。

直播、音频、付费文章及三个平台之外的发布格式不在当前范围内。

## 8. 发布一致性

发布采用明确状态：

```text
draft
→ prepared
→ awaiting_confirmation
→ publishing
→ published
```

失败状态：

- `failed`：确认没有发布成功，可以修正后重新准备；
- `needs_user`：登录、验证码或页面变化，需要人工接管；
- `unknown`：点击发布后无法确认结果，禁止自动重试。

Agent 可以准备发布，但不能完成人类确认。用户必须在 WMB 界面看到准确的平台、账号、最终内容和素材后进行一次性确认。

确认绑定内容版本、平台、账号和素材。任何一项发生变化，原确认立即失效。

发布成功必须取得帖子地址或平台页面中的等价稳定身份，并回写 `publications`。点击成功、页面跳转或无错误日志都不能单独视为发布成功。

`unknown` 状态必须先由用户或适配器通过账号内容页对账，不能自动重复点击发布。

## 9. 指标与复盘

指标以 `publication_id + captured_at` 追加快照，不覆盖历史值。

每个快照同时保存：

- 归一化公共指标；
- 平台原始标签和值；
- 数据来源页面；
- 采集时间；
- 不支持或不可见的字段状态。

不可见指标记为 `unsupported` 或 `unavailable`，不能写成 `0`。

账号级粉丝等指标保存到独立的 `account_metric_snapshots`，不混入帖子快照。

平台适配器从帖子页或创作者后台读取当前账号可见指标。首次实现时以真实登录账号页面为准，将每个平台的稳定字段写成独立适配器验收清单。

复盘必须引用对应的内容版本、发布记录和指标快照。方法结论进入 `method_findings`，下一份运营方案的条目可以引用资料、历史复盘和方法结论 ID，形成可验证的反馈链。

## 10. 任务调度与恢复

SQLite `jobs` 表保存：

- 指标采集；
- 到期复盘提醒；
- 浏览器操作后的待确认事项；
- 其他不需要模型推理的确定性任务。

主进程用一个定时器等待最近的 `due_at`。应用退出时不运行；重新启动后恢复到期任务。

任务状态：

- `pending`
- `running`
- `succeeded`
- `failed`
- `needs_user`

重启恢复规则：

- 指标采集等可安全重试任务从 `running` 回到 `pending`；
- 发布任务从 `running` 转为 `needs_user`，禁止自动重发；
- 已保存的指标快照和发布身份永不因后续失败被删除。

不使用 Redis、Bull、独立任务服务或 Windows 后台常驻服务。

## 11. 界面信息架构

第一版完整界面包含五个主区域：

- `Today`：待处理工作、每日情报和运营方案；
- `Studio`：资料、选题、内容项目、版本和素材；
- `Publish`：平台版本、账号、确认、执行状态和人工接管；
- `Results`：指标快照、趋势、复盘和方法结论；
- `Settings`：数据目录、MCP、Chrome、平台账号和日志状态。

界面只呈现 PRD 当前操作，不增加社交、团队、权限、插件市场或 Agent 聊天界面。

## 12. 业务验收

不单独建设技术验证项目。实现完成只按 PRD 业务闭环验收。

至少完成以下真实链路：

1. 用户从外部 Agent 发起每日运营；
2. Agent 通过 MCP 保存资料、运营方案和选题；
3. 同一内容在 WMB 界面可见并可由另一个 Agent 接续修改；
4. Agent 通过 MCP 保存 X、小红书和微信公众号的对应平台版本；
5. 用户在界面确认准确账号、最终内容和素材；
6. WMB 通过独立 Chrome 完成约定格式的真实发布；
7. 发布身份回写数据库；
8. WMB 从网页采集平台可见指标并形成历史快照；
9. Agent 根据内容版本和指标写入具体复盘与方法结论；
10. 后续运营方案能引用此前资料、复盘和方法结论。

三个平台和约定发布格式均属于当前完成条件。局部命令成功、测试通过、窗口可见或单个平台可用，都不代表完整 PRD 已实现。
