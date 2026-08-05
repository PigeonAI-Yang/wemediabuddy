# WeMediaBuddy 技术设计

- 本次架构修订：2026-08-05，工作空间隔离的人机协同目标合同

- 产品：WeMediaBuddy（WMB）
- 状态：已确认
- 日期：2026-07-27
- 对应需求：`PRD.md` 第 1–9 节、第 10 节“当前产品范围”和第 11–14 节

## 1. 技术目标

完整实现 PRD 当前产品契约：

- Windows 桌面应用；
- 本地资料、创作、发布和复盘工作台；
- 内置 Pi 和外部 Agent 通过 MCP 操作同一业务数据；
- WMB 管理独立 Chrome 和持久登录状态；
- 通过网页完成 X、小红书和微信公众号的发布与数据采集；
- 不依赖内容平台官方 API；
- 不内置模型权重；随应用附带一套独立、可替换升级的 Pi RPC 运行目录。

PRD 第 10 节“后续阶段”列出的能力不在当前实现范围内。

本文定义 WMB-4800 批准的目标架构；当前代码并未因本文自动达到该目标。实现与迁移只按 PLAN 的 WMB-4801–WMB-4809 和 EVAL-029 验收，不得借此新增微服务、通用 Agent/工作流框架或角色/权限系统。

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

WMB 是一个 Electron 模块化单体。一个安装可登记多个完整 data-root 工作空间，但同一时间只装载一个 ActiveWorkspaceRuntime；不把现有 SQLite 改造成共享库多租户系统。

以下 3.1–3.4 是 WMB-4801–4809 的批准目标，不是当前实现陈述。当前基线仍存在独立开库/事务的 IPC/MCP 写入口、单一全局 Pi supervisor、一个规范化共享浏览器 profile 与仅统计在途请求的 WorkspaceRuntimeGate。迁移必须复用既有工作空间注册表、切换 journal、权威 workspace/capability 读取和 publication 安全状态；每个目标入口验收后删除对应 legacy write route，不并行保留第二套写架构。

### 3.1 InstallationContext

InstallationContext 是安装级唯一真相，拥有应用本体、固定 Pi runtime/model preset、共享 Skill library、浏览器 executable、BrowserProfile registry 与 defaultProfileId。物理浏览器 profile/Cookie 只保存在 installation userData，不进入任何 data-root 或 SQLite。它不保存资料、内容、任务、grant、账号 snapshot、回执或其他业务数据。

创建工作空间时，UI 在创建事务内把 defaultProfileId 显式写成该根的初始 browserProfileId，并建立根内 expected account snapshot 和 binding revision；运行时绝不按路径、名称或“最近登录”猜测 profile。Owner 后续可通过 UI 改绑或创建/选择独立 profile。多个根可以绑定同一 defaultProfileId，但根内的账号 snapshot、来源/List binding、cache、operation、grant、receipt 和业务事实绝不共享。

### 3.2 ActiveWorkspaceRuntime and Electron Main

ActiveWorkspaceRuntime 是活动根的唯一 owner，拥有一个 runtimeEpoch、数据库连接、command dispatcher、串行业务写队列、MCP endpoint、scheduler、browser lease 和 Pi worker lease。当前范围每个活动根最多一个 Pi RPC worker；其 lease 仍绑定 runtimeEpoch、taskId 和 command dispatcher，使 Pi 进程不成为第二权威。并发读取/研究可有界运行；提高 Pi worker 容量或多 Agent 并行编排属于后续阶段。

主进程负责：

- 应用和窗口生命周期；
- InstallationContext、应用级工作空间注册表与冷切换监督；
- ActiveWorkspaceRuntime 生命周期与 command dispatcher；
- SQLite 访问与迁移；
- 本地素材管理；
- 持久任务调度；
- MCP HTTP 服务；
- BrowserProfile registry、browser lease、Chrome 启动、状态检查和关闭；
- Playwright CDP 连接；
- 平台发布与指标采集。

业务代码按领域拆分，但不拆成独立服务或额外进程。

