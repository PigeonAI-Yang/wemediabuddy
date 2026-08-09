# Changelog

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
