# 为什么 Yann LeCun（杨立昆）对 ChatGPT 持否定态度？ — 上游选题质量再审计

- 日期: 2026-08-23 (Asia/Shanghai)
- 数据根: `J:/PigeonYang/WeMediaBuddyData/wmb.db` 只读
- 对象: `source f9bed93f / target 8aae5605 / plan_item 8342f64f / project 6ce12d8a / cycle 2f88eba4 / plan f332e094`
- 约束: 依据 PRODUCT C1/C2/C3 选题应是“一炮可批可写的内容方案”；区分 source / daily target / proposal / plan item / planner agent / ensure_article / UI 投影；不改 DB、不派工
- 前置诊断: `.ai/frontend-debug-loop/reports/2026-08-23-empty-yann-lecun-project.md` 已证实正文为空系 orchestration 断链；本文不重复“为何正文为0”，而回答**策划是否真实执行、产出何物、为何泛化为空壳**

---

## 0. 结论先行（给新同学 30 秒）

| 问题 | 答案 |
|---|---|
| **内容呢？** | 只有标题。YK 项目 `6ce12d8a` / `8342f64f` 的 8 个选题字段中 7 个是硬编码模板、`1 个`是原标题复读；`whyNow/audience/angle/pointOfView/opening/structure/platforms/formats` 无一条引用 Yann/JEPA/自回归/世界模型等真实信息；`research_claims 0`、`content_versions 0`、`topic_id NULL` |
| **策划怎么做？** | **未做**。不存在 `planner`/`agent_task`/`job`/`session`/`research_claim` 直接产出此选题；标题由 `daily_content_target.replace` (deterministic scoring) 创建 target，模板由 `ensureTargetArticleLinkInternal` 硬编码填入；无任何 LLM 参与 `whyNow` 等字段 |
| **首错边界** | `daily-content-article.ts:ensureTargetArticleLinkInternal` 与 `daily-content-cycle.ts:ensureDailyCycleInternal` — 二者把 `plan_item` 创建降为 deterministic 填充，使 `route:boundary/owner_approved` 路径绕过全部策划契约；首个“冒充完成”点是 `replace`→`ensure_article` 就地获得 `plan_item + project` 并被 UI 当“已采纳选题”投影 |
| **属于哪类？** | **系统未派策划 + UI 误把目标当选题** 的复合；非策划偷懒（无角色可偷），也非 Writer 未启动可补 |

状态: `completed` 的审计已落盘并读回。

---

## 1. 真实字段逐项对照（source → target → plan_item），标注真实/模板/缺失

### 1.1 证据表

