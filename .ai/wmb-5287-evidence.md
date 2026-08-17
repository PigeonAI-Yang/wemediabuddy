# WMB-5287 Studio inline-image control persistence

## Root cause

`src/renderer/studio-view.tsx` 的富文本编辑器 ref callback 会在工具条点击引发失焦和父级重渲染后，以 `renderMarkdown(displayBody)` 重建 `#studio-body` 子树。该路径没有像既有回填 effect 与 `onBlur` 一样重新调用 `applyInlineLayout()`。新 figure 因此丢失 `data-wmb-width` / `data-wmb-align`，CSS 回到自然尺寸和居中；`coreMediaDraft` 实际未丢失，所以按钮状态与画面曾出现不一致。

## Repair

- ref callback 在 `innerHTML` 真正重建后立即执行 `applyInlineLayout(node)`。
- 不改变正文 Markdown token、绑定模型、保存 IPC、DB schema 或 CSS。
- 所有三条富文本 DOM 回填路径现在都在重建后投影当前权威绑定。

## Regression coverage

`tests/e2e/studio.test.mjs` 的 `ST-008-studio-image-editing` 新增完整链路：

1. medium/right 实际宽度与右对齐几何；
2. 点击 small/left 后实际 40% 宽度与左对齐；
3. 点击标题失焦并等待 1200ms，DOM 属性和几何不回退；
4. 重新选中后按钮 `aria-pressed` 与草稿一致；
5. 正文 token、alt、figure/img inline style 未被布局编辑污染；
6. 保存后 SQLite 最新 `content_media_bindings` 为 small/left；
7. 页面重载、重开同一项目后实际几何和按钮状态仍恢复；
8. 恢复 medium/right 后继续覆盖既有拖拽、裁切、替换、图注、移出及历史只读路径。

## Verification

- `pnpm run typecheck`: PASS
- `node --check tests/e2e/studio.test.mjs`: PASS
- `pnpm e2e --file tests/e2e/studio.test.mjs --scenario ST-008-studio-image-editing --max-parallel 1`: PASS, 1/1
- Electron artifacts: `tests/e2e/.artifacts/ST-008-studio-image-editing-4ALxSk/`
- E2E 创建的 Electron/Playwright 进程随 runner 退出；`hub ps` 未显示本次验收遗留进程。既有 `wemedia-buddy-app` 与 `omp.browser.headless` 在验收前已运行，未干扰或关闭。
