# WMB-5136 Evidence — 选题台账显式批量模式（常态无 checkbox 列）

- 日期：2026-08-09
- 合同：`.ai/wmb-5136-contract.md`
- 改动文件：`src/renderer/proposals-view.tsx`、`src/renderer/styles-proposals.css`（仅此两个 Allowed paths 落点）
- 独立复审：`ReviewWmb5136 — approved`；F1/F2 均 closed，无未决 findings
- 当前台账真实数据（实机读取，2026-08-09）：today 3 / shelved 5 / dismissed 13

## Background

合同要求把选题台账批量操作改为显式模式：常态（未进入批量）下选题行不渲染 checkbox、行布局不预留空 checkbox 列；工具区新增「批量操作」入口，进入后同位置按钮变为「退出批量」，today/shelved/dismissed 三 tab 行首 checkbox 出现；退出/Escape 清空 checkedIds、批量条消失。仅 renderer 可见性/交互调整，不改业务命令（dismissPlanItem/restoreProposal）、IPC、能力注册表与产品合同。

修复前基线（合同记录 + 已提交版本 793e933 复核）：openTab 分支（today+shelved）行 checkbox 无条件渲染、dismissed 行 checkbox 无条件渲染——三类 tab 修复前均常态渲染 checkbox；批量条在 `checkedIds.length>0 && (openTab||tab==='dismissed')` 时出现；常态行首始终预留 28px checkbox 列（`.proposal-open-item{grid-template-columns:28px minmax(0,1fr)}`）。此基线来自源码/合同事实，非实机测量。

## Root cause

批量 UI 原为无模式设计：checkbox 常驻（openTab 分支覆盖 today+shelved，二者与 dismissed 三类 tab 修复前均无条件渲染），常态行布局固定 28px 复选框列，空选择时也占位，造成常态视觉噪音与行宽浪费，且没有显式「进入/退出批量」入口，用户无法感知当前处于哪种操作语境。修复方向：新增 `batchMode` 显式状态，常态完全隐藏 checkbox 与空列，仅批量模式下渲染 checkbox 列与批量条；批量入口与「退出批量」为同一按钮二态。

## Implementation

最小修复，仅两文件：`proposals-view.tsx` 374 行、`styles-proposals.css` 175 行（均低于 check.ps1 500 行全局门槛，且不在 line-caps.json 特例内）。

**proposals-view.tsx**

- L79 新增 `batchMode` 状态；L86 `enterBatch`、L88-91 `exitBatch`（清空 checkedIds + 置 false）。
- L135-144 Escape 监听：仅 `batchMode` 时挂载 window keydown，卸载移除监听；`event.key==='Escape'` 且无确认层时 `exitBatch()`。**reviewer F1 修复**：L139 新增 `if (document.querySelector('.app-confirm-root')) return;` —— 确认层开启时首次 Escape 只关闭确认层（交给 app-confirm），不退出批量模式。
- L149 `batchSupported = openTab || tab==='dismissed'`（today/shelved/dismissed 才渲染入口；adopted/expired 无）。
- L257-264 工具区（proposal-tabs 行右侧）「批量操作/退出批量」同按钮二态：文案切换 + `aria-pressed={batchMode}` + active 类，点击在 enter/exit 间切换。
- L293-298 开放 tab（today/shelved）行 checkbox：由无条件渲染改为 `batchMode ?` 条件渲染。
- L335-339 dismissed（closed）行 checkbox：由 `tab==='dismissed'` 无条件渲染改为 `batchMode && batchSupported` 条件渲染。
- tab 切换 effect 与台账外部变更 effect 保持清空 checkedIds，但**不**退出 batchMode（模式由按钮状态保持，符合合同）。
- TDZ blocker（首轮实现发现、验收前已修复）：首版将 Escape effect 置于 `exitBatch` 声明之前，effect 依赖数组 `[batchMode, exitBatch]` 直接引用未初始化绑定，构成 temporal dead zone 引用；修复为当前顺序 —— `enterBatch`/`exitBatch`（L86-91）声明前置到该 effect（L135-144）之前，typecheck 与实机 Escape 行为均正常。

**styles-proposals.css**

- L45-64 新增 `.proposal-batch-toggle`：`margin-left:auto` 靠 tabs 行右侧，min-height 40px，`.active` 态 accent 下划线，不新增页面结构。
- L166-168 `.proposal-open-item` 常态改为无 checkbox 列（`display:grid;gap:8px` 单列）；仅 `.proposal-open-item.batch` 恢复 `28px minmax(0,1fr)` 双列，正文/卡片 extra 在 `.batch` 下 `grid-column:2`。

## Live matrix（实机，原生 Electron viewport，经现有实例 CDP 9374 接入）

台账真实数据：today 3 / shelved 5 / dismissed 13。全程未触发批量否掉/批量恢复业务命令，台账数据原样保留。

| 状态 | 1366×768 | 1100×760 |
|---|---|---|
| today 常态 | 0 checkbox、无批量条；grid 685 | 0 checkbox、无批量条；grid 419 |
| today 批量 | 3 checkbox；grid 28+649 | 3 checkbox；grid 28+383 |
| root 溢出 | 1366 == client 1366 | 1100 == client 1100 |

