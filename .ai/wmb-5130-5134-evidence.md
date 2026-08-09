# WMB-5130..5134 Evidence

## Scope and root causes

- X observation recovery used a moving `started_at` cutoff and could repeatedly reclaim rows from the same dead generation; 15 production rows were stranded as `running` without an active owner.
- Pi dock Main imports mixed extensionless ESM paths, so direct Node test imports failed.
- EVAL-029 frozen databases stopped at migration 49 after migration 50 became current.
- Eight full-suite failures mixed stale UI/test contracts with three source defects: Today pool readback used wall clock instead of the requested business day; generic conversation reads prematurely converted a live streaming turn to interrupted; the packaged operator Skill omitted registered tools.
- Final review found the 5-minute Pi grace still left a crash-relaunch ghost. Recovery is now lifecycle-explicit: ordinary reads preserve live streaming; `ensurePi` recovers an interrupted turn immediately before starting a new worker. Canonical transcript projection cannot roll back a newer stored user turn.

## Repairs

- `src/main/x-observation-jobs.ts`, `src/main/x-observation-scheduler.ts`: generation-safe recovery plus one-shot startup/scheduler behavior.
- `src/main/app-window.ts`, `src/main/ipc-pi-dock.ts`, `src/main/pi-config.ts`: Node-loadable Electron/ESM boundary.
- `tests/eval-029-fixtures.test.mjs`, `tests/settings.test.mjs`: migration 50 fixture contract.
- `src/main/workbench.ts`: Today pool projection anchored to Shanghai business-day end.
- `src/main/pi-conversation.ts`, `src/main/index.ts`: lifecycle-explicit interrupted-turn recovery and monotonic transcript projection.
- `skills/wemedia-buddy-operator/SKILL.md`: registered tool inventory synchronized without authority expansion.
- Stale UI/runtime assertions were aligned only where current product behavior was source-authoritative.

## Production reconciliation

- `.ai/wmb-5130-reconcile.json`: 15 orphaned X observation rows recovered from `running`; before/after status counts and scheduler readback recorded. No source evidence rows were deleted.

## Verification

- `tests/x-observation-jobs.test.mjs`: 16/16 pass, including stale-generation cutoff recovery.
- Workspace import/profile/proposal suites: 14/14 pass; Electron adapter import smoke: 3/3 pass.
- `tests/eval-029-fixtures.test.mjs`: 9/9 pass in bounded cold processes.
- Opportunity pool: 12/12 pass. Pi operator/extension: 9/9 pass. Pi conversation/message flow after final lifecycle repair: 18/18 pass.
- Residual UI/runtime clusters: 35/35 + 18/18 pass.
- Final full `npm test` after all Pi lifecycle repairs: 552/552 pass.
- `npm run typecheck`: pass after final Pi repair.
- Ledger, intake, prototype split and capability registry checks: pass. Registry remains 20 internal commands, 17 grantable covered, roles desk/reporter/planner/writer/librarian.
- Real Electron, current source and real root, 1600×960: renderer loaded Today and Studio without error boundary; `scrollWidth == clientWidth`; Today showed 2 current candidates and no duplicate AI-writing card in the rendered board; Pi dock remained rendered and usable.

## Independent review

- `ReviewWmb5130`: overall correct; no blocker/major. Minor scheduler-anchor test recommendation recorded.
- `ReviewWmb5133Final`: initial two Pi grace findings fixed; follow-up approved both closures with no new issue.

## External harness note

`scripts/check.ps1` initially reached the source-line ratchet during concurrent WMB-5135 work; WMB-5130..5134 did not modify its owned Studio file. WMB-5135 later completed with its own cap repair and lightweight harness pass. This wave did not raise the cap or rewrite another owner's work.

## Pi operator Skill impact

Updated — only the documented registered tool inventory changed; authority boundaries and capability registry did not.
