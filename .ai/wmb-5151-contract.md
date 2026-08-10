# WMB-5151 Contract

## Route
Patch

## Goal
按 Owner 指定顺序重排并压缩智能体班组页，消除分区碎片与垂直浪费。

## Acceptance
- [x] 班组概览成为页面第一块内容，五角色状态与既有交互不变。
- [x] 原顶部状态摘要、配置入口和派单表单压缩为第二块内容。
- [x] 活动实例与历史工单合并为一个连续组件，筛选、取消、续派与空态不变。
- [x] 1440 与 1100 宽度无横向溢出，实机截图通过。

## Allowed paths
- TASKS.md
- .ai/wmb-5151-contract.md
- .ai/wmb-5151-evidence.md
- src/renderer/agents-roster-view.tsx
- src/renderer/agents-roster-overview.tsx
- src/renderer/agents-roster-instances.tsx
- src/renderer/styles-agents.css
- src/renderer/styles-agents-overview.css
- src/renderer/styles-agents-instances.css
- tests/wmb-5143-agents-instance-view.test.mjs
- tests/wmb-5145-crew-multi-instance-acceptance.test.mjs
- tests/agents-roster-conflict.test.mjs
- scripts/line-caps.json

## Forbidden paths
- src/main/**
- src/shared/agent-capabilities.ts
- src/shared/page-authority.ts
- .pi/**
- skills/**
- package.json

## Non-goals
- 不改角色、权限、派工逻辑、任务投影、Pi 面板或设置页。

## Capability registry impact
no change — 仅 renderer 布局重排，不增加命令、角色或授权范围。

## Depends on
WMB-5143, WMB-5146

## Design / lock
none
