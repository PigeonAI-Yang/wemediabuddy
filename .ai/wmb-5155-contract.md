# WMB-5155 Contract

## Route
Patch

## Goal
修复主题审批台账在主题页纵向 Flex 中被压缩裁切，恢复真实提案正文、明细入口和失效说明的可见与可点。

## Acceptance
- [x] 真实失效提案的台账高度覆盖完整内容，不再被 `overflow:hidden` 裁切。
- [x] “资料员建议”“批准后影响”“查看完整变更明细”和失效说明均可见。
- [x] “查看完整变更明细”可点击展开，主题工具栏与主题卡保持原布局。
- [x] 不新增动作、不允许失效提案批准、不改审批事务与权限。

## Allowed paths
- TASKS.md
- .ai/wmb-5155-contract.md
- .ai/wmb-5155-evidence.md
- .ai/wmb-5152-ui-acceptance.mjs
- .ai/frontend-debug-loop/state.json
- .ai/frontend-debug-loop/reports/2026-08-10-wmb-5155-topic-ledger-clipping.md
- .ai/frontend-debug-loop/reports/2026-08-10-wmb-5155-*.png
- src/renderer/styles-knowledge-topic.css
- tests/wmb-5152-topic-approval-ui.test.mjs

## Forbidden paths
- src/main/**
- src/preload/**
- src/shared/**
- src/renderer/topic-maintenance-ledger.tsx
- .pi/**
- skills/**
- package.json

## Non-goals
- 不新增“重新整理”或其它流程，不改失效提案终态，不改主题搜索与卡片。

## Capability registry impact
no change — 仅修复既有 renderer 容器的 flex 收缩裁切。

## Depends on
WMB-5154

## Design / lock
none
