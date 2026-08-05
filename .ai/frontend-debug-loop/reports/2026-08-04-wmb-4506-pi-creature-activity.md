purpose: Pi connection and tool activity use one visibly moving WMB creature; fails when the connecting card shows a ball or a running 20px mark is perceptually static.

Loop: WMB-4506 Pi creature activity
Symptom: Owner saw a static creature during Pi tools and an unrelated pulsing ball while Pi connected.
Observation packet: Current packaged renderer at 1600x960; reduced motion was false; manually forcing `is-working` changed matrices but the old 751-unit SVG translations became only about 0.5-0.75 screen pixels and began with a 336ms still interval.
Hypotheses: Confirmed that state projection and CSS animation existed; rejected disabled animation; confirmed the break was perceptual scale plus the separate connecting placeholder.
Bug type: DOM/style presentation.
Chain traced: `ipc-pi-dock.ts` -> `pi-dock.tsx` -> `pi-dock-transcript.tsx` -> `wmb-brand-mark.tsx` -> foundation/studio CSS.
Breakpoint: Active animation was owned by an inner SVG group in document units, while the connection card rendered a separate ball.
Root cause: The authentic mark changed to a 751-wide viewBox without moving activity translation to screen-pixel space; the connection placeholder was never migrated to the shared component.
Files read: project contracts/workflow, Pi event/dock/transcript/component/styles/tests, current package DOM and real Pi sessions.
Files changed: transcript, shared motion CSS, connecting-card CSS, focused regression, loop evidence and task ledger.
Before/after gate: Before, the connecting DOM was `.pi-activity-mark > i` and tool motion resolved below one visible pixel. After, connecting renders `WmbCreatureMark is-working` at 34x26 and samples -1.2px through +1.2px; a real fast `wmb_get_workbench` call ran, settled and idled; a real long `wmb_read_x_list_members` call produced twelve distinct running transforms, settled and idled.
Owner check: Real package uses real Pi/WMB read-only state, old layout remains, reduced-motion remains honored, no runtime/tool contract changed; visual acceptance is still pending.
Result: Implementation and machine-verifiable live gate passed.
State update: needs_owner.
Clean completion: no.
Blocked reason: Owner must confirm the visible motion is clear and not excessive.
