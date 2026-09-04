# 2026-08-25 选题“安全偏”归因审计 — 五条谨慎型 AI 工程/治理选题为何取代传播型选题

- 业务日期 `2026-08-25` Asia/Shanghai
- 审计对象 `j:/PigeonYang/WeMediaBuddy` + 活动数据根 `J:\PigeonYang\WeMediaBuddyData\wmb.db`
- 审计时间 2026-08-26 02:00 Asia/Shanghai  · 执行者 `AuditTopicSafeBias` (read-only, 无扫描/无落库)
- 结论等级 `主因可证伪 · 辅因可复核` — 任一反事实证据可直接推翻对应分支
- 关联交付 `docs/audits/2026-08-25-topic-selection-safe-bias-audit.md` (本文件)

> 一句话结论：五题“安全偏”不是单点模型保守，而是**数据输入全为研究补料 + 提示词目标显式奖励可验收工程判断 + 评分体系未度量传播质量且被绕过 + UI 用 `priority → SSS` 伪装成传播等级**四重叠加；`SSS/S/A/B` 表达的是工程治理优先级，而非任何点击/收藏/分享意义上的传播质量。

---

## 1 执行结论（可证伪）

| 维度 | 判定 | 可证伪条件 |
|---|---|---|
| **主因** | **提示词/目标偏置 + 评分体系偏置** — `wemedia-intelligence-engine` 的正式目标与四问/五维/六栏目把“好机会”定义为“AI 实践×公开验证×产品化”的可验收工程动作，而非自媒体传播质量；6 维评分无传播维度且被 `pending` 绕过 | 若 `src/main/agent-runner.ts:354 dailyPrompt` 的“判断要求”实际要求以 CTR/收藏/分享/评论张力为第一目标，或 `SCORE_CRITERIA_RECORD` 含 `propagation_virality/shareability/tension` 权重且 5 题 score 为 `scored` 非 `pending`，则本判定被推翻 |
| **次因 1 数据/输入偏置** | 本轮增量 60 条几乎全为 `categories=["研究补料"]`、`verification_status=pending` 的官方文档/论文/仓库（evals/OSWorld/VBench/Cindy…），无高张力社交热点 | 若 `source_items` 在 `2026-08-24T19:41:55Z` 水印后 60 条含 ≥10 条 `signal_only`/`热点冲突`类 X List 热帖且被纳入 5 题 `source_ids_json`，则推翻 |
| **次因 2 编排失效** | `daily_judge` 直写 `plans.save` 产出 `planning_status=draft` + `score_reasons_json={"status":"pending","score":0}` 的方案并置为 `is_current=1`；Stage C 的 6 维 `scored` 门槛被完全绕过，`filterApprovedItems` 本应隐藏它们 | 若 `plan_items` 中 `b879…` 5 行其 `planning_status=approved` 且 `score_reasons_json.status=scored`，则推翻 |
| **次因 3 UI 标签幻觉** | 渲染层 `priorityGrade(0)=SSS 金色扫光` 与 `formatScoreDisplay` 的“— / 待补证据”割裂：用户看到 SSS 误以为是传播侧的置顶推荐，实为工程优先级的展示幻觉 | 若 `src/renderer/today-view-parts.tsx:163 priorityGrade` 实际映射 `score.total` 而非 `priority` 整数，则推翻 |
| **非主因（已排除）** | 源资料去重/多样性、UI 投射错误（行号错位）、多轮评分平均等均不是主因 | 详见 §5 根因树 |

---

## 2 证据链（端到端·文件行号+DB 查询双锚定）

### 2.1 身份配方与正式目标（客观标尺）

- **工作空间配方** `J:\PigeonYang\WeMediaBuddyData\wmb.db:workspace_profiles` 单行：
  `display_name="AI × 商业化成长"`, `audience="正在寻找 AI 商业化方向、愿意完成真实项目并获取反馈的中文读者"`, `content_goal="…从迷茫走向明确：找到个人商业化方向，完成第一个真实项目并拿到真实反馈；不承诺收入"`, `intelligence_pack_id="wemedia-intelligence-engine"`。
- **编辑简报装配** `src/main/editorial-brief.ts:103 assembleEditorialBrief` · 渲染 `src/main/editorial-brief.ts:214 renderEditorialBrief` — 简报由 `身份 + 历史 + 存量 + 增量` 四块组成；增量口径 `src/main/editorial-brief.ts:168-184` `WHERE collected_at > watermark AND management_status != 'archived' ORDER BY collected_at DESC LIMIT 60`，`pending` 资料入选但评分未做。
- **理想自媒体传播标尺（对照本案缺席项）**：受众实效（明确谁今天就能用）、读者收益（可复制动作/可对比回执）、冲突张力（反直觉/证据冲突）、时效钩子（为何今天比明天值钱）、可分享性（是否值得转给同事/群）；本案判定只满足“可执行”，四项显著缺席（见 §6）。

### 2.2 情报通道与本轮真实输入

