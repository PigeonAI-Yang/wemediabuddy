# 零更新空 current plan 不掏空主席

Date: 2026-08-07  
Status: Owner-approved  
Task: WMB-4933

## 1. 结论

「当日 `is_current` plan」是**本轮侦察运行记录**（允许 items=0 保档），不是**主席可批清单**。  
零更新必须允许空方案成为 current；主席投影必须与 current 解耦，继续展示未终结的历史可批项。

## 2. 产品规则

1. 重新侦察 / 零更新绝不掏空主席：存在历史可批项时主区继续显示。
2. 顶部文案跟 task 真相走（「暂无新机会」）；主席内容独立。
3. 空方案 = 合法运行记录，回答「本轮无新产出」，不回答「今天无内容可批」。
4. 真正空态仅当：机会池空 **且** 无任何非空方案历史。
5. 写路径 `saveCurrentPlan` 不改；空方案照样原子替换 current。
6. 旧方案不批量进持续关注 rail。

## 3. 根因

1. `getOpportunityPool` 用 `p.is_current = 1` 代理「未终结」→ 空 current 把同日旧有内容 plan 整批挤出池。
2. `getToday.latestPlan` 只要今日 plan 存在（哪怕 0 条）就为 null。
3. `displayItems` 信空 `todayPlan`，无法回退最近非空方案。

## 4. 修复（只读路径）

### P1 正解（本任务一次做完）

1. **机会池数据源**：每个 `plan_date` 取「最近**非空**方案」（`EXISTS plan_items`，按 `created_at DESC`），再跑既有终结过滤（采纳/否决/过期/时效/同主题降权/story 去重）。
2. **`latestPlan`**：当今日 plan 不存在或 items 为空时，加载全局最近非空方案（可含同日被降级的旧 plan）。
3. **`displayItems`**：`pool>0 → todayPlan 非空 → latestPlan → []`；抽共享 helper 供 UI/测试。

### 不改

- `saveCurrentPlan` / 空方案保档  
- run-view 零更新文案  
- rail / schema

## 5. 验收

1. 同日空 current + 旧 plan items≥1 → 主席仍显示旧可批卡；顶部可为「暂无新机会」。
2. 否掉后刷新不再出现。
3. 无历史首次空跑 → 真空态不变。
4. 跨日 rollover：`plan=null` 时 `latestPlan` 仍指向最近非空。
5. `opportunity-pool` / `today-desk-display` / `workbench-rollover` 通过。
