# WMB-5158 Evidence

## Delivered

- Added `TopicMaintenanceSnapshotV2.conflictContract`; proposal generation is the only scope builder and approval only evaluates the persisted contract.
- Unrelated third-topic/source drift no longer blocks reassign. Topic revision, canonical occupation, merge membership and target unique-key drift return structured `staleReason` with zero formal writes.
- v1 proposals keep the legacy comparison path; historical stale rows are not rewritten or revived.
- Rejected order-dependent batches: merge with update/archive/reassign on either topic, overlapping reassign relation sets, baseline same-canvas merge collisions and duplicate canonical changes.
- Migration 52 adds nullable `stale_reason_json`; EVAL-029 fixture and Settings schema readback moved from 51 to 52.

## Verification

- `node --test --experimental-strip-types tests/wmb-5150-topic-maintenance.test.mjs` — 9/9 PASS.
- `node --test --experimental-strip-types tests/wmb-5150-topic-maintenance.test.mjs tests/eval-029-fixtures.test.mjs tests/settings.test.mjs` — 19/19 PASS.
- `npm run typecheck` — PASS.
- `npm run check:capabilities` — PASS; no registry change.
- `powershell -ExecutionPolicy Bypass -File scripts/check.ps1` — PASS.
- `npm test` — 678/678 PASS after schema-version fixture updates.
- `git diff --check` — PASS (only existing line-ending warnings).

## Independent review

Architecture/data/reliability reviews agreed on persisted canonical conflict scope and durable follow-up. Four adversarial code-review rounds found and closed target-carry false stale, canvas uniqueness leakage, merge/update/reassign order dependence and overlapping reassign relation sets. `wmb_5158_accept_review` final verdict: PASS, no blocker/high.
