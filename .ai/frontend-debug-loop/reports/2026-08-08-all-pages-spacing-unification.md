purpose: 以用户红圈标注的 Today 卡片间距为全局基准，统一 WeMediaBuddy 所有页面的外边距、卡片间距和主要内容区节奏。
fails-when: 常规工作页的首个内容块不在 16px 页面内边距处，主要卡片集合相邻间距不是 16px，任一 1100/1366/1672px 视口出现文档横向溢出，或画布自由布局被误改成常规卡片流。

Loop: all-pages-spacing-unification
Symptom: 页面边缘、命令条、卡片集合和分栏面板分别使用 10/12/14/16/24/32px；用户红圈所示 Today 间距没有成为跨页面规则，造成同一应用内页面松紧不一致。
Observation packet:
- url: Electron dev renderer `http://127.0.0.1:27391/`
- viewport: 最终截图 1365x768@1.25；响应式门覆盖 1100、1366、1672px。
- user action: 逐页打开 今日、智能体、发现、选题、创作、发布、结果、主题、资料库、关系画布、设置；读取页面容器和一级卡片的真实 bounding rect/computed style。
- expected: 常规页面边缘与一级卡片间距统一为 Today 红圈基准 16px；特殊页面保留自身结构但固定 chrome 采用同一 16px inset。
- actual before: Today 主要间距已接近 16px，但 Agents 为 14/10/12px、Topic 为 24/14/12px、Workflow 为 24px、Studio 为 20px、Canvas toolbar 为 14/10px，多个页面同时存在局部覆盖。
- actual after: 九个常规页面 `padding=16px`、首块 `edgeX=edgeY=16px`；可见一级卡片 gap 数组全部为 16px。Canvas header/toolbar 为 16px；Settings 为居中 max-width，顶部 16px，窄屏始终至少保留左右 16px。
- screenshot: `reports/2026-08-08-all-pages-spacing-after.webp`
- console: 本轮未专门采集 Console；真实 Electron 逐页 DOM gate 全部完成，无渲染中断。
- network/ws: 纯布局修正，不依赖外网或数据 mutation。
- dom selectors: `.today-main`, `.agents-roster`, `.discover-page`, `.proposals-page`, `.studio-editor-view`, `.studio-library`, `.publish-page`, `.results-page`, `.topic-home`, `.library-page`, `.kc-header`, `.kc-board-toolbar`, `.settings-content-inner`。
- computed style/layout: 9 个常规页逐页实测通过；33 个 page×viewport 响应式检查 `failed=[]`，所有文档 `scrollWidth<=clientWidth`。
Hypotheses:
- 根因是每个页面各自维护 hard-coded gutter，导入顺序末尾再用覆盖修正。证伪条件：迁移到共享 token 后仍有页面出现非 16px 的外边距/一级卡片 gap。结果：确认根因；迁移后实测无失败。
- 所有页面都应直接套 `.page`。证伪条件：Canvas、Settings、Studio/Publish 的结构因此受损。结果：否定；这些页面保留专用容器，只消费共享 token。
Bug type: CSS contract drift + cascade override fragmentation。
Chain traced: `styles-foundation.css --page-space` -> 各页面所有者 stylesheet -> Electron computed style -> 页面/card bounding rect。
Breakpoint: 全局没有唯一页面节奏 token；相同语义在各 stylesheet 中独立写死，responsive 分支又二次覆盖。
Root cause: 视觉基准存在于 Today 页面，但未被编码成共享设计合同，页面级 CSS 演进后产生多套不可比较的 gutter。
Files changed: `src/renderer/styles-foundation.css`, `styles-workflow.css`, `styles-agents.css`, `styles-knowledge.css`, `styles-proposals.css`, `styles-workflow-library.css`, `styles-studio.css`, `styles-results.css`, `styles.css`。
Before/after gate:
- before: 页面/card gutter 分散为 10/12/14/16/20/24/32px。
- after: `--page-space: 16px` 为唯一一级页面节奏；常规页直接使用，Canvas/Settings 等特殊面只让适用 chrome 消费它。
- proof: 真实 Electron DOM/computed-style/bounding-rect 检查 + 最终截图；无 mock。
Owner check:
- user-blocked-on: 应用各页面卡片与边缘距离不一致，视觉上不像同一套系统。
- now-usable: 页面外边距、命令条下沿、一级卡片集合和主要分栏 inset 共享 16px 节奏。
- real-data-or-state: 使用正在运行的真实 Electron renderer 和当前数据。
- loading-empty-error-states: 本轮只改布局 token；逐页真实内容未出现裁切或横向页面溢出。
- v1-v2-baseline-preserved: Today 红圈间距作为基准；Canvas 保持自由画布，Settings 保持居中窄栏，Studio/Publish/Results 保持原结构。
- regression-risk-checked: CSS 在 1100/1366/1672px 的 33 个 DOM 检查为零失败，但该检查错误地在用户真实 Electron target 上调用 `page.setViewport(...)`，并残留 device metrics override；因此原验收执行方式不合格。
- would-user-return-this: yes；真实窗口随后出现缩放内容与右下黑边。已通过 `page.setViewport(null)` 恢复，见 `2026-08-08-electron-viewport-recovery.md`。
Result: spacing CSS 的 DOM 结果成立，但原运行态清理失败，不能视为 clean completion；恢复后的原生窗口另行验收。
State update: 后续由 `electron-viewport-recovery` 状态取代。
Clean completion: no（原轮）；recovery 轮完成后为 yes。
Blocked reason: none。
