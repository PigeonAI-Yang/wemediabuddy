# WMB-4945 — 端到端混合批资料门验收 + 空跑 no-op + M-4930 回归

日期：2026-08-07 ｜ 任务：WMB-4945 ｜ 前置：WMB-4944（已移出视图，done）、WMB-4932（4930 桌面收口，done）

设计：`.ai/2026-08-07-lane-relevance-gate-design.md` §8.1 WMB-4945 + §9 A–E（验收标准）。

## 交付内容

新增 `tests/lane-gate-e2e.test.mjs`（4 用例），把 4941–4944 的单元/fixture 级证据串成端到端验收
（fixture 走 dispatcher 落库，判定走 `buildDailyGateRun` → `applyDailyLaneGate` 生产编排路径）：

### 1. 混合批端到端（§9-A1 + B3 + B4）

官方信源（registry feed）+ AI 前沿 List（AI-only route）+ 博主生活动态三路 fixture，
`buildDailyGateRun` 分流：官方/AI 前沿 → Tier 0 自动相关（零模型），生活动态 → Tier 1 待判。
`applyDailyLaneGate` 一轮后：

- 生活动态 → `archived`（revision 1→2）+ 流水行 `irrelevant / lifestyle_noise / reason 非空 /
  judged_by=agent / judged_at / source_revision=2`；官方与赛道发布保持 `active`，流水行 `judged_by=system`；
  流水共 3 行（系统 ×2 + 编辑 ×1）。
- 有效库分离：简报增量块只含官方 + AI 前沿（不含已移出条目），`laneFiltered.count=1`、
  原因码 Top3 = `lifestyle_noise×1`，render 含「本轮另有 1 条与本赛道无关」；
  `getToday` 今日 feed/`sourcesTotal=2` 只数有效项，`archivedTodayCount=1`（feed 行尾计数）。

### 2. 主编覆写恢复闭环（§9-C6）

`dispatchLaneRestore`（expectedRevision=2）→ 资料回 `active`、流水追加 `editor_override / judged_by=editor`
（当前判定 = 最新行胜出）；下一轮简报增量重新可见；`shouldSkipJudgment` 7 日冷却生效，
重跑 `buildDailyGateRun` autoRelevant/pending 均为空 → 判定轮 no-op，恢复状态不被翻转。

### 3. 解析失败 fail-closed + 重判（§9-A2）

`applyDailyLaneGate` 收到损坏 gate 块 → 整轮抛错，零判定行、零归档；
下一轮同一 gateRun 重判成功（判定幂等，无重复流水行）。

### 4. 空跑 no-op（§9-E8 / PRD AC-017）

渠道就绪（x_list_bindings + succeeded 回执，0 候选 0 保存）→ 零新入库：
`buildDailyGateRun` autoRelevant/pending 均为空，`applyDailyLaneGate` no-op 零写（`source_lane_judgments` 0 行）；
空方案（items: []）经 `savePlanFromSynthesisOutput`（worker lease + 自动 grant）保存，
`dispatchCompleteAgentTask` 收尾为 `succeeded / completed`——零更新空方案成功路径不受资料门影响。

## 验收对照（设计 §9 A–E）

| 验收项 | 覆盖 |
|---|---|
| A1 混合批：生活动态 archived+原因；官方/赛道 active 且无模型调用痕迹；流水行字段齐全 | e2e 用例 1 + lane-gate-run 用例 2 |
| A2 解析失败/Pi 不可用：零归档、水印不推进、下轮重判幂等 | e2e 用例 4 + lane-gate-run 用例 3/4 |
| B3 归档项从默认列表/知识上下文/简报增量/今日 feed 消失；「已移出」可见带原因 | e2e 用例 1（简报/今日）+ search-sources-effective-only + brief-increment-effective-only + lane-gate-removed-view |
| B4 「今日新资料」只数有效 + feed 行尾计数 | e2e 用例 1 + today-stats-effective-only |
| B5 searchSources 默认排除 + 含已移出开关 | search-sources-effective-only（WMB-4943） |
| C6 恢复 → 有效库 + 简报增量可见 + editor 行 + 7 日不重判 | e2e 用例 2 + lane-gate-removed-view |
| D7 plan/carry/pool 零 schema 变更；pool/持续关注/主席回归 | 回归 suite（见下）+ opportunity-pool / ferment-aftershock-no-topic / today-desk-display |
| E8 空跑不变：无新入库资料门 no-op，判定任务照常收尾 | e2e 用例 3（succeeded 完成） |

## 验证证据

- 新增 e2e：`node --test --test-concurrency=1 tests/lane-gate-e2e.test.mjs` → **4/4 pass**。
- 回归 suite：opportunity-pool / ferment-aftershock-no-topic / today-desk-display /
  lane-gate-contract / lane-gate-run / lane-gate-e2e → **40/40 pass**。
- 全套：`npm test` → **359/359 pass**（4944 基线 355 + 新增 4）。
- `npm run typecheck`（tsc --noEmit）→ **exit 0**。

## 非目标（遵守）

- 未改任何 src 代码：本次为纯验收（测试 + 证据 + 台账），4941–4944 实现原样。
- 未做打包（packaging 非目标）；未 git commit（约束）。
- 实机 Discover 判定流水 UI（设计 §6 可后置项）不在本任务范围。

## 关联

- 数据契约/命令：WMB-4941（`sources.lane_gate` / `sources.lane_restore` + 7 日冷却）。
- 判定编排：WMB-4942（Tier 0/1 + 归档写路径 + fail-closed 水印）。
- 有效库管线：WMB-4943（简报增量/今日统计/searchSources 口径）。
- 已移出视图：WMB-4944（徽标/恢复按钮）。
