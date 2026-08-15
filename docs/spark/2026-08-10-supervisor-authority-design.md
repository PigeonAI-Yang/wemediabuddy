# 主管全站内部授权设计（desk = 软件内主管 · approach A）

- 日期：2026-08-10（Owner 决策日）；落档：2026-08-10
- 路由：Design → **Owner 锁定（§8，2026-08-10 全 10 项确认）** → Legislate（PRODUCT / PRD / SPEC / canonical 修订）→ 任务合同 → 施工
- 状态：**Owner locked（§8 全 10 项确认，2026-08-10）**；已进入立法（WMB-5181）与施工（WMB-5182–5185，TASKS doing 仍是唯一施工许可）
- 对齐：PRODUCT C9、PRD §2.4、SPEC §1.0 / CAP-026 / CAP-027 / CAP-028、`docs/spark/2026-08-07-role-permission-design.md`（canonical）、`docs/spark/2026-08-08-agent-crew-multi-instance-design.md`、`docs/spark/2026-08-10-topic-maintenance-approval-design.md`、`docs/spark/2026-08-10-topic-maintenance-conflict-reproposal-design.md`、`.ai/wmb-5144-*`（历史记录）
- **许可边界**：本文件只做设计立法输入，**不授权任何代码变更**；TASKS doing 仍是唯一施工许可。§6 列出的文件是「立法与实施影响面清单」，不是实施合同。
- 侦察输入：`SupervisorAuthorityScout`（只读侦察，2026-08-10）与当前源码事实（2026-08-10 复核：`src/shared/agent-capabilities.ts`、`src/main/task-grants.ts`、`src/main/pi-page-authority.ts`、`src/main/capability-overlays.ts`、`src/main/role-roster.ts`、`src/shared/page-authority.ts`、`scripts/check-capability-registry.mjs`、`src/main/ipc-knowledge-business.ts`、`src/main/topic-maintenance-reproposal.ts`、`skills/wemedia-buddy-operator/SKILL.md`）。

---

## 0. 结论（verdict，先行）

1. **身份翻转**：角色键 `desk` 的内部持久标识保留不变；所有用户可见身份统一为 **主管 / 主编席**（注册表 `ROLE_CATALOG.desk` 本来就是「主管 / 主编席」，被 WMB-5144 的展示层覆盖成「桌助 / 协调入口」——本设计删除覆盖与全部「桌助助手」文案，**不留任何用户可见的兼容别名**）。主管是**软件内的主管**，不是主编（人）的传声筒。
2. **授权翻转**：主管持有**全站内部 standing 写权** = 全部 `agentGrantable` 业务能力的命令并集 ∪ `INFRA_GRANT_COMMANDS`。任一页 dock 会话（含发布页、智能体页）绑定主管时签发覆盖全量内部命令的 grant；内部命令对主管**永不因「本页更窄」中止**。
3. **三条红线类别仅人（不变，且是全部）**：最终平台发布、硬删执行、外部平台变更执行——这三类是**类别**，不是命令清单。主管可**准备**不可逆/外部动作（内部准备命令，standing），但任何最终动作必须由人类 UI **新鲜确认**（Precise Gate + Owner UI）；代理不得自签 precise grant、不得直接执行。命令级拆分：`intelligence_channels.proposal_apply` 拆为无 remove 的安全应用路径（主管可执行）与含 website DELETE 的硬删路径（Owner UI）；`x_lists.operation_execute` 执行保持 precise Owner UI，新增独立 internal prepare 命令给主管；`publication.editor_prepare_execute`（浏览器副作用）纳入精确人工确认边界，最终发布点击永不自动。**除这三类外，所有内部 WMB 操作——包括内部审批——归主管。**
4. **员工隔离不变**：记者/策划/写手/资料员的页授权 = 页 writeScope ∩ 角色 standing（发布页对员工仍只读）；对象级硬隔离继续约束员工实例；主管不进员工槽（`spawn(roleId:'desk')` → `ROLE_NOT_SPAWNABLE` 保留）。
5. **内部审批重分类**：`knowledge.topic_maintenance_approve / reject / reproposal_retry`（现登记为 `cap.topic_approval`、`agentGrantable:false`、Owner-UI 专属）**重分类为仅主管可授予**：`agentGrantable:true`、`precise:false`、默认绑定 `{ desk: true }`、不绑定任何员工角色与外部 Agent。
6. **方案**：选定 **A（全能力角色 + 可审计全站任务授权）**，否决 B（仅运行时绕过）与 C（无条件超级用户）。两个子决策：主管 v1 不参与 capability overlays（防止设置面板暴露主管能力开关）；`spawn(roleId:'desk')` 继续拒绝。
7. **旧证续期**：主管 standing 集变化（注册表修订）→ 既有 `sameCommandSet` 机制自动 revoke + reissue；主管会话遇**写前** `TASK_SCOPE_BROADENED`（命令在 standing 集、不在当前 grant）→ 恰一次安全重试（重签 + 重放一次）；仍失败 = 注册缺口 bug → BLOCKED + 审计，**不循环、不中止会话**。
8. **Pi 行为非中止**：主管一切拦截均注入 `[WMB_AUTHORITY_BLOCKED] reason=<code>`，会话与任务存活，Pi 说明原因并给可操作指引；主管只可能遇红线 / 基建 / 注册缺口三类拒绝，普通内部命令永不拦截。

