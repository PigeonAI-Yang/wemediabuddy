# Writer Research Dispatch Loop 诊断报告 — 工单 `08746077-0e80-4dd4-8c4f-cf537b44167f`

- **日期**: 2026-08-23 (UTC+08)
- **工单**: `08746077-0e80-4dd4-8c4f-cf537b44167f` / 映射 `agent_tasks.id=85d0db72-7431-4c5c-8c72-4f7723173a10`
- **项目**: `2fb16eba-6e30-4e33-8cab-2233135ced4e`《AI 项目最容易烧钱的地方，不在模型价格，而在没人做成本复盘》
- **终态**: `status=partial` / `phase=research_dispatched` / `revision=1` / `content_versions.count=1`
- **结论摘要**: 唯一首错点在 **Writer 策略层 `researchReady` 判定**（`role-job-policies.ts:128` + `agent-runner.ts:827/885/968`），`brief` 中“严禁研究”的自然语言被当作普通 `brief` 文本透传至 prompt，却仍被硬编码的研究前置分支覆盖，导致事实核查证据缺口 manifest 强制派研究生、父任务立即以 `partial/research_dispatched` 交接，正文保存被短路且稳定复现。

---

## 1 Problem — 用户观测的四项为何同时成立

| 观测 | DB/文件证据 |
|---|---|
| **partial** | `agent_tasks(85d0db72).status='partial'`，`finished_at=2026-08-23T06:10:06.233Z`；`jobs` 类比层 `report.code='PARTIAL'`（pi-agent session `41352e48...jsonl:62-64` `job.partial` 事件） |
| **research_dispatched** | 同行 `phase='research_dispatched'`，`result_refs_json={"researchHandoff":{"researchJobId":"4ad7aae4-ff7d-4688-b23f-bbb78b673ced","reused":false}}`，`events_json=[{"message":"已派研究补料工单 4ad7aae4..."}]` |
| **revision 1** | `content_projects(2fb16eba).revision=1, status='drafting', updated_at=2026-08-23T05:59:45.848Z`（建项目后未再更新）；`content_versions` 仅 1 行 `527cf518... v1 2026-08-23T05:59:45.848Z author=ai` |
| **禁止研究仍派研究** | `context_refs_json.brief` 原文含“此轮严禁调用外部研究、严禁派研究补料；请把稿件写成基于已有资料的观点型方法文”；但会话 `agent/sessions/job-08746077...jsonl:0699303b` 交付的 system prompt 第 4 条为“**必须调用 wmb_dispatch_research...即使项目已有少量关联资料，也必须派单**”；writer 实际于 `2026-08-23T06:09:07-06:10:06` 调用 `research.dispatch` 并触发 `handoffParentAfterResearchDispatch` |

---

## 2 Timeline — 精确时间线（Asia/Shanghai，来源 DB + 两个 session 目录）

