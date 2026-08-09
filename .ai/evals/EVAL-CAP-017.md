# EVAL-CAP-017

- Capability: X List 作为工作空间内、账号与 BrowserProfile 绑定的情报来源；显式读写均遵循 dispatcher/grant/operation 边界，失败不跨根污染或自动重试。
- Task: WMB-5130
- Preconditions: 当前根存在已验证的 X List binding；观察任务中包含旧 runtime generation 留下的 `running` 行。
- Steps:
  1. 执行 X List channel、operation、session、cache、visibility 和 workspace boundary 套件。
  2. 用新 runtime generation 启动观察恢复；再次执行同一恢复路径。
  3. 读回 operation/job 状态和既有 source evidence。
- Expected observable results: List 身份继续由 workspace/profile/account/List ID 约束；旧 generation 只被回收一次；当前 generation 不被误收割；重复恢复不产生新平台动作、source 或 receipt；失败隔离在原 operation。
- Command evidence: `.ai/wmb-5130-5134-evidence.md`; `tests/x-list-channel.test.mjs`; `tests/x-list-operations.test.mjs`; `tests/x-list-session.test.mjs`; `tests/workspace-platform-boundaries.test.mjs`; final `npm test` → 552 passed, 0 failed; `npm run typecheck` → pass.
- Manual/live evidence: `.ai/wmb-5130-reconcile.json` 记录真实根 15 条无活跃 owner 的 observation `running` 行被准确回收，source evidence 未删除；Electron Today/Studio 实机读回无 error boundary。
- Result: pass
- Failure reason: none.
