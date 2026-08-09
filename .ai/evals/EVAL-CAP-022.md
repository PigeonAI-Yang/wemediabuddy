# EVAL-CAP-022

- Capability: 用户显式启动后，每个冻结 X List 仅创建 +15m/+60m/+180m 三个有界趋势观察；快照 append-only、缺失值不伪造、恢复幂等且迟到 generation 零写入。
- Task: WMB-5130
- Preconditions: 数据库含已完成快照、当前 generation 行，以及 15 条因进程退出遗留且已无 owner 的旧 generation `running` 行。
- Steps:
  1. 运行 observation 创建、claim、complete、过期、失败隔离与恢复回归。
  2. 启动 generation-safe recovery，随后在同一 generation 重复 recovery/scheduler path。
  3. 读回 job 状态、snapshot/source evidence 和 generation 字段。
- Expected observable results: 三窗口边界不变；旧 generation orphan 只转为 truthful terminal failure 一次；当前 generation 不被回收；重复执行不放大重试；已完成 snapshot/source evidence 不删除、不覆盖；迟到结果不写入。
- Command evidence: `.ai/wmb-5130-5134-evidence.md`; `.ai/wmb-5130-reconcile.json`; `tests/x-observation-jobs.test.mjs` → 16 passed, 0 failed; final `npm test` → 552 passed, 0 failed; `npm run typecheck` → pass.
- Manual/live evidence: 真实根 15 条 orphan 从 `running` 回收为 `failed`，before/after counts 与 scheduler readback 已记录；无 source evidence 丢失。
- Result: pass
- Failure reason: none.
