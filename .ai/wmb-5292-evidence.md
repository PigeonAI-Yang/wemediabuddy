# WMB-5292 — Studio evidence-gap research handoff repair

## Problem

The Studio writer could see `research.dispatch` only on the MCP server, not as a registered Pi tool. `evidence-grounded-writer` also told writers to use available read-only research when saved material was insufficient. A writer therefore researched inline, or a manager spawned ordinary `roleId=reporter` work that routed to `daily_scan`; neither path produced the project research EvidencePack or automatic project-source association.

## Repair

- `.pi/extensions/wmb-mcp/wmb-mcp-tools-research.ts`
  - Registers `wmb_dispatch_research`, matching the existing `WMB_TOOL_IDENTITY['research.dispatch']` identity.
  - Maps `parentTaskId`, `requiredClaims`, optional budget, channels, brief, and gapId to the existing MCP snake_case contract.
  - Keeps validation, budget ceilings, parent-role allowlist, same-parent uniqueness, boundary inheritance, and loop prevention on the existing server path.
- `skills/evidence-grounded-writer/SKILL.md`
  - In a WMB task, saved evidence insufficiency now immediately invokes `wmb_dispatch_research`.
  - Explicitly forbids inline public-web research and ordinary `wmb_spawn_job` reporter/daily_scan substitution.
  - After successful dispatch, the unsupported writer task stops without saving a draft; the existing EvidencePack successor resumes the original role.
  - Outside a WMB task, the general skill may still use available read-only research.
- `skills/wemedia-buddy-operator/SKILL.md`
  - Documents the controlled tool and forbidden substitute routes.
- `tests/wmb-5292-evidence-gap-pi-tool.test.mjs`
  - Exercises extension registration, real Pi-tool execution against an MCP capture server, camelCase-to-snake_case mapping, guidance invariants, role/loop gates, and same-parent idempotency.

## Preserved source-association path

The repair does not add source IDs to `content.save_version` and does not infer project sources from manuscript URLs. Research still produces EvidencePack/source IDs through the Source SSOT. Existing project investigation terminal handling calls `linkPackageSourceIds()` before persisting the package, and the research successor re-runs the original role with the inherited project boundary.

## Verification

- `node --test tests/wmb-5292-evidence-gap-pi-tool.test.mjs` — PASS, 4/4.
- `node --test tests/evidence-grounded-writer-skill.test.mjs tests/pi-extension.test.mjs` — PASS, 9/9.
- `node --test tests/wmb-5173-research-successor.test.mjs tests/wmb-5290-investigation.test.mjs` — PASS, 27/27; covers fresh/reused dispatch, three-layer loop prevention, EvidencePack, original-role successor, project package/source linking, two approvals, and persisted writer gate.
- `npm run typecheck` — PASS.

## Existing unrelated failure

`node --test tests/pi-operator-skill.test.mjs` reports 4/5 PASS. The exact-tool-ledger assertion already sees registered `wmb_import_project_image` but the operator Skill does not document it. That tool is an unrelated pre-existing workspace change and was not modified under WMB-5292.

## Data boundary

No production project, database row, existing article version, or source relation was mutated during verification. The previously inspected project remains historical evidence of the old broken route; future WMB factual-writing gaps now enter the controlled research path.