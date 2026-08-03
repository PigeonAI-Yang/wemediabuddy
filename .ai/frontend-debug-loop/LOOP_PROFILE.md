project-purpose: WMB Pi dock lets users continue and retry real Pi conversations without ambiguous clicks.
target-surface: Pi message fork and retry action buttons.
runtime-chain: click -> renderer handler -> pi:fork IPC -> Pi native fork -> conversation state -> optional retry send -> DOM status.
completion-authority: packaged Windows DOM readback on the same delayed click path.
focused-gate: visible pending feedback within one render frame; duplicate click disabled; success and failure settle truthfully.
budgets: one implementation attempt, one repair attempt, at most eight tracked product files.
stop-conditions: native fork semantics must change, real user data would be required, or root cause expands beyond the action lifecycle.
