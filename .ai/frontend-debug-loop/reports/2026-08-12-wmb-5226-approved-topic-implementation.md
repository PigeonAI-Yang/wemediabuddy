purpose: 主题详情让用户按“当前认识→真实资料→最近变化”理解主题，并通过四个产品页签进入资料、变化和版本。
fails-when: 正式 Electron 仍显示七章节导航、标题提前换行、来源预览缺失、页签失效或技术文案泄漏。

Loop: WMB-5226
Symptom: 已批准 HTML 尚未进入正式 renderer。
Observation packet: 1568×934，真实微 SaaS Topic/Wiki/source/receipt 数据。
Bug type: component DOM/style projection。
Chain traced: knowledge read model → LibraryTopicsView state → approved four-tab projection → DOM/computed layout → pixels/events。
Breakpoint: 正式主题详情仍消费旧七章节视觉投影。
Root cause: 设计概念与正式 renderer 未同步。
Files changed: `src/renderer/library-topics-view.tsx`、`src/renderer/styles-knowledge-topic.css`、`tests/wmb-5212-topic-wiki-renderer.test.mjs`。
Before/after gate: 标题 20px 单行；四页签 4/4 切换正确；概览 2 条真实来源；唯一主 CTA；overflowX=0；可见工程文案=0。
Proof: `J:/Users/yangda01/Temp/omp-sshots-1554e0df3fbcb9b1.webp`。
Owner check: compile/risk/error、深档案、版本恢复、Pi/创作/画布、dataChanged、键盘 1–7、真实数据保留。
Result: PASS；typecheck PASS；聚焦门禁 13/13 PASS。
Clean completion: yes
Blocked reason: none
