# Planning Stage 架构修复 · 完整方案

- 日期：2026-08-23
- 状态：待实施（方案冻结，可直接施工）
- 定位：WeMediaBuddy 策划阶段一等状态修复 + 评分/编排/投影一致性修复。**只新增策划状态机与最小列，不另造策划表**。
- 审计依据：
  - `.ai/frontend-debug-loop/reports/2026-08-23-empty-yann-lecun-project.md`（空 Yann 项目：project `6ce12d8a` / idea v0 / `8aae5605` 建壳成功但无 `content_versions`，`e91ad226:ensure_article` 13:40:03 仅产 `plan_item 8342f64f` + 空 project，Stage D 12:07 已完成未覆盖）
  - `.ai/frontend-debug-loop/reports/2026-08-23-yann-topic-planning-quality.md`（策划质量：后端固定写入 9 个策划字段、`topic_id null`、`score 100` 硬编码 `daily-content-cycle.ts:77,103` + `ZhihuScoringInput 25/20/20/15/15/5`，`duplicate` 串题、无 `planner agent_task/job/research_claims`，绕过策划的 `route boundary`）
- 约束来源：本方案为主架构决定忠实展开，不另造体系；支持分波并发；仅落盘方案，不改 `TASKS`/源码/其他文档。

---

## 1 Problem / Evidence

### 1.1 策划不是一等状态，无审批门

- `src/main/db/migrations.ts`（v4 建 `plan_items`，v10 增 `available_materials_json` / `missing_materials_json` / `score_reasons_json`）现状列含策划正文、来源与修订字段，但**无 `planning_status` / `planning_provenance_json`**，也无策划状态索引。
- `src/main/planning.ts:saveCurrentPlan` 直接全量插入正式 `plan_items`，调用方 `src/main/agent-runner.ts:223` 与 `command plans.save` 未区分草稿与正式。`src/main/daily-content-article.ts:ensureTargetArticleLinkInternal` 另有一条硬编码同结构插入路径，绕过 `planning.ts` 校验（审计 2 路径分叉证据）。
- `src/main/proposals.ts:getProposalLedger / dispositionOfPlanItem / buildProposalLedger` 与 `src/main/workbench.ts:getToday / getOpportunityPool / latestPlanItemRowsByDate` 将未审批项直接投影为“今日正式选题”，导致 Writer 在无策划证据下被派单。

### 1.2 评分恒 100，无证据时自动升正式选题

- `src/main/daily-content-cycle.ts:77,103` 的评分输入六维写死为满分；`src/main/zhihu-hot-scoring.ts:scoreCandidates/selectWithQuota` 因此对任意标题都得到 100，与真实 `source.summary/excerpt/heat/categories`、`available_materials_json`、`missing_materials_json` 无关。
- `src/main/zhihu-hot-channel.ts:readZhihuHotViaBrowser/commitZhihuHotScan` 与 `src/main/daily-content-cycle.ts:ensureDailyCycleInternal/getDailyCycleProjection` 在知乎模板指纹（固定 7 模板：`why_now='基于知乎热题的每日内容目标'` / `timeliness=today` / 泛科技受众/深度解读…/背景→拆解…/`platforms ["x","xiaohongshu","wechat"]`）命中时仍产 100 分并进入 `plan_items`。

### 1.3 编排与 Writer 补策划

- `src/main/daily-orchestration.ts:createProductionStageC/D/E/orchestrateDailyContent` 与 `src/main/daily-orchestration-scheduler.ts` 的 Stage C/D 在信息不足时未派 `planner`，Stage D 已 `completed` 仍被后续写入覆盖（Yann 12:07 证据）。
- `src/main/job-spawner.ts:getActiveJobSpawner` 对 `reporter/writer` 的派单未以 `missing_materials_json` 与可核验证据为分支，Writer 侧补策划导致无 `research_claims` 仍可 `finalizeTargetArticleInternal`。

### 1.4 Yann 空项目可复现

- `src/main/content.ts:getStudio/getContentProject/listContentProjects` 与 `src/main/agent-tasks.ts:project_investigations` 对 `project 6ce12d8a / plan_item 8342f64f` 返回 `versions 0 / jobs 0 / agent_tasks 0 / research_claims 0`，Studio 以 `dirty false` 显示“已保存”误导。

### 1.5 已知固定模板精确拒绝缺失

- 当前没有对 `daily-content-article.ts:99-108` 九个硬编码字段的完整精确指纹门；本方案要求逐项深等，不用正则/关键词替代。

---

## 2 Goals / Non-Goals

### 2.1 Goals（可证伪）

1. `plan_items` 成为策划单一真源，新增 **仅两列** `planning_status` + `planning_provenance_json`，复用 `source_ids_json/available_materials_json/missing_materials_json/score_reasons_json/topic_id/revision`。
2. 策划为独立一等状态：`draft → ready_for_review → approved|rejected → draft`。批准/驳回属于内部审批：`desk` 依据 C9 standing grant 执行，Owner UI 可显式覆盖；普通员工 Agent 不可执行。仅 `approved` 可进入正式选题投影与生产编排。
3. 评分无证据时为 `pending` 而非 100；`pending` 不进正式选题、不派 Writer。
4. 审批后统一幂等编排 `advanceApprovedPlanItem`：建 `project`（若不存在）→ 按 `missing_materials_json` 与证据派 `reporter` 或 `writer`；手动按钮与 Stage D 同路径。
5. Stage C 机械信息不足时写 `pending` 并派 `planner`，禁止恒 100/自动升正式。
6. Writer 不补策划：无 `approved` 策划不得派 Writer；缺证据仅 `reporter`。
7. 分波并发可实施：Wave A 仅 5349，Wave B 并发 5350-5353（文件所有权不重叠），Wave C 5354 集成收口。

### 2.2 Non-Goals（明确不做）

