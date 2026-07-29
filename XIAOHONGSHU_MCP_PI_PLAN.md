# 小红书 MCP 内置与 Pi 接入方案

状态：已批准排期，等待知识系统序列完成后实施  
日期：2026-07-29  
范围：CAP-002、CAP-009、CAP-013、CAP-014  
前置任务：WMB-1310

## 1. 目标

把已验证的 `xpzouying/xiaohongshu-mcp` 固定版本作为 WeMediaBuddy 的内置只读采集工具：

> WMB 启动内置 MCP → Pi 搜索/读取小红书 → Pi 通过现有 WMB MCP 保存资料 → UI 与外部 Agent 读取同一业务对象

完成后，开发版和 Windows 安装包都不依赖用户机器上的 `J:\PigeonYang\tools`、全局 Codex MCP 配置或外部启动脚本。

## 2. 已确认事实

- 当前固定版本为 `xpzouying/xiaohongshu-mcp` v2.1.1。
- 上游已有 `check_login_status`、`search_feeds`、`get_feed_detail`、`user_profile`。
- 上游同时包含发布、评论、点赞、收藏和登录态删除等写能力，不能把完整工具清单交给 Pi。
- 上游默认端口参数为 `:18060`，必须显式绑定 loopback，不能暴露到局域网。
- `cookies.json` 默认跟随进程工作目录，资源目录和 Git 仓库不能作为运行目录。
- 当前 Pi 扩展只连接 `WMB_MCP_URL`；Pi dock 和固定任务的运行环境都没有内置小红书 MCP 地址。
- 当前本机服务可以通过健康检查，但登录状态读取受 Windows 错误 225 阻塞。该问题必须在真实验收中解决或诚实标记为阻塞。

## 3. 产品边界

Pi 只获得四个显式读取工具：

- `xhs_check_login_status`
- `xhs_search_feeds`
- `xhs_get_feed_detail`
- `xhs_user_profile`

不提供通用 `call_xhs_tool(name, args)`，不动态注册上游工具，不向 Pi 暴露上游 MCP URL。

小红书结果仍通过现有 `wmb_save_source` / `sources.upsert_batch` 写入 WMB。小红书 MCP 不直接写 SQLite，不新增第二套资料库。

本阶段不实现对标账号池、定时巡检、评分引擎、反检测策略或自动发布。先完成一个稳定、可验证的内置采集能力；持续追踪在真实读取闭环成立后另行排期。

## 4. 打包与运行目录

固定版本二进制进入一个干净的 vendor 资源目录：

```text
resources/
└─ xiaohongshu-mcp/
   ├─ xiaohongshu-mcp-windows-amd64.exe
   └─ xiaohongshu-login-windows-amd64.exe
```

资源目录不得包含现有 `cookies.json`。

运行数据放在：

```text
<data-root>/
└─ xiaohongshu-mcp/
   ├─ cookies.json
   └─ logs/
```

开发版读取仓库内固定 vendor 资源；打包版读取 `process.resourcesPath`。两者使用同一个 supervisor 和同一套路径规则。

## 5. 主进程生命周期

新增一个最小 supervisor，与现有 WMB MCP、Pi 和浏览器生命周期并列：

1. 数据根可用后创建运行目录；
2. 在 loopback 选择本次 WMB 拥有的空闲端口；
3. 启动固定二进制，工作目录为 `<data-root>/xiaohongshu-mcp`；
4. 显式传入 `-port 127.0.0.1:<port>`；
5. 等待真实 MCP initialize / tools-list，并确认四个目标工具存在；
6. 把内部 URL 作为 `WMB_XHS_MCP_URL` 传给所有 Pi 启动路径；
7. 子进程异常退出时保存 exit code/stderr；下一次需要时可重新启动；
8. 切换数据根前停止旧进程，再用新运行目录启动；
9. WMB 退出时等待子进程结束，不留下孤儿进程。

不能因某个固定端口已有服务就直接复用；否则可能连接到错误版本、错误 cookies 或非小红书服务。

## 6. 登录与状态

首次使用或 cookies 失效时，由用户显式启动打包内的登录程序。登录程序与 MCP 使用同一个数据根运行目录。

状态至少区分：

- `ready`：进程、MCP 工具和登录态均可用；
- `needs_user`：服务可用但需要用户登录；
- `process_failed`：二进制、浏览器子进程或 Windows 拦截导致启动失败；
- `tool_mismatch`：MCP 可连接但固定读取工具缺失。

无结果、登录失效和进程失败不能互相冒充。

## 7. Pi 接入

复用 `.pi/extensions/wmb-mcp.ts` 的 MCP JSON-RPC 客户端，但为 WMB 和小红书保留两个明确服务器地址。

四个小红书 wrapper 使用上游真实参数 schema，固定调用精确工具名。Pi dock、每日情报、Studio 初稿和 Results 复盘的所有 Pi 启动路径都传递相同的内部地址，避免只有某一入口可用。

资讯 Skill 的小红书采集路线改为：

1. 检查登录状态；
2. 按检索目标搜索；
3. 读取候选笔记详情或用户主页；
4. 保留笔记 ID、`xsec_token`、作者/用户 ID、原始 URL、发布时间、采集时间、正文与可见互动证据；
5. 通过 `wmb_save_source` 写入；
6. 用 WMB MCP 按 source ID 回读。

## 8. 实施顺序

1. 固定并验证 vendor 资源；
2. 主进程 supervisor、loopback、数据根和生命周期；
3. 人工登录入口与可读状态；
4. Pi 四工具白名单代理；
5. 资讯 Skill 与 WMB 入库闭环；
6. 开发版故障/恢复检查；
7. Windows 打包真实验收。

## 9. 验收

必须同时证明：

1. 打包资源包含固定版本的两个 EXE，哈希符合清单，不包含真实 cookies。
2. 未启动外部 18060 服务时，WMB 自己启动 child PID 和 loopback MCP。
3. resources、安装目录和 Git 仓库没有新增运行数据；cookies 只出现在所选数据根。
4. Pi 工具列表恰好包含四个 `xhs_*` 读取工具；发布、互动和 cookies 删除工具不可调用。
5. Pi 真实完成登录检查、搜索、笔记详情和用户主页读取。
6. Pi 用现有 WMB 工具保存一条小红书资料，并按 source ID 精确回读。
7. 子进程被终止后，下一次调用能够恢复或返回明确失败；不能伪装成空结果。
8. 切换数据根后旧 PID/端口结束，新进程使用新的 cookies 路径。
9. 退出 WMB 后没有遗留小红书 MCP 进程。
10. 开发版聚焦检查、类型检查、轻量门禁和 Windows 打包验收通过。

Windows 错误 225、登录失效或平台挑战如果仍存在，最终状态必须是 `blocked` 或 `needs_user`，不能用工具注册或健康检查代替真实读取。

## 10. 非目标

- 不自研小红书浏览器采集器；
- 不向 Pi 暴露上游写工具；
- 不打包现有账号 cookies；
- 不新增云服务、账号池、自动注册或验证码处理；
- 不在本阶段实现持续追踪、爆款评分和新 UI 数据驾驶舱。