```
2026-08-23T05:59:45.847Z  content_projects(2fb16eba)创建，revision=1，首版 content_versions(v1)落库
2026-08-23T06:00:31.513Z  page_studio(e11a8a62) running/starting（desk 占位，无关）
2026-08-23T06:01:28.180Z  d6a5fa3c studio_draft partial/research_dispatched → research 239f00a9 (首次同项目写作即进入研究前置)
2026-08-23T06:02:35.017Z  239f00a9 research failed/failed (BUDGET 内失败，未产生 supported claim)
2026-08-23T06:06:55.180Z  5db785a3 studio_draft partial/research_dispatched → research bfa87d5d
2026-08-23T06:08:03.864Z  bfa87d5d research cancelled/cancelled（supervisor 因幂等冲突主动取消，pi-agent session 41352...:61 "已取消由它自动派出的重复研究工单"）
2026-08-23T06:08:59.111Z  JobPool.spawn writer 08746077 brief=《严禁研究、仅写观点型方法文》 + 仅允许两条 @OpenRouter 事实，其余标为"我的建议"
                        ↳ agent_tasks 85d0db72 创建 context_refs={roleId:writer, projectId:2fb16eba, writerTask:core_draft, researchGate:"required", jobId:08746077, brief:"...严禁派研究补料..."}
                        ↳ researchGate仍为 required（isResearchSuccessorRow=false, investigation=null → researchReady=false）
2026-08-23T06:09:00.279Z  agent/sessions/job-08746077...jsonl:0699303b 投递 draftPrompt(researchReady=false) — 外部研究前置交接（含 brief 但要求必须派研究）
2026-08-23T06:09:22.100Z  writer 调用 wmb_get_agent_task → 回读 task 仍 running/running_pi，获取 projectId 与 brief
2026-08-23T06:10:05-06.081Z writer 调用 wmb_get_content + synthesis, 组装 4-8 条 requiredClaims（openrouter_activity_capabilities / openrouter_cost_review_case / ai_usage_cost_observability_limits / model_selection_vs_total_task_cost / cost_review_method_boundary / cost_optimization_tradeoffs）
2026-08-23T06:10:06.081Z  research.dispatch → dispatchResearchForEvidenceGap 成功 spawns 4ad7aae4
                        → handoffParentAfterResearchDispatch 写入 progress "已派研究补料工单 4ad7aae4..." + handoffAgentTaskToResearch → status=partial phase=research_dispatched finished_at=06:10:06.233Z
2026-08-23T06:10:06.295Z  e1ef7191 research(4ad7aae4) running/starting（reporter，budget 12m/40候选/3并行/1轮，claims 同上）
2026-08-23T06:10:14.198Z  JobPool 推送 [JOB_EVENT] job.partial for 08746077 to pi-agent session 41352...:62
2026-08-23T06:10:20.473Z  supervisor 验收："最后一轮仍返回 partial。先做最终验收..."
2026-08-23T06:12:45.686Z  e1ef7191 failed/failed code=RESEARCH_FAILED "同一 requestId 已绑定不同命令或输入。"（J:/PigeonYang/WeMediaBuddyData/agent/sessions/job-4ad7aae4...jsonl:4 的 claims 与写入竞态）
2026-08-23T06:12:48.873Z  supervisor 收到 [JOB_EVENT] job.failed for 4ad7aae4，不再重派，报告"已停止继续续派，避免重复触发同一问题。项目保留原始初稿和两条 OpenRouter 资料。"
```

继承边界：三次 `studio_draft → research` 均 `researchGate=required`，且 `findActiveResearchForParent` 同父唯一检查仅防并发二派，不防跨轮重派；CAP-028 止环仅拦 `research → research` 与 `successor → research`，不拦 `writer(writer brief禁止) → research`。

---

## 3 Root Cause — 唯一首个错误判定点

**首错函数：`src/main/role-job-policies.ts:128` 的 `runDraftPolicy` 对 `researchReady` 的判定**

```ts
// role-job-policies.ts:113-141
export function runDraftPolicy(ctx) {
  const approvedInvestigation = Boolean(investigation?.package && investigation.direction && ['ready_to_write','writing','completed'].includes(investigation.status));
  return startStudioDraft({
    ...,
    researchReady: isResearchSuccessorRow(ctx.runtime.database, ctx.jobId) || approvedInvestigation,
  });
}
```

- 只有两种豁免进直接写作：`isResearchSuccessorRow`（父工单是 `jobs(kind='research_successor')`）或 `approvedInvestigation`（专项调查 `ready_to_write/writing/completed`）。**无任何分支读取或结构化解析 `brief` 里的“严禁/禁止/不要派研究/观点型方法文”**。
- 该值透传至 `src/main/agent-runner.ts:885` `contextRefs.researchGate = researchReady?'satisfied':'required'`，并决定 prompt 分支：
  - `agent-runner.ts:827, 968 if (!researchReady) → draftPrompt` 返回 **“外部研究前置交接”** 模板（L827-841），其中第4条为 **must dispatch** 且末条“**派单成功后立即结束，不得调用 wmb_save_core_version**”。
  - `agent-runner.ts:843, 997` 仅当 `researchReady===true` 才进入“核心初稿任务”模板并允许 `wmb_save_core_version`。

因此，尽管 `brief` 在 `JobPayload`（`pi-agent/sessions/41352...jsonl:58 payload_json.brief`）与 `context_refs_json.brief` 中完整保留“此轮严禁调用外部研究”，`brief` 仅作为 `draftPrompt` 的 `brief=${brief}` 插值文本被写入 prompt 正文，对控制流零影响。LLM 收到冲突指令时，显式的 **must 指令** 覆盖自然语言偏好，必走 `wmb_dispatch_research` 路径。

