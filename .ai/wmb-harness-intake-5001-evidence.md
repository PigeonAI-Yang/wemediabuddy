# Harness intake adoption (post WMB-5000)

Date: 2026-08-07

## Skill first

Canonical skill: `J:\PigeonYang\skills\project-harness-bootstrap`

- Added Tier 2.5 idea intake to `SKILL.md`
- Added `references/intake-routing-contract.md`
- Added templates: `check-intake.mjs`, `docs-intake-routing.md`, `docs-change-contract.md`
- Wired optional intake step into template `check.ps1`
- Replaced stale `C:\Users\yangda01\.codex\skills\project-harness-bootstrap` copy with junction → J canonical

## WMB project

- `docs/intake-routing.md`
- `docs/templates/change-contract.md`
- `scripts/check-intake.mjs` with `INTAKE_WATERLINE = 5001`
- `scripts/check.ps1` calls intake check
- `AGENTS.md` Idea intake section
- `docs/ai-harness.md` artifact map + PLAN vs TASK roles
- `docs/development-workflow.md` / `docs/verification.md` pointers

## Verification

```text
node scripts/check-intake.mjs
→ check-intake ok (0 doing/done task(s) at/above intake waterline 5001)
```

Negative fixture (temporary WMB-5001 doing row, no contract, then restored):

```text
check-intake failed:
  - WMB-5001 (doing): missing contract .ai/wmb-5001-contract.md
```

`scripts/check.ps1` still fails on pre-existing source line-cap debt (unrelated to intake). Intake step itself runs after ledger and is green when contracts satisfy waterline.

## Owner operating rule from now

Next real task id must be ≥ WMB-5001 and ship `.ai/wmb-NNNN-contract.md` before/with `doing`.
