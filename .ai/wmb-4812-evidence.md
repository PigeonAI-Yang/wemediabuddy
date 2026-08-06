# WMB-4812 Evidence

Date: 2026-08-06  
Status: **done**

## Goal

Close the three current-package EVAL-029 gaps left by WMB-4809:

1. real Pi model continuation under a live worker lease
2. packaged precise-grant negative matrix
3. packaged immutable publication-snapshot / browser reconciliation

## Product fixes required to finish acceptance

### 1) `x_lists.operation_recover` 1Hz flood

Root cause:

- `XListOperationTray` polls `listXListOperations` every 1s
- IPC `x-lists:list-operations` dispatched that list as `x_lists.operation_recover`
- every poll wrote a command receipt even when `x_list_operations` was empty
- this saturated the serial runtime write path and blocked `createBrowserProfile` relaunch

Fix:

- `src/main/ipc-x-lists.ts`: list operations is pure DB read
- `src/main/x-list-business-command.ts`: `dispatchRecoverOrphanedXListOperations` only writes when interrupted ops exist
- `src/main/index.ts`: one-shot recover on runtime open
- regression: `tests/x-list-list-operations-readback.test.mjs`

### 2) Headless Owner browser confirmation hang

Root cause:

- `createBrowserProfile` requires native `dialog.showMessageBox`
- packaged acceptance runs `WMB_ACCEPTANCE_HEADLESS=1` and cannot click the dialog
- the IPC hung forever after snapshot create

Fix:

- `src/main/ipc-settings-config.ts`: auto-accept Owner browser confirmation only when `WMB_ACCEPTANCE_HEADLESS=1`
- normal Owner UI still shows the real confirmation dialog

### 3) Acceptance runner gaps (already in tree)

- real Pi continuation under worker lease + same-task grant
- precise execution-grant negative matrix
- publication snapshot freeze + stale authorize after profile relaunch
- DPAPI: copy installed `pi-api-config.json` + `Local State`
- longer Pi settle timeout for packaged real-model runs

## Final packaged receipt

Path: `.ai/wmb-4809-package-readback.json`  
Schema: `wmb.eval-029-package-readback.v1`  
`ok: true`

| Focused gate | Result |
| --- | --- |
| Pi worker lease | `piContinuation.modelExecuted=true`; task `succeeded/completed`; `wmb_save_core_version` tool success; core version `#2` saved |
| precise grant negative matrix | prevalidation codes `SCOPE_MISMATCH`×2 / `IDENTITY_MISMATCH` / `EXPIRED`; control grant `active→revoked`; dispatched reject receipts `sideEffectState=not_started` |
| publication snapshot reconciliation | snapshot immutable across profile relaunch; authorize rejected `BROWSER_NEEDS_USER`; operation stayed `prepared`; no execution grant added; no final publication |

Also proved:

- Owner profile relaunch: bindingRevision `1→2`, new profile/runtimeEpoch/MCP
- UK switch isolates precise grant + publication snapshot
- inactive AI root digest unchanged
- manual final publication boundary retained

## Focused verification

- `npm run typecheck` pass
- `node --test tests/x-list-list-operations-readback.test.mjs tests/x-list-operations.test.mjs` pass
- packaged acceptance pass → `.ai/wmb-4809-package-readback.json`

## Pi operator Skill impact

no change — runtime list/recover routing, headless Owner-dialog acceptance bypass, and package acceptance coverage only; no Pi-facing tool/workflow contract change.

## Independent review

required for done closeout (waterline ≥ 4810).
