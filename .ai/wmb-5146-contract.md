# WMB-5146 Contract

## Route
Patch

## Goal
智能体页视觉整改 Patch：消除用户 2026-08-10 实机截图验收反馈的大面积碎片化空白、五组卡片散落、视觉层级和空间利用失败；仅整改 renderer agents 视图/css 布局呈现，不改变实例投影、权限、Skill 与功能语义（沿用 PRODUCT C9 / SPEC CAP-027）。

## Problem / Root cause
用户 2026-08-10 实机截图验收反馈（WMB-5145 视觉验收失败）：当前智能体页大面积碎片化空白、五组卡片散落、视觉层级和空间利用失败。WMB-5143 已交付实例驱动 UI（五角色分组/实例卡/needs_user「等你批」/页头摘要/历史折叠+一键续派）功能语义正确，但布局呈现未达视觉验收标准：分组卡片散落、空白未整合、层级不清。实施前以最新源码复核 agents 视图与 styles-agents.css 的布局根因（网格/间距/分组容器/响应式断点）。

## References
- 设计真源（正式施工 Owner lock）: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` — §11（智能体页 UI）、§12 兼容/迁移原则（§12.2.6 UI 单源）、§17 Owner lock（TASKS doing 仍是唯一施工许可）
- PRODUCT C9（C9.1 同角色多实例显式可见、C9.3 needs_user 停留、C9.4 不预设空槽）
- PRD §2.4 REQ-028/REQ-029、AC-024..AC-027
- SPEC §1.0 不变量 8/9、CAP-027、EVAL-030
- PLAN M-5140（任务分解与 Gate）
- WMB-5143 合同/证据（实例驱动 UI 已交付；本 Patch 只整改布局呈现，不重做语义）
- 用户 2026-08-10 实机截图验收反馈（5145 视觉验收失败记录）

## Scope
1. 智能体页布局整改：整合大面积碎片化空白、重组五组卡片（对齐/间距/分组容器/层级）、修复视觉层级与空间利用；仅改 renderer agents 视图与样式（`agents-roster-view.tsx` / `styles-agents.css`，必要时最小 class 配合）。
2. 功能语义零变更：实例投影（jobId 一等身份/活动期编号/终态顺序）、权限（registry/对象级隔离）、Skill（提示词/工具面）均不变；空态「当前无任务」、多实例卡、needs_user「等你批」停留、页头摘要、历史折叠+一键续派 行为保持 5143 交付语义。
3. 视觉验收：1440 / 1100 / 窄屏三档实机截图，覆盖 空态 / 多实例 / needs_user 三态。

## Acceptance
- [ ] 1440 / 1100 / 窄屏三档实机截图 PASS：无大面积碎片化空白、五组卡片不散落、分组对齐一致、视觉层级清晰、空间利用合理（横向无溢出、纵向无断裂）
- [ ] 三态实机：空态（五角色分组头可见 + 各「当前无任务」）、多实例（同角色多卡独立）、needs_user（「等你批」停留）在三个视口下布局均符合上述标准
- [ ] 功能语义零回归：`tests/wmb-5143-agents-instance-view.test.mjs` 保持通过；实例投影/权限/Skill 面零改动（diff 仅限 agents 视图/css）
- [ ] 门禁：`npm run typecheck` 0；renderer smoke 通过；`npm run check:capabilities`（G1）通过；跳过 formatter/lint/全量测试（项目级命令由主 Agent 统一执行）
- [ ] 证据收口：`.ai/wmb-5146-evidence.md` 落盘（三视口×三态实机截图与 DOM/布局数据、before/after 对比）；TASKS.md 行 done 回执（入账阶段，本合同不登记）

## Verification
- 实机（隔离 data root，真实 Electron/browser）：1440 / 1100 / 窄屏三档截图 + 空态/多实例/needs_user 三态，记录 DOM/布局指标到 evidence。
- 聚焦回归：`tests/wmb-5143-agents-instance-view.test.mjs`（5143 面保持）。
- 门禁：`npm run typecheck` + renderer smoke + `npm run check:capabilities`（G1）。
- 证据文件：`.ai/wmb-5146-evidence.md`（未来实施阶段落盘；本 Patch 只落合同，不创建证据）。

## Allowed paths
- `.ai/wmb-5146-contract.md`（本合同，本次唯一新建文件）
- `.ai/wmb-5146-evidence.md`（未来实施阶段证据文件；本次不创建）
- `src/renderer/agents-roster-view.tsx`（智能体页视图整改落点，必要时最小 class/结构配合）
- `src/renderer/styles-agents.css`（样式整改主要落点）
- `tests/wmb-5143-agents-instance-view.test.mjs`（回归面；仅当布局整改需同步断言时最小调整）
- `TASKS.md`（未来入账用；本 Patch 只落合同，不登记）

## Forbidden paths
- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`（能力注册表/权限，no change）
- `PRODUCT.md` / `PRD.md` / `SPEC.md` / `TECHNICAL_DESIGN.md` / `PLAN.md`（产品/技术合同已落档）
- 三表 schema 与迁移文件（结构零改动，无迁移）
- `src/main/**`、`src/preload/**`（IPC/MCP/dispatcher/grant/lease/终态语义；本 Patch 不动运行时与权限）
- `skills/wemedia-buddy-operator/SKILL.md`、`src/main/pi-operator-skill.ts`（Pi operator Skill no change）
- 真实 data root、依赖文件（package.json、package-lock.json、node_modules 等）、`TASKS.archive.md`
- 本合同之外任何文件（本次仅允许新建 `.ai/wmb-5146-contract.md`）

## Non-goals
- 不改变实例投影/权限/Skill：jobId 一等身份、活动期编号、终态顺序、grant 交集、对象级隔离、提示词/工具面全部不变
- 不改功能语义：空态/多实例/needs_user/页头摘要/历史折叠+续派 行为保持 5143 交付语义，不重做 UI 逻辑
- 不新增角色/能力/命令/依赖；不引入新组件库/布局系统
- 不重做整个产品布局（仅智能体页）；不触发真实平台发布/互动
- 本 Patch 不登记 TASKS 行、不写实现代码；本合同仅为提案

## Capability registry impact
no change — 纯 renderer 布局/样式整改，不触碰 registry、不新增命令/角色；`check:capabilities`（G1）通过。
Pi operator Skill impact: no change — 不改提示词/工具面（Skill 面由 5144 已登记，本任务零触碰）。

## Depends on
WMB-5143

## Design / lock
- Design: docs/spark/2026-08-08-agent-crew-multi-instance-design.md
- Owner lock 2026-08-10（用户实机截图验收反馈）:
  1. 用户 2026-08-10 实机截图验收反馈（5145 视觉验收失败）：当前智能体页大面积碎片化空白、五组卡片散落、视觉层级和空间利用失败；本 Patch 以消除该三项为唯一验收口径。
  2. 只整改 renderer agents 视图/css 布局呈现；实例投影/权限/Skill/功能语义零变更（5143 已验收行为保持）。
  3. 验收：1440 / 1100 / 窄屏三档实机截图 + 空态/多实例/needs_user 三态，before/after 对比入 evidence。
  4. Capability registry no change：不新增角色/能力/命令；`check:capabilities`（G1）通过。
  5. Non-goals: 不重做 UI 逻辑、不改功能语义、不新增依赖/组件库、不触发真实平台发布/互动。
  6. Route: Patch.
  7. Design path: `docs/spark/2026-08-08-agent-crew-multi-instance-design.md`.
