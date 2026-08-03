purpose: Settings owns X List configuration and confirmation; Discover only helps the user consume selected List content.
fails-when: Discover still exposes a binding/mutation control, or Settings cannot surface Pi-prepared operation 93df4a01-f437-4d91-b358-961d6afebf7b.

Loop: WMB-3700
Symptom: Pi told the user to confirm a prepared X List members operation in UI, but management remained hidden in Discover.
Observation packet: Source and live DB readback showed the 20-item operation persisted as prepared while Discover rendered binding, composer, confirmation and history; Settings rendered visibility only.
Hypotheses: WMB-3200/3300 migrated only visibility and channel configuration, leaving the original management subtree behind. Confirmed by Git blame and source path.
Bug type: render ownership / information architecture regression.
Chain traced: Pi MCP prepare -> x_list_operations -> preload list/get/arm/confirm -> renderer active operation -> UI confirmation.
Breakpoint: the renderer consumer of the mutation commands was x-lists-view.tsx under Discover.
Root cause: partial UI migration, not missing operation data or missing IPC.
Files read: PRD.md, SPEC.md, PLAN.md, TASKS.md, TECHNICAL_DESIGN.md, docs/development-workflow.md, docs/verification.md, docs/pi-operation-skill-maintenance.md, renderer X List/Settings sources and focused tests.
Files changed: PLAN.md, TASKS.md, canonical operator Skill, Settings/X List renderer sources, CSS and focused tests.
Before/after gate: before Discover owned prepare/confirm/bind and Settings could be cancelled by concurrent shared-browser validation. After focused checks pass and the current formal package reads Settings management=true, prepared operation visible=true, history=2, Discover management=false and width 1330/1330.
Owner check: the running UK workspace presents `读取最新快照` on the first screen; both real operations remain prepared with 20/20 pending, so acceptance performed no X mutation. Existing WMB-3600 dirty product work was not edited.
Result: delivered and running.
State update: complete.
Clean completion: yes
Blocked reason: none.
