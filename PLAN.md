# WeMediaBuddy Delivery Plan

This plan orders the complete current PRD. Phases are dependency gates, not reduced scope or an MVP.


## M-5100 角色编制 × Capability 注册表（CAP-026）

Scope: implement fixed staff roles + Capability registry + harness gates + readonly Agents page; then scan/judge split and worker roleId. Canonical design `docs/spark/2026-08-07-role-permission-design.md`. Owner approved 2026-08-07 full lock + harness first.

Order:

1. `WMB-5100` — harness + legislate + registry file + CI gate (this foundation).
2. `WMB-5101` — grant filter by roleId in ensureAutomaticTaskGrant + tests.
3. `WMB-5102` — readonly Agents roster page + nav.
4. `WMB-5103` — P0 evidence / focused regression (desk zero-regression).
5. `WMB-5104` — split daily_scan / daily_judge intents (P1).
6. `WMB-5105` — lease roleId + roster live projection API (P1).
7. `WMB-5106` — safe capability overlays UI (P2; blocked until P0/P1 gates).

Gate P0: `npm run check:capabilities` green; writer cannot receive lane_restore via filter; Agents view readonly; no capability_overlays write IPC.



## M-5110 Desk 经理 + 员工工单池（CAP-027）

Scope: main Pi = Desk manager; role agents = subagent jobs with worker pool (default maxWorkers=2), per-job session, role-filtered grants (CAP-026 reuse), entity locks on planDate/projectId. Canonical: `docs/spark/2026-08-07-desk-manager-job-runtime.md`. Aligns role-permission design §11 P1 worker pool + single-hop dispatch.

Order:

1. `WMB-5111` — JobPool + multi-lease runtime
2. `WMB-5112` — JobSpawner + role grant projection
3. `WMB-5113` — jobs IPC + preload
4. `WMB-5114` — Agents job board + today chip
5. `WMB-5115` — tests + evidence pack

Gate: job-pool tests green; two non-conflicting leases; roster shows multi running; CAP-026 registry unchanged except wiring.


## M-5140 智能体班组多实例协同（固定五角色 × 按任务实例）（CAP-027）

Scope: implement the formal construction Owner lock `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` (§17) on top of the M-5110 JobPool runtime: role ≠ slot, same-role multi-instance with explicit visibility, instances created per task and exiting the active view at terminal state, shared pool as pure capacity (maxWorkers 0..7), desk as coordination entry (not supervisor workstation), instance permission = task grant ∩ role capability ∩ resource boundary with dispatcher object-level hard isolation, red lines unchanged, jobId first-class identity with active-period-only display numbering, needs_user staying in the active view without holding slot/lease/grant/lock, and the persistent re-dispatch contract in the existing `context_refs_json` (no new table/column). Spec: PRODUCT C9, PRD §2.4 (REQ-028/REQ-029, AC-024..AC-027), SPEC §1.0 items 8-9 and CAP-027 (EVAL-030).

Owner lock 2026-08-08 (13 points; authoritative text in design doc §17):

1. 固定五角色（桌助/记者/策划/写手/资料员）跨赛道稳定。
2. 同角色多实例显式可见。
3. 实例按任务创建，终态退出活动视图（needs_user 例外见 9）。
4. 不预设空槽：五角色分组始终可见，空角色「当前无任务」。
5. 共享并发池仅系统容量：maxWorkers（0..7，0=停用派工，默认 2）。
6. 桌助是协调入口，不是主管工位（无 standing 写权、不进员工槽、不代批）。**（2026-08-10 主管授权翻转修订：历史锁保留；现行规范 = M-5180——主管（desk）= 软件内主管/主编席，全站内部 standing 写权，内部审批归主管，红线三类仅人类 UI。）**
7. 实例权限 = 任务精确授权 ∩ 角色能力 ∩ 资源边界。
8. 发布/硬删红线不变（agentGrantable:false 对一切实例不可达）。
9. needs_user 停留活动区「等你批」至用户处理/关闭，期间不占并发/lease/grant/锁。
10. 空态呈现：五角色分组始终可见，空角色「当前无任务」，不画空槽。
11. 角色编号仅活动期显示，持久身份 jobId。
12. 对象级硬隔离（施工必需）：dispatcher 校验工单对象边界，跨对象写拒绝。
13. 持久续派合同：jobId/roleId/brief/边界参数写入既有 context_refs_json，不新增表。

Order (dependency: 持久合同+对象 gate → 运行投影 → UI → Skill → 验收):

1. `WMB-5141` — 持久续派合同 + dispatcher 对象级硬隔离：spawn 合同写 jobId/roleId/brief/边界参数入 `context_refs_json`；`agent_tasks`/`task_grants`/`execution_grants` 三表 schema 零改动；对象键校验（businessDate/projectId/sourceIds/scope）跨对象写 BLOCKED + 审计；check:capabilities G1 + effective grant 一致性 G2。
2. `WMB-5142` — 运行投影：实例一等身份 jobId、活动期编号、终态顺序（agent_task 终态 → grant 回收 → lease/锁释放 → pool 终态）、scan→judge 单活动实例不双计、历史只从持久面重建。
3. `WMB-5143` — 智能体页实例驱动 UI：五角色分组始终可见、空角色「当前无任务」、实例卡、needs_user「等你批」停留、页头摘要（工作中/排队/等你批）、历史折叠 + 一键续派。
4. `WMB-5144` — Pi operator Skill 多实例感知 + 桌助呈报/续派路径（不新增 Skill；提示词按 `docs/pi-operation-skill-maintenance.md` 规程登记）。
5. `WMB-5145` — 验收：EVAL-030（设计 §14 A1..A14）+ 聚焦测试 + typecheck + check:capabilities + 实机；变更集零新增角色/能力，注册表零改动。

Gate: EVAL-030 passes; same-role multi-instance visible; empty state shows 「当前无任务」 without seats; needs_user stays without slot/lease/grant/lock; restart re-dispatch from `context_refs_json`; cross-object write blocked with audit; red-line commands unreachable; check:capabilities green. **TASKS doing 仍是唯一施工许可**：每个任务须自带任务合同（显式引用设计 §12 兼容原则与 §16 影响面）+ 施工 Owner lock，进入 TASKS doing 才可开工。


## M-5150 主题整理提案与 Owner 审批（CAP-003 / CAP-026）

Scope: 资料员整理主题家底，生成精确变更台账；桌助呈报；Owner 批准后整批原子生效。覆盖主题新建、修改、合并、归档和关系迁移，stale 零部分写；禁止把整理退回 Owner 手工执行。Canonical design: `docs/spark/2026-08-10-topic-maintenance-approval-design.md`。

Order:

1. `WMB-5150` — legislation + durable proposal ledger + transactional apply/reject + librarian job/Pi tools + Topic/Today approval UI + EVAL-031 evidence。

Gate: real duplicate-topic proposal has zero pre-approval mutations; reject zero business write; approve migrates all formal links and archives old topic in one transaction; stale zero partial write; Agent apply blocked; Topic/Today/desk projections agree; operator Skill, typecheck, capability gate, focused tests and renderer smoke pass。

## M-5160 主题冲突合同与自动重提（CAP-003 / CAP-026）

Scope: replace snapshot-wide stale inference with one persisted intent-level conflict contract; real conflicts atomically enqueue a domain-specific reproposal outbox, then dispatch librarian after commit and recover across restart. Preserve immutable old proposals, Owner-only approval and legacy stale history. Canonical design: `docs/spark/2026-08-10-topic-maintenance-conflict-reproposal-design.md`。

Order:

1. `WMB-5158` — snapshot v2 conflict contract, structured conflict evidence and v1-compatible reads/decisions。
2. `WMB-5159` — topic reproposal outbox, stable internal job identity, post-commit dispatch, bounded failure handling and cold-start recovery。
3. `WMB-5160` — supersession UI, historical stale classification, operator Skill/Pi prompt synchronization and EVAL-031 full acceptance。

Gate: irrelevant drift approves; true conflict writes zero formal facts and one durable outbox in the approval transaction; no Agent runs before commit; duplicate click/kick/restart creates one successor from current facts; old/legacy proposals remain immutable; focused/full/typecheck/capability/lightweight/smoke and real Electron approval-to-successor readback pass。


## M-5170 ResearchJob 补料与研究续派（窄例外）（REQ-031 / CAP-028）

Scope: 立法落档正式 Owner lock `docs/spark/2026-08-10-agent-research-job-design.md`（§5–§13 R1–R13）：记者 = 统一补料执行者，新增 `cap.research`（L2 注册表唯一扩展点，readToolWhitelist 可选字段，`sources.upsert_batch` 唯一写回）；新独立 Web 读工具 `wmb_search_web`/`wmb_read_web_page`（channel resolve/trial 保持渠道语义、不承载研究读面）；research 会话读硬门 fail-closed（P1.4 读门窄域首落）；深度档 12 分钟 / 15 有效来源 / 40 候选 / 3 并行 / 仅一轮；claim 机器校验四态；`research_claims` 为 REQ-031/CAP-028 授权的唯一新增研究业务表（非续派合同表，消解与 PRD §2.4.8 / REQ-029 / CAP-027 §8 的字面冲突）；自动续派 = 系统终态处理器创建新 job（非重试），每父工单至多一次，research→research 禁止。PRODUCT C9 窄例外增补 C9.2（设计 §10 误写 C9.3，以 C9.2 为准）。仅立法，不产生实现计划与任务编号（R13）。

Canonical design: `docs/spark/2026-08-10-agent-research-job-design.md`（§5–§8 契约 + §10 立法清单 + §12 EVAL-032；Owner lock 2026-08-10 正式锁定）。

Depends: M-5110 / M-5140（JobPool 运行时、持久续派合同与对象级硬隔离之上）。

