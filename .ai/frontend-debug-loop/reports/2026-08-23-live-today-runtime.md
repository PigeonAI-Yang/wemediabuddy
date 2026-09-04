purpose: WeMediaBuddy Today 是每日经营的唯一入口，本轮修复用户当前真实窗口的运行时加载路径，使其呈现新单卡「今日经营概况」且不含旧「每日编排」「昨日迭代」，并满足新增的垂直间距与删行验收。
fails-when: 用户窗口仍加载旧 UI、Today 仍出现「每日编排」或「昨日迭代」、Settings 缺少每日自动化、Results 缺少复盘、间距仍贴线、或下方标题行仅隐藏但留空高度。

Loop: 2026-08-23-live-today-runtime
Symptom: 用户截图显示 Today 仍为旧三卡「当前显示最优可批选题 + 每日编排 + 昨日迭代」；期望为单卡「今日经营概况」，每日编排在设置、昨日迭代在结果。新增验收：1) 概况卡与下方双栏需有清楚垂直间距，不能贴线；2) 删除概况卡下边界正下方、右侧列表上方的那一整行说明/标题文字（红线标记），且不能仅隐藏留空高度。另有 supervised process `wemediabuddy` exit 255。

Observation packet:
- url: file:///J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar/.vite/renderer/main_window/index.html (WeMediaBuddy packaged, userData C:\Users\yangda01\AppData\Roaming\WeMediaBuddy)
- viewport: 1920x1032 (packaged window, remote-debugging-port 9335)
- user action: 启动后浏览 今日 → 设置 → 结果，观察 Today 是否仅有概况卡
- expected: Today 仅有「今日经营概况」含 4 指标与趋势，卡与下方双栏有明确间距（≥16px），无任何标题行在卡下与右侧列表之间；Settings → 每日自动化可见「每日编排」定时/自动/立即执行与结算；Results → 复盘可见「复盘」与「昨日迭代」队列
- actual (before): 进程 605136 加载的 app.asar 为 2026-08-22 23:26:52 (5669993 字节)，而源码 today-command-bar.tsx / today-view.tsx 已于 2026-08-23 00:33-00:40 修改为新概况卡，包未重建导致窗口仍旧。Today 内 gap 0px (ovBottom 315.625 / gridTop 315.625, spacing 0)，且 feed-list 顶部存在条件段 <p class="feed-context">今天暂无新资料，以下为最近有效入库</p> 位于概况卡下边界正下方、右侧列表上方，符合红线描述。
- screenshot (before): .ai/frontend-debug-loop/reports/today-before.png (306017 字节, 1920x1032)
- console: page error 0 (hub wemediabuddy 日志仅有 wmb-creature-walk.html 404 与历史 pi:chat TASK_SCOPE_BROADENED，不影响 Today/Settings/Results)
- network/ws: 无数据链路故障，属打包时效与布局层级问题
- dom selector: .today-overview (存在) / .today-grid (存在) / .feed-context (捕获前存在) / .today-main gap normal
- computed style/layout: .today-main gap normal, .today-overview marginBottom 0, .today-grid marginTop 0, 实测 spacing 0
- state/store snapshot: getTodayOverviewMetrics 正常，今日新资料等指标可渲染

Hypotheses:
- hypothesis: 源码已接通新概况卡但用户窗口执行路径仍指向旧构建产物 (J:\wmb-out\WeMediaBuddy-win32-x64\resources\app.asar)，且布局未设垂直间距、feed-context 行未被删除
- supports: app.asar 时间戳 2026-08-22 23:26 早于源码 2026-08-23 00:40；Win32_Process CommandLine 指向 J:\wmb-out\...\WeMediaBuddy.exe --app-path ...\app.asar --remote-debugging-port=9335；捕获 dom 显示 gap 0 与 feed-context 存在
- would-disprove: 若捕获的 renderer url 不是 J:\wmb-out 产物或 gap 已为 18px，则假设不成立
- next-check: 对比 app.asar 与源码 mtime，查询远程调试端点并测量 ovBottom/gridTop 与查询 .feed-context
- result: confirmed

Bug type: timing-stale (stale packaged artifact) + selector-wrong/render-guard (布局 gap 缺失与多余标题行未移除)

Chain traced:
- src/renderer/today-view.tsx: TodayView 渲染 TodayCommandBar (今日经营概况) + today-grid (today-opps + today-rail feed-list)，已移除旧 proposal-ledger-entry 但仍保留 feed-context
- src/renderer/today-command-bar.tsx: TodayCommandBar 已重构为今日经营概况 (标题、更新于按钮→每日自动化、4 指标 metrics、趋势 svg)
- src/renderer/styles-workflow.css: .today-main flex column 无 gap 导致贴线
- src/renderer/styles-today-overview.css: 概况卡样式独立，与下方间距由父容器决定
- src/renderer/settings-view.tsx: SettingsView daily-automation 引入 TodayDailyCycle
- src/renderer/results-view.tsx: ResultsView 内置 <TodayYesterdayIteration> 复盘区
- packaging: forge.config.ts outDir J:\wmb-out, app.asar + resources，hub 进程 wemediabuddy 托管