- 不新建 `planning_items` / `plan_drafts` 等新表；不迁移 `topic` 主键；不重写评分模型为 LLM。
- 不引入正则替代策划；不为每个 `plan_item` 自动建 `research_claims` 假证据。
- 不改 `PRODUCT` 商业定位；不改 `daily_content_cycles/targets/derivatives`（v75）表结构。
- 不在 Writer 内做选题重写；不自动将 `draft` 升为正式。

---

## 3 Ontology（本体）

| 实体 | 定义 | 标识 | 关系 |
|---|---|---|---|
| `plan_item` | 策划单一真源，一行一选题 | `plan_items.id` | 1 plan : N items；1 item : 0..1 topic；1 item : 0..1 project；1 item : 0..1 `agent_task(planner)` |
| `planning_status` | 策划阶段状态机 | `draft/ready_for_review/approved/rejected` | 独立于生产 `Stage C/D/E` 与 `content` 状态 |
| `planning_provenance` | 策划来源/轨迹 JSON | `planning_provenance_json` | 含 `origin, fingerprints, planner_task_id, transitions[]` |
| `topic` | 知识主题 | `topics.id` / `planning.ts topicIndex normalize` | `plan_item.topic_id` 可空，`approved` 后异步绑定也允许 |
| `project` | 内容工程 | `content_projects.id` | 由 `advanceApprovedPlanItem` 在 SQLite 事务中查询后幂等创建；不假设现有 schema 有唯一键 |
| `agent_task` | 代理任务 | `agent_tasks.id` | 通过现有任务/作业模型的 `roleId='planner'` 与上下文对象键识别，不新增虚构 `kind` 列；`reporter/writer` 由编排派生 |
| `daily_target` | 每日内容目标 | `daily_content_targets.id` | Stage C 的评分与选择对象；`score_snapshot_json.status='pending'` 时不得提升为正式选题 |

**角色**：`desk`（内部审批/统一编排）、`Owner UI`（显式批准、驳回、覆盖）、`planner`（补齐策划与材料缺口）、`reporter`（补研究）、`writer`（仅在策划已批且证据就绪时写作）、`scheduler`（Stage C/D 定时）。

**不变量**：
- 正式选题投影 = `planning_status=approved` 的 `plan_items` 子集。
- `writer` 派单前置 = `planning_status='approved' AND missing_materials_json 为空 AND score.status != 'pending'`。
- 同一 `plan_item` 同时仅一项活动 `planner` 任务；幂等对象键为 `planItemId`，任务身份仍使用现有 `agent_task/jobId` 契约。

---

## 4 DB Migration / Backfill

### 4.1 Migration（vNext，仅两列 + 一索引）

文件：新建 `src/main/db/planning-stage-migrations.ts`，版本固定为 **77**；`src/main/db/migrations.ts` 仅负责导入并追加到聚合数组。该版本紧随 `zhihu-hot-content-loop-migrations.ts` v75/v76。

```sql
-- v77: planning stage 一等状态
ALTER TABLE plan_items ADD COLUMN planning_status TEXT NOT NULL
  CHECK (planning_status IN ('draft','ready_for_review','approved','rejected'))
  DEFAULT 'draft';

ALTER TABLE plan_items ADD COLUMN planning_provenance_json TEXT NOT NULL
  DEFAULT '{"origin":"system","transitions":[]}';

-- 复用列：source_ids_json, available_materials_json, missing_materials_json,
-- score_reasons_json, topic_id, revision 已存在（v4/v10）
CREATE INDEX IF NOT EXISTS idx_plan_items_planning_status
  ON plan_items(planning_status, plan_id, sort_order);
```

> 决策：`planner_task_id` 不另加列，写入 `planning_provenance_json.planner_task_id`；查询活动任务时仍以现有 `agent_tasks/jobs` 为事实源，JSON 只保存审计引用。

### 4.2 Backfill（v77 内一次执行；分类条件可重复运行而不翻转）

```sql
-- 精确模板指纹：与 daily-content-article.ts:99-108 的八个硬编码字段逐项相等；
-- 不使用正则，也不把 Yann 的用户数据 UUID 写进通用 migration。
UPDATE plan_items
SET planning_status='draft',
    planning_provenance_json = json_patch(
      planning_provenance_json,
      json_object(
        'origin','migration',
        'legacy','legacy_zhihu_fallback',
        'backfilled_at',strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        'reason','exact_fallback_fingerprint_8fields'
      )
    )
WHERE planning_status='draft'
  AND json_extract(planning_provenance_json,'$.legacy') IS NULL
  AND why_now='基于知乎热题的每日内容目标'
  AND timeliness='today'
  AND target_audience='泛科技受众'
  AND angle='深度解读该问题的核心争议与证据'
  AND point_of_view='提供独立判断与可操作建议'
  AND platforms_json='["x","xiaohongshu","wechat"]'
  AND formats_json='["article"]'
  AND opening_guidance='以问题为引，快速建立共识再展开分析'
  AND structure_guidance='背景→拆解→证据→观点→行动';

-- 其余既有项保持可用，标记为已审批遗产；只处理尚未分类的 v77 默认行。
UPDATE plan_items
SET planning_status='approved',
    planning_provenance_json = json_patch(
      planning_provenance_json,
      json_object(
        'origin','migration',
        'legacy','legacy_approved',
        'backfilled_at',strftime('%Y-%m-%dT%H:%M:%SZ','now')
      )
    )
WHERE planning_status='draft'
  AND json_extract(planning_provenance_json,'$.legacy') IS NULL;
```

- 精确模板行（包括 Yann 现有 `plan_item 8342f64f`）由通用指纹命中为 `draft`；项目 `6ce12d8a` 保留，不删除、不另建。
- `legacy_zhihu_fallback` 不进正式投影，需 `planner` 补齐 → `ready_for_review` → `desk/Owner UI` 审批。
- v77 migration 只执行一次；若将分类 SQL 独立重放，`legacy IS NULL` 守卫保证不会二次翻转 `approved/draft`。

### 4.3 索引与兼容

