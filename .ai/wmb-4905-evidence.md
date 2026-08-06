# WMB-4905 自动 Pi 协作授权验收

- Task: `WMB-4905`
- SPEC: `CAP-014`, `CAP-021`, Cross-capability UX
- Date: 2026-08-06

## 交付行为

- 用户点击收集、创作或复盘动作后，runner 在任务进入 `running`、Pi 启动前自动绑定当前 worker lease，并按 intent 签发或复用最小范围 `TaskGrantV1`。
- `daily_intelligence`、`studio_draft`、`results_review` 使用独立命令白名单；grant 仅允许 `pi:pi` 与 packaged MCP 实际 actor `external_agent:mcp`。
- Pi 系统提示携带同一 `taskId`、`grantId`、`workerLeaseId`；缺失、过期、跨 workspace/runtime、越权命令、错误 actor、陈旧 lease 仍拒绝且零业务写入。
- 删除 Today 的独立授权 CTA、renderer 控件、preload/global API 与 main IPC 注册；保留 MCP `task_grants.get/list` 只读能力及 backend `TaskGrantControl`。
- 发布、账号、浏览器等外部副作用继续使用 `PreciseExecutionGrantV1` 精确确认，未被 task grant 放宽。
- Pi operator Skill 已同步三份安装源，明确不再要求用户点击“授权 AI 协作”。

## 关键修复

独立评审发现 `startWorkspaceDailyIntelligence` 会在 channels 已进入 `needs_user/failed` 后再次调用授权 hook，触发 `TASK_NOT_ACTIVE`。已删除重复调用，并将 channel hook 移到 stale/reused 早退之后、progress/scan 之前。新增 blocked、stale-context、resume_pending 行为覆盖。

## 验证

- `npm run typecheck` — pass。
- `node --test --test-concurrency=1 tests/task-grants.test.mjs tests/agent-runner.test.mjs tests/daily-intelligence-channels.test.mjs tests/today-run-view.test.mjs tests/workspace-needs-user.test.mjs` — 38/38 pass。
- `node --check .ai/wmb-4809-package-acceptance.mjs` — pass。
- `npm run build` — Electron Forge Windows package pass；main、preload、renderer 与 packaged executable 均生成。
- Operator Skill SHA-256：三份均为 `913714546fce7aa0b51693e06e7b6b1b378c458504c3b7199364724b2df09259`。
- 最终 packaged Electron (`out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe`, CDP 9341) live readback：title `WeMediaBuddy`，`#root` 存在；Today 当前动作仅「查看资料」「继续生成方案」；未出现「授权 AI 协作」「任务授权」「Task grant」「grant control」。应用保持打开。
- 独立 reviewer 复核：PASS；P1/P3 已修复，新增行为测试覆盖 blocked/stale/resume。原 `tests/agent-runner.test.mjs` 仍有一个 source-ordering guard，非阻塞，真实行为已由 channel tests 覆盖。

## 变更面

- Authority/runtime: `src/main/task-grants.ts`, `src/main/agent-runner.ts`, `src/main/workspace-intelligence.ts`, `src/main/daily-intelligence-channels.ts`, `src/main/index.ts`, `src/main/pi-operator-skill.ts`
- Removed UI/API: `src/renderer/today-run-view.ts`, `src/renderer/today-command-bar.tsx`, `src/preload/preload.ts`, `src/renderer/global.d.ts`; deleted `src/renderer/task-grant-control.tsx`, `src/main/ipc-task-grants.ts`
- Tests/harness: `tests/task-grants.test.mjs`, `tests/agent-runner.test.mjs`, `tests/daily-intelligence-channels.test.mjs`, `tests/today-run-view.test.mjs`, `.ai/wmb-4809-package-acceptance.mjs`
- Operator guidance: `skills/wemedia-buddy-operator/SKILL.md` and both installed data-root copies
- Design record: `docs/spark/2026-08-06-today-daily-intelligence-mainline-design.md`

## Skipped / risks

- 未运行全量 `npm test` 或 `scripts/check.ps1 -Full`；本任务使用与变更路径直接对应的 38 项回归、typecheck、Windows package 和真实 packaged UI readback。
- 未触发真实 Pi 生成，避免修改当前用户工作空间；自动 grant 的 packaged real-Pi acceptance 已迁移为只读轮询自动 grant，留待发布级 EVAL-029 执行。
