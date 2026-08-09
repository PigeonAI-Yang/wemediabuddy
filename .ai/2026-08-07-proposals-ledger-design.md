# 选题台账（编辑部提案夹）前后端设计

Date: 2026-08-07  
Status: Owner-approved  
Tasks: WMB-4946 (BE) · WMB-4947 (FE) · WMB-4948 (P1)

## 1. 结论

新建一级导航 **「选题」**（编辑部提案夹 / 选题台账），插在 **发现与创作之间**。

| 对象 | 含义 |
|---|---|
| 方案 | 整叠递案 `plans` |
| 选题/机会卡 | `plan_items` 单条 |
| 选题台账 | 全量决策记录（今日可批 / 待处理·搁置 / 已采纳 / 已否掉 / 已过期） |
| 今日主席 | 台账「今日可批」的投影子集 |

硬边界：资料库=入库资料；发现=资讯流；创作=已立项；今日=办公台**不是档案**。  
**禁止**今日页历史抽屉。

## 2. IA

导航：今日 → 发现 → **选题** → 创作 → 发布 → 结果

五个 tab：

1. 今日可批  
2. 待处理/搁置（跨日未终结，默认不消失）  
3. 已采纳  
4. 已否掉  
5. 已过期  

今日页：主席 + 持续关注 + 一条入口「选题台账 · N」（N=今日可批+待处理）。

跳转：

- 选题 → 创作：`createProjectFromPlanItem`  
- 选题 → 否掉：`dismissPlanItem`  
- 选题 → 主题：`topicId` 存在时  
- 今日 → 选题：入口条  

## 3. 后端

新文件 `src/main/proposals.ts`：

- `getProposalLedger(db, { planDate, tab?, limit?, now? })`  
- `summarizeProposalLedger(db, { planDate, now? })` → counts only  

数据源：与机会池共用「每 `plan_date` 最近**非空**方案」行集。  
从 `workbench.ts` 提取：

- `latestPlanItemRowsByDate`  
- `dedupeOpenProposals`（sameStory）  

状态判定 `dispositionOfPlanItem`（短路顺序）：

1. adopted — 有项目或 carry done  
2. dismissed — carry dismissed  
3. expired — carry expired 或时效窗过  
4. open — planDate===today → today；else shelved  

IPC（只读）：

- `proposals:get`  
- `proposals:summary`  

写路径复用：`today:create-project` / `today:dismiss-plan-item`。  
`DataChangedScope` 增加 `proposals`；dismiss/create 广播含 `proposals`。

## 4. 前端

- `View` 增加 `proposals`  
- `proposals-view.tsx` + `styles-proposals.css`  
- 开放 tab 复用 `Opportunity`；终态用紧凑行  
- 今日入口条在 CommandBar 与 grid 之间  
- `onDataChanged` 监听 `proposals|today|studio`  

文案：台账内用「选题」，不出现「机会」「仍在发酵」。

## 5. 任务

| Task | 范围 |
|---|---|
| WMB-4946 | 后端 + IPC + helper 提取 + tests |
| WMB-4947 | 前端页 + 导航 + 今日入口 |
| WMB-4948 | P1 分页/批量/恢复/Pi 精化 |

## 6. 非目标

- 今日抽屉/第二列表  
- schema 变更  
- 改 saveCurrentPlan / 空方案保档  
- P0 分页交互  

## 7. 验收（P0）

1. 侧栏「选题」在发现与创作之间  
2. 五 tab 计数/空态正确  
3. 今日可批 ≡ pool∩今日（同源）  
4. 今日入口 N=today+shelved，无抽屉  
5. 采纳/否掉闭环正确  
6. 无 schema 变更；池相关测试不破  