- **真实运行的通道** `agent_tasks:856e3e17-b193-4c31-9ff9-1376f0681b45` `checkpoint_json.intelligenceChannels.modules=["x_lists"]`，`context_refs_json.planDate=2026-08-25`。对应 `pi-agent/sessions/daily-2026-08-25-856e3e17-b193-4c31-9ff9-1376f0681b45.jsonl:63` 首个 `user` prompt 内的 `【编辑简报】` 增量头 `水印 2026-08-24T19:41:55.160Z 之后，共 60 条，已截断`。
- **60 条的真实面貌**（量）：DB 验证 `SELECT management_status, count(*) FROM source_items WHERE collected_at BETWEEN '2026-08-24T16:00:00Z' AND '2026-08-25T16:00:00Z' GROUP BY management_status` → `active 285 / archived 39`；`SELECT verification_status …` → `pending 324` 全部待核实。本轮 60 条抽样首 10 条含 `99563ce… Computer use | Gemini API`, `7755a458… Notion 七年`, `dd553d17… MiniMax H3` 等，但最终入选的 5 题未使用其中任何社交/需求侧热帖。
- **DB 侧来源分类** `source_items.categories_json` 对 5 题 22 个 `sourceIds` 的抽检（例 `b55c0aef… categories=["研究补料"]`，`00d75ba7… ["研究补料"]`）全命中研究补料，无 `signal_only`/热点冲突信号。

### 2.3 生产者与提示词/判据

- **生产者任务** `agent_tasks:856e3e17` `intent=daily_judge` `status=succeeded phase=completed` `business_date=2026-08-25` `pi_session_id=daily-2026-08-25-856e3e17-b193-4c31-9ff9-1376f0681b45` `created 2026-08-25T03:41:13.359Z → updated 2026-08-25T03:48:00.650Z`。`result_refs_json` → `planId=b8796009-6fc5-46be-9c1e-8630cd4011e3` `planItemIds=[ebecc2d8…,e646fc4…,b8a438…,7f908f…,00a323…]` `opportunityCount=5`。
- **提示词模板** `src/main/agent-runner.ts:354 dailyPrompt` + `src/main/agent-runner.ts:385-422` 判断要求：
  1) 先读身份块对齐，脱离身份的泛资讯/纯模型公告/参数新闻直接丢弃；2) 四问必须含五维命中环 `时代认知/个人方向/AI实践/公开验证/产品化`，说不出环节则降权或丢弃；2.5 六栏目骨架；2.7 标题三切口但“夸张反常识只放 titleGuidance”；**3) `优先级 0=SSS…7=F`**（`src/main/agent-runner.ts:391`）；4) 禁止调 `wmb_get_workbench`；6) 先输出赛道判定块再输出方案块。
- **机会标准** `skills/wemedia-intelligence-engine/references/opportunity-standard.md:1-40` 四问 + 五维 + 六栏目 + `evidence = 真实来源 + 主编实践/案例 + 具体行动`；`skills/…/subskills/opportunity-editor/SKILL.md` 明确“按 `SSS→F` 排序”。
- **等级即幻觉的根** `skills/…/references/wmb-field-map.md:28` `priority 用整数编码等级，不要写“优先级1/2/3”给人看：0=SSS（仅突发特别重大事件，极少使用；金色扫光）…7=F` + `src/renderer/today-view-parts.tsx:163-173 priorityGrade` 将 `priority` 整数直接映射为 `SSS/S…F` 并套金色扫光/红蓝等 `opp-grade` 样式。
- **赛道门** `src/main/agent-runner.ts:157 parseLaneGateOutput` + `skills/…/references/collection-sop.md` — W1 A 类官宣全量打卡，Tier0 `isTier0AutoRelevantSource` 直通，Tier1 由本 `daily_judge` 在输出首个 ```json 块内一次完成；本轮门控首尾回执均为 `sources.lane_gate:requestId 856e3e17…:gate` `ok:false`（`performance validation missed` 误报）后重试 `…:r1` 仍失败，但 `plans.save` 仍成功，说明门控失败未阻断方案落库（fail-closed 设计在实践中未生效于本轮）。

### 2.4 产出落库与排序

- **落库路径** `src/main/agent-runner.ts:540 savePlanFromSynthesisOutput` → `parseDailyPlanOutput` 取最后一个 ```json 块 → `allowedSourceIds` 过滤 → `plans.save` 派发 `CommandReceiptV1 receiptId=b1ef2d24… ok:true` → `src/main/planning.ts:88 saveCurrentPlan` 事务内 `INSERT plans` + `INSERT plan_items ×5`。
- **排序** `src/main/planning.ts:98 items.sort((a,b)=>a.priority-b.priority)`，先 `0(SSS)` 再 `1(S)…`。因此截图中自上而下的顺序就是 `priority` 的数值序，而非任何传播分数。
- **DB 事实（最强）**：
  ```sql
  SELECT id, plan_date, is_current, summary FROM plans WHERE plan_date='2026-08-25' ORDER BY updated_at DESC;
  -- b8796009… is_current=1, 8fc7476e… is_current=0 为同方案的回退副本；876b25ae…/354d0684… 等 4 份为前日 24 日产生的候选，未成为 current

  SELECT title, priority, planning_status, score_reasons_json, source_ids_json
  FROM plan_items WHERE plan_id='b8796009-6fc5-46be-9c1e-8630cd4011e3' ORDER BY sort_order;
  -- 5 行均为 planning_status='draft', score_reasons_json='{"status":"pending","score":0,"reasons":[]}'
  -- pending_reason=insufficient_evidence, provenance.origin='daily_judge'
  SELECT COUNT(*) FROM plan_items WHERE plan_id='b8796009…' AND planning_status='approved'; -- 0
  ```

