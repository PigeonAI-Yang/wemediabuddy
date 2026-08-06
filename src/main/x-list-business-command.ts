import { randomUUID } from 'node:crypto';
import { CommandDispatchError } from './command-dispatcher.ts';
import type { XListPostDetail } from './platforms/x-list-browser.ts';
import type { XListBrowserConfig } from './platforms/x-list-primitives.ts';
import type { CommandResult } from './result.ts';
import {
  dispatchBusinessCommand,
  receiptAsCommandResult,
  requireCommandResultData,
  requireReceiptData
} from './business-command.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { readXListPostCache, writeXListPostCache, type XListPostCacheScope } from './x-list-post-cache.ts';
import { readXListIndexCache, writeXListIndexCache, type XListIndexValue } from './x-list-cache.ts';
import {
  clearXListTimelineCache,
  readXListTimelineCache,
  writeXListTimelineCacheIfImproved,
  type XListTimelineCacheRecord,
  type XListTimelineCachePost
} from './x-list-timeline-cache.ts';
import {
  armXListOperation,
  beginXListOperation,
  bindXList,
  finishXListOperation,
  getXListBinding,
  getXListOperation,
  isXListOperationStopRequested,
  leaseXListOperation,
  listXListOperations,
  prepareXListOperation,
  readXListExecutionAuthority,
  recordXListOperationIntent,
  recoverOrphanedXListOperations,
  requestXListOperationStop,
  setXListBindingEnabled,
  skipPendingXListOperationItems,
  updateXListOperationItem,
  xListExecutionAuthorityMatches,
  type PrepareXListOperationInput,
  type XListOperation,
  type XListOperationItemState,
  type XListSnapshot
} from './x-lists.ts';
import {
  persistBoundXListTimeline,
  type BoundXListTimelineCollection,
  type BoundXListTimelineRead,
  type CollectBoundXListTimelineInput,
  type XListOperationFinish,
  type XListOperationPersistence
} from './x-list-execution.ts';
import { readWorkspaceBrowserBinding } from './workspace-browser-binding.ts';
import {
  getXObservationSession,
  persistXObservationSessionStart,
  stopXObservationSession,
  type XObservationSession,
  type XObservationStartRead
} from './x-observation-jobs.ts';

const owner = Object.freeze({ type: 'owner_ui' as const, id: 'renderer', label: 'Owner UI' });
const browserActor = Object.freeze({ type: 'browser_adapter' as const, id: 'x-list-browser', label: 'X List browser adapter' });
type XListValidationFailureInput = { code: string; message: string };

export async function dispatchPersistXListIndex(runtime: ActiveWorkspaceRuntime, input: {
  browserId: string;
  expectedAccountKey: string;
  value: XListIndexValue;
}) {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.index_cache_persist', requestId: randomUUID(), actor: owner, input,
    boundIdentity: { browserId: input.browserId, accountKey: input.expectedAccountKey, fingerprint: input.value.observation.fingerprint },
    entityType: 'x_list_index_cache',
    execute: (database, value) => {
      assertAccount(value.expectedAccountKey, value.value.accountKey);
      writeXListIndexCache(database, value.value);
      return { data: { accountKey: value.expectedAccountKey }, entityId: value.expectedAccountKey, readback: { listCount: value.value.lists.length } };
    }
  });
  requireReceiptData(receipt);
}

export async function dispatchPersistXListTimeline(runtime: ActiveWorkspaceRuntime, input: {
  browserId: string;
  expectedAccountKey: string;
  observedAccountKey: string;
  listId: string;
  posts: XListTimelineCachePost[];
  detail: { name?: string; canonicalUrl?: string };
  fetchedAt?: string;
}): Promise<XListTimelineCacheRecord | null> {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.timeline_cache_persist', requestId: randomUUID(), actor: owner, input,
    boundIdentity: { browserId: input.browserId, accountKey: input.expectedAccountKey, listId: input.listId, fetchedAt: input.fetchedAt ?? null },
    entityType: 'x_list_timeline_cache',
    execute: (database, value) => {
      assertAccount(value.expectedAccountKey, value.observedAccountKey);
      const saved = writeXListTimelineCacheIfImproved(database, {
        accountKey: value.expectedAccountKey, listId: value.listId, posts: value.posts,
        detail: value.detail, source: 'live', fetchedAt: value.fetchedAt
      });
      return { data: saved, entityId: `${value.expectedAccountKey}:${value.listId}`, readback: saved };
    }
  });
  return requireReceiptData(receipt);
}

