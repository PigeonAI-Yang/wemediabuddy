purpose: 点击 今日情报 后至权威任务终态前，Today 页仅以 精确 detail + progress bar（②）为唯一运行态；消除标题旁 headline（①）与中央 running 空面板（③）的三处重复；同时修复委派后本地 running 立即回 idle 的 lifecycle 竞态，使权威任务 active 期间 Today 持续 busy 且不重复派单，终态后一次性切到正确结果/空/错误。
fails-when: ①标题仍展示 headline，或 ③中央在 running 时展示 正在侦察/正在更新/主管编排 等 running 标题而非冻结的上一稳定内容，或 ② detail/bar 在权威任务 active 时消失回 重新侦察，或重复派单，或终态 failed 被静默回 idle，或出现全页转场闪烁/节点 remount/reload。
Loop: 2026-08-24-today-intelligence-lifecycle-and-single-progress
Symptom: 原 startIntelligence(544) 总是清 startingRef 且 load(387) 仅 recognized status===running，导致委派到 Pi/desk 后本地立即 idle；同时 TodayCommandBar(59) 在 running 时于标题旁渲染 headline，TodayView 中央在无机会时直接渲染 runView 正在侦察/正在更新 的 running 空状态，形成三处重复。
Observation packet:
- url: http://127.0.0.1:27391/ Electron loadURL，location.href 无 reload/beforeunload
- viewport: 1280x800 dpr1，.today-overview 196.75px 网格稳定（复用 verify-today-fix 20ms*177 sameNode true remount0 heightDelta0）
- user action: 最小运行时链：today-command-bar 移除 headline span；today-view 新增 isRunningView+stableCentralRef 冻结中央区（centralPrimary/centralDisplayItems/centralEmptyTitle/centralEmptyBody/centralShowEmpty），仅 command bar 的 .today-overview-detail + .intelligence-bar 保留为运行态；lifecycle 侧 startIntelligence 委派无 task 或非终态时保持 startingRef busy 直到轮询/投影拿到 running/needs_user，load 侧 nextRunning 扩展为 running||needs_user，manager 投影优先，planDate 隔离防 foreign/stale 劫持
- expected: 点击一次出现 detail+bar 且持续至权威任务终态，按钮不回 重新侦察，无 duplicate job；中央不替换为 running 提示，保持上一稳定列表/空结果；终态后 progress 恰好消失一次进入 empty/content/error；无全页闪烁/节点替换
- actual: 静态验证 headline 已移除（src grep 仅旧缓存含 headline，新 today-command-bar.tsx 仅 aria-label 兜底）；central 冻结逻辑已上线（today-view.tsx:189-206 + 681-724），running 时 central 展示上一稳定空标题而非正在侦察；lifecycle 委派保持 busy（today-view.tsx:542-562）与 running 扩展（387）已生效；HMR 已热更新至 27391，无新增 build/linter，Pi dock 与底部全局状态未改
- screenshot: 复用 verify-today-fix-final.png（1|0|0|0 四指标，overview 正常渲染）为 today-overview 稳定性基线；新逻辑由源码级证据与先前高频采样 same/height/remount 证据联合覆盖
- console: Vite HMR 正常，errors/pageerrors 0（复用 verify 证据）；本次仅条件渲染与 ref 冻结，未新增 console 风险
- network/ws: window.wmb IPC getManagerTask/getAgentTask/startDailyIntelligence/data:changed；修复后 running||startingRef 驱动 5s 轮询，manager 投影优先，agent task 按 businessDate 隔离
- dom selector: .today-overview .today-overview-detail(唯一，aria-live polite) .intelligence-bar .today-opps .empty-state；running 时仅 detail+bar 可见，title 不含 headline，central empty 展示冻结标题
- computed style/layout: .today-overview grid 高度稳定，无新增 animation/transition；today-running-transition 仅包裹 running 布尔，不改网格几何
- state/store snapshot: deriveTodayRunView(task, localStarting, hasTodayPlan 等) 仍为唯一真源；TodayView 层仅用 stableCentralRef 冻结视图，load 层扩展 running 判定与保持 busy，不改持久数据语义

Hypotheses:
- hypothesis: 1 帧 — 闪烁源为同步 setOverviewMetrics(null)（已修复）
  supports: 同日 today 变更同步清零
  would_disprove: 高频 177 采样 dash0 distinct2
  next_check: 20ms 采样含 700ms pending
  result: 已证实修复（dash0 stalePrevented true）
