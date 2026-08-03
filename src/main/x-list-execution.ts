import type { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { upsertSource } from './sources.ts';
import { writeXListTimelineCacheIfImproved } from './x-list-timeline-cache.ts';
import { saveXPostMetricSnapshot } from './x-post-metrics.ts';
import {
  createXList, deleteXList, ensureXListMember, readXListDetail, readXListIndex, readXListMembers, readXListTimeline,
  updateXList, XListStopRequestedError, XListUnknownError, type XListDetail
} from './platforms/x-list-browser.ts';
import { type XListBrowserConfig } from './platforms/x-list-primitives.ts';
import { XListNeedsUserError } from './platforms/x-list-session.ts';
import {
  beginXListOperation, finishXListOperation, getXListBinding, getXListOperation, isXListOperationStopRequested,
  recordXListOperationIntent, skipPendingXListOperationItems, type XListOperation, type XListSnapshot,
  updateXListBindingObservation, updateXListOperationItem, type XListBinding
} from './x-lists.ts';

export async function captureXListOperationSnapshot(config: XListBrowserConfig, operation: XListOperation): Promise<XListSnapshot> {
  if (operation.kind === 'create') {
    const index = await readXListIndex(config);
    return { accountKey: index.accountKey, index: { evidenceFingerprint: index.observation.fingerprint } };
  }
  if (!operation.listId) throw new Error('List 操作缺少稳定 List ID。');
  if (operation.kind === 'members_add' || operation.kind === 'members_remove') {
    const result = await readXListMembers(config, operation.listId);
    const handles = (operation.payload as { handles: string[] }).handles;
    const present = new Set(result.members.map((member) => member.handle.toLowerCase()));
    return {
      accountKey: result.accountKey,
      list: snapshotList(result.detail, result.accountKey),
      members: handles.map((handle) => ({ handle, present: present.has(handle.toLowerCase()) }))
    };
  }
  const result = await readXListDetail(config, operation.listId);
  return { accountKey: result.accountKey, list: snapshotList(result.detail, result.accountKey) };
}

export async function confirmAndRunXListOperation(database: DatabaseSync, config: XListBrowserConfig, input: { operationId: string; expectedRevision: number; typedListName?: string }): Promise<CommandResult<XListOperation>> {
  const operation = getXListOperation(database, input.operationId);
  if (!operation) return failure('NOT_FOUND', 'List 操作不存在。');
  if (operation.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', 'List 操作已变化，请重新加载。', { current: operation });
  if (operation.state !== 'awaiting_confirmation') return failure('CONFIRMATION_REQUIRED', 'List 操作尚未等待 UI 最终确认。');
  if (operation.kind === 'delete' && input.typedListName?.trim() !== operation.snapshot.list?.name) return failure('VALIDATION_ERROR', '删除 List 前必须输入当前 List 名称。');
  let snapshot: XListSnapshot;
  try {
    snapshot = await captureXListOperationSnapshot(config, operation);
  } catch (error) {
    return failure('BROWSER_NEEDS_USER', error instanceof Error ? error.message : String(error));
  }
  const started = beginXListOperation(database, { operationId: operation.id, expectedRevision: operation.revision, currentSnapshot: snapshot });
  if (!started.ok) return started;
  return runStartedXListOperation(database, config, started.data);
}

export async function collectBoundXListTimeline(database: DatabaseSync, config: XListBrowserConfig, input: {
  accountKey: string;
  listId: string;
  limit?: number;
  expectedBindingId?: string;
  expectedRevision?: number;
  observationKey?: string;
  scheduledFor?: string | null;
  readTimeline?: typeof readXListTimeline;
}): Promise<CommandResult<{ binding: XListBinding; sourceIds: string[]; snapshotIds: string[]; candidateCount: number }>> {
  const binding = getXListBinding(database, input.accountKey, input.listId);
  if (!binding) return failure('NOT_FOUND', 'List 绑定不存在。');
  if (!binding.enabled) return failure('INVALID_STATE', '该 List 已移出发现，不能采集。');
  if (!workspaceMatches(database, config.workspaceId)) return failure('REVISION_CONFLICT', '活动工作空间已变化，未开始 X List 读取。');
  if ((input.expectedBindingId && input.expectedBindingId !== binding.id) || (input.expectedRevision !== undefined && input.expectedRevision !== binding.revision)) {
    return failure('REVISION_CONFLICT', 'X List 来源已变化，请重新开始本次扫描。');
  }
  try {
    const result = await (input.readTimeline ?? readXListTimeline)(config, binding.listId, Math.min(Math.max(input.limit ?? 50, 1), 50));
    if (!sameHandle(result.accountKey, binding.accountKey)) return failure('ACCOUNT_MISMATCH', '当前浏览器账号与绑定 List 的账号不一致。');
    const current = getXListBinding(database, binding.accountKey, binding.listId);
    if (!current || !current.enabled || current.id !== binding.id || current.revision !== binding.revision || !workspaceMatches(database, config.workspaceId)
      || (config.accountKey && !sameHandle(config.accountKey, binding.accountKey))) {
      return failure('REVISION_CONFLICT', 'X List 来源或账号在读取期间已变化，未写入迟到结果。');
    }
    if (result.posts.some((post) => !post.metricEvidence)) return failure('VALIDATION_ERROR', 'X List 指标缺少原始解析证据，未写入资料或快照。');
    const capturedAt = result.detail.observation.capturedAt;
    const observationKey = input.observationKey?.trim() || `${current.id}:${capturedAt}`;
    database.exec('BEGIN IMMEDIATE');
    try {
      const saved = result.posts.map((post) => ({ post, source: upsertSource(database, {
        feedId: current.sourceFeedId,
        originalUrl: post.url,
        title: post.text.replace(/\s+/g, ' ').slice(0, 180) || `${current.name} 动态`,
        author: post.authorHandle ?? undefined,
        publishedAt: post.postedAt ?? undefined,
        summary: post.text,
        evidence: JSON.stringify({ listId: current.listId, listUrl: current.canonicalUrl, collectedAt: capturedAt })
      }) }));
      const snapshotIds = saved.flatMap(({ post, source }) => post.metricEvidence ? [saveXPostMetricSnapshot(database, {
        sourceItemId: source.id,
        accountKey: current.accountKey,
        listId: current.listId,
        bindingId: current.id,
        bindingRevision: current.revision,
        observationKey,
        scheduledFor: input.scheduledFor,
        capturedAt,
        metrics: post.metricEvidence,
        evidence: { workspaceId: config.workspaceId ?? null, pageUrl: result.detail.observation.pageUrl, fingerprint: result.detail.observation.fingerprint }
      }).id] : []);
      const sourceIds = saved.map(({ source }) => source.id);
      const updated = updateXListBindingObservation(database, current.accountKey, current.listId, { detail: result.detail.observation, collected: sourceIds.length, snapshots: snapshotIds.length });
      writeXListTimelineCacheIfImproved(database, {
        accountKey: current.accountKey,
        listId: current.listId,
        posts: result.posts,
        detail: { name: result.detail.name, canonicalUrl: result.detail.canonicalUrl },
        source: 'collect',
        fetchedAt: capturedAt
      });
      database.exec('COMMIT');
      return success({ binding: updated!, sourceIds, snapshotIds, candidateCount: result.posts.length });
    } catch (error) {
      database.exec('ROLLBACK');
      return failure('VALIDATION_ERROR', error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    return failure('BROWSER_NEEDS_USER', error instanceof Error ? error.message : String(error));
  }
}

async function runStartedXListOperation(database: DatabaseSync, config: XListBrowserConfig, operation: XListOperation): Promise<CommandResult<XListOperation>> {
  if (operation.kind === 'members_add' || operation.kind === 'members_remove') return runMemberBatch(database, config, operation);
  const intent = { value: false };
  const hooks = actionHooks(database, operation.id, intent);
  try {
    if (operation.kind === 'create') {
      const payload = operation.payload as { name: string; description?: string; isPrivate: boolean };
      const result = await createXList(config, payload, hooks);
      assertAccount(operation, result.accountKey);
      return success(finishXListOperation(database, operation.id, { state: 'succeeded', phase: 'readback_succeeded', evidence: { result: { accountKey: result.accountKey, listId: result.detail.listId, url: result.detail.canonicalUrl } } }));
    }
    if (operation.kind === 'update') {
      const payload = operation.payload as { name?: string; description?: string; isPrivate?: boolean };
      const result = await updateXList(config, { listId: operation.listId!, ...payload }, hooks);
      assertAccount(operation, result.accountKey);
      return success(finishXListOperation(database, operation.id, { state: 'succeeded', phase: 'readback_succeeded', evidence: { result: { accountKey: result.accountKey, listId: result.detail.listId, url: result.detail.canonicalUrl } } }));
    }
    const result = await deleteXList(config, operation.listId!, hooks);
    assertAccount(operation, result.accountKey);
    return success(finishXListOperation(database, operation.id, { state: 'succeeded', phase: 'readback_succeeded', evidence: { result } }));
  } catch (error) {
    return success(finishFromError(database, operation.id, intent.value, error));
  }
}

async function runMemberBatch(database: DatabaseSync, config: XListBrowserConfig, operation: XListOperation): Promise<CommandResult<XListOperation>> {
  const desiredState = (operation.payload as { desiredState: 'present' | 'absent' }).desiredState;
  for (const item of operation.items) {
    if (item.state !== 'pending') continue;
    if (isXListOperationStopRequested(database, operation.id)) {
      skipPendingXListOperationItems(database, operation.id);
      return success(finishXListOperation(database, operation.id, { state: 'partial', phase: 'stopped_at_action_boundary' }));
    }
    const intent = { value: false };
    try {
      const result = await ensureXListMember(config, { listId: operation.listId!, handle: item.handle, desiredState }, actionHooks(database, operation.id, intent, item.handle));
      assertAccount(operation, result.accountKey);
      updateXListOperationItem(database, { operationId: operation.id, handle: item.handle, state: outcomeState(result.outcome), evidence: { outcome: result.outcome, evidenceUrl: result.evidenceUrl } });
    } catch (error) {
      if (error instanceof XListStopRequestedError) {
        skipPendingXListOperationItems(database, operation.id);
        return success(finishXListOperation(database, operation.id, { state: 'partial', phase: 'stopped_at_action_boundary' }));
      }
      if (error instanceof XListNeedsUserError && !intent.value) {
        updateXListOperationItem(database, { operationId: operation.id, handle: item.handle, state: 'needs_user', evidence: { message: error.message } });
        // Keep going for remaining handles; final state becomes partial/needs_user summary.
        continue;
      }
      const state = intent.value || error instanceof XListUnknownError ? 'unknown' : 'failed';
      updateXListOperationItem(database, { operationId: operation.id, handle: item.handle, state, evidence: { message: error instanceof Error ? error.message : String(error) } });
      if (state === 'unknown') {
        skipPendingXListOperationItems(database, operation.id);
        return success(finishXListOperation(database, operation.id, { state, phase: 'unknown_after_action', errorCode: 'X_LIST_UNKNOWN', errorMessage: error instanceof Error ? error.message : String(error) }));
      }
      continue;
    }
  }
  const items = getXListOperation(database, operation.id)?.items ?? operation.items;
  const needsUser = items.filter((item) => item.state === 'needs_user').length;
  const failed = items.filter((item) => item.state === 'failed').length;
  const done = items.filter((item) => item.state === 'added' || item.state === 'removed' || item.state === 'already_present' || item.state === 'already_absent').length;
  if (needsUser && !failed && !done) {
    return success(finishXListOperation(database, operation.id, {
      state: 'needs_user',
      phase: 'needs_user',
      errorCode: 'BROWSER_NEEDS_USER',
      errorMessage: '部分成员变更需要用户接管浏览器。'
    }));
  }
  if ((failed || needsUser) && done) {
    return success(finishXListOperation(database, operation.id, {
      state: 'partial',
      phase: 'partial_member_readbacks',
      errorCode: needsUser ? 'BROWSER_NEEDS_USER' : 'VALIDATION_ERROR',
      errorMessage: needsUser ? '部分成员需要用户接管后重试。' : '部分成员变更失败。'
    }));
  }
  if (failed || needsUser) {
    return success(finishXListOperation(database, operation.id, {
      state: needsUser ? 'needs_user' : 'failed',
      phase: needsUser ? 'needs_user' : 'failed',
      errorCode: needsUser ? 'BROWSER_NEEDS_USER' : 'VALIDATION_ERROR',
      errorMessage: needsUser ? '成员变更需要用户接管浏览器。' : '全部成员变更失败。'
    }));
  }
  return success(finishXListOperation(database, operation.id, { state: 'succeeded', phase: 'all_member_readbacks_succeeded' }));
}

function actionHooks(database: DatabaseSync, operationId: string, intent: { value: boolean }, handle?: string) {
  return {
    beforeAction: async (action: string) => { intent.value = true; recordXListOperationIntent(database, operationId, action, handle); },
    shouldStop: async () => isXListOperationStopRequested(database, operationId)
  };
}

function finishFromError(database: DatabaseSync, operationId: string, intentRecorded: boolean, error: unknown): XListOperation {
  if (error instanceof XListStopRequestedError) return finishXListOperation(database, operationId, { state: 'partial', phase: 'stopped_at_action_boundary' });
  if (error instanceof XListNeedsUserError && !intentRecorded) return finishXListOperation(database, operationId, { state: 'needs_user', phase: 'needs_user', errorCode: 'BROWSER_NEEDS_USER', errorMessage: error.message });
  const unknown = intentRecorded || error instanceof XListUnknownError;
  return finishXListOperation(database, operationId, {
    state: unknown ? 'unknown' : 'failed', phase: unknown ? 'unknown_after_action' : 'failed',
    errorCode: unknown ? 'X_LIST_UNKNOWN' : 'VALIDATION_ERROR', errorMessage: error instanceof Error ? error.message : String(error)
  });
}

function snapshotList(detail: XListDetail, accountKey: string): NonNullable<XListSnapshot['list']> {
  const owned = !detail.ownerHandle || sameHandle(detail.ownerHandle, accountKey) || detail.kind === 'owned';
  return {
    listId: detail.listId,
    canonicalUrl: detail.canonicalUrl,
    ownerHandle: owned ? accountKey : (detail.ownerHandle ?? accountKey),
    name: detail.name,
    description: detail.description ?? '',
    isPrivate: detail.isPrivate === true,
    memberCount: detail.memberCount,
    kind: owned ? 'owned' : detail.kind,
    evidenceFingerprint: detail.observation.fingerprint
  };
}

function assertAccount(operation: XListOperation, accountKey: string): void {
  if (!sameHandle(operation.accountKey, accountKey)) throw new XListNeedsUserError('X 执行时账号已变化，结果需要人工确认。');
}

function outcomeState(outcome: 'added' | 'removed' | 'already_present' | 'already_absent'): 'succeeded' | 'already_present' | 'already_absent' {
  return outcome === 'already_present' || outcome === 'already_absent' ? outcome : 'succeeded';
}

function sameHandle(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }

function workspaceMatches(database: DatabaseSync, workspaceId?: string): boolean {
  if (!workspaceId) return true;
  const stored = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
  return stored?.value === workspaceId;
}
