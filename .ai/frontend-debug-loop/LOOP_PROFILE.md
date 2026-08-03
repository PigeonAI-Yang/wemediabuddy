project-purpose: X List cards retain the platform's original repost and quote relationships across cache writes and restarts.
target-surface: Packaged Discover X timeline cards loaded from SQLite cache.
runtime-chain: X GraphQL post -> live parser -> timeline cache normalization -> cache IPC -> renderer mapper -> repost/quote DOM.
completion-authority: a real cached repost renders its reposter label and a real cached quote renders its nested quoted card after remount, with no live refresh.
focused-gate: real AI-list live/cache field comparison, focused cache regression and packaged cached DOM readback.
budgets: one cache normalizer repair, one focused test, one package/live verification.
stop-conditions: live parser lacks the fields, nested payload exceeds cache limits, or cache remount requires a live read.
