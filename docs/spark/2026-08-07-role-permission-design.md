# 角色编制 × 授权能力注册表 系统设计（canonical）

- 日期：2026-08-07（v2：合并 Main Agent 可扩展性方案与 Owner 四项新关切，由 Designer 统稿）
- 作者：RoleSystemDesigner（Designer 主导最终行文；吸收 RolePermDesigner 初稿与 Main Agent 架构方案）
- 状态：待 Owner 锁定（§10）
- **本文件 = 唯一 canonical**。它吸收并取代：
  - 同路径 v1 初稿（固定角色 + 权限信息架构）；
  - Main Agent 的「Role/Lane/Capability/Grant 四层 + 智能体页 + 分期」方案（本任务要求强制整合）；
  - 兄弟设计 `docs/spark/2026-08-07-fixed-role-agents-ux-design.md` 的 UX/IA 层——其中「角色不新增一级导航页」的决策**被本文件 §7 修订**（Owner 要求一级「智能体」页）。
- 依据与对齐：PRODUCT.md C1–C7、PRD §4.7/§5.2/§5.5/§5.7、REQ-007/021/022/027、`2026-08-07-pi-page-authority-design.md`（1A/2A/3A 锁定）、`2026-08-06-intelligence-to-topic-agent-design.md`（滚动机会池）、`2026-08-07-fixed-role-agents-ux-design.md`（UX 层）、`2026-08-07-product-form-agent-desk-constitution.md`
- 代码事实：`src/shared/page-authority.ts`、`src/main/task-grants.ts`、`src/main/pi-page-authority.ts`、`src/main/workspace-runtime.ts`、`src/main/agent-runner.ts`、`src/main/pi-operator-skill.ts`、`package.json`（scripts: typecheck/test）、`src/renderer/main.tsx`（view 路由，现无 agents 视图）、`src/main/workspace-mcp.ts`（`workspace.capabilities` = **功能开关**，与本设计授权能力注册表是两条轴，见 §5.1 命名澄清）

---

## 0. 结论（verdict，先行）

1. **四层架构**：`L0 角色编制`（跨赛道稳定）→ `L1 赛道包 Lane pack`（技能/信源/受众，**零权限**）→ `L2 授权能力注册表 Capability registry`（**新写能力的唯一扩展点**）→ `L3 授权运行时 Grant runtime`（TaskGrant/PageGrant/PreciseGrant 签发 + 角色投影 API）。换赛道只换 L1；角色、注册表、授权矩阵一行不改。
2. **编制 = 5 个固定角色**：桌助（主编席）、记者（前线）、策划（策划组·兼复盘）、写手（写字间）、资料员（资料室）。编制锚定「劳动分工类型」，不锚定「劳动对象」→ 赛道变化天然不触发编制变更（§3.4）。不复盘岗、不设发布岗、不设观察岗。
3. **权限 = 注册表投影，不是手写表**。`RoleWrite[role]` = 该角色启用的 Capability 的命令并集；`RoleRead[role]` = 读面并集；`GrantScope` 按任务/页签发，三者在运行时取交集，PreciseGate 拦平台副作用。桌助 = 页级作用域角色，其「页 scope 透传」是**注册表里的显式声明**（§5.6），不是疏漏。
4. **写手对资料库 = 只读借阅**；**资料员 = 只整理，不是选题决策者/主笔/复盘者**；**任何角色（含桌助）不能最终发布、不能硬删资料、不能碰平台副作用**——这三类是注册表中的 `agentGrantable:false` 红线能力，永不出现在任何开关面（§5.5/§10 L15）。
5. **智能体（班组）页 = 一级导航**：roster（谁在干什么）+ 进度 + 详情 + 设置跳转；**今日只留一行值班条**（知情投影，点「查看全部」进智能体页）。班组抽屉方案废弃（被整页取代）。页面只读运行面，**所有可配置项在设置·角色管理**。
6. **防假开关纪律**：未完成 P0（注册表 + 角色过滤 + 只读班组页）之前，**不做任何可配置的权限/角色 UI**——开关只写 `capability_overlays` 覆盖表，且由同一份投影 API 同时驱动「强制执行」与「界面显示」；`agentGrantable:false` 的能力在 UI 上根本渲染不出来（§11.4）。
7. **后端可持续 = 单一真相 + CI 门禁**：每个新写命令必须注册进注册表（命令→能力→默认角色绑定→读面→所属 intent/页），CI 断言「未注册的新写命令 = 构建失败」。这同时回答「新功能权限怎么给」与「后端会不会撑不住」。

---

## 1. 问题与非目标

### 1.1 要解决的问题（按 Owner 关切逐条，含新增四项）

| 现状问题 | 证据 | 对策 |
| --- | --- | --- |
| **P1 角色身份缺失**：所有 Pi 会话同一人格、同一上下文，无法形成「员工班子」 | dock 无收件人概念；worker 只有 `{type:'pi', id:'pi'}`（`task-grants.ts` workers） | §2/L0 编制 + §4 角色身份层 |
| **P2 页级授权过宽**：`page_today` 含 `plans.save/lane_gate/upsert_batch`，`page_library` 含 `lane_gate/lane_restore/upsert_batch` 等，任何对话者都拿到全页写权 | `src/shared/page-authority.ts` | §4.3 页级 scope ∩ 角色能力；§5 注册表收窄 |
| **P3 daily 扫判一体**：`daily_intelligence` scope 同时含 `sources.upsert_batch`（采）与 `lane_gate/plans.save/knowledge.*`（判） | `task-grants.ts` AUTOMATIC_TASK_GRANT_SCOPES | §4.4 拆 `daily_scan`/`daily_judge`，分属记者/策划 |
| **P4 单 lease 卡死**：一名 Pi worker 占用即全站无智能 | `workspace-runtime.ts` `acquireWorkerLease` busy 抛错 | §11 P1 worker 池化；P0 先在 lease 绑 roleId |
| **P5 无越权可见性**：授权失败曾被静默吞掉；错误不区分「角色没权/本页没权/需 UI 确认」 | `pi-page-authority.ts`、`pi-operator-skill.ts` | §4.6 越权原因分类 + chip + BLOCKED + toast |
| **P6 权限与身份混谈**：旧提案把角色写成提示词+Skill 组合，无硬约束落点 | — | §4.1 角色硬约束 = 签发过滤 + envelope 校验 |
| **P7（新·Owner）换赛道要重做权限**：换 赛道（lane）时担心角色/权限要推倒重来 | 无 lane 概念与权限解耦；赛道切换只有 `lane_gate` 判定流水 | §2 四层架构：换赛道 = 换 L1 Lane pack；L0/L2/L3 零改动（§3.4、§10 L13） |
| **P8（新·Owner）新功能权限散装**：每加一个功能就四处手写授权，没有统一的「这个功能谁能用、怎么给」入口 | 现状：新命令要么进 `AUTOMATIC_TASK_GRANT_SCOPES`、要么进 `PAGE_TASK_GRANT_SCOPES`、要么 Precise，三条路径无共同登记处 | §5 授权能力注册表 = 唯一扩展点；CI 门禁（§5.4）；§10 L14 |
| **P9（新·Owner）无智能体可视化页**：看不到「哪个员工在干什么、进度、详情」；Owner 要求一级页面：roster + 进度 + 详情 + 跳角色设置 | `main.tsx` view 路由无 agents 视图；今日无 roster 组件 | §7 智能体（班组）页 IA + §11 P0 只读版先行 |
| **P10（新·Owner）后端可持续**：担心后端现在撑不起、未来也撑不起 → 无尽 bug | 无单一真相：授权事实散在 3 张静态表 + 2 个签发点 + UI 侧手写文案 | §2/L3 后端真相 = 注册表 + 覆盖表 + 投影 API；UI 只是视图（§5.7、§10 L15） |

### 1.2 非目标（明确不做）

