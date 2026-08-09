# WMB-5114 Contract

## Route
Patch — historical baseline registration under WMB-5116 Owner gate decision 2026-08-09; original task route not recorded

## Goal
Agents 页工单看板 + 派单 UI；今日 command bar「班组工单」chip → agents（M-5110，CAP-027/CAP-021）。

## Acceptance
- [x] 账本记录（TASKS.archive.md WMB-5114 done，2026-08-07）：AgentsRosterView 派单/取消/槽位；today command bar 班组工单 chip
- [x] 证据记录（.ai/wmb-5110-5115-evidence.md Deliverables）：Agents 页工单看板 + 派单 UI；今日 command bar「班组工单」chip → agents
- [x] 账本独立审查记录：historical — not recorded before receipt gate
- [ ] 本文件为遗留基线登记；不视为原任务重新验收或新验证

## Allowed paths
- src/renderer/agents-roster-view.tsx
- src/renderer/today-command-bar.tsx
- .ai/wmb-5110-5115-evidence.md

## Forbidden paths
- 平台发布与硬删路径（publication-*、browser 发布、物理删除）
- src/shared/agent-capabilities.ts / src/shared/page-authority.ts
- 真实 data root

## Non-goals
- 不做权限开关 UI（5106 范围）
- 本登记不消除遗留债务；不声称原任务当时已走 intake

## Capability registry impact
no change — 账本行：renderer UI only

## Depends on
WMB-5113（账本 parent 列）

## Authority
Historical reconstruction — WMB-5116 Owner gate decision 2026-08-09 批准的遗留基线登记；Owner lock: not recorded; do not infer。

## Verification evidence
- 账本行：TASKS.archive.md WMB-5114（M-5110，CAP-027/CAP-021，done，parent WMB-5113）
- 证据文件：.ai/wmb-5110-5115-evidence.md（Deliverables，原任务记录，非本次复跑）

## Design / lock
Historical reconstruction — Owner lock: not recorded; do not infer。完成时未记录 Owner lock/验收结果；不得反向声称当时已走 intake。