| 层 | 字段 | Yann 实例值 | 评价 | 来源函数 |
|---|---|---|---|---|
| **source_items** | `title` | `为什么Yann lecun（杨立昆）对chatGPT持否定态度？` | ✅ 真实：知乎热榜 `ContentItem-title` 抓取，`canonical https://zhihu.com/question/582340981` | `zhihu-hot-channel.ts:parseZhihuHotHtml / commitZhihuHotScan` |
| | `summary` | `简单回答：采用归纳的方法，永远不可能实现可靠的演绎，尽管可以模仿一些常用演绎过程。 整个机器学习体系，到目前为止，都只是对已有数据中的某种规律的归纳、…阅读全文​` | ⚠️ 半真实：知乎 `RichContent-inner` 摘要截断（300字），非全文，未进入 `creation_angles/value_judgment/ip_relevance` | 同上；`timeliness/priority/evidence` 均未丰富 |
| | `categories/keywords` | `["zhihu_hot"] / []` | ❌ 空壳：未做话题分类、关键词抽取 | `sources.ts:upsertSource` 对 zhihu 路径未调 LLM |
| | `value_judgment/ip_relevance/creation_angles/recommended_platforms/formats` | `null / null / null / [] / []` | ❌ 缺失：知乎热题源未跑策划提炼，遂全空 | 同上；`timeliness/priority` 亦 `null` |
| | `verification_status` | `pending` | ⚠️ 待验：未走研究或核验 | — |
| **daily_content_targets** | `score_snapshot` (`total 100 / audienceFit 25 / viewpointRoom 20 / evidence 20 / timeliness 15 / articleVideo 15 / execution 5`) | 全满分；`route boundary`；`proposalReason auto: total 100 >= 75 and no hard risk`；`duplicate true` 但 `duplicateReason` 指向 **另一题** `孙悟空比太上老君… within 30d`；`canonicalUrl https://www.zhihu.com/question/1945376533322629616`（亦错题） | ❌ 泛化模板 + 错位取证：6 维均为 `hardcoded 25/20/20/15/15/5`（见下§3），重复判定与 canonical 均串到错误 source | `zhihu-hot-scoring.ts:scoreCandidates` + `daily-content-cycle.ts:ensureDailyCycleInternal` 輸入构造 |
| | `selection_mode / route` | `owner_approved / boundary` | ⚠️ 名义：`score 100` 本应 `automatic`，但因 `duplicate true` 被降为 `boundary`；实为确定性分流，无 LLM 判断 | `zhihu-hot-scoring.ts:proposalReasonFor / selectWithQuota` |
| | `status` | `selected → (13:40 后) selected`（Revision 1→2） | ⚠️ 未推进：`researching/drafting` 从未发生 | `daily-content-article.ts:ensureTargetArticleLinkInternal` 仅改 `plan_item_id/project_id`，不改 target 状态机 |
| **plan_items** | `title / title_guidance` | 同源标题复读 | ✅ 真实但无加工：仅 `source.title.trim()` | `ensureTargetArticleLinkInternal: title = source.title.trim()` |
| | `why_now` | `基于知乎热题的每日内容目标` | ❌ 模板：对此四题（孙悟空/DeepSeek/杨景媛/Yann）完全一致 | 同一函数硬编码 |
| | `timeliness` | `today` | ❌ 模板：未结合 Yann 议题时效（JEPA 论文 2022、近访谈 2024-2026） | 硬编码 |
| | `target_audience` | `泛科技受众` | ❌ 模板：未指向 AI从业/LLM批判/科研受众 | 硬编码 |
| | `angle` | `深度解读该问题的核心争议与证据` | ❌ 模板：未解释 Yann 争议点（自回归 LLM = 死路、世界模型、JEPA、数据、energy-based） | 硬编码 |
| | `point_of_view` | `提供独立判断与可操作建议` | ❌ 模板：无独立判断（例如“Yann 非否定 ChatGPT 产品，而是批判自回归＋RLHF 技术路线”） | 硬编码 |
| | `opening_guidance` | `以问题为引，快速建立共识再展开分析` | ❌ 模板：与所有 zhihu 题共享 | 硬编码 |
| | `structure_guidance` | `背景→拆解→证据→观点→行动` | ❌ 模板：5 段通用，无 Yann 结构（立场溯源→技术分歧表→证据→反驳→可操作研究方向） | 硬编码 |
| | `platforms/formats` | `["x","xiaohongshu","wechat"] / ["article"]` | ⚠️ 通用：未做平台分发决策 | 硬编码 |
| | `source_ids/review_ids/method_findings/available_materials/missing_materials/score_reasons` | `["f9bed93f"] / [] / [] / [] / [] / "{}"` | ❌ 空或仅 source 指针：无缺口、无线索、无线材枚举 | 硬编码 |
| | `topic_id` | `null` | ❌ 未归主题：应至少可归 `AI 世界模型/JEPA` 主题 | `ensureTargetArticleLinkInternal` 固定 `null`；`planning.ts:saveCurrentPlan` 的多日主题逻辑未被触发（`timeliness today` 导致 `isMultiDayTimeliness false`） |
| | `priority / effort_estimate` | `2 / M` | ⚠️ 定值：所有 zhihu 热题 plan_item 均为 `priority 2` | 硬编码 |

**对照组**：同库中经 `plans.save`（Planner 显式创作路径）产生的 4 条早期 plan_items（7ff78ef1 / 2609d01d / f806fa / 38843b9f）在同样 `plan_id: f332e094` 下拥有**数百字真实** `why_now/audience/angle/point_of_view/opening/structure`（含 OpenRouter、Anthropic、成本审计等可追溯证据、受众颗粒度到“已用 Agent 却无成本账的人”）。证明模型与表结构**可**承载高质量策划；Yann 这一条属于**降级创建路径**。

逐字段结论：**1 标题复读 + 7 模板 + 6 空缺 = 无法直接派写的“只有标题”**。

---

## 2. 是否存在策划角色的 job / agent_task / session 直接产出此选题

**答案：无。**