- **不做编排图**：角色之间没有边，没有自动多跳链路；派工 = 主编单跳派给一个角色，呈报回主席台（§8 反模式 3）。
- **不做多租户/企业版权限**：单主编本地终端；读档（ReadProfile）的价值是**上下文纪律 + 角色人格窄化**，不是多用户安全边界（§6.3 诚实声明）。
- **不改 `agent_tasks` / `task_grants` / `execution_grants` 既有表结构**：只新增一张 `capability_overlays` 覆盖表 + roleId 语义 + 两处签发过滤（§8.2）。
- **不给角色发任何「一键越权」按钮**：Owner UI 动作（owner_ui actor）永不受角色门限制，但 Agent 侧不做 permission-escalation 入口。
- **不重做发布链路**：最终发布始终人点（REQ-007）；发布准备维持 Precise。
- **不写实施代码**：§11 仅为排期输入（本任务禁止 TS/TSX 改动）。

---

## 2. 分层架构（Role vs Lane pack vs Capability registry vs Grant runtime）

### 2.1 四层总览

```
L0 角色编制 Role catalog        —— 谁是谁（身份/科室/技能/预设）；跨赛道、跨功能稳定
   │
   ├───────────────────────────────────────┐
   ▼                                       ▼
L1 赛道包 Lane pack              L2 授权能力注册表 Capability registry
   · 每个赛道一份：技能子集、             · 命令 → 能力 → 默认角色绑定 → 读面 → 所属 intent/页
   · 信源/X List、受众口径、渠道            · 新写能力的唯一扩展点；CI 门禁（§5.4）
   · 平台/发布配置                         · 跨赛道稳定（能力 = 劳动类型，与题材无关）
   · ⚠ 零权限内容：不含任何命令/角色绑定
   │
   └──────────────┬────────────────────────┘
                  ▼
L3 授权运行时 Grant runtime      —— 真相与强制执行
   · TaskGrant（任务级）/ PageGrant（页级）/ PreciseExecutionGrant（平台副作用）
   · 签发：effectiveWrite = GrantScope ∩ commandsOf(enabledCaps(role)) ∩ PreciseGate
   · 覆盖表 capability_overlays（Owner 唯一可改的权限面，仅 agentGrantable 能力）
   · 投影 API：roster 状态 + 角色权限摘要（智能体页/值班条/chip 共用，UI 只是视图）
```

| 层 | 内容 | 稳定性 | 换赛道时 | 加新功能时 |
| --- | --- | --- | --- | --- |
| **L0 编制** | 5 角色身份/科室/Skill/预设 | 稳定（周常工作双测试，§3.3） | 不动 | 不动 |
| **L1 赛道包** | 技能子集、信源/X List、受众口径、渠道、平台配置 | **随赛道变** | **只换这一层** | 可能换（新赛道包或扩展） |
| **L2 注册表** | 授权能力清单（命令/读面/绑定/intent 归属） | 稳定（能力=劳动类型） | 不动 | **唯一改点**（新能力注册） |
| **L3 运行时** | grant 签发、envelope 校验、覆盖表、投影 API | 稳定 | 不动 | 由 L2 注册自动生效 |

**分层不变量**：
1. **L1 禁止携带权限**：Lane pack 结构里出现任何命令名/角色绑定 = CI 失败（§5.4 检查 4）。赛道差异只改变「哪些能力在当前赛道激活、针对什么对象干活」，不改变「谁拥有什么能力」。
2. **L2 是唯一扩展点**：新写命令不进 L2 → 构建失败；进 L2 后，签发、页投影、智能体页摘要、审计自动全部生效，**禁止 UI 侧第二份手写权限标签**（§6.4）。
3. **L3 不裁决「谁该有」**：运行时只执行注册表+覆盖表的投影，不内嵌业务判断；Owner 的编辑入口（设置·角色管理）也只写覆盖表。

### 2.2 为什么是四层而不是「角色带权限」一层

- 单层模型（角色→命令表）的问题是**复制**：`sources.lane_gate` 同时被策划（判定）和资料员（归档）持有，单层就得在两张角色表里各写一遍，且换赛道/加功能时不知道改哪张。能力注册表把「命令集合」抽出来做一层，角色只是**绑定**（many-to-many），共享命令只写一次（§5.3 例：cap.lane_judge 与 cap.library_organize 都绑定 `sources.lane_gate`）。
- 赛道包独立成层，是因为**权限的事实面（劳动类型）与赛道（劳动对象）正交**：记者在「AI 赛道」扫 AI 源，换到「宠物赛道」还是扫源——采集能力不变，信源换了。把两者放一层必然导致「换赛道重配权限」的复辟（P7）。

### 2.3 与现有 `workspace.capabilities`（功能开关）的关系

`src/main/workspace-mcp.ts` 已有 `capabilities: { xLists, aiIntelligence, ... }`——那是**功能特性开关**（某工作空间装没装这个功能模块），不是授权能力。两条轴并存、互不替代：功能开关决定「这个模块在不在」，授权注册表决定「哪个角色能用它的写命令」。文档与命名上禁止混用（§5.1 命名澄清，验收含注释级检查）。

---

## 3. 编制（5 角色 + 为什么跨赛道稳定）

### 3.1 角色目录（5 角色 + 主编）

| 角色 | 科室（C6 房间） | 周常真实工作（判断依据） | 专属 Skill（owner 要求） | 模型预设 |
| --- | --- | --- | --- | --- |
| **桌助 / 主编席** | 今日（主编桌） | 每天：读桌态答问、代呈报、派工、解释状态 | `wemedia-buddy-operator`（现有） | 默认 preset |
| **记者** | 发现（前线） | 每天：渠道扫描、入库、渠道回执、有界观察 | `wemedia-intelligence-engine` 采集面（现有） | 默认 |
| **策划**（兼复盘） | 选题 + 主题 + 结果（提案夹/档案室/评报栏） | 每天：lane 判定、机会池四问、主题归纳；每周：复盘 keep/stop/change | 新 skill（判断简报/四问/归主题/复盘，基于 intelligence-engine 判断面） | 默认 |
| **写手** | 创作（写字间） | 按批：经批准的选题 → 起草/改稿/交付 | `evidence-grounded-writer`（现有） | 默认 |
| **资料员** | 资料库（资料室） | 每天：整理队列、移出/恢复/状态、挂主题 | 新 skill（整理纪律，operator 子集） | 默认 |
| **主编（人）** | 全站 | 定目标、批呈报、派工、监工、发布确认、担责 | —（owner_ui actor，不受角色门限制） | — |

### 3.2 为什么是这 5 个（每岗有周常真实工作）

1. **桌助**：Owner 指定默认对话对象（「默认 dialog 与桌助」）。它承担全站知情与代笔呈报，是唯一需要「跨科室读」的角色。
2. **记者**：采集是每日主路径劳动（PRODUCT.md Narrative Priority #1）。无它，资料池不增长。
3. **策划**：判断是 WMB 的核心差异（「今天什么值得做、为什么、怎么写」——Agent 呈报人批，PRODUCT.md C1/Purpose）。四问进池、主题归纳、复盘合流都在它手里。**复盘兼策划**（不单设复盘岗）：复盘每周一次，单独设岗周常工作量不足（反角色膨胀原则）；且复盘结论（reviews）就是下一轮判断的上下文（2026-08-06 §5.1「反馈即时生效」），同岗闭环最短。
4. **写手**：创作项目主写（C1 默认 Agent 干活）。写作与选题决策**必须分岗**——Owner 明示「Writer 不得是 topic decider」；若合并，一个 agent 既出题又自写，批题环节的制衡消失。
5. **资料员**：库房整理是每日存在的工作（新料入库 → 待整理队列），且 Owner 明示「Librarian 不得是 main writer 或 topic decider」——分岗才能把「整理权」与「写作权/选题权」物理隔离。

### 3.3 为什么不是更少 / 更多（编制双测试）

**双测试（写进验收）**：任何新角色候选必须通过「每周 ≥1 次真实工作 + 有独立授权形状」双测试，否则并岗或不开岗。

| 合并方案 | 否决理由 |
| --- | --- |
| 策划+写手 = 「编辑」 | 违反 Owner 约束「writer 不是 topic decider」；批题制衡消失；权限并集（plans.save ∪ content.*）恰是本设计要消灭的过宽 |
| 记者+策划 = 「采编」 | 复辟 P3 扫判一体；滚动池方向明确要采集/判断解耦 |
| 资料员并入策划或写手 | 违反 Owner 约束；整理（恢复/状态/挂主题）与判断/写作的 revision 语义不同，混岗互相污染 |
| 去掉桌助 | Owner 明示默认对话对象是桌助；桌助=页级助手与策划=standing 判断岗的授权形状不同（§4.3） |

