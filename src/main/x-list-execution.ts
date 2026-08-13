import type { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { scheduleSourceKnowledgeCompile } from './knowledge-compile-trigger.ts';
import { upsertSource } from './sources.ts';
import { writeXListTimelineCacheIfImproved } from './x-list-timeline-cache.ts';
import { saveXPostMetricSnapshot } from './x-post-metrics.ts';
import {
  createXList, deleteXList, ensureXListMember, readXListDetail, readXListIndex, readXListMembers, readXListTimeline,
  updateXList, XListStopRequestedError, XListUnknownError, type XListDetail, type XListPost
} from './platforms/x-list-browser.ts';
import { type XListBrowserConfig } from './platforms/x-list-primitives.ts';
import { XListNeedsUserError, XListPlatformRejectedError } from './platforms/x-list-session.ts';
import {
  getXListBinding, type XListBinding, type XListOperation, type XListOperationItemState,
  type XListSnapshot, updateXListBindingObservation, xListSnapshotFingerprint
} from './x-lists.ts';

export const activeXListOperationIds = new Set<string>();

export type XListOperationFinish = Readonly<{
  state: 'succeeded' | 'partial' | 'needs_user' | 'unknown' | 'failed';
  phase: string;
  evidence?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}>;

export type XListOperationPersistence = Readonly<{
  assertAuthority: () => XListOperation;
  read: () => XListOperation | null;
  isStopRequested: () => boolean;
  recordIntent: (action: string, handle?: string) => Promise<XListOperation>;
  updateItem: (input: { handle: string; state: XListOperationItemState; evidence?: Record<string, unknown> }) => Promise<XListOperation>;
  skipPendingItems: () => Promise<XListOperation>;
  finish: (input: XListOperationFinish) => Promise<XListOperation>;
}>;
async function runTrackedXListOperation(
  config: XListBrowserConfig,
  operation: XListOperation,
  persistence: XListOperationPersistence
): Promise<CommandResult<XListOperation>> {
  activeXListOperationIds.add(operation.id);
  try { return await runStartedXListOperation(config, operation, persistence); }
  finally { activeXListOperationIds.delete(operation.id); }
}

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

export async function runAcceptedXListOperation(
  config: XListBrowserConfig,
  operation: XListOperation,
  persistence: XListOperationPersistence
): Promise<CommandResult<XListOperation>> {
  if (operation.state !== 'running' || operation.phase !== 'executing' || !operation.executionGrantId) {
    return failure('EXECUTION_GRANT_REQUIRED', 'List 浏览器操作尚未完成精确授权和运行状态提交。');
  }
  persistence.assertAuthority();
  let snapshot: XListSnapshot;
  try {
    snapshot = await captureXListOperationSnapshot(config, operation);
    persistence.assertAuthority();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return success(await persistence.finish({ state: 'needs_user', phase: 'needs_user', errorCode: 'BROWSER_NEEDS_USER', errorMessage: message }));
  }
  if (operation.confirmationFingerprint !== xListSnapshotFingerprint(snapshot)) {
    return success(await persistence.finish({ state: 'failed', phase: 'confirmation_stale', errorCode: 'CONFIRMATION_STALE', errorMessage: '账号、List 或冻结变更集已变化，未执行任何平台写入。' }));
  }
  return runTrackedXListOperation(config, operation, persistence);
}

export type CollectBoundXListTimelineInput = {
  accountKey: string;
  listId: string;
  limit?: number;
  expectedBindingId?: string;
  expectedRevision?: number;
  observationKey?: string;
  scheduledFor?: string | null;
  expectedObservationJobId?: string;
  isCurrent?: () => boolean;
  readTimeline?: typeof readXListTimeline;
};

export type BoundXListTimelineRead = {
  binding: XListBinding;
  timeline: { accountKey: string; detail: XListDetail; posts: XListPost[]; hasMore: boolean };
};

export type BoundXListTimelineCollection = {
  binding: XListBinding;
  sourceIds: string[];
  snapshotIds: string[];
  candidateCount: number;
  capturedAt: string;
};

export async function readBoundXListTimeline(
  database: DatabaseSync,
  config: XListBrowserConfig,
  input: CollectBoundXListTimelineInput
): Promise<CommandResult<BoundXListTimelineRead>> {
  const binding = validateBoundXListTimelineContext(database, config, input);
  if (!binding.ok) return binding;
  try {
    const timeline = await (input.readTimeline ?? readXListTimeline)(config, binding.data.listId, Math.min(Math.max(input.limit ?? 50, 1), 50));
    if (!sameHandle(timeline.accountKey, binding.data.accountKey)) return failure('ACCOUNT_MISMATCH', '当前浏览器账号与绑定 List 的账号不一致。');
    if (timeline.posts.some((post) => !post.metricEvidence)) return failure('VALIDATION_ERROR', 'X List 指标缺少原始解析证据，未写入资料或快照。');
    return success({ binding: binding.data, timeline });
  } catch (error) {
    return failure('BROWSER_NEEDS_USER', error instanceof Error ? error.message : String(error));
  }
}

export function persistBoundXListTimeline(
  database: DatabaseSync,
  config: XListBrowserConfig,
  input: CollectBoundXListTimelineInput,
  read: BoundXListTimelineRead
): CommandResult<BoundXListTimelineCollection> {
  const validated = validateBoundXListTimelineContext(database, config, {
    ...input,
    accountKey: read.binding.accountKey,
    listId: read.binding.listId,
    expectedBindingId: read.binding.id,
    expectedRevision: read.binding.revision
  });
  if (!validated.ok) return validated;
  const current = validated.data;
  if (config.accountKey && !sameHandle(config.accountKey, current.accountKey)) return failure('ACCOUNT_MISMATCH', '当前浏览器账号与绑定 List 的账号不一致。');
  const result = read.timeline;
  if (!sameHandle(result.accountKey, current.accountKey)) return failure('ACCOUNT_MISMATCH', '当前浏览器账号与绑定 List 的账号不一致。');
  if (result.posts.some((post) => !post.metricEvidence)) return failure('VALIDATION_ERROR', 'X List 指标缺少原始解析证据，未写入资料或快照。');
  try {
    const capturedAt = result.detail.observation.capturedAt;
    const observationKey = input.observationKey?.trim() || `${current.id}:${capturedAt}`;
    const saved = result.posts.map((post) => ({ post, source: upsertSource(database, {
      feedId: current.sourceFeedId,
      originalUrl: post.url,
      title: post.text.replace(/\s+/g, ' ').slice(0, 180) || `${current.name} 动态`,
      author: post.authorHandle ?? undefined,
      publishedAt: post.postedAt ?? undefined,
      summary: post.text,
      evidence: JSON.stringify({
        listId: current.listId,
        listUrl: current.canonicalUrl,
        collectedAt: capturedAt,
        avatarUrl: post.avatarUrl ?? null,
        displayName: post.displayName ?? null
      })
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
    // WMB-5229：直写保存成功后异步有界编译（不阻断采集/快照）。
    for (const { source } of saved) scheduleSourceKnowledgeCompile({ sourceId: source.id, revision: source.revision });
    return success({ binding: updated!, sourceIds, snapshotIds, candidateCount: result.posts.length, capturedAt });
  } catch (error) {
    return failure('VALIDATION_ERROR', error instanceof Error ? error.message : String(error));
  }
}

export async function collectBoundXListTimeline(
  database: DatabaseSync,
  config: XListBrowserConfig,
  input: CollectBoundXListTimelineInput
): Promise<CommandResult<BoundXListTimelineCollection>> {
  const read = await readBoundXListTimeline(database, config, input);
  if (!read.ok) return read;
  database.exec('BEGIN IMMEDIATE');
  try {
    const persisted = persistBoundXListTimeline(database, config, input, read.data);
    if (!persisted.ok) {
      database.exec('ROLLBACK');
      return persisted;
    }
    database.exec('COMMIT');
    return persisted;
  } catch (error) {
    database.exec('ROLLBACK');
    return failure('VALIDATION_ERROR', error instanceof Error ? error.message : String(error));
  }
}

function validateBoundXListTimelineContext(
  database: DatabaseSync,
  config: XListBrowserConfig,
  input: CollectBoundXListTimelineInput
): CommandResult<XListBinding> {
  const binding = getXListBinding(database, input.accountKey, input.listId);
  if (!binding) return failure('NOT_FOUND', 'List 绑定不存在。');
  if (!binding.enabled) return failure('INVALID_STATE', '该 List 已移出发现，不能采集。');
  if (input.isCurrent && !input.isCurrent()) return failure('REVISION_CONFLICT', 'X List 观察已停止，未开始读取。');
  if (!workspaceMatches(database, config.workspaceId)) return failure('REVISION_CONFLICT', '活动工作空间已变化，未开始 X List 读取。');
  if ((input.expectedBindingId && input.expectedBindingId !== binding.id) || (input.expectedRevision !== undefined && input.expectedRevision !== binding.revision)) {
    return failure('REVISION_CONFLICT', 'X List 来源已变化，请重新开始本次扫描。');
  }
  if (!observationJobMatches(database, input.expectedObservationJobId)) return failure('REVISION_CONFLICT', 'X List 观察已停止，未写入迟到结果。');
  return success(binding);
}

async function runStartedXListOperation(
  config: XListBrowserConfig,
  operation: XListOperation,
  persistence: XListOperationPersistence
): Promise<CommandResult<XListOperation>> {
  if (operation.kind === 'members_add' || operation.kind === 'members_remove') return runMemberBatch(config, operation, persistence);
  const intent = { value: false };
  const hooks = actionHooks(persistence, intent);
  try {
    persistence.assertAuthority();
    if (operation.kind === 'create') {
      const payload = operation.payload as { name: string; description?: string; isPrivate: boolean };
      const result = await createXList(config, payload, hooks);
      persistence.assertAuthority();
      assertAccount(operation, result.accountKey);
      return success(await persistence.finish({ state: 'succeeded', phase: 'readback_succeeded', evidence: { result: { accountKey: result.accountKey, listId: result.detail.listId, url: result.detail.canonicalUrl } } }));
    }
    if (operation.kind === 'update') {
      const payload = operation.payload as { name?: string; description?: string; isPrivate?: boolean };
      const result = await updateXList(config, { listId: operation.listId!, ...payload }, hooks);
      persistence.assertAuthority();
      assertAccount(operation, result.accountKey);
      return success(await persistence.finish({ state: 'succeeded', phase: 'readback_succeeded', evidence: { result: { accountKey: result.accountKey, listId: result.detail.listId, url: result.detail.canonicalUrl } } }));
    }
    const result = await deleteXList(config, operation.listId!, hooks);
    persistence.assertAuthority();
    assertAccount(operation, result.accountKey);
    return success(await persistence.finish({ state: 'succeeded', phase: 'readback_succeeded', evidence: { result } }));
  } catch (error) {
    return success(await finishFromError(persistence, intent.value, error));
  }
}

async function runMemberBatch(
  config: XListBrowserConfig,
  operation: XListOperation,
  persistence: XListOperationPersistence
): Promise<CommandResult<XListOperation>> {
  const payload = operation.payload as { desiredState: 'present' | 'absent' };
  for (const item of operation.items) {
    if (item.state !== 'pending') continue;
    if (persistence.isStopRequested()) {
      await persistence.skipPendingItems();
      return success(await persistence.finish({ state: 'partial', phase: 'stopped_at_action_boundary' }));
    }
    const intent = { value: false };
    try {
      persistence.assertAuthority();
      const result = await ensureXListMember(config, { listId: operation.listId!, handle: item.handle, desiredState: payload.desiredState },
        actionHooks(persistence, intent, item.handle));
      persistence.assertAuthority();
      assertAccount(operation, result.accountKey);
      await persistence.updateItem({ handle: item.handle, state: outcomeState(result.outcome), evidence: { outcome: result.outcome, evidenceUrl: result.evidenceUrl } });
    } catch (error) {
      if (error instanceof XListStopRequestedError) {
        await persistence.skipPendingItems();
        return success(await persistence.finish({ state: 'partial', phase: 'stopped_at_action_boundary' }));
      }
      if (!intent.value) {
        await persistence.updateItem({ handle: item.handle, state: 'needs_user', evidence: { message: error instanceof Error ? error.message : String(error) } });
        await persistence.skipPendingItems();
        return success(await persistence.finish({
          state: 'needs_user', phase: 'needs_user', errorCode: 'BROWSER_NEEDS_USER',
          errorMessage: error instanceof Error ? error.message : String(error)
        }));
      }
      const state = error instanceof XListPlatformRejectedError ? 'failed'
        : intent.value || error instanceof XListUnknownError ? 'unknown' : 'failed';
      await persistence.updateItem({ handle: item.handle, state, evidence: { message: error instanceof Error ? error.message : String(error) } });
      if (state === 'unknown') {
        await persistence.skipPendingItems();
        return success(await persistence.finish({ state, phase: 'unknown_after_action', errorCode: 'X_LIST_UNKNOWN', errorMessage: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
  const items = persistence.read()?.items ?? operation.items;
  const needsUser = items.filter((item) => item.state === 'needs_user').length;
  const failed = items.filter((item) => item.state === 'failed').length;
  const done = items.filter((item) => item.state === 'succeeded' || item.state === 'already_present' || item.state === 'already_absent').length;
  if (needsUser && !failed && !done) return success(await persistence.finish({
    state: 'needs_user', phase: 'needs_user', errorCode: 'BROWSER_NEEDS_USER', errorMessage: '部分成员变更需要用户接管浏览器。'
  }));
  if ((failed || needsUser) && done) return success(await persistence.finish({
    state: 'partial', phase: 'partial_member_readbacks', errorCode: needsUser ? 'BROWSER_NEEDS_USER' : 'VALIDATION_ERROR',
    errorMessage: needsUser ? '部分成员需要用户接管后重试。' : '部分成员变更失败。'
  }));
  if (failed || needsUser) return success(await persistence.finish({
    state: needsUser ? 'needs_user' : 'failed', phase: needsUser ? 'needs_user' : 'failed',
    errorCode: needsUser ? 'BROWSER_NEEDS_USER' : 'VALIDATION_ERROR',
    errorMessage: needsUser ? '成员变更需要用户接管浏览器。' : '全部成员变更失败。'
  }));
  return success(await persistence.finish({ state: 'succeeded', phase: 'all_member_readbacks_succeeded' }));
}

function actionHooks(persistence: XListOperationPersistence, intent: { value: boolean }, handle?: string) {
  return {
    beforeAction: async (action: string) => {
      persistence.assertAuthority();
      await persistence.recordIntent(action, handle);
      intent.value = true;
    },
    shouldStop: async () => persistence.isStopRequested()
  };
}

async function finishFromError(persistence: XListOperationPersistence, intentRecorded: boolean, error: unknown): Promise<XListOperation> {
  if (error instanceof XListStopRequestedError) return persistence.finish({ state: 'partial', phase: 'stopped_at_action_boundary' });
  if (!intentRecorded) return persistence.finish({
    state: 'needs_user', phase: 'needs_user', errorCode: 'BROWSER_NEEDS_USER',
    errorMessage: error instanceof Error ? error.message : String(error)
  });
  const unknown = intentRecorded || error instanceof XListUnknownError;
  return persistence.finish({
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

function observationJobMatches(database: DatabaseSync, jobId?: string): boolean {
  if (!jobId) return true;
  const job = database.prepare("SELECT status FROM jobs WHERE id=? AND kind='x_list_observation'").get(jobId) as { status?: string } | undefined;
  return job?.status === 'running';
}
