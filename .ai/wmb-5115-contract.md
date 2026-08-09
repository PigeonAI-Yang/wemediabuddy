# WMB-5115 Contract

## Route
Patch — historical baseline registration under WMB-5116 Owner gate decision 2026-08-09; original task route not recorded

## Goal
Focused tests + evidence pack 关闭 M-5110：job-pool/job-spawner/workspace-runtime 聚焦测试与证据落盘（M-5110，CAP-027）。

## Acceptance
- [x] 账本记录（TASKS.md WMB-5115 done，2026-08-07）：27/27 pool/spawner/runtime tests；tsc 0；.ai/wmb-5110-5115-evidence.md
- [x] 证据记录（.ai/wmb-5110-5115-evidence.md）：Verification 27/27 + tsc 0；Boundary/stress 30/30 → Fix pass 33/33（同日）——非本次复跑
- [ ] 本文件为遗留基线登记；不视为原任务重新验收或新验证

## Allowed paths
- tests/job-pool.test.mjs
- tests/job-spawner.test.mjs
- tests/workspace-runtime.test.mjs
- tests/job-pool-stress.test.mjs
- .ai/wmb-5110-5115-evidence.md

## Forbidden paths
- 平台发布与硬删路径（publication-*、browser 发布、物理删除）
- src/shared/agent-capabilities.ts / src/shared/page-authority.ts
- 真实 data root

## Non-goals
- 不新增产品功能（tests/evidence only）
- 本登记不消除遗留债务；不声称原任务当时已走 intake

## Capability registry impact
no change — 账本行：tests/evidence only

## Depends on
WMB-5114（账本 parent 列）

## Authority
Historical reconstruction — WMB-5116 Owner gate decision 2026-08-09 批准的遗留基线登记；Owner lock: not recorded; do not infer。

## Verification evidence
- 账本行：TASKS.md WMB-5115（M-5110，CAP-027，done，parent WMB-5114）
- 证据文件：.ai/wmb-5110-5115-evidence.md（Verification / Boundary / Fix pass，原任务记录，非本次复跑）

## Design / lock
Historical reconstruction — Owner lock: not recorded; do not infer。完成时未记录 Owner lock/验收结果；不得反向声称当时已走 intake。
