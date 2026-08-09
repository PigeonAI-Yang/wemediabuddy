# EVAL-CAP-004

- Capability: Studio content projects — create/list/open projects, immutable core versions, platform versions; human+Pi share project state without losing the open project.
- Tasks: foundation M-300 chain; WMB-4974 (list click = Pi focus without entering editor; open/double-click enters; editor focus includes body excerpt).
- Preconditions: renderer Studio library with one or more projects; Pi dock configured optional for context chip only.
- Steps:
  1. Open Studio library (no project selected). Click a project row once — Pi chip shows project title; editor does not open.
  2. Click the same row again — focus clears.
  3. Double-click or use「打开」— editor opens for that project; Pi focus includes body excerpt when body exists.
  4. Back to library — list focus behavior still available.
- Expected observable results: click ≠ navigate; open is explicit; `pageFocus` / studio context carry project id+title; typecheck clean.
- Command evidence: `npm run typecheck` → 0; `tests/pi-context-payload.test.mjs` → 4/4; focused studio behavior covered by WMB-4974 implementation + `.ai/wmb-4973-4976-evidence.md`.
- Manual/live evidence: optional visual check of `.studio-project-row.selected` styling.
- Result: pass
- Failure reason: none.
- Pi operator Skill impact: no change — renderer focus wiring only.