- 28+8+649 = 685、28+8+383 = 419：批量态仅比常态多 28px 复选框列 + 8px gap，正文宽度精确收缩；两态 root 均 `scrollWidth==clientWidth`，无横向溢出。
- today 批量勾选 1 条 → 批量条显示「已勾选 1 条」；点「清除勾选」→ 批量条消失、selection 0，但按钮仍 pressed true、3 checkbox 仍在（不退出模式）；按 Escape → pressed false、selection 0（退出批量，回常态 DOM）。
- shelved：常态 0 checkbox → 进入批量 5 checkbox → 勾选 1 条；切到 dismissed：保持 pressed true、13 checkbox、selection 0（tab 切换清选择、不退出模式）；adopted：无批量按钮、无 checkbox；回 today：仍 mode true（按钮 pressed 保持）；Escape 退出。
- 1100 截图人工确认：常态行无 checkbox、无空列占位；批量态 checkbox 与正文分列、无重叠。
- **F1 复验（1100×760，修复后实机）**：today 批量勾选 1 条 → 点「批量否掉」打开确认层（dialog true、pressed true、checked 1）→ 首次 Escape 仅关闭确认层（pressed true、checked 1、3 checkbox、批量条仍显示）→ 第二次 Escape 退出批量（pressed false、checked 0、0 checkbox、批量条消失）；全程 dismissPlanItem 未触发。

## Keyboard and visual

- **Tab**：实机仅验证 toggle 获焦后按一次 Tab，activeElement 变为首个 aria-label 为「勾选 {title}」的 checkbox；未逐项遍历后续焦点序列。
- **Escape**：批量模式下退出批量并清空选择（回常态 DOM）；确认层（`.app-confirm-root`）开启时首次 Escape 仅关闭确认层（F1 修复），再按一次才退出批量；监听仅批量模式挂载，非批量模式不拦截。
- **视觉**：批量按钮 active 态 accent 下划线 + 文案切换；行 checked 态沿用既有 `.checked` 样式；批量条按钮文案与 appConfirm 确认对话框不变。

## Commands

- `npm run typecheck`：PASS。
- `node scripts/smoke-renderer.mjs`：PASS —— `[wmb-smoke] ok http://127.0.0.1:27391/`（title WeMediaBuddy + `#root` 校验通过）。
- `scripts/check.ps1`（lightweight）：PASS —— required files、Pi operation Skill 策略索引、renderer port anchor、placeholder、500 行源文件上限、prototype split、task ledger（check-ledger）、idea intake（check-intake）、capability registry（check-capability-registry）全部通过。
- 环境说明：尝试新起 hub renderer 进程被拒（27391 已被真实 WMB 实例占用），随后经现有 Electron CDP 9374 接入完成实机验证 —— 属进程/端口既有状态，非产品失败。
- 按合同跳过 formatter/lint/build/测试套件；截图临时不入库（git status 无新增图片文件）。

## Impact

- **Capability registry**：no change —— 纯 renderer 可见性/交互调整，不触碰 registry。
- **Pi operator Skill**：no change —— checkbox 可见性为 renderer-only 表现层调整；`wmb_*` 工具、批量命令（dismissPlanItem/restoreProposal）、业务流程与 readback 契约均不变，按 docs/pi-operation-skill-maintenance.md 影响表属「纯视觉/可见性调整，正常无需更新」类。
- **业务命令零触发**：实机验证全程未执行批量否掉/批量恢复（无 dismissPlanItem/restoreProposal 调用），today3/shelved5/dismissed13 原样保留。
- **回归面**：单条否掉/恢复、行点击 Pi 焦点、主题跳转、分页/加载更多逻辑未改动；批量条按钮文案与确认对话框不变；adopted/expired 无 checkbox、无批量条（现状保持）。
- **文件面**：仅 `proposals-view.tsx` + `styles-proposals.css`。

## Risks

- **独立复审**：`ReviewWmb5136 — approved`，F1/F2 均 closed，无未决 findings。
- **TASKS 入账（已 done）**：TASKS.md WMB-5136 已置 done，Evidence 列含日期、证据路径、核心实机验收、typecheck/smoke/lightweight 与 Capability registry/Pi operator Skill/Independent review 四类回执（376 字符 ≤700）；Active tasks 仅保留 WMB-5130。2026-08-09 正式关闭入账。
- **批量命令未实机执行**：为不动真实台账，批量否掉/恢复仅验证勾选、批量条显隐与确认层开/关（Escape 关闭），未确认执行；业务命令（dismissPlanItem/restoreProposal）未触发，循环执行逻辑沿用既有未改代码，首次真实批量执行建议在非生产数据上复核。
- **截图临时不入库**：1100/1366 视觉为人工检查，临时路径不保留，后续如需可重新截图归档。
- **数据随真实台账变化**：today3/shelved5/dismissed13 为当日实机读数，行数会随时间变化，但模式行为不依赖具体行数。
