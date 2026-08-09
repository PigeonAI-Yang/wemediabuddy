purpose: Today 页把真实每日情报任务状态转成用户可判断、可操作的进度反馈；本轮让采集、整理判断、方案生成共享同一进度条，并移除无价值的班组工单入口。
fails-when: 任一 manager running phase 不渲染 `.intelligence-bar`，真实 report 状态降级为 idle，或 Today DOM 仍出现“班组 工单”按钮。

Loop: today-progress-unification
Symptom: 采集阶段已有进度条，主管进入整理/策划/report 后 Today 卡片只剩状态文案；页面另有“班组 工单 N”按钮，占位但不帮助完成今日方案。
Observation packet:
- url: Electron dev renderer `http://127.0.0.1:27391/`
- viewport: 1600x960
- user action: 打开今日页，观察真实 manager report running 卡片，扫描进度 DOM 和全部按钮。
- expected: scanning/judging/report 均使用同一个 `.intelligence-bar`；有 planned/processed 时显示确定比例，无计数时显示 indeterminate；不显示班组工单入口。
- actual before: `reports/2026-08-08-today-progress-unification-before.png` 中阶段反馈不统一，且存在班组工单入口。
- actual after: `reports/2026-08-08-today-progress-unification-electron.png` 中真实 report 卡片显示单一状态行和进度条；DOM 为 `data-mode=running`、`data-indeterminate=true`、`aria-label=正在生成方案`、`width: 36%`；按钮扫描 `hasWorkOrder=false`。
- console: 本轮未专门采集 Console；Electron DOM gate 未出现渲染异常。
- network/ws: 不依赖外网；状态沿既有 manager IPC 投影链路到 renderer。
- dom selector: `.today-command-state`, `.intelligence-bar`, `button`
- computed style/layout: 1600x960 截图中进度条可见，无裁切、重叠；Today 资料列表与 Pi dock 保持。
- state/store snapshot: `syncManagerTask/getManagerTask` 返回 manager `status=running`, checkpoint `status=waiting_human`, phase `report`；Today 投影保持 running。
Hypotheses:
- manager checkpoint phase 未进入 Today 的统一 running-phase projection。证伪条件：report DOM 仍无 bar 或 monitor_reporter/planner/report projection tests 失败。结果：确认。
- 班组工单由 Today 其他入口继续渲染。证伪条件：删除后按钮扫描仍命中。结果：否定，after DOM 为 false。
Bug type: mapping-wrong + render-guard。
Chain traced: manager IPC -> `src/renderer/today-view.tsx` manager/child snapshot -> `src/renderer/today-run-view.ts` phase/progress projection -> `src/renderer/today-command-bar.tsx` shared `.intelligence-bar` -> Electron DOM/pixels。
Breakpoint: manager checkpoint/legacy child 之前没有稳定投影成可被 `mapTaskToStep` 识别的 running snapshot；manager phase 分组与非终态判定不完整，导致后段阶段不能稳定消费 shared bar。
Root cause: generic daily task phase 和 manager checkpoint phase 是两套状态语义，但 Today projection 只完整覆盖前者；manager `waiting_human/report` 还可能因旧方案或 child 停止降级。无关的 Agents 工单入口同时被透传进 Today。
Files read: `src/renderer/today-view.tsx`, `src/renderer/today-run-view.ts`, `src/renderer/today-command-bar.tsx`, `src/renderer/main.tsx`, `src/renderer/styles-agents.css`, `tests/today-run-view.test.mjs`。
Files changed: `src/renderer/today-view.tsx`, `src/renderer/today-run-view.ts`, `src/renderer/today-command-bar.tsx`, `src/renderer/main.tsx`, `src/renderer/styles-agents.css`, `tests/today-run-view.test.mjs`。
Before/after gate:
- before: 同一 Today 路径下后段阶段缺少统一进度反馈，且显示班组工单。
- after: 真实 report/waiting_human 保持 running 并显示 indeterminate bar；manager child 有 `planned/processed` 时 projection 输出确定比例；Today DOM 无班组工单。
- proof: Electron screenshot + live DOM；`node --test --test-concurrency=1 tests/today-run-view.test.mjs` 22/22 pass。
- type gate: `npm run typecheck -- --pretty false` 仍有 16 diagnostics，全部位于六个未改的 `src/main/*` 文件；本轮 renderer 变更文件零 diagnostics。
Owner check:
- user-blocked-on: 后段阶段看不到进度、无法判断是否仍在工作。
- now-usable: 三组 running phase 共用进度条；真实 report 卡可见。
- real-data-or-state: 使用当前 manager IPC 状态，不是 mock。
- loading-empty-error-states: 既有 idle/partial/needs_user/failed/done projection tests 保持通过。
- v1-v2-baseline-preserved: dark Today 布局、资料列表、操作按钮与 Pi dock 保留；只删除指定班组工单入口。
- regression-risk-checked: phase mapping、waiting_human 非终态、determinate/indeterminate、按钮消失均有 focused gate。
- would-user-return-this: no。
Result: 统一进度条与按钮删除均通过真实 Electron gate。
State update: `.ai/frontend-debug-loop/state.json` -> `today-progress-unification`, `complete`。
Clean completion: yes
Blocked reason: none。全量 typecheck 的 16 个既有 main-layer diagnostics 单独记录，未用 suppress/fallback 处理，也不属于本轮 UI 范围。