如果未来真实证明浏览器任务会阻塞或拖垮主进程，再把浏览器执行器迁移到 Electron Utility Process。当前不提前建设。

### 3.3 React 界面进程

Renderer 只负责显示和用户交互：

- 不直接访问 SQLite；
- 不直接读写素材目录；
- 不直接操作 Chrome；
- 不直接启动任务；
- 通过 `contextBridge` 暴露的窄 IPC 接口调用业务命令。

Renderer 保持 sandbox 和 context isolation，不启用 Node integration。

### 3.4 统一业务入口

界面 IPC、内置 Pi、外部 MCP、scheduler 和 browser adapter 都调用同一个 command dispatcher；既有图中的 Business Commands 是 dispatcher 后的 domain commands：

```text
React UI ──IPC──┐
                ├── Business Commands ── SQLite / Files / Jobs / Browser
External Agent ─MCP─┘
```

每个请求携带 CommandEnvelopeV1；dispatcher 验证 workspaceId、runtimeEpoch、actor、taskId、requestId、inputHash、grant 和 causation，串行提交 domain write、receipt 与 audit。相同 workspace/requestId 和 hash 返回同一回执，hash 不同冲突。MCP、IPC、Pi、scheduler 和浏览器适配器都不能绕过 dispatcher 直接修改数据库；chat/session/模型输出也不构成授权。

工作空间列表、当前身份、官方目录和配方提案属于有限的应用级控制命令；资料、内容、发布、复盘及其他业务命令始终只访问当前 MCP URL 绑定的活动根。当前身份由一个共享业务读取生成权威 workspace/capability snapshot，统一带出 workspace/data-root 身份、profile revision、能力包、发布平台子集、固定能力可用性和官网/X Lists 渠道就绪摘要；UI、IPC、MCP 与 Pi 不各自重构或缓存另一份真相。

## 4. 领域模块

主进程内部只保留 PRD 必需模块：

- `sources`：资料、来源、摘要、标签和创作角度；
- `planning`：选题和每日运营方案；
- `content`：内容项目、不可变版本和平台版本；
- `assets`：本地图片、视频和其他素材；
- `accounts`：平台账号身份和登录状态；
- `publishing`：发布准备、人工接管和结果回写；
- `metrics`：平台页面指标和时间快照；
- `reviews`：复盘与方法结论；
- `jobs`：持久任务和恢复；
- `operations`：最小业务操作记录；
- `mcp`：MCP 工具到业务命令的映射；
- `browser`：安装级专用 Edge profile、进程生命周期、CDP 连接和平台适配器。
- `x-lists`：所有自媒体工作空间共享的固定 X List 读写、授权、读回和发现信源绑定；Pi/外部 Agent 在 task grant 内准备创建或成员变更，只有 matching precise execution grant 才能进入浏览器，编辑和删除还要求 UI-only gate；所有路径经 dispatcher 持久化 operation，再由当前根 browser lease 串行完成。BrowserProfile registry 安装级共享，profile 由根显式绑定；账号快照、缓存、绑定、操作、grant、回执和资料始终随当前 data-root 隔离。
- `intelligence-channels`：固定官网/X Lists 来源配置、解析/试读、逐来源回执和共享每日预检/扫描编排；不是插件加载器。
- `workspaces`：应用级注册表、根身份校验和单活动根切换；
- `workspace-profiles`：有限字段的当前配方、编译期官方目录和会话级提案确认。
- `pi-skills`：安装级 Pi Skill 清单、原子 SKILL.md 增删改、默认 Skill tombstone 和已登记 data-root 副本同步；不提供业务插件加载或新权限。
- `pi-commands`：从当前根受监管 Pi RPC 的 `get_commands` 读取真实扩展命令、提示模板和 Skills，去除源文件路径后交给输入框；不保存静态目录或提供执行 IPC。

不建设通用工作流引擎、事件溯源系统、平台 DSL 或选择器配置平台。

## 5. 本地数据

### 5.1 数据目录

