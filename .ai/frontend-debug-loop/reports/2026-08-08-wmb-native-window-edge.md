purpose: WeMediaBuddy 无边框窗口在真实桌面上右侧出现暗边；本轮推进窗口原生边界到像素的用户可见链路。
fails-when: DWM extended frame bounds 仍比窗口 rect 缩进，或重启后右侧出现独立暗带。

Loop:
Symptom: 用户看到窗口右侧仍有阴影/暗边；Pi 收起和展开按钮高度不同。
Observation packet:
- url: Electron dev renderer via CDP
- viewport: 1600x960
- user action: 重启主进程，读取原生 HWND 边界；点击 Pi 收起/展开
- expected: 窗口内容铺满窗口；按钮两态尺寸一致；点击可往返
- actual before: HWND rect 1616x968，DWM extended frame 1602x961，左右各缩进 7px；页面 CSS 计算 box-shadow/filter 均为 none
- actual after: HWND rect 与 DWM extended frame 均为 1600x960；窗口 style 从 0x14c70000 移除 WS_THICKFRAME 后边界立即对齐
- dom selector: .pi-dock-toggle-rail, .pi-dock-toggle, .app-shell
- computed style: 两态 button rect/css 均 18x44px，box-shadow:none，filter:none
- console/network: 启动日志显示 main/preload bundle 成功；本轮未观察到 renderer 错误

Hypotheses:
1. Pi 按钮或 dock CSS 产生阴影 — 被 DOM computed style 和 renderer right-strip 排除。
2. Windows DWM 外框/可调整大小的 thick frame 产生 7px 非客户区 — 原生 SetWindowLongPtr 临时移除 WS_THICKFRAME 后 extended bounds 与 window rect 对齐，确认。

Bug type: dom-hidden/layout + native window frame
Chain traced: BrowserWindow options -> HWND style -> DWM extended frame -> desktop pixels；renderer CSS 仅负责按钮视觉。
Breakpoint: BrowserWindow 默认保留 thick frame，Windows DWM 在 frameless resizable window 外扩 7px。
Root cause: `thickFrame` 默认开启；`hasShadow:false` 只关闭 Electron shadow，不能去掉该原生 resize frame。
Files changed:
- src/main/app-window.ts: `roundedCorners:false`、`thickFrame:false`、`hasShadow:false`
- src/renderer/pi-dock.tsx: toggle 外层 rail 热区
- src/renderer/styles-foundation.css / src/renderer/styles.css: 两态统一 18x44px，去除按钮 shadow/filter/transform

Before/after gate:
- before: rect=(912,216,1616,968)，extended=(919,216,1602,961)，right/left inset=7px
- after: rect=(920,216,1600,960)，extended=(920,216,1600,960)，inset=0px
- 点击验收: `app-shell pi-open` -> `app-shell pi-collapsed` -> `app-shell pi-open`
- 尺寸验收: expanded/collapsed 均 18x44px；dimensionsEqual=true；两态均可点击

Owner check:
- user-blocked-on: 右侧暗边和 Pi 两态按钮尺寸不一致
- now-usable: 主进程已重启；原生窗口边界无 7px thick-frame inset；Pi 可往返
- real-data-or-state: 使用实际运行中的 Electron 窗口和真实 React state
- loading-empty-error-states: 未改变业务数据链路；本轮聚焦窗口边界和 dock 控件
- v1-v2-baseline-preserved: 仅关闭原生 thick frame；Pi 自身宽度拖拽逻辑未改
- regression-risk-checked: typecheck 仍有仓库既有 25 项、分布于 9 个文件；app-window 无新增诊断；启动 bundle 成功；需注意 `thickFrame:false` 会移除系统原生窗口 resize 边缘
- would-user-return-this: no

Result: Native edge fix and toggle sizing pass focused runtime gate.
State update: completed after restart and native HWND verification.
Clean completion: yes
Blocked reason: none
