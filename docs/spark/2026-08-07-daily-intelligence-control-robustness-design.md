# 今日情报任务控制鲁棒性设计

- 日期：2026-08-07
- 状态：设计（待 Owner 拍板后挂台账）
- 触发：用户在 `plan-synthesis` 等待 68m+ 点击「保存并停止」无响应
- 相关：`agent:control-daily`、`agent-runner` 综合环、`TodayCommandBar`、热修（立即 partial）

---

## 0. 结论先行

1. **根因不是按钮没绑上**，而是控制链路「只留言、不收尸」：`save_partial` 只写 `control_action`，综合阶段长时间不消费；UI 不 await，用户零反馈。
2. **终局合同**：任何控制点击必须在 **≤3s 内**给出 UI 态（进行中），在 **≤15s 内**进入非 `running` 终态（成功 partial/cancelled/failed），否则判 **控制失败** 并给可操作提示。
3. **权威时序**（保留热修方向，系统化）：  
   `UI click → IPC → DB control_action + 立即 UI pending → abort runtime → 同步写终态（partial/cancel）→ broadcast → UI 刷新`。  
   **终态写入不得只靠 runner 轮询。**
4. **P0 止血**（1–2 task）：控制路径同步收尾 + UI 反馈 + 僵尸 running 一键清理 + 综合 catch 认 save_partial（热修巩固）。
5. **P1 有界中断**：综合/扫描临界区可协作取消；`promptUntilSettled` 支持 abort 后必 settle；卡死检测（heartbeat 超时）。
6. **P2 自愈**：启动扫描遗留 running；可选自动 partial；更细 diagnostics。
7. 热修是 **P0 子集**，不是终局；本设计把它收编进状态机与验收，避免再靠运气。

---

## 1. 问题与故障模式

### 1.1 已发生 case（Owner 截图）

| 观察 | 含义 |
|---|---|
| 阶段 `plan-synthesis` | 已进入 Pi 综合，不在扫描 |
| 已等待 68m14s | 远超设计 10m prompt 超时；可能超时未生效、或超时后未正确收尾、或 UI 时钟只增不刷新状态 |
| 点「保存并停止」无感 | 控制未导致可见状态迁移 |
| 渠道 15/15 | 扫描侧可能已完成；卡在综合 |

### 1.2 故障模式表

| ID | 模式 | 机制 | 用户体感 |
|---|---|---|---|
| F1 | 留言式控制 | 只写 `control_action`，等 runner 读 | 点了没反应 |
| F2 | 长临界区不可打断 | `promptUntilSettled` 内不查 control | 卡死到超时 |
| F3 | abort 与终态竞态 | abort 后 catch 当失败，或不认 save_partial | 状态乱/仍 running |
| F4 | 无 runtime 的 running | 重启/崩溃后 DB 仍 running，activeDailyRuntimes 空 | 按钮可点但 abort 空操作，永远等 runner |
| F5 | UI 静默 | 不 await、不 toast、不 disable | 以为没点上 |
| F6 | 连点/双动作 | 第二次 control 时 status 已非 running → INVALID_STATE | 误报失败或吞掉 |
| F7 | 心跳虚高 | heartbeat 更新但业务不进展 | 进度条「还活着」实际卡死 |
| F8 | 超时不收敛 | timeout reject 后路径不 partial | 68m 僵尸 |
| F9 | 部分完成无证据 | partial 时无 sources 直接 VALIDATION_ERROR | 保存并停止失败 |
| F10 | 广播不同步 | 终态写了 UI 不听 event | 需手动刷新才看见 |

### 1.3 热修覆盖了什么 / 没覆盖什么

| 已热修 | 仍缺 |
|---|---|
| control-daily 对 save_partial 立即 partial | 正式状态机文档与幂等表 |
| abort 后 catch 认 save_partial | 协作取消 token 贯穿临界区 |
| UI await + 错误展示 | 僵尸任务专钮、stalled 自动策略 |
| | 超时与 wall-clock 上限 |
| | 连点/竞态单测矩阵 |

---

## 2. 目标语义

### 2.1 用户可见语义

