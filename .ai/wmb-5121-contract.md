# WMB-5121 Contract

## Route
Design

## Goal
librarian 结构化 no-op：严格 fenced JSON `{"wmb_noop":true}` 输出协议 + 删除自然语言正则回退 + 三处提示词更新，消除 no-op 假阴性。

## Acceptance
- [ ] 末条最后 fenced 块 `{"wmb_noop":true}`（含附加键）→ noop_confirmed
- [ ] 围栏非法 / 非末条（JSON 坏、`wmb_noop:false`、键错）→ null（JOB_READBACK_MISSING，保守失败）
- [ ] `LIBRARIAN_NOOP_MARKERS` 全仓库删除且无调用方（一次性删除面搜索作为迁移收口证据）
- [ ] 收据 ≥1 → sources_mutated（围栏被忽略，mutation 赢）
- [ ] finalText 内存路径免读文件
- [ ] 三处提示词（libraryOrganizePrompt / PI_AUTHORITY_SYSTEM_PROMPT / skills/wemedia-buddy-operator/SKILL.md）含 wmb_noop 围栏指令
- [ ] 存量无围栏 no-op 会话 → 保守 failed（不假成功）

## Allowed paths
- src/main/role-job-registry.ts（`noopDeclarationSchema` / `parseNoopDeclaration` 新增；`readbackLibraryMutation` +finalText；删除 `LIBRARIAN_NOOP_MARKERS`）
- src/main/role-job-policies.ts（`EmployeePolicyRun.finalAssistantText` 捕获；libraryOrganizePrompt 第 3/4 点加围栏确认指令）
- src/main/generic-employee-runner.ts（readbackFor library_mutation 分支传 `run.finalAssistantText`）
- src/main/pi-operator-skill.ts（`PI_AUTHORITY_SYSTEM_PROMPT` no-op 回报协议）
- skills/wemedia-buddy-operator/SKILL.md（「资料与今日方案」段加一行围栏要求）
- tests/job-pool.test.mjs
- tests/job-l2-integration.test.mjs
- tests/pi-extension.test.mjs
- .ai/wmb-5121-*

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
- 不新增角色、不做可配置权限 UI、不新增命令/schema/表 / grant 路径（agent_tasks / task_grants / execution_grants 结构零改动；围栏为输出侧文本协议，不进 agent-capabilities / AUTOMATIC_TASK_GRANT_SCOPES）
- 不改人工发布边界（最终发布点击与硬删仍仅 Owner UI）
- JobPool 不整体持久化（池内工单保持内存态，恢复沿用 agent_tasks interrupted 语义）
- 不改 agent-tasks.ts（601 行已登记上限，终态语义不动）/ mcp.ts / src/shared/*

## Capability registry impact
no change — agent-capabilities.ts / page-authority.ts 零改动；由 check:capabilities（A1）+ librarian effective grant 一致性（A2）验证。Pi operator Skill impact: updated — no-op 输出协议三处文本（libraryOrganizePrompt / PI_AUTHORITY_SYSTEM_PROMPT / SKILL.md），依 docs/pi-operation-skill-maintenance.md 更新规程。

## Depends on
WMB-5118

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
