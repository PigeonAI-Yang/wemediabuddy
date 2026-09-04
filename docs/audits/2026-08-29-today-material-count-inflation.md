# WeMediaBuddy「今日资料」计数膨胀审计

审计日期：2026-08-29（上海日）  
审计窗口：`2026-08-28T16:00:00.000Z` ≤ `collected_at/created_at` ≤ `2026-08-29T15:59:59.999Z`  
保护对象：正在运行的 WMB PID 616904；主管任务 `52968c9f-3291-47cc-b606-d57f170a76e5`。全程只读；未启动、停止、点击、重试、清理或修改产品代码。

## 1. 结论先行

**已确认的是计数语义/范围缺陷，不是当前数据存在 500+ 条稳定 ID 重复。**

Today 页的“今日新资料/今日资料”不是“内容机会”数，也不是去重后的 manager 业务机会数。它读取 `source_items` 在上海日窗口内、`management_status != 'archived'` 的**原始行数**，使用 `COUNT(*)`，而资料列表本身只取 `LIMIT 500`。最新只读快照为 **518 行**；前一快照为 **516 行**，增长发生在 live run 继续写入期间。

在最新快照中，518 行同时对应 518 个 `source_items.id`、518 个 `canonical_url`、518 个 `original_url`；没有 canonical/original URL 重复组。因此“500+”主要是实际落库的来源记录量和 UI 口径宽泛造成的认知差异，不是 join fan-out 或 URL 重复把同一资料乘出来。

主管任务 `progress.opportunityCount` 最新读数为 **111**（此前 live 快照约 102/107）；它是主管检查点中“已成功子任务数”的运行进度字段，不等于 `source_items` 行数，也不等于已持久化的当日 `plan_items` 数。当前数据库中 `plans(plan_date='2026-08-29') = 0`、当日 `plan_items = 0`，所以该 111 仍是运行中进度，不是最终今日机会台账。

**live run 可以继续。** 当前证据显示写入回执可读回、稳定身份没有重复行爆炸，主管心跳/状态仍在运行；不要因这个显示问题中止、重启、去重或删除资料。显示口径应在运行结束后另行修复或澄清。

## 2. 症状与应有语义

### 症状

用户看到 Today 页“今日资料”500+，而 manager 侧机会读数约 107；最新只读快照为 518 与 111。资料列表最多显示 500 条，但计数可继续大于 500。

### 应有的指标边界

| 指标 | 应表示的业务对象 | 不应与其混用 |
| --- | --- | --- |
| 今日新资料 | 上海日内新落库的唯一来源资料（至少按 stable source identity 去重） | 内容机会、研究声明、内容版本、Job 数 |
| 内容机会 | `plan_items` 经 recommendation projection 过滤后的可批机会（今日/跨日分别统计） | 原始来源资料行 |
| manager `opportunityCount` | 当前主管检查点的运行进度字段；本版本由已成功 children 数推导 | 最终机会台账 |
| `research_claims` | 研究声明/证据行 | 资料或机会 |
| `content_versions` | 内容版本行 | 资料或机会 |

按当前实现的既有注释，“有效资料库”是“未 archived 的资料”；若产品确实要展示原始入库量，518 是该口径的正确读数，但标签容易被理解成“机会数”。若产品要求“唯一业务资料”或“本次 manager 资料”，当前查询范围不够窄。

## 3. 观察数据包

### 3.1 当前 Today source scope

窗口：上面的上海日 UTC 边界；过滤：`management_status != 'archived'`。

| 项目 | 最新 bounded snapshot |
| --- | ---: |
| `source_items` 原始行数 | **518** |
| distinct `source_items.id` | **518** |
| distinct `canonical_url` | **518** |
| distinct `original_url` | **518** |
| distinct 非空 `content_fingerprint` | **0**（本窗口行均使用 URL 身份） |
| distinct `title` | **515** |
| active（未 archived） | **518** |
| archived | **0** |
| created 在同一上海日窗口 | **518**（前一快照已精确读回 516/516；随后 live run 新增 2 条） |
| created before today / historical rows | **0** |
| list projection rows | **最多 500**（SQL `LIMIT 500`） |

