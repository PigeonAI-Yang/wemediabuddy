# WMB-5306 正文图片拖拽移动

## 目标

在 Studio 可视化编辑中，用户可把正文图片拖到目标段落上方或下方。位置调整进入现有 Markdown 正文历史，保存重载后不回退。工具条提供「上移 / 下移」键盘替代路径。

## 实现

- 可编辑 figure 使用原生 HTML drag-and-drop；历史版本和源码编辑不启用拖拽。
- 拖动时将最近的正文顶层块判断为目标，以指针所在块的上半区/下半区决定 before/after，并显示 accent 插入线。
- 靠近编辑画布上下边缘时自动滚动，支持长正文移动。
- drop 后直接调整富文本 DOM 顺序，再通过现有 `htmlToMarkdown()` 回写正文和撤销历史。
- 同一素材多次出现时，根据移动前的 `data-wmb-occurrence` 重映射核心媒体绑定，保持宽度、对齐、图注等绑定语义对应原图片实例。
- 平台正文继续复用既有 `syncPlatformBindingsForBody()` 对账。
- 图片工具条新增「上移 / 下移」，边界位置自动禁用；工具条限制在 Studio 文档列内，不遮挡 Pi dock。
- 源码编辑保持 Markdown 文本精确控制位置，不新增平行移动协议。

## 验证

- `node tests/e2e/runner.mjs --file tests/e2e/studio.test.mjs --scenario WMB-5305-studio-editor-modes-and-image-insertion`：PASS，1/1。场景已扩展覆盖 WMB-5306。
- 真实 Electron 验收：拖动第一张图片到 Markdown 二级标题下方；dragover 插入线为 `after`；DOM 顺序正确；工具条上移后回到标题上方、下移后回到标题下方；保存、重载和 SQLite 最新正文均保持两个图片 token 及移动后顺序；1100×800 横向溢出 ≤1px。
- `npm run typecheck`：PASS。
- `node --test tests/design-tokens-drift.test.mjs`：PASS，3/3。
- 视觉证据：`tests/e2e/.artifacts/WMB-5305-studio-editor-modes-and-image-insertion-3GxsWg/studio-inline-image-drag-position-screenshot.png`。
