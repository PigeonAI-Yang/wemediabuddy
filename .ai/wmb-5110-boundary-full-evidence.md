# CAP-027 完整边界测试证据包

Date: 2026-08-07  
Plan: `docs/spark/2026-08-07-cap027-boundary-test-plan.md`  
Trigger: Owner 截图「扫描中 Pi worker lease 尚未释放」——此前仅 L0 不能算边界完成。

## Summary

| Layer | Result | Evidence |
| --- | --- | --- |
| L0 纯逻辑 | **PASS** | job-pool / stress / spawner / workspace-runtime |
| L1 接线 | **PASS** | `tests/worker-lease-wiring.test.mjs` 9/9 |
| L2 半集成 | **PASS** | `tests/job-l2-integration.test.mjs` 7/7 |
| L0+L1+L2 合跑 | **PASS 60/60** | 见下方命令 |
| L3 E0 P0 有头 | **PASS** | real userData CDP probe |
| 事故修复 | **DONE** | `withRuntimeWorker` → employee lease |

## Automated command

```text
node --test tests/job-pool.test.mjs tests/job-pool-stress.test.mjs tests/job-spawner.test.mjs tests/workspace-runtime.test.mjs tests/worker-lease-wiring.test.mjs tests/job-l2-integration.test.mjs
→ 60/60 pass
```

### L1 highlights
- S1/S4: `withRuntimeWorker` 仅 `employee`，禁止 desk
- S2: `ensurePi` 仅 `desk`
- S3: job-spawner 仅 employee
- D1–D4: desk∥employee 共存；双 desk 拒绝；release 不残留

### L2 highlights
- 双员工成功、第三排队晋升、同 planDate CONFLICT、cancel 无泄漏、maxWorkers 扩/拒 99、session 路径

## L3 E0 (real userData)

Probe: `.ai/wmb-5110-l3-e0-real-probe.mjs`  
JSON: `.ai/wmb-5110-l3-e2e-2026-08-07.json`  
Screenshot: `.ai/wmb-5110-l3-e0-real-scan-chat.png`

| Case | Result | Detail |
| --- | --- | --- |
| Runtime ready | PASS | root=`J:\PigeonYang\WeMediaBuddyData`, getToday ok |
| E0-01 scan then chat | **PASS** | `startDailyIntelligence` ok task running；`chatPi` ok；**无 lease 尚未释放** |
| E0-02 daily continues | PASS | dailyOk=true after chat |
| E0-03 cancel then chat | **PASS** | control cancel ok；chat2 ok；无 lease 错误 |
| leaseErrorSeen | false | — |

Note: chat 可能带 `[WMB_AUTHORITY_BLOCKED] unknown_page`（页授权另议题）；**P0 合同是 lease 占座**，该项通过。

Fixture-only probe earlier failed runtime bootstrap（假数据根）——已严格判 FAIL，不记通过。

## Code fix verified by L1+L3

`src/main/index.ts` `withRuntimeWorker`:
- before: `acquireWorkerLease(..., 'desk')` → 扫描占主编席
- after: `acquireWorkerLease(..., 'employee')` → Dock desk 可并存

## Residual

- L3 E1 工单看板 UI 连点 / 三重并发未做全自动化（计划 Sprint B）
- 假 fixture acceptance 数据根格式需与 4932 完全对齐方可无头 CI
- `unknown_page` authority 与 lease 正交，另跟

## Verdict

**边界测试 Sprint A（止血 + L0/L1/L2 + E0 P0）完成。**  
Owner 截图根因路径已有自动化回归 + 真机有头复验通过。