### 2.5 UI 投射与“今日”真相

- **今日投射** `src/main/workbench.ts:410 getToday` → `loadPlan(planDate, is_current=1)` 取 `b879…` → `rawTodayItems = plan.items` → `src/renderer/today-view.tsx:96 todayItems = filterApprovedItems(rawTodayItems)`。
- **过滤器** `src/renderer/proposal-ledger.ts:168 filterApprovedItems = items.filter(isApproved)` + `isApproved = planning_status==='approved'`（`src/renderer/proposal-ledger.ts:143`）。因此**真·Today 页的“今日机会”应为 0**；截图若显示 5 条 SSS/S/A/B，必然不是 `TodayView.todayItems`，而是**提案台账/池的未过滤视图**（`src/main/proposals.ts:200 fetchAllLedgerRows` 取 `is_current` 最近方案的全部 `plan_items`，再在前端按 `priorityGrade` 展示金色 SSS）。此即 UI 标签幻觉的精确落点。
- **评分展示** `src/renderer/proposal-ledger.ts:98 formatScoreDisplay` 对 `planning_status='draft'` 恒返回 `— / 待补证据`；`formatScoreWithPending` 亦然。故同一行上同时出现 `SSS（金色）` 与 `评分：待补证据（—）` 的割裂状态，可被 `plan_items.score_reasons_json` 与前端快照直接证实。

---

## 3 五题逐条溯源表

> `planId=b8796009-6fc5-46be-9c1e-8630cd4011e3` (`is_current=1`, `created 2026-08-25T03:48:00.136Z`, `summary="今日增量最值得做的不是模型新闻，而是把 AI 能力改造成可验收的真实项目：先定义评分与回执，再公开测试 agent 泛化、视频质量和产品化边界。"`) — `agent_tasks:856e3e17` `daily_judge` 产物

| # | 标题（原文） | 等级(展示) | 形式等级来源 | 生产者 | 时效/受众/角度（原文） | 来源证据（可追溯 URL） | 状态/分数 | 去重/多样性 |
|---|---|---|---|---|---|---|---:|---|
| 1 | 别再展示 AI 做成了什么，先把它放进一套能复跑的评测里 | **SSS** `priority=0` 金色扫光 | `agent-runner.ts:391` 模型直出 `priority` | `856e3e17 daily_judge` `g=planner` `m=gpt-5.6-luna:max` | `timeliness=本周` / `audience=正在把提示词/Agent/自动化流程做成真实交付的人` / `angle=选一个重复任务，写10个真实样本和验收标准…` / `POV=价值不由最好的一次输出决定…命中 AI实践/公开验证/产品化` | `b55c0aef…https://github.com/openai/evals/blob/main/docs/build-eval.md`, `a55c0d1e…https://developers.openai.com/api/docs/guides/evals`, `6cbdb50…https://docs.langchain.com/langsmith/evaluation`, `8e6e35…https://docs.langchain.com/langsmith/evaluation-concepts`, `d281ad…https://cloud.google.com/vertex-ai/generative-ai/docs/models/evaluate-models`, `05743b…https://github.com/anthropics/courses` | `planning_status=draft` `score={"status":"pending","score":0,"reasons":[]}` `provenance.fingerprints.template_exact_9fields=false` | `fingerprintPlanItem(title,topicId,sourceIds) sha256` 无冲突；`topicId=新建`（多日“本周”触发 `createTopic`）；未与其它四条去重（标题 bigram 不重叠） |
| 2 | 一次成功的 Agent 演示，为什么还不能算交付能力 | **S** `1` 金色 | 同上 | 同上 | `热点 2-3天` / `audience=正在尝试把浏览器 Agent/客服 Agent/自动化流程交给真实用户测试的人` / `angle=选5个不同网站或约束的小任务…` / `POV=第一份产品证据不是“它完成过”而是“它在重复任务中稳定完成…”` | `00d75ba…https://arxiv.org/abs/2404.07972 OSWorld`, `64fe3d1…https://arxiv.org/abs/2306.06070 Mind2Web`, `2f1bb13…https://arxiv.org/abs/2406.12045 τ-bench`, `bf5968…https://github.com/ServiceNow/BrowserGym`, `390e6…https://github.com/web-arena-x/webarena`, `706bc0…https://github.com/xlang-ai/OSWorld` | 同上 draft/pending | 同上 |
| 3 | 批量生成视频以后，先用一致性和闪烁把废片筛掉 | **A** `2` 红 | 同上 | 同上 | `长期` / `audience=正在尝试为客户或自己的账号批量制作 AI 视频的人` / `angle=固定提示词生成一小批样片，按一致性/闪烁/运动和成像质量筛选…` / `POV=瓶颈不是能不能出片而是有没有可复核质量门…` | `6fe96a5…https://runway.com/`, `0950f2d…https://vchitect.github.io/VBench-project`, `ebfde48…https://github.com/Vchitect/VBench`, `f8cf48…https://ap.org/…ai-guidance…` | 同上 | 同上；19 分上与 #4 同级按原序 |
| 4 | AI 产品从 Demo 走向工作环境，真正增加的是哪些约束 | **A** `2` 红 | 同上 | 同上 | `持续/多日` / `audience=正在把个人 AI 工作流整理成可交付工具或小团队服务的人` / `angle=拆出隔离、逐条审查、可回退、过程成本可见四个稳定层…` / `POV=产品化不是再加按钮而是把失败/权限/交接纳入交付…` | `a974c0a…https://cindy.cn/`, `486867…https://github.com/makecindy/cindy/blob/main/README.zh-CN.md`, `80c53fb…https://gameres.com/901202300.html`, `d15c49…https://chooseai.net/news/5353` | 同上 | 同上 |
| 5 | 先问清楚谁会为这张 AI 结果卡片负责，再决定做什么 | **B** `3` 蓝 | 同上 | 同上 | `长期` / `audience=还没有确定 AI 服务对象、但想完成第一个真实项目的人` / `angle=做5次针对具体岗位的深度访谈…再做一张最小交付卡` / `POV=方向不是从“我会什么模型”开始而是“谁在什么场景下愿意为结果负责”…` | `a7d9c60c…https://gov.uk/service-manual/user-research/using-in-depth-interviews`, `7755a458…https://sspai.com/post/102031 Notion七年` | 同上 | 同上 |

