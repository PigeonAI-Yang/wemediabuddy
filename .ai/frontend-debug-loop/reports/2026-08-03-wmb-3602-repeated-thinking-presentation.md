purpose: Keep Pi reasoning inspectable without letting completed max-reasoning loops dominate the conversation.
fails-when: Completed raw thinking remains fully expanded or WMB deletes/reorders true output.

Loop: wmb-3602-repeated-thinking-presentation
Symptom: Pi appears to repeat the same content continuously.
Observation packet: Packaged DOM had zero exact duplicate segments but 42 fully expanded historical thinking segments; raw JSONL showed the same semantic revisiting under deepseek-v4-flash thinking=max.
Hypotheses: WMB presentation amplified provider repetition rather than duplicating text; confirmed.
Bug type: render presentation.
Chain traced: raw thinking entries -> ordered segments -> transcript component -> DOM.
Breakpoint: Completed thinking render policy.
Root cause: Every historical reasoning segment stayed expanded forever.
Files read: raw active Pi session, `pi-transcript-projection.ts`, `pi-dock-utils.ts`, `pi-dock-transcript.tsx`, `styles-pi.css`.
Files changed: `pi-dock-utils.ts`, `pi-dock-transcript.tsx`, `styles-pi.css`, DESIGN/SPEC and focused test.
Before/after gate: before 42 completed thinking bodies expanded; after 42 one-line summaries, zero details visible, one clicked detail visible.
Owner check: No content/model/preset mutation; 28 reply segments and 54 tool lines retained.
Result: fixed.
State update: WMB-3602 done; WMB-3600 next.
Clean completion: yes
Blocked reason: none.