| 候选岗 | 否决理由（周常工作测试） |
| --- | --- |
| 独立「复盘」岗 | 周更节奏，周常工作量不足；结论被策划消费，合并闭环更短 |
| 「发布」岗 | 发布是主编动作（REQ-007），Agent 只做「准备」（Precise 门）；无发布执行的 standing 工作，设岗即空岗 |
| 「观察员」岗 | X List 有界观察是定时任务，无对话身份需求；归记者（采集面） |
| 「渠道管理员」岗 | 渠道配置在设置页（Owner UI，REQ-022）；扫描执行归记者 |
| 「封面/美工」岗 | 当前无该业务面，不设空岗（未来真出现再评估） |
| 「主题运营」岗 | 主题归纳是 LLM 编辑判断（归策划）；域管理也是策划 |

### 3.4 为什么编制跨赛道稳定（P7 的直接回答）

1. **编制锚定劳动分工类型，不是劳动对象**：采 / 判 / 写 / 理 / 桌 是内容生产管线的五种分工，赛道（AI、宠物、留学……）改变的是「扫什么源、判什么题材、写给谁看」，不改变「需要有人扫、有人判、有人写、有人理、有人看桌」这一管线结构。
2. **证据：产品形态跨赛道同构**：WMB 的今日情报 → 选题 → 写作 → 发布 → 复盘管线不随赛道变化；`lane_gate` 判定流水、`sources`/`plans`/`content`/`reviews` 实体模型与赛道无关。
3. **L2 能力同样与赛道无关**：`cap.collect` 是「采集」这个劳动类型的授权，不论采的是 AI 源还是宠物源。赛道差异全部收进 L1 Lane pack（信源/X List/受众口径/平台配置）。
4. **由此得到验收标准**：赛道切换操作（UI 切 lane 或换 Lane pack 生效）**不得**触碰 L0 编制、L2 注册表、L3 覆盖表；若某次切赛道需要改角色或改绑定 → 视为设计缺陷上报回本设计评审（§10 L13）。

---

## 4. 权限模型（硬约束层）

### 4.1 一句话模型

> 角色 = 身份（人格/技能/预设），**不是权限**。权限 = L3 现有三层 grant 机制，按 **L2 注册表投影**做两件事：**签发时收窄**（命令集过滤）与 **入口兜底**（envelope 校验）。读走独立读面硬门。**角色层自身不含任何手写命令表**——一切来自注册表（§5）。

```
effectiveWrite(role, context) =
      GrantScope(context)                       // task-bound standing scope 或 page-bound dock scope
    ∩ commandsOf(enabledCaps(role))             // 注册表投影；桌助 = 页 scope 透传（显式声明，§5.6）
    ∩ PreciseGate(side-effect?)                 // x_lists.operation_execute / proposal_apply / 发布准备 → 仅 Precise

effectiveRead(role) = ∪ readProfiles(enabledCaps(role))   // 实体级读面；MCP 读 fail-closed + 上下文注入过滤
```

### 4.2 三层硬约束如何叠加（复用既有机制，不重造）

| 层 | 现状机制 | 角色层/注册表如何叠加 |
| --- | --- | --- |
| **TaskGrantV1**（任务级命令白名单） | `ensureAutomaticTaskGrant` 按 intent 查 `AUTOMATIC_TASK_GRANT_SCOPES` 签发，4h 过期；`assertTaskGrantForEnvelope` 在 dispatcher 入口强校验（`task-grants.ts`） | 签发时 `allowedCommands := intent 基础 scope ∩ commandsOf(enabledCaps(role))`；`sameCommandSet` 判定命令集变化自动 revoke+reissue 机制**原样复用**（角色切换 = 命令集变化 → 自动换发）；intent→neededCaps 映射登记在注册表（§5.3） |
| **PageGrant**（页级 dock 最小写权） | `PAGE_TASK_GRANT_SCOPES` 9 页静态表（`src/shared/page-authority.ts`），`ensurePageAuthority` 签发 | dialog 中 `allowedCommands := PAGE_TASK_GRANT_SCOPES[view] ∩ commandsOf(enabledCaps(role))`；桌助 = 透传（= 现状行为，零回归） |
| **PreciseExecutionGrant**（平台副作用） | `x_lists.operation_execute` / `intelligence_channels.proposal_apply` / 发布执行永不进自动 scope，仅 Owner UI 对冻结操作签发（`execution-grants.ts`、pi-page-authority 设计 §6） | 注册表中这三类 = `precise:true` 且 `agentGrantable:false` 的红线能力；任何角色 standing/page scope 都不含这些命令；角色层不新增 Precise 通道，也不替 Owner 代签 |

**兜底校验（envelope 入口，防角色伪造/复用旧证）**：在 `assertTaskGrantForEnvelope` 同一断言点追加一步——由 `envelope.workerLeaseId` 解析 lease 绑定的 `roleId`，断言 `envelope.command ∈ commandsOf(enabledCaps(roleId))`。理由：

- lease 由 **UI 选择（dock 收件人）或 runner 配置（intent→角色）**决定，永不来自对话文本 → 角色不可伪造（「prompt-only 不是权限」）；
- 换收件人 = `rebindWorkerTask` 换 taskId → 旧 grant 的 taskId 失配即拦（既有机制），role 校验是第二道保险；
- 外部 Agent（`type:'external_agent'`）无 lease：角色继承其任务（taskId→intent→角色），随 envelope 断言，不新增会话级身份。

### 4.3 两类授权形状：standing scope vs page scope

| | **standing scope（岗位常备）** | **page scope（页上对话）** |
| --- | --- | --- |
| 谁有 | 固定角色（记者/策划/写手/资料员） | 所有人（含桌助） |
| 何时生效 | 角色任务运行（后台 runner / 派工任务） | 用户在某页打开 dock 对话 |
| 来源 | intent → 注册表登记的命令集（§5.3 grantKinds.task） | `PAGE_TASK_GRANT_SCOPES[view]` ∩ 注册表投影 |
| 桌助 | **无 standing 写权**（桌助只答、只呈报、只读；要写必须靠页级 grant 或派工） | 继承页 scope（透传） |
| 角色交叉 | 不适用（任务属于谁就是谁） | 固定角色 = 页 scope ∩ 自身能力命令 → **离开自己科室的页即只读** |

这条区分直接回答：**「桌助会不会太大？」不会——它没有任何 standing 写权；「固定角色会不会在别页乱写？」不会——PageGrant ∩ 能力投影双收窄。**

### 4.4 intent 拆分：扫判分家（P3 的解法）

现状（`task-grants.ts` AUTOMATIC_TASK_GRANT_SCOPES）：

```
daily_intelligence = [report_progress, knowledge.record_batch, knowledge.suggestion_create,
                      plans.save, sources.upsert_batch, sources.lane_gate]   // 采+判+归档一锅
studio_draft      = [report_progress, content.save_version]
results_review    = [report_progress, knowledge.record_batch, reviews.save]
```

目标（新增两个 intent，表语义不变，仍是「intent → 命令集」静态查表；intent 归属在注册表登记）：

```
daily_scan   = [report_progress, sources.upsert_batch]                        // 记者（cap.collect）
daily_judge  = [report_progress, knowledge.record_batch, knowledge.suggestion_create,
                plans.save, sources.lane_gate]                                // 策划（cap.lane_judge + cap.topic_decide + cap.knowledge_curate）
studio_draft = [report_progress, content.save_version]                        // 写手（cap.write；content.create 经派工/页 scope 单独给）
results_review = [report_progress, knowledge.record_batch, reviews.save]      // 策划（cap.review，复盘兼岗）
```

- 并集与旧 `daily_intelligence` 完全一致（回归保护），但命令集按角色拆分，**每张 grant 只有一半命令**；
- 与 2026-08-06 滚动池方向天然对齐：采集编排器触发 scan，扫描完成触发增量 judge；
- 若实施上暂时不分两个任务（P0 最小步），可保留单任务 `daily_intelligence` + 阶段内改绑 scope：`sameCommandSet` 判定已支持命令集变化 → 自动 revoke+reissue（机制零改动）。**推荐**直接拆两个 intent（审计更干净）。

### 4.5 读模型（ReadProfile）

