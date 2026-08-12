# ResearchJob 补料与研究续派 系统设计（durable design，canonical）

- 日期：2026-08-10
- 作者：WriteResearchJobDesign（吸收 DialogueGapAudit / AgentNetworkPathAudit / ResearchJobStorageAudit 三份审计与 Owner 分节确认的 Contract）
- 状态：**正式 Owner lock 2026-08-10（§13）——Owner 书面 Spec Review 2026-08-10 PASS，已批准并正式锁定**。本文件只设计，不实施；不改 PRD/SPEC/PRODUCT/TASKS；不产生实现计划与任务编号。下一阶段仅授权 Legislate（转写 PRD §2.5 / SPEC CAP-028 / EVAL-032 / PRODUCT C9 窄例外条款 / Capability 注册表 / 角色工单注册表 / operator Skill）；不授权实现与 TASKS doing。
- 依据与对齐：
  - 事件证据：`local://paste-1.md`（GLM 5.2 反常低价稿，2026-08-10 会话实录）、`agent://DialogueGapAudit`（四层缺口分解）、`agent://AgentNetworkPathAudit`（挂载面审计与 s5 三选项约束）、`agent://ResearchJobStorageAudit`（零新表可表达 + 仅 research_claims 一张最小表）
  - 规范：PRODUCT.md C1–C9（尤其 C2 今日=办公桌、C4 不上裸原料、C8 注册表唯一扩展点、C9 班组多实例不变量）、PRD §2.0/§2.3/§2.4/§4.7/§5.1、SPEC §1.0（不变量 8–9）/§2.2（有界并发读）/CAP-002/CAP-005/CAP-026/CAP-027、`docs/spark/2026-08-07-role-permission-design.md`（§4.5 读模型与 P1 读门、§5 L2 唯一扩展点、§8.2 授权持久化承诺）、`docs/pi-operation-skill-maintenance.md`（影响表与证据合同）
  - 代码事实：`src/shared/agent-capabilities.ts`（AGENT_CAPABILITIES/TASK_INTENT_NEEDED_CAPS/REDLINE_COMMANDS/roleReadProfiles）、`src/main/task-grants.ts`（AUTOMATIC_TASK_GRANT_SCOPES/roleForTaskIntent/ensureAutomaticTaskGrant/assertTaskGrantForEnvelope）、`src/main/role-job-registry.ts`（ROLE_TO_INTENT/ROLE_TO_POLICY/ROLE_TO_READBACK/RoleJobRequest/deriveRoleJobSpec）、`src/main/job-object-boundary.ts`（JobContract/buildJobContextRefs/rebuildRoleJobRequest/assertBoundaryCovers/ROLE_BOUNDARY_DIMENSIONS）、`src/main/agent-tasks.ts`（AgentTaskStatus/AgentTaskProgress/reportAgentTaskProgress/needsUserAgentTask/cancelAgentTask/recoverInterruptedAgentTasks）、`src/main/topic-maintenance-reproposal.ts`（jobs 出队范式）、`src/main/db/migrations.ts:206-216`（jobs 表 dedupe_key UNIQUE）、`src/main/db/late-migrations.ts:495-560`（intent CHECK 表重建范式 v48/v50）、`src/main/website-channel.ts:39/64`（resolveWebsiteCandidates/trialReadWebsite/readWebsitePage）、`src/main/agent-runner.ts:299-338/686/764`（dailyPrompt/nativeSearch 接线/draftPrompt）、`src/main/xiaohongshu-mcp.ts:20-35`（XHS_REQUIRED_TOOLS/XHS_FORBIDDEN_TOOLS）、`src/main/pi-config.ts:18`（nativeSearch = 模型配置）、`.pi/extensions/wmb-mcp/*`（wmb_* 工具面）
---

## 0. 结论（verdict，先行）

1. **问题真实，但根因不是「没有联网工具」**：X/XHS 只读工具已全量挂载到所有 Pi 会话（`wmb_read_x_list_*`=X 真实读、`xhs_*`=XHS 只读；`wmb_resolve_intelligence_website`/`wmb_trial_intelligence_website` 为渠道候选解析/试读，属渠道语义，非研究读面），Web 研究读面需新增 2 个独立只读工具 `wmb_search_web`/`wmb_read_web_page`；缺的是**接线**：L2 注册表无「网页补料/研究」能力项；固定角色工作流 prompt 未使用这些工具；读侧无硬门（`READ_PROFILE_BLOCKED` 零命中，仅 prompt 纪律）；一处 grant×prompt 冲突（nativeSearch 规则 5 指示 `wmb_save_source`，而 daily_judge scope 无 `sources.upsert_batch`）。
2. **正式 ResearchJob Capability**：在 L2 注册表新增 `cap.research`（默认绑定记者；research intent；读工具硬白名单；唯一写回命令 `sources.upsert_batch`），由注册表投影驱动签发、审计与投影——这是 L2「唯一扩展点」的正规路径，不新增角色、不做权限 UI。
3. **记者 = 统一补料执行者**；首批读面 = Web + X + XHS **只读**（Web 用新增 `wmb_search_web`/`wmb_read_web_page`，X/XHS 复用既有只读工具）；研究写回 = 证据入库（task grant 内业务写，非平台副作用）。
4. **深度档预算**（Owner 确认，本次立法唯一档位）：12 分钟 / 15 有效来源 / 40 候选 / 3 并行抓取 / 仅一轮。
5. **自动续派 = C9「员工不自动多跳」的唯一窄例外**：记者研究达门槛（研究任务终态并产出 EvidencePack）后，系统自动派生**原角色**续派工单一次（同一边界、同一 roleId）；`jobs` 表 `dedupe_key=research-succ:{parentJobId}` UNIQUE 保证至多一跳；research→research 禁止；续派后原角色再次缺料 → `needs_user` 交人决策——**一次研究绕行硬止环**。
6. **持久化零膨胀**：续派合同/预算/链进既有 `context_refs_json`；预算计数进 `progress_json`；可恢复现场进 `checkpoint_json`；EvidencePack 进 `result_refs_json`；`needs_user`/取消沿用既有状态机。**唯一新增表 = `research_claims`**（研究证据判定表，查询/审计面）；与 role-permission-design §8.2「唯一新增持久化 = capability_overlays」及 PRODUCT C9.10「不新增表/列」不冲突（两者均限定于授权持久化与续派合同；`research_claims` 为业务事实表，立法时在 C9.10 增加显式范围澄清，§10）。
7. **Today 只上 unresolved required needs_user 卡**：研究进度、候选清单、裸资料永不上桌（C2/C4）；智能体页记者卡承载研究中/进度/claim 摘要。
8. **读硬门首个落地实例**：research 会话按 `cap.research.readToolWhitelist` fail-closed（越权返回 `READ_PROFILE_BLOCKED` + 审计），是 role-permission-design §11 P1.4 读门的窄域首落，非全局展开。
---

## 1. 问题与证据

### 1.1 事件证据（GLM 5.2 反常低价稿，2026-08-10）

用户要求写深「GLM 5.2 在 OpenRouter 反常低价：官方涨价 vs 第三方降价机制」稿，暴露的失败链：

