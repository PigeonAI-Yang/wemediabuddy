# WeMediaBuddy Task Ledger

This is the only progress ledger.

Statuses:

- `todo`: ready after dependencies are done;
- `doing`: actively being changed; at most one per Owner;
- `blocked`: cannot meet acceptance without user input or external state;
- `done`: deliverables and verification evidence exist.

Progress is task evidence, not a percentage.

Done receipt contract (WMB-4810 and later):

A row whose Task number is ≥ 4810 (compare the numeric part) must, when marked `done`, satisfy all four receipts in its Evidence cell:

- at least one existing repository-relative evidence path (for example `.ai/wmb-4810-xxx.json`, `tests/foo.test.mjs`);
- `Pi operator Skill impact: (updated|no change) — <non-empty note>`;
- `Independent review: <name> — <non-empty conclusion>` or `Independent review: not required — (docs-only|test-only|evidence-only|copy-only)`;
- Evidence cell total at most 700 characters; narrative detail goes in `.ai/wmb-XXXX-evidence.md` (XXXX = numeric task part).

Ledger archive: `TASKS.archive.md` stores `done` rows no longer referenced by any non-`done` row's Depends on cell; `scripts/check-ledger.mjs` validates both files as one union (the same `WMB-*` id must not appear in both), and when active `TASKS.md` exceeds 120 lines run `node scripts/tasks-archive.mjs` to move eligible `done` rows there (append-only, idempotent, byte-preserving).

CAP eval: for every `CAP-xxx` in SPEC, if all tasks referencing it are `done` and the largest such task number is ≥ 4810, `.ai/evals/EVAL-CAP-xxx.md` must exist (compare by the CAP number as lowercase 3 digits; file name uppercase, e.g. `EVAL-CAP-025.md`).

Current state:

- Active tasks: none
- Next eligible tasks: none
- Blocked tasks: none
- Product form lock + Role/Capability lock 2026-08-07: PRODUCT C8, PRD §2.3, SPEC CAP-026, spark role-permission-design

| Task | Milestone | Capability | Status | Depends on | Deliverable | Verification / evidence | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |

| WMB-5130 | M-5130 | CAP-011, CAP-017, CAP-018, CAP-022, CAP-025 | done | WMB-5122 | Repair X observation claim/recovery lifecycle, stop retry amplification, and reconcile the 15 live orphan rows without losing completed evidence | 2026-08-09: `.ai/wmb-5130-5134-evidence.md`, `.ai/wmb-5130-reconcile.json`, `tests/x-observation-jobs.test.mjs`; generation-safe recovery 16/16，实库 15 条 orphan 均转 failed，无 evidence 丢失。Capability registry impact: no change — 既有 observation authority。Pi operator Skill impact: no change — 后台生命周期修复。Independent review: ReviewWmb5130 — no blocker/major。 | main |
| WMB-5131 | M-5130 | CAP-014, CAP-025 | done | WMB-5122 | Complete the Node ESM relative-import cutover for the Pi dock dependency chain so direct test execution resolves every module | 2026-08-09: `.ai/wmb-5130-5134-evidence.md`; workspace import/profile/proposal 14/14，Electron adapter import smoke 3/3，未再出现 ERR_MODULE_NOT_FOUND。Capability registry impact: no change — 仅模块解析边界。Pi operator Skill impact: no change — 不改工具语义。Independent review: ReviewWmb5133Final — integrated review approved。 | main |
| WMB-5132 | M-5130 | CAP-025 | done | WMB-5122 | Bring deterministic EVAL-029 fixtures forward through migration 50 while preserving their frozen business parent and manifest invariants | 2026-08-09: `.ai/wmb-5130-5134-evidence.md`, `tests/eval-029-fixtures.test.mjs`; migration 50 冷 fixture 9/9，两次 bounded cold process 保持冻结 parent/manifest。Capability registry impact: no change — fixture-only。Pi operator Skill impact: no change — fixture-only。Independent review: not required — test-only。 | main |
| WMB-5133 | M-5130 | Cross-capability UX | done | WMB-5122 | Reconcile Discover accessibility/ownership assertions and remaining stale UI/runtime contract tests against current product behavior | 2026-08-09: `.ai/wmb-5130-5134-evidence.md`, `tests/pi-conversation.test.mjs`; UI/runtime 35/35+18/18，pool 12/12，Pi 18/18；business-day readback、生命周期显式中断恢复、Skill 工具清单完成。Capability registry impact: no change — authority 未扩张。Pi operator Skill impact: updated — 同步已注册工具清单。Independent review: ReviewWmb5133Final — 两项 finding 均关闭，无新问题。 | main |
| WMB-5134 | M-5130 | CAP-014, CAP-025 | done | WMB-5130, WMB-5131, WMB-5132, WMB-5133 | Close the residual diagnosis with bounded full-suite completion, typecheck, ledger checks, Electron smoke and independent review | 2026-08-09: `.ai/wmb-5130-5134-evidence.md`; final `npm test` 552/552，typecheck、capability/ledger/intake/prototype gates pass；实机 Electron Today/Studio 无 error boundary/横溢出。Capability registry impact: no change — integration-only。Pi operator Skill impact: no change — 5133 单独记录 Skill 更新。Independent review: ReviewWmb5133Final — approved。 | main |
| WMB-5135 | M-5130 | Cross-capability UX | done | WMB-5122 | Studio+Pi 遮挡根因修复：消除 Pi 展开 + 创作页下版本上下文抽屉/编辑区/pi-dock 的用户可见重叠，仅根因最小修复，不重做创作页或 Pi | 2026-08-09: .ai/wmb-5135-evidence.md；3 viewport×4 状态 12/12 noOverflow/overlap PASS；Tab/Esc PASS；typecheck PASS；renderer smoke PASS；lightweight check PASS。Capability registry impact: no change — 纯 renderer 样式修复，不触碰 registry。Pi operator Skill impact: no change — 不改 Pi dock 布局契约与 Skill。Independent review: ReviewWmb5135 — approved；唯一 minor（<=1180 canvas 30px padding）已恢复并复核 closed。 | studio-ui |




