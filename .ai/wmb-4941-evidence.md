# WMB-4941 判定数据契约：source_lane_judgments + dispatcher 命令 + task grant 挂载

日期：2026-08-07 ｜ Agent：Wmb4941LaneContract ｜ 状态：交付（待 Main 验收）

## 交付内容

### 1. 迁移（`src/main/db/late-migrations.ts` v46）
按设计 §3.3 新增纯追加表 `source_lane_judgments`（10 列，含 decision/judged_by CHECK、source_id FK ON DELETE CASCADE、judged_at 判定轮快照、source_revision 乐观并发/审计），附 (source_id, judged_at DESC) 与 (workspace_lane, judged_at DESC) 索引。版本号取 **46**（与 Wmb4931DeskFull 协调：其 v45 保留给 work_carry_items.story_key/stage）。

### 2. 新模块 `src/main/lane-gate.ts`（4941 基础 + 4942 合流，见「协同」）
- `writeLaneJudgment`：校验 decision/reason_code（§3.2 词典）/judged_by；irrelevant 必填 reason；source 存在；`expectedRevision` 必须匹配当前 source_items.revision（否则 REVISION_CONFLICT）；同 (source_id, judged_at) 重复执行零写（判定轮幂等）。
- `readLaneJudgments` / `getLatestLaneJudgment`：追加型读取，当前判定 = 最新一行。
- `restoreFilteredSource`：archived → active + revision+1 + 追加 judged_by=editor / decision=relevant / reason_code=editor_override 流水行；已 active 时零写 no-op。7 日冷却以 `LANE_JUDGMENT_COOLDOWN_MS` + `shouldSkipJudgment` 落地（强制判定编排 4942/4945 调用）。
- reason_code 词典 8 项（4942 补充 `lane_relevant` 为 Tier 1 相关默认码）。

### 3. Dispatcher 命令（`src/main/source-commands.ts`）
- `sources.lane_gate`：批量判定（judgedBy system/agent），CommandEnvelopeV1 + CommandReceiptV1；回执含 written/archived/skipped/judgments 读回。合流后经 4942 的 `applyLaneGateBatch(transaction:false)` 执行：irrelevant 判定与归档（archived + revision+1）同事务写入，任一判定失败整批零写回滚；已 archived + irrelevant → skipped(already_archived)；同 (source_id, judged_at) → skipped(already_judged)。
- `sources.lane_restore`：主编恢复（owner_ui），回执含 source/judgment/restored + before/after revision；ok 且 restored 时广播 data-changed。
- 重放/冲突/陈旧由 dispatcher 既有语义保证（requestId + inputHash）。

### 4. Task grant 挂载（`src/main/task-grants.ts`）
- `TASK_INTERNAL_COMMANDS` 增加 `sources.lane_gate`、`sources.lane_restore`（可签发）。
- `AUTOMATIC_TASK_GRANT_SCOPES.daily_intelligence`（judge intent）增加 `sources.lane_gate`；lane_restore 属 editor intent 不进自动 scope（owner_ui 无需 grant）。

### 5. 测试
- `tests/lane-gate-contract.test.mjs`（新增，10 用例）：迁移建表/写行+读回（含归档副作用断言）/重放/同 requestId 异输入冲突/陈旧 runtime/陈旧 revision/irrelevant 缺 reason/同轮重跑零写/追加型 latest 胜出/restore 闭环+零写+冷却/自动 grant 挂载+缺 grant 拒绝。
- `tests/task-grants.test.mjs`：精确数组断言同步（TASK_INTERNAL_COMMANDS + daily_intelligence scope）。
- `tests/migrations-child.mjs`：迁移计数断言改为从 `migrations.length` 派生（对 4931 并行 v45 稳健），补 source_lane_judgments 存在性检查。

## 协同（并发 4942 Wmb4942TierGate）
4942 并行落地 Tier 0/applyLaneGateBatch 时与我共享 lane-gate.ts/source-commands.ts：
- 协商后边界：4941 = source-commands 收尾（补 restoreFilteredSource import，已落地）+ task-grants + 4941 契约测试；4942 = lane-gate Tier0/applyLaneGateBatch/listLaneGateCandidates + agent-runner。
- `sources.lane_gate` 语义从「仅落判定行」合流为「判定+归档同事务」（4942 归档写路径并入命令），契约测试已按此校准。

## 验证证据

- `node --test tests/lane-gate-contract.test.mjs tests/task-grants.test.mjs tests/migrations.test.mjs tests/command-dispatcher.test.mjs` → **22/22 pass**（合流后终态复跑）。
- `npx tsc --noEmit` → **exit 0**（含 4942 agent-runner 落地后全树干净）。

## 范围边界（非目标遵守）

- 未做 Tier 0/1 模型逻辑（4942 已并行落地其部分）；判定编排/水印（agent-runner）归 4942。
- 未做「已移出」视图/恢复 UI（4944）；restore 命令本体已可用，冷却以助手函数落地。
- 未加 MCP 工具注册（mcp-source-commands.ts 未动）；未触碰 editorial-brief/workbench/knowledge/ferment/discover/planning。
- 未 git commit。

## 交接给后续 WMB

- 4942（进行中）：Tier 1 prompt 第一关 + 编排调用 `shouldSkipJudgment` 落实 7 日冷却。
- 4944：「已移出」视图直接消费 `readLaneJudgments`；恢复按钮调 `sources.lane_restore`（owner_ui）。
- 若需 Pi/MCP 走 gate：在 mcp-source-commands.ts 注册工具（4941 未做）。
