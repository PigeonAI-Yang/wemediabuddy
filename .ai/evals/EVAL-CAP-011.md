# EVAL-CAP-011

- Capability: 已记录发布 URL 的指标任务按 1h/6h/24h/72h 窗口创建、去重、恢复；启动恢复必须安全幂等，不重复写、不伪造准时快照、不自动重发。
- Task: WMB-4810
- Preconditions: 数据库存在已发布且带 external_url/published_at 的 publication；上一次启动已为其创建 4 个窗口指标任务并持久化 `publication:<id>:revision:<rev>:metrics-schedule` 命令回执；下一次启动使用新的 runtimeEpoch。
- Steps:
  1. 以 epoch-boot-1 打开 runtime，执行启动调度，确认创建 4 个窗口任务并写入 1 张调度回执。
  2. 停止 runtime，以 epoch-boot-2 重新打开同一数据库，再次执行启动调度。
  3. 观察第二次调度是否抛出 `REQUEST_REPLAY_CONFLICT`，以及任务数、回执数是否保持不变。
  4. 在真实数据根（3 条已发布记录、3 张既有调度回执、12 条 pending 任务）冷启动完整桌面应用。
- Expected observable results: 第二次启动调度返回 created=0 且不抛错；指标任务仍为 4、调度回执仍为 1；真实应用启动链越过 refreshRuntime 完成窗口创建，CDP 可读回 `WeMediaBuddy` 页面，无未处理 rejection。
- Command evidence: `.ai/wmb-4810-evidence.md`; `tests/metrics-jobs.test.mjs`; `node --test tests/metrics-jobs.test.mjs tests/command-dispatcher.test.mjs tests/publishing.test.mjs tests/x-metrics.test.mjs tests/account-metrics.test.mjs tests/x-post-metric-snapshots.test.mjs tests/x-observation-jobs.test.mjs` → 21 passed, 0 failed; `npm run typecheck` → pass.
- Manual/live evidence: 真实 dev 冷启动后 `✔ Launched Electron app` 无新增 `UnhandledPromiseRejection`；CDP `/json` 返回 1 个 page target `WeMediaBuddy | http://127.0.0.1:27391/`；`node scripts/smoke-renderer.mjs` → `[wmb-smoke] ok http://127.0.0.1:27391/`。
- Result: pass
- Failure reason: none for CAP-011 WMB-4810 scope. `commandInputHash` 纳入 runtimeEpoch 导致跨重启 requestId 幂等普遍不可用的深层语义未改动，详见 `.ai/wmb-4810-evidence.md` 残余风险节。
