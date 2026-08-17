purpose: 智能体页必须用一致当前态回答“现在是否有任务”；本轮接通 roster/desk 活动状态到中央当前任务区。
fails-when: 任一角色卡显示工作中或等你批，但中央仍显示无进行中任务，或中央入口不能打开同一真实任务。

Loop: WMB-5314
Symptom: 主管、策划角色卡显示工作中，中央显示当前无进行中的任务。
Observation packet: 用户截图 1568x941；`.agents-role-card` 与 `.agents-filter-empty` 同屏矛盾。角色卡消费 crew projection、legacy roster、desk worker snapshot；中央只消费 crew projection。
Hypotheses: 中央 selector 漏掉未进 JobPool 的真实 AgentTask 与主管 Pi 占用。代码追踪确认。
Bug type: selector-wrong。
Chain traced: AgentTask/JobPool/Pi worker snapshot → `buildRoleRoster`/`readCrewInstanceProjection`/`jobs:pool-status` → `AgentsRosterView` → `RoleOverviewRow` 与中央 `.agents-active`。
Breakpoint: `src/renderer/agents-roster-view.tsx` 的中央空态仅判断 `activeRoleSections(projection)`。
Root cause: WMB-5273 有意保留 legacy Pi 任务可见性，但中央区未合并这条真实活动来源；desk 占用同样只在角色卡可见。
Files changed: `src/renderer/agents-roster-view.tsx`; `src/renderer/agents-roster-instances.tsx`; `tests/e2e/agents.test.mjs`; loop/ledger evidence files。
Before/after gate: before 为用户截图；after 由真实 Electron `AG-008-agents-legacy-task-avatar` 证明：JobPool 投影为空、持久记者任务 running 时，中央显示同一 task ID、工作中与摘要，空态消失，中央按钮进入同一详情，关闭后焦点归还触发按钮，page error 0。
Owner check: usable-path=yes；real-data-or-state=SQLite AgentTask + renderer IPC；loading-empty-error-states=三类当前来源均空才显示空态；baseline=JobPool 实例卡、历史区、角色卡与生命周期未改；would-user-return-this=no。
Result: PASS。
State update: done。
Clean completion: yes。
Blocked reason: none。
