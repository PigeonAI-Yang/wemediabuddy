# WMB-4973～4976 evidence

Date: 2026-08-07

## 4973 Results
- `results-view.tsx`: local chart drill selection → `onFocusChange` with publication metrics/review shallow meta
- `main.tsx`: results branch uses `pageFocus` only (no silent default published)

## 4974 Studio
- list row: click = listFocus (Pi), double-click /「打开」= enter editor
- editor open: focus includes body excerpt (cap 6000)
- `onFocusChange={setPageFocus}` from main

## 4975 Publish / Library / Topic
- Publish: click already selected work item; piContext now includes focus meta (platform/status/projectId/operation)
- Library: existing `onFocusChange` path retained
- Topic: existing `onTopicContextChange` retained

## 4976 Today ferment
- `FermentingRail` click-to-focus + selected style
- `TodayView` + main `fermentSelectedItem` → focus when no opp/source selection

## Verify
```text
npm run typecheck → 0
node --test tests/pi-context-payload.test.mjs → 4/4
node scripts/check-ledger.mjs → pass
```
