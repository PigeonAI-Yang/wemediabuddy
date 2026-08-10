# 智能体班组多实例协同设计（固定五角色 × 按任务实例）

- 日期：2026-08-08（Owner 显式 UI 选择确认；同日落档并依 Owner 追加五项选择与独立复审修正）
- 作者：Designer（依据 Owner 2026-08-08 会话确认方向统稿）
- 状态：**正式施工 Owner lock（2026-08-08 Owner 会话确认并落档升级）**。本文件是班组多实例协同方向的唯一设计真源。**TASKS doing 仍是唯一施工许可**：本文件不替代任务合同、不直接授予施工权；任何施工须另行任务合同（显式引用 §12 兼容原则与 §16 影响面）并经 TASKS doing 授权（§17）。
- Route：Design → **Legislate（2026-08-08 已落档 PRODUCT / PRD / SPEC / PLAN）**。设计落档阶段不修改源码 / 测试 / TASKS / 台账。
- 依据：PRODUCT C8、PRD §2.3、SPEC §1.1（CAP-026）、`docs/spark/2026-08-07-role-permission-design.md`（canonical）、`docs/spark/2026-08-07-desk-manager-job-runtime.md`（CAP-027）、`docs/spark/2026-08-08-agent-crew-generic-runner-repair-design.md`（WMB-5116）、`docs/spark/2026-08-08-manager-as-primary-agent-design.md`、`docs/spark/2026-08-08-agent-crew-residual-risk-closure-design.md`（WMB-5117..5122）、`docs/spark/2026-08-08-manager-orchestration-design.md`、`docs/spark/2026-08-07-fixed-role-agents-ux-design.md`

---

## 0. 结论（verdict，先行）

1. **班组 = 固定五角色身份 × 按任务创建的多实例**。角色（桌助/记者/策划/写手/资料员）是跨赛道稳定的劳动分工类型；**实例**是某次任务运行产生的执行单元（jobId + lease + 会话 + agent_task + grant），绑定一个角色，终态后退出活动视图。二者是「类型」与「个体」的关系，不是「座位」与「坐席」的关系。
2. **三条硬区分**：固定角色 ≠ 固定槽（角色不绑定槽位数量，同角色可同时多实例）；实例 ≠ 永久员工（实例随任务生灭，无「待命」实例、无持久员工档案）；并发 ≠ 角色限制（共享并发池只是系统容量，不构成任何角色的名额配额）。
3. **五角色分组始终可见，不画空槽**：智能体页按固定五角色分组呈现，空角色显示「当前无任务」，不画占位坐席；活动视图只渲染真实实例卡。闲时不撒谎——不存在「五个座位等填充」。
4. **共享并发池 = 纯系统容量**：`maxWorkers`（0..7，0=停用派工，默认 2）表示全角色共用的并行工单数上限，是容量旋钮，不是角色编制，也不是每角色配额。
5. **桌助 = 协调入口，不是主管工位**：真正的「主管工位」是主编（人）——定目标、批关键节点、担责。桌助是对人说话的入口与单跳派工执行者：派工、盯梢、传话、呈报；桌助无 standing 写权、永不进员工槽、不代批。
6. **实例权限 = 任务精确授权 ∩ 角色能力 ∩ 资源边界**，且限定在该任务的对象键（businessDate / projectId / sourceIds / scope）内，dispatcher 对象级硬校验、跨对象写拒绝。发布/硬删/平台副作用红线不变（`agentGrantable:false`，任何实例不可达）。
7. **兼容承诺**：本方向不要求新增通用角色、不引入云服务/多租户、不新增平台 API；`agent_tasks` / `task_grants` / `execution_grants` 结构预期零改动（spawn 合同写入既有 `context_refs_json` 列，不新增表/列）；Capability registry 预期零改动（以一致性检查验证）。
8. **needs_user 停留活动区**：终态 `needs_user` 卡留在活动视图「等你批」，直至用户处理/关闭；期间不占并发、不持 lease/grant/锁。

---

## 1. Problem / Root cause

### 1.1 要解决的问题

| # | 问题 | 现状证据 | 后果 |
| --- | --- | --- | --- |
| P1 | **固定槽误解**：把「5 角色编制」读成「5 个常驻座位」 | 班组页/值班条按角色画固定名牌（`fixed-role-agents-ux-design.md` §2/§3）；角色与席位未解耦 | 无任务时渲染「待命」空座=向用户撒谎；有任务时数量被座位数锁死 |
| P2 | **实例语义缺失**：任务与执行单元不分，实例没有一等身份 | 现状只有 roleId 概念；同角色多工单只能体现在 JobPool 排队里，UI 无「两个记者同时在干」的表达 | 无法表达同角色并行、无法按实例隔离会话/授权/历史、无法按任务汇报 |
| P3 | **并发语义错位**：把并发量读成「每个角色几个名额」 | `maxWorkers` 是全局池容量；角色专属实体锁已存在（WMB-5116 §8.1） | 容量策略与角色编制耦合 → 加并行要改「角色表」，动编制 |
| P4 | **主管工位漂移**：桌助被当成监工座 | desk 有 `pageScopePassThrough`；manager 编排面已存在 | 若 desk 被理解为「主管座位」，会向 standing 写权/自动多跳回潮 |
| P5 | **多实例无编号无历史**：实例退出后无从指认 | JobPool 内存态；context_refs_json 未含 jobId/brief/边界参数，历史散在 agent_tasks / 会话文件 / 审计 | 「刚才那个记者#几」说不清；实例指认与续派缺锚点 |

