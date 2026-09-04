# WMB-5354 Live Production Acceptance — Accepted

Date: 2026-08-31

## Verdict

**PASS / ACCEPTED.** The exact packaged production chain reused the historical plan item and project, consumed the existing Reporter evidence package and approved direction, dispatched a real Writer, committed a new non-empty content version through an exact-task `content.save_version` receipt, and reached investigation `completed`. No seed row, replacement plan item, terminal-state reset, direct provenance write, or reuse of the old content version was accepted as completion.

## Fixed identities

- Plan item: `8342f64f-916e-498a-82df-c8628917885b`
- Content project: `6ce12d8a-d12d-449d-baca-fcdc55b0f3c8`
- Real data root: `J:/PigeonYang/WeMediaBuddyData`
- Current packaged app: `J:/wmb-out-5377/WeMediaBuddy-win32-x64/WeMediaBuddy.exe`
- Launch mode: packaged Electron, isolated user-data, real database, no seed data

## Existing Planner → Owner authority chain

The exact plan item contains a real immutable planning provenance chain:

- Planner task/job: `616f21f7-9a94-4640-ba32-82f2c0d978aa`
- `draft → ready_for_review` by `planner` at `2026-08-23T17:44:14.162Z`
- `ready_for_review → approved` by `owner_ui` at `2026-08-23T17:45:33.421Z`
- Current status/revision: `approved@r4`

The item predates the canonical editorial-thesis approval contract. WMB-5389 repaired that exact historical omission through an Owner-authorized `plan_item.repair_approved_chain` receipt, preserving terminal approval and adding canonical `editorial_decision`, `propagation_v2`, and `thesis_lock_v1` provenance.

## Reporter acceptance

WMB-5377 removed the duplicate-canonical-URL request-identity conflict and the current packaged app produced a real evidence package:

- Reporter job: `bc242682-7e40-4080-a5ec-01a776a5f811`
- Reporter task: `2d46deeb-6996-4854-a2c2-ae536edb0347`
- Reporter terminal: `partial / candidates_exhausted`
- Project investigation: `research_review@r10`
- ResearchEvidencePack: 3 claims, 8 sources, 1 unresolved required claim
- Persisted claims: 3, all terminal
- Command receipts: 16 receipts, 16 distinct request IDs, 0 conflicts, 0 cross-command identity reuse

This is a truthful Reporter terminal with a non-empty package, not `RESEARCH_FAILED`.

## Research review and Owner direction approval

The packaged app consumed the real evidence package through production IPC:

1. `investigation.review_research` accepted the package and saved direction version 1: `direction_pending_approval@r11`.
2. `investigation.decide_direction` approved direction version 1: `ready_to_write@r12`.
3. `investigation.start_writer` dispatched Writer job `74ee4fd5-1a38-4160-bef4-1d8b991734f1`: `writing@r13`.

The approved direction explicitly removes the unsupported claim that Yann LeCun said verbatim that ChatGPT cannot reason, preserves the unresolved claim, and restricts the article to sourced evidence about world models, planning, external feedback, and reliable reasoning boundaries.

## Historical repair prerequisite

- Repair command: `plan_item.repair_approved_chain`
- Repair receipt: `4c327c95-7e0e-4964-9524-a82b35b65079`
- Plan-item revision: `approved@r3 → approved@r4`
- Repair action: `thesis_lock_repaired`
- Existing project, version 1, and done Carry identities remained unchanged
- Verified pre-state backup, SHA256, pre-state hash, and complete repair evidence: `.ai/wmb-5389-evidence.md`

## Writer acceptance

- Writer job: `5d0c84da-f1a0-4ed2-8f42-b7b9783af71d`
- Writer task: `b4aa2902-53ff-40c1-92a0-f3f4ee71b7f6`
- Model route: `gpt-5.6-luna`, `thinking=max`
- Writer task terminal: `succeeded / completed`
- Investigation terminal: `completed@r16`, Writer status `succeeded`
- `content.save_version` receipt: `e7e8d4eb-9558-434a-b136-da7a4ffe4eb9`
- Receipt request: `b4aa2902-53ff-40c1-92a0-f3f4ee71b7f6:core_version_retry2`
- Receipt status: `ok / committed`
- Exact result/readback version: `3d03ab2f-17ce-463d-a723-311349acbe15`, version 2
- New body length: `3071` characters
- Content versions: `1 → 2`; empty versions: `0`

The successful receipt is bound to the exact Writer task and reads back the same project/version identity. The previous failed task's reference to version 1 remains historical and is not counted as this delivery.

## Acceptance matrix

| Requirement | Result |
|---|---|
| Exact plan item/project reused | Pass |
| Real Planner → Owner approval provenance | Pass, historical immutable chain plus receipt-backed lock repair |
| Real Reporter package and new claims | Pass: 3 claims / 8 sources |
| Research review and direction approval | Pass |
| Real Writer terminal success | Pass: job `5d0c84da`, task `b4aa2902`, investigation `completed@r16` |
| New non-empty content version | Pass: version 2, 3071 characters, exact save receipt/readback |
| No fabricated/direct writes | Pass |

## Cleanup

- Packaged acceptance app closed.
- Process-level check found no running `WeMediaBuddy.exe`.
- Isolated acceptance user-data directory removed; no `wmb-5354-rerun-*` directory remains.
- Console errors: 0; page errors: 0.