> 校验 SQL（可复制到 `sqlite3 J:\PigeonYang\WeMediaBuddyData\wmb.db`）：
> ```sql
> .headers on
> SELECT sort_order, priority, CASE priority WHEN 0 THEN 'SSS' WHEN 1 THEN 'S' WHEN 2 THEN 'A' WHEN 3 THEN 'B' ELSE 'C…' END AS grade,
>        title, planning_status, score_reasons_json FROM plan_items
> WHERE plan_id='b8796009-6fc5-46be-9c1e-8630cd4011e3' ORDER BY sort_order;
> ```

---

## 4 评分语义 — `priority` 不是传播分，`score` 未生效

### 4.1 两套“分”同名不同义

| 体系 | 定义位置 | 取值 | 语义 | 本案 5 题取值 | 是否决定 SSS/S/A/B |
|---|---|---|---|---|---|
| **A. 机会等级 `priority`** | `agent-runner.ts:104 planOutputItemSchema priority 0..7` → `planning.ts:88 saveCurrentPlan priority 0..7` → `today-view-parts.tsx:163 priorityGrade` | `0=SSS,1=S,2=A,3=B,4=C,5=D,6=E,7=F` | 模型对机会“工程/商业重要度”的主观分档；`SSS` 定义为“仅突发特别重大事件，极少使用；金色扫光”(`wmb-field-map.md:28`) | `0,1,2,2,3` | **是**（唯一决定徽章颜色与排序） |
| **B. 六维评分 `score_reasons_json`** | `agent-runner.ts:66 SCORE_CRITERIA_RECORD` `planning.ts:6 SCORE_CRITERIA` `zhihu-hot-scoring.ts:ZHIHU_SCORING_DIMENSION_CAPS` | `evidence_coverage 25 + timeliness 20 + audience_fit 20 + angle_novelty 15 + effort_feasibility 15 + compliance 5 = 100` | 证据覆盖/时效/受众匹配/角度新颖/可执行性/合规；要求 `status=scored` 且 6 项权重精确 | `{"status":"pending","score":0,"reasons":[]}` | **否**（全 pending，故显示 `—`） |
| **C. 知乎 Stage C 衍生分** | `daily-content-cycle.ts / zhihu-hot-scoring.ts` | `audienceFit 25 … executionCost 5` | 仅用于知乎热榜选题的 `daily_content_targets.score_snapshot_json`，与 `plan_items` 完全隔离 | 与本 5 题无关 | 否 |

### 4.2 为何 `SSS` 不代表传播质量

1. **权重里没有传播**：A 体系的 6 维无 `virality/shareability/tension/curiosity_gap/ctr`；`angle_novelty 15` 最接近，但被定义为“与身份/历史/库存的具体关系”而非外部传播张力。B 体系（知乎）同样无传播维。
2. **分数被绕过**：`planning.ts:52 scoredJsonForItem` 对无 `scoreReasons` 的条目返回 `pending + planning_status=draft`；`daily_judge` 产出的 5 题恰好未携带 `scoreReasons`（`agent-runner.ts:118 scoreReasons optional`），故全部 `pending` 却仍以 `priority` 决定 `SSS`。真正要求 `scored` 的校验仅在 `planning-stage.ts:120 submitPlanItemForReview` 修订流中生效，不作用于 `daily_judge` 直写路径。
3. **UI 双轨割裂**：同一行上 `opp-grade data-grade=SSS` 与 `评分：待补证据（—）`（`proposal-ledger.ts:98 formatScoreDisplay` 对 `draft` 恒 pending）并存；用户记忆锚点是金色 `SSS`，理性锚点是 `—`，前者胜出形成幻觉。
4. **时效被治理化**：`timeliness` 字段在 5 题中为 `本周/热点2-3天/长期/持续多日`，但 `ferment.ts:80 classifyTimeliness` 将其转为 `breaking 24h / hot 72h / evergreen` 的生命周期窗口，用于 `work_carry_items.expiresAt` 与池过期，而非传播窗口的紧迫性排序。

