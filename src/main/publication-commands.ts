import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BrowserRuntime } from './browser.ts';
import { startVerifiedBoundBrowser, type BoundBrowserPlatform } from './bound-browser.ts';
import { dispatchBusinessCommand, requireCommandResultData, requireReceiptData } from './business-command.ts';
import { CommandDispatchError, createCommandEnvelope, type CommandActorV1, type CommandEnvelopeV1, type CommandReceiptV1 } from './command-dispatcher.ts';
import { dispatchIssueExecutionGrant } from './execution-grants.ts';
import {
  completePublicationPreparation, createPublicationSnapshot, getPublicationBrowserOperation, getPublicationSnapshot,
  recoverInterruptedPublicationBrowserOperations, transitionPublicationBrowserOperation, type CreatePublicationSnapshotInput, type PublicationBrowserOperationV1,
  type PublicationSnapshotV1
} from './publication-operations.ts';
import { getPublicationDetail, recoverInterruptedPublications, reconcileAsNotPublished, transitionPublication, type PublicationRecord } from './publishing.ts';
import { prepareWechatArticle, readBackWechatArticle } from './platforms/wechat.ts';
import { prepareXImage, prepareXText, prepareXVideo } from './platforms/x.ts';
import { readWorkspaceBrowserBinding } from './workspace-browser-binding.ts';
import type { ActiveWorkspaceRuntime, WorkspaceRuntimeLease } from './workspace-runtime.ts';

const OWNER: CommandActorV1 = Object.freeze({ type: 'owner_ui', id: 'renderer', label: 'Owner UI' });
export const PUBLICATION_SNAPSHOT_CREATE_COMMAND = 'publication.snapshot_create';
export const PUBLICATION_EDITOR_PREPARE_COMMAND = 'publication.editor_prepare_execute';
type SnapshotCreateInput = Readonly<{ platformVersionId: string; requestId?: string }>;
type EditorPrepareInput = Readonly<{ publicationId: string; expectedRevision: number; requestId?: string }>;
type BrowserSetter = (runtime: BrowserRuntime) => WorkspaceRuntimeLease;
export type PublicationEditorPrepareDependencies = Readonly<{
  startBrowser?: typeof startVerifiedBoundBrowser;
  invokeEditor?: typeof invokeEditorAdapter;
}>;
type PublicationOperationContext = { publication: PublicationRecord; snapshot: PublicationSnapshotV1; operation: PublicationBrowserOperationV1 };

export function dispatchCreatePublicationSnapshot(runtime: ActiveWorkspaceRuntime, input: SnapshotCreateInput): Promise<CommandReceiptV1<PublicationOperationContext>> {
  const version = runtime.database.prepare(`SELECT id, platform, title, body, format, asset_ids_json AS assetIds FROM platform_versions WHERE id=?`).get(input.platformVersionId) as { id: string; platform: BoundBrowserPlatform; title: string | null; body: string; format: string; assetIds: string } | undefined;
  if (!version || !['x', 'wechat'].includes(version.platform)) throw new CommandDispatchError('NOT_FOUND', '平台版本不存在或暂不支持发布。');
  const binding = requireVerifiedBinding(runtime, version.platform);
  const expected = binding.expectedAccountSnapshot[version.platform];
  if (!expected) throw new CommandDispatchError('ACCOUNT_MISMATCH', '当前浏览器绑定没有冻结的平台账号。');
  const account = runtime.database.prepare(`SELECT id FROM platform_accounts WHERE platform=? AND account_key=? AND browser_profile_id=? AND browser_binding_revision=?`).get(version.platform, expected.accountKey, binding.profileId, binding.bindingRevision) as { id: string } | undefined;
  if (!account) throw new CommandDispatchError('ACCOUNT_MISMATCH', '当前平台账号与浏览器绑定不一致。');
  const commandInput = { platformVersionId: version.id, accountId: account.id, browserProfileId: binding.profileId, browserBindingRevision: binding.bindingRevision, workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch, payload: { title: version.title, body: version.body, assets: parseAssetIds(version.assetIds) } };
  return dispatchBusinessCommand(runtime, { command: PUBLICATION_SNAPSHOT_CREATE_COMMAND, requestId: input.requestId ?? randomUUID(), actor: OWNER, input: commandInput, boundIdentity: { platformVersionId: version.id, accountId: account.id, platform: version.platform, browserProfileId: binding.profileId, browserBindingRevision: binding.bindingRevision }, causation: { actor: OWNER.id }, entityType: 'publication_snapshot', execute: (database, normalized) => { const data = requireCommandResultData(createPublicationSnapshot(database, normalized as CreatePublicationSnapshotInput)); return { data, entityId: data.snapshot.id, readback: data }; } });
}
export async function dispatchRecoverInterruptedPublications(runtime: ActiveWorkspaceRuntime): Promise<number> {
  const receipt = await dispatchBusinessCommand<{ runtimeEpoch: string }, number>(runtime, {
    command: 'publication.recover_interrupted',
    requestId: `${runtime.identity.runtimeEpoch}:publication-recover`,
    actor: OWNER,
    input: { runtimeEpoch: runtime.identity.runtimeEpoch },
    boundIdentity: runtime.identity,
    entityType: 'publication_browser_operation',
    execute: (database) => ({ data: recoverInterruptedPublications(database) + recoverInterruptedPublicationBrowserOperations(database), sideEffectState: 'committed' })
  });
  return requireReceiptData(receipt);
}