export async function dispatchReadXListTimelineCache(runtime: ActiveWorkspaceRuntime, input: {
  accountKey: string;
  listId: string;
}): Promise<XListTimelineCacheRecord | null> {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.timeline_cache_read', requestId: randomUUID(), actor: owner, input,
    boundIdentity: { accountKey: input.accountKey, listId: input.listId }, entityType: 'x_list_timeline_cache',
    execute: (database, value) => {
      if (!getXListBinding(database, value.accountKey, value.listId)) return { data: null, entityId: `${value.accountKey}:${value.listId}` };
      const cached = readXListTimelineCache(database, value.accountKey, value.listId);
      return { data: cached, entityId: `${value.accountKey}:${value.listId}`, readback: cached };
    }
  });
  return requireReceiptData(receipt);
}

export async function dispatchClearXListTimelineCache(runtime: ActiveWorkspaceRuntime, input: {
  browserId: string;
  expectedAccountKey: string;
  requestedAccountKey?: string;
}): Promise<{ deleted: number }> {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.timeline_cache_clear', requestId: randomUUID(), actor: owner, input,
    boundIdentity: { browserId: input.browserId, accountKey: input.expectedAccountKey }, entityType: 'x_list_timeline_cache',
    execute: (database, value) => {
      if (value.requestedAccountKey) assertAccount(value.expectedAccountKey, value.requestedAccountKey);
      const result = clearXListTimelineCache(database, value.expectedAccountKey);
      return { data: result, entityId: value.expectedAccountKey, readback: result };
    }
  });
  return requireReceiptData(receipt);
}

export async function dispatchReadXListPostCache(runtime: ActiveWorkspaceRuntime, scope: XListPostCacheScope, statusUrl: string) {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.post_cache_read', requestId: randomUUID(), actor: owner, input: { scope, statusUrl },
    boundIdentity: { browserId: scope.browserId, accountKey: scope.accountKey, statusUrl }, entityType: 'x_list_post_cache',
    execute: (_database, value) => ({ data: readXListPostCache(value.scope, value.statusUrl), entityId: value.statusUrl })
  });
  return requireReceiptData(receipt);
}

export async function dispatchPersistXListPost(runtime: ActiveWorkspaceRuntime, input: {
  scope: XListPostCacheScope;
  statusUrl: string;
  value: { accountKey: string; post: XListPostDetail };
}) {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.post_cache_persist', requestId: randomUUID(), actor: owner, input,
    boundIdentity: { browserId: input.scope.browserId, accountKey: input.scope.accountKey, statusUrl: input.statusUrl },
    entityType: 'x_list_post_cache',
    execute: (_database, value) => {
      assertAccount(value.scope.accountKey, value.value.accountKey);
      writeXListPostCache(value.scope, value.statusUrl, value.value);
      return { data: { statusUrl: value.statusUrl }, entityId: value.statusUrl };
    }
  });
  requireReceiptData(receipt);
}

export async function dispatchPrepareXListOperation(runtime: ActiveWorkspaceRuntime, input: PrepareXListOperationInput, expectedAccountKey: string) {
  const replaying = Boolean(runtime.database.prepare('SELECT 1 FROM x_list_operations WHERE request_id=?').get(input.requestId.trim()));
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_prepare', requestId: input.requestId.trim() || randomUUID(), actor: owner, input: { ...input, transaction: true },
    boundIdentity: { accountKey: expectedAccountKey, listId: input.listId ?? null, kind: input.kind }, entityType: 'x_list_operation',
    execute: (database, value) => {
      assertAccount(expectedAccountKey, value.accountKey);
      const result = requireCommandResultData(prepareXListOperation(database, value));
      return { data: result, entityId: result.operation.id, afterRevision: result.operation.revision, readback: result };
    }
  });
  if (receipt.error?.code === 'ACCOUNT_MISMATCH') {
    requireReceiptData(receipt);
    throw new Error('Unreachable after failed receipt.');
  }
  const result = receiptAsCommandResult(receipt);
  return result.ok && replaying ? { ...result, data: { ...result.data!, replayed: true } } : result;
}

