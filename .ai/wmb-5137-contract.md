# WMB-5137 Contract

## Route
Patch

## Goal
修复 2026-08-09 11:41 daily_scan 故障链（X 预检超时且前置 rethrow 阻断逐渠道、reporter 无 code 异常错误码语义错误、job 失败 agent_task 终态滞后、roster 冲突误报），仅四项最小修复，不增命令/Capability/依赖，不触发真实平台发布/互动。

## Problem / Root cause
已确认直接证据（2026-08-09 11:41 daily_scan 故障现场）：
1. `src/main/platforms/x.ts:16-18` — `identifyXAccount` 对 `SideNav_AccountSwitcher_Button` `waitFor({state:'visible', timeout:15_000})`；未登录/未恢复会话时抛无 code 的 timeout Error。
2. `src/main/daily-intelligence-channels.ts:167,275-283` — `resolveBrowserConfig` 在逐渠道循环前调用，非 NEEDS_USER 错误直接 rethrow → 单渠道预检失败使整个工单失败，其余可运行渠道不执行。
3. `src/main/generic-employee-runner.ts:151-154` — catch 中无 code 异常全角色兜底 `JOB_ERROR_CODES.LIBRARY_ORGANIZE_FAILED`，reporter 也落"资料整理失败"语义错误码。
4. runner catch 返回 `failedOutcome(code, message)` 但未写 agent_task 终态（成功路径由领域原语/assembleOutcome 写，librarian organize 由 §6 step7/role-job-policies.ts:283 写）→ 非 abort 异常后 agent_task 停在 running，等重启/orphan sweeper 兜底。
5. `src/renderer/agents-roster-view.tsx:267-269` — `deskConflict = deskOccupied && (deskRow?.status==='blocked' || pool.running>0)`：正常 desk running + 员工 running 编排被判定冲突并渲染危险态。

## Scope
四项修复，每项保持现有产品承诺与角色权限：
1. reporter 无 code 异常落语义正确错误码（reporter 域错误码，非 LIBRARY_ORGANIZE_FAILED），并保留原始 `error.message`（不吞信息）。
2. X 预检失败（identifyXAccount 超时 / resolveBrowserConfig 前置 rethrow）落可追踪渠道失败或 needs_user 回执（渠道级 receipt 或工单 needs_user/渠道失败终态），且不阻断其他可运行渠道继续扫描。
3. job 失败（含非 abort 异常）立即使对应 agent_task 终态一致（failed + 对应 errorCode），不依赖重启/orphan sweeper；取消优先与五态契约（WMB-5116）不回归。
4. agents-roster-view 仅对真实 blocked/资源冲突（RESOURCE_LOCK_CONFLICT / RESOURCE_LEASE_BUSY / 权限 BLOCKED 等）显示冲突危险态；正常 desk+员工 running 编排显示非危险状态。

## Acceptance
- [ ] 原故障 fixture 复现：以 2026-08-09 11:41 故障 fixture（X 渠道 identifyXAccount 对 SideNav_AccountSwitcher_Button 15s 超时；resolveBrowserConfig 前置 rethrow）修复前运行，before 证据（异常类型、错误码、agent_task 停留状态、roster DOM）落盘 `.ai/wmb-5137-evidence.md`；复现不出则以事实记录"未复现"，不得以推断充当。
- [ ] 可证伪测试 1（错误码语义）：reporter 无 code 异常 → job 落 reporter 语义错误码且 errorMessage 保留原始 message 原文；writer/planner/librarian 无 code 异常各落本角色语义错误码；LIBRARY_ORGANIZE_FAILED 仅剩 organize 域使用（focused 单测断言错误码映射，覆盖全角色 fixture）。
- [ ] 可证伪测试 2（渠道隔离）：X 预检失败渠道落可追踪回执（渠道级 failure receipt 或工单 needs_user 终态，含渠道标识与原因）；其余可运行渠道（official_web 等）仍产生扫描回执并推进；断言预检失败不使整个工单 failed（fixture 用 stub 浏览器会话，无真实平台发布/互动）。
- [ ] 可证伪测试 3（终态一致）：runner 抛非 abort 异常 → job failed 后对应 agent_task 在短窗口（非 sweeper 周期）内落 failed + 对应 errorCode；agent_task 与 pool 终态由同一映射函数产出（五态契约）；取消路径维持 cancelled 优先（WMB-5116 用例回归）。
- [ ] renderer 实机状态（隔离 data root）：正常 reporter 工单 running 时 roster 无冲突危险态（无 `.seat-conflict`/danger callout，desk+员工均 running 显示非危险 badge）；构造真实锁冲突（RESOURCE_LOCK_CONFLICT）场景显示冲突；before/after DOM 与 computed-style 快照入 evidence。
- [ ] 轻量门禁：`npm run typecheck` 0；`npm run check:capabilities` 通过（capability registry no change 由该检查验证）；intake/ledger 结构检查通过；跳过 formatter/lint/全量测试（项目级命令由主 Agent 统一执行）。
- [ ] 证据收口：`.ai/wmb-5137-evidence.md` 完整（before/after、fixture 输出、测试与实机数据）；TASKS.md 行 done 回执（入账阶段，本合同不登记）。

