# WMB-5141 Evidence — 持久续派合同 + dispatcher 对象级硬隔离

- 日期：2026-08-09
- 合同：`.ai/wmb-5141-contract.md`（Design 落档）；设计真源 `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` §7.3/§8.1/§12.2.1/§12.2.7/§16
- 改动文件（6 源码 + 2 测试 + 1 证据）：
  - `src/main/job-object-boundary.ts`（新建：纯对象边界校验器 + 续派重建 + 命令边界提取，WMB-5141 边界机制唯一落点）
  - `src/main/role-job-registry.ts`（RoleJobRequest/RoleJobSpec 持久边界类型 + deriveRoleJobSpec 边界派生 + 统一 re-export）
  - `src/main/job-spawner.ts`（spawn 保留原始请求随执行上下文下发）
  - `src/main/generic-employee-runner.ts`（onTaskReady 原子写入续派合同 refs）
  - `src/main/task-grants.ts`（签发/执行两处硬门）
  - `tests/job-l2-integration.test.mjs`（L2-15 适配新 spawn 合同字段）
  - `tests/wmb-5141-job-boundary.test.mjs`（新建，13 条聚焦测试）
  - `.ai/wmb-5141-evidence.md`（本文件）

## Background

设计 §1.1 P5（实例无编号无历史：`context_refs_json` 未含 jobId/brief/边界参数，实例退出后无从指认与续派）与 §12.2.7/§15 风险 10（grant 存在性与 `expected_revision` 不构成边界防线，dispatcher 缺对象键比对 → 跨对象写可越权）。实施前复核真实调用链：spawn（`mcp-job-tools.ts` jobs.spawn → `JobSpawner.spawn` → `deriveRoleJobSpec`）→ 执行（`createGenericEmployeeRunner.onTaskReady` → `ensureAutomaticTaskGrant` → `dispatchIssueTaskGrant`）→ 命令（`CommandDispatcher.dispatch` → workspace-runtime `validateEnvelope` → `assertTaskGrantForEnvelope`/`assertExecutionGrantForEnvelope`）。两处硬门 = 签发（task_grants.issue）与执行（envelope 门）。

## Root cause

- 续派侧：spawn 任务的 `context_refs_json` 只有 planDate/projectId 等业务 refs，无 jobId/roleId/brief/边界参数 → 实例退出后无法从持久面重建原 RoleJobRequest。
- 隔离侧：`assertTaskGrantForEnvelope` 只校验 grant 存在/状态/命令范围/lease，不做对象键比对；`dispatchIssueTaskGrant` 不校验任务边界完整性 → 跨 date/project/source 写可越权。

## Implementation

**role-job-registry.ts**（+~290 行，纯函数面）

- 新类型 `JobObjectBoundary`（businessDate/projectId/sourceIds/scope）、`JobContract`（jobId/roleId/brief/boundary）；`RoleJobSpec` 扩展 `sourceIds`/`scope`。
- `normalizeSourceIds`（trim/去重/字典序）、`buildJobObjectBoundary`（按角色派生边界；librarian 无 sourceIds 且未限定 scope → `scope:'workspace'`=整库，与锁键 `library-maintenance:<ws>` 一致；writer projectId 归一化 `?? null`）。
- `buildJobContextRefs`（jobId/roleId/brief/businessDate/projectId/sourceIds/scope，reporter 另存 sourceFeedIds）、`readJobContractFromRefs`/`readJobContract`（jobId 存在 = 有 spawn 合同）、`rebuildRoleJobRequest`（一键续派重建）。
- 纯校验器：`resolveCommandObjectBoundary`（命令→对象键提取：plans.save→planDate、content.save_version→projectId、knowledge.record_batch/lane_gate→sourceIds、lane_restore/update_status→sourceId；未登记命令不约束）、`boundaryClaimFromContext`（relevantContext 显式 jobBoundary 优先，顶层业务键回落）、`hasBoundaryClaim`、`assertBoundaryCovers`（缺失或越界 fail closed：`TASK_SCOPE_BROADENED` + `details.reason='OBJECT_SCOPE_MISMATCH'` + dimension/expected/got）、`assertJobBoundaryComplete`（角色关键维度缺失拒签）、`ROLE_BOUNDARY_DIMENSIONS`/`maskBoundaryToRole`（按角色合同维度掩码主张：planner 对象是 businessDate，其 knowledge.record_batch 的 sourceIds 属合法写，不拦截）。

