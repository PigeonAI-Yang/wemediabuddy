# Desk 经理 + 员工工单运行时（M-5110 / CAP-027）

- 日期：2026-08-07
- 作者：DeskSubagentDesigner + Main
- 状态：Owner 批准实施（会话锁定）；实施中
- 依赖：CAP-026 角色×Capability（M-5100 done）
- 与 canonical 关系：落实 `2026-08-07-role-permission-design.md` §11 P1「worker 池化 + 单跳派工」；不重做权限表

## 结论

Desk（主对话 Pi）= **经理席**：编排、派单、盯单、对用户说话。  
reporter / planner / writer / librarian = **员工 subagent**：一次性工单（job），独立 session，角色过滤 grant，默认 `maxWorkers=2` FIFO。  
业务写仍走 CommandDispatcher + 实体锁；单一 `wmb.db`。  
验收：派单时 desk 可交互；两不冲突工单并发；冲突 `plans.save` → `JOB_LOCK_CONFLICT`；看板同屏 desk + 多 running。

## 拓扑

```
Desk Pi (交互 session，不占员工槽)
    │ spawn/await/cancel
    ▼
JobPool (maxWorkers=2, FIFO)
    │
    ▼
JobSpawner → PiRpcSupervisor × N
    session: sessions/job-<jobId>.jsonl
    grant: ensureAutomaticTaskGrant(..., roleId)
    write: dispatcher + planDate/projectId lock
    ▼
wmb.db
```

## IPC

| 通道 | 作用 |
| --- | --- |
| `jobs:spawn` | `{ roleId, intent?, brief, businessDate?, planDate?, projectId? }` → job |
| `jobs:list` | 工单列表 |
| `jobs:await` | 等终态（事件驱动） |
| `jobs:cancel` | 取消 |
| `jobs:get-pool` | 槽位与队列摘要 |

## 非目标

- 不多 Electron 窗口；不分叉 DB；无无界并行；不重做 CAP-026；员工不互聊；不做自动多跳编排图。

## 任务

见 `PLAN.md` M-5110 / `TASKS.md` WMB-5111–5115。

## 验收（可证伪）

1. maxWorkers=2 时 3 工单：2 running + 1 queued；释放后 FIFO 晋升  
2. multi-lease：`getWorkerSnapshots()` 可 >1；`isCurrentWorkerLease` 按 leaseId  
3. spawn 创建 job session 路径约定 + role grant 接线  
4. roster/jobs 投影可显示多 running  
5. 同 planDate 实体锁：第二写冲突码 `JOB_LOCK_CONFLICT`  
6. 聚焦测试绿 + evidence 文件  
