# WMB-5146 Evidence — 智能体页布局整改 Patch（三区连续架构：活动实例区 → 班组概览 → 统一历史区）

- 日期：2026-08-10
- 合同：`.ai/wmb-5146-contract.md`（Patch）；设计真源 `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` §11/§12.2.6/§17、PRODUCT C9、PRD REQ-028/REQ-029、SPEC CAP-027/EVAL-030；用户 2026-08-10 实机截图验收反馈（5145 视觉验收失败：五组卡片散落、大面积碎片化空白、主次层级断裂）
- 改动文件：
  - `src/renderer/agents-roster-view.tsx`（重写信息架构与 DOM 层级：五角色大卡网格 → 三区连续结构；check.ps1 `(Get-Content).Count` 口径 467 → 526）
  - `src/renderer/styles-agents.css`（重写布局区样式；836 → 942）
  - `src/renderer/agents-instance-logic.ts`（新增纯展示逻辑：`EMPLOYEE_ORDER` / `sortInstancesForDisplay` / `activeRoleSections` / `roleOverviewStatus`；228 行 ≤500 无注册 cap）
  - `tests/wmb-5143-agents-instance-view.test.mjs`（新增 6 条 5146 fixture 渲染/结构/响应式门；12 → 18 条，291 行 ≤500）
  - `scripts/line-caps.json`（agents-roster-view.tsx 467→526、styles-agents.css 836→942，均 = check.ps1 `(Get-Content).Count` 精确匹配）
  - `.ai/wmb-5146-evidence.md`（本文件）

## Background / 根因（Change 1）

实施前复核：`.agents-groups` 为 `repeat(auto-fit, minmax(min(100%, 360px), 1fr))` 五角色分组网格。用户 1568×1014 视口（右侧 Pi 约 350px，主区约 1030px）下每行只能容纳 2 组（2×360+gap > 1030 时 3 列折行），五组渲染成 2×3 孤岛（首行 desk/reporter/planner，次行 writer/librarian + 空位），每组卡高度不一导致行内大段空白；1440 全宽下 auto-fit 变 3 列 → 3+2 布局同样散落。空角色仍各占一张大卡（只有一行「当前无任务」），grid `align-items: start` 使行高塌缩不均、视觉断裂。

## Implementation（Change 2-5）

**信息架构重做（Change 2）**：删除 `.agents-groups` 五卡网格，改为单一滚动主区 `.agents-main` 内连续三区：
1. **活动实例区**（`.agents-active`，主工作区，仅当存在当前 filter 下可见实例的角色时才渲染）：按固定员工角色序（reporter/planner/writer/librarian）竖向堆叠角色节（`.agents-role-group`，沿用 5143 类名），节内实例卡网格 `repeat(auto-fit, minmax(min(100%, 240px), 1fr))` —— 同角色多实例并列展开；单实例用 `:has(> .agents-instance-card:only-child)` 收窄为 `minmax(280px, 460px)` 紧凑卡，不占满整行。零可见实例时整区不渲染（filter≠all 时渲染一行紧凑筛选空态），无任务角色不再占大卡。
2. **班组概览**（`.agents-overview`，始终可见）：五角色（含桌助）连续紧凑目录，`repeat(auto-fit, minmax(min(100%, 190px), 1fr))`——≥950px 可用宽度一排五格、窄屏自动换行、min(100%) 单列保底，无横向溢出；每格 = 头像 + 角色名 + 房间 + 状态（空角色「当前无任务」/ 被 filter 隐藏「当前筛选无匹配实例」/ 有实例显示状态词 + 在办计数 + 「查看实例」跳转按钮）。
3. **统一历史区**（`.agents-history-area`）：只收集有历史的角色（`historyRoles`），每角色 `<details>` 折叠（`历史 · N`，最近 5 条），全部默认收起 → 无参差高度。

**展示逻辑（Change 3，agents-instance-logic.ts 纯函数，fixture 可断言）**：
- `sortInstancesForDisplay`：needs_user 最前（等你批主次明确）→ running → waiting_resource → queued，displayNumber/jobId 兜底 → 跨轮询排列稳定。
- `activeRoleSections`：活动实例区角色节 = 有可见实例的角色 × 固定角色序（无实例角色不占区）。
- `roleOverviewStatus`：概览行三态（empty/filtered/active，状态词取排序后首实例）。
- `EMPLOYEE_ORDER` 定员（不含 desk）：桌助永不进活动实例区，只在概览以协调入口行出现。

