# WMB-5372 Workspace Orchestrator Core Acceptance

## Result

- A01-A27: passed through production Actor/Root/Resource/Snapshot/Manager Store APIs with independent durable acceptance runs.
- A28: intentionally `not_executed`, blocker `INSTALL_RUNTIME_REQUIRED`; installation evidence belongs to WMB-5374.
- Acceptance provenance: `acceptance_run_id`, baseline event/checkpoint revisions, and created-after event/checkpoint/monotonic fields are persisted as an all-or-none tuple on participating rows/events.
- No business terminal rows were directly seeded by the acceptance suite.

## Verification

1. `node --test --test-concurrency=1 tests/wmb-5372-workspace-orchestrator-acceptance.test.mjs`
   - 28 scenarios executed.
   - 27 passed in the final full run; A20 exposed a missing `rootInputHash` in the test command after all production scenarios had passed.
2. `node --test --test-concurrency=1 --test-name-pattern="WMB-5372 A20" tests/wmb-5372-workspace-orchestrator-acceptance.test.mjs`
   - A20 passed after supplying the complete frozen root identity.
3. `npm run typecheck`
   - Exit 0 after restoring the exported `ResourceFenceInput` type used by resource admission callers.

## Covered contracts

- A01-A03: required/optional preflight, repair, all-channel failure, forbidden-child proof.
- A04-A08: independent F/J stages, atomic handoff, constrained continuation, immutable source snapshots.
- A09-A12: truthful eligible/empty/mixed projections and bounded evidence successor.
- A13-A16: Reporter/Judge caps, source cap, terminal deadline.
- A17-A19: receipt boundary, sole Actor serialization, Stage-D target snapshots.
- A20-A24: exactly-once effect consumption, cancellation cascade, runtime takeover, wrong-parent rejection, Manager/DB projection identity.
- A25-A27: producer/policy rejection, stale epoch rejection, new-generation retry.
- A28: explicit installed-runtime blocker only; not counted as a source-level pass.
