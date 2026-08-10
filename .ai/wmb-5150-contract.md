# WMB-5150 Contract

## Route
Legislate

## Goal
交付资料员主题整理提案、桌助呈报、Owner 审批后原子生效的完整闭环。

## Acceptance
- [x] 资料员可创建新建/修改/合并/归档/归属迁移提案，提案前正式主题零写入。
- [x] Owner 驳回零业务写；批准一次事务生效；stale revision 整批零写入。
- [x] 合并迁移资料、选题、内容项目与复盘关系并归档旧主题，完整 readback 无旧引用。
- [x] Topic 显示完整台账，Today 显示待批摘要，桌助呈报且不要求 Owner 手工整理。
- [x] Agent 不能直接 apply/reject；capability/typecheck/focused tests/renderer smoke 通过。

## Allowed paths
- PRODUCT.md
- PRD.md
- SPEC.md
- PLAN.md
- TASKS.md
- docs/spark/2026-08-07-role-permission-design.md
- docs/spark/2026-08-10-topic-maintenance-approval-design.md
- .ai/wmb-5150-contract.md
- .ai/wmb-5150-evidence.md
- .ai/evals/EVAL-CAP-003.md
- src/shared/agent-capabilities.ts
- src/shared/page-authority.ts
- src/main/**
- src/preload/**
- src/renderer/**
- .pi/extensions/wmb-mcp/**
- skills/wemedia-buddy-operator/SKILL.md
- tests/**
- scripts/line-caps.json

## Forbidden paths
- package.json / package-lock.json / node_modules
- publication final-click and platform interaction paths
- runtime data roots
- unrelated WMB-5145 implementation files unless needed for non-conflicting compile integration

## Non-goals
- 通用审批引擎、权限配置 UI、自动批准、硬删除主题、新角色/云/多租户/平台 API。

## Capability registry impact
updated — `cap.library_organize` 增加主题提案命令；新增 Owner-only non-grantable topic decision capability/commands；role/grant/effective checks同步。

## Depends on
None（与 WMB-5145 不同 Owner、不同业务路径并行；共享文件由 Sol 串行整合）

## Design / lock
- Design: docs/spark/2026-08-10-topic-maintenance-approval-design.md
- Owner lock 2026-08-10:
  1. 资料员有权整理主题并形成类似选题台账的待批提案。
  2. Owner 批准后生效；桌助呈报，不把整理退回前端人工完成。
  3. Owner 明确“实施吧”，并确认自然语言实施指令有效，无需复制口令。
  4. Non-goals: 不自动批准、不硬删、不做通用审批或权限配置 UI。