- 读工具（`wmb_get_*` / `wmb_read_x_list_*` / `xhs_*` 读类）现无需 grant；注册表补一张实体级读面（能力自带 readProfiles，角色读面 = 并集），两个落点：
  1. **MCP 读工具 fail-closed**：读工具按 entity type 对照角色读面，不在表内 → 读拒绝（错误携带 `READ_PROFILE_BLOCKED` + 原因）；
  2. **上下文注入过滤**：dock/runner 的上下文组装只注入该角色读面内的面（对齐「上下文与授权同源同表」原则，pi-page-authority 设计 §1.2）。
- **诚实声明**：单主编本地终端下，读档不是安全边界（数据都在本地）；它的价值是**人格窄化 + 上下文卫生 + 为未来多账号/共享根留门**（§6.3）。
- 读面详见 §6.2。

### 4.6 越权可见性（禁止静默，五类原因）

| 拦截原因 code | 含义 | 用户看到 |
| --- | --- | --- |
| `ROLE_SCOPE_BLOCKED` | 该角色没这个权（例：资料员说「我来写正文」） | chip 提示 + BLOCKED 注入：「资料员不能写正文。可以交给写手，或你在创作页 UI 继续。」 |
| `PAGE_SCOPE_BLOCKED` | 本页没这个权（例：发布页想写正文） | 「发布页只读。写正文请到创作页。」 |
| `PRECISE_REQUIRED` | 平台副作用需 UI 确认（X List 变更、发布准备执行） | 「这是平台操作，需要你在 UI 确认。」+ 指向确认入口 |
| `GRANT_EXPIRED/REVOKED` | 授权过期/撤销（含换收件人后旧证） | 「授权已过期/已切换对象，请重试。」 |
| `READ_PROFILE_BLOCKED` | 读档外实体（例：记者读复盘） | 「记者不读复盘。可以问策划或桌助。」 |

- 实现沿用既有管道：`[WMB_AUTHORITY_BLOCKED] reason=<code>` 注入 raw（`pi-page-authority.ts` 机制）+ toast + chip 段联动；`PI_AUTHORITY_SYSTEM_PROMPT` 增加「收到 BLOCKED 必须向用户说明原因并给可操作指引，禁止伪造 authority 或绕行」。
- **禁止**：Agent 收到拦截后改用「直接写文件/DB」或「重复猜测命令」；禁止把五个原因合并成一句「没有权限」的裸话。
- 审计：每次拦截写一条 `role_authority_blocked` 流水（role、command、page、reason、时间），智能体页与设置页可查（§7）。

---

## 5. 授权能力注册表（Capability Registry）与新功能开发规程

### 5.1 定位与命名澄清

- **授权能力（Capability）**：一个「可被角色持有的写能力单元」= 一组写命令 + 一组读面 + 默认角色绑定 + 所属 intent/页 + 副作用标记。**它与 `workspace-mcp.ts` 的 `workspace.capabilities`（功能开关）是两条轴**：功能开关决定「模块装没装」，授权能力决定「哪个角色能用它的写命令」。代码注释、UI 文案、文档中禁止把两者混称（验收含注释级检查）。
- 单文件落地：`src/shared/agent-capabilities.ts`（与 `PAGE_TASK_GRANT_SCOPES` 同放 shared，main/renderer 同源单份），结构见 §5.2。

### 5.2 注册表结构（TS 接口草案，仅排期输入）

```ts
interface AgentCapability {
  id: string;                       // 'cap.collect' | 'cap.lane_judge' | ...
  displayName: string;              // 「采集」——智能体页摘要/chip 显示名
  description: string;              // 一句话职责（新增功能评审用）
  commands: string[];               // 该能力授权的写命令（⊆ TASK_INTERNAL_COMMANDS）
  readProfiles: EntityFace[];       // 该能力附带读面（sources/knowledge/plans/content/reviews/metrics/x_lists/desk/canvas/publication/settings）
  defaultRoleBindings: Record<RoleId, boolean>;   // 默认持有者（many-to-many，命令可被多能力共享）
  grantKinds: {
    task?: string[];                // 参与的任务 intent（daily_scan / studio_draft …）
    page?: string[];                // 参与的页 scope（discover / library / studio …）
  };
  precise: boolean;                 // true = 平台副作用，运行时必须 PreciseGate（红线类）
  agentGrantable: boolean;          // false = 红线能力，永不出现在覆盖开关面、永不绑定 Agent
  pageScopePassThrough?: boolean;   // 仅桌助：页 scope 透传（§5.6）
  owner: string;                    // 该能力的功能负责人（新增功能评审联系人）
  since: string;                    // 注册版本
}

interface RoleCatalogEntry {
  roleId: RoleId;                   // 桌助/记者/策划/写手/资料员
  identity: { 科室; skills; preset; };   // 身份层，零命令
}

interface TaskIntentMap {           // intent → 所需能力（grantKinds 反查的真相源）
  [intent: string]: { neededCaps: AgentCapabilityId[]; };
}
```

**投影（只读推导，禁止手写）**：

```
RoleWrite[role]  = ∪ commands(role 启用且 agentGrantable 的能力)          // 桌助除外（透传声明）
RoleRead[role]   = ∪ readProfiles(role 启用的能力) ∪ 桌助全读面(设置除外)
enabledCaps(role, workspace) = 默认绑定 → 应用 capability_overlays 覆盖后
```

### 5.3 初始注册表（v1，9 项：7 业务能力 + 2 类红线占位）

| 能力 id | 名称 | commands | readProfiles | 默认绑定 | grantKinds |
| --- | --- | --- | --- | --- | --- |
| `cap.collect` | 采集 | `sources.upsert_batch`、`x_lists.observation_start/stop` | sources、x_lists | 记者 ✓ | task: daily_scan；page: discover |
| `cap.lane_judge` | 赛道判定 | `sources.lane_gate` | sources、plans、knowledge | 策划 ✓ | task: daily_judge；page: library |
| `cap.library_organize` | 库房整理 | `sources.lane_gate`、`sources.lane_restore`、`sources.update_status`、`knowledge.record_batch` | sources、knowledge | 资料员 ✓ | page: library |
| `cap.topic_decide` | 选题决策 | `plans.save`、`knowledge.suggestion_create` | plans、knowledge、metrics、reviews、content(防重) | 策划 ✓ | task: daily_judge；page: today、proposals |
| `cap.knowledge_curate` | 知识/主题归纳 | `knowledge.record_batch`、`knowledge.domain_create/update`、`knowledge.creative_brief_*` | knowledge、canvas | 策划 ✓ | task: daily_judge；page: topic、canvas |
| `cap.write` | 写作 | `content.create`、`content.save_version` | sources(借)、knowledge(借)、plans(已批简报)、content(自有+历史)、reviews(反馈) | 写手 ✓ | task: studio_draft；page: studio |
| `cap.review` | 复盘 | `reviews.save` | metrics、reviews、content(防重) | 策划 ✓ | task: results_review；page: results |
| `cap.desk` | 桌助知答 | ∅（**pageScopePassThrough: true**） | 全实体（settings 除外） | 桌助 ✓ | page: 全部 |
| `cap.publish_prep` / `cap.hard_delete` / `cap.platform_mutation` | 发布准备/硬删/平台副作用 | 发布执行、`deleteKnowledgeSource`、`x_lists.operation_execute`、`intelligence_channels.proposal_apply` | — | **无**（agentGrantable:false, precise:true） | 仅 Precise + Owner UI |

**读法**（对应 §6 矩阵，矩阵只是本表的展示投影）：
- 共享命令只写一次：`sources.lane_gate` 同时被 `cap.lane_judge`（策划=相关性判定）与 `cap.library_organize`（资料员=移出归档）绑定——单层角色表做不到这点，这正是注册表的核心价值；
- `knowledge.record_batch` 同理：策划（归纳沉淀）+ 资料员（挂主题组织）；
- 红线三类注册在表里 = 为了让 CI 能断言「**没有任何自动 scope 含红线命令**」（§5.4 检查 3），也为了让未来的功能开发者在注册时看到它们为什么不可 Agent 化。

### 5.4 CI 门禁（概念；落地为 `scripts/check-capability-registry.mjs`）