- 读路径 `latestPlanItemRowsByDate` / `getProposalLedger` / `getTodayOverviewMetrics` 增加 `WHERE planning_status='approved'`。
- 旧代码未传 `planning_status` 时 DB `DEFAULT 'draft'` 生效，不阻断写入。

---

## 5 JSON Schemas

### 5.1 `planning_provenance_json`（`plan_items.planning_provenance_json`）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PlanningProvenance",
  "type": "object",
  "required": ["origin"],
  "properties": {
    "origin": { "type": "string", "enum": ["zhihu_hot","manual","planner","migration","system"] },
    "planner_task_id": { "type": ["string","null"] },
    "planner_job_id": { "type": ["string","null"] },
    "legacy": { "type": ["string","null"], "enum": ["legacy_zhihu_fallback","legacy_approved",null] },
    "yann_recovery": { "type": ["string","null"] },
    "project_id": { "type": ["string","null"] },
    "fingerprints": {
      "type": "object",
      "properties": {
        "template_exact_9fields": { "type": "boolean" },
        "zhihu_hot_ids": { "type": "array", "items": { "type": "string" } }
      }
    },
    "transitions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["from","to","at","by"],
        "properties": {
          "from": { "type": ["string","null"], "enum": ["draft","ready_for_review","approved","rejected",null] },
          "to": { "type": "string", "enum": ["draft","ready_for_review","approved","rejected"] },
          "by": { "type": "string", "enum": ["system","planner","desk","owner_ui","migration"] },
          "at": { "type": "string", "format": "date-time" },
          "reason": { "type": "string" }
        }
      }
    },
    "backfilled_at": { "type": ["string","null"], "format": "date-time" }
  },
  "additionalProperties": true
}
```

示例：

```json
{"origin":"zhihu_hot","fingerprints":{"template_exact_9fields":true,"zhihu_hot_ids":["abc"]},
 "transitions":[{"from":null,"to":"draft","by":"system","at":"2026-08-23T12:07:00Z","reason":"stage_c_insufficient_evidence_pending"}],
 "planner_task_id":"task_..."}
```

### 5.2 `available_materials_json` / `missing_materials_json`（复用现有 `string[]` 契约）

```json
// available_materials_json：已经具备、可交给后续角色使用的材料说明
["知乎热榜原始条目与 canonical URL", "Yann LeCun 原话来源待核验的线索"]

// missing_materials_json：仍需记者补齐的可执行缺口；空数组才允许直接派 Writer
["核验 Yann LeCun 原始采访/帖子上下文", "补齐支持与反驳世界模型路线的独立来源"]
```

- 保持 `src/main/planning.ts:PlanItemInput.availableMaterials/missingMaterials` 的 `string[]` 形态，避免另造第二种材料 schema。
- `source_ids_json` 继续保存机器可核验的资料 ID；`available_materials_json` 只陈述已有材料，`missing_materials_json` 只陈述待办缺口。

### 5.3 `score_reasons_json` / `daily_content_targets.score_snapshot_json`

```json
{
  "status": "pending|scored",
  "score": 0,
  "reasons": [
    {"criterion":"evidence_coverage","weight":25,"score":0,"reason":"no_source_body_or_claims"},
    {"criterion":"timeliness","weight":20,"score":0,"reason":"today_but_no_source_evidence"},
    {"criterion":"audience_fit","weight":20,"score":0},
    {"criterion":"angle_novelty","weight":15,"score":0},
    {"criterion":"effort_feasibility","weight":15,"score":0},
    {"criterion":"compliance","weight":5,"score":5}
  ],
  "pending_reason": "insufficient_evidence"
}
```

- `status='pending'` 时 `score` 固定为 0，UI 显示 `— / 待补证据`，禁止显示 100。
- 权重保持现有 `25/20/20/15/15/5`；输入改为真实 `source.summary/excerpt/heat/categories` 与策划材料状态，不再写死六维满分。

### 5.4 `score_snapshot` 持久化

复用 v75 已存在的 `daily_content_targets.score_snapshot_json` 与 `plan_items.score_reasons_json`；**不新增 `daily_content_cycles` 列**。Stage C 写 target 快照，Planner 保存策划时把同一事实归一化写入 plan item。

---

## 6 State Machine + Transition Table

### 6.1 状态图

```
        ┌─────────────────────────────────┐
        │            draft                │◄─────────────┐
        │  (策划草稿，不进正式投影)       │              │
        └──────────────┬──────────────────┘              │
                       │ plans.save /                    │ rejected→draft
                       │ planner补齐                     │ (owner rework)
                       ▼                                 │
        ┌─────────────────────────────────┐              │
        │       ready_for_review          │──────┐       │
        │  (待 desk / Owner UI 审批)      │      │       │
        └──────────────┬──────────────────┘      │       │
                       │                         │       │
          ┌────────────┴────────────┐            │       │
          ▼                         ▼            │       │
   ┌─────────────┐          ┌──────────────┐    │       │
   │  approved   │          │  rejected    │────┘       │
   │ (正式选题)  │          │ (驳回)       │  approve/  │
   └─────────────┘          └──────────────┘  reject    │
          │                                              │
          │ advanceApprovedPlanItem                      │
          ▼                                              │
     project + reporter/writer                           │
