# WMB-4971 / WMB-4972 evidence

Date: 2026-08-07

## 4971 — shared payload / focus

- `src/renderer/pi-focus.ts` — `toggleSingleFocus`
- `src/renderer/pi-context-payload.ts` — `buildPiContextPayload`, `describePiContextChip`
- `src/renderer/pi-dock.tsx` — uses shared builder/chip
- `tests/pi-context-payload.test.mjs` — 4/4 pass

## 4972 — Proposals click-to-focus

- `src/renderer/proposals-view.tsx` — open-tab Opportunity toggle; history rows click focus; blank clears
- `src/renderer/main.tsx` — `proposalsSelectedItem` → `piContext.selectedItems`
- `src/renderer/styles-proposals.css` — `.proposal-row.selected`

## Verification

```text
node --test tests/pi-context-payload.test.mjs  → 4/4
npm run typecheck → 0
node scripts/check-ledger.mjs → pass after this evidence exists
```

## Contract

- Click card = Pi focus (single)
- Click again / blank = clear
- Topic/studio buttons still navigate separately
