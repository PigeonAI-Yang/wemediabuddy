# 今日页「今日经营概况」间歇性全页刷新/闪烁 归因审计（含 2026-08-24 修复复验）

- 日期 2026-08-24 Asia/Shanghai（初诊 21:55，修复复验 22:24）
- 路由 today (src/renderer/main.tsx:410)
- 组件 今日经营概况 section.today-overview aria-label 今日经营概况 (src/renderer/today-command-bar.tsx:54 h2 今日经营概况)
- 运行表面 Electron BrowserWindow (src/main/app-window.ts:13) 加载 http://127.0.0.1:27391/ hub wemediabuddy pid 15852 HMR 22:21:52 已更新；观测在 WMB_ACCEPTANCE_USER_DATA 隔离 harness 实例完成
- 结论（初诊） not_causal（对全页刷新/路由重载/窗口重载不构成因果）；新组件仅在 today 变更时于指标区产生 1 帧 React 重渲染闪烁（— 占位），不产生 DOM remount/CSS 动画/route reload/window reload
- 结论（修复后）已修复：同日刷新 pending 保留旧值、resolved 原子切换一次；planDate 变更永不暴露旧日期值；节点与高度稳定；无 — 瞬态、无 remount、无 reload（见 §9）

可证伪：若为假，则应观测到 beforeunload>0 或 overviewWeak 节点被替换且 document.contains(old)==false 或 appShell 子树重建或稳态 viewTransitions 连续>0；三轮实测均未出现，且计算样式稳定，可直接推翻。修复后可被高频采样 dash>0 或 heightDelta>2 或 stalePrevented false 推翻。

## 1 Observation Packet

url http://127.0.0.1:27391/ location.href 观测期不变 无 page reload
viewport 1280x800 dpr1 (harness) overviewRect w642 h196.75 稳定
user action ①空闲 35s 静观 ②强制 window.wmb.getToday(planDate) ③点击 今日经营概况右侧 开始今日情报 (.today-overview .primary-button) 后静观 30-35s
expected 今日页静止与 running 态保持 today-overview 高度/透明度稳定 无白屏/路由切换/窗口重载
actual 未出现全页刷新：仅指标区重渲染 overviewSame true 全程 无 remount/ reload
screenshot .ai/frontend-debug-loop/reports/audit-today-flicker-t0.png audit-today-flicker-final.png audit-today-running-final.png audit-today-ui-final.png
console harness evidence.console 仅 Vite 连接与 React DevTools 提示 errors [] pageerrors []
network/ws 无前端 fetch 全部经 window.wmb IPC today:get (src/main/ipc-today-studio-business.ts:41) today:overview-metrics (:42) daily-intelligence；观测期 onDataChanged 0-2 次
dom selector .today-overview .today-layout app-shell .today-metric-value(4) .intelligence-bar；空闲35s overviewSame true remount0 rerender0 viewTransitions0 reloads0 dashFlashes0；强制变更后 vals 0|0|0|0 稳定 趋势4；运行态35s viewTransitions 2(仅启动) 稳态0 reloads0 overviewSame true
computed style .today-overview display grid opacity1 height196.75px animation none transition all 稳定 .today-layout display block height710px
state store App.today 经 JSON 去重 (src/renderer/main.tsx:105-110) planDate Intl en-CA Asia/Shanghai 稳定；overviewMetrics 状态 src/renderer/today-view.tsx:128 filteredOverviewMetrics :137；running useTodayRunningTransition (today-view.tsx:92) + task

## 2 组件与链路

today期望 今日新资料/内容机会/进行中项目/近7日发布 → route today (main.tsx:410 TodayView) → API getToday/getTodayOverviewMetrics (ipc-today-studio-business.ts:41-42 workbench.ts:146/274) → App.today + TodayView.overviewMetrics( :128) + filteredOverviewMetrics(:137) → runView deriveTodayRunView(:158) → TodayCommandBar (today-command-bar.tsx:8-87) → DOM section.today-overview → computed grid → pixels

关键文件行 src/renderer/today-command-bar.tsx:54 section today-overview :57 h2 ; today-view.tsx:128-136 指标拉取 setOverviewMetrics(null)+getTodayOverviewMetrics 137-149 纠偏 630-644 消费无key ; workbench.ts:274-375 聚合 ; ipc-today-studio-business.ts:41-42 ; preload.ts:458 ; styles-today-overview.css:1,8

