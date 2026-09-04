purpose: 今日经营概况为今日页首屏核心经营概览，服务用户“一眼看清今日新资料/内容机会/进行中项目/近7日发布”。本轮推进链路 从数据源变更(today) → 指标拉取(getTodayOverviewMetrics) → 状态原子提交 → 组件渲染 → DOM/样式稳定 的运行时闭环，消除 1 帧 — 闪烁与跨日期旧值穿透。
fails-when: 高频采样出现 — 瞬态、或 distinctVals≠2（非原子一次切换）、或 .today-overview 高度跳变>2px、或 WeakRef 节点被替换、或 beforeunload/reload>0、或 planDate 竞态下旧日期值覆盖新日期。

Loop: 2026-08-24-today-overview-flicker-repair
Symptom: today-view.tsx:129-136 在依赖 [planDate, today] 的 effect 中同步 setOverviewMetrics(null) 后再异步回填，导致同日 today 变更时指标区 1 帧全部变 —；另未做请求序号与 planDate 身份校验，存在迟到响应或旧 planDate 值在新 planDate 下误展示的风险。
Observation packet:
- url: http://127.0.0.1:27391/ (Electron loadURL, src/main/app-window.ts:36) HMR 22:21:52 已热更新
- viewport: 1280x800 dpr1, overviewRect 642x196.75 h 稳定（采样 min 196.75 max 196.75 delta0）
- user action: 受控同日变更：向隔离库 wmb.db 插入 source_items(id s-verify-*) + BrowserWindow.webContents.send('data:changed', {scopes:['today','agent']}) 驱动 App.refreshToday → TodayView effect → getTodayOverviewMetrics(延迟 700ms 模拟 pending)；另合成 planDate 竞态 600ms vs 200ms；全程 20ms 高频采样 177 次（tmp/verify-today-fix.mjs）
- expected: pending 同日保留四值，resolved 原子切换一次；planDate 切换不暴露旧值；节点与高度稳定；无 — 瞬态、无 remount、无 reload
- actual: 初始 0|0|0|0 在 pending 前 28 个样本（~560ms）保持不变，resolved 后原子切换至 1|0|0|0，distinctVals [“0|0|0|0”, “1|0|0|0”] 仅 2，dashFlashes0 transientDash0 hasTransientDash false，sameNode true remount0 rerenders 仅一次切换，beforeunload0 reloads0，heightDelta0；planDate 竞态 old 600ms 被 seq 丢弃仅提交 new 200ms，stalePrevented true
- screenshot: .ai/frontend-debug-loop/reports/verify-today-fix-final.png (63.7KB, 1280x800, fullPage false, overview updatedAt 2026/8/24 22:24:36, 值 1/0/0/0)
- console: harness evidence.console 仅 Vite 连接与 React DevTools 提示，errors[] pageerrors[]，electronStderr 仅 DeprecationWarning
- network/ws: 无前端 fetch；仅 window.wmb IPC today:get / today:overview-metrics；本次经 DB 写入+broadcast 走真实链路，App.today JSON 去重后更新
- dom selector: .today-overview (today-command-bar.tsx:54) .today-layout app-shell .today-metric-value(4) .intelligence-bar；20ms 采样 weakSame true 全程，MutationObserver childList remount0
- computed style/layout: .today-overview display grid opacity1 height196.75px animation none transition all 稳定；grid-template 4 列；高度 20ms 采样 minH 196.75 maxH 196.75 delta0
- state/store snapshot: App.today 去重 (main.tsx:105) planDate 稳定；TodayView overviewMetrics 修复后 seq+planDateRef (today-view.tsx:128-153) filteredOverviewMetrics:137 running via useTodayRunningTransition(:92)

Hypotheses:
- hypothesis: 同日 today 变更同步清零导致 1 帧 — 是唯一局部闪烁源
  supports: code today-view.tsx:131 setOverviewMetrics(null) 紧接异步；TodayCommandBar unknown→— (today-command-bar.tsx:71)
  would_disprove: 修复后高频采样 dash0 且 distinct 仅 2
  next_check: 20ms 高频采样 3s 含 700ms pending 窗口
  result: 证实：修复前会闪，修复后 dash0
- hypothesis: 请求竞态/跨日期旧值可能覆盖新值
  supports: 依赖 [planDate, today] 双触发 + 网络/DB 延迟不定
  would_disprove: planDate 600ms vs 200ms 竞态仅提交 new
  next_check: 合成 seq 递增 + requestPlanDate 与 currentPlanDate 对比
  result: 证实：old 被丢弃，stalePrevented true