| 时间 | 事件 | 后果 |
| --- | --- | --- |
| 19:02 | 派写手强制整篇重写（r5），唯一一手证据 = @AbionMorse 反常低价帖 | 证据池仅 1 条 |
| 19:02:57 | 用户点破：写手资料不足时无联网补充能力 | 输出上限 = 入库证据广度 |
| r3 | 写手「写得更深」→ **编造无出处数字**（1.14 美元/天 vs 1 万美元 DGX） | 证据不足逼出幻觉 |
| r4 | 写手「按新角度重写」→ **整段复制旧稿（r4 = r3）** | 无新材料只能复抄 |
| 19:03 | 派记者定向查「GLM 官方涨价」→ 被路由成渠道扫描 | 「保存 100 条但搜不到目标证据」 |
| 19:04 | 用户要求主管统筹：缺料即另派补料工单 | 无角色可承接；prepare 渠道变更校验失败重试 |
| 19:05 | 用户要求工具侧缺口上报 | 桌助正式上报三类缺口（搜索/网页读/采集器调用） |

### 1.2 审计结论（AgentNetworkPathAudit 关键事实）

- **挂载面（现状事实）**：渠道 Web 工具（`wmb_resolve_intelligence_website` → `resolveWebsiteCandidates`，Bing 候选解析；`wmb_trial_intelligence_website` → `trialReadWebsite`，任意公网 URL 试读、SSRF/反挑战防护）、X 真实读（`wmb_read_x_list_index/detail/members/timeline`，静默浏览器）、XHS 读（`xhs_search_feeds/get_feed_detail/user_profile/check_login_status`）已挂载到全部 Pi 会话（`.pi/extensions/wmb-mcp/` + `WMB_MCP_URL`/`WMB_XHS_MCP_URL` 环境注入），desk 与外部 Agent 可用；固定角色会话技术上可见但 prompt 未用。**研究 Web 读面不复用渠道工具**：新增 `wmb_search_web`/`wmb_read_web_page` 两个独立只读工具，底层仅复用 `resolveWebsiteCandidates` 与静态正文提取（工具名/参数/审计语义独立，§6.2）。
- **四层缺口**（非单一联网开关）：
  1. **Capability 未注册**：L2 无「网页研究/补料」项；上述读工具不在任何能力的 commands/readProfiles；`readProfiles` 仅声明无强制（`READ_PROFILE_BLOCKED` 零命中，读门 = 设计 §11 P1.4 未落地）。
  2. **角色未接线**：daily_judge prompt 明令「不需要也不许调用任何工具…仅可 wmb_get_knowledge_context」（agent-runner.ts:337）；writer/librarian prompt 同理无网页工具；reporter 的「定向采集」被 ROLE_TO_INTENT 路由成 `daily_scan` 渠道扫描。
  3. **grant×prompt 冲突**：nativeSearch 规则 5 指示 `wmb_save_source` 带 URL 入库，而 daily_judge scope 无 `sources.upsert_batch`（仅 daily_scan 有）→ 判题者调用必 `TASK_SCOPE_BROADENED`。
  4. **派补料无承接者**：主管（桌助）派「资料补充工单」无角色可承接；渠道增配 prepare 校验失败重试；资料员两次 JOB_FAILED（handle=null，席位健康问题，非本设计范围）。
- **红线现状**（保持不动）：`x_lists.operation_execute`、`intelligence_channels.proposal_apply` = REDLINE_COMMANDS（仅 Precise + Owner UI）；XHS `publish_*`/评论/点赞等在 `XHS_FORBIDDEN_TOOLS`；发布最终点击与硬删 `agentGrantable:false`；有界观察可授权、平台写入永不自动。
- **用户目标**：分工明确（补料归采集侧，不压写手）；主管统筹（发现缺料自动派补料工单）；工具侧缺口上报由开发补全（本设计以新增 2 个 WMB 只读工具 + L2 注册表内闭环）。
---

## 2. 现状根因（为什么「工具在」却「不能用」）

1. **工作流未接线**：固定角色工作流（judge/writer/librarian prompt）从不使用已挂载的读工具；reporter 只有「渠道扫描」一条 intent，没有「按需研究」intent。
2. **Capability 未登记**：读工具不构成任何能力项，故无角色绑定、无读面投影、无 grant 语义、无智能体页摘要、无审计——「谁能在什么任务里读什么」没有注册表事实。
3. **读侧无硬门**：读是「默认全开 + prompt 别用」；弱模型臆造工具/越权读无运行时拦截（这是 role-permission-design §4.5/§11 P1.4 的遗留债，本次借 research 会话窄域首落）。
4. **生命周期缺失**：没有「缺口 → 补料 → 判定 → 回写原任务」的正式容器：预算、证据门槛、claim 判定、续派、止环都没有承载对象。

**结论**：本设计新增 2 个 WMB 只读工具（`wmb_search_web`/`wmb_read_web_page`），**零新网络供应商/零新模型/零新平台 API**；X/XHS 复用已挂载只读工具；把研究读面正式化进「Capability + intent + 读硬门 + 任务生命周期」。
---

## 3. 目标 / 非目标

### 3.1 目标

1. 正式 ResearchJob Capability（`cap.research`）与 `research` intent，记者为唯一执行角色。
2. 首批研究读面 = Web（`wmb_search_web`/`wmb_read_web_page`，新增 2 个 WMB 只读工具）+ X（read_*）+ XHS（search/detail/profile）**只读**；研究写回 = `wmb_save_source`（`sources.upsert_batch`）证据入库。
3. 深度档预算与证据门槛（§5.4/§6.5）机器化：12 分钟 / 15 有效来源 / 40 候选 / 3 并行 / 仅一轮；required claim 判定阈值由系统校验（fail-closed），非 prompt 纪律。
4. 一次研究绕行硬止环：自动续派恰好一跳（原角色），research→research 禁止；续派后缺料 → `needs_user` 交人。
5. 持久化：续派合同/预算/链/claim 判定全部落既有 JSON 列 + 唯一新表 `research_claims`；重启可续、取消/失败沿用既有语义。
6. Today 只上 unresolved required needs_user 卡；智能体页呈现研究任务。
7. 立法清单与 Pi Skill 影响齐备，可被后续 Legislate 直接转写。

### 3.2 非目标（明确不做）

- **不新增角色**：研究归记者（编制五角色不变）；不设「研究员」岗。
- **不做通用编排**：自动续派仅限 research→原角色单跳；不扩展为任意角色多跳链、不做编排图。
- **不给写手/策划/资料员装配研究权**：他们按 C8 只读借阅既有证据，不持 `sources.upsert_batch` 研究写权（写手连该命令都没有）。
- **不落地全局读门**：本次只对 research intent 会话实施读工具硬白名单；其余角色/意图行为零变化（P1 全量读门留待原设计排期）。
- **零新供应商/零新模型/零新平台 API**：新增仅 `wmb_search_web`/`wmb_read_web_page` 两个 WMB 只读工具；不改渠道配置语义——channel `resolve/trial` 保持渠道语义、不承载研究读面，研究场景不涉及渠道解析/准备/确认的任何写路径。
- **不做认证抓取**：`wmb_read_web_page` 浏览器回退仅渲染动态公网页，不创建第二平台登录态、不绕验证码/登录墙（§6.5）。
- **不定义其他研究档位**：本次立法只有深度档；其它档位属后续独立设计，本文件不预留档位枚举。
- **不处理资料员席位健康、渠道动态渲染抓取器**（审计缺口②③）：属环境/运维与渠道模块，不在本设计。
- **不做权限 UI、不写实施代码、不产生任务编号**。
---

## 4. 已否决替代方案

### 方案 A：给写手直接装配通用 web 搜索/网页读取工具（补料即写作）

