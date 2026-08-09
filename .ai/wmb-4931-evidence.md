# WMB-4931 Editor-desk full version — 聚焦验证证据

日期：2026-08-07
验证切片：Wmb4931DeskFull（aftershock 去 topic 硬依赖 + story_key/stage 落库 + Discover 任务流水 + topic 绑定率）

## 结论

四项交付全部完成，聚焦测试 6/6 新增全绿，**全量测试套件 336/336 通过**（含 4930 chair/rail/pool 既有测试、4941 的 lane-gate 迁移共存），**`tsc --noEmit` 全树通过（exit 0，4941/4942 落地后复跑确认）**。基线时 `ferment.test.mjs` 有 2 个预存失败（topic-null 高价值项因播种覆盖语义 reason 而掉 rail），本任务已修复并转绿。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `node --test tests/ferment-aftershock-no-topic.test.mjs` | 6/6 通过（title-bigram 路径 / plan 来源重合路径 / 无证据空余波 / topic 路径回归 / 迁移列+派生 / story_key 回填） |
| `node --test tests/ferment.test.mjs tests/opportunity-pool.test.mjs` | 全绿（基线 2 个预存失败已修复） |
| `node --test --test-concurrency=1 tests/*.test.mjs` | **336/336 通过**（基线 328/336；8 个失败中 5 个为迁移版本断言过期、2 个为 Discover 边界文案违规、1 个迁移计数，全部修复） |
| `npm run typecheck` | **全树通过（tsc exit 0）**——4941/4942 落地后复跑确认；期间 transient 的 source-commands 符号错误属其 in-flight 改动，非本任务文件 |

## 交付内容

### 1. Aftershock 去 topic 硬依赖（`src/main/ferment.ts` `refreshAftershocks`）
- 候选新来源单次查询（窗口 = 行内最早 firstSeenAt，下限 now-14d，未归档），全部 carry 行复用。
- 有 topicId：沿用既有语义——被同主题 plan_items 引用的新来源（topic 路径回归测试覆盖）。
- 无 topicId：按 storyKey 规则判定——(a) 被「同故事」plan_item（来源重合 shared≥2 或 Jaccard≥0.5，或标题 bigram≥0.5）引用的新来源；(b) 直接与 carry 标题做规范化 bigram 重合的新来源（未进任何方案也亮后续）。
- 配套修复：`upsertCarryFromPlanItem` 更新路径 reason 改为 `COALESCE(reason, ?)`——播种不再覆盖「未完结影响」语义 reason，多日项跨日不掉 rail（这是基线 2 个失败测试的根因）。

### 2. story_key / stage 可选 schema（`db/late-migrations.ts` v45 + `ferment-read.ts`/`ferment.ts`）
- 迁移 v45：`work_carry_items` 加 `story_key TEXT`、`stage TEXT` + 两个索引。**不加 UNIQUE 部分索引**：dismissed 泊车/合并历史行与活跃行同 story 是常态，唯一约束违反「否决/合并行保留可查证历史」语义；身份收敛由 mergeSimilarCarryItems 负责（设计 §8.2 的 UNIQUE 索引按此裁决省略，证据在迁移注释）。
- `storyKeyOf`（ferment-read.ts）：topicId → `topic:{id}`（跨日稳定）；无 topic → 来源集哈希 `sources:{hash}`；再兜底标题 bigram 哈希 `title:{hash}`。
- 写入点：upsertCarryFromPlanItem（insert+update）、dismissCarryForPlanItem、seedCarryFromHighValueSources、seedCarryFromTopics、mergeSimilarCarryItems（合并行继承 keeper 键）、refreshWorkCarry 内 backfillCarryStoryKeys（旧行/直写行回填）。
- stage 派生（deriveCarryStages，refresh 内幂等）：watching→cooling；active 有「为何关注」（余波≥1 或未完结语义 reason）→fermenting；否则 emerging。`listFermentingBundle` 有 stage 时直接用，stage 为 null 的旧行回退按 aftershock/reason 现算——既有 4930 rail 行为不变（相关测试原样通过）。

### 3. Discover 收编任务/partial 流水（`src/renderer/discover-view.tsx` + `styles-workflow-library.css`）
- 顶部轻量状态块 `discover-task-stream`：读取 `getAgentTask({intent:'daily_intelligence'})`，运行中/needs_user 每 8s 轮询 + onDataChanged(agent/today) 即时刷新。
- 呈现：headline（启动/扫描/生成方案/部分完成/需要处理/失败/完成）+ 进度（渠道 n/m · 保存 · 机会）+ 最近事件 + partial/failed 的 errorMessage。**不占今日主视野**：今日页零改动。
- 文案守边界：全文件无「情报渠道」（Discover/Settings 边界测试原样通过）。

### 4. topic_id 绑定率（`src/main/planning.ts` + `src/main/agent-runner.ts`）
- `saveCurrentPlan`：事务内为**多日/持续/余波项**（无 topicId 时）find-or-create 主题并绑定——同规范标题复用既有主题（跨日同 story 落在同一 topic，story_key 稳定），无则 `createTopic`（标题截 80 字）；事务回滚主题一并回滚。非多日项不自动建主题（测试断言）。
- `dailyPrompt`：新增判断要求 3.5——多日跟进项必须绑定 topicId（只可复制简报「存量」/知识上下文的真实 id，禁止臆造；无既有主题可省略，系统自动补绑）；JSON 示例增加 topicId 字段说明。zod schema 本已支持 topicId，无需改解析。

## 触碰文件

- `src/main/ferment.ts`（refreshAftershocks 重写、story_key/stage、merge 键统一、reason 保留、listFermentingBundle stage）
- `src/main/ferment-read.ts`（storyKeyOf、CarryRow/stage/storyKey 读写）
- `src/main/planning.ts`（多日项 find-or-create 主题绑定，事务内）
- `src/main/agent-runner.ts`（dailyPrompt 3.5 + JSON 示例 topicId）
- `src/main/db/late-migrations.ts`（v45，与 4941 的 v46 共存）
- `src/renderer/discover-view.tsx` + `src/renderer/styles-workflow-library.css`（任务流水块）
- `tests/ferment-aftershock-no-topic.test.mjs`（新增 6 测试）
- 迁移版本断言更新（新增 v45/v46 的合法后果）：`tests/eval-029-fixtures.test.mjs`、`tests/settings.test.mjs`、`scripts/eval-029-fixtures.mjs`、`tests/fixtures/eval-029-workspaces.v1.json`（schemaVersion 44→46）

## 剩余风险

- `sources:`/`title:` 前缀 story_key 会随来源集/措辞漂移；refresh 由 mergeSimilarCarryItems 收敛（合并行继承 keeper 键），topic 绑定率提升后 `topic:` 键占比上升、稳定性改善。属设计属性。
- stage 为 refresh 派生缓存：refresh 之间若直写 reason/aftershock，rail 判定回退旧 stage 直到下次 refresh（与 4930 设计「MVP 接受时序依赖，完整版加列固化」方向一致；listFermentingBundle 对 stage=null 行回退现算兜底）。
- Discover 任务流水的实机 Electron 视觉验收（A3 观感）建议由主 Agent 终验；逻辑层（取数/轮询/文案/边界）已由类型检查 + 边界测试覆盖。
- `npm run typecheck` 已全树通过（tsc exit 0，4941/4942 落地后复跑确认）。