export async function dispatchArmXListOperation(runtime: ActiveWorkspaceRuntime, input: {
  operationId: string;
  expectedRevision: number;
  snapshot: XListSnapshot;
  expectedAccountKey: string;
}) {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_arm', requestId: randomUUID(), actor: owner, input,
    boundIdentity: { operationId: input.operationId, revision: input.expectedRevision, accountKey: input.expectedAccountKey }, entityType: 'x_list_operation',
    execute: (database, value) => {
      const operation = getXListOperation(database, value.operationId);
      if (!operation) return { data: requireCommandResultData(armXListOperation(database, value)), entityId: value.operationId };
      assertAccount(value.expectedAccountKey, operation.accountKey);
      const armed = requireCommandResultData(armXListOperation(database, value));
      return { data: armed, entityId: armed.id, beforeRevision: value.expectedRevision, afterRevision: armed.revision, readback: armed };
    }
  });
  if (receipt.error?.code === 'ACCOUNT_MISMATCH') {
    requireReceiptData(receipt);
    throw new Error('Unreachable after failed receipt.');
  }
  return receiptAsCommandResult(receipt);
}

export async function dispatchStopXListOperation(runtime: ActiveWorkspaceRuntime, input: { operationId: string; expectedRevision: number }) {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_stop', requestId: randomUUID(), actor: owner, input,
    boundIdentity: { operationId: input.operationId, revision: input.expectedRevision }, entityType: 'x_list_operation',
    execute: (database, value) => {
      const stopped = requireCommandResultData(requestXListOperationStop(database, value));
      return { data: stopped, entityId: stopped.id, beforeRevision: value.expectedRevision, afterRevision: stopped.revision, readback: stopped };
    }
  });
  return receiptAsCommandResult(receipt);
}

export async function dispatchBindXList(runtime: ActiveWorkspaceRuntime, input: Parameters<typeof bindXList>[1]) {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.binding_bind', requestId: randomUUID(), actor: owner, input: { ...input, transaction: true, notify: false },
    boundIdentity: { accountKey: input.accountKey, listId: input.list.listId, revision: input.expectedRevision ?? null }, entityType: 'x_list_binding',
    execute: (database, value) => {
      const binding = requireCommandResultData(bindXList(database, value));
      return { data: binding, entityId: binding.id, beforeRevision: input.expectedRevision, afterRevision: binding.revision, readback: binding };
    }
  });
  return receiptAsCommandResult(receipt);
}

export async function dispatchSetXListBindingEnabled(runtime: ActiveWorkspaceRuntime, input: {
  accountKey: string;
  listId: string;
  expectedRevision: number;
  enabled: boolean;
}, expectedAccountKey: string) {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.binding_set_enabled', requestId: randomUUID(), actor: owner, input: { ...input, notify: false },
    boundIdentity: { accountKey: expectedAccountKey, listId: input.listId, revision: input.expectedRevision }, entityType: 'x_list_binding',
    execute: (database, value) => {
      assertAccount(expectedAccountKey, value.accountKey);
      const binding = requireCommandResultData(setXListBindingEnabled(database, value));
      return { data: binding, entityId: binding.id, beforeRevision: value.expectedRevision, afterRevision: binding.revision, readback: binding };
    }
  });
  if (receipt.error?.code === 'ACCOUNT_MISMATCH') {
    requireReceiptData(receipt);
    throw new Error('Unreachable after failed receipt.');
  }
  return receiptAsCommandResult(receipt);
}