**为什么是首个唯一错误**：后续所有正确行为都放大了该错误——`dispatchResearchForEvidenceGap`（`research-dispatch.ts:137-186`）校验通过（父任务 intent=studio_draft 合法、非 successor、非 research 父）、`handoffParentAfterResearchDispatch`（`research-dispatch.ts:192-219`）原子化将父任务置为 `partial/research_dispatched`（`agent-tasks.ts:481-502` `UPDATE ... status='partial', phase='research_dispatched'`），并短路 `startStudioDraft:985-995` 的 `afterPrompt.status !== 'running' → return` 与 `validating/complete`。若首点改为 `researchReady=true`，后段全部不会触发。

---

## 4 Contributing Factors — 放大/固化但非首因

1. **输入合同未结构化**：PRD/SPEC `CAP-028 Research Gate` 仅定义“研究门满足→允许写”，未定义“允许研究”的负向权限。没有 `allowResearch: boolean`、`researchMode: required|prohibited|auto` 或 `briefIntent` 结构化字段；`brief` 停留在自由文本，工程上不可判别。文件：`src/main/daily-content-article.ts:147 isResearchGateSatisfied` 只管 gate，不论 allow。
2. **Writer prompt 优先级倒置**：`draftPrompt` 把“禁止研究”写进 `brief` 插值，却在上方放更高优先级的 must-dispatch 指令（L838-840），形成 **指令冲突时系统指令胜**。正确优先级应为：结构化 `allowResearch=false` > `brief prohibition` > 默认 must-research。
3. **终态选择偏 `partial`**：`handoffAgentTaskToResearch` 特意独立于通用 `partialAgentTask`（`agent-tasks.ts:477-479` 注释“受控研究交接是可审计的部分结果…与通用 partial分开，避免把未写正文伪装成普通部分成稿”），因此即使 `saveTargetArticleDraftInternal` 从未执行且 `RESEARCH_GATE_UNMET` 本可写 `blocked`，writer 侧仍以 `partial/research_dispatched` 结束，属于 **可审计但误导的成功**。
4. **Just-in-time `researchGate` 写入**：`context_refs.researchGate` 在 `startStudioDraft:885` 即冻结，而 `saveTargetArticleDraftInternal:196` 的 `RESEARCH_GATE_UNMET → blocked` 是 MCP 写入侧的第二道门。writer 走的是 Pi MCP `research.dispatch` 而非 `wmb_save_core_version`，因此第二道门从未被触达，`blocked` 未发生。
5. **重启/重试幂等只防并发，不防语义循环**：`findActiveResearchForParent` 同父唯一仅拦活动研究；历史已 `partial/research_dispatched` 的父工单可无限 spawning 新 writer（新 `jobId` → 新 `agent_task`），导致 `06:01 → 06:06 → 06:08` 三轮稳定复现。
6. **Daily orchestration 误导性缺席**：本例为 `Studio direct` 写入（`jobId=direct-writer:${taskId}` 兼容分支 `agent-runner.ts:906`），不经 `daily-orchestration.ts:270 createProductionStageD` 的 quota/ensureLink 路径，因此 `DailySettlement` 不会将其记为 `needs_user/gap`，settlement/readback 看似“成功入队”而掩盖 `partial`。
7. **测试覆盖盲区**：现有聚焦测试 `wmb-5335-article.test.mjs` 仅测 gate 的正/反向（门满足写通、门不满足 blocked），无“门不满足但 brief 显式禁止研究 → 应直接写观点文”的用例；`wmb-5173` 仅测派生正确性，不测“不应派”否定路径；`tests/agent-runner.test.mjs:102` 注释“core_draft 默认 researchReady=false 时为外部研究前置…真实写作需 researchReady=true”把默认值当作正确，未断言 prohibition。

---

## 5 证据链 — 生产符号与直接调用链

**调用链（冻结输入 → 研究派单 → partial → 未写正文）**