应用在 Electron `userData` 下保存最小工作空间注册表、安装级 Pi 模型预设、浏览器 executable、BrowserProfile registry/defaultProfileId、物理 profile 目录，以及普通共享 Pi Skills 的权威副本和默认 Skill 删除记录；不保存业务数据或素材。用户选择的每个 data-root 都完整保存：

```text
<data-root>/
├─ wmb.db
├─ assets/
├─ browser-profile/          # 旧根兼容目录；不再承载活动 Edge 登录态
├─ pi-agent/
├─ xiaohongshu-mcp/
├─ logs/
└─ exports/
```

设置页显示实际路径、用途、占用空间和项目数量。运行数据不进入 Git 仓库。

数据库和文件只保存相对数据根目录的路径，允许用户整体移动或备份数据目录。

每个根的既有 `app_meta` 保存与注册表一致的 `workspace_id`。重新关联移动后的根必须核对该身份；不能按目录名或路径猜测。现有根只补身份和配方记录并原地登记为 AI 工作空间，不搬迁业务数据。

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
- `x_list_bindings`
- `x_list_operations`
- `x_list_operation_items`
- `website_sources`
- `source_scan_receipts`
- `x_post_metric_snapshots`
- `workspace_browser_bindings`
- `task_grants`
- `precise_execution_grants`
- `command_receipts`
- `publication_snapshots`

`operation_log` remains the minimal audit history; `command_receipts` owns normalized replay/result evidence and does not duplicate domain truth. Existing `mcp_request_results` remains readable while callers migrate, then becomes a read-only compatibility projection. The new tables and binding metadata are root-local. Browser registry/physical profile paths stay installation-owned.

平台特有字段和原始指标使用 JSON 保存；跨平台稳定字段使用普通列。不同平台不建立重复业务表。

X List 帖子继续以规范 URL 复用 `source_items`。`x_post_metric_snapshots` 只追加当前根真实读取到的指标时间点，保存 account/List/binding 身份、scheduled/actual time、normalized/raw/status/evidence；它不复制帖子正文或充当第二资料库。List 浏览 cache 仍可覆盖最新 payload，但不得用于历史趋势。

内容修改创建新版本。更新命令携带当前 revision，旧版本写入返回冲突和最新版本，防止不同 Agent 用旧上下文覆盖新内容。

每个根只保存一个带 revision 的当前有效 `WorkspaceProfileV1`。字段固定为显示名称、受众、内容目标、纯文本编辑简报、情报包与创作包 ID/版本和平台子集；情报包只承载受众/编辑上下文和真正的赛道展示/判断差异，不承载官网/X Lists 执行代码。复盘暂留固定内核，不接受任意执行配置。AI/UK 官方模板先以编译期数据随应用发布，不实现插件加载器、旧包兼容层或通用执行图。

平台子集限制新方案的平台选择、新平台版本、发布执行和平台专属运行时，不删除历史读回，也不限制情报输入。官网与 X Lists 是固定共享能力而不是新的 profile 字段：每个根使用自己的 website source、X 账号快照、List binding、缓存、扫描回执和 source feed；安装级 BrowserProfile registry 提供 defaultProfileId，新根显式继承该绑定，Owner 可在 UI 改绑或创建独立 profile。既有 AI source-index 与 `AI前沿` 转成 AI 根的普通可见配置；所有包只消费本根明确启用的来源，AI profile 只继续控制排行榜等真正的 AI 专属能力。

`website_sources` 只保存当前根网站配置并引用一个既有 `source_feeds`：用户输入、规范入口 URL、启用/解析状态、最近错误和 revision。`x_list_bindings` 继续是 X List 配置真相。一个共享业务读取把两者投影成相同的渠道来源摘要，不复制 X List 身份。`source_scan_receipts` 记录 task/workspace/module/source 身份、检查时间、状态、候选/保存数量和错误；它是任务证据，不是第二资料库。Agent 的来源变更候选可临时保存；执行必须用当前根持久 task grant 派生的 precise execution grant，经 dispatcher 原子写入来源、receipt 与 audit。需要 UI-only gate 的变更由 UI 签发该 grant；重启不把临时候选升级成授权。

