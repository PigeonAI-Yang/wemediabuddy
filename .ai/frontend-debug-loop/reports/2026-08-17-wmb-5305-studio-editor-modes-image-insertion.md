# WMB-5305 Studio 源码模式与图片插入修复

## 问题

Studio 的「源码」模式同时渲染只读 textarea 和 Markdown 预览，既不是可编辑源码，也与富文本模式重复。图片上传入口只在可视化工具栏出现；文件选择会让编辑器失焦，上传完成后再读取 selection 会丢失原光标。

## 根因

- `studio-view.tsx` 的 source 分支同时挂载 textarea 与 `.studio-live-false-body`，textarea 被设为 `readOnly`。
- 图片入口属于仅可视化模式显示的 `StudioFormatBar`，source 分支没有等价入口。
- `insertImageFile()` 在异步文件选择和导入结束后读取活动 DOM selection；此时 selection 已不再代表用户点击上传前的位置。
- 图片 Markdown 紧贴段内文字时不会被 `hoistAssetFigures()` 提升为正文 figure，因此模式切换后图片不可见。

## 决策与改动

- 模式名称收口为「源码编辑 / 可视化编辑」；两种正文 DOM 互斥。
- 源码模式只保留可编辑原始 Markdown textarea，并提供独立图片入口。
- 在打开文件选择器前捕获正文快照、源码 selection 或可视化 DOM 对应的 Markdown offset；上传完成后按书签插入，不依赖失焦后的 selection。
- 图片 token 自动补齐必要段落边界，保证它是独立 Markdown 图片段并可提升为 figure。
- 图片定位、正文内图片工具条、章节跳转统一只查询当前可视化编辑器 DOM；删除废弃 preview CSS。
- 顶栏按钮禁止换行，1100px 下「版本 / 源码编辑 / 可视化编辑 / 保存」保持单行。

## 验证

- `node tests/e2e/runner.mjs --file tests/e2e/studio.test.mjs --scenario WMB-5305-studio-editor-modes-and-image-insertion`：PASS，1/1。
- 真实 Electron 覆盖：源码 textarea 可见、可写、无重复预览；源码与可视化模式各从当前光标插入一张图片；两个 figure 立即渲染；保存重载后保留两个 `wmb-asset://` token；1100×800 页面/画布横向溢出 ≤1px。
- `npm run typecheck`：PASS。
- `node --test tests/design-tokens-drift.test.mjs`：PASS，3/3。
- 视觉证据：`tests/e2e/.artifacts/WMB-5305-studio-editor-modes-and-image-insertion-mnjjTB/studio-editor-two-mode-image-insertion-screenshot.png`。
- E2E runner 已退出；进程复核未发现测试专属 Electron/Chromium，保留的是用户原有 WeMediaBuddy 与 WeOMP 进程，未干扰。
