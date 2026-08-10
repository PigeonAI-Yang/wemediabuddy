import { ipcMain } from 'electron';
import { dispatchBusinessCommand, receiptAsCommandResult, requireReceiptData } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  createKnowledgeDomain, getKnowledgeContext, getKnowledgeDomain, getKnowledgeTopicDossier, listKnowledgeDomains,
  listKnowledgeTopics, listRediscovery, updateKnowledgeDomain
} from './knowledge.ts';
import { decideTopicMaintenanceProposal, listTopicMaintenanceProposals } from './topic-maintenance.ts';
import {
  addKnowledgeCanvasNode, createContentProjectFromBrief, createCreativeBrief, createKnowledgeCanvas, createKnowledgeRelation,
  decideKnowledgeSuggestion, getContentProjectContextPackages, getCreativeBriefForContext, getCreativeBriefForPackage,
  getCreativeBriefLineage, getKnowledgeCanvas, getKnowledgeContextPackage, listKnowledgeCanvases, listKnowledgeContextPackages,
  moveKnowledgeCanvasNodes, previewKnowledgeContextPackage, removeKnowledgeCanvasNode, updateCreativeBrief, updateKnowledgeCanvas,
  updateKnowledgeRelation
} from './knowledge-canvas.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, runtimeForNullableMutation, type BusinessIpcDependencies } from './ipc-business-context.ts';
import { ensureJobsSpawner } from './ipc-jobs.ts';
import { kickTopicReproposals, resumeTopicReproposal } from './topic-maintenance-reproposal.ts';

export function registerKnowledgeBusinessIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle('knowledge:list-topics', (_event, input = {}) => readWorkspaceDatabase(dependencies,
    () => ({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }), database => listKnowledgeTopics(database, input)));
  ipcMain.handle('knowledge-domains:list', (_event, input = {}) => readWorkspaceDatabase(dependencies,
    () => ({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }), database => listKnowledgeDomains(database, input)));
  ipcMain.handle('knowledge-domains:get', (_event, id: string, input = {}) => readWorkspaceDatabase(dependencies,
    () => null, database => getKnowledgeDomain(database, id, input)));
  ipcMain.handle('knowledge:get-context', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeContext(database, input)));
  ipcMain.handle('knowledge:get-topic-dossier', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeTopicDossier(database, input)));
  ipcMain.handle('knowledge:rediscovery', () => readWorkspaceDatabase(dependencies,
    () => ({ unused: [], watching: [], pending: [] }), database => listRediscovery(database)));
  ipcMain.handle('knowledge:topic-maintenance-proposals', (_event, input = {}) => readWorkspaceDatabase(dependencies,
    () => ({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }), database => listTopicMaintenanceProposals(database, input)));
  const decideProposal = (decision: 'approve' | 'reject') => ipcMain.handle(`knowledge:topic-maintenance-${decision}`, async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: `knowledge.topic_maintenance_${decision}`, requestId: input.requestId ?? freshRequestId(), actor: ownerUiActor,
      input: { id: input.id, expectedRevision: input.expectedRevision, decision }, boundIdentity: { entityType: 'topic_maintenance_proposal', entityId: input.id }, entityType: 'topic_maintenance_proposal',
      execute: (database, value) => { const data = decideTopicMaintenanceProposal(database, value); return { data, entityId: data.id, beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data }; } });
    if (receipt.ok) broadcastDataChanged({ scopes: ['library', 'today'], reason: `topic_maintenance.${decision}` });
    if (receipt.ok && decision === 'approve' && (receipt.data as { status?: string } | null)?.status === 'stale') {
      await kickTopicReproposals(runtime, ensureJobsSpawner({ getActiveRuntime: dependencies.getActiveRuntime }));
    }
    return receiptAsCommandResult(receipt);
  });
  decideProposal('approve'); decideProposal('reject');
  ipcMain.handle('knowledge:topic-maintenance-reproposal-resume', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.topic_maintenance_reproposal_retry', requestId: input.requestId ?? freshRequestId(), actor: ownerUiActor,
      input: { proposalId: input.id }, boundIdentity: { entityType: 'topic_maintenance_reproposal_job', entityId: input.id }, entityType: 'topic_maintenance_reproposal_job',
      execute: (database, value) => { const data = resumeTopicReproposal(database, value.proposalId, new Date().toISOString()); return { data, entityId: data.proposalId, readback: data }; } });
    if (receipt.ok) { broadcastDataChanged({ scopes: ['library', 'today', 'agent'], reason: 'topic_maintenance.reproposal_resume' }); await kickTopicReproposals(runtime, ensureJobsSpawner({ getActiveRuntime: dependencies.getActiveRuntime })); }
    return receipt;
  });
  ipcMain.handle('knowledge-canvas:list', () => readWorkspaceDatabase(dependencies, () => [], database => listKnowledgeCanvases(database)));
  ipcMain.handle('knowledge-canvas:get', (_event, id: string) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeCanvas(database, id)));
  ipcMain.handle('knowledge-context:preview-package', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => previewKnowledgeContextPackage(database, input)));
  ipcMain.handle('knowledge-context:list-packages', (_event, input = {}) => readWorkspaceDatabase(dependencies,
    () => ({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }), database => listKnowledgeContextPackages(database, input)));
  ipcMain.handle('knowledge-context:get-package', (_event, id: string) => readWorkspaceDatabase(dependencies, () => null, database => getKnowledgeContextPackage(database, id)));
  ipcMain.handle('knowledge-context:project-packages', (_event, projectId: string) => readWorkspaceDatabase(dependencies, () => [], database => getContentProjectContextPackages(database, projectId)));
  ipcMain.handle('knowledge-context:get-brief', (_event, packageId: string) => readWorkspaceDatabase(dependencies, () => null, database => getCreativeBriefForPackage(database, packageId)));
  ipcMain.handle('knowledge-context:get-brief-for-context', (_event, input) => readWorkspaceDatabase(dependencies, () => null, database => getCreativeBriefForContext(database, input)));
  ipcMain.handle('knowledge-context:get-brief-lineage', (_event, briefId: string) => readWorkspaceDatabase(dependencies, () => null, database => getCreativeBriefLineage(database, briefId)));

  ipcMain.handle('knowledge-domains:create', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.domain_create', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'knowledge_domain' }, entityType: 'knowledge_domain',
      execute: (database, value) => { const data = createKnowledgeDomain(database, value, false); return { data, entityId: data.id, afterRevision: data.revision, readback: data }; } });
    return requireReceiptData(receipt);
  });
  ipcMain.handle('knowledge-domains:update', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.domain_update', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'knowledge_domain', entityId: input.id }, entityType: 'knowledge_domain',
      execute: (database, value) => { const data = updateKnowledgeDomain(database, value, false); return { data, entityId: data.id, beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data }; } });
    return requireReceiptData(receipt);
  });

  const canvasMutation = (channel: string, entityType: string, execute: (database: any, input: any) => any) => {
    ipcMain.handle(channel, async (_event, input) => {
      const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
      const receipt = await dispatchBusinessCommand(runtime, { command: channel, requestId: freshRequestId(), actor: ownerUiActor,
        input, boundIdentity: { entityType, entityId: input?.id ?? input?.canvasId }, entityType,
        execute: (database, value) => { const data = execute(database, value); return { data, entityId: data?.id ?? value?.id ?? value?.canvasId,
          beforeRevision: value?.expectedRevision, afterRevision: data?.revision, readback: data }; } });
      return requireReceiptData(receipt);
    });
  };
  canvasMutation('knowledge-canvas:create', 'knowledge_canvas', createKnowledgeCanvas);
  canvasMutation('knowledge-canvas:update', 'knowledge_canvas', updateKnowledgeCanvas);
  canvasMutation('knowledge-canvas:add-node', 'knowledge_canvas_node', addKnowledgeCanvasNode);
  canvasMutation('knowledge-canvas:move-nodes', 'knowledge_canvas', (database, input) => moveKnowledgeCanvasNodes(database, input, false));
  canvasMutation('knowledge-canvas:remove-node', 'knowledge_canvas_node', removeKnowledgeCanvasNode);
  canvasMutation('knowledge-canvas:create-relation', 'knowledge_relation', createKnowledgeRelation);
  canvasMutation('knowledge-canvas:update-relation', 'knowledge_relation', updateKnowledgeRelation);

  ipcMain.handle('knowledge-canvas:decide-suggestion', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.suggestion_decide', requestId: input.requestId,
      actor: ownerUiActor, input: { id: input.id, expectedRevision: input.expectedRevision, decision: input.decision },
      boundIdentity: { entityType: 'knowledge_suggestion', entityId: input.id }, entityType: 'knowledge_suggestion',
      execute: (database, value) => { const data = decideKnowledgeSuggestion(database, value); return { data, entityId: data.id,
        beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data }; } });
    return receiptAsCommandResult(receipt);
  });
  ipcMain.handle('knowledge-context:create-brief', async (_event, input) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const { requestId, ...commandInput } = input;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'knowledge.creative_brief_create', requestId, actor: ownerUiActor,
      input: commandInput, boundIdentity: { entityType: 'creative_brief' }, entityType: 'creative_brief',
      execute: (database, value) => { const data = createCreativeBrief(database, value); return { data, entityId: data.id, afterRevision: data.revision, readback: data }; } });
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
