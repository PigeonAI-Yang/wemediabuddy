purpose: The return-to-latest control should be discoverable at the transcript's bottom center without changing scroll ownership.
fails-when: Button and transcript center differ by more than 1px or clicking does not reach the exact bottom.

Loop: WMB-4101 Pi return center
Symptom: Control appeared at bottom-right.
Observation packet: Packaged transcript center X 1342, button center X 1543, delta 201px; right 16px and no transform.
Hypotheses: Explicit right anchoring caused the offset; confirmed by computed style and geometry.
Bug type: dom-hidden / layout.
Chain traced: manual upward scroll -> visibility state -> pi-jump-latest -> absolute positioning -> pixels.
Breakpoint: `.pi-jump-latest` horizontal anchor in `styles-pi.css`.
Root cause: The existing control was intentionally right-anchored.
Files read: `styles-pi.css`, `pi-dock` transcript behavior, packaged DOM.
Files changed: `styles-pi.css`.
Before/after gate: Before center delta 201px; after 0px. Click remains exact bottom distance 0.
Owner check: Bottom offset, appearance, visibility and scroll-follow behavior unchanged.
Result: complete.
State update: complete.
Clean completion: yes
Blocked reason: none.