- 挂入点：`npm run check:capabilities`（P0 起进入 `typecheck` 前置链与 CI 预检；`package.json` 已有 `typecheck`/`test` 两个钩子可扩展，不加新框架）。
- 检查项（失败 = 构建失败）：
  1. **全覆盖**：`TASK_INTERNAL_COMMANDS` 中每个可写命令（除 `owner_ui`、`report_progress`、基建类）必须被 ≥1 个 agentGrantable 能力声明；
  2. **intent 一致性**：每个 `AUTOMATIC_TASK_GRANT_SCOPES` intent 的 neededCaps 声明齐全，且每个声明能力的命令 ⊆ 该 intent 基础 scope（防 grant 静默扩权）；
  3. **红线负断言**：红线/Precise 命令（发布执行、`deleteKnowledgeSource`、`x_lists.operation_execute`、`proposal_apply`）不得出现在任何 standing/page 自动 scope；且 `agentGrantable:false` 能力不得有默认角色绑定；
  4. **L1 纯净**：Lane pack 结构（未来实现）不得包含任何命令名/角色绑定字段；
  5. **页面一致性**：`PAGE_TASK_GRANT_SCOPES` 中每个命令必须被 ≥1 能力声明为 page grantKind（或显式标记 page-only 工具）；
  6. **桌助唯一性**：`pageScopePassThrough:true` 只允许出现在 `cap.desk`（防止未来角色复制透传 → 全能角色）。

### 5.5 覆盖表（capability_overlays）——Owner 唯一可改的权限面

- 新表（workspace 级）：`capability_overlays(workspace_id, role_id, capability_id, enabled, updated_at)`。**这是本设计唯一新增的持久化**；`agent_tasks`/`task_grants`/`execution_grants` 结构不动（§8.2）。
- 语义：默认绑定（静态）← 覆盖（动态）；`enabled=false` = 该角色在该工作空间停用此能力。停用即刻生效于签发（同一投影 API 驱动强制执行与界面显示）。
- **红线不可覆盖**：`agentGrantable:false` 的能力不进覆盖表可写面——UI 层、IPC 层、DB 约束三层都拒绝（假开关的物理消灭，§9 反模式 1）。
- 变更审计：每次 overlay 写入记流水（谁、哪角色、哪能力、何时），设置页可查「当前覆盖 vs 默认差异」。

### 5.6 桌助 = 页级作用域角色（显式声明，不是疏漏）

- `cap.desk` 无 commands，但带 `pageScopePassThrough:true` → 页级签发时透传（现状行为逐字节不变，零回归）；standing 任务不存在桌助身份（桌助无 standing 写权）。
- 设计意图：桌助是「主编所在页的助手」，它的权限形状 = 页，与固定角色的「能力形状」本质不同；这个区别必须显式声明在注册表，并由 CI 唯一性检查保护（§5.4 检查 6），防止未来有人复制透传造出全能角色。

### 5.7 后端真相与投影 API（P10 的直接回答）

- **真相**：`src/shared/agent-capabilities.ts`（静态默认）+ `capability_overlays`（动态覆盖）+ L3 签发逻辑。三处之外没有权限事实；UI 侧**禁止**第二份权限标签（§6.4 反双源）。
- **投影 API（只读）**：
  - `pi:roster-status` → 每角色：状态点/状态词/一句话、当前任务（intent/taskId/进度/开始时间）、最近流水（任务/拦截/呈报）、blocker；
  - `pi:role-permission-summary` → 每角色：可写 Cap 列表 + 只读面（注册表+覆盖投影，供智能体页/值班条/chip/设置摘要共用）。
- 这两个 API 是「智能体页、值班条、dock chip、设置摘要」四个 UI 面的**唯一数据源**；任何 UI 想显示「谁有什么权」必须走它。

### 5.8 新功能开发规程（写死：一个功能一个注册）

```
新增写能力步骤（P0 后强制）：
1. 在 agent-capabilities.ts 注册新能力：commands + readProfiles + defaultRoleBindings + grantKinds + precise/agentGrantable；
2. 若涉及新任务 intent：在 TaskIntentMap 登记 neededCaps；若涉及页：登记 page grantKind；
3. 跑 npm run check:capabilities + typecheck（CI 必过）；
4. 功能评审时顺带评审能力绑定（默认给谁、为什么、红线判定）；
5. 注册后自动生效：签发、envelope、智能体页摘要、chip、审计——无需 UI 侧手写。
禁止路径：直接往 AUTOMATIC_TASK_GRANT_SCOPES / PAGE_TASK_GRANT_SCOPES 加命令而不注册（CI 检查 1/5 拦）。
```

---

## 6. 完整权限矩阵（注册表的展示投影）

### 6.1 写矩阵（命令 × 角色）

命令全集 = `TASK_INTERNAL_COMMANDS`（`task-grants.ts`）。平台副作用（发布执行 / `x_lists.operation_execute` / `proposal_apply` / `deleteKnowledgeSource`）**不进任何角色 standing/page scope**，仅 Precise + Owner UI，故下表不列（红线，§10 L15）。`agent_tasks.report_progress` 全员常备（审计面），省略。

| 命令 | 桌助 | 记者 | 策划 | 写手 | 资料员 | 备注 |
| --- | :-: | :-: | :-: | :-: | :-: | --- |
| `sources.upsert_batch`（存料） | 页内 | **✓ standing** | ✗ | ✗ | ✗ | 采集=记者专属（cap.collect） |
| `x_lists.observation_start/stop`（有界观察） | 页内 | **✓ standing** | ✗ | ✗ | ✗ | 观察归采集面（cap.collect，与 3A 一致） |
| `sources.lane_gate`（判定/归档） | 页内 | ✗ | **✓ standing** | ✗ | **✓ standing** | 策划=相关性判定（cap.lane_judge）；资料员=移出归档（cap.library_organize） |
| `sources.lane_restore`（恢复） | 页内 | ✗ | ✗ | ✗ | **✓ standing** | 恢复=库房操作（cap.library_organize）；策划误判后纠正走资料员或 Owner UI |
| `sources.update_status`（状态） | 页内 | ✗ | ✗ | ✗ | **✓ standing** | 纯状态更新，资料员专属 |
| `plans.save`（选题/机会池） | 页内(今日) | ✗ | **✓ standing** | ✗ | ✗ | **选题决策权 = 策划**（cap.topic_decide）；写手/资料员/记者永不碰 |
| `knowledge.record_batch`（挂知识/主题） | 页内 | ✗ | **✓ standing** | ✗ | **✓ standing** | 策划=归纳沉淀（cap.knowledge_curate）；资料员=挂主题（cap.library_organize） |
| `knowledge.suggestion_create` | 页内 | ✗ | **✓ standing** | ✗ | ✗ | 建议=策划（cap.topic_decide） |
| `knowledge.domain_create/update`（域管理） | 页内 | ✗ | **✓ standing** | ✗ | ✗ | 主题架构=策划（cap.knowledge_curate） |
| `knowledge.creative_brief_*`（简报/立项） | 页内 | ✗ | **✓ standing** | ✗ | ✗ | 简报深化=策划 |
| `content.create`（立项开写） | 页内 | ✗ | ✗ | **✓ standing** | ✗ | 写手经已批选题开项目（cap.write） |
| `content.save_version`（写正文） | 页内 | ✗ | ✗ | **✓ standing** | ✗ | **写作权 = 写手独占** |
| `reviews.save`（复盘） | 页内 | ✗ | **✓ standing** | ✗ | ✗ | 复盘兼策划（cap.review） |

**读法**：
- 「页内」= 桌助在**用户当前所在页**的 PageGrant 内可用（今日页含 `plans.save/lane_gate/upsert_batch` 等；创作页含 `content.*`）。桌助没有任何 standing 权。
- 固定角色在 dialog 中 = 页 scope ∩ 自身能力命令；例：写手在创作页 = `content.*` ✓；写手在资料库页 = ∅（只读）；策划在创作页 = 只读。
- 每条 grant 的 `relevantContext` 记 `{intent, role, page, objectId}`，审计可回答「谁、在哪、凭什么」。（字段现成，`task-grants.ts` 已扩展过 page/objectId。）

### 6.2 读矩阵（实体面 × 角色）

