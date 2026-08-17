# WMB-5317 — Investigation supervisor review redispatch repair

## Problem

A supervisor could finish reviewing an investigation package without calling `accept`, `supplement`, `expand`, or `stop`. The project then remained `research_review`; startup recovery treated the same package as unreviewed and dispatched the same supervisor review again.

## Decision

- Added the explicit supervisor outcome `defer` to the shared investigation review contract and Pi MCP wrapper.
- `defer` persists the package review, records `research_review_deferred`, increments the project revision, and moves the project to `needs_user` without choosing an Owner action.
- Supervisor instructions now require every review turn to persist either `accept` or `defer`; insufficient evidence must not produce a fabricated direction.
- Runtime dispatch now keys in-flight supervisor review attempts by investigation package ID and only selects `research_review` packages whose `review_json` is null. The same package cannot be dispatched twice in one runtime; a later package has a different ID and remains eligible.
- Studio preserves the `defer` value during renderer normalization and presents the Owner choices: accept with a direction, supplement, expand, or stop.

## Verification

- `node --test --test-concurrency=1 tests/wmb-5290-investigation.test.mjs` — PASS, 2/2. The child contract covers: defer → durable `needs_user`; the old package no longer matches recovery; duplicate defer is rejected; supplement creates a new reporter round; the new package re-enters `research_review`; a second defer survives database reopen.
- `node --test --test-concurrency=1 tests/wmb-5292-evidence-gap-pi-tool.test.mjs` — PASS, 9/9. Covers `wmb_review_investigation_research` registration and exact `defer` authority/argument mapping.
- `node --test --test-concurrency=1 tests/studio-investigation-indicator.test.mjs` — PASS, 4/4. Covers renderer preservation of `review.decision = "defer"`.
- `node tests/e2e/runner.mjs --file tests/e2e/investigation.test.mjs --scenario WMB-5290-deferred-owner-decision` — PASS, 1/1 in isolated headless Electron. The deferred conclusion and all four Owner decision paths are visible; page errors: 0.
- Live workspace readback: project `5675d709-b815-4dad-8f96-f3399918192b` is `needs_user`, revision 11, latest review decision `defer`.

## Cleanup

- Test tabs were closed by the E2E runner.
- Process-level check found 0 isolated `wmb-e2e` / acceptance Electron processes.
- No foundation brand token, dependency, schema, source-store, publishing, or automatic Owner-decision change.
