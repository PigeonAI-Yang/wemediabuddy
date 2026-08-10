# WMB-5144 Contract

## Route
Design

## Goal
落实设计 §16.2 与 §10 的 Pi operator Skill 多实例感知与桌助呈报/续派路径：提示词明确「同一角色可能同时有多个工单实例；你只对当前 job 的上下文负责，不引用其他实例会话、不假设自己是唯一在岗员工」，按 `docs/pi-operation-skill-maintenance.md` 规程登记；桌助对进度/状态的回答只来自投影 API，续派参数从 context_refs_json 重建；不新增 Skill 文件、不新增命令。

## Problem / Root cause
设计 §1.1 P2（实例语义缺失）在提示词面的表现：员工提示词未感知多实例，可能引用其他实例会话或假设自己是唯一在岗员工（实例串扰，§16.2 行为契约 3）；桌助呈报若脱离投影 API 事实源会编造进度/状态（§10 硬边界 4：同一事实源）。实施前以最新源码复核 pi-operator-skill.ts / SKILL.md / 桌助呈报路径落点。

## References
- 设计真源（正式施工 Owner lock）: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` — §12 兼容/迁移原则（§12.2.2 registry 零改动 + G1/G2）、§16 影响面（§16.2 Pi operator Skill：多实例感知契约 3，不新增 Skill）、§17 Owner lock（TASKS doing 仍是唯一施工许可）
- PRODUCT C9（C9.1 同角色多实例显式可见、C9.6 桌助是协调入口不是主管工位）
- PRD §2.4 REQ-028（实例一等身份 = jobId）、REQ-029（共享容量与实例授权边界、桌助边界）、AC-024..AC-027
- SPEC §1.0 不变量 8/9、CAP-027（多实例运行时；桌助边界）、EVAL-030
- PLAN M-5140（任务分解与 Gate：WMB-5144 为 Pi operator Skill 多实例感知 + 桌助呈报/续派路径）
- `docs/pi-operation-skill-maintenance.md`（提示词登记规程）

## Scope
1. 多实例感知提示词登记：按 `docs/pi-operation-skill-maintenance.md` 规程，在既有提示词落点登记多实例感知文本（明确「只对当前 job 上下文负责、不引用其他实例会话、不假设自己是唯一在岗员工」）；不新增 Skill 文件。
2. 桌助呈报/续派路径：桌助对进度/状态的回答只来自投影 API（roster/jobs/task），禁止编造；续派参数 = 从 context_refs_json 重建原 RoleJobRequest（jobId/roleId/brief/边界参数）+ 结果摘要（5141/5142 合同）。

## Acceptance
- [ ] 多实例感知文本按维护规程登记于既有提示词落点（pi-operator-skill.ts / 角色策略提示词 / skills/wemedia-buddy-operator/SKILL.md），明确「同一角色可能同时有多个工单实例；只对当前 job 上下文负责；不引用其他实例会话；不假设自己是唯一在岗员工」
- [ ] 不新增 Skill 文件、不新增命令/工具/角色权限（focused 断言：Skill 清单/命令面不扩张）
- [ ] 桌助呈报事实源：对进度/状态的回答只来自投影 API（roster/jobs/task），无编造进度/状态；续派参数重建自 context_refs_json（5141 合同）+ 结果摘要
- [ ] 既有 Skill 契约不回归：pi-extension 聚焦测试与 wmb_mcp 工具清单测试通过（WMB-5133 工具清单契约保持）
- [ ] 门禁：`npm run typecheck` 0；`npm run check:capabilities`（G1）通过；跳过 formatter/lint/全量测试（项目级命令由主 Agent 统一执行）
- [ ] 证据收口：`.ai/wmb-5144-evidence.md` 完整（登记前后提示词 diff、桌助呈报路径实机/测试数据）；TASKS.md 行 done 回执（入账阶段，本合同不登记）

## Verification
- focused 测试：Skill 文本契约（多实例感知文本存在且位置正确）、工具清单不回归、桌助呈报/续派参数重建（focused 单测 + 实机路径）。
- 门禁：`npm run typecheck` + `npm run check:capabilities`（G1）；轻量 intake/ledger 结构检查由主 Agent 统一执行。
- 证据文件：`.ai/wmb-5144-evidence.md`（未来实施阶段落盘；本 Design 只落合同，不创建证据）。

## Allowed paths
- `.ai/wmb-5144-contract.md`（本合同，本次唯一新建文件）
- `.ai/wmb-5144-evidence.md`（未来实施阶段证据文件；本次不创建）
- `TASKS.md`（未来入账用；本 Design 只落合同，不登记）
- 未来实施预期落点（本 Design 禁止触碰，列出以约束根因范围）：`src/main/pi-operator-skill.ts`、`skills/wemedia-buddy-operator/SKILL.md`、`src/main/manager-*.ts`（桌助呈报路径）、`tests/pi-extension.test.mjs` 及对应聚焦测试

## Forbidden paths
- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`（能力注册表/权限，no change）
- `PRODUCT.md` / `PRD.md` / `SPEC.md` / `TECHNICAL_DESIGN.md` / `PLAN.md`（产品/技术合同已落档）
- 三表 schema 与迁移文件（结构零改动，无迁移）
- `src/main/**` 中 dispatcher/grant/lease/终态语义文件（WMB-5141/5142 面；本任务不改运行时语义）
- 真实 data root、依赖文件（package.json、package-lock.json、node_modules 等）、`TASKS.archive.md`
- 本合同之外任何文件（本次仅允许新建 `.ai/wmb-5144-contract.md`）

