# WMB-5102 Contract

## Route
Patch

## Goal
Readonly first-class Agents roster page + sidebar entry.

## Acceptance
- [x] View `agents` in nav after Today
- [x] Roster shows five roles
- [x] No permission toggles on page
- [x] Settings jump button only

## Allowed paths
- src/renderer/agents-roster-view.tsx
- src/renderer/main.tsx
- src/renderer/app-types.ts
- src/renderer/styles-agents.css
- src/renderer/styles.css
- src/renderer/today-view-parts.tsx
- .ai/wmb-5102-*

## Forbidden paths
- capability_overlays IPC

## Non-goals
- Live task progress API

## Capability registry impact
no change — UI consumes ROLE_CATALOG labels only

## Depends on
WMB-5100

## Design / lock
none