**job-spawner.ts**

- `JobExecuteContext` 新增 `request`（spawn 原始请求）；`jobRequests` Map（jobId → 原始请求）spawn 时保留、**终态才清理**（runJob finally 按 pool 终态判定；waiting_resource 泊车保留原请求供晋升重跑，T13）/取消（onCleanup）/dispose 清理。

**generic-employee-runner.ts**

- 新增导出 `writeJobContractRefs`：把 `buildJobContextRefs` 合并进既有 `context_refs_json`（单命令 `agent_tasks.update_phase`，原子、不丢既有 refs，receipt+audit；任务非 running 跳过）。
- `onTaskReady` 从 `ctx.request` 派生对象边界（`buildJobObjectBoundary`）；reporter 派单未显式给 sourceFeedIds 时从冻结渠道（contextRefs.intelligenceChannels）推导 feedIds 边界；在 `ensureAutomaticTaskGrant` **之前**写入合同 refs（缺失边界 → grant issue fail closed 同一硬门链）。

**task-grants.ts**

- `ensureAutomaticTaskGrant`：携带 spawn 合同的任务边界必须完整（`assertJobBoundaryComplete`，先于 grant 复用/签发）；relevantContext 附 `jobBoundary`（自描述）。
- `dispatchIssueTaskGrant` 硬门：任务有合同时边界完整校验 + relevantContext 主张（掩码后）必须被任务边界覆盖，越界拒签（dispatcher persistError 落 `command_receipts` error/not_started + `operation_log` 审计，零 task_grants 写）。
- `assertTaskGrantForEnvelope` 硬门：命令对象键（掩码后）必须落在任务持久边界内；handler 未执行 → 零业务写 + 自动审计。红线命令（x_lists.operation_execute 等）无命令提取器 → 不受影响，仍由 execution grant 门拦截。

## Commands / Results

- `node --test --test-concurrency=1 tests/wmb-5141-job-boundary.test.mjs`：**13/13 PASS**
  - T1 续派合同四角色 fixture + 一键续派重建（reporter/planner/writer/librarian-sources/librarian-workspace）
  - T2 边界标准化 + 命令提取（含 sources.upsert_batch feedId、content.create string[] 真实 shape）+ 校验器同界/越界/缺失/角色掩码 + observation_* 员工 scope 排除断言
  - T3 真实 spawn 链路：reporter 任务 refs 含 jobId/roleId/brief/businessDate/sourceIds/feedIds（feed 边界从冻结渠道推导）且保留 planDate/workspaceId/intelligenceChannels（不丢既有 refs）；自动 grant relevantContext 携带 jobBoundary
  - T4 签发硬门：jobId 在但边界缺失 → 自动授权 TASK_SCOPE_BROADENED + OBJECT_SCOPE_MISMATCH，零 grant 写
  - T5 签发硬门：relevantContext 跨 projectId/跨 scope 主张 → 拒签 + command_receipts error/not_started + operation_log 审计；同界主张可签发
  - T6 执行硬门（A9）：writer 跨 projectId 写 → BLOCKED + 审计 + sideEffectState=not_started（零业务写）；同界成功；有效 grant 仍被对象键比对拦截（grant 存在性不构成防线）
  - T7 执行硬门：planner 跨 date、librarian 跨 sourceIds 拒绝同界成功；planner 合法 source 维度写（knowledge.record_batch）不误拦；scope=workspace 不受 sourceIds 约束
  - T8 红线不变：红线命令对有效 grant + 匹配边界组合仍 EXECUTION_GRANT_REQUIRED，x_list_operations 零写
  - T9 同项目第二张 writer 单 → waiting_resource(RESOURCE_LOCK_CONFLICT) 不落 failed，释放后晋升
  - T10 三表 schema 零改动（PRAGMA 列集合与既有 DDL 全等）
  - T12 执行硬门：reporter sources.upsert_batch 跨渠道 feedId 拦截（dimension=feedIds）+ sideEffectState=not_started（零业务写）+ command_receipts/operation_log 审计，同渠道/无 feedId 通过；content.create 越界 sourceIds 拦截（零业务写 + 审计）、同界通过
  - T11 重启可重建：context_refs_json 跨 runtime epoch 完整指认 + rebuild 原 RoleJobRequest + 重建请求可再次 spawn
  - T13 泊车保留原始请求：waiting_resource(RESOURCE_LOCK_CONFLICT) 晋升重跑后 execute 收到原 reporter 请求（channelIds/sourceFeedIds 不丢；复验：改回无条件 finally 清理则该测试失败）