## Non-goals
- 不新增 Skill 文件/命令/工具/角色权限；不新增依赖
- 不改角色权限与产品承诺；不改五态终态契约与取消优先语义（WMB-5116 契约保持）
- 不重做桌助编排（单跳派工、不代批、无 standing 写权语义不变）
- 不改 dispatcher/grant/lease 运行时语义（5141/5142 面）
- 不触发真实平台发布/互动
- 本 Design 不登记 TASKS 行、不写实现代码；本合同仅为提案

## Capability registry impact
no change — 纯提示词登记与桌助呈报/续派路径对齐，不新增命令/工具/角色权限、不触碰 registry；`check:capabilities`（G1）通过。
Pi operator Skill impact: required（updated）— 多实例感知提示词按 `docs/pi-operation-skill-maintenance.md` 规程登记（设计 §16.2 行为契约 3；不新增 Skill）。

## Depends on
WMB-5143

## Design / lock
- Design: docs/spark/2026-08-08-agent-crew-multi-instance-design.md
- Owner lock 2026-08-08:
  1. 多实例感知提示词（§16.2 契约 3）按 `docs/pi-operation-skill-maintenance.md` 规程登记：提示词明确「同一角色可能同时有多个工单实例；你只对当前 job 的上下文负责，不引用其他实例会话、不假设自己是唯一在岗员工」；不新增 Skill 文件。
  2. 桌助呈报/续派（§10 硬边界 4）：对进度/状态的回答只来自投影 API（roster/jobs/task），禁止编造；续派参数 = 从 context_refs_json 重建原 RoleJobRequest（jobId/roleId/brief/边界参数）+ 结果摘要（5141/5142 合同）。
  3. Capability registry no change：不新增命令/工具/角色权限；desk 无 standing 写权、不进员工槽、单跳派工、不代批不变；`check:capabilities`（G1）通过。
  4. 既有 Skill 契约不回归：工具清单与提示词语义按维护规程登记后复核。
  5. Non-goals: 不新增 Skill/命令/工具；不改角色权限与产品承诺；不改五态终态契约；不改 dispatcher/grant/lease 语义；不触发真实平台发布/互动。
  6. Route: Design.
  7. Design path: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md`.
