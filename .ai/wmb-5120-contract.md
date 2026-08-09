# WMB-5120 Contract

## Route
Design

## Goal
grant 终态显式 revoke：`dispatchRevokeTaskGrantsForTask` + `dispatchTask` 终态钩子 + 幂等/交接回归，清理终态后 `task_grants` 审计残留。

## Acceptance
- [ ] 终态后 `listTaskGrants` 无 active（row status=revoked、revoked_at 非空）
- [ ] 带旧 grantId envelope → `TASK_GRANT_REVOKED`（或 `TASK_NOT_ACTIVE`）拒绝
- [ ] 重复回收幂等（第二次 ok data=[]）
- [ ] channel_scanned（saved>0）时 grant 仍 active（scan→judge 交接不误回收）
- [ ] `npm run check:capabilities` pass

## Allowed paths
- src/main/task-grants.ts（`dispatchRevokeTaskGrantsForTask` 新增：复用 `TASK_GRANT_REVOKE_COMMAND` + receipt + operation audit；原子幂等 UPDATE，不要求 expectedRevision）
- src/main/agent-task-commands.ts（`dispatchTask` 终态钩子：command ∈ 终态集 → best-effort revoke，try/catch 吞错不破坏终态写）
- tests/job-l2-integration.test.mjs
- tests/command-dispatcher.test.mjs
- .ai/wmb-5120-*

## Forbidden paths
- PRODUCT.md / PRD.md / SPEC.md / TECHNICAL_DESIGN.md
- src/shared/agent-capabilities.ts、src/shared/page-authority.ts
- src/main/agent-tasks.ts、src/main/mcp.ts
- 发布类与硬删路径（publication-*、browser 发布、物理删除/清库命令）
- 依赖文件（package.json、package-lock.json、node_modules 等）
- 真实 data root

## Non-goals
- 不重做 daily pipeline（扫描/判定/水印/赛道门领域原语保持现状）
- 不增加共享 planDate 锁（延续 WMB-5116 Owner lock #3：reporter 与 planner 不共享实体锁）
- 不新增角色、不做可配置权限 UI、不新增命令/schema/表（agent_tasks / task_grants / execution_grants 结构零改动；零迁移、无新命令）
- 不改人工发布边界（最终发布点击与硬删仍仅 Owner UI）
- JobPool 不整体持久化（池内工单保持内存态，恢复沿用 agent_tasks interrupted 语义）
- 不改 agent-tasks.ts（601 行已登记上限，终态语义不动）/ mcp.ts / src/shared/*；一次性 backfill 明确不做

## Capability registry impact
no change — agent-capabilities.ts / page-authority.ts 零改动；由 check:capabilities（A1）+ librarian effective grant 一致性（A2）验证。Pi operator Skill impact: no change — R3 为会话后回收，非提示词语义，按 docs/pi-operation-skill-maintenance.md 注明。

## Depends on
WMB-5117

## Design / lock
- Design: docs/spark/2026-08-08-agent-crew-residual-risk-closure-design.md
- Owner lock 2026-08-08:
  1. scan/judge 不共享实体锁；running judge 让 reporter 产生瞬时 deferred（不写 agent_task 终态），pool 泊车 `RESOURCE_JUDGE_IN_FLIGHT`（waiting_resource 车道），judge terminal 触发 rescan，60s watchdog 兜底；scan 返回时捕获不可变 readback snapshot。
  2. `JobExecuteContext` 建立单一 stoppable 注册协议；abort 后注册立即 stop；cancel 顺序 = abort → Pi `abortTurn`+`stop`（≤2s）→ `agent_task` cancel → pool cancel → lease finally；所有四角色接线，取消总门 ≤5s。
  3. grant 只在 `agent_task` 终态幂等显式 revoke，绝不按 job `channel_scanned` 终态回收（保护 scan→judge 交接复用）；复用 `task_grants.revoke` / audit，无迁移、无新命令。
  4. librarian no-op 仅接受末条 assistant 严格 fenced JSON `{"wmb_noop":true}`；移除自然语言 marker fallback；mutation receipt 永远优先，JSON 不能伪造写入。
  5. Capability registry no change；Pi Skill 仅 no-op 输出协议更新。
  6. clean cutover，无 shim、无双轨。
  7. 分工：WMB-5117 transient controls foundation；WMB-5118 scan/judge；WMB-5119 hard cancel；WMB-5120 grant revoke；WMB-5121 structured no-op；WMB-5122 integrated tests/live/review/evidence。
  8. Non-goals: §2.2 全部成立——不重做 daily pipeline、不增加共享 planDate 锁、不新增角色/权限 UI/命令/schema、不改人工发布边界、不持久化 JobPool。
  9. Route: Design.
  10. Design path: `docs/spark/2026-08-08-agent-crew-residual-risk-closure-design.md`.