| WMB-1305A | M-1300 | CAP-005, CAP-014, CAP-016 | done | WMB-1305 | Replace the standalone context-package interface with direct page selection | 2026-07-29 Owner changed the contract twice: no package UI and no invisible package/snapshot rows. The minimal reproduction counted real DB `knowledge_context_packages=1` and `knowledge_context_uses=3`, then showed the old turn wrote both. The replacement resolves the current canvas read-only immediately before send and embeds that exact manifest in the existing Pi session turn; renderer no longer calls package create/use for direct context. Hidden real Electron on normal user data showed no package UI, default `当前页 2 项`, checkbox multi-select `已选 2 项`, and blank-board pointer down/up restored `当前页 2 项`. A selected-one real Pi turn returned exactly title `Chubby Skills…` and node `0bae3d3d-216c-45cd-bcb3-3f350e7ef61e`; the new session JSONL turn contains only that direct manifest and no tool call, while DB stayed exactly `packages=1, uses=3`. 1100×700 and 1920×900 had zero document/body overflow; screenshots `.ai/wmb-1305a-direct-context-1100.png` and `wmb-1305a-direct-context-1920.png`. Typecheck and lightweight harness passed. Historical package rows/APIs remain read-only-compatible but new UI creates none. | Codex |
| WMB-5116 | M-5110 | CAP-027, CAP-026, CAP-021, CAP-014 | done | WMB-5115 | GenericEmployeeRunner clean cutover + resource-wait locks + librarian real execution | 2026-08-09: `.ai/wmb-5116-evidence.md`; focused pool/spawner/L2 33/33; typecheck + capability check + lightweight harness pass. Isolated live: reporter+writer+librarian concurrent succeeded with business readback; running librarian cancel 1.2s, task cancelled, job lease released. Capability registry impact: no change — existing role/capability intersection retained. Pi operator Skill impact: updated — spawn/writer prompts no longer expose intent. Independent review: ReviewWmb5116 — approved; four findings closed. | main |
| WMB-5117 | M-5110 | CAP-027, CAP-021 | done | WMB-5116 | transient controls foundation：pool RESOURCE_JUDGE_IN_FLIGHT 三码泊车+skip-self、JobExecutionOutcome 瞬时 deferred 类型、job-control.ts 抽取 cancel 序列+stoppable 注册协议、job-spawner 拆分与 line-caps 登记 | 2026-08-09: `tests/job-pool.test.mjs` + `tests/job-spawner.test.mjs` 32/32 pass；`npm run typecheck` pass；job-spawner 488 lines/cap 488。Capability registry impact: no change — agent-capabilities/page-authority 零改动。Pi operator Skill impact: no change — 池内部机制非提示词语义。Independent review: ReviewWmb5117 — approved；无 blocker/major，两个 minor 已修且回归通过。最终集成 .ai/wmb-5117-5122-evidence.md | main |
| WMB-5118 | M-5110 | CAP-027, CAP-021 | done | WMB-5117 | scan/judge：守卫 deferred+透传、scan 不可变快照、assembleOutcome deferred/快照路由、parkDeferred 与晋升/看门狗验证 | 2026-08-09: .ai/wmb-5118-evidence.md；job-scan-judge-race 9/9，pool 16/16，spawner 16/16，L2 17/17；typecheck pass；job-spawner 486 lines/cap 486。Capability registry impact: no change — agent-capabilities/page-authority 零改动。Pi operator Skill impact: no change — R1 为 waitReason 事件语义非提示词语义。Independent review: ReviewWmb5118 — approved，无 finding。最终集成 .ai/wmb-5117-5122-evidence.md | ScanRace |
| WMB-5119 | M-5110 | CAP-027, CAP-021 | done | WMB-5118 | hard cancel：四角色 registerStoppable 接线、onTaskReady abort 门、bestEffortCancelTask 全角色、取消序列总门 ≤5s | 2026-08-09: .ai/wmb-5119-evidence.md + .ai/wmb-5122-e3-reverify.json；T-09/T-11/T-12 + planner cancel race 4/4 过（四角色取消总门 ≤5s）；npm run typecheck pass。实机失败（planner 4/4 agent_task 落 partial，superseded）→ 5119 fix 后 E-3 复验全项 PASS：reporter 58ms、planner cancelled 4597ms、writer 2060ms lateMutation0、librarian 2092ms，四角色 task cancelled/Pi 退出/lease0。Capability registry impact: no change — agent-capabilities/page-authority 零改动。Pi operator Skill impact: no change — R2 为系统层动作非提示词语义。Independent review: ReviewWmb5119 — approved，无 blocker/major。 | HardCancel |
| WMB-5120 | M-5110 | CAP-026, CAP-021 | done | WMB-5117 | grant 终态显式 revoke：dispatchRevokeTaskGrantsForTask + dispatchTask 终态钩子 + 幂等/交接回归 | 2026-08-09: .ai/wmb-5120-contract.md + tests/job-l2-integration.test.mjs；L2-12..17 6/6 且全 L2 17/17；typecheck pass。Capability registry impact: no change — agent-capabilities/page-authority 零改动。Pi operator Skill impact: no change — R3 为会话后回收非提示词语义。Independent review: ReviewWmb5120 — approved，无 finding。最终集成 .ai/wmb-5117-5122-evidence.md | GrantRevoke |
| WMB-5121 | M-5110 | CAP-027, CAP-026, CAP-014 | done | WMB-5118 | structured no-op：严格 fenced JSON {"wmb_noop":true} 协议 + 删除正则回退 + 三处提示词 | 2026-08-09: .ai/wmb-5121-contract.md + tests/job-pool.test.mjs + tests/pi-extension.test.mjs；T-18/T-20 及 Skill 测试过，聚焦 70/70；npm run typecheck pass。Capability registry impact: no change — agent-capabilities/page-authority 零改动。Pi operator Skill impact: updated — 严格 wmb_noop fenced JSON 三处协议。Independent review: ReviewWmb5121 — approved，无 finding。最终集成 .ai/wmb-5117-5122-evidence.md | StructuredNoop |
| WMB-5122 | M-5110 | CAP-027, CAP-026, CAP-021, CAP-014 | done | WMB-5118, WMB-5119, WMB-5120, WMB-5121 | integrated：聚焦套件+typecheck+check:capabilities+lightweight+隔离实机+独立复审+证据包+ledger 六行 | 2026-08-09: .ai/wmb-5117-5122-evidence.md + .ai/wmb-5122-live-e0-e5.json + .ai/wmb-5122-e3-reverify.json；实机 E0/E1/E2a/E2b/E4/E5 PASS，E3 FAIL→fix 后复验 PASS；E6 聚焦 75/75 + typecheck + check:capabilities + lightweight（check.ps1）pass；job-spawner 468/cap 468。Capability registry impact: no change — 集成/证据任务。Pi operator Skill impact: no change — 六任务合并验收逐任务注明（仅 5121 updated）。Independent review: ReviewResidualClosure — approved；major 撤销，无 findings。 | main |