未确认提案只保存在当前 Main 进程内，重启即失效。已有工作空间的确认在其根内单事务更新 profile revision；若它是活动根，随后必须用既有有界重启协议替换所有 profile-bound runtime 和 MCP URL，不在活进程内重绑。新工作空间先在用户选择的空目录中幂等完成根身份、schema 和有效 profile，再原子加入注册表，激活仍走独立的重启协议。注册前崩溃不会改变当前活动根，候选根可按稳定身份重新校验或关联。

### 5.3 单活动根切换

切换前由主进程关闭 mutation gate，停止新 claim，拒绝新写入，只等待当前单一 SQLite commit 或单一不可分割浏览器动作到达安全点，并检查 Pi、情报/创作/复盘任务和浏览器外部写入；无法安全排空时恢复 gate 且不推进 journal。目标根只读校验通过后，注册表写入 `previous + pending`，主进程把未确定外部动作持久化为 `needs_user`/`unknown`，停止 Pi、Chrome、小红书 MCP、scheduler 和 MCP Server，关闭 SQLite，再调用 Electron 正常重启。每个 live runtime 生成新的 opaque runtimeEpoch；写事务前必须再次校验 workspace+epoch+lease，旧事件和旧 grant 零写入。首期不在同一进程内重绑 renderer 和全部运行时。

重启后先把 pending 标记为 attempting，再按正常事务迁移和核心业务读回打开目标根；成功才提交 active。目标启动失败或 attempting 期间进程退出时，下次启动恢复 previous；如果 previous 也无法打开，明确报告恢复失败。成功切换由新进程产生新 MCP URL，旧连接和旧 URL 全部关闭，非活动根不运行后台任务。

## 6. MCP 接入

WMB 运行时启动本地 Streamable HTTP MCP Server：

```text
http://127.0.0.1:<port>/mcp
```

设置页显示 MCP 地址、运行状态和连接说明。

MCP URL 每次工作空间切换后重新生成，并在连接信息中同时显示当前 workspace ID 和名称。旧 URL 不转发到新根。

MCP 工具按业务能力组织：

- 资料查询、保存和整理；
- 选题与运营方案读写；
- 内容项目和版本读写；
- 素材查询与关联；
- 发布准备和状态查询；
- 指标快照查询；
- 复盘和方法结论读写；
- 待处理工作查询。
- 通用 `x_lists.*`：当前根 X List 读取、直接创建/成员变更、编辑删除准备、绑定和限量信源收集，不含确认工具；
- 通用 `intelligence_channels.*`：当前根官网/X Lists 配置与就绪读取、网站名称/URL候选解析和试读、List 名称/URL/ID候选解析、来源变更准备、grant/receipt 读回、今日预检和逐来源回执读取；不暴露 UI-only grant 签发工具；
- 工作空间列表/当前身份、官方模板与能力包目录读取、配方提案提交。

最后一组应用级 MCP 工具只读或准备提案；不能确认、激活、删除工作空间，也不能接收任意文件系统路径。新 data-root 的选择与有效配方激活仅通过窄 IPC 交给 UI 最终确认。

外部 Agent 直接连接 Streamable HTTP MCP。内置 Pi 只增加一个薄 MCP 工具扩展，不复制业务命令。UI/IPC、MCP 和 Pi 的每次渠道调用都通过 dispatcher 重验当前 workspace、runtimeEpoch、browserProfileId、账号与对象 revision。`x_lists.create` 冻结 List 名称和隐私状态；`x_lists.members_add` / `members_remove` 冻结精确 handles；`intelligence_channels.websites_add` 冻结已解析、真实试读的官网批次。以上副作用只能消费 matching precise execution grant 并写回 operation/receipt/真实读回；对话文字和 tool call 本身不授权。X List 编辑/删除及其他产品定义的高风险变更还必须由 UI-only gate 签发 grant。Pi dock 不渲染确定性任务控件，也不把 WMB 后台状态冒充模型消息。

