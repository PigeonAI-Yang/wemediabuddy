# WMB-5116 Contract

## Route
Design

## Goal
四员工工单统一由 GenericEmployeeRunner 执行，修复外部 intent 可绕过角色、资料员必败、锁串扰、错误/取消终态不一致与完成无业务读回五类缺陷。

## Acceptance
- [ ] spawn 无 intent 且 role 唯一派生：`SpawnJobRequest`/`jobs.spawn`/`wmb_spawn_job` 不再接受 `intent` 字段（编译期与运行时 schema 双重拒绝）；`role-job-registry.ts` 派生表四角色 × intent 与设计 §5.2 逐项相等，`role-roster` 反向投影不受影响
- [ ] 四角色统一生产 runner：reporter/planner/writer/librarian 工单统一由 `GenericEmployeeRunner` 单一入口单一生命周期执行；`ipc-jobs.ts`/`mcp.ts` 注入点切换到新执行器；`src/main/job-execute-daily.ts` 删除后仓库无 `createDailyJobExecutor` 残留
- [ ] librarian 真实执行 + 业务读回 + 不扩权：librarian 工单 spawn → running → Pi 策略会话 → mutation 收据读回 → succeeded（修复 E1）；effective grant = `page_library` ∩ librarian 角色能力 ∩ precise gate，`plans.save`/`content.*`/`reviews.save`/硬删/发布不可达
- [ ] waiting_resource + 专属锁 + 同日并发：实体锁冲突 → `waiting_resource(RESOURCE_LOCK_CONFLICT)`；lease 忙 → `waiting_resource(RESOURCE_LEASE_BUSY)`；资源释放后 ≤1s 自动晋升不落 failed；同日 reporter+writer+librarian 并发成功，同 `project:` 键 writer 或同 workspace librarian 第二单等资源
- [ ] 五态结构化错误/取消一致：`succeeded`/`failed`/`cancelled`/`partial`/`needs_user` 由同一映射函数产出 pool 与 agent_task 终态；取消优先——queued/waiting_resource/running 三态取消均落 cancelled 且 agent_task 同步；abort + outcome 冲突恒为 cancelled
- [ ] 双轨删除：`createDailyJobExecutor`、`SpawnJobRequest['intent']`、`pipelineOwned`、`requeue(` + `setTimeout(750)` 全仓库删除且无调用方（一次性删除面搜索作为迁移收口证据）
- [ ] 验证通过：focused tests（job-pool/job-spawner/job-l2-integration L0/L1）全绿；typecheck 0；`npm run check:capabilities` 通过（capability registry no change 由该检查验证）；lightweight check（intake/ledger）通过
- [ ] 隔离 Electron 实机：隔离 data root 上 `smoke-renderer` 通过（页面身份 WeMediaBuddy `<title>` + `#root`，地址 127.0.0.1:27391）；真实 reporter（scan_phase_reached）/planner（plans_revision）/writer（content_version）/librarian（sources_mutated|noop_confirmed）读回可见；同日三角色并发成功；running cancel ≤5s 终态 cancelled、lease 归零、agent_task cancelled；JOB_EVENT 载荷来自 report，无 waiting_judge 伪状态

