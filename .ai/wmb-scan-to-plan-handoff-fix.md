# 扫完不进方案：现场根因与修复

Date: 2026-08-08  
Owner 截图：资料已入库 / 今日方案还没生成完 / 方案生成遇到内部错误

## 直说

**单测绿 ≠ 主路径通。** 之前 477 绿测的是门闩与子系统契约；没有拦住「扫完 100 条资料后协调器退出、判断从未启动」这条真链路。

## 现场证据（`WeMediaBuddyData/wmb.db`）

| task | intent | date | status/phase | saved | 含义 |
|---|---|---|---|---|---|
| `6252670f-…` | daily_scan | 2026-08-08 | **running / channel_scanned** | 100 | 扫完停住，未进判断 |
| `2a765228-…` | daily_scan | 2026-08-07 | partial / partial | 100 | 假运行被收成 partial，无 errorMessage → UI 回落「内部错误」 |
| `acc809aa-…` | daily_scan | 2026-08-07 | partial | 100 | `DAILY_STALL_HANDOFF` |

渠道回执 5/5 succeeded。方案 `e4727e07` 仍是 08-07 旧方案，不是本轮扫完后的新判断。

## 根因（可复现）

1. **扫完后协调器退出**，任务停在 `channel_scanned`；`scanOnly` 依赖 `onNewSources→judgeOnly`，失败/丢失即永不判断。
2. **收尸 key 写错**：`dailyRuns` 用 `path + '\\0' + date`，sweeper 用 `path + date` → 永远认为无协调器，3 分钟后直接 **partial 收尸**，而不是重拉判断。
3. **「继续生成方案」对 partial 走 `start_full`**，重扫不重判；UI 无 errorMessage 时详情回落「方案生成时遇到内部错误」。
4. **`startDailyChannelRun` 复用 `channel_scanned` 时 `shouldRunJudgment: false`**，全量路径也不会进判断。
5. **启动只恢复 `resume_pending`**，不恢复 `channel_scanned`。

## 修复

| 文件 | 改动 |
|---|---|
| `daily-start-gate.ts` | `channel_scanned` → `start_judge_only`；**partial 继续 → `start_judge_only`** |
| `daily-intelligence-channels.ts` | 复用 `channel_scanned` → **`shouldRunJudgment: true`** |
| `index.ts` | `dailyRunKey` 统一 key；MCP 就绪后 **优先 judgeOnly 接力**；scheduler 登记 `dailyRuns`；启动恢复 `channel_scanned`；IPC 传入 latest partial |
| 测试 | A3b partial→judge；IPC 接受 `dailyRunKey` |

## 验证

```text
node --test tests/basic-agent-paths.test.mjs tests/daily-handoff-orphan.test.mjs tests/daily-intelligence-channels.test.mjs tests/agent-runner.test.mjs
→ 45/45 pass
```

## Owner 操作

1. **重启/热重载主进程**（改的是 main，渲染刷新不够）。
2. 打开「今日」→ 对卡住日期点 **「继续生成方案」**（现在应走判断，不重扫）。
3. 预期：phase 进入 `judging_opportunities` / `synthesizing`，完成后机会列表更新。

若仍失败，看任务 `error_message` 真值（模型/权限/赛道门），不再是「扫完假运行」。
