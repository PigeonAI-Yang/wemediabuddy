purpose: 创作编辑器只承载创作动作，模型配置归设置页。
fails-when: 正文画布上方出现独立配图配置栏或模型输入，或者工具条无法启动配图。

Loop: WMB-5315
Symptom: 定稿配图控件横插正文区域，模型字段错误暴露在编辑器。
Observation packet: Owner 1568×941 截图；控件位于格式工具条与正文之间。
Hypotheses: WMB-5312 将运行参数与系统配置一起实现成独立 panel，破坏编辑器层级。
Bug type: layout-wrong / product-boundary-wrong。
Chain traced: 设置独立配图配置 → Studio 加载配置 → 工具条启动 → 配图运行反馈。
Breakpoint: `src/renderer/studio-view.tsx` 独立 `.studio-illustration-panel` controls。
Root cause: 模型配置和文档级运行参数没有按生命周期拆分。
Files changed: `src/renderer/studio-view.tsx`; `studio-view-panels.tsx`; `styles-studio.css`; `tests/e2e/studio.test.mjs`。
Before/after gate: Owner 截图 → 真实 Electron 1100×800；设置页模型入口可见，编辑器无模型字段/空 panel，比例/张数/动作在格式工具条；完整配图、重生、撤销、重载链 PASS。
Owner check: usable-path=yes；real-data-or-state=yes；empty-state=无运行不占空间；baseline=任务与持久化不变；would-user-return-this=no。
Result: PASS。
State update: done。
Clean completion: yes。
Blocked reason: none。
