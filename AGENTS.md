# WeMediaBuddy — agent notes

Secondary agent surface (Codex / multi-agent). **Oh My Pi primary entry is `CLAUDE.md`.** Rules below must stay in sync with `CLAUDE.md` and `.cursor/rules/design-authority.mdc`.

## Rapid Delivery

- Optimize for the shortest path to a working user-visible result. Process, ledgers, evidence, and delegation support delivery; they never replace it.
- Work one highest-value critical path at a time. Do not fan out into package, canary, adversarial, audit, or cleanup work while the current product flow is still broken.
- The Owner's request authorizes implementation. `TASKS.md`, PLAN, and Goal record progress and ordering; they are not construction permission gates.
- Fix required prerequisites and callers as part of the current task. Split work only for an independent product decision, irreversible migration, or genuinely unrelated deliverable.
- Use the smallest loop: reproduce or locate the behavior, edit production code, run the closest behavioral test or real scenario, then stop when it passes.
- Do not impose arbitrary one-wave, 15-minute, second-pass approval, mandatory reviewer, full-suite, package, or E2E rituals. Run a wider gate only when it proves a specific uncovered risk.
- `blocked` is reserved for external credentials, permissions, unavailable services, destructive decisions, or Owner-locked product choices. Missing APIs, fields, tests, and build errors are engineering work to resolve directly.
- Do not reopen completed tasks without current regression evidence. Do not create long evidence documents unless the task explicitly requires one.
- A task is not `done` merely because code exists or a test passed. For receipt-enforced tasks, agents MUST NOT hand-edit `TASKS.md` to `done`; use `npm run task:close -- <TASK-ID> <pushed-implementation-commit> -- <verification command>`.
- `npm run check:task-ledger` is authoritative for task closure. A missing receipt, unpushed implementation/closure commit, mismatched commit paths, missing verification log, multiple `doing` rows, or stale ledger pointer keeps the task open.
- Finish and push the current serial task before starting its successor. Untracked task-owned production, test, migration, script, configuration, or renderer files are unfinished work, not evidence of completion.
- Historical rows are grandfathered. Machine receipts are mandatory for WMB-5324, WMB-5374, WMB-5385–WMB-5388, and every numeric task from WMB-5391 onward.


## Visual Design Authority

Audience: project agents / Codex. Same SSOT chain as Oh My Pi.

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
