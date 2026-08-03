# Pi Operation Skill Maintenance

## Purpose and status

User requirement: Pi must not rediscover how to operate WeMediaBuddy on every conversation. WMB therefore maintains one installation-wide operation Skill that explains supported business workflows, tool order, confirmation boundaries, state handling and required readback.

Current gap: the repository does not yet contain that shared operation Skill. The active UK Pi root contains only its lane Skill, while generic WMB operating knowledge is split between the appended system prompt and tool descriptions. This document is the maintenance contract for the shared Skill; it does not claim the missing product asset is already delivered.

Delivery of the missing asset, the X List browser/login correction, truthful daily-progress correction, installer and packaged acceptance is tracked serially by `WMB-2400`, `WMB-2403`, `WMB-2404`, `WMB-2401` and `WMB-2402` in `TASKS.md`.

When implemented, the canonical source is:

```text
skills/wemedia-buddy-operator/SKILL.md
```

Packaged resources and data-root copies are generated artifacts. Development Agents edit only the canonical source. They must not hand-edit `out/`, `data/<root>/pi-agent/skills/`, or another installed copy.

## Layer ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| Pi system prompt | Immutable safety and authority boundaries: use `wmb_*`, no direct DB/file write, no final publication, UI-only confirmation | Detailed operating playbooks or duplicated tool manuals |
| WMB operator Skill | How to operate WMB: prerequisite reads, tool sequence, user handoff, state/error handling and final readback | Business implementation, arbitrary SQL/file access, lane editorial judgment |
| MCP/Pi tool schema and Main business command | Exact parameters, validation, workspace/revision binding, transactions and error propagation | Natural-language workflow teaching |
| Lane Skill | Audience, editorial context, sourcing judgment and creation method for AI/UK/game | Copies of generic WMB operating procedures or channel execution code |

The business command remains authoritative. The Skill teaches the supported path; it never weakens or replaces runtime validation.

## Required impact review

Every task that changes one of the following must review and normally update the operator Skill in the same task:

| Change | Operator Skill update |
| --- | --- |
| Add, rename, remove or change a Pi/MCP tool, parameter, result or error | Update exact tool names, inputs, sequence and readback |
| Add or change a user workflow across Today, Discover, Studio, Publish, Results or Settings | Update the playbook and where Pi hands control to the user |
| Change prerequisites such as Pi configuration, browser/login state, selected workspace or enabled channels | Update preflight and `needs_user` recovery |
| Change prepare/confirm, stale-revision, publication or other human-authorization boundaries | Update what Pi may prepare, what only UI may confirm, and stale recovery |
| Add or change task/job states, retry, cancellation, restart or root-switch behavior | Update state interpretation and safe next action |
| Add a shared module or change module ownership | Update module routing; do not copy the flow into lane Skills |
| Change workspace/profile/data-root isolation or active identity readback | Update identity checks before mutation and required post-action readback |
| Change Skill packaging, installation, versioning or Pi launch arguments | Update install/load contract and packaged verification |
| Remove a workflow or capability | Remove obsolete guidance and prove no stale tool name remains |

An update is normally unnecessary for pure visual styling, internal refactoring with identical observable behavior, test-only changes, or database migrations invisible to Pi. The task evidence must still state why the Skill is unaffected.

## Task evidence contract

Every affected `TASKS.md` completion receipt includes exactly one decision line:

```text
Pi operator Skill impact: updated — <changed playbook and verification>
```

or:

```text
Pi operator Skill impact: no change — <concrete reason observable behavior is unchanged>
```

“Not relevant” without a reason is not evidence. If the canonical Skill has not yet been implemented, an affected product task cannot claim that Pi operating guidance was synchronized; it must either deliver the Skill first or record the explicit dependency/blocker.

## Update procedure

1. Read the active `TASKS.md` item and the referenced PRD/SPEC behavior.
2. Trace the real UI/IPC/MCP/Pi/Main call path and identify the authoritative command.
3. Classify the change using the impact table above.
4. Update the canonical operator Skill only; keep lane-specific judgment in the lane Skill.
5. Keep the system prompt limited to immutable safety/authority boundaries. Move repeatable operating steps into the Skill instead of expanding the prompt.
6. Check every tool named by the changed playbook against the actual Pi extension/tool registry.
7. Run the smallest focused workflow check, then record the impact decision and evidence in the same `TASKS.md` row.
8. When packaging or installation changed, verify one fresh packaged Pi root loads the canonical Skill and one existing root refreshes without retaining a stale copy.

## Verification

Documentation-only maintenance:

- `scripts/check.ps1` must find this document and all required Harness indexes;
- `git diff --check` must pass.

Operator Skill content changes:

- parse every referenced `wmb_*` tool and prove it exists in the current Pi extension registry;
- prove removed/renamed tool names are absent from the canonical Skill;
- run one focused workflow covering the changed sequence and final readback.

Packaging or loader changes:

- build the Windows package;
- start Pi in a fresh isolated data root;
- read back the loaded Skill identity/version from the actual Pi runtime;
- repeat with one existing root to prove refresh behavior;
- confirm lane Skills remain root-specific while the operator Skill is identical across roots.

Model narration or the presence of a copied file alone is not proof that Pi loaded or followed the Skill.

## Rule update routing

- Product behavior changed: update PRD/SPEC first, then the operator Skill and task evidence.
- Tool or architecture changed without product-scope change: update TECHNICAL_DESIGN when applicable, then the operator Skill.
- A repeated Pi operating mistake exposed missing guidance: add the smallest playbook clarification and one focused regression.
- A new lane differs only in audience/editorial judgment: update its lane Skill, not the shared operator Skill.
- A new shared WMB operation exists: update the shared operator Skill once; never duplicate it across lane Skills.
