purpose: A visible Pi tool summary must show whether that exact tool is still running; fails when active and completed rows remain visually identical.

Loop: WMB-4500 Pi tool activity
Symptom: The user sees a tool name but cannot tell whether it is working or stuck without opening it.
Observation packet: packaged Pi dock at 1600x960; screenshot supplied by owner; `.pi-tool-line > summary` has no animation and the row has no running class.
Hypotheses: confirmed that start/result state is already present as streaming plus absence/presence of the tool output property, but the transcript ignores it.
Bug type: state-to-DOM projection missing.
Chain traced: `app-window.ts` events -> `pi-dock.tsx` -> `pi-dock-utils.ts` -> `pi-dock-transcript.tsx` -> shared `wmb-brand-mark.tsx` and foundation animation styles.
Breakpoint: tool segment render.
Root cause: the generic activity card only covers a streaming turn with zero segments; once a tool segment exists there is no activity UI.
Files read: Pi event bridge, dock state/update utilities, transcript, Pi CSS, message types and focused tests.
Files changed: reusable WMB creature brand component, foundation motion states, Pi tool-state binding, focused regression and task/loop evidence.
Before/after gate: before static/no animation; after packaged live read measured 7 body and 6 pupil transforms while busy, then a 420ms settling blink and exact idle/no-animation state.
Owner check: the one-line collapsed summary and expandable details remain; real motion receipt `.ai/wmb-4500-motion.gif` and screenshots show the current package.
Result: the brand itself now communicates active tool work and is reusable outside Pi through one shared component.
State update: complete.
Clean completion: yes.
Blocked reason: none.
