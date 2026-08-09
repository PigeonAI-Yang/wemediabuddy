project-purpose: 全页面视觉整改必须在不污染用户真实 Electron 窗口的前提下验证页面间距与响应式行为。
target-surface: WeMediaBuddy 原生 Electron renderer、全部导航页面、页面/card spacing 与窗口自适应。
runtime-chain: native BrowserWindow bounds -> Electron webContents viewport -> renderer responsive CSS -> page/card DOM pixels。
completion-authority: 真实 Electron 内容铺满原生窗口，`devicePixelRatio=1`，`innerWidth/clientWidth` 与原生 content bounds 一致；逐页视觉状态无裁切、黑边或 letterbox。
focused-gate: 页面边缘与一级 card gap 采用 `--page-space`；真实 Electron 未残留 Chromium device metrics override。
budgets: 不改变用户窗口尺寸、缩放、BrowserWindow bounds 或系统 DPI；只读 DOM/computed style 可以直接在真实 Electron 执行。
runtime-safety: 禁止在用户正在使用的 Electron CDP target 上调用 `page.setViewport(...)`、`Emulation.setDeviceMetricsOverride` 或其他设备模拟。响应式多宽度验证必须使用不会共享真实窗口状态的独立可运行客户端；若 Electron preload 使独立浏览器不可运行，则改用原生窗口 resize 验收或只验证当前原生尺寸，不得用设备模拟替代。任何既有 override 必须先执行 `page.setViewport(null)`，并以 `devicePixelRatio=1`、`innerWidth≈outerWidth`、无黑边截图作为清除证据。
stop-conditions: 页面出现黑边/letterbox、`devicePixelRatio≠1`、`innerWidth` 明显小于 `outerWidth`，或验证步骤会修改用户真实窗口运行状态。