- **内容**：在 writer 会话放通用搜索与任意 URL 读取，写手「边写边补料」。
- **否决理由**：
  1. **分工制衡消失**：用户明示「分工就是得明确」「补料是采集侧的活」；采写合一复辟「写手自证自写」，选题/证据纪律无独立把关。
  2. **上下文与质量失控**：搜索噪音挤占写作上下文；弱模型把「搜到」当「核实」，幻觉数字的根因（无门槛证据）不消除，只是换了入口。
  3. **证据写权混淆**：写手持 `sources.upsert_batch` 研究写权与 C8「写手对资料库=只读借阅」直接冲突，需改注册表绑定面。
  4. **读无门**：方案 A 若不连同读硬门落地，等于把 P1.4 债放大到所有写手会话。
  5. **审计面糊**：证据质量与写作质量混在一个任务里，无法回答「这条料是谁、按什么门槛核的」。

### 方案 B：零注册表 prompt 接线（把现有只读工具写进各角色 prompt/SOP）

- **内容**：不动 L2 注册表，只在固定角色 prompt/SOP 里指示使用 `wmb_trial_intelligence_website` 等现有工具。
- **否决理由**：
  1. **读侧无硬门，仍是 prompt 纪律**：弱模型臆造工具/空转/越权读无运行时拦截——正是 AgentNetworkPathAudit 指出「读门=设计 P1.4 未落地」要消灭的形态。
  2. **无 grant/审计/投影**：工具不进注册表 → 无角色绑定、无读面、无智能体页摘要、无越权流水；「谁读了什么」不可答。
  3. **grant×prompt 冲突不解决**：daily_judge 的 nativeSearch 规则 5 与缺 `sources.upsert_batch` 的矛盾依旧，判题者一写就被 TASK_SCOPE_BROADENED。
  4. **无生命周期容器**：预算 12 分钟/15 来源/40 候选/3 并行/仅一轮、claim 判定、续派、止环都没有对象可挂，全落回口头约定。
  5. **语义悬空**：`trial_website` 现语义是「渠道候选试读」；不加独立研究读面定义则「证据补料读」名不正言不顺——复用渠道工具会把渠道审计与研究审计混在同一工具上。

### 为什么选正式 ResearchJob

X/XHS 读工具已挂载、Web 研究读面以两个独立 WMB 只读工具补齐（底层复用既有解析/静态提取，杜绝 channel `resolve/trial` 兼任研究读面的语义耦合），缺的是「能力登记 + 意图接线 + 读硬门 + 生命周期」四件事。正式 `cap.research` 把四者统一收进 L2 注册表唯一扩展点（role-permission-design §5）：能力登记驱动签发/读门/审计/投影，research intent 驱动工作流与 grant，ResearchGap/ResearchClaim/EvidencePack 承载预算、门槛、判定与续派。它是**用既有架构补齐既有缺口**，不引入新范式。
---

## 5. 核心对象与状态机

### 5.1 术语表

| 术语 | 定义 |
| --- | --- |
| **ResearchGap** | 缺口合同：父任务（原角色工单）在证据上缺什么、门槛是什么、预算是什么。值对象，持久于 `context_refs_json.research`。 |
| **ResearchJob** | 研究工单：`agent_tasks` 一行，`intent='research'`、`roleId='reporter'`，唯一执行者。 |
| **RequiredClaim** | 必需声明：父任务必须得到答案的命题（如「GLM 5.2 官方是否涨价」），带类型（fact/price/policy）与证据门槛。 |
| **ResearchClaim** | 判定记录：`research_claims` 表一行 = 一个 research 任务 × 一个 required claim 的判定结果。 |
| **EvidencePack** | 证据包：研究任务的交付物，`result_refs_json` 承载；成员即 `research_claims` 行 + 已入库 sourceIds。 |

### 5.2 ResearchGap（context_refs 合同，值对象）

```jsonc
{
  "jobId": "<researchJobId>",            // 复用既有 spawn 合同键（WMB-5141 范式）
  "roleId": "reporter",
  "brief": "研究指令（含研究目标与验收口径）",
  "businessDate": "2026-08-10",          // 父任务业务日（reporter 边界完整性必需，非空）
  "projectId": "59fe…6eb6d",             // 父任务 projectId（如有；供续派重建）
  "research": {
    "gapId": "research-<uuid>",          // 本缺口唯一 ID
    "parentJobId": "<父工单 jobId>",
    "parentTaskId": "<父任务 taskId>",
    "parentRoleId": "writer",            // 父角色 ∈ {writer, planner, librarian}；禁止 reporter/research
    "requiredClaims": [
      {
        "key": "glm52_official_price_rise",
        "text": "GLM 5.2 官方在 OpenRouter 涨价（对比此前的官方基准价）",
        "type": "price"                  // fact | price | policy；price/policy ⇒ needs_time_excerpt
      }
    ],
    "budget": {
      "timeMinutes": 12,
      "minValidSources": 15,
      "maxCandidates": 40,
      "maxParallelFetches": 3,
      "maxRounds": 1                      // 仅一轮（硬上限）
    },
    "channels": ["web", "x", "xhs"]       // 首批只读面，固定枚举
  }
}
```

派生规则：`deriveRoleJobSpec` 对带 `research` 的 reporter 请求派生 `intent='research'`、`policy='research'`、`readback='research_evidence'`、`resourceLocks` 沿用 reporter 锁键并叠加 `research:{parentJobId}`（同父并行互斥）。**角色工单注册表（role-job-registry）是 intent 派生唯一真相源，调用方不得改写。**

### 5.3 ResearchJob（agent_tasks 行）

- `intent='research'`：`RunnerAgentIntent` 并集新增（late-migrations 按 v48/v50 范式重建 CHECK，v51）。
- `status`：沿用既有 `AgentTaskStatus`（running/succeeded/partial/failed/cancelled/interrupted/needs_user），零改动。
- `contextRefs`：§5.2 合同（jobId/roleId/brief/边界 + research 块）。
- `progress`：`{ planned: 40, processed: <候选已处理>, verified: <有效来源数>, saved: <入库数>, message }`（复用 AgentTaskProgress 既有字段，预算计数唯一落点）。
- `checkpoint`：`{ round: 1, startedAt, budgetLeftMs, candidatesProcessed, claimsSnapshot: { [claimKey]: status } }` —— 可恢复现场（重启续跑）。
- `resultRefs`：EvidencePack（§5.5）。

### 5.4 ResearchClaim 状态机（research_claims 表）

状态：`pending → supported | contradicted | unresolved | source_unavailable`（后四态终态；pending 仅存在于任务运行中）。

| 状态 | 判定条件（系统机器校验，fail-closed） |
| --- | --- |
| `supported` | 证据集达到支持门槛：**≥1 官方/一手源**，或 **≥2 独立可靠二手源**（两源 canonical URL 域互异 = 独立代理；每条含 title/originalUrl/author/summary 可核验字段）；`type ∈ {price, policy}` 时**每条支撑证据必须携带 时间（publishedAt/collectedAt）+ 摘录（原文关键句 verbatim excerpt）**，缺则判不支持。 |
| `contradicted` | 反向证据达到同门槛（针对否定命题），或官方来源直接推翻原命题。 |
| `unresolved` | 一轮内已核查但无法判定（证据冲突未达门槛 / 证据质量不足 / 校验失败降级）。 |
| `source_unavailable` | 该 claim 全部候选源读取失败（网络不可达 / 动态渲染读不到 / 登录缺失 / 被反爬 / 验证码或登录墙），无任何可评估材料。 |