ownership App shell (main.tsx/app-window.ts/index.ts) 仅 via refreshToday 间接触发；Today页面 (today-view.tsx) 拥有 setOverviewMetrics(null) 唯一闪烁点；今日经营概况组件 纯展示无定时器无key无reload；数据聚合 workbench 无定时器

## 3 全量刷新/轮询/定时器/key/reload 路径

1 App安全兜底 main.tsx:130-135 setInterval 120_000 refreshToday+refreshPublications 否
2 App事件驱动 main.tsx:125-129 onDataChanged today|agent → refreshToday 否
3 App可见性 main.tsx:136-141 visibilitychange → refreshToday 否
4 Today指标拉取 today-view.tsx:129-136 useEffect[planDate,today] setOverviewMetrics(null); getTodayOverviewMetrics 否但唯一局部闪烁源 (同步null→— 1帧)
5 Today机会纠偏 today-view.tsx:137-149 useMemo 否
6 Today Manager 5s轮询 today-view.tsx:324-365 setInterval 5_000 仅running 否
7 Today时钟 tick today-view.tsx:367-371 setInterval 1_000 仅running 否
8 Feed RAF today-view.tsx:174-210 requestAnimationFrame ~60fps 否
9 全局时钟 StatusClock main.tsx:33-36 setInterval 1_000 否
10 ViewTransition today-running-transition.ts:8-22 document.startViewTransition 仅running翻转时 全页cross-fade但观测仅启动2次稳态0
11 窗口重载 main/index.ts:738 webContents.reloadIgnoringCache 仅relaunch dev 否 观测0次
12 Vite HMR dev 27391 文件变更时 否
13 Retry reload agents-roster-view.tsx:237 window.location.reload 仅横幅点击 不在today
14 CSS styles-today-overview.css:1-21 无animation 过渡默认 否

key审计 TodayCommandBar无key App TodayView无key today-overview永不因key remount

## 4 判别

React重渲染 确实1帧 — 异步回填 高度不变 空闲/运行 dashFlashes 0
组件重挂 未发生 WeakRef same true remount0 appShell 0重建
CSS动画 未发生 animation none
路由重载 未发生 view today 稳定
窗口重载 未发生 beforeunload0 reloads0 href不变
数据轮询 存在但未达全页阈值 空闲 todayCalls0 metricsCalls0 运行亦0 因today未变
结论 唯一可误认为闪烁的是 today变更→同步null→回填 1帧 — 重渲染 非remount/reload/animation

## 5 假设证伪

H1 setOverviewMetrics导致全页remount 证伪 same true remount0
H2 120s/5s轮询致白屏 证伪 35s0调用 JSON去重
H3 ViewTransition间歇闪烁 证伪 稳态0次仅启动2次
H4 Feed RAF叠加致全页抖动 部分成立但不属overview因果

## 6 结论

全页刷新 not_causal 无reload/route/窗口路径  runtime reloads0 beforeunload0 overviewSame true height196.75稳定 可被 reloads>0 推翻
局部闪烁 contributes 仅today变更时 today-view.tsx:131 同步null致 — 约10-40ms 高度不变不扩散 采样50ms 60次 id空闲0次运行0次因隔离库无写入 可被 移除null后采样—消失 证伪
触发周期 仅App refreshToday 拉到不同today时 1次 空闲120s去重常0 运行态受dataChanged驱动最密为后端每次写入 5s轮询本身不直接触发 隔离实测35s 0次
是否根因 全页否 局部是

## 7 整改与修复（已落地 2026-08-24 22:21 HMR）

变更 src/renderer/today-view.tsx:128-153
- 新增 overviewSeqRef + overviewPlanDateRef
- 仅 planDate 变更时同步 setOverviewMetrics(null)（防跨日期旧值穿透）；同日 today 变更时保留旧值 pending
- 请求序号 seq + cancelled + requestPlanDate vs currentPlanDate 双重丢弃，保证迟到/旧日期响应不覆盖
- 错误分支不再同步清零，保留旧值

复用项目已有 seq/requestId 模式（见 source-body、知识库等多处），未新增依赖/动画/key/remount/reload/fallback，未改设计 token 与 TodayCommandBar 展示逻辑。

