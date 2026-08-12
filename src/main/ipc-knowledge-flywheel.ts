/**
 * WMB-5210 M1：知识飞轮命令接线（最窄面）。
 * 职责：把唯一正式知识写命令 `knowledge_flywheel.change_set_apply` 注册进 CommandDispatcher
 * （dispatchBusinessCommand → command_receipts + operation_log 审计），并暴露 store 的只读面。
 *
 * 边界（全部 fail-closed）：
 * - workspace/data-root：写必须经 requireBusinessRuntime（活动运行时身份），envelope 由
 *   CommandDispatcher 断言 workspaceId/runtimeEpoch；meta.workspaceId 只取运行时身份，
 *   不接受 renderer 传入的 workspaceId（传入且不匹配 → KNOWLEDGE_FLYWHEEL_WORKSPACE_MISMATCH）。
 *   读走 readWorkspaceDatabase（数据根 DB 句柄即边界）；get-receipt-by-request 用 DB 绑定工作空间。
 * - requestId：必填（幂等键）；缺省/空 → KNOWLEDGE_FLYWHEEL_REQUEST_ID_REQUIRED。
 * - beforeRevision：既有对象更新必须携带（store 强制 REVISION_CONFLICT，事务内零写）。
 * - 调用方边界：IPC 写面固定 owner_ui actor；Pi/外部 Agent 必须走 task grant（dispatcher 门），
 *   本面不提供无授权写路径。红线（final publish / hard delete / external mutation）不涉及，
 *   本面不暴露任何删除/发布命令。
 * - 不建第二套存储：唯一写入口是 store 的 applyKnowledgeChangeSet；本模块只做信封/校验/读投影。
 */
import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { CommandDispatchError } from './command-dispatcher.ts';
import { dispatchBusinessCommand, receiptAsCommandResult } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, type BusinessIpcDependencies } from './ipc-business-context.ts';
import {
  applyKnowledgeChangeSet,
  getChangeSet,
  getHealthIssue,
  getKnowledgeAnnotation,
  getKnowledgeEntity,
  getKnowledgeFreeNote,
  getKnowledgeNote,
  getKnowledgeNoteVersion,
  getKnowledgeRelation,
  getQueryArtifact,
  getQueryArtifactByRequest,
  getUpdateReceipt,
  getUpdateReceiptByRequest,
  getWikiPage,
  getWikiPageVersion,
  KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND,
  KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS,
  KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL,
  listChangeSets,
  listHealthIssues,
  listKnowledgeAnnotations,
  listKnowledgeEntities,
  listKnowledgeEvidenceLinks,
  listKnowledgeFreeNotes,
  listKnowledgeNoteVersions,
  listKnowledgeNotes,
  listKnowledgeRelations,
  listQueryArtifacts,
  listRelationRegistry,
  listUpdateReceipts,
  listWikiPages,
  listWikiPageVersions,
  type CreatorNature,
  type KnowledgeChangeSetInput,
  type KnowledgeChangeSetMeta,
  type ResolutionMode,
  type TriggerSource
} from './knowledge-flywheel.ts';
import {
  getKnowledgeUsagePackage,
  getKnowledgeUsagePackageByRequest,
  getKnowledgeUsageRecord,
  listKnowledgeUsagePackages,
  listKnowledgeUsageRecords
} from './knowledge-usage.ts';
import { getQueryWritebackSummary } from './query-writeback.ts';

const TRIGGER_SOURCES: readonly TriggerSource[] = [
  'ingest', 'query', 'lint', 'creation', 'review', 'user', 'migration'
];
const RESOLUTION_MODES: readonly ResolutionMode[] = [
  'replaced_current', 'time_bounded', 'scope_split', 'kept_disputed', 'insufficient', 'manual_correction', 'none'
];
const CREATOR_NATURES: readonly CreatorNature[] = [
  'user', 'pi', 'background_agent', 'system', 'migration'
];

