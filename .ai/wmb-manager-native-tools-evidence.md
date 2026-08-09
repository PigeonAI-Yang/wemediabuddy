# Native manager tool/subagent projection — live evidence

Date: 2026-08-08

## Result
After clicking/startDailyIntelligence:

Dock shows native tool lines:
1. `wmb_run_daily_child` — start child executor (input businessDate/stage, output childTaskId/role)
2. `subagent.reporter` — live reporter progress (planned/phase/message)

Screenshot: `wmb-manager-native-tools.png`

## Implementation
- `manager-dock-turn.ts`: beginManagerDockTurn / markManagerChildStarted / projectManagerChildProgress emit `pi:event` `scope:dock` tool + tool-result
- Same channel as manual Pi chat tool-lines
- pi-dock preserves streaming assistant tool segments across manager.* data reloads
- Fake technical checkpoint cards no longer primary path

## Note
Child still executes via legacy daily_scan bridge; displayed as subagent.reporter/planner tool rows.
