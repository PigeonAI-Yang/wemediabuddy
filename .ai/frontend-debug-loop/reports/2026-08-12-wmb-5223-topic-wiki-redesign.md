purpose: 主题 Wiki 服务当前认识读取与下一步行动；本轮修复从 read model 到 DOM/pixels 的视觉信息架构。
fails-when: 1183x871 下仍出现巨大空卡、日志墙、技术字段、多个紫色主 CTA 或横向溢出。

Loop: WMB-5223
Symptom: 标题与动作割裂，13px 级全屏横铺，空认识占大卡，四个空分区同权，版本与 migration 回执像技术日志。
Observation packet: 用户截图 Image #1；真实工作空间 Topic/Wiki 数据；目标 DOM `.topic-layout-detail .topic-wiki-page`。
Hypotheses: token 合规被误当作设计完成，未针对空数据做信息架构。
Bug type: DOM/style information architecture.
Chain traced: Topic/Wiki read model -> `library-topics-view.tsx` -> `styles-knowledge-topic.css` -> Electron pixels.
Breakpoint: 详情 JSX 分组、空态判断、回执/版本投影和 CSS 层级。
Root cause: 两列全宽 grid、巨大主面板、每段独立空态、内部 migration 文案直接投影。
Files changed: `src/renderer/library-topics-view.tsx`; `src/renderer/styles-knowledge-topic.css`。
Before/after gate: 1183x871；阅读列 903px；overflowX=0；唯一主 CTA「让 Pi 出选题方案」；七段导航保留；可见 migration/derived-from-legacy/sourcesTotal/sourcesKeptRaw/Method Finding=0。
Proof: `J:/Users/yangda01/Temp/omp-sshots-1554c10540d158bb.webp`。
Owner check: 真实数据；空态、failed/stale 原路径保留；完整档案、差异、恢复、去创作、画布入口不变。
Result: PASS。聚焦测试 12/12，typecheck PASS。
Clean completion: yes
Blocked reason: none
