# Change Contract Templates

Use these templates when admitting work into the task ledger.

## Owner lock

```text
Owner lock YYYY-MM-DD:
1. <decision>
2. <decision>
3. Non-goals: <what we are not doing>
4. Route: Design | Legislate
5. Design path: <repo-relative path>
```

## Task contract file

Create `.ai/<task-id-lower>-contract.md` with **exactly these headings**:

```markdown
# <TASK-ID> Contract

## Route
Patch | Design | Legislate

## Goal
One sentence.

## Acceptance
- [ ] Observable check 1
- [ ] Observable check 2
- [ ] Observable check 3

## Allowed paths
- path/...

## Forbidden paths
- path/...

## Non-goals
- ...

## Capability registry impact
(updated|no change) — <which capabilities/commands/roles, or why untouched>

## Depends on
None | TASK-ID list

## Design / lock
none

For Design/Legislate, replace the last section with:

```markdown
## Design / lock
- Design: docs/spark/YYYY-MM-DD-topic-design.md
- Owner lock YYYY-MM-DD:
  1. ...
  2. ...
  3. Non-goals: ...
```

## Rules

- Patch may use `Design / lock: none`.
- Design/Legislate must include a real design path and an `Owner lock` block.
- Contract files are short. Long narrative goes to design/evidence files.
- `scripts/check-intake.mjs` checks structure, not brilliance.
