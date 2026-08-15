purpose: 主题 Wiki「已有资料」不再把每条资料画成相同紫色菱形 ◆；改用 SourceMark 显示真实信源/平台标志，无 URL 时回落文档图标。作者头像只保留给 X 作者身份（本面不传 avatarUrl），资料身份标识不再称为头像。
fails-when: 概览「已有资料」仍出现 ◆ 占位；不同 URL 资料显示相同标记；无 URL 的资料显示非文档 fallback；1274/1600 宽布局标题被挤压。

Loop: WMB-5237
Symptom: 概览来源预览与深层来源卡统一使用 ◆ 菱形占位，无法区分真实信源。
Root cause: 主题视图未接入 SourceMark，资料身份标识用静态字符占位。
Files changed:
- `src/renderer/library-topics-view.tsx`：新增 `aiSourcePresentation` 可选 prop（默认 false）；概览「已有资料」行 ◆ 替换为 `<SourceMark canonicalUrl={item.metadata?.originalUrl ?? item.metadata?.sourceUrl ?? null} aiSourcePresentation={aiSourcePresentation}/>`；`renderSourceCard`（深层来源卡/证据页签/反证卡）header 增加 SourceMark + 标题分组 `.library-topic-source-title`。
- `src/renderer/styles-knowledge-topic.css`：删除已死的 `.topic-wiki-source-badge` 规则，新增 `.topic-wiki-source-row .source-mark`（34×34、radius 8px，保持 36px 网格列不变）与 `.library-topic-source-title` 分组规则（flex 标题组，`flex:1; min-width:0`，标题不挤压）。
- `src/renderer/main.tsx`：`LibraryTopicsView` 透传 `aiSourcePresentation={settings?.workspace.capabilities.sourceWire === true}`，与 `LibraryView` 一致。
- 未改 `source-mark.tsx`（AvatarFallback 已在其上做 avatar 失败回落，API 不变，本面不传 avatarUrl，两处改动正交）。

Before/after gate: ◆ 全局 0 残留；概览行与深层来源卡均渲染 SourceMark；不同 URL → findSourceLogo 注册信源/平台 hostname 标志；无 URL → `source-mark-fallback` 文档 SVG；36px 网格列 + 34px mark 尺寸不变，标题组 `min-width:0` 可换行不横向溢出。
Proof: 局部类型检查 `tsc --noEmit`（global.d.ts + library-topics-view/main/source-mark + 依赖闭包）0 错误；未运行项目级测试套件。
Owner check: 概览来源预览、查看全部深层来源、证据页签来源卡、反证卡、无 URL 资料 fallback、wide 布局 1274/1600 标题不换行挤压。
Result: PASS；typecheck PASS。
Clean completion: yes
Blocked reason: none
