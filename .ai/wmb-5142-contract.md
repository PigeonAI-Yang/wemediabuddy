# WMB-5142 Contract

## Route
Design

## Goal
落实设计 §5/§6.4/§7 的实例运行投影：实例一等身份 jobId + 不可变 roleId、活动期显示编号、固定终态顺序（agent_task 终态 → grant 回收 → lease/锁释放 → pool 终态）、scan→judge 单活动实例不双计、历史只从持久面重建（context_refs_json 锚点 + agent_tasks/会话文件/审计），不依赖内存池。

## Problem / Root cause
设计 §1.1 P2/P5（实例语义缺失：任务与执行单元不分，实例没有一等身份，历史散在 agent_tasks/会话文件/审计）。现状 JobPool 仅内存态记录、UI 无「同角色多实例」表达，终态顺序与 scan→judge 复用（实例与 agent_task 非 1:1）存在双计风险。运行投影是 5141 持久合同之上的一等身份语义层；实施前以最新源码复核投影/终态落点。

## References
- 设计真源（正式施工 Owner lock）: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` — §12 兼容/迁移原则（§12.2.4 干净切换、§12.2.5 desk 零回归、§12.2.6 UI 单源）、§16 影响面（§16.1 registry 预期零改动）、§17 Owner lock（TASKS doing 仍是唯一施工许可）
- PRODUCT C9（C9.2 实例按任务创建、C9.9 角色编号仅活动期显示、C9.10 持久续派合同）
- PRD §2.4 REQ-028（实例一等身份 = jobId，角色编号仅活动期显示）、REQ-029（共享容量与实例授权边界）、AC-024..AC-027
- SPEC §1.0 不变量 8/9、CAP-027（实例生命周期、终态顺序、scan→judge 归属）、EVAL-030
- PLAN M-5140（任务分解与 Gate：WMB-5142 为运行投影）

## Scope
1. 实例投影模型：一等身份 `jobId` + 不可变 `roleId`；活动期显示编号（「记者 #N」）纯显示，不进入任何契约/存储，重启后新活动期重新计数。
2. 终态顺序执行与呈现：agent_task 终态 → grant 回收（agent_task 终态钩子幂等 revoke；cancel 不显式 revoke，WMB-5120）→ lease/实体锁释放 → pool 终态 + JOB_EVENT；scan→judge 复用同一 agent_task 时实例终态可先于 agent_task（交接续实例 rebind），同一任务同一时刻只归属一个活动实例（活动视图不双计）。
3. 历史投影：只从持久面重建（context_refs_json 为锚 + agent_tasks/会话文件/审计），不依赖内存池；实例退出活动视图后仍可指认、可续派。

## Acceptance
- [ ] 实例一等身份：投影记录以 jobId 唯一标识、roleId 不可变；活动期编号（记者 #N）纯显示（focused 单测断言编号不进契约/存储、重启后重新计数）
- [ ] 终态顺序（四角色）：agent_task 终态 → grant 回收 → lease/实体锁释放 → pool 终态 + JOB_EVENT；扫描/判定角色不回归五态契约与取消优先（WMB-5116/5119 用例回归）
- [ ] scan→judge 单活动实例不双计：复用同一 agent_task 时 reporter 终态退出、judge 接管进度/等你批 投影，同一任务不双计（focused 测试 + 实机断言）
- [ ] 历史重建：池清空（重启）后从 context_refs_json + agent_tasks/会话文件/审计完整重建实例历史并可指认（jobId + 结果）；续派参数与 5141 合同一致，无自造第二份写源
- [ ] desk 零回归：默认桌助下既有 dock 用例（today/library/studio/publish）行为不变；值班条投影无 action 不上条
- [ ] 一致性门禁：`npm run check:capabilities`（G1）通过；`npm run typecheck` 0；focused 测试通过；跳过 formatter/lint/全量测试（项目级命令由主 Agent 统一执行）
- [ ] 证据收口：`.ai/wmb-5142-evidence.md` 完整；TASKS.md 行 done 回执（入账阶段，本合同不登记）

## Verification
- focused 测试：投影身份/活动期编号、终态顺序（四角色）、scan→judge 不双计、重启后历史重建（设计 §14 A1/A3/A13 的本任务切片）。
- 实机（隔离 data root）：重启后历史重建与续派指认可见；desk dock 回归。
- 一致性门禁：`npm run check:capabilities`（G1）+ `npm run typecheck`；轻量 intake/ledger 结构检查由主 Agent 统一执行。
- 证据文件：`.ai/wmb-5142-evidence.md`（未来实施阶段落盘；本 Design 只落合同，不创建证据）。

## Allowed paths
- `.ai/wmb-5142-contract.md`（本合同，本次唯一新建文件）
- `.ai/wmb-5142-evidence.md`（未来实施阶段证据文件；本次不创建）
- `TASKS.md`（未来入账用；本 Design 只落合同，不登记）
- 未来实施预期落点（本 Design 禁止触碰，列出以约束根因范围）：`src/main/job-pool.ts`、`src/main/role-roster.ts`、`src/main/manager-job-notify.ts`、`src/main/agent-tasks.ts`（终态顺序配合面）、投影 API 落点、`tests/` 对应聚焦测试

## Forbidden paths
- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`（能力注册表/权限，no change）
- `PRODUCT.md` / `PRD.md` / `SPEC.md` / `TECHNICAL_DESIGN.md` / `PLAN.md`（产品/技术合同已落档）
- 三表 schema 与迁移文件（结构零改动，无迁移）
- `skills/wemedia-buddy-operator/SKILL.md`、`src/main/pi-operator-skill.ts` 及 Pi 相关资产（Pi operator Skill no change）
- 真实 data root、依赖文件（package.json、package-lock.json、node_modules 等）、`TASKS.archive.md`
- 本合同之外任何文件（本次仅允许新建 `.ai/wmb-5142-contract.md`）

