# EVAL-CAP-027

- Capability: Desk manager + multi-instance crew runtime. Roles are labor identities rather than seats; each execution is a `jobId`-identified instance governed by the shared pool, task grant, resource boundary, lease and isolated Pi session.
- Tasks: WMB-5116–WMB-5122, WMB-5137.
- Preconditions: fixed role registry enabled; `JobPool` configured with bounded `maxWorkers`; workspace runtime, dispatcher, task grants and role runners available.
- Steps:
  1. Spawn concurrent same-role and cross-role jobs; verify independent `jobId`, context, session, grant, lease and active projection.
  2. Exercise FIFO capacity, `maxWorkers=0`, resource-lock/Judge-in-flight parking, promotion and watchdog behavior.
  3. Drive success, partial, failure, `needs_user`, hard cancel and scan→judge handoff; verify terminal ordering, cancel priority, grant revoke and lease/lock release.
  4. Restart from persistent task/context/session/audit facts and re-dispatch the original bounded role request.
  5. Verify five role groups, true active-instance counts, no empty seats/fictional standby state, and danger styling only for real resource conflicts.
  6. Attempt desk spawn, cross-object writes and non-grantable publication/delete/platform effects; verify rejection with zero business mutation.
- Expected observable results: same-role instances may run concurrently under one shared capacity limit; each task has at most one active instance; waiting jobs consume no slot; terminal instances leave active projection except `needs_user`, which holds no runtime resources; cancel completes within five seconds and wins every outcome race; grants and object boundaries constrain all writes; desk remains read/orchestration-only.
- Command evidence: `.ai/wmb-5117-5122-evidence.md`, `.ai/wmb-5122-live-e0-e5.json`, `.ai/wmb-5122-e3-reverify.json`, `.ai/wmb-5137-evidence.md`; focused integration gate 75/75 passed; four-role live cancellation/readback E3 re-verification passed; WMB-5137 focused regression 98/98 plus reporter terminal-path T8 8/8 passed; typecheck, capability registry and lightweight harness passed.
- Independent review: `ReviewResidualClosure` approved WMB-5117–5122 with no findings after the major was closed; `ReviewWmb5137` approved the failure/projection follow-up after F1/F2 closure.
- Pi operator Skill impact: updated in WMB-5116/WMB-5121 for multi-instance and strict structured no-op behavior; no new Skill or tool surface.
- Result: pass.
