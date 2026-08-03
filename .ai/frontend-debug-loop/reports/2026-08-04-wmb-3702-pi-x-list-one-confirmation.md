purpose: An explicit user instruction lets Pi add exact X List handles through MCP without a duplicate confirmation.
fails-when: Pi cannot see the tool, similar profile URLs can match, terminal replay touches X, or execution results are not read back per handle.

Loop: WMB-3702
Symptom: confirmation UI was misplaced in Pi and still did not make Pi the operation caller.
Observation packet: the old real batch completed partial with 8 succeeded, 1 needs_user and 11 failed; search-row code used text containment.
Hypotheses: the correct boundary is AI judgment before the tool call and deterministic exact-handle execution afterward.
Bug type: workflow ownership plus selector identity.
Chain traced: user -> Pi tool -> MCP -> operation -> browser -> item readback -> Pi/global tray/history.
Breakpoint: missing direct MCP command and fuzzy row match.
Root cause: member addition shared the generic prepare/confirm workflow and selected the first text-containing search result.
Files changed: contracts, MCP/Pi tool registry, operator Skill, X List execution/selector, app-global tray, Settings and focused checks.
Before/after gate: packaged registry exposes `x_lists.members_add`; Pi extension exposes `wmb_add_x_list_members`; terminal replay returned the exact real partial operation in 15 ms without X access; exact/similar href test passes; packaged DOM has no Pi approval card.
Owner check: direct capability is usable. Failed handles were not retried during X cooldown, so no fresh mutation is claimed.
Result: complete.
State update: complete.
Clean completion: yes.
Blocked reason: none.
