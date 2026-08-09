# M-4980 Pi page authority evidence

Date: 2026-08-07  
Design: `docs/spark/2026-08-07-pi-page-authority-design.md`  
Owner lock: 1A hard-delete UI-only · 2A 4h grant · 3A discover observation auto

## Delivered

### Core
- `src/shared/page-authority.ts` — PAGE_TASK_GRANT_SCOPES
- `src/main/pi-page-authority.ts` — ensurePageAuthority / injectAuthority / BLOCKED
- `src/main/ipc-pi-dock.ts` — uses ensurePageAuthority; `pi:authority-status`
- `src/main/agent-tasks.ts` — page_* intents + complete validation
- `src/main/task-grants.ts` — scopes + sources.update_status whitelist + relevantContext page/objectId
- late-migration **v47** agent_tasks intent CHECK expand

### Library tools
- MCP: `sources.lane_gate`, `sources.lane_restore`, `sources.update_status` (`mcp-source-commands.ts`)
- wmb: `wmb_judge_sources`, `wmb_restore_source`, `wmb_update_source_status`

### UX / skill
- authority chip on Pi dock header + styles
- preload/global `getPiAuthorityStatus`
- operator skill M-4980 section + PI_AUTHORITY_SYSTEM_PROMPT BLOCKED/no hard-delete

## Verification

```text
node --test tests/page-authority.test.mjs
# 6/6 pass

npx tsc --noEmit
# EXIT 0
```

## Pi operator Skill impact
updated — page dock auto-grant, library organize tools, BLOCKED handling, no hard-delete.

## Independent review
not required — test-only + design-locked implementation
