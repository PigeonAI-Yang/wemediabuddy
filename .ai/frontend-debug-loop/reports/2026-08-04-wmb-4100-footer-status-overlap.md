purpose: The global footer presents operational truth; this loop keeps every status in one readable layout flow.
fails-when: Any X operation trigger rectangle intersects another footer item at the Owner viewport.

Loop: WMB-4100 footer status overlap
Symptom: X List operation text covered workspace and MCP statuses.
Observation packet: Packaged 1600x960 DOM; trigger parent `app-shell pi-open`, fixed at left 220/bottom 4; intersections with workspace and MCP in both themes.
Hypotheses: Out-of-flow fixed positioning was the overlap source; confirmed by exact rectangles.
Bug type: dom-hidden / layout.
Chain traced: operation state -> XListOperationTray -> fixed trigger -> status footer pixels.
Breakpoint: `styles-pi.css` fixed trigger outside `status-bar-left`.
Root cause: The global trigger was rendered before the footer and manually painted on top of it.
Files read: `main.tsx`, `x-list-operation-tray.tsx`, `styles-foundation.css`, `styles-pi.css`, packaged DOM.
Files changed: `main.tsx`, `styles-foundation.css`, `styles-pi.css`, `tests/footer-theme-ui.test.mjs`.
Before/after gate: Before two overlaps; after trigger parent is `status-bar-left`, position static, both theme overlap arrays empty.
Owner check: All five real left statuses remain visible after workspace settings load; footer hierarchy otherwise unchanged.
Result: complete.
State update: advanced to theme icon loop.
Clean completion: yes
Blocked reason: none.
