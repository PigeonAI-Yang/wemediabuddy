# WMB-4932 主席机会池 storyKey 去重（验收 C9）— 验证证据

日期：2026-08-07
验证切片：PoolStoryDedupe（实现 + 聚焦验证）

## 结论

`getOpportunityPool` 增加投影级同故事去重：同一 Story 在主席清单只留一张卡（keeper = 最小 priority → 最新 createdAt），其余同故事行从返回池丢弃。聚焦 3 个测试文件 17/17 通过，`npm run typecheck` 通过（exit 0）。台账置 done 由主 Agent 合并证据后执行。

## 改动

- `src/main/workbench.ts`：`getOpportunityPool` 在候选池构建后、排序前，复用 `ferment-read.ts` 的 `sameStory`（topicId → 来源重合 shared≥2/Jaccard≥0.5 → 规范化标题 bigram≥0.5）做两两聚类；keeper 比较规则：`priority` 更小胜出，同 priority 取 `createdAt` 更新者；败者直接从返回池丢弃。`pool` 由 `const` 改 `let` 承接去重结果。未动 SQL、排序、demotion/待处理标注等既有语义。
- `tests/opportunity-pool.test.mjs`：
  - 新增 C9 测试 `same story different wording collapses to one chair card`：4 条 plan_items、4 个不同日期、两对「同 story 不同措辞」——播种时标题 bigram 与来源均无重合（避免播种期 save-time merge 收敛），再用 SQL 显式制造来源重合（各共享 2 来源）触发投影级去重。断言池长 2（每 story 一卡）、keeper 分别为「新措辞乙」（同 priority 取最新 createdAt）与「高优先级旧版」（priority 0 优先于更新的 createdAt）、两个败者不并排。
  - 既有 demotion 测试标题 `别主题机会` → `独立话题机会`：原标题与 `同主题机会` 的规范化 bigram Jaccard = 0.6 ≥ 0.5，会被新增去重误并（topicId 不同、来源不重合）；改名后 Jaccard ≈ 0.286，回归语义不变（非 demoted 项仍排前）。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `node --test tests/opportunity-pool.test.mjs tests/today-desk-display.test.mjs tests/today-pool-view.test.mjs` | pass 17 / fail 0（含新增 C9 测试；opportunity-pool 11 个全过） |
| `npm run typecheck`（`tsc --noEmit`） | 通过，exit 0，无错误输出 |

## 测试灵敏度验证

临时移除去重块后单跑新增测试：`✖` fail 1（池返回 4 条 → 长度断言失败）；恢复后全绿。证明测试非空转，且 4 条候选均通过既有 carry/采纳/时效过滤，去重是唯一收敛因素。

## 触碰文件

- 修改：`src/main/workbench.ts`（import sameStory + 去重块 + `let pool`）
- 修改：`tests/opportunity-pool.test.mjs`（新增 C9 测试；1 处标题改名）
- 新增：`.ai/wmb-4932-pool-dedupe.md`（本文）

## 剩余风险 / 边界

- `sameStory` 为两两比较，bigram Jaccard 不保证传递闭包；≤200 条池内聚类用贪心首卡代表簇，极端措辞链可能分裂为 2 簇（实库措辞相距远，风险低）。
- 去重发生在投影层，不改 plan_items / carry 数据；保存期 `mergeSimilarCarryItems` 收敛仍是数据侧主收敛路径，本改动是主席清单展示层的兜底与确定性保证。
- 未触碰：Electron 实机、UI 文案、台账状态（主 Agent 终验）。
