# WeMediaBuddy — 项目长期记忆

## 构建/CI 关键约束（务必遵守）
- 项目是 **Electron 43 + React 19 + TS 5.9 + Vite 7** 桌面应用，Electron Forge 7.11 打包，npm 管理（默认分支 `master`）。
- **构建只能在 windows-latest 上跑**：`media-runtime.lock.json` 锁定 `win32-x64`，且 `build`/`package`/`publish` 都会先执行 `verify:xhs-resources → prepare-pi-runtime → prepare-media-runtime`。在非 Windows runner 上 `prepare-media-runtime` 会因平台不匹配而失败。
- 部署目标：GitHub Releases（草稿），由 `forge.config.ts` 的 `PublisherGithub`（owner=PigeonAI-Yang, name=wemediabuddy, draft:true）完成；发布用 `npm run publish`。
- 测试：单元 `node --test tests/*.test.mjs`（仅顶层，可跨平台）；E2E 用 Playwright（`npm run e2e` / `e2e:gate`），需在 Windows 上跑。
- 设计令牌 SSOT 为 `src/renderer/styles-foundation.css`，改品牌令牌前需询问 owner（见 AGENTS.md/CLAUDE.md）。

## CI/CD 工作流（2026-08-18 新增）
- `.github/workflows/ci.yml`：PR/push 触发；`typecheck-unit`（ubuntu，跳过 Electron 下载）+ `build-windows`（windows-latest，npm run package，上传未打包产物）。
- `.github/workflows/release.yml`：tag `v*`/手动触发；门禁后 `npm run publish` 到草稿 Release，并记录 SHA-256 校验和。可选 Authenticode 签名 Secret：`WMB_WINDOWS_CERTIFICATE_BASE64` / `WMB_WINDOWS_CERTIFICATE_PASSWORD`。
