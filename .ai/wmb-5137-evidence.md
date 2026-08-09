# WMB-5137 Evidence（Backend 部分：ImplementReporterFailureFix）

日期：2026-08-09
范围：`src/main/generic-employee-runner.ts`、`src/main/role-job-registry.ts`（同域 helper）、
`src/main/daily-intelligence-channels.ts`、`tests/generic-employee-runner.test.mjs`、
`tests/daily-intelligence-preflight.test.mjs`。
Renderer（agents-roster-view 冲突投影）证据由并行任务 FixRosterConflictProjection 单独入账，
本文件 Backend 部分不覆盖。

## 1. 故障 fixture（2026-08-09 11:41 daily_scan）

- X 预检链：`identifyXAccount`（`src/main/platforms/x.ts`）对
  `SideNav_AccountSwitcher_Button` `waitFor({state:'visible', timeout:15_000})`，
  未登录/未恢复会话时抛**无 code** 的 timeout `Error`；`resolveBrowserConfig`
  （`daily-intelligence-channels.ts`）对非 NEEDS_USER 错误**前置 rethrow**。
- 复现 fixture（stub 浏览器会话，无真实平台发布/互动/网络）：预检链在
  `requireBrowserProfile` 处抛非用户态 `VALIDATION_ERROR`（`安装级浏览器配置路径尚未初始化。`，
  与 identifyXAccount 超时同为「非用户态预检异常」；真实超时路径需要真实浏览器会话）。
  DB：有效配方 + 已校验浏览器绑定 + 启用 X List + 官网来源（trialRead 指向非公网地址，
  扫描零网络）。

## 2. Before 证据（修复前 HEAD 4e60185 运行同一 fixture）

facts-probe 输出（修复前）：

```json
{
  "outcome": { "status": "failed", "code": "VALIDATION_ERROR", "message": "安装级浏览器配置路径尚未初始化。" },
  "agentTask": { "status": "running", "errorCode": null, "errorMessage": null },
  "receipts": []
}
```

- 单渠道预检失败 rethrow → 整个工单 `failed`（复现 11:41「其余可运行渠道不执行」）。
- **agent_task 停留 `running`**（runner catch 未写终态，等重启/orphan sweeper 兜底）。
- **渠道回执为 0**（X 预检失败无任何可追踪回执）。

## 3. After 证据（修复后同一 fixture）

facts-probe 输出（修复后）：

```json
{
  "outcome": { "status": "partial", "code": "CHANNEL_SCAN_FAILED", "message": "来源检查未全部成功；已基于库存资料完成判断。" },
  "agentTask": { "status": "partial", "errorCode": "CHANNEL_SCAN_FAILED", "errorMessage": "来源检查未全部成功；已基于库存资料完成判断。" },
  "receipts": [
    { "module": "x_lists", "status": "failed", "errorCode": "VALIDATION_ERROR", "errorMessage": "X 浏览器预检失败：安装级浏览器配置路径尚未初始化。" },
    { "module": "official_web", "status": "failed", "errorCode": "WEBSITE_URL_NOT_PUBLIC", "errorMessage": "WEBSITE_URL_NOT_PUBLIC: 不支持非公开网站地址：127.0.0.1。" }
  ]
}
```

- X 预检失败 → 逐 X 来源**可追踪 failed 回执**（渠道标识 + code + message），工单不再整体 failed。
- official_web 渠道继续扫描（本例因 fixture 故意用非公网地址落 failed；聚焦测试 T-A 用
  stub 扫描验证官网**成功**场景 → partial）。
- **agent_task 终态即时同步**（partial + CHANNEL_SCAN_FAILED，同一 `mapOutcomeToTerminal` 映射）。

before/after 判定探针（断言修复后行为，HEAD 上失败、修复后通过）：
`git worktree add --detach HEAD` 后于 HEAD 上运行 → FAIL（outcome=failed，见上）；
同一探针于修复树运行 → PASS。探针为证据工具，已从永久套件移除（依赖进程级浏览器 registry
初始化状态，永久套件改用确定性注入 seam）。

## 4. 修复内容

