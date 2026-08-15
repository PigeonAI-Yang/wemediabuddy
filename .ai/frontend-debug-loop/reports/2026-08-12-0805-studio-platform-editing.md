purpose: 创作页的平台版本必须按平台、按版本独立进入共享文本编辑器，并允许人工修改保存；左栏同时明确区分文章纲要与内容版本。
fails-when: 点击不同平台仍看到聚合内容；平台标题或正文不可编辑保存；切换页签覆盖核心正文或未保存平台草稿；左栏分区同明度，或核心正文图标未与平台图标对齐。

Loop: WMB-5202-studio-platform-tabs
Symptom: X、小红书、公众号按钮原先都进入同一个聚合面板，平台版本只能查看，不能在核心编辑器中修改与保存。
Observation packet: 改前真实 Electron 中依次点击 X、小红书，内容标签均为 `X · thread / 小红书 · note / 小红书 · note`；`StudioTab` 只有一个聚合 `platforms` 值，renderer 对全部 `platformVersions` 执行 `flatMap`。
Hypotheses: 平台身份在左栏点击时丢失，且共享编辑器只有核心正文草稿与保存端点。两项均确认。
Bug type: component state + render selection + missing platform edit command path。
Chain traced: `StudioOutline` 平台按钮 → `platform:<id>` tab → `selectStudioPlatformVersion` → 独立 `StudioPlatformDraft` → 共享标题/源码/渲染编辑器 → `saveStudioPlatform` preload/IPC → 现有 `savePlatformVersion` → 项目详情与右栏版本读回。
Breakpoint: 平台限定页签、版本选择与草稿键。
Root cause: 所有平台按钮被压成同一状态，渲染端聚合所有平台版本；平台版本没有绑定共享编辑器，也没有 Studio 平台保存 IPC。
Files changed: `src/main/content.ts`、`src/main/ipc-today-studio-business.ts`、`src/preload/preload.ts`、`src/renderer/global.d.ts`、`src/renderer/studio-platform-tabs.ts`、`src/renderer/studio-view.tsx`、`src/renderer/studio-view-panels.tsx`、`src/renderer/styles-studio.css`、`tests/content-child.mjs`、`tests/studio-platform-tabs.test.mjs`、`TASKS.md`、`.ai/frontend-debug-loop/LOOP_PROFILE.md`、`.ai/frontend-debug-loop/state.json`、本报告。
Before/after gate: 改后真实隔离 Electron 中，X 首次打开标题/正文均为空；人工保存后 UI 显示 `X · 修订 1 · 已保存`、左栏 `X 1 个版本`，数据库读回 `platform=x / title=X 平台首版 / body=X 平台正文 · 人工创建 / revision=1 / format=text`。小红书可在右栏切换 `平台标题 v1 / revision 1` 与 `平台标题 v3 · 人工保存 / revision 2`，中央编辑器逐字读回各自标题和正文。公众号空白草稿输入后切回核心正文，核心仍为 `# 核心正文\n\n用于隔离验收。`；再次进入公众号，未保存标题与正文仍在。Vite overlay=false。
Visual gate: 黑夜主题文章纲要/内容版本背景分别为 `rgb(28,28,28)` 与 `rgb(19,19,19)`；白昼主题分别为约 `rgb(242,241,247)` 与 `rgb(249,248,252)`。核心正文与首个平台图标均为 17×17，左侧 x 坐标均为 254。黑夜截图 `J:/Users/yangda01/Temp/omp-sshots-15541e78a16337fa.webp`；白昼截图 `J:/Users/yangda01/Temp/omp-sshots-15541ef24f6337fb.webp`。
Focused verification: `node --test --test-concurrency=1 tests/studio-platform-tabs.test.mjs tests/studio.test.mjs tests/data-changed-studio.test.mjs tests/content.test.mjs tests/content-list-detail.test.mjs tests/content-scale-concurrency.test.mjs tests/content-version-project.test.mjs tests/content-lifecycle.test.mjs tests/content-project-create.test.mjs` → 13/13 PASS；`npm run typecheck` → PASS。
Repository-suite note: `npm test` 已尝试，但被任务外既有问题阻断：缺少 `.ai/wmb-5152-ui-acceptance.mjs`，以及 `wmb-5180-orchestration-acceptance.test.mjs` 仍断言旧的单行 `studio_draft` 信封源码结构。两项均不在 WMB-5202 产品链路内；本任务聚焦回归、类型检查与真实 Electron 验收全部通过。
Owner check: user-blocked-on=平台内容不能独立编辑且左栏层级不清；now-usable=逐平台、逐版本编辑保存，空平台可建首版，左栏分区与图标对齐清楚；real-data-or-state=隔离 SQLite 与真实 Electron；loading-empty-error-states=空平台与 revision 冲突路径保留；v1-v2-baseline-preserved=核心正文、来源、素材、发布边界不变；regression-risk-checked=核心/平台草稿隔离、版本切换、创建、更新、DB 绑定、两主题视觉；would-user-return-this=no。
Result: verified。
State update: verified。
Clean completion: yes。
Blocked reason: none。
