purpose: 今日（TodayView）是选题入口，承载经营概况与机会池；本轮推进 已安装包 0.3.0 点击“今日”即黑屏 的端到端可用性链路
fails-when: 安装包内点击 今日 后 DOM/layout 不可见、console 仍有 ReferenceError、或截图仍为黑窗/空 root；任一即未修好

Loop: 2026-08-25-installed-today-black-screen
Symptom: 安装版 WeMediaBuddy 0.3.0（%LOCALAPPDATA%\WeMediaBuddy\app-0.3.0）点击侧栏“今日”后出现 completely black window；其它路由（创作/发布等）未受影响，用户报告为 ground truth

Observation packet:
  url: file:///C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar/.vite/renderer/main_window/index.html (packaged, 非 Vite dev)
  viewport: 1280x800 (Electron 默认窗口), dpr 1
  user action: 优雅停止旧实例 → 以 --remote-debugging-port=9321 隔离诊断重启动已安装 exe（保留 data-root J:/PigeonYang/WeMediaBuddyData）→ CDP 连接 → 侧栏点击 今日
  expected: 展示正常 app-shell（topbar + sidebar + workspace.today-layout + today-overview 经营概况 + Pi dock），无 console 错误
  actual (before): 点击后 #root 被清空为 `<div id="root"></div>`，整窗黑屏；document.documentElement.outerHTML 仅剩空 root；body computed: background rgb(11,11,11) display block visibility visible opacity 1 — 非样式隐藏，是 React 树卸载；截图 .ai/frontend-debug-loop/reports/2026-08-25-before-black-today.png 8KB 全黑
  screenshot (before): J:/PigeonYang/WeMediaBuddy/.ai/frontend-debug-loop/reports/2026-08-25-before-black-today.png
  console (before): [] console, pageErrors: ["FermentingRail is not defined\nReferenceError: FermentingRail is not defined\n    at h4 (file:///C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar/.vite/renderer/main_window/assets/index-DIFRKd9p.js:194:11192)\n    at of (...) at R0 (...) at og (...) at Z1 ..."] — 唯一 fatal，首次渲染即抛，无其它 error
  network/ws: 无 fetch；仅 window.wmb IPC，同比 dev 的 getManagerTask/getAgentTask 等；非数据缺失
  dom selector (before): #root 存在但 innerHTML ""；.app-shell/.today-layout/.today-overview/.pi-dock 均 false；点击前 studio-mode 正常（app-shell pi-open studio-mode, --pi-open-width 337px）
  computed style/layout (before): body 未隐藏；app-shell 根被卸载故无 layout；非 dom-hidden / style 遮挡，实为 render-guard 层以上的 JS 异常导致整树卸载
  state/store snapshot (before): localStorage wmb.view=studio；点击后 wmb.view 仍 studio（未成功切换），today 任务/缓存无关

Hypotheses:
  - hypothesis: Vite 端口占用或 HMR 错误页导致黑屏（常见伪因）
    supports: 过去曾因 27391 端口被占导致加载错误页
    would-disprove: 检查 packaged URL 为 file://.../app.asar/... 非 http://127.0.0.1:27391，且 console 非 Vite overlay 而是 ReferenceError
    next-check: 读取 CDP page.url 与 pageErrors 类型
    result: 已证伪 — packaged url 为 file://app.asar，非 Vite；错误为 ReferenceError 非端口
  - hypothesis: CSS/主题变量丢失导致 body 透明/布局塌陷（dom-hidden / style）
    supports: 曾有主题 token 缺失导致白屏
    would-disprove: body computed style display block opacity 1 visibility visible；且 JS 有未捕获异常
    next-check: getComputedStyle(document.body) 与 pageerror 关联
    result: 已证伪 — body 样式正常，root 被 JS 异常清空
  - hypothesis: TodayView 内 FermentingRail/TodaySourceDetail 未定义导致渲染崩溃（render-guard）
    supports: 700+ 候选的 today-view.tsx diff 显示 HEAD 曾有 `import {FermentingRail,TodaySourceDetail} from './today-view-panels'`，而当前工作区该行被误删，但底部仍渲染 <FermentingRail> 与 <TodaySourceDetail>；打包后 index-DIFRKd9p.js:194 抛 FermentingRail is not defined
    would-disprove: 在已安装 asar 解包的 index-DIFRKd9p.js 中应能定位该引用，且源码补回导入后打包的新 bundle 不再抛错且今日可渲染
    next-check: 1) npx asar list 检查旧版包含 DIFRKd9p.js 且无 FermentingRail 定义；2) 源码恢复导入；3) 重建后验证新 bundle 与 CDP 无 error 且 today-layout 可见
    result: 已确认 — 旧包确实缺导入，新包 index-BJpTtnjX.js 1240622B 今日渲染正常