const SEGMENT_KEYS: readonly (keyof KnowledgeChangeSetInput)[] = [
  'freeNotes', 'freeNoteTransitions', 'entities', 'notes', 'relations', 'evidenceLinks',
  'annotations', 'wikiPages', 'healthIssues', 'receipts', 'queryArtifacts', 'extensionRelations'
];

export type ChangeSetApplyIpcInput = Readonly<{
  requestId: string;
  reason: string;
  triggerSource: TriggerSource;
  resolutionMode: ResolutionMode;
  createdBy: CreatorNature;
  /** 可选：传入时必须与活动运行时工作空间一致（防跨 root 混淆）。 */
  workspaceId?: string;
  input: KnowledgeChangeSetInput;
}>;

export type NormalizedChangeSetApply = Readonly<{
  meta: KnowledgeChangeSetMeta;
  segments: KnowledgeChangeSetInput;
}>;

/**
 * 写面输入校验（fail-closed）。workspaceId 只接受运行时身份；
 * 缺 requestId / reason / 空段 / 非法枚举 / workspace 不匹配一律拒绝，不进入 dispatcher。
 */
export function normalizeChangeSetApplyInput(input: unknown, workspaceId: string): NormalizedChangeSetApply {
  const value = (input ?? {}) as Record<string, unknown>;
  const requestId = typeof value.requestId === 'string' && value.requestId.trim() ? value.requestId.trim() : null;
  if (!requestId) throw new CommandDispatchError('KNOWLEDGE_FLYWHEEL_REQUEST_ID_REQUIRED', '知识 ChangeSet 必须携带 requestId（工作空间内幂等键）。');
  const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null;
  if (!reason) throw new CommandDispatchError('KNOWLEDGE_FLYWHEEL_REASON_REQUIRED', '知识 ChangeSet 必须携带人类可读的总体原因。');
  const triggerSource = value.triggerSource;
  if (!TRIGGER_SOURCES.includes(triggerSource as TriggerSource)) {
    throw new CommandDispatchError('KNOWLEDGE_FLYWHEEL_TRIGGER_SOURCE_INVALID', '非法 triggerSource。', { triggerSource });
  }
  const resolutionMode = value.resolutionMode;
  if (!RESOLUTION_MODES.includes(resolutionMode as ResolutionMode)) {
    throw new CommandDispatchError('KNOWLEDGE_FLYWHEEL_RESOLUTION_MODE_INVALID', '非法 resolutionMode。', { resolutionMode });
  }
  const createdBy = value.createdBy;
  if (!CREATOR_NATURES.includes(createdBy as CreatorNature)) {
    throw new CommandDispatchError('KNOWLEDGE_FLYWHEEL_CREATED_BY_INVALID', '非法 createdBy。', { createdBy });
  }
  if (value.workspaceId !== undefined && value.workspaceId !== null && String(value.workspaceId) !== workspaceId) {
    throw new CommandDispatchError('KNOWLEDGE_FLYWHEEL_WORKSPACE_MISMATCH', 'ChangeSet 工作空间与当前 data-root 不一致。', { boundWorkspaceId: workspaceId, changeSetWorkspaceId: value.workspaceId });
  }
  const segments = (value.input ?? {}) as KnowledgeChangeSetInput;
  if (!SEGMENT_KEYS.some((key) => Array.isArray(segments[key]) && (segments[key] as unknown[]).length > 0)) {
    throw new CommandDispatchError('KNOWLEDGE_FLYWHEEL_INPUT_EMPTY', '知识 ChangeSet 不能为空：至少一个对象段非空。');
  }
  return Object.freeze({
    meta: Object.freeze({
      workspaceId,
      requestId,
      reason,
      triggerSource: triggerSource as TriggerSource,
      resolutionMode: resolutionMode as ResolutionMode,
      createdBy: createdBy as CreatorNature
    }),
    segments
  });
}

