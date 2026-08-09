# WMB-5122 Contract

## Route
Design

## Goal
六任务集成收口：聚焦套件 + typecheck + check:capabilities + lightweight + 隔离实机验收（E-0..E-6）+ 独立复审 + 证据包 + TASKS.md 六行 done。

## Acceptance
- [ ] §10 全 focused 套件绿（job-pool / job-spawner / job-l2-integration / job-scan-judge-race / command-dispatcher / pi-extension）+ typecheck 0
- [ ] `npm run check:capabilities` pass（A1）+ librarian effective grant 一致性（A2）
- [ ] `scripts/check.ps1` lightweight pass
- [ ] §11 实机验收 E-0..E-6 全项通过（隔离 data root，不碰真实数据）
- [ ] 独立复审结论 approved（关闭全部 finding）
- [ ] `.ai/wmb-5117-5122-evidence.md` 落盘；TASKS.md 六行 done 回执（含 Pi Skill impact 逐任务证据行）

## Allowed paths
- §10 测试文件：tests/job-pool.test.mjs、tests/job-spawner.test.mjs、tests/job-l2-integration.test.mjs、tests/job-scan-judge-race.test.mjs、tests/command-dispatcher.test.mjs、tests/pi-extension.test.mjs
- tests/job-scan-judge-race.test.mjs
- .ai/wmb-5117-5122-evidence.md
- TASKS.md（ledger 六行 done）
- scripts/line-caps.json（最终复核登记）

## Forbidden paths
- PRODUCT.md / PRD.md / SPEC.md / TECHNICAL_DESIGN.md（如行为契约稳定需补充，另行登记）
- src/shared/agent-capabilities.ts、src/shared/page-authority.ts
- src/main/agent-tasks.ts、src/main/mcp.ts
- 发布类与硬删路径（publication-*、browser 发布、物理删除/清库命令）
- 依赖文件（package.json、package-lock.json、node_modules 等）
- 真实 data root（隔离验收仅用临时独立工作空间）

## Non-goals
- 不重做 daily pipeline（扫描/判定/水印/赛道门领域原语保持现状）
- 不增加共享 planDate 锁（延续 WMB-5116 Owner lock #3：reporter 与 planner 不共享实体锁）
- 不新增角色、不做可配置权限 UI、不新增命令/schema/表（agent_tasks / task_grants / execution_grants 结构零改动）
- 不改人工发布边界（最终发布点击与硬删仍仅 Owner UI）
- JobPool 不整体持久化（池内工单保持内存态，恢复沿用 agent_tasks interrupted 语义）
- 不改 agent-tasks.ts（601 行已登记上限，终态语义不动）/ mcp.ts / src/shared/*

## Capability registry impact
no change — 集成/验收任务不触碰 registry；由 check:capabilities（A1）+ librarian effective grant 一致性（A2）验证。Pi operator Skill impact: no change — 六任务合并验收，逐任务证据行注明（仅 5121 updated）。

## Depends on
WMB-5118, WMB-5119, WMB-5120, WMB-5121

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