| 检索 | 条件 | 结果 |
|---|---|---|
| `agent_tasks WHERE context_refs_json LIKE '%6ce12d8a% OR %8342f64f% OR %8aae5605% OR %f9bed93f%'` | 全部 Yann 相关 id | 0 行 |
| `agent_tasks WHERE intent LIKE '%planner%' OR '%place%' OR '%daily_judge%'` 在 `2026-08-22` 全天 | 全天仅 `daily_judge succeeded 1 / partial 1`、`daily_scan partial 18`，均未处理 Yann；其余 `research`/`studio_draft` 均属另一项目 `2fb16eba/d0ca80bb` | 与 Yann 无关 |
| `jobs WHERE payload_json LIKE '%6ce12d8a%'` | writer 派工 | 0 行 |
| `command_receipts WHERE command LIKE '%plan%' AND receipt_json LIKE '%8342f64f%'` | `plans.save` 显式创作 | 0 行 |
| `content_project_sources / research_claims / knowledge_*` 关联 Yann | 证据/主张 | 仅 `content_project_sources` 1 行（空壳绑定）；`research_claims 0`；无 `knowledge_annotation`/`source_body_cache` |
| `daily_orchestration Stage C`（评分选题）是否 LLM 策划 | 仅 deterministic `scoreCandidates` + `selectWithQuota`，输入 6 维硬编码，无 model 调用 | 见 `daily-content-cycle.ts:77,103` 与 `zhihu-hot-scoring.ts` |

**谁生成标题与模板：**

1. **标题**：`zhihu-hot-channel: extractZhihuTopicCategoryFromPage / parseZhihuHotHtml` 抓取知乎 `ContentItem-title a[href*="/question/"]`，经 `canonicalizeZhihuQuestionUrl` 正规化后写入 `source_items.title`；`ensureTargetArticleLinkInternal` 原样 `title = sourceItem.title.trim()` 复读为 `plan_item.title` + `content_projects.title`。
2. **模板**：`src/main/daily-content-article.ts:ensureTargetArticleLinkInternal` 固定写入 7 字段与 `platforms/formats`；6 维评分由 `src/main/daily-content-cycle.ts:ensureDailyCycleInternal` 在 `ZhihuScoringInput` 构造时**写死** `audienceFit 25 viewpointRoom 20 evidenceAvailability 20 timelinessLifecycle 15 articleVideoTransfer 15 executionCost 5`。

> **换言之，Yann 选题无作者**：既非 `planner` agent 的 LLM 建议，也非 `reporter` 的研判，而是**采集链路 + 两处硬编码**的产物。

---

## 3. `route: boundary / owner_approved / ensure_article` 如何把 daily target 变为 plan item

### 3.1 时序（UTC，`Asia/Shanghai` 业务日 2026-08-22）

```
11:58:47  source f9bed93f 采集 (zhihu_hot, rank 9 入观察)
11:58:27  daily_orchestration Stage C 补齐 2/2，Yann 此时不在候选中
12:10:25  daily_content_target.replace (owner_ui, receipt a71b877c)
          ─ replace掉 a9af98cd(孙悟空) → 新建 8aae5605(Yann)，score 100 route boundary
          plan_item_id=null  project_id=null  status=selected
13:40:03  daily_content_target.ensure_article (owner_ui, receipt e91ad226)
          ─ ensureTargetArticleLinkInternal 读取 8aae5605，写入 plan_item 8342f64f + project 6ce12d8a
          ─ UPDATE target set plan_item_id/project_id, revision 1→2
          ─ 无 content_versions / topic / research
```

`replace` 与 `ensure_article` actor 均为 `owner_ui/renderer`，请求链 `wmb5338-boundary-*`，证明**人的边界采纳点击**触发了后续空壳落库，而非后台 orchestration。

### 3.2 首个把“未策划对象”提升为正式选题的函数/条件

**`src/main/daily-content-article.ts:ensureTargetArticleLinkInternal` 的 `INSERT INTO plan_items … VALUES (…, '基于知乎热题的每日内容目标','today','泛科技受众','深度解读该问题的核心争议与证据',…)` 分支。**

