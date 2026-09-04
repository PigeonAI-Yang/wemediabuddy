# Changelog

## Unreleased

### Fixed

- 清理已退役的 EVAL-029、旧 Today 编排及实现细节测试，恢复计划保存的来源覆盖校验、草稿状态和优先级边界，使当前产品合同重新通过完整测试门禁。
- X List 资料在调用方事务内持久化知识编译队列，并仅在提交后启动 drain，避免独立连接抢锁；工单关闭后的迟到终态报告也不再访问已关闭数据库。


## 0.4.0 - 2026-09-04

### Added

- 新增面向 Campaign 的自动内容创建链路，将选题、审批、研究、写作、配图和发布准备收敛到可恢复的 Owner 工作流。
- 新增 Workspace Orchestrator Actor、冻结投影、资源准入、恢复协议和可审计任务收据。
- 新增通用 AI 服务商管理、模型发现、角色模型策略以及可信的设置页来源展示。
- 新增 X 帖子评论串、作者 Thread、原生 X Article 全文及关联媒体归档。
- 知乎成为一等发布平台：支持专用浏览器账号验证、文章编辑回读、素材绑定和发布前 fail-closed 检查。
- 新增主进程与 Pi 子进程系统代理继承，以及可验证的媒体运行时准备流程。

### Changed

- 简化内容创建决策，移除独立 Judge 和 Stage D 生产职责，默认自动推进已批准且满足条件的选题。
- 重构超大模块并统一 Source 平台身份、编辑身份、知识编译与 Today 情报入口。
- 强化任务账本关闭协议，采用机器收据和月度归档记录完成状态。

### Fixed

- 修复 Today、Studio、Library、设置、规划器和插图工作流中的状态恢复、空白界面、列表稀疏及交互反馈问题。
- 修复知识飞轮、审批后创建、来源范围、提案持久化和 Workspace Orchestrator 恢复链路。
- 修复重复 X 采集导致的正文 revision、媒体候选漂移以及 Article／评论部分失败状态不准确问题。

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
