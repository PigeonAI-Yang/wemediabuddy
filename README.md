# WeMediaBuddy

> 人类与 AI 共同操作的自媒体运营伙伴。

WeMediaBuddy（WMB）是一款面向个人创作者的 Windows 自媒体运营终端。

它首先回答的不是“今天发什么”，而是：

> **今天有什么真正值得做？为什么值得做？应该怎么讲？**

WMB 把散落在新闻、产品发布、开源项目、Skill、社区讨论和个人实践中的信息，转化为可以长期积累的资料、判断、内容与方法。

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
- 从信息中提炼 1–3 个真正值得投入的内容机会。

### 人机共同创作

- 资料、选题、观点、草稿和素材保存在同一个工作现场；
- 内置 Pi 可以在每个页面与用户讨论并执行明确的智能任务；
- Codex、Claude Code、OpenCode 等外部 Agent 也能通过 MCP 接续同一份业务状态；
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

1. **判断优先于生成**：先判断什么值得做，再开始写。
2. **人类掌舵**：用户负责目标、观点和最终责任，AI 负责侦察、整理、研究、创作与复盘。
3. **同一个事实源**：界面、内置 Pi 和外部 Agent 操作同一份本地数据。
4. **大胆但克制**：标题和开头要有冲击力，但正文必须兑现承诺。
5. **发布保持人工确认**：不自动点击平台最终发布按钮。
6. **结果回到下一轮**：数据不是展示面板，而是下一次决策的依据。

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

首次启动后：

1. 选择 WMB 数据目录；
2. 在“设置”中选择专用浏览器 Profile；
3. 填写提供 OpenAI-compatible 接口的 Base URL、API Key 和模型名称；
4. 回到右侧 Pi 对话区开始使用。

API Key、浏览器登录态和业务数据只应保存在本机，不要提交到仓库。

### 生成 Windows 打包目录

```powershell
npm ci
npm run build
```

完成后从以下位置启动：

```text
out\WeMediaBuddy-win32-x64\WeMediaBuddy.exe
```

`npm run build` 当前生成可运行的 Windows 应用目录，不生成安装向导。正式安装包将在 Release 流程完成后提供。

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
