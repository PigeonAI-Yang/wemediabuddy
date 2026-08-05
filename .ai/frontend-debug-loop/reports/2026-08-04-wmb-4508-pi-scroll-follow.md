purpose: Pi output follows by default and pauses only for deliberate historical reading; fails when either real packaged path loses its required position.

Loop: wmb-4508-pi-scroll-follow
Symptom: New Pi output required 回到最新 even without user interaction.
Observation packet: Current onScroll assigned followingLatest solely from a transient 48px bottom-distance check. Minimal reproduction returned bug=true with userActed=false and following=false.
Hypotheses: Layout/programmatic scroll was being mistaken for user intent; confirmed by the handler and falsified after intent gating.
Bug type: timing-stale.
Chain traced: Pi message state -> transcript DOM growth -> onScroll -> followingLatest -> layout scroll effect -> visible position.
Breakpoint: src/renderer/pi-dock-transcript.tsx scroll-state transition.
Root cause: Every scroll event could disable following; no input event proved that the reader had actually scrolled.
Files read: PRD.md, SPEC.md, PLAN.md, TASKS.md, TECHNICAL_DESIGN.md, docs/development-workflow.md, docs/verification.md, pi-dock-transcript.tsx, pi-dock-utils.ts, pi-message-flow.test.mjs.
Files changed: pi-dock-transcript.tsx, pi-dock-utils.ts, pi-message-flow.test.mjs, TASKS.md and loop evidence.
Before/after gate: Before, no-user-action metrics 800/1300/400 produced following=false. After, packaged streaming recorded 28 growth samples at distance 0 with no button. A deliberate 650px upward wheel showed the button; another real Pi turn grew content 984px while scrollTop remained exactly 37259. 回到最新 restored distance 0 and hid the button.
Owner check: user-blocked-on resolved; real Pi state used; existing button/animation/message UI preserved; loading/empty/error behavior unchanged; regression risk covered in both directions.
Result: pass.
State update: complete.
Clean completion: yes.
Blocked reason: none.