Order (dependency order: 立法 → 注册表/读工具 → 读硬门 → 持久化 → ResearchJob → 自动 successor → UI/Pi Skill → EVAL-032):

1. **立法** — PRODUCT C9.2 窄例外 + C9.10/C9.11 范围澄清；PRD §2.5 + REQ-031 + AC-029（`research_claims` 唯一新业务表，消解字面冲突）；SPEC CAP-027 兼容澄清 + CAP-028（含 Web 安全条款）+ EVAL-032。
2. **注册表 / 读工具** — `cap.research` 登记（readToolWhitelist；TASK_INTENT_NEEDED_CAPS / AUTOMATIC_TASK_GRANT_SCOPES / roleForTaskIntent）；注册 `wmb_search_web` / `wmb_read_web_page`。
3. **读硬门** — research 会话按 readToolWhitelist fail-closed：越权 READ_PROFILE_BLOCKED（reason RESEARCH_READ_WHITELIST）+ 审计；其余角色/意图零回归。
4. **持久化** — late-migrations v54：agent_tasks intent CHECK 重建 + `research_claims` DDL；ResearchGap / 预算 / checkpoint / EvidencePack 分落 context_refs_json / progress_json / checkpoint_json / result_refs_json。
5. **ResearchJob** — 记者补料工单运行：预算硬边界、`wmb_save_source` 证据入库（originalUrl 去重、price/policy 带时间+摘录、无 feedId）、claim 机器校验、resume_pending 重启恢复。
6. **自动 successor** — 系统终态处理器创建新 job（非重试）：research_successor（dedupe_key UNIQUE + INSERT OR IGNORE 幂等）→ 调度器派生原角色续派；未答 required claim 先入 needs_user（收窄 / 手动补料 / 接受标注待核实）；三层硬止环。
7. **UI / Pi Skill** — 智能体页记者卡 + needs_user 等你批；Today 只上 unresolved required needs_user；operator Skill playbook（lane Skill 不复制）。
8. **EVAL-032** — GLM 5.2 端到端验收（13 条可证伪条款）+ 机械层测试（claim 门槛矩阵、读白名单负断言、successor 幂等、Web URL 校验）。

Gate: EVAL-032 全 13 条 + AC-029 通过（真实 GLM readback：writer evidenceGap → 桌助自动派 research → 证据入库 → 终态处理器自动续派一次 → 续派新稿无无出处数字）；读硬门负断言（白名单外工具含 channel resolve/trial 必被 READ_PROFILE_BLOCKED + 审计）；research_claims 约束（UNIQUE(task_id, claim_key) / CHECK 枚举 / 机器校验，伪造 supported 降级 unresolved）；successor 唯一（同 parentJobId 重放仍只产出一个 research_successor，research→research spawn 拒绝）；Today 只上 unresolved required needs_user；重启从 checkpoint + research_claims 恢复；check:capabilities green；typecheck green。


## M-5180 主管全站内部授权（desk = 软件内主管）（CAP-026 / CAP-027 / CAP-003 / CAP-028）

Scope: 正式 Owner lock `docs/spark/2026-08-10-supervisor-authority-design.md`（§8 全 10 项确认，approach A，2026-08-10）立法与施工：身份翻转（desk = 软件内主管/主编席，用户可见身份统一，删除「桌助/协调入口」文案）；授权翻转（主管 standing = 全部 grantable 业务能力命令 ∪ INFRA_GRANT_COMMANDS，含内部准备命令，不含三类红线执行命令；任一页 dock 绑定主管签发全量内部 grant）；红线恰三类（类别，非命令清单）——最终平台发布、硬删执行、外部平台变更执行——最终动作仅人类 UI 新鲜确认（Precise Gate + Owner UI），主管可准备不可执行；内部审批（`knowledge.topic_maintenance_approve / reject / reproposal_retry`）重分类归主管（`agentGrantable:true`、`precise:false`、`{desk:true}`）；员工隔离与 grant/lease/Precise/审计纪律不变；`spawn(roleId:'desk')` 仍拒绝；standing 集变化经 `sameCommandSet` 自动换发 + 写前 `TASK_SCOPE_BROADENED` 恰一次安全重试；新内部写命令默认绑定主管（仅红线类别执行命令例外）；主管 v1 不参与 overlays；非中止 Pi 行为（红线/基建/注册缺口三类拒绝 + `[WMB_AUTHORITY_BLOCKED]`）。

Canonical design: `docs/spark/2026-08-10-supervisor-authority-design.md`（§0/§2/§4/§5/§6/§7/§8）；canonical 修订：`docs/spark/2026-08-07-role-permission-design.md`、`docs/spark/2026-08-08-agent-crew-multi-instance-design.md`、`docs/spark/2026-08-10-topic-maintenance-approval-design.md`、`docs/spark/2026-08-10-topic-maintenance-conflict-reproposal-design.md`。

Order (dependency order: 立法 → 注册表/授权核心 → 边界/审批 → 身份/文案 → 验收):

1. `WMB-5181` — **立法（Legislate）**：PRODUCT C9.6 / PRD §2.3/§2.4/§2.5 + REQ-029/REQ-030/AC-027/AC-028 / SPEC §1.0 + CAP-026.9/CAP-003/CAP-027.6/CAP-028 + EVAL-030/031 + PLAN M-5180 + canonical 修订 + 实施合同 5182-5185。只立法不实现。
2. `WMB-5182` — **authority core：注册表形状 / deskStanding + task/page grant 续期**（deskStanding 常量、`roleWriteCommands('desk')`、`filterCommandsForRole`、删除 `pageScopePassThrough`、cap.topic_approval 翻转、REDLINE_COMMANDS 三类类别化、`ensureAutomaticTaskGrant`/`assertTaskGrantForEnvelope` desk 基底与续期、`ensurePageAuthority` 发布页签发、`setCapabilityOverlay` desk 拒绝、`DESK_ROSTER_FACE` 删除、check-capability-registry 检查 4/6/7 翻转）。
3. `WMB-5183` — **边界：安全内部准备 vs 不可逆/外部执行 + 主题审批**（channel `proposal_apply` 无 remove 安全路径归主管/含 remove 硬删路径 Owner UI；x_lists 新增 internal prepare 命令 + `operation_execute` 保持 precise Owner UI；`publication.editor_prepare_execute` 精确人工确认边界、最终 publish click 永不自动；topic approve/reject/reproposal_retry 仅主管可授予，员工/外部 Agent 拒绝零写）。消费 5182 注册表契约。
4. `WMB-5184` — **身份/提示词/Skill/renderer 文案**（`PI_AUTHORITY_SYSTEM_PROMPT`、`skills/wemedia-buddy-operator/SKILL.md` + 镜像、MCP 工具描述、roster/renderer 文案 → 主管/主编席；不改 grant 语义）。
5. `WMB-5185` — **集成验收 / live 证据**（设计 §7 A1–A9 落为测试与实机场景；EVAL-030 desk 行翻转、EVAL-031 主管审批；仅可修复 5182–5184 归属源码的集成缺陷）。

Gate: A1 standing 集断言（`roleWriteCommands('desk')` == `commandsCoveredByGrantableCapabilities() ∪ INFRA_GRANT_COMMANDS` 且与红线执行命令集交集为空）；A2 跨页写（发布页绑定主管签发全量 grant、员工仍只读）；A3 红线回归（channel 安全应用成功/含 remove 拒绝零写、x_lists internal prepare 成功 + operation_execute Precise 拦截、editor_prepare_execute 精确人工确认、硬删 Owner UI only）；A4 内部审批（主管应用原子生效 + 读回；资料员/策划/外部拒绝零写；真冲突 stale 零写 + 重提仍主管批准）；A5 员工隔离回归；A6 续期 + 恰一次重试；A7 非中止 Pi 行为；A8 文案 grep 门（无「桌助/协调入口」残留，desk 行 = 主管/主编席 且写命令数 > 0）；A9 实机演练；check:capabilities green；typecheck green；`npm run check:capabilities` 断言翻转后全绿。**TASKS doing 仍是唯一施工许可**：每个任务须自带任务合同（显式引用设计 §4/§6/§7）+ 施工 Owner lock，进入 TASKS doing 才可开工。


## M-5000 产品形态宪法锁定（Agent 主路径终端）

Scope: freeze product form so later Today/desk/topic/opportunity work cannot drift back to traditional CMS or VS Code-like human-primary IDE. Docs/rules only in the freeze task; continuous-attention rewrite to topic projection is a follow-up milestone, not silently implied by this lock.

Normative:

- `PRODUCT.md` constitution C1–C7
- `PRD.md` §2.0
- `SPEC.md` §1.0
- `AGENTS.md` Project goal
- Detail: `docs/spark/2026-08-07-product-form-agent-desk-constitution.md`

Owner lock 2026-08-07:

1. Form = Codex Desktop-like agent-primary terminal; reject VS Code-like human-primary writing IDE.
2. Human = editor-in-chief (approve/dispatch/supervise/publish confirm/liability); Agent = primary labor.
3. Today = editor desk for decidable/must-know submissions only.
4. Long-horizon attention formal identity = **Topic**; continuous-attention must not dump untriaged sources as opportunity-drafting offload.
5. Topic induction = LLM editorial judgment, not regex primary.

Order:

1. `WMB-5000` — write constitution into PRODUCT/PRD/SPEC/AGENTS/README + spark detail + ledger (this freeze).
2. Follow-up (separate milestone when scheduled) — **same four items as** `docs/spark/2026-08-07-product-form-agent-desk-constitution.md` §8:
   1. Replace Today continuous-attention: retire `work_carry_items` + `storyKey`/`sameStory` as long-horizon identity; project **topic progress**.
   2. Backend upsert/merge **topic** + link evidence when agent marks long-horizon worth (LLM induction, not regex primary).
   3. Stop promoting bare high-value sources onto the desk without an opportunity brief.
   4. UI glossary: 关注 / 主题 / 选题 / 资料.

