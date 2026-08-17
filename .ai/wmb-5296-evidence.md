# WMB-5296 — Automatic research continuation

## Problem

A partial research task could leave a `research_successor` row in `needs_user`, forcing the owner to choose among internal routing strategies before article writing resumed.

## Decision

Production research completion now uses the conservative `narrow` decision automatically. Unresolved claims are excluded from the current factual acceptance scope; they are not promoted to verified facts. Startup reconciliation applies the same decision to legacy undecided rows. A successor that later enters `needs_user` for another prerequisite no longer reappears as an unresolved research-choice gate once its research decision is already persisted.

The pure state-machine API still supports explicit decisions for compatibility and focused tests, but production enqueue and restart paths do not ask the owner.

## Changed

- `src/main/research-job-runtime.ts`
  - Production terminal enqueue passes `autoDecision: 'narrow'` in guarded and bare-DB paths.
- `src/main/research-successor.ts`
  - Enqueue accepts an optional automatic decision.
  - Startup reconciliation inserts missing successors with `narrow`.
  - Legacy undecided `needs_user` rows are resumed with `narrow`.
- `src/main/research-successor-projection.ts`
  - Research-choice projection excludes rows whose decision is already persisted.
- `skills/wemedia-buddy-operator/SKILL.md`
  - Operator contract now documents automatic continuation and evidence truthfulness.
- Focused unit and Electron acceptance scenarios cover automatic enqueue, legacy recovery, kick, and duplicate-gate suppression.

## Verification

- `npm run typecheck` — passed.
- `node --test tests/wmb-5173-research-successor.test.mjs tests/wmb-5174-research-successor-ui.test.mjs` — 36/36 passed.
- `node --test tests/design-tokens-drift.test.mjs` — 3/3 passed.
- Real Electron: `WMB-5296-studio-research-auto-continue` — passed.
  - Artifact: `tests/e2e/.artifacts/WMB-5296-studio-research-auto-continue-3wGaWQ/`
- Live workspace readback:
  - Project `5675d709-b815-4dad-8f96-f3399918192b` advanced from version 2 (2361 chars) to version 3 (3841 chars).
  - Successor writer task `cbcb9e99-103e-4048-b620-be4b8063a6c4` reached `succeeded/completed` at `2026-08-16T12:20:07.704Z`.