判定写入路径：**系统侧推导，非 agent 直接写库**。记者通过结构化输出提出 `{ claimKey, status, evidenceSourceIds, verdictReason }` 建议 → runner 用上述规则逐条校验（数量/独立域/字段完整/时间+摘录）→ 校验通过写 `research_claims`，不通过降级 `unresolved`（原因 `threshold_not_met`）。硬门槛在代码，不在 prompt。

### 5.5 EvidencePack（result_refs_json）

```jsonc
{
  "kind": "research_evidence",
  "jobId": "<researchJobId>",
  "round": 1,
  "claims": [
    { "id": "<research_claims 行 id>", "key": "glm52_official_price_rise",
      "status": "supported", "verdictReason": "…",
      "evidenceSourceIds": ["<sourceId>"], "needsTimeExcerpt": true }
  ],
  "sourceIds": ["<本任务新入库证据 sourceId…>"],
  "validSourceCount": 15, "candidateCount": 40, "timeSpentMinutes": 11,
  "terminalReason": "claims_resolved | budget_exhausted | candidates_exhausted | aborted",
  "unresolvedRequiredClaims": ["<claimKey…>"]   // status ∈ {unresolved, source_unavailable} 的 key 列表
}
```

### 5.6 ResearchJob 终态与续派门槛

| 研究任务终态 | 条件 | 自动续派 |
| --- | --- | --- |
| `succeeded` | 全部 required claim 已终态且无 unresolved/source_unavailable | 是（原角色直接运行） |
| `partial` | 一轮耗尽（预算/候选）仍有 claim 未答，但已产出 ≥1 判定 | 是（但见下：unresolved 卡 needs_user） |
| `failed` / `cancelled` | 运行器错误 / 用户取消 | **否**（桌助向用户呈报，不自动重试） |
| `needs_user` | X/XHS 登录缺失等前置阻塞（沿用渠道式语义） | 否（用户处理后桌助续派） |

**达门槛定义**：研究任务达到终态并产出 EvidencePack（succeeded 或 partial 均可）。15 有效来源为质量目标（未达记入 EvidencePack 质量说明，不阻塞续派）；40 候选 / 12 分钟 / 仅一轮为运行硬边界。**successor 状态门**：EvidencePack 含 unresolved/source_unavailable required claim 时，续派工单**先入 needs_user 再运行**（不跑 Pi 会话），等你批卡片列出未解决声明，用户三选一：**收窄范围 / 手动补料 / 接受标注待核实**；处理后由桌助续派正常运行。全部 resolved（supported/contradicted）→ 续派直接运行。
---

## 6. 角色、Capability、读硬门与红线

### 6.1 cap.research 注册表条目（L2 唯一扩展点新增）

```ts
Object.freeze({
  id: 'cap.research',
  displayName: '研究补料',
  description: '按需研究：白名单读（Web/X/XHS 只读）→ 证据入库 → claim 判定',
  commands: Object.freeze(['sources.upsert_batch'] as const),        // 唯一写回；与 cap.collect 共享命令（many-to-many）
  readProfiles: Object.freeze(['sources', 'x_lists'] as const),
  readToolWhitelist: Object.freeze([                                   // 新增可选字段：读工具硬白名单（research 会话强制）
    'wmb_search_web', 'wmb_read_web_page',                             // 新增独立 Web 只读工具（非 channel resolve/trial）
    'wmb_read_x_list_index', 'wmb_read_x_list_detail', 'wmb_read_x_list_members', 'wmb_read_x_list_timeline',
    'xhs_check_login_status', 'xhs_search_feeds', 'xhs_get_feed_detail', 'xhs_user_profile',
    'wmb_get_source', 'wmb_search_sources'                             // 内部去重读
  ] as const),
  defaultRoleBindings: Object.freeze({ reporter: true }),
  grantKinds: Object.freeze({ task: Object.freeze(['research'] as const) }),
  precise: false,          // 非 Owner UI 型 side-effect 确认；仍受 task grant × role capability × envelope × 对象边界交集约束（§6.4）
  agentGrantable: true,
  owner: 'intelligence',
  since: '2026-08-10'
})
```

- `readToolWhitelist` 为 `AgentCapability` 新增**可选**字段（默认缺省 = 无白名单约束，保证其余角色/意图零回归）；读门投影：`roleReadTools(role) = ∪ readToolWhitelist(enabledCaps(role))`。
- **channel 工具不进白名单**：`wmb_resolve_intelligence_website`/`wmb_trial_intelligence_website` 保持渠道语义（候选解析/试读，挂渠道审计），不承载研究读面；新工具底层仅复用 `resolveWebsiteCandidates`/静态正文提取，工具名、参数、审计语义独立，cap.collect 渠道场景不受影响。
- `TASK_INTENT_NEEDED_CAPS.research = ['cap.research']`；`AUTOMATIC_TASK_GRANT_SCOPES.research = ['agent_tasks.report_progress', 'sources.upsert_batch']`；`roleForTaskIntent('research') = 'reporter'`。写权生效链：intent scope ∩ `filterCommandsForRole('reporter', …)`（`sources.upsert_batch` 经 cap.collect/cap.research 并集放行）∩ 对象边界断言——零新机制，注册表投影自动生效。
- **不在 research scope 内**：`x_lists.observation_start/stop`（cap.collect 有，但 research scope 表语义不含）、`knowledge.*`、`plans.*`、`content.*`、`reviews.*`——研究只采集，不判断、不写方案。

### 6.2 read 工具硬白名单与读硬门

**research 会话可用工具全集（fail-closed 白名单）**：

| 面 | 工具 | 语义 |
| --- | --- | --- |
| 基础设施 | `wmb_get_agent_task` / `wmb_report_agent_progress` | 检查点/进度（全员常备） |
| Web 读 | `wmb_search_web` | 公网搜索候选解析（底层复用 `resolveWebsiteCandidates`；独立工具名/参数/审计语义） |
| Web 读 | `wmb_read_web_page` | 公网页面静态正文提取；静态失败 → 受控 headless browser fallback 渲染动态公网页（不建第二平台登录态、不绕验证码/登录墙；§6.5） |
| X 读 | `wmb_read_x_list_index/detail/members/timeline` | 静默浏览器真实读，最多 50 条/次 |
| XHS 读 | `xhs_check_login_status` / `xhs_search_feeds` / `xhs_get_feed_detail` / `xhs_user_profile` | 只读（XHS_REQUIRED_TOOLS 子集） |
| 内部去重读 | `wmb_get_source` / `wmb_search_sources` | 查重、关联既有证据 |
| 写（唯一） | `wmb_save_source` | 证据入库（§6.4） |

**硬门落点**：MCP 读工具 dispatch 入口按 `taskId → agent_task.intent` 查角色读工具白名单投影——research 会话调白名单外任何工具（含 channel `wmb_resolve_intelligence_website`/`wmb_trial_intelligence_website`、`wmb_get_workbench`、`wmb_get_content`、`wmb_save_plan`、`wmb_record_knowledge`、`wmb_judge_sources`、x_lists prepare/execute、`wmb_prepare_intelligence_channel_changes`、`wmb_spawn_job` 等）→ `READ_PROFILE_BLOCKED`（reason `RESEARCH_READ_WHITELIST`），按 role-permission-design §4.6 管道注入 BLOCKED + 写 `role_authority_blocked` 审计流水。research prompt 同时明示白名单（prompt 仅纪律，dispatch 层为准）。**这是 P1.4 读门的窄域首落：只约束 research intent，其余零变化。**
### 6.3 上下文纪律

