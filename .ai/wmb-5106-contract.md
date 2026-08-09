# WMB-5106 Contract

## Route
Patch — historical baseline registration under WMB-5116 Owner gate decision 2026-08-09; original task route not recorded

## Goal
Safe capability_overlays settings UI（P2）：capability_overlays 迁移 v49 + set/list IPC + AgentsSettingsPanel 仅 disable 默认绑定 agentGrantable（M-5100，CAP-026）。

## Acceptance
- [x] 账本记录（TASKS.archive.md WMB-5106 done，2026-08-07）：capability_overlays v49；set/list IPC；settings AgentsSettingsPanel disable-only agentGrantable
- [x] 证据记录（.ai/wmb-5100-5106-evidence.md）：src/main/capability-overlays.ts + migration v49；settings safe overlays（disable default-bound agentGrantable only）
- [ ] 本文件为遗留基线登记；不视为原任务重新验收或新验证

## Allowed paths
- src/main/capability-overlays.ts
- src/main/db/late-migrations.ts（migration v49）
- src/renderer/agents-settings-panel.tsx
- .ai/wmb-5100-5106-evidence.md

## Forbidden paths
- 平台发布与硬删路径（publication-*、browser 发布、物理删除）
- src/shared/agent-capabilities.ts / src/shared/page-authority.ts
- 真实 data root

## Non-goals
- 不做特权扩展（仅 disable 默认绑定 cap，无 privilege expansion）
- 本登记不消除遗留债务；不声称原任务当时已走 intake

## Capability registry impact
updated — 账本行：overlays（capability_overlays v49 + set/list IPC）

## Depends on
WMB-5104, WMB-5105（账本 parent 列）

## Authority
Historical reconstruction — WMB-5116 Owner gate decision 2026-08-09 批准的遗留基线登记；Owner lock: not recorded; do not infer。

## Verification evidence
- 账本行：TASKS.archive.md WMB-5106（M-5100，CAP-026，done，parent WMB-5104/WMB-5105）
- 证据文件：.ai/wmb-5100-5106-evidence.md（Deliverables，原任务记录，非本次复跑）

## Design / lock
Historical reconstruction — Owner lock: not recorded; do not infer。完成时未记录 Owner lock/验收结果；不得反向声称当时已走 intake。
