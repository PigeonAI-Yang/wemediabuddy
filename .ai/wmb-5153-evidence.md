# WMB-5153 Evidence

## Root cause
- `.topic-home-toolbar` 先定义为 Grid，后续通用 `.library-topic-list-toolbar` 再次覆盖，搜索框独占整行。
- 审批动作位于卡片下半段；现场旧渲染/裁切后只剩“待你批准”状态标签。

## Delivered
- 主题搜索与状态筛选改为可换行 Flex；常规宽度同排，窄主区空间不足时自然换行。
- “待你批准”、紫罗兰“批准并生效”和高对比“驳回提案”统一放入卡片头部。
- 卡头只显示“主题整理建议（N 项）”与提交时间；原始长说明进入二级技术明细，默认不显示对象 ID。
- 冷重启当前开发实例，消除旧 HMR 页面残留。

## Verification
- `node --test tests/wmb-5152-topic-approval-ui.test.mjs tests/wmb-5150-topic-maintenance.test.mjs tests/wmb-5143-agents-instance-view.test.mjs`：27/27 PASS。
- `.ai/wmb-5152-ui-acceptance.mjs`（`WMB_ACCEPTANCE_OUTPUT_PREFIX=.ai/wmb-5153`）：1440 搜索/筛选同排；1100 合法换行；两档按钮真实可见、位于卡头、无横溢出。
- 同一实机验收真实完成批准、驳回、审批失败 alert、二级技术明细及原始 reason 展开读回。
- `npm run typecheck`、`scripts/check.ps1`、`scripts/smoke-renderer.mjs`、`git diff --check`：PASS；`styles-knowledge.css` 564/564。
- 截图：`.ai/wmb-5153-topic-1440.png`、`.ai/wmb-5153-topic-1100.png`。

## Review
- `wmb_5153_review`：实现 PASS；指出可见性验收假阳性，已补按钮真实尺寸/视口位置、工具栏换行关系、原始 reason 默认隐藏与展开读回。
- Capability registry impact: no change — renderer-only。
- Pi operator Skill impact: no change — 搜索、筛选与审批业务流程及工具协议不变。