| 读面 | 桌助 | 记者 | 策划 | 写手 | 资料员 |
| --- | :-: | :-: | :-: | :-: | :-: |
| 资料 sources | ✓ | ✓ | ✓ | **✓ 借阅** | ✓ |
| 知识/主题 knowledge | ✓ | ✓ | ✓ | **✓ 借阅** | ✓ |
| 选题/机会池 plan_items | ✓ | ✗ | ✓ | ✓(已批简报) | ✗ |
| 创作 content | ✓ | ✗ | ✓(防重) | ✓(自有+历史) | ✗ |
| 复盘 reviews | ✓ | ✗ | ✓ | ✓(反馈) | ✗ |
| 指标 metrics | ✓ | ✗ | ✓ | ✗ | ✗ |
| 渠道/趋势 x_list | ✓ | ✓ | ✓(趋势) | ✗ | ✗ |
| 今日呈报 desk | ✓ | ✗ | ✓(自有产出) | ✗ | ✗ |
| 发布状态 publication | ✓(状态) | ✗ | ✗ | ✗ | ✗ |
| 画布 canvas | ✓ | ✗ | ✓ | ✗ | ✗ |
| 设置 settings | ✗ | ✗ | ✗ | ✗ | ✗ |

**边界规则（Owner 明示的两条 + 推导）**：

1. **写手对资料库 = 只读借阅**：读 sources/knowledge/主题全量（借），任何 `lane_*`、`update_status`、组织类命令都无（不整理、不删除、不移动）；
2. **资料员边界**：组织命令全有（归档/恢复/状态/挂主题），但 `plans.save`/`content.*`/`reviews.save` 全无 → **不是选题决策者、不是主笔、不复盘**；
3. **谁绝不能发布/硬删**：**全部角色（含桌助）**——最终发布 = 平台人工点击（REQ-007）；`deleteKnowledgeSource` 硬删 = Owner UI only（1A）；平台副作用仅 Precise + Owner UI 确认。

### 6.3 读档的诚实声明

单主编本地终端下，读档不是安全边界（数据都在本地）；它的价值是**上下文卫生 + 人格窄化**（记者不背复盘、写手不背选题全景），并为未来多账号/共享根留门。不因「有读档」放松 grant 纪律。

### 6.4 反双源规则（防止散装回潮）

- 智能体页摘要、值班条 hover、dock chip、设置权限面板、拦截文案里的**所有权限描述**必须由 `pi:role-permission-summary` 投影生成；**禁止**在 UI 侧手写任何「角色 = 命令」标签（P8 的根治条款）。
- 验收：UI 代码里 grep 不到与 `agent-capabilities.ts` 重复的命令名常量。

---

## 7. 智能体（班组）页 IA（P9：一级页面）

### 7.1 与兄弟 UX 设计的关系（明确修订）

- `fixed-role-agents-ux-design.md` 曾决策「角色不新增一级导航页，可选班组抽屉」。**本文件修订该决策**：Owner 明确要一级「智能体」页（roster + 进度 + 详情 + 设置跳转），故：
  - **今日页保留一行值班条**（状态知情投影，规格沿用兄弟设计 §3：一行封顶、状态点双编码、只答「谁在干什么/卡在哪/要不要你拍板」）；
  - **智能体页 = 一级导航**（新 view `agents`，与今日/发现等平级），承载完整 roster + 进度 + 详情 + 设置链接；
  - **班组抽屉方案废弃**：整页取代抽屉，避免两套班组呈现面并存。
- 值班条与智能体页是同一事实的两个投影（同 `pi:roster-status`）：条 = 桌上瞄一眼，页 = 坐下来看和派工。

### 7.2 IA 图

```
智能体（班组）页 —— 一级导航，建议紧邻「今日」之后
 ├─ 页头 · 班组总览
 │    5 枚名牌（复用值班条组件，全宽版）：状态点 + 角色名 + 状态词 + 一句话
 │    全局摘要行：工作中 N · 待命 M · 等你批 K（可点过滤）
 ├─ 主体 · 每角色一区（5 区，可折叠）
 │    桌助 | 记者 | 策划 | 写手 | 资料员
 │    ├─ 状态卡：状态点 + 状态词 + 一句话 + 正在做（当前任务/intent、进度 N/M、最新产出摘要、开始时间）
 │    ├─ 最近流水：最近 N 条 任务/拦截/呈报（只读，审计面投影）
 │    ├─ 权限摘要：可写 Cap 列表（「采集 · 存料/观察」）+ 只读面（来自 pi:role-permission-summary，只读）
 │    └─ 动作：交谈（切 dock 收件人并聚焦 dock）｜ 派工（单跳派工单，P1）｜ 去科室（导航到角色科室页）
 └─ 页脚 · 配置入口：编辑角色（Skill/模型预设/启停/权限摘要）→ 设置·角色管理（跳转链接，非本页配置）
```

### 7.3 与今日值班条 / dock / 设置的关系（一页一事）

| 面 | 角色 | 内容 | 与智能体页的关系 |
| --- | --- | --- | --- |
| **今日值班条** | 知情投影 | ≤1 行：状态点+状态词+一句话+交谈/去科室+「查看全部」 | 点击「查看全部」→ 智能体页；**hover 权限摘要移除**（权限细节只在智能体页，避免双源） |
| **智能体页** | 运行管理面 | roster+进度+详情+派工入口+设置跳转 | 本页 |
| **Dock** | 内线电话 | 收件人切换（默认桌助）+ 权限 chip 双段 | 智能体页「交谈」= 切收件人 + 聚焦 dock，不新开聊天窗；dock 在智能体页存在（设置页除外，沿用现状） |
| **设置·角色管理** | 配置面 | 每角色 Skill 清单/模型预设/启停；权限摘要只读面板；**P2 的 Cap 覆盖开关**（仅 agentGrantable） | 智能体页只放「跳转设置」链接；**本页不渲染任何配置控件** |

**一页一事原则**：智能体页 = 看（谁在干什么）+ 派（单跳派工）；设置 = 配（Skill/预设/启停/能力开关）。运行页塞配置控件 = 配置大屏反模式（§9 反模式 7）。dock 收件人切换与派工动作在智能体页可用（它们是运行动作不是配置）。

### 7.4 空 / 忙 / 卡文案（沿用兄弟设计 §7 规则）

永远回答「谁 + 在干什么 + 卡在哪 + 主编能做什么（等/催/批/派）」；「卡住了」仅真实 blocker（如渠道登录失效）才出现，带修复 action；禁止猜测性措辞与编造完成时间。

### 7.5 视觉纪律

- 角色色入设计系统 token 再使用（禁止散落硬编码 hex）：记者=青蓝、策划=琥珀金、写手=紫灰、资料员=墨绿、桌助=中性墨；
- 名牌 = 字标/单字母 + 名字 + 状态点；不画卡通头像、不用渐变玻璃、不发光边框；
- 状态点：待命=灰、工作中=琥珀（无脉冲）、等你批=蓝、卡住了=红；颜色+文字双编码（WCAG AA）；
- 页面为只读运行面：所有数值/状态来自投影 API，无本地猜测。

---

## 8. 与现有授权机制叠加（TaskGrant / PageGrant / PreciseGrant / agent_tasks）

### 8.1 叠加总表

| 既有机制 | 现状 | 注册表/角色层如何叠加 | 改动面 |
| --- | --- | --- | --- |
| **TaskGrant**（`task-grants.ts`） | intent→命令集静态查表；4h 过期；`sameCommandSet` 自动 revoke+reissue；envelope 强校验 | 签发时 `allowedCommands := 基础 scope ∩ commandsOf(enabledCaps(role))`；intent 的 neededCaps 登记注册表（§5.3） | 签发点 + 注册表；表结构不动 |
| **PageGrant**（`page-authority.ts`） | 9 页静态 scope + `ensurePageAuthority` | dialog 中 `∩ commandsOf(enabledCaps(role))`；桌助透传 | 签发点；静态表不动（它仍是「本页允许什么」） |
| **PreciseExecutionGrant**（`execution-grants.ts`） | 平台副作用仅 Precise + Owner UI | 红线能力 `agentGrantable:false` 永不出现在 standing/page/覆盖面；角色层不新增 Precise 通道 | 注册表登记；逻辑不动 |
| **agent_tasks** | 任务表；worker 单 lease（`workspace-runtime.ts`） | **表结构不动**；roleId 进 lease/context（P0）；任务 intent 查 TaskIntentMap 得 neededCaps（P1） | 语义层；P1 worker 池化 |
| **capability_overlays（新）** | — | Owner 唯一可改权限面；workspace 级；红线能力不可覆盖 | 唯一新增持久化 |