/** DB 绑定工作空间（app_meta）；未激活的精简 fixture 返回 null。 */
function boundWorkspaceId(database: DatabaseSync): string | null {
  try {
    const row = database.prepare("SELECT value AS workspaceId FROM app_meta WHERE key='workspace_id'").get() as { workspaceId?: string } | undefined;
    return row?.workspaceId ?? null;
  } catch {
    return null;
  }
}

export function registerKnowledgeFlywheelIpc(dependencies: BusinessIpcDependencies): void {
  // ---- 唯一正式知识写命令 ----
  ipcMain.handle(KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL, async (_event, input: unknown) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const { meta, segments } = normalizeChangeSetApplyInput(input, runtime.identity.workspaceId);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND,
      requestId: meta.requestId,
      actor: ownerUiActor,
      input: segments,
      boundIdentity: { entityType: 'knowledge_change_set', requestId: meta.requestId },
      entityType: 'knowledge_change_set',
      execute: (database, value) => {
        // dispatcher 已 BEGIN IMMEDIATE 包裹整个 execute → transaction=false（契约 §14.3 全成或零写）。
        const result = applyKnowledgeChangeSet(database, meta, value as KnowledgeChangeSetInput, false);
        return { data: result, entityId: result.changeSetId, readback: result };
      }
    });
    if (receipt.ok) broadcastDataChanged({
      // WMB-5213：知识 scopes 广播（画布变化/健康模式、主题/Wiki、回执视图均按此刷新，替代轮询主路径）。
      scopes: ['knowledge', 'topics', 'canvas', 'health', 'receipt', 'library', 'today'],
      reason: 'knowledge_flywheel.change_set_apply'
    });
    return receiptAsCommandResult(receipt);
  });

  // ---- 只读面（有界；DB 句柄即 workspace/data-root 边界）----
  const read = <T>(noRoot: T, run: (database: DatabaseSync) => T): Promise<T> =>
    readWorkspaceDatabase(dependencies, () => noRoot, run);

  ipcMain.handle('knowledge-flywheel:list-entities', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listKnowledgeEntities(database, input)));
  ipcMain.handle('knowledge-flywheel:get-entity', (_event, input: { id: string }) => read(null, database => getKnowledgeEntity(database, input.id)));
  ipcMain.handle('knowledge-flywheel:list-notes', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listKnowledgeNotes(database, input)));
  ipcMain.handle('knowledge-flywheel:get-note', (_event, input: { id: string }) => read(null, database => getKnowledgeNote(database, input.id)));
  ipcMain.handle('knowledge-flywheel:get-note-version', (_event, input: { id?: string }) => read(null, database => input.id ? getKnowledgeNoteVersion(database, input.id) : null));
  ipcMain.handle('knowledge-flywheel:list-note-versions', (_event, input: { noteId?: string; limit?: number; offset?: number } = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => input.noteId ? listKnowledgeNoteVersions(database, input.noteId, input) : { items: [], total: 0, limit: 50, offset: 0, hasMore: false }));
  ipcMain.handle('knowledge-flywheel:list-pages', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listWikiPages(database, input)));
  ipcMain.handle('knowledge-flywheel:get-page', (_event, input: { id: string }) => read(null, database => getWikiPage(database, input.id)));
  ipcMain.handle('knowledge-flywheel:get-page-version', (_event, input: { id: string }) => read(null, database => getWikiPageVersion(database, input.id)));
  ipcMain.handle('knowledge-flywheel:list-page-versions', (_event, input: { pageId?: string; limit?: number; offset?: number } = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => input.pageId ? listWikiPageVersions(database, input.pageId, input) : { items: [], total: 0, limit: 50, offset: 0, hasMore: false }));
  ipcMain.handle('knowledge-flywheel:list-relations', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listKnowledgeRelations(database, input)));
  ipcMain.handle('knowledge-flywheel:get-relation', (_event, input: { id: string }) => read(null, database => getKnowledgeRelation(database, input.id)));
  ipcMain.handle('knowledge-flywheel:list-evidence', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listKnowledgeEvidenceLinks(database, input)));
  ipcMain.handle('knowledge-flywheel:list-annotations', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listKnowledgeAnnotations(database, input)));
  ipcMain.handle('knowledge-flywheel:get-annotation', (_event, input: { id: string }) => read(null, database => getKnowledgeAnnotation(database, input.id)));
  ipcMain.handle('knowledge-flywheel:list-free-notes', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listKnowledgeFreeNotes(database, input)));
  ipcMain.handle('knowledge-flywheel:get-free-note', (_event, input: { id: string }) => read(null, database => getKnowledgeFreeNote(database, input.id)));
  ipcMain.handle('knowledge-flywheel:get-change-set', (_event, input: { id: string }) => read(null, database => getChangeSet(database, input.id)));
  ipcMain.handle('knowledge-flywheel:list-change-sets', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listChangeSets(database, input)));
  ipcMain.handle('knowledge-flywheel:get-receipt', (_event, input: { id: string }) => read(null, database => getUpdateReceipt(database, input.id)));
  ipcMain.handle('knowledge-flywheel:get-receipt-by-request', (_event, input: { requestId: string }) => read(null, database => getUpdateReceiptByRequest(database, boundWorkspaceId(database) ?? '', input.requestId)));
  ipcMain.handle('knowledge-flywheel:list-receipts', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listUpdateReceipts(database, input)));
  ipcMain.handle('knowledge-flywheel:get-query-artifact', (_event, input: { id: string }) => read(null, database => getQueryArtifact(database, input.id)));
  ipcMain.handle('knowledge-flywheel:get-query-artifact-by-request', (_event, input: { requestId: string }) => read(null, database => getQueryArtifactByRequest(database, input.requestId)));
  // WMB-5214：Query 写回摘要（Artifact + 风险标记 + Receipt；面板单次调用）
  ipcMain.handle('knowledge-flywheel:get-query-writeback-summary', (_event, input: { requestId: string }) => read(null, database => getQueryWritebackSummary(database, input.requestId)));
  ipcMain.handle('knowledge-flywheel:list-query-artifacts', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listQueryArtifacts(database, input)));
  ipcMain.handle('knowledge-flywheel:get-health-issue', (_event, input: { id: string }) => read(null, database => getHealthIssue(database, input.id)));
  ipcMain.handle('knowledge-flywheel:list-health-issues', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listHealthIssues(database, input)));
  ipcMain.handle('knowledge-flywheel:list-relation-registry', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listRelationRegistry(database, input)));
  // WMB-5215 M6 usage 血缘只读面（有界；DB 句柄即 workspace/data-root 边界）
  ipcMain.handle('knowledge-flywheel:get-usage-package', (_event, input: { id: string }) => read(null, database => getKnowledgeUsagePackage(database, input.id)));
  ipcMain.handle('knowledge-flywheel:get-usage-package-by-request', (_event, input: { requestId: string }) => read(null, database => getKnowledgeUsagePackageByRequest(database, boundWorkspaceId(database) ?? '', input.requestId)));
  ipcMain.handle('knowledge-flywheel:list-usage-packages', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listKnowledgeUsagePackages(database, input)));
  ipcMain.handle('knowledge-flywheel:get-usage-record', (_event, input: { id: string }) => read(null, database => getKnowledgeUsageRecord(database, input.id)));
  ipcMain.handle('knowledge-flywheel:list-usage-records', (_event, input = {}) => read({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }, database => listKnowledgeUsageRecords(database, input)));
}

/** 只读通道全集（与 store 常量对齐；防注册遗漏的断言用）。 */
export const KNOWLEDGE_FLYWHEEL_IPC_CHANNELS: readonly string[] = Object.freeze([
  KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL,
  ...KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS
]);
