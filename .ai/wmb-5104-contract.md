# WMB-5104 Contract

## Route
Patch — historical baseline registration under WMB-5116 Owner gate decision 2026-08-09; original task route not recorded

## Goal
Split daily_scan/daily_judge automatic scopes：channel 运行绑定 daily_scan + reporter，judgment rebind daily_judge + planner，AUTOMATIC scopes 分区（M-5100，CAP-026/CAP-014）。

## Acceptance
- [x] 账本记录（TASKS.archive.md WMB-5104 done，2026-08-07）：intents + migration v48；channel=daily_scan+reporter；judge rebind planner；AUTOMATIC scopes split
- [x] 证据记录（.ai/wmb-5100-5106-evidence.md）：intents daily_scan/daily_judge（+ legacy daily_intelligence）；late migration v48；channel run → daily_scan + roleId reporter；judgment → rebind/start daily_judge + roleId planner；AUTOMATIC scopes partitioned
- [ ] 本文件为遗留基线登记；不视为原任务重新验收或新验证

## Allowed paths
- src/main/db/late-migrations.ts（migration v48）
- src/main/**（runtime intent split；证据未记录精确路径）
- .ai/wmb-5100-5106-evidence.md

## Forbidden paths
- 平台发布与硬删路径（publication-*、browser 发布、物理删除）
- src/shared/page-authority.ts
- 真实 data root

## Non-goals
- 不拆分角色 Skill 包（P1 后续）
- 本登记不消除遗留债务；不声称原任务当时已走 intake

## Capability registry impact
updated — 账本行：task intents（daily_scan/daily_judge 分区）

## Depends on
WMB-5103（账本 parent 列）

## Authority
Historical reconstruction — WMB-5116 Owner gate decision 2026-08-09 批准的遗留基线登记；Owner lock: not recorded; do not infer。

## Verification evidence
- 账本行：TASKS.archive.md WMB-5104（M-5100，CAP-026/CAP-014，done，parent WMB-5103）
- 证据文件：.ai/wmb-5100-5106-evidence.md（Deliverables，原任务记录，非本次复跑）

## Design / lock
Historical reconstruction — Owner lock: not recorded; do not infer。完成时未记录 Owner lock/验收结果；不得反向声称当时已走 intake。
