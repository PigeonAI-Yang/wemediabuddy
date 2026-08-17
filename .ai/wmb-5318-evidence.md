# WMB-5318 — Opinion-first investigation continuation

## Problem

The investigation domain already allowed an Owner to accept a deferred package with a constrained writing direction, but Studio and supervisor/Pi language presented `accept` only as “evidence sufficient.” After `defer`, the visible handoff emphasized supplement, expand, or stop. A normal self-media viewpoint article therefore appeared locked until every research claim was resolved.

## Decision

- Keep the existing `accept -> direction_pending_approval -> approve -> ready_to_write` path and both Owner approvals.
- For `needs_user` with the latest package review `defer`, label the existing primary action `按观点稿继续`.
- State the writing boundary directly: strong viewpoints and future judgments may continue as author judgments; numbers, quotations, concrete cases, attribution, and other externally verifiable facts must remain within evidence.
- Supervisor and Pi tool language now present the same option alongside supplement, expand, and stop. The supervisor still cannot choose or approve on the Owner’s behalf.
- No new state, decision enum, protocol, schema, permission, or writer bypass.

## Current project recovery

Project `5675d709-b815-4dad-8f96-f3399918192b` received an Owner-approved opinion-first direction that preserves the strong thesis while constraining unsupported factual claims. Database readback:

- status: `ready_to_write`
- revision: `13`
- direction version: `1`
- direction status: `approved`
- recommendation: `continue`

## Verification

- `node --test --test-concurrency=1 tests/wmb-5290-investigation.test.mjs` — PASS, 2/2.
- `node --test --test-concurrency=1 tests/wmb-5292-evidence-gap-pi-tool.test.mjs` — PASS, 9/9.
- `node tests/e2e/runner.mjs --file tests/e2e/investigation.test.mjs --scenario WMB-5290-deferred-owner-decision` — PASS, 1/1 in isolated Electron.
- Electron assertion: defer-specific primary label `按观点稿继续`; all supplement/expand/stop actions remain; factual guardrail visible; 1100×800 horizontal overflow 0; page errors 0.
- Evidence artifact: `tests/e2e/.artifacts/WMB-5290-deferred-owner-decision-qcRvzh/`.
- Isolated Electron process cleanup count: 0.

## Scope

No foundation brand token, CSS geometry, DB schema, investigation state/decision contract, permissions, publishing boundary, model call, or non-investigation Studio flow changed.

## Operational completion

- Writer job `eea05c40-13d6-4c2c-8cd6-04793606c2e9` saved the opinion-first core article as version 10.
- A repair job restored the eight pre-existing images without generating, deleting, or replacing any asset; the latest core article is version 11 (`c39e4897-a108-4959-a6f8-58343a7c7440`).
- `content.get` readback: project revision 11, eight Markdown image references, eight media bindings, and exact equality with version 10 after removing image Markdown.
- Both image-reference and binding asset-id sets exactly match version 9. No platform version was generated and nothing was published.