export async function dispatchPreparePublicationEditor(runtime: ActiveWorkspaceRuntime, input: EditorPrepareInput, setBrowser?: BrowserSetter, dependencies: PublicationEditorPrepareDependencies = {}): Promise<CommandReceiptV1<PublicationOperationContext>> {
  const replay = readPublicationEditorReplay(runtime, input);
  if (replay) return replay;
  const context = readPublicationOperationContext(runtime, input.publicationId);
  if (context.publication.revision !== input.expectedRevision) throw new CommandDispatchError('REVISION_CONFLICT', '发布记录已变化，请重新加载。');
  if (context.operation.state !== 'prepared') throw new CommandDispatchError('INVALID_STATE', '该编辑器准备操作已经授权或结束，禁止重复执行。');
  const binding = requireVerifiedBinding(runtime, context.snapshot.platform as BoundBrowserPlatform);
  assertSnapshotIdentity(runtime, context.snapshot, binding);
  const requiredReadback = { operationId: context.operation.id, snapshotId: context.snapshot.id, title: context.snapshot.payload.title, body: context.snapshot.payload.body, assetIds: context.snapshot.assets.map((asset) => asset.id) };
  const commandInput = { publicationId: context.publication.id, snapshotId: context.snapshot.id, operationId: context.operation.id, publicationRevision: context.publication.revision, operationRevision: context.operation.revision, inputHash: context.snapshot.inputHash, payload: context.snapshot.payload, assets: context.snapshot.assets, browserProfileId: context.snapshot.browserProfileId, browserBindingRevision: context.snapshot.browserBindingRevision, expectedAccount: context.snapshot.accountKey, requiredReadback };
  const allowedTransition = 'prepared->execution_granted';
  const boundIdentity = { publicationId: context.publication.id, snapshotId: context.snapshot.id, operationId: context.operation.id, publicationRevision: context.publication.revision, operationRevision: context.operation.revision, inputHash: context.snapshot.inputHash, browserProfileId: context.snapshot.browserProfileId, browserBindingRevision: context.snapshot.browserBindingRevision, expectedAccount: context.snapshot.accountKey, allowedTransition, requiredReadback };
  const requestId = input.requestId ?? `${context.operation.id}:authorize:${context.operation.revision}`;
  const draft = createCommandEnvelope({ workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch, command: PUBLICATION_EDITOR_PREPARE_COMMAND, requestId, input: commandInput, boundIdentity, actor: OWNER });
  const issued = await dispatchIssueExecutionGrant(runtime, { requestId: `${requestId}:grant`, command: PUBLICATION_EDITOR_PREPARE_COMMAND, inputHash: draft.inputHash, boundIdentity, targetActor: OWNER, browserProfileId: context.snapshot.browserProfileId, bindingRevision: context.snapshot.browserBindingRevision, expectedAccount: context.snapshot.accountKey, allowedTransition, requiredReadback, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  if (!issued.ok || !issued.data) throw new CommandDispatchError(issued.error?.code ?? 'EXECUTION_GRANT_INVALID', issued.error?.message ?? '无法签发精确执行授权。');
  const authorized = await runtime.dispatchCommand(createCommandEnvelope({ workspaceId: draft.workspaceId, runtimeEpoch: draft.runtimeEpoch, command: draft.command, requestId: draft.requestId, input: commandInput, boundIdentity, actor: OWNER, executionGrantId: issued.data.id }), () => {
    const operation = requireCommandResultData(transitionPublicationBrowserOperation(runtime.database, { operationId: context.operation.id, expectedRevision: context.operation.revision, to: 'execution_granted', phase: 'execution_granted', executionGrantId: issued.data!.id }));
    return { data: { publication: context.publication, snapshot: context.snapshot, operation }, entityType: 'publication_browser_operation', entityId: operation.id, beforeRevision: context.operation.revision, afterRevision: operation.revision, readback: operation, sideEffectState: 'authorized' };
  });
  const authorizedData = requireReceiptData(authorized);
  try {
    const browser = await (dependencies.startBrowser ?? startVerifiedBoundBrowser)(runtime.database, context.snapshot.platform as BoundBrowserPlatform, { mode: 'quiet' });
    if (browser.profile.id !== context.snapshot.browserProfileId || browser.binding.profileId !== context.snapshot.browserProfileId) {
      throw new CommandDispatchError('BROWSER_PROFILE_MISMATCH', '浏览器 Profile 与不可变发布快照不一致。');
    }
    if (browser.binding.bindingRevision !== context.snapshot.browserBindingRevision) {
      throw new CommandDispatchError('BROWSER_BINDING_STALE', '浏览器绑定版本与不可变发布快照不一致。');
    }
    if (browser.identity.accountKey !== context.snapshot.accountKey) throw new CommandDispatchError('ACCOUNT_MISMATCH', '浏览器当前账号与不可变发布快照不一致。');
    const lease = setBrowser ? setBrowser(browser.runtime) : runtime.bindBrowser(browser.runtime);
    return runtime.runExternalBrowserWork(lease, async () => {
      try {
        const leased = requireReceiptData(await transitionOperation(runtime, authorizedData.operation, 'browser_leased', 'browser_leased'));
        const executing = requireReceiptData(await transitionOperation(runtime, leased, 'executing', 'executing'));
        const readback = await (dependencies.invokeEditor ?? invokeEditorAdapter)(runtime, context.snapshot, browser.runtime.cdpUrl);
        const pending = requireReceiptData(await transitionOperation(runtime, executing, 'readback_pending', 'readback_pending', { readback, evidence: { editorEvidenceUrl: readback.evidenceUrl } }));
        return completeOperation(runtime, pending, readback.evidenceUrl, context.snapshot);
      } catch (error) {
        const latest = getPublicationBrowserOperation(runtime.database, context.operation.id);
        if (latest && ['execution_granted', 'browser_leased', 'executing', 'readback_pending'].includes(latest.state)) {
          const uncertain = latest.state === 'readback_pending';
          await transitionOperation(runtime, latest, uncertain ? 'unknown' : 'needs_user', uncertain ? 'unknown' : 'needs_user', { errorCode: uncertain ? 'PUBLICATION_READBACK_UNKNOWN' : 'PUBLICATION_BROWSER_NEEDS_USER', errorMessage: error instanceof Error ? error.message : String(error) });
        }
        throw error;
      }
    });
  } catch (error) {
    const latest = getPublicationBrowserOperation(runtime.database, context.operation.id);
    if (latest && ['execution_granted', 'browser_leased', 'executing', 'readback_pending'].includes(latest.state)) {
      const uncertain = latest.state === 'readback_pending';
      await transitionOperation(runtime, latest, uncertain ? 'unknown' : 'needs_user', uncertain ? 'unknown' : 'needs_user', { errorCode: uncertain ? 'PUBLICATION_READBACK_UNKNOWN' : 'PUBLICATION_BROWSER_NEEDS_USER', errorMessage: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
}

async function transitionOperation(runtime: ActiveWorkspaceRuntime, operation: PublicationBrowserOperationV1, to: PublicationBrowserOperationV1['state'], phase: string, extra: { readback?: unknown; evidence?: unknown; errorCode?: string; errorMessage?: string } = {}) {
  return dispatchBusinessCommand(runtime, { command: `publication.browser.${to}`, requestId: `${operation.id}:${to}:r${operation.revision}`, actor: OWNER, input: { operationId: operation.id, expectedRevision: operation.revision, to, phase, ...extra }, boundIdentity: { operationId: operation.id, expectedRevision: operation.revision, to, phase }, entityType: 'publication_browser_operation', execute: (database, normalized) => { const data = requireCommandResultData(transitionPublicationBrowserOperation(database, normalized)); return { data, entityId: data.id, beforeRevision: operation.revision, afterRevision: data.revision, readback: data, sideEffectState: to }; } });
}
function completeOperation(runtime: ActiveWorkspaceRuntime, operation: PublicationBrowserOperationV1, editorEvidenceUrl: string, snapshot: PublicationSnapshotV1) {
  return dispatchBusinessCommand(runtime, { command: 'publication.editor_prepare_complete', requestId: `${operation.id}:complete:r${operation.revision}`, actor: OWNER, input: { operationId: operation.id, expectedRevision: operation.revision, editorEvidenceUrl }, boundIdentity: { operationId: operation.id, snapshotId: snapshot.id, inputHash: snapshot.inputHash, expectedRevision: operation.revision }, entityType: 'publication_snapshot', execute: (database, normalized) => { const data = requireCommandResultData(completePublicationPreparation(database, normalized)); return { data, entityId: data.publication.id, afterRevision: data.operation.revision, readback: data }; } });
}

export function readPublicationEditorReplay(runtime: ActiveWorkspaceRuntime, input: EditorPrepareInput): CommandReceiptV1<PublicationOperationContext> | null {
  if (!input.requestId) return null;
  const prior = runtime.database.prepare(`SELECT runtime_epoch AS runtimeEpoch, envelope_json AS envelopeJson, receipt_json AS receiptJson
    FROM command_receipts WHERE workspace_id=? AND request_id=?`)
    .get(runtime.identity.workspaceId, input.requestId) as { runtimeEpoch: string; envelopeJson: string; receiptJson: string } | undefined;
  if (!prior) return null;
  const envelope = JSON.parse(prior.envelopeJson) as CommandEnvelopeV1<{ publicationId?: unknown; publicationRevision?: unknown }>;
  const authorization = JSON.parse(prior.receiptJson) as CommandReceiptV1<PublicationOperationContext>;
  if (prior.runtimeEpoch !== runtime.identity.runtimeEpoch || authorization.runtimeEpoch !== runtime.identity.runtimeEpoch) {
    throw new CommandDispatchError('WORKSPACE_STALE', '该发布请求不属于当前工作空间运行时。');
  }
  if (envelope.command !== PUBLICATION_EDITOR_PREPARE_COMMAND || authorization.command !== PUBLICATION_EDITOR_PREPARE_COMMAND
    || envelope.input.publicationId !== input.publicationId || envelope.input.publicationRevision !== input.expectedRevision) {
    throw new CommandDispatchError('REQUEST_REPLAY_CONFLICT', '同一 requestId 已绑定不同发布请求。');
  }
  const operationId = authorization.data?.operation.id;
  if (!operationId) throw new CommandDispatchError('INVALID_STATE', '发布授权回执缺少浏览器操作身份。');
  const completed = runtime.database.prepare(`SELECT runtime_epoch AS runtimeEpoch, receipt_json AS receiptJson
    FROM command_receipts WHERE workspace_id=? AND command='publication.editor_prepare_complete' AND request_id LIKE ?
    ORDER BY created_at DESC LIMIT 1`).get(runtime.identity.workspaceId, `${operationId}:complete:r%`) as { runtimeEpoch: string; receiptJson: string } | undefined;
  if (completed) {
    const receipt = JSON.parse(completed.receiptJson) as CommandReceiptV1<PublicationOperationContext>;
    if (completed.runtimeEpoch !== runtime.identity.runtimeEpoch || receipt.runtimeEpoch !== runtime.identity.runtimeEpoch) {
      throw new CommandDispatchError('WORKSPACE_STALE', '发布完成回执不属于当前工作空间运行时。');
    }
    return Object.freeze(receipt);
  }
  const operation = getPublicationBrowserOperation(runtime.database, operationId);
  throw new CommandDispatchError('INVALID_STATE', '该发布请求已执行但尚无可重放的完成回执。', { operationId, state: operation?.state ?? 'missing' });
}
export function readPublicationOperationContext(runtime: ActiveWorkspaceRuntime, publicationId: string): PublicationOperationContext {
  const detail = getPublicationDetail(runtime.database, publicationId);
  if (!detail) throw new CommandDispatchError('NOT_FOUND', '发布记录不存在。');
  const row = runtime.database.prepare('SELECT snapshot_id AS snapshotId, id AS operationId FROM publication_browser_operations WHERE publication_id=?').get(publicationId) as { snapshotId: string; operationId: string } | undefined;
  if (!row) throw new CommandDispatchError('NOT_FOUND', '发布快照操作不存在。');
  const snapshot = getPublicationSnapshot(runtime.database, row.snapshotId);
  const operation = getPublicationBrowserOperation(runtime.database, row.operationId);
  if (!snapshot || !operation) throw new CommandDispatchError('NOT_FOUND', '发布快照操作读回失败。');
  return { publication: detail.publication, snapshot, operation };
}
function requireVerifiedBinding(runtime: ActiveWorkspaceRuntime, platform: BoundBrowserPlatform) {
  const binding = readWorkspaceBrowserBinding(runtime.database);
  if (!binding?.profileId || binding.state !== 'verified') throw new CommandDispatchError('BROWSER_NEEDS_USER', '当前工作空间浏览器绑定尚未验证。');
  if (!binding.expectedAccountSnapshot[platform]) throw new CommandDispatchError('ACCOUNT_MISMATCH', '当前平台没有冻结账号。');
  return binding;
}
function assertSnapshotIdentity(runtime: ActiveWorkspaceRuntime, snapshot: PublicationSnapshotV1, binding: ReturnType<typeof requireVerifiedBinding>): void {
  if (snapshot.workspaceId !== runtime.identity.workspaceId || snapshot.runtimeEpoch !== runtime.identity.runtimeEpoch) throw new CommandDispatchError('WORKSPACE_STALE', '发布快照不属于当前运行时。');
  if (snapshot.browserProfileId !== binding.profileId || snapshot.browserBindingRevision !== binding.bindingRevision) throw new CommandDispatchError('PROFILE_STALE', '发布快照浏览器绑定已变化。');
  const expected = binding.expectedAccountSnapshot[snapshot.platform as BoundBrowserPlatform];
  if (!expected || expected.accountKey !== snapshot.accountKey || expected.accountRevision !== snapshot.accountRevision) throw new CommandDispatchError('ACCOUNT_MISMATCH', '发布快照账号身份已变化。');
}
function parseAssetIds(value: string): string[] { try { const parsed = JSON.parse(value); if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) throw new Error(); return parsed; } catch { throw new CommandDispatchError('VALIDATION_ERROR', '平台版本素材绑定无效。'); } }
async function invokeEditorAdapter(runtime: ActiveWorkspaceRuntime, snapshot: PublicationSnapshotV1, cdpUrl: string): Promise<{ title: string | null; body: string; assetIds: string[]; evidenceUrl: string }> {
  if (snapshot.platform === 'wechat') return prepareWechatArticle(cdpUrl, snapshot.payload.title ?? '', snapshot.payload.body);
  const asset = snapshot.assets[0];
  if (!asset) return prepareXText(cdpUrl, snapshot.payload.body);
  const assetPath = path.join(runtime.identity.rootPath, asset.relativePath);
  return snapshot.payload.format === 'video' ? prepareXVideo(cdpUrl, snapshot.payload.body, assetPath, asset.id) : prepareXImage(cdpUrl, snapshot.payload.body, assetPath, asset.id);
}
export async function dispatchManualWechatReadback(runtime: ActiveWorkspaceRuntime, input: { publicationId: string; expectedRevision: number; articleUrl: string }, browser: BrowserRuntime): Promise<CommandReceiptV1<PublicationRecord>> {
  const detail = getPublicationDetail(runtime.database, input.publicationId);
  if (!detail || detail.publication.platform !== 'wechat' || !detail.payload?.title) throw new CommandDispatchError('NOT_FOUND', '微信公众号发布记录或标题不存在。');
  const readback = await runtime.runExternalBrowserWork(runtime.bindBrowser(browser), () => readBackWechatArticle(browser.cdpUrl, input.articleUrl, detail.payload!.title!));
  return dispatchBusinessCommand(runtime, { command: 'publication.manual_readback', requestId: `${input.publicationId}:manual-readback:${input.expectedRevision}`, actor: OWNER, input: { ...input, readback }, boundIdentity: { publicationId: input.publicationId, expectedRevision: input.expectedRevision, externalUrl: readback.externalUrl, externalId: readback.externalId }, entityType: 'publication', execute: (database, normalized) => { const data = requireCommandResultData(transitionPublication(database, normalized.publicationId, 'published', { expectedRevision: normalized.expectedRevision, externalUrl: normalized.readback.externalUrl, externalId: normalized.readback.externalId, reason: 'manual publication URL readback matched' })); return { data, entityId: data.id, afterRevision: data.revision, readback: data }; } });
}
export function dispatchReconcilePublication(runtime: ActiveWorkspaceRuntime, input: { publicationId: string; expectedRevision: number }) {
  return dispatchBusinessCommand(runtime, { command: 'publication.reconcile_not_published', requestId: `${input.publicationId}:reconcile:${input.expectedRevision}`, actor: OWNER, input, boundIdentity: { publicationId: input.publicationId, expectedRevision: input.expectedRevision }, entityType: 'publication', execute: (database, normalized) => { const data = requireCommandResultData(reconcileAsNotPublished(database, { ...normalized, evidence: { actor: 'ui', decision: 'not_published' } })); return { data, entityId: data.id, afterRevision: data.revision, readback: data }; } });
}