所有最新快照行的可见 provenance/status 聚合为：`client_label='WMB research'`、`feed_id IS NULL`、`verification_status='pending'`、`management_status='active'`。因此它们会被当前过滤器全部纳入，但无法仅凭 `source_items` 行把 518 条分配回官方站点、X List 或知乎 feed。

### 3.2 重复/超额构成

| 稳定身份/字段 | 重复组 | 超额行 | 最大组 |
| --- | ---: | ---: | ---: |
| `canonical_url` | 0 | 0 | — |
| `original_url` | 0 | 0 | — |
| `content_fingerprint` | 0（非空值为 0） | 0 | — |
| `title`（仅标题相同，不代表同一资料） | 3 | 3 | 2 |

标题重复的 3 组各只有 2 行，不能证明稳定身份重复；其余 515 个标题是 distinct。故可确认的 duplicate/excess 是 **3 行标题层超额**，不是 407 行或数百行 URL/ID 重复。

### 3.3 研究/内容/任务参照量

同一 UTC 窗口只读读取：

| 表/字段 | 数量 | 实际含义 |
| --- | ---: | --- |
| `research_claims` created | 168 | 研究声明/证据行 |
| `content_versions` created | 419 | 内容版本行 |
| `jobs` created | 6510 | 各类运行/归档/媒体等 Job，不是资料数 |
| 当日 `plans` | 0 | 当前日尚无持久化 plan |
| 当日 `plan_items` | 0 | 当前日尚无持久化 plan item |

### 3.4 写入回执、重试与 partial/failed

`sources.upsert_batch` 回执在本窗口按 task 状态聚合为：

| task 状态 | receipts | result items | readback items |
| --- | ---: | ---: | ---: |
| research succeeded | 185 | 185 | 185 |
| research failed | 146 | 146 | 146 |
| research partial | 383 | 383 | 383 |
| 合计 | 714 | 714 | 714 |

把回执中的 source ID 限制到当前 518 个 Today source 后：

- `created=true`：518 个 upsert 事件、518 个 distinct source ID；
- `created=false`：47 个更新事件，涉及 41 个 source ID；最大同一 source 的 upsert attempts 为 5；
- 这些重复事件没有形成额外 `source_items` 行，而是命中了既有 URL 身份并更新 revision；
- 当前 source ID 与 task 结果的 distinct 关联为：research partial 284（65 tasks）、succeeded 161（20 tasks）、failed 102（31 tasks），不同状态之间有跨任务重叠，联合集合仍为 518。

因此：**retry/partial/failed 会留下已经成功写入的资料，并使回执事件变多；但没有证据表明它们把同一 canonical/original URL 插成多行。** 当前 `sources.upsert_batch` 的 result item 数与 readback item 数逐状态完全相等，未观察到 `JOB_READBACK_MISSING` 导致的额外 source 行或二次插入。

独立的 `source_scan_receipts` 也不支持“daily scan retry 造出 518 行”：本窗口 x_lists 为 35 个 failed receipt、0 saved；知乎为 2 个 succeeded receipt、2 saved、1 个 distinct source。518 行的可见来源标签是 `WMB research`，不是这些扫描回执直接列出的 1 个知乎来源。

## 4. 端到端链路与精确证据

### 4.1 Repo UI → service/store → SQLite

1. `src/main/workbench.ts:262-268` 将 `planDate` 转为上海日 UTC 边界，并定义 `effectiveFilter = "management_status != 'archived'"`。
2. `src/main/workbench.ts:273-278` 直接执行：
   ```sql
   SELECT COUNT(*) AS total FROM source_items
   WHERE management_status != 'archived'
     AND collected_at >= ? AND collected_at <= ?
   ```
   同时用相同过滤器读取资料行并 `ORDER BY collected_at DESC LIMIT 500`。
3. `src/main/workbench.ts:279-291` 在有当日 rows 时令 `sourcesTotal = sourcesTotalRow.total`；因为本次 `todayRows.length > 0`，最近日期 fallback 没有参与计数。
4. `src/renderer/today-view.tsx:120-136` 仅在 `sourcesDate === planDate` 时把 `today.sourcesTotal` 传入 Today run view；`src/renderer/today-view.tsx:631-643` 将 overview metrics 接入 `TodayCommandBar`。
5. `src/renderer/today-run-view.ts:339-345` 的运行态统计也把该值标为“今日新资料”；`src/renderer/today-command-bar.tsx:47-52` 的经营概况指标同样把该值标为“今日新资料”，`69-80` 直接渲染 metric value。
6. `src/main/workbench.ts:465-480` 的 `getTodayOverviewMetrics` 又以同一上海日边界、同一 `management_status != 'archived'`、同一 `COUNT(*)` 计算 overview 的 sources value。因此不是单一 renderer 偶发显示错误，而是 service/read model 的共同口径。

