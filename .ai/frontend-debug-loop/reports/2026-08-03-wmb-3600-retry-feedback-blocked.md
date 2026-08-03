purpose: Make Pi retry acknowledge a user's click immediately without changing native fork semantics.
fails-when: A deliberately delayed fork does not show pending state within one frame or failure does not restore the action.

Loop: wmb-3600-pi-retry-feedback
Symptom: Retry appears dead for several seconds.
Observation packet: Handler awaited `forkPiConversation` before any state update; user screenshot showed no response. Context bridge is frozen, so an isolated packaged process was prepared for deterministic delay.
Hypotheses: Missing pending state is the renderer breakpoint; supported by source order.
Bug type: side-effect-missing feedback.
Chain traced: click -> Renderer pending state -> pi:fork IPC -> native Pi process -> success/failure settlement -> DOM.
Breakpoint: Renderer before first await; packaged gate harness later failed before the click.
Root cause: No pending action lifecycle existed.
Files read: `pi-dock.tsx`, `pi-dock-transcript.tsx`, `styles-pi.css`, `ipc-pi-dock.ts`, packaged Pi process launch path.
Files changed: Renderer action state/transcript/CSS, focused check and isolated acceptance script; uncommitted.
Before/after gate: Source before/after and focused check pass. Packaged delayed gate attempt 1 had no renderer page yet; attempt 2 assumed a node.exe child, while packaged Pi is WeMediaBuddy.exe running with ELECTRON_RUN_AS_NODE. No button click occurred.
Owner check: Real user data protected by isolated root; runtime loading/error states remain unverified.
Result: blocked under the Skill two-failure stop rule.
State update: WMB-3600 blocked; product diff intentionally uncommitted.
Clean completion: no
Blocked reason: Same packaged gate failed setup twice for different reasons; resume requires a fresh loop audit and correct Pi process selector.