## Non-goals
- 不新增表/列/schema；不持久化 JobPool（池内工单保持内存态，恢复沿用 agent_tasks interrupted 语义）
- 不做智能体页 UI（WMB-5143 范围）；不新增能力/角色/命令
- 不改 desk 编排工具面、不引入员工自动多跳/编排图
- 不改发布/硬删红线与平台副作用边界
- 不改 Pi 提示词（Pi operator Skill no change，见 Capability registry impact）
- 本 Design 不登记 TASKS 行、不写实现代码；本合同仅为提案

## Capability registry impact
no change — 实例投影/终态顺序为运行层语义，不触碰 registry、不新增命令/角色；`check:capabilities`（G1）通过。
Pi operator Skill impact: no change — 无直接提示词变更（R1 等待原因/终态顺序为系统层事件语义非提示词语义）；5144 单独登记多实例感知提示词。

## Depends on
WMB-5141

## Design / lock
- Design: docs/spark/2026-08-08-agent-crew-multi-instance-design.md
- Owner lock 2026-08-08:
  1. 实例一等身份 = `jobId` + 不可变 `roleId`；活动期编号（「记者 #N」）纯显示，不进入任何契约/存储，重启后新活动期重新计数（§7.1/§7.2）。
  2. 终态顺序固定：agent_task 终态 → grant 回收（agent_task 终态钩子幂等 revoke；cancel 不显式 revoke，WMB-5120）→ lease/实体锁释放 → pool 终态 + JOB_EVENT；scan→judge 复用同一 agent_task 时实例终态可先于 agent_task（交接 rebind），同一任务同一时刻只归属一个活动实例，不双计（§5 规则 3/§7.1）。
  3. 历史只从持久面重建（context_refs_json 锚点 + agent_tasks/会话文件/审计），不依赖内存池；实例退出活动视图后仍可指认、可续派（§7.3）；JobPool 不整体持久化。
  4. 干净切换（§12.2.4）：同一投影 API 同时驱动强制与显示，无 shim、无双轨；desk 零回归（§12.2.5）。
  5. Capability registry no change：`check:capabilities`（G1）通过；红线不变。
  6. Non-goals: 不做 UI（5143 范围）；不新增表/列/schema/能力/角色/命令；不持久化 JobPool；不改 Pi 提示词。
  7. Route: Design.
  8. Design path: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md`.
