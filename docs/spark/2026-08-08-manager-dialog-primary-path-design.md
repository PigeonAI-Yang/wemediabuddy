# 主管对话框主路径设计（点一下 = 对话里派工）

Date: 2026-08-08  
Status: Draft for Designer audit  
Owner intent source: 会话 2026-08-08  
Related:

- `docs/spark/2026-08-08-manager-as-primary-agent-design.md`（控制面目标）
- `docs/spark/2026-08-08-manager-orchestration-design.md`（MCP 工具切片）
- `docs/spark/2026-08-07-fixed-role-agents-ux-design.md`（固定角色 UX）
- `docs/spark/2026-08-07-product-form-agent-desk-constitution.md`（产品形态宪法）

---

## 0. 一句话

**点「今日情报」= 在右侧对话框给主管下工单；过程在同一对话框演完；员工是主管的 subagent；人只对主管说话、批关键节点。**

不是：按钮启动后台管道，人再去班组页盯仪表盘。

---

## 1. 问题陈述

### 1.1 今天的断裂

| 用户动作 | 系统实际 | 用户预期 |
|---|---|---|
| 点今日情报 | 主进程直跑 `daily_scan→daily_judge` | 主管接单并编排 |
| 看进度 | 今日命令条 / 班组页 | 对话框里看见过程 |
| 跟 Pi 说话 | 页面授权对话，常与流水线无关 | 和「正在干活的主管」连续对话 |
| 班组页 | 另开监工墙 | 可有，但不是主路径 |

结果：按钮路径与对话路径是两套系统，主管无法成为 Main Agent。

### 1.2 目标体感（验收叙事）

1. 人在今日点「重新侦察 / 今日情报」。  
2. 右侧主管会话自动出现 **任务卡**：目标、日期、状态=已接单。  
3. 对话流出现编排事件：派记者 → 进度 2/5 → 完成 → 派策划 → 呈报可批。  
4. 人可随时在同一对话追问、改目标、取消、批准。  
5. 班组页可同步占用状态，但人不必离开对话框也能完成监工。

---

## 2. 角色与房间（对齐宪法）

| 身份 | 产品名 | 运行时 | 职责 |
|---|---|---|---|
| 人 | 主编 / Owner | UI | 定目标、批关键节点、修卡点、担责 |
| 主管 | 主管（desk） | 主 Pi + desk lease | 接单、拆解、派 subagent、盯梢、接力、呈报 |
| 记者 | 记者 | employee lease + session | 扫描/采集有界单 |
| 策划 | 策划 | employee lease + session | 判定/方案/选题有界单 |
| 写手 | 写手 | employee lease + session | 起草有界单 |
| 资料员 | 资料员 | employee lease + session | 整理/归档有界单 |

硬规则：

- 主管 = Main；员工 = subagent。  
- **单跳有界派工**：员工不自动转派员工。  
- desk **不占** JobPool 员工槽。  
- 最终可批对象落 Today/Proposals，不落在聊天里假装完成。

---

## 3. IA：主舞台与副舞台

```
主舞台（默认始终可见）
  右侧 Dock = 主管作战室
    - 默认收件人：主管
    - 任务卡（可钉）
    - 编排时间线
    - 子任务折叠块
    - 呈报卡（可批/去今日）

副舞台
  今日页：命令条仍显示总态；点今日情报 = 向主管下单（不是旁路管道）
  智能体页：班组监工墙（席位/工单池），服务「查看全部」
  各科室页：员工专业工作面（发现/选题/创作/资料）
```

反模式：

- 把 Dock 做成 5 个聊天 App 首页  
- 进度只写命令条、对话里空白  
- 人必须打开班组页才能知道「派了没有」

---

## 4. 交互流

### F1 点今日情报（主路径）

```
[今日命令条] 重新侦察/今日情报
    → dispatchManagerTask({
         goal: 'daily_intelligence',
         businessDate,
         acceptance: '可信渠道回执 + 当日可批方案',
         suggestedPlan: ['reporter:scan', 'planner:judge_plan']
       })
    → 聚焦 Dock，收件人=主管
    → 对话插入 ManagerTaskCard（status=accepted）
    → 自动 prompt 主管主循环（或唤醒已有主管会话）
```

主管主循环（对话可见）：

1. 确认目标与验收（短气泡）  
2. `spawn_job(reporter, brief=今日扫描…)`  
3. 轮询/订阅进度 → 更新任务卡 + 时间线  
4. 记者成功 → `spawn_job(planner, brief=基于扫描写今日方案…)`  
5. 策划成功 → 呈报卡：摘要 +「查看今日方案/去创作」  
6. 失败/卡点 → 任务卡 blocked + 人可执行的修复动作