### 8.2 明确承诺

- **不改** `agent_tasks` / `task_grants` / `execution_grants` 表结构；roleId 只进 lease/context（审计需要可加 role 索引，P2）。
- **不改** `AUTOMATIC_TASK_GRANT_SCOPES` / `PAGE_TASK_GRANT_SCOPES` 的表语义（「intent/页允许什么」不变），只在签发处加注册表投影收窄——这是零回归的关键（默认桌助透传 = 现状逐字节不变）。
- **唯一新增持久化** = `capability_overlays`（§5.5）。

### 8.3 迁移路径（从 v1 静态表到注册表投影）

1. v1 的 `RoleWrite[role]` / `RoleRead[role]` 静态表内容**原样搬进**注册表默认绑定（§5.3 九项覆盖全部矩阵单元格）——矩阵不变，只是来源换成投影；
2. CI 检查 1/5（§5.4）确保搬入后无命令失联；
3. 视觉/文案双源清除（§6.4）随 P0 一起做。

---

## 9. 风险与反模式

| # | 风险/反模式 | 对策 |
| --- | --- | --- |
| 1 | **假开关**（花活 UI 先于后端强制：界面有开关、实际不拦；或开关只改显示不改授权） | 「未做 P0 前零可配置权限 UI」纪律（§11.4）；开关只写 overlay 且由同一投影 API 驱动强制与显示；`agentGrantable:false` 在 UI/IPC/DB 三层不可写（§5.5） |
| 2 | **赛道复制权限**（换赛道 = 复制一份角色权限包，从此两处漂移） | L1 Lane pack 零权限 + CI 检查 4；换赛道只换 L1；若出现「改权限才能切赛道」= 设计缺陷上报（§3.4/§10 L13） |
| 3 | **编排回潮**（派工顺手做成记者→策划→写手自动链路） | 单跳有界派工契约 + 呈报回主席台；UI 永不出边（兄弟设计 §9） |
| 4 | **单 lease 卡死全站**（记者扫描时写手无法并行） | P1 worker 池化（每角色独立 lease + 空闲挂起 + 并行上限）；P0 先 lease 绑 roleId |
| 5 | **注册表腐化**（命令漏注册 → CI 兜不住；或注册了但默认绑定空转） | CI 全覆盖+负断言双向检查（§5.4）；每能力必须 ≥1 角色绑定或显式红线标记 |
| 6 | **角色膨胀**（复盘岗、发布岗、观察岗一个个冒出来） | §3.3 双测试：周常工作 ≥1 次 + 独立授权形状；编制变更必须回本设计评审 |
| 7 | **智能体页漂移**（变成健康大屏/配置大屏/聊天首页） | 一页一事（§7.3）：页=看+派；配置在设置；无资源指标、无每消息模型选择器、无日志流 |
| 8 | **prompt-only 权限**（「提示词里说你是资料员就算数」） | roleId 只由 UI/runner 绑定；envelope 兜底断言；Skill 文本零权限（PRD §5.7） |
| 9 | **身份放大**（点记者就以为能归档） | 名牌动作 = 权限投影（§7.2）；chip 双段显示交集；拦截原因分类（§4.6） |
| 10 | **跨角色旧证复用**（换收件人后旧 grant 继续写） | rebind 换 taskId → `isCurrentWorkerLease` 拦；role 兜底第二道；4h 过期回收（2A）三重收敛 |
| 11 | **过度收窄打断主流程**（写手写作中要存一条来源，被拦） | 存料=记者，**UI 存料按钮不拦**（owner_ui 不受角色门限）；Agent 收到拦截给「交给记者」指引而非绕行 |
| 12 | **读档的假安全感** | §6.3 诚实声明；不因「有读档」放松 grant 纪律 |
| 13 | **桌助漂移成全能角色** | 桌助 standing 写权 = ∅；透传是显式声明 + CI 唯一性检查（§5.6）；值班条不显示「权限合计」式宣传 |
| 14 | **Skill 悄悄带权**（给角色配 Skill 时塞进工具白名单） | Skill 清单在设置页管理；Skill 内容不得注册新命令（CI 检查 1 兜底） |
| 15 | **并发 grant 竞态**（角色并行后同任务双 grant） | `dispatchIssueTaskGrant` active 单张校验现成；P2 补并发矩阵测试 |
| 16 | **拦截文案恐吓化** | 文案模板全部以「可操作指引」收尾；权限是默认正确的，拦截是异常（PRODUCT.md 设计原则 5） |
| 17 | **overlay 权限漂移**（Owner 停用某能力后无人知晓） | overlay 变更全流水 + 设置页「当前覆盖 vs 默认差异」视图（§5.5） |

---

## 10. Owner 锁定项（逐条打勾 yes/no）

### A. 编制与角色边界

| # | 锁定项 | 决策（yes/no） | 含义 |
| --- | --- | --- | --- |
| L1 | **编制 = 5 角色**：桌助 / 记者 / 策划（兼复盘）/ 写手 / 资料员；发布不设角色 | ☐ | 复盘并岗、发布不设岗、观察归记者；新角色需过周常工作双测试（§3.3） |
| L2 | **写手对资料库只读借阅**：读全量，无任何 lane/组织命令 | ☐ | 借 ≠ 管；整理一律资料员或 Owner UI |
| L3 | **资料员边界**：持 归档/恢复/状态/挂主题；无 `plans.save`/`content.*`/`reviews.save` | ☐ | 不是选题决策者、不是主笔、不复盘 |
| L4 | **选题决策权 = 策划**：`plans.save` 仅策划（standing）+ 桌助页内；写手/资料员/记者永不持有 | ☐ | Writer 不是 topic decider（Owner 明示） |
| L5 | **记者边界**：持 `upsert_batch`+观察；无 `lane_gate`/`plans.save` | ☐ | 采与判分家（P3 根治） |
| L6 | **桌助 = 页级作用域角色**：standing 写权 ∅，页 scope 透传为显式注册表声明；默认收件人 | ☐ | 桌助不成为全能；现状行为零回归 |

### B. 授权模型

| # | 锁定项 | 决策（yes/no） | 含义 |
| --- | --- | --- | --- |
| L7 | **有效写权 = GrantScope ∩ commandsOf(enabledCaps(role)) ∩ PreciseGate**；roleId 只由 UI/runner 绑定；envelope 兜底 | ☐ | 提示词/Skill 不产生权限；角色不可伪造 |
| L8 | **读档硬门**（MCP 读 fail-closed + 上下文过滤，读面=注册表投影）；owner_ui 不受角色门限制 | ☐ | 读=上下文卫生（非安全边界，诚实声明） |
| L9 | **daily 拆 `daily_scan`/`daily_judge`**（并集不变），与滚动机会池同向 | ☐ | 扫判授权分家；兼容期可单任务阶段改绑 |
| L10 | **每角色独立 lease + 空闲释放 + 并行上限**（P1 基建；P0 先 lease 带 roleId） | ☐ | 化解「单 lease 卡死全站」 |

### C. 可扩展性（Main Agent 方案核心，Owner 关切 1/2/4）

| # | 锁定项 | 决策（yes/no） | 含义 |
| --- | --- | --- | --- |
| L11 | **赛道解耦**：换赛道只换 Lane pack（技能/信源/受众/渠道），L0 编制、L2 注册表、L3 覆盖表零改动；Lane pack 零权限（CI 检查 4） | ☐ | 「换赛道要重做权限」的担忧永久关闭 |
| L12 | **Capability 注册表 = 新写能力的唯一扩展点**：命令→能力→默认绑定→读面→intent/页归属登记于 `agent-capabilities.ts`；CI 门禁「未注册新写命令 = 构建失败」（全覆盖+红线负断言） | ☐ | 「新功能权限散装」的根治条款（P8） |
| L13 | **后端真相 = 注册表 + capability_overlays + 投影 API**（`pi:roster-status` / `pi:role-permission-summary`）；UI 只是视图，禁止第二份权限标签（§6.4） | ☐ | 「后端撑不住→无尽 bug」的结构性回答（P10） |
| L14 | **覆盖表只允许 agentGrantable 能力**：发布/硬删/平台副作用 = `agentGrantable:false` 红线能力，UI/IPC/DB 三层不可覆盖 | ☐ | 假开关的物理消灭 |

