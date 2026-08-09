# WMB-4943 有效库管线：简报增量 / 今日统计 / 搜索 只路由有效资料

日期：2026-08-07 ｜ Agent：Wmb4943EffectiveLib ｜ 状态：交付（待 Main 验收）

## 交付内容

### 1. 简报增量过滤 + 透明计数行（`src/main/editorial-brief.ts`）
- 增量查询 `assembleEditorialBrief` 追加 `AND management_status != 'archived'`：已移出（资料门归档）条目不进增量块。
- `EditorialBrief.increment` 新增 `laneFiltered: { count, reasonCodes }`：`source_lane_judgments`（WMB-4941 流水表）中 `decision='irrelevant' AND judged_at >= since`（本轮窗口）的条数 + 原因码 Top3（按 count DESC, code ASC）。
- `renderEditorialBrief` 在增量块行尾追加透明行：`（本轮另有 N 条与本赛道无关，已移出有效库：reason×n、…）`，仅当 count > 0 时输出。

### 2. 今日统计只数有效 + feed 行尾计数（`src/main/workbench.ts` getToday）
- `sourcesTotalRow` / `todayRows` / `fallbackRows` 三个查询统一追加 `management_status != 'archived'`：今日 feed 与「今日新资料」统计只数有效项。
- `latestSourceDate` 回退查询也排除 archived：全部今日资料被移出时，sourcesDate 回退到最近仍有有效资料的日子。
- 返回新增 `archivedTodayCount`：当日（planDate 窗口）`management_status='archived'` 条数，供 feed 行尾「另有 N 条与本赛道无关」计数（设计 §4 / §6）。

### 3. searchSources 默认排除 + includeArchived 开关（`src/main/sources.ts` + `src/main/mcp.ts`）
- `searchSources(database, query, limit, includeArchived = false)`：默认只返回有效资料（`management_status != 'archived'`），第四个参数为开关，向后兼容既有 3 参调用。
- MCP 工具 `sources.search` inputSchema 增加 `include_archived: z.boolean().optional()` 并透传（设计 §4「含已移出」开关经 API 暴露）。

### 4. 回归：ferment/knowledge 既有排除补测试 + 补齐知识上下文排除
- `listKnowledgeSources` 默认排除 archived、`includeArchived`/`managementStatus='archived'` 显式含已移出（既有行为，补断言）。
- `getKnowledgeContext` 的 sources 查询追加 `AND management_status != 'archived'`（按主题与按 sourceId 均不回带已移出条目；设计 B3「wmb_get_knowledge_context 不含归档项」落地）。
- ferment 既有排除补断言：`seedCarryFromHighValueSources`（refreshWorkCarry）不播种已移出高价值资料；`listRediscovery`「高价值但尚未创作」不含已移出条目。

## 测试（3 个新聚焦文件，11 用例）

- `tests/brief-increment-effective-only.test.mjs`（4）：增量不含归档 id；透明计数条数 + 原因码 Top3（lifestyle_noise×2 / ad_promotion×1）+ render 文案；零判定不输出透明行；窗口外判定不计入本轮。
- `tests/today-stats-effective-only.test.mjs`（3）：今日 sources/sourcesTotal 只数有效、archivedTodayCount=1；全今日归档时回退最近有效日；空库零计数。
- `tests/search-sources-effective-only.test.mjs`（4）：searchSources 默认排除 / includeArchived=true 含已移出 / 3 参旧调用兼容；listKnowledgeSources 默认排除；getKnowledgeContext 排除归档（按主题 + 按 sourceId）；ferment 播种与 rediscovery 排除归档。

## 验证证据

- 聚焦 3 文件：`node --test tests/brief-increment-effective-only.test.mjs tests/today-stats-effective-only.test.mjs tests/search-sources-effective-only.test.mjs` → **11/11 pass**。
- 相关回归组（editorial-brief / workbench / knowledge / opportunity-pool / today-pool-view / today-desk-display / lane-gate-run / lane-gate-contract / agent-runner / intelligence-wire / sources / daily-plan-output）→ **60/60 pass**（4930 pool/chair/rail 与 4941/4942 gate 全绿）。
- 全套 `npm test` → **353/353 pass**（基线 342 + 新增 11）。
- `npx tsc --noEmit` → **exit 0**。

## 验收映射（设计 §8.1 / §9-B）

- 简报增量无归档 id：`brief-increment-effective-only` 用例 1、2。
- 今日 source 计数 effective-only + feed 行尾计数：`today-stats-effective-only` 用例 1、2（sourcesTotal=1 / archivedTodayCount=1）。
- searchSources 默认排除归档、含已移出开关：`search-sources-effective-only` 用例 1（含 MCP schema 变更）。
- 4930 pool 测试原样通过：全套 353/353 中 opportunity-pool / today-pool-view / today-desk-display 全绿。

## 范围边界（非目标遵守）

- 未动采集（scan-all / 渠道）、四问 / 机会池 / carry / plan_items / plan schema（4930 北极星零触碰）。
- 未动判定编排与水印（4942 归口）：`agent-runner.ts` 仅消费新增的 laneFiltered 渲染行（无接口变更）。
- 未做「已移出」视图 / 恢复 UI（4944）；restore 命令本体已可用。
- 未 git commit。
