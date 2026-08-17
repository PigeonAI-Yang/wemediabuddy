# WMB-5303 — Investigation reporter repeated-failure repair

## Problem

The real Studio investigation for project `5675d709-b815-4dad-8f96-f3399918192b` failed three consecutive reporter rounds with `RESEARCH_FAILED / Pi 回复超时。`.

The persisted transcripts proved these were not idle or network-start failures: the reporter searched, opened pages and began source persistence, but the generic Pi prompt timeout terminated each run at about five minutes. The latest failed run had opened 13 candidate pages and was saving traceable sources when killed.

## Root cause and repair

`src/main/research-job-runtime.ts` used the generic `WMB_PI_PROMPT_TIMEOUT_MS` resolver with a 300,000 ms default while the research runner's declared hard budget is 12 minutes.

Added exported `resolveResearchPromptTimeoutMs()` and changed only the research reporter runtime to use it:

- default/invalid/too-small configuration: `600,000 ms`;
- explicit valid environment value remains honored;
- 10 minutes leaves two minutes inside the 12-minute research hard budget for machine fetch validation, claim judgement and terminal persistence.

Discovery instructions now stop expansion after 15 valid candidates or about eight minutes, cap candidates at 40, and reserve the remainder for structured output and machine persistence. No DB schema, permission, Source SSOT, evidence threshold or UI contract changed.

## Focused verification

- `npm run typecheck` — PASS.
- `node --test tests/wmb-5172-research-runner.test.mjs` — 23/23 PASS.
- New regression `WMB-5303: research prompt timeout matches the 12-minute hard budget instead of failing at five minutes` covers default, explicit override, invalid and sub-30-second values.
- Existing prompt-contract test confirms the stop rule and machine-owned source persistence instructions.

## Real application smoke test

Restarted the supervised Electron application from the repaired source and invoked the existing `investigationRetryReporter` action for investigation revision 8.

Observed dispatch result:

- investigation revision: `8 -> 9`;
- reporter round: `4`;
- job: `a45325a2-680a-41cc-9557-25e668157ae6`;
- initial reporter state: `queued`.

After crossing the former five-minute failure boundary, authoritative `investigationGet(projectId)` returned:

- investigation status: `research_review`;
- revision: `10`;
- reporter task: `ddaae2c6-9c9c-4a6d-bab2-1c8a2bd8176e`;
- reporter status: `partial` (truthful research terminal, not infrastructure failure);
- `errorMessage: null`;
- finished at `2026-08-16T15:56:12.246Z`;
- evidence package linked `11` source IDs.

The rendered Studio surface simultaneously showed `待主管验收调查资料包` and the actions `验收通过 / 需要补查 / 扩展范围 / 停止调查`.

This proves the repaired live reporter crossed the old timeout boundary, persisted a real evidence package, and advanced the project into the existing review state rather than repeating `Pi 回复超时。`.