> 结论：`SSS/S/A/B` 是**工程治理优先级的整数映射**，不是任何可证伪的传播质量分；本案“SSS 的评测题”若按传播标准重评，时效与受众收益均不满足 SSS 的“突发特别重大”定义。

---

## 5 根因树（可证伪·主因/辅因/已排除）

```
[可观测症状]
  2026-08-25 5题标题均为谨慎型治理教训（“先…再…/为什么还不能…”的慢思考句式）
        │
        ├─── 数据/输入偏置 ────────────────┐
        │    60条增量≈100% 研究补料                │  ★辅因（必要非充分）
        │    X List 热张力帖 0 被选用              │
        │    证据地位：source_items:categories     │
        ├─── 提示词/目标偏置 ─────────────┤
        │    正式目标=AI×商业化成长的可验收项目  │  ★主因
        │    四问+五维+六栏目 奖励 治理/验证      │
        │    opportunity-standard.md 四问过滤      │
        │    证据地位：agent-runner.ts:385 line   │
        ├─── 评分体系偏置 ────────────────┤
        │    6维无传播维；score pending 绕过      │  ★主因（与上并列）
        │    priority 主观等级决定 SSS            │
        │    证据地位：planning.ts:52 /           │
        │              ledger.ts:98               │
        ├─── 编排失效 ──────────────────┤
        │    daily_judge 直写 draft+current=1     │  ★辅因（放大器）
        │    Stage C 需“已评分才能 approved”被跳过 │
        │    filterApprovedItems 本应归零但池绕过  │
        │    证据地位：agent_tasks:856e3e17       │
        └─── UI 幻觉 ─────────────────┘
             priorityGrade 0→SSS 金色             │  ★辅因（呈现层）
             分数“—”却金色置顶  误导传播解读      │
             证据地位：today-view-parts.tsx:163   │

[非主因·已用证据排除]
  × 去重/多样性逻辑：fingerprintPlanItem + mergeSimilarCarryItems 未触发误杀；5题标题 bigram 无重叠
  × 随机采样/模型发散：本轮 gpt-5.6-luna medium 单次确定性 JSON 输出，无重试择优
  × 源资料缺链：5题22个URL 均 canonicallink 非空，WMB-4931 校验通过
  × 时区/窗口错配：plan_date 与 Shanghai 日界一致，dayStart/dayEnd 换算正确
```

### 5.1 逐因证据与证伪点

| 分支 | 证据（文件:行 / DB） | 为何导致“安全偏” | 如何证伪 |
|---|---|---|---|
| **A 数据输入** | `editorial-brief.ts:168 incrementRows queries` / `source_items(2026-08-25):categories_json` / `agent_tasks:856e3e17 checkpoint.intelligenceChannels.sources ×5 @KimbomArtist` | 60 条中 VBench/论文/Cindy 文档占主导，唯一可触发传播张力的 X 线索（如热转/争议帖）数量为 0；模型只能从“能兑现四问”的研究补料中挑，因而天然偏向“评测/复跑/一致性/约束” | 抽取同水印内任意 10 条 `summary` 若出现≥3 条含 `争议/破防/爆款/涨粉/变现/踩坑` 且被判 `relevant=false`，则数据侧“无 tension 输入”被推翻 |
| **B 提示词目标** | `agent-runner.ts:387-391` 判断要求 / `skills/.../opportunity-standard.md:6 四问` / `skills/.../references/collection-sop.md:A类 must_check` | 目标函数显式要求“可执行的决策/行动 + 本人实践/案例 + 具体动作”，并以“降权：纯模型公告…否则降权或排除”过滤追热点式传播；而“让人愿意点开”仅在搜校层作为虚假事实红线，未进入排序目标 | 若 prompt 中 `判断要求` 含 `以点击率/完播率/分享率为第一排序目标`，或 `opportunity-standard` 含 `传播张力>治理正确性`，则本分支被推翻 |
| **C 评分体系** | `agent-runner.ts:66 SCORE_CRITERIA_RECORD` / `planning.ts:6 SCORE_CRITERIA` / `planning-stage.ts:66 validateScoredReasons` / `proposal-ledger.ts:98 formatScoreDisplay` | 评分未度量 `benefit/tension/shareability`；且 `daily_judge` 路径不强制 `scored`，导致 `priority` 的主观工程判断直接升格为 `SSS`，无制衡 | 若 5 题 `score_reasons_json.status=scored` 且 `reasons` 6 项完整且 `score≥75`，则“评分被绕过”被推翻 |
| **D 编排失效** | `agent_tasks:856e3e17 status=succeeded/phase=completed` / `plans:b879… is_current=1, planning_status draft ×5` / `workbench.ts:96 filterApprovedItems` | 正确语义下 `Today opportunities.value` 应为 `0`（`getTodayOverviewMetrics` 以 `planning_status='approved'` 计数），但提案池绕过滤镜后仍以 `priority` 展示，造成“今日有 5 个 SSS-S-B 待做”的误读 | 若 `plan_items` 5 行 `planning_status=approved`，或 `workbench.getToday` 未过滤而是全量透传，则编排失效不成立 |
| **E UI 幻觉** | `today-view-parts.tsx:163 priorityGrade` / `wmb-field-map.md:28` / `today-view.tsx:96-120 displayItems` | 金色 `SSS` 的视觉权重（扫光、红/A 蓝/B）属于强信号；分数 `—` 属于弱文本信号；双轨并存时用户自然以颜色定重要性，误将“工程 SSS”读作“传播 SSS” | 若 `priorityGrade` 实际读 `score.total` 阈值映射，则幻觉不成立 |

