# WMB-5141 Contract

## Route
Design

## Goal
落实设计 §7.3/§12.2.1/§12.2.7 的持久续派合同与 dispatcher 对象级硬隔离：spawn 合同把 jobId/roleId/brief/边界参数（businessDate/projectId/sourceIds/scope）写入既有 `context_refs_json`（三表 schema 零改动），dispatcher 在签发/执行路径校验工单对象边界，跨对象写拒绝（BLOCKED + 审计流水），`check:capabilities`（G1）+ effective grant 一致性（G2）通过。

## Problem / Root cause
设计 §1.1 P5（实例无编号无历史：`context_refs_json` 未含 jobId/brief/边界参数，实例退出后无从指认与续派）与 §8.1/§12.2.7（对象级边界：grant 存在性与 `expected_revision` 不构成边界防线，dispatcher 缺对象键比对 → 跨对象写可越权，§15 风险 10）。现状 spawn 合同未落持久续派字段，dispatcher 未做对象键校验。实施前以最新源码复核上述落点。

## References
- 设计真源（正式施工 Owner lock）: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` — §12 兼容/迁移原则（§12.2.1 schema 零改动、§12.2.2 registry 零改动 + G1/G2、§12.2.7 对象级硬隔离为施工必需）、§16 影响面（§16.1 Capability registry 预期零改动、运行层强制点）、§17 Owner lock（TASKS doing 仍是唯一施工许可）
- PRODUCT C9（班组多实例不变量；C9.7 实例权限交集、C9.10 持久续派合同）
- PRD §2.4 REQ-028（角色≠槽位/实例/等你批）、REQ-029（共享容量与实例授权边界、对象级硬隔离）、AC-024..AC-027
- SPEC §1.0 不变量 8/9、CAP-027（Desk manager + multi-instance crew runtime；对象级硬隔离 + 持久续派合同）、EVAL-030
- PLAN M-5140（任务分解与 Gate：WMB-5141 为持久续派合同 + dispatcher 对象级硬隔离）

## Scope
1. 持久续派合同：spawn 合同写入既有 `context_refs_json` 列 = { jobId, roleId, brief, 边界参数(businessDate/projectId/sourceIds/scope) }；`agent_tasks`/`task_grants`/`execution_grants` 三表 schema 零改动（无迁移、无新表/列）。
2. dispatcher 对象级硬隔离（施工必需，§12.2.7）：签发/执行路径校验工单对象边界（businessDate/projectId/sourceIds/scope），跨对象写请求拒绝（BLOCKED + 审计流水）；运行层新增强制点，不产生新能力、不改三表 schema。
3. 一致性门禁：G1 `npm run check:capabilities` + G2 effective grant 一致性（librarian 等四角色排除清单 `plans.save`/`content.*`/`reviews.save`/硬删/发布不可达）；任一失败即构建失败。

## Acceptance
- [ ] 续派合同落地：spawn 的 job 在 agent_task 的 `context_refs_json` 中可读到 jobId/roleId/brief/边界参数四类字段（focused 单测断言字段与语义，fixture 覆盖四角色）；三表 schema 零改动（无迁移、无新表/列，以 schema/迁移面检查为证）
- [ ] 一键续派可重建：从 `context_refs_json` 重建原 RoleJobRequest（jobId/roleId/brief/边界参数）的 focused 测试通过
- [ ] 对象级硬隔离（负断言）：写手实例对另一 projectId 对象写 → dispatcher 拦截（BLOCKED + 审计流水）；同项目第二张单 → `waiting_resource(RESOURCE_LOCK_CONFLICT)` 不落 failed；grant 存在性/`expected_revision` 不单独构成边界防线
- [ ] 红线不变（负断言）：发布/硬删/平台副作用（`agentGrantable:false`）对任何实例、任何 grant 组合不可达；跨对象拦截不放开任何红线命令
- [ ] 一致性门禁：`npm run check:capabilities` 通过（capability registry no change 由该检查验证）+ effective grant 一致性 G2 通过
- [ ] `npm run typecheck` 0；focused 测试通过；跳过 formatter/lint/全量测试（项目级命令由主 Agent 统一执行）
- [ ] 证据收口：`.ai/wmb-5141-evidence.md` 完整（before/after、fixture 输出、门禁结果）；TASKS.md 行 done 回执（入账阶段，本合同不登记）

## Verification
- focused 测试：context_refs_json 续派合同、重建续派、跨对象写拦截负断言、红线负断言（设计 §14 A9/A10 的本任务切片）。
- 一致性门禁：`npm run check:capabilities`（G1）+ effective grant 一致性（G2）。
- `npm run typecheck` 0；轻量 intake/ledger 结构检查由主 Agent 统一执行。
- 证据文件：`.ai/wmb-5141-evidence.md`（未来实施阶段落盘；本 Design 只落合同，不创建证据）。

## Allowed paths
- `.ai/wmb-5141-contract.md`（本合同，本次唯一新建文件）
- `.ai/wmb-5141-evidence.md`（未来实施阶段证据文件；本次不创建）
- `TASKS.md`（未来入账用；本 Design 只落合同，不登记）
- 未来实施预期落点（本 Design 禁止触碰，列出以约束根因范围）：`src/main/job-spawner.ts`、`src/main/mcp-job-tools.ts`、`src/main/role-job-registry.ts`、`src/main/agent-tasks.ts`（context_refs_json 写入面）、`src/main/manager-dispatch.ts` 及 dispatcher 对象键校验落点、`tests/` 对应聚焦测试

## Forbidden paths
- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`（能力注册表/权限，no change；G1/G2 由检查验证）
- `PRODUCT.md` / `PRD.md` / `SPEC.md` / `TECHNICAL_DESIGN.md` / `PLAN.md`（产品/技术合同已落档）
- 三表 schema 与迁移文件（`agent_tasks`/`task_grants`/`execution_grants` 结构零改动，无迁移）
- `skills/wemedia-buddy-operator/SKILL.md`、`src/main/pi-operator-skill.ts` 及 Pi 相关资产（Pi operator Skill no change）
- 真实 data root、依赖文件（package.json、package-lock.json、node_modules 等）、`TASKS.archive.md`
- 本合同之外任何文件（本次仅允许新建 `.ai/wmb-5141-contract.md`）