1. **角色语义错误码**：`role-job-registry.ts` 新增 `REPORTER_SCAN_FAILED` /
   `PLANNER_JUDGE_FAILED` / `WRITER_DRAFT_FAILED`（JOB_ERROR_CODES 稳定码表）与
   `ROLE_TO_FAILURE_CODE` + `roleFailureCode(roleId)`；runner catch 无 code 异常按角色域
   映射，**不再跨域借 LIBRARY_ORGANIZE_FAILED**；原始 `error.message` 原样保留。
2. **X 预检渠道隔离**：`resolveBrowserConfig` 不再 rethrow——非用户态异常折叠为
   `BrowserPreflight.preflightError`，逐 X 来源落 `failed` 回执（`recordPreflightFailure`，
   message 前缀「X 浏览器预检失败：」+ 原文）；NEEDS_USER 类仍走既有 needs_user 回执；
   official_web 等渠道继续；全部 blocked 由既有 `readDailyReceiptAggregation` 做
   needs_user/failed 聚合。新增 `dependencies.preflight` 注入 seam（复用 scanWebsite/collectX
   既有注入模式）。
3. **job 失败即时终态**：runner 非 abort catch 对仍 running 的 created task 立即
   `writeAgentTaskTerminal`（failed + 同一映射 errorCode + 原始 message），不依赖
   重启/orphan sweeper；已终态任务跳过（双终态防护）；取消优先（abort 门）先行不变。
4. 未触碰 renderer / capability registry / page-authority / 产品合同 / Pi Skill。

## 5. 聚焦测试

本任务约束命令（仅本文件，跳 formatter/lint/全量）：

```
node --test --test-concurrency=1 tests/generic-employee-runner.test.mjs
→ 8/8 pass
```

主 Agent 历史 8 文件批次回归（完整命令；该次运行 98/98 pass，时点
`tests/generic-employee-runner.test.mjs` 为 7 用例，T8 为本任务追加）：

```
node --test --test-concurrency=1 tests/generic-employee-runner.test.mjs tests/daily-intelligence-preflight.test.mjs tests/daily-intelligence-channels.test.mjs tests/job-pool.test.mjs tests/job-spawner.test.mjs tests/job-scan-judge-race.test.mjs tests/job-l2-integration.test.mjs tests/agents-roster-conflict.test.mjs
→ 98/98 pass
```

- `tests/generic-employee-runner.test.mjs`（8/8）：T1 四角色错误码映射（LIBRARY_ORGANIZE_FAILED
  仅剩 librarian）；T2/T3 真实 runner no-code 异常 → REPORTER_SCAN_FAILED /
  PLANNER_JUDGE_FAILED + message 原文保留；T4 带 code 异常透传回归；T5 即时终态
  （running→failed + 同一映射 code + message + 双终态防护）；T6/T7 取消优先；
  **T8 真实 runner 接线**（新增，关闭复审 F1）：有效官方 profile 下经
  `createGenericEmployeeRunner` → `runScanPolicy` → `startDailyChannelRun` 真实创建
  daily_scan 任务，测试覆盖实例 `bindWorkerTask` 在 onTaskReady 已置 createdTaskId 之后
  抛无 code 异常 → outcome failed / REPORTER_SCAN_FAILED / message 原文，且按
  businessDate+intent 读回任务即时 failed + 同一 errorCode + 同一 message；该终态唯一
  写入点即 runner catch 的 createdTaskId 写终态段（抛点在进度/收尾 dispatch 之前，
  领域原语无其他终态写入），删该段任务保持 running → T8 断言失败，runner 接线可证伪。
- `tests/daily-intelligence-preflight.test.mjs`（2/2）：X 预检失败 + 官网成功 = partial +
  回执齐全（含渠道标识与原因）；全部 X 预检失败按 failed 聚合。

渲染/打包/复审闭环（追加）：

- renderer（FixRosterConflictProjection）：`tests/agents-roster-conflict.test.mjs` 9/9
  （正常 desk+员工 running 编排非冲突；真 RESOURCE_LOCK_CONFLICT / RESOURCE_LEASE_BUSY
  危险态；编排等待/空列表非冲突；DOM `.seat-conflict` 门）。