### 1.2 Root cause（一句话）

**角色编制（劳动分工类型）被误当成了「座位数」与「并发配额」**：执行单元（实例）没有独立一等身份，共享容量没有与编制解耦，活动视图按「角色」而非按「实例」渲染。本设计的全部内容 = 把这三处解耦，并落成不变量。

---

## 2. Goals / Non-goals

### 2.1 Goals

1. 固定五角色不变（PRODUCT C8 / PRD §2.3）；**同角色可同时多实例且显式可见**。
2. **实例按任务创建**；任务终态后**实例退出活动视图**（历史留档，不占活动面）。
3. 活动视图**不预设空槽**：五角色分组始终可见，空角色显示「当前无任务」，不画空槽。
4. 共享并发池 = **纯系统容量**（默认 `maxWorkers=2`），不构成角色配额。
5. 桌助 = **协调入口**（对话、派工、盯梢、传话、呈报），无 standing 写权、不进员工槽、不代批。
6. 实例权限 = **任务精确授权 ∩ 角色能力 ∩ 资源边界**；dispatcher 对象级硬校验（跨对象拒绝）；发布/硬删红线不变。
7. 兼容：不新增通用角色/云/平台 API；schema 与 Capability registry 预期零改动。

### 2.2 Non-goals（明确不做）

- **不做编排图 / 员工自动多跳**：实例之间没有边；接力由桌助/人单跳完成。
- **不做永久员工实体**：不建员工档案、不设常驻「待命」实例、不做员工考勤/资历模型。
- **不做可配置权限 UI**：P0（注册表 + 角色过滤 + 只读班组页）完成前零权限配置控件（canonical §11.4 纪律延续）。
- **不新增通用角色 / 云 / 平台 API**：不引入 generic worker 泛角色；不依赖云端编排服务；不新增内容平台官方 API（浏览器 CDP 执行器现状不变）。
- **不改发布/硬删红线**：最终发布点击与硬删仍仅人类 UI。
- **施工许可仍由 TASKS doing 唯一授予**：本文件是正式施工 Owner lock 的设计真源；施工须另行任务合同（引用 §12/§16）并经 TASKS doing 授权，本文件本身不直接启动代码变更（§17）。

---

## 3. 术语与不变量

### 3.1 术语

| 术语 | 定义 |
| --- | --- |
| **角色 Role** | L0 编制身份 = 劳动分工类型（桌助/记者/策划/写手/资料员）。跨赛道、跨功能稳定；不含槽位数量语义。 |
| **实例 Instance** | 一次任务运行产生的执行单元：一等身份 `jobId` + `roleId`，活动期持 employee lease 与任务 grant，独立 Pi 会话（`job-<jobId>.jsonl`）；通常对应一个 `agent_task`，scan→judge 场景可与接续实例共享同一任务（非 1:1）。绑定且仅绑定一个角色。 |
| **工单 Job** | 单跳派工单元（`RoleJobRequest` → 派生 `RoleJobSpec`），在共享并发池中排队/执行/终态（needs_user 终态停留活动视图待人工处理）。 |
| **任务 Task** | `agent_task` 持久业务任务，intent 由角色注册表唯一派生（`daily_scan`/`daily_judge`/`studio_draft`/`page_library`）；一个任务生命周期内可先后被 scan→judge 两个实例 rebind。 |
| **共享并发池 Pool** | 全角色共用的 worker 容量（`maxWorkers` 0..7，0=停用派工，默认 2）。纯容量语义。 |
| **槽位 Slot** | 池容量单位。**不是编制、不是配额**。 |
| **活动视图 Active view** | 智能体（班组）页、今日值班条、科室页中渲染「在办实例」的面。只含 queued / waiting_resource / running 及停留待处理的 needs_user 实例（终态但停留至用户处理/关闭）。 |

### 3.2 不变量（本设计的地基，任何施工不得违反）

1. **固定角色 ≠ 固定槽**：角色是身份类型，不绑定槽位数量；同角色可同时存在任意多个实例（受共享容量与实体锁约束）。
2. **实例 ≠ 永久员工**：实例随任务创建、终态退出活动视图（needs_user 停留至人工闭环）；无持久员工实体、无「待命」实例态。
3. **并发 ≠ 角色限制**：共享池容量只表示系统同时能跑多少工单，不构成任何角色的名额；同角色并发与否由任务量与容量决定。
4. **不预设空槽**：五角色分组始终可见，空角色显示「当前无任务」，不画空槽、不虚构「某某待命中」。
5. **桌助 = 协调入口**：无 standing 写权、永不进员工槽、单跳派工、传话 ≠ 代批。
6. **实例权限 = 任务精确授权 ∩ 角色能力 ∩ 资源边界**；红线（发布/硬删/平台副作用）对一切实例不可达。
7. **intent 由角色注册表唯一派生**：spawn 输入不含外部 `intent`（WMB-5116 Owner lock #2 延续）。
8. **终态退出不删历史**：实例退出活动视图后，记录仍从持久面（agent_tasks / context_refs_json / 会话文件 / 审计）可重建、可指认。
9. **实例与 agent_task 非 1:1**：scan→judge 可复用同一 agent_task（rebind）；同一任务同一时刻只归属一个活动实例，活动视图不双计。

---

## 4. 信息架构

