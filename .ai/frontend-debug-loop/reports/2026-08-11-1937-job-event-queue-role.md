purpose: Pi Dock 必须让真人发言与自动工单通知在同一任务链中保持可辨识；本轮修复 queue_update 到队列 DOM 的消息归属。
fails-when: canonical JOB_EVENT 仍出现“下一轮”人工语义，或真人粘贴 JOB_EVENT token 被误判为系统通知。

Loop: WMB-5192-job-event-queue-role
Symptom: 自动记者工单终态在 Pi 原生队列中显示为“下一轮”。
Observation packet: 用户实机截图 428x849；`.pi-native-queue` 底部可见 `[JOB_EVENT] job.finished`，标签为“下一轮”。
Hypotheses: `src/main/index.ts` 在 queue_update 广播前调用 `extractVisiblePrompt`，canonical 信封被不可逆剥离；renderer 因而无法调用精确 parser，只能走普通 follow-up 分支。
Bug type: mapping-wrong。
Chain traced: `manager-job-notify.ts notifyDeskJobEvent` -> `PiRpcSupervisor.followUp` -> Pi `queue_update` -> `index.ts` adapter -> `pi-dock.tsx` state -> `pi-dock-transcript.tsx` queue DOM。
Breakpoint: `src/main/index.ts` queue_update adapter。
Root cause: `src/main/index.ts` 在可信 renderer 边界之前把 canonical 信封降成可见正文；`pi-dock-transcript.tsx` 因而只能将其按普通 follow-up 标为“下一轮”。
Files read: manager-job-notify.ts; pi-transcript-projection.ts; index.ts; pi-dock.tsx; pi-dock-transcript.tsx; pi-dock-utils.ts; job-event-envelope.ts; focused tests。
Files changed: src/main/index.ts; src/renderer/pi-dock-utils.ts; src/renderer/pi-dock-transcript.tsx; src/renderer/styles-pi.css; tests/job-event-envelope.test.mjs; TASKS.md; loop state/report。
Before/after gate: before = Image #1 中 `data-kind=follow`/“下一轮”；after = 428x849 live Vite 组件读回 `kind=system_event`、`label=WMB 系统通知`、`userBubbleCount=0`、`internalEnvelopeVisible=false`，截图 `J:/Users/yangda01/Temp/omp-sshots-15537713e3f8c85b.png`。
Owner check: 原用户阻塞已消除；canonical production builder envelope 走真实组件/CSS；普通人工 follow-up 与 honeypot 保持原语义；26/26 聚焦测试与 typecheck 通过；would-user-return-this=no。
Result: fixed。
State update: completed, attempts=1。
Clean completion: yes
Blocked reason: none。
