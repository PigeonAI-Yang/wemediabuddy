purpose: 今日顶部与智能体班组必须投影同一执行事实；本轮修复策划终态到主管 checkpoint 再到 Today command bar 的链路。
fails-when: 无运行 employee 时顶部仍显示“正在评估”，或 waiting_human 被错误解除主管串行锁。

Loop: WMB-5193-today-agent-status-consistency
Symptom: 今日顶部显示“正在评估新资料并更新选题池”，智能体班组无人工作。
Observation packet: 真实工作空间 `J:/PigeonYang/WeMediaBuddyData/wmb.db`；唯一 running AgentTask 为主管 `page_agents/f422d84e…`，其 agent phase=`plan_ready`，checkpoint 仍为 `running/monitor_planner`；对应 `daily_judge/cf6065b1…` 已 `succeeded/completed` 并 finished。
Hypotheses: terminal child 被 active-only selector 丢失，主管 checkpoint 漏写；Today 又把 waiting_human 串行非终态等同于 active work。
Bug type: state-missing + selector-wrong。
Chain traced: startWorkspaceDailyIntelligence -> runManagerDailyStage -> manager sync IPC -> readManagerProjection -> TodayView load -> deriveTodayRunView -> command bar。
Breakpoint: `agent:sync-manager-task` active-only child lookup；Today synthetic manager snapshot 恒 `status=running`。
Root cause: 主管同步只读取 active child，策划完成后即从选择器消失；Today 又将 waiting_human 串行锁误投影为 active work。
Files read: agent-tasks.ts; manager-orchestration.ts; manager-dispatch.ts; manager-task.ts; index.ts; today-view.tsx; today-run-view.ts; role-roster.ts; live SQLite。
Files changed: agent-tasks.ts; manager-dispatch.ts; manager-orchestration.ts; index.ts; today-run-view.ts; today-view.tsx; focused tests; TASKS.md; loop state/report。
Before/after gate: before confirmed by user observation + live DB；after focused tests 43/43 and typecheck pass。
Owner check: real Electron CDP at 1365×768: Today contains「今日可批 · 3」「当前有可批选题」and excludes「正在评估」「正在更新」；Agents five `.agents-overview-row` entries all running=false and「当前无任务」，working count 0。
Result: resolved。
State update: terminal child is recovered after manager creation time; stage completion syncs immediately; duplicate terminal sync is idempotent; waiting_human keeps serial lock without active-work UI。
Clean completion: yes
Blocked reason: none。
