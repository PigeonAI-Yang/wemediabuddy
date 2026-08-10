# WMB-5156 Contract

## Route
Patch

## Goal
把主题变更明细从重复的前后主题清单精简为只呈现真实变化的一行式对照。

## Acceptance
- [x] 展开明细只显示发生变化的主题，不重复展示未变化主题。
- [x] 状态用“状态：持续关注 → 已归档”等完整语句表达，不渲染伪按钮式状态标签。
- [x] 仅调整关联内容时明确显示“主题状态不变，仅调整关联内容”。
- [x] 技术明细仍保留完整前后快照；审批、失效和权限行为不变。
- [x] 真实记录与 1440/1100 实机排版清晰、无横向溢出。

## Allowed paths
- TASKS.md
- .ai/wmb-5156-contract.md
- .ai/wmb-5156-evidence.md
- .ai/wmb-5156-*.png
- .ai/wmb-5152-ui-acceptance.mjs
- src/renderer/topic-maintenance-ledger.tsx
- src/renderer/styles-knowledge-topic.css
- tests/wmb-5152-topic-approval-ui.test.mjs

## Forbidden paths
- src/main/**
- src/preload/**
- src/shared/**
- .pi/**
- skills/**
- package.json

## Non-goals
- 不新增可点击状态、不改审批事务、不改失效提案终态或重提流程。

## Capability registry impact
no change — 仅精简既有变更明细的 renderer 表达。

## Depends on
WMB-5155

## Design / lock
none