export async function dispatchPersistBoundXListTimeline(
  runtime: ActiveWorkspaceRuntime,
  config: XListBrowserConfig,
  input: CollectBoundXListTimelineInput,
  readResult: CommandResult<BoundXListTimelineRead>,
  expectedAccountKey: string
) {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.timeline_collect', requestId: randomUUID(), actor: owner,
    input: { accountKey: input.accountKey, listId: input.listId, limit: input.limit, expectedBindingId: input.expectedBindingId, expectedRevision: input.expectedRevision, observationKey: input.observationKey, scheduledFor: input.scheduledFor, readResult },
    boundIdentity: { accountKey: expectedAccountKey, listId: input.listId, bindingId: readResult.ok ? readResult.data.binding.id : input.expectedBindingId ?? null, revision: readResult.ok ? readResult.data.binding.revision : input.expectedRevision ?? null },
    entityType: 'x_list_binding',
    execute: (database, value) => {
      assertAccount(expectedAccountKey, value.accountKey);
      const read = requireCommandResultData(value.readResult);
      const result = requireCommandResultData(persistBoundXListTimeline(database, config, value, read));
      return { data: result, entityId: result.binding.id, beforeRevision: read.binding.revision, afterRevision: result.binding.revision, readback: result };
    }
  });
  if (receipt.error?.code === 'ACCOUNT_MISMATCH') {
    requireReceiptData(receipt);
    throw new Error('Unreachable after failed receipt.');
  }
  return receiptAsCommandResult<BoundXListTimelineCollection>(receipt);
}

export async function dispatchStartXObservation(runtime: ActiveWorkspaceRuntime, config: XListBrowserConfig, input: {
  requestId: string;
  bindingIds: string[];
}, readResult: CommandResult<XObservationStartRead>) {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.observation_start', requestId: input.requestId.trim() || randomUUID(), actor: owner,
    input: { requestId: input.requestId, bindingIds: input.bindingIds, readResult },
    boundIdentity: { browserId: config.id, accountKey: config.accountKey ?? null, bindingIds: [...input.bindingIds].sort() },
    entityType: 'x_observation_session',
    execute: (database, value) => {
      const read = requireCommandResultData(value.readResult);
      const session = requireCommandResultData(persistXObservationSessionStart(database, config, read));
      return { data: session, entityId: session.id, readback: session };
    }
  });
  return receiptAsCommandResult<XObservationSession>(receipt);
}

export async function dispatchStopXObservation(runtime: ActiveWorkspaceRuntime, sessionId: string): Promise<XObservationSession | null> {
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.observation_stop', requestId: randomUUID(), actor: owner, input: { sessionId },
    boundIdentity: { sessionId }, entityType: 'x_observation_session',
    execute: (database, value) => ({ data: stopXObservationSession(database, value.sessionId), entityId: value.sessionId })
  });
  return requireReceiptData(receipt);
}

export async function dispatchRecoverOrphanedXListOperations(
  runtime: ActiveWorkspaceRuntime,
  activeIds: ReadonlySet<string> = new Set()
): Promise<number> {
  const interrupted = listXListOperations(runtime.database, { limit: 100 }).filter((operation) =>
    ['execution_granted', 'browser_leased', 'running'].includes(operation.state) && !activeIds.has(operation.id));
  if (interrupted.length === 0) return 0;
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_recover',
    requestId: `${runtime.identity.runtimeEpoch}:x-list-operation-recover`,
    actor: owner,
    input: { activeIds: [...activeIds].sort() },
    boundIdentity: { runtimeEpoch: runtime.identity.runtimeEpoch },
    entityType: 'x_list_operation',
    execute: (database) => {
      const recovered = recoverOrphanedXListOperations(database, activeIds);
      return { data: recovered, readback: { recovered }, sideEffectState: recovered > 0 ? 'committed' : 'not_started' };
    }
  });
  return requireReceiptData(receipt);
}

export async function dispatchLeaseXListOperation(runtime: ActiveWorkspaceRuntime, operationId: string, executionGrantId: string): Promise<XListOperation> {
  const operation = assertCurrentXListExecutionAuthority(runtime, operationId, executionGrantId);
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_browser_lease', requestId: randomUUID(), actor: browserActor,
    input: { operationId, expectedRevision: operation.revision, executionGrantId },
    boundIdentity: { operationId, executionGrantId, expectedRevision: operation.revision }, entityType: 'x_list_operation',
    execute: (database, value) => {
      assertCurrentXListExecutionAuthority(runtime, value.operationId, value.executionGrantId);
      const leased = requireCommandResultData(leaseXListOperation(database, value));
      return { data: leased, entityId: leased.id, beforeRevision: operation.revision, afterRevision: leased.revision, readback: leased };
    }
  });
  return requireReceiptData(receipt);
}