```
JobPool.spawn({ roleId:writer, projectId:2fb16eba, writerTask:core_draft, brief:"...严禁派研究..." })
  → role-job-policies.ts:128 researchReady=false
    → agent-runner.ts:885 contextRefs.researchGate='required'
    → agent-runner.ts:894 dispatchStartAgentTask
    → agent-runner.ts:923 dispatchUpdateAgentTaskPhase running_pi
    → agent-runner.ts:980 draftPrompt(task, projectId, requestId, 'core_draft', brief, false)  // L827-841
        "当前轮次禁止写作。必须调用 wmb_dispatch_research ... 即使已有资料也必须派单"
      → Pi tool wmb_dispatch_research (mcp-job-tools.ts:167 registerTool 'research.dispatch')
        → research-dispatch.ts:137 dispatchResearchForEvidenceGap(parentTaskId=85d0db72)
          - getAgentTask, readJobContractFromRefs(jobId=08746077), deriveResearchParentRole='writer' ✓
          - isResearchSuccessorRow=false ✓
          - assertClaimsValid(6 claims fact/price/policy) ✓
          - findActiveResearchForParent=null → spawn Job{id:4ad7aae4, kind:research? reporter+researchGap}
        → research-dispatch.ts:192 handoffParentAfterResearchDispatch
          → agent-tasks.ts:204 dispatchReportAgentTaskProgress phase=research_dispatched
          → agent-tasks.ts:481 handoffAgentTaskToResearch → UPDATE status='partial', phase='research_dispatched', result_refs={researchHandoff}
      → agent-runner.ts:985 afterPrompt.status !== 'running' → early return partial, 跳过 validating/complete
      →（未达）daily-content-article.ts:196 saveTargetArticleDraftInternal → 无调用，content_versions 仍 v1, content_projects.revision 1
```

**关键文件:符号/行范围（以当前仓 `J:/PigeonYang/WeMediaBuddy/src/main` 为准）**

- `agent-runner.ts:791-859 draftPrompt` — L827 `if (!researchReady)` 分支为强制派研究模板（L838 `必须调用 wmb_dispatch_research`、L840 `即使已有少量资料也必须`、L841 `不得在当前会话临时联网`；L843 为写作模板）
- `agent-runner.ts:861-920 startStudioDraft` — L885 `researchGate: writerTask==='core_draft'?(researchReady?'satisfied':'required'):'not_applicable'`；L968 `researchPreflight = writerTask==='core_draft' && researchReady!==true`；L985-995 研究已派则 return partial，禁止 validating/complete 覆盖
- `role-job-policies.ts:113-141 runDraftPolicy` — L128 `researchReady: isResearchSuccessorRow(...) || approvedInvestigation`（唯一决策点，缺 brief 解析）
- `daily-content-article.ts:147-166 isResearchGateSatisfied` / `168-236 saveTargetArticleDraftInternal`（RESEARCH_GATE_UNMET → blocked，但本路径未进入）
- `research-dispatch.ts:128-186 dispatchResearchForEvidenceGap` / `192-219 handoffParentAfterResearchDispatch`
- `agent-tasks.ts:453-475 partialAgentTask` / `477-503 handoffAgentTaskToResearch`（`status='partial', phase='research_dispatched'` 正是由此写入）
- `mcp-job-tools.ts:167-212 research.dispatch` MCP 暴露
- `research-successor.ts:140 isResearchSuccessorRow`（止环条件）
- `index.ts:1194-1227 agent:start-studio-draft IPC`（`researchReady` 仅看 `investigation`，同样缺 brief）
- `daily-orchestration.ts:270-335 createProductionStageD`（本例未走，但显示另一条 writer 入口同样不读 brief）

**只读证据摘录**

- `J:/PigeonYang/WeMediaBuddyData/wmb.db:agent_tasks` — `85d0db72` row（上表 TIMELINE）
- `J:/PigeonYang/WeMediaBuddyData/wmb.db:content_projects/versions` — revision 1 / v1
- `J:/PigeonYang/WeMediaBuddyData/agent/sessions/job-08746077...jsonl` — prompt 全文（含 brief 与 must-dispatch 冲突）
- `J:/PigeonYang/WeMediaBuddyData/pi-agent/sessions/41352e48...jsonl:58-64` — spawn payload brief 与三轮 partial 验收对话
- `J:/PigeonYang/WeMediaBuddyData/agent/sessions/job-4ad7aae4...jsonl:4` — 研究 claims 明细（6 条，预算 12m/40候选/3并行/1轮）

---

## 6 Settle / Successor / Orchestration 辨析

