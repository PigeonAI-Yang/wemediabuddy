# Workspace-scoped human-AI collaboration architecture

Status: Owner-approved target and migration design for WMB-4800. This document explains the change; PRD, SPEC and TECHNICAL_DESIGN remain normative, and TASKS.md remains the only progress ledger.

## 1. Product center

WMB is a workspace-isolated self-media business and knowledge flywheel. A human owns each lane's goal, viewpoint, grants and final responsibility. Built-in Pi and external Agents are equal task-authorized workers that may research, analyze, organize, persist, create and review within an approved task. WMB supplies the shared business surface, preserves durable facts and controls side effects.

The center is not Electron Main, Pi chat, MCP, SQLite, Skills or a generic Agent platform. Those are implementation or operating surfaces around the same self-media lifecycle:

```text
sources → evidence → opportunities → plans → content → platform versions
        → manual publication → metrics → reviews/methods → next plan
```

Every useful result enters an existing root-local business object with evidence and causation. Chat transcripts, model reasoning, tool-progress text and Pi session files remain supporting records, never business truth or authorization.

## 2. Scope boundaries

This migration preserves:

- one Electron modular monolith and one SQLite database per data root;
- one active workspace runtime at a time;
- Pi as the pinned built-in executor and MCP as the external Agent surface;
- website/X Lists as fixed shared self-media capabilities with root-local configuration;
- X, Xiaohongshu and WeChat delivery contracts;
- visible browser operation and manual final publication;
- existing immutable content versions, revisions, receipts and truthful `needs_user`/`unknown` states.

It does not add microservices, a shared multi-tenant database, RBAC, a generic workflow engine, arbitrary code execution, an embedded model, platform APIs or multi-user collaboration.

## 3. Ownership model

| Owner | Owns | Must not own |
| --- | --- | --- |
| InstallationContext | app/runtime/model presets, shared Skill library, browser executable, BrowserProfile registry, defaultProfileId | sources, content, tasks, grants, account snapshots or receipts |
| Workspace data root | business and knowledge facts, source/List configuration, tasks, sessions, grants, account/profile binding, receipts and audit | physical browser profiles/cookies or another root's data |
| ActiveWorkspaceRuntime | one root DB, dispatcher, serial write queue, MCP endpoint, scheduler, browser lease and worker-lease manager | installation defaults or inactive-root work |
| Pi/external Agent worker | bounded task/session context and research execution | workspace selection, grants, direct DB/files, final publish or independent truth |
| Owner UI | goal, viewpoint, root/profile selection, grant gates and final decisions | silent cross-root reuse or platform final-click automation |

New roots explicitly copy InstallationContext.defaultProfileId into their own binding record and establish an expected-account snapshot plus binding revision. This is the approved default inheritance. The Owner may later rebind or create/select an independent profile. Sharing a physical profile never shares root-local account snapshots, sources, Lists, caches, operations, grants, receipts, content or knowledge.

Legacy root-local `browser-profile` directories are never launched implicitly. WMB-4802 first reuses an already verified installation profile when present. If credentials exist only in a legacy root profile, the Owner gets one explicit UI migration: with every browser process stopped, WMB copies it into a new opaque installation-owned profile, keeps the source untouched, verifies the live account, then binds the root. Failed verification becomes `needs_user`; WMB neither guesses the account nor silently falls back to the legacy path.

## 4. One command boundary

All mutation transports converge before domain logic:

```text
Owner UI / Pi / external Agent / scheduler / browser adapter
                         ↓
                  CommandEnvelopeV1
                         ↓
                    dispatcher
                         ↓
        domain state + receipt + minimal audit
```

The envelope carries workspace/runtime identity, actor, task/worker identity when applicable, request ID, input hash, grant references and causation. `inputHash` covers command ID, normalized input and the workspace/runtime/profile/account/object identities bound by that command. The dispatcher rejects stale identity before a domain or platform write and cannot replay a receipt from another command with a coincidentally equal payload.

One SQLite transaction commits a business mutation, its durable receipt and minimal audit. Replaying the same workspace/request ID and input hash returns the original receipt; changing the hash conflicts. Files may stage before the transaction, but a committed object never references an uncommitted file.

Reads may run concurrently. Business writes and external-effect state transitions serialize through the active runtime. This is a correctness boundary, not a new workflow framework.

## 5. Grants and human authority

