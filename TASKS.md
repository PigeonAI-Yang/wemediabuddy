# WeMediaBuddy Task Ledger

This is the only progress ledger.

Statuses:

- `todo`: ready after dependencies are done;
- `doing`: actively being changed; at most one task;
- `blocked`: cannot meet acceptance without user input or external state;
- `done`: deliverables and verification evidence exist.

Progress is task evidence, not a percentage.

Current state:

- Active task: none
- Next eligible task: `WMB-0101`
- Blocked tasks: none
- Completed harness tasks: `WMB-0001`, `WMB-0002`

| Task | Milestone | Capability | Status | Depends on | Deliverable | Verification / evidence | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WMB-0001 | M-000 | CAP-001, CAP-002, CAP-003, CAP-004, CAP-005, CAP-006, CAP-007, CAP-008, CAP-009, CAP-010, CAP-011, CAP-012, CAP-013 | done | — | Harness entrypoint, workflow, verification, eval templates | `scripts/check.ps1` passes in commit containing harness | Codex |
| WMB-0002 | M-000 | CAP-001, CAP-002, CAP-003, CAP-004, CAP-005, CAP-006, CAP-007, CAP-008, CAP-009, CAP-010, CAP-011, CAP-012, CAP-013 | done | WMB-0001 | `SPEC.md`, `PLAN.md`, task traceability | Harness reference check passes | Codex |
| WMB-0101 | M-100 | CAP-001 | todo | WMB-0002 | Electron/React/TypeScript scaffold and pinned manifests | package typecheck, test, build scripts pass | — |
| WMB-0102 | M-100 | CAP-001 | todo | WMB-0101 | Data-root select/open/validate flow and directory layout | Restart readback using temporary data root | — |
| WMB-0103 | M-100 | CAP-001 | todo | WMB-0102 | SQLite migration runner and base object conventions | Migration and reopen regression check | — |
| WMB-0104 | M-100 | CAP-013 | todo | WMB-0102, WMB-0103 | Settings paths, usage, counts, health, log opening | UI readback matches filesystem and process facts | — |
| WMB-0105 | M-100 | CAP-013 | todo | WMB-0103 | Operation log and stable result/error envelope | Command regression check | — |
| WMB-0201 | M-200 | CAP-002 | todo | WMB-0103 | Source feeds/items and canonical dedupe | EVAL-001 source portion | — |
| WMB-0202 | M-200 | CAP-003 | todo | WMB-0201 | Topics, plans, references, one-current-plan rule | EVAL-001 plan portion | — |
| WMB-0203 | M-200 | CAP-002, CAP-003 | todo | WMB-0202 | Today view and source/plan commands | UI readback of stored source and plan | — |
| WMB-0301 | M-300 | CAP-004 | todo | WMB-0103 | Content projects, immutable core versions, platform versions | Version/revision regression check | — |
| WMB-0302 | M-300 | CAP-004 | todo | WMB-0301 | Atomic asset import, hash reuse, metadata | Interrupted import leaves no referenced partial file | — |
| WMB-0303 | M-300 | CAP-004 | todo | WMB-0302 | Studio view, version history, platform tabs, conflict reload | Manual UI acceptance | — |
| WMB-0304 | M-300 | CAP-005 | todo | WMB-0202, WMB-0301 | Loopback MCP server and required read tools | MCP client black-box readback | — |
| WMB-0305 | M-300 | CAP-005 | todo | WMB-0304 | MCP write tools, request idempotency, revision conflicts | EVAL-002 | — |
| WMB-0401 | M-400 | CAP-006 | todo | WMB-0104 | Installed Chrome discovery/selection, dedicated profile, CDP lifecycle | PID/profile/endpoint/login readback | — |
| WMB-0402 | M-400 | CAP-006 | todo | WMB-0401 | Account identity persistence and mismatch blocking | Wrong-account negative check | — |
| WMB-0403 | M-400 | CAP-007 | todo | WMB-0302, WMB-0402 | Publication, attempt, confirmation, reconciliation schema and state machine | State transition regression checks | — |
| WMB-0404 | M-400 | CAP-007 | todo | WMB-0403 | Prepare/editor readback and confirmation snapshot | EVAL-009 | — |
| WMB-0405 | M-400 | CAP-007, CAP-013 | todo | WMB-0404 | Publish UI, UI-only confirm, timeline, takeover, reconcile | EVAL-010 local controlled failure | — |
| WMB-0501 | M-500 | CAP-008 | todo | WMB-0405 | X account identify and pure-text publish/readback | EVAL-003 real status URL/ID | — |
| WMB-0502 | M-500 | CAP-008 | todo | WMB-0501 | X one-image publish/readback | EVAL-004 real status URL/ID | — |
| WMB-0503 | M-500 | CAP-008 | todo | WMB-0501 | X one-video publish/readback and processing wait | EVAL-005 real status URL/ID | — |
| WMB-0504 | M-500 | CAP-008, CAP-011 | todo | WMB-0501 | X creator-page metric mapping | Real snapshot with source and field statuses | — |
| WMB-0601 | M-600 | CAP-009 | todo | WMB-0405 | Xiaohongshu account identify and image-note publish/readback | EVAL-006 real note URL/ID | — |
| WMB-0602 | M-600 | CAP-009 | todo | WMB-0601 | Xiaohongshu video-note publish/readback and processing wait | EVAL-007 real note URL/ID | — |
| WMB-0603 | M-600 | CAP-009, CAP-011 | todo | WMB-0601 | Xiaohongshu creator-page metric mapping | Real snapshot with source and field statuses | — |
| WMB-0701 | M-700 | CAP-010 | todo | WMB-0405 | WeChat account identify, article editor prepare/readback | Editor and identity receipt | — |
| WMB-0702 | M-700 | CAP-010 | todo | WMB-0701 | WeChat actual publish, takeover, accessible article readback | EVAL-008 real article URL | — |
| WMB-0703 | M-700 | CAP-010, CAP-011 | todo | WMB-0702 | WeChat backend metric mapping | Real snapshot with source and field statuses | — |
| WMB-0801 | M-800 | CAP-011 | todo | WMB-0504, WMB-0603, WMB-0703 | Metric jobs, four capture windows, idempotency, overdue recovery | EVAL-011 metric/job portion | — |
| WMB-0802 | M-800 | CAP-011 | todo | WMB-0402, WMB-0801 | Account metric snapshots | Follower/account snapshot readback | — |
| WMB-0803 | M-800 | CAP-011 | todo | WMB-0801 | Results snapshot/raw/status views | Manual values match creator pages | — |
| WMB-0804 | M-800 | CAP-012 | todo | WMB-0202, WMB-0803 | Reviews, method findings, backlinks, Results UI | EVAL-012 | — |
| WMB-0901 | M-900 | CAP-001 | todo | WMB-0104 | Whole data-root move/reopen | EVAL-013 | — |
| WMB-0902 | M-900 | CAP-007 | todo | WMB-0405 | Crash/restart publication safety | EVAL-010 and restart receipt | — |
| WMB-0903 | M-900 | CAP-001, CAP-002, CAP-003, CAP-004, CAP-005, CAP-006, CAP-007, CAP-008, CAP-009, CAP-010, CAP-011, CAP-012, CAP-013 | todo | WMB-0804, WMB-0901, WMB-0902 | Full harness checks and packaged Windows build | package checks and installer receipt | — |
| WMB-0904 | M-900 | CAP-008, CAP-009, CAP-010, CAP-011, CAP-012 | todo | WMB-0903 | Six-format live acceptance and full feedback chain | EVAL-001–EVAL-013 all pass | — |