export async function dispatchBeginXListOperation(runtime: ActiveWorkspaceRuntime, operationId: string, executionGrantId: string): Promise<XListOperation> {
  const operation = assertCurrentXListExecutionAuthority(runtime, operationId, executionGrantId);
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_begin_execution', requestId: randomUUID(), actor: browserActor,
    input: { operationId, expectedRevision: operation.revision, executionGrantId },
    boundIdentity: { operationId, executionGrantId, expectedRevision: operation.revision }, entityType: 'x_list_operation',
    execute: (database, value) => {
      assertCurrentXListExecutionAuthority(runtime, value.operationId, value.executionGrantId);
      const running = requireCommandResultData(beginXListOperation(database, value));
      return { data: running, entityId: running.id, beforeRevision: operation.revision, afterRevision: running.revision, readback: running };
    }
  });
  return requireReceiptData(receipt);
}

export function createXListOperationPersistence(
  runtime: ActiveWorkspaceRuntime,
  operationId: string,
  executionGrantId: string
): XListOperationPersistence {
  return Object.freeze({
    assertAuthority: () => assertCurrentXListExecutionAuthority(runtime, operationId, executionGrantId),
    read: () => getXListOperation(runtime.database, operationId),
    isStopRequested: () => isXListOperationStopRequested(runtime.database, operationId),
    recordIntent: (action: string, handle?: string) => dispatchXListOperationIntent(runtime, operationId, executionGrantId, action, handle),
    updateItem: (input: { handle: string; state: XListOperationItemState; evidence?: Record<string, unknown> }) =>
      dispatchXListOperationItem(runtime, operationId, executionGrantId, input),
    skipPendingItems: () => dispatchSkipXListOperationItems(runtime, operationId, executionGrantId),
    finish: (input: XListOperationFinish) => dispatchFinishXListOperation(runtime, operationId, executionGrantId, input)
  });
}

async function dispatchXListOperationIntent(
  runtime: ActiveWorkspaceRuntime, operationId: string, executionGrantId: string, action: string, handle?: string
): Promise<XListOperation> {
  const operation = assertCurrentXListExecutionAuthority(runtime, operationId, executionGrantId);
  const input = { operationId, executionGrantId, expectedRevision: operation.revision, action, handle: handle ?? null };
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_intent', requestId: randomUUID(), actor: browserActor, input,
    boundIdentity: input, entityType: 'x_list_operation',
    execute: (database, value) => {
      assertCurrentXListExecutionAuthority(runtime, value.operationId, value.executionGrantId);
      const updated = recordXListOperationIntent(database, value.operationId, value.action, value.handle ?? undefined);
      return { data: updated, entityId: updated.id, beforeRevision: operation.revision, afterRevision: updated.revision, readback: updated };
    }
  });
  return requireReceiptData(receipt);
}

async function dispatchXListOperationItem(
  runtime: ActiveWorkspaceRuntime, operationId: string, executionGrantId: string,
  item: { handle: string; state: XListOperationItemState; evidence?: Record<string, unknown> }
): Promise<XListOperation> {
  requireFrozenXListExecutionAuthority(runtime, operationId, executionGrantId);
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_item_write', requestId: randomUUID(), actor: browserActor,
    input: { operationId, executionGrantId, ...item }, boundIdentity: { operationId, executionGrantId, handle: item.handle },
    entityType: 'x_list_operation_item', execute: (database, value) => {
      requireFrozenXListExecutionAuthority(runtime, value.operationId, value.executionGrantId);
      updateXListOperationItem(database, value);
      return { data: getXListOperation(database, value.operationId)!, entityId: `${value.operationId}:${value.handle}` };
    }
  });
  return requireReceiptData(receipt);
}

async function dispatchSkipXListOperationItems(runtime: ActiveWorkspaceRuntime, operationId: string, executionGrantId: string): Promise<XListOperation> {
  requireFrozenXListExecutionAuthority(runtime, operationId, executionGrantId);
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_items_skip', requestId: randomUUID(), actor: browserActor,
    input: { operationId, executionGrantId }, boundIdentity: { operationId, executionGrantId }, entityType: 'x_list_operation',
    execute: (database, value) => {
      requireFrozenXListExecutionAuthority(runtime, value.operationId, value.executionGrantId);
      skipPendingXListOperationItems(database, value.operationId);
      return { data: getXListOperation(database, value.operationId)!, entityId: value.operationId };
    }
  });
  return requireReceiptData(receipt);
}

