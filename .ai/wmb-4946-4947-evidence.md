# WMB-4946 / WMB-4947 Evidence

Date: 2026-08-07

## Design
`.ai/2026-08-07-proposals-ledger-design.md`

## Backend (4946)
- `src/main/proposals.ts` — getProposalLedger / summarizeProposalLedger
- `src/main/workbench.ts` — latestPlanItemRowsByDate + dedupeOpenProposals extract
- IPC `proposals:get` / `proposals:summary`
- data-changed scope `proposals` on dismiss/create
- preload + global.d.ts

## Frontend (4947)
- View `proposals` nav between discover and studio
- `src/renderer/proposals-view.tsx` five tabs
- Today entry bar `选题台账 · N`
- styles-proposals.css

## Verification
```text
node --test tests/proposals-ledger.test.mjs tests/opportunity-pool.test.mjs
# 15/15

npm run typecheck
# clean
```

## Pi operator Skill impact
no change — ledger is UI/workbench projection; no Pi prompt/tool surface.

## Independent review
not required — test-only backend + frontend wiring with focused fixtures.
