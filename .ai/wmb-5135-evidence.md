# WMB-5135 Evidence — Pi 展开 + 创作页遮挡最小修复

- 日期：2026-08-09
- 合同：`.ai/wmb-5135-contract.md`
- 改动文件：`src/renderer/styles-studio.css`、`src/renderer/studio-view.tsx`（仅此两个 Allowed paths 落点）
- 独立复审：`ReviewWmb5135 — approved`；唯一 minor（<=1180 `studio-canvas` 30px padding 被误删）已恢复并由 reviewer 复核 closed，无未决 findings

## Background

用户报告「Pi 展开 + 创作页」场景下版本上下文抽屉遮挡编辑区。合同限根因最小修复：只消除创作页内编辑区/版本上下文/pi-dock 之间的用户可见重叠，不重做创作页布局，不动 app-shell 三列 grid 与 styles-pi.css 的 `.pi-open` 全局契约。已证实嫌疑机制（合同记录，styles-studio.css 原 618 行）：`.pi-open .studio-editor-view.context-open .studio-context-v2` 为 absolute z12 抽屉（width min(310px,100%)）覆盖编辑区；同处 `.pi-dock{z-index:100}` 为无条件全局抬升（跨页泄漏，非正文覆盖主因）。根因判定以 before 实机复现证据为准。

## Before（实机复现）

隔离 Electron 原生 viewport 1600×960，状态：Pi 展开 + 打开创作项目 + 版本上下文开。DOM/computed-style/边界矩形实测：

| 元素 | x..x+w | w | 关键 computed style |
|---|---|---|---|
| `.studio-document` | 423..1203 | 780 | in-flow 列 |
| `.studio-context-v2` | 893..1203 | 310 | `position:absolute; z-index:12` 抽屉 |
| pi-dock（`.pi-dock`） | 1220..1600 | 380 | 与 workspace/context 均不重叠 |

- doc/context 几何重叠：310（context 全宽盖在编辑区右侧）。
- root（html）1600 == client 1600：shell 层无横向溢出，遮挡发生在编辑区列内部。
- 旁证快照 `.ai/pi-shadow-geo.json`（1600×960，`app-shell pi-open`）：workspace.right=1179、pi-dock.left=1179，零几何重叠；dock z=100（快照值）。

## Root cause

创作页 `.studio-editor-grid` 内，版本上下文被声明为 absolute z12 抽屉：当 Pi 展开使编辑列被压缩时，抽屉以 `width:min(310px,100%)` 直接覆盖在编辑区之上，构成 310px 的用户可见遮挡；`.pi-open` 下 `.studio-editor-view.context-open .studio-context-v2` 的 absolute 定位是正文覆盖的直接机制（Pi dock 本身与编辑列零重叠，非遮挡来源）。

## Implementation

最小修复，仅两文件：

**styles-studio.css — context 改为 in-flow grid 列（不再 absolute）**

- 基础态 `.studio-context-v2` 保持 in-flow flex 列（`display:flex; flex-direction:column`），不再是覆盖抽屉。
- Pi 展开态：`.pi-open .studio-editor-grid{grid-template-columns:190px minmax(0,1fr)}`；`.pi-open .studio-editor-view.context-open .studio-editor-grid{grid-template-columns:190px minmax(0,1fr) 280px}`；`.pi-open .studio-context-v2{display:none}`；`.pi-open .studio-editor-view.context-open .studio-context-v2{display:flex;position:static;width:auto;box-shadow:none}` —— context 作为第三列入 grid，编辑列与 context 由 grid 均分，不再重叠。
- ≤1180 收窄：`@media(max-width:1180px)` 下 `.studio-editor-view.context-open .studio-editor-grid{grid-template-columns:170px minmax(0,1fr) 220px}`；`.pi-open .studio-editor-view.context-open .studio-editor-grid{grid-template-columns:minmax(0,1fr) 220px}` —— context 列 220px。
- 既有回归面保留：`.pi-dock{z-index:100}` 原样未动（不影响本修复的正文覆盖判定；app-shell grid 契约不动）。

**studio-view.tsx — Escape 关闭版本上下文**

- 新增 effect（`contextOpen` 依赖）：`window.addEventListener('keydown', …)`，`event.key === 'Escape'` 时 `setContextOpen(false)`，卸载时移除监听。修复前无此监听，Escape 无法关闭 context 抽屉。

