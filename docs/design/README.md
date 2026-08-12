# Design docs (WeMediaBuddy)

## Authority

| Layer | Path | Role |
| --- | --- | --- |
| Machine SSOT | `src/renderer/styles-foundation.css` | Tokens + chrome (墨夜 · Inter · `#8b7cff` · topbar 56px) |
| Living guide | `docs/design/living-style-guide.html` | Human-readable, CSS-variable-driven |
| Narrative | `DESIGN.md` | Story only; tokens synced from foundation |
| Oh My Pi entry | `CLAUDE.md` | Primary anti-drift instructions for UI work |
| Also mirrored | `AGENTS.md`, `.cursor/rules/design-authority.mdc` | Same rules for other agents |

**Not SSOT:** `prototype/`, `.impeccable/design.json` — do not execute against them when they disagree with foundation.

## Open the living style guide

From a browser (or Electron):

`docs/design/living-style-guide.html`

It links foundation via relative path `../../src/renderer/styles-foundation.css`. Open from the repo so that path resolves (file:// from this folder is fine).

## Sync DESIGN.md tokens

```bash
node scripts/sync-design-doc-from-foundation.mjs
```

## Drift test

```bash
node --test tests/design-tokens-drift.test.mjs
```

Also included in `npm test` via `tests/*.test.mjs`.