Gate: any new desk/topic/opportunity design cites §2.0 / SPEC §1.0 / PRODUCT C1–C7; agents read AGENTS form clause before those surfaces; follow-up work must name replacement of carry/storyKey rail explicitly.

## M-5001 持续关注 → 主题进展投影

Scope: implement product-form constitution §8 four items for Today continuous-attention. Replace long-horizon rail identity from `work_carry_items`+`storyKey`/bare source to **topic progress**. Keep plan_item carry for proposals state machine. Does not redesign chair/opportunity pool.

Design: `docs/spark/2026-08-07-continuous-attention-topic-progress-design.md`  
Normative: PRODUCT C3/C4, PRD §2.0, SPEC §1.0, form constitution §5/§8

Owner lock (inherits M-5000):

1. Rail long-horizon identity = Topic only.
2. Stop bare high-value source desk promotion.
3. plan_item open/dismiss stays on proposals/carry — not the attention identity.
4. Topic induction remains LLM/multi-day bind + evidence link; no regex primary.

Order:

1. `WMB-5001` — freeze this design + hang 5002-5004.
2. `WMB-5002` — `listFermentingBundle` topic-progress projection; no-op `seedCarryFromHighValueSources`; plan-save topic↔source links.
3. `WMB-5003` — FermentingRail topic UI + glossary + create/open path.
4. `WMB-5004` — focused tests + typecheck + evidence.

Gate: rail shows topics never bare sources; proposals restore intact; ferment/desk focused tests green.




## M-4990 今日情报任务控制鲁棒性

Scope: make Today daily-intelligence controls (save_partial / cancel / timeout / zombie) reliable: click feedback, bounded exit from running, sync terminal state after abort, stall/wall-clock paths. Does not redesign judgment content, Today visual IA, or Pi page authority (M-4980).

Design: `docs/spark/2026-08-07-daily-intelligence-control-robustness-design.md`
Owner lock 2026-08-07: wall clock 30m auto partial; stall>10m auto partial (P1); cancel keeps ingested sources; zombie primary=cleanup keep results; start P0 now.

Order:

1. `WMB-4990` — freeze design and hang chain (docs/ledger).
2. `WMB-4991` — control-daily authoritative sequence + idempotent + single-flight.
3. `WMB-4992` — UI pending/error/refresh for save_partial/cancel.
4. `WMB-4993` — runner catch dual-path + abortDailyIntelligence harden; no rewrite after terminal.
5. `WMB-4994` — zombie running CTA + minimal startup interrupted reconcile.
6. `WMB-4995`–`WMB-4998` — P1/P2 stall wall-clock, scan cooperative cancel, tests, diagnostics.

Gate: synthesis-phase save_partial leaves running within 15s with UI feedback; no 68m hang; zombie cleanable.

## M-4980 内置 Pi 页面级权限（dock 自由对话）

Scope: replace studio-only dock auto-grant with page-scoped `PAGE_TASK_GRANT_SCOPES` + `page_*` intents; library organize tools (soft archive/restore/status); authority chip and non-silent BLOCKED errors. Does not auto-grant X List platform mutation or final publish (PreciseExecution stays). Owner lock 2026-08-07: 1A hard-delete Owner-UI only; 2A grants expire ~4h without revoke-on-leave; 3A discover observation may auto-grant.

Design: `docs/spark/2026-08-07-pi-page-authority-design.md`  
Audit: `.ai/2026-08-07-pi-page-authority-audit.md`

Order:

1. `WMB-4980` — freeze design/audit + hang 4981-4986 (docs/ledger).
2. `WMB-4981` — shared `page-authority` table + AgentIntent/page_* migration + AUTOMATIC_TASK_GRANT_SCOPES.
3. `WMB-4982` — `ensurePageAuthority` replaces studio special-case in pi dock.
4. `WMB-4983` — MCP `lane_gate` / `lane_restore` / `sources.update_status` + library P0 tools.
5. `WMB-4984` — operator Skill + authority prompt BLOCKED guidance.
6. `WMB-4985` — chip + `pi:authority-status` + non-silent authorize failures.
7. `WMB-4986` — focused tests, typecheck, evidence, studio regression.

Gate: library dock can soft-archive/restore/status with grants; publish dock readonly BLOCKED; studio save_version still works; no silent authorize swallow.



## M-4970 Pi 页面点选焦点统一

Scope: unify “click card = Pi focus without navigating in” across workflow pages. Today’s opportunity/source multi-select is the reference. Delivers interaction contract, shared selection helpers, payload honesty, then per-page wiring starting with Proposals and Results. Does not add comment/DM scraping, settings Pi dock, or full-page screenshot context.

Design: `.ai/2026-08-07-pi-page-context-selection-audit.md`  
Owner lock 2026-08-07: single-click focuses Pi context; enter detail is a separate gesture; prefer single-focus by default; multi-select kept where Today/canvas/rankings already use it.

Order:

1. `WMB-4970` — freeze audit/contract and hang 4971-4976 (docs/ledger only).
2. `WMB-4971` — shared focus helper + `buildPiContextPayload` pure module + unit tests.
3. `WMB-4972` — Proposals page click-to-focus (no navigate) + main `piContext` branch.
4. `WMB-4973` — Results click-to-focus + shallow metrics/review fields in payload.
5. `WMB-4974` — Studio list click=focus vs open-editor; editor auto-focus + body excerpt.
6. `WMB-4975` — Publish / Library / Topic align to contract.
7. `WMB-4976` — Today ferment item focus + chip/clear copy consistency + acceptance evidence.

Gate: Proposals/Results/Studio-list support focus-without-enter; Chip honest when empty; Today multi-select and canvas/X-list do not regress; settings still has no business Pi dock.


## M-4960 AI×个人商业化成长配方落地

Scope: tighten the existing `official.ai` workspace + `wemedia-intelligence-engine` judgment/creation copy into Owner-locked「AI × 个人商业化成长」without a new lane, pack id, or publication automation. Delivers template v2 identity strings, official-root re-ensure (current `ensure` no-ops on existing profiles), dailyPrompt/Skill four-question overlay, lane-gate copy, review/method seed docs, and Owner ops checklist. Does not implement xhs editor prep, method-library aggregate UI, ReviewRecord new columns, product-seed automation, or M-4950 proposal-ledger P1.

Design: `.ai/2026-08-07-ai-commercialization-recipe-impl.md`  
Strategy: `docs/spark/2026-08-07-ai-personal-commercialization-wmb-plan.md`  
Owner lock 2026-08-07: rename display; accept xhs manual publish for 90d; map commercialization signals into review summary/notes first; bump officialTemplateVersion and re-ensure official AI roots; add indie-hacker / tool-review X List via config (no hard-coded list ids).

Order:

1. `WMB-4960` — freeze design, Owner resolutions, and 4961-4965 chain (docs/ledger only).
2. `WMB-4961` — `official.ai` template v2 + ensure upgrade path for official lineage + tests.
3. `WMB-4962` — `dailyPrompt` + intelligence opportunity Skill/standard commercialization overlay and column skeleton (parallel with 4961 after 4960).
4. `WMB-4963` — lane-gate / gate-section copy aligned to commercial audience (after 4961+4962).
5. `WMB-4964` — operator review template + method seeds doc (parallel after 4960).
6. `WMB-4965` — Owner ops checklist + acceptance evidence (after 4961-4964).

Gate: new and existing official AI roots surface commercial identity in editorial brief; judge prompt requires五维 hit; xhs remains manual-publish night-light; no fake List bindings; focused tests + typecheck green; M-4950 code surfaces untouched unless coincidental.

## M-4930 Today as editor desk（主编办公台）

Scope: reposition Today as the chief-editor desk — chair = current approvable opportunities (never cleared while a new run is in flight), secondary rail =「持续关注」(story-keyed event cards with “why still watching”), backlog labeled「待处理」, task/partial narrative stays on Discover. Does not change publication, precise grants, browser binding, Studio or Results schema; reuses `plan_items` + `work_carry_items`.

Design: `.ai/2026-08-06-today-editor-desk-design.md` (north-star revision; supersedes `.ai/2026-08-06-fermenting-rail-redesign.md` as the governing IA/copy/acceptance doc).

Order:

1. `WMB-4930` — land MVP: chair `displayItems` empty-pool fallback, storyKey merge +「持续关注」rail filter/fields/copy, pool「待处理」badge, planning carry reason seed, focused tests.
2. `WMB-4932` — close MVP gaps: chair pool storyKey dedupe (same-story one card) + live Electron acceptance (run keeps prior plan; copy; dismiss path).
3. `WMB-4931` (later) — full version: aftershock without topic hard-dep, optional `story_key`/`stage` columns, Discover owns task/partial stream, higher `topic_id` bind rate.
4. `WMB-4933` — zero-update empty current plan must not blank the chair: pool reads latest non-empty plan per date (not `is_current`); `latestPlan`/displayItems fall back to latest non-empty plan. Design: `.ai/2026-08-07-empty-current-plan-chair-fix.md`.


## M-4950 选题台账（编辑部提案夹）

Scope: new workflow nav「选题」between Discover and Studio — full decision ledger for plans/plan_items (今日可批 / 待处理·搁置 / 已采纳 / 已否掉 / 已过期). Today stays the editor desk only (chair + 持续关注 + one ledger entry link). Zero schema; reuse pool row source + create/dismiss write paths. Does not put archive drawers on Today, does not mix unadopted proposals into Studio, does not put plans into Discover.

