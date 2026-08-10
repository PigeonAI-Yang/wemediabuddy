# WMB-5143 Contract

## Route
Design

## Goal
落实设计 §4/§11 的实例驱动智能体页：五角色分组始终可见、空角色「当前无任务」不画空槽、实例卡（状态词/状态点双编码 + 进度 + 动作）、needs_user「等你批」停留、页头摘要（工作中/排队/等你批）、历史折叠 + 一键续派；UI 单源（一切显示只来自投影 API，禁止第二份手写标签）。

## Problem / Root cause
设计 §1.1 P1/P2/P3（固定槽误解、实例语义缺失、并发语义错位）在活动视图的表现：现状按角色画固定名牌，空角色渲染「待命」空座（违反不变量 2/4），同角色多实例无表达，UI 可能自造第二份标签（§12.2.6 违规面）。实施前以最新源码复核 agents 视图/值班条/科室页投影落点。

## References
- 设计真源（正式施工 Owner lock）: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` — §12 兼容/迁移原则（§12.2.5 desk 零回归、§12.2.6 UI 单源）、§16 影响面（§16.1 registry 预期零改动）、§17 Owner lock（TASKS doing 仍是唯一施工许可）
- PRODUCT C9（C9.1 同角色多实例显式可见、C9.3 needs_user 停留、C9.4 不预设空槽、C9.9 角色编号仅活动期显示）
- PRD §2.4 REQ-028（角色≠槽位/实例/等你批）、REQ-029（共享容量与实例授权边界）、AC-024..AC-027（多实例显式可见与空态/生命周期与等你批/容量与对象边界/持久续派与桌助边界）
- SPEC §1.0 不变量 8/9、CAP-027（活动视图语义、needs_user 停留）、EVAL-030
- PLAN M-5140（任务分解与 Gate：WMB-5143 为智能体页实例驱动 UI）

## Scope
1. 智能体页实例驱动视图：五角色分组始终可见；空角色显示「当前无任务」，不画空槽；实例卡 = 名牌（角色 + 实例号）+ 任务一句话 + 状态词/状态点（双编码）+ 进度 N/M + 开始时间 + 动作（查看详情/传话/取消/处理）；needs_user 卡停留「等你批」直至用户处理/关闭。
2. 页头摘要：工作中 N · 排队 M · 等你批 K（全部来自投影 API，可点过滤）；无实例时总量空态。
3. 历史折叠区：每角色最近 N 条终态实例（状态 + 一句话结果 + 时间），点击续派/查看会话；续派参数 = 从 context_refs_json 重建 RoleJobRequest（5141/5142 合同）。
4. 今日值班条 ≤1 行知情投影（谁在干什么/卡在哪/要不要你拍板）与科室页投影（只投影该角色实例活动状态）；Dock 收件人钉死桌助（manager-as-primary-agent 契约延续）。

## Acceptance
- [ ] 空态（设计 §14 A2/A4）：全空时五角色分组头始终可见、各显示「当前无任务」，页头摘要「工作中 0 · 排队 0」，全页无「待命」/占位坐席文案（实机 DOM 断言 + 文案扫描）
- [ ] 多实例（A1）：容量允许时派两张不同渠道记者单 → 同角色两张实例卡「记者 #1」「记者 #2」，各自进度独立
- [ ] 终态退出/等你批（A3/A11）：succeeded/failed/cancelled 卡立即退出活动视图进历史；needs_user 卡停留「等你批」直至用户处理/关闭（期间不占并发、不持 lease/grant/锁、不自动重试）；scan→judge 同一任务不双计
- [ ] 实例卡内容：名牌 + 任务一句话 + 状态词/点双编码（WCAG AA）+ 进度 N/M + 开始时间；等待原因可读（禁止裸「等资源」）；失败/拦截文案以可操作指引收尾
- [ ] 页头摘要与过滤：工作中/排队/等你批 全部来自投影 API 且可点过滤；无第二份手写标签（UI 单源，§12.2.6）
- [ ] 历史 + 一键续派：历史从持久面重建（5142 投影），续派参数 = 重建 RoleJobRequest（5141 合同）；实机重启后可用（A13 的 UI 面）
- [ ] 值班条/科室页/Dock：值班条 ≤1 行、无 action 不上条；科室页只投影该角色实例活动状态；Dock 收件人钉死桌助、员工实例不可直呼
- [ ] 门禁：`npm run typecheck` 0；renderer smoke 通过；`npm run check:capabilities`（G1）通过；跳过 formatter/lint/全量测试（项目级命令由主 Agent 统一执行）
- [ ] 证据收口：`.ai/wmb-5143-evidence.md` 完整（实机 before/after DOM 与视口数据）；TASKS.md 行 done 回执（入账阶段，本合同不登记）

## Verification
- 实机（隔离 data root，真实 Electron/browser）：空态/多实例/终态退出/等你批/历史续派逐项验证；DOM 与视口快照（沿用 WMB-5135/5136 视口口径）。
- focused renderer 测试：投影驱动、状态映射、空态文案、历史重建渲染。
- 门禁：`npm run typecheck` + renderer smoke + `npm run check:capabilities`（G1）；轻量 intake/ledger 结构检查由主 Agent 统一执行。
- 证据文件：`.ai/wmb-5143-evidence.md`（未来实施阶段落盘；本 Design 只落合同，不创建证据）。

## Allowed paths
- `.ai/wmb-5143-contract.md`（本合同，本次唯一新建文件）
- `.ai/wmb-5143-evidence.md`（未来实施阶段证据文件；本次不创建）
- `TASKS.md`（未来入账用；本 Design 只落合同，不登记）
- 未来实施预期落点（本 Design 禁止触碰，列出以约束根因范围）：`src/renderer/agents-*.tsx`（智能体页/实例卡/历史折叠）、`src/renderer/agents-roster-view.tsx`、今日值班条与科室页投影组件、对应 styles-*.css、`tests/` 对应聚焦测试

## Forbidden paths
- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`（能力注册表/权限，no change）
- `PRODUCT.md` / `PRD.md` / `SPEC.md` / `TECHNICAL_DESIGN.md` / `PLAN.md`（产品/技术合同已落档）
- 三表 schema 与迁移文件（结构零改动，无迁移）
- `src/main/**` 中 dispatcher/grant/lease/终态语义文件（WMB-5141/5142 面）、`src/preload/**` 业务命令面（如需新 IPC 仅限投影只读面）
- `skills/wemedia-buddy-operator/SKILL.md`、`src/main/pi-operator-skill.ts` 及 Pi 相关资产（Pi operator Skill no change）
- 真实 data root、依赖文件（package.json、package-lock.json、node_modules 等）、`TASKS.archive.md`
- 本合同之外任何文件（本次仅允许新建 `.ai/wmb-5143-contract.md`）