- 打包：`npm run build` exit 0（2026-08-09 12:28:31 → 12:29:54）；产物
  `out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe` + `resources/app.asar` 存在。
- ReviewWmb5137：F1（runner catch 终态接线无端到端测试）由 T8 关闭；F2（evidence §5
  批次计数误植）由本节改为真实命令与计数关闭；verdict approved。

门禁：`npm run typecheck` 0；`node scripts/check-capability-registry.mjs` pass；
`check-intake` ok；`check-ledger` PASS（capability registry no change 由检查验证）。

## 6. Changed files

- `src/main/role-job-registry.ts`（470 行，≤500）：JOB_ERROR_CODES +3 码、ROLE_TO_FAILURE_CODE、
  `roleFailureCode` 导出。
- `src/main/generic-employee-runner.ts`（274 行）：catch 角色域错误码 + 即时终态写入；
  `writeAgentTaskTerminal` 导出（既有 helper 测试可见，同域既有惯例）。
- `src/main/daily-intelligence-channels.ts`（496 行）：`BrowserPreflight`、
  `resolveBrowserConfig` 非抛出化、`recordPreflightFailure`、blocked 分支按 preflightError
  落 failed 回执、`dependencies.preflight` 注入。
- `tests/generic-employee-runner.test.mjs`（新增，195 行，含 T1-T8）、
  `tests/daily-intelligence-preflight.test.mjs`（新增，112 行）。
- 未改：`tests/daily-intelligence-channels.test.mjs`（604 行，保持注册 cap 604）。

## 7. Risks

- 无 code 异常若发生「任务已建但领域原语已写终态」时，runner 的 running 检查跳过写入，
  由领域原语错误码保留（如 writer STUDIO_DRAFT_FAILED）——语义不变，无双终态。
- 预检失败回执的 errorCode 对无 code 错误沿用 `CHANNEL_SCAN_FAILED` 兜底（与既有
  `recordAttemptFailure` 一致），message 带「X 浏览器预检失败：」前缀保证可追踪。
- `preflight` 注入 seam 只用于测试/宿主注入，缺省走真实 `resolveBrowserConfig`，不改生产行为。
- 真实现场 15s 超时路径未在无浏览器环境下端到端重跑；以同链路非用户态异常（VALIDATION_ERROR）
  复现等价性，见第 2/3 节（已如实记录，非推断冒充）。
- 实机 readback 仅验证 roster idle 投影；normal/blocked 危险态判定由
  `tests/agents-roster-conflict.test.mjs` 9/9 fixture 覆盖（实机无真实冲突任务环境，如实记录）。

## 8. 最终打包、实机 readback 与最终门禁（结项追加）

- 最终打包：`npm run build` PASS（2026-08-09 12:52:31，`package.json` version 0.2.0）；
  产物 `out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe`（225,781,760 B）与
  `resources/app.asar`（3,939,436 B），结项复核存在。
- SHA-256（结项实测一致）：exe
  `6da31d666a8dd06950394956ceb1a9e68bb48e2e7bf3b478262a3345c93f871b`；asar
  `6140f69d11b61c9ccc52de39ad04170a624d3e319a06b77987fc30d668408e3e`。
- packaged Electron readback：窗口 title「WeMediaBuddy / #root / 智能体按钮」；无 error
  banner、无 `.seat-conflict`。
- line-cap 修复：renderer 接线使 `agents-roster-view.tsx` 达 680 行（超注册 cap 675），
  `resolveDeskConflict` 压缩为单行并删空行回 675/675；roster 9/9 仍过（DOM 接线断言空白
  不敏感）。其余：channels.ts 496/500、role-job-registry 470/500、runner 274、
  roster-conflict 40、channels.test 604/604（注册 cap）。
- 最终门禁：`npm run typecheck` PASS；`node scripts/check-capability-registry.mjs` PASS
  （capability registry no change）；lightweight `scripts/check.ps1` PASS；`check-intake` ok；
  `check-ledger` PASS（结项复跑）。
