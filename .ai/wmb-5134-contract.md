# WMB-5134 Contract

## Route
Patch

## Goal
对 WMB-5130..5133 做全量、静态、实机与独立复审收口，并提交可追溯证据和 ledger receipts。

## Acceptance
- [x] final `npm test` 552/552。
- [x] `npm run typecheck`、capability/ledger/intake/prototype gates 通过。
- [x] 当前源码 Electron Today/Studio 实机无 error boundary、无横向溢出，Pi dock 可用。
- [x] 独立复审关闭全部 blocker/major/minor findings。
- [x] `.ai/wmb-5130-5134-evidence.md`、CAP evals 与 TASKS receipts 完整。

## Allowed paths
- WMB-5130..5133 已授权路径
- `.ai/wmb-5134-contract.md`, `.ai/wmb-5130-5134-evidence.md`, `.ai/evals/EVAL-CAP-017.md`, `.ai/evals/EVAL-CAP-018.md`, `.ai/evals/EVAL-CAP-022.md`, `TASKS.md`

## Forbidden paths
- 新产品能力、schema、capability registry、发布边界、无关 cleanup。

## Non-goals
- 不把 warning 当失败；不掩盖真实回归；不替并行 owner 改文件。

## Capability and Skill impact
Capability registry: no change. Pi operator Skill: no change；实际清单同步记在 WMB-5133。

## Design / lock
- 以 final full suite、静态 gates、实机 Electron 和独立复审共同判定完成。

## Depends on
WMB-5130, WMB-5131, WMB-5132, WMB-5133
