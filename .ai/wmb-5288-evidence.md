# WMB-5288 — Agent unified live run log

## Result

- `src/renderer/agents-detail-modal.tsx` now renders task events and Pi/Job transcript entries through one `RunLogSection` for both roster-backed legacy tasks and projected instances.
- The duplicate `任务事件` and `实时运行记录/运行记录` sections are replaced by one `运行记录` section. Instance-only inter-agent `最新消息` remains separate because it is a distinct communication stream.
- Entries share one chronological list. Task events retain timestamp and message; transcript entries retain their existing semantic presentation (`任务输入`, `智能体回复`, tool/thinking/system/orchestration states).
- The log is a keyboard-focusable `role="log"` region with bounded height and internal vertical scrolling.
- Initial load follows the newest entry. New content continues following only while the reader is at the bottom. Scrolling upward disables follow without moving the reading position; returning to the bottom re-enables it.
- No Agent/Pi IPC, database schema, permissions, capabilities, dependencies, or foundation tokens changed.

## Files

- `src/renderer/agents-detail-modal.tsx`
- `src/renderer/styles-agents.css`
- `tests/e2e/agents.test.mjs`
- `tests/wmb-5143-agents-instance-view.test.mjs`

## Verification

- `pnpm run typecheck` — PASS.
- `node --check tests/e2e/agents.test.mjs` — PASS.
- `node --test tests/wmb-5143-agents-instance-view.test.mjs` — 21/21 PASS.
- `node --test tests/design-tokens-drift.test.mjs` — 3/3 PASS.
- Real Electron: `AG-002-agents-detail-modal` and `AG-008-agents-legacy-task-avatar` — 2/2 PASS.
- Electron assertions cover one unified section for instance and legacy paths, removed duplicate section, bounded internal overflow, initial bottom-follow, new-record follow, user upward-scroll lock, bottom-return recovery, and real 5-second disk reconciliation.
- Page errors: `[]`.

## Visual evidence

- `tests/e2e/.artifacts/AG-008-agents-legacy-task-avatar-664sAC/agents-unified-run-log-screenshot.png`
- `tests/e2e/.artifacts/AG-008-agents-legacy-task-avatar-664sAC/agents-unified-run-log-pageerrors.json`

The inspected 1600×960 Electron screenshot shows one compact `运行记录` area inside the agent detail modal, with a visible internal scrollbar and the newest record at the bottom. The modal and surrounding shell remain contained without horizontal overflow.

## Runtime cleanup

The E2E-created Electron/Playwright processes exited through the runner. The existing supervised `wemedia-buddy-app` and pre-existing `omp.browser.headless` processes were not created or modified by this task.
