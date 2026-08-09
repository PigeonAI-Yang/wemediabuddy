# WMB-5132 Contract

## Route
Patch

## Goal
把确定性 EVAL-029 冷 fixture 推进到 migration 50，同时保持冻结 business parent 与 manifest 不变量。

## Acceptance
- [x] fixture schema 版本与当前 migration 50 一致。
- [x] 冻结 parent/manifest 语义不变。
- [x] `tests/eval-029-fixtures.test.mjs` 9/9 在 bounded cold processes 通过。

## Allowed paths
- `tests/eval-029-fixtures.test.mjs`, `tests/settings.test.mjs`
- EVAL-029 fixture 生成/断言所需的既有测试资产
- `.ai/wmb-5132-contract.md`, `.ai/wmb-5130-5134-evidence.md`, `TASKS.md`

## Forbidden paths
- production schema 语义、capability registry、真实 data root。

## Non-goals
- 不重写冻结业务夹具；不降低 migration 断言。

## Capability and Skill impact
Capability registry: no change. Pi operator Skill: no change.

## Design / lock
- 只推进测试 fixture migration；冻结业务对象与 manifest 不得变化。

## Depends on
WMB-5122
