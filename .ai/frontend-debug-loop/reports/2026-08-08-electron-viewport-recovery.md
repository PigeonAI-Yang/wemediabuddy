purpose: 清除全页面响应式检查残留在用户真实 Electron target 上的 Chromium viewport override，恢复原生窗口铺满，并禁止同类破坏性验收。
fails-when: Electron 内容仍缩放在左上角、右侧/底部出现黑边、`devicePixelRatio≠1`、`innerWidth/clientWidth` 未恢复到原生 content bounds，或项目验收规则仍允许在真实 Electron 上调用设备模拟。

Loop: electron-viewport-recovery
Symptom: 用户截图显示应用按较小的固定 16:9 视口缩放在窗口左上角，右侧和底部出现大片黑色区域。
Observation packet:
- url: Electron dev renderer `http://127.0.0.1:27391/`
- actual before: 上一轮在真实 Electron CDP target 依次调用 `page.setViewport({1100...})`、`1366`、`1672`，最后错误地恢复为 `1365x768@1.25` 而不是释放 emulation；应用因此 letterbox。
- root evidence: `Emulation.clearDeviceMetricsOverride` 后 Puppeteer 仍保留其 viewport 状态；调用 `page.setViewport(null)` 后实时指标从 `inner=1365x768, outer=1785x1014, DPR=1.25` 变为 `inner=1769x1006, outer=1785x1014, DPR=1`。
- actual after: `documentElement client=1769x1006`, `scroll=1769x1006`，内容铺满原生窗口，无横向/纵向文档溢出和黑边。
- screenshot: `reports/2026-08-08-electron-viewport-recovery-after.webp`
- attempted isolation: 独立 headless Chromium 能打开 dev URL，但由于 Electron preload API 不存在，renderer root 为空，不能作为当前应用完整响应式验收客户端；已关闭，不影响真实窗口。
Hypothesis:
- CSS 自适应被全局 spacing 改坏。证伪：释放 Puppeteer viewport override 后，不修改 CSS 即恢复铺满。结果：否定。
- 真实 Electron target 残留设备模拟。证伪：`page.setViewport(null)` 后仍 letterbox。结果：确认并修复。
Breakpoint: 验收工具运行态，而不是应用布局代码。
Files changed: `.ai/frontend-debug-loop/LOOP_PROFILE.md`；纠正 `reports/2026-08-08-all-pages-spacing-unification.md` 的错误 clean-completion 记录；应用生产代码未改。
Prevention: LOOP_PROFILE 明确禁止在用户真实 Electron CDP target 上调用 `page.setViewport`/device metrics override；独立客户端不可运行时必须使用原生窗口 resize 或只验收当前原生尺寸，不能用设备模拟替代。
Owner check: 用户窗口已恢复原生自适应；真实运行内容铺满；没有通过重启或改 CSS 掩盖工具状态错误。
Result: viewport override 已释放，原生 Electron 视觉与尺寸指标通过。
Clean completion: yes
Blocked reason: none。
