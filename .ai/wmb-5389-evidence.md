# WMB-5389 Historical Approved Thesis-Lock Repair

Date: 2026-08-31

## Verdict

**PASS.** The exact historical approved plan item now has a canonical `editorial_decision`, `thesis_lock_v1`, and `propagation_v2` truth-gate score through the product `CommandDispatcher`. Approval stayed terminal; the existing project and content version were not replaced or reused as a fake new Writer output.

## Exact identity

- Plan item: `8342f64f-916e-498a-82df-c8628917885b`
- Project: `6ce12d8a-d12d-449d-baca-fcdc55b0f3c8`
- Before: `approved@r3`, no thesis lock, one content version
- After: `approved@r4`, `thesis_lock_v1`, one unchanged content version

## Authorized repair contract

The repair command accepts an explicit Owner-authorized three-level editorial decision and `propagation_v2` score. It validates:

- complete proposal fields and non-placeholder content;
- winner thesis equality with the existing approved `point_of_view`;
- editorial knowledge references;
- truth-gate source references against the approved plan-item source scope;
- exact revision and terminal `approved` state;
- absence of any existing thesis lock.

It writes only `score_reasons_json`, canonical planning provenance, `updated_at`, and `revision + 1` in the same command transaction. Existing locks, conflicting decisions, stale revisions, invalid evidence, or backup/pre-state mismatch fail closed.

## Product receipt

- Command: `plan_item.repair_approved_chain`
- Request: `WMB-5389-real-20260831:owner-authorized-kernel-1`
- Receipt: `4c327c95-7e0e-4964-9524-a82b35b65079`
- Status: `ok / committed`
- Revision: `3 → 4`
- Action: `thesis_lock_repaired`
- Actor: `owner_ui / owner:yangda01`

Exact readback:

- `planning_status=approved`
- `thesis_lock.version=thesis_lock_v1`
- `thesis_lock.approvedBy=owner:yangda01`
- `thesis_lock.repair.version=approved_thesis_repair_v1`
- `score_reasons.version=propagation_v2`
- content version count remains `1`
- existing version `7d3a2189-f217-4e8e-acdd-d85fef4be153` remains non-empty (`2062` characters)

## Backup and rollback binding

- Verified offline pre-state copy: `J:/wmb-out/wmb-5389-prestate.db`
- SHA256: `107907AE4C33962A4AC01FB15D538817EC434694965AF1B8E6E90D32313CCF1D`
- `PRAGMA quick_check`: `ok`
- Pre-state hash: `D82A479BB270D1B300C38CB881049C42551BCE87C82237782EC51C81C073047F`

The normal standalone Node process repeatedly hit Windows SQLite `IOERR_TRUNCATE` while opening the 2.4 GB live database for backup/write. No business transaction began in those failed attempts. The final product command ran in the persistent JS runtime that had already proven a successful full WAL checkpoint, while preserving the same verified backup and pre-state binding.

## Verification

- Focused repair behavior: `node --experimental-strip-types --test --test-name-pattern="repairs a legacy approved thesis lock" tests/approved-plan-chain-repair.test.mjs` — PASS 1/1.
- Verified external-backup CLI contract: `node --experimental-strip-types --test --test-name-pattern="accepts an exact verified external backup" tests/approved-plan-chain-repair.test.mjs` — PASS 1/1.
- Real command receipt and database readback listed above.
