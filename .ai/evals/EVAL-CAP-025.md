# EVAL-CAP-025

- Capability: Owner、Pi 与外部 Agent 在同一工作空间任务上共享业务事实，但每次 worker 写入都受当前根、运行时 epoch、task grant、worker 身份和原子命令回执约束。
- Task: WMB-4805
- Preconditions: 已完成 WMB-4804 统一 `CommandEnvelopeV1` / dispatcher；存在一个绑定当前 workspace 的 running task；Owner 签发允许 `sources.upsert_batch` 且同时绑定 `pi:pi` 与 `external_agent:mcp` 的未过期 grant；Pi 持有当前 runtime 的 opaque worker lease。
- Steps:
  1. Owner UI 经 IPC 签发 grant，并从 IPC/MCP 精确回读 `TaskGrantV1`。
  2. Pi 使用 task、grant、lease 写入一条资料；外部 Agent 使用同一 task/grant 写入第二条资料。
  3. 精确回读两个 root-local 业务对象和各自 `CommandReceiptV1`。
  4. 撤销 grant 后，用相同 request/hash 重放 Pi 命令；再用新 request、改变输入、缺失/过期/错误 worker/错误 lease/另一 root 的 grant 分别尝试写入。
  5. 重启 runtime，确认旧 epoch grant 在当前读面显示 `stale`，新写入被拒绝。
- Expected observable results: 两个 worker 的成功写入均持久化并可回读；相同 request/hash 返回逐字段相同的历史回执且不重复写；改变输入返回 `REQUEST_REPLAY_CONFLICT`；所有 stale/missing/expired/revoked/wrong-worker/cross-root 尝试产生零业务写入；授权失败持久化 `sideEffectState=not_started` 的错误回执；MCP 不暴露 grant issue/revoke。
- Command evidence: `.ai/wmb-4805-task-grant-evidence.json`; `tests/task-grants.test.mjs`; `tests/command-dispatcher.test.mjs`; `tests/pi-operator-skill.test.mjs`; `node --test tests/pi-operator-skill.test.mjs tests/task-grants.test.mjs tests/command-dispatcher.test.mjs` → 9 passed, 0 failed; `npm run typecheck` → pass; `npm run build` → pass.
- Manual/live evidence: 打包产物 `out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe` 以标题 `WeMediaBuddy` 和 `#root` 启动；Today 真实界面可读，截图 `J:/Users/yangda01/Temp/omp-sshots-154ba0c974d79d4f.webp`。当前真实 workspace 没有 running task，故授权按钮按设计不显示；running-task 状态由自动化验收覆盖。
- Result: pass
- Failure reason: none for CAP-025 WMB-4805 scope. Full-suite run additionally暴露了与本任务无关的 EVAL-029 fixture、过时 Discover UI 断言和缺失 Xiaohongshu 测试二进制；详见任务证据。

## WMB-4806 precise execution grant extension

- Capability extension: Owner UI 对准确命令提议签发/撤销一次性 `PreciseExecutionGrantV1`；grant 绑定 workspace、runtime epoch、task/grant、command、inputHash、bound identity、target actor、browser profile/binding revision、expected account、allowed transition、required readback 和 expiry，并与 domain mutation 在同一 dispatcher transaction 中消费。
- Steps:
  1. Owner 对准确 website proposal 和已冻结的 X List operation 分别确认；回执必须包含唯一 `executionGrantId`，精确回读 grant 为 `consumed`，domain state 只写一次。
  2. 对相同 request/hash 重放，确认历史 `CommandReceiptV1` 原样返回且 grant 不再次消费。
  3. 分别尝试 missing、stale epoch、cross-root、wrong command/inputHash/bound identity/actor、browser binding/account/transition/readback mismatch、expired、revoked 和 already-consumed grant；每次确认 domain/platform writes 为零且错误回执为 `sideEffectState=not_started`。
  4. 令 domain handler 抛错，确认 grant 消费和 domain write 一并回滚，而错误回执在独立 transaction 持久化。
  5. 枚举 IPC、preload、MCP/Pi surfaces：issue/revoke 只存在 Owner renderer IPC；MCP 仅有 get/list read surfaces；website/X direct side-effect confirmation tool 不再暴露给 Pi/MCP。
- Command evidence: `tests/execution-grants.test.mjs`; `tests/intelligence-channel-proposals.test.mjs`; `tests/intelligence-channel-mcp.test.mjs`; `npm run typecheck && node --test tests/execution-grants.test.mjs tests/intelligence-channel-proposals.test.mjs tests/intelligence-channel-mcp.test.mjs` → 14 passed, 0 failed; follow-up frozen-field check `npm run typecheck && node --test tests/execution-grants.test.mjs` → 6 passed, 0 failed.
- Independent review: GPT slow completion - `ACCEPTABLE (no blocker)`；确认 atomic single consumption、reject-before-write、rollback、Owner-only issue/revoke surfaces 与 representative website/X migrations 符合 WMB-4806 边界。
- Pi operator Skill impact: updated - 明确 proposal-only、Owner UI exact grant、operation states、executionGrantId 与 grant 不可复用规则，并移除 website direct-add/confirm 工具表述。
- Live renderer evidence: 用户批准临时释放 `127.0.0.1:27391` 后，以 `vite.renderer.config.ts` 启动当前 renderer；`node scripts/smoke-renderer.mjs` 返回 `[wmb-smoke] ok http://127.0.0.1:27391/`，确认标题 `WeMediaBuddy`、`#root` 与正确 entry。随后已按原命令恢复 `J:\PigeonYang\skills\wemotionbuddy` 的 Python 静态服务并回读目录页。
- Result: pass.

## WMB-4807 unified write routing extension

- Capability extension: 当前范围内的 UI、MCP 与 scheduler 业务写入统一收口到 `CommandEnvelopeV1` / `CommandReceiptV1` dispatcher；代表性终点为 `src/main/business-command.ts:59`、`src/main/source-commands.ts:38`、`src/main/intelligence-channel-command.ts:89`、`src/main/x-list-command.ts:98`。
- Routed families: agent task lifecycle/recovery；sources/rankings；plans/content/studio；knowledge/canvas/suggestions/creative briefs/records；reviews/metrics；intelligence channels；X List bindings/cache/operations/observation；X observation schedule/recover/claim/finish/capture。
- Write guard: runtime write guard 拒绝 dispatcher 所有权之外对 active root SQLite 的直接 DML、DDL 与 transaction escape。
- Deferred boundary: 仅将 `src/main/ipc-publishing-results.ts` 的 browser/publication side effects 与 `src/main/data-root-selection.ts` 的 pre-runtime publication recovery 明确留给 WMB-4808。
- Command evidence: `.ai/wmb-4807-unified-write-routing.json`；`node --test tests/write-guard.test.mjs` → 1 passed, 0 failed；13-file focused regression → 37 passed, 0 failed；`npm test` → 251 passed, 0 failed；prior `npm run typecheck` → pass。
- Independent review: `Wmb4807McpCore` - `PASS`；read-only MCP/UI/scheduler source review found no in-scope blocker；代表性 canonical business routes 到达 `dispatchBusinessCommand` / `dispatchCommand`，TaskGrant IDs 对齐，runtime write guard 阻止 bypass；browser/publication side effects 为明确的 WMB-4808 follow-up。
- Pi operator Skill impact: updated - 增加 runtime-bound request/task/grant/receipt 与严禁直接 SQLite/data-root file write 的准确契约；没有新增 tool surface。
- Result: pass.