不应做 加key强制remount / reload掩盖 / 缩短120s / 加animation淡入

## 8 证据索引（初诊）

隔离证据 .ai/frontend-debug-loop/reports/audit-today-flicker-evidence.json audit-today-running-evidence.json audit-today-ui-evidence.json 及4png
代码行 见 §2-3
脚本 tmp/audit-today-flicker.mjs tmp/audit-today-ui.mjs 可复现
本报告初诊期只读诊断，未改源码/DB

## 9 修复后复验（2026-08-24 22:24，受控 today 变更 + 20ms 高频采样）

脚本 tmp/verify-today-fix.mjs（隔离 harness 真实 Electron + HMR 已生效构建）
- 触发：向隔离库 wmb.db 插入 source_items(id s-verify-*) + BrowserWindow.webContents.send('data:changed', {scopes:['today','agent']}) → App.refreshToday(JSON去重) → TodayView effect → getTodayOverviewMetrics(700ms 延迟模拟 pending)
- 采样：20ms 间隔 177 次持续 3s，记录 metric-value、高度、WeakRef 同一性、beforeunload、MutationObserver remount
- 结果：初始 0|0|0|0 在 pending 前 28 样本保持不变，resolved 后原子切换至 1|0|0|0；distinctVals [“0|0|0|0”, “1|0|0|0”] 仅 2，dashFlashes0 transientDash0 hasTransientDash false，sameNode true remount0 beforeunload0 reloads0 heightDelta0 (min196.75 max196.75)，firstChangeIdx 28 对应 700ms 延迟，符合保留旧值后原子切换
- 截图：.ai/frontend-debug-loop/reports/verify-today-fix-final.png (1280x800, overview 1|0|0|0 已渲染，更新于 2026/8/24 22:24:36，趋势 1 条 up，其余 0)
- 控制台：harness evidence.console 仅 Vite 连接与 React DevTools 提示，errors[] pageerrors[]，electronStderr 仅 DeprecationWarning
- DOM/样式：.today-overview display grid opacity1 height196.75px animation none transition all 稳定，grid 4列，高度 20ms 采样全程 196.75
- 状态/链路：App.today JSON 去重更新，TodayView overviewMetrics 经 seq+planDateRef 原子提交，filteredOverviewMetrics 已含新 approvedCount

planDate 竞态合成验证（同页内模拟）：
- 场景：planDate 2026-08-20 延迟 600ms 的旧请求与 2026-08-21 延迟 200ms 的新请求并发，后者先变更 currentPlanDate 并清零
- 结果：seq 丢弃旧请求，仅提交 value-B-newDate，stalePrevented true，finalCommitted 为新日期值
- 含义：迟到或旧 planDate 的响应永不覆盖新 planDate 的当前值，满足“不以错误日期展示旧值”

对比初诊：
- 初诊高频亦可见 dash0（因隔离库无写入未触发），但 code 路径同步 null 确为唯一局部闪烁源；修复后在真实受控变更下 dash 仍 0 且 pending 保留得到直接证据，height 与节点稳定性与初诊一致
- 触发周期：仅 App refreshToday 拉到不同 today 时 1 次（本次受控写入触发），空闲 120s 去重仍 0，运行态由 data:changed 驱动，5s 轮询本身不直接触发 — 已保持

最强证据（单条可推翻）：
- verify-today-fix-evidence.json samplesCount 177, firstChangeIdx 28, dashFlashes0, sameNode true, heightDelta0, stalePrevented true + verify-today-fix-final.png 1|0|0|0 原子切换；code diff today-view.tsx:128-153 seq+planDateRef；HMR 22:21:52 已生效 hub pid15852 未重启

## 10 证据索引（修复后）

新增隔离证据 .ai/frontend-debug-loop/reports/verify-today-fix-evidence.json (9.8KB, 177 样本) 及 verify-today-fix-final.png (63.7KB)
修复报告 .ai/frontend-debug-loop/reports/2026-08-24-today-overview-flicker-repair.md
循环状态 .ai/frontend-debug-loop/state.json (2026-08-24-today-overview-flicker, done, attempts2, clean_completion yes)
源码变更 src/renderer/today-view.tsx:128-153（唯一产品文件）
脚本 tmp/verify-today-fix.mjs 可复现