Bug type: render-guard (JS ReferenceError 导致 React 整树卸载，非 data-missing / mapping / state / style)

Chain traced:
  user expectation (点击 今日 展示经营概况) -> route/page (main.tsx App view=today -> TodayView) -> adapter/mapper (today-view.tsx TodayView 组件) -> component (today-view-panels.tsx FermentingRail/TodaySourceDetail) -> DOM (today-layout / today-overview) -> computed style/layout (grid, opacity 1) -> pixels/events (sidebar+Pi dock 可见)
  关键文件与消费位置:
    - src/renderer/today-view.tsx:13 import 断点（缺失）+ 773-926 render 分支 <TodaySourceDetail> / <FermentingRail>
    - src/renderer/today-view-panels.tsx:26 FermentingRail, 242 TodaySourceDetail 定义
    - src/renderer/main.tsx:410 TodayView 挂载
    - packaged: C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar/.vite/renderer/main_window/assets/index-DIFRKd9p.js:194:11192 (before) -> index-BJpTtnjX.js (after)
    - 安装壳: %LOCALAPPDATA%\WeMediaBuddy\app-0.3.0\WeMediaBuddy.exe

Breakpoint: src/renderer/today-view.tsx:13（import 层）— 组件层引用了未导入的 FermentingRail，导致生产包 ReferenceError，React 错误边界外未捕获，整棵 App 卸载，DOM 停留在空 #root，表现为黑屏

Root cause: 在将 today-view-parts.tsx 的 priorityGrade→resolvePropagationGrade 重构时，同步误删了 today-view.tsx 顶部的 `import { FermentingRail, TodaySourceDetail } from './today-view-panels'`（HEAD 版本存在，当前工作区丢失），但 render 路径仍使用 <FermentingRail>（today-layout 下半部分发酵轨道）与 <TodaySourceDetail>（资料详情覆层）。Vite dev 因 HMR 缓存/类型检查未阻塞，`npm run build` 亦无 tsc 门禁，Electron Forge 仍打包出带未定义引用的 index-DIFRKd9p.js；已安装的生产包首次渲染 今日 即抛 ReferenceError，触发 React 卸载，视觉即黑窗。仅 今日 触发（studio/publish 等不依赖该导入）。

Files read:
  - src/renderer/today-view.tsx (927行)
  - src/renderer/today-view-panels.tsx
  - src/renderer/main.tsx:410
  - src/renderer/styles-foundation.css / styles.css
  - forge.config.ts / package.json / vite.renderer.config.ts
  - installed app.asar: C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar (asar list/extract)
  - J:/wmb-out/make/squirrel.windows/x64/RELEASES & installer

Files changed (product, max 8, 本轮仅 1):
  - src/renderer/today-view.tsx — 恢复 `import { FermentingRail, TodaySourceDetail } from './today-view-panels';`（+1 行，位于 13 行，复用已有路径，无新依赖，不改 UI/样式/数据语义）
  - tests/today-installed-black-screen-regression.test.mjs — 新增行为回归测试（验证导入与使用共存，缺失则 fail；不计入 product 预算，但为唯一 gate 测试）
  - （loop 报告/state 仅维护状态，不计入 product）

