# WMB-5140 Contract

## Route
Patch — 历史合同补录（historical contract reconstruction）：原 WMB-5116 施工批次下的授权子任务（Windows 发布/自动化批次，M-5130/CAP-025），引用既有 Owner lock 路径与日期：`.ai/wmb-5116-contract.md`（Design / lock，Owner lock 2026-08-08；Owner gate decision 2026-08-09）与 `docs/spark/2026-08-08-windows-release-update-design.md`（2026-08-08，状态：Owner 已批准；独立规格复核通过）。

## Goal
Automate version-tagged Windows releases and complete final build, packaged smoke, artifact verification, and release review（TASKS.md 任务行原文）。

## Problem / Root cause
n/a — 历史合同补录：本任务为实现交付（发布自动化 + 最终构建/打包 smoke/artifact 校验/发布复审），无故障根因。设计要点（设计 §4.3）：版本标签固定 `v<semver>` 且必须与 `package.json.version` 完全一致；从标签对应干净提交以 `npm ci` + 锁文件构建；GitHub Actions 最小 `contents: write` 权限 + Owner 人工批准 Environment；代码签名材料只来自 Environment Secrets；Draft 仅资产初检，验收通过后提升为正式 Release，不重新构建。

## Acceptance
（按 TASKS.md 任务行原文 + 完成证据；历史合同补录，非本合同创建时复跑）
- [x] 任务行原文：Automate version-tagged Windows releases and complete final build, packaged smoke, artifact verification, and release review。
- [x] 发布自动化：`.github/workflows/release.yml` 按版本标签构建 tagged Windows releases，校验 SHA-256 并上传 Forge/Squirrel 产物（设计 §4.3 固定标签 + 干净提交构建 + 最小权限 + Environment Secrets 签名）；release 复审后追加显式 unsigned artifact 选项（commit 444f281，本分支内）。
- [x] 最终构建与门禁：check.ps1 / typecheck / build pass（release-review hardening 后 Electron Forge 产出全新 win32/x64 package 与 Squirrel 分发包）；line-caps 递减登记（`index.ts` 969、`global.d.ts` 572，commit 67b1ae7）。
- [x] packaged smoke：重建 `WeMediaBuddy.exe` 以隔离 data root 启动，CDP 下 renderer 健康、全局更新横幅以生产 CSS 渲染（1440×900，无溢出），exit 0。
- [x] artifact verification：installer / nupkg / RELEASES 的 SHA-256 已记录（`.ai/wmb-5138-5140-evidence.md` Artifacts 段）；`WMB_WINDOWS_CERTIFICATE_FILE` / `WMB_WINDOWS_CERTIFICATE_PASSWORD` 保持可选仓库 Secret，未签名本地构建仍可用于验收。
- [x] 发布边界：本实施会话未创建 Git tag 或 GitHub Release；发布由版本标签工作流驱动，避免未复审的外部变更。
- [ ] 本文件为历史合同补录：以上 acceptance 以任务行证据为准，未在本合同创建时复跑（证据日期 2026-08-09，见 `.ai/wmb-5138-5140-evidence.md`）。

## Verification
- 完成证据（2026-08-09 任务行 + `.ai/wmb-5138-5140-evidence.md`）：check.ps1/typecheck/build pass；packaged renderer + update banner CDP smoke exit 0；installer/nupkg/RELEASES SHA-256 recorded；独立复审 ReviewReleaseFixes — release follow-up approved，findings 0（任务行 Evidence cell 原文）。
- 本合同创建不重新验收；证据为账本/evidence 既有记录。

## Allowed paths
（实际 changed artifacts；实施落地于发布批次 commit fdeaa75 及后续 release 收口 commit，2026-08-09）
- `.github/workflows/release.yml`（新增：版本标签发布工作流；commit fdeaa75 + 444f281 显式 unsigned 选项）
- `forge.config.ts`（PublisherGithub：`PigeonAI-Yang/wemediabuddy`，draft: true；outDir 短路径 `WMB_OUT_DIR`/盘根 `wmb-out`；可选 windowsSign）
- `package.json` / `package-lock.json`（version 0.2.1、`publish` script、@electron-forge/publisher-github、maker-squirrel）
- `scripts/line-caps.json`（`index.ts` 969 / `global.d.ts` 572 递减登记；commit 67b1ae7 对齐已验证源码上限）
- `CHANGELOG.md`（新增，0.2.1 发布说明）
- `README.md`（Windows 安装包/发布流程文档）
- `.ai/wmb-5138-5140-evidence.md`（任务证据文件）

## Forbidden paths
- `src/shared/agent-capabilities.ts` / `src/shared/page-authority.ts`（能力注册表/权限，no change）
- `PRODUCT.md` / `PRD.md` / `SPEC.md`（产品合同，no change）
- 真实 data root、依赖安装目录（node_modules 等）
- `TASKS.md` / `TASKS.archive.md`（合同补录不登记行）
- WMB-5138/5139 专属落点（`squirrel-lifecycle.ts`、`onboarding.ts`、`app-update.ts`、`desktop-lifecycle.ts`、对应 renderer/测试等不在本任务范围）

## Non-goals
- 不新增业务命令/Capability/依赖；不触发真实平台发布/互动（本任务不创建 tag/Release，仅提供自动化与验收）
- 不做 macOS/Linux/ARM64、Microsoft Store、自建更新服务器、灰度/多租户通道（设计 §12）
- 发布脚本不得自动把未验收 Draft 提升为正式 Release（设计 §11）
- 本合同不重新验收、不修改源码；仅为历史合同补录

## Capability registry impact
no change — 任务行原文：release integration only。
Pi operator Skill impact: no change — no operation contract changed（任务行原文）。

## Depends on
WMB-5138, WMB-5139（任务行 Depends on 原文）

## Design / lock
- Design: `docs/spark/2026-08-08-windows-release-update-design.md`（2026-08-08，Owner 已批准；独立规格复核通过）— §4.3 GitHub 发布（固定标签/干净构建/最小权限/Environment Secrets）、§10 发布验收、§11 运行和所有权为本任务设计真源。
- Owner lock 引用（既有）：`.ai/wmb-5116-contract.md` Design / lock（Owner lock 2026-08-08；Owner gate decision 2026-08-09）。本任务为该施工批次下的授权子任务（历史合同补录）。
- 本文件为 historical contract reconstruction：原任务完成时未单独落本合同；Acceptance/Verification 以 TASKS 行与 `.ai/wmb-5138-5140-evidence.md` 既有记录为准，不补造原任务不存在的验收结果或 Owner lock 原文。