Design: `.ai/2026-08-07-proposals-ledger-design.md`

Order:

1. `WMB-4946` — backend ledger query + shared pool helpers + IPC/preload/types + tests.
2. `WMB-4947` — frontend ProposalsView + nav + Today entry bar + adopt/dismiss wiring.
3. `WMB-4948` (later) — pagination, restore, batch ops, Pi context refinement.

## M-4940 Lane relevance gate（赛道资料门 / 有效资料库）

Scope: after broad channel collect, add a workspace-lane relevance gate before topic/opportunity judgment. Irrelevant sources leave the effective library with traceable reasons and restore; effective sources alone feed brief, Today source counts/feed, and four-question planning. Does not change scan-all collection, publication, precise grants, browser binding, Studio/Results, plan_items structure, or M-4930 chair/rail rules.

Design: `.ai/2026-08-07-lane-relevance-gate-design.md` (Owner-locked pipeline: 广收 → 赛道门 → 有效库 → 四问选题 → 今日办公台).

Order:

1. `WMB-4940` — freeze design and hang 4941-4945 implementation chain (docs/ledger only).
2. `WMB-4941` — `source_lane_judgments` contract + dispatcher `sources.lane_gate` / `sources.lane_restore` + judge grant mount.
3. `WMB-4942` — Tier0 official/lane-source pass + Tier1 same-turn binary gate with reason codes; archive write path; parse-fail zero-archive.
4. `WMB-4943` — effective-library consumers: brief increment filter + transparency line; Today feed/stats effective-only + tail count; searchSources default exclude + include flag; regression that ferment/knowledge consumers already exclude archived.
5. `WMB-4944` — Library「已移出」view with reason badges, restore, 7-day rejudge cooldown.
6. `WMB-4945` — end-to-end mixed-batch acceptance (split/restore/stats) + empty-run no-op (AC-017) + M-4930 desk regression.

Gate: lifestyle/off-lane noise is archived with reason and disappears from effective library/brief/Today counts; official/lane sources stay active without model call; restore returns to effective set and blocks rejudge for 7 days; parse failure archives nothing; chair/rail/pool invariants from M-4930 still hold.

## M-4910 Rolling opportunity pool and editorial brief

Scope: intelligence-to-topic pipeline only — channel failure isolation, incremental judgment with a live-assembled editorial brief, rolling opportunity pool semantics, Today pool projection, and bounded deep-dive ingestion. Does not change publication, precise grants, browser binding, Studio or Results; `plan_items` structure is unchanged (pool state rides the existing ferment/carry state machine).

Design: `docs/spark/2026-08-06-intelligence-to-topic-agent-design.md`

Order:

1. `WMB-4910` — land pure `assembleEditorialBrief` (identity/history/inventory/increment) with seed-DB fixtures.
2. `WMB-4911` — rewire daily judgment prompt to the brief and four-question mandate; judgment must not depend on browser state.
3. `WMB-4912` — isolate per-channel scan failure (official-web never browser-bound; X absence is annotated, never blocking) and unify rolling/manual scan entries.
4. `WMB-4913` — incremental judgment via checkpoint watermark, single-instance judge with queued follow-up, auto-trigger after each scan (Owner-approved trigger 甲).
5. `WMB-4914` — pool semantics: cross-date unterminated pool view in workbench plus ferment expired/dismissed states and publish-time same-topic demotion.
6. `WMB-4915` — Today pool projection: pool list, timeliness/new markers, evidence-chain links, channel-absent banner, dismiss action.
7. `WMB-4916` — deep-dive ingestion constraint (canonicalUrl required before citation) and preset native-search capability flag in Pi settings.
8. `WMB-4917` — end-to-end acceptance: absent-channel run, watermark continuity, review-visible-in-brief within minutes, pool four-question quality readback.

Gate: X absence never blocks judgment; every pool opportunity answers the four questions with clickable evidence; a review saved at 20:00 is visible in the brief of any judgment run at 20:05; no new scheduler framework, scoring system or second agent.

## M-4800 Workspace-scoped human-AI collaboration architecture

Scope: approved product/architecture contracts for workspace-isolated self-media operations, task-authorized AI autonomy, one authoritative business-command boundary, and explicit installation/workspace/runtime ownership. This milestone changes documents and freezes a migration chain only; it does not start implementation or weaken existing publication confirmation and evidence requirements.

Order:

1. `WMB-4800` — reconcile PRD, SPEC, technical architecture and the stale architecture guide; add the approved target-architecture document and dependency-ordered implementation tasks.
2. `WMB-4801` — seal current write/runtime/profile routes, legacy read compatibility and the real AI/UK fixtures used by EVAL-029.
3. `WMB-4802` — land BrowserProfile registry/default inheritance, explicit legacy-profile migration and root binding/account snapshots.
4. `WMB-4803` — establish the single ActiveWorkspaceRuntime owner, runtime epoch, bounded leases and switch/quit drain.
5. `WMB-4804` — land CommandEnvelopeV1, dispatcher, atomic receipts/replay/audit and one representative migrated mutation.
6. `WMB-4805` — land task grants and prove Pi/external-Agent continuation with persisted business facts.
7. `WMB-4806` — land precise-execution grants and UI-only issuance/revoke gates with stale zero-write behavior.
8. `WMB-4807` — route remaining UI/MCP/scheduler business writes through the dispatcher and remove migrated direct write paths.
9. `WMB-4808` — migrate browser side effects/publication reconciliation and retire implicit conversational/direct-tool authorization.
10. `WMB-4809` — complete legacy read compatibility, operator Skill synchronization and packaged EVAL-029 across real AI/UK roots.
11. `WMB-4812` — close the remaining current-package EVAL-029 coverage explicitly left by WMB-4809: real Pi model continuation under worker lease, packaged precise-grant negative matrix, and packaged immutable publication-snapshot/browser reconciliation.

Gate for WMB-4800: REQ-027, AC-023, CAP-025, EVAL-029 and `docs/architecture/workspace-ai-collaboration-architecture.md` agree on the same product center, scope boundaries, authority, runtime ownership and migration gates; while planning, WMB-4800 is the only `doing` task; on completion WMB-4801 is the next `todo`. No production code, schema, packaged Skill or runtime artifact changes in WMB-4800.

Gate for M-4800 completion: no `focusedCoverageRequired` remains and architecture §8 is proven in the current Windows package.


## M-4900 Today daily-intelligence mainline convergence

Scope: Today page user narrative only — one run view, one CTA matrix, no fake human todos. Does not redesign channel modules, Pi judgment prompts, or Studio/Results.

Design: `docs/spark/2026-08-06-today-daily-intelligence-mainline-design.md`

Order:

1. `WMB-4900` — freeze the design and hang the task chain (docs/ledger only).
2. `WMB-4901` — land pure `TodayRunView` projection and make Today render from that single source.
3. `WMB-4902` — remove fake plan pending actions; apply CTA/blocker matrix and minimal settings deep-links.
4. `WMB-4903` — regression evidence for start/continue/partial/needs_user paths without contradictory copy.

Gate: Owner can name the current step in one sentence; at most one primary CTA; no “创建今日运营方案” fake todo; real blockers are actionable; command bar, empty state and right rail never contradict.

## M-4700 Daily intelligence run isolation

Scope: existing CAP-014/CAP-020 daily-intelligence execution only; no validation, source-selection or plan-authority change.

Order:

1. `WMB-4700` — resolve the Beijing business date at click time, bind each daily task to its own Pi session, and return a durably saved partial task without emitting a Pi runtime failure.

Gate: an overnight-open Today view starts the current Beijing date; two tasks on one date cannot share a Pi transcript; a failed judgment with trustworthy receipts returns `partial`; current-task `plans.save` and real-source validation remain mandatory.

## M-4600 Pi delegated vision

Scope: CAP-014 delegated image understanding for a text-only primary model; reuse the pinned upstream Pi extension and the active OpenAI-compatible preset without adding an Agent framework or changing WMB business authority.

Order:

1. `WMB-4600` — package `pi-vision-tool`, register the explicit MiMo vision model alongside the active primary model, load the extension in RPC mode, and prove real text-only and image turns in the Windows package.

Gate: EVAL-028 passes; the primary remains DeepSeek V4 Flash, only an explicit image request invokes MiMo, the observation returns through a visible tool result, and failures do not fallback, mutate WMB business state or fabricate image content.

## M-4300 Pi conversation archive

Scope: the existing root-local Pi conversation index and header menu only; no deletion, Settings page or transcript rewrite.

Order:

1. `WMB-4300` — persist archive state, add archive/restore in the existing menu, and preserve a valid active conversation.

Gate: archive survives restart, disappears from the default list, restores from the archived view, leaves exact transcript/session files intact, and cannot interrupt an active Pi turn.

## M-4200 Deterministic direct X List member removal

Scope: extend the existing CAP-014/CAP-017 direct member-change contract to explicit removals; reuse the same operation persistence, browser executor, exact-handle validation and truthful readback.

Order:

1. `WMB-4200` — expose `x_lists.members_remove` and `wmb_remove_x_list_members`, synchronize the built-in operator Skill, and complete one real owned-List removal with current-member readback.

Gate: Pi can derive every parameter without source inspection, an explicit remove instruction needs no duplicate UI confirmation, replay is distinguishable from a current attempt, and a real removal is absent from the subsequent member read.

## M-4100 Footer status and theme semantics

Scope: current packaged footer only; no status data, operation lifecycle or theme palette change.

Order:

1. `WMB-4100` — place the X operation indicator in the footer flow without overlap and make the icon match the current dark/light theme.
2. `WMB-4101` — center the existing return-to-latest control at the bottom of the Pi transcript.
3. `WMB-4102` — smoothly scroll to latest, then fade the centered control without horizontal motion.

