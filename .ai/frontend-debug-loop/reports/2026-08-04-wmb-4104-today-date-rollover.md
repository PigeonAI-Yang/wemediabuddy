purpose: Today keeps the creator's latest usable opportunities visible until the new day's plan replaces them.
fails-when: A date rollover shows historical sources as current while hiding the matching latest plan, or prior data satisfies exact-date task validation.

Loop: WMB-4104
Symptom: 66 sources were visible but the largest opportunity panel said nothing was available.
Observation packet: Real UK root had 66 sources and a 10-item current plan on 2026-08-03; the 2026-08-04 read fell back sources but returned no plan.
Hypotheses: Source and plan rollover semantics diverged.
Bug type: selector/view-model.
Chain traced: root SQLite -> `getToday` -> IPC -> App state -> Today items -> opportunity cards.
Breakpoint: `getToday` mixed historical source fallback with exact-only plan output.
Root cause: The UI had no separately dated latest-plan field and therefore rendered an empty state after midnight.
Files changed: workbench read model, Today renderer/types, focused regression, operator Skill.
Before/after gate: Packaged real-root read now keeps exact plan null while exposing `latestPlan` dated 2026-08-03 with 10 items; DOM renders all 10 and labels the date.
Owner check: Current-day task validation and start action remain exact-date; no cross-root or synthetic plan fallback.
Result: Latest opportunities remain usable across rollover.
State update: complete.
Clean completion: yes.
Blocked reason: none; unrelated full-suite baseline failures are recorded in TASKS.md.
