# WMB-5157 Contract

## Route
Patch

## Goal
修复主题审批把无关资料的既有跨主题关系误判为现场变化，恢复无冲突提案的一次批准生效。

## Acceptance
- [x] 生成快照与批准校验使用相同的显式 `reassign.sourceId` 边界。
- [x] 目标资料或目标主题真实变化仍必须判为 stale，禁止无条件批准。
- [x] 资料员提案涉及的主题含其它资料、其它资料又关联第三主题时，无关关系不得阻断批准。
- [x] 原子写、回滚、Owner-only 决策与 Capability 注册表不变。
- [x] 独立数据库复现修复前 stale、修复后 approved，并读回实际关系与归档结果。

## Allowed paths
- TASKS.md
- .ai/wmb-5157-contract.md
- .ai/wmb-5157-evidence.md
- .ai/wmb-5152-ui-acceptance.mjs
- .ai/wmb-5157-*.png
- .ai/frontend-debug-loop/state.json
- .ai/frontend-debug-loop/reports/2026-08-10-wmb-5157-false-stale.md
- src/main/topic-maintenance.ts
- tests/wmb-5150-topic-maintenance.test.mjs

## Forbidden paths
- src/renderer/**
- src/preload/**
- src/shared/agent-capabilities.ts
- src/shared/page-authority.ts
- .pi/**
- skills/**
- package.json

## Non-goals
- 不复活已经终态 stale 的旧提案，不放宽真实目标冲突，不新增自动批准。

## Capability registry impact
no change — 修正既有审批校验边界，不新增命令、角色或授权。

## Depends on
WMB-5156

## Design / lock
none