---

## 1. 问题与证据（desk 如何变成「助手 / 无 standing 写权」）

### 1.1 立法层（现行，需翻转；以下为旧条款引证）

| 文件 | 条款 | 现行内容（摘要） |
| --- | --- | --- |
| PRODUCT.md | C9.6 | 主管工位是主编（人）；桌助无 standing 写权、永不进员工槽、不代批、单跳派工。 |
| PRD.md | §2.4 第 6 条、REQ-029、AC-027 | 主管工位是主编（人）；桌助无 standing 写权、不进员工槽、不代批。 |
| SPEC.md | §1.0 不变量 9 | the human editor-in-chief is the supervisor, desk has no standing write power, never occupies an employee slot and never approves on the human's behalf. |
| SPEC.md | CAP-027.6 | Desk = coordination entry, not supervisor workstation；`spawn(roleId:'desk')` → `ROLE_NOT_SPAWNABLE`；工具只读/编排。 |
| 设计 | 2026-08-07 role-permission §4.3 / §5.6 / §6.1 / §9 反模式 13 / §10 L6 / §11 P0.6 | 桌助 = 页级作用域角色，standing 写权 ∅，`pageScopePassThrough` 显式声明，写矩阵桌助行全「页内」，反模式「桌助漂移成全能」。 |
| 设计 | 2026-08-08 crew §0.1-5 / §1.1 P4 / §2.1-5 / §3.2-5 / §8.3 / §10 / §14 A7 / §17-6 | 桌助 = 协调入口不是主管工位；A7「desk 无 standing 写权」为验收断言。 |
| 设计 | 2026-08-10 topic-maintenance-approval §4 / §6-7 | 提案应用命令 Owner-UI 专属、`agentGrantable:false`；桌助不代批。 |
| 设计 | 2026-08-10 conflict-reproposal §5.6 / §7.6 | 不让桌助或 Agent 代批；新提案仍须 Owner 批准。 |
| 历史合同 | `.ai/wmb-5144-contract.md` / evidence.md | P2 把身份翻成「协调入口，主管是主编本人」，并登记进提示词 / Skill / 工具文案。 |

### 1.2 注册表层（授权轴，现行）

- `src/shared/agent-capabilities.ts`：`ROLE_CATALOG.desk = { labelZh:'主管', roomZh:'主编席', skills:['wemedia-buddy-operator'] }`（授权面未改）；`cap.desk` `commands: []` + `pageScopePassThrough: true`；`roleWriteCommands('desk')` 硬编码 `return []`；`filterCommandsForRole` 对 desk 透传；`cap.topic_approval`（approve/reject/reproposal_retry）`agentGrantable:false`、`precise:true`、零绑定。
- `src/main/task-grants.ts`：`ensureAutomaticTaskGrant` 的 `baseCommands` = `AUTOMATIC_TASK_GRANT_SCOPES[intent]`（页任务 = 该页 writeScope）；`assertTaskGrantForEnvelope` 第 363–365 行对 topic approve/reject 硬拦「该命令仅允许 Owner UI 执行」。
- `src/main/pi-page-authority.ts`：`ensurePageAuthority` 遇 `writeScope === null`（发布页）→ `readonly_page`，desk 也拦。
- `src/main/capability-overlays.ts`：`roleWriteCommandsWithOverlays` 对 desk 返回 `[]`；`setCapabilityOverlay` 以 `pageScopePassThrough` 守卫拒绝覆盖。
- `src/main/role-roster.ts`：`DESK_ROSTER_FACE = { labelZh:'桌助', roomZh:'协调入口' }` 覆盖展示。
- `scripts/check-capability-registry.mjs`：检查 4（`pageScopePassThrough` 唯一于 `cap.desk`）、检查 7（`roleWriteCommands('desk')` 为空）把「助手形状」固化成 CI 断言。

### 1.3 运行时 / 提示词 / 展示层（现行）

- 页任务 `contextRefs.roleId`：非 studio/library/discover 页一律 `'desk'`；`filterCommandsForRole('desk', base)` 透传 → 跨页命令即 `TASK_SCOPE_BROADENED`。
- `src/main/pi-operator-skill.ts` `PI_AUTHORITY_SYSTEM_PROMPT`：「你是…桌助（desk，唯一常驻对话面）：协调入口，主管是主编本人，桌助不代行主管职权…」。
- `skills/wemedia-buddy-operator/SKILL.md`：「桌助边界：…无 standing 写权…」「发布页为零自动写权」「若遇旧数据把 desk 标为主管/主编席，一律按桌助/协调入口理解，不因此自认主管」。
- 文案面：`.pi/extensions/wmb-mcp/wmb-mcp-tools-manager.ts`、`src/main/mcp.ts`、`src/main/mcp-job-tools.ts`、`src/main/ipc-pi-dock.ts`（contextRule）、`src/main/manager-dispatch.ts`、`src/main/manager-orchestration.ts`、`src/renderer/agents-roster-view.tsx`、`src/renderer/agents-roster-overview.tsx`、`src/renderer/agents-settings-panel.tsx`（`filter(cap => !cap.pageScopePassThrough)`）、`src/main/ipc-today-studio-business.ts`（capability summary 暴露 `pageScopePassThrough`）。

