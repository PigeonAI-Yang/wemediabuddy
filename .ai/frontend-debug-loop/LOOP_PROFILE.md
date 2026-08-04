project-purpose: Pi tool summaries tell the user both what is running and whether work is still progressing without opening raw details.
target-surface: Current tool row inside the packaged Pi transcript.
runtime-chain: Pi tool start/result events -> streaming message segments -> transcript running-state projection -> logo activity DOM/CSS.
completion-authority: only an unfinished tool in the streaming turn animates; tool result, error, stop and turn completion remove the activity state while details remain expandable.
focused-gate: deterministic start/result projection test plus packaged live Pi tool call animation and completion readback.
budgets: one transcript render change, one CSS change, one focused regression, one packaged live verification.
stop-conditions: tool completion cannot be inferred truthfully from existing events, animation obscures the summary, or live tool execution cannot be observed.