### 4.2 source upsert 是否会因 retry 插出重复行

`src/main/sources.ts:114-123` 先对 URL canonicalize，并按 `canonical_url = ?` 查询既有行；`165-177` 命中后 UPDATE 同一 ID；`180-191` 只有不存在时才 INSERT 新 ID。初始 schema `src/main/db/migrations.ts:56-62` 还对 `canonical_url` 与 `content_fingerprint` 建立 UNIQUE 约束。当前 DB 的 518 个 canonical URL 全 distinct，与代码行为一致。

### 4.3 manager 107/111 的真实语义

`src/main/manager-dispatch.ts:175-181` 在主管检查点写入：

```ts
opportunityCount: next.children.filter((child) => child.status === 'succeeded').length
```

这是 manager checkpoint 的 succeeded-child 进度，不是 `source_items` count；当前 manager 仍是 `running/dispatch...`，且当日尚无 `plans/plan_items`。另一路 `src/main/today-recommendation.ts` 的 Today “内容机会”是 recommendation projection 的 `todayReady + carriedReady`，其对象是可批 `plan_items`，不能拿来与资料行数做一比一校验。

## 5. 假设检验

| 假设 | 结论 | 证据 |
| --- | --- | --- |
| 历史 rows 被 Today 混入 | **否** | 当前日窗口内 518 行均为当日创建；当日有 rows 时 fallback 不执行；historical=0。 |
| retry/job duplication 造出额外 source rows | **否（就稳定身份而言）** | 47 个 update events/41 个重复 source ID，但 canonical/original 重复组为 0；upsert 命中同 ID 更新。 |
| partial/failed 任务全部回滚，因此不应计数 | **否** | partial/failed research 回执仍有已成功写入的 source rows；其 rows 只要 active 就被 Today broad filter 纳入。 |
| join fan-out | **否** | Today count 直接 `FROM source_items`，没有 join。 |
| 缺少 DISTINCT/grouping | **语义上确认，数值重复未确认** | SQL 使用 `COUNT(*)`；若未来同一 stable identity 多行，会直接放大。但本快照 canonical/original/id 均 518 distinct，所以本次 500+ 不能归因于现存 URL/ID 重复。 |
| UI 读错了 manager opportunity source | **确认存在指标单位错觉** | “今日资料”取 source_items；manager progress/Today opportunities 取 child/checkpoint 或 plan-item projection，业务对象不同。 |

## 6. 已确认根因、贡献因素与用户影响

### 已确认根因

Today 的 sources metric 绑定了“当日 active `source_items` 原始行数”，而不是唯一业务资料的 stable identity，也不是 manager 的机会/plan item。实现同时将展示行数限制为 500，但没有把计数限制为 500 或显示“518 条（当前展示 500 条）”。因此 518 与约 107/111 是不同数据层、不同业务对象的数值，直接比较必然产生“膨胀”观感。

### 贡献因素

1. 过滤器只排除 `archived`，518 行全部 `verification_status='pending'` 仍进入统计；没有 verification、manager run 或 task ownership 限制。
2. 518 行均标记 `WMB research` 且 `feed_id=NULL`，当前缺少可读的 channel/feed provenance，无法从 source row 判断是否属于本次 manager 采集。
3. partial/failed research 任务的已提交 source 写入不会因任务终态而消失；这是“资料已入库”的合理结果，却会让 raw source count 高于最终机会数。
4. 仅有 3 个标题重复组（3 行超额），属于低量内容相似/标题复用信号，不是 500+ 的主因。

### 用户影响