### 1.4 根因

WMB-5144 的 P2 收口把「主管 = 人」写进了立法与提示词，并用 `pageScopePassThrough` 空集特例 + 展示覆盖把注册表里本就存在的「主管 / 主编席」身份隐藏成助手。结果是：软件内唯一的常驻监督面失去全站内部写权，主管必须逐页透传、跨页即拦、内部审批只能退回人点 UI——**把人变成了软件的日常监督者**。本设计的目标 = 恢复 desk 为软件内主管，把「人」放回它真正的位置：三类红线最终动作的新鲜确认与最终担责。

---

## 2. Owner 意图与决策（2026-08-10 批准）

1. **方案 A 批准**：capability-registry 全角色 + 可审计全站任务授权（§3）。
2. **红线精确化**：仅人可操作的红线**恰好三类（类别）**——① 最终平台发布；② 硬删执行；③ 外部平台变更执行。除此之外的一切内部 WMB 操作（含内部审批）归主管。
3. **主管是全站内部写权持有者**：恢复 desk 为软件内主管工位（主编席），持 standing 全量内部写权，跨页可用。
4. **员工边界与审计纪律不放松**：员工页授权、对象级硬隔离、grant/lease/Precise 门、审计流水全部保留；红线对任何 Agent（含主管）不可达。
5. 决策日：2026-08-10；本文件为决策的书面落档，已获 §8 全 10 项 Owner 锁定（2026-08-10，verbatim：「approved §8 all 10 items, approach A, proceed to legislation and immediate implementation」）。

---

## 3. 方案对比与选定（A 批准）

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A. 全能力角色 + 页授权（批准）** | 注册表把主管绑定全部 `agentGrantable` 业务能力（`cap.collect / research / lane_judge / library_organize / topic_approval / topic_decide / knowledge_curate / write / review` 的 `defaultRoleBindings` 增 `desk:true`）；删除 `pageScopePassThrough` 与全部 desk 空集特例；运行时主管页授权基底 = standing 全量（非页 writeScope），发布页对主管签发全量 grant、对员工仍只读；员工页授权保持 页 ∩ 角色。保留 grant 模型、审计、Precise 门、对象边界。 | **采用**。注册表（授权真相）与运行时行为一致；立法翻转后 CI 断言同步翻转；无双语义。 |
| B. 仅运行时绕过（否决） | 注册表保持 `cap.desk` 空集 + 透传，只改签发（主管页 grant = 全量）。 | 注册表继续声明主管无命令 = 与立法矛盾；CI 的 desk 空集断言仍要改，省不了改动却留下双语义。 |
| C. 无条件超级用户（否决） | 主管绕过 grant 门，grant-free 写。 | 违反 SPEC §2.2「Pi/external 业务写必须有 task grant」；破坏回执/审计；红线需另列豁免。 |

**A 的两个子决策**（随 A 一并批准）：
- **主管不参与 overlays（v1）**：`setCapabilityOverlay` 显式拒绝 `roleId === 'desk'`，设置面板不出现主管能力开关（替代原 `pageScopePassThrough` 守卫的防暴露作用）。
- **`spawn(roleId:'desk')` → `ROLE_NOT_SPAWNABLE` 保留**：主管是常驻对话面，不占员工槽、不产生实例卡；监工走 roster / jobs / message。

---

## 4. 定义（身份 / 授权集 / 签发流 / 红线 / 隔离 / 注册默认 / 续期 / 重试 / 非中止）

### 4.1 身份

- 角色键 `desk` 保留（内部持久标识，不进入用户可见语言）。
- 唯一用户可见身份：**主管 / 主编席**（`ROLE_CATALOG.desk` 原值）。删除 `DESK_ROSTER_FACE` 覆盖与全部「桌助 / 协调入口 / 桌助对话」文案；**不保留任何用户可见兼容别名**（历史文档中的旧词仅作引证保留，不进入新文案）。
- 主管 = 软件内主管：管理记者/策划/写手/资料员，持全站内部写权，单跳派工、盯梢、传话、呈报、**内部审批**均为其职权。人的角色 = 三类红线最终动作的新鲜确认与最终担责（定目标、担责），不再是软件的日常监督者。

### 4.2 授权集（不变量 I1）

- `deskStanding = commandsCoveredByGrantableCapabilities() ∪ INFRA_GRANT_COMMANDS`（全量内部命令，**含内部准备命令**，不含红线类别执行命令）。
- 红线**类别**的执行命令（最终发布点击、硬删执行、`x_lists.operation_execute`、`publication.editor_prepare_execute`、`intelligence_channels.proposal_apply` 的 remove 路径）**永不入内**——CI 负断言（§7 A1）。
- 读面不变：主管读全实体（settings 除外），维持现状。

### 4.3 签发流（不变量 I2/I3/I4）

