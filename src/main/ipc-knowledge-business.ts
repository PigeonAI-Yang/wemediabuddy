import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { dispatchBusinessCommand, receiptAsCommandResult, requireReceiptData } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  getKnowledgeContext, getKnowledgeTopicDossier,
  listKnowledgeTopics, listRediscovery
} from './knowledge.ts';
import { decideTopicMaintenanceProposal, listTopicMaintenanceProposals } from './topic-maintenance.ts';
import {
  getSourceKnowledgeDetail, getTopicWikiDetail, resolveKnowledgeDeepLink
} from './knowledge-topic-library.ts';
import {
  KNOWLEDGE_DEEP_LINK_IPC_CHANNEL, KNOWLEDGE_SOURCE_KNOWLEDGE_DETAIL_IPC_CHANNEL, KNOWLEDGE_TOPIC_WIKI_DETAIL_IPC_CHANNEL
} from '../shared/knowledge-topic-library.ts';
// WMB-5243：全局 Wiki 知识网络只读投影（无 canvasId；稳定节点 ID；正式对象只读投影）。
import {
  KNOWLEDGE_NETWORK_NODE_DETAIL_IPC_CHANNEL, KNOWLEDGE_NETWORK_PROJECTION_IPC_CHANNEL,
  type KnowledgeNetworkProjection, type KnowledgeNetworkProjectionInput
} from '../shared/knowledge-network.ts';
import {
  addKnowledgeCanvasNode, createContentProjectFromBrief, createCreativeBrief, createKnowledgeCanvas, createKnowledgeRelation,
  decideKnowledgeSuggestion, getCanvasNodeDetail, getContentProjectContextPackages, getCreativeBriefForContext, getCreativeBriefForPackage,
  getCreativeBriefLineage, getKnowledgeCanvas, getKnowledgeCanvasProjection, getKnowledgeContextPackage, getKnowledgeNetworkNodeDetail,
  getKnowledgeNetworkProjection, listKnowledgeCanvases,
  listKnowledgeContextPackages, moveKnowledgeCanvasNodes, previewKnowledgeContextPackage, removeKnowledgeCanvasNode,
  updateCreativeBrief, updateKnowledgeCanvas, updateKnowledgeRelation, validateKnowledgeSelectionManifest
} from './knowledge-canvas.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, runtimeForNullableMutation, type BusinessIpcDependencies } from './ipc-business-context.ts';
import { kickTopicReproposals, resumeTopicReproposal } from './topic-maintenance-reproposal.ts';
import { submitWorkspaceOrchestratorIntent } from './workspace-orchestrator-runtime.ts';
import { recordCreativeBriefUsage } from './knowledge-usage-integration.ts';
import { wakePersistentKnowledgeJobs } from './knowledge-compile-trigger.ts';
import {
  emptyMaintenanceStatus, getMaintenanceStatus, pauseMaintenanceRun, resumeMaintenanceRun, startMaintenanceRun
} from './knowledge-maintenance.ts';
import {
  KNOWLEDGE_MAINTENANCE_IPC_CHANNELS, type KnowledgeMaintenanceStartInput
} from '../shared/knowledge-maintenance.ts';

export function registerKnowledgeBusinessIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle('knowledge:list-topics', (_event, input = {}) => readWorkspaceDatabase(dependencies,
    () => ({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }), database => listKnowledgeTopics(database, input)));
  ipcMain.handle('knowledge:get-context', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeContext(database, input)));
  ipcMain.handle('knowledge:get-topic-dossier', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeTopicDossier(database, input)));
  // WMB-5212：Topic Wiki 详情 / Source 知识详情 / 准确深链（只读投影；复用 v56/v57 与既有 dossier，不造表）。
  ipcMain.handle(KNOWLEDGE_TOPIC_WIKI_DETAIL_IPC_CHANNEL, (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getTopicWikiDetail(database, input)));
  ipcMain.handle(KNOWLEDGE_SOURCE_KNOWLEDGE_DETAIL_IPC_CHANNEL, (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getSourceKnowledgeDetail(database, input)));
  ipcMain.handle(KNOWLEDGE_DEEP_LINK_IPC_CHANNEL, (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => resolveKnowledgeDeepLink(database, input)));
  ipcMain.handle('knowledge:rediscovery', () => readWorkspaceDatabase(dependencies,
    () => ({ unused: [], watching: [], pending: [] }), database => listRediscovery(database)));
  ipcMain.handle('knowledge:topic-maintenance-proposals', (_event, input = {}) => readWorkspaceDatabase(dependencies,
    () => ({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }), database => listTopicMaintenanceProposals(database, input)));
  const decideProposal = (decision: 'approve' | 'reject') => ipcMain.handle(`knowledge:topic-maintenance-${decision}`, async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: `knowledge.topic_maintenance_${decision}`, requestId: input.requestId ?? freshRequestId(), actor: ownerUiActor,
      input: { id: input.id, expectedRevision: input.expectedRevision, decision }, boundIdentity: { entityType: 'topic_maintenance_proposal', entityId: input.id }, entityType: 'topic_maintenance_proposal',
      execute: (database, value) => { const data = decideTopicMaintenanceProposal(database, value); return { data, entityId: data.id, beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data }; } });
    if (receipt.ok) {
      wakePersistentKnowledgeJobs();
      broadcastDataChanged({ scopes: ['library', 'today'], reason: `topic_maintenance.${decision}` });
    }
    if (receipt.ok && decision === 'approve' && (receipt.data as { status?: string } | null)?.status === 'stale') {
      await kickTopicReproposals(runtime, (input) => submitWorkspaceOrchestratorIntent(runtime, input));
    }
    return receiptAsCommandResult(receipt);
  });
  decideProposal('approve'); decideProposal('reject');
  ipcMain.handle('knowledge:topic-maintenance-reproposal-resume', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.topic_maintenance_reproposal_retry', requestId: input.requestId ?? freshRequestId(), actor: ownerUiActor,
      input: { proposalId: input.id }, boundIdentity: { entityType: 'topic_maintenance_reproposal_job', entityId: input.id }, entityType: 'topic_maintenance_reproposal_job',
      execute: (database, value) => { const data = resumeTopicReproposal(database, value.proposalId, new Date().toISOString()); return { data, entityId: data.proposalId, readback: data }; } });
    if (receipt.ok) { broadcastDataChanged({ scopes: ['library', 'today', 'agent'], reason: 'topic_maintenance.reproposal_resume' }); await kickTopicReproposals(runtime, (input) => submitWorkspaceOrchestratorIntent(runtime, input)); }
    return receipt;
  });
  ipcMain.handle('knowledge-canvas:list', () => readWorkspaceDatabase(dependencies, () => [], database => listKnowledgeCanvases(database)));
  ipcMain.handle('knowledge-canvas:get', (_event, id: string) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeCanvas(database, id)));
  // WMB-5213：三模式投影 / 节点详情深链 / selected-only 清单（只读；复用 v56 读模型，不造表）。
  ipcMain.handle('knowledge-canvas:projection', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeCanvasProjection(database, input)));
  ipcMain.handle('knowledge-canvas:detail', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getCanvasNodeDetail(database, input)));
  // WMB-5243：全局 Wiki 知识网络只读投影（无 canvasId；分页有界；正式对象；空库返回有效空投影）。
  ipcMain.handle(KNOWLEDGE_NETWORK_PROJECTION_IPC_CHANNEL, (_event, input) => readWorkspaceDatabase(dependencies,
    (): KnowledgeNetworkProjection => ({
      networkId: 'global', nodes: [], relations: [], filters: { nodeTypes: [], relationTypes: [] },
      totalNodes: 0, totalRelations: 0, limit: 500, offset: 0, hasMore: false, updatedAt: ''
    }),
    database => getKnowledgeNetworkProjection(database, input as KnowledgeNetworkProjectionInput | undefined)));
  ipcMain.handle(KNOWLEDGE_NETWORK_NODE_DETAIL_IPC_CHANNEL, (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeNetworkNodeDetail(database, input)));
  ipcMain.handle('knowledge-context:selection-manifest', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => validateKnowledgeSelectionManifest(database, input)));
  ipcMain.handle('knowledge-context:preview-package', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => previewKnowledgeContextPackage(database, input)));
  ipcMain.handle('knowledge-context:list-packages', (_event, input = {}) => readWorkspaceDatabase(dependencies,
    () => ({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }), database => listKnowledgeContextPackages(database, input)));
  ipcMain.handle('knowledge-context:get-package', (_event, id: string) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeContextPackage(database, id)));
  ipcMain.handle('knowledge-context:project-packages', (_event, projectId: string) => readWorkspaceDatabase(dependencies, () => [], database => getContentProjectContextPackages(database, projectId)));
  ipcMain.handle('knowledge-context:get-brief', (_event, packageId: string) => readWorkspaceDatabase(dependencies, () => null, database => getCreativeBriefForPackage(database, packageId)));
  ipcMain.handle('knowledge-context:get-brief-for-context', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getCreativeBriefForContext(database, input)));
  ipcMain.handle('knowledge-context:get-brief-lineage', (_event, briefId: string) => readWorkspaceDatabase(dependencies, () => null, database => getCreativeBriefLineage(database, briefId)));

  const canvasMutation = (channel: string, entityType: string, reason: string, execute: (database: any, input: any) => any) => {
    ipcMain.handle(channel, async (_event, input) => {
      const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
      const receipt = await dispatchBusinessCommand(runtime, { command: channel, requestId: freshRequestId(), actor: ownerUiActor,
        input, boundIdentity: { entityType, entityId: input?.id ?? input?.canvasId }, entityType,
        execute: (database, value) => { const data = execute(database, value); return { data, entityId: data?.id ?? value?.id ?? value?.canvasId,
          beforeRevision: value?.expectedRevision, afterRevision: data?.revision, readback: data }; } });
      // WMB-5213：画布布局写广播 canvas scope（订阅替代主轮询；画布节点只是引用与布局，非知识真源）。
      if (receipt.ok) broadcastDataChanged({ scopes: ['canvas'], reason });
      return requireReceiptData(receipt);
    });
  };
  canvasMutation('knowledge-canvas:create', 'knowledge_canvas', 'canvas.create', createKnowledgeCanvas);
  canvasMutation('knowledge-canvas:update', 'knowledge_canvas', 'canvas.update', updateKnowledgeCanvas);
  canvasMutation('knowledge-canvas:add-node', 'knowledge_canvas_node', 'canvas.add_node', addKnowledgeCanvasNode);
  canvasMutation('knowledge-canvas:move-nodes', 'knowledge_canvas', 'canvas.move_nodes', (database, input) => moveKnowledgeCanvasNodes(database, input, false));
  canvasMutation('knowledge-canvas:remove-node', 'knowledge_canvas_node', 'canvas.remove_node', removeKnowledgeCanvasNode);
  canvasMutation('knowledge-canvas:create-relation', 'knowledge_relation', 'canvas.relation.create', createKnowledgeRelation);
  canvasMutation('knowledge-canvas:update-relation', 'knowledge_relation', 'canvas.relation.update', updateKnowledgeRelation);

  ipcMain.handle('knowledge-canvas:decide-suggestion', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.suggestion_decide', requestId: input.requestId,
      actor: ownerUiActor, input: { id: input.id, expectedRevision: input.expectedRevision, decision: input.decision },
      boundIdentity: { entityType: 'knowledge_suggestion', entityId: input.id }, entityType: 'knowledge_suggestion',
      execute: (database, value) => { const data = decideKnowledgeSuggestion(database, value); return { data, entityId: data.id,
        beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data }; } });
    if (receipt.ok) broadcastDataChanged({ scopes: ['canvas'], reason: 'canvas.suggestion_decide' });
    return receiptAsCommandResult(receipt);
  });
  ipcMain.handle('knowledge-context:create-brief', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const { requestId, ...commandInput } = input;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.creative_brief_create', requestId, actor: ownerUiActor,
      input: commandInput, boundIdentity: { entityType: 'creative_brief' }, entityType: 'creative_brief',
      execute: (database, value) => { const data = createCreativeBrief(database, value) as { id: string; revision: number; contextNodeIds?: string[] };
        // WMB-5215：简报与固定知识血缘同一事务（usage 失败整体回滚）。
        recordCreativeBriefUsage(database, { briefId: data.id, contextNodeIds: data.contextNodeIds ?? [], reason: 'creative_brief_create' });
        return { data, entityId: data.id, afterRevision: data.revision, readback: data }; } });
    return receiptAsCommandResult(receipt);
  });
  ipcMain.handle('knowledge-context:update-brief', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const { requestId, ...commandInput } = input;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.creative_brief_update', requestId, actor: ownerUiActor,
      input: commandInput, boundIdentity: { entityType: 'creative_brief', entityId: input.id }, entityType: 'creative_brief',
      execute: (database, value) => { const data = updateCreativeBrief(database, value); return { data, entityId: data.id,
        beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data }; } });
    return receiptAsCommandResult(receipt);
  });
  ipcMain.handle('knowledge-context:create-project-from-brief', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.creative_brief_create_project', requestId: input.requestId,
      actor: ownerUiActor, input: { briefId: input.briefId, expectedRevision: input.expectedRevision },
      boundIdentity: { entityType: 'creative_brief', entityId: input.briefId }, entityType: 'content_project',
      execute: (database, value) => { const data = createContentProjectFromBrief(database, value); return { data,
        entityId: data.project?.id, beforeRevision: value.expectedRevision, afterRevision: data.brief?.revision, readback: data }; } });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'content.create_from_brief' });
    return receiptAsCommandResult(receipt);
  });
}

