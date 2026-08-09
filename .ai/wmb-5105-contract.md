# WMB-5105 Contract

## Route
Patch — historical baseline registration under WMB-5116 Owner gate decision 2026-08-09; original task route not recorded

## Goal
lease roleId + pi:roster-status projection：WorkspaceRuntimeLease 携带 roleId，role-roster 提供 agents:roster-status，Agents 页 live poll 展示（M-5100，CAP-026/CAP-021）。

## Acceptance
- [x] 账本记录（TASKS.archive.md WMB-5105 done，2026-08-07）：lease.roleId；role-roster.ts；agents:roster-status IPC；page authority roleId
- [x] 证据记录（.ai/wmb-5100-5106-evidence.md）：lease roleId on WorkspaceRuntimeLease；src/main/role-roster.ts + agents:roster-status；Agents page live poll；page authority stamps roleId（desk/writer/librarian/reporter）
- [ ] 本文件为遗留基线登记；不视为原任务重新验收或新验证

## Allowed paths
- src/main/role-roster.ts
- src/main/workspace-runtime.ts（lease roleId）
- src/renderer/agents-roster-view.tsx（live poll）
- .ai/wmb-5100-5106-evidence.md

## Forbidden paths
- 平台发布与硬删路径（publication-*、browser 发布、物理删除）
- src/shared/agent-capabilities.ts
- 真实 data root

## Non-goals
- 不新增角色、不做权限编辑 UI
- 本登记不消除遗留债务；不声称原任务当时已走 intake

## Capability registry impact
updated — 账本行：runtime projection（lease roleId / roster IPC）

## Depends on
WMB-5103（账本 parent 列）

## Authority
Historical reconstruction — WMB-5116 Owner gate decision 2026-08-09 批准的遗留基线登记；Owner lock: not recorded; do not infer。

## Verification evidence
- 账本行：TASKS.archive.md WMB-5105（M-5100，CAP-026/CAP-021，done，parent WMB-5103）
- 证据文件：.ai/wmb-5100-5106-evidence.md（Deliverables，原任务记录，非本次复跑）

## Design / lock
Historical reconstruction — Owner lock: not recorded; do not infer。完成时未记录 Owner lock/验收结果；不得反向声称当时已走 intake。