每日侦察、运营方案和创作可由用户在 WMB 中显式触发 Pi，也可从任意外部 Agent 发起。WMB 不定时唤醒 Agent；模型推理由用户配置的 OpenAI Responses 或 OpenAI Chat Completions 兼容服务完成，协议、模型或服务失败时不做静默替换。

## 6.1 Pi RPC executor

- 安装包的 `resources/.pi-runtime` 保存固定版本的官方 Pi CLI 及其生产依赖；
- 该目录不进入 `app.asar`，可独立替换升级；升级必须先验证版本和 RPC 启停，失败时保留现有版本；
- ActiveWorkspaceRuntime 管理当前唯一的 task/conversation Pi worker lease；Pi RPC 子进程通过 LF JSONL 发送固定 intent，并携带 workspaceId、runtimeEpoch、taskId、workerLeaseId、requestId 与 causation 转发事件；
- WMB 在安装级用户目录保存一套加密的 Pi API/model 预设，并为每个根的 Pi 进程注入当前共享预设、该根 MCP URL 和任务上下文；Pi 会话与运行文件仍按 data-root 隔离，不读取其他 Agent OAuth；
- 固定 runtime 同版打包上游 `pi-vision-tool`；每次启动生成的模型目录同时声明当前主模型和显式视觉模型，视觉扩展复用同一加密 API 预设，通过 `describe_image` 直接调用兼容 `/chat/completions` 并把文字结果返回主模型。它不启动第二套 Agent、不切换主会话模型、不获得 WMB MCP 以外的新业务权限；
- WMB 把安装级普通 Pi Skills 原子同步到每个根的 `pi-agent/skills/`；Pi 原生按 name/description 发现并按需读取，系统 operator 和根专属 lane Skill 不受普通 Skill CRUD 影响；
- Pi dock 在用户输入 `/` 时按需读取该进程的 `get_commands`；Main 只返回 name、description 和受限 source，Renderer 负责筛选与键鼠插入，提交仍走现有 `pi:chat`；
- Pi 会话投影保留 assistant content 中 thinking、text、toolCall 与对应 toolResult 的发生顺序并合并连续 assistant 条目；Renderer 对旧快照做同样的兼容合并，工具节点默认只渲染一行摘要，原始输入/输出留在该行的按需展开详情中；根内会话索引用可选 `archivedAt` 控制菜单可见性，归档不移动、重写或删除会话 JSON 与 Pi session 文件；
- Pi 业务写入只能经薄 WMB MCP 进入当前根 dispatcher，最终发布能力不暴露给 Pi。

## 7. 浏览器执行器

### 7.1 Chrome 生命周期

WMB 负责：

1. 从安装级 BrowserProfile registry 取得当前根显式绑定的 profile，并在获得 browser lease 后启动可见 Edge/Chromium；
2. 启用仅本机可访问的远程调试端口；
3. 通过 Playwright `connectOverCDP` 连接；
4. 保持浏览器可见，允许用户随时接管；
5. 检测浏览器退出、登录失效和连接中断；
6. 在设置页显示浏览器进程、数据目录、端口和账号状态。

不连接用户日常浏览器，不复制 Cookie，也不引入指纹浏览器。新根默认绑定 defaultProfileId，因此通常无需重复登录；Owner 可为需要不同账号的根创建/改绑独立 profile。工作空间切换会停止旧浏览器进程、CDP 和 lease，目标根按自己的 binding revision 重新取得 profile。

### 7.2 平台适配器

当前实现三个薄适配器：

- X；
- 小红书；
- 微信公众号。

每个适配器只实现共同业务契约：