```
智能体（班组）页 —— 一级导航（实例驱动的活动视图）
 ├─ 页头 · 班组总览
 │    全局摘要行：工作中 N · 排队 M · 等你批 K（等你批 = 活动面 needs_user 实例；全部来自投影 API，可点过滤）
 ├─ 主体 · 按角色分组的在办实例
 │    记者（分组头始终可见；无实例时组内显示「当前无任务」，不画空槽）
 │    ├─ 实例卡 #2：名牌 + 任务一句话 + 状态词/状态点 + 进度（N/M）+ 开始时间
 │     │    动作：查看详情｜传话（桌助代传）｜取消（running/排队/等资源）｜处理（needs_user：续派/关闭）
 │    ├─ 实例卡 #3：…（同角色可多张，横向/纵向不封顶，受池容量自然约束）
 │    策划 | 写手 | 资料员（同构）
 │    └─ 桌助：唯一常驻协调入口卡（对话入口，非实例——见 §10）
 ├─ 历史（可折叠，从持久面投影）
 │    每角色最近 N 条终态实例：状态 + 一句话结果 + 时间；点击续派/查看会话
 └─ 页脚 · 配置入口：设置·角色管理（跳转链接，本页不渲染配置控件）
```

- **五角色分组始终可见**：某角色当前无任何实例时，组内显示「当前无任务」一行，不画空槽（Owner 确认第 10 点）；页头摘要 `工作中 0 · 排队 0` 为总量空态。共享 agent_task 的进度/等你批 投影只归属当前活动实例（§7.1），不双计。
- 今日值班条：≤1 行知情投影（谁在干什么 / 卡在哪 / 要不要你拍板），点击「查看全部」→ 智能体页；沿用双编码状态点与「无 action 不上条」规则。
- Dock：收件人钉死桌助（manager-as-primary-agent Owner lock #1）；员工实例不可直呼——点实例名牌 = 问桌助或跳智能体页。
- 科室页（发现/选题/创作/资料库）：只投影该角色实例的活动状态，不复制班组页全量列表。
- 设置·角色管理：配置面（Skill/模型预设/启停/权限摘要）；与活动视图彻底分离（一页一事）。

---

## 5. 实例生命周期

```
spawn(RoleJobRequest) ──> 派生 RoleJobSpec ──> 入池（实例创建，身份 = jobId + roleId）
   │
   ├─ queued ────────────────────────┐
   ├─ waiting_resource（锁冲突/lease 忙/judge in flight）──┤
   ├─ running（lease → agent_task → grant → 角色策略 → Pi 会话 → 业务阶段）──┤
   │                                                                      │
   └─ 终态（取消优先）：succeeded | partial | needs_user | failed | cancelled
       1. agent_task 终态（lease 仍绑定任务时先写；scan→judge 复用场景 job 终态可先于 agent_task 终态）
       2. 释放 grant（agent_task 终态幂等 revoke，R3 协议；cancel 不显式 revoke，WMB-5120）→ lease → 实体锁
       3. pool 终态 + RoleJobReportV1 + JOB_EVENT 呈报桌助
       4. 退出活动视图（needs_user 停留「等你批」直至用户处理/关闭，不占并发/lease/grant/锁）；记录入历史面
```

生命周期规则：

1. **创建 = 入池**：spawn 通过校验即创建实例；queued / waiting_resource / running 三态在活动视图可见，终态 needs_user 亦停留活动视图（§3.1）。
2. **身份不可变**：`jobId` 是实例一等身份；roleId、intent、资源键在派生后不可改写。
3. **终态顺序固定**：先 agent_task 终态、再释放 grant/lease/锁、最后 pool 终态与通知（防 lease stale 与晋升竞态；WMB-5116 §6 step 7 顺序延续）。**例外：scan→judge 复用同一 agent_task 时，实例终态可先于 agent_task 终态**——agent_task 交接续实例（judge）rebind，实例不等待其终态（WMB-5120 §7.2）。
4. **退出 ≠ 删除**：终态实例退出活动视图（needs_user 停留至人工闭环），其会话文件、agent_task 行、context_refs_json、审计流水全部保留；历史面可重建（§7）。
5. **同角色多实例无冲突**：同一角色同时存在的多个实例互不共享上下文、互不共享会话文件；是否真正并行由共享池容量与实体锁裁决（§9）。
6. **实例不继承其他实例状态**：每实例独立读取业务对象（revision 语义保护并发写），无「老员工记得上次」的隐式记忆——记忆只能来自持久业务对象。

---

## 6. 任务数据流：派发 / 排队 / 取消 / 失败 / needs_user

### 6.1 派发（dispatch）

```
人（UI 派工/今日命令）或桌助（wmb_spawn_job / jobs.spawn）
   → { roleId, brief, businessDate?, channelIds?/sourceIds?/projectId?/scope? }   // 无 intent
   → JobSpawner：派生 RoleJobSpec（intent / 实体锁 / 策略 / 读回规则）
   → JobPool（FIFO）→ 容量可用 → GenericEmployeeRunner：
       实体锁 → employee lease → dispatchStartAgentTask → 绑定 → 角色 grant
       → 角色策略（scan/judge/draft/organize）→ Pi 会话 → 业务阶段领域原语
       → 业务读回（scan_phase_reached / plans_revision / content_version / sources_mutated / noop_confirmed）
       → JobExecutionOutcome → 终态映射 → RoleJobReportV1 → JOB_EVENT（桌助收到并呈报）
```

- 人批准与最终决策始终在 Today/Proposals 决策面，不在聊天内假装完成（manager-as-primary-agent Owner lock #3）。
- 同一 ManagerTask 内的接力（扫完 → 派策划）由桌助主循环执行，**员工实例绝不自动转派**（§10）。

