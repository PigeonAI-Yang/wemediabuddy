# WMB-5373 Workspace Orchestrator Adversarial Acceptance

## Result

- Execution suite: 29/29 test cases passed, 0 failed, 0 skipped.
- Durable scenario outcomes: 21 `passed`, 8 `not_executed`, 0 `failed`.
- Product acceptance gate: **rejected**. The suite completed successfully because unavailable production contracts were recorded as explicit blockers rather than fabricated passes.
- Each scenario creates an independent acceptance run, baseline tuple, evidence pointer, durable readbacks, and negative zero-write assertions through the production Actor/Root/Resource/Snapshot/Recovery/Manager APIs.

## Verification

`node --test --test-concurrency=1 tests/wmb-5373-adversarial-a29-a34.test.mjs tests/wmb-5373-adversarial-a35-a40.test.mjs tests/wmb-5373-adversarial-a41-a46.test.mjs tests/wmb-5373-adversarial-a47-a52.test.mjs tests/wmb-5373-adversarial-a53-a57.test.mjs`

Final result: 29 tests, 29 pass, 0 fail, 0 skipped; duration 30.44 seconds.

## Passed scenarios

- A29: logical invocation/replay and repaired binding hash DAG.
- A30: spawn crash boundaries adopt or kill exactly one process.
- A31: an independent durable sink commits one row per effect token; adapter restart queries the committed outcome and settles the same consumption without replaying the external effect.
- A32: 37 transaction-internal crash injections span T1–T8 registry, business-row, checkpoint/index, and event/outbox boundaries; every failed attempt leaves the complete workspace snapshot unchanged, then a fresh Store replay commits one complete bundle.
- A33: stall takeover leaves one authority winner.
- A34: T8 cancel atomically terminalizes root, intent, mailbox, active claims, dispatches, effect consumptions, building scopes, active-root index, settlement registry, event, and outbox; frozen scopes remain immutable, leases expire at cancellation time, terminal hashes are first-writer immutable, and old Actor dispatch/effect/stage deliveries are authorization-rejected with zero terminal-row writes.
- A35: cancel/handoff lock order creates no post-cancel Judge child.
- A36: source freeze and F→J handoff require a complete current-channel authority readback; auth/config/capability/profile revision drift, revocation, and lease expiry fail closed before any unauthorized snapshot or Judge write, while the frozen predecessor remains immutable.
- A37: invalid channel policy rejects before root with zero business writes.
- A38: absent/not_applicable/frozen projection states and index rebuild are durable.
- A39: migration journal replay/conflict and global zero-write fence.
- A40: legacy renderer/MCP/scheduler/binary producers are cutover-rejected.
- A41: producer census/attestation and cancellation reject dynamic writers.
- A42: rollback deny/drain/verify completion atomically rebinds the terminal startup gate to the current Actor owner/token/checkpoint; stale rollback fences remain rejected, the first post-rollback legal intent succeeds, and terminal replay is checkpoint/event-idempotent.
- A43: 100 equivalent scheduler requests coalesce with monotonic mailbox backpressure.
- A44: Judge admission enforces one active slot while deterministic priority and durable UTC aging promote waiting reservations; only process-free reserved work is preemptable, and replay/restart duplicate no claim, dispatch, or root.
- A45: 80-source cap permits exactly one unique F-to-J handoff.
- A46: same-root evidence successor API creates stable ordinal 1/2 stage/claim identities, replays without writes, rejects no-op and ordinal overflow before writes, and commits strict progress while reusing the frozen source lineage.
- A47: hung required probes persist a canonical lease, resume exactly once across Store restart/replay, then terminalize at the aggregate monotonic deadline as PRECHECK_DEADLINE without creating roots, claims, or dispatches; unrelated mailbox work remains serviceable.
- A48: monotonic deadlines create immutable gate epochs.
- A51: all-optional failures expose explicit action without root or worker.
- A53: outbox/inbox resync, index rebuild, and stale CTA fail closed.
- A54: late legacy delivery after tombstone is authorization-rejected and audit-only.
- A56: live-channel failure matrix preserves trusted receipt and coverage boundaries.
- A57: redaction and authorizer boundaries deny privilege, forged hash, SQL mutation, and publish.

## Not-executed blockers

| Scenario | Blocker | Required production capability |
| --- | --- | --- |
| A49 | `SCOPE_ARCHIVE_API_MISSING` | Archive/tombstone API and durable scope archive-chain anchor. |
| A50 | `SOURCE_PROVENANCE_API_MISSING` | Cross-root receipt provenance validation and `SOURCE_PROVENANCE_MISMATCH`. |
| A52 | `APPROVAL_EXECUTOR_API_MISSING` | Owner approval execution, stale/blocked ID denial, and repair executor. |
| A55 | `WMB-5374:INSTALL_RUNTIME_REQUIRED` | Installed app.asar/PID/data-root/resourcesPath/build-manifest evidence; owned by WMB-5374. |

## Production defects repaired during acceptance

1. Event/outbox writers in Actor, Root/Stage, Snapshot, and Recovery now allocate `event_ordinal` monotonically within the same aggregate revision instead of colliding at ordinal 1.
2. Canonical causation replay returns the original event and outbox identity; an event missing its matching outbox fails closed with `ORCHESTRATOR_CONTRACT_ERROR`.
3. `acceptIntent` enforces Actor write fence plus the exact current migration row before any receipt/intent/mailbox business write.
4. Recovery rebuild preserves scheduler `NO_CURRENT_TARGETS` as `projection_state=not_applicable` and restores the durable terminal reason from the intent next action.

## Decision

WMB-5373 is complete as an adversarial acceptance execution and evidence task. WMB-5375 and WMB-5378–WMB-5382 have closed A31–A36, A42, and A44; the product rollout gate remains rejected until the five remaining source-level blockers are implemented and A55 is closed by WMB-5374 installed-runtime evidence.