- **禁止 `wmb_get_workbench`**（WMB-4917：~868KB 全量工作台会挤爆上下文）；research 简报由 runner 组装（父任务边界 + requiredClaims + 既有证据摘要），对齐 daily 简报模式。
- 研究候选/证据不整体注入父任务上下文；父任务只消费 EvidencePack（result_refs 摘要 + sourceIds），证据正文按需读。

### 6.4 Precise 写回（证据入库契约）

- **性质**：`wmb_save_source` → `sources.upsert_batch` 是**业务写**（写当前根资料库），非平台副作用；`cap.research` 声明 `precise:false` **仅表示不要求 Owner UI 型 precise side-effect 确认**，**不绕过既有公式**——仍须通过自动 task grant（`AUTOMATIC_TASK_GRANT_SCOPES.research` 含该命令）、role capability（cap.collect/cap.research 并集）、execution/task envelope（`taskId/grantId/workerLeaseId/requestId`）与对象边界断言（研究写回 items 不带 feedId → claim 为空，边界断言放行；**研究证据禁止挂渠道 feed**）的精确交集校验。
- **字段契约**（`wmb_save_source` 扩展可选字段 `publishedAt`、`excerpt`、`clientLabel`，非研究任务不强制）：`title/originalUrl/summary/author` 必填，`originalUrl` 为去重主键（canonical 化，WMB-4916 先于引用）；`clientLabel='WMB research'`、categories 标记「研究补料」，可追溯来源角色。
- **价格/政策类 claim 的证据**：必须同时带 `publishedAt`（时间）+ `excerpt`（摘录），缺失即 claim 判定校验失败（§5.4）。
- 幂等：`requestId = agentRequestId(taskId, 'source:<n>')` 确定性生成，重放返回原收据（SPEC §2.2）。
### 6.5 Web 安全与 X/XHS 红线

- **Web 安全（新工具沿用既有防护并扩展，条款入 CAP-028）**：`wmb_search_web` 底层复用 `resolveWebsiteCandidates`（Bing 候选解析 + URL 规范化）；`wmb_read_web_page` **静态正文提取优先**，静态读失败 → **受控 headless browser fallback** 渲染动态公网页（仅渲染只读，不执行用户脚本交互、不注入 cookie/会话、**不创建第二平台登录态**）；**验证码/登录墙不绕过**——遇验证码/登录墙返回明确失败（`source_unavailable`，reason `auth_required`），不尝试破解、不携带任何会话凭证；URL/资源限制（静态与 fallback 共用，fail-closed）：`assertPublicUrl` 防 SSRF（拒绝私网/环回/内网/链路本地地址）+ **DNS 重绑定防护**（解析后目标 IP 二次校验）+ **重定向受限**（仅 http/https，逐跳重校验 host）+ **体积上限**（正文 ≤ 2 MiB）+ **类型白名单**（text/html 等文档型）+ **超时上限**（默认 15s）；研究只读公网 URL，不做登录态抓取、不碰认证页。
- **X 红线**：只读 `read_*` 工具（静默浏览器）；`wmb_prepare_x_list_operation`、`x_lists.operation_execute` 是 REDLINE_COMMANDS（仅 Precise + Owner UI），research scope 不含；研究不启动/停止观察（`observation_start/stop` 不在 research scope）。
- **XHS 红线**：`XHS_FORBIDDEN_TOOLS`（publish_content / publish_with_video / 评论 / 点赞 / 收藏 / 删 cookie / 取登录二维码）永不暴露；research 只允许 XHS_REQUIRED_TOOLS 四只读。
- **发布/硬删不变**：最终发布点击与硬删仅人类 UI，任何实例、任何 grant 组合不可达（C9.8）。
---

## 7. 持久化

### 7.1 映射总表（ResearchJobStorageAudit 落档）

| 语义 | 落点 |
| --- | --- |
| ResearchJob | `agent_tasks` 行，`intent='research'`（v51 CHECK 重建） |
| ResearchGap + 预算 + required claim 门槛 + parent/research/successor 链 | `context_refs_json`（§5.2；续派 `rebuildRoleJobRequest` 直接可用） |
| 预算计数 12/15/40/3 | `progress_json`（planned/processed/verified/saved） |
| claim 状态 + 可恢复现场 | `checkpoint_json` + `research_claims` 行 |
| EvidencePack | `result_refs_json`（成员即 `research_claims` 行） |
| needs_user / 取消 | 既有状态机（`needsUserAgentTask`/`cancelAgentTask`）+ crew 投影 |
| 一次自动 successor | `jobs` 表 `kind='research_successor'`，`dedupe_key='research-succ:{parentJobId}'` UNIQUE，`payload_json` 带 parentJobId；消费按 reproposal 范式 |

### 7.2 唯一新表：`research_claims`（最小表）

```sql
-- late-migrations v51（与 v48/v50 同范式；agent_tasks intent CHECK 同步加入 'research'）
CREATE TABLE research_claims (
  id                        TEXT PRIMARY KEY,
  task_id                   TEXT NOT NULL,          -- agent_tasks.id（research 任务）
  claim_key                 TEXT NOT NULL,
  claim_text                TEXT NOT NULL,          -- 冻结的声明原文（spawn 时复制）
  claim_type                TEXT NOT NULL CHECK (claim_type IN ('fact','price','policy')),
  status                    TEXT NOT NULL CHECK (status IN ('pending','supported','contradicted','unresolved','source_unavailable')),
  verdict_reason            TEXT,
  evidence_source_ids_json  TEXT NOT NULL DEFAULT '[]',
  needs_time_excerpt        INTEGER NOT NULL DEFAULT 0,   -- price/policy ⇒ 1
  verified_at               TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE (task_id, claim_key)
);
CREATE INDEX research_claims_task_status ON research_claims(task_id, status);
```

### 7.3 `jobs` 表 research_successor（一次止环的唯一性载体）
```jsonc
// jobs 行：kind='research_successor'
{
  "dedupe_key": "research-succ:{parentJobId}",       // UNIQUE ⇒ 每父工单至多一个自动续派（重放幂等）
  "payload_json": {
    "parentJobId": "<父工单 jobId>",                 // 续派重建源（读父任务 context_refs）
    "researchTaskId": "<research 任务 taskId>",
    "parentRoleId": "writer",
    "unresolvedRequiredClaims": ["glm52_official_price_rise"],
    "briefSuffix": "…EvidencePack 摘要与写作约束…"
  },
  "due_at": "<now>", "status": "pending"
}
```

消费范式（对齐 topic-maintenance-reproposal.ts）：调度器轮询 due 行 → `rebuildRoleJobRequest(父任务 contextRefs)` 重建原角色请求 → 追加 `briefSuffix` → JobSpawner 派生续派工单 → JOB_EVENT 处理落 completed/failed；`INSERT OR IGNORE` + UNIQUE 保证重启/重放不产生第二个续派。
---

## 8. 自动派工 / 续派数据流与可靠性