Before/after gate (同一路径、同一 viewport、同一操作):
  before: 已安装 0.3.0 (app-0.3.0, index-DIFRKd9p.js 1173914B) — 以 --remote-debugging-port=9321 启动，CDP 点击 今日 → pageErrors[0]=FermentingRail is not defined，#root innerHTML=""，.today-layout false, .today-overview false, appShell 空，截图 8KB 黑窗
  after (新包): 同端口模型重建后安装覆盖 — installer J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe 782691840B SHA256 8A4A527C693B8386EFAD8E48B5BFC5CDDDCDC77338D5281F744BFE5374FA7A15，nupkg WeMediaBuddy-0.3.0-full.nupkg 787754822B，app.asar 5795725B (2026-08-25 14:18:42), renderer index-BJpTtnjX.js 1240622B — 以 --remote-debugging-port=9322 启动，CDP 点击 今日 → view 切换至 today，console [] pageErrors []，DOM: .app-shell.pi-open display grid, .today-layout true, .today-overview true display grid opacity 1, .sidebar true, .pi-dock true, workspace 含 today-overview 经营概况（更新于 2026/8/25 14:19:25）与 4 指标（今日新资料 402 较昨日 +163% 等），#root innerLen 2346396，body not hidden，executable path C:\Users\yangda01\AppData\Local\WeMediaBuddy\app-0.3.0\WeMediaBuddy.exe 且 URL 为 file://.../app.asar/... 无 Vite 依赖，截图 .ai/frontend-debug-loop/reports/2026-08-25-after-fixed-today.png 203KB 含 sidebar+今日内容+Pi dock
  proof: before截图+pageError栈 + after截图+DOM+零error + 安装物指纹（installer SHA256/路径、nupkg、app.asar）+ 可执行路径 + 无 Vite
  proof (额外): typecheck 无需；已在 packaged 上做像素级与 DOM 级双证据

Owner check:
  user-blocked-on: 安装后点 今日 即黑窗，无法查看经营概况与机会池，工作流阻断
  now-usable: 可用 — 点击 今日 稳定进入经营概况，指标与机会池可见，刷新/查看资料/选题跳转可用，无闪烁
  real-data-or-state: 真实 IPC 与已安装数据源（J:/PigeonYang/WeMediaBuddyData），非 mock；overview metrics 来自 getTodayOverviewMetrics 真实查询
  loading-empty-error-states: 已检查 — detail+bar 为唯一 running 态，中央区冻结上一稳定内容；empty 展示 genuine empty 文案；failed 透出 errorMessage，无静默回 idle
  v1-v2-baseline-preserved: 是 — 仅恢复缺失导入，未改 styles-foundation/brand token/Pi dock/布局/数据语义；未振动机皮
  regression-risk-checked: 是 — 新增回归测试 `today-installed-black-screen-regression.test.mjs`（2 用例 pass，缺导入则 fail）；已验证其它路由（studio）仍正常；未引入新依赖
  would-user-return-this: no — 黑屏已消除，owner 视角可放心交付

Result: 已闭环 — 单点导入缺失修复，生产包重建并覆盖安装，安装后像素与运行时双证据通过

State update: 已更新 .ai/frontend-debug-loop/state.json — active_loop=2026-08-25-installed-today-black-screen, status=done, clean_completion=yes, attempts=1

Clean completion: yes

Blocked reason: none

Deployment:
  build: npm run build (canonical, 单次) — 583s, 产物 J:/wmb-out/WeMediaBuddy-win32-x64 + J:/wmb-out/make/squirrel.windows/x64/
  installer: J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe (782691840B, SHA256 8A4A527C693B8386EFAD8E48B5BFC5CDDDCDC77338D5281F744BFE5374FA7A15)
  nupkg: J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy-0.3.0-full.nupkg (787754822B)
  app.asar: C:\Users\yangda01\AppData\Local\WeMediaBuddy\app-0.3.0\resources\app.asar (5795725B, 2026-08-25 14:18:42), contained renderer index-BJpTtnjX.js (1240622B)
  executable: C:\Users\yangda01\AppData\Local\WeMediaBuddy\app-0.3.0\WeMediaBuddy.exe (verified via Get-Process Path, 5 实例，PID 16556 为主)
  no-vite: URL file://.../app.asar/.vite/... 且 CmdLine 无 --remote-debugging-port 以外 Vite 相关，无依赖
  data-root: C:\Users\yangda01\AppData\Roaming\WeMediaBuddy\data-root.json {"path":"J:\\PigeonYang\\WeMediaBuddyData"} 未变更；J:/PigeonYang/WeMediaBuddyData 目录与 workspace-registry.json 保持原样

Diagnostics reclaimed: CDP browser closed (playwright-core disconnect), 截图与 evaluate 已落盘，诊断端口 9321 旧实例已 taskkill /F，当前 9322 实例保持运行供验收（用户 data-root 保留）

Hard stop: 本轮在 30 分钟硬止损内完成首次 package→install→verified（含 9m+ 的 Squirrel nuget/releasify），无二次 build