export async function dispatchFinishXListOperation(
  runtime: ActiveWorkspaceRuntime, operationId: string, executionGrantId: string, finish: XListOperationFinish
): Promise<XListOperation> {
  const operation = requireFrozenXListExecutionAuthority(runtime, operationId, executionGrantId);
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'x_lists.operation_finish', requestId: randomUUID(), actor: browserActor,
    input: { operationId, executionGrantId, expectedRevision: operation.revision, finish },
    boundIdentity: { operationId, executionGrantId, expectedRevision: operation.revision }, entityType: 'x_list_operation',
    execute: (database, value) => {
      requireFrozenXListExecutionAuthority(runtime, value.operationId, value.executionGrantId);
      const finished = finishXListOperation(database, value.operationId, value.finish);
      return { data: finished, entityId: finished.id, beforeRevision: operation.revision, afterRevision: finished.revision, readback: finished };
    }
  });
  return requireReceiptData(receipt);
}

function requireFrozenXListExecutionAuthority(runtime: ActiveWorkspaceRuntime, operationId: string, executionGrantId: string): XListOperation {
  const operation = getXListOperation(runtime.database, operationId);
  const authority = operation && readXListExecutionAuthority(operation);
  if (!operation || !authority || operation.executionGrantId !== executionGrantId
    || authority.executionGrantId !== executionGrantId || !xListExecutionAuthorityMatches(operation, authority)) {
    throw new CommandDispatchError('EXECUTION_GRANT_SCOPE_MISMATCH', 'List 操作的冻结执行身份已变化。');
  }
  return operation;
}

function assertCurrentXListExecutionAuthority(runtime: ActiveWorkspaceRuntime, operationId: string, executionGrantId: string): XListOperation {
  const operation = requireFrozenXListExecutionAuthority(runtime, operationId, executionGrantId);
  const authority = readXListExecutionAuthority(operation)!;
  const binding = readWorkspaceBrowserBinding(runtime.database);
  const expected = binding?.expectedAccountSnapshot.x;
  if (!binding?.profileId || binding.state !== 'verified' || binding.profileId !== authority.browserProfileId
    || binding.bindingRevision !== authority.browserBindingRevision || !expected
    || expected.browserProfileId !== authority.browserProfileId || expected.browserBindingRevision !== authority.browserBindingRevision
    || expected.accountKey.trim().toLowerCase() !== authority.expectedAccount.trim().toLowerCase()) {
    throw new CommandDispatchError('BROWSER_PROFILE_MISMATCH', 'List 操作的浏览器档案、绑定版本或账号已变化。');
  }
  return operation;
}
export function readXListIndexFromRuntime(runtime: ActiveWorkspaceRuntime) {
  return readXListIndexCache(runtime.database);
}

export function readXObservationFromRuntime(runtime: ActiveWorkspaceRuntime, sessionId: string) {
  return getXObservationSession(runtime.database, sessionId);
}

export async function dispatchXListValidationFailure(runtime: ActiveWorkspaceRuntime, input: {
  command: string;
  requestId?: string;
  boundIdentity: Readonly<Record<string, unknown>>;
  error: unknown;
}): Promise<never> {
  const candidate = input.error;
  const code = candidate && typeof candidate === 'object' && 'code' in candidate && typeof candidate.code === 'string' ? candidate.code : 'COMMAND_FAILED';
  const message = candidate instanceof Error ? candidate.message : String(candidate);
  const receipt = await dispatchBusinessCommand<XListValidationFailureInput, never>(runtime, {
    command: input.command, requestId: input.requestId ?? randomUUID(), actor: owner,
    input: { code, message }, boundIdentity: input.boundIdentity, entityType: 'x_list_command',
    execute: () => { throw Object.assign(new Error(message), { code }); }
  });
  return requireReceiptData<never>(receipt);
}

function assertAccount(expected: string, actual: string): void {
  if (expected.trim().toLowerCase() !== actual.trim().toLowerCase()) {
    throw Object.assign(new Error('当前浏览器账号与本根绑定账号不一致。'), { code: 'ACCOUNT_MISMATCH' });
  }
}
