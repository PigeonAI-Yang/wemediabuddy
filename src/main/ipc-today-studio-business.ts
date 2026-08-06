import { dialog, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getToday } from './workbench.ts';
import { dismissCarryForPlanItem, listFermentingBundle, refreshWorkCarry, setCarryState, type CarryState } from './ferment.ts';
import {
  copyContentVersionToNewProject, createContentProjectWithVersion, createProjectFromPlanItem, deleteContentProject,
  getContentProject, getContentProjectStatusSummary, getStudio, listContentProjects, saveCoreVersion, updateContentProject,
  type ContentProjectOrder, type ContentProjectPlatform, type ContentProjectStatus
} from './content.ts';
import { getAsset, guessImageMime, linkProjectAsset, listProjectAssets, markdownImageForAsset, registerStagedAsset, stageAssetBytes } from './assets.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { dispatchBusinessCommand, receiptAsCommandResult, requireCommandResultData, requireReceiptData } from './business-command.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, runtimeForNullableMutation, type BusinessIpcDependencies } from './ipc-business-context.ts';

export function registerTodayStudioBusinessIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle('today:get', (_event, planDate: string) => readWorkspaceDatabase(dependencies, () => null, database => getToday(database, planDate)));
  ipcMain.handle('today:list-fermenting', (_event, planDate: string) => readWorkspaceDatabase(dependencies, () => null, database => listFermentingBundle(database, planDate)));
  ipcMain.handle('studio:get', () => readWorkspaceDatabase(dependencies, () => null, database => getStudio(database)));
  ipcMain.handle('studio:list', (_event, input: { query?: string; status?: ContentProjectStatus; archived?: boolean; order?: ContentProjectOrder; platform?: ContentProjectPlatform; limit?: number; offset?: number }) =>
    readWorkspaceDatabase(dependencies, () => null, database => listContentProjects(database, input)));
  ipcMain.handle('studio:summary', () => readWorkspaceDatabase(dependencies, () => null, database => getContentProjectStatusSummary(database)));
  ipcMain.handle('studio:get-detail', (_event, projectId: string) => readWorkspaceDatabase(dependencies, () => null, database => getContentProject(database, projectId)));
  ipcMain.handle('studio:list-assets', (_event, projectId: string) => readWorkspaceDatabase(dependencies, () => [], database => listProjectAssets(database, projectId)));

  ipcMain.handle('today:refresh-fermenting', async (_event, planDate: string) => {
    const runtime = await runtimeForNullableMutation(dependencies); if (!runtime) return null;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'today:refresh-fermenting', requestId: freshRequestId(), actor: ownerUiActor,
      input: { planDate }, boundIdentity: { entityType: 'work_carry' }, entityType: 'work_carry',
      execute: (database, value) => { const data = refreshWorkCarry(database, value.planDate); return { data, readback: data }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['today'], reason: 'carry.refresh' }); return data;
  });
  ipcMain.handle('today:set-carry-state', async (_event, input: { id: string; expectedRevision: number; state: CarryState; reason?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'today:set-carry-state', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'work_carry', entityId: input.id }, entityType: 'work_carry',
      execute: (database, value) => { const data = setCarryState(database, value, false); return { data, entityId: data.id,
        beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['today'], reason: 'carry.state' }); return data;
  });
  ipcMain.handle('today:dismiss-plan-item', async (_event, input: { planItemId: string; reason?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'opportunities.dismiss', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'plan_item', entityId: input.planItemId }, entityType: 'work_carry',
      execute: (database, value) => { const data = dismissCarryForPlanItem(database, value, false); return { data, entityId: data.id,
        beforeRevision: undefined, afterRevision: data.revision, readback: data }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['today'], reason: 'carry.dismiss' }); return data;
  });
  ipcMain.handle('today:create-project', async (_event, planItemId: string) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'content.create', requestId: freshRequestId(), actor: ownerUiActor,
      input: { planItemId }, boundIdentity: { entityType: 'plan_item', entityId: planItemId }, entityType: 'content_project',
      execute: (database, value) => { const data = createProjectFromPlanItem(database, value.planItemId, false); return { data,
        entityId: data.id, afterRevision: data.revision, readback: getContentProject(database, data.id) }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['today', 'studio'], reason: 'content.create_from_plan' }); return data;
  });

  ipcMain.handle('studio:create-project', async (_event, input: { title: string; body: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const title = input.title.trim(); if (!title) throw new Error('项目标题不能为空。');
    const commandInput = { title, body: input.body || `# ${title}\n\n` };
    const receipt = await dispatchBusinessCommand(runtime, { command: 'content.create', requestId: freshRequestId(), actor: ownerUiActor,
      input: commandInput, boundIdentity: { entityType: 'content_project' }, entityType: 'content_project',
      execute: (database, value) => { const created = createContentProjectWithVersion(database, value, false); const data = getContentProject(database, created.id);
        if (!data) throw new Error('内容项目写入后读取失败。'); return { data, entityId: data.id, afterRevision: data.revision, readback: data }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['studio'], reason: 'content.create' }); return data;
  });
  ipcMain.handle('studio:update-project', async (_event, input: { projectId: string; expectedRevision: number; status?: ContentProjectStatus; archived?: boolean; topicId?: string | null }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'studio:update-project', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'content_project', entityId: input.projectId }, entityType: 'content_project',
      execute: (database, value) => { const data = requireCommandResultData(updateContentProject(database, value, false)); return { data,
        entityId: data.id, beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data }; } });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'content.update' });
    return receiptAsCommandResult(receipt);
  });
  ipcMain.handle('studio:delete-project', async (_event, input: { projectId: string; expectedRevision: number }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'studio:delete-project', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'content_project', entityId: input.projectId }, entityType: 'content_project',
      execute: (database, value) => { const data = requireCommandResultData(deleteContentProject(database, value, false)); return { data,
        entityId: data.id, beforeRevision: value.expectedRevision, sideEffectState: 'deleted' }; } });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'content.delete' });
    return receiptAsCommandResult(receipt);
  });
  ipcMain.handle('studio:copy-version', async (_event, input: { sourceProjectId: string; contentVersionId: string; title: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'studio:copy-version', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'content_version', entityId: input.contentVersionId }, entityType: 'content_project',
      execute: (database, value) => { const data = requireCommandResultData(copyContentVersionToNewProject(database, value, false)); return { data,
        entityId: data.id, afterRevision: data.revision, readback: data }; } });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'content.copy' });
    return receiptAsCommandResult(receipt);
  });
  ipcMain.handle('studio:save-core', async (_event, input: { projectId: string; title: string; body: string; expectedRevision: number }) => {
    const runtime = await requireBusinessRuntime(dependencies); if (!input?.projectId) throw new Error('请先选择内容项目。');
    const receipt = await dispatchBusinessCommand(runtime, { command: 'content.save_version', requestId: freshRequestId(), actor: ownerUiActor,
      input: { ...input, body: String(input.body ?? ''), author: 'user' as const },
      boundIdentity: { entityType: 'content_project', entityId: input.projectId }, entityType: 'content_version',
      execute: (database, value) => { const data = requireCommandResultData(saveCoreVersion(database, value, false)); return { data,
        entityId: data.id, beforeRevision: value.expectedRevision, afterRevision: data.projectRevision, readback: data }; } });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'content.core_version' });
    return receiptAsCommandResult(receipt);
  });

  ipcMain.handle('studio:import-image', async (_event, input: { projectId: string; sourcePath?: string; fileName?: string; mimeType?: string; bytesBase64?: string; alt?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies); if (!input?.projectId) throw new Error('请先选择内容项目。');
    let bytes: Buffer; let fileName = input.fileName; let mimeType = input.mimeType;
    if (input.bytesBase64) bytes = Buffer.from(input.bytesBase64, 'base64');
    else {
      let sourcePath = input.sourcePath;
      if (!sourcePath) {
        const picked = await dialog.showOpenDialog({ title: '插入图片', properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }] });
        if (picked.canceled || !picked.filePaths[0]) return { ok: false as const, cancelled: true as const };
        sourcePath = picked.filePaths[0];
      }
      bytes = await readFile(sourcePath); fileName ||= path.basename(sourcePath); mimeType ||= guessImageMime(sourcePath);
    }
    const staged = await stageAssetBytes(runtime.identity.rootPath, { bytes, fileName, mimeType, origin: 'studio-editor' });
    if (!staged.mimeType.startsWith('image/')) throw new Error('只能插入图片文件。');
    const receipt = await dispatchBusinessCommand(runtime, { command: 'studio:import-image', requestId: freshRequestId(), actor: ownerUiActor,
      input: { projectId: input.projectId, staged, alt: input.alt, fileName },
      boundIdentity: { entityType: 'content_project', entityId: input.projectId }, entityType: 'asset',
      execute: (database, value) => {
        if (!getContentProject(database, value.projectId)) throw new Error('内容项目不存在。');
        const imported = registerStagedAsset(database, value.staged); linkProjectAsset(database, value.projectId, imported.id);
        const asset = getAsset(database, imported.id); if (!asset) throw new Error('素材写入后读取失败。');
        const alt = (value.alt || value.fileName || path.basename(asset.relativePath)).replace(/\.[^.]+$/, '');
        const data = { ok: true as const, asset, markdown: markdownImageForAsset(asset, alt || '图片'), reused: imported.reused };
        return { data, entityId: asset.id, afterRevision: 1, readback: asset };
      } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['today'], reason: 'studio.asset' }); return data;
  });
}
