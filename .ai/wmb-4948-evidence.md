# WMB-4948 evidence

Date: 2026-08-07

## Delivered
- `proposals.ts`: `offset` pagination; `restoreDismissedProposal`
- IPC `proposals:restore`; set-carry-state broadcasts `proposals`
- preload/global.d.ts: offset + restoreProposal
- `proposals-view.tsx`: load more, batch dismiss/restore, restore button, checkboxes, Pi focus retained
- styles: batch bar, pager, checks

## Verify
```
node --test tests/proposals-ledger.test.mjs → 5/5
npm run typecheck → 0
node scripts/check-ledger.mjs → pass
```
