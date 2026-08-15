# 主管编排架构（Manager Orchestration）

Date: 2026-08-08  
Status: Owner-directed implementation slice

## 1. Goal

主管（desk / 主 Pi）在智能体班组页可：

1. **派工**：向记者 / 策划 / 写手 / 资料员发有界工单  
2. **读进度**：读班组席位、工单池、员工 task 检查点  
3. **传话**：向在办/排队工单追加主管留言（员工执行上下文可见）

非目标（本切片不做）：

- 员工自动多跳链路 / 画布编排  
- 主管直接占用员工 lease 冒充员工说话  
- 扩大主管业务写权到 `plans.save` / 正文创作

## 2. Boundaries

| 能力 | 机制 | 授权 |
|---|---|---|
| 派工 | `JobSpawner.spawn` → JobPool 员工槽 | 班组页 `page_agents` 会话；MCP 经理工具 |
| 读进度 | `buildRoleRoster` + `jobs.list/get` + `agent_tasks.get` | 只读 MCP |
| 传话 | `JobSpawner.postMessage` → 工单收件箱；running 时兼写 task progress | 班组页经理工具 |
| 员工执行写业务 | 员工 role grant（既有） | 不放大 desk grant |

契约：

- **单跳有界派工**：主管 → 一个员工角色 → 呈报/终态回池  
- desk **永不** `JobPool.submit(roleId:'desk')`  
- 传话 ≠ 切换 dock 收件人聊天客户端；是工单附言通道

## 3. MCP surface（Pi）

| Tool | MCP name | 读写 |
|---|---|---|
| `wmb_list_agents_roster` | `agents.roster` | 读 |
| `wmb_list_jobs` | `jobs.list` | 读 |
| `wmb_get_job` | `jobs.get` | 读 |
| `wmb_spawn_job` | `jobs.spawn` | 写（经理） |
| `wmb_cancel_job` | `jobs.cancel` | 写（经理） |
| `wmb_message_job` | `jobs.message` | 写（经理） |
| `wmb_list_job_messages` | `jobs.messages` | 读 |

## 4. page_agents scope

保持有限业务写权（进度/资料/建议），经理工具走 MCP 直接调度 JobSpawner，不塞进 `TASK_INTERNAL_COMMANDS` 业务命令表（避免 desk grant 与员工 grant 混淆）。

Chip：`进度/存资料/建议 · 派单走主管工具`

## 5. Acceptance

1. 班组页主管调用 `wmb_spawn_job({ roleId:'reporter', brief:'…' })` → 工单入池  
2. `wmb_list_agents_roster` / `wmb_list_jobs` 可见占用与进度  
3. `wmb_message_job` 后 `wmb_list_job_messages` 可读回；running 工单 progress 出现 `[主管]` 前缀  
4. 不能 `spawn` desk；不能无 brief 派单  
