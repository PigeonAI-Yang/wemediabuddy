# 智能选题流程减法实施计划

状态：实施中  
日期：2026-09-04  
里程碑：M-5396  
任务：WMB-5396–WMB-5400

## 1. 问题

创作流程的 Owner 决策点已经在 WMB-5391–WMB-5395 收敛为“批准并开始创作”与最终审稿，但智能选题后台仍存在重复控制权：Today 可直接启动情报链，Workspace Orchestrator 也可调度同一链；独立 `judge` intent 没有稳定的 Executor 消费合同；`stage_d` 以空 target/effect 成功结算，却与批准后真实启动调查的生产链并存；`daily_content_cycles`、Plan Projection 与 `plans/plan_items` 都能表达今日候选状态。

这些不是用户需要的能力，而是历史实现叠加。继续补强每条路径会增加恢复、幂等和状态一致性成本。

## 2. 决策

本轮只做减法，不新增选题能力、审批阶段、数据库、评分模型或用户工作面。

目标主链：

```text
Owner / Scheduler 发起今日选题
  → Workspace Orchestrator 接收唯一 typed intent
  → 扫描并冻结来源快照
  → Planner 判断并写入 plans / plan_items
  → Proposals 等待 Owner
  → Owner 批准并开始创作
  → 创建唯一 Content Project
  → 自动调查与写作
  → 正文待审
```

权威边界：

- Workspace Orchestrator 只负责调度、快照、租约、恢复和执行回执。
- `plans/plan_items` 是可审批选题的唯一业务事实。
- `content_projects` 与调查状态是批准后生产的唯一业务事实。
- `daily_content_cycles/targets` 仅保留现有统计与历史投影，不再拥有选题或生产推进权。
- Today 只发起或导航，不直接执行 Planner/Reporter/Writer。

## 3. 删除项

### 3.1 删除 Today 直接执行链

- `agent:start-daily-intelligence` 不再直接调用 `startWorkspaceDailyIntelligence`。
- Today 与手动入口统一提交 Workspace Orchestrator `full` intent。
- UI 读取既有 Actor/Manager 投影，不建立调用完成后的第二套本地成功真相。

### 3.2 删除无消费者的独立 Judge 语义

- 不再提交无法由 Executor 独立消费的 `judge` intent。
- “继续策划/重新策划”复用当前唯一可执行的 typed root 合同；若已有冻结快照无法安全复用，则明确重新执行完整 root，不保留悬空命令。
- 删除只为旧 `judge` 命令存在的 IPC、preload 类型或测试断言。

### 3.3 删除 Stage D 的生产所有权

- `stage_d` 不再由 daily content successor 驱动选题或内容生产。
- 删除当前空 `targets/effects` 成功结算分支及其生产调用方。
- Owner 批准后的 `approvePlanItemAndCreateProject → continueAutomaticInvestigation` 保持唯一生产入口。
- 保留 daily cycle 已有统计读模型与历史数据，不做破坏性 schema 删除。

### 3.4 删除重复 UI 动作

- Today 保留“生成/刷新今日选题”和深链 Proposals，不承载批准命令。
- Proposals 保留完整方案、批准并开始创作、拒绝；不展示无法完成的悬空继续动作。
- Studio 继续以正文/生产状态为默认，调查仅渐进披露；不恢复 WMB-5391–WMB-5395 已删除的中间按钮。

## 4. 不改范围

- 不改变候选数量、评分维度、truth gate、来源真实性或主张锁。
- 不实现自动补位、来源解释增强或新的重评模型。
- 不修改 foundation 品牌 token。
- 不删除既有调查、版本、receipt、Plan、daily cycle 历史数据。
- 不修改人工发布边界。
- 不为旧调用保留 alias、shim 或双轨兼容。

## 5. 实施任务

### WMB-5396：冻结减法合同并登记任务

交付：本计划与 WMB-5396–WMB-5400 串行任务台账。  
验证：`npm run check:task-ledger`。

### WMB-5397：统一今日选题执行入口

交付：Today 手动生成只提交 Workspace Orchestrator typed `full` intent；删除 renderer IPC 到 Planner 直跑链；Scheduler 与 Owner 共用同一 durable mailbox、request identity 和投影真相。  
验证：聚焦测试证明 UI 入口不直接调用 `startWorkspaceDailyIntelligence`，同 request 重放不产生第二个 root。

### WMB-5398：删除悬空 Judge 命令

交付：删除无稳定 Executor 消费者的 `judge` 用户命令及调用方；重新策划只走唯一可执行 root 合同；删除孤立 IPC/preload/renderer 分支。  
验证：聚焦测试证明不存在提交 `action: 'judge'` 的产品入口，重新策划请求能够进入可执行 root 且无第二套 Planner 启动路径。

### WMB-5399：移除 Stage D 重复生产所有权

交付：删除 daily content successor 的 `stage_d` 生产触发与 Executor 空 effect 分支；批准事务与自动调查成为唯一项目生产入口；daily cycle 保留只读统计。  
验证：聚焦测试证明计划批准只创建一个项目并只续派一次调查，daily cycle 不再提交 `stage_d`，Actor 不再接受空生产成功。

### WMB-5400：减法链终验与孤立代码清理

交付：删除切换后未引用的处理器、类型、文案和测试 fixture；验证 Today → Actor → Plan → Proposals → 批准 → Project → 自动调查 → 正文待审主链。  
验证：相关聚焦测试、`npm run typecheck`、`node --test tests/design-tokens-drift.test.mjs`、真实 Electron 主路径、`npm run check:task-ledger`。

## 6. 验收标准

1. Today 手动生成和 Scheduler 只进入同一个 Workspace Orchestrator mailbox。
2. 产品代码不再从 Today IPC 直接启动 Planner 情报链。
3. 产品入口不再提交悬空的独立 `judge` intent。
4. `stage_d` 不再被 daily cycle 用作项目生产推进命令。
5. Owner 批准仍是唯一生产授权，并且只创建一个项目、一个调查身份和一次 Writer 续派。
6. Today、Proposals、Studio 不增加任何新阶段或按钮。
7. 来源、评分、truth gate、主张锁、receipt、恢复和人工发布边界不退化。
8. 已有 daily cycle 数据仍可读取，且无破坏性迁移。

## 7. 停止条件

WMB-5400 通过后停止智能选题流程级改造。自动补位、来源解释增强和评分优化不属于本计划，必须由新的真实使用证据单独立项。
