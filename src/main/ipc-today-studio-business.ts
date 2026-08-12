import { dialog, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { broadcastDataChanged } from './data-changed.ts';
import { getProposalLedger, restoreDismissedProposal, summarizeProposalLedger, type ProposalTab } from './proposals.ts';
import { dismissCarryForPlanItem, listFermentingBundle, refreshWorkCarry, setCarryState, shanghaiDate, type CarryState } from './ferment.ts';
import {
  copyContentVersionToNewProject, createContentProjectWithVersion, createProjectFromPlanItem, deleteContentProject,
  getContentProject, getContentProjectStatusSummary, getStudio, listContentProjects, saveCoreVersion, savePlatformVersion, updateContentProject,
  type ContentProjectOrder, type ContentProjectPlatform, type ContentProjectStatus
} from './content.ts';
import { getToday } from './workbench.ts';
import { buildRoleRoster } from './role-roster.ts';
import { getActiveJobSpawner } from './job-spawner.ts';
import { readCrewInstanceProjection } from './crew-instance-projection.ts';
import { readTaskTranscriptForJob } from './pi-transcript-projection.ts';
import { migrateDatabase } from './db/migrations.ts';
import { listCapabilityOverlays, setCapabilityOverlay } from './capability-overlays.ts';
import { AGENT_CAPABILITIES, ROLE_CATALOG, isRoleId, type RoleId } from '../shared/agent-capabilities.ts';
import { bindAgentAvatarAsset, clearAgentAvatarMapping, listAgentAvatars } from './agent-avatars.ts';
import { getAsset, guessImageMime, linkProjectAsset, listProjectAssets, markdownImageForAsset, registerStagedAsset, stageAssetBytes } from './assets.ts';
import { dispatchBusinessCommand, receiptAsCommandResult, requireCommandResultData, requireReceiptData } from './business-command.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, runtimeForNullableMutation, type BusinessIpcDependencies } from './ipc-business-context.ts';

export function registerTodayStudioBusinessIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle('today:get', (_event, planDate: string) => readWorkspaceDatabase(dependencies, () => null, database => getToday(database, planDate)));
  ipcMain.handle('agents:roster-status', (_event, input: { businessDate?: string } = {}) => readWorkspaceDatabase(dependencies, () => [], database => {
    const runtime = dependencies.getActiveRuntime();
    const workers = runtime?.getWorkerSnapshots?.() ?? [];
    const worker = runtime?.getWorkerSnapshot() ?? null;
    return buildRoleRoster(database, { businessDate: input?.businessDate ?? shanghaiDate(), worker, workers });
  }));

  // WMB-5143：只读投影面（活动实例 + 持久面历史 + 摘要），单一 CrewInstanceProjection DTO。
  ipcMain.handle('agents:crew-projection', () => readWorkspaceDatabase(dependencies, () => null, database => {
    const spawner = getActiveJobSpawner();
    return readCrewInstanceProjection({
      database,
      pool: spawner?.pool ?? null,
      getHandle: spawner ? (jobId) => spawner.getHandle(jobId) : null
    });
  }));

  // WMB-5195：只读工单 transcript。主进程只接受 jobId，依据 authoritative crew projection 反查会话
  // （daily/employee 会话名均按契约解析、路径 containment fail-closed）；无写操作、不新增 schema/权限，
  // 缺失/不匹配/解析失败一律返回 null，不向 renderer 暴露路径细节。
  ipcMain.handle('agents:task-transcript', async (_event, jobId: string) => {
    if (typeof jobId !== 'string' || !jobId.trim()) return null;
    const runtime = dependencies.getActiveRuntime();
    if (runtime) return readTaskTranscriptForJob(runtime.database, runtime.identity.rootPath, jobId, getActiveJobSpawner());
    const root = await dependencies.loadSelectedDataRoot();
    const activatedRuntime = dependencies.getActiveRuntime();
    if (activatedRuntime) return readTaskTranscriptForJob(activatedRuntime.database, activatedRuntime.identity.rootPath, jobId, getActiveJobSpawner());
    if (!root) return null;
    const database = migrateDatabase(path.join(root.path, 'wmb.db'));
    try {
      return await readTaskTranscriptForJob(database, root.path, jobId, getActiveJobSpawner());
    } finally {
      database.close();
    }
  });
  
  ipcMain.handle('agents:capability-summary', () => {
    return {
      roles: Object.values(ROLE_CATALOG).map((role) => ({
        roleId: role.roleId,
        labelZh: role.labelZh,
        roomZh: role.roomZh,
        skills: [...role.skills]
      })),
      capabilities: AGENT_CAPABILITIES.filter((cap) => cap.agentGrantable).map((cap) => ({
        id: cap.id,
        displayName: cap.displayName,
        description: cap.description,
        defaultRoleBindings: cap.defaultRoleBindings
      }))
    };
  });
  ipcMain.handle('agents:list-overlays', () => readWorkspaceDatabase(dependencies, () => [], (database) => {
    const runtime = dependencies.getActiveRuntime();
    const workspaceId = runtime?.identity.workspaceId;
    if (!workspaceId) return [];
    return listCapabilityOverlays(database, workspaceId);
  }));
  ipcMain.handle('agents:set-overlay', async (_event, input: { roleId: string; capabilityId: string; enabled: boolean }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    if (!isRoleId(input.roleId)) throw new Error('未知角色。');
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'agents.set_overlay',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input: {
        workspaceId: runtime.identity.workspaceId,
        roleId: input.roleId,
        capabilityId: input.capabilityId,
        enabled: input.enabled
      },
      boundIdentity: { entityType: 'capability_overlay', roleId: input.roleId, capabilityId: input.capabilityId },
      entityType: 'capability_overlay',
      execute: (database, value) => {
        const data = setCapabilityOverlay(database, {
          workspaceId: value.workspaceId,
          roleId: value.roleId,
          capabilityId: value.capabilityId as import('../shared/agent-capabilities.ts').AgentCapabilityId,
          enabled: value.enabled
        });
        return { data, entityId: `${value.roleId}:${value.capabilityId}`, afterRevision: 1, readback: data };
      }
    });
    const row = requireReceiptData(receipt);
    broadcastDataChanged({ scopes: ['agent'], reason: 'capability.overlay' });
    return row;
  });

  ipcMain.handle('agents:list-avatars', () => readWorkspaceDatabase(dependencies, () => [], database => listAgentAvatars(database)));
  ipcMain.handle('agents:set-avatar', async (_event, input: { roleId: string; base64: string; mimeType?: string; width?: number; height?: number }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    if (!input?.roleId || !input?.base64) throw new Error('roleId 与图片数据必填。');
    if (!isRoleId(input.roleId)) throw new Error('未知角色。');
    const bytes = Buffer.from(String(input.base64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (!bytes.length) throw new Error('图片数据无效。');
    if (bytes.byteLength > 5 * 1024 * 1024) throw new Error('头像不能超过 5MB。');
    const staged = await stageAssetBytes(runtime.identity.rootPath, {
      bytes,
      fileName: `${input.roleId}.png`,
      mimeType: input.mimeType || 'image/png',
      origin: 'agent-avatar',
      width: input.width ?? 256,
      height: input.height ?? 256
    });
    if (!staged.mimeType.startsWith('image/')) throw new Error('头像必须是图片。');
    try {
      const aliasAbs = path.join(runtime.identity.rootPath, 'assets', 'agent-avatars', `${input.roleId}.png`);
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(path.dirname(aliasAbs), { recursive: true });
      await writeFile(aliasAbs, bytes);
    } catch { /* alias best-effort */ }
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'agents.set_avatar',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input: { roleId: input.roleId as import('../shared/agent-capabilities.ts').RoleId, staged },
      boundIdentity: { entityType: 'agent_avatar', roleId: input.roleId },
      entityType: 'agent_avatar',
      execute: (database, value) => {
        const data = bindAgentAvatarAsset(database, { roleId: value.roleId, staged: value.staged });
        return { data, entityId: value.roleId, afterRevision: 1, readback: data };
      }
    });
    const data = requireReceiptData(receipt);
    broadcastDataChanged({ scopes: ['agent'], reason: 'agent.avatar' });
    return data;
  });
  ipcMain.handle('agents:clear-avatar', async (_event, input: { roleId: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    if (!input?.roleId || !isRoleId(input.roleId)) throw new Error('未知角色。');
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'agents.clear_avatar',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input: { roleId: input.roleId },
      boundIdentity: { entityType: 'agent_avatar', roleId: input.roleId },
      entityType: 'agent_avatar',
      execute: (database, value) => {
        clearAgentAvatarMapping(database, value.roleId);
        return { data: { ok: true as const }, entityId: value.roleId, afterRevision: 1, readback: { ok: true } };
      }
    });
    const data = requireReceiptData(receipt);
    broadcastDataChanged({ scopes: ['agent'], reason: 'agent.avatar.clear' });
    return data;
  });


  ipcMain.handle('proposals:get', (_event, input: { planDate: string; tab?: ProposalTab; limit?: number; offset?: number }) =>
    readWorkspaceDatabase(dependencies, () => null, database => getProposalLedger(database, input)));
  ipcMain.handle('proposals:summary', (_event, planDate: string) =>
    readWorkspaceDatabase(dependencies, () => null, database => summarizeProposalLedger(database, { planDate })));
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
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['today', 'proposals'], reason: 'carry.state' }); return data;
  });
  ipcMain.handle('proposals:restore', async (_event, input: { planItemId: string; reason?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'opportunities.restore', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'plan_item', entityId: input.planItemId }, entityType: 'work_carry',
      execute: (database, value) => { const data = restoreDismissedProposal(database, value, false); return { data, entityId: data.id,
        afterRevision: data.revision, readback: data }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['today', 'proposals'], reason: 'proposal.restore' }); return data;
  });
  ipcMain.handle('today:dismiss-plan-item', async (_event, input: { planItemId: string; reason?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'opportunities.dismiss', requestId: freshRequestId(), actor: ownerUiActor,
      input, boundIdentity: { entityType: 'plan_item', entityId: input.planItemId }, entityType: 'work_carry',
      execute: (database, value) => { const data = dismissCarryForPlanItem(database, value, false); return { data, entityId: data.id,
        beforeRevision: undefined, afterRevision: data.revision, readback: data }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['today', 'proposals'], reason: 'carry.dismiss' }); return data;
  });
  ipcMain.handle('today:create-project', async (_event, planItemId: string) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, { command: 'content.create', requestId: freshRequestId(), actor: ownerUiActor,
      input: { planItemId }, boundIdentity: { entityType: 'plan_item', entityId: planItemId }, entityType: 'content_project',
      execute: (database, value) => { const data = createProjectFromPlanItem(database, value.planItemId, false); return { data,
        entityId: data.id, afterRevision: data.revision, readback: getContentProject(database, data.id) }; } });
    const data = requireReceiptData(receipt); broadcastDataChanged({ scopes: ['today', 'studio', 'proposals'], reason: 'content.create_from_plan' }); return data;
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
  ipcMain.handle('studio:save-platform', async (_event, input: {
    projectId: string; contentVersionId: string; platform: ContentProjectPlatform; format: string; title?: string;
    body: string; assetIds?: string[]; expectedRevision?: number; versionId?: string;
  }) => {
    const runtime = await requireBusinessRuntime(dependencies); if (!input?.projectId) throw new Error('请先选择内容项目。');
    const receipt = await dispatchBusinessCommand(runtime, { command: 'content.save_version', requestId: freshRequestId(), actor: ownerUiActor,
      input: { ...input, body: String(input.body ?? ''), id: input.versionId },
      boundIdentity: { projectId: input.projectId, versionId: input.versionId ?? null }, entityType: 'content_version',
      execute: (database, value) => { const data = requireCommandResultData(savePlatformVersion(database, value)); return { data,
        entityId: data.id, beforeRevision: value.versionId ? value.expectedRevision : undefined, afterRevision: data.revision, readback: data }; } });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'content.platform_version' });
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
