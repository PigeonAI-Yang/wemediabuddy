# WMB-5152 Contract

## Route
Patch

## Goal
把主题整理审批台账改成主次动作明确、面向主编表达且默认不暴露内部语义的审批组件。

## Acceptance
- [x] 待批提案的“批准并生效”为紫罗兰强调色主按钮，“驳回提案”为清晰可见的次按钮，只有处理中才呈禁用态。
- [x] 主视图按建议、影响和审批结果组织，不显示 `proposed`、revision、对象 ID、`topic_id` 或 relation 等内部语义。
- [x] 完整变更默认折叠；技术 ID 与原始关系仅在二级“技术明细”展开中出现。
- [x] 1440 与 1100 宽度无横向溢出，错误提示仍以 `role="alert"` 可见。

## Allowed paths
- TASKS.md
- .ai/wmb-5152-contract.md
- .ai/wmb-5152-evidence.md
- .ai/wmb-5152-*.png
- .ai/wmb-5152-*.mjs
- src/renderer/topic-maintenance-ledger.tsx
- src/renderer/styles-knowledge-topic.css
- tests/wmb-5152-topic-approval-ui.test.mjs

## Forbidden paths
- src/main/**
- src/preload/**
- src/shared/agent-capabilities.ts
- src/shared/page-authority.ts
- .pi/**
- skills/**
- package.json

## Non-goals
- 不改主题提案生成、审批事务、权限、状态机、Today 呈报或 Pi 操作流程。

## Capability registry impact
no change — 仅调整既有 Owner 审批组件的展示和样式，不新增命令、角色或授权范围。

## Depends on
WMB-5150

## Design / lock
none