- **页 dock**：任一页（含 publish、agents）绑定主管时，`ensurePageAuthority` 跳过 `writeScope === null` 的只读分支，为该页任务签发 `allowedCommands = deskStanding` 的自动 grant。主管内部命令永不因「本页更窄」中止。
- **`ensureAutomaticTaskGrant`**：`resolvedRole === 'desk'` 时 `baseCommands = deskStanding`（不经 `AUTOMATIC_TASK_GRANT_SCOPES[intent]` 收窄），overlays 跳过（A 子决策，现状分支已排除 desk）。
- **员工**：页授权 = 页 writeScope ∩ 角色 standing（I3，零变化）；发布页对员工仍 `readonly_page`。
- **一切 pi/external 写（含主管）仍需 task grant + lease 校验**（SPEC §2.2）；无 grant-free 写（I4）。grant 绑定 workspace/runtimeEpoch/taskId，跨工作空间写仍被 `TASK_GRANT_STALE` 拦。
- **envelope 兜底**：`assertTaskGrantForEnvelope` 删除「topic approve/reject 仅 Owner UI」硬拦（363–365 行），改由 standing 集成员资格 + grant scope 校验统一把关；红线类别执行命令不进入任何 grant，`assertExecutionGrantForEnvelope` Precise 门照常（含 `publication.editor_prepare_execute` 浏览器副作用）。
- **对象级硬隔离**：继续约束员工实例（`RoleJobSpec.resourceLocks`，C9.7 施工必需）；主管 dock 会话维持现状页任务边界（workspace/taskId/lease），不新增 spawn 对象边界。

### 4.4 三条红线类别（不变量 I5，且是全部）与准备/执行分离

红线是**类别**，不是命令清单：① 最终平台发布；② 硬删执行；③ 外部平台变更执行。三类**最终动作（final act / execute）**必须由人类 UI **新鲜确认**（Precise Gate + Owner UI）；主管可**准备**不可逆/外部动作（内部准备命令，standing），但代理不得自签 precise grant、不得直接执行任何红线最终动作。

| # | 红线类别 | 最终动作（仅人类 UI，新鲜确认） | 主管可准备的部分（内部命令） |
| --- | --- | --- | --- |
| ① | **最终平台发布** | 平台最终发布点击（永不自动）；`publication.editor_prepare_execute`（浏览器填充平台编辑器，外部浏览器副作用）须精确人工确认 | 发布快照准备（内部准备命令；PublicationSnapshot 冻结） |
| ② | **硬删执行** | `deleteKnowledgeSource` 等硬删仅 Owner UI（1A）；`intelligence_channels.proposal_apply` 拆分出的**含 website DELETE 的 remove 路径**（Owner UI） | `intelligence_channels.proposal_apply` 拆分出的**无 remove 安全应用路径**（本地 add/enable/disable，非破坏性）→ 归主管，核心事务逻辑复用 |
| ③ | **外部平台变更执行** | `x_lists.operation_execute`（X List 外部变更执行）保持 precise Owner UI | 新增独立 **internal prepare 命令/capability** 绑定主管（MCP prepare 工具改挂该内部 scope，不再误用 `operation_execute` scope） |

- 红线类别执行命令对主管、员工、外部 Agent、任何 grant 组合不可达；主管遭遇时得到 `PRECISE_REQUIRED` / Owner-UI 指引（§4.9）。
- 命令级拆分（§6.3 登记影响面，非实施合同）：`intelligence_channels.proposal_apply` 按「是否含 remove」拆分；x_lists 新增内部 prepare 命令；`publication.editor_prepare_execute` 纳入精确人工确认边界。
- **「红线」一词在本设计及后续立法中只指这三类**；内部审批（§5）不是红线。

### 4.5 员工隔离（不变量 I6 的一部分）

- 员工 = reporter / planner / writer / librarian。页授权与 standing 形状、对象边界、needs_user、jobId 指认等全部现行机制不变。
- 员工**不**持有 `cap.topic_approval`（重分类后仅 `{ desk: true }` 绑定）；员工不持有红线。
- 主管不进员工槽：`spawn(roleId:'desk')` → `ROLE_NOT_SPAWNABLE`；主管无实例卡；监工走 roster / jobs / message（I6）。

### 4.6 命令注册默认值（新功能开发规程修订）

- **默认绑定主管**：任何新的内部写命令登记 Capability 时，`defaultRoleBindings` 默认含 `desk:true`（主管是全站内部写权持有者）；员工绑定按劳动分工评审（选题决策权、写作权、库房整理权等既有边界不变）。
- **仅红线类别执行命令例外（不绑定主管）**：最终发布、硬删执行、外部平台变更执行 → 登记为 `agentGrantable:false`、`precise:true`、零绑定，CI 负断言兜底；**内部准备命令默认绑定主管**（x_lists prepare、channel 安全应用、发布快照准备等）。
- 覆盖表仍只允许 `agentGrantable` 能力；主管 v1 不参与 overlays（A 子决策）。

### 4.7 旧证续期（不变量 I7 的一部分）

- 主管 standing 集变化（注册表修订）→ `ensureAutomaticTaskGrant` 内既有 `sameCommandSet` 判定自动 revoke + reissue；**无手工迁移、无数据脚本**。
- 续期发生在：写前拦截触发的重签（§4.8）、或下次会话/任务绑定的 grant 检查。

### 4.8 写前 `TASK_SCOPE_BROADENED` 的恰一次安全重试（不变量 I7 核心）