```

### 6.2 Transition Table（唯一真源）

| # | from | to | 触发 | 执行者 | 校验 | 产出 |
|---|---|---|---|---|---|---|
| T1 | `null` → `draft` | `plans.save` 首次创建 / Stage C `pending` 写入 | `system/planner` | 最小结构可持久化，`topic_id` 可空 | `plan_items` 插入 `draft`，写 `provenance.origin` |
| T2 | `draft` → `ready_for_review` | `plans.save` / Planner 补齐提交 | `planner` | §7 全部门通过；`source_ids_json` 有效、`score_reasons_json.status='scored'`；`missing_materials_json` 可非空但必须具体 | 状态转待审，追加 transition |
| T3 | `ready_for_review` → `approved` | `plan_item.approve` | `desk` standing grant 或 Owner UI | revision 匹配且 `score.status='scored'`；**无强制跳门** | 提交状态后调用 `advanceApprovedPlanItem` |
| T4 | `ready_for_review` → `rejected` | `plan_item.reject` | `desk` standing grant 或 Owner UI | revision 匹配，`reason` 必填 | 状态置 `rejected`，不删行 |
| T5 | `rejected` → `draft` | `plan_item.rework` | `desk` 或 Owner UI | revision 匹配 | 回到草稿，保留 transitions，Planner 可继续补齐 |
| T6 | `draft` → `draft` | Planner 增量补齐 | `planner` | 部分字段更新 | 更新策划字段与三个 JSON，不转态 |

**禁止**：`draft → approved`、`approved → rejected`、`rejected → approved` 直跳；`approved` 仅可经新 `revision` 的 `draft` 重新审批（审计要求状态只允许 `draft→ready_for_review→approved|rejected`、`rejected→draft`）。

### 6.3 并发守卫

- `UPDATE plan_items SET planning_status=:to, revision=revision+1, updated_at=now(), planning_provenance_json=:provenance WHERE id=:id AND planning_status=:expected AND revision=:expectedRevision`；影响行数 0 则报 `conflict`，前端提示刷新。

---

## 7 Quality Gate（结构校验 + 证据引用）

**位置**：`src/main/planning.ts:saveCurrentPlan` 内首道门；`src/main/mcp-business-commands.ts:plans.save` 复用同一函数；`planner` 任务完成回调同门。

**不允许**：正则/关键词匹配替代策划；Writer 内重写策划字段。

### 7.1 结构校验（必填）

- `title` 10–80 字符，必须是可直接评审的题目而非裸来源标题；
- `why_now` 含具体事件、时间窗口或传播机会；
- `timeliness` 与 `why_now` 一致，`today` 必须有当日来源事实；
- `target_audience` 是具体人群，不得只写“泛科技受众”；
- `angle` 给出与来源相关的可检验争议或切口；
- `point_of_view` 给出明确、可反驳的独立判断；
- `opening_guidance` 与 `structure_guidance` 必须围绕该主题，不得是通用骨架；
- `platforms/formats` 必须有策划解释；完整 9 字段 fallback 指纹命中时整项拒绝进入 `ready_for_review`，不单独禁止某个平台组合。

### 7.2 证据引用

- `source_ids_json` 至少一项且每个 ID 必须存在、具有 canonical URL；否则只能保留 `draft + pending`。
- `available_materials_json`、`missing_materials_json` 保持 `string[]`；Planner 必须分别陈述已有材料和具体研究缺口。
- `score_reasons_json.status` 必须由真实来源字段和材料状态计算；`pending` 不能进入待审。

### 7.3 已知固定模板精确拒绝

```ts
const ZHIHU_FALLBACK_FINGERPRINT = {
  whyNow: "基于知乎热题的每日内容目标",
  timeliness: "today",
  targetAudience: "泛科技受众",
  angle: "深度解读该问题的核心争议与证据",
  pointOfView: "提供独立判断与可操作建议",
  platforms: ["x", "xiaohongshu", "wechat"],
  formats: ["article"],
  openingGuidance: "以问题为引，快速建立共识再展开分析",
  structureGuidance: "背景→拆解→证据→观点→行动",
} as const;
// isExactZhihuFallback 对以上 9 个字段逐项深等；命中只能保存 draft，
// 并写 provenance.fingerprints.template_exact_9fields=true，绝不进入 ready_for_review。
```

### 7.4 结果

- Stage C 创建最小 `draft + pending`；`plan_item.submit` 或新建批次 `plans.save` 校验失败时返回结构化错误且不修改现有草稿。
- 质量门通过后才提交为 `ready_for_review`；模板指纹输入永远不能借失败分支写成待审。

---

## 8 Commands / Capabilities / Grants

### 8.1 Commands（`src/main/mcp-business-commands.ts` / `src/main/command-dispatcher.ts`）

| Command | 语义 | 触发 | 幂等锚 | 产出状态 |
|---|---|---|---|---|
| `plans.save` | 保存一批新的完整策划 | Planner / 现有 command dispatcher | 现有 `requestId → command_receipts` | 每项经质量门后创建为 `ready_for_review`；任一失败则事务回滚 |
| `plan_item.submit` | 提交一个既有草稿/驳回项 | Planner | `plan_item_id + expectedRevision + requestId` | `draft → ready_for_review`；用于 Yann 原位重策划 |
| `plan_item.request_planning` | 为草稿确保一项 Planner 工单 | Stage C / `desk` / Owner UI | `plan_item_id + requestId` | 活动 Planner 任务存在则复用，否则新建 |
| `plan_item.approve` | 内部批准 | `desk` standing grant 或 Owner UI | `plan_item_id + expectedRevision + requestId` | `ready_for_review → approved`；提交后调用统一推进服务 |
| `plan_item.reject` | 内部驳回 | `desk` standing grant 或 Owner UI | 同上 | `ready_for_review → rejected` |
| `plan_item.rework` | 驳回后退回草稿 | `desk` 或 Owner UI | 同上 | `rejected → draft` |
| `plan_item.advance` | 重放统一生产推进 | Stage D / Owner UI；内部调用 `advanceApprovedPlanItem` | `plan_item_id + requestId` | 复用/创建 project，确保当前应有的 reporter 或 writer 任务 |

### 8.2 Capabilities & Grants（`src/shared/agent-capabilities.ts` + `src/main/task-grants.ts`）

```
plans.save / plan_item.submit / plan_item.request_planning → planner 精确工单或 desk standing grant；Owner UI 可显式触发 request_planning
plan_item.approve/reject/rework → desk standing grant；Owner UI 显式动作
plan_item.advance               → desk / scheduler 精确系统调用；Owner UI 显式动作
```

- 员工角色的有效权限仍是 `task grant ∩ role capability ∩ object boundary`；普通 `planner/reporter/writer/librarian` 不得 approve/reject。
- Owner UI 不是 `agent_task`，走现有 `owner_ui/renderer` command envelope；C9 的 `desk` 仍拥有内部审批 standing write，不把日常内部批准强推给人。
- 不扩展 `CommandEnvelope` schema。每次 transition 从现有 envelope 的 `requestId/actor/taskId` 生成 provenance 条目，并由 `command_receipts` 提供重放事实。

---

## 9 Stage C/D、desk 与 Owner UI 统一时序

### 9.1 约束

- 新策划 `plans.save`、既有草稿 `plan_item.submit` 只产出 `ready_for_review`；`approve/reject` 仅由 `desk` 或 Owner UI 执行。
- 审批状态先原子提交，再调用 `advanceApprovedPlanItem`；外部派工不放进 SQLite 事务。失败时保留 `approved`，Stage D / `plan_item.advance` 可安全重放。
- Stage C 信息不足写 `pending` 并派 Planner，禁止恒 100、硬编码策划字段和自动升正式选题。

### 9.2 时序 A：Stage C 自动

```
Scheduler → createProductionStageC()
  → read/commit Zhihu source → scoreCandidates(real source facts)
  → evidence 不足:
      daily_content_targets.score_snapshot_json = {status:'pending', score:0, ...}
      createPlanningDraftFromTarget(title + sourceIds；策划字段为空；planning_status='draft')
      spawn roleId='planner'，对象边界 planItemId（活动任务存在则复用）
      不进正式投影，不派 reporter/writer
  → evidence 足且 Planner 已产完整方案:
      plans.save / plan_item.submit → ready_for_review