## Non-goals
- 不新增表/列/schema；不新增能力/角色/命令/依赖
- 不做可配置权限 UI；不重做 dispatch 语义（仅新增对象键校验强制点，签发/执行路径不动红线）
- 不持久化 JobPool（池内工单保持内存态，恢复沿用 agent_tasks interrupted 语义）
- 不改发布/硬删红线与平台副作用边界
- 不改 Pi 提示词（Pi operator Skill no change，见 Capability registry impact）
- 本 Design 不登记 TASKS 行、不写实现代码；本合同仅为提案

## Capability registry impact
no change — dispatcher 对象级硬隔离为运行层新增强制点（设计 §12.2.7/§16.1：不产生新能力、不改 schema/角色绑定、不新增命令）；必须 `npm run check:capabilities`（G1）+ effective grant 一致性（G2）通过。
Pi operator Skill impact: no change — spawn 合同写入 `context_refs_json` 为系统侧持久化合同，无直接提示词变更；5144 单独登记多实例感知提示词。

## Depends on
WMB-5122（done；M-5110 JobPool 运行时与五态终态契约是本次基础）

## Design / lock
- Design: docs/spark/2026-08-08-agent-crew-multi-instance-design.md
- Owner lock 2026-08-08:
  1. 持久续派合同（§7.3/§12.2.1）：spawn 合同把 jobId/roleId/brief/边界参数（businessDate/projectId/sourceIds/scope）写入既有 `context_refs_json` 列；`agent_tasks`/`task_grants`/`execution_grants` 三表 schema 零改动，不新增表/列。
  2. dispatcher 对象级硬隔离（施工必需，§12.2.7）：签发/执行路径校验工单对象边界，跨对象写请求拒绝（BLOCKED + 审计流水）；运行层新增强制点，不产生新能力；grant 存在性与 `expected_revision` 不单独构成边界防线。
  3. Capability registry no change：`check:capabilities`（G1）+ effective grant 一致性（G2）必须通过；红线（发布/硬删/平台副作用，`agentGrantable:false`）对一切实例不可达。
  4. 干净切换：spawn 合同写入既有列，无 shim、无双轨、无迁移；JobPool 不整体持久化。
  5. Non-goals: 不新增表/列/schema/能力/角色/命令；不做可配置权限 UI；不重做 dispatch 语义；不改 Pi 提示词；不持久化 JobPool。
  6. Route: Design.
  7. Design path: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md`.
