# WMB-5160 Evidence

## Delivered

- Removed the full maintenance ledger from Topic home. Search, status filters and the adjacent `整理台账` entry now share the compact toolbar; the entry opens a dedicated subpage with Back navigation.
- The ledger maps persisted facts to concise business states: `历史未生效`, `资料员正在重新整理`, `重新整理未完成`, and `已由新版接替`. Only current proposed rows expose approve/reject.
- Retry-exhausted rows expose one real `重新交给资料员` action. It requeues the same durable job with attempts reset and a fresh run identity; it never revives or approves the stale proposal. Each click receives a fresh dispatcher request ID, so a second recovery cannot replay the first success.
- Desk/librarian prompts and the canonical operator Skill require latest-fact successor proposals with `supersedesProposalId`; they never send the Owner to edit topics manually. Canonical, both installed data roots and the existing packaged mirror read back revision `6ad8ec8a2e956323aca626ae4a49a58ee77f876ea3540019012e38245d3289db`.

## Verification

- `tests/wmb-5150-topic-maintenance.test.mjs` — 13/13 PASS, including two complete `needs_user → resume` cycles with stable jobId and distinct runIds.
- `tests/wmb-5152-topic-approval-ui.test.mjs` — 6/6 PASS; combined UI/Skill gate 12/12 PASS; librarian L2 integration 20/20 PASS.
- Full `npm test` — 685/685 PASS before the final one-line fresh-request fix; the affected focused suite then passed 19/19.
- `npm run typecheck`, `npm run check:capabilities`, `powershell -ExecutionPolicy Bypass -File scripts/check.ps1`, `node scripts/smoke-renderer.mjs`, `git diff --check` — PASS; only existing LF/CRLF warnings remain.

## Live Electron evidence

- Current real data: historical stale rows render `历史未生效`, have no buttons, leak no internal semantics and do not overflow. Screenshot: `J:/Users/yangda01/Temp/wmb-5160-after-history.png`.
- Isolated lifecycle: Owner approve → stale/pending → librarian successor → Owner approve → old topic archived; outbox completed with exact successor link, DPR=1, no overflow/internal leakage. Screenshots: `J:/Users/yangda01/Temp/wmb-5160-e2e-reproposing.png`, `J:/Users/yangda01/Temp/wmb-5160-e2e-approved.png`.
- Isolated page/recovery: Topic home ledger absent, entry immediately follows filters, separate page opens, recovery changes needs_user→pending with attempts=0 and stable jobId, Back restores home with ledger absent. Screenshots: `J:/Users/yangda01/Temp/wmb-5160-topic-entry.png`, `J:/Users/yangda01/Temp/wmb-5160-ledger-page.png`.

## Independent review

- `wmb_5160_final_review` found one HIGH: fixed request ID made a second recovery replay the first receipt.
- Fix: UI omits requestId; Main generates a fresh one. `wmb_5160_high_rereview` verdict PASS with no BLOCKER/HIGH/MEDIUM.

## Capability / Skill impact

- Capability registry: no change — recovery reuses the existing Owner-only, non-agent-grantable scheduler retry command; no role gained authority.
- Pi operator Skill: updated — automatic reproposal, successor and no-manual-edit contract synchronized to installed mirrors.