- **触发条件**：主管（desk）会话的写请求命中 `assertTaskGrantForEnvelope` 的「命令超出 Task grant 范围」（`TASK_SCOPE_BROADENED`），且该命令 ∈ `deskStanding`——即旧证未换发（§4.7）或本页旧证过窄。
- **安全性**：dispatcher 在命令 handler 执行**之前**抛错，被拒 envelope 从未产生业务写；重试严格发生在任何业务写之前。
- **序列（恰好一次）**：① 拦截 `TASK_SCOPE_BROADENED` → ② 对绑定任务重跑 `ensureAutomaticTaskGrant(desk)`（sameCommandSet 变化 → revoke + reissue）→ ③ 重放同一 envelope **恰一次** → ④ 成功 = 收尾；仍失败 = 注册缺口 bug → `[WMB_AUTHORITY_BLOCKED] reason=TASK_SCOPE_BROADENED` + `role_authority_blocked` 审计流水。
- **禁止**：多次循环重试、静默吞掉、绕过 grant 直写 DB。
- **员工不触发**：员工命令超出角色 standing 集 = `ROLE_SCOPE_BLOCKED`（语义不变，不重试）。

### 4.9 非中止 Pi 行为（不变量 I7 的拒绝分类）

主管只可能遇三类拒绝，全部非中止：

| 类别 | 触发 | 主管行为 |
| --- | --- | --- |
| 红线 | `PRECISE_REQUIRED` / Owner-UI 新鲜确认（最终发布、`publication.editor_prepare_execute`、硬删执行、外部平台变更执行） | 说明原因 + 指向 UI 确认入口；不代签、不绕行 |
| 基建 | `lease_missing` / `task_not_active` / `unknown_page` / `TASK_GRANT_STALE/EXPIRED/REVOKED` 等 | 说明原因 + 可操作指引（重试 / 换页 / 等待） |
| 注册缺口 | 一次重试后仍 `TASK_SCOPE_BROADENED` | 报告注册缺口（§4.8）；会话与任务存活 |

- 每次拦截写 `role_authority_blocked` 流水（role、command、page、reason、时间）。
- Pi 收到 BLOCKED 必须向用户说明原因并给可操作指引；禁止伪造 authority、禁止把拦截原因合并成「没有权限」裸话、禁止绕行（禁直写文件/DB）。

---

## 5. 内部审批重分类（cap.topic_approval）

**现状**：`cap.topic_approval`（`knowledge.topic_maintenance_approve / reject / reproposal_retry`）登记为 `agentGrantable:false`、`precise:true`、零绑定；`assertTaskGrantForEnvelope` 对 approve/reject 硬拦 Owner-UI only；reproposal_retry 由 scheduler（有界重试）与 Owner UI（恢复动作）调用。

**重分类（本设计裁决）**：这三条命令是**内部操作**（本地知识库主题结构的原子事务，不触外部平台），不属于三类红线类别 → **归主管**：

1. `cap.topic_approval` → `agentGrantable:true`、`precise:false`、`defaultRoleBindings: { desk: true }`、`grantKinds` 覆盖主管页/任务（发布页与智能体页 dock 亦可用）。
2. `assertTaskGrantForEnvelope` 删除 Owner-UI-only 硬拦；主管经 standing 集 + grant scope 正常执行。
3. **四眼制衡保留**：提案提出权仍在资料员（`knowledge.topic_maintenance_propose` ∈ `cap.library_organize`，员工可持有）；批准/驳回/恢复只绑定主管——员工与外部 Agent 仍不可调用（role/execution 边界拒绝，零业务写）。
4. **冲突合同不变**：真冲突整批零写 → stale → 系统自动派资料员按最新现场重提 → 新提案仍由主管批准；scheduler 的 outbox 自动派发是基建路径，不进任何角色 grant。
5. 红线类别执行命令（§4.4）**保持不可授予**，不受本重分类影响。（`intelligence_channels.proposal_apply` 的安全应用/remove 拆分属渠道域，见 §4.4 与 §6.3，与本节的内部主题审批互不相关。）
6. 立法联动：`2026-08-10-topic-maintenance-approval-design.md` §4/§6/§7 与 `2026-08-10-topic-maintenance-conflict-reproposal-design.md` §5.6/§7.6 中「Owner-UI 专属 / 桌助不代批」条款按本设计修订为「主管审批」；历史 Owner lock 记录保留，新立法显式引用本次修订。

---

## 6. 需变更的权威条款与文件清单（只列影响面，不写实施合同）

> **本清单用于立法与后续任务合同的边界识别，不授权施工**。任何改动须经 TASKS doing 任务合同。

### 6.1 立法条款（PRODUCT / PRD / SPEC）

| 文件 | 条款 | 变更方向 |
| --- | --- | --- |
| PRODUCT.md | C9.6 | 翻转：主管工位 = 软件内主管（主编席），持全站内部 standing 写权；红线三类不变；员工槽/代批句改写（内部审批归主管） |
| PRD.md | §2.4 第 6 条、REQ-029、AC-027 | 同翻转；AC-027「无 standing 写权、spawn 被拒」改为「standing 全量内部写权；spawn(roleId:'desk') 仍被拒」 |
| SPEC.md | §1.0 不变量 9 | desk 子句翻转（supervisor = software-side，standing internal write power）；红线子句保留 |
| SPEC.md | CAP-027.6 | 同翻转；工具描述由「只读/编排」改为「全站内部写 + 编排 + 内部审批」 |
| SPEC.md | CAP-026（注册表约束）、EVAL-030 | desk 绑定与 desk 行投影断言同步翻转 |
| SPEC.md | CAP-028 | 研究续派「桌助作为协调入口自动派单」表述改为「主管派单」；`cap.research` 增加 desk 绑定 |

