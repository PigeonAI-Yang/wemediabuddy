import { dialog, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { broadcastDataChanged } from './data-changed.ts';
import { getProposalDetail, getProposalLedger, restoreDismissedProposal, summarizeProposalLedger, type ProposalTab } from './proposals.ts';
import { dismissCarryForPlanItem, listFermentingBundle, refreshWorkCarry, setCarryState, shanghaiDate, type CarryState } from './ferment.ts';
import {
  copyContentVersionToNewProject, createContentProjectWithVersion, deleteContentProject,
  getContentProject, getContentProjectStatusSummary, getStudio, listContentProjects, saveCoreVersion, savePlatformVersion, updateContentProject,
  type ContentProjectOrder, type ContentProjectPlatform, type ContentProjectStatus
} from './content.ts';
import { getToday, getTodayOverviewMetrics } from './workbench.ts';
import { buildRoleRoster } from './role-roster.ts';
import { getActiveJobSpawner } from './job-spawner.ts';
import { readCrewInstanceProjection } from './crew-instance-projection.ts';
import { readTaskTranscriptForJob } from './pi-transcript-projection.ts';
import { listResearchSuccessorNeedsUser } from './research-successor-projection.ts';
import { decideResearchSuccessorViaRuntime, RESEARCH_SUCCESSOR_ACTIONS } from './research-successor.ts';
import { migrateDatabase } from './db/migrations.ts';
import { submitWorkspaceOrchestratorIntent } from './workspace-orchestrator-runtime.ts';
import type { SubmitWorkspaceOrchestratorIntentInput } from './workspace-orchestrator-runtime.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { executeOwnerProjectionDecision, readOwnerProjectionDecisionBinding } from './workspace-orchestrator-owner-decision.ts';
import { approvePlanItemAndCreateProject } from './plan-item-approval.ts';

import { listCapabilityOverlays, setCapabilityOverlay } from './capability-overlays.ts';
import { AGENT_CAPABILITIES, ROLE_CATALOG, isRoleId, type RoleId } from '../shared/agent-capabilities.ts';
import { bindAgentAvatarAsset, clearAgentAvatarMapping, listAgentAvatars } from './agent-avatars.ts';
import { getAsset, guessImageMime, linkProjectAsset, listProjectAssets, markdownImageForAsset, MAX_DERIVED_IMAGE_BYTES, registerStagedAsset, stageAssetBytes } from './assets.ts';
import type { StagedCrop } from './media-bindings.ts';
import { insertDerivedCropProvenance, pngDimensionsFromBytes } from './media-bindings.ts';
import { isValidCropRegion, type ContentMediaBindingDraft, type CropRegion, type PlatformClipPayload, type PlatformCropPayload, type PlatformMediaBindingDraft } from '../shared/media-bindings.ts';
import type { StagedClipSave } from './content.ts';
import {
  commitClipDerivation, insertDerivedProvenance, isAnnotationSpecValid, MEDIA_RUNTIME_MISSING,
  stageClipAsset, validateClipRange, type AnnotationSpec, type StagedClip
} from './media-derivations.ts';
import { dispatchBusinessCommand, receiptAsCommandResult, requireCommandResultData, requireReceiptData } from './business-command.ts';
import { failure } from './result.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, runtimeForNullableMutation, type BusinessIpcDependencies } from './ipc-business-context.ts';
type PlanItemIntentIdentity = Readonly<{
  planItemId: string;
  businessDate: string;
  planItemRevision: number;
  projectId: string | null;
  projectRevision: number | null;
}>;

function readPlanItemIntentIdentity(database: ActiveWorkspaceRuntime['database'], planItemId: string): PlanItemIntentIdentity {
  const item = database.prepare(`
    SELECT pi.id AS planItemId, pi.revision AS planItemRevision, p.plan_date AS businessDate
      FROM plan_items pi
      JOIN plans p ON p.id = pi.plan_id
     WHERE pi.id = ?
  `).get(planItemId) as { planItemId: string; planItemRevision: number; businessDate: string } | undefined;
  if (!item) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
  const projects = database.prepare('SELECT id, revision FROM content_projects WHERE plan_item_id = ?').all(planItemId) as Array<{ id: string; revision: number }>;
  if (projects.length > 1) throw Object.assign(new Error('ambiguous_project_for_plan_item'), { code: 'CONFLICT' });
  const project = projects[0] ?? null;
  return Object.freeze({
    planItemId: item.planItemId,
    businessDate: String(item.businessDate ?? ''),
    planItemRevision: Number(item.planItemRevision),
    projectId: project?.id ?? null,
    projectRevision: project ? Number(project.revision) : null
  });
}

export function registerTodayStudioBusinessIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle('today:get', (_event, planDate: string) => readWorkspaceDatabase(dependencies, () => null, database => getToday(database, planDate)));
  ipcMain.handle('today:overview-metrics', (_event, planDate: string, asOf?: string) => readWorkspaceDatabase(dependencies, () => null, database =>
    getTodayOverviewMetrics(database, planDate, { now: asOf ? new Date(asOf) : undefined })));
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

  // WMB-5174：Today「研究缺口 · 等你批」只读投影（仅 unresolved required needs_user；无候选/进度/裸资料）。
  ipcMain.handle('today:research-successors', () => readWorkspaceDatabase(dependencies, () => [], database =>
    listResearchSuccessorNeedsUser(database)
  ));

  // WMB-5174：三动作（收窄/手动补料/接受标注待核实）精确接 decideResearchSuccessorViaRuntime。
  // 决策即系统命令（actor=scheduler，decision 写入 payload.briefSuffix）；结果原样返回 CommandResult，
  // 权限/错误诚实回显（不吞错、不伪装成功）。
  ipcMain.handle('agents:decide-research-successor', async (_event, input: { jobId?: string; decision?: string }) => {
    const jobId = typeof input?.jobId === 'string' && input.jobId.trim() ? input.jobId.trim() : '';
    const decision = input?.decision;
    if (!jobId) return { ok: false as const, data: null, error: { code: 'VALIDATION_ERROR', message: '缺少研究续派工单 ID。' } };
    if (!RESEARCH_SUCCESSOR_ACTIONS.includes(decision as (typeof RESEARCH_SUCCESSOR_ACTIONS)[number])) {
      return { ok: false as const, data: null, error: { code: 'VALIDATION_ERROR', message: `决策只允许 ${RESEARCH_SUCCESSOR_ACTIONS.join('/')}（收窄/手动补料/接受标注待核实）。` } };
    }
    const runtime = await requireBusinessRuntime(dependencies);
    const result = await decideResearchSuccessorViaRuntime(runtime, jobId, decision as (typeof RESEARCH_SUCCESSOR_ACTIONS)[number]);
    if (result.ok) broadcastDataChanged({ scopes: ['agent', 'today'], reason: `research-successor.decide:${decision}` });
    return result;
  });

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
  ipcMain.handle('proposals:detail', (_event, planItemId: string) =>
    readWorkspaceDatabase(dependencies, () => null, database => getProposalDetail(database, planItemId)));
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
  ipcMain.handle('studio:save-core', async (_event, input: { projectId: string; title: string; body: string; expectedRevision: number; mediaBindings?: ContentMediaBindingDraft[] }) => {
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
    mediaBindings?: PlatformMediaBindingDraft[]; cropPayloads?: PlatformCropPayload[];
    clipPayloads?: PlatformClipPayload[];
  }) => {
    const runtime = await requireBusinessRuntime(dependencies); if (!input?.projectId) throw new Error('请先选择内容项目。');
    // WMB-5237：裁切载荷在 dispatcher 事务前 stage（sha256 命名幂等，文件重复可容忍）；
    // asset + provenance + 绑定在 dispatcher 事务内原子注册/写入，保存失败整体回滚（不留半写）。
    const stagedCrops: StagedCrop[] = [];
    for (const payload of input.cropPayloads ?? []) {
      if (!payload?.assetId) throw new Error('裁切载荷缺少源素材 assetId。');
      if (!isValidCropRegion(payload.cropRegion)) throw new Error('裁切区域无效（须 0..1 且 x+width<=1、y+height<=1、width/height>0）。');
      if (typeof payload.pngBase64 !== 'string' || payload.pngBase64.length === 0) throw new Error('裁切载荷缺少 PNG 字节。');
      const bytes = Buffer.from(payload.pngBase64, 'base64');
      const pngDimensions = pngDimensionsFromBytes(bytes);
      const staged = await stageAssetBytes(runtime.identity.rootPath, {
        bytes,
        fileName: 'crop.png',
        mimeType: 'image/png',
        origin: 'platform-crop',
        width: payload.width ?? pngDimensions?.width ?? null,
        height: payload.height ?? pngDimensions?.height ?? null
      });
      stagedCrops.push({ sourceAssetId: payload.assetId, cropRegion: payload.cropRegion, staged });
    }
    // WMB-5246：视频 Clip 载荷在事务前完成文件工作（stageClipAsset：校验 + ffmpeg 物化 + staging，
    // 零 DB 写）；事务内由 savePlatformVersion 原子注册派生 asset + 血缘 + 绑定回填。
    // 校验失败 / MEDIA_RUNTIME_MISSING 在任何文件写入之前抛出 → 冲突/失败零部分写。
    const stagedClips: StagedClipSave[] = [];
    for (const payload of input.clipPayloads ?? []) {
      if (!payload?.sourceAssetId) throw new Error('视频载荷缺少源素材 assetId。');
      if (!Number.isSafeInteger(payload.startMs) || !Number.isSafeInteger(payload.endMs)) throw new Error('视频时间段必须是整数毫秒。');
      const staged = await stageClipAsset(runtime.database, runtime.identity.rootPath, {
        sourceAssetId: payload.sourceAssetId,
        startMs: payload.startMs,
        endMs: payload.endMs,
        origin: 'platform-clip'
      });
      stagedClips.push({
        staged: staged.staged,
        sourceAssetId: payload.sourceAssetId,
        startMs: payload.startMs,
        endMs: payload.endMs,
        codec: staged.codec,
        copyOrTranscode: staged.copyOrTranscode,
        durationMs: staged.durationMs,
        runtimeName: staged.runtimeName,
        runtimeVersion: staged.runtimeVersion
      });
    }
    const { cropPayloads: _ignoredCropPayloads, clipPayloads: _ignoredClipPayloads, ...saveInput } = input;
    const receipt = await dispatchBusinessCommand(runtime, { command: 'content.save_version', requestId: freshRequestId(), actor: ownerUiActor,
      input: { ...saveInput, body: String(input.body ?? ''), id: input.versionId, stagedCrops, stagedClips },
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

  // WMB-5237：非破坏裁切派生 asset（renderer canvas 导出 PNG → sha256 去重 + derived_crop provenance）。
  // 写守卫要求 DB 写在命令派发内：stageAssetBytes（纯文件）在 dispatch 前，registerStagedAsset +
  // insertDerivedCropProvenance（DB 写）在 execute 内同步完成；原图永不覆盖/删除，失败零 DB 关系。
  // 幂等：相同派生字节经 registerStagedAsset sha256 复用（reused=true），provenance 行 UNIQUE 不重复。
  ipcMain.handle('studio:derive-asset', async (_event, input: { sourceAssetId?: string; cropRegion?: CropRegion; pngBase64?: string }) => {
    const sourceAssetId = typeof input?.sourceAssetId === 'string' ? input.sourceAssetId.trim() : '';
    if (!sourceAssetId) return failure('VALIDATION_ERROR', '缺少源素材 assetId。');
    if (!isValidCropRegion(input?.cropRegion)) return failure('VALIDATION_ERROR', '裁切区域无效（须 0..1 且 x+width<=1、y+height<=1、width/height>0）。');
    const pngBase64 = typeof input?.pngBase64 === 'string' ? input.pngBase64.trim() : '';
    if (!pngBase64) return failure('VALIDATION_ERROR', '缺少裁切后 PNG 数据。');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(pngBase64, 'base64');
    } catch {
      return failure('VALIDATION_ERROR', 'PNG 数据不是合法的 base64。');
    }
    if (bytes.byteLength === 0) return failure('VALIDATION_ERROR', 'PNG 数据为空。');
    if (bytes.byteLength > MAX_DERIVED_IMAGE_BYTES) return failure('VALIDATION_ERROR', `裁切图片超过大小上限（${Math.round(MAX_DERIVED_IMAGE_BYTES / 1024 / 1024)}MB）。`);
    // PNG magic + IHDR 尺寸的单一实现（png-dimensions.ts，经 media-bindings.ts 导出）；非法字节 → null fail-closed。
    const dimensions = pngDimensionsFromBytes(bytes);
    if (!dimensions) return failure('VALIDATION_ERROR', '裁切结果必须是有效的 PNG 图片。');
    const runtime = await requireBusinessRuntime(dependencies);
    const source = getAsset(runtime.database, sourceAssetId);
    if (!source) return failure('NOT_FOUND', `源素材不存在：${sourceAssetId}。`);
    if (!source.mimeType.startsWith('image/')) return failure('VALIDATION_ERROR', `源素材不是图片（mime ${source.mimeType}）。`);
    const staged = await stageAssetBytes(runtime.identity.rootPath, {
      bytes,
      fileName: 'crop.png',
      mimeType: 'image/png',
      origin: 'studio-crop',
      width: dimensions.width,
      height: dimensions.height
    });
    const requestId = freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'studio:derive-asset',
      requestId,
      actor: ownerUiActor,
      input: { sourceAssetId, cropRegion: input.cropRegion as CropRegion, staged, width: dimensions.width, height: dimensions.height, requestId },
      boundIdentity: { entityType: 'asset', entityId: sourceAssetId },
      entityType: 'asset',
      execute: (database, value) => {
        const registered = registerStagedAsset(database, value.staged);
        insertDerivedCropProvenance(database, {
          sourceAssetId: value.sourceAssetId,
          derivedAssetId: registered.id,
          cropRegion: value.cropRegion,
          width: value.width,
          height: value.height,
          origin: 'studio-crop',
          requestId: value.requestId
        });
        const data = { assetId: registered.id, reused: registered.reused, sha256: staged.sha256 };
        return { data, entityId: registered.id, afterRevision: 1, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'studio.asset.crop' });
    return receiptAsCommandResult(receipt);
  });

  // WMB-5246：非破坏标注派生 asset（renderer canvas 导出标注 PNG → sha256 去重 +
  // derived_annotation provenance，transform_json 存 {annotationType, elements, width, height}）。
  // 与裁切同构：文件 staging 在 dispatch 前，DB 写在命令事务内原子完成；原图永不覆盖/删除。
  ipcMain.handle('studio:derive-annotation', async (_event, input: { sourceAssetId?: string; annotationSpec?: unknown; pngBase64?: string }) => {
    const sourceAssetId = typeof input?.sourceAssetId === 'string' ? input.sourceAssetId.trim() : '';
    if (!sourceAssetId) return failure('VALIDATION_ERROR', '缺少源素材 assetId。');
    if (!isAnnotationSpecValid(input?.annotationSpec)) return failure('VALIDATION_ERROR', 'annotationSpec 无效（须 annotationType 字符串、elements 数组、正整数 width/height）。');
    const pngBase64 = typeof input?.pngBase64 === 'string' ? input.pngBase64.trim() : '';
    if (!pngBase64) return failure('VALIDATION_ERROR', '缺少标注后 PNG 数据。');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(pngBase64, 'base64');
    } catch {
      return failure('VALIDATION_ERROR', 'PNG 数据不是合法的 base64。');
    }
    if (bytes.byteLength === 0) return failure('VALIDATION_ERROR', 'PNG 数据为空。');
    if (bytes.byteLength > MAX_DERIVED_IMAGE_BYTES) return failure('VALIDATION_ERROR', `标注图片超过大小上限（${Math.round(MAX_DERIVED_IMAGE_BYTES / 1024 / 1024)}MB）。`);
    const dimensions = pngDimensionsFromBytes(bytes);
    if (!dimensions) return failure('VALIDATION_ERROR', '标注结果必须是有效的 PNG 图片。');
    const runtime = await requireBusinessRuntime(dependencies);
    const source = getAsset(runtime.database, sourceAssetId);
    if (!source) return failure('NOT_FOUND', `源素材不存在：${sourceAssetId}。`);
    if (!source.mimeType.startsWith('image/')) return failure('VALIDATION_ERROR', `源素材不是图片（mime ${source.mimeType}）。`);
    const staged = await stageAssetBytes(runtime.identity.rootPath, {
      bytes,
      fileName: 'annotation.png',
      mimeType: 'image/png',
      origin: 'studio-annotation',
      width: dimensions.width,
      height: dimensions.height
    });
    const requestId = freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'studio:derive-annotation',
      requestId,
      actor: ownerUiActor,
      input: { sourceAssetId, annotationSpec: input.annotationSpec as AnnotationSpec, staged, width: dimensions.width, height: dimensions.height, requestId },
      boundIdentity: { entityType: 'asset', entityId: sourceAssetId },
      entityType: 'asset',
      execute: (database, value) => {
        const registered = registerStagedAsset(database, value.staged);
        insertDerivedProvenance(database, {
          kind: 'derived_annotation',
          sourceAssetId: value.sourceAssetId,
          derivedAssetId: registered.id,
          transformJson: {
            annotationType: value.annotationSpec.annotationType,
            elements: value.annotationSpec.elements,
            width: value.width,
            height: value.height
          },
          origin: 'studio-annotation',
          requestId: value.requestId
        });
        const data = { assetId: registered.id, reused: registered.reused, sha256: staged.sha256 };
        return { data, entityId: registered.id, afterRevision: 1, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'studio.asset.annotation' });
    return receiptAsCommandResult(receipt);
  });

  // WMB-5246：非破坏 ≤60s 视频片段派生（stream copy 优先，关键帧边界不准确时固定
  // H.264/AAC 转码；derived_clip [+ derived_transcode] 血缘 + 运行时身份）。
  // 文件工作（ffmpeg 物化 + staging）在命令事务外；DB 写（asset + provenance）在事务内；
  // 非法范围/运行时缺失在任何写入之前 fail-closed。
  ipcMain.handle('studio:derive-clip', async (_event, input: { sourceAssetId?: string; startMs?: number; endMs?: number }) => {
    const sourceAssetId = typeof input?.sourceAssetId === 'string' ? input.sourceAssetId.trim() : '';
    if (!sourceAssetId) return failure('VALIDATION_ERROR', '缺少源素材 assetId。');
    const startMs = input?.startMs;
    const endMs = input?.endMs;
    if (typeof startMs !== 'number' || typeof endMs !== 'number' || !Number.isInteger(startMs) || !Number.isInteger(endMs)) {
      return failure('VALIDATION_ERROR', 'clip 时间范围必须是整数毫秒。');
    }
    const runtime = await requireBusinessRuntime(dependencies);
    const source = getAsset(runtime.database, sourceAssetId);
    if (!source) return failure('NOT_FOUND', `源素材不存在：${sourceAssetId}。`);
    if (!source.mimeType.startsWith('video/')) return failure('VALIDATION_ERROR', `源素材不是视频（mime ${source.mimeType}）。`);
    // 预校验（durationMs 缺失时由 stageClipAsset 探测后二次校验）：非法输入零文件、零 DB 写。
    const rangeError = validateClipRange(startMs, endMs, source.durationMs);
    if (rangeError) return failure('VALIDATION_ERROR', rangeError);
    let stagedClip: StagedClip;
    try {
      stagedClip = await stageClipAsset(runtime.database, runtime.identity.rootPath, {
        sourceAssetId,
        startMs,
        endMs,
        origin: 'studio-clip'
      });
    } catch (error) {
      // stageClipAsset 抛稳定 code（media-derivations.ts）：CLIP_RANGE_INVALID 是用户输入问题 → VALIDATION_ERROR；
      // MEDIA_RUNTIME_MISSING（受管媒体运行时未就绪）与其它物化失败是环境/执行问题 → INVALID_STATE。
      // 原始 runtime code 保留在 details.runtimeCode，失败原因不隐藏。
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const mappedCode = code === 'CLIP_RANGE_INVALID' ? 'VALIDATION_ERROR'
        : code === MEDIA_RUNTIME_MISSING ? 'INVALID_STATE'
          : 'INVALID_STATE';
      return failure(mappedCode, error instanceof Error ? error.message : String(error), {
        ...(typeof code === 'string' ? { runtimeCode: code } : {})
      });
    }
    const requestId = freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'studio:derive-clip',
      requestId,
      actor: ownerUiActor,
      input: {
        sourceAssetId, startMs, endMs,
        staged: stagedClip.staged, mode: stagedClip.copyOrTranscode, codec: stagedClip.codec,
        runtimeName: stagedClip.runtimeName, runtimeVersion: stagedClip.runtimeVersion, requestId
      },
      boundIdentity: { entityType: 'asset', entityId: sourceAssetId },
      entityType: 'asset',
      execute: (database, value) => {
        const data = commitClipDerivation(database, value.staged, {
          sourceAssetId: value.sourceAssetId,
          startMs: value.startMs,
          endMs: value.endMs,
          origin: 'studio-clip',
          requestId: value.requestId,
          mode: value.mode,
          codec: value.codec,
          runtimeName: value.runtimeName,
          runtimeVersion: value.runtimeVersion
        });
        return { data, entityId: data.assetId, afterRevision: 1, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'studio.asset.clip' });
    return receiptAsCommandResult(receipt);
  });

  ipcMain.handle('plan-item:request-planning', async (_event, input: { planItemId: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const identity = readPlanItemIntentIdentity(runtime.database, input.planItemId);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const payload = Object.freeze({
      planItemId: identity.planItemId,
      expectedRevision: identity.planItemRevision,
      projectId: identity.projectId,
      projectRevision: identity.projectRevision
    });
    return submitWorkspaceOrchestratorIntent(runtime, {
      producerId: 'proposal.plan-item-request-planning',
      businessDate: identity.businessDate,
      requestId,
      action: 'judge',
      logicalInput: payload,
      payload,
      rootMode: 'owner'
    } satisfies SubmitWorkspaceOrchestratorIntentInput);
  });

  ipcMain.handle('plan-item:approve', async (_event, input: { planItemId: string; expectedRevision: number; reason?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    return runtime.runActorControlPlane(() => {
      runtime.database.exec('BEGIN IMMEDIATE');
      try {
        const result = approvePlanItemAndCreateProject(runtime.database, {
          planItemId: input.planItemId,
          expectedRevision: input.expectedRevision,
          by: 'owner',
          reason: input.reason
        });
        runtime.database.exec('COMMIT');
        broadcastDataChanged({ scopes: ['today', 'studio', 'proposals'], reason: 'plan_item.approve' });
        return result;
      } catch (error) {
        runtime.database.exec('ROLLBACK');
        throw error;
      }
    });
  });

  ipcMain.handle('plan-item:reject', async (_event, input: { planItemId: string; expectedRevision: number; reason: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const identity = readPlanItemIntentIdentity(runtime.database, input.planItemId);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const payload = Object.freeze({
      planItemId: identity.planItemId,
      expectedRevision: input.expectedRevision,
      projectId: identity.projectId,
      projectRevision: identity.projectRevision,
      decision: 'reject',
      approvedPlanItemIds: [],
      reason: input.reason
    });
    return submitWorkspaceOrchestratorIntent(runtime, {
      producerId: 'proposal.candidate-decision',
      businessDate: identity.businessDate,
      requestId,
      action: 'approve_candidates',
      logicalInput: payload,
      payload,
      rootMode: 'owner'
    } satisfies SubmitWorkspaceOrchestratorIntentInput);
  });

  ipcMain.handle('plan-item:rework', async (_event, input: { planItemId: string; expectedRevision: number; reason?: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const identity = readPlanItemIntentIdentity(runtime.database, input.planItemId);
    const binding = readOwnerProjectionDecisionBinding(runtime.database, runtime.identity.workspaceId, input.planItemId);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const payload = Object.freeze({ ...binding, expectedRevision: input.expectedRevision, decision: 'repair', invalidPlanItemIds: [identity.planItemId], reason: input.reason ?? 'rework' });
    const actorReceipt = await submitWorkspaceOrchestratorIntent(runtime, {
      producerId: 'proposal.candidate-decision', businessDate: identity.businessDate, requestId,
      action: 'repair_invalid_candidate', logicalInput: payload, payload, rootMode: 'owner'
    } satisfies SubmitWorkspaceOrchestratorIntentInput);
    if (!actorReceipt.ok) return actorReceipt;
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'plan_item.rework', requestId: `${requestId}:execute`, actor: ownerUiActor,
      input: { ...binding, decision: 'repair' as const, expectedRevision: input.expectedRevision, requestId, reason: input.reason ?? 'rework' },
      boundIdentity: { entityType: 'plan_item', entityId: input.planItemId }, entityType: 'plan_item',
      execute: (database, value) => {
        const data = executeOwnerProjectionDecision(database, value);
        return { data, entityId: input.planItemId, beforeRevision: input.expectedRevision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['today', 'proposals'], reason: 'plan_item.rework' });
    return receiptAsCommandResult(receipt);
  });

  ipcMain.handle('plan-item:advance', async (_event, input: { planItemId: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const identity = readPlanItemIntentIdentity(runtime.database, input.planItemId);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const payload = Object.freeze({
      planItemId: identity.planItemId,
      expectedRevision: identity.planItemRevision,
      projectId: identity.projectId,
      projectRevision: identity.projectRevision
    });
    return submitWorkspaceOrchestratorIntent(runtime, {
      producerId: 'proposal.plan-item-advance',
      businessDate: identity.businessDate,
      requestId,
      action: 'stage_d',
      logicalInput: payload,
      payload,
      rootMode: 'owner'
    } satisfies SubmitWorkspaceOrchestratorIntentInput);
  });
}
