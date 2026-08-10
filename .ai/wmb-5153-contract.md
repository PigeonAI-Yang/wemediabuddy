# WMB-5153 Contract

## Route
Patch

## Goal
压缩主题首页工具栏，并让待批主题整理卡在首屏明确显示可点击的批准与驳回动作。

## Acceptance
- [x] 搜索主题与全部/活跃/观察/休眠筛选在空间足够时同一行，空间不足才自然换行。
- [x] “待你批准”保持状态标签；同一区域明确显示“批准并生效”和“驳回提案”按钮。
- [x] 原始长说明不再占据卡片头部，默认收进次级展开；主视图不显示对象 ID。
- [x] 1440 与 1100 实机按钮可见可点、无横向溢出，批准/驳回/错误路径保持。

## Allowed paths
- TASKS.md
- .ai/wmb-5153-contract.md
- .ai/wmb-5153-evidence.md
- .ai/wmb-5153-*.png
- .ai/wmb-5153-*.mjs
- .ai/wmb-5152-ui-acceptance.mjs
- src/renderer/library-topics-view.tsx
- src/renderer/topic-maintenance-ledger.tsx
- src/renderer/styles-knowledge.css
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
- 不改主题搜索逻辑、筛选逻辑、提案内容、审批事务、权限或 Today 呈报。

## Capability registry impact
no change — 仅调整既有主题首页与 Owner 审批组件的布局和可见入口。

## Depends on
WMB-5152

## Design / lock
none