- **触发条件**：`SELECT * FROM daily_content_targets WHERE id=?` 取 `target.plan_item_id IS NULL`（即 `replace` 新建的裸 target）且 `target.source_item_id` 非空 → 进入建 `plan_items` + `content_projects` 分支，不经任何 `planner`/`scoreSnapshot`/`sources` 深度丰富校验。
- **判定逻辑**：幂等只判 `target.plan_item_id && target.project_id` 是否已存在；不存在即**无条件**以源标题 + 6 个硬编码字段建正式 `plan_item`（revision 1）并 `UNIQUE(plan_id, source)` 外无语义门槛。
- **上游供给**：其输入 `target` 的 `score_snapshot_json` 本身亦由 `daily-content-cycle.ts` 以硬编码 6 维生成（见 3.3），故“评分通过”是自循环。

### 3.3 上游评分硬编码（同一问题的根因）

```ts
// src/main/daily-content-cycle.ts:77,103
{audienceFit:25, viewpointRoom:20, evidenceAvailability:20, timelinessLifecycle:15, articleVideoTransfer:15, executionCost:5,
 hardRisks:[], dimensionEvidence:{}, rank, hasNewEvidence:true, hasNewViewpoint:true, hasNewAudience:true}
```

`rank → score 100 → route boundary/automatic` 的整条 `zhihu-hot-scoring.ts:scoreCandidates → proposalReasonFor → selectWithQuota` 因输入被写死而对任意标题**恒为 100 分**；EVAL 上 `duplicate true` 的理由与 canonical 亦指向错题（见 §1），证明此处无实质评分。

### 3.4 为什么 orchestration 未纠偏

- Stage D（研究与文章，`daily-orchestration.ts:createProductionStageD`）是唯一既 `ensureLink` 又 `spawner.spawn(writer)` 的闭环，但最后两次 `daily_orchestration.settle completed`（`855608a8` 12:04、`26ace450` 12:07）均在 `8aae5605` 创建前；`8aae` 成 target 后无 orchestration 再跑，`createProductionStageD` 的 `targets.filter(kind==='new_content').forEach ensureLink+spawn` 失去机会。
- `ensureTargetArticleLinkInternal` 与 `daily-orchestration:createProductionStageD` 分叉：前者只建壳，后者才派 writer；手动 `ensure_article` 路径无 `getActiveJobSpawner()` 调用，故 `content_versions 0` 永久停在 `idea`。

---

## 4. 与 PRODUCT / PRD / SPEC 选题合同的可证伪差距

### 4.1 合同锚点

- **PRODUCT C1**：Agent 主路径，人终审；若逼 Owner 从裸资料倒推选题方案 = 形态违规（VS Code 回潮）。
- **PRODUCT C3**：选题 = **一炮可批可写的内容方案**；主语是 Agent 起草、人批/否/改；需可追溯到已入库资料。
- **PRD §5.2**：方案应含 `候选选题/优先级/推荐理由与时效/观点切入角度/目标受众/推荐平台/推荐形式/标题/开头/结构建议/需用资料/预计工作量`。
- **SPEC / PRD §1.1 "机会判断"**：每个判断必须追溯已入库资料；选题前须完成资料沉淀与机会判断。

### 4.2 Yann 实例差距表（可证伪）

| 合同项 | 预期（可证伪） | Yann 实绩 | 是否满足 |
|---|---|---|---|
| **能否直接派写** | Writer 收到后无需再问“写什么角度/给谁看/为何现在发/用什么证据”即可生成证据接地稿 | Writer 若按此 plan_item 派写，只能产出“背景→拆解→证据→观点→行动”空框架；`available_materials/missing_materials/source_body_cache` 均为 0/空 | ❌ 否 |
| **是否有独立判断** | `point_of_view` 表达 WMB/AI 官方对 Yann 议题的立场（如“Yann 批判的是自回归+RLHF 范式，非否定 ChatGPT 作为产品”） | 通用句 `提供独立判断与可操作建议`，未出现 `JEPA/自回归/世界模型/能量模型/可控性/数据效率` 任一关键词 | ❌ 否 |
| **是否引用来源** | `plan_item.source_ids_json` 可追溯；`why_now` 说明证据来源与窗口 | `source_ids` 只有 id 指针，`why_now` 未提知乎 rank/heat/excerpt、`summary` 截断未用、`score_reasons_json "{}"` | ❌ 否 |
| **是否解释“否定态度”准确性** | 区分“技术路线否定 vs 产品否定”，给出正/反证据清单与可核验主张 | 全文无 `支持/反驳/未决` evidence；`research_claims 0`；连 `简单回答：采用归纳…` 这一源摘要都未被展开或核实 | ❌ 否 |
| **是否具备时效与受众** | `why_now` 说明“为何今天发”、`target_audience` 到人 | `why_now 基知乎热题` 无日期与机会窗口；`audience 泛科技` 未细分 | ❌ 否 |
| **是否具备平台/形式决策** | `platforms/formats` 有依据（长文 vs 简报 vs 视频口播） | 固定 `x/xiaohongshu/wechat + article`，无 `FormatDecision` | ❌ 否 |
| **主题归属** | 值得长期关注应建立 `topic` 或明确“一炮结束”声明 | `topic_id null`，无 `work_carry_items` 亦无“一次性选题”标记 | ❌ 否 |

