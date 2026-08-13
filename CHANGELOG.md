# Changelog

## 0.3.0 - 2026-08-13

### Added

- Production knowledge flywheel covering source compilation, topic Wiki synthesis, Pi query write-back, creation lineage, review feedback, and knowledge health.
- Resumable high-value source backfill with sparse promotion, evidence preservation, idempotent checkpoints, and honest `uncompiled` / `legacy_shell` / `compiled` states.
- Research successor workflow with bounded budgets, crash recovery, claim persistence through guarded command dispatch, and explicit unresolved-claim decisions.

### Changed

- Topic, Library, Knowledge Canvas, Pi, Studio, Results, and Agents now expose the same versioned knowledge and research state without introducing a parallel Wiki product.
- Creation and publication review flows now retain immutable Wiki, Note, Evidence, and Usage version lineage.

### Fixed

- Prevented direct research-claim writes from bypassing the workspace write guard.
- Prevented callers from expanding research budgets beyond machine limits and restored stale successor jobs without duplicate dispatch.
- Stopped empty or legacy Wiki shells from appearing as fully compiled current knowledge.

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
