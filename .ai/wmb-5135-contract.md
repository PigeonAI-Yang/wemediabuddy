# WMB-5135 Contract

## Route
Patch

## Goal
修复用户可见的「Pi 展开 + 创作页」遮挡，仅做根因最小修复，不重做创作页或 Pi。

## Acceptance
- [ ] Before 复现：用真实 Electron 原生 viewport，在用户报告状态（Pi 展开 + 打开创作项目 + 版本上下文开/关）记录 DOM/computed-style/边界矩形到 `.ai/wmb-5135-evidence.md`；复现不出遮挡则如实记录「未复现」，不得以推断充当事实。已证实事实（快照 `.ai/pi-shadow-geo.json`，1600×960，cls `app-shell pi-open`）：workspace.right=1179、pi-dock.left=1179，零几何重叠；dock z=100 为快照值。
- [ ] 根因最小修复：改动仅限 styles-studio.css（必要时 studio-view.tsx），消除版本上下文抽屉/编辑区/pi-dock 之间的用户可见重叠。已证实嫌疑机制（当前源码 styles-studio.css:618）：`.pi-open .studio-editor-view.context-open .studio-context-v2` 为 absolute z12 抽屉（width min(310px,100%)）覆盖编辑区；同处 `.pi-dock{z-index:100}` 为无条件全局抬升（跨页泄漏，非正文覆盖主因）。根因判定以 before 复现证据为准。
- [ ] 三 viewport（1672×982 / 1366×768 / 1100×760）× Pi 展开/收起 × 版本上下文开/关：均 scrollWidth==clientWidth（无横向溢出）；编辑区、上下文抽屉、pi-dock 命中与键盘可用（Tab 焦点、Esc 关闭）。
- [ ] 回归：Pi 收起、上下文关闭时创作页表现与修复前一致；其他页面 dock 行为不变（影响面记录在 evidence）。
- [ ] `.ai/wmb-5135-evidence.md` 落盘（before/after 快照与边界数据）；TASKS.md 行 done 回执（入账阶段）。

## Allowed paths
- `.ai/wmb-5135-contract.md`（本合同）
- `src/renderer/styles-studio.css`（根因修复唯一预期落点）
- `src/renderer/studio-view.tsx`（仅当最小修复需要 class/结构配合）
- `.ai/wmb-5135-evidence.md`（任务证据文件：before/after DOM/computed-style/边界快照）
- `TASKS.md`（未来入账用；本 Patch 只落合同，不登记）

## Forbidden paths
- `src/main/**`、`src/preload/**`、IPC/MCP（含 src/main/mcp.ts、agent-tasks.ts）
- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`（能力注册表/权限）
- `PRODUCT.md` / `PRD.md` / `SPEC.md` / `TECHNICAL_DESIGN.md`（产品合同）
- 其他 renderer 样式/组件：styles-pi.css、styles-foundation.css、legacy-studio-view.tsx、studio-view-panels.tsx 等
- 依赖文件（package.json、package-lock.json、node_modules 等）
- 真实 data root

## Non-goals
- 不重做创作页布局或 Pi dock（app-shell 三列 grid 与 styles-pi.css 的 .pi-open 全局布局契约不动）
- 不引入新组件/布局系统，不做遮挡之外的样式迁移
- 不改 main/IPC/MCP/能力注册表/产品合同；Pi operator Skill 零改动
- 不承诺未验证根因：absolute z12 抽屉为已证实嫌疑机制，根因以 before 复现证据判定
- 不把 stale served CSS 当当前源码：判断仅基于仓库当前 styles-studio.css（已核对 line 618）

## Capability registry impact
no change — 纯 renderer 样式/布局修复，不触碰 registry。Pi operator Skill impact: no change。

## Depends on
WMB-5122（已 done；owner studio-ui 与 WMB-5130 无文件重叠，独立 owner 并行施工避免同 owner 冲突）

## Design / lock
none