**层级/视觉（Change 4）**：needs_user 卡强化 info 边框（60%）+ 内环 + 5% 底色；桌助概览行 `.is-desk` 淡 accent 底、无实例卡 → 视觉弱于活动实例；标题层级 h1 智能体班组 → h2 活动实例/班组概览/历史工单 → h3 角色名（顺序无跳级）；聚焦全部走 `outline: 2px solid var(--accent)`（新增 `.agents-overview-jump:focus-visible`，按钮由全局 foundation 覆盖）。

**状态/过滤/空态/错误（Change 5）**：页头摘要/过滤按钮、needs_user「等你批」停留、续派/关闭/取消/复制 jobId、历史一键续派全部保持 5143 语义；加载门 `projection === null && !stale`、stale banner + 重试、`requestSeq` 并发守卫、deskConflict 危险 callout 与桌助状态点/词双编码保持；`prefers-reduced-motion` 下进度 transition 关闭、概览跳转 scrollIntoView 用 `behavior:'auto'`。

## 真实 DOM 验证（fixture 驱动，浏览器实机渲染，同用户视口）

方法：dev server（27391）真实加载 renderer，`evaluateOnNewDocument` 注入完整 window.wmb mock（onboarding/settings/投影/roster/容量/头像），点侧栏「智能体」进入本视图，采集 DOM/布局数据。三档视口 × 三态覆盖如下（均为实测 getBoundingClientRect）：

**空态（zero active + 2 条策划历史），1568×1014（Pi 开，主区 940px）**：
- `.agents-active` 不渲染；`.agents-overview` 5 行全部「当前无任务」（桌助状态行 + 4 员工 `agents-role-empty`）；`.agents-history-area` 紧接其下（y=553，`历史 · 2`）；主区 sw=cw=940、body 1568==winW → **无横向溢出、无孤岛、无空区**（概览 258px + 16px gap + 历史 74px 连续）。

**多实例 + needs_user（2 reporter + 1 planner needs_user），1568×1014**：
- 活动实例区 2 节（reporter/planner，writer/librarian 不占区）；卡片序 = 记者 #2（等你批）→ 记者 #1（工作中）→ 策划 #1（等你批）——**needs_user 优先排序生效**；记者 #2 与 #1 同排并列（x=245/w=452 与 x=707/w=452，同 y=359）——**2 reporter 实例并列可辨**；needs_user 卡实测 borderColor `color(srgb 0.296 0.482 0.649)`（info）+ 底色 tint——**等你批主次明确**；概览行「记者 2 等你批 查看实例」「策划 1 等你批 查看实例」+ writer/librarian 当前无任务；needs_user 卡动作 = 复制 jobId / 续派 / 关闭；点击「等你批」过滤 → 仅 2 张等你批卡可见。连续堆叠无空区：reporter 节 y=313 h=249 → planner 节 y=578 h=213 → 概览 y=807，节间 gap 恒 16px；无横向溢出。

**1440 全宽（Pi 收，workspace 1224）**：概览 5 格同排（y=846 一行，w=227×5：x=245/480/715/949/1184）；reporter 双卡并列 578px×2；planner 单卡收窄为 460px（`:has` 单卡约束生效）；sw=cw=1192 无溢出——**1440 不散**。

**窄屏 1100（Pi 开，主区 472px）**：实例卡单列堆叠（记者#2 → #1 → 策划，各 446px）；概览 2 列换行（219px×2，3 行）；sw=cw=472 无溢出——**窄屏单列**。

**a11y/交互**：查看实例按钮、摘要过滤按钮、头像按钮聚焦均 `solid 2px rgb(139 124 255)`（accent）——**全部聚焦绿**；点「查看实例」→ 活动实例区 scrollIntoView（目标节 top -166 → 291）；reduced-motion 分支存在于代码（`matchMedia('(prefers-reduced-motion: reduce)')`）。

## Commands / Results（Change 6-7）