- `identifyAccount`
- `prepare`
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
→ 用户在平台页面手动发布
→ published（只读回读确认）
```

失败状态：

- `failed`：确认没有发布成功，可以修正后重新准备；
- `needs_user`：登录、验证码或页面变化，需要人工接管；
- `unknown`：人工发布后无法确认结果，需要对账。

Agent 和 WMB 只能准备编辑器。用户必须在平台网页中看到准确账号、内容和素材，并亲自点击最终发布按钮。

准备记录绑定内容版本、平台、账号和素材。任何一项发生变化，必须重新准备。

发布成功必须取得帖子地址或平台页面中的等价稳定身份，并回写 `publications`。点击成功、页面跳转或无错误日志都不能单独视为发布成功。

`unknown` 状态必须通过账号内容页对账；WMB 不得点击或重试平台发布按钮。

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

用户显式启动的 X List 趋势观察复用同一 jobs 基础，但使用独立 kind：初次真实读取后只为冻结 List 创建 +15m、+60m、+180m 三个窗口。任务重新核验活动 workspace、浏览器账号、binding ID/revision 后串行读取并追加快照；切换根时停止领取、排空当前读取并随旧 Chrome/runtime 一起关闭。旧根不运行，过期窗口不补造快照。

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

第一版完整界面包含六个主区域：

- `Today`：待处理工作、每日情报和运营方案；
- `Discover`：AI 榜单、当前根所选 X Lists 动态和其他用于找题材的外部发现内容，不承载来源配置；
- `Studio`：资料、选题、内容项目、版本和素材；
- `Publish`：平台版本、账号、确认、执行状态和人工接管；
- `Results`：指标快照、趋势、复盘和方法结论；
- `Settings`：官网/X Lists 情报渠道、来源配置、就绪状态和扫描回执，以及数据目录、MCP、Chrome、平台账号、Pi Skills 和日志状态。

顶栏或等价的持久位置显示当前工作空间；Settings 提供列表、重启式安全切换、移动后重新关联，以及官方模板或 Agent 配方提案的精确差异确认。不新增工作空间搭建聊天页，用户继续使用现有 Pi dock 或外部 Agent 描述目标。

Pi dock 输入框提供贴近输入框的斜杆命令面板，直接呈现当前 Pi RPC 实际加载的扩展命令、提示模板和 Skills。面板只负责发现、筛选和插入，不复制命令实现、不自动发送、不绕过既有 Pi/MCP/发布确认边界。

界面只呈现 PRD 当前操作，不增加社交、团队、权限、插件市场或 Agent 聊天界面。

## 12. 业务验收

不单独建设技术验证项目。实现完成只按 PRD 业务闭环验收。

至少完成以下真实链路：

1. 用户从外部 Agent 发起每日运营；
2. Agent 通过 MCP 保存资料、运营方案和选题；
3. 同一内容在 WMB 界面可见并可由另一个 Agent 接续修改；
4. Agent 通过 MCP 保存 X、小红书和微信公众号的对应平台版本；
5. 用户在界面确认准确账号、最终内容和素材；
6. WMB 交付约定格式的最终平台版本与素材，由用户人工发布；
7. 用户可选回填发布链接；
8. WMB 从已回填链接采集平台可见指标并形成历史快照；
9. Agent 根据内容版本和指标写入具体复盘与方法结论；
10. 后续运营方案能引用此前资料、复盘和方法结论。

工作空间扩展还必须完成：现有 AI 根零业务搬迁登记；AI/UK 冷切换和失败回滚不串线；每个新根显式绑定 defaultProfileId，Owner 可改绑/创建独立 profile，活动根 binding revision 更新后冷重启并使旧 runtime/MCP URL/lease 失效；UI、IPC、MCP 与 Pi 读回同一权威 workspace/capability snapshot；UK 新根的真正 AI-only sentinel 保持零调用；第三自媒体工作空间经 Agent 提案和 UI 确认后完成资料、方案、内容及至少一个平台版本；发布平台子集在新方案、平台版本、发布和平台运行时边界拒绝越界写入且保留历史读回；空页面冷开不隐式创建业务对象；AI、UK 和第三根都能通过相同官网/X Lists 模块管理本根来源，逐来源回执证明零更新成功、部分失败保留和全部阻塞预检；即使绑定同一 defaultProfileId，账号 snapshot、List/URL binding、grant、receipt 与 source item 也不跨根。

三个平台的约定平台版本均属于当前完成条件；真实发布本身不是完成门槛。
