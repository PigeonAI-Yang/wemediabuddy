# 主管主 Agent + 员工 Subagent 架构

Date: 2026-08-08  
Status: Owner intent lock（对齐讨论；分阶段实施）  
Supersedes partial reading of: `2026-08-08-manager-orchestration-design.md`（该文是工具面切片，本文是控制面目标）

## 1. Owner 意图（准绳）

人点「今日情报」时：

1. **任务先到主管**（desk / 主 Pi / 主 Agent）  
2. 主管以 **subagent** 形式把活分给记者/策划/写手/资料员  
3. 主管 **持续监控** 子任务进度  
4. 子任务完成后，主管再 **串下一步**（例如扫完 → 派策划写方案/选题）  
5. 人只定目标、批关键节点、处理卡点；不自己当流水线调度器

类比：当前 coding harness 里 Main 调 `task` subagent；WMB 里 **主管 = Main，员工 = subagent**。运行时是 Pi，理论上支持多 worker / 多 session；缺的是 **主管控制面**，不是 Pi 能不能开多个进程。

## 2. 现状 vs 目标

| | 现在 | 目标 |
|---|---|---|
| 点「今日情报」 | UI/调度器 **直打** `daily_scan`→`daily_judge` 流水线 | 先建 **主编任务** 交给主管；由主管派 subagent |
| 主管 | 主 Pi 对话 + 少量 MCP 派工工具 | **编排主循环**：接单→拆解→派工→盯梢→接力→呈报 |
| 员工 | JobPool 工单 + 独立 lease（骨架 execute 可秒成功） | 真正的 Pi subagent 会话，按角色 skill/grant 干活 |
| 进度 | 人看班组页 / 命令条 | **主管**聚合子任务状态，对人只报关键节点与卡点 |
| 接力 | 代码里写死 scan→judge | 主管策略：扫完再派策划；可插入人批 |

一句话：现在是 **管道驱动**；你要的是 **主管驱动**。

## 3. 目标控制环

```
人：点「今日情报」/ 说「今天按标准流程走」
        │
        ▼
  主编任务 ManagerRun（intent=page_agents 或 manager_daily）
        │  持有：目标、日期、验收标准、子任务表
        ▼
  主管 Pi（desk lease，主会话）
        │
        ├─ 派 subagent 记者  → Job/Task(daily_scan 或 reporter 有界单)
        │     └─ 主管 poll/subscribe 进度
        ├─ 记者终态成功
        │
        ├─ 派 subagent 策划 → Job/Task(daily_judge / 方案合成)
        │     └─ 主管 poll/subscribe 进度
        ├─ 策划呈报方案
        │
        └─ 主管向人呈报：可批摘要 / 卡点 / 下一步建议
```

硬规则：

1. **单跳有界**：主管一次只给一个员工一张有界单；串行接力由主管做，不由员工自动转派。  
2. **desk 永不进 JobPool 员工槽**。  
3. **人可打断**：取消、改目标、卡点修复后「继续」。  
4. **授权不放大**：员工 grant 仍按角色 intent；主管不能借员工身份写超权命令。  
5. **呈报回主席台**：最终可批对象落 Today/Proposals，不落在聊天里假装完成。

## 4. 与 Pi 能力的映射

| Coding harness | WMB |
|---|---|
| Main agent | 主管 Pi（desk） |
| `task` subagent | 员工 Pi worker（employee lease + session） |
| 主会话监控 | 主管工具：`list_jobs` / `get_job` / `get_agent_task` / roster |
| 主 → 子 指令 | `spawn_job` + `message_job`（附言/纠偏） |
| 子完成回传 | job 终态 + task result/progress；主管读后决定下一步 |

Pi 已支持多 session / 多 lease；要补的是：

- **ManagerRun 状态机**（主编任务对象）  
- **入口改道**（今日情报 → 先到主管）  
- **员工 execute = 真 Pi 长跑**（不是默认秒成功）  
- **主管系统提示词/Skill**：何时派谁、如何验收、如何对人呈报  

## 5. 入口改道（关键产品行为）

### 5.1 今日情报

- **旧**：`agent:start-daily-intelligence` → 直接 scan/judge 协调器  
- **新**：`agent:start-daily-intelligence` → 创建/恢复 `ManagerRun` → 唤醒主管主会话并注入：

```
目标=今日情报
日期=...
验收=渠道回执可信 + 当日方案可批
建议拆解=记者扫描 → 策划判定/方案
```

主管在主循环里再 `spawn_job(reporter)` / 盯梢 / `spawn_job(planner)`。

### 5.2 兼容闸

过渡期可双模：

- `manager_orchestrated=true`（默认，Owner 目标）  
- `legacy_pipeline=true`（逃生舱，直打旧协调器）

## 6. ManagerRun 最小数据（建议）

```
ManagerRun
  id, businessDate, goal, status
  phase: accepting | dispatching | monitoring | handoff | reporting | done | blocked
  children: [{ jobId, roleId, intent, status, taskId }]
  lastReportToHuman
  checkpoint
```

持久化：可先挂 `agent_tasks`（intent=`page_agents`/`manager_daily`）+ checkpoint_json；不必先上新表。

## 7. 分阶段实施

### P0 — 语义对齐（已部分具备）
- 主管命名、班组页有限权、派工/留言 MCP 工具  

### P1 — 控制面骨架（下一步该做）
1. `ManagerRun` 创建/恢复 API  
2. 今日情报入口改道到主管  
3. 主管 Skill：标准「今日情报」拆解剧本  
4. 主管循环：spawn → poll → 下一步 / 呈报  

### P2 — 真 subagent 执行
1. JobSpawner.execute 注入真实员工 Pi runner  
2. 角色 skill + session 隔离  
3. 主管 `message_job` 能影响在跑员工  

### P3 — 多剧本
- 「只扫不写」「扫完等人批再策划」「选题交给写手」等  

## 8. 明确不做（防漂）

- 员工之间自动转派  
- 班组页变成聊天首页  
- 主管绕过 grant 直接写全库  
- 把旧 daily 协调器逻辑复制进五个角色 prompt 各写一份（编排中心必须在主管）

## 9. Acceptance（P1 完成时）

1. 点今日情报后，先出现 **主管任务/主管会话**，而不是立刻只有 `daily_scan` 孤儿协调器。  
2. 主管工具能派记者并读到进度。  
3. 记者成功后，主管再派策划（可自动策略，但决策点在主管）。  
4. 人在班组/今日能看到「主管在盯哪些子任务」。  
5. 旧流水线仍可经逃生舱触发。

## 10. Owner 确认句

> 今日情报不是一条死管道，而是主管接单后的 subagent 编排；人指挥主管，主管指挥员工并盯进度、做接力。

---


## Owner locks (2026-08-08)

1. **Dock 收件人钉死主管**：人只对主管说话；员工是 subagent，不是可直呼同仁。员工名牌 = 状态投影（只读）；点名牌 = 问主管或跳智能体页，P1 不做直接员工对话。
2. **P1 串行唯一 ManagerTask**：同一时刻最多一个 active 主管任务。运行中再点今日情报 → 按钮变为「对话中 · 查看进度」，聚焦对话任务卡，不派第二单。一单内并行员工 job 仍允许。
3. **waiting_human 批准回今日**：改目标/取消/继续留在对话；批方案/批选题/去创作 → 跳 Today/Proposals 决策面。禁止聊天内完整批准 UI。

Source: Owner 会话 2026-08-08 明确确认 1是 2是 3是。
Designer review: `2026-08-08-manager-dialog-primary-path-design-review.md` M3/M4/M5.