| 动作 | 用户以为 | 系统必须做到 | 保留数据 |
|---|---|---|---|
| **保存并停止** | 停下来，别把已干活丢光 | 尽快 `status=partial`（或已有 plan 则 succeeded/partial 视校验）；停止一切 Pi/扫描 | 已入库 sources、已有 plan（若有）、channel receipts |
| **取消任务** | 不要了 | `status=cancelled`；尽快停 | 已入库 sources **可留**（本地资产），但任务记取消；不要求强留 plan |
| **超时/卡死自愈** | 系统别挂死 | 自动 partial 或 failed，并说明原因 | 同 save_partial 尽量保证据 |
| **清理僵尸** | 这个假 running 弄掉 | 无 runner 的 running → interrupted/partial/cancelled（可选） | 按用户选 |

### 2.2 系统不变量

1. **I1** `status=running` 仅当存在「可能推进的执行者」：活跃 dailyRun **或** 明确的 resume 路径 **或** 未过期 lease。否则不得长期 running。  
2. **I2** 控制点击后，DB 在 15s 内离开 running（或返回明确错误且 UI 显示）。  
3. **I3** `control_action` 是提示，**不是**唯一终态机制；终态必须有同步写入路径。  
4. **I4** abort/stop runtime 必须导致 `promptUntilSettled` **必返回**（resolve/reject），禁止挂死。  
5. **I5** partial 允许「仅有扫描证据、无新 plan」；与「完全无证据」区分文案。  
6. **I6** UI 任何控制按钮：pending 防连点；结束解除。

---

## 3. 状态机与时序

### 3.1 任务状态（沿用现枚举，补语义）

```text
running ──save_partial──► partial
running ──cancel────────► cancelled
running ──timeout/stall─► partial | failed（策略可选，推荐 partial 若有证据）
running ──crash/restart─► interrupted（启动和解）→ 用户清理或自动 partial
running ──success───────► succeeded
running ──unrecoverable─► failed | needs_user
```

### 3.2 控制时序（权威）

```text
[UI] 点击「保存并停止」
  → button disabled + 文案「正在保存并停止…」
  → IPC agent:control-daily { action: save_partial }

[Main control-daily]  （单飞：同 taskId 互斥）
  1. 校验 task 存在
  2. 若已非 running：直接返回当前终态（幂等成功）
  3. requestAgentTaskControl(save_partial)  // 审计痕迹
  4. abortDailyIntelligence(taskId)         // abortTurn + stop + 移出 map
  5. dispatchPartialAgentTask(taskId)       // 同步终态 ★权威
  6. broadcast agent_task + dataChanged
  7. return partial 任务快照

[Runner] 若仍在跑：
  - prompt 被 abort → catch
  - 读 task：若已 partial/cancelled → 直接 return，禁止再写 running
  - 若仍 running 且 control_action=save_partial → partial（双保险）

[UI]
  - 用返回快照 setTask
  - refresh Today
  - 解除 disabled；失败 toast/行内错误
```

取消路径：步骤 5 换 `dispatchCancelAgentTask`。

### 3.3 幂等

| 当前状态 | 再 save_partial | 再 cancel |
|---|---|---|
| running | 走全时序 → partial | → cancelled |
| partial | 返回 ok + 当前任务（no-op） | 可选拒绝或 no-op |
| cancelled/succeeded/failed | no-op 成功 | no-op 成功 |
| 连点 | 单飞锁，第二次等第一次结果 | 同 |

---

## 4. 长临界区可中断策略

| 阶段 | 典型耗时 | 策略 |
|---|---|---|
| 渠道扫描 | 秒～数分 | 每个 source 边界查 control；cancel/save_partial 跳出循环并收尾 |
| refresh_carry | 短 | 不中断；前后检查 control |
| **promptUntilSettled** | 最长 10m+ | **P0**：外部 abort 必 settle；**P1**：可选 5–15s 轮询 control 协作 abort |
| lane_gate 写库 | 短 | 事务内不中断；前后检查 |
| save plan | 短 | 不中断 |
| validate/complete | 短 | save_partial 已终态则跳过 |

### 4.1 Pi 运行时合同（P0/P1）