Bug type: timing-stale (时序/竞态导致的旧结果闪烁与穿透)

Chain traced:
- 期望 今日新资料/内容机会/进行中项目/近7日发布 → route today (main.tsx:410 TodayView) → API getToday/getTodayOverviewMetrics (ipc-today-studio-business.ts:41-42 workbench.ts:146/274) → App.today + TodayView.overviewMetrics(:128) + filteredOverviewMetrics(:137) → runView deriveTodayRunView(:158) → TodayCommandBar (today-command-bar.tsx:8-87) → DOM section.today-overview → computed grid → pixels
- 关键文件行 src/renderer/today-view.tsx:128-153 (修复后), today-command-bar.tsx:54/71, workbench.ts:274, ipc-today-studio-business.ts:41-42, preload.ts:458, styles-today-overview.css:1,8

Breakpoint: today-view.tsx:128-153 Effect 层。旧代码在每次 planDate/today 变化时同步 set null，未做请求身份与日期身份校验；修复归属该层，不在组件展示层或上游。

Root cause:
- 直接原因：useEffect 中 setOverviewMetrics(null) 同步执行 → 渲染 — → 异步回填，产生一帧闪。且 then/catch 仅判 active 未判 seq 与 planDate，导致迟到或旧日期响应可能覆盖。
- 设计原因：未区分“同日刷新保留旧值”与“跨日期切换清零防旧值”两种语义，也未引入项目已有 seq/requestId 模式（见 source-body 等多处）。

Files read:
- src/renderer/today-view.tsx:1-153, 350-500, 500-765
- src/renderer/today-command-bar.tsx
- src/renderer/styles-today-overview.css
- src/main/workbench.ts:274-375
- src/main/ipc-today-studio-business.ts:41-42
- src/preload/preload.ts:457-458
- docs/audits/2026-08-24-today-overview-flicker-audit.md
- .ai/frontend-debug-loop/state.json
- tmp/audit-today-flicker.mjs

Files changed:
- src/renderer/today-view.tsx (仅 128-153 区间，新增 overviewSeqRef + overviewPlanDateRef + 条件清零 + seq/cancelled/planDate 校验)

Before/after gate:
- before: today 变更 → 同步 null → — (1 帧) → 回填；高频 50ms 采样在 pending 窗口可见 —；错误时亦清零；跨日期迟到可能覆盖；证据见旧 audit-today-flicker-evidence.json（四指标 0|0|0|0 但同步 null 路径存在）
- after: 同日变更 → 保留旧值 0|0|0|0 直至新值 1|0|0|0 原子到达（28 样本 pending 0 变化，distinct 2，dash0，same true，heightDelta0）；planDate 变更 → 同步清零（刻意）且旧请求被 seq 丢弃；错误时保留旧值；证据 verify-today-fix-evidence.json (samplesCount 177, firstChangeIdx 28, height 196.75, remount0, beforeunload0, reloads0, stalePrevented true) + verify-today-fix-final.png (1|0|0|0 已渲染, 无 —)
- proof: tmp/verify-today-fix.mjs 高频 20ms 采样 177 次 + 600ms/200ms 竞态合成；运行于隔离 harness 真实 Electron + HMR 已生效的 WeMediaBuddy 构建；console 0 错误，node identity 与高度全程稳定

Owner check:
- user-blocked-on: 用户在今日数据源刷新时看到指标区闪 —，怀疑全页闪烁
- now-usable: 受控同日变更 3s 采样证明 pending 保留、原子切换、几何稳定，用户路径不再卡于闪烁
- real-data-or-state: 真实 IPC + 隔离库 DB 写入触发真实链路，0→1 真实指标，height 196.75 真实像素，stale 合成亦验证
- loading-empty-error-states: 同日 pending 保留旧值（非 —），planDate  pending 清零防旧值，错误保留旧值已覆盖；初始空值仍为 — 属预期
- v1-v2-baseline-preserved: 是，未改 styles-today-overview.css、brand token、TodayCommandBar 展示逻辑、key/animation/reload，仅改请求身份
- regression-risk-checked: 是，verify 0 dash 0 remount height0，HMR 更新已验证，未引入新依赖/动画/key
- would-user-return-this: no

Result: done

State update: .ai/frontend-debug-loop/state.json 已更新 active_loop 仍为 2026-08-24-today-overview-flicker，status done，observation_packet 与 last_gate 指向 verify-today-fix 3s 高频证据，attempts 2，clean_completion yes

Clean completion: yes
Blocked reason: 无