### 6.2 排队（queue）

- 纯 FIFO；资源不可用不落失败，进入 `waiting_resource` 车道（锁冲突 `RESOURCE_LOCK_CONFLICT` / lease 忙 `RESOURCE_LEASE_BUSY` / judge 在跑 `RESOURCE_JUDGE_IN_FLIGHT`）。
- waiting_resource **不占槽位**、可取消、可读、可传话；资源释放事件 + 60s 看门狗重扫晋升（WMB-5116 §8.2 / WMB-5117 §5.4 延续）。

### 6.3 取消（cancel）

| 状态 | 动作 | 终态 |
| --- | --- | --- |
| queued / waiting_resource | 直接终态化 | `cancelled`（不建任务、不占租约） |
| running | abort → 停 Pi（≤2s，stoppable 注册协议）→ 取消 agent_task → 释放 lease/锁 → pool 终态；grant 由 agent_task 终态钩子统一回收，cancel 路径不显式 revoke（WMB-5120） | `cancelled`（agent_task 同步 cancelled） |

- **取消优先于一切 outcome**：`signal.aborted` 置位后任何路径不得落 succeeded/failed/partial/needs_user（WMB-5116 §5.3）。
- 取消幂等：重复 cancel 返回当前终态；取消总门 ≤5s（WMB-5117 R2 协议）。

### 6.4 失败（failure）

- 终态携带稳定 `code`（`JOB_READBACK_MISSING`、`PI_START_FAILED`、`MCP_UNAVAILABLE` 等）+ 人类可读 `message`；`JobRecord.error` 与 `agent_task.errorCode` 同源。
- **成功必须业务读回**：无读回证据不得 succeeded；缺读回落 `failed(JOB_READBACK_MISSING)`——表达「员工完成了但业务产物缺失」，桌助据此续派。
- **保守失败，不放宽**：读回证据不充分时宁可 failed，不做伪成功（WMB-5121 no-op 协议同理：伪造围栏最多得到 no-op，永远得不到 mutation）。

### 6.5 needs_user（需人介入）

- 终态 `needs_user` + 稳定 `code` +（部分）读回证据；例如策划判定遇到跨域材料需人定夺、写手缺素材需人补料。
- 数据流：runner 产出 → 终态 → JOB_EVENT → 桌助向人呈报「需要你 X」→ 人动作后桌助续派或关闭；**不视为 failed，不自动重试**。实例卡停留活动视图「等你批」直至用户处理/关闭，期间不占并发、不持 lease/grant/锁（§5）。

---

## 7. 编号与历史策略

1. **实例一等身份 = `jobId`**（池内唯一；job 与实例同实体，入池即创建、终态即退出——needs_user 停留除外）。跨面指认以 jobId 为锚、roleId 定角色归属；taskId 在实例与任务 1:1 时参与指认。**共享归属规则**：scan→judge 复用同一 agent_task 时（实例与任务非 1:1），同一任务同一时刻只归属一个活动实例（归接续实例 judge），活动视图进度/等你批 投影只计当前活动实例，历史按 jobId 行去重，不双计。永不依赖显示名。
2. **显示编号**：每角色活动期序数，如「记者 #2」（可附业务日期 08-08）。**编号仅活动期显示**（Owner 确认第 11 点）：退出活动视图即不再以编号指认；纯显示用，同角色同秒多实例靠 `#N` 区分；序数不进入任何契约/存储，重启后新活动期重新计数，持久身份仍 jobId（§15 风险 5）。
3. **历史分层**：
   - **内存面**：JobPool 记录（含 `report`），随进程生命周期（既有锁定：JobPool 不整体持久化）；
   - **持久面**：`agent_tasks`（任务终态/errorCode/phase）+ **`context_refs_json`（spawn 合同：jobId/roleId/brief/边界参数，Owner 确认第 13 点）** + `job-<jobId>.jsonl` 会话文件 + `command_receipts`/审计流水 + task_grants（终态 revoke 留痕）；
   - **投影规则**：UI 的「历史/最近流水」只从持久面重建，不依赖内存池；实例退出活动视图后，历史仍可指认、可一键续派——续派参数 = 从 context_refs_json 重建原 RoleJobRequest（jobId/roleId/brief/边界参数）+ 结果摘要。
4. **会话文件命名 `job-<jobId>.jsonl` 保留**：天然支持多实例隔离与续跑 baseline；同角色多实例会话互不混流。
5. **历史保留策略**：默认保留 agent_tasks 既有语义（interrupted 续跑）+ 会话文件随项目数据；不做新表、不做归档流水线（本设计不新增持久化）。

---

## 8. 权限模型

```
effectiveWrite(instance) =
      GrantScope(task)                       // 任务精确授权（派生 intent 的既有 scope）
    ∩ commandsOf(enabledCaps(role))          // 角色能力投影（注册表 + 覆盖表）
    ∩ PreciseGate(side-effect?)              // 平台副作用 → 仅 Precise + Owner UI
    ∩ 资源边界                               // 该任务对象键：businessDate / projectId /
                                            //   sourceIds / scope（锁键即对象边界）
```

