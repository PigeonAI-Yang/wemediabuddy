purpose: 创作页专项调查工作面需要让 Owner 一眼区分流程总状态、记者实时进度与一次性操作结果；本轮收口 renderer 的层级与反馈生命周期。
fails-when: 运行态仍重复出现「记者专项调查」、工单 ID 默认暴露、通用解释重复，或「已重新派记者」在 4 秒后仍占据页面。

Loop: WMB-5302 investigation status hierarchy
Symptom: 顶部状态、记者区标题、状态胶囊、解释文字和永久操作反馈重复表达同一运行事实。
Observation packet: Owner 1568×941 截图；真实模型为 `status=researching`，reporter 提供 round/status/jobId/startedAt/finishedAt。
Hypotheses: 单一组件把 workflow status、reporter status 与 mutation feedback 同时渲染为常驻主层信息。代码检查确认。
Bug type: component / DOM hierarchy and feedback lifecycle。
Chain traced: `investigation.get` / mutation result → `StudioInvestigationPanel` model → header status + reporter progress + feedback → DOM/CSS。
Breakpoint: `src/renderer/studio-investigation-panel.tsx` 的 `renderReporterCard()` 与 `feedback` state。
Root cause: reporter 卡再次使用流程名称和强调胶囊；通用解释与 header hint 重复；成功反馈没有清理生命周期。
Files changed: `src/renderer/studio-investigation-panel.tsx`; `src/renderer/styles-studio.css`; `tests/e2e/investigation.test.mjs`; task/loop evidence files。
Before/after gate: before 为 Owner 截图中的四重状态表达；after 中顶部保留流程总状态，记者区标题为「调查进度」，正文为「第 N 轮 · 调查中 · 开始时间」，完整工单默认收进「任务详情」，成功反馈 2400ms 自动消失。
Proof: `npm run typecheck` PASS；E2E syntax PASS；design token 3/3 PASS；真实 Electron `INV-001-studio-investigation-init-approve` PASS，覆盖运行态层级、默认收起工单详情、补派成功提示出现与 4 秒内消失、1100×800 横向溢出 0、page error 0。产物 `tests/e2e/.artifacts/INV-001-studio-investigation-init-approve-a1aHb8/`。
Owner check: usable-path=yes；real-data-or-state=yes；loading/empty/error baseline preserved；writer status styling preserved；双主题 token 未改；would-user-return-this=no。
Result: passed。
State update: WMB-5302 done。
Clean completion: yes。
Blocked reason: none。
