# WMB-5116 Evidence — GenericEmployeeRunner 统一执行 + 角色/取消/读回修复 (CAP-027 / CAP-026 / CAP-021 / CAP-014)

Date: 2026-08-08（实机）/ 2026-08-09（收尾）
Contract: `.ai/wmb-5116-contract.md`
Design: `docs/spark/2026-08-08-agent-crew-generic-runner-repair-design.md`

## Scope

修复五类缺陷：外部 intent 可绕过角色、资料员必败、锁串扰、错误/取消终态不一致、完成无业务读回。实现摘要（均已观察）：

- 外部 spawn 去 `intent`/`planDate`：`SpawnJobRequest`/`jobs.spawn`/`wmb_spawn_job` 不再接受 `intent`（编译期与运行时 schema 双重拒绝）。
- `role-job-registry.ts` 唯一派生四角色（reporter/planner/writer/librarian × intent 与设计 §5.2 逐项相等）；`role-roster` 反向投影不受影响。
- 四角色工单统一由 `GenericEmployeeRunner` 单一入口单一生命周期执行；`createDailyJobExecutor` 删除，无 `createDailyJobExecutor` 残留。
- `waiting_resource` 两原因：实体锁冲突 `RESOURCE_LOCK_CONFLICT`、lease 忙 `RESOURCE_LEASE_BUSY`；资源释放后 FIFO 晋升。
- `succeeded`/`failed`/`cancelled`/`partial`/`needs_user` 五态由同一映射函数产出 pool 与 agent_task 终态；取消优先，abort + outcome 冲突恒为 cancelled。
- librarian：effective grant = `page_library` ∩ librarian 角色能力 ∩ precise gate（不扩权）；真实 Pi 策略会话；mutation 收据业务读回。

## Automated verification

```text
node --test tests/job-pool.test.mjs tests/job-spawner.test.mjs tests/job-l2-integration.test.mjs
→ 33/33 pass
npm run typecheck
→ pass
npm run check:capabilities
→ pass (20 commands / 17 grantable / 5 roles; capability registry no change)
```

## Live acceptance

隔离实机数据根：`J:/Users/yangda01/Temp/wmb-5116-live-cc7v44bl/data-root`（独立临时工作空间，未触碰真实数据）。

- 三角色同启（2026-08-08T17:06:51Z）：
  - reporter job `bb79…` → succeeded，业务读回 `SCAN_CHANNEL_SCANNED`（readback 字段 `scan_phase_reached`/`channel_scanned`），17:06:53。
  - writer job `b517…` → succeeded，业务读回 `CONTENT_VERSION`（`versionId` = `6af9…`），17:07:20。
  - librarian job `df7e…` → succeeded，业务读回 `NOOP_CONFIRMED`（`workspace`），17:07:21。
- running 取消：librarian job `5b92…` running（task `975d…`、lease `4571…`），17:07:51.309 → 17:07:52.534 落 `cancelled`（≈1.2s，满足 ≤5s 门）；agent_task `status`/`phase`/`errorCode` = `cancelled`/`cancelled`/`CANCELLED`；pool `employeeSnapshots` 不含该 lease（该工单 lease 归零）。
- 资料员真实 Pi：session `job-bd2d9e14-...jsonl` 为真实 Pi 会话，末尾回复无需更改，job succeeded `NOOP_CONFIRMED`。
- 实机 renderer identity smoke：`smoke-renderer` 通过，页面身份 WeMediaBuddy `<title>` + `#root`，地址 127.0.0.1:27391（先前观察）。

## Independent review

独立复审 `ReviewWmb5116`：四项原 finding 全关闭，approved。

## Residual risks（ReviewWmb5116 原文概括）

- 非 librarian 的 Pi 子进程取消采用 lease 阻写而非强杀（Pi 进程未被强制终止）。
- 非 organize 的 readback-missing 保守失败（缺业务读回时保守落失败）。
- grant 不显式 revoke（签发后无显式回收路径）。
- no-op 措辞可能保守假阴性：真实无变更但末条回复未命中标记时会保守失败，不会放宽为假成功。

## Final gate

- `powershell -ExecutionPolicy Bypass -File scripts/check.ps1` → pass（harness / line caps / ledger / intake / capability registry；package checks 按 lightweight 设计跳过）。