### F2 人在对话里追问

- 「扫到哪了」→ 主管读 roster/jobs/task，用摘要回答（禁止编造）  
- 「先别写方案，只扫」→ 更新 ManagerTask 策略，取消/不派策划  
- 「给记者留言：优先官方源」→ `message_job`  
- 「取消今日情报」→ cancel 子任务 + ManagerTask=cancelled

### F3 人从班组页监工（副路径）

- 看到席位占用与工单  
- 「与主管谈」= 回到 Dock 主管会话（同一 ManagerTask 上下文）  
- 不在班组页重造完整聊天客户端

### F4 遗留逃生舱

- 设置或隐藏手势：`legacy_pipeline=true` 直打旧 scan/judge  
- 默认关闭；仅故障时用

---

## 5. 对话框信息架构（组件）

### 5.1 ManagerTaskCard（任务卡）

字段：

- 标题：今日情报  
- 状态：接单中 / 执行中 / 等待你 / 已呈报 / 失败 / 已取消  
- 当前步骤：记者扫描 3/5  
- 子任务 chips：记者·跑 / 策划·等  
- 主按钮：取消 | 继续 | 查看方案（随状态变）

位置：

- 插入为对话内系统/主管消息  
- 可选「钉在 dock 顶」直到 done（不要挡输入框）

### 5.2 OrchestrationEvent（编排事件行）

轻量时间线行，例如：

- `10:21 主管 → 记者：开始扫描`  
- `10:24 记者完成 · 保存 100 条`  
- `10:25 主管 → 策划：生成方案`

### 5.3 SubagentBlock（子任务块）

- 默认折叠：角色 + 一句话状态  
- 展开：工具行/关键日志（复用 pi-tool-line 视觉语言）  
- 禁止默认展开成长日志墙

### 5.4 ReportCard（呈报卡）

- 结论摘要（3–6 条）  
- 证据/方案入口  
- CTA：打开今日方案 / 去创作 / 继续追问

### 5.5 与现有 transcript 的关系

- 主管工具调用继续走现有 tool-line  
- 任务卡/事件/呈报 = 结构化消息类型（勿全靠纯文本硬解析）  
- streaming 时任务卡状态可更新（同一 taskId 的卡片就地 patch，避免刷屏）

---

## 6. 状态模型（最小）

```
ManagerTask
  id
  goal: 'daily_intelligence' | …
  businessDate
  status: accepted | running | waiting_human | reporting | succeeded | partial | failed | cancelled
  phase: dispatch_reporter | monitor_reporter | dispatch_planner | monitor_planner | report
  children: [{
    jobId, roleId, intent, taskId?, status, brief, startedAt?, finishedAt?
  }]
  acceptance: string
  lastHumanVisibleSummary: string
  legacyPipeline?: boolean
  checkpoint
```

持久化建议（P1）：

- 用 `agent_tasks` intent=`page_agents`（或新增 `manager_run`）+ `checkpoint_json` 存 ManagerTask  
- 子任务指针指向 JobPool jobId + employee agent_task id

---

## 7. 入口与 API 契约

### 7.1 UI

```
todayCommand.primary(start|retry|continue)
  → window.wmb.dispatchManagerTask({ goal, businessDate, modules? })
  → focus dock + ensure manager session
```

### 7.2 Main

```
dispatchManagerTask
  1. ensure desk worker lease
  2. create/resume ManagerTask row
  3. append structured message to desk session transcript
  4. prompt manager skill with task payload
  5. return { managerTaskId, sessionId }
```

### 7.3 主管工具（已有 + 需补）

已有零件：

- `wmb_spawn_job` / `wmb_list_jobs` / `wmb_get_job`  
- `wmb_message_job` / `wmb_list_job_messages`  
- `wmb_list_agents_roster`  
- `wmb_get_agent_task`

P1 需补：

- `wmb_update_manager_task`（更新阶段/摘要，驱动任务卡 patch）  
- `wmb_list_manager_tasks`（恢复会话时回放）  
- 进度订阅：job/task 变更 → 主管会话系统事件（或主管循环 poll）

### 7.4 员工执行

P1 过渡：主管 spawn 后，JobSpawner.execute 可 **调用现有 daily_scan/judge 协调器**（包一层），对外仍是 subagent 语义。  
P2：execute = 真角色 Pi 长跑。

---

## 8. 主管 Skill 剧本（今日情报）

系统提示要点：