### 8.1 主数据流（GLM 案例即为验收路径）
```
① 原角色工单运行（writer studio_draft，projectId=P）
   └─ 运行中报告结构化缺口信号 evidenceGap（progress/checkpoint；或 plan item「missing
      materials」未消解，CAP-003 既有字段）
② 桌助（协调入口，C9.6）自动派记者：wmb_spawn_job({ roleId:'reporter',
   research:{ requiredClaims, budget(深度档), channels:['web','x','xhs'] } })
   ├─ 边界继承：businessDate=父任务业务日（reporter 完整性必需）+ projectId=P（供续派）
   ├─ 幂等：同一 parentJobId 至多一个活动 research 任务（spawn 校验，失败返回既有）
   └─ 契约持久化：context_refs_json（§5.2）
③ research 任务运行（intent='research'，记者实例）
   ├─ 读硬门：白名单内 search_web/read_web_page/X/XHS/去重读，越权 READ_PROFILE_BLOCKED
   ├─ 写回：wmb_save_source 证据入库（originalUrl 去重；price/policy 带时间+摘录）
   ├─ 预算：12 分钟 / 40 候选 / 3 并行抓取（任务内并发信号量，不占额外 worker 槽；
   │        与 maxWorkers 语义互不影响）/ 仅一轮
   └─ 判 claim：结构化建议 → 系统机器校验门槛 → 写 research_claims + checkpoint
④ 终态：succeeded（全部 claim 有答案）/ partial（一轮耗尽仍有未答）→ EvidencePack
   （result_refs）+ 终态事件（JOB_EVENT）
⑤ 自动续派（唯一窄例外）：research 终态处理器 enqueue research_successor
   （dedupe_key=research-succ:{parentJobId}）→ 调度器派生原角色续派工单
   ├─ EvidencePack 无未答 claim → 续派直接运行（新 jobId，同 roleId 同边界，
   │    brief 追加 EvidencePack 摘要 + 「不得编造无出处数字」约束）
   └─ 有未答 claim → 续派先入 needs_user（等你批：收窄 / 手动补料 / 接受标注待核实）
⑥ 用户处理 needs_user 后桌助续派；循环关闭。
```

### 8.2 一次研究绕行硬止环（三层，任何一层都断链）

1. **派生层**：research 工单的父角色 ∈ {writer, planner, librarian}，**禁止 research/reporter 作父**（spawn 校验 fail-closed）→ 不存在 research→research 链。
2. **唯一性层**：`jobs.dedupe_key=research-succ:{parentJobId}` UNIQUE → 每研究任务自动续派恰好一次；`INSERT OR IGNORE` 使终态处理器重入/重启重放幂等。
3. **行为层**：续派工单（原角色）的 grant scope 不含 `sources.upsert_batch`（writer=content.save_version、planner=plans.save 等），原角色无研究写权；续派后再次缺料 → 系统不自动再派研究，`needs_user` 交人；**再开研究工单必须由主编显式决策**（人工编排，非自动绕行）。

### 8.3 重启 / 取消 / 幂等 / 失败

| 场景 | 行为 |
| --- | --- |
| 重启 | research intent 加入 `recoverInterruptedAgentTasks` 的 resume_pending 集合（与 daily_* 同桶）：running → phase='resume_pending'，runner 从 `checkpoint_json` + `research_claims` 恢复（剩余预算内续跑）；其余语义零改动 |
| 取消 | 沿用 `cancelAgentTask`：running/needs_user 可取消；已入库证据保留（既有承诺）；不触发续派 |
| 幂等 | 研究 spawn 按 parentJobId 去重；`wmb_save_source` requestId 确定性重放；claim 写入按 `UNIQUE(task_id, claim_key)` upsert；research_successor 按 dedupe_key 唯一 |
| 失败 | research `failed`/`cancelled` 不续派；桌助向用户呈报失败原因与已入库证据，由用户决定是否重开 |
| 终态重复处理器 | 终态处理器幂等（EvidencePack 已写则跳过；successor 已 enqueue 则 INSERT OR IGNORE 忽略） |
---

## 9. UI 投影与 Pi 展示

### 9.1 智能体页（班组）

- research 任务以**记者卡**呈现（角色分组不变，C9.2）：阶段「研究中」、进度 `processed/planned` 与 `verified/15`、claim 判定摘要（supported/contradicted/unresolved/source_unavailable 计数）、开始时间。
- 终态（succeeded/partial/failed/cancelled）退出活动视图，jobId 可指认（C9.3/9）；`needs_user` 卡停留「等你批」（不占并发/lease/grant/锁，C9.3），卡上列未解决 required claim 与三个处理动作（收窄 / 手动补料 / 接受标注待核实）。
- 投影复用既有 `crew-instance-projection`（needs_user 去重、jobId 锚点、持久 needs_user 重启重建）——research 工单走 JobPool 与既有员工工单同管道，不另建投影。

### 9.2 Today（主编桌）

- **只上 unresolved required needs_user 卡**：「等你批 — GLM 5.2 官方涨价声明未解决」+ 三个决策动作。上桌条件严格等于：EvidencePack 含 unresolved/source_unavailable required claim 的续派工单处于 needs_user。
- **永不上桌**：研究进度、候选清单、运行日志、裸资料（C2/C4「不上半成品原料堆」）；研究者与研究过程中间态只活在智能体页。
- 全部 resolved 的续派正常运行 → 无新卡上桌，桌面只呈现既有呈报流。

### 9.3 Pi 展示

- 桌助经既有 `JOB_EVENT` 终态推送 + `wmb_get_job`（monitor.task）观察 research 任务；不 sleep/bash 轮询（对齐 paste-1 会话既有纪律）。
- `wmb_spawn_job` 扩展 research 参数面（roleId='reporter' + research 块），其余桌面工具不变；新工具 `wmb_search_web`/`wmb_read_web_page` 仅属 research 读面（§6.2），桌助侧工具面不变。
---

## 10. 立法影响清单（Legislate 转写输入）

