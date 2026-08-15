purpose: 创作项目库让主编用行空白建立 Pi 焦点、用标题进入具体稿件；本轮修复标题点击的事件路由。
fails-when: 同一真实项目库中，标题点击仍只切换选中，或空白点击改为打开项目。

Loop: WMB-5199-studio-title-opens-project
Symptom: 项目标题是行内非交互 `strong`，点击冒泡至行 `onClick`，只切换 Pi 焦点而不进入编辑器。
Observation packet: Electron `http://127.0.0.1:27391/`，1365×768、deviceScaleFactor 1.25；真实项目 21 条。改前空白点击后首行 `selected=true`；再点标题后 `selectedRows=0`、`library=true`、`editor=false`。
Hypotheses: 标题缺少独立打开处理器并冒泡到行选择处理器；代码与真实 DOM/事件结果共同确认。
Bug type: event-missing / event-routing。
Chain traced: `src/renderer/studio-view.tsx` 项目行 → `.studio-project-name` → 行 `onClick` / `onDoubleClick` → `onSelect(project.id)` → 真实项目编辑器。
Breakpoint: component event routing。
Root cause: `.studio-project-name` 使用非交互 `strong`，没有调用既有 `onSelect`；标题点击只能触发行选择。
Files read: `src/renderer/studio-view.tsx`、`src/renderer/styles-studio.css`、`tests/studio.test.mjs`、`tests/studio-child.mjs`。
Files changed: `src/renderer/studio-view.tsx`、`src/renderer/styles-studio.css`、`TASKS.md`、`.ai/frontend-debug-loop/state.json`、本报告。
Before/after gate: 改后同一 Electron、同一首行：标题元素为 `BUTTON`；点击标题后 `library=false`、`editor=true`，标题为“做 AI 副业最该先做的一步：先写出一份交付结果，找 10 个人问三件事，而不是先买会员搭工作流”；行空白点击仍仅 `selected=true`、`editor=false`。行聚焦时 Space 只切换选中，Enter 仍打开；标题聚焦时 Enter 打开。Vite overlay=false，page error=0，console error=0。截图 `J:/Users/yangda01/Temp/omp-sshots-15540ae33a971af1.webp`。
Owner check: user-blocked-on=标题无法直接打开；now-usable=标题鼠标/键盘均打开；real-data-or-state=真实 21 项项目库与真实 d34e790a 项目；loading-empty-error-states=未改数据加载、空态、错误态；v1-v2-baseline-preserved=空白选中、双击、行 Enter/Space、显式打开/归档/删除保留；regression-risk-checked=嵌套按钮键盘事件不再冒泡到行；would-user-return-this=no。
Result: 标题与行空白形成明确两级交互；`npm run typecheck` PASS，真实 Electron 用户路径 PASS。
State update: verified。
Clean completion: yes
Blocked reason: none