1. 你是主管，不是亲自扫全网的人。  
2. 接 ManagerTask 后先复述目标与验收（1 短句）。  
3. 先派记者；未完成前不派策划（除非人改策略）。  
4. 每 关键的进度变化必须更新任务卡摘要（工具）。  
5. 失败只报已知事实与人可动作。  
6. 结束必须呈报：结果落点（方案/机会数）+ 下一步。  
7. 禁止编造完成时间与未发生的子任务成功。

---

## 9. 视觉与文案原则（供 Designer 收紧）

- 任务卡：编辑台克制，非聊天 App 气泡皮肤狂欢。  
- 状态点：颜色+文字双编码（待命/工作中/等你/卡住）。  
- 主管默认名牌：主管；不显示模型名作主状态。  
- 文案模板：`谁 + 在干什么 + 卡在哪 + 你能做什么`。  
- 命令条与对话任务卡 **同一事实源**，禁止两处数字打架。  
- reduced motion：进度可静默更新，无闪烁脉冲。

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| Dock 变成聊天首页 | 今日仍是桌；任务卡服务主编决策；默认收件人主管 |
| 双进度源打架 | ManagerTask 为对话呈现真源；命令条只投影 |
| 旧管道与主管并行双跑 | 入口互斥；running ManagerTask 时按钮变「查看对话进度」 |
| 刷屏 | 卡片 patch + 事件节流 + 子任务默认折叠 |
| 编排回潮（自动多跳） | 员工禁止转派；只有主管可派下一步 |
| 权限放大 | 员工 grant 仍按角色；主管工具只编排不写全业务 |

---

## 11. 分期与验收

### P1 体感闭环（优先）

- [ ] 点今日情报 → 主管对话出现任务卡并自动开跑  
- [ ] 对话可见：已派记者、进度摘要、完成/失败  
- [ ] 人可在对话取消  
- [ ] 命令条与任务卡状态一致  
- [ ] 默认不再 UI 直打旧管道（逃生舱保留）

### P2 接力

- [ ] 记者成功后主管自动派策划（策略可配置）  
- [ ] 呈报卡链到今日方案  

### P3 真 subagent

- [ ] 员工 execute = 角色 Pi  
- [ ] 主管留言进入在跑员工上下文  

---

## 12. 请 Designer 审计的问题清单

1. 任务卡钉顶 vs 仅对话内联，哪个更不挡操作、更不像聊天 App？  
2. 编排事件行的密度：每条工具都上时间线，还是仅角色级里程碑？  
3. 子任务块展开深度：是否允许看员工完整 tool-line？  
4. 今日命令条在主管主路径下如何降级文案（避免「第二控制台」）？  
5. 「等待你」状态的主 CTA 文案与跳转：留在 Dock 批，还是回今日主席台？  
6. 多 ManagerTask 并行是否允许？若否，第二个点击如何提示？  
7. 与既有 fixed-role UX（收件人切换）冲突点：默认收件人是否永远钉死主管？  
8. 空态/失败态示例文案是否符合「敏锐克制主编台」？  
9. 视觉组件是否复用现有 pi-tool-line / command-bar token，还是需要新原子？  
10. 无障碍：任务卡更新的 live region 策略？

---

## 13. 非目标（本设计明确不做）

- 员工自动记者→策划链路（无主管）  
- 班组页重做成主聊天  
- 主管绕过 grant 直接全权写库  
- 一次点击启动多个互不关联后台任务且对话不感知  

---

## 14. Owner 锁定句（待 Designer 审计后确认）

> 主路径劳动者是主管 Agent；对话框是作战室；按钮是下单；员工是 subagent；人通过对话完成监工与批准。

---


## Owner locks (2026-08-08)

1. **Dock 收件人钉死主管**：人只对主管说话；员工是 subagent，不是可直呼同仁。员工名牌 = 状态投影（只读）；点名牌 = 问主管或跳智能体页，P1 不做直接员工对话。
2. **P1 串行唯一 ManagerTask**：同一时刻最多一个 active 主管任务。运行中再点今日情报 → 按钮变为「对话中 · 查看进度」，聚焦对话任务卡，不派第二单。一单内并行员工 job 仍允许。
3. **waiting_human 批准回今日**：改目标/取消/继续留在对话；批方案/批选题/去创作 → 跳 Today/Proposals 决策面。禁止聊天内完整批准 UI。

Source: Owner 会话 2026-08-08 明确确认 1是 2是 3是。
Designer review: `2026-08-08-manager-dialog-primary-path-design-review.md` M3/M4/M5.