| 文档 | 修改 | 内容要点 |
| --- | --- | --- |
| PRODUCT.md | **C9 窄例外修订（C9.3 增补）** | 「员工不自动多跳」增补唯一窄例外：ResearchJob 终态后系统自动派生一次原角色续派工单（同边界、同角色、dedupe 唯一、research→research 禁止、续派后缺料转 needs_user）。 |
| PRODUCT.md | **C9.10 范围澄清** | 「不新增表/列」明确限定于续派合同（context_refs_json）与 agent_tasks/task_grants/execution_grants 三表结构；`research_claims` 为研究证据判定表（唯一新增业务表），与 C8.3 注册表扩展点无冲突。 |
| PRD.md | **新增 §2.5「ResearchJob 补料与研究续派（窄例外）」** | 记者统一补料；首批 Web+X+XHS 只读（Web 用 `wmb_search_web`/`wmb_read_web_page`）；深度档 12 分钟/15 有效来源/40 候选/3 并行/仅一轮；达门槛自动 successor 原角色；required claim 门槛（1 官方/一手 或 2 独立可靠二手；价格政策需时间+摘录）；四态判定；一次硬止环；Today 只上 unresolved required needs_user。 |
| PRD.md | §2.3 / §5.1 措辞增补 | 新增 cap.research 能力登记与 research intent 说明；研究补料并入情报流程（第一价值 #1 采集侧）。 |
| SPEC.md | §1.0 不变量 8–9 增补窄例外条款；§2.2 并发注记 | 有界研究读（3 并行抓取）符合既有「有界读/研究可并发」条款，不绕过写边界。 |
| SPEC.md | **新增 CAP-028「ResearchJob 证据补料与单跳续派」** | 本设计 §5–§8 转写为规范条款（对象、状态机、门槛、白名单、读门、止环、持久化）+ **Web 安全条款**（§6.5：浏览器回退边界、验证码/登录墙不绕过、SSRF/DNS 重绑定/重定向/体积/类型/超时）。 |
| SPEC.md | 验收矩阵新增 **EVAL-032** | 见 §12。 |
| Capability 注册表 | `src/shared/agent-capabilities.ts` | 新增 `cap.research`（含 readToolWhitelist 可选字段）；`TASK_INTENT_NEEDED_CAPS.research`；`AgentCapabilityId`/`AgentCapability` 类型扩展。CI 六检查（role-permission-design §5.4）随之覆盖新命令/新能力。 |
| 新工具 | wmb-mcp 工具注册 | 新增 `wmb_search_web`/`wmb_read_web_page`（独立工具名/参数/审计语义；底层复用 resolveWebsiteCandidates/静态正文提取；浏览器回退安全边界）。 |
| 角色工单注册表 | `src/main/role-job-registry.ts` | `RoleJobRequest` 新增 research 变体（reporter + research 块）；`ROLE_TO_POLICY`/`ROLE_TO_READBACK`/`ROLE_TO_FAILURE_CODE` 增 research 映射；`RoleJobPolicy`/`RoleJobReadbackKind` 并集扩展；`deriveRoleJobSpec` 派生 intent='research'。 |
| Task grant | `src/main/task-grants.ts` | `AUTOMATIC_TASK_GRANT_SCOPES.research`；`roleForTaskIntent('research')='reporter'`。 |
| Agent task | `src/main/agent-tasks.ts` + late-migrations | `RunnerAgentIntent` 并集 'research'；v51 CHECK 重建；`recoverInterruptedAgentTasks` research 入 resume_pending 集合。 |
| 新表 | late-migrations v51 | `research_claims` DDL（§7.2）。 |
| 新 job kind | migrations/jobs 消费 | `research_successor` 入队/调度/事件处理（reproposal 范式）。 |
| 读硬门 | MCP 读工具 dispatch + agent-runner research prompt | research 会话白名单 fail-closed（READ_PROFILE_BLOCKED + 审计）。 |
| operator Skill | `skills/wemedia-buddy-operator/SKILL.md` | 研究工作流 playbook（§11）。 |

**不涉及**：PRD §2.0/§2.4 主条款、SPEC §1.0 其余不变量、C1–C7、发布/硬删红线、权限 UI、TASKS/PLAN。
---

## 11. Pi Skill 影响（pi-operation-skill-maintenance.md 影响表逐条）

| 影响表条目 | 判定 | 动作 |
| --- | --- | --- |
| 新增/变更 Pi/MCP 工具 | **新增 `wmb_search_web`/`wmb_read_web_page`**（零新供应商/模型/平台 API）；`wmb_save_source` 增可选字段（publishedAt/excerpt/clientLabel） | 更新 operator Skill：新工具参数与浏览器回退安全边界、wmb_save_source 参数说明与证据字段要求 |
| 新增用户工作流 | 是（研究补料 → 续派 → needs_user 决策） | 更新 playbook：识别 evidenceGap、派 research 工单、读白名单、验收 EvidencePack、处理等你批三动作 |
| 变更 task/job 状态 | 是（新 intent 'research'、新 job kind 'research_successor'、研究 needs_user 语义） | 更新状态解释与安全下一步章节 |
| 变更授权边界 | 是（research 读白名单、写回为业务写且仅免 Owner UI 型确认） | 更新「可准备/仅 UI 确认」边界说明 |
| 变更渠道/工作空间/模块 | 否（研究不触渠道配置、不改模块归属） | 证据写回标注 clientLabel |
| Skill 打包/安装 | 否 | 无动作 |

证据合同：立法后 TASKS 验收行必须写「Pi operator Skill impact: updated — 研究补料 playbook 与 wmb_save_source 字段说明」；**lane Skill 不复制研究流程**（pi-operation-skill-maintenance.md 规则）。
---

## 12. 测试 / eval 与 GLM 案例端到端验收

### 12.1 EVAL-032（建议编号）：「ResearchJob 补料与单跳续派」

使用 GLM 5.2 反常低价 fixture（@AbionMorse 帖 + 智谱官方定价页 + OpenRouter 模型页 + 一个动态渲染公网页 fallback fixture）跑通端到端，可证伪验收：

1. writer 工单（projectId=P）运行中报告 evidenceGap（requiredClaims 含 `glm52_official_price_rise`，type=price）→ 桌助**自动**派 research 工单（同一边界：businessDate + projectId=P），同一 parentJobId 至多一个活动 research 任务。
2. research 任务在智能体页呈现为记者卡，progress 计数（planned=40/verified 目标 15）真实推进。
3. **读硬门**：research 会话调用白名单外工具（如 `wmb_get_workbench`、channel `wmb_trial_intelligence_website`）→ `READ_PROFILE_BLOCKED`（reason RESEARCH_READ_WHITELIST）+ 审计流水；白名单内 search_web/read_web_page/X/XHS 读正常。
4. 证据写回：每条 `wmb_save_source` 带 originalUrl（canonical 去重，重复入库不新增 source）；price claim 证据带 publishedAt + excerpt；无 feedId；**缺 taskId/grantId/workerLeaseId/requestId 或带 feedId → 边界断言拒绝**（precise:false 仅免 Owner UI 确认，不豁免既有交集约束）。
5. **claim 机器校验**：伪造「supported」但证据不达门槛（1 条二手/缺时间或摘录）→ 降级 unresolved（threshold_not_met）；官方价页 1 条一手 + 独立二手 → supported；官方价页明确未涨 → contradicted；全部候选不可读 → source_unavailable。
6. **仅一轮**：候选耗尽/12 分钟到点 → 终态 partial + EvidencePack（round=1）。
7. **自动续派**：research 终态 → `jobs` 行 `kind='research_successor'`、`dedupe_key='research-succ:{parentJobId}'`；重放终态处理器（同 parentJobId 二次 enqueue）→ 仍只产出一个续派；续派 = writer 工单（同 projectId），brief 追加 EvidencePack 摘要。
8. **硬止环**：续派 writer 再次缺料 → **不**自动再派 research → needs_user 卡；research 工单的父 intent 为 research 时 spawn 拒绝（VALIDATION_ERROR）。
9. **Today 投影**：未解决 required claim 的续派 → 唯一等你批卡（收窄/手动补料/接受标注待核实）；研究进度与裸资料不出现在 Today。
10. **重启恢复**：research 任务 running 中重启 → resume_pending，从 checkpoint + research_claims 恢复（剩余预算内）；`research_successor` 已 enqueue 未消费 → 重启后仍只消费一次。
11. **产物质量**：续派写手新稿**无无出处数字、不整段复制旧稿**；「官方涨价」从「标待核实」变为有据（supported/contradicted），或按用户决策收窄/标注。
12. **取消/失败**：取消 research → 已入库证据保留、不续派；failed → 桌助呈报、不自动重试。
13. **Web 安全（条款同入 CAP-028）**：`wmb_read_web_page` 静态读失败 → fallback 成功渲染动态公网页 fixture 并返回正文；同一 URL 含验证码/登录墙 → 明确失败（reason auth_required），不绕、不携带会话凭证；私网/环回 URL → SSRF 拒绝；DNS 重绑定宿主 → 拒绝；重定向跳出白名单域 → 拒绝；超大页面（>2 MiB）/非文档类型/超时（>15s）→ 拒绝或截断——均记审计流水。