### 6.2 设计文档（canonical 与子设计）

| 文件 | 条款 | 变更方向 |
| --- | --- | --- |
| 2026-08-07-role-permission-design.md | §4.3（standing/page 表）、§5.3（cap.desk 行）、§5.4 检查 6、§5.5（覆盖表）、§5.6（页作用域声明）、§5.8（注册规程）、§6.1（写矩阵）、§8.2（零回归承诺）、§9 反模式 13、§10 L6/L15、§11 P0.6 | 主管 standing = 全量内部命令；删除透传声明与「漂移成全能」反模式；写矩阵桌助列改「✓ standing（全量内部，除红线类别执行命令）」；L15 红线三类保持 |
| 2026-08-08-agent-crew-multi-instance-design.md | §0.1-5、§1.1 P4、§2.1-5、§3.2-5、§8.3、§10、§14 A7、§17-6 | 同翻转；A7 改为「主管 standing 写权 = 全量内部（不含红线类别执行命令），spawn 仍拒绝」；P4 反模式转归档 |
| 2026-08-10-topic-maintenance-approval-design.md | §4（授权形状）、§6 验收 7、§7 Owner lock | 应用命令归主管（`agentGrantable:true`、`precise:false`、`{desk:true}`）；资料员/策划/外部仍拒绝 |
| 2026-08-10-topic-maintenance-conflict-reproposal-design.md | §5.6、§7.6 | 「不让桌助或 Agent 代批」→「内部审批归主管；员工与外部 Agent 不代批」 |
| `.ai/wmb-5144-*` | — | 历史记录保留，不重写；新合同显式引用本翻转 |

### 6.3 实施文件（影响面，非合同）

| 文件 | 符号 | 变更方向 |
| --- | --- | --- |
| `src/shared/agent-capabilities.ts` | `AGENT_CAPABILITIES`、`roleWriteCommands`、`filterCommandsForRole`、`roleHasPagePassThrough`、`REDLINE_COMMANDS`、`cap.topic_approval` | 业务能力默认绑定增 `desk:true`；`cap.topic_approval` 翻转为 grantable + desk 绑定 + `precise:false`；删 `pageScopePassThrough` 字段与 desk 空集/透传特例；红线按三类**类别**定义，`REDLINE_COMMANDS` 常量随命令拆分修订（`x_lists.operation_execute` 保留执行红线；`intelligence_channels.proposal_apply` 拆分；补 `publication.editor_prepare_execute`） |
| `src/main/task-grants.ts` | `ensureAutomaticTaskGrant`、`assertTaskGrantForEnvelope` | desk 基底 = standing 全量（跳过 intent 收窄）；删 363–365 行 Owner-UI 硬拦；续期/重试语义（§4.7/§4.8） |
| `src/main/pi-page-authority.ts` | `ensurePageAuthority` | 主管跳过 `readonly_page` 分支（发布/智能体页签发全量 grant）；员工只读不变 |
| `src/main/capability-overlays.ts` | `roleWriteCommandsWithOverlays`、`setCapabilityOverlay` | 删 desk 空集特例；加显式 `roleId==='desk'` 拒绝（替代原透传守卫） |
| `src/main/role-roster.ts` | `DESK_ROSTER_FACE` | 删除覆盖 → `ROLE_CATALOG.desk`（主管/主编席） |
| `src/main/pi-operator-skill.ts` | `PI_AUTHORITY_SYSTEM_PROMPT` | 主管身份 + standing 全量内部写 + 红线边界；保留多实例/jobId/needs_user/禁编造/禁直写 DB/UI 确认 |
| `skills/wemedia-buddy-operator/SKILL.md` | 桌助边界、页面 dock 自动授权、主题提案呈报段 | 主管边界 + 全站内部写；发布页对主管可写；提案审批指向主管 |
| 文案面 | `.pi/extensions/wmb-mcp/wmb-mcp-tools-manager.ts`、`src/main/mcp.ts`、`src/main/mcp-job-tools.ts`、`src/main/ipc-pi-dock.ts`（contextRule）、`src/main/manager-dispatch.ts`、`src/main/manager-orchestration.ts` | 「桌助/协调入口」→「主管/主编席」 |
| renderer | `agents-roster-view.tsx`、`agents-roster-overview.tsx`（RoleHead/概览行/提示）、`agents-settings-panel.tsx`（capability 过滤）、`src/main/ipc-today-studio-business.ts`（summary 暴露） | desk 行 = 主管/主编席；过滤随 `pageScopePassThrough` 删除调整（主管能力不出现在覆盖 UI） |
| 渠道提案命令（`intelligence_channels.proposal_apply` 处理路径） | 提案应用事务 | 拆分：**无 remove 的安全应用路径**（本地 add/enable/disable，非破坏性）登记为内部命令并绑定主管，核心事务逻辑复用；**含 website DELETE 的 remove 路径**保留 Owner UI 硬删边界（`agentGrantable:false`） |
| X List 工具面（MCP prepare 工具 + `x_lists.operation_execute` 处理路径） | prepare 工具、operation 执行命令 | 新增独立 **internal prepare 命令/capability** 绑定主管；MCP prepare 工具改挂该内部 scope（不再误用 `operation_execute` scope）；`x_lists.operation_execute` 执行保持 precise Owner UI |
| 发布准备/执行路径（`publication.editor_prepare_execute` 处理路径） | editor_prepare_execute、发布适配器 | `publication.editor_prepare_execute`（浏览器填充副作用）纳入精确人工确认边界（Precise + Owner UI 新鲜确认）；最终 publish click 永不自动；发布快照准备归主管内部命令 |
| `scripts/check-capability-registry.mjs` | 检查 4/6/7 | 删透传唯一性检查；desk 断言改为「standing = 全量内部（含准备命令）且不含红线类别执行命令」 |

