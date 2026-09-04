# WMB-5347 Writer Research Dispatch Loop — 完成证据

- **Task**: WMB-5347 (done) — Writer 禁研观点文无法保存修复
- **Audit**: `docs/audits/2026-08-23-writer-research-dispatch-loop.md` 项目 `2fb16eba`《AI 项目最容易烧钱的地方》 `status=partial/phase=research_dispatched/revision=1` 三连复现
- **Contract**: 独立状态 `researchReady`（证据满足） vs `researchMode`（策略） vs `researchGate`（required/satisfied/exempt/not_applicable）；`prohibited && !evidenceReady` 经 DB 校验的 `exempt` 进入受限写作不派研究；`required/auto && !evidenceReady` 保持 must-dispatch；结构化值权威，旧 brief 仅单点归一；保存豁免必须回读 `agent_tasks.context_refs` 的 `taskId/projectId/researchMode`

## 1 设计要点

- 单点 `normalizeResearchMode`：显式 `researchMode/research_mode` 优先；显式 `required` 覆盖 brief 禁研；缺字段时 `/禁止|严禁|不要|不允许.{0,12}研究/` 兼容为 `prohibited`；其他为 `auto`；未知值 `VALIDATION_ERROR` 拒绝。
- `researchReady` 语义不变（`isResearchSuccessorRow || approvedInvestigation`）；`researchGate` 由 `evidenceReady + researchMode` 派生：`core_draft && evidenceReady → satisfied`；`core_draft && !evidenceReady && prohibited → exempt(reason=prohibited_brief_exempt)`；其余 `required`；非 core 为 `not_applicable`。
- Runner 分支：`prohibited` 直接受限写作 prompt（仅既有来源、严禁 `wmb_dispatch_research` 与临时联网、无支持事实删或标观点）；`auto/required && !evidenceReady` 保持原研究前置模板。
- 保存门在 `mcp-business-commands.ts` 可信边界：以 `taskId` 回读 `agent_tasks`，校验 `intent=studio_draft && roleId=writer && researchMode=prohibited && researchGate=exempt && projectId` 匹配才放行；裸 exempt/错项目/非 writer 均 `RESEARCH_GATE_EXEMPT_INVALID`。

## 2 文件清单（7 产品 + 1 测试，≤10）

| 文件 | 变更 |
|---|---|
| `src/main/role-job-registry.ts` | 新增 `ResearchMode` 三态、`RESEARCH_PROHIBITED_BRIEF_RE`、 `normalizeResearchMode*` 单点归一；`ROLE_ALLOWED_KEYS.writer` 增 `researchMode/research_mode`；`parseRoleJobRequest` 归一冻结；`RoleJobSpec.researchMode`；`deriveRoleJobSpec` 派生 |
| `src/main/job-object-boundary.ts` | `buildJobContextRefs` 持久化 `researchMode/research_mode`；`rebuildRoleJobRequest` 回读 + 旧 refs brief fallback；writerTask 增 `video_script` |
| `src/main/role-job-policies.ts` | `runDraftPolicy` 分离 `evidenceReady` 与 `researchMode`，透传至 `startStudioDraft` |
| `src/main/agent-runner.ts` | `draftPrompt` 新增 `researchMode` 分支（prohibited 受限写作）；`startStudioDraft` 新增 `researchMode` 入参、归一、派生 `researchGate/exempt`、`researchPreflight` 排除 prohibited、direct 合同带 `researchMode`、`dispatchFail` 跳过 prohibited |
| `src/main/mcp-job-tools.ts` | `jobs.spawn` writer 增加 `research_mode/researchMode` enum + `video_script`，透传 `researchMode` |
| `src/main/mcp-business-commands.ts` | `assertStudioDraftResearchReady(taskId, projectId?)` 校验 `exempt` 仅当 `writer+studio_draft+prohibited+projectId匹配` 放行，否则 `RESEARCH_GATE_EXEMPT_INVALID`；保存两处传入 `projectId` |
| `src/main/index.ts` | `agent:start-studio-draft` 接受 `brief/researchMode/research_mode`，归一后透传 `startStudioDraft`（直接调用方 clean-cutover） |
| `tests/wmb-5347-writer-research-mode.test.mjs` | 聚焦测试 10 项，覆盖全部合同 |

> 未改 `research-dispatch.ts`/`research-successor`/`handoff`/`DB schema`/`UI`，保留 `video_script` 衍生。

## 3 红灯证据（修复前）

- `draftPrompt(task, ..., false, 'prohibited')` 仍含 `必须调用 wmb_dispatch_research`，走 `partial/research_dispatched`，`saveCoreVersion` 保持 `RESEARCH_REQUIRED`，`revision` 保持 `1`，`content_versions` 1 行，未追加版本。
- 对应聚焦测试在旧代码下 5/10 失败（示例：`WMB-5347: draftPrompt prohibited 为受限写作` `AssertionError: 必须调用 wmb_dispatch_research`；`prohibited exempt 允许保存` `NOT NULL` 缺 `researchMode` 持久化前虽能过但 prompt 仍错）。

## 4 绿灯证据（修复后）

```
$ node --test tests/wmb-5347-writer-research-mode.test.mjs
✔ 10/10 PASS (prohibited 无 must dispatch 且 revision 1->2、auto/required 仍 dispatch/blocked、required覆盖brief、旧brief fallback、未知值拒绝、伪造/错项目拒绝、successor不退化)
$ npx tsc -p tsconfig.json --noEmit
# 仅余 2 错误，均在 src/main/zhihu-hot-channel.ts:336,338 — 预存，与本任务无关
```

- `prohibited` prompt 不含 `必须调用 wmb_dispatch_research`，含 `受限写作·已豁免`、`严禁调用`、`仅依据已关联来源`、`观点/待验证`，可直接 `wmb_save_core_version`，`revision 1->2` 且 `content_versions` 2 行，无 `research handoff`。
- `auto/required` 未ready 仍 `必须调用 wmb_dispatch_research`，保存门 `RESEARCH_REQUIRED`。

## 5 验收

- 三态归一、持久化、Runner 分支、保存门 DB 校验、tool schema、直接调用方 clean-cutover 全部落地；`researchReady` 语义未改；`research_dispatch` 未动；默认 CAP-028 保持。
- `TASKS.md:WMB-5347` 置 `done`，证据 `.ai/wmb-5347-evidence.md` 完成。

*Generated: 2026-08-23 Asia/Shanghai*