---

## 6 自媒体传播目标在哪里缺席或被忽略

> 对照 `opportunity-standard.md` 的四问与 WMB “内容梯子”：宽情绪/问题入口 → 经典方法 → 真实项目/案例 → 转化。传播质量要求“先让人愿意点开，再让人承认没被骗”；本案后半句被极致执行，前半句被牺牲。

| 传播要件 | 标准含义 | 本案 5 题表现 | 缺席证据（标题/字段原样） | [INFERENCE] 边界说明 |
|---|---|---|---|---|
| **受众（Audience）** | 不是配方里的职业身份，而是此刻“正被什么卡住”的人 | `targetAudience` 均写成 `正在把…的人` 的身份标签，未点名具体场景卡点（例“写了 3 版方案仍被老板判‘看不出差异’”） | `#2 audience=正在尝试把浏览器 Agent…交给真实用户测试的人` — 空泛，可套任意读者 | 无读者访谈原话；`missingMaterials` 反复写“本人真实…回执”缺席，说明受众痛点无一手证据 |
| **自媒体目标（Self-media objective）** | 从流量到信任的梯子：先拿情绪/问题入口，再给方法与案例 | 5 题全部落在 `AI 实践/公开验证/产品化`，`时代认知` 仅 #2 提及，**0 题命中“个人方向/迷茫诊断”类入口**；梯子顶端直接开做，无宽入口 | `structureGuidance` 分布 `AI实战×2, 方向判断×1, AI实战×1, AI实战×1` — 无 `迷茫诊断/经典方法/项目日志` 的情绪入口骨架 | 符合 `opportunity-editor` 对“纯模型新闻降权”的执行，但牺牲了破圈入口 |
| **读者收益（Reader benefit）** | 读完今天就能做的一件事，或明天可复用的判断清单 | 角度均为 `先做一个小实验/记录…/拆出…稳定层` 的方法论，收益是“更正确的项目观”，而非“立即可得的选题/流量/转化”收益 | `angle=选一个重复任务，写10个真实样本…` — 收益滞后且需额外成本；未给 `今天发什么/怎么起标题/怎么蹭热点` | `availableMaterials` 标注“官方文档提供…结构”，`missingMaterials` 均为“本人…” — 收益依赖读者自行动手，无即时获得感 |
| **冲突张力（Tension）** | 反直觉、证据冲突、代价揭示、权威反转等让人必须点开的钩子 | 标题钩子均为温和的“别再…先…”“为什么还不能…”“真正增加的是哪些…”的**治理提醒**，无强冲突/数字/代价/反常识 | `titleGuidance` 刻意把爆点移出标题：`强调从展示转向可复跑验收的动作冲突` — 冲突被定义为“动作冲突”而非“利益/认知冲突” | 符合 `titleGuidance` 的“夸张反常识只放 guidance”约束，代价是标题失去传播张力 |
| **时效（Timeliness）** | 为何今天做比明天做值钱（窗口、代价、错过成本） | `timeliness` 为 `本周/热点2-3天/长期/持续多日`，`whyNow` 均写“XX 文档/论文共同形成了可执行流程，适合本周/长期转化为真实项目” — **无“今天不做就错过什么”的紧迫性** | `whyNow=OpenAI、LangSmith…资料共同形成了…适合本周…` / `VBench …属于长期有效的 AI 实践题` — 平铺直叙，无窗口代价 | 仅 #2 有“热点2-3天”，但 `POV` 仍为长期治理判断，未兑现热点 |
| **可分享性（Shareability）** | 是否值得转给同事/群/老板（有面子、有用、有谈资） | 5 题均为“对 AI 从业者正确但对朋友圈无谈资”的内省式建议，转发语只能是“说得很对”，而非“你看这个/我们也试试/这能解决我们…” | 全量标题无 `你/我们/今天/现在/免费/避坑/涨粉/变现` 等可分享触发词；`platforms` 含 `xiaohongshu/wechat` 但内容无小红书体感 | 受 `editorialBrief`“不承诺收入、区分流量与合格线索”牵制，主动抑制了易分享但轻承诺的选题 |