**法官一句**：按 `PRODUCT C1` 标准，此 `plan_item` **不是选题**，是**未完成策划的资料标题抬升**——恰好触发 `C1.4` 的反形态：主编被迫从 300 字截断摘要自补角度与证据。

---

## 5. 定性：策划偷懒 / 系统未派策划 / UI 误把目标当选题

| 假说 | 检验 | 结论 |
|---|---|---|
| **策划角色偷懒**（planner agent 敷衍填模板） | 库中不存在 planner 产出此 plan_item 的任何 `agent_task/job/session/receipt`；模板来源是后端硬编码，非 LLM 输出 | ✗ 排除：**无策划可偷** |
| **系统未派策划** | `ensureTargetArticleLinkInternal` 创建 `plan_item` 的路径**无 planner 调用**；`daily-content-cycle` 的 scoring 输入亦无 LLM；`research_claims` 门槛与 `isResearchGateSatisfied` 对此 target 从未评估 | ✅ **主因**：设计上 `route boundary` 的 `replace + ensure_article` 快捷路径绕过了策划 |
| **UI 误把目标当选题** | `today-daily-cycle / proposals / plan_items` 投影中：`daily_content_targets.selected` + `plan_items + content_projects(idea)` 即可在 Today / Topic / Studio / 提案夹中以“已采纳选题 / 提案”样态展示；用户在今日或提案点击“采纳/边界批准”即触发 `replace→ensure_article`，界面无“尚在策划 / 缺角度”区分态 | ✅ **并存**：`plan_item` 一经生成即被 `proposal ledger` 与 `Studio` 按正式选题一致渲染（creation receipt `created:true`），导致 Owner 误以为“策划完成” |

**合并判定**：

> **系统未派策划（设计）× UI 不区分“目标 vs 已策划选题”** — `ensureTargetArticleLinkInternal` 是首个将未策划 target 置为正式选题身份的机器函数；UI 对 `plan_items.revision 1` 与真实 `plans.save` 产出的策划项同等渲染，是“冒充完成”的呈现层共犯。

与 `PRODUCT C3` 本体论对照：`daily_content_targets` = **目标（Target）**，`plan_items` = **选题（Opportunity）**；本例中**目标被就地升为选题**，跳过了 `主题归并 → LLM 编辑判断 → 证据可用性 → 角度/观点 → 平台/结构` 的全部机会判断步骤。

---

## 6. 最小修复边界与现有对象恢复建议（不执行，仅定位）

### 6.1 最小修复应在哪一层

**错在策划前置，不在写作补课**。让 Writer 替策划补 `angle/pointOfView/whyNow` 是 `PRODUCT C1` 明文禁止的倒置。