Gate: at the Owner viewport all footer items have disjoint rectangles, dark/light show moon/sun respectively, and return-to-latest remains centered through a smooth scroll before fading only after the exact transcript bottom.

## M-4000 Deterministic direct X List member addition

Scope: historical CAP-014 and CAP-017 direct Pi member-add contract; this milestone predates M-4200, which later makes explicit member removal direct as well.

Order:

1. `WMB-4000` — make direct authorized member addition validate one frozen account/List/owner/handle snapshot before idempotent per-handle execution, and publish a complete small-model SOP in the tool schema and built-in operator Skill.
2. `WMB-4001` — execute the remaining authorized UK List additions through the packaged MCP without Pi, require current-member filtering and per-handle platform readback, and repair any confirmed live failure before completion.

Gate: one direct call cannot reject its own progressively rendered second snapshot; UI-confirmed mutations retain freshness checks; Pi can select every parameter, distinguish replay from attempt and continue a partial result without reading source code or guessing; the packaged direct tool completes a real authorized member-add operation with truthful per-handle readback.

## M-3900 Truthful X List member-add replay

Scope: existing CAP-014 and CAP-017 direct Pi member-add contract; no idempotency, authorization or browser-execution change.

Order:

1. `WMB-3900` — mark terminal request-id replay separately from a current execution attempt and teach Pi to continue a partial operation only by reading current members, filtering unresolved handles and using a new business request ID.

Gate: a terminal replay is machine-readable and cannot be truthfully described as a fresh execution; a new continuation never reuses the terminal request ID or blindly resubmits already-present handles.

## M-3800 Pi user-controlled streaming scroll

Scope: existing CAP-014 Pi dock presentation; no Pi runtime, persistence or message-order change.

Order:

1. `WMB-3800` — follow streaming output only while the reader remains near the bottom; preserve an upward manual scroll and expose an explicit return-to-latest action.

Gate: a reader at the bottom keeps seeing new output; scrolling upward is not overridden by later Pi deltas, tool updates or phase changes; returning to the bottom resumes following.

## M-3700 Settings-owned X List management

Scope: CAP-013, CAP-017 and CAP-020 information architecture; no business-command or confirmation-authority change.

Gate: Settings owns List visibility, daily-source binding, owned-List mutation, prepared-operation confirmation and operation history; Discover retains selected-List content browsing and collection only, with no configuration or external-write controls.

Follow-up `WMB-3701` makes the persisted two-step confirmation and execution result unambiguous across navigation, always reopening the newest operation instead of an older still-pending duplicate.

## M-3600 Pi action acknowledgement

Scope: CAP-014 fork/retry interaction feedback.

Gate: under a deliberately delayed native fork, the clicked control enters a visible pending state within one render frame, duplicate action is unavailable, and success/failure restores the existing conversation behavior.

## M-3500 Pi chronological transcript

Scope: CAP-014 conversation presentation.

Gate: one real persisted Pi turn renders visible thinking and replies in chronological order inside one assistant bubble; each tool call defaults to one compact `tool · task` line, while its raw arguments and result remain hidden unless the user explicitly expands that line.

## M-000 Harness and contracts

Scope: CAP-001–CAP-015 documentation and traceability.

Gate:

- PRD, SPEC, technical design, plan, and task ledger agree;
- Pi operation-Skill maintenance policy is indexed from the Agent entrypoint and enforced by the lightweight Harness;
- harness check passes;
- task ledger contains every capability.

## M-100 Desktop foundation

Scope: CAP-001, CAP-013.

Deliver:

- Electron + React + TypeScript scaffold;
- selected package manager and pinned runtime versions;
- sandboxed renderer and narrow preload;
- data-root first run/open flow;
- SQLite migrations;
- Settings health, paths, usage, counts, and logs;
- package typecheck, test, and build scripts.

Gate: packaged Windows app reopens one selected data root with persisted objects and truthful health/readback.

## M-200 Sources, plans, and Today

Scope: CAP-002, CAP-003.

Deliver:

- source feed/item persistence and dedupe;
- versioned intelligence-engine Skill with a graded source registry, collection SOPs, evidence verification, event clustering, and opportunity judgment;
- topics, plans, references, and current-plan rule;
- Today view and business commands.

Gate: duplicate or incremental source input does not lose prior analysis, complete source search/readback works, and a current plan cites stored sources with material gaps, retains every qualifying opportunity, and reads them back in `SSS → F` order without a fixed count cap.

## M-300 Studio, assets, and MCP

Scope: CAP-004, CAP-005.

Deliver:

- content projects, immutable versions, platform versions;
- atomic asset import and preview;
- Studio view;
- loopback MCP tools;
- revision and request-id behavior.

Gate: Agent A creates work, Agent B continues it, stale Agent A write conflicts, and UI reflects the latest revision.

## M-400 Browser, accounts, and safe publishing core

Scope: CAP-006, CAP-007, CAP-013.

Deliver:

- managed visible Chrome/profile/CDP;
- account identification and mismatch blocking;
- prepare/readback contract;
- UI-only confirmation;
- publication attempts, unknown reconciliation, takeover, and state timeline.

Gate: a local controlled page proves state transitions and restart safety; no real platform is claimed complete here.

## M-500 X vertical slice

Scope: CAP-008, CAP-011.

Deliver all three X platform-version formats and exact manual handoff.

Gate: EVAL-003, EVAL-004, and EVAL-005 pass with exact payloads and bound assets.

## M-600 Xiaohongshu vertical slice

Scope: CAP-009, CAP-011.

Deliver both Xiaohongshu formats through the required MCP/manual workflow.

Gate: EVAL-006 and EVAL-007 pass with exact payloads and bound assets.

## M-700 WeChat vertical slice

Scope: CAP-010, CAP-011.

Deliver the final article payload for manual publication and optional URL validation.

Gate: EVAL-008 passes with the exact article payload.

## M-800 Results and learning loop

Scope: CAP-011, CAP-012.

Deliver:

- 1h/6h/24h/72h snapshots and overdue recovery;
- account snapshots;
- Results view;
- final review and method findings;
- later plan backlink.

Gate: EVAL-011 and EVAL-012 pass.

## M-900 Full acceptance and delivery

Scope: CAP-001–CAP-013.

Deliver:

- all command checks;
- packaged app;
- six platform payload receipts;
- cross-Agent receipt;
- restart, unknown, stale confirmation, data-root, and feedback-loop receipts.

Gate: all current-scope TASKS are `done`, all EVAL-001–EVAL-013 pass under the manual-publication contract, and the harness check passes.

## M-1000 Built-in Pi executor

Scope: CAP-014 plus existing CAP-002–CAP-005 and CAP-013 business surfaces.

Deliver:

- pinned, independently replaceable Pi runtime using WMB's OpenAI-compatible connection;
- one supervised RPC process and thin WMB MCP extension;
- durable, idempotent Pi task state with business-object readback;
- one persistent collapsible Pi dock on every main page;
- native Pi dock turn controls: no ordinary-chat deadline, stop/steer/follow-up, native queue display and forked conversation branches;
- Today intelligence and Studio draft intents without an external chat.

Gate: the packaged runtime starts, streams, aborts and exits; a real Pi task writes only through live WMB MCP; Today and Studio read back their required business objects; final publication remains manual.

## M-1100 Long-term Studio workbench

Scope: CAP-004, CAP-005 and CAP-014 at 1000+ content-project scale.

Detailed plan: `STUDIO_LONG_TERM_PLAN.md`.

Order:

1. correct Pi project/version semantics;
2. split project-list and single-project detail reads;
3. add project status, archive, search and bounded paging;
4. rebuild Studio around on-demand project detail and usable version history;
5. migrate existing data and pass the 1001-project desktop acceptance.

Gate: Pi creates a new project for a new article and leaves unrelated project versions unchanged; list payloads contain at most 50 summaries and no historical bodies; one project detail retains complete immutable versions; 1001-project search/filter/paging, revision conflict, migration integrity and real desktop operation pass.

## M-1200 Knowledge compounding

Scope: CAP-002, CAP-003, CAP-004, CAP-011, CAP-012 and CAP-015.

Deliver:

- dual-axis source lifecycle and independent paged Library;
- explicit cross-day topic/source aggregation;
- bounded historical contribution-chain context;
- deterministic rediscovery;
- shared UI, IPC and MCP/Pi business commands.

Detailed plan: `KNOWLEDGE_COMPOUNDING_PLAN.md`.

Gate: migration preserves existing objects; lifecycle revisions, topic idempotency, 250-item paging, and a real source-to-review feedback chain read back through the same business API.

## M-1300 Knowledge canvas

Scope: CAP-002, CAP-003, CAP-004, CAP-015 and CAP-016.

Deliver:

- persistent canvases containing references to real WMB objects and local notes;
- directed typed semantic relations with separate canvas visibility;
- drag, pan/zoom, multi-select and rectangular selection;
- direct current-page or explicit multi-selection Pi context with whitespace clear;
- direct current-page/selected context carried by the existing Pi turn, with evidence links stored on briefs/projects and no package or snapshot object;
- shared business, IPC and MCP commands with optimistic revisions and atomic idempotency.

Detailed plan: `KNOWLEDGE_CANVAS_PLAN.md`.

Gate: EVAL-015 passes on migrated real data, including restart restoration, current-page default, multi-select sentinel exclusion, whitespace clear, exact Pi-turn context identity, project evidence backlink and 250-node/1100px operation.

## M-1500 Frontend visual and experience redesign

Scope: renderer UI/UX only; no business-contract change. Baseline is the owner-approved interactive prototype in `prototype/` (「墨夜编辑台」, approved 2026-07-30).

Deliver:

