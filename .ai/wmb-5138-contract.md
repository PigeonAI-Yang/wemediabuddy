# WMB-5138 Contract

## Route
Patch — 历史合同补录（historical contract reconstruction）：原 WMB-5116 施工批次下的授权子任务（Windows 发布/打包批次，M-5130/CAP-025），引用既有 Owner lock 路径与日期：`.ai/wmb-5116-contract.md`（Design / lock，Owner lock 2026-08-08；Owner gate decision 2026-08-09）与 `docs/spark/2026-08-08-windows-release-update-design.md`（2026-08-08，状态：Owner 已批准；独立规格复核通过）。

## Goal
Ship a Windows Squirrel installer with the production renderer, application icon, and compact bundled Pi runtime（TASKS.md 任务行原文）。

## Problem / Root cause
n/a — 历史合同补录：本任务为打包/分发交付，无故障根因。实施前基线（设计 §3）：`package.json` `build` 仅运行 Pi runtime 准备与 `electron-forge package`，`forge.config.ts` 只有 packagerConfig 与 Vite 插件，无 maker、publisher、签名或更新配置；README 明确当前不生成安装向导。

## Acceptance
（按 TASKS.md 任务行原文 + 完成证据；历史合同补录，非本合同创建时复跑）
- [x] 任务行原文：Ship a Windows Squirrel installer with the production renderer, application icon, and compact bundled Pi runtime。
- [x] Squirrel lifecycle 5/5：`tests/squirrel-lifecycle.test.mjs` 覆盖 install/updated/uninstall/obsolete 四启动事件与非事件直通。
- [x] packaged runtime readback：打包包含 `resources/.r/node_modules/a/dist/cli.js`、`resources/.r/node_modules/pi-vision-tool/package.json`、`.package-lock.sha256`；最终 artifact hashes（Setup.exe / full.nupkg / RELEASES SHA-256）记录于 `.ai/wmb-5138-5140-evidence.md`。
- [x] 应用图标与身份：packager icon `images/icon` + `app.setAppUserModelId('com.pigeonyang.wemediabuddy')`（forge.config.ts / src/main/index.ts）。
- [ ] 本文件为历史合同补录：以上 acceptance 以任务行证据为准，未在本合同创建时复跑（证据日期 2026-08-09，见 `.ai/wmb-5138-5140-evidence.md`）。

## Verification
- 完成证据（2026-08-09 任务行 + `.ai/wmb-5138-5140-evidence.md`）：Squirrel lifecycle 5/5；packaged runtime readback；artifact SHA-256（`WeMediaBuddy Setup.exe` 193,148,416 B、`WeMediaBuddy-0.2.0-full.nupkg` 197,689,408 B、`RELEASES` 83 B）；`npm run build`（Forge make）产出 win32/x64 Squirrel 分发包。
- 独立复审：ReviewWmbRelease — approved，无 blocker/major（任务行 Evidence cell 原文）。
- 本合同创建不重新验收；证据为账本/evidence 既有记录。

## Allowed paths
（实际 changed artifacts；实施落地于发布批次 commit fdeaa75，2026-08-09）
- `forge.config.ts`（MakerSquirrel：setupExe/icon/noMsi/短路径 outDir/extraResource `.r`）
- `src/main/squirrel-lifecycle.ts`（新增：Squirrel install/updated/uninstall/obsolete 启动参数处理）
- `src/main/index.ts`（AUMID + handleSquirrelLifecycle 接线 + single-instance 规避）
- `src/main/pi-runtime-manager.ts`（`.pi-runtime` → `.r` 路径）
- `scripts/prepare-pi-runtime.mjs`（紧凑 bundled Pi runtime：`.r` 短目录 + fingerprint）
- `tests/squirrel-lifecycle.test.mjs`（新增）
- `package.json` / `package-lock.json`（author、@electron-forge/maker-squirrel、`build` → `electron-forge make`）
- `.gitignore`（`.pi-runtime` → `.r`）
- `PI_INTEGRATION_PLAN.md`、`TECHNICAL_DESIGN.md`（`resources/.r` 目录说明同步）
- `.ai/wmb-5138-5140-evidence.md`（任务证据文件）

## Forbidden paths
- `src/shared/agent-capabilities.ts` / `src/shared/page-authority.ts`（能力注册表/权限，no change）
- `PRODUCT.md` / `PRD.md` / `SPEC.md`（产品合同；本任务仅同步 runtime 目录说明，不改合同语义）
- 真实 data root、依赖安装目录（node_modules 等）
- `TASKS.md` / `TASKS.archive.md`（合同补录不登记行）
- 本任务范围之外的 Windows 发布后续 commit（`.github/workflows/release.yml` 属 WMB-5140）

## Non-goals
- 不新增业务命令/Capability/依赖；不触发真实平台发布/互动
- 不做 macOS/Linux/ARM64、Microsoft Store、自建更新服务器（设计 §12 首期范围外）
- 不引入自动回滚宣传（设计 §6.3/§12）
- 本合同不重新验收、不修改源码；仅为历史合同补录

## Capability registry impact
no change — 任务行原文：packaging/runtime distribution only。
Pi operator Skill impact: no change — bundled existing runtime and Skills unchanged（任务行原文）。

## Depends on
WMB-5137（任务行 Depends on 原文）

## Design / lock
- Design: `docs/spark/2026-08-08-windows-release-update-design.md`（2026-08-08，Owner 已批准；独立规格复核通过）— 覆盖安装器、打包边界、更新、发布工作流与验收。
- Owner lock 引用（既有）：`.ai/wmb-5116-contract.md` Design / lock（Owner lock 2026-08-08；Owner gate decision 2026-08-09）。本任务为该施工批次下的授权子任务（历史合同补录）。
- 本文件为 historical contract reconstruction：原任务完成时未单独落本合同；Acceptance/Verification 以 TASKS 行与 `.ai/wmb-5138-5140-evidence.md` 既有记录为准，不补造原任务不存在的验收结果或 Owner lock 原文。
