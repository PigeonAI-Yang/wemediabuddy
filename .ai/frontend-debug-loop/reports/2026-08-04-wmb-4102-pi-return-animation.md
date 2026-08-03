# WMB-4102

- Symptom: pressing `回到最新` visibly moved it right before disappearance.
- Root cause: the shared `button:active` transform replaced the control's `translateX(-50%)`, moving its center 41 px right while held.
- Fix: preserve `translateX(-50%)` for the Pi control's active state; smooth-scroll to bottom, then fade and unmount.
- Packaged evidence: pointer-down center delta 0 px; 124 animation frames, 109 distinct scroll positions, center spread 0 px, bottom at frame 110, unmount at frame 123.
- Gates: focused tests 6/6, typecheck, diff check, Windows package.