- 回归：`task-grants` 7 + `job-l2-integration` 20 + `generic-employee-runner` 8 + `execution-grants`/`command-dispatcher`/`agent-tasks`/`worker-lease-wiring`/`role-capability-p1`/`pi-page-authority`/`job-spawner`/`job-pool`/`workspace-runtime`/`agent-work-paths`/`basic-agent-paths`/`manager-orchestration`/`agent-runner`/`daily-handoff-orphan`/`workspace-intelligence`/`pi-message-flow`/`manager-task`/`job-scan-judge-race`/`agent-capabilities`：**全部 PASS（累计 108+ 条）**
- `npx tsc --noEmit`：PASS（0 错误）
- `npm run check:capabilities`（G1）：PASS —— Capability registry passed
- G2（effective grant 一致性排除清单 plans.save/content.*/reviews.save/硬删/发布）：由既有 `job-l2-integration` L2-07 + `agent-capabilities` + `role-capability-p1` 覆盖，PASS
- L2-15 适配说明：该既有测试手造任务 contextRefs 含 jobId 但缺边界字段 —— 新 fail-closed 门正确拒签；已按新 spawn 合同补齐 businessDate/brief 字段（等价于真实 spawn 写入的 refs），语义不变
- 按合同跳过 formatter/lint/项目级全套/check.ps1（主 Agent 统一执行）。line-cap 面已自验（Get-Content 实测）：`job-spawner.ts` 486=cap 486（`scripts/line-caps.json` 精确值）、`role-job-registry.ts` 498（cap 由 753 收缩至 498，ratchet only moves down——WMB-5141 把边界代码迁入新文件 `job-object-boundary.ts`）、`job-object-boundary.ts` 303、`task-grants.ts` 435、`generic-employee-runner.ts` 319、`tests/wmb-5141-job-boundary.test.mjs` 525（按既有测试文件惯例登记 line-caps.json 精确 cap，同 `workspace-browser` 737 / `x-list-import` 517）。
- 独立复审修复轮（Main changes_requested 五点闭环）：1) 登记 `sources.upsert_batch` extractor（items[].feedId → feedIds 维度，`JobObjectBoundary` 新增 feedIds），reporter 合同写入时从冻结渠道推导 feed 边界（派单未带 sourceFeedIds 场景不误拦生产扫描），dispatcher 负断言 T12；2) `content.create` extractor 修正为真实 string[] shape + 单元与 dispatcher 负断言（T2/T12）；3) `x_lists.observation_*` 核实：capability 绑定 reporter（task scope）与 page_discover，员工自动授权 scope 均不含（T2 排除断言），page_discover 页任务无 jobId 合同 → 门不适用，bindingIds 为独立配置实体无同空间可兑现对象键 → 证据说明不登记；4) `jobRequests` 清理修正：**终态才清理**（runJob finally 按 pool 终态判定；waiting_resource 泊车保留原请求供晋升重跑续派合同写入），取消（onCleanup）/dispose 清理保留，T13 负回归测试证明无条件清理会让晋升重跑丢失 reporter 渠道/feed 边界；5) evidence 行数实测更新。
- 未登记 grantable 命令逐项判定（「未登记命令不能让持久 spawn 合同绕过可兑现对象边界」）：已登记 8 个（plans.save/content.save_version/content.create/knowledge.record_batch/sources.upsert_batch/sources.lane_gate/sources.lane_restore/sources.update_status——提取器字段逐一对照真实 handler 输入 shape，见 mcp-business-commands/mcp-source-commands）。未登记 12 个的判定：`agent_tasks.report_progress`（基础设施，写任务自身进度，taskId 已由 envelope 绑定，无独立对象维）；`knowledge.suggestion_create`（员工 daily_judge/daily_intelligence 可授，但输入对象键为 canvasId——画布节点建议实体，不属于 businessDate/projectId/sourceIds/feedIds/scope 任何合同维，且是待用户确认的建议而非业务事实写）；`reviews.save`（对象键 publicationId，results_review 仅 page intent、员工角色不派发该 intent，无合同任务）；`knowledge.domain_create/domain_update`、`knowledge.creative_brief_create/_update/_create_project`（对象键 domainId/briefId/canvasId，仅 page_topic/page_canvas 页任务可授，页任务无 spawn 合同）；`intelligence_channels.proposal_apply`（PRECISE_EXECUTION_COMMANDS，由 execution grant 门拦截）；`x_lists.operation_execute`（红线，EXECUTION_GRANT_REQUIRED 门恒拦）；`x_lists.observation_start/observation_stop`（见修复轮 3）。上述无兑现对象键的命令主张为空 → 不新增约束（与设计 §12.2.7「只登记可兑现边界语义的命令」一致），证据说明不构成 fail-open。

