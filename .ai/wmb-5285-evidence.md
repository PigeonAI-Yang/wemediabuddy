# WMB-5285 Settings-wide visible-copy semantic audit

## Decision

Audited every Settings page except the already-cleaned Browser & Accounts page against Goal / Choice / Outcome / Recovery. Removed only visible copy that repeated a heading, selected value, adjacent status, or non-actionable internal implementation detail. Preserved information that changes a choice, explains an outcome or consequence, identifies real state/data, or provides recovery.

## Delivered

- **General:** removed duplicate page/group descriptions and repeated fixed-value explanations; retained theme persistence outcome and truthful fixed-value states.
- **AI & Models:** removed the duplicate active-profile sentence from the fallback list; retained model identity, fallback-order semantics, model metadata, save/fetch outcomes, and recovery copy.
- **Pi Skills:** removed the second read-only/save/delete explanation from the editor footer; retained the single causal read-only explanation beside the selected Skill, status, counts, empty states, save outcome, and action feedback.
- **Intelligence Channels:** removed the page-level restatement of its two tabs and the single-candidate confirmation tautology; retained readiness, scan results, empty/recovery paths, List state, destructive consequences, and operation outcomes.
- **Agent Access:** removed role-card internal Skill recipe IDs and the unavailable local-service sentence duplicated by the adjacent `未启动` status; retained the URL when available, workspace identity, worker-pool truth, capability descriptions, consequences, and empty state.
- **Data & Storage:** removed database schema version and content-hash implementation details; retained paths, sizes, health, workspace migration choices/consequences, proposal evidence, logs, and maintenance actions.
- **Diagnostics:** no copy removed; every visible row is the page's actual health result or recovery action.
- **About WMB:** renamed the repeated `WeMediaBuddy` version row to `应用版本`, removed redundant runtime source explanation and English `unknown` fallback; retained version/update state, release consequences, errors, backups, retry/manual-download recovery, runtime version, refresh, and rollback.
- Removed the now-orphaned `.agents-settings-skill-line` CSS rule.
- Added semantic assertions and dark/light screenshot coverage for every audited page in `tests/e2e/settings.test.mjs`.

No IPC, DB schema, permissions, Capability registry, dependencies, settings operations, or foundation brand tokens changed.

## Verification

- `npm run typecheck` — PASS.
- `node --check tests/e2e/settings.test.mjs` — PASS.
- `node --test tests/design-tokens-drift.test.mjs` — PASS (3/3).
- Real Electron `STG-001-settings-sections-nav` — PASS at 1100×800 with all audited pages captured in dark and light themes; no horizontal overflow; all capture `pageerrors.json` files empty.
- Real Electron focused regressions — PASS (5/5):
  - `STG-002-settings-theme-persist`
  - `STG-004-settings-data-workspace`
  - `STG-006-settings-diagnostics`
  - `STG-007-settings-app-update`
  - `STG-008-settings-skills`
- Visual inspection — PASS: all nine Settings surfaces have stable hierarchy, readable contrast, aligned controls, and no visible copy tautologies in either theme.

Primary evidence:

- `tests/e2e/.artifacts/STG-001-settings-sections-nav-sdtqWb/`
- `tests/e2e/.artifacts/STG-001-settings-sections-nav-sdtqWb/settings-audit-dark-contact.jpg`
- `tests/e2e/.artifacts/STG-001-settings-sections-nav-sdtqWb/settings-audit-light-contact.jpg`
- `tests/e2e/.artifacts/STG-002-settings-theme-persist-6ciRt0/`
- `tests/e2e/.artifacts/STG-004-settings-data-workspace-Y5JAvO/`
- `tests/e2e/.artifacts/STG-006-settings-diagnostics-BYXgOT/`
- `tests/e2e/.artifacts/STG-007-settings-app-update-P9Gtze/`
- `tests/e2e/.artifacts/STG-008-settings-skills-IN1daA/`

## Launch note

The first grouped Electron attempt failed before rendering because the long-running Vite dev server returned a stale blank `settings-view.tsx` module (`does not provide an export named 'SettingsView'`). Restarting the managed application rebuilt the module; the exact acceptance then passed. This was launch infrastructure, not a product assertion failure.