- `node --test --test-concurrency=1 tests/wmb-5143-agents-instance-view.test.mjs tests/agents-roster-conflict.test.mjs tests/wmb-5145-crew-multi-instance-acceptance.test.mjs tests/wmb-5142-instance-projection.test.mjs`：**58/58 PASS**（5143 文件 18 条 = 12 原 + 6 新增 5146 门；conflict 11 条；5145 验收 15 条 + 5142 投影 14 条——5143 原有 DOM/样式/加载门与 5145 A1..A14 全部原样保持绿，功能语义零回归）。
- 新增 6 条门：display 排序 needs_user 优先且幂等；活动实例区角色节（固定序/过滤/节内排序）；概览三态（empty/filtered/active + leader 词）；三区连续架构 DOM 门（agents-main/active/overview/history-area，无 agents-groups）；桌助协调入口概览行门；响应式样式门（auto-fit 240px 实例网格、:has 单卡、auto-fit 190px 概览、needs_user 底色、统一历史区、jump focus-visible、prefers-reduced-motion、无 seat/slot 术语）。
- `npx tsc --noEmit`：PASS（0 错误）。
- line-cap（check.ps1 `(Get-Content).Count` 口径）：`agents-roster-view.tsx` 526（cap 467→526）、`styles-agents.css` 942（836→942）——与 `scripts/line-caps.json` 精确匹配；`agents-instance-logic.ts` 228、`tests/wmb-5143-agents-instance-view.test.mjs` 291、`tests/agents-roster-conflict.test.mjs` 128（均 ≤500 无注册 cap）。按合同跳过 formatter/lint/全量/check.ps1/check:capabilities（主 Agent 统一执行）。

## Acceptance 对照

- 用户截图同等视口（1568×1014）不再出现 2×3 孤岛与大块空白：实测主区 940px 下三区连续（空态 258+16+74，多实例 249+16+213+16+258），节间恒 16px，无孤岛网格（`agents-groups` 已删除，静态门 + 实测双证）✓
- 空态页面连续且紧凑：五组概览行始终可见且明确「当前无任务」，活动区零渲染，历史统一折叠，无参差高度 ✓
- 2 reporter 实例并列可辨：1568/1440 双视口实测同排双卡，活动期编号 #1/#2 + 独立状态词 ✓
- needs_user 主次明确：节内排序最先 + info 边框/底色 + 续派/关闭动作；过滤与概览状态词联动 ✓
- 1440 全宽不散 / 1100 窄屏单列 / 均无横向溢出：三档实测（1192/940/472 主区，sw==cw）✓
- 桌助协调入口且视觉弱于活动实例：概览行 + `.is-desk` 淡底 + 无实例卡，desk 分支先返回 ✓
- 功能语义零回归：`tests/wmb-5143-agents-instance-view.test.mjs` 保持通过（12 原条全绿）；实例投影/权限/Skill 面零改动（diff 仅视图/css/纯展示逻辑/测试/linecaps）✓
- 全部聚焦绿：跳转/摘要/头像聚焦实测 accent outline；linecap 精确匹配 check.ps1 口径 ✓
- 门禁：typecheck 0（自验）；聚焦套件 58/58；renderer smoke（`scripts/smoke-renderer.mjs`，需运行中 dev server 与 Electron 环境）与 `npm run check:capabilities`（G1，registry 零触碰）由主 Agent 统一执行；三视口×三态 Electron 实机截图（隔离 data root）由主 Agent 验收入档 ✓

## Impact

- **Capability registry**：no change —— `agent-capabilities.ts`/`page-authority.ts` 零触碰（纯 renderer 布局/样式整改）。
- **Pi operator Skill**：no change —— 无提示词/工具面变更。
- **已知边界**：实机截图三态（Electron + 隔离 data root）由主 Agent 执行；本文档的 DOM/布局数据来自同视口真实浏览器渲染（fixture 投影数据驱动，隔离于真实 data root，未触发任何平台动作）。

---

# 附：WMB-5146 后续 — 恢复 500 行硬规则（line-cap 拆分收口）

- 日期：2026-08-10（视觉重构落地后同一工作波次）
- 目标：视觉重构把 `agents-roster-view.tsx` / `styles-agents.css` 推高到 526/942 行，靠 line-caps 抬高规避 500 行项目硬规则；本收口恢复规则 —— 所有触及源文件 ≤500（check.ps1 `(Get-Content).Count` 与物理行双口径），不得再以 >500 cap 规避。

## 拆分（DOM/classnames 零变更，纯机械搬迁）