### D. UI / UX

| # | 锁定项 | 决策（yes/no） | 含义 |
| --- | --- | --- | --- |
| L15 | **发布/硬删红线**：任何角色（含桌助）不能最终发布（平台人工点击，REQ-007）、不能硬删（Owner UI only，1A）、不能平台副作用（仅 Precise + Owner UI） | ☐ | 全角色统一红线 |
| L16 | **一级「智能体（班组）」页**：roster + 进度 + 详情 + 派工入口 + 设置跳转；今日保留一行值班条（知情投影）；班组抽屉方案废弃 | ☐ | Owner 关切 3；修订兄弟设计「不新增一级导航页」决策 |
| L17 | **智能体页 = 只读运行面**：可配置项（Skill/预设/启停/Cap 开关）一律在设置·角色管理；「未做 P0 前零可配置权限 UI」纪律 | ☐ | 防假开关 + 防配置大屏 |
| L18 | **单跳派工、禁止自动多跳**；跨角色动作 = 主编派工 | ☐ | 无编排图 |

---

## 11. 建议实施分期（P0 / P1 / P2，不写代码）

### P0 —— 注册表 + 角色过滤 + 只读班组页（核心放行；「权限诚实」期）

1. `src/shared/agent-capabilities.ts`：注册表 v1（§5.3 九项）+ RoleCatalog + TaskIntentMap；v1 的 `RoleWrite/RoleRead` 静态表内容搬入默认绑定（矩阵不变，来源换投影）；
2. `scripts/check-capability-registry.mjs` 落地并挂入 `typecheck` 前置链/CI（§5.4 六项检查）；**P0 起「未注册新命令 = 构建失败」生效**；
3. lease 加 `roleId`（acquire 传参，immutable）；grant 签发过滤：standing scope / page scope 均 `∩ commandsOf(enabledCaps(role))`；envelope 兜底断言（与 `assertTaskGrantForEnvelope` 同点）；桌助透传 = 现状零回归；
4. **智能体页只读版**：一级导航 `agents` view + `pi:roster-status`（roster + 状态 + 正在做 + blocker）；值班条「查看全部」跳本页；**无派工、无详情流水、无任何开关**；
5. 越权可见性：五类拦截原因 + chip 双段 + BLOCKED/toast + 审计流水（复用 `pi:authority-status`/`injectAuthority` 管道）；
6. 回归：默认桌助下全部现有 dock 用例（today/library/studio/publish）逐项与现状一致。

### P1 —— 扫判分家 + 详情页 + 并行 worker + 读门

1. `AUTOMATIC_TASK_GRANT_SCOPES` 拆 `daily_scan`/`daily_judge`（并集不变，§4.4）；runner 采集=记者 Skill、判断=策划 Skill；兼容期单任务阶段改绑兜底；
2. 智能体页详情版：每角色「最近流水」（任务/拦截/呈报）+ 权限摘要（`pi:role-permission-summary`）+ 单跳派工入口（派工单卡 → 角色任务 → 呈报回主席台）；
3. worker 池化：每角色独立 lease/进程/会话；空闲 5 分钟挂起；并行上限设置项；并发 grant 竞态矩阵测试；
4. MCP 读工具 fail-closed（按 entity type 对照读面投影）+ 上下文注入按角色过滤；
5. 设置·角色管理：每角色 Skill 清单/模型预设/启停；「角色权限摘要」只读面板（来自投影 API）；overlay 变更审计与「覆盖 vs 默认差异」视图。

### P2 —— 安全开关 + 打磨

1. **Cap 覆盖开关**（设置·角色管理内，仅 `agentGrantable` 能力；`capability_overlays` 读写 + 三层红线拒绝）；开关即刻生效于签发（同投影驱动强制与显示）；
2. 多 worker 上限/空闲策略的收敛配置；并发下 grant 撤销/过期收敛 + 跨角色会话历史清理；
3. 选题页对话写权决策（`page_proposals` 是否补 `plans.save`，或坚持 Owner UI 按钮）；
4. 外部 Agent 角色绑定完整验收（task→role 传递）；多工作空间（UK root）覆盖表隔离验证；值班条/智能体页/设置摘要三投影一致性 QA 矩阵。

### 11.4 「未做 P0 前不做可配置花活」纪律（写死）

- **P0 完成前**：不允许任何「可配置权限/角色」UI 上线——没有能力开关、没有角色启停控件、没有权限编辑器；智能体页是**只读**的（看状态、跳设置、点交谈）。
- 理由：没有注册表 + 签发过滤兜底，任何开关都是**假开关**（改显示不改授权），只会复刻 P8 散装、制造 P10 无尽 bug。
- 验收信号：P0 交付时，`grep` 不到任何写 `capability_overlays` 的 IPC；唯一写路径出现在 P2 的设置·角色管理，且经三层红线校验。

---

## 附：依据文件索引（只读核实）

- `PRODUCT.md`：C1–C7、C6 房间隐喻、Narrative Priority
- `PRD.md`：§4.7 三层授权、§5.2/§5.5、§5.7 Skill 边界、REQ-007/021/022/027、AC-023e
- `src/shared/page-authority.ts`：`PAGE_TASK_GRANT_SCOPES`（9 页、chipLabel/chipTone、writeScope|null）
- `src/main/task-grants.ts`：`TASK_INTERNAL_COMMANDS`、`AUTOMATIC_TASK_GRANT_SCOPES`（含 daily_intelligence 扫判一体证据）、`ensureAutomaticTaskGrant`（sameCommandSet → revoke+reissue）、`assertTaskGrantForEnvelope`、4h 过期
- `src/main/workspace-runtime.ts`：`acquireWorkerLease`（单 lease busy）、`isCurrentWorkerLease(leaseId, taskId)`、`rebindWorkerTask`
- `src/main/pi-page-authority.ts`：`ensurePageAuthority`、`injectAuthority`、`[WMB_AUTHORITY_BLOCKED]`
- `src/main/pi-operator-skill.ts`：`PI_AUTHORITY_SYSTEM_PROMPT`
- `src/main/agent-runner.ts`：`startDailyIntelligence`（扫描+lane+综合同任务）、`withRuntimeWorker`
- `src/renderer/main.tsx`：view 路由（today/discover/proposals/topic/library/canvas/studio/publish/results/settings，**无 agents**；设置页隐藏 dock）
- `src/main/workspace-mcp.ts`：`workspace.capabilities` = 功能开关（与本设计授权能力注册表命名澄清，§5.1）
- `package.json`：scripts（typecheck/test，CI 门禁挂载点）
- `docs/spark/2026-08-07-pi-page-authority-design.md`：1A（硬删 Owner UI only）、2A（grant 4h）、3A（观察入 page_discover）
- `docs/spark/2026-08-06-intelligence-to-topic-agent-design.md`：滚动机会池、采集/判断解耦（§4）
- `docs/spark/2026-08-07-fixed-role-agents-ux-design.md`：值班条/dock/名牌/派工 UX（本设计的 UX 层；「不新增一级导航页」决策已被本文件 §7.1 修订）

---

## 12. Owner amendment 2026-08-10：主题整理提案

本节以更晚 Owner lock 修订本设计中“策划直接维护主题结构、资料员只挂主题”的默认边界；其余固定角色、grant 交集和红线不变。详案：`docs/spark/2026-08-10-topic-maintenance-approval-design.md`。

1. 策划继续判断长期线与新主题候选，但正式主题结构变更不再绕过 Owner 审批。
2. 资料员是主题家底维护人：去重、改名、合并、归档、关系迁移先提交持久提案。
3. 资料员提案命令进入 `cap.library_organize`；应用/驳回命令是 Owner UI 专属、`agentGrantable:false`。
4. 桌助只派工和呈报，不能代批，也不能要求 Owner 手工执行提案内的编辑步骤。
5. 批准绑定提案及被触碰对象 revision，整批原子生效；stale 零部分写。
6. 后续冲突合同与自动重提修订见 `docs/spark/2026-08-10-topic-maintenance-conflict-reproposal-design.md`：真冲突由系统在提交后重派资料员，新提案仍走 Owner 审批；旧提案不复活、不自动 rebase。
