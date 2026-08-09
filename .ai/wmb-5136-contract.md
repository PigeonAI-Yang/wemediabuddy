# WMB-5136 Contract

## Route
Patch

## Goal
选题台账批量操作改为显式模式：常态（未进入批量）下选题行不渲染 checkbox、行布局不预留空 checkbox 列；选题页工具区新增"批量操作"入口，进入后同位置按钮变为"退出批量"，三 tab（today/shelved/dismissed）行首 checkbox 出现；退出时清空 checkedIds、批量条消失。仅 renderer 可见性/交互调整，不改业务命令、IPC、能力注册表与产品合同。

## Acceptance
- [ ] 当前事实（已核对 proposals-view.tsx）：openTab 分支（today+shelved）行 checkbox 无条件渲染（L266-268）、dismissed 行无条件渲染（L306-308），三类 tab 修复前均常态渲染 checkbox；批量条在 `checkedIds.length>0 && (openTab||tab==='dismissed')` 时出现（L239，openTab=today|shelved L129）；tab 切换（L111-115）与台账外部变更（L120-121）已清空 checkedIds。实施前以最新源码复核。
- [ ] 常态 DOM：today/shelved/dismissed 行首均无 `input[type=checkbox]` 且无 `.proposal-check` 空列占位，行布局不预留 checkbox 列宽。
- [ ] 进入/退出：工具区"批量操作"按钮可点击进入；进入后同位置按钮文案变"退出批量"，三 tab 行首 checkbox 出现；点"退出批量"→ checkedIds 清空、批量条消失、checkbox 消失、按钮回到"批量操作"。
- [ ] 选择与批量条：批量模式下勾选 N 条 → 批量条出现并显示"已勾选 N 条"、行带 checked 类；"清除勾选"清空选择、批量条消失且不退出模式；批量否掉/批量恢复执行后 checkedIds 清空（保留 L172/L191 语义）。
- [ ] 三 tab：today（批量否掉）、shelved（批量否掉）、dismissed（批量恢复）批量模式下均可勾选并执行对应批量命令；tab 切换/数据刷新清空 checkedIds 但**不擅自退出批量模式**（模式由按钮状态保持）。
- [ ] 键盘/语义：Tab 可达模式切换按钮、批量模式下各行 checkbox 与批量条按钮，焦点环清晰；"批量操作"↔"退出批量"为同一按钮状态切换（按钮文案 + aria-pressed 二态）；Escape 退出批量模式并清空选择（回到常态 DOM）。
- [ ] 窄屏与溢出：批量模式开/关两态在 1100×760 与 1366×768 下均 `scrollWidth==clientWidth`，无横向溢出（沿用 WMB-5135 视口口径）。
- [ ] 回归：单条否掉、dismissed 单条恢复、行点击 Pi 焦点、主题跳转、分页/加载更多在批量模式开/关两态行为一致；批量条按钮文案与确认对话框不变；adopted/expired tab 保持现状（无 checkbox、无批量条）。
- [ ] 证据：`.ai/wmb-5136-evidence.md` 落盘（真实 Electron/browser 实机 before/after DOM 与视口数据）；TASKS.md 行 done 回执（入账阶段）。

## Allowed paths
- `.ai/wmb-5136-contract.md`（本合同）
- `src/renderer/proposals-view.tsx`（唯一预期组件落点）
- `src/renderer/styles-proposals.css`（checkbox 列与批量条样式）
- `.ai/wmb-5136-evidence.md`（任务证据文件）
- `TASKS.md`（未来入账用；本 Patch 只落合同，不登记）

## Forbidden paths
- `src/main/**`、`src/preload/**`、IPC/MCP（含 src/main/mcp.ts、agent-tasks.ts）
- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`（能力注册表/权限）
- `PRODUCT.md` / `PRD.md` / `SPEC.md` / `TECHNICAL_DESIGN.md`（产品合同，本 Patch 不得修改）
- 其他 renderer 组件/样式（today-view-parts.tsx、styles-foundation.css、styles-pi.css、studio-* 等）
- `skills/wemedia-buddy-operator/SKILL.md` 及 Pi 相关资产
- 依赖文件（package.json、package-lock.json、node_modules 等）、真实 data root、`TASKS.archive.md`

## Non-goals
- 不引入新组件/布局系统/状态库；不做批量之外的台账重构
- 不改业务命令语义（dismissPlanItem/restoreProposal）、IPC 工具、能力注册表
- 不改产品合同（PRODUCT C1–C7、PRD §2.0、SPEC §1.0）：批量入口为页面级交互实现，"选题=主编决策台账"形态不变
- 不为 adopted/expired tab 增加批量能力（保持现状）
- 不新增组件测试文件：最小 Patch 以真实 Electron/browser 实机验收为主，现有组件测试框架无合适入口则不新增测试
- 不在本 Patch 登记 TASKS 行或实现代码；本合同仅为提案
- Pi operator Skill 零改动

## Capability registry impact
no change — 纯 renderer 可见性/交互调整，不触碰 registry。

Pi operator Skill impact: no change — checkbox 可见性为 renderer-only 表现层调整；`wmb_*` 工具、批量命令（dismissPlanItem/restoreProposal）、业务流程与 readback 契约均不变，Pi 操作路径无差异。按 docs/pi-operation-skill-maintenance.md 影响表属"纯视觉/可见性调整，正常无需更新"类；evidence 中仍须写明该理由。

## Depends on
WMB-5122（已 done；未来 owner proposals-ui，与 WMB-5130 无文件重叠）

## Design / lock
- 保守默认（已定）：工具区"批量操作"入口（proposal-tabs 行右侧）→ 进入后按钮文案变"退出批量"（aria-pressed 二态），三 tab 行首 checkbox 出现；退出清空 checkedIds、批量条消失；tab 切换/数据刷新继续清空选择但不擅自退出模式；常态行布局去掉空 checkbox 列。
- "清除勾选"清空选择并留在批量模式；Escape 退出批量模式并清空选择。
- Owner 仅需确认整份 Patch 合同，未确认前不登记。
