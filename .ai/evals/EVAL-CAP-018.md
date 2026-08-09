# EVAL-CAP-018

- Capability: 每个 workspace 是隔离 data root，任一时刻仅一个 ActiveWorkspaceRuntime；调度、Pi、BrowserProfile、IPC/MCP 与迟到事件均绑定 workspace/runtime generation。
- Task: WMB-5130
- Preconditions: 根中存在前一 runtime generation 遗留的 X observation rows；当前 runtime 具有不同 generation。
- Steps:
  1. 执行 workspace registry、switch、runtime、profile、confirmation 与 platform-boundary 套件。
  2. 以当前 generation 执行启动恢复并进入 scheduler tick。
  3. 重复恢复，检查旧 generation、当前 generation、业务对象和 lease 状态。
- Expected observable results: 只回收旧 generation 的无主 `running` 行；当前 generation 的活动行保持不变；同一启动不重复 recover；无跨根 source/snapshot/receipt 写入；workspace 与 profile identity readback 保持一致。
- Command evidence: `.ai/wmb-5130-5134-evidence.md`; `tests/workspace-runtime.test.mjs`; `tests/workspace-switch.test.mjs`; `tests/workspaces.test.mjs`; `tests/workspace-profile-ensure-upgrade.test.mjs`; final `npm test` → 552 passed, 0 failed; `npm run typecheck` → pass.
- Manual/live evidence: `.ai/wmb-5130-reconcile.json` 记录真实根回收前后状态计数；真实 Electron 使用当前根启动并加载 Today/Studio，renderer 无 error boundary，Pi dock 可用。
- Result: pass
- Failure reason: none.
