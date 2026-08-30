# WeMediaBuddy — Oh My Pi / Claude entry

This file is the **primary** instruction surface for Oh My Pi on this repo.

## Rapid Delivery

- Optimize for the shortest path to a working user-visible result. Process, ledgers, evidence, and delegation support delivery; they never replace it.
- Work one highest-value critical path at a time. Do not fan out into package, canary, adversarial, audit, or cleanup work while the current product flow is still broken.
- The Owner's request authorizes implementation. `TASKS.md`, PLAN, and Goal record progress and ordering; they are not construction permission gates.
- Fix required prerequisites and callers as part of the current task. Split work only for an independent product decision, irreversible migration, or genuinely unrelated deliverable.
- Use the smallest loop: reproduce or locate the behavior, edit production code, run the closest behavioral test or real scenario, then stop when it passes.
- Do not impose arbitrary one-wave, 15-minute, second-pass approval, mandatory reviewer, full-suite, package, or E2E rituals. Run a wider gate only when it proves a specific uncovered risk.
- `blocked` is reserved for external credentials, permissions, unavailable services, destructive decisions, or Owner-locked product choices. Missing APIs, fields, tests, and build errors are engineering work to resolve directly.
- Do not reopen completed tasks without current regression evidence. Do not create long evidence documents unless the task explicitly requires one.
- When a task is truly done, update its ledger row, then commit and push only that task's exact files before starting the next task.


## Visual Design Authority

Audience: Oh My Pi (primary). Same rules are mirrored in `AGENTS.md` and `.cursor/rules/design-authority.mdc`.

### Authority chain (SSOT)

1. **Machine SSOT:** `src/renderer/styles-foundation.css` — 墨夜 · Inter · accent `#8b7cff` · topbar `56px`.
2. **Human living guide:** `docs/design/living-style-guide.html` — rendered from foundation CSS variables.
3. **`DESIGN.md`:** narrative only. Frontmatter / synced token block is updated by `scripts/sync-design-doc-from-foundation.mjs`; do not hand-edit token values there.
4. **Not SSOT:** `prototype/` and `.impeccable/design.json` — historical / exploration only. Never treat them as execution truth.

### Conflict resolution

If any document, prototype, Impeccable JSON, or memory disagrees with `styles-foundation.css`, **foundation wins**.

### Bans

- Do not invent one-off `hex` / `rgb()` / `hsl()` in page CSS (`src/renderer/styles-*.css` except foundation) or in TSX for brand/chrome colors.
- Use foundation variables (`var(--accent)`, `var(--ink)`, `var(--surface)`, …).
- Anti-drift gate: `tests/design-tokens-drift.test.mjs` (allowlist is **shrink only**).

### Must-ask boundaries (brand tokens)

Before changing brand-level tokens in foundation — including `--accent*`, `--app-bg`, `--font-sans` / Inter stack, `--topbar-height`, and core ink / surface / border scales — **ask the owner first**. Do not “improve” the palette unilaterally.

### UI task checklist

1. Open / skim `docs/design/living-style-guide.html` (or read foundation tokens).
2. Reuse existing CSS variables; never invent new brand hex.
3. Run `node --test tests/design-tokens-drift.test.mjs` after CSS token-related edits.
4. If foundation tokens changed (after owner approval), run `node scripts/sync-design-doc-from-foundation.mjs`.
