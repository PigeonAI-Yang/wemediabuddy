purpose: 修复 WeMediaBuddy 右侧残留阴影，同时恢复用户要求的原生无边框窗口边界。
fails-when: 资料抽屉关闭时仍在右侧向视口内扩散阴影，或原生窗口边界被错误移除。

Loop:
Symptom: `thickFrame:false` 去掉了原生窗口边界，但右侧阴影仍在。
Observation packet:
- url: Electron dev renderer via CDP
- viewport: 1600x960
- user action: 关闭资料抽屉，读取右侧 DOM；恢复 BrowserWindow 原生选项并重启；打开/关闭资料抽屉
- expected: 关闭资料抽屉无阴影；打开资料抽屉保留其出场阴影；原生窗口边界恢复
- actual before corrected repair: `.sources-panel` class 无 open，rect x=1600/right=2020，但 computed `box-shadow: -18px 0 44px rgba(0,0,0,.30)`，阴影从屏幕外向左扩散；`thickFrame:false` 时 native rect 与 DWM frame 对齐但原生边界消失
- dom selector: `.sources-panel`, `.sources-panel.open`, `.close-sources`
- computed style: closed shadow=none after fix; open shadow=`rgba(0,0,0,.3) -18px 0 44px 0`
- screenshot: `.ai/shadow-after-fix-right.png`
- console: 重启日志显示 main/preload bundle 成功

Hypotheses:
1. 原生窗口 DWM frame 是用户看到的阴影 — 被用户反馈和 DOM 像素证据否定；去掉原生 frame 后阴影仍在。
2. 关闭态的 sources-panel 仍绘制 box-shadow — confirmed；关闭态 rect 在视口外，但阴影延伸 44px 进入视口。

Bug type: dom-hidden / CSS paint leakage
Chain traced: Today view -> sources panel state -> transform translateX(100%) -> box-shadow paint outside transformed element -> right-edge pixels。
Breakpoint: `.sources-panel` 默认规则无论 open/closed 都设置 `box-shadow`。
Root cause: 关闭态只移动 panel，不关闭 shadow；视口外元素的阴影仍可绘制到视口内。

Files changed:
- `src/renderer/styles-workflow-today.css`: 默认 `.sources-panel` 改为 `box-shadow:none`；仅 `.sources-panel.open` 恢复 `-18px 0 44px rgb(0 0 0 / 30%)`
- `src/main/app-window.ts`: 恢复 `roundedCorners:true`、`thickFrame:true`；保留 `frame:false` 与 `hasShadow:false`

Before/after gate:
- closed before: `class=sources-panel`, `transform=translateX(100%)`, `shadow=-18px 0 44px rgba(0,0,0,.3)`
- closed after: `class=sources-panel`, `transform=translateX(100%)`, `shadow=none`
- open after: `class=sources-panel open`, `transform=translateX(0)`, shadow 保留
- closed again: shadow 恢复为 none
- native after restore: window rect=(912,216,1616,968)，DWM extended=(919,216,1602,961)，原生边界恢复

Owner check:
- user-blocked-on: 右侧阴影和原生窗口被误删
- now-usable: 真实窗口已重启；关闭资料抽屉不再泄漏阴影；原生边界已恢复
- real-data-or-state: 实际 Electron 窗口、真实 Today 页面与真实 drawer state
- loading-empty-error-states: 未改变业务数据链路
- v1-v2-baseline-preserved: 打开资料抽屉的阴影保留；原生窗口选项恢复
- regression-risk-checked: live click open/close 通过；main/preload bundle 成功；仓库 typecheck 的既有错误仍存在，未由本改动引入
- would-user-return-this: yes

Result: Correct root cause fixed; native window restored.
State update: completed after restart and closed/open/closed runtime gate.
Clean completion: yes
Blocked reason: none