- **CAP-028 Research Gate**：冻结职责正确（无 supported claim → 不满足），但 gate 只管“能否保存正文”，不管“能否发起研究”。本例失败在“能否发起研究”层，未到 gate。
- **Writer fact-check / manifest**：manifest 由 `wmb_dispatch_research` 的 `requiredClaims` 构成（writer 在 L837 整理 4-8 条 fact/price/policy，L838 触发 `research.dispatch`），证据缺口判定在 LLM 侧完成，不在 `daily-content-article.ts` 的机器校验。
- **Research successor 终态**：`e1ef7191(4ad7aae4)` 以 `failed/research_failed` 结束（requestId 绑定冲突），未 enqueue `research_successor`（仅 `succeeded/partial(unresolved)→pending/needs_user` 才 enqueue，见 `research-successor.ts`）。因此无 `jobs(kind='research_successor')` 新行，父 `partial` 无续派，符合“终态错误而非 settle 误判”。
- **Daily orchestration settle/readback**：`daily_content_cycles(2026-08-23).status='running'` 未 settle，本次写入为 Studio direct，非 Daily 管辖；`getPersistedSettlement` 无 08-23 结算，`createProductionStageD/E` 未调度该 project（无 `daily_content_targets` 行）。`partial` 的可见性仅经 `crew-instance-projection` / `agent_tasks` 读回，非 settlement 误判。
- **判定**：缺口类型为 **输入合同未结构化（Brief 禁止研究未落为结构化 `allowResearch`） + 优先级错误（must-dispatch 指令覆盖 brief） + 终态选择偏 `partial`（交接即可审计但误导）**；非 settle/readback 误判。

---

## 7 Stable Reproduction — 是否会稳定复现

**会，且已三连复现。**

- **触发条件**：`writerTask=core_draft` 且 `researchReady=false`（即非 successor 且无 `ready_to_write` 专项调查）→ `draftPrompt` 必走 must-dispatch 分支，与 `brief` 语义无关。
- **已观察**：同一 `projectId=2fb16eba` 在 `06:01(d6a5fa3c)/06:06(5db785a3)/06:08(85d0db72)` 三次 `studio_draft` 均 `partial/research_dispatched`，即使第三次 `brief` 明确“严禁派研究”仍一致；`revision` 始终 1 未动。
- **可复现脚本（只读/聚焦测试语义，不修改 DB）**：用 `wmb-5335` 同款 `migrateDatabase → ensureTargetArticleLinkInternal → runDraftPolicy` 语义构造：`runDraftPolicy({spec:{projectId, writerTask:'core_draft', brief:"...严禁研究..."}, jobId:"new-writer-not-successor"})` 断言返回 `researchReady=false` 且 `draftPrompt(...,false).includes("必须调用 wmb_dispatch_research")===true`。该断言在当前生产代码下恒为真。

---

## 8 Minimal Repair Boundary — 最小修复边界

> 约束：不改 TASKS/生产数据，不改远超首错点的下游派生；本次仅划边界，不落地代码。

1. **新增结构化输入（首选，最小）**  
   - 在 `RoleJobRequest` / `Job.payload` 新增 `allowResearch?: boolean | 'auto'|'prohibited'`（或 `researchMode`）或在 `content_projects` 增加 `research_policy` 列，迁移脚本补默认 `auto`。  
   - 修改仅两处：`role-job-policies.ts:128` 与 `index.ts:1202-1205 / agent-runner.ts:885` 查询该字段；`brief` 自然语言仅作 fallback 关键词匹配（`/(严禁|禁止|不要|不允许).{0,8}研究/ && 观点型|方法文/` → 视同 `prohibited`）。  
   - `draftPrompt` 首行为决策点增加 `if (allowResearch===false) researchReady=true`（即跳过研究前置，直接走写作模板），并在 prompt 中显式声明“本轮禁止研究，已豁免证据缺口 manifest”。

2. **Prompt 优先级修正（同 PR 内必做）**  
   - `agent-runner.ts:827-841` 的 must-dispatch 块需加前置：`若 brief 含显式禁止研究且 allowResearch!==true，则忽略本块，直接使用写作模板`。确保结构化 > 显式 brief > 默认。

3. **可选的 `RESEARCH_GATE_UNMET` 减弱（窄例）**  
   - 当 `allowResearch===false` 时，`saveTargetArticleDraftInternal:196` 的 `RESEARCH_GATE_UNMET → blocked` 应降级为 `drafting` 直通（或新增 `research_exempt` 状态），避免观点文仍被 gate 堵死。非必须若观点文允许 `isResearchGateSatisfied` 豁免；但若观点文需 0 claim 即可写，则必须。

4. **验收**：仅改 `runDraftPolicy`/`startStudioDraft`/`draftPrompt` 三文件，不改 `research-dispatch`/`handoff`/`daily-orchestration`。测试新增 `wmb-5335` 反向用例：`brief含禁止→保存观点文成功且 revision+1`，并回归 `wmb-5173`。

