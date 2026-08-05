# WMB-4810 启动指标调度跨重启幂等证据

## 故障现象

2026-08-06 第二次启动 dev 应用后窗口不再创建：CDP `/json` 返回 0 个 page target，主进程日志出现
`UnhandledPromiseRejectionWarning: CommandDispatchError: 同一 requestId 已绑定不同命令或输入。`
调用栈：`refreshRuntime → dispatchSchedulePublishedPublicationMetricJobs → dispatchBusinessCommand → CommandDispatcher.resolveReplay`。

## 根因（先复现，后修补）

1. `dispatchSchedulePublishedPublicationMetricJobs` 每次启动对全部已发布记录使用确定性 requestId
   `publication:<id>:revision:<rev>:metrics-schedule` 重新调度（src/main/metric-commands.ts）。
2. `ActiveWorkspaceRuntime.open` 每次启动生成新的随机 `runtimeEpoch`（src/main/workspace-runtime.ts:107）。
3. `commandInputHash` 把 `runtimeEpoch` 纳入哈希（src/main/command-dispatcher.ts:275），因此跨启动重放同一
   requestId 时 inputHash 必然变化，`resolveReplay` 抛 `REQUEST_REPLAY_CONFLICT`。
4. 抛出点在 `app.whenReady` 链中 `createWindow()` 之前（src/main/index.ts:202 vs :474），启动链中断，窗口永不创建。

真实数据库读回（J:\PigeonYang\WeMediaBuddyData\wmb.db，只读）：3 条已发布记录、3 张
`*:metrics-schedule` 回执（2026-08-05T17:37:37Z，即本地 01:37 第一次冷启动写入）、12 条 pending
指标任务（1h/6h/24h/72h × 3）。第二次启动必然崩溃，与理论一致。

最小证伪复现：tests/metrics-jobs.test.mjs 新增
「startup metric scheduling stays idempotent across a restart with a new runtime epoch」——
同一数据库先后以 epoch-boot-1 / epoch-boot-2 打开两个 runtime，第二次调度在修补前抛
`REQUEST_REPLAY_CONFLICT`（已观察到 3 pass / 1 fail 的失败态）。

## 修复

- `schedulePublicationMetricJobs` 本来就按 `dedupe_key = metric:<publicationId>:<window>` 幂等；
  启动循环缺的是「派发前」的业务级判重。
- src/main/metrics.ts 新增导出 `hasScheduledPublicationMetricJobs(database, publicationId)`：
  按 dedupe_key 前缀计数，达到 WINDOWS_MS 窗口数即视为已调度。
- src/main/metric-commands.ts 启动循环执行双重护栏：窗口已齐（业务无操作）或该 requestId
  回执已记录（跨 epoch 重放必抛错）都跳过；只有窗口缺失且无回执时才派发。
- 发布记录 revision 变化时 requestId 变化，正常派发；窗口缺失且无回执时派发后由内部 dedupe
  只补缺失窗口。独立评审（reviewer：通过，confidence 0.85）指出仅靠窗口计数在 WINDOWS_MS
  未来漂移时会复现崩溃，回执护栏已按评审建议补上加固，复现测试同步扩展窗口漂移场景
  （删除 72h 任务保留回执，boot-3 不抛错、不重复派发）。

## 验证

- 复现测试修补后通过；`node --test tests/metrics-jobs.test.mjs tests/command-dispatcher.test.mjs
  tests/publishing.test.mjs tests/x-metrics.test.mjs tests/account-metrics.test.mjs
  tests/x-post-metric-snapshots.test.mjs tests/x-observation-jobs.test.mjs` → 21 passed, 0 failed。
- `npm run typecheck` → pass。
- 真实 dev 冷启动（携带崩溃前的真实数据库）：`✔ Launched Electron app` 后无任何 rejection，
  CDP `/json` 返回 1 个 page target `WeMediaBuddy | http://127.0.0.1:27391/`，
  `node scripts/smoke-renderer.mjs` → `[wmb-smoke] ok http://127.0.0.1:27391/`。

## 边界与残余风险

- 若指标任务被人为删除而回执保留（当前无此代码路径），同一 requestId 会再次响亮失败；这是可接受的保守语义。
- `commandInputHash` 纳入 runtimeEpoch 使跨重启 requestId 幂等普遍不可用；本次只修复唯一会每次启动重复派发的
  调用点。MCP 跨重启重试同一 requestId 会得到 `REQUEST_REPLAY_CONFLICT` 而非静默回放，属于可辩护的严格语义，
  如需放宽应单独立项评估。
