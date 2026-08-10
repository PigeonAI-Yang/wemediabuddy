# WMB-5145 Contract

## Route
Design

## Goal
落实设计 §14（A1..A14）与 SPEC EVAL-030 的集成验收：聚焦测试 + typecheck + check:capabilities（G1/G2）+ 隔离实机（含重启续派）+ 独立复审 + 证据包 + TASKS.md 五行 done 回执；变更集零新增角色/能力，注册表零改动。

## Problem / Root cause
M-5140 五项施工（5141..5144）需要统一验收门：EVAL-030 场景 A1..A14 逐项可证伪验收 + §12.2 一致性门禁（G1/G2），防止「槽位化/常驻员工/配额化」设计违规（§15 风险 1/4）与 registry/权限漂移（§15 风险 7）；done 回执须满足 WMB-4810 起四回执契约。

## References
- 设计真源（正式施工 Owner lock）: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` — §12 兼容/迁移原则（§12.2.1 schema 零改动、§12.2.2 registry 零改动 + G1/G2、§12.2.3 不新增通用角色/云/平台 API、§12.2.4 干净切换）、§16 影响面（§16.1 验收强制 G1/G2；§16.2 Skill 登记复核）、§17 Owner lock（TASKS doing 仍是唯一施工许可）
- PRODUCT C9（班组多实例不变量全集）
- PRD §2.4 REQ-028/REQ-029、AC-024..AC-027
- SPEC §1.0 不变量 8/9、CAP-027、EVAL-030
- PLAN M-5140（任务分解与 Gate：WMB-5145 为验收；Gate 清单见 PLAN M-5140）
- `docs/pi-operation-skill-maintenance.md`（5144 提示词登记的复核规程）

## Scope
1. EVAL-030 验收场景 A1..A14 逐项可证伪验收（含负断言：A9 跨对象写、A10 红线不可达、A14 兼容零改动）。
2. 门禁：聚焦测试（5141..5144 面）+ `npm run typecheck` + `npm run check:capabilities`（G1）+ effective grant 一致性（G2）+ 隔离实机（智能体页实例卡/空态/等你批/历史续派；重启后从 context_refs_json 续派 A13）。
3. 收口：独立复审（无 blocker/major，findings 关闭）+ 证据包（`.ai/wmb-5145-evidence.md` 等）+ TASKS.md 五行 done 回执（每行四回执齐全）。

## Acceptance
- [ ] A1..A14 逐项 PASS：同角色多实例显式可见（A1）；实例按任务创建（A2）；终态退出/等你批（A3）；不预设空槽（A4）；并发 = 系统容量（A5）；并发 ≠ 角色配额（A6）；桌助非主管工位（A7）；实例权限交集（A8）；跨对象写拦截负断言（A9）；红线不可达负断言（A10）；needs_user 数据流（A11）；取消 ≤5s（A12）；历史重建与一键续派（A13）；兼容零改动（A14）
- [ ] EVAL-030 门禁：同角色多实例显式可见；空态「当前无任务」无空座；needs_user 停留不占 slot/lease/grant/锁、不自动重试；重启后从 context_refs_json 续派；跨对象写 BLOCKED + 审计；红线命令不可达；check:capabilities 绿
- [ ] 聚焦测试全绿 + `npm run typecheck` 0 + `npm run check:capabilities`（G1）+ effective grant 一致性（G2）通过
- [ ] 隔离实机（隔离 data root）：智能体页实例卡/空态/等你批/历史续派可见；桌助呈报来自投影 API；重启续派（A13）实机完成
- [ ] 独立复审通过（无 blocker/major，findings 全部关闭）
- [ ] 证据包落盘：`.ai/wmb-5145-evidence.md`（A1..A14 逐项结果 + 门禁输出 + 实机数据）；`.ai/evals/EVAL-CAP-027.md` 若需更新按既有规程处理
- [ ] TASKS.md 五行 done 回执：WMB-5141..5145 每行四回执齐全（至少一个仓库相对证据路径 / `Pi operator Skill impact: (updated|no change) — <note>` / `Independent review: <name> — <conclusion>` / Evidence cell ≤700 字符）；5141..5143 注明 Pi Skill no change、5144 注明 updated、5145 注明 verifies
- [ ] 跳过 formatter/lint/全量测试（项目级命令由主 Agent 统一执行）

## Verification
- EVAL-030 场景驱动（设计 §14 A1..A14 逐项，负断言必须真实执行，不得以推断充当）。
- 聚焦套件 + `npm run typecheck` + `npm run check:capabilities`（G1/G2）。
- 隔离实机（真实 Electron/browser，隔离 data root，含重启续派）。
- 独立复审记录 + 证据文件 `.ai/wmb-5145-evidence.md`（未来实施阶段落盘；本 Design 只落合同，不创建证据）。

## Allowed paths
- `.ai/wmb-5145-contract.md`（本合同，本次唯一新建文件）
- `.ai/wmb-5145-evidence.md`（未来实施阶段证据文件；本次不创建）
- `.ai/evals/EVAL-CAP-027.md`（若验收发现需按 CAP eval 规程更新；本次不创建）
- `TASKS.md`（done 回执阶段五行入账；本 Design 只落合同，不登记）
- 未来实施预期落点（本 Design 禁止触碰，列出以约束验收范围）：5141..5144 施工产出、`tests/` 验收聚焦测试、隔离实机脚本

## Forbidden paths
- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`（能力注册表/权限，no change）
- `PRODUCT.md` / `PRD.md` / `SPEC.md` / `TECHNICAL_DESIGN.md` / `PLAN.md`（产品/技术合同已落档）
- 三表 schema 与迁移文件（结构零改动，无迁移）
- `skills/wemedia-buddy-operator/SKILL.md`、`src/main/pi-operator-skill.ts`（5144 已登记；本任务只复核不重写）
- 真实 data root、依赖文件（package.json、package-lock.json、node_modules 等）、`TASKS.archive.md`
- 本合同之外任何文件（本次仅允许新建 `.ai/wmb-5145-contract.md`）

