# 2026-08-25 rejected-round exhausted

Loop: rejected-round-exhausted
purpose: Today轮次在5条均被否掉后应从“等待确认”转为“已耗尽”，CTA从“查看待确认选题”切为“开始新一轮收集”并放行同日新一轮任务
fails-when: pending仍计rejected、CTA仍为open_manager、exhausted未透传、running复用失效、旧plan被覆盖

Chain traced:
- 期望 否掉→ window.wmb.dismissPlanItem → ipc today:dismiss-plan-item → dispatchBusinessCommand opportunities.dismiss → dismissCarryForPlanItem → work_carry_items dismissed (+ planning_status rejected备用) → workbench.getTodayPlanExhaustion(查planning_status+work_carry) → getToday.exhaustion → TodayView(backendExhaustion优先) → deriveTodayRunView(isExhausted) → today-command-bar → DOM
- 实际旧链 pending=raw-approved（含rejected），isExhausted仅查planning_status，work_carry dismissed被忽略，Today仍显示5条草案/查看待确认选题，manager/legacy startDailyIntelligence未检查pending直接放行新任务
- 关键文件行 src/renderer/proposal-ledger.ts:240 isUnresolved/isExhaustedPlan, src/renderer/today-run-view.ts:486 exhausted, src/renderer/today-view.tsx:191 backendExhaustion, src/main/workbench.ts:160 getTodayPlanExhaustion(双检), src/main/manager-dispatch.ts:218 pending拦截, src/main/index.ts:1110 legacy拦截

Breakpoint: workbench.getTodayPlanExhaustion + TodayView backendExhaustion优先 + today-run-view exhausted分支。旧代码在renderer仅算planning_status，未读work_carry；修复归属数据+视图层，不在持久schema新增字段。

Evidence:
- DB证据: plan b879 5条 planning_status draft，work_carry dismissed 5条（object_id匹配，created 03:46/03:48，receipt opportunities.dismiss 5条05:35 ok），getTodayPlanExhaustion -> total5 unresolved0 rejected5 isExhausted true（修复后），unresolved=0/allRejected=true
- 视图证据: deriveTodayRunView混排3+2→needs_user/查看待确认选题，5全否决→exhausted/开始新一轮收集，running覆盖exhausted仍为scanning
- 去重证据: manager-dispatch pending时返回focus_existing/抛PENDING_REVIEW被index捕获，legacy路径同样拦截；exhausted时放行，double call经dailyStageLock+getActive复用保证1个
- 包证据: 待typecheck通过后打包验证

Result: pending语义已正（draft/ready only），exhausted推导已接通work_carry，CTA已切真实收集路径，未新增持久列，未删历史