**视图（按业务区边界拆出独立 presentational 组件，沿用 `library-view-parts`/`pi-dock-utils` 相邻模块惯例）**：
- `src/renderer/agents-roster-parts.tsx`（新增，40 行）：roster 族共享展示原语 `StatusDot` / `roleLabel` / `clock` / `stampLine` + `RosterRow` 数据形状（主视图、实例组件、概览组件三方共用，非无意义 utils）。
- `src/renderer/agents-roster-instances.tsx`（新增，155 行）：活动实例区 —— `InstanceCard`（原 renderInstanceCard）、`ActiveRoleInstances`（原 renderActiveSection，`data-role`/`aria-labelledby`/实例网格 DOM 原样）、`RoleHistoryList`（原 renderHistory，`历史 · N` 折叠 DOM 原样）+ `HISTORY_LIMIT`。
- `src/renderer/agents-roster-overview.tsx`（新增，119 行）：班组概览 —— `RoleHead`（原 renderRoleHead，桌助 `labelZh/roomZh` 投影回落表达式逐字保留）与 `RoleOverviewRow`（原 renderOverviewRow，desk 分支先返回 / `deskState` 双编码 / 三态空文案逐字保留）。
- `src/renderer/agents-roster-view.tsx`（528 → 333 行）：保留数据接线（投影/roster/容量/头像轮询、`requestSeq` 并发守卫、stale 门）、页头摘要/过滤、派单条、deskConflict callout、`scrollToRole`、头像裁剪对话框，主区三区骨架改为消费上述组件（props 1:1 传入 `busy`/`onCopyJobId`/`onRedispatch`/`onCancel`/`onJump`/`onPickAvatar`）。

**样式（按组件区拆分，经 `styles.css` 既有 `@import` 机制挂载；跨区无重复选择器，级联顺序不受影响）**：
- `src/renderer/styles-agents.css`（942 → 479 行）：页面外壳 —— roster/team-card/页头摘要/loading/主滚动区与活动实例区容器（1-147）、派单条/row-action/进度条/reduced-motion（612-711）、头像裁剪 modal（712-772）、Settings panel（773-943）。
- `src/renderer/styles-agents-overview.css`（新增，161 行）：概览网格/角色头/状态行（148-308）。
- `src/renderer/styles-agents-instances.css`（新增，170 行）：实例卡/历史区（309-478）。
- `src/renderer/styles-agents-status.css`（新增，133 行）：状态点/状态词/job stamp/term-mark 双编码原语（479-611）。
- `src/renderer/styles.css`：`styles-agents.css` 单行 import 展开为 4 行（agents → overview → instances → status，与原单文件相对顺序一致）。

## line-caps 收口（scripts/line-caps.json）

- 移除 `src/renderer/agents-roster-view.tsx: 526` 与 `src/renderer/styles-agents.css: 942` 两条 >500 注册（两文件现已 ≤500，无需 cap）；**未新增任何 >500 cap**。
- 顺带修正既有 stale cap：`tests/wmb-5142-instance-projection.test.mjs` 734 → 736（该文件为同波 WMB-5142 新增未跟踪文件，实际 736 行，cap 落后 2 行导致 check.ps1 500 行门红；按「cap = 精确当前行数」惯例上调，非新增 cap）。

## 测试 source gates 迁移（tests/wmb-5143-agents-instance-view.test.mjs、tests/agents-roster-conflict.test.mjs）

- 随代码搬迁把 DOM 门指向新文件：实例卡/历史门（`agents-instance-number`、`复制 jobId`、`续派/关闭/取消`、`agents-role-history`、`历史 · {history.length}`、`agents-instance-list`、`agents-role-group`、`data-role={roleId}`）→ `agents-roster-instances.tsx`；概览门（`agents-role-empty">当前无任务`、`if (roleId === 'desk')`、`deskState` 双编码、`agents-overview-jump`、桌助标签回落表达式、`协调入口` 文案）→ `agents-roster-overview.tsx`；主视图保留接线/摘要/加载/冲突门。
- CSS 门改读拆分文件：状态点/词双编码 → `styles-agents-status.css`；实例卡/历史/单卡约束 → `styles-agents-instances.css`；概览网格/jump focus → `styles-agents-overview.css`；reduced-motion/shell → `styles-agents.css`；无 seat/slot 术语对 4 个 css 文件与 4 个 tsx 文件联合断言。
- 三区连续架构门中 `sections.map(renderActiveSection)` / `ORDER.map(renderOverviewRow)` 相应更新为 `sections.map(...)`+`<ActiveRoleInstances>` / `ORDER.map(...)`+`<RoleOverviewRow>`（组件渲染走点已加入断言）。

## 验证结果（本收口自验）

