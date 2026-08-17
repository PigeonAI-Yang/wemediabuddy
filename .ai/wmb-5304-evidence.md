# WMB-5304 — Investigation supervisor review execution repair

## Problem

A reporter terminal event could persist an investigation at `research_review` and render “主管正在验收”, but no supervisor execution existed. The authoritative Agents roster therefore showed `desk = idle`, and no supervisor could read the package or save a post-research direction.

## Repair

- `src/main/project-investigation.ts`
  - Added `buildInvestigationSupervisorReviewPrompt(projectId)` with a bounded supervisor contract: read the exact investigation, approved outline, evidence package and Source SSOT; verify evidence before any direction; use the existing investigation review command when sufficient; preserve Owner approval and never dispatch the writer.
  - `handleInvestigationJobEvent()` now returns a `reporter_review` dispatch signal only after the reporter terminal transaction has truthfully reached `research_review`.
- `src/main/ipc-jobs.ts`
  - Consumes that signal and runs a real `runDockManagerPrompt()` orchestration on the authoritative desk task.
  - Broadcasts the native job event first, so project state and agent projection refresh from their real stores.
  - Deduplicates one in-flight supervisor review per project and clears the guard on failure.
  - Recovers persisted `research_review` rows on workspace startup.
- `src/main/index.ts`
  - Re-runs pending supervisor recovery after `registerPiDockIpc()`. This fixes the startup ordering race where the workspace runtime was opened before the dock prompt dependencies existed.
- `src/main/task-grants.ts`
  - Added existing investigation read/review business commands to the desk task grant; no writer or publishing permission was added.

No DB schema, Source SSOT, evidence threshold, Owner second approval, publishing boundary, dependency, renderer CSS, or foundation token changed.

## Focused verification

- `npm run typecheck` — PASS.
- `node --test --test-name-pattern="job lifecycle broadcasts|task grants expose|WMB-5304" tests/pi-message-flow.test.mjs tests/wmb-5290-investigation.test.mjs tests/task-grants.test.mjs` — 3/3 PASS.
- Regression coverage proves:
  - reporter completion returns one bounded supervisor-review dispatch;
  - the prompt requires authoritative investigation/source reads, evidence review, the existing review command, exact readback, Owner approval preservation, and no writer dispatch;
  - the desk grant exposes the required investigation read/review commands;
  - job lifecycle broadcast remains immediate and does not mutate the native Pi transcript stream.

## Real Electron acceptance

Restarted the supervised Electron application against the real workspace `J:\PigeonYang\WeMediaBuddyData` and observed project `5675d709-b815-4dad-8f96-f3399918192b`.

Before repair, authoritative state was:

- investigation: `research_review`, revision `10`;
- desk roster: `idle`, `当前无任务`;
- active project jobs: none.

After the repaired startup recovery:

- the same persisted `research_review` row dispatched a real desk task `1216f492-cc79-4c42-aa74-cfdeaca4dc4d`;
- authoritative roster changed to `desk.status = running`;
- the Pi transcript recorded `已安排主管` and a real `主管验收调查资料包` orchestration card;
- the supervisor called `wmb_get_current_workspace`, `wmb_get_agent_task`, `wmb_get_task_grant`, `wmb_get_investigation`, then read all 11 linked sources through `wmb_get_source`;
- page errors: `0`; horizontal overflow: `0`.

The supervisor truthfully rejected the package rather than fabricating a direction: only 2 of 13 claims had limited support, 11 remained unresolved, no controlled task comparison existed, and the package terminal reason was `candidates_exhausted`. It therefore did **not** invoke investigation approval, did **not** save a direction, did **not** dispatch a writer, and left the investigation at `research_review` for the Owner’s explicit choice between further evidence and a narrower methodology article. This is the required truthful terminal behavior when the evidence gate is not met.

Visual evidence: `J:\Users\yangda01\Temp\omp-sshots-155a26795983d49d.webp`.
