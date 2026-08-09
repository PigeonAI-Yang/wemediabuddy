# WMB-5101 Contract

## Route
Patch

## Goal
Filter automatic task grants by optional roleId / contextRefs.roleId.

## Acceptance
- [x] ensureAutomaticTaskGrant intersects role write set
- [x] desk/null role keeps prior page scope (zero regression path)
- [x] unit tests for writer/librarian filters

## Allowed paths
- src/main/task-grants.ts
- src/shared/agent-capabilities.ts
- tests/agent-capabilities.test.mjs
- .ai/wmb-5101-*

## Forbidden paths
- Permission settings UI

## Non-goals
- Multi-lease pool

## Capability registry impact
updated — filterCommandsForRole used at grant issue

## Depends on
WMB-5100

## Design / lock
none