## Non-goals
- 不扩大变更范围（五项施工范围由 WMB-5141..5144 合同界定，验收只核对不扩写）
- 不新增角色/能力/命令/依赖；不重做 UI 或运行时语义
- 不触发真实平台发布/互动；实机验收仅用隔离 data root
- 不重写 5144 已登记的提示词（只复核一致性与维护规程符合性）
- 本 Design 不登记 TASKS 行、不写实现代码；本合同仅为提案

## Capability registry impact
no change — 验收/证据任务，变更集零新增角色/能力/命令；`check:capabilities`（G1）+ effective grant 一致性（G2）为验收门禁（设计 §16.1）。
Pi operator Skill impact: verifies — 复核 5144 登记的多实例感知提示词与 `docs/pi-operation-skill-maintenance.md` 规程一致，并逐任务注明（5141..5143 no change / 5144 updated）。

## Depends on
WMB-5144

## Design / lock
- Design: docs/spark/2026-08-08-agent-crew-multi-instance-design.md
- Owner lock 2026-08-08:
  1. 验收以设计 §14 A1..A14 + SPEC EVAL-030 为唯一口径；负断言（A9 跨对象写、A10 红线不可达）必须真实执行，不得以推断充当。
  2. 门禁：聚焦测试 + `npm run typecheck` + `npm run check:capabilities`（G1）+ effective grant 一致性（G2）+ 隔离实机（含重启续派 A13）；实机仅用隔离 data root，不触发真实平台发布/互动。
  3. 收口：独立复审（无 blocker/major，findings 关闭）+ 证据包（`.ai/wmb-5145-evidence.md`）+ TASKS.md 五行 done 回执（每行四回执齐全，逐任务注明 Pi Skill impact）。
  4. 兼容零改动复核（§12.2）：变更集不触碰三表 schema、不新增能力/角色/通用角色/云/平台 API；干净切换无 shim 无双轨。
  5. Non-goals: 不扩大变更范围、不新增角色/能力/命令、不重做 UI/运行时、不重写 5144 提示词、不触发真实平台发布/互动。
  6. Route: Design.
  7. Design path: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md`.
