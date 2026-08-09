# WMB-5103 Contract

## Route
Patch — historical baseline registration under WMB-5116 Owner gate decision 2026-08-09; original task route not recorded

## Goal
P0 focused tests + typecheck + evidence pack：CAP-026 角色×能力 P0 收口验证与证据落盘（M-5100，CAP-026）。

## Acceptance
- [x] 账本记录（TASKS.archive.md WMB-5103 done，2026-08-07）：check:capabilities；agent-capabilities + role-capability-p1 10/10；tsc 0
- [x] 证据记录（.ai/wmb-5100-5106-evidence.md Verification）：`npm run check:capabilities` 通过；10/10 tests；tsc exit 0——非本次复跑
- [x] 证据记录（.ai/wmb-5100-5103-evidence.md Commands）：check-capability-registry pass、agent-capabilities tests pass——非本次复跑
- [ ] 本文件为遗留基线登记；不视为原任务重新验收或新验证

## Allowed paths
- tests/agent-capabilities.test.mjs
- tests/role-capability-p1.test.mjs
- scripts/check-capability-registry.mjs
- .ai/wmb-5100-5106-evidence.md / .ai/wmb-5100-5103-evidence.md

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
WMB-5101, WMB-5102（账本 parent 列）

## Authority
Historical reconstruction — WMB-5116 Owner gate decision 2026-08-09 批准的遗留基线登记；Owner lock: not recorded; do not infer。

## Verification evidence
- 账本行：TASKS.archive.md WMB-5103（M-5100，CAP-026，done，parent WMB-5101/WMB-5102）
- 证据文件：.ai/wmb-5100-5106-evidence.md + .ai/wmb-5100-5103-evidence.md（Verification，原任务记录，非本次复跑）

## Design / lock
Historical reconstruction — Owner lock: not recorded; do not infer。完成时未记录 Owner lock/验收结果；不得反向声称当时已走 intake。