## Verification
- 原故障 fixture：2026-08-09 11:41 daily_scan 故障复现 fixture（X 账号切换按钮 15s 超时 + resolveBrowserConfig 前置 rethrow），修复前后对比驱动。
- 可证伪测试：focused tests（generic-employee-runner 错误码映射、daily-intelligence-channels 渠道隔离、job/agent_task 终态同步、roster 冲突投影），全角色 fixture 覆盖。
- renderer 实机：隔离 data root 真实 Electron/browser 状态（roster 冲突显示与渠道回执可见性），DOM/computed-style 快照。
- 轻量门禁：typecheck、check:capabilities、intake/ledger 结构检查；formatter/lint/全量测试由主 Agent 统一执行。
- 证据文件：`.ai/wmb-5137-evidence.md`（未来实施阶段落盘；本 Patch 只落合同，不创建证据）。

## Allowed paths
- `.ai/wmb-5137-contract.md`（本合同，本次唯一新建文件）
- `.ai/wmb-5137-evidence.md`（未来实施阶段证据文件；本次不创建）
- `TASKS.md`（未来入账用；本 Patch 只落合同，不登记）
- 未来实施预期落点（本 Patch 禁止触碰，列出以约束根因范围）：`src/main/generic-employee-runner.ts`、`src/main/role-job-policies.ts`、`src/main/daily-intelligence-channels.ts`、`src/main/platforms/x.ts`、`src/renderer/agents-roster-view.tsx`、`tests/` 对应聚焦测试

## Forbidden paths
- `src/shared/agent-capabilities.ts`、`src/shared/page-authority.ts`（能力注册表/权限，no change）
- `PRODUCT.md` / `PRD.md` / `SPEC.md` / `TECHNICAL_DESIGN.md`（产品合同）
- `skills/wemedia-buddy-operator/SKILL.md` 及 Pi 相关资产（Pi operator Skill no change）
- 真实 data root、依赖文件（package.json、package-lock.json、node_modules 等）、`TASKS.archive.md`
- 本合同之外任何文件（本次仅允许新建 `.ai/wmb-5137-contract.md`）

## Non-goals
- 不新增命令/Capability/依赖；不重排 job 编排语义、不改角色权限与产品承诺
- 不改五态终态契约与取消优先语义（WMB-5116 契约保持）
- 不重做 Agents 页 UI 或渠道配置 UI（仅冲突判定与危险态展示修正）
- 不触发真实平台发布/互动；X 预检失败仅落回执，不自动重试、不绕过授权
- 不承诺未复核根因：实施前以最新源码复核四项证据
- 本 Patch 不登记 TASKS 行、不写实现代码；本合同仅为提案

## Capability registry impact
no change — 四项均为错误码/回执/终态同步/展示语义修正，不触碰 registry，不新增命令与 Capability。
Pi operator Skill impact: no change — 不增命令、不改角色权限与产品承诺；reporter/X 路径为既有工作流修复，Pi 操作路径无差异。

## Depends on
WMB-5116（done；GenericEmployeeRunner 与五态终态契约是本次四项修复的既有基础）

## Owner confirmation
CONFIRMED 2026-08-09 — Owner 已确认"四项完整修复"，合同锁定。以下 Owner lock 文本为锁定原文（保留）：

```text
Owner lock 2026-08-09:
1. 四项修复按 WMB-5137 合同执行：① reporter 无 code 异常落语义正确错误码并保留原始 message；② X 预检失败（identifyXAccount 超时 / resolveBrowserConfig 前置 rethrow）落可追踪渠道失败或 needs_user 回执，且不阻断其他可运行渠道；③ job 失败即时同步对应 agent_task 终态，不依赖 orphan sweeper；④ agents-roster-view 仅对真实 blocked/资源冲突显示冲突危险态，正常 desk+员工 running 编排显示非危险状态。
2. Capability registry 与 Pi operator Skill 均 no change；不新增命令/Capability/依赖；不触发真实平台发布/互动；保持现有产品承诺与角色权限。
3. Non-goals: 不重排 job 编排语义、不改角色权限与产品合同（PRODUCT/PRD/SPEC 不动）；不改五态终态契约与取消优先语义；不重做 Agents 页 UI；本 Patch 不登记 TASKS、不写实现代码。
4. Route: Patch
5. Design path: 无（Patch；实施前以最新源码复核根因）
```

## Design / lock
none（Patch）— Owner 已确认 2026-08-09；锁定文本见 Owner confirmation 段（原文保留）。
