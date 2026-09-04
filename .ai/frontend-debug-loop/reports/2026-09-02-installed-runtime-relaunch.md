purpose: 安装版必须从用户原有数据目录正常拉起，并展示已修复的今日选题布局。
fails-when: 安装目录启动后没有 renderer 页面，或次要选题列表仍保留空白高度。

Loop: installed-runtime-relaunch
Symptom: 替换单个 app.asar 后，主进程存在但窗口没有拉起。
Observation packet: 安装版仅有 main/GPU 进程，CDP page targets 为空；完整包运行时可正常创建窗口。
Hypotheses: 单独替换 app.asar 导致安装目录中的 Electron 运行时与打包资源不一致。
Bug type: runtime packaging mismatch.
Chain traced: packaged runtime -> installed app directory -> Electron main -> BrowserWindow -> renderer -> Today DOM/layout.
Breakpoint: 安装目录只更新 app.asar，没有同步完整打包运行时。
Root cause: 混合安装态；新 app.asar 与旧 executable/resources 组合无法创建 renderer 页面。
Files read: src/main/index.ts; src/main/app-window.ts; src/renderer/styles-workflow.css.
Files changed: 无新增生产代码；完整覆盖安装目录中的打包运行时。
Before/after gate: before CDP targets=[]；after 安装版页面 target=WeMediaBuddy，document.visibilityState=visible，次要列表 169.875px、单卡 167.875px、尾部间隙 1px。
Owner check: 用户窗口已拉起；真实用户数据目录；现有界面与数据保持；空白区已消失。
Result: complete.
State update: done.
Clean completion: yes.
Blocked reason: none.