Breakpoint: 1) 运行实例指向旧构建 (packaged asar freshness) 2) 样式层 gap 缺失 3) 组件层多余 feed-context 行

Root cause:
- 主因：用户当前窗口由 hub 的 persistent 进程 wemediabuddy 以 J:\wmb-out\...\WeMediaBuddy.exe 启动，其 app.asar 未随 2026-08-23 源码重构更新，导致屏幕仍旧。次因：.today-main 未设 gap，概况卡与双栏贴线；today-view.tsx 中 feed-list 顶部条件渲染的 feed-context 行恰位于概况卡下边界与右侧列表之间，被用户红线标记，要求整行删除而非隐藏。

Files read:
- J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx
- J:/PigeonYang/WeMediaBuddy/src/renderer/today-command-bar.tsx
- J:/PigeonYang/WeMediaBuddy/src/renderer/styles-workflow.css
- J:/PigeonYang/WeMediaBuddy/src/renderer/styles-today-overview.css
- J:/PigeonYang/WeMediaBuddy/src/renderer/settings-view.tsx
- J:/PigeonYang/WeMediaBuddy/src/renderer/results-view.tsx
- J:/PigeonYang/WeMediaBuddy/forge.config.ts, package.json
- 进程与打包时间戳、CDP json、hub ps/logs

Files changed (2, ≤8):
- src/renderer/styles-workflow.css — .today-main 添加 gap: 18px (display:flex; flex-direction:column; gap:18px) 使概况卡与下方双栏有清楚垂直间距
- src/renderer/today-view.tsx — 删除 feed-list 顶部 <p class="feed-context">今天暂无新资料，以下为最近有效入库</p> 整行条件渲染，无残留高度 (非 visibility hidden)

Before/after gate (同一真实 packaged 路径、同一窗口尺寸):
- before: 进程 605136 (app.asar 2026-08-22 23:26) → spacing 0 (ovBottom 315.625 / gridTop 315.625)，feed-context 存在 (document.querySelector('.feed-context') === true)，Today 视觉贴线
- after: 重建后 app.asar 2026-08-23 01:24 (hub pid 591860 main, renderer 8864) → spacing 18 (ovBottom 268.75 / gridTop 286.75, gap 18px, rowGap 18px)，feed-context false，Today 仅有「今日经营概况」且无「每日编排」「昨日迭代」字符串；Settings 检查 daily-automation true 且含「每日编排」；Results 检查复盘 true 且含「昨日迭代」队列
- proof:
  - 进程命令行: J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe --remote-debugging-port=9335 --app-path="J:\wmb-out\WeMediaBuddy-win32-x64\resources\app.asar" --user-data-dir="C:\Users\yangda01\AppData\Roaming\WeMediaBuddy" (重新 packaged 后 pid 591860/8864)
  - renderer 入口: file:///J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar/.vite/renderer/main_window/index.html (CDP /json)
  - DOM 证据: document.includes('今日经营概况') true, !includes('每日编排' 在 Today) true, feed-context false, gap 18px
  - 截图: today-before.png (贴线) vs today-after.png (间距 18px, 无标题行) + settings-daily-automation.png (每日自动化) + results-review.png (复盘)
  - page error 0

Owner check:
- user-blocked-on: Today 旧三卡与贴线、红线标题行遮挡
- now-usable: Today 单卡概况 + 双栏清晰可点击，更新于按钮可跳转每日自动化，指标可跳转资料/机会/项目/发布，feed 滚动与 Pi 选择正常
- real-data-or-state: getTodayOverviewMetrics 真实指标 (今日新资料 42 等) 渲染，feed 来自真实入库
- loading-empty-error-states: feed 空时 empty-copy，blockers 空时不渲染，overview run 状态条与详情正常
- v1-v2-baseline-preserved: 未改 foundation token (#8b7cff, 墨夜, Inter, 56px topbar)、侧栏、Pi；仅改 today-main gap 与删一行
- regression-risk-checked: Today 不再含旧两组件，Settings/Results 迁移组件经真实点击验证
- would-user-return-this: no (间距清晰、标题行整行移除无空隙、三页面归属正确)

Result: done

State update: 已重建 J:\wmb-out 产物并通过 hub wemediabuddy 重启恢复正常窗口；gap 与删行修复已在真实打包窗口验证通过。

Clean completion: yes
Blocked reason: 无