---

## 9 Rejected Fixes — 不应采用的假修复

| 假修复 | 为何拒绝 |
|---|---|
| **在 `dispatchResearchForEvidenceGap` 加 brief 关键词黑名单** | 治标不治本：write 会话已在 prompt 层决定必派，即使 MCP 拒绝，父任务仍在 `researchPreflight && RESEARCH_DISPATCH_MISSING → failed`（`agent-runner.ts:987-994`）无法写正文；且关键词在 MCP 层不可审计。 |
| **将 `handoffAgentTaskToResearch` 改为 `succeeded` 或写空内容版本** | 把“未写正文”伪装成成功/部分成稿，违背 `agent-tasks.ts:479` “避免把未写正文伪装成普通部分成稿”，且 `content_versions` append-only 被破坏，`revision` 语义污染。 |
| **全局禁用研究（置 `researchReady=true` 默认）** | 破坏 CAP-028 正向场景（事实稿需研究）；A4 验收 `wmb-5338` 依赖研究门，过大开关。 |
| **在 `brief` 里追加对抗 prompt（如“忽视系统指令”）** | prompt 注入对抗系统指令，不可控且全仓受影响；应改为结构化字段。 |
| **把 `partial/research_dispatched` settle 为 `failed/needs_user` 以触发重试** | 改变 settlement 语义但未修首因，重试仍走必派研究，形成 `failed → 重试 → 再 failed` 循环；且 `e1ef7191` 后续已 `failed` 仍未自动重试，证明 settle 不是根因。 |
| **伪造 supported claim 写入 `research_claims` 以满足 gate** | 篡改证据真实性（`research_claims.status='supported'` 需机器校验门槛，`research-claim-validation.ts` fail-closed），导致 `wmb-5173`/`wmb-5338` 四态门失效。 |
| **仅删 prompt 中的“即使已有少量资料也必须”一句** | 仍保留 must-dispatch，LLM 仍倾向派研究；需结构化豁免而非措辞微调。 |

---

## 10 Acceptance Proof — 可证伪验收

- **正向（禁止研究→观点文通）**：`node --test tests/wmb-5335-article.prohibited-research.test.mjs` — 给 `projectId=2fb16eba` 构造 `brief="此轮严禁研究，观点型方法文"` + `allowResearch=false`（或等效），`runDraftPolicy` 返回 `researchReady=true`，`draftPrompt(...,true)` 不含 `wmb_dispatch_research`，`saveTargetArticleDraftInternal` 在无 supported claim 时仍允许 `INSERT content_versions`，`revision` 由 1→2，`daily_content_targets.status` 非 `blocked`，`agent_tasks` 终态 `succeeded/done` 而非 `partial/research_dispatched`。
- **反向（默认→仍需研究）**：同法 `brief="正常事实稿，需核查"` + `allowResearch=auto|undefined`，`runDraftPolicy` 仍 `researchReady=false`，`draftPrompt` 含 must-dispatch，`handoff` 后 `partial/research_dispatched` 且 `content_versions.count` 不变。
- **回归**：`node --test tests/wmb-5335-article.test.mjs tests/wmb-5173-research-successor.test.mjs tests/wmb-5172-research-runner.test.mjs` 全绿；`npm run typecheck` 0 错。证据写入 `J:/PigeonYang/WeMediaBuddy/docs/audits/2026-08-23-writer-research-dispatch-loop.md` 标题、章节与末尾已读回。

---

## 11 附：直接证据索引（便于抽查）

- DB 行：`wmb.db:agent_tasks@85d0db72`、`wmb.db:content_projects@2fb16eba`、`wmb.db:content_versions@527cf518...`
- Session：`J:/PigeonYang/WeMediaBuddyData/agent/sessions/job-08746077...jsonl`（prompt 冲突）、`J:/PigeonYang/WeMediaBuddyData/pi-agent/sessions/41352e48...jsonl:58-68`（三轮 partial 验收对话）、`job-4ad7aae4...jsonl:4`（6 claims 明细）
- 代码：见 §5 调用链行号；完整 diff 边界见 §8。

> 本报告为只读诊断，未修改生产代码/DB、未触发研究/写作、未续派；后续修复请按 §8 最小边界开单独 Task，并先补 §10 验收测试。
