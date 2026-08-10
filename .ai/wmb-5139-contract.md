# WMB-5139 Contract

## Route
Patch — 历史合同补录（historical contract reconstruction）：原 WMB-5116 施工批次下的授权子任务（Windows 发布/更新批次，M-5130/CAP-025），引用既有 Owner lock 路径与日期：`.ai/wmb-5116-contract.md`（Design / lock，Owner lock 2026-08-08；Owner gate decision 2026-08-09）与 `docs/spark/2026-08-08-windows-release-update-design.md`（2026-08-08，状态：Owner 已批准；独立规格复核通过）。

## Goal
Add resumable first-run onboarding and safe in-app update, backup, recovery, and install handoff（TASKS.md 任务行原文）。

## Problem / Root cause
n/a — 历史合同补录：本任务为实现交付（首次向导 + 应用内更新/备份/恢复/安装交接），无故障根因。设计要点（设计 §5–§7）：更新状态为安装级状态且存于 `app.getPath('userData')`；Main 进程独占下载/校验/退出/安装；安全退出复用 workspace runtime drain/quit 边界；升级前备份工作空间 `wmb.db` 与安装级配置文件；首次启动向导可恢复、完成页只展示真实状态。

## Acceptance
（按 TASKS.md 任务行原文 + 完成证据；历史合同补录，非本合同创建时复跑）
- [x] 任务行原文：Add resumable first-run onboarding and safe in-app update, backup, recovery, and install handoff。
- [x] focused release suite 28/28：`tests/onboarding.test.mjs`、`tests/app-update.test.mjs`、`tests/release-feed.test.mjs`（+ `tests/squirrel-lifecycle.test.mjs`）以 `--test-concurrency=1` 运行全绿；typecheck pass。
- [x] failed quit-install restores window：退出时安装失败则清 shutdown 状态并重建应用窗口（desktop-lifecycle.ts 交接路径，ReviewReleaseFixes 首项 follow-up）。
- [x] global update prompt live：下载完成的更新有持久应用级提示（`立即重启更新` / `稍后`，app-update-banner，ReviewReleaseFixes 第二项 follow-up）。
- [x] acceptance tag strict：`WMB_ACCEPTANCE_UPDATE_TAG` 在 feed URL 构造前拒绝非 `v<semver>` 输入（release-feed.ts，ReviewReleaseFixes 第三项 follow-up）。
- [ ] 本文件为历史合同补录：以上 acceptance 以任务行证据为准，未在本合同创建时复跑（证据日期 2026-08-09，见 `.ai/wmb-5138-5140-evidence.md`）。

## Verification
- 完成证据（2026-08-09 任务行 + `.ai/wmb-5138-5140-evidence.md`）：focused release suite 28/28、typecheck pass；packaged smoke 中隔离 data root 上全局更新横幅以生产 CSS 渲染（1440×900，`稍后提醒` + `立即重启更新` 无溢出）；升级前备份与 boot-ok 语义按设计 §6 落位。
- 独立复审：ReviewReleaseFixes — three follow-up findings closed，无新问题（任务行 Evidence cell 原文）。
- 本合同创建不重新验收；证据为账本/evidence 既有记录。

## Allowed paths
（实际 changed artifacts；实施落地于发布批次 commit fdeaa75，2026-08-09）
- `src/main/onboarding.ts`（新增：可恢复首次启动向导）
- `src/main/app-update.ts`（新增：更新状态机/下载/安全退出/安装交接）
- `src/main/desktop-lifecycle.ts`（新增：桌面生命周期 + quit-install 交接 + 失败恢复窗口）
- `src/main/ipc-onboarding.ts`（新增）、`src/main/ipc-app-update.ts`（新增）
- `src/main/release-feed.ts`（新增：稳定/验收 feed URL 构造与 `v<semver>` 严格校验）
- `src/main/index.ts`（desktopLifecycle 接线，替换原 before-quit 处理）
- `src/preload/preload.ts`（onboarding/update IPC 面）
- `src/renderer/onboarding-view.tsx`（新增）、`src/renderer/app-update-banner.tsx`（新增）、`src/renderer/app-update-settings.tsx`（新增）
- `src/renderer/main.tsx`、`src/renderer/settings-view.tsx`、`src/renderer/global.d.ts`
- `src/renderer/styles-onboarding.css`（新增）、`src/renderer/styles-app-update.css`（新增）
- `tests/onboarding.test.mjs`（新增）、`tests/app-update.test.mjs`（新增）、`tests/release-feed.test.mjs`（新增）
- `.ai/wmb-5138-5140-evidence.md`（任务证据文件）

## Forbidden paths
- `src/shared/agent-capabilities.ts` / `src/shared/page-authority.ts`（能力注册表/权限，no change）
- `PRODUCT.md` / `PRD.md` / `SPEC.md`（产品合同，no change）
- 真实 data root、依赖安装目录（node_modules 等）
- `TASKS.md` / `TASKS.archive.md`（合同补录不登记行）
- WMB-5138/5140 专属落点（`forge.config.ts`、`squirrel-lifecycle.ts`、`.github/workflows/release.yml`、`scripts/prepare-pi-runtime.mjs` 等不在本任务范围）

## Non-goals
- 不新增业务命令/Capability/依赖；不触发真实平台发布/互动
- 不做百分比灰度、静默强制更新、多租户通道、自建更新服务器（设计 §12 首期范围外）
- 不宣称无法自证安全的自动回滚（设计 §6.3）
- AI 配置沿用既有 `safeStorage` 加密路径，不重做模型配置体系
- 本合同不重新验收、不修改源码；仅为历史合同补录

## Capability registry impact
no change — 任务行原文：lifecycle/UI only。
Pi operator Skill impact: no change — AI configuration delegates to existing secure config（任务行原文）。

## Depends on
WMB-5138（任务行 Depends on 原文）

## Design / lock
- Design: `docs/spark/2026-08-08-windows-release-update-design.md`（2026-08-08，Owner 已批准；独立规格复核通过）— §5 更新状态机/检查/下载/提示、§5.4 安全退出、§6 数据保护与恢复、§7 首次启动向导、§9 错误处理为本任务设计真源。
- Owner lock 引用（既有）：`.ai/wmb-5116-contract.md` Design / lock（Owner lock 2026-08-08；Owner gate decision 2026-08-09）。本任务为该施工批次下的授权子任务（历史合同补录）。
- 本文件为 historical contract reconstruction：原任务完成时未单独落本合同；Acceptance/Verification 以 TASKS 行与 `.ai/wmb-5138-5140-evidence.md` 既有记录为准，不补造原任务不存在的验收结果或 Owner lock 原文。
