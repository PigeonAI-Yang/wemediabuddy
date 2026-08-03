purpose: The Pi return control must acknowledge a press without moving away from the reader's pointer.
fails-when: Packaged pointer-down has no scale/down feedback or shifts the horizontal center by more than 1 px.

Loop: WMB-4103
Symptom: The right jump was gone, but pressing the control had no visible response.
Observation packet: Before/down computed transforms were identical in the packaged app.
Hypotheses: The WMB-4102 centering override replaced the whole active transform.
Bug type: DOM/style.
Chain traced: pointer-down -> shared active rule -> Pi override -> computed transform -> button rectangle.
Breakpoint: Pi active transform composition.
Root cause: The override retained centering but discarded the shared down/scale feedback.
Files changed: `src/renderer/styles-pi.css`, focused assertion and loop receipts.
Before/after gate: before/down is now `matrix(1,0,0,1,-41,0)` -> `matrix(.98,0,0,.98,-41,1)` with center delta 0.
Owner check: Original smooth return and in-place fade remain intact; 128-frame packaged readback has center spread 0.
Result: Press feedback restored without horizontal jump.
State update: complete.
Clean completion: yes.
Blocked reason: none.