1. **实例权限 = 任务精确授权 ∩ 角色能力 ∩ 资源边界**（Owner 确认第 7 点）。资源边界由 `RoleJobSpec.resourceLocks` 承载：锁键是什么，写权对象就是什么；越界即拦截。**对象级硬隔离（施工必需，Owner 确认第 12 点）**：dispatcher 在签发/执行路径校验工单对象边界（businessDate / projectId / sourceIds / scope），跨对象写请求拒绝（BLOCKED + 审计流水）；grant 存在性与 expected_revision 不构成边界防线（§12.2.7 / §14 A9）。
2. **角色 ≠ 权限，prompt/Skill ≠ 权限**：roleId 只由 UI 派工或 runner 绑定；envelope 兜底断言（canonical §4.2 延续）。Skill 文本零权限。
3. **桌助**：`pageScopePassThrough`（页级透传，显式注册表声明），**无 standing 写权**；桌助工具（roster/jobs/message）走 MCP 编排面，不塞进业务命令表（manager-orchestration §4）。
4. **红线不变**：最终平台发布点击、硬删（`deleteKnowledgeSource`）、平台副作用（`x_lists.operation_execute`、`proposal_apply`）= `agentGrantable:false`，对一切角色、一切实例、一切 grant 组合不可达；发布准备仍走 Precise + Owner UI。
5. **实例不叠加权限**：多实例并行不产生「角色能力并集放大」——每实例独立签发、独立校验，实例间不共享 grant。

---

## 9. 并发与资源等待

### 9.1 共享并发池 = 纯系统容量

- `maxWorkers`（0..7，0=停用派工，默认 2）是**全角色共用的并行工单数上限**，是容量旋钮：加并行 = 调容量，**绝不改角色表、不改注册表、不改任何角色绑定**；0 时 spawn 拒绝（派工停用）。
- **并发 ≠ 角色限制**：同角色可占多个槽（两个记者扫不同渠道），不同角色共享同一容量（记者+写手+资料员同日并行）。容量只约束「同时跑多少」，不约束「谁跑」。

### 9.2 实体锁矩阵（对象边界 = 并发裁决）

| 资源 | reporter | planner | writer | librarian |
| --- | --- | --- | --- | --- |
| 槽位（共享池） | ✓ | ✓ | ✓ | ✓ |
| `scan:<ws>:<date>:<channel>` | ✓ | — | — | — |
| `plan:<ws>:<date>` | — | ✓ | — | — |
| `project:<ws>:<projectId>` | — | — | ✓ | — |
| `library-maintenance:<ws>` | — | — | — | ✓ |

- reporter 与 planner **不共享 planDate 锁**（WMB-5116 Owner lock #3）；阶段先后由 readiness/显式依赖控制。
- 锁冲突 → `waiting_resource(RESOURCE_LOCK_CONFLICT)`，不落失败、不 requeue 黑客（WMB-5116 §8）。

### 9.3 waiting_resource

- 车道状态：不占槽、可取消、可读、可传话；`waitReason`/`waitingSince` 写入记录。
- 晋升：资源释放事件触发重扫 + 60s 看门狗兜底；parked 工单按 `queuedAt` 相对公平竞争。
- **同角色多实例在 waiting_resource 中并排可见**（如第二张记者单等第一个记者释放渠道键）——这是「同角色多实例显式可见」在等待态的合法表达。

### 9.4 并发安全

- 业务写仍走 CommandDispatcher + 实体锁 + `expected_revision`（REVISION_CONFLICT 语义不变）；活跃运行串行化业务写，有界读可并行。
- 并发 grant 竞态：`dispatchIssueTaskGrant` active 单张校验 + 终态 revoke 协议（WMB-5120）——实例终态后旧证不可写。

---

## 10. 桌助 / Pi 会话边界

| 维度 | 桌助（desk） | 员工实例（reporter/planner/writer/librarian） |
| --- | --- | --- |
| 本质 | 协调入口（唯一常驻对话面） | 按任务的执行单元（subagent） |
| 创建 | 随应用存在（dock 默认收件人） | 按 spawn 创建，终态退出活动视图 |
| 会话 | 主 Pi 会话（交互式） | `job-<jobId>.jsonl` 独立会话，dock 不可直呼 |
| 写权 | 无 standing；页 scope 透传 | 任务精确授权 ∩ 角色能力 ∩ 资源边界 |
| 槽位 | 永不进 JobPool 员工槽 | 占共享池槽位 |
| 职责 | 接单、拆解、单跳派工、盯梢、传话、呈报 | 执行有界工单、业务读回、终态报告 |
| 决策 | 不代批（批准在 Today/Proposals UI） | 不决策选题、不自动转派 |

硬边界：

1. **桌助是协调入口，不是主管工位**：主管工位 = 主编（人）。桌助无 standing 写权、永不进员工槽、`spawn(roleId:'desk')` 被拒（`ROLE_NOT_SPAWNABLE`）、传话 ≠ 代批。
2. **单跳有界**：桌助一次只给一个员工一张有界单；接力（扫完 → 派策划）由桌助主循环执行，员工实例之间不互聊、不转派。
3. **会话不混流**：员工会话内容不进入 dock 转录；每实例独立上下文；实例间无隐式记忆（§5.6）。
4. **同一事实源**：桌助对进度/状态的回答只来自投影 API（roster/jobs/task），禁止编造。

---

## 11. UI 状态与文案

### 11.1 实例状态词（活动视图）

| 状态 | 状态词 | 状态点 | 含义 |
| --- | --- | --- | --- |
| queued | 排队中 | 灰 | 在池中等待容量 |
| waiting_resource | 等资源 | 灰（带 reason 文案） | 锁/lease/judge 占用，不占槽 |
| running | 工作中 | 琥珀（无脉冲） | 正在执行，附进度 N/M |
| needs_user | 等你批 | 蓝 | 终态，停留活动视图直至用户处理/关闭；不占并发、不持 lease/grant/锁 |
| succeeded / partial | 已完成 / 部分完成 | 绿 | 终态，退出活动视图 |
| failed / cancelled | 失败 / 已取消 | 红 / 灰 | 终态，退出活动视图 |

