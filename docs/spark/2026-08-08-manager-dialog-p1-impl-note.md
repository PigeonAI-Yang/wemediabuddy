# Manager Dialog P1 实现说明（2026-08-08）

## Owner locks
1. Dock 钉死主管
2. 串行唯一 ManagerTask
3. 批准回今日

## Landed
- `manager-task.ts`: ManagerTask checkpoint 模型 + 串行门
- `manager-dispatch.ts`: `dispatchManagerDailyIntelligence` 创建/聚焦；对话插入主管任务卡；legacy child 进度同步
- `agent:start-daily-intelligence`: 先走主管派单，再 bridge 旧 scan/judge 管道
- `agent:get-manager-task` / `agent:sync-manager-task`
- Today：`focusDialog` 展开右侧 dock；串行时 CTA「对话中 · 查看进度」
- 测试：manager-task / manager-orchestration / today-run-view manager CTA

## Not yet (P1.1+)
- 结构化 ManagerTaskCard 组件（现为对话文本卡）
- ManagerRunStrip 迷你条
- 真 subagent execute（仍 bridge 旧管道）
- 记者完成后自动派策划的主管策略循环（现依赖旧 handoff）

## Manual check
1. 重启应用（跑 migration v50）
2. 今日点重新侦察 → 右侧对话应出现【主管任务】卡并展开 dock
3. 再点一次 → 不双开，按钮/行为为查看进度
4. 批准仍回今日方案区