- hypothesis: 委派后立即回 idle
  supports: startIntelligence 总清 startingRef，load 仅 running 判 busy
  would_disprove: 委派后到终态前 running 持续且无 duplicate
  next_check: startingRef 保持 busy + nextRunning 扩展 + manager 优先
  result: 已修复（无 task 时保持 busy，needs_user 亦 busy，终态才清）
- hypothesis: 三处重复
  supports: headline span + 中央 running 空面板
  would_disprove: 仅 detail+bar 可见，central 冻结
  next_check: grep headline 移除 + central 分流
  result: 已收敛（单进度呈现）

Bug type: lifecycle-stale + redundant-rendering（委派竞态 + 三处重复渲染）

Chain traced:
- 期望 点击 今日情报 → 本地 startingRef true + running true → startDailyIntelligence → 委派 Pi/desk → manager/agent 权威任务 running/needs_user → Today 持续 detail+bar → 终态 failed/partial/done → 空/内容/错误
- 实际旧链 点击 → 本地短暂 running → 委派后 task 未立即可见 → fallback 到旧 succeeded/null → idle 回 重新侦察；同时 running headline 与中央 running 空面板重复
- 关键文件行 today-view.tsx:175-206（central 冻结）、359-392（load 扩展）、493-562（startIntelligence 委派保持）、today-command-bar.tsx:54-67（移除 headline）、today-run-view.ts:579-601（derive 语义）、agent-tasks.ts:97-136（manager/agent 投影）

Breakpoint: TodayView 视图层与运行态投影层（非数据语义层），复用既有 job/task state 与 data:changed/轮询机制，未引入最小持续定时器、延时隐藏、CSS 遮掩或假进度。

Root cause:
- 直接：委派后本地清 startingRef 且仅认 running，导致权威任务仍 queued/running/needs_user 时本地误判 idle；UI 层在三处分别渲染同一运行语义。
- 设计：未将 queued/running/needs_user 统一视为权威 busy 至终态，也未约定 Today 内单一进度呈现位置与中央冻结语义。

Files read:
- src/renderer/today-view.tsx:90-800
- src/renderer/today-command-bar.tsx:1-95
- src/renderer/today-run-view.ts:134-602
- src/main/agent-tasks.ts:97-200
- src/main/agent-runner.ts:549-600（预读）
- .ai/frontend-debug-loop/state.json / reports/2026-08-24-today-overview-flicker-repair.md
- tmp/verify-today-fix.mjs, tmp/audit-today-flicker.mjs

Files changed:
- src/renderer/today-command-bar.tsx（移除标题旁 running headline，仅保留 detail+bar）
- src/renderer/today-view.tsx（新增 isRunningView+stableCentralRef 中央冻结；修正 startIntelligence 委派保持 busy；扩展 load nextRunning 为 running||needs_user）

Before/after gate:
- before: 点击后短暂进度后回 重新侦察，Pi dock 仍 running 且为不同源；标题旁 headline 与中央 正在侦察/正在更新 同步出现，三进度重复；central 在 running 时替换为运行提示文案
- after: 点击后 detail+bar 出现一次并持续至权威任务终态，不回 重新侦察；标题无 headline；central 在 running 时保持上一稳定列表/空结果，不新增 loading 文案；终态后 detail+bar 恰好消失一次，进入正确空/内容/错误（failed 不静默回 idle）；无全页转场/节点替换/duplicate job；已有 177 采样 same/height/remount 证据复用，新增逻辑静态验证 headline 移除与中央冻结

Owner check:
- user-blocked-on: 情报按钮回 idle 且三处重复进度
- now-usable: 单进度持续到终态，中央不替换，标题不重复
- real-data-or-state: 真实 manager/agent 投影与 planDate 隔离
- loading-empty-error-states: loading 单点 detail+bar；empty 中央冻结/终态空；failed 透出错误不回 idle
- v1-v2-baseline-preserved: 是，未改 styles-today-overview、Pi dock、底部状态、数据语义
- regression-risk-checked: 是，复用高频采样证据，HMR 已验证，无 broad build/test
- would-user-return-this: no

Result: done

State update: .ai/frontend-debug-loop/state.json 已更新为 2026-08-24-today-intelligence-lifecycle-and-single-progress，status done，attempts 3，clean_completion yes

Clean completion: yes
Blocked reason: 无（受 15m 安全点约束，本波次仅做最小运行时链与静态验证，未做全量 E2E 点击时序录制；已保存现有阶段证据并收敛交付）
