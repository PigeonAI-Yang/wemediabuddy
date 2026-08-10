# WMB-5160 Contract

## Route
Legislate

## Goal
Expose the reproposal/supersession lifecycle clearly, synchronize Pi operating guidance and close EVAL-031 end to end.

## Acceptance
- [ ] Topic ledger distinguishes legacy stale, reproposing, retry exhausted and superseded without fake controls.
- [ ] Librarian/desk prompts and canonical operator Skill require automatic reproposal and never send Owner to manual topic editing.
- [ ] Real Electron approval-to-successor readback plus focused/full/typecheck/capability/lightweight/smoke gates pass.

## Allowed paths
- TASKS.md
- .ai/evals/EVAL-CAP-003.md
- .ai/frontend-debug-loop/state.json
- .ai/frontend-debug-loop/reports/2026-08-10-wmb-5160-topic-ledger-page.md
- skills/wemedia-buddy-operator/SKILL.md
- src/main/pi-operator-skill.ts
- src/main/role-job-policies.ts
- src/main/topic-maintenance-reproposal.ts
- src/main/ipc-knowledge-business.ts
- src/preload/preload.ts
- src/renderer/global.d.ts
- src/renderer/library-topics-view.tsx
- src/renderer/topic-maintenance-ledger.tsx
- src/renderer/styles-knowledge-topic.css
- tests/pi-operator-skill.test.mjs
- tests/wmb-5150-topic-maintenance.test.mjs
- tests/wmb-5152-topic-approval-ui.test.mjs
- .ai/wmb-5160-evidence.md

## Forbidden paths
- New approval or permission UI frameworks
- Platform adapters and publication code

## Non-goals
- Reviving or silently classifying historical stale proposals.

## Capability registry impact
no change — renderer, prompt, Skill and acceptance only.

## Depends on
WMB-5159

## Design / lock
- Design: docs/spark/2026-08-10-topic-maintenance-conflict-reproposal-design.md
- Owner lock 2026-08-10:
  1. Owner sees the real business lifecycle and only approves/rejects current proposals.
  2. Historical stale stays historical; current true conflict is automatically returned to librarian.
  3. Non-goals: no fake buttons, internal semantic leakage or manual topic reconstruction.