- `abortTurn` / `stop` 必须 `fail()` 所有 settleWaiters（已有 fail 路径；P0 验收：stop 后 prompt 不得 >3s 仍 pending）。
- `abortDailyIntelligence`：`abortTurn` → `stop` → `activeDailyRuntimes.delete`（热修方向）。
- 禁止只 `stop` 不 delete map 条目导致假活跃。

### 4.2 墙钟上限（推荐默认）

| 项 | 推荐 |
|---|---|
| 单次 promptUntilSettled | 10m（现有）硬超时 → 必收尾 |
| 整次 daily_intelligence wall clock | **30m**（可配置）超时 → 自动 save_partial 语义 |
| UI 等待文案 | >2m 显示「若长时间无进展可保存并停止」 |
| stalled | heartbeat 仍在但 **phase 不变 >10m** 或 **无 progress 事件 >10m** → 标 stalled + 可自动 partial |

---

## 5. UI 反馈合同

### 5.1 按钮

| 状态 | 保存并停止 | 取消任务 |
|---|---|---|
| 可点 | 默认 | 默认 |
| 点击后 | disabled +「正在保存并停止…」 | disabled +「正在取消…」 |
| 成功 | 按钮区回到 idle 次级 CTA；headline 反映 partial/cancelled | 同 |
| 失败 | 解除 disabled；command 区错误一句 + 可重试 | 同 |

### 5.2 禁止

- fire-and-forget 无 catch  
- 无 taskId 时静默 return（需提示「无运行中任务」）  
- 终态后仍显示「正在启动/综合」主态  

### 5.3 僵尸条（P0）

当 `task.status===running` 且（无 active run 或 stalled）：

- 主文案：`任务可能已失去执行者（等待 Xm）`
- 主按钮：`清理并保留结果`（=save_partial 路径）
- 次按钮：`丢弃任务`（=cancel）

---

## 6. 主进程改造点（文件/符号）

| 位置 | 改造 |
|---|---|
| `src/main/index.ts` `agent:control-daily` | 权威时序 §3.2；幂等；单飞锁 per taskId |
| `src/main/agent-runner.ts` `abortDailyIntelligence` | abortTurn+stop+delete map |
| `src/main/agent-runner.ts` synthesis try/catch/finally | 认 save_partial；若已终态禁止回写 running |
| `src/main/agent-runner.ts` heartbeat | 可选：附 phase 时钟；检测 stalled |
| `src/main/agent-tasks.ts` `requestAgentTaskControl` / `partialAgentTask` | 幂等：非 running 返回成功快照；partial 无证据时降级文案而非硬失败（产品可选） |
| `src/main/pi-runtime.ts` | 保证 stop/abort 必 settle；补单测 |
| `src/renderer/today-view.tsx` | await 控制、pending、错误、refresh |
| `src/renderer/today-run-view.ts` | stalled/zombie 投影与 CTA |
| `src/renderer/today-command-bar.tsx` | pending 文案；disabled 联动 |
| 启动路径 `dispatchRecoverInterruptedAgentTasks` | 扩展：遗留 running 标 interrupted 或可清理 |

---

## 7. 分阶段落地与建议 Task 链

建议里程碑：**M-4990 今日情报控制鲁棒性**

| Task | 阶段 | 内容 | 依赖 |
|---|---|---|---|
| **WMB-4990** | 文档 | 冻结本设计 + 挂链 | — |
| **WMB-4991** | P0 | control-daily 权威时序（abort+同步 partial/cancel+幂等+单飞） | 4980 |
| **WMB-4992** | P0 | UI：pending/错误/refresh；无 taskId 提示 | 4980 |
| **WMB-4993** | P0 | runner catch 双保险 + 已终态禁止回写；巩固 abortDailyIntelligence | 4981 |
| **WMB-4994** | P0 | 僵尸 running 检测 CTA + 启动 interrupted 和解（最小） | 4981,4982 |
| **WMB-4995** | P1 | 墙钟/ stall 检测 → 自动 partial；prompt 超时必收尾验收 | 4983 |
| **WMB-4996** | P1 | 扫描循环边界协作中断 | 4983 |
| **WMB-4997** | P1 | pi-runtime stop/abort settle 单测 + control 竞态单测 | 4981 |
| **WMB-4998** | P2 | 更细 diagnostics、控制审计日志、可选自动清理策略开关 | 4985 |

