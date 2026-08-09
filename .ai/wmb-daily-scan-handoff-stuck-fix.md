# 假运行：channel_scanned 不接力判断

Date: 2026-08-07  
Owner 现象：当前「赚钱信息差博主」· 已等待 80+ 分钟 ·「清理并保留结果」

## 这不是边界测试结果

边界测试未覆盖「扫完 → 判断」协调器掉线后的 UI 僵尸态。本事故是 **daily 编排 bug**。

## 现场数据

- task `acc809aa-…` intent=`daily_scan` status=`running` phase=`channel_scanned`
- progress: planned=5 processed=5 saved=100 currentSource=赚钱信息差博主
- receipts: 5 条齐全
- lastActivityAt ≈ 12:25，之后无判断 phase
- UI zombie 文案来自 `today-run-view.ts`（heartbeat/started 过久）

## 根因

1. **IPC 早退过宽**（`agent:start-daily-intelligence`）：  
   `if (active && (dailyRuns.has(runKey) || active.phase !== 'resume_pending')) return reused`  
   → `channel_scanned` 且 **dailyRuns 已空** 时仍直接 reused，**永不启动 judgeOnly**。

2. **看门狗只挂在判断 Pi 循环**（`startDailyIntelligence` heartbeat）：  
   扫完停在 `channel_scanned`、协调器已退出时，**没有进程再跑 stall 收尸**。

3. 定时 `scanOnly` 依赖 `onNewSources` 触发 judge；若该 Promise 丢失/失败，任务永久 running。

## 修复

1. **库内止血**：将卡住的 `acc809aa` 置 `partial`（保留资料）；清理孤立 `page_today`。
2. **IPC**：仅 `dailyRuns.has` 或非 handoff 的 running 才 reused；`channel_scanned` → **`judgeOnly: true` 重拉判断**。
3. **启动收尸**：`isOrphanChannelScannedTask`（默认 3min 无进展）在 `refreshRuntime` 时 `dispatchPartialAgentTask`。
4. 单测：`tests/daily-handoff-orphan.test.mjs` 5/5。

## 验证

```text
node --test tests/daily-handoff-orphan.test.mjs → 5/5
tsc --noEmit → 0
```

Owner：刷新今日页后假运行应消失；再点扫描应能进入判断或正常结束。