- **无「待命」实例态**：实例不常驻；角色无实例时该分组显示「当前无任务」一行，不画空槽（§3.2 不变量 2/4；Owner 确认第 10 点）。页头摘要「工作中 0 · 排队 0」为总量空态，空角色分组文案统一为「当前无任务」，无双轨空态。needs_user 停留活动视图；其余终态立即退出（§5）。
- 状态点颜色 + 文字双编码（WCAG AA）；等待原因（如「等策划判定结束」）必须可读，禁止裸「等资源」。

### 11.2 文案模板

- 一律回答四件事：**谁（角色 + 实例号）+ 在干什么（任务一句话）+ 卡在哪（等待原因/失败 code）+ 你能做什么（等/催/批/派/取消）**。
- 禁止：编造完成时间、猜测性进度、把 waiting_resource 说成失败、把「无实例」说成「某某待命中」。
- 失败/拦截文案以可操作指引收尾（五类拦截原因分类呈现，canonical §4.6）；权限拦截是异常，默认正确。
- 值班条 ≤1 行、无 action 不上条；实例卡默认折叠、展开看工具行/关键日志（沿用 pi-tool-line 视觉语言），禁止默认展开成长日志墙。

---

## 12. 兼容 / 迁移原则

### 12.1 设计落档（2026-08-08 完成）

- 2026-08-08 本方向已升级为**正式施工 Owner lock** 并落档为产品规范：PRODUCT C9、PRD §2.4（REQ-028/REQ-029、AC-024..AC-027）、SPEC §1.0 不变量 8/9 与 CAP-027（EVAL-030）、PLAN M-5140。
- 施工期原则（schema 零改动、registry 预期零改动、不新增通用角色/云/平台 API、干净切换、desk 零回归、UI 单源、对象级硬隔离为施工必需）见 §12.2；**施工许可仍由 TASKS doing 唯一授予**——本文件不直接授权代码变更，任何施工须另行任务合同并进入 TASKS doing（§17）。

### 12.2 施工期原则（未来任务合同时生效）

1. **schema 零改动**：`agent_tasks` / `task_grants` / `execution_grants` 结构不动；JobPool 保持内存态（不新增工单持久化表）。**spawn 合同写入既有 `context_refs_json` 列**（jobId/roleId/brief/边界参数，Owner 确认第 13 点），不新增表、不新增列。
2. **Capability registry 预期零改动**：`src/shared/agent-capabilities.ts` / `page-authority.ts` 不改；施工必须跑 `npm run check:capabilities`（G1）+ effective grant 一致性（G2），失败即构建失败。
3. **不新增通用角色 / 云 / 平台 API**：本方向任何施工不得引入 generic worker、云端编排、平台官方 API。
4. **干净切换**：从「角色固定面」投影迁移到「实例驱动面」投影，同一投影 API 同时驱动强制与显示；无 shim、无双轨（WMB-5116 §11 延续）。
5. **desk 零回归**：默认桌助下的既有 dock 用例（today/library/studio/publish）行为不变。
6. **UI 单源**：任何「谁在干什么/谁有什么权」的显示只来自投影 API（roster / role-permission-summary），禁止 UI 第二份手写标签（canonical §6.4）。
7. **对象级硬隔离为施工必需**（Owner 确认第 12 点）：dispatcher 必须校验工单对象边界（businessDate / projectId / sourceIds / scope），跨对象写请求拒绝（BLOCKED + 审计流水）；运行层新增强制点，不产生新能力、不改三表 schema（§8.1 / §14 A9）。

---

## 13. 错误处理

| 场景 | 行为 |
| --- | --- |
| 资源不可用（锁/lease/judge） | `waiting_resource`，非错误；reason + 晋升事件 + 看门狗 |
| 读回缺失 | `failed(JOB_READBACK_MISSING)`，保守失败；桌助可续派 |
| Pi 启动失败 / MCP 不可用 | `failed` + 稳定 code + 可操作 message |
| 取消与 outcome 并发 | 取消优先；任何路径不得落其余四态（§6.3） |
| 权限/对象越界（实例） | 五类拦截原因（ROLE/PAGE/PRECISE/GRANT/READ）+ 对象边界拦截（跨对象写拒绝，§8.1）+ chip + BLOCKED + toast；审计流水 |
| 重复取消 / 重复回收 | 幂等：返回当前终态 / 第二次 revoke data=[] |
| 终态后旧证写入 | `TASK_NOT_ACTIVE` / `WORKER_LEASE_STALE` / `TASK_GRANT_REVOKED` 三层拒绝 |
| 并发写冲突 | `REVISION_CONFLICT`（expected_revision 语义不变） |

原则：**可重试 ≠ 自动重试**（needs_user 不自动重跑）；**可解释 ≠ 可编造**（错误只报已知事实）；**保守失败优于伪成功**。

---

## 14. 验收场景（可证伪）