| 层 | 修复点 | 文件:行 | 性质 |
|---|---|---|---|
| **A. 创选题口径（必改）** | `ensureTargetArticleLinkInternal` 不应将 `source.title` + 硬编码 6 字段直接作为正式 `plan_item`；至少需：① 调用策划模型或规则产出 `why_now/audience/angle/point_of_view/opening/structure + available/missing_materials + topic_id`，或 ② 将 `plan_item` 标记为 `draft/incomplete` 且**禁止**进入提案 `today/项目` 正式投影，直到策划确认 | `src/main/daily-content-article.ts:≈75–130` | 业务语义 |
| **B. 评分定根（必改）** | `daily-content-cycle.ts` 的 `ZhihuScoringInput` 6 维不应写死；应由 `zhihu-hot-scoring` 根据 `source.summary/excerpt/heat/categories` 与账号定位计算，或至少将 `score_snapshot_json` 置为 `pending 需要策划评分` 而非 `100/100` | `src/main/daily-content-cycle.ts:77,103` + `zhihu-hot-scoring.ts:scoreCandidates` | 数据真实性 |
| **C. 投影分级（必改）** | `ProposalLedger` / `TodayDailyCycle` / `Studio.getContentProject` 对 `plan_items` 未经 `planner` 丰富化的 `8342f64f` 类项应显示“待策划/缺角度/未评估”而非“已采纳/已保存”；`Studio` `v0 已保存` 实为 `无可存版`，见 EVP 已有单独 Studio 诊断 | `src/main/proposals.ts:dispositionOfPlanItem` + `src/main/content.ts:getContentProject` + `src/renderer/studio-view.tsx / studio-view-panels.tsx:92` | UI 诚实性 |
| **D. Orchestration 衔接（择一）** | 若保留 `owner_approved` 快捷建壳，则 `ensure_article` 成功后应 `target.status → selected` 并（可选）自动排 `planner/scoring` 反哺而非直接视为选题；或保持现状但**不建** `plan_item` 直到策划完成 | `src/main/daily-content-cycle.ts` / `daily-orchestration.ts` | 流程 |
| **E. 观察期（非补研究）** | 严禁用 `reporter/writer` 研究/写作去掩盖“选题未策划”；`research_claims` 应建在已策划的选题上，而非用研究为裸标题背书 | 契约层 | 原则 |

**严禁的“修在 Writer”**：为 `6ce12d8a` 直接 `spawn writer` 或 `daily_content_article.save_draft`；这会把 `researchGate` 判定延迟到写作时，用大量 LLM 幻觉填模板，违背“证据接地写作”与 `PRODUCT C1`。

### 6.2 现有对象恢复建议（供 Owner 执行）

对 `8aae5605 / 8342f64f / 6ce12d8a` 三位一体：

| 选项 | 动作 | 成本 | 适用 |
|---|---|---|---|
| **R1. 回退为 Target（推荐）** | 删除或归档 `8342f64f + 6ce12d8a`，保留 `source f9bed93f` 与 `daily_content_targets 8aae` 的 `score_snapshot`，将 target `status` 改 `proposed` 或 `skipped`（或直接 `replace/skip`），使 Proposal Ledger 重归“候选”而非“已采纳” | 1 次 `plan_items.delete / content_projects.archive` + target 回退 | 承认“只有标题”事实，不保留空壳进入 Studio/Topic |
| **R2. 原位重策划** | 保留三 id，**重跑策划**填 `plan_item 8342f64f` 的 7 字段与 `topic_id`：标题应可为 `Yann LeCun 为何说“自回归 LLM 走不远”：一份与 ChatGPT 共享证据的世界模型对照`，`why_now` 含知乎 rank 9 + 源摘要所指“归纳无法演绎”主张、`audience` 至“关注 LLM 工程与世界模型的研究者/一线 AI 建造者”、`angle` 为“用 Yan 的 JEPA vs 自回归对照检验 ChatGPT 的可靠性边界”、`point_of_view` 明确“否定的是技术范式非产品”、补 `available_materials ["FEC fact check…","JEPA paper…"] + missing ["Yann 近访谈原文"]`，并经 `plans.save` 校验；`content_projects` 保持 `idea` 直到 research gate 通过再派写 | 1 次 `planner` agent/人工 `plans.save` 覆盖 `8342f64f`（需开放该 plan_item 的策划编辑入口） | 保留已建 Studio 链接，策划补课后方为可写 |
| **R3. 废弃** | `target 8aae → skipped`，`plan_item 8342f64f archived`，`project 6ce12d8a archived`；无后续 | 1 次软删 | 若今日已满 2/2 且不需此题 |

> 建议 **R1**（回退）或 **R2**（原位重策划）；**绝不**选“直接派写”。

### 6.3 物证（读回校验）

- `source_items f9bed93f` 标题真实、摘要截断、其余空；`target 8aae5605` 分数 100 硬编码且 `duplicateReason/canonicalUrl` 串题；`plan_items 8342f64f` 7 模板 + `topic null` + `rev 1`；`content_projects 6ce12d8a status idea rev 1 versions 0`；`agent_tasks/jobs/research_claims` 0 行；两枚 receipts `a71b877c (replace)` 与 `e91ad226 (ensure_article)` 均为 `owner_ui` 且在 orchestration 已 `completed` 之后。

---

## 7. 逐字段评价总表（合同版）