**P0 完成定义**：synthesis 中点击保存并停止，**15s 内** UI 显示非 running，且不出现 68m 挂死。

---

## 8. 验收矩阵（≥10）

| # | 场景 | 期望 |
|---|---|---|
| 1 | synthesis 中点保存并停止 | ≤3s pending；≤15s partial；Pi 停 |
| 2 | synthesis 中点取消 | ≤15s cancelled |
| 3 | 扫描中点保存并停止 | 跳出扫描，partial，已扫 sources 保留 |
| 4 | 无 taskId 点按钮 | 明确错误，不静默 |
| 5 | 任务已 partial 再点保存并停止 | 幂等 ok，不抛 INVALID_STATE 吓人 |
| 6 | 连点 3 次保存并停止 | 单飞，一次终态 |
| 7 | 先保存并停止再取消 | 第二次 no-op 或明确已结束 |
| 8 | 重启后 DB running、无 runner | 显示僵尸；清理并保留结果 → 非 running |
| 9 | prompt 超时 | 必离开 running；优先 partial |
| 10 | wall clock 30m | 自动收尾 |
| 11 | partial 时仅有 sources 无 plan | 允许 partial，文案说明 |
| 12 | partial 时完全无证据 | 明确失败或 failed，不假 partial |
| 13 | abort 后 runner catch | 不覆盖已写终态 |
| 14 | UI 收到 broadcast | 不需手刷即更新 |
| 15 | 保存并停止失败（模拟 DB） | UI 显示错误，按钮可再点 |

---

## 9. 非目标与风险

### 非目标

- 重做情报算法/四问  
- 保证 partial 一定有高质量 plan  
- 多窗口分布式锁（单机单实例即可）  
- 杀进程级强退 OS（先 RPC abort/stop）

### 风险

| 风险 | 缓解 |
|---|---|
| 同步 partial 与 runner 双写 | 终态后 runner 所有写路径先读 status |
| abort 丢会话 | partial 不依赖完整 plan；有 receipts 即可 |
| 误 partial 证据不足 | I5/用例 11–12；文案诚实 |
| 热修与设计分叉 | 4981 以本时序为权威，对照热修收敛 |

---

## 10. 待 Owner 拍板（≤5，带推荐）

1. **整次任务墙钟上限**：推荐 **30 分钟** 自动按 save_partial 语义收尾。  
2. **stall 自动还是仅提示**：推荐 **>10m phase 无进展 → 自动 partial**（可先做提示+按钮，P1 再自动）。  
3. **取消是否保留已入库 sources**：推荐 **保留**（本地资产），任务标 cancelled。  
4. **僵尸默认按钮**：推荐主按钮 **清理并保留结果**（partial），次 **丢弃任务**。  
5. **是否挂 M-4990 台账立即开工**：推荐 **先 4980–4984 P0**，再 P1。

---

## 附录 A — 与热修对照

| 热修点 | 设计归宿 |
|---|---|
| control-daily 立即 partial | §3.2 步骤 5；Task 4981 |
| abortTurn+stop+delete | §4.1；4983 |
| catch 认 save_partial | §3.2 runner 双保险；4983 |
| UI await | §5；4982 |

## 附录 B — 关键符号（现状）

- `ipcMain.handle('agent:control-daily')` — `src/main/index.ts`
- `abortDailyIntelligence` / `activeDailyRuntimes` — `src/main/agent-runner.ts`
- `requestAgentTaskControl` / `partialAgentTask` — `src/main/agent-tasks.ts`
- `dispatchPartialAgentTask` — `src/main/agent-task-commands.ts`
- `PiRpcSupervisor.promptUntilSettled` — `src/main/pi-runtime.ts`
- `TodayView.onSecondary` — `src/renderer/today-view.tsx`
- `runningSecondaries` — `src/renderer/today-run-view.ts`