- design tokens (elevation, accent discipline, priority/platform color scales, type scale) in `styles.css`;
- grouped rail navigation, refined topbar and status bar, collapsible Pi dock;
- per-view redesigns: Today, Studio, Publish, Results, Library/Domain Map, Canvas/Composer, Settings;
- amber "needs human" semantics, SSS→F grade badges, platform identity colors applied consistently.

Gate: every redesigned view keeps its existing business behavior and readbacks, shows zero document/body overflow at 1100×700 and 1920×900 in a real Electron window, and typecheck plus the lightweight harness pass.

## M-1400 Built-in Xiaohongshu collection for Pi

Scope: CAP-002, CAP-009, CAP-013 and CAP-014.

Deliver:

- pinned `xpzouying/xiaohongshu-mcp` binaries packaged as WMB resources without account cookies;
- one supervised loopback-only child process using the selected WMB data root for runtime state;
- explicit login, readiness, failure, restart, data-root switch and application-exit lifecycle;
- exactly four read-only Xiaohongshu tools exposed to every built-in Pi entry;
- Xiaohongshu search/detail/profile evidence saved and read back through the existing WMB source business API.

Detailed plan: `XIAOHONGSHU_MCP_PI_PLAN.md`.

Gate: a packaged Windows app starts its own pinned Xiaohongshu MCP without external installation, Pi performs one real read-only collection flow and saves a source through WMB MCP, cookies remain only under the selected data root, write tools are absent, and application exit leaves no child process.

## M-1600 X List workspace

Scope: CAP-017.

Deliver:

- fixed, visible, serial X List executor using the WMB installation's dedicated Edge profile and current account;
- persisted List bindings, confirmation-bound operation records and per-member readback;
- owned/followed/member List read model and permission-bounded management commands;
- UI-only confirmation, MCP/Pi read-and-prepare commands, and Discover List workspace;
- explicit bounded List-timeline collection into existing sources.

Gate: EVAL-016 passes with one real installation-level Edge login reused across AI/UK/game without repeated login, an owned List mutation with exact readback, stale confirmation rejection, safe stop/unknown behavior, and a bound List source readback. X Lists remains available independently of the publishing-platform subset; workspace acceptance additionally proves the same X List identity/cache fixture is root-local and never reused across roots.

## M-1700 Official-release intelligence wire

Scope: CAP-002, CAP-003, CAP-014 and CAP-017.

Deliver: expand and validate the official AI source index, run the enabled AI-frontier X List and primary-source checklist before judgment routes, persist per-source health, and prove named release evidence enters existing sources. M-2100 later migrates these accepted source identities into the AI root's ordinary website/X Lists configuration and replaces this AI-only execution route without losing the accepted source readback.

Gate: source-index validation, focused wire tests, durable source-item readback and List-operation evidence pass without creating a second intelligence store.

## M-1800 Durable source foundation

Scope: CAP-002 and CAP-014.

Deliver: canonical source identity and upsert semantics, registry-to-feed binding, root-local bounded source-body cache rules with no cross-root hit, and a shared wire-health read API.

Gate: source/migration/settings focused tests and typecheck prove every ingress resolves to one durable source and the latest wire health is readable through the shared business surface.

## M-1900 Modular data-root workspaces

Scope: CAP-002, CAP-003, CAP-004, CAP-006, CAP-011, CAP-012, CAP-013, CAP-014, CAP-015, CAP-016, CAP-017, CAP-018 and CAP-019.

Detailed design: `docs/spark/2026-08-02-modular-workspace-content-terminal-design.md`.

Order:

1. `WMB-1900` — approve the product/implementation/architecture contracts and this sequential task chain;
2. `WMB-1901` — seal the dirty baseline, its acceptance code and a repeatable pre-enrollment AI-root manifest with an explicit allowed-difference set;
3. `WMB-1902` — add the minimal registry, root identity, moved-root relink and zero-business-migration AI enrollment;
4. `WMB-1903` — deliver the complete relaunch-based workspace switch slice: mutation drain, switch journal, list/switch UI, old MCP/process shutdown, rollback and inactive-root proof;
5. `WMB-1904` — add finite compile-time AI/UK profiles, route discovered AI-only choices through the active profile, create a fresh UK root and prove a linked X pure-text chain with exhaustive AI-only sentinel coverage;
6. `WMB-1905` — extract only the intelligence/creation catalog boundaries proven by AI/UK, then add session-bound proposals and read-or-prepare-only application MCP tools with the full stale negative matrix;
7. `WMB-1906` — add UI result/diff confirmation and prove an Owner-supplied third self-media goal through manual confirmation, cold reopen and a linked X pure-text chain;
8. `WMB-1907` — run focused packaged acceptance for enrollment, relaunch switching, failure recovery, UK, the third lane and truthful `needs_user`, reusing unchanged legacy receipts.
9. `WMB-1908` — publish one authoritative workspace capability snapshot; make active-profile changes replace every bound runtime and old MCP URL; make generic X Lists available in every root while keeping bindings, caches, account snapshots and AI fixed-List policy root/pack isolated;
10. `WMB-1909` — render Discover from a finite intelligence-pack mapping, keep rankings/then-current AI source presentation AI-only, and expose the shared root-local X Lists workspace in AI, UK and game without a plugin loader; M-2100 later migrates source presentation to shared root-local channels;
11. `WMB-1910` — enforce profile publishing-platform subsets at shared write/runtime boundaries and make missing-model/login task states truthful without disabling generic X List inputs;
12. `WMB-1911` — isolate workspace-bound renderer selections and remove mount-time business writes;
13. `WMB-1912` — run the packaged AI/UK/game module, generic X Lists, platform, process and zero-cross-root acceptance matrix.

Gate: EVAL-017–EVAL-019 pass. The AI root retains its current data and accepted behavior; AI, UK and the third lane use one WMB codebase but isolated roots; inactive roots have no process or write; Agents can prepare but never activate a profile. Generic `x_lists.*` is available in every active self-media root independently of publishing platforms, one installation-level Edge login is reused, while account snapshots, bindings, caches, operations and collected sources stay root-local. M-2100 subsequently replaces the fixed AI source wire with the shared root-local channel configuration while retaining AI rankings. Legacy UK-terminal data import, rename/archive/delete lifecycle, third-party plugins, shared-database tenancy, parallel workspace runtimes, profile history/old-pack compatibility and native media editors are not part of M-1900.

## M-2000 Pi model contract correction

Scope: CAP-014.

Deliver: state the built-in Pi boundary accurately, retain only OpenAI Responses and OpenAI Chat Completions configuration, store one encrypted preset set for the WMB installation, reject unsupported protocols at the shared config boundary, and keep model selection bound to the provider catalog or explicit user input without fallback.

Gate: focused Pi configuration tests, Windows packaging and live configuration readback prove the removed protocol is unavailable while the existing OpenAI-compatible profile remains unchanged. Run typecheck and record unrelated baseline failures without expanding this task.

## M-2100 Workspace intelligence channels

Scope: CAP-002, CAP-003, CAP-014, CAP-017, CAP-018, CAP-019, CAP-020 and CAP-021.

Detailed design: `docs/spark/2026-08-03-workspace-intelligence-channel-modules-design.md`.

Order:

1. `WMB-2100` — approve REQ-020–022, AC-016–018, CAP-020–021, EVAL-020–023 and this sequential task chain;
2. `WMB-2101` — add root-local website source configuration, generic per-source scan receipts, shared readiness readback and migrations while reusing existing source/List objects;
3. `WMB-2102` — add arbitrary public website name/URL candidate resolution, canonical trial read, confirmation, management and truthful zero-item scans;
4. `WMB-2103` — add current-account X List name/URL/ID resolution, same-name candidate selection and existing-binding reuse;
5. `WMB-2104` — move deterministic channel preflight/scans above pack-specific judgment, freeze selected source revisions, aggregate per-source receipts and replace the zero-source/non-empty-plan completion gate;
6. `WMB-2105` — deliver Discover intelligence-channel management and the original Today default-all/per-run selection/preflight UI from the authoritative shared snapshot; WMB-2300 later removes the Today management surface while retaining automatic default-all preflight;
7. `WMB-2106` — expose read/prepare-only channel MCP/Pi tools and UI-only exact batched source confirmation with stale zero-write behavior;
8. `WMB-2107` — run focused packaged AI/UK acceptance for arbitrary websites, same-name X Lists, cold-switch isolation, zero-update success, partial preservation, all-blocked preflight and exact authorization.

Gate: EVAL-020–EVAL-023 pass. AI/UK use the same two fixed channel modules and shared daily scan path; the AI source-index/List fixtures are retained as visible AI-root configuration rather than a privileged collector. At least one truthful source check may succeed with zero new items and an empty plan, while no trustworthy receipt cannot claim success. Source configuration, account snapshots, bindings, receipts and collected items stay root-local while the Edge login is installation-level; Agents prepare but UI confirms exact source changes. Xiaohongshu, communities, third-party modules, plugin loading and the separate Pi stale temporary-working-directory BUG are outside M-2100.

## M-2200 X List trend opportunity radar

Scope: CAP-002, CAP-003, CAP-011, CAP-015, CAP-017, CAP-018, CAP-021 and CAP-022.

Detailed design: `docs/spark/2026-08-03-x-list-trend-opportunity-radar-design.md`.

Order:

1. `WMB-2200` — freeze REQ-023/AC-019/CAP-022/EVAL-024–025, capture one current real structured-metrics baseline and falsifiably test List-ID response isolation;
2. `WMB-2201` — add per-field parsing status and append-only root-local X post metric snapshots after account/binding revalidation;
3. `WMB-2202` — add deterministic bounded snapshot/trend reads with exact insufficient-data semantics and shared IPC/MCP/Pi access;
4. `WMB-2203` — add explicit-start +15m/+60m/+180m observation jobs, idempotency, stop/restart/expiry and active-root lifecycle;
5. `WMB-2204` — feed trend evidence into existing event/topic aggregation, Today/Discover and the plan-to-content chain without social automation or a second source/event store;
6. `WMB-2205` — run focused current-Windows-package EVAL-024–025 acceptance with real X metrics, root switching, partial/needs_user and responsive UI readback.