```

### 9.3 时序 B：Planner 补齐

```
planner task → 读取 source body / 资料库 → 补全策划字段、availableMaterials、missingMaterials、scoreReasons
  → plan_item.submit(planItemId, expectedRevision, item)
  → Quality Gate 通过: ready_for_review
  → 失败: 原 draft 不变，返回字段级错误，Planner 修正后再提交
```

### 9.4 时序 C：desk / Owner UI 审批

```
desk（默认内部审批）或 Owner UI（显式覆盖）
  → plan_item.approve {id, expectedRevision, reason?}
  → BEGIN IMMEDIATE
      conditional UPDATE ready_for_review → approved + revision + provenance transition
    COMMIT
  → advanceApprovedPlanItem(planItemId)
      BEGIN IMMEDIATE
        SELECT existing content_projects WHERE plan_item_id=?
        不存在则 INSERT；存在则复用
      COMMIT
      if missing_materials_json 非空 OR 无足够 research_claims: ensure reporter task
      else: ensure writer task
  → 返回 projectId + currentJobId + existing flags
```

### 9.5 时序 D：Stage D / 手动 / Reporter 完成同一服务

```
Stage D approved 集合 ─┐
Owner UI 开始生产 ─────┼→ advanceApprovedPlanItem(planItemId)
Reporter 终态处理器 ──┘
```

- Reporter 完成后更新材料/claims 并自动重放 `advanceApprovedPlanItem`；此时已是 `approved`，**不要求二次审批**。
- 三个入口共享项目查询事务与任务对象键；重复调用只返回当前 project/job，不二次派单。

### 9.6 状态与 UI 文案

- `draft`：Proposals 显示“草稿 · 待策划/待补证据”；Today 正式列表不出现。
- `ready_for_review`：Proposals 待审队列显示“待主管审批”；Today 正式计数不含。
- `approved`：Today 正式选题计数 +1；Studio 显示研究或写作的真实阶段。
- `rejected`：Proposals 驳回区，不计入 Today，可退回草稿。

---

## 10 Idempotency / Concurrency / Error States

### 10.1 幂等键

| 操作 | 幂等锚 | 实现 |
|---|---|---|
| `plans.save` | `requestId` | 复用现有 `command_receipts`；同 request 重放同结果，不新增虚构 hash 列 |
| `plan_item.submit/approve/reject/rework` | `requestId + plan_item_id + expectedRevision` | receipt 防请求重放；conditional UPDATE 防陈旧 revision |
| `advanceApprovedPlanItem` | `plan_item_id` | `BEGIN IMMEDIATE` 内先查后建 project；同步 SQLite 临界区无 `SELECT FOR UPDATE` |
| Planner/Reporter/Writer 派单 | `plan_item_id/project_id + roleId + active phase` | 查询现有活动 job/task；存在则返回，终态满足下一阶段才创建新任务 |

### 10.2 并发

- `plan_items` 使用 `revision` 乐观锁；项目“查后建”在 `BEGIN IMMEDIATE` 的同步 SQLite 事务内完成，避免并发双建，不声称现有 schema 有 `UNIQUE(plan_item_id)`。
- 审批事务只写数据库并立即提交；`advance` 与 `spawn` 在提交后执行。派工失败不回滚审批，靠 Stage D / 手动重放恢复。
- `proposals.ts` / `workbench.ts` 只读已提交状态；Stage C 写 target/draft 时不持有跨 Agent 或外部 I/O 长事务。

### 10.3 错误状态与恢复

| 错误 | 表现 | 处理 |
|---|---|---|
| 质量门拒绝 | `400 validation_failed`，现有 draft/revision 不变 | Planner 按字段错误修正后重提 |
| 审批冲突 | `409 conflict` | 拉取最新 revision 后由 desk/Owner UI 重新决策 |
| `advance` 重放 | 返回现有 project/current task | 无二次派单 |
| Planner 任务失败 | task/job 终态 failed，plan item 仍 draft | 新工单可按同一 planItemId 重派，旧任务保留审计 |
| Reporter 补证据后 | claims 增长、missing 清空 | 终态处理器重放 advance，自动派 Writer，无二次审批 |
| DB `CHECK` 违规 | `SQLITE_CONSTRAINT_CHECK` | 非法状态写入失败 |

---

## 11 Read Projections / UI Copy

### 11.1 投影（`src/main/proposals.ts` / `workbench.ts` / `content-derivative.ts`）

- `getProposalLedger()`：按 `planning_status` 分组；`draft/ready_for_review/rejected/approved` 都可审计可见，但只有 `approved` 标为正式选题。
- `getToday()` / `getOpportunityPool()` / `latestPlanItemRowsByDate()`：仅 `approved` 计入 Today 正式列表与指标；待审项留在 Proposals，不用 Today 占位冒充。
- `getStudioDualProjectionInternal()` / `getTodayOverviewMetrics()`：空项目 `versionCount=0` 显示“尚未生成正文”；`approved + missing` 显示“研究中/需补研究”，不得显示“已保存正文”。

### 11.2 UI Copy（`src/renderer/*`）

- `proposals-view.tsx`：`draft` → “草稿 · 待策划/待补证据”；`ready_for_review` → “待主管审批” + 有权限主体的批准/驳回；`approved` → “已批准 · 生产推进中”；`rejected` → “已驳回”。
- `today-library-view.tsx` / `today-daily-cycle.tsx` / `today-yesterday-iteration.tsx`：无证据时显示“评分：待补证据（—）”，禁止“100 分 / 已就绪”。
- `studio-view.tsx` / `studio-view-panels.tsx`：`versionCount=0` 显示“尚未生成正文”；展示真实 Planner/Reporter/Writer 任务，不以 `dirty=false` 推导内容已完成。

### 11.3 评分展示

- `pending` 显示 `—`，并从 `score_reasons_json` 展示缺口；`scored` 显示现有六维加权分解。

---

## 12 Legacy / Yann Recovery

### 12.1 存量划分

- 精确模板指纹（§4.2）→ `draft` + `legacy_zhihu_fallback` + `pending`，不进正式投影。
- 其他既有 `plan_items` → `approved` + `legacy_approved`，保持可用，不影响已发布内容。
- 空项目 `6ce12d8a / 8342f64f` 被通用 9 字段指纹归为 `draft`；project 保留，`content_versions=0` 时 Studio 显示“尚未生成正文”。

### 12.2 Yann 修复流程

1. v77 通用 backfill 将 `8342f64f` 归为 `draft + legacy_zhihu_fallback`，不写用户专属 migration SQL。
2. 通过 `plan_item.request_planning` 为该 `planItemId` 确保一项 `roleId='planner'` 工单；活动任务存在则复用，并把 task/job 引用写入 provenance。
3. Planner 原位 `plan_item.submit` 补全策划与真实评分 → `ready_for_review`。
4. `desk` 默认内部批准；Owner UI 也可显式批准。`advanceApprovedPlanItem` 先复用已有 project `6ce12d8a`，因当前 claims 为 0 而派 Reporter。
5. Reporter 完成并写入 claims/清空缺口后，终态处理器自动重放 advance，派 Writer；只有 Writer 保存首个 `content_version` 后 Studio 才显示正文版本。

### 12.3 回滚兼容

- `legacy_approved` 项无需重审；可按 `planning_provenance_json.legacy` 筛选。
- 已有空 project 不删除；状态投影以 plan item 与真实 version/task 事实为准。

---

## 13 Security / Permissions

- `plan_item.approve/reject/rework` 仅 `desk` standing grant 或 Owner UI；其他 Agent 即使伪造命令名也由 capability ∩ grant ∩ object boundary 拒绝。
- `plans.save/plan_item.submit` 允许 Planner 精确工单与 desk，但只能到 `ready_for_review`，不可直写 `approved`。
- `plan_item.request_planning/advance` 允许 desk、scheduler 的精确系统调用及 Owner UI；Reporter/Writer 不可自行审批或改策划。
- 派 Writer 前服务端再次校验 `planning_status='approved'`、无材料缺口且证据门满足。
- provenance 由后端追加；前端输入不能覆盖 transition 历史。

---

## 14 File Ownership 与 Wave A/B/C 并发计划

### 14.1 文件所有权（并发不重叠）

| Wave | 任务 | Owner 文件（独占） | 共享只读 |
|---|---|---|---|
| A | 5349 foundation | `src/main/db/planning-stage-migrations.ts`（新）+ `src/main/db/migrations.ts` + `src/main/planning-stage.ts`（新）+ `src/main/planning.ts` + `tests/planning-stage-foundation.test.mjs`（新） | 其余文件只读 |
| B 并发 | 5350 scoring/planner intake | `src/main/planning-stage-intake.ts`（新，唯一 owner，导出 `ensurePlannerTask`）+ `src/main/daily-content-cycle.ts` + `src/main/zhihu-hot-scoring.ts` + `src/main/zhihu-hot-channel.ts` + `tests/planning-stage-scoring.test.mjs`（新） | 调用 Wave A 冻结 API，不改 planning/orchestration |
| B 并发 | 5351 approval/orchestration | `src/main/daily-content-article.ts` + `src/main/daily-orchestration.ts` + `src/main/daily-orchestration-scheduler.ts` + `src/main/mcp-business-commands.ts` + `src/main/business-command.ts` + `src/main/command-dispatcher.ts` + `src/main/task-grants.ts` + `src/shared/agent-capabilities.ts` + 必需的 preload/IPC command bridge + `src/main/job-spawner.ts` + `tests/planning-stage-orchestration.test.mjs`（新） | 不改 content.ts / renderer projections |
| B 并发 | 5352 proposals/today | `src/main/proposals.ts` + `src/main/workbench.ts` + `src/renderer/proposals-view.tsx` + `src/renderer/today-library-view.tsx` + `src/renderer/today-daily-cycle.tsx` + `src/renderer/today-yesterday-iteration.tsx` + `tests/planning-stage-projections.test.mjs`（新） | 仅消费冻结状态/通用 command bridge |
| B 并发 | 5353 Studio | `src/main/content.ts` + `src/main/content-derivative.ts` + `src/renderer/studio-view.tsx` + `src/renderer/studio-view-panels.tsx` + `tests/planning-stage-studio.test.mjs`（新） | 仅消费冻结状态与 command bridge |
| C | 5354 integration/docs/Yann recovery | `PRODUCT.md` + `PRD.md` + `SPEC.md` + `TECHNICAL_DESIGN.md` + 独立集成测试/验收证据；真数据只经产品命令恢复 | 不回改 Wave A/B owner 文件；若接口缺陷则止损报告 |

**冻结合同**：Wave A 交付 `PlanningStatus`、`validatePlanItemForReview`、`isExactZhihuFallback`、`createPlanningDraftFromTarget`、`submitPlanItemForReview`、`transitionPlanItem` 的输入/输出。Wave B 的 5350 独占新文件 `planning-stage-intake.ts` 并实现 `ensurePlannerTask(database,{planItemId,sourceIds,requestId}) → {taskId,jobId,created}`；5351 只导入调用。Command 名固定为 `plan_item.request_planning/submit/approve/reject/rework/advance`。

**规则**：Wave B 四任务同批启动且不得越过 owner 清单修改共享文件；发现冻结接口不足即返回 `partial + 精确缺口`，不擅自并写 foundation。

### 14.2 Wave 甘特

```
Wave A (5349) ─────────────────────────────────────►
                  Wave B (5350 ┆ 5351 ┆ 5352 ┆ 5353) 并发
                                                    Wave C (5354) ──►
```

- Wave A 完成并通过 DoD 后，Wave B 四切片同时开工（槽位尽量放满 Luna Max）。
- Wave C 依赖 Wave B 全部验收（`advance` 幂等与投影一致性需四切片就绪）。

---

## 15 任务定义 WMB-5349..5354（依赖 / 验收）

### WMB-5349 foundation（Wave A，唯一前置）

- **交付**：v77 两列/索引/backfill；`planning-stage.ts` 冻结状态机、质量门、9 字段精确指纹、最小 draft 创建、单项 submit/transition/Planner 幂等接口；`plans.save` 新项只产 `ready_for_review`。
- **依赖**：无。
- **验收**：目标 foundation 测试证明 v77 分类、模板拒绝、合法/非法转移、既有草稿原位 submit 与 revision 冲突。

### WMB-5350 scoring / planner intake（Wave B）

- **交付**：评分由真实 source 字段驱动；证据不足写 `pending/0`，创建最小 draft 并调用 `ensurePlannerTask`；重复 Stage C 不重派。
- **依赖**：5349。
- **验收**：目标 scoring 测试证明无证据不是 100、无硬编码策划字段、同 planItem 仅一项活动 Planner 任务。

### WMB-5351 approval / orchestration（Wave B）

- **交付**：六个 `plan_item.*` command/capability；desk 与 Owner UI 权限；`advanceApprovedPlanItem` 统一项目复用、Reporter/Writer 分支、Reporter 完成续推；手动与 Stage D 同路径。
- **依赖**：5349。
- **验收**：目标 orchestration 测试证明普通 Agent 403、desk/Owner UI 可审批、陈旧 revision 409、重复 advance 不双建/不重派、Reporter 完成后自动派 Writer。

### WMB-5352 proposals / today（Wave B）

- **交付**：Proposals 按四状态诚实投影；Today 仅 approved；pending 显示 `—/待补证据`；批准/驳回调用冻结 command bridge。
- **依赖**：5349。
- **验收**：目标 projection 测试证明 draft/pending 不计入 Today、ready_for_review 在 Proposals 可见、无 100 误导。

### WMB-5353 Studio（Wave B）

- **交付**：Studio 根据策划状态、真实任务和 `versionCount` 显示；v0 显示“尚未生成正文”，不以 dirty=false 显示已保存；开始生产调用 `plan_item.advance`。
- **依赖**：5349。
- **验收**：目标 Studio 测试证明 draft 无 Writer 入口、approved 生产幂等、v0 文案诚实。

### WMB-5354 integration / docs / Yann recovery（Wave C）

- **交付**：更新四份正式合同；以产品命令原位恢复 Yann；运行一个集成场景并写验收证据。
- **依赖**：5350-5353 全部完成。
- **验收**：Yann `8342f64f` 经 Planner→审批→Reporter→Writer，复用 project `6ce12d8a`，最终 `research_claims≥1`、`content_versions≥1`；正式文档与实现一致。

---

## 16 Tests 矩阵

| 层级 | 用例 | 覆盖 | 唯一断言 |
|---|---|---|---|
| Foundation | v77 + backfill | 5349 | 精确 9 字段 fallback=`draft/legacy_zhihu_fallback`；其他存量=`approved/legacy_approved`；非法状态失败 |
| Foundation | submit + transition | 5349 | 模板不能待审；完整策划可 `draft→ready_for_review`；陈旧 revision 与非法跳转冲突 |
| Scoring | pending 非 100 | 5350 | 无真实证据为 `pending/0`，创建最小 draft，不写 fallback 策划内容 |
| Planner intake | 同对象幂等 | 5350 | 重复 Stage C 仅一项活动 Planner 任务 |
| Approval | 权限与 revision | 5351 | desk/Owner UI 成功；普通 Agent 403；陈旧 revision 409 |
| Orchestration | 项目/任务幂等 | 5351 | 重放 advance 复用 project/current task，不双建、不重派 |
| Orchestration | Reporter→Writer | 5351 | missing 非空仅 Reporter；Reporter 完成并满足证据门后自动 Writer，无二次审批 |
| Projection | 正式选题仅 approved | 5352 | draft/待审不进 Today；四状态在 Proposals 诚实可见；pending 不显示 100 |
| Studio | v0 与生产状态 | 5353 | v0 显示“尚未生成正文”；draft 无 Writer；approved 展示真实任务 |
| Integration | Yann 原位恢复 | 5354 | 复用原 plan item/project，最终 claims≥1 且 versions≥1 |

---

## 17 Real-Data Acceptance（真数据验收）

1. **Stage C 真实扫描**：抓取当日知乎热榜并运行 Stage C；缺正文/claims 的 target 必须是 `score.status='pending', score=0`，关联 draft 无模板策划字段，且仅一项 Planner 活动任务。
2. **Planner 原位补齐**：对 `8342f64f` 执行 `plan_item.request_planning`，Planner 读取真实来源后 `plan_item.submit`；断言状态 `ready_for_review`、策划字段与来源相关、评分不再 pending。
3. **内部审批**：由 desk standing grant 或 Owner UI 执行 approve；断言 `approved`，并复用 project `6ce12d8a`。
4. **Reporter/Writer 分支**：当前 claims=0 时只派 Reporter；Reporter 产 EvidencePack/claims 后自动续推 Writer，最终保存首版正文。
5. **投影一致**：Today 只计 approved；Proposals 展示真实策划状态；Studio `versionCount=0` 前不显示“已保存正文”。

---

## 18 Rollback / Observability

### 18.1 Rollback

- v77 是 additive migration，旧列与旧数据不删除。上线前必须备份 active-root SQLite，并先以临时副本运行 migration foundation 测试。
- **尚未产生 v77 业务写入**：停止应用，恢复迁移前 DB 备份并回退应用包。
- **已经产生 v77 状态写入**：禁止靠 feature flag 回退成“直接 approved”；只能前向修复。强行降级会把 draft 重新冒充正式选题。
- 不提供运行时 bypass，也不在 SQLite 上执行脆弱的在线 DROP COLUMN 回滚。

### 18.2 Observability

- 复用 `command_receipts` / operation log 记录 `planning.transition`、`scoring.pending`、`advance` 的 requestId、actor、planItemId、revision、branch、existing/error。
- 验收查询输出四状态计数、pending 数、活动 Planner/Reporter/Writer 任务及孤立空 project；不为本修复新建遥测服务或告警系统。

---

## 19 PRODUCT / PRD / SPEC / TECH_DESIGN 更新

- **PRODUCT**：策划成为资料与正式选题之间的一等阶段；C9 desk 负责日常内部审批，Owner UI 保留显式决定；Writer 不补策划。
- **PRD**：增加 draft/待审/已批/驳回用户故事、Stage C pending、统一生产推进、真实 UI 文案和验收。
- **SPEC**：v77 两列/JSON schema、六个 `plan_item.*` command、capability/grant/object boundary、projection 与 idempotency 合同。
- **TECHNICAL_DESIGN**：`planning-stage.ts` API、Stage C 真实评分、审批提交后推进、SQLite `BEGIN IMMEDIATE` 临界区、Reporter 终态续推、Wave owner。

---

## 20 Out of Scope

- 新建策划表、第二数据库/服务、topic 体系重写、评分权重调优或 LLM 自动评分。
- Writer 内重写策划、自动 `draft→approved`、运行时降级到直接 approved。
- 多租户/权限体系重做；仅在现有 role/capability/grant/boundary 上增加精确命令。
- 新遥测平台、告警服务、发布动作和硬删。

---

## Decision Log

| # | 决策 | 依据 | 否决替代 |
|---|---|---|---|
| D1 | 复用 `plan_items`，仅加 status/provenance | 单一真源、最小迁移 | 新表双写 |
| D2 | v77 精确 9 字段 backfill，通用规则不写 Yann UUID | 可审计且不污染产品 migration | 正则/用户专属 SQL |
| D3 | 新项 `plans.save`、既有项 `plan_item.submit` 只到待审 | 既支持批次又支持原位恢复 | 直接 approved / 新建替代旧项 |
| D4 | desk 默认内部审批，Owner UI 可显式覆盖 | PRODUCT C9 + 人机批准入口 | Owner-only 或员工自批 |
| D5 | pending=0，不进正式投影、不派 Writer | 评分真实性 | 100 分兜底 |
| D6 | approval 先提交，advance 后执行且可重放 | 外部派工不能嵌入 DB 事务 | 同事务 spawn |
| D7 | 项目幂等用 `BEGIN IMMEDIATE` 查后建 | 现有 schema 无 `UNIQUE(plan_item_id)`，SQLite 无 `SELECT FOR UPDATE` | 虚构唯一键/行锁 |
| D8 | Reporter 终态自动重放 advance | approved 无需二次审批 | 人工再批一次 |
| D9 | Wave A 冻结 API，Wave B 四 owner 并发，Wave C 收口 | 文件无重叠、依赖明确 | 抢写共享文件/全串行 |
| D10 | 无 bypass rollback；写入后前向修复 | 回退直批会重新制造根因 | feature flag 直批 |

---

## Definition of Done（可证伪）

- [ ] v77 在临时数据库上新增两列与索引；精确 9 字段 fallback（含 Yann）为 draft，其他存量保持 approved。
- [ ] Stage C 无真实证据为 pending/0，最小 draft 不含硬编码策划内容，重复扫描不重派 Planner。
- [ ] `plans.save/plan_item.submit` 只有质量门通过才到 ready_for_review；模板、陈旧 revision、非法跳转失败。
- [ ] desk/Owner UI 可审批，普通 Agent 不可；approved 后项目和当前角色任务均幂等。
- [ ] missing 非空仅 Reporter；Reporter 完成后自动 Writer；Writer 前二次验证策划已批且证据就绪。
- [ ] Today 仅 approved；Proposals 四状态诚实；Studio v0 显示“尚未生成正文”，pending 不显示 100。
- [ ] Yann 原 plan item/project 原位走通 Planner→审批→Reporter→Writer，最终 `research_claims≥1`、`content_versions≥1`。
- [ ] 四份正式合同与实现一致；每个 WMB 任务仅保留一个最强目标测试/真实场景证据。

---

*方案结束。Wave A 由 WMB-5349 启动；通过后 Wave B 的 WMB-5350..5353 同批并发；Wave C 的 WMB-5354 仅做合同与真数据收口。*
