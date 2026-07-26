# WeMediaBuddy Agent Guide

## Project goal

WeMediaBuddy is a Windows desktop terminal where a human and external AI Agents operate the same self-media workflow: research, planning, creation, browser publishing, metrics, and review.

Current scope is defined by `PRD.md` and `SPEC.md`. X, Xiaohongshu, and WeChat Official Accounts are required. WMB does not embed an LLM or Agent runtime and does not use platform APIs.

## Required reading

Before any change, read:

1. `PRD.md` — product intent and boundaries.
2. `SPEC.md` — normative behavior and acceptance.
3. `PLAN.md` — implementation order and gates.
4. `TASKS.md` — current task, ownership, evidence, and progress.
5. `TECHNICAL_DESIGN.md` — approved stack and architecture.
6. `docs/development-workflow.md` and `docs/verification.md`.

For browser/platform work, also read the matching platform contract in `SPEC.md`.

## Work protocol

1. Select one `todo` task from `TASKS.md`; move only that task to `doing`.
2. Read every referenced requirement and the real call path before editing.
3. For a bug, first create and run a minimal falsifiable reproduction; do not patch before the root cause is confirmed.
4. Make the smallest implementation that satisfies the referenced SPEC IDs.
5. Run `powershell -ExecutionPolicy Bypass -File scripts/check.ps1`.
6. Record verification evidence in `TASKS.md`; mark `done` only when every acceptance item passes.
7. Report files read, files changed, rationale, verification, and remaining risks.

## Change boundaries

- User requirement: preserve `PRD.md`, `SPEC.md`, and `TECHNICAL_DESIGN.md` as approved product contracts. Change them only when the user changes scope.
- User requirement: do not implement PRD section 10 future items.
- User requirement: do not add an embedded LLM, Agent runtime, platform API integration, cloud service, auth system, or multi-user features.
- User requirement: publishing always requires a fresh human confirmation bound to the exact account, content version, and assets.
- Project fact: runtime data belongs under the configured data root, never in the Git repository.
- Recommendation: do not add dependencies unless an active task cannot be completed with the approved stack or existing dependencies; record the reason in `TASKS.md`.
- Never run destructive Git or filesystem commands against broad paths.

## Verification

Run the checks listed in `docs/verification.md`. The current one-command entrypoint is:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

No business-code checks exist until the application scaffold task creates `package.json`; do not report typecheck, lint, test, or build as passed before those commands exist.

## Final report

Include:

- task ID and SPEC IDs;
- files read and changed;
- behavior delivered;
- commands and results;
- live/manual evidence where required;
- failures, skipped checks, and remaining risks.

## Harness index

- `docs/ai-harness.md`
- `docs/architecture.md`
- `docs/development-workflow.md`
- `docs/verification.md`
- `.ai/evals/README.md`
