# WeMediaBuddy

> AI 驱动的自媒体人机协同终端：Agent 主路径生产，人类定事、批事、担责。

WeMediaBuddy（WMB）是一款面向个人创作者的 Windows **自媒体人机协同应用终端**（形态对齐 Agent 主路径终端，**不是**「人写为主、AI 侧栏辅助」的写作 IDE，也不是传统 CMS）。

它首先回答的不是“今天发什么”，而是：

> **今天有什么真正值得做？为什么值得做？应该怎么讲？**

默认由 Agent 完成侦察、整理、归主题、出选题与起草准备；你作为主编在「今日」办公桌批呈报、派工、监工与确认发布。WMB 把散落在新闻、产品发布、开源项目、Skill、社区讨论和个人实践中的信息，转化为可以长期积累的资料、主题、判断、内容与方法。

产品形态宪法：`PRODUCT.md` · `PRD.md` §2.0 · `SPEC.md` §1.0

## 仓库地址

```text
https://github.com/PigeonAI-Yang/wemediabuddy
```

Git 克隆地址：

```text
https://github.com/PigeonAI-Yang/wemediabuddy.git
```

## 产品愿景

多数 AI 内容工具只负责生成一段文字，生成之后，资料、判断和结果仍然散落在聊天记录里。

WeMediaBuddy 希望建立一条持续运转的内容经营闭环：

```text
每日侦察
→ 资料入库
→ 机会判断
→ 运营方案
→ 人机讨论
→ 内容创作
→ 多平台适配
→ 人工发布
→ 数据采集
→ 创作复盘
→ 改进下一轮运营
```

目标不是让 AI 批量制造内容，而是让人类与 AI 长期共同经营一个个人品牌，并把每天产生的情报、观点、内容和结果沉淀为自己的资产。

## 核心能力

### 今天有什么值得做

- 发现重要 AI 新闻、新产品、新模型、新工具和开源项目；
- 关注 Skill、MCP、GitHub Trending 与社区正在升温的问题；
- 保存原始来源、摘要、判断、创作角度和适合的平台；
- 从信息中保留全部达到标准的内容机会，并按 `SSS → S → A → B → C → D → E → F` 排列。

### 人机共同创作

- 资料、选题、观点、草稿和素材保存在同一个工作现场；
- 内置 Pi 可以在每个页面与用户讨论并执行明确的智能任务；
- 获得用户授权的外部 Agent 也能通过 MCP 接续同一份业务状态；
- 更换 Agent 不等于丢失工作。

### 内容资产与多平台版本

- 核心内容使用不可变版本保存；
- 为 X、小红书和微信公众号准备不同的平台版本；
- 资料、内容、素材和发布结果保持可追溯关系；
- 不为了多平台分发制造重复、低价值内容。

### 发布与复盘

- WMB 使用独立、持久的专用浏览器登录态；
- 最终发布按钮始终由用户在平台页面手动点击；
- 人工发布后可以回填公开链接并采集网页可见指标；
- 复盘形成明确的 Keep、Stop、Change，并影响下一轮选题。

## 产品原则

1. **Agent 主路径，人类终审**：默认由 Agent 侦察、整理、归主题、出选题与起草；人类定方向、批呈报、派工、监工、确认发布并担责。
2. **判断优先于生成**：先判断什么值得做，再开始写；不得把未成选题的原料堆给主编代替呈报。
3. **人类掌舵**：用户负责目标、观点和最终责任；AI 持续协作，不是侧栏聊天装饰。
4. **同一个事实源**：界面、内置 Pi 和外部 Agent 操作同一份本地数据。
5. **大胆但克制**：标题和开头要有冲击力，但正文必须兑现承诺。
6. **发布保持人工确认**：不自动点击平台最终发布按钮。
7. **结果回到下一轮**：数据不是展示面板，而是下一次决策的依据。

## 技术方向

- Electron、React、TypeScript；
- SQLite 本地数据根；
- MCP 业务工具；
- 内置、可独立升级的 Pi RPC 运行时；
- 用户配置的 OpenAI-compatible 模型服务；
- 专用 Chromium、CDP 与 Playwright；
- Windows 桌面优先。

## 当前状态

项目仍在开发中，任务进度以 [`TASKS.md`](./TASKS.md) 为唯一台账。

当前重点是让内置 Pi 真正融入桌面工作现场：先完成可直接使用的连续对话，再逐步接通页面上下文、资料操作、今日情报、内容创作和复盘。

## 安装与运行

当前仓库尚未发布 Windows 安装器。现阶段请从源码运行或生成本地 Windows 打包目录。

### 环境要求

- Windows 10 或 Windows 11；
- Git；
- Node.js 24；
- npm 10 或更高版本；
- Microsoft Edge、Google Chrome 或其他可用的 Chromium 浏览器。

### 从源码运行

```powershell
git clone https://github.com/PigeonAI-Yang/wemediabuddy.git
cd wemediabuddy
npm ci
npm start
```

首次启动向导会依次完成：

1. 创建默认工作空间，或选择现有数据目录；
2. 配置并实际测试 OpenAI-compatible 模型连接；
3. 按需登录小红书、X、微信公众号；
4. 进入主界面。平台登录可跳过，工作空间与 AI 配置不可跳过。

API Key、浏览器登录态和业务数据只应保存在本机，不要提交到仓库。

### 生成 Windows 安装包

```powershell
npm ci
npm run build
```

本地 Windows 构建使用短路径避免 Squirrel/NuGet 的 260 字符限制；默认输出到当前盘根目录的 `wmb-out`：

```text
<当前盘>:\wmb-out\WeMediaBuddy-win32-x64\WeMediaBuddy.exe
<当前盘>:\wmb-out\make\squirrel.windows\x64\WeMediaBuddy Setup.exe
<当前盘>:\wmb-out\make\squirrel.windows\x64\RELEASES
<当前盘>:\wmb-out\make\squirrel.windows\x64\*.nupkg
```

`npm run package` 只生成免安装应用目录；`npm run build` 生成 Squirrel.Windows 安装器。正式发布由 `.github/workflows/release.yml` 在受保护的 `release` Environment 中签名并上传为 GitHub Draft Release，随后人工提升为 prerelease、验收，再转正式版本。证书 Base64 和密码只允许存入 GitHub Environment Secrets `WMB_WINDOWS_CERTIFICATE_BASE64`、`WMB_WINDOWS_CERTIFICATE_PASSWORD`，不得写入仓库、缓存、日志或构建产物。

## 文档

- [`PRD.md`](./PRD.md)：产品愿景与范围
- [`SPEC.md`](./SPEC.md)：可观察行为与验收契约
- [`PLAN.md`](./PLAN.md)：交付阶段
- [`TASKS.md`](./TASKS.md)：唯一任务台账
- [`TECHNICAL_DESIGN.md`](./TECHNICAL_DESIGN.md)：技术架构
- [`DESIGN.md`](./DESIGN.md)：界面设计规范

## 安全与数据

WMB 以本地优先方式保存业务数据。运行数据、浏览器登录态、API Key、Cookie 和个人内容不应提交到仓库。

## License

许可证尚未确定。在正式添加许可证前，代码版权归项目作者所有。