### 6.4 测试（需改 / 新增，均须经任务合同）

需改（现锁定「无写权」）：`tests/agent-capabilities.test.mjs`、`tests/agent-work-paths.test.mjs`、`tests/wmb-5145-compatibility-invariants.mjs`（re-baseline 须显式评审）、`tests/wmb-5145-crew-multi-instance-acceptance.test.mjs`（A7）、`tests/wmb-5142-instance-projection.test.mjs`（desk 行）、`tests/pi-operator-skill.test.mjs`（身份 eval）、`tests/agents-roster-conflict.test.mjs`、`tests/wmb-5143-agents-instance-view.test.mjs`、`tests/pi-extension.test.mjs`、`tests/pi-message-flow.test.mjs`、`tests/job-event-envelope.test.mjs`、`scripts/check-capability-registry.mjs`。

新增（§7 的 A1–A8 落为测试场景）。

---

## 7. 验收标准（可执行、可证伪；落为测试与实机场景）

> 以下为设计级可执行验收，由后续任务合同落地为测试/实机演练；本文件不写实现。

- **A1 standing 集断言（CI 单测）**：`roleWriteCommands('desk')` 排序后 == `commandsCoveredByGrantableCapabilities() ∪ INFRA_GRANT_COMMANDS`（含内部准备命令）；且与红线类别执行命令集（最终发布点击、`publication.editor_prepare_execute`、硬删执行、`x_lists.operation_execute`、`intelligence_channels.proposal_apply` 的 remove 路径）交集为空（负断言）。
- **A2 跨页写（集成）**：发布页 dock 绑定主管 → 签发覆盖全量内部命令的 grant；`content.save_version` 等在发布页会话成功；同一命令在员工角色发布页会话 → `readonly_page` BLOCKED。
- **A3 红线回归（类别级，集成）**：a) 渠道：主管执行 `intelligence_channels.proposal_apply` 无 remove 安全路径 → 成功且回读；含 website DELETE 的 remove 路径 → Owner UI 专属，主管/员工/外部 Agent 全部拒绝且零业务写；b) X List：主管 internal prepare 命令成功；`x_lists.operation_execute` → Precise 门拦截（`EXECUTION_GRANT_REQUIRED`），零业务写；c) 发布：`publication.editor_prepare_execute` 须精确人工确认，代理不可达；最终 publish click 永不自动（无任何 grant/命令可达）；d) 硬删（`deleteKnowledgeSource` 等）→ Owner UI only，任何 grant 组合不可达。
- **A4 内部审批（集成）**：主管应用已批准的主题整理提案 → 单事务整批生效 + 完整读回；资料员/策划/外部 Agent 尝试应用 → 角色/执行边界拒绝，零业务写；真冲突 → stale 零写 + 自动重派资料员重提，新提案仍由主管批准。
- **A5 员工隔离（回归）**：写手在创作页 = `content.*` 仅；策划在资料库页 = 页∩standing；员工在发布页仍只读；`spawn(roleId:'desk')` → `ROLE_NOT_SPAWNABLE`。
- **A6 续期 + 恰一次重试（集成）**：主管 standing 集变化后，旧 grant 经 `sameCommandSet` 自动 revoke+reissue；写前 `TASK_SCOPE_BROADENED` 触发恰好一次重签+重放后成功；二次失败 → BLOCKED + 审计，无循环。
- **A7 非中止（回归）**：主管每类拦截注入 `[WMB_AUTHORITY_BLOCKED] reason=<code>`，会话与任务存活；每条拦截落 `role_authority_blocked` 审计流水。
- **A8 文案一致性（grep 门）**：提示词 / Skill / 工具描述 / roster 投影中无「桌助 / 协调入口」残留；desk 行 = 主管/主编席 且写命令数 > 0；员工行不变。
- **A9 实机演练**：默认主管在 今日/发现/创作/发布 各页 dock 执行跨页内部命令成功；X List 执行无 UI 确认被拦（内部 prepare 可通过）；发布页内部写成功、`editor_prepare_execute` 无 UI 确认被拦；员工角色在非本科室页仍只读。

---

## 8. Owner 锁定块（Owner lock 2026-08-10 —— 全 10 项已确认）

