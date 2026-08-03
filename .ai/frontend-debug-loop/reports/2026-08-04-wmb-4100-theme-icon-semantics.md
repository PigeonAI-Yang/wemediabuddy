purpose: The footer theme control communicates current appearance while its title communicates the switch target.
fails-when: Dark lacks a moon, light lacks a sun, or clicking cannot toggle both ways.

Loop: WMB-4100 theme icon semantics
Symptom: Current-theme icons were reversed.
Observation packet: Packaged dark was `☀ 黑夜紫罗兰`; light was `☾ 白昼紫罗兰`; action titles were already correct.
Hypotheses: Only the icon branch was reversed; confirmed by source and live toggle.
Bug type: mapping-wrong.
Chain traced: persisted theme -> React conditional -> status-theme text -> pixels.
Breakpoint: icon conditional in `main.tsx`.
Root cause: Icon branches represented the target theme while the adjacent label represented the current theme.
Files read: `main.tsx` and packaged DOM.
Files changed: `main.tsx`, `tests/footer-theme-ui.test.mjs`.
Before/after gate: Packaged dark now `☾ 黑夜紫罗兰`; click yields `☀ 白昼紫罗兰`; second click restores dark; titles still name the target.
Owner check: Theme palette, persistence and click behavior unchanged.
Result: complete.
State update: complete.
Clean completion: yes
Blocked reason: none.
