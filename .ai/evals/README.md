# WMB Evals

## Purpose

Evals prove a SPEC capability end to end. They do not replace task-level tests or live platform receipts.

## Capability eval template

```markdown
# EVAL-CAP-XXX

- Capability:
- Task:
- Preconditions:
- Steps:
- Expected observable results:
- Command evidence:
- Manual/live evidence:
- Result: pass | fail | blocked
- Failure reason:
```

## Regression eval template

```markdown
# EVAL-REG-XXX

- Original failure:
- Minimal reproduction:
- Root cause:
- Fix:
- Regression command:
- Expected result:
- Result: pass | fail
```

## Grader types

- `command`: deterministic script or test exit status.
- `manual`: human verifies account, content, layout, or platform result.
- `model-assisted`: Agent reviews structured evidence; never the sole grader for publication or data correctness.

## Reporting

An eval passes only when all required graders pass. Report partial or blocked results explicitly; do not average failures into a score.

