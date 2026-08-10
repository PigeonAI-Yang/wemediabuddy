# WMB-5154 Contract

## Route
Patch

## Goal
删除主题审批首屏中重复的页面标题、台账标题和待批状态标签，保留直接决策动作与终态结果。

## Acceptance
- [x] 主题首页不再显示独立的“主题”大标题，页面可访问名称保留。
- [x] 审批组件不再显示“主题整理提案台账”标题，待批卡不再显示“待你批准”。
- [x] “批准并生效”“驳回提案”仍可见可点，批准、驳回和现场变化终态仍显示结果。
- [x] 1440 与 1100 实机无横向溢出，删除标题后间距自然。

## Allowed paths
- TASKS.md
- .ai/wmb-5154-contract.md
- .ai/wmb-5154-evidence.md
- .ai/wmb-5154-*.png
- .ai/wmb-5152-ui-acceptance.mjs
- scripts/line-caps.json
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
- 不改主题搜索、筛选、提案内容、审批事务、权限或 Today 呈报。

## Capability registry impact
no change — 仅删除既有 Owner 审批界面的重复文字与待批标签。

## Depends on
WMB-5153

## Design / lock
none
