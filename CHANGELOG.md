# Changelog

## Unreleased

### Added

- 知乎（Zhihu）成为一等发布平台（WMB-5249）：平台账号在专用浏览器中验证登录态（authenticated / unauthenticated / challenge / unknown）并冻结稳定账号身份；专栏文章编辑器准备支持纯文本正文（标题/正文精确回读、编辑前登录/验证码停止、绝不自动点击发布），素材绑定在任何浏览器副作用前 fail-closed；Studio 平台页签、发布队列、设置与首启向导全面接入；数据库迁移 v70 将全部平台 CHECK 扩展至 `zhihu`（数据/索引/触发器/FK 原样保留）。

## 0.3.0 - 2026-08-13

### Added

- Production knowledge flywheel covering source compilation, topic Wiki synthesis, Pi query write-back, creation lineage, review feedback, and knowledge health.
- Resumable high-value source backfill with sparse promotion, evidence preservation, idempotent checkpoints, and honest `uncompiled` / `legacy_shell` / `compiled` states.
- Research successor workflow with bounded budgets, crash recovery, claim persistence through guarded command dispatch, and explicit unresolved-claim decisions.
- Global Wiki knowledge network with Topic, Knowledge Note, and Entity nodes, ontology cards, formal relations, and box-selected frozen Pi context.
- Real Electron end-to-end coverage for 83 user journeys, with a release gate over every automatable critical/high-risk journey.
- Frozen media runtime contract (WMB-5245, in development): immutable `media-runtime.lock.json` pinning FFmpeg 8.1.2, whisper.cpp v1.9.2 + small model, Tesseract 5.5.3 and chi_sim/eng traineddata with exact URLs, SHA-256, sizes and licenses; deterministic `scripts/prepare-media-runtime.mjs` preparation into `.r/media-runtime`; byte-verified app-side locator (`src/main/media-runtime.ts`) with stable `MEDIA_RUNTIME_*` codes and no PATH fallback; post-package gate (`scripts/verify-packaged-media-runtime.mjs`) that actually probes `ffprobe -version`, `whisper-cli --help`, `tesseract --version` from the packaged runtime.

### Changed

- Topic, Library, Knowledge Canvas, Pi, Studio, Results, and Agents now expose the same versioned knowledge and research state without introducing a parallel Wiki product.
- Relationship Canvas now opens directly as a read-only global knowledge graph; manual canvas construction and creation-workbench responsibilities were removed.
- Creation and publication review flows now retain immutable Wiki, Note, Evidence, and Usage version lineage.

### Fixed

- Prevented direct research-claim writes from bypassing the workspace write guard.
- Prevented callers from expanding research budgets beyond machine limits and restored stale successor jobs without duplicate dispatch.
- Stopped empty or legacy Wiki shells from appearing as fully compiled current knowledge.
- Preserved formal relations across network pagination, exposed excluded Pi context counts, and made Knowledge Note/Entity navigation fall back visibly to ontology cards.
- Fixed Studio first-platform saves, nested publication reconciliation transactions, stale knowledge-health filters, completed onboarding without Pi, and several user-journey race conditions.

## 0.2.1 - 2026-08-08

### Added

- Windows Squirrel installer, application icon, and compact bundled Pi runtime.
- Resumable first-run onboarding for data directory, browser profile, and AI configuration.
- In-app update checks, download progress, restart/later/quit-install choices, and a global update prompt.
- Version-tagged GitHub Actions release workflow with code-signing and release-gate enforcement.

### Changed

- Update installation now drains active work, checkpoints SQLite, backs up user data and configuration with SHA-256 manifests, and keeps the latest three backups.
- Agent runtime failures now preserve semantic error details, isolate failed intelligence channels, synchronize task terminal state, and show roster conflicts only for real resource conflicts.
- Proposal batch controls stay hidden until explicit batch mode is entered and clear on exit.

### Fixed

- Failed quit-time update installation restores the application window instead of leaving a lock-holding background process.
- Acceptance update feeds reject non-SemVer override tags before URL construction.
