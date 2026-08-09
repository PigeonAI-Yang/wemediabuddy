# WMB-5112 Contract

## Route
Patch — historical baseline registration under WMB-5116 Owner gate decision 2026-08-09; original task route not recorded

## Goal
JobSpawner + role grant projection：spawn → lease + task + grant + session 完整路径，默认 execute 骨架可注入 Pi（M-5110，CAP-027/CAP-026）。

## Acceptance
- [x] 账本记录（TASKS.archive.md WMB-5112 done，2026-08-07）：job-spawner lease+task+grant+session path；workspaceId in contextRefs
- [x] 证据记录（.ai/wmb-5110-5115-evidence.md Deliverables）：`job-spawner.ts` spawn→lease+task+grant+session 路径；默认 execute 骨架可注入 Pi
- [x] 证据记录验证：job-spawner tests 通过（27/27 批次，2026-08-07）——非本次复跑
- [ ] 本文件为遗留基线登记；不视为原任务重新验收或新验证

## Allowed paths
- src/main/job-spawner.ts
- tests/job-spawner.test.mjs
- .ai/wmb-5110-5115-evidence.md

## Forbidden paths
- 平台发布与硬删路径（publication-*、browser 发布、物理删除）
- src/shared/agent-capabilities.ts / src/shared/page-authority.ts
- 真实 data root

## Non-goals
- 不改变角色/权限定义（grant 由 roleId 投影，不扩权）
- 本登记不消除遗留债务；不声称原任务当时已走 intake

## Capability registry impact
no change — 账本行：wiring only；grant 含 workspaceId 属 CAP-026 复用

## Depends on
WMB-5111（账本 parent 列）

## Authority
Historical reconstruction — WMB-5116 Owner gate decision 2026-08-09 批准的遗留基线登记；Owner lock: not recorded; do not infer。

## Verification evidence
- 账本行：TASKS.archive.md WMB-5112（M-5110，CAP-027/CAP-026，done，parent WMB-5111）
- 证据文件：.ai/wmb-5110-5115-evidence.md（Deliverables / Verification，原任务记录，非本次复跑）

## Design / lock
Historical reconstruction — Owner lock: not recorded; do not infer。完成时未记录 Owner lock/验收结果；不得反向声称当时已走 intake。