Gate: EVAL-024–EVAL-025 pass. One explicit run creates only bounded active-root observation work; the same post retains one source identity and multiple truthful metric snapshots; deterministic speed evidence reaches an existing multi-source opportunity and survives UI/MCP creation into the same topic/source lineage. Missing metrics, app exit, root switch and late responses never create fake trends or cross-root writes. Full-network monitoring, X official APIs, background services, automatic social interaction and unrelated X utility tools remain outside M-2200.

## M-2300 Today information-first restoration

Scope: CAP-020 and CAP-021.

1. `WMB-2300` — remove channel selection, source counts, readiness management and configuration guidance from Today; start every enabled Discover channel automatically and report preflight failure only after an explicit start.

Gate: Today contains no channel checkbox/count/name/readiness/configuration surface, its start payload cannot deselect modules, Settings retains the full management surface, and renderer readback confirms Today remains opportunity-first while Discover remains content-discovery-only.

## M-2400 Installation-wide Pi operation Skill

Scope: CAP-014 and the existing WMB business workflows it operates. This milestone teaches Pi the supported software workflows; it does not add a new business module or weaken runtime validation.

Order:

1. `WMB-2400` — create the canonical `wemedia-buddy-operator` Skill with current workflow playbooks and a deterministic check that every named `wmb_*` tool exists;
2. `WMB-2403` — falsifiably reproduce and repair the browser/login workflow that blocks X List save/read: migrate the existing logged-in Edge profile to one installation-level identity shared by every workspace while retaining root-local X business state, remove stale user-facing provider/root-login terminology, and synchronize the operator Skill with the verified flow;
3. `WMB-2404` — falsifiably reproduce the 13/13 daily-intelligence stall, distinguish channel completion from the later Pi judgment/save phase, and make persisted progress and Today presentation truthful until the plan is actually available; this independent task may proceed while WMB-2403 is at its required human-login gate;
4. `WMB-2401` — package and refresh the shared operator Skill into every Pi data root while keeping lane Skills root-specific and the system prompt limited to immutable authority boundaries; this installation task may proceed while WMB-2403 waits at its human-login gate;
5. `WMB-2402` — after both WMB-2401 and WMB-2403, prove a fresh root and existing AI/UK roots load and follow the shared Skill for channel proposal, real X List save/read through the same installation-level Edge login, and content-project workflows without direct writes or confirmation bypass.

Gate: the canonical Skill is the sole editable source, every packaged Pi root loads the same current operator Skill plus its own lane Skill, stale tool names and stale provider/root-login guidance fail deterministic checks, daily progress remains truthful across channel and Pi phases, and real Pi readback completes the changed playbooks through WMB business tools, one exact installation-level browser/profile, root-local business isolation and required UI confirmation.

## M-2500 Installation-wide Pi Skills and evidence-grounded writing

Scope: CAP-014 and CAP-023.

Order:

1. `WMB-2500` — freeze REQ-024/AC-020/CAP-023/EVAL-026 and the protected-system versus editable-installation Skill boundary;
2. `WMB-2501` — implement the installation Skill store, tombstones, atomic CRUD, all-root synchronization and Settings management page;
3. `WMB-2502` — create and ship `evidence-grounded-writer`, with factual-writing triggers, claim/evidence discipline, information-density rules and post-draft verification;
4. `WMB-2503` — package and prove fresh/existing-root CRUD, restart deletion persistence, protected/lane preservation and one real Pi evidence-grounded writing result.

Gate: Settings manages ordinary shared Pi Skills without becoming a business plugin manager; protected operator/lane Skills cannot be changed; editable Skill mutations are identical across registered roots and take effect in the next Pi process; the default writing Skill reduces human verification load by producing a traceable, information-dense factual draft plus only residual conflicts/uncertainty for human review.

## M-2600 Pi slash-command palette

Scope: CAP-014, CAP-023 and CAP-024.

Order:

1. `WMB-2600` — freeze REQ-025/AC-021/CAP-024/EVAL-027 and the actual-RPC-catalog, insert-before-send and no-new-authority boundaries;
2. `WMB-2601` — expose the supervised Pi RPC `get_commands` catalog through one narrow path-safe Main/preload read boundary with focused runtime and normalization checks;
3. `WMB-2602` — add the composer-anchored palette with name/description filtering, source labels, loading/error/empty states, keyboard navigation, pointer selection and native command insertion/submission;
4. `WMB-2603` — package and prove actual command discovery, zero-send insertion, native Skill loading and create/edit/delete catalog refresh against a real Pi process.

Gate: the palette contains only commands returned by the current Pi RPC process, never fabricates interactive-only commands or exposes source paths, selecting never sends, normal queue semantics remain unchanged, and installation Skill mutations are visible and executable through the next real Pi process.

## M-2700 Acceptance gate reconciliation

Scope: existing CAP-004, CAP-014 and CAP-017 behavior plus the project verification Harness; no product-contract change.

Order:

1. `WMB-2700` — reproduce every reported acceptance remainder and freeze its root cause without changing behavior;
2. `WMB-2701` — move content-list fixture cleanup outside the SQLite-owning child process and make the source-logo test enforce the live registry contract instead of a stale count;
3. `WMB-2702` — remove the three TypeScript diagnostics by preserving validated URL narrowing and counting the persisted X List item state actually written by the shared outcome mapper;
4. `WMB-2703` — restrict placeholder scanning to relevant project deliverables, then pass typecheck, the full test suite, lightweight Harness and package gate.

Gate: no acceptance command relies on ignored runtime data, stale fixture counts or in-process deletion of an open Windows SQLite file; typecheck is clean; full tests, lightweight Harness and Windows packaging pass from a clean worktree.

## M-2800 Pi platform-version completion

Scope: existing CAP-004, CAP-005, CAP-007 and CAP-014 contracts; no publication-confirmation change.

Order:

1. `WMB-2800` — reproduce the reported post-draft failure against the real MCP registry, packaged Pi extension, active Pi tool list and operator Skill, then identify the exact missing boundary;
2. `WMB-2801` — repair the confirmed shared boundary so Pi can save X, Xiaohongshu and WeChat platform versions through the existing business command with exact project/core-version linkage and readback;
3. `WMB-2802` — package and prove one real completed body produces all three platform versions visible in Studio and Publish while final publication remains UI-confirmed only.

Gate: Pi uses the same existing content/version business API as UI and external MCP, creates no parallel draft store, reads back exact platform/title/body/project/core-version identities, and gains no final-publication or confirmation authority.

## M-2900 Shared X List index read recovery

Scope: existing CAP-017 shared X login and List read contract; no account, confirmation or data-isolation change.

Order:

1. `WMB-2900` — reproduce the authenticated shared-profile failure, repair same-URL reuse of an empty stopped document, and prove the real shared login returns its account and List index without another login.

Gate: an authenticated installation Edge page is reused only while its document is usable; an empty stopped same-URL page is reloaded, and the real shared profile returns the current account and Lists through the existing business read path.

## M-3100 X List workspace visibility

Scope: existing CAP-017 workspace and CAP-021 enabled-source daily orchestration; no new source store or channel state.

Order:

1. `WMB-3100` — keep the complete account List index inside a visibility chooser, show only root-selected Lists in the workspace, retain enabled binding as the independent daily-intelligence switch, and keep an empty-timeline retry control at normal height.

Gate: opening one workspace does not expose every account List as a workbench tab; visibility is root-local and survives reopen; toggling display alone does not bind or enable a source; daily intelligence still freezes only enabled bindings; zero-post retry remains readable without stretching.

## M-3200 Settings-owned X List display configuration

Scope: existing CAP-013 Settings and CAP-017 root-local display preference; no channel or platform mutation.

Order:

1. `WMB-3200` — remove display configuration from Discover, expose it as one Settings section, and prove the same root-local preference controls the clean List workbench after return/reopen.

Gate: Discover contains only selected Lists and their content/actions; Settings exposes the complete cached account index plus refresh and display checkboxes; changing display never changes enabled bindings or daily sources.

## M-3300 Discover content surface and Settings-owned channels

Scope: CAP-013, CAP-017, CAP-020 and CAP-021 information architecture; existing source business commands and confirmation rules remain unchanged.

Order:

1. `WMB-3300` — move the complete website/X List channel configuration workspace to Settings, leave rankings and selected X List content in Discover, and update PRD/SPEC/technical ownership language.

Gate: Discover contains no source add/enable/disable/remove, readiness or receipt-management controls; Settings retains all existing channel operations and confirmations; Today still runs every enabled source; AI rankings and selected X List content remain discoverable.

## M-3400 Truthful empty X List timeline

Scope: existing CAP-017 read presentation; no browser, cache or pagination protocol change.

Order:

1. `WMB-3400` — prove whether the reported sequence is one or two reads, then render zero initial posts as one retryable empty state and expose pagination only after at least one post exists.

Gate: one empty response cannot show both no-dynamics and load-more; no automatic second timeline request is introduced; non-empty timelines retain existing pagination.


## M-5210 内建 Wiki 与知识飞轮（CAP-002 / CAP-003 / CAP-014 / CAP-027）