| # | 场景 | 可证伪结果 |
| --- | --- | --- |
| A1 | 同角色多实例显式可见 | 派两张不同渠道的记者单（容量允许）→ 智能体页同时渲染「记者 #1」「记者 #2」两张实例卡，各自进度独立 |
| A2 | 实例按任务创建 | 无 spawn 时智能体页主体零实例卡，五角色分组头始终可见且各显示「当前无任务」；spawn 后实例卡出现 |
| A3 | 终态退出活动视图 | 实例 succeeded/failed/cancelled 后该卡立即退出活动视图进入历史面；needs_user 停留「等你批」直至用户处理/关闭后退出。历史可指认（jobId + 结果）；scan→judge 复用同一 agent_task 时，reporter 终态退出、judge 接管进度显示，同一任务不双计 |
| A4 | 不预设空槽 | 全空状态下无「待命」/占位坐席文案，五角色分组各显示「当前无任务」；页头摘要显示 工作中 0 · 排队 0 |
| A5 | 并发 = 系统容量 | `maxWorkers=2` 时 3 张跨角色工单 → 2 running + 1 queued；释放后 FIFO 晋升；同角色两实例可同时 running；`maxWorkers=0` 时 spawn 拒绝（派工停用） |
| A6 | 并发 ≠ 角色配额 | 容量 2 时两个记者实例可并行占满 2 槽；调 `maxWorkers=4` 无需改任何角色/注册表 |
| A7 | 桌助非主管工位 | desk 无 standing 写权；`spawn(roleId:'desk')` 被拒；桌助工具只读/编排，无 `plans.save`/`content.*` |
| A8 | 实例权限交集 | 写手实例可只读借阅资料库但无组织命令；资料员实例无 `plans.save`/`content.*`/`reviews.save`；越界 → 对应拦截原因 |
| A9 | 资源边界（对象级硬隔离） | 写手实例只能写其 projectId 对象；对另一项目写 → dispatcher 对象级拦截（BLOCKED）；同项目第二张单 → waiting_resource |
| A10 | 红线不变 | 发布执行/硬删/平台副作用命令对任何实例、任何 grant 组合不可达；`agentGrantable:false` 能力不出现在任何覆盖面 |
| A11 | needs_user 数据流 | 策划实例返回 needs_user + code + 部分读回 → 桌助呈报「需要你 X」→ 人动作后桌助续派或关闭；不自动重试；卡停留活动视图「等你批」直至闭环 |
| A12 | 取消 ≤5s | running 中取消 → Pi 进程树终止、agent_task cancelled、lease 归零、pool cancelled，总门 ≤5s；重复取消幂等 |
| A13 | 历史可重建与一键续派 | 实例退出后重启应用（池清空）→ 该实例从 context_refs_json（jobId/roleId/brief/边界参数）+ agent_tasks/会话文件/审计完整指认，一键续派（重建 RoleJobRequest） |
| A14 | 兼容零改动 | 施工变更集不触碰三张表 schema、不新增能力、不新增角色；`check:capabilities` + 类型检查通过 |

---

## 15. 风险

| # | 风险 | 对策 |
| --- | --- | --- |
| 1 | **槽位思维回潮**：实现时把角色区渲染成固定席位，空角色显示「待命」 | 不变量 2/4 + A4 验收；分组始终可见但空角色只显示「当前无任务」，不画空槽、不虚构「待命」 |
| 2 | **实例膨胀**：工单随手派 → 活动视图堆满实例卡 | 共享容量天然限流；ManagerTask 聚合（对话内看编排，不逐卡刷屏）；历史面收纳终态 |
| 3 | **桌助漂移成主管座**：编排工具顺手放大 desk 写权 | 不变量 5 + A7；desk 工具只编排不写业务；批准始终在 Today/Proposals UI |
| 4 | **并发被读成配额**：产品/文档把 maxWorkers 描述成「每角色 N 个」 | 本文件 §3.2/§9.1 是权威表述；UI 文案与投影只显示容量摘要，不显示「角色名额」 |
| 5 | **实例身份漂移**：显示序数与持久身份混用（跨重启引用「记者 #2」） | §7：一等身份 = jobId；编号仅活动期显示、重启后重新计数；契约与存储只用 jobId |
| 6 | **历史丢失**：池内存态清空后 UI 无历史可看 | §7.3 投影规则：历史只从持久面重建（context_refs_json 持久合同）；A13 验收 |
| 7 | **registry/权限漂移**：施工顺手改能力或放大 grant | §12.2 一致性检查即构建失败；红线负断言 |
| 8 | **编排回潮**：实例间自动转派/多跳 | 不变量 7 + §10 硬边界；员工无编排工具 |
| 9 | **假成功回潮**：读回放宽 | 保守失败协议（§6.4/§13）；no-op 严格围栏协议（WMB-5121）延续 |
| 10 | **对象级边界漏检**：dispatcher 只校验 grant 存在/状态而漏对象键比对 → 跨对象写可越权 | §8.1/§12.2.7 列为施工必需强制点；A9 负断言验收 |

---

## 16. Capability registry 与 Pi operator Skill 影响

### 16.1 Capability registry（`agent-capabilities.ts` / `page-authority.ts`）

- **预期零改动（Capability 面）**：多实例是运行层与投影层语义，不产生新写能力、不改默认角色绑定、不改页 scope。**运行层例外**：dispatcher 新增对象级边界校验（Owner 确认第 12 点，§12.2.7）——强制点新增，不产生新能力、不改 schema；`check:capabilities` 仍须通过。
- 施工验收强制：G1 `npm run check:capabilities` + G2 effective grant 一致性（librarian 等四角色排除清单 `plans.save`/`content.*`/`reviews.save`/硬删/发布不可达）；任一失败即构建失败（WMB-5116 §13 延续）。
- **不新增能力、不新增角色**：多实例不需要「实例管理」「协作者」类新能力。