// ============================================================
// WMB-5236：全库维护 run IPC（start/status/pause/resume）
// 写面（start/pause/resume）经 dispatcher 授权；status 走只读投影。
// ============================================================

function boundWorkspaceIdOf(database: DatabaseSync): string | null {
  try {
    const row = database.prepare("SELECT value AS workspaceId FROM app_meta WHERE key='workspace_id'").get() as { workspaceId?: string } | undefined;
    return row?.workspaceId ?? null;
  } catch {
    return null;
  }
}

/** 注册维护 run 的 start/status/pause/resume 通道（复用 BusinessIpcDependencies 与 dispatcher）。 */
export function registerKnowledgeMaintenanceIpc(dependencies: BusinessIpcDependencies): void {
  const maintenanceMutation = <T>(command: string, execute: (database: DatabaseSync, workspaceId: string, input: unknown) => T) =>
    async (_event: IpcMainInvokeEvent, input: unknown): Promise<T> => {
      const runtime = await requireBusinessRuntime(dependencies);
      const receipt = await dispatchBusinessCommand(runtime, {
        command,
        requestId: `knowledge-maintenance:${command}:${Date.now()}`,
        actor: ownerUiActor,
        input: { workspaceId: runtime.identity.workspaceId, input },
        boundIdentity: { entityType: 'knowledge_maintenance_run' },
        entityType: 'knowledge_maintenance_run',
        execute: (database: DatabaseSync, value) => ({ data: execute(database, runtime.identity.workspaceId, value.input) })
      });
      return requireReceiptData(receipt);
    };

  ipcMain.handle(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.start, maintenanceMutation('start', (database, workspaceId, input) =>
    startMaintenanceRun(database, { workspaceId, ...((input ?? {}) as KnowledgeMaintenanceStartInput) })));

  ipcMain.handle(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.pause, maintenanceMutation('pause', (database, workspaceId) => pauseMaintenanceRun(database, workspaceId)));

  ipcMain.handle(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.resume, maintenanceMutation('resume', (database, workspaceId) => resumeMaintenanceRun(database, workspaceId)));

  ipcMain.handle(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.status, () => readWorkspaceDatabase(dependencies,
    () => emptyMaintenanceStatus(), (database) => {
      const workspaceId = boundWorkspaceIdOf(database);
      return workspaceId ? getMaintenanceStatus(database, workspaceId) : emptyMaintenanceStatus();
    }));
}