> 一句话：**读者今天点开能得到“更谨慎的工程观”，但得不到“更兴奋的行动理由或更愿意分享的谈资”**；这正好是 `opportunity-standard` 刻意选择的结果，而非偶然失误。

---

## 7 评分语义的正名 — `SSS/S/A/B` 在本案到底是什么

- **不是传播分**：`SSS` 的定义“仅突发特别重大事件，极少使用；金色扫光”在工程语境下指“评测范式从演示转向复跑”这类范式迁移；在传播语境下 `SSS` 应指“今天不发就会被抢走注意力的社会级话题” — 两者标准完全不同，却共用同一徽章。
- **不是能力分**：`score=0 pending` 证明系统尚未对“能否写好这篇”做任何证据/受众/可执行性打分；`SSS` 仅表达 planner 认为“这件事对‘AI×商业化成长’这条主线很重要”。
- **是优先级分**：`priority 0..7` 是 `dailyPrompt` 要求模型自判的**工作排序优先级**，数值越小越先做；它决定 `SSS→F` 的颜色与上下顺序，**不决定它是否值得读者今天阅读**。
- **传播侧的正确读法**：若要把 5 题翻译成传播质量，它们应被读作 `B~C 级治理选题`（对从业者有长期价值，但热点与分享阈值均未达到），而非 `SSS~B`。
- **歧义的根**：`src/renderer/today-view-parts.tsx:163` 与 `src/main/planning.ts:98` 的整数排序、`skills/.../wmb-field-map.md:28` 的 `0=SSS …` 映射，以及 `src/renderer/proposal-ledger.ts:98` 的 `— / 待补证据` 三者在同一行共存，却无任何“此 SSS 仅代表工程优先级，不代表传播推荐”的 UI 免责声明。

---

## 8 最小修复边界 — 仅诊断，不改代码/库/候选/任务状态

> 按合同：诊断止于“哪里动手能以最小代价证伪/校正本案偏置”，不执行修复，不改 `src/main` / `src/renderer` / 提示词 / DB / 候选 / 任务状态。

### 8.1 边界 1 — 评分：让传播质量可被度量（不改则 SSS 永为幻觉）

- **动**：在不改变 6 维总分 100 的前提下，将 `SCORE_CRITERIA_RECORD` 中 `angle_novelty 15` 或新增 `propagation_tension 10` 的定义，从“与身份/库存的关系”改写为**外部传播张力**（好奇缺口/利益冲突/可分享触发词覆盖率/评论诱因），并在 `planning-stage.ts:66 validateScoredReasons` 中要求 `score_reasons.reasons` 对该维给出**外部证据句**（非自指）。
- **不动**：不改 `priority` 整数本身；`priority` 保留为工作优先级，`score.total` 才作为传播侧 `SSS` 的阈值。
- **验收**：重跑 `2026-08-25` 的 5 题 `score_reasons_json` 若进入 `scored`，其 `propagation_tension ≤5/15` 应可直接解释为何它们不应为 `SSS/S`。

### 8.2 边界 2 — 提示词：把“可分享”写进排序目标（不改则数据再多仍产治理题）

- **动**：仅改 `src/main/agent-runner.ts:354 dailyPrompt` 的 `判断要求 2` 与 `3`：在“四问”中增设**第五问“为什么值得读者现在转发/收藏/评论”**，并将 `opportunity-standard.md:4` 的“今天做是否比以后做更有价值”显式拆为**对作者的窗口价值 vs 对读者的转发价值**；将“夸张反常识只放 titleGuidance”的禁令，改写为**标题必须包含一个可被正文兑现的利益/冲突钩子**（数字/对比/反转/代价四选一）。
- **不动**：不改 `A类 must_check` 全量与 `wmb_get_knowledge_context` 禁调 `wmb_get_workbench` 的上下文纪律；不改 `laneGate` 的赛道定义。
- **验收**：同增量重跑时，至少应出现 1 条含 `你/我们/避坑/省 X 小时/多赚/少踩` 的候选标题，否则视为目标仍未对齐传播。

### 8.3 边界 3 — 输入：给增量注入可传播信号（不改则巧妇难为）

- **动**：将 `404` 的 `x_lists` 通道从单一 `@KimbomArtist/AI前沿` 扩展为**至少 2 个张力信号源**（例：X 热转/争议帖 + 小红书需求原话 + 知乎“普通人怎样用好 DeepSeek?”类真实提问），并在 `assembleEditorialBrief` 的 `increment` 块中对 `collected_at` 降序截断前，**先按 `signal_only` 信号做 10 条保底注入**，而非纯时间截断。
- **不动**：不改 `source-index.json` 的 `trust_level` 分级；`signal_only` 仍不作为 `primary` 事实源，仅作选题钩子。
- **验收**：同水印内 60 条中 `signal_only` 占比从 `≈0%` 升至 `≥15%`，且至少 1 条进入最终方案的 `source_ids_json`。

### 8.4 边界 4 — 编排/UI：让“未评分 SSS”不可被误读（不改则幻觉永存）

