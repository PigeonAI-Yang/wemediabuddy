purpose: 创作编辑器左上角应明确指向返回目的地；本轮把含混的复合文案统一为「创作库」。
fails-when: 编辑器仍显示「创作 / 项目库」，或点击新文案不能返回完整项目列表。

Loop: WMB-5200-studio-library-label
Symptom: 返回按钮自身写成「创作 / 项目库」，其后组件又渲染 `/ 当前项目标题`，形成重复且含混的层级。
Observation packet: 真实 Electron 编辑器、1365×768、项目 d34e790a；改前左上角为「创作 / 项目库 / 当前标题」。
Hypotheses: 复合文案重复承载了已由 `.crumb-sep` 表达的层级；组件只有一个返回动作，不是两个目的地。确认。
Bug type: component copy。
Chain traced: `StudioEditorTop` → `.studio-top-back` → `onBack` → 创作项目库。
Breakpoint: 返回入口文案。
Root cause: 单一返回按钮使用了两个目的地名称。
Files read: `src/renderer/studio-view-panels.tsx`。
Files changed: `src/renderer/studio-view-panels.tsx`、`TASKS.md`、`.ai/frontend-debug-loop/state.json`、本报告。
Before/after gate: 改前「创作 / 项目库 / 当前标题」；改后真实 DOM 为「创作库 / 当前标题」。点击「创作库」返回 21 条真实项目列表，`library=true`、`editor=false`。Vite overlay=false，page error=0，console error=0。截图 `J:/Users/yangda01/Temp/omp-sshots-15540cb022571af2.webp`。
Owner check: user-blocked-on=入口命名别扭；now-usable=单一目的地清晰；real-data-or-state=真实项目编辑器与 21 条项目库；loading-empty-error-states=未改；v1-v2-baseline-preserved=分隔符、项目标题、返回行为和布局不变；regression-risk-checked=真实点击回到项目库；would-user-return-this=no。
Result: 采用「创作库」，因为目标是完整项目库而非临时队列；`npm run typecheck` PASS，真实 Electron 返回路径 PASS。
State update: verified。
Clean completion: yes
Blocked reason: none