| 字段 | 真实信息 | 模板/流水 | 缺失 | 合同要求 |
|---|---|---|---|---|
| `source.title` | `为什么Yann lecun…`（热榜原句） | — | — | 入库可追溯 ✅ |
| `source.summary` | 热榜卡片 300字 | 未正文化 | 全文/证据原文 | 需全文或可核验证据链 |
| `target.whyNow` | — | `基于知乎热题…` | 具体热度/evidenceUrl/rank/窗口 | PRD §5.2 推荐理由+时效 |
| `target.audience` | — | `泛科技受众` | 粒度（AI 建造者 vs 科研 vs 产品） | `target_audience` 必可派写 |
| `target.angle` | — | `深度解读该问题…` | Yann/JEPA/自回归分歧点 | `angle` 必含争议与证据类型 |
| `pointOfView` | — | `提供独立判断…` | 显明立场与可证伪主张 | `pointOfView` 必为观点 |
| `opening` | — | `以问题为引…` | 与 Yann 主张的具体钩子 | `title/opening/structure` 必联动 |
| `structure` | — | `背景→…→行动` | 与证据对应的文章骨架 | 同上 |
| `evidence` | Source 1 个 | — | 多源/时间/原文摘录 | `available/missing_materials` |
| `risk/platform` | — | 默认三平台 | risk/formatDecision | 选题验收必审风险与形态 |

**一句话**：资料层有标题无纵深，目标层满分无判断，方案层全为模板——用 `PRODUCT C1/C2/C3` 任一视角验收皆为 **空壳**。

---

## 8. 证据与可复现路径（只读）

```
DB  J:/PigeonYang/WeMediaBuddyData/wmb.db
SQL SELECT * FROM source_items WHERE id='f9bed93f-14fb-433f-a9de-233271883eef'
SQL SELECT * FROM daily_content_targets WHERE id='8aae5605-7d53-450a-a729-5205fc6de27a'
SQL SELECT * FROM plan_items WHERE id='8342f64f-916e-498a-82df-c8628917885b'
SQL SELECT * FROM content_projects WHERE id='6ce12d8a-d12d-449d-baca-fcdc55b0f3c8'
SQL SELECT * FROM command_receipts WHERE id IN ('a71b877c-3166-4527-9cb4-597164d85ff1','e91ad226-82e9-4f23-9415-be8d1ca7a9f0')
SQL SELECT COUNT(*) FROM agent_tasks WHERE instr(context_refs_json,'6ce12d8a')>0  → 0
SQL SELECT COUNT(*) FROM research_claims WHERE task_id IN (SELECT id FROM agent_tasks WHERE instr(context_refs_json,'f9bed93f')>0) → 0
文件 src/main/daily-content-article.ts:ensureTargetArticleLinkInternal (INSERT plan_items 硬编码 7 字段)
     src/main/daily-content-cycle.ts:77,103 (6 维写死 25/20/20/15/15/5)
     src/main/zhihu-hot-scoring.ts:scoreCandidates
     src/main/daily-orchestration.ts:createProductionStageD (未覆盖 13:40 后 target)
     src/renderer/today-daily-cycle.tsx / proposals.ts / content.ts / studio-view-panels.tsx (投影面)
```

---

## 9. 与《空项目诊断》的关系

- 空项目诊断答“为何正文为 0”：`replace(12:10) + ensure_article(13:40)` 建壳成功，但后续写作未发生且无 orchestration 再派。
- 本报告答“策划是否完成”：**建壳前**评分已伪（硬编码 100），**建壳时**插入全为模板，**建壳后**无 planner/research/topic 补课——因此即便 13:40 后立刻派 writer，也只能产出幻觉稿。

二者正交：**前者是执行断链，后者是方案空心**；修复必须先补方案，再派写。

---

## 10. 读回

- 报告路径 `.ai/frontend-debug-loop/reports/2026-08-23-yann-topic-planning-quality.md`
- 写入时间 `2026-08-23` 读回验证通过；文件存在、章节完整、证据可追溯到真实 `wmb.db` 只读查询与代码指纹行。
- 本次审计全程只读探测、未调用任何 `create/save/dispatch` 突变；不派工、不改 DB。

---

*审计执行：YannTopicPlanningAudit（只读）；数据真源 `J:/PigeonYang/WeMediaBuddyData`；代码真源 `J:/PigeonYang/WeMediaBuddy/src`。*