- **动**：将 `src/renderer/today-view-parts.tsx:163 priorityGrade` 的展示，从**单一 `priority→SSS` 徽章**改为**双徽章**（`工程优先级 SSS` + `传播评分 —/待补证据`），并在 `today-view.tsx:96 filterApprovedItems` 的 `Today` 真列表中，对 `draft` 项以“待评分草案·不计入今日机会”的置灰态展示，而非与 `approved` 同权置顶。
- **不动**：不改 `plans.is_current` 的写入时序；不改 `work_carry` 的过期/复活逻辑。
- **验收**：`getTodayOverviewMetrics` 的 `opportunities.value` 与 `todayItems.length` 同时为 `0` 时，`Today` 页首屏“今日机会”卡片显示 `— / 尚无已评分机会`，而非 5 个金色 `SSS` 占位。

> 以上四边界任一落地即可使本案症状消失；四者齐落可使“工程正确性”与“传播有效性”首次可被分别度量、分别排序、分别证伪。

---

## 9 证据清单（可一键复核）

| 证据类 | 路径 / 查询 | 要点 |
|---|---|---|
| 任务 | `agent_tasks id=856e3e17-b193-4c31-9ff9-1376f0681b45` | `intent daily_judge, business_date 2026-08-25, status succeeded/phase completed, pi_session daily-2026-08-25-856e3e17…` |
| 会话 | `J:\PigeonYang\WeMediaBuddyData\pi-agent\sessions\daily-2026-08-25-856e3e17-b193-4c31-9ff9-1376f0681b45.jsonl` | 第 4 行 `user` 含完整 `【编辑简报】` + 末尾 `assistant` 含首个 `gate` + 第二个 `plan` 两个 ```json 块；`wmb_save_plan ok:true` |
| 方案 | `plans id=b8796009-6fc5-46be-9c1e-8630cd4011e3 is_current=1` | `summary` 前述；`updated 2026-08-25T03:48:00.136Z` |
| 条目 | `plan_items plan_id=b879… sort_order 0..4` | 标题/优先级/状态/分数见 §3；`score_reasons_json pending` ×5 |
| 资料 | `source_items id in (b55c0…ff)` ×22 | `canonical_url` 非空，`categories=["研究补料"]`，`verification_status pending` |
| 提示词 | `src/main/agent-runner.ts:354 dailyPrompt` `src/main/agent-runner.ts:387-391` | 四问+五维+优先级 0=SSS 定义 |
| 标准 | `skills/wemedia-intelligence-engine/references/opportunity-standard.md` | 四问、标题三切口、`evidence = 真实来源+主编实践+具体动作` |
| 映射 | `skills/.../references/wmb-field-map.md:28` `src/renderer/today-view-parts.tsx:163` | `priority→SSS` 映射与样式 |
| 落库 | `src/main/planning.ts:88 saveCurrentPlan` `src/main/agent-runner.ts:540 savePlanFromSynthesisOutput` | `pending→draft` 仍可 `is_current=1` |
| 投射 | `src/main/workbench.ts:410 getToday` `src/renderer/today-view.tsx:96` `src/renderer/proposal-ledger.ts:168 filterApprovedItems` | `draft` 不计入 Today，池绕过则可见 |
| 分数 | `src/renderer/proposal-ledger.ts:98 formatScoreDisplay` | `draft → — / 待补证据` 恒定 |
| 通道 | `src/main/editorial-brief.ts:103 assembleEditorialBrief` | 增量 `LIMIT 60` 时间截断，无传播保底 |

---

## 10 方法说明与局限

- **只读**：全程 `DatabaseSync readOnly` + 文件只读，未执行 `scripts/*` / 扫描 / 任务重跑 / 状态变更；Pi 会话仅读取已落盘 `jsonl`。
- **时间盒**：15 分钟内完成；增量 60 条全文未全部逐条精读，采用分层抽样 + 首尾锚定（首条 Gemini Computer Use，尾条含 GOV.UK/SSPai 等），已满足五题溯源的最小充分证据。
- **未触及**：`zhihu_hot` 衍生分与 `daily_content_targets.score_snapshot_json` 属另一赛道（知乎热榜），与本 5 题无关；`topic_maintenance / fermenting` 的跨日复活逻辑在本案 5 题上均未触发（`topicId` 为新建或空）。

---

## 11 终态自检

- [x] 报告已落盘 `docs/audits/2026-08-25-topic-selection-safe-bias-audit.md` 并可被 `read` 回读（本文件即读回源）
- [x] 五题均锚定 `plan_id / planItemId / sourceIds / priority→grade / planning_status / score_reasons_json pending` 三重证据
- [x] `SSS/S/A/B` 被正名为**治理优先级**而非传播质量，且给出 UI 双徽章的最小修复边界
- [x] 受众/目标/收益/张力/时效/可分享性 的缺席逐项点名并给出原文证据
- [x] 根因树主因/辅因/已排除均给出可证伪条件，无无源推断（需推断处已标 `[INFERENCE]` 且未作为证伪依据）

> 下一步仅当 owner 要求时执行：按 §8 四边界择一落地并重跑 `2026-08-25` 的 `daily_judge` 做 A/B 对照；否则本审计即为终态。

