project-purpose: X List manual refresh updates discovery content without destroying a more complete last-good cache or making existing cards disappear.
target-surface: Packaged Discover X timeline `刷新动态` path for the selected UK List.
runtime-chain: refresh click -> preload IPC -> live X reader -> Main cache resolution -> renderer state -> timeline DOM.
completion-authority: an empty live result retains cached cards with truthful copy; a partial page merges without shrinking cache; a real refresh still renders cards and restart reads the same resolved cache.
focused-gate: deterministic 40-cache empty/20-partial regression plus packaged same-button before/after DOM and SQLite readback.
budgets: one Main cache-policy repair, one Renderer copy update, one focused test, one package/live verification.
stop-conditions: live result cannot be distinguished from parse failure, account/List identity changes, or two same-path runtime gates fail for different causes.