## Allowed paths
- src/main/generic-employee-runner.ts（新增）
- src/main/role-job-registry.ts（新增）
- src/main/role-job-policies.ts（新增）
- src/main/job-execute-daily.ts（删除）
- src/main/job-pool.ts
- src/main/job-spawner.ts
- src/main/ipc-jobs.ts
- src/main/mcp.ts
- src/main/mcp-job-tools.ts（新增，仅抽取 jobs MCP schema/handler 以保持单文件 ≤500 行）
- src/main/manager-job-notify.ts
- src/main/role-roster.ts
- src/main/pi-extension.ts
- src/main/pi-operator-skill.ts
- src/main/task-grants.ts（grant 签发路径配合确认，不扩权）
- src/preload/preload.ts（jobs spawn 参数面同步）
- .pi/extensions/wmb-mcp/wmb-mcp-tools-manager.ts
- src/renderer/agents-roster-view.tsx
- src/renderer/global.d.ts
- src/renderer/pi-context-payload.ts
- tests/job-pool.test.mjs
- tests/job-spawner.test.mjs
- tests/job-l2-integration.test.mjs
- tests/job-pool-stress.test.mjs
- tests/agent-work-paths.test.mjs
- tests/basic-agent-paths.test.mjs
- tests/manager-orchestration.test.mjs
- tests/pi-extension.test.mjs
- .ai/frontend-debug-loop/**
- .ai/wmb-5116-*
- .ai/wmb-5003-contract.md（历史追溯合同：M-5001 FermentingRail 主题 UI）
- .ai/wmb-5006-contract.md（历史追溯合同：遗留基线登记）
- .ai/wmb-5010-contract.md（历史追溯合同：遗留基线登记）
- .ai/wmb-5012-contract.md（历史追溯合同：遗留基线登记）
- .ai/wmb-5014-contract.md（历史追溯合同：遗留基线登记）
- .ai/wmb-5020-contract.md（历史追溯合同：遗留基线登记）
- .ai/wmb-5030-contract.md（历史追溯合同：遗留基线登记）
- .ai/wmb-5032-contract.md（历史追溯合同：遗留基线登记）
- .ai/wmb-5100-contract.md（历史追溯合同：M-5100 harness/legislate/registry）
- scripts/line-caps.json（遗留递减基线登记）
- TASKS.md
- src/main/agent-tasks.ts（仅 WMB-5116 typed outcome/progress/runner 集成修正）
- src/main/manager-dispatch.ts（仅 WMB-5116 typed outcome/progress/runner 集成修正）
- src/main/manager-dock-turn.ts（仅 WMB-5116 typed outcome/progress/runner 集成修正）
- src/main/daily-control-policy.ts（仅 WMB-5116 typed outcome/progress/runner 集成修正）
- src/main/agent-runner.ts（仅 WMB-5116 typed outcome/progress/runner 集成修正）

## Forbidden paths
- PRODUCT.md / PRD.md / SPEC.md / TECHNICAL_DESIGN.md
- src/shared/agent-capabilities.ts
- src/shared/page-authority.ts
- 真实 data root（隔离验收仅用临时独立工作空间；真实用户数据/发布数据不可触碰）
- 发布类与硬删路径（publication-*、browser 发布、物理删除/清库命令）
- 依赖文件（package.json、package-lock.json、node_modules 等）

## Non-goals
- 不新增角色、不做可配置权限 UI、不重做 Today 产品形态、不改变最终人工发布边界
- JobPool 本次不整体持久化（池内工单仍为内存态，重启恢复沿用 agent_tasks interrupted 语义）
- 不改 desk 编排工具面、不引入员工自动多跳、不重建 manager 编排
- 不重写现有 daily/studio 业务阶段（水印/赛道门/验证/草稿保存保留为领域原语）

## Capability registry impact
no change — `agent-capabilities.ts`/`page-authority.ts` 零改动；由 `check:capabilities` + effective grant 一致性检查验证；Pi operator Skill 文本更新（spawn/写手提示词去 intent 字样）属 Skill impact: updated

## Depends on
WMB-5115

## Design / lock
- Design: docs/spark/2026-08-08-agent-crew-generic-runner-repair-design.md
- Owner lock 2026-08-08:
  1. 四角色工单统一由 `GenericEmployeeRunner` 执行，删除 `createDailyJobExecutor` 及双入口。
  2. `wmb_spawn_job` / `jobs.spawn` 删除外部 `intent`；intent 由角色注册表唯一派生。
  3. 角色专属锁：reporter=`scan:<workspaceId>:<businessDate>:<channel>`，planner=`plan:<workspaceId>:<businessDate>`，writer=`project:<workspaceId>:<projectId>`，librarian=`library-maintenance:<workspaceId>`；reporter 与 planner 不共享 planDate 锁。
  4. 锁冲突与 lease 忙进入 `waiting_resource`，不落失败；资源释放后按 FIFO 晋升。
  5. `JobExecutionOutcome` / `RoleJobReportV1` 使用 `succeeded` / `failed` / `cancelled` / `partial` / `needs_user` 五态；取消优先；成功必须业务读回。
  6. 资料员权限不扩大；Capability registry 预期 no change，但实现必须通过 capability 一致性检查。
  7. 一次性干净切换，无 shim、无双轨；JobPool 本次不整体持久化。
  8. Non-goals: 不新增角色、不做可配置权限 UI、不重做 Today 产品形态、不改变最终人工发布边界。
  9. Route: Design.
  10. Design path: `docs/spark/2026-08-08-agent-crew-generic-runner-repair-design.md`.

## Owner gate decision 2026-08-09

- 选择「登记遗留基线」以解除 WMB-5116 lightweight gate（line-caps）验收阻塞：对当前全部超限文件登记递减上限（cap=当前精确行数，只降不升，任何后续增长必须失败），并创建九份历史追溯合同（WMB-5003 / 5006 / 5010 / 5012 / 5014 / 5020 / 5030 / 5032 / 5100）及新增允许路径（`src/main/pi-extension.ts`、`tests/pi-extension.test.mjs`、`scripts/line-caps.json`、九份合同文件）。
- 本决定是遗留债务的显式登记，**不等于债务清零**：不补造原任务不存在的 Owner lock 或验收结果，不声称超限文件已拆分或重构。