A task grant is a durable, root-local authorization for a Pi or external Agent worker to pursue one Owner goal within frozen scope, inputs/revisions and time. It permits autonomous internal business work; it is not a user role and does not authorize an external side effect.

A precise execution grant derives from a live task grant and freezes one exact business/browser side effect: command and input hash, workspace/runtime epoch, object revisions, profile binding and expected account, target identities, payload/assets, allowed transition and required readback. Missing, stale, consumed, broadened or mismatched grants produce zero write.

Normal explicit Owner UI mutations carry Owner-UI actor evidence rather than inventing an AI task grant. All task/precise grant issuance and revocation, plus workspace creation/activation and profile binding/rebinding, remain UI-only gates. Pi and external MCP cannot invoke those gates. WMB never receives a grant to click a platform's final publish control.

| Command class | Task grant | Precise grant | UI-only gate |
| --- | --- | --- | --- |
| Pure read | no | no | no |
| Owner UI internal write | no | only when it creates an exact side-effect authorization | the explicit UI action is actor evidence |
| Pi/external Agent source, knowledge, content or review write | yes | no external side effect: no | no |
| Website add/enable/remove; X create/member change | yes for Agent execution | yes | yes, Owner UI issues the exact grant |
| X edit/delete; workspace/profile binding or rebinding | Agent may prepare only | yes where an operation follows | yes |
| Browser editor prepare/readback | initiating task/Owner action | yes | according to the existing publication handoff |
| Platform final publish | not applicable | none exists | user clicks manually on the platform |

## 6. Runtime and failure lifecycle

`ActiveWorkspaceRuntime` is the only owner of live root resources. Current scope allows one active Pi RPC worker lease per active root; the lease carries workspace ID, runtime epoch, task ID, worker-lease ID, request ID and causation. Bounded read/research work may run concurrently, but raising Pi worker capacity or adding parallel Agent orchestration remains future scope. A Pi process is never a second business authority.

Switch and quit close new claims first, drain only the current atomic command/readback boundary, persist truthful terminal state, stop worker/browser leases, close MCP/DB resources and discard late events with zero write. A root switch relaunches into the target root; it does not hot-rebind a renderer or reuse a stale MCP URL.

Browser effects commit a browser-operation state before each external action and perform truthful readback afterward. This state is separate from the publication record: browser-operation `succeeded` means editor preparation/readback succeeded, never that WMB published. Interruption becomes `needs_user`, `unknown` or a reconciled terminal result; it never silently retries an uncertain action. Publication preparation uses an immutable snapshot, while final publication remains manual.

## 7. Migration strategy

The migration is replacement, not a parallel compatibility architecture. Historical data and sessions remain readable, but migrated capabilities lose their legacy direct write entrypoint.

1. `WMB-4801`: seal the current route/process/data baseline, legacy read model and EVAL-029 fixtures.
2. `WMB-4802`: land InstallationContext BrowserProfile registry/default inheritance, root binding/account snapshots and the explicit legacy-profile migration.
3. `WMB-4803`: establish ActiveWorkspaceRuntime ownership, new-per-launch runtime epoch, bounded leases and drain protocol.
4. `WMB-4804`: add CommandEnvelopeV1, dispatcher, receipts/replay/audit and migrate one representative domain mutation.
5. `WMB-4805`: add task grants and prove Pi/external-Agent continuation with persisted business facts.
6. `WMB-4806`: add precise execution grants plus UI-only issuance/revoke gates and stale/zero-write checks.
7. `WMB-4807`: move remaining UI, MCP and scheduler business writes behind the dispatcher and retire migrated direct write routes.
8. `WMB-4808`: migrate browser side effects, publication snapshots and reconciliation; retire implicit conversational/direct-tool authorization.
9. `WMB-4809`: freeze legacy writes as read-only compatibility, run complete AI/UK packaged EVAL-029, and update the operator Skill for delivered workflows.

Each task must leave one falsifiable check, update the canonical operator Skill when its observable workflow/authority changes, and preserve all unrelated dirty work. No task may claim completion from API success, process readiness, chat narration or test doubles without the required durable/live readback.

## 8. Completion

The architecture is delivered only when EVAL-029 proves in a current Windows package that two roots can share the default physical profile without sharing business/account facts; Owner rebinding works; Pi and an external Agent continue one granted task; replay and stale identity are deterministic; runtime switch/quit rejects late writes; browser operations reconcile truthfully; legacy records stay readable; and the user alone performs final publication.