Scope: implement the Owner-approved design package `docs/spark/2026-08-12-wmb-knowledge-flywheel-design-package.md` as an in-place upgrade of Source → Topic → Opportunity → Content → Publication → Review. SQLite remains the only source of truth; existing Source/Topic/Content/Publication/Review identities remain canonical; `LibraryTopicsView`, `LibraryView`, `KnowledgeCanvasView`, Pi and Studio are retrofitted rather than adding a parallel Wiki product. Formal knowledge writes are atomic, immutable-versioned, evidence-backed, immediately effective and reversible. Final platform publication, hard delete and external platform mutation boundaries remain unchanged.

Canonical contracts:

- `docs/spark/2026-08-12-wmb-built-in-wiki-notes-architecture-design.md`
- `docs/spark/2026-08-12-wmb-knowledge-object-version-contract-design.md`
- `docs/spark/2026-08-12-wmb-ai-knowledge-compilation-protocol-design.md`
- `docs/spark/2026-08-12-wmb-existing-knowledge-surfaces-retrofit-design.md`
- `docs/spark/2026-08-12-wmb-creation-knowledge-usage-protocol-design.md`
- `docs/spark/2026-08-12-wmb-outcome-feedback-knowledge-health-design.md`
- `docs/spark/2026-08-12-wmb-knowledge-flywheel-migration-delivery-acceptance-design.md`

Order (freeze shared contracts first; then run independent consumers concurrently where dependencies permit):

1. `WMB-5210` — M1 core storage and command boundary: schema, immutable versions, version-level evidence, relations, annotations, atomic ChangeSet, Receipt, QueryArtifact and HealthIssue; capability/dispatcher/requestId/revision/read APIs; migration and transaction tests.
2. `WMB-5211` — M2 minimum compiler vertical slice: one real Source resolves an existing Entity, creates/updates sparse knowledge, qualifies an old Method, preserves a dispute, recompiles one existing Topic Wiki and emits one readable receipt; low-value and idempotent paths included.
3. `WMB-5212` — M3 in-place Topic and Library retrofit: Wiki-first Topic details; Raw/Evidence/Inbox/Receipt/Health Library; deep links and dataChanged refresh; no parallel route or user-facing knowledge CRUD.
4. `WMB-5213` — M4 Canvas projection: relation/change/health modes, formal-object references, dataChanged subscription and selected-only creation actions; deleting a node never deletes knowledge.
5. `WMB-5214` — M5 Pi Query write-back: frozen QueryArtifact inputs, reusable synthesis dedupe/write-back, pure-restatement no-op and visible usage/deposition receipt.
6. `WMB-5215` — M6 creation usage lineage: immutable Knowledge Usage Package/Record across proposal, brief, core content and platform versions; actual-used vs consulted; risk and evidence projection.
7. `WMB-5216` — M7 outcome feedback and health: publication-time lineage, conservative Review compilation, bounded incremental/periodic Lint, HealthIssue lifecycle and deterministic auto-repair only.
8. `WMB-5217` — M8 historical initialization and clean cutover: derived legacy Wiki versions, bounded high-value extraction, retirement of parallel/dead paths, carry-to-topic convergence and no long-lived dual write.
9. `WMB-5218` — integrated acceptance: real Ingest → Wiki → Query → Creation → Publication/Review → Lint loop; concurrency/restore/idempotency/data-root isolation; focused/full/typecheck/capability and live Electron evidence.

Dependencies: WMB-5210 freezes all shared schemas and interfaces. WMB-5211 and WMB-5213 may proceed after 5210. WMB-5212 and WMB-5214 require the compiler read/write slice from 5211. WMB-5215 requires 5210 and may proceed independently of renderer work. WMB-5216 requires Query and creation lineage. WMB-5217 requires all user-facing writers to be migrated. WMB-5218 is the final gate.

Gate: one existing Topic visibly changes after ingesting one real Source; the update is sparse, evidence-located, atomic, versioned, reversible and idempotent; Pi writes back only reusable synthesis; Studio records actual fixed knowledge versions; Review does not fabricate causality; deterministic health defects auto-repair while real disputes remain visible; existing business IDs and contribution chains survive; no external Wiki dependency, parallel Topic/Wiki identity, user-managed knowledge tables, partial ChangeSet, cross-data-root leakage or relaxation of publication red lines. `TASKS.md` status `doing` remains the construction permit for each slice.

## M-5240 Karpathy LLM Wiki 非退化对齐（CAP-002 / CAP-003 / CAP-014 / CAP-027）

Scope: WMB 必须覆盖 Karpathy 原始 LLM Wiki 的全部核心能力，并将其 optional UI/tooling 能力在 WMB 内提供等价能力。SQLite 保持唯一真源；现有主题、资料库、关系画布、Pi、创作是产品表面，不引入 Obsidian、Markdown Wiki 目录或第二套 Topic/Source/知识身份。核心原则：Raw 输入按 revision 不可变；AI 拥有 Wiki 编译；知识被持续整合而非问答时临时重建；单条/批量 Ingest、Query 写回、Lint、Index、Log、Search、Graph 和视觉来源都可观察、可恢复、可追溯。

Order:

1. `WMB-5235` — 原始能力矩阵与机器可证伪基线。
2. `WMB-5236` — 持久化全库维护运行与全局报告。
3. `WMB-5237` — 完整 Lint、Raw revision 不可变、图片感知摄取。
4. `WMB-5238` — SQLite Wiki Index/Log/Hot 等价读模型与统一全文搜索。
5. `WMB-5239` — 资料库原位全库维护/日志/搜索/批量摄取 UI。
6. `WMB-5240` — Pi/operator 自然语言全 Wiki 操作。
7. `WMB-5241` — 真实工作空间非退化最终验收。

Gate: 一条真实 Source 可更新多个既有 Wiki 页面；一批 Sources 可断点摄取；高价值 Query 固定引用并写回；全库维护可由 Owner 或 Pi 启动、暂停、继续并在重启后恢复；Lint 实际检测矛盾、陈旧、孤立、缺页、缺交叉引用、重复、无证据和研究缺口；统一搜索命中 Wiki 正文与固定版本知识；全局 index/log/report 可读；图片结论绑定资产与 Source revision；关系图可导航；所有变化具备 ChangeSet、Receipt、版本和恢复路径。任何一项只存在于设计文档、测试 fixture 或单轮 Pi 文本均不算完成。

## M-5330 知乎热题驱动每日文章×视频文案闭环（PRD §2.6 / SPEC CAP-029 / REQ-032）

Scope: 嵌入现有闭环的知乎热榜 intelligence module + 每日周期/目标 + 视频文案衍生一条龙。知乎仅作热门问题情报源，不经营知乎、不新增回答编辑器/发布链。复用 Today/Plan/Proposal Ledger/Content Project/Research Gate/Studio/Results 与现有班组；不建第二工作台/服务/数据库/内容身份，不重构 Artifact 图，不改发布红线。Canonical design `docs/spark/2026-08-22-zhihu-hot-question-content-loop-PLAN.md`（正式 Owner lock 2026-08-22）。

Order (依赖顺序：基础立法→扫描→评分→周期/目标→迭代→文章→衍生→编排→验收；WMB-5330 只做基础):

1. `WMB-5330` — **基础冻结（当前任务）**：PRD §2.6 + REQ-032/AC-030 立法、SPEC CAP-029 + EVAL-033 立法、TECHNICAL_DESIGN v75 记载、PLAN M-5330 立法；v75 迁移（`zhihu_hot_observations` 唯一观察、`daily_content_cycles` UNIQUE business_date、`daily_content_targets` carry 前驱 lineage + 冻结 score/format JSON、 `content_derivatives`/`content_derivative_versions` 不可变版本行与触发器）随空库与遗留 v74 库升级；`src/shared/daily-content-loop.ts` 冻结命令/类型单源、`src/shared/agent-capabilities.ts` 三新能力（Reporter 扫榜、Planner 周期/目标、Writer 衍生版本、Desk 站立含、无发布授）与 `filterCommandsForRole` 交集；仅声明契约，无浏览器/Today/Studio/调度运行时。机器门禁：空/遗留迁移、唯一性、不可变、命令注册、角色过滤。
2. `WMB-5331` — 知乎热榜 intelligence module（浏览器 readiness、官方热榜 DOM、去重 Source/observation、逐源 receipt、渠道卡）；不使未公开 API。
3. `WMB-5332` — 六维评分、硬风险、30 天重复、自动/边界/拒绝三路与 Proposal Ledger。
4. `WMB-5333` — Daily Cycle/Target 状态机、默认 2 条、partial/skip/replace/carry-once、幂等 ensure 与 Today 投影。
5. `WMB-5334` — 昨日未发布与已发布迭代队列、Review/指标/新证据汇总、本地新版本不触发线上更新。
6. `WMB-5335` — target→Plan Item→Content Project、Research Gate、文章主稿/定稿与状态投影。
7. `WMB-5336` — video_script 衍生身份/不可变版本、format decision 自适应形态、Writer 任务、Studio 双产物/stale。
8. `WMB-5337` — 阶段 A–E Desk 编排、自动/手动归一、重启重派、数据根隔离、局部失败与结算 receipt。
9. `WMB-5338` — A1–A12 真实闭环验收、打包证据、clean cutover、永久文档与证据更新。

Gate M-5330: 迁移在空库与 v74 遗留库升级且五表/触发器/FK 完整；Reporter/Planner/Writer 命令分别仅由对应角色(+desk)可达且无发布权限；空库可插入完整循环样本且唯一/不可变/外键校验生效；`content_derivative_versions` immutable；全部新增写经 CommandEnvelopeV1 + active-root dispatcher；**WMB-5330 之后**才允许的运行时/浏览器/Today/Studio/调度变更在 M-5330 内为零。Gate M-5338: 真实热题完成 Source→Score→Target→Research→Article→Video Script→Completed；两类昨日迭代成立；无自动发布、第二工作台、重复身份或跨根泄漏；全量打包证据齐。