## Non-goals
- 不做可配置权限 UI（P0 注册表 + 角色过滤 + 只读班组页完成前零权限配置控件）
- 不做编排图/员工自动多跳/永久员工实体（不建员工档案、无「待命」实例态）
- 不重做 Today 产品形态；不改业务命令语义与最终人工发布边界
- 不新增组件库/布局系统/状态库；不做批量之外的重构
- 不新增能力/角色/命令；不改发布/硬删红线
- 不改 Pi 提示词（Pi operator Skill no change，见 Capability registry impact）
- 本 Design 不登记 TASKS 行、不写实现代码；本合同仅为提案

## Capability registry impact
no change — 纯 renderer 投影 UI（视图/文案/状态映射），不触碰 registry、不新增命令/角色；`check:capabilities`（G1）通过。
Pi operator Skill impact: no change — 无直接提示词变更（Dock 收件人钉死桌助为既有 manager-as-primary-agent 契约；实例卡/空态为 renderer-only 表现层）；5144 单独登记多实例感知提示词。

## Depends on
WMB-5142

## Design / lock
- Design: docs/spark/2026-08-08-agent-crew-multi-instance-design.md
- Owner lock 2026-08-08:
  1. 智能体页按实例驱动（§4/§11.1）：五角色分组始终可见，空角色显示「当前无任务」不画空槽；实例卡 = 名牌 + 任务一句话 + 状态词/状态点双编码（WCAG AA）+ 进度 N/M + 开始时间 + 动作（查看详情/传话/取消/处理）；needs_user 卡停留「等你批」至用户处理/关闭，其余终态立即退出进历史。
  2. 页头摘要「工作中 N · 排队 M · 等你批 K」全部来自投影 API，可点过滤；无实例时总量空态；历史从持久面重建并可一键续派（参数 = 从 context_refs_json 重建 RoleJobRequest，5141/5142 合同）。
  3. UI 单源（§12.2.6）：任何「谁在干什么/谁有什么权」的显示只来自投影 API（roster/role-permission-summary），禁止第二份手写标签；状态点颜色 + 文字双编码；等待原因可读，禁止裸「等资源」。
  4. 值班条 ≤1 行、无 action 不上条；科室页只投影该角色实例活动状态；Dock 收件人钉死桌助，员工实例不可直呼（manager-as-primary-agent 契约延续）。
  5. Capability registry no change：`check:capabilities`（G1）通过；不做可配置权限 UI；红线不变。
  6. Non-goals: 不做编排图/员工自动多跳/永久员工实体；不重做 Today；不改业务命令语义；不触碰 dispatcher/grant/lease 语义；不改 Pi 提示词。
  7. Route: Design.
  8. Design path: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md`.