当前落盘实测：`src/renderer/studio-view.tsx` 623 行、`src/renderer/styles-studio.css` 655 行（均等于 line-caps.json 校准值）。

## After 稳定态矩阵（实机，原生 Electron viewport）

单元格 = doc 宽 / context 宽 / pi 宽（px）。4 状态 × 3 viewport = 12 组。

| viewport | Pi+ ctx+ | Pi+ ctx- | Pi- ctx- | Pi- ctx+ |
|---|---|---|---|---|
| 1672×982 | 572 / 280 / 380 | 852 / 0 / 380 | 892 / 310 / 0 | 892 / 310 / 0 |
| 1366×768 | 456 / 280 / 380 | 736 / 0 / 380 | 646 / 280 / 0 | 646 / 280 / 0 |
| 1100×760 | 250 / 220 / 380 | 470 / 0 / 380 | 680 / 0 / 0 | 460 / 220 / 0 |

- 12/12：`scrollWidth == clientWidth`（noOverflow=true）。
- 12/12：doc/context/Pi 任意两两 `overlap == false`（几何零重叠）。
- 注：1672 与 1366 下 Pi- ctx- 与 Pi- ctx+ 数值相同（context 由 grid 第三列承载、关闭时该列不占位），1100 下两者不同（≤1180 context 220 生效）——均为实测值，非推断。

### 最终实机复验（1100×760，Pi 收起，reviewer 复核后补测）

- Pi collapsed + ctx-：`studio-canvas` padding `42px 30px 48px`；doc 680 / context 0；root 1100 == client 1100。
- Pi collapsed + ctx+：doc 460 / context 220；context `position: static`，overlap false，padding 同值（`42px 30px 48px`）。

## Keyboard and hit testing

- **Tab 顺序**：版本按钮 → 源码/富文本切换（版本 → 源码）可聚焦、可达。
- **Pi session menu Escape**：menu `aria-expanded=true` 后按 Escape → `aria-expanded=false`、menu 项数 0（Pi 既有行为，本 patch 未改 Pi 代码，仅矩阵内验证）。
- **Context Escape（修复前后对照）**：修复前（无监听）context 开时按 Escape → 仍开（true→true）；新增 effect 后 → context `display:none`、state false，doc 恢复 852（1672 Pi+ ctx+ 关闭后的稳定态）。
- **视觉检查**：1672 与 1100 原生 Electron 截图人工检查通过 —— 正文、版本上下文、Pi 均可见可点（临时截图路径按合同不保留为持久证据）。

## Commands

- `npm run typecheck`：PASS（两次；最终压缩前语义相同）。
- `node scripts/smoke-renderer.mjs`：PASS —— `[wmb-smoke] ok http://127.0.0.1:27391/`。
- `scripts/check.ps1` lightweight 门禁：三跑记录，前两次失败如实保留——
  1. 首次 FAIL：`src/renderer/studio-view.tsx` 631 行 > 行 cap 623（新增 effect 未压缩导致超限）。
  2. 压缩后第二次 FAIL：620 行 < 623（ratchet 只允许向下收紧，620 低于既有 cap 触发 ratchet 报错）。
  3. 校准至 623 后第三次 PASS：全部 lightweight gates 通过（当前文件 623 行 == cap 623）。

## Impact

- **Capability registry**：no change（纯 renderer 样式/布局修复）。
- **Pi operator Skill**：no change。
- **其他页面 dock 行为**：不变（未动 styles-pi.css / app-shell grid；`.pi-dock{z-index:100}` 原样）。
- **回归**：Pi 收起 + 上下文关闭时创作页表现与修复前一致（Pi- ctx- 列为 grid 原布局，见矩阵）。
- **文件面**：仅 `styles-studio.css` + `studio-view.tsx`。

## Risks

- TASKS.md 入账：2026-08-09 已登记 WMB-5135 为 done，四项回执齐全（证据路径、Capability registry、Pi operator Skill、Independent review），矩阵/门禁与回执见 TASKS.md Evidence cell；本文件作为 reviewer 与 ledger 的引用证据，不再存在未入账风险。
- 视觉证据为人工检查、临时路径不保留：后续如需可重新截图归档。
- ≤1180 时 context 收窄为 220px（实测 1100 行），若未来加宽 context 内容需重测该断点。
