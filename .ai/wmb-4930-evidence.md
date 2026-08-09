# WMB-4930 Today editor-desk MVP — 聚焦验证证据

日期：2026-08-06
验证切片：Wmb4930Finish（收尾：修红测试 → 聚焦验证 → 证据 → TASKS 回执）

## 结论

聚焦 3 个测试文件 16/16 通过，`npm run typecheck` 通过，renderer 用户文案无「仍在发酵」。MVP 交付物齐备，台账置 done。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `node --test tests/opportunity-pool.test.mjs tests/today-pool-view.test.mjs tests/today-desk-display.test.mjs` | pass 16 / fail 0（含重写后的两个 merge 测试） |
| `npm run typecheck`（`tsc --noEmit`） | 通过，无错误输出 |
| grep `仍在发酵` `src/renderer` | 0 匹配（仓库其余命中仅为台账/设计稿/旧会话记录，非用户文案） |

## 失败根因与测试改写（tests/opportunity-pool.test.mjs）

- **重叠来源合并测试**：原标题 `同一故事 措辞甲/乙/丙` 规范化 bigram Jaccard = 0.714 ≥ 0.5，`saveCurrentPlan` 末尾新增的 `mergeSimilarCarryItems(database)` 在播种期就已把甲、乙并入丙；测试再手动调用时仅剩 1 条 active 行 → 返回 0。改写：标题改为两两 Jaccard ≤ 0.0625 的同故事不同措辞（`配偶签证收入要求观察` / `担保人收入证明细则` / `居住时长门槛核对`），播种后 3 条全 active；再用 SQL 显式制造来源重合（a=[sA,sB,sC] b=[sB,sC,sD] c=[sC,sD,sE]）并拉开 last_seen，手动 `mergeSimilarCarryItems` 返回 2，keeper 为最新一条（丙），旧两行 dismissed 且 reason 含「合并为同一故事」。此路径专测来源重叠分支。
- **标题相似合并测试**：原标题对 `英国移民规则又更新：HC 259` vs `移民规则又更新了吗：Statement of Changes` 规范化后 bigram Jaccard = 0.107 < 0.5，任何阶段都不会命中 `sameStory`（非保存期合并所致）。改写为真实命中标题路径的对子 `英国移民新规出台：配偶签证收入门槛调整` vs `英国移民新规：配偶签证收入门槛再调整`（Jaccard 0.778，来源无重合），并断言**保存期合并**语义：先播种甲并把其 carry `last_seen_at` 拉到 30h 前，再播种乙 → 乙保存末尾的 save-time merge 将甲置 dismissed（reason 含「合并为同一故事」）、乙保留 active；随后手动再触发返回 0（幂等）。
- `disjoint stories never merge` 与 `listFermentingBundle why-watching` 等其余测试未动，保持通过。

## 触碰/核验文件

- 修改：`tests/opportunity-pool.test.mjs`（仅上述两个测试的断言与标题）
- 核验通过（主 Agent 已实现，本切片复核）：`src/main/ferment-read.ts`（sameStory/normalizeStoryTitle/hasWhyWatching/defaultReason）、`src/main/ferment.ts`（mergeSimilarCarryItems by sameStory、listFermentingBundle why-watching 过滤）、`src/main/planning.ts`（carry reason 语义化 + 保存末尾触发合并）、`src/renderer/today-view.tsx`（displayItems 显式判空兜底、poolBadges(planDate)）、`src/renderer/today-pool-view.ts`（pending badge）、`src/renderer/today-view-panels.tsx`（持续关注 rail 文案/空态）、`src/renderer/pi-dock.tsx`（上下文描述「持续关注（有后续影响）/可批方案」语义）
- 测试原样通过：`tests/today-pool-view.test.mjs`（3/3）、`tests/today-desk-display.test.mjs`（3/3）

## 剩余风险

- 保存期合并 keeper 按 `last_seen_at`（插入即 now）排序；同毫秒级同时播种多条相似行时平局顺序由 rowid 决定，keeper 措辞不保证是最新写入的措辞（故事身份仍收敛为 1 行，语义不受影响）。属既有设计属性，非本任务回归。
- 主席去重（验收 C9）依赖保存期 carry 合并收敛，而非机会池投影级 storyKey 去重——MVP（§8.1）接受。
- 本切片为聚焦验证：实机 Electron 探针（验收 A1 跑批中旧方案可见、B7 采纳/否决实机交互）与 A2/A3 观感项归主 Agent 终验；dismiss 不复活与池排除已有测试覆盖。
