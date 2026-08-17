# WMB-5297 — Evidence-backed article value and clean-copy repair

## Decision

Research remains an internal anti-fabrication mechanism. Published copy now prioritizes a strong thesis, forward-looking vision, emotional tension, and concrete reader action. Internal evidence gaps, research process, verification summaries, residual uncertainty, and disclaimer-style tailnotes are prohibited from the article body.

## Product changes

- `skills/evidence-grounded-writer/SKILL.md`: separates invisible research discipline from editorial voice; permits bold future-facing judgments while retaining the no-fabricated-facts boundary.
- `skills/wemedia-buddy-operator/SKILL.md`: requires research-successor output to be clean and publication-worthy rather than paper-like.
- `src/main/research-successor.ts`: unresolved claims are internal deletion input only; successor prompts prohibit verification logs and disclaimer tailnotes.
- `src/main/ipc-project-investigation.ts`: investigation-backed writing follows the same clean-copy contract.
- Focused tests assert these contracts.

## Live article repair

Real workspace project `5675d709-b815-4dad-8f96-f3399918192b` was rewritten and saved through the live Studio UI.

- Title: `别急着换模型：未来真正拉开差距的，是谁先拥有自己的 AI 工作流`
- Saved version: `v4`
- Body length: `2579` characters
- Preserved: two managed inline images, source/project history, existing Studio version protocol.
- Removed: `核查摘要`, `残余不确定项`, research narration, defensive evidence-boundary prose.
- Added: high-tension opening, “抽卡” framing, workflow-as-compounding-asset thesis, six-step implementation path, model-switch decision rule, forward-looking close.

## Verification

- Live Electron Studio save state returned `内容未改动` after save.
- Rendered surface contained `前者拥有工具，后者拥有杠杆。` and contained no old `残余不确定项` section.
- SQLite readback from `J:/PigeonYang/WeMediaBuddyData/wmb.db`: project revision `4`, latest core version `v4`, body `2579` chars, clean-copy check true.
- Active runtime mirror `J:/PigeonYang/WeMediaBuddyData/pi-agent/skills/evidence-grounded-writer/SKILL.md` normalized-content parity with the canonical project Skill: true.
- Render screenshot: `J:/Users/yangda01/Temp/omp-sshots-1559f2dc9e03bcbd.webp`.
- `node --test tests/evidence-grounded-writer-skill.test.mjs tests/wmb-5173-research-successor.test.mjs tests/wmb-5174-research-successor-ui.test.mjs tests/wmb-5175-eval-cap028.test.mjs`: 57/57 PASS.
- `npm run typecheck`: PASS.
