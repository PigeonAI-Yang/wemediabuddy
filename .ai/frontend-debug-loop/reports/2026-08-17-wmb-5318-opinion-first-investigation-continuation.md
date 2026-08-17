# WMB-5318 — 观点稿优先的调查继续路径

## Problem

调查状态机本来允许 Owner 在 `defer -> needs_user` 后用受约束的写作方向继续，但 Studio 主动作仍显示“验收通过”，主管与 Pi 的暂缓说明又只突出补查、扩展或停止。结果是产品语义把“可核查事实要有证据”误变成“观点稿必须等同研究报告”，Pi 因此拒绝派写手。

## Root cause

断点位于 presentation/handoff 层，不在数据库或状态机：

`资料包验收 -> defer/needs_user -> 主管/Pi 呈报 + Studio 决策文案`

既有 `accept -> direction_pending_approval -> approve -> ready_to_write` 路径可安全复用；缺的是 defer 特定的 Owner 选项与事实/观点边界说明。

## Repair

- defer 特定主动作改为“按观点稿继续”，仍提交既有 `accept-research`。
- 页面明确：强观点与未来判断可作为作者判断继续；数字、引语、具体案例、归因等外部可验证事实必须受证据约束。
- 主管提示与 Pi 调查验收工具使用同一四选项：按观点稿继续、需要补查、扩展范围、停止调查。
- 主管仍不得代替 Owner 选择、审批或派写手。
- 当前真实项目补入并批准观点稿写作方向，状态恢复为 `ready_to_write`。

## Verification

- domain contract: 2/2 PASS.
- Pi wrapper contract: 9/9 PASS.
- focused Electron: 1/1 PASS.
- 1100×800 horizontal overflow: 0.
- page errors: 0.
- current DB: `ready_to_write`, revision 13, direction v1 approved.
- isolated Electron processes remaining: 0.

Evidence: `.ai/wmb-5318-evidence.md` and `tests/e2e/.artifacts/WMB-5290-deferred-owner-decision-qcRvzh/`.

## Operational completion

The approved direction was executed by the writer. Core version 10 contains the completed opinion-first article. Core version 11 restores all eight pre-existing images and bindings without changing the version 10 text. `content.get` readback verified 8/8 references, 8/8 bindings, exact asset-id sets, and text equality after image-reference removal. No platform version or publication was created.
