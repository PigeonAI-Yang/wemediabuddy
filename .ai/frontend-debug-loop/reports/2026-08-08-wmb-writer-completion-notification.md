purpose: WeMediaBuddy 的 Pi 主管负责把员工工单结果接回用户可见的工作台；本轮修复 writer studio_draft 完成后“自动通知—验收—汇报”链路。

Loop:
WMB writer completion notification

Symptom:
写手已经成功保存正文并结束工单，但主管会话停在 `wmb_spawn_job`，用户必须再次追问，造成“员工做完了、主管不知道”的假完成。

Observation packet:
- url: Electron dev renderer via CDP，`http://127.0.0.1:27391/`
- viewport: 1600x960
- user action: 在 Pi dock 派 writer `studio_draft`，等待终态并观察主管会话
- expected: `job.finished` 自动进入主管，主管回读 `wmb_get_content(projectId)` 并报告
- actual before: 已有 writer task `67a37677-0da7-41f1-a6c5-1da3f5b58479` succeeded，项目 revision=2，但会话没有终态通知；日志出现 `[manager-job-notify] desk push failed: Cannot access 'runtime' before initialization`。更早的旧 main bundle 还出现 `roleId is not defined`。
- screenshot: 未持久化截图；事件缺陷用真实 transcript DOM + job/task/project 状态取证
- console/log: 见上；重启后 main/preload bundle 成功构建
- network/ws: 不涉及外部网络；使用 Electron IPC 与 Pi RPC
- dom selector: `.pi-conversation`
- state: 修复后 job `ec4153d9-04ef-4789-ae40-67f82d4cd09c` succeeded；临时项目 `a34d9e74-55a6-4629-819e-0e26fde7a132` 产生 v2、revision=2；DOM 命中 jobId 与“事件广播「写手完成 → 主管收通知」链路正常”

Hypotheses:
1. writer 实际没有完成。被 `jobsAwait.status=succeeded`、真实项目 v2、主管回读正文推翻。
2. 终态通知在 broadcast/followUp 前异常退出。日志和源码确认：`runtime` 在初始化前传入 `summarizeTask`，触发 TDZ；writer dispatch 分支还读取未定义的 `roleId`。

Bug type:
timing-stale + side-effect-missing（终态事件副作用在通知函数入口异常退出）。

Chain traced:
`JobSpawner.spawn` -> writer worker -> `job.finished` -> `notifyDeskJobEvent` -> `broadcastPiEvent` / `syncManagerTaskFromJob` / `PiRpcSupervisor.followUp` -> `pi-conversation` persistence -> `.pi-conversation` DOM。

Breakpoint:
- `src/main/job-spawner.ts`: writer 的 pipeline-owned 判断使用 bare `roleId`，运行时抛 `ReferenceError`。
- `src/main/manager-job-notify.ts`: `summarizeTask(runtime, taskId)` 位于 `const runtime` 初始化之前，运行时抛 TDZ `ReferenceError`，因此事件广播和 Pi followUp 都没发生。

Root cause:
两个局部运行时变量错误叠加：writer 派工分支引用不存在的局部变量；终态通知函数在声明 `runtime` 前读取它。TypeScript 允许这两处闭包/作用域代码通过编译，无法替代真实运行时验收。

Files read:
`src/main/job-spawner.ts`, `src/main/manager-job-notify.ts`, `src/main/ipc-jobs.ts`, `src/main/job-execute-daily.ts`, `src/main/pi-runtime.ts`, `src/renderer/pi-dock.tsx`, `tests/job-spawner.test.mjs`, `tests/job-l2-integration.test.mjs`。

Files changed:
- `src/main/job-spawner.ts`: 使用 `job.roleId`，writer 进入正确的 pipeline-owned 分支。
- `src/main/manager-job-notify.ts`: 先初始化 `runtime`，再调用 `summarizeTask`。
- `tests/job-l2-integration.test.mjs`: writer fixture 带 `projectId`；释放并等待 held worker，避免 focused suite 留下悬挂执行。
- `.ai/frontend-debug-loop/LOOP_PROFILE.md`, `.ai/frontend-debug-loop/state.json`：记录本轮链路与验收证据。

Before/after gate:
- before: 真实已有 writer task succeeded、项目已到 revision=2，但 Pi 对话无 `[JOB_EVENT]`；用户需要再次询问。
- after: 创建临时项目 -> spawn writer -> `jobsAwait` 返回 `succeeded`（job `ec4153d9-04ef-4789-ae40-67f82d4cd09c`，finished `2026-08-08T06:46:08.867Z`）-> 主管会话自动出现 `[JOB_EVENT] job.finished` -> 主管自动执行正文回读并汇报 v2 / revision=2。
- proof: 浏览器读取真实 `.pi-conversation` innerText，`containsWriterReport=true`、`containsJobId=true`；随后删除临时项目、归档测试会话、恢复原会话 `0b45f297-b528-4810-abed-cecb76dbaee4`。

Owner check:
- user-blocked-on: 修复前用户被迫追问工单结果；修复后不再阻塞。
- now-usable: writer 完成后主管自动接管终态并汇报。
- real-data-or-state: 真实 Electron、真实 SQLite 项目版本、真实 JobPool/Pi transcript；非 mock。
- loading-empty-error-states: `job.failed` 失败终态也已实测自动进入主管并汇报；本轮未改变空态/样式。
- v1-v2-baseline-preserved: 未改 Pi UI 或内容数据语义；原用户会话恢复。
- regression-risk-checked: focused job suite 11/11 通过；writer 真实端到端通过。
- would-user-return-this: no。

Verification:
- `node --test --test-concurrency=1 tests/job-spawner.test.mjs tests/job-l2-integration.test.mjs`: 11 passed, 0 failed。
- 真实 Electron smoke: writer succeeded、项目 v2 回读、主管自动 `job.finished` 汇报、DOM 命中、临时项目删除与原会话恢复。
- `npm run typecheck -- --pretty false`: 仍有 18 个既有诊断，集中在 `manager-dispatch.ts`、`agent-runner.ts`、`mcp.ts`、`manager-dock-turn.ts`、`today-run-view.ts`、`daily-control-policy.ts`、`ipc-jobs.ts`；本轮改动文件未列入诊断。

Result:
写手完成事件已恢复端到端可见性；失败终态和成功终态均可到达主管。

State update:
`state.json` 标记 `wmb-writer-completion-notification` 为 `complete`，记录 DOM、任务、项目和清理证据。

Clean completion: yes
Blocked reason: 无。全局 typecheck 的 18 个诊断不属于本轮改动文件，已保留为已知基线。