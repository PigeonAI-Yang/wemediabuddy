purpose: Make Pi retry acknowledge a user's click immediately without changing native fork semantics.
fails-when: A delayed fork leaves the clicked control visually unchanged.

Loop: wmb-3600-pi-retry-feedback
Symptom: Retry appears dead for several seconds.
Observation packet: Source trace shows `forkMessage` awaits `window.wmb.forkPiConversation` before the first state update; the context-bridge API is frozen, so runtime delay injection was not performed against user data.
Hypotheses: Missing pending renderer state remains supported and not yet repaired.
Bug type: timing-stale / side-effect-missing feedback.
Chain traced: retry click -> `forkMessage` -> `pi:fork` -> native Pi fork -> conversation update.
Breakpoint: Renderer action lifecycle before the first await.
Root cause: Pending UI state is absent.
Files read: `src/renderer/pi-dock.tsx`, `src/renderer/pi-dock-transcript.tsx`, `src/main/ipc-pi-dock.ts`.
Files changed: none for product behavior.
Before/after gate: before established from source and user screenshot; after deferred.
Owner check: superseded temporarily by higher-risk interrupted-turn data loss.
Result: paused as todo; no completion claim.
State update: WMB-3600 now follows WMB-3602.
Clean completion: no
Blocked reason: deliberately reprioritized behind conversation data integrity.