- 行数双口径全部 ≤500：`agents-roster-view.tsx` 333、`agents-roster-instances.tsx` 155、`agents-roster-overview.tsx` 119、`agents-roster-parts.tsx` 40、`styles-agents.css` 479、`styles-agents-overview.css` 161、`styles-agents-instances.css` 170、`styles-agents-status.css` 133（PowerShell `(Get-Content).Count` 与物理行均 ≤500，均无注册 cap）。
- 结构保真（静态对比，旧文件逐字重建于工作区基线）：64/64 静态 className、8/8 className 模板（含 desk 双编码表达式）、34/34 可见文案节点、aria/role/title 字面量集合全部一致；tag/attr 差异仅为预期组件边界（`renderActiveSection`→`ActiveRoleInstances` 等，`key` 位置随组件上移）。CSS 943 行全覆盖无缺漏（规则数：shell 72、overview 22、instances 27、status 28 与原文件逐组一致）。
- `node --test --test-concurrency=1 tests/agents-roster-conflict.test.mjs tests/wmb-5142-instance-projection.test.mjs tests/wmb-5143-agents-instance-view.test.mjs tests/wmb-5145-crew-multi-instance-acceptance.test.mjs`：**58/58 PASS**（拆分后门全部重指向并通过）。
- `npm run typecheck`：PASS（0 错误）。
- check.ps1 500 行门：PASS（含 wmb-5142 cap 修正后全仓无超限/欠限）；check.ps1 其余失败仅剩既有 idea-intake（WMB-5138/5139/5140 done 缺合同文件），与本拆分无关、未触碰。

---

# 附：P2 收口 + 独立复审（ReviewWmb5146Visual） + 主验证入账（ledger closure）

- 日期：2026-08-10（WMB-5146 入账波次）

## 独立复审结论（reviewer subagent `ReviewWmb5146Visual`，复审记录 history://ReviewWmb5146Visual）

- 结论：**approved**（overall_correctness: correct，confidence 0.85）。用户 2026-08-10 截图三问题（碎片化空白/五卡散落/层级失败）在真实 renderer 关闭：独立 Playwright 于 1568×1014（Pi 开，主区 940px）/1440（1192px）/1100（472px）实测 docOverflowX=0、`.agents-groups` 孤岛网格已删、三区连续几何与 evidence 一致、needs_user 排序 + info 边框/底色、全聚焦 accent outline、桌助弱化；typecheck 0、聚焦 58/58、patch 文件双口径 ≤500 且无 >500 cap、禁改路径零 diff。
- Finding P2（priority 2）：统一历史区 `<details>` summary 丢失角色标签（仅「历史 · N」，无 aria-label）。**已由主 Agent 修复**：`RoleHistoryList` 增 roleId prop（调用点 `agents-roster-view.tsx:310-312` 传 `roleId={roleId}`），summary 改 `{roleLabel(roleId)} · 历史 · {history.length}`（`agents-roster-instances.tsx:134`）；复验 `tests/wmb-5145-crew-multi-instance-acceptance.test.mjs` + `tests/wmb-5142-instance-projection.test.mjs` **29/29 PASS** + `npm run typecheck` 0 错误 → closed。
- Finding P3（priority 3）：check.ps1 `Get-Content` 缺 `-Encoding UTF8` 在本机 codepage 936 下低估 CJK 文件行数（wmb-5142 736 vs 真实 768），为**非阻断预存 infra 发现**——本次 patch 文件真实字节行数亦 ≤500 无违规，按合同不扩 scope（不改 check.ps1）。
- 剩余实机风险（review 注明）：evidence 的 Electron 截图为主 Agent 验收项；legacyBusy 概览路径为 5143 预存语义。均不阻断本任务。

## 主验证（main verification，入账复跑确认）

- `node --test --test-concurrency=1 tests/wmb-5143-agents-instance-view.test.mjs tests/agents-roster-conflict.test.mjs tests/wmb-5145-crew-multi-instance-acceptance.test.mjs tests/wmb-5142-instance-projection.test.mjs`：**58/58 PASS**（5143 文件 18 = 12 原 + 6 新增 5146 门；conflict 11；5145 验收 15；5142 投影 14）。
- `npx tsc --noEmit`：PASS（0 错误）。
- `npm run check:capabilities`（G1）：PASS（Capability registry check passed，registry 零触碰）。
- `node scripts/smoke-renderer.mjs`（dev server 27391 运行中）：`[wmb-smoke] ok`。
- `node scripts/check-ledger.mjs`：8/8 PASS（本任务入账后复跑）。

## Impact / 入账

- **Capability registry**：no change —— `agent-capabilities.ts`/`page-authority.ts` 零触碰。
- **Pi operator Skill**：no change —— 零触碰 Skill 与提示词。
- **Ledger**：WMB-5146 `doing → done`（四项 done receipts 齐）；WMB-5145 `blocked → doing`（依赖 5146 满足，恢复验收）；Current state 同步唯一 doing = 5145。