- 用户把“已收集资料量”误读为“可执行机会量”，会误判系统漏筛或重复采集。
- 资料流列表最多 500 行，metric 可显示 518，造成计数与可见列表进一步不一致。
- 当前 manager 仍在运行，111 不能被当作最终机会台账；在 plan 持久化前比较该数字会放大不确定性。
- 未发现需要立即停止 live run 的数据损坏证据；真正风险是决策口径误读，而非当前 DB 已发生稳定 ID 批量重复。

## 7. 安全立即动作与最小修复边界

### 现在允许的动作

- **允许 live run 继续**，不要停止/重启 PID 616904，不要取消主管任务，不要 seed/reset/delete/deduplicate。
- 在 run 终态前，把 518 视为“当日 active research source rows”的运行中快照；不要把它与 111 当作同一指标。
- run 终态后再做一次只读快照，确认最终 plan/recommendation 与 manager 进度的归属关系。

### 建议的最小修复边界（本次不实施）

1. 先决定产品语义：若要 raw ingest count，将标签改成“今日新增来源记录”，并明确 `displayed ≤ 500`；若要业务资料数，则定义 stable identity（URL，缺失时 fingerprint）并使用明确的 distinct 口径。
2. 若要显示“本次 manager 输入资料”，必须增加可审计的 run/task/source provenance 读模型；不能用 `client_label` 或标题猜测，也不能用删除重复行掩盖范围问题。
3. “内容机会”继续只从 recommendation/`plan_items` projection 读取；不要让 sources metric 复用 manager `progress.opportunityCount`。
4. 对 partial/failed 的已提交 source，明确其是否属于资料库；不要在 UI 层按任务 status 做猜测性排除。

## 8. 运行结束后的验证场景

只读验证应覆盖同一 `planDate`：

1. `getToday.sourcesTotal` 等于 `source_items` 当前日、未 archived 的 raw count；`sources.length` 不超过 500，并明确展示截断关系。
2. 同时读取 distinct stable identity count，确认 raw 与 unique 的差异；当前基线预期为 518/518（后续值随 live run 变化）。
3. 单独读取 recommendation 的 `todayReady + carriedReady`、持久化 `plan_items`，再读取 manager checkpoint，确认三者不被命名成同一“机会”指标。
4. 汇总 `sources.upsert_batch` 的 result items/readback items 与 `created` 标记；任何 readback 缺失、同 stable identity 多 ID、或 URL UNIQUE 冲突才进入数据完整性故障处理。

## 9. 安装包与仓库源码一致性

安装包检查对象：`J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar`，版本清单为 WeMediaBuddy `0.3.0`；其 renderer entry 为 `index-DkL9wNeE.js`，`index.html` 显式加载该文件。

- 安装包 `.vite/build/index.js:3764-3778` 的 minified `getToday` 仍清楚包含：上海日边界、`management_status != 'archived'`、`SELECT COUNT(*) AS total FROM source_items`、资料 `LIMIT 500`；语义与仓库 `src/main/workbench.ts:262-291` 一致。
- 安装包 renderer 资源没有发现 `.map` 文件，只有 hash 后的 JS/CSS 与静态资源；因此不能把 minified renderer 行号一一映射回 repo TSX 行号。hash/构建产物与 repo 文件名不同是预期的安装包差异，但 main count logic 已通过 bundle 字符串/结构核对。
- 结论不依赖安装包 renderer 的 source map：repo UI bridge (`today-view.tsx`/`today-command-bar.tsx`) 与安装包 main bundle 的 count path 均指向同一 raw `COUNT(*)` semantics。

## 10. 最终判定

- **UI number semantics：** 上海日窗口内、未 archived 的 `source_items` 原始行数；最新快照 518，资料列表最多 500。
- **Distinct current-day count：** 518 个 source IDs / 518 个 canonical URLs（前一 bounded snapshot 为 516，live run 期间增长 2）。
- **Duplicate/excess：** canonical/original URL 0 组、0 超额；标题 3 组、3 行超额、最大组 2；无证据表明 500+ 是稳定身份重复。
- **Root cause：** `getToday` 与 overview metrics 共同使用 broad `COUNT(*)` source-row query，并将其展示为“今日资料”；它与 manager checkpoint opportunity progress、recommendation plan items、research claims/content versions不是同一业务对象。
- **Live run safety：** **安全继续（Yes）**；保持只读观察，不做中止或数据清理。
- **持久报告：** 本文件。