> 本块编号逐项。**Owner lock 2026-08-10（verbatim）**：「approved §8 all 10 items, approach A, proceed to legislation and immediate implementation」。全部 10 项已由 Owner 书面确认（决策日 2026-08-10）；本设计据此进入立法（WMB-5181）与施工（WMB-5182–5185，TASKS doing 仍是唯一施工许可）。「红线」一词在本块及后续立法中只指三类：最终平台发布、硬删执行、外部平台变更执行（类别，非命令清单）。

1. ☑ **身份**：角色键 `desk` 保留；所有用户可见身份统一为主管 / 主编席；删除「桌助 / 协调入口」展示覆盖与文案，不留用户可见兼容别名。
2. ☑ **授权**：主管持全站内部 standing 写权 = 全部 grantable 业务能力命令 ∪ INFRA（含内部准备命令，不含红线类别执行命令）；任一页 dock（含发布/智能体页）绑定主管签发全量内部 grant；内部命令对主管不因「本页更窄」中止。
3. ☑ **红线恰三类（类别，非命令清单）**：最终平台发布、硬删执行、外部平台变更执行；主管可**准备**不可逆/外部动作（内部准备命令），最终动作须人类 UI 新鲜确认，代理不得自签 precise grant、不得直接执行；`intelligence_channels.proposal_apply` 拆分无 remove 安全路径（主管）与含 remove 硬删路径（Owner UI）；`x_lists.operation_execute` 执行保持 precise Owner UI 并新增内部 prepare 给主管；`publication.editor_prepare_execute` 纳入精确人工确认边界；最终 publish click 永不自动；「红线」一词不再包含内部审批。
4. ☑ **内部审批归主管**：`knowledge.topic_maintenance_approve / reject / reproposal_retry` 重分类为仅主管可授予（`agentGrantable:true`、`precise:false`、`{desk:true}`）；资料员/策划/外部 Agent 不持有；冲突合同与四眼制衡保留。
5. ☑ **员工隔离**：员工页授权 = 页 ∩ 角色 standing 不变；发布页对员工仍只读；对象级硬隔离与 grant/lease/Precise/审计纪律不变；`spawn(roleId:'desk')` 仍拒绝。
6. ☑ **续期与重试**：standing 集变化经既有 `sameCommandSet` 自动换发；写前 `TASK_SCOPE_BROADENED` 恰一次安全重试，二次失败 = 注册缺口 bug → BLOCKED + 审计，不循环、不中止。
7. ☑ **注册默认**：新内部写命令默认绑定主管；仅红线类别执行命令例外；内部准备命令默认绑定主管；覆盖表仍只允许 `agentGrantable` 能力，主管 v1 不参与 overlays。
8. ☑ **非中止 Pi 行为**：主管只遇红线/基建/注册缺口三类拒绝，全部注入 `[WMB_AUTHORITY_BLOCKED]` 并给可操作指引，禁止伪造 authority 与绕行。
9. ☑ **立法范围**：§6.1–§6.2 列出的 PRODUCT/PRD/SPEC/canonical 条款按本设计修订；历史 Owner lock 与 `.ai/wmb-5144-*` 保留为历史，不重写。
10. ☑ **施工许可**：本文件仅授权立法与设计输入；实施须经 TASKS doing 任务合同（WMB-5182–5185）。

---

## 9. 自审记录（写前逐项核对，问题已在本文件定稿前修复）

| 检查项 | 结论 |
| --- | --- |
| 占位符/TODO/TBD | 无；§8 锁定块为已确认的 Owner lock（2026-08-10 全 10 项 ☑），非占位。 |
| 矛盾 | 已消除「主管=人 vs 主管=软件内主管」双语义；全文件规范语句只使用主管/主编席，`desk` 仅作代码角色键；旧条款仅以引证形式出现（§1）。 |
| 范围歧义 | 红线按三类**类别**定义（§4.4），`REDLINE_COMMANDS` 是命令常量、不是红线定义（已删除「恰三条件」错误表述）；准备 vs 执行分离明确（主管可准备、执行须人新鲜确认）；内部审批的授权面精确到三条命令 + 唯一绑定角色（§5）；「红线」一词不再包含内部审批（§4.4/§8-3）。 |
| 意外第四条红线 / 外部 execute 遗漏 | 无：红线 = 三类（最终发布、硬删执行、外部平台变更执行），准备 ≠ 红线；外部/最终 execute 全集已列明——`x_lists.operation_execute`、`publication.editor_prepare_execute`、`intelligence_channels.proposal_apply` 的 remove 路径、最终 publish click、硬删命令——无第四类、无遗漏；内部审批与渠道安全应用归主管（非红线）。 |
| 日期 | 全部统一 2026-08-10（决策日/落档/复核），无 2026-08-11 残留。 |
| 人机措辞 | 无「人 = 软件主管」或「主管 = 助手」残留：§2/§4.1 明确人 = 三类红线最终动作的新鲜确认与最终担责；主管 = 软件内主管持全站内部写权、内部准备权与内部审批权。 |
| 兼容别名 | 用户可见语言无「桌助/协调入口」兼容别名（§4.1/§7 A8）；`desk` 键保留是持久标识，非用户可见别名。 |
| 授权 vs 施工 | §0/§6 显式声明本文件不授权代码，TASKS doing 仍是唯一施工许可。 |
| 验收可执行性 | §7 A1–A9 为可证伪的断言级验收（命令名、拦截码、行为结果均已对齐当前源码事实）。 |