### 16.2 Pi operator Skill（`pi-operator-skill.ts` + `skills/wemedia-buddy-operator/SKILL.md`）

- **行为契约文本**（施工期按 `docs/pi-operation-skill-maintenance.md` 规程逐条登记）：
  1. intent 由系统按角色自动派生（删除外部 intent 字样，WMB-5116 §10.2 已锁定）；
  2. librarian no-op 末条围栏 `{"wmb_noop":true}` 协议（WMB-5121 已锁定）；
  3. **多实例感知**：提示词明确「同一角色可能同时有多个工单实例；你只对当前 job 的上下文负责，不引用其他实例会话、不假设自己是唯一在岗员工」——防实例串扰。
- **不新增 Skill**：现有角色 Skill 面不动；多实例不需要新技能文件。

---

## 17. Owner confirmation block

**本块记录 Owner 2026-08-08 显式 UI 选择确认、同日追加五项选择与独立复审确认的班组协同方向，并已升级为正式施工 Owner lock：本文件是班组多实例方向的唯一设计真源；TASKS doing 仍是唯一施工许可——本文件不替代任务合同、不直接授权代码施工；任何施工须另行任务合同（显式引用 §12 兼容原则与 §16 影响面，并带自己的施工 Owner lock）并经 TASKS doing 授权。**

| # | 确认点 | 落点 |
| --- | --- | --- |
| 1 | **固定五角色**：桌助/记者/策划（兼复盘）/写手/资料员，跨赛道稳定 | §0.1、§3.1、PRODUCT C8/C9.1、PRD §2.3/§2.4、SPEC CAP-027.1 |
| 2 | **同角色多实例显式可见**：同角色可同时多实例，活动视图逐实例呈现 | §4、§5.5、§14 A1、PRODUCT C9.1、PRD §2.4.2、SPEC CAP-027.1/EVAL-030 |
| 3 | **实例按任务创建，任务结束后退出活动视图**（needs_user 停留例外见 #9） | §5、§14 A2/A3、PRODUCT C9.2/C9.3、PRD §2.4.3、SPEC CAP-027.2 |
| 4 | **不预设空槽**：活动视图无实例即无渲染（空态呈现细化见 #10） | §4、§11.1、§14 A4、PRODUCT C9.4、PRD §2.4.1、SPEC CAP-027.3 |
| 5 | **共享并发池仅作为系统容量**：maxWorkers（0..7，0=停用派工）是容量，不是角色配额 | §9.1、§14 A5/A6、PRODUCT C9.5、PRD §2.4.5、SPEC CAP-027.5 |
| 6 | **桌助是协调入口，不是主管工位**：主管 = 人；桌助无 standing 写权、不进员工槽、不代批 | §10、§14 A7、PRODUCT C9.6、PRD §2.4.6、SPEC CAP-027.6 |
| 7 | **实例权限 = 任务精确授权 ∩ 角色能力 ∩ 资源边界**（对象级硬隔离见 #12） | §8、§14 A8/A9、PRODUCT C9.7、PRD §2.4.7、SPEC CAP-027.7 |
| 8 | **发布/硬删红线不变**：最终发布点击与硬删仅人类 UI；平台副作用仅 Precise + Owner UI | §8.4、§14 A10、PRODUCT C9.8、SPEC CAP-027.7 |
| 9 | **needs_user 停留活动区**：终态 needs_user 卡留在活动视图「等你批」，直至用户处理/关闭；期间不占并发、不持 lease/grant/锁 | §3.1、§5、§6.5、§11.1、§14 A3/A11、PRODUCT C9.3、PRD §2.4.4、SPEC CAP-027.4 |
| 10 | **空态呈现（细化 #4）**：五角色分组始终可见；空角色显示「当前无任务」，不画空槽 | §0.3、§3.2、§4、§11.1、§14 A2/A4、PRODUCT C9.4、PRD §2.4.1、SPEC CAP-027.3 |
| 11 | **角色编号仅活动期显示**：实例显示「记者1/记者2」角色编号，退出活动视图即不再以编号指认；持久身份仍 jobId | §7.2、§14 A1、PRODUCT C9.9、PRD §2.4.2、SPEC CAP-027.3 |
| 12 | **对象级硬隔离（施工必需）**：dispatcher 必须校验工单对象边界，跨对象写请求拒绝 | §8.1、§12.2.7、§14 A9、PRODUCT C9.7、PRD §2.4.7/REQ-029、SPEC CAP-027.7 |
| 13 | **持久续派合同**：jobId/roleId/brief/边界参数写入既有 context_refs_json，重启后完整指认与一键续派，不新增表 | §7.3、§12.2.1、§14 A13、PRODUCT C9.10、PRD §2.4.8/REQ-029、SPEC CAP-027.8 |

配套纪律（随本确认生效）：

- 本方向任何变更须回到本文件评审；「槽位化/常驻员工/配额化」实现视为设计违规（§15.1/15.4）。
- 不要求新增通用角色、不引入云服务、不新增平台 API；违反即回到 §2.2 复审。
- 施工授权边界：未来任务合同须显式引用本文件 §12 兼容原则与 §16 影响面，并带自己的施工 Owner lock。
- 独立复审确认（随本确认生效）：`maxWorkers` 合法域 0..7（0=停用派工，默认 2，§9.1）；scan→judge 可复用同一 agent_task，实例与 agent_task 非 1:1（§5/§7.1 归属规则）；cancel 不显式 revoke grant，grant 由 agent_task 终态钩子统一回收（WMB-5120，§6.3）。
