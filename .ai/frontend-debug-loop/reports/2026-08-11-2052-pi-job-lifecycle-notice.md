# WMB-5194 — Pi 工单生命周期通知

## Observation packet

- Surface: 开发版 Electron Pi 对话栏
- Symptom: 主管经 `wmb_spawn_job` 派工后，员工运行期间没有可见通知；只有 canonical 终态 JOB_EVENT 后续进入会话时才可能出现结果。
- Expected: `job.started`、资源/输入等待、终态广播到达时立即出现独立「WMB 系统通知」；不截断 Pi 原生 tool stream；canonical 终态进入会话后不重复。
- Root cause: 主进程 `manager-job-notify.ts` 已广播 `type=job_event`，但 `pi-dock.tsx` 的 `onPiEvent` 消费器没有 `job_event` 分支，因此等待期广播被直接忽略。

## Repair

- `src/renderer/pi-dock-utils.ts`: 将 started/waiting/terminal 事件投影为按 `jobId` 更新的瞬态 `system_event`；canonical JOB_EVENT 到达后抑制同工单瞬态行。
- `src/renderer/pi-dock.tsx`: 独立维护 `jobNotices`，消费 `job_event`，会话新建/切换/归档/分叉时清理。
- `src/renderer/pi-dock-transcript.tsx`: 按时间合并瞬态通知与会话消息，不改原生 Pi 消息数组。
- `src/preload/preload.ts`、`src/renderer/global.d.ts`: 补齐工单事件字段类型。
- `tests/pi-message-flow.test.mjs`: 覆盖即时 started、同工单终态原地更新、canonical 去重、非 retry 锚点及 tool-result 不丢失。

## Verification

- `node --test --test-concurrency=1 tests/pi-message-flow.test.mjs`: 17/17 PASS。
- `npm run typecheck`: exit 0。
- 真实开发版 Electron：通过 `window.wmb.jobsSpawn` 派记者工单 `dfecd516-685c-4dcd-b1b3-123c350e54fd`；500 ms DOM 读回「记者工单 dfecd516 已派发，正在执行。」；工单于 2026-08-11T12:52:54.164Z succeeded 后，同一工单仅保留一行「记者工单 dfecd516 已完成，主管正在验收。」。
- 原生 tool stream 隔离由聚焦测试验证：通知合并不修改原消息数组，`finishPiTool` 仍写入 tool output。

Capability registry impact: no change. Pi operator Skill impact: no change.