## Impact

- **Capability registry**：no change —— `agent-capabilities.ts`/`page-authority.ts` 零触碰；对象级硬隔离为运行层强制点（G1 已验证）。
- **Pi operator Skill**：no change —— spawn 合同写入 `context_refs_json` 为系统侧持久化契约，`wmb_*` 工具名/参数/序列/读回不变；按 `docs/pi-operation-skill-maintenance.md` 影响表属「内部重构且可观察行为不变」类；不新增命令/能力/角色/依赖；三表 schema 零改动（T10 为证）。

## Risks

- 无 Pi 配置的 writer/librarian 前置 needs_user 任务不经 onTaskReady（resolveAgentPiPrerequisite 早退）：writer 任务无 jobId（无合同），librarian 任务有 jobId/roleId/brief 但无边界字段 —— 终态无写权，续派由桌助重新 spawn 补齐；已在合同语义内，列为已知边界。
- scan→judge 复用同一 agent_task 时，合同 refs 归属接续实例（judge 的 jobId），scan 实例经会话文件/审计指认 —— 与设计 §7.3 共享归属规则一致。
- 命令对象键提取器只登记可兑现边界语义的命令（plans.save/content.save_version/content.create/knowledge.record_batch/sources.upsert_batch/lane_gate/lane_restore/update_status，提取字段逐一对照真实 handler 输入）；未登记命令的对象键（canvasId/publicationId/domainId/briefId/bindingIds/sessionId 等）不在任务合同维内、无兑现语义 → 不新增约束，红线与既有 grant 范围语义不变。
- `sources.upsert_batch` 无 feedId 的条目不主张渠道维度（真实扫描流 intelligence-wire/website-channel/x-list-execution 恒带 feedId；feedId 缺失仅出现在 UI 手工入库 owner_ui 与外部 MCP page grant 路径，均无员工 spawn 合同）——该残余由 handler 既有去重不变式兜底，证据说明。
- `readJobContract` 的 JSON.parse 失败会传播（fail closed），不吞错。