### 12.2 机械层测试（脚本/单测，非项目级套件）

- research_claims UNIQUE(task_id, claim_key) 与 CHECK 枚举约束；
- research_successor dedupe_key 唯一性与 INSERT OR IGNORE 幂等；
- 读白名单枚举负断言（白名单外工具必被 READ_PROFILE_BLOCKED，含 channel resolve/trial）；
- claim 判定函数四态 + 门槛矩阵（1 官方/2 独立二手/时间+摘录缺失降级）；
- spawn 校验（父角色白名单、同 parentJobId 活动研究去重、research 父拒绝）；
- `rebuildRoleJobRequest` + briefSuffix 续派重建正确性；web 读 URL 校验（SSRF/DNS 重绑定/重定向/体积/类型/超时）与 fallback 触发/降级条件。
---

## 13. Owner lock（编号块 —— 正式锁定 2026-08-10）

> **Owner lock 2026-08-10（ResearchJob 补料与研究续派 —— 窄例外）**：本块为**正式 Owner lock**，Owner 已批准整个书面设计（含 §5–§8 契约、§10 立法清单、§12 验收）并经书面 Spec Review 2026-08-10 PASS。本锁定仅授权下一阶段 Legislate；不产生任何实现许可，TASKS doing 状态不受影响，本设计文件之外的任何改动须另行立法（R13）。

1. **R1 正式 ResearchJob Capability**：新增 `cap.research`（记者绑定；research intent；`sources.upsert_batch` 唯一写回；读工具硬白名单），权限唯一扩展点仍为 L2 注册表；不新增角色、不做权限 UI。
2. **R2 记者 = 统一补料执行者**：首批研究读面 = Web（`wmb_search_web`/`wmb_read_web_page`，新增 2 个 WMB 只读工具，零新供应商/模型/平台 API）+ X（read_*）+ XHS（search/detail/profile）**只读**；channel resolve/trial 保持渠道语义、不承载研究读面；研究不触渠道配置、不碰平台副作用。
3. **R3 桌助在原任务边界内自动派记者**：识别 evidenceGap 即自动派 research 工单（businessDate + projectId 边界继承；同一 parentJobId 至多一个活动研究任务）。
4. **R4 深度档预算（本次唯一档位）**：12 分钟 / 15 有效来源 / 40 候选 / 3 并行抓取 / 仅一轮；预算计数进 progress_json，机器执行不靠 prompt。
5. **R5 自动单跳续派 = C9「不自动多跳」唯一窄例外**：研究达门槛（终态 + EvidencePack）后自动派生原角色续派工单一次（同边界、同角色、新 jobId）；research→research 禁止；其余角色链路无任何自动多跳。
6. **R6 required claim 证据门槛**：supported = 1 官方/一手 或 2 独立可靠二手（独立域代理 + 字段完整）；price/policy 类必须带时间+摘录；contradicted 同门槛反向；unresolved / source_unavailable 为未答态。
7. **R7 claim 四态状态机 + `research_claims` 最小表**：唯一新增业务表（查询/审计面）；C9.10「不新增表/列」与 §8.2「唯一新增持久化」明确限于授权与续派合同，立法时写入范围澄清。
8. **R8 一次研究绕行硬止环**：派生层（父角色白名单）+ 唯一性层（dedupe_key UNIQUE）+ 行为层（原角色无研究写权、续派后缺料转 needs_user）三层断链；再开研究必须主编显式决策。
9. **R9 Today 只上 unresolved required needs_user 卡**：等你批三动作（收窄/手动补料/接受标注待核实）；研究进度、候选、裸资料永不上桌（C2/C4）。
10. **R10 读硬门窄域首落**：research 会话按 readToolWhitelist fail-closed（READ_PROFILE_BLOCKED + 审计，含 channel resolve/trial 拒绝）；其余角色/意图零回归；全量读门仍按 role-permission-design P1.4 原排期。
11. **R11 重启/取消/幂等**：research 入 resume_pending（checkpoint + research_claims 恢复）；取消/失败沿用既有状态机，已入库证据保留；spawn/写回/successor 全链幂等。
12. **R12 Web 读安全边界**：`wmb_read_web_page` 静态读失败 → 受控 headless browser fallback 渲染动态公网页；**不创建第二平台登录态、不绕验证码/登录墙**；SSRF/DNS 重绑定/重定向/体积/类型/超时限制进入 CAP-028 与 EVAL-032（§6.5/§12）。
13. **R13 立法范围**：PRODUCT C9 窄例外条款 + C9.10 澄清 + PRD §2.5 + SPEC CAP-028（含 Web 安全）/EVAL-032 + 新工具注册 + 注册表/intent/读门/operator Skill；**不产生实现计划与任务编号**；本设计文件之外的任何改动须另行立法。
---

## 14. 自审

1. **无占位**：全部字段、DDL、状态机、门槛、边界、数据流、验收均为可转写的确定条款；无未决占位词或「后续决定」；研究档位明确「本次仅深度档，不预留枚举」（非目标而非占位）。
2. **无矛盾**：
   - 「零新表」矛盾已显式消解：唯一新表 `research_claims` 与 role-permission-design §8.2、PRODUCT C9.10 的「不新增表/列」在 §10 以范围澄清并轨（§8.2/C9.10 承诺的是授权持久化与续派合同）。
   - 「新增 2 个 WMB 只读工具」与「零新供应商/模型/平台 API」全文一致（§0/§2/§3.2/§6/§11）；channel resolve/trial 仅作现状事实与底层复用依据，不进入 research 白名单/锁定条款（§6.1/§6.2/§12/§13）。
   - 「自动多跳」与 C9.3 不变量：以「唯一窄例外 + 三层硬止环」框定，不构成通用编排。
   - 3 并行抓取 ≠ maxWorkers 配额：明确为任务内抓取并发，占一个 worker 槽（§8.1③）。
3. **范围聚焦**：不新增角色（仅 2 个 WMB 只读工具）、不改渠道语义/权限 UI/编排图；资料员席位健康、动态渲染抓取器、全局读门明确划为非目标。
4. **术语一致**：沿用 WMB 术语（桌助/记者/策划/写手/资料员、intent、JobContract、context_refs_json、needs_user、JobPool、boundary、REDLINE_COMMANDS、EvidencePack、ResearchGap/ResearchClaim）；「深度档」「达门槛」「原任务边界」「一次硬止环」全文同义使用。
5. **依据核对**：Owner 已确认契约逐条落档（Contract → §5.4/§5.6/§6/§8/§9/§10/§13）；锁定修订（新工具语义与浏览器回退边界、precise 口径、Web 安全入规范与 EVAL、日期唯一 2026-08-10）全文一致；审计三件套结论作为 §1/§2/§7 证据与映射源，未新增未核实论断。
---

*验收对照（Acceptance）*：①本文件自包含且可被 Legislate 直接转写（§10 逐文档清单 + §12 验收条款）✓；②明确一张新表（§7.2 `research_claims`）且消解「零新表」矛盾（§10/§14.2）✓；③无实现计划、无任务编号（§13 R13、§3.2）✓；④仅修改 `docs/spark/2026-08-10-agent-research-job-design.md`，未修改其他文件 ✓；⑤全文无未来日期（仅 2026-08-10）✓；⑥行数 ≤ 500（合并空行/重复段压缩）✓；⑦§13 为正式 Owner lock（书面 Spec Review 2026-08-10 PASS），锁定状态全文一致，下一步仅 Legislate ✓。
