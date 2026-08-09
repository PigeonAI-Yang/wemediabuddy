# WMB-4942 判定两关落地：Tier 0 规则 + Tier 1 结构化判定 + 归档写路径 + fail-closed 水印

日期：2026-08-07 ｜ Agent：Wmb4942TierGate ｜ 状态：交付（待 Main 验收）

## 交付内容

### 1. Tier 0 确定性规则（`src/main/lane-gate.ts`，零模型）
- `isTier0AutoRelevantSource(database, source, lane)`：官方信源（`source_feeds.registry_id` 非空，W1 主发清单官方 web 巡检渠道是唯一写入口，按 intelligencePackId 各自挂载即赛道映射）+ AI 工作空间（`wemedia-intelligence-engine`）的 AI 前沿 List（`AI_FRONTIER_LIST_ID`，AI-only route 索引的 x_lists 主线）绑定 feed → 直判相关。
- `listLaneGateCandidates(database, { since, limit })`：与简报增量同窗口（collected_at > since，排除 archived），供判定编排使用。
- 设计取舍（§3.1 原文锁定）：AI 前沿 List 属「AI-only route 索引」Tier 0 范围；混发噪音过滤作用于**非精选渠道**（其余 X List / 用户渠道逐条进 Tier 1），已在证据末尾记录该边界。

### 2. 归档写路径（`applyLaneGateBatch`，同一事务）
- 不相关 → `management_status='archived'` + revision+1 + 判定流水行，同一事务（dispatcher BEGIN IMMEDIATE 或自带事务）；任一判定失败（SOURCE_NOT_FOUND / REVISION_CONFLICT / LANE_JUDGMENT_INVALID）→ 整批回滚零写（fail-closed on archive）。
- 幂等：已 archived + irrelevant → skipped(already_archived) 零写；relevant × archived → 仅覆盖判定记录（最新行胜出），不翻转状态；同 (source_id, judged_at) 重放 → skipped(already_judged)。
- `sources.lane_gate` 命令改走 `applyLaneGateBatch(transaction:false)`，回执扩展 `archived` 数组；`lane_restore` 未动。
- reason_code 词典补充 `lane_relevant`（Tier 1 判相关默认记录码；设计 §3.2 relevant 条目不携带 reasonCode，但流水表 NOT NULL）。

### 3. Tier 1 结构化判定 + 编排（`src/main/agent-runner.ts`）
- `parseLaneGateOutput`：取会话**第一个** ```json 块（方案块在之后，`parseDailyPlanOutput` 仍取最后一个，语义不变）；irrelevant 必带词典内 reasonCode（系统码 official_source/editor_override/lane_relevant 禁用）+ 一句话 reason；重复 sourceId 拒绝。
- `dailyPrompt` 新增「第一关：赛道相关性判定」段：Tier 0 id 标注自动相关、待判清单逐条判定要求、先判定块后方案块的输出顺序（方案 sourceIds 只许引用相关 id）。
- `buildDailyGateRun`：候选 = 简报增量窗口未 archived 资料；Tier 0 分流；`shouldSkipJudgment` 7 日冷却命中者跳过（重跑/主编恢复后不重判）。无工作空间配方时整体 no-op（空跑不变 AC-017）。
- `applyDailyLaneGate`：先解析判定块（漏判/多判/重复 → 抛错 → 整轮 fail-closed 零归档、水印不推进），再写 Tier 0 系统行（judged_by=system / official_source）、Tier 1 编辑行（irrelevant → archived + 流水），返回有效资料 id 集合。
- `savePlanFromSynthesisOutput` 增加 `allowedSourceIds` 过滤：四问方案引用白名单外 sourceId 的项被丢弃（四问只跑在有效资料上）。
- 水印推进保持在两关（判定 + 方案）都成功之后：任何失败走既有 catch → partial，`judgeWatermark` 不写入，下轮重判（判定幂等）。

### 4. 测试（`tests/lane-gate-run.test.mjs` 新增 6 用例）
- Tier 0 分流 + 系统行写入（官方/AI 前沿 active、judged_by=system）+ 提示词第一关门段。
- 混合批 A1：生活动态 → archived + lifestyle_noise + reason 非空 + judged_by/at/sourceRevision；官方与 AI 前沿保持 active（无模型调用痕迹）。
- 解析失败零归档：非法 JSON / 缺块 / 方案块误判 / 缺 reasonCode / 系统码 / 缺 reason / 重复 → 零判定行；命令级坏批整批回滚。
- 编排 fail-closed：漏判/多判/重复 → 抛错零写；完整一轮 4 行流水 + lifestyle 归档。
- 7 日冷却：已判条目重跑跳过（零归档重判轮）；冷却过期后重新成为候选；archived 条目不进判定轮。
- 方案过滤：引用已移出资料的机会被丢弃。

## 验证证据
- `node --test tests/lane-gate-run.test.mjs` → **6/6 pass**。
- `node --test tests/lane-gate-contract.test.mjs tests/migrations.test.mjs` → **11/11 pass**（4941 契约在归档语义下保持全绿；append-only 测试第二轮 expectedRevision 已由 Wmb4941LaneContract 协调为 2）。
- `npm test` 全套 → **342/342 pass**（含 agent-runner / daily-plan-output / task-grants / 4931 并行工作）。
- `npx tsc --noEmit` → **exit 0**。

## 协作与边界
- 与 Wmb4941LaneContract 协调：source-commands.ts 归其定稿（已合入），lane-gate.ts Tier0/applyLaneGateBatch 与 agent-runner 归本任务；契约测试已按其 applyLaneGateBatch 语义更新。
- 与 Wmb4931DeskFull 确认：agent-runner.ts 可写（保留 dailyPrompt 3/3.5 topic-binding 行）；未触碰 ferment.ts / workspace-intelligence.ts / discover-view（4931 Discover 流非本任务范围）。
- 非目标遵守：无 UI（4944）、无 searchSources/简报增量过滤/今日统计（4943）、无端到端 Discover 流（4931）、未 git commit。

## 已知边界（设计锁定）
- AI 前沿 List 整 feed 视为赛道精选信源（§3.1 AI-only route 索引），其单条内容不逐条过模型；混发噪音过滤覆盖非精选渠道。若后续要求前沿 List 内逐条过滤，需收窄 Tier 0 范围（完整版双水印/低置信桶一并评估）。
- 方案引用过滤为丢弃非有效项而非整轮失败（弱模型容错；判定的 fail-closed 已由解析/应用层保证）。
