import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { readSettings } from './settings';
import { startMcp, type McpRuntime } from './mcp';
import type { XhsMcpRuntime } from './xiaohongshu-mcp';
import { refreshXhsRuntime, registerXhsIpc } from './ipc-xhs';
import { stopManagedBrowsers, type BrowserRuntime } from './browser'; import { configureBrowserProfileRegistryPath, openBrowserProfileRegistry } from './browser-config';
import { migratePiConfigToInstallation, resolvePiConfig } from './pi-config';
import { ensurePiConversationLayout, listPiConversations, readPiConversation, setPiConversationArchived, startNewPiConversation, switchPiConversation, writePiConversation } from './pi-conversation'; import { PI_AUTHORITY_SYSTEM_PROMPT } from './pi-operator-skill'; import { syncPiSkillsForDataRoots } from './pi-skill-library';
import { PiRpcSupervisor } from './pi-runtime';
import { piModelsJson, WMB_VISION_MODEL } from './pi-model';
import { getPiRuntimeInfo, resolvePiRuntimeRoot, piCliFromRuntimeRoot, piVisionExtensionFromRuntimeRoot, updatePiRuntime, rollbackPiRuntime } from './pi-runtime-manager';
import {
  agentRequestId,
  getActiveAgentTask,
  getAgentTask,
  getLatestAgentTask,
  type AgentIntent
} from './agent-tasks';
import {
  dispatchCancelAgentTask,
  dispatchCompleteAgentTask,
  dispatchFailAgentTask,
  dispatchRequestAgentTaskControl,
  dispatchRecoverInterruptedAgentTasks,
  dispatchStartAgentTask,
  dispatchUpdateAgentTaskPhase
} from './agent-task-commands.ts';
import { createDataRootSelection } from './data-root-selection';
import { ActiveWorkspaceRuntime, assertWorkspaceSwitchable, installActiveWorkspaceIpcGate, RUNTIME_MANAGING_IPC_CHANNELS, type WorkspaceRuntimeLease } from './workspace-runtime';
import { abortDailyIntelligence, startResultsReview, startStudioDraft } from './agent-runner';
import { readWorkspaceIntelligenceProfile, startWorkspaceDailyIntelligence } from './workspace-intelligence';
import { registerKnowledgeContentIpc } from './ipc-knowledge-content';
import { registerPublishingResultsIpc } from './ipc-publishing-results';
import { dispatchRecoverInterruptedPublications } from './publication-commands.ts';
import { dispatchRecoverRunningMetricJobs, dispatchSchedulePublishedPublicationMetricJobs } from './metric-commands.ts';
import { ensureAutomaticTaskGrant } from './task-grants.ts';
import { registerExecutionGrantIpc } from './ipc-execution-grants';
import { broadcastPiEvent, broadcastPiRuntimeProgress, createWindow } from './app-window';
import { visiblePiPrompt } from './pi-persistence';
import { registerSettingsConfigIpc } from './ipc-settings-config';
import { registerPiDockIpc } from './ipc-pi-dock';
import { registerXListIpc } from './ipc-x-lists'; import { dispatchRecoverOrphanedXListOperations } from './x-list-business-command'; import { activeXListOperationIds } from './x-list-execution'; import { registerIntelligenceChannelsIpc } from './ipc-intelligence-channels';
import { getAsset, guessImageMime } from './assets';
import { preparePiExtension } from './pi-extension';
import { WorkspaceProposalStore } from './workspace-proposals'; import { IntelligenceChannelProposalStore } from './intelligence-channel-proposals'; import { createWorkspaceConfirmation } from './workspace-confirmation';
import { XObservationScheduler } from './x-observation-scheduler'; import { disposeXListSessions } from './platforms/x-list-session'; import { createBrowserProfileOwner } from './browser-profile-owner';
if(process.env.WMB_ACCEPTANCE_USER_DATA)app.setPath('userData',process.env.WMB_ACCEPTANCE_USER_DATA); if(process.env.WMB_ACCEPTANCE_CDP_PORT)app.commandLine.appendSwitch('remote-debugging-port',process.env.WMB_ACCEPTANCE_CDP_PORT);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wmb-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true,
      stream: true
    }
  }
]);
const dailyRuns = new Map<string, Promise<unknown>>();
let activeRuntime: ActiveWorkspaceRuntime | null = null;
installActiveWorkspaceIpcGate(ipcMain, () => activeRuntime, [...RUNTIME_MANAGING_IPC_CHANNELS]);
const workspaceProposals = new WorkspaceProposalStore(); const channelProposals = new IntelligenceChannelProposalStore();
const currentMcp = () => activeRuntime?.getMcp<McpRuntime>() ?? null;
const currentXhs = () => activeRuntime?.getXhs<XhsMcpRuntime>() ?? null;
const currentBrowser = () => activeRuntime?.getBrowser<BrowserRuntime>() ?? null;
const currentPi = () => activeRuntime?.getWorker<PiRpcSupervisor>() ?? null;
const ownerUiActor = { type: 'owner_ui' as const, id: 'renderer', label: 'Owner UI' };
async function uiCommandResult<T>(work: () => Promise<T>): Promise<{ ok: true; data: T; error: null } | { ok: false; data: null; error: { code: string; message: string; details?: Readonly<Record<string, unknown>> } }> {
  try { return { ok: true, data: await work(), error: null }; }
  catch (error) {
    const value = error as { code?: unknown; message?: unknown; details?: Readonly<Record<string, unknown>> };
    return { ok: false, data: null, error: { code: typeof value?.code === 'string' ? value.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error), ...(value?.details ? { details: value.details } : {}) } };
  }
}
async function withRuntimeWorker<T>(taskId: string | null, onEvent: (event: Record<string, unknown>) => void, work: (hooks: { workerLeaseId: string; onTaskReady: (taskId: string) => Promise<string>; onRuntime: (worker: PiRpcSupervisor) => void; onEvent: (event: Record<string, unknown>) => void }) => Promise<T>): Promise<T> {
  const runtime = activeRuntime;
  if (!runtime) throw new Error('当前工作空间运行时不可用。');
  const lease = runtime.acquireWorkerLease(taskId);
  let worker: PiRpcSupervisor | null = null;
  runtime.bindWorker(lease, { stop: async () => { await worker?.stop(); } });
  try {
    return await work({
      workerLeaseId: lease.leaseId,
      onTaskReady: async (value) => { runtime.bindWorkerTask(lease, value); return ensureAutomaticTaskGrant(runtime, value); },
      onRuntime: (value) => { worker = value; },
      onEvent: (event) => { runtime.guardLease(lease, () => onEvent(event)); }
    });
  } finally { runtime.releaseWorker(lease); }
}
let shuttingDown = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}
async function ensurePi(dataRoot: DataRoot): Promise<PiRpcSupervisor> {
  const runtime = activeRuntime;
  if (!runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) throw new Error('当前工作空间运行时不可用。');
  const running = currentPi();
  if (running?.isRunning) return running;
  const lease = runtime.acquireWorkerLease();
  try {
    const config = resolvePiConfig();
    const layout = await ensurePiConversationLayout(dataRoot.path);
    const conversation = await readPiConversation(dataRoot.path);
    runtime.setPiSessionFile(conversation.sessionFile || layout.sessionFile);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...config, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
    const runtimeRoot = await resolvePiRuntimeRoot(dataRoot.path);
    const mcp = currentMcp();
    if (!mcp) throw new Error('WMB MCP 尚未就绪。');
    const extensionPath = await preparePiExtension(layout.agentDir);
    const worker = new PiRpcSupervisor(process.execPath, [piCliFromRuntimeRoot(runtimeRoot), '--mode', 'rpc', '--session', runtime.getPiSessionFile() || layout.sessionFile, '-e', extensionPath, '-e', piVisionExtensionFromRuntimeRoot(runtimeRoot), '--provider', 'wmb-api', '--model', config.model, ...(config.thinking ? ['--thinking', config.thinking] : []), '--append-system-prompt', PI_AUTHORITY_SYSTEM_PROMPT], {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: layout.agentDir, WMB_PI_API_KEY: config.apiKey, PI_VISION_PROVIDER: 'wmb-api', PI_VISION_MODEL: WMB_VISION_MODEL, PI_VISION_REASONING_EFFORT: 'off', WMB_MCP_URL: mcp.url, WMB_XHS_MCP_URL: currentXhs()?.getUrl() || ''
    }, (event) => {
      runtime.guardLease(lease, () => {
        const dockEvent = event.type === 'queue_update' ? { ...event, steering: Array.isArray(event.steering) ? event.steering.map((text) => visiblePiPrompt(String(text))) : [], followUp: Array.isArray(event.followUp) ? event.followUp.map((text) => visiblePiPrompt(String(text))) : [] } : event;
        broadcastPiRuntimeProgress(dockEvent, 'dock');
        if (event.type === 'wmb_process_crashed') {
          broadcastPiEvent({ type: 'failed', error: String(event.error ?? 'Pi 进程已退出，可重新发送。'), scope: 'dock' });
          runtime.releaseWorker(lease);
        }
      });
    }, layout.workspace);
    runtime.bindWorker(lease, worker);
    const state = await worker.start();
    const stateData = state.data;
    const sessionId = stateData && typeof stateData === 'object' && 'sessionId' in stateData ? String((stateData as { sessionId?: string }).sessionId ?? '') : '';
    await writePiConversation(dataRoot.path, { id: conversation.id, title: conversation.title, sessionFile: conversation.sessionFile || layout.sessionFile, sessionId: sessionId || conversation.sessionId, messages: conversation.messages, createdAt: conversation.createdAt });
    runtime.setPiSessionFile(conversation.sessionFile || layout.sessionFile);
    return worker;
  } catch (error) {
    runtime.releaseWorker(lease);
    throw error;
  }
}

async function refreshRuntime(dataRoot: DataRoot): Promise<void> {
  if (activeRuntime?.isActive && activeRuntime.identity.rootPath === path.resolve(dataRoot.path)) return;
  const runtime = ActiveWorkspaceRuntime.open(dataRoot.path, { openDatabase: migrateDatabase });
  activeRuntime = runtime;
  try {
    await dispatchRecoverInterruptedPublications(runtime);
    await dispatchRecoverOrphanedXListOperations(runtime, activeXListOperationIds);
    await dispatchRecoverInterruptedAgentTasks(runtime);
    await dispatchRecoverRunningMetricJobs(runtime);
    await dispatchSchedulePublishedPublicationMetricJobs(runtime);
    const mcp = await startMcp(dataRoot.path, runtime.gate, { listWorkspaces, proposals: workspaceProposals, channelProposals, runtimeEpoch: runtime.identity.runtimeEpoch }, runtime);
    runtime.setMcp(mcp);
    const xhs = await refreshXhsRuntime(readWorkspaceIntelligenceProfile(dataRoot.path, runtime).platforms.includes('xiaohongshu') ? dataRoot : null, null);
    runtime.setXhs(xhs);
    const scheduler = new XObservationScheduler({ runtime, loadSelectedDataRoot, isCurrent: () => activeRuntime === runtime && runtime.isActive });
    runtime.setScheduler(scheduler);
    scheduler.start();
  } catch (error) {
    if (activeRuntime === runtime) activeRuntime = null;
    await runtime.stop({ drain: false }).catch(() => {});
    throw error;
  }
}
const browserRegistryPath = path.join(app.getPath('userData'), 'browser-config.json');
configureBrowserProfileRegistryPath(browserRegistryPath);
openBrowserProfileRegistry(browserRegistryPath);
const defaultBrowserProfileId = () => openBrowserProfileRegistry(browserRegistryPath).defaultProfileId;
const { loadSelectedDataRoot, chooseDataRoot, migrate, listWorkspaces, switchWorkspace, relaunchCurrentWorkspace, createUkWorkspace } = createDataRootSelection({
  userDataPath: () => app.getPath('userData'),
  defaultBrowserProfileId,
  chooseDirectory: async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0] ?? null; },
  refreshRuntime,
  canSwitch: async (dataRoot) => assertWorkspaceSwitchable(dataRoot.path, { piActive: Boolean(currentPi()?.isActive), dailyRunCount: dailyRuns.size }),
  closeMutationGate: async () => { if (activeRuntime) await activeRuntime.closeClaimsAndDrain(); },
  openMutationGate: () => activeRuntime?.reopenClaims(),
  stopRuntime: async () => { const runtime = activeRuntime; try { await runtime?.stop({ drain: false }); } finally { if (activeRuntime === runtime) activeRuntime = null; } },
  relaunch: async (dataRoot) => {
    // Packaged/acceptance: full process relaunch. Dev: soft runtime refresh keeps Vite alive.
    if (!dataRoot || app.isPackaged || process.env.WMB_ACCEPTANCE_USER_DATA) { app.relaunch(); app.quit(); return; }
    await refreshRuntime(dataRoot);
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.reloadIgnoringCache();
  }
});
const browserProfileOwner = createBrowserProfileOwner({
  registryPath: browserRegistryPath,
  relaunchCurrentWorkspace,
  stopBrowserSessions: async () => { await disposeXListSessions(); await stopManagedBrowsers(); activeRuntime?.releaseBrowser(); },
  setBrowser: (runtime) => { if (runtime) activeRuntime?.bindBrowser(runtime, { stop: async () => { await disposeXListSessions(); await stopManagedBrowsers(); } }); else activeRuntime?.releaseBrowser(); }
});
const workspaceConfirmation = createWorkspaceConfirmation({ userDataPath: () => app.getPath('userData'), defaultBrowserProfileId, chooseDirectory: async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0] ?? null; }, loadSelectedDataRoot, relaunchCurrentWorkspace, proposals: workspaceProposals });
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const dataRoot = await loadSelectedDataRoot(); const registry = await listWorkspaces(); await syncPiSkillsForDataRoots(app.getPath('userData'), app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.resolve('skills'), registry.workspaces.map((workspace) => workspace.rootPath));
  migratePiConfigToInstallation(path.join(app.getPath('userData'), 'pi-api-config.json'), registry.workspaces.map((workspace) => workspace.rootPath));
  if (dataRoot) await refreshRuntime(dataRoot);
  const startupMcp = currentMcp(); const startupXhs = currentXhs();
  if (dataRoot && startupMcp && activeRuntime) {
    const startupRuntime = activeRuntime;
    const pending = getLatestAgentTask(startupRuntime.database);
    if (pending?.intent === 'daily_intelligence' && pending.status === 'running' && pending.phase === 'resume_pending') {
      const runKey = `${dataRoot.path}\u0000${pending.businessDate}`;
      const run = withRuntimeWorker(pending.id, (event) => {
        broadcastPiRuntimeProgress(event);
        if (event.type === 'agent_task') broadcastPiEvent(event);
      }, (hooks) => startWorkspaceDailyIntelligence({
        dataRootPath: dataRoot.path,
        businessDate: pending.businessDate,
        mcpUrl: startupMcp.url,
        xhsMcpUrl: startupXhs?.getUrl() || '',
        activeRuntime: startupRuntime,
        ...hooks
      })).finally(() => dailyRuns.delete(runKey));
      dailyRuns.set(runKey, run);
    }
  }
  registerSettingsConfigIpc({ loadSelectedDataRoot, chooseDataRoot, listWorkspaces, switchWorkspace, createUkWorkspace, listWorkspaceProposals: workspaceConfirmation.list, selectWorkspaceProposalRoot: workspaceConfirmation.selectRoot, confirmWorkspaceProposal: workspaceConfirmation.confirm, getMcp: currentMcp, getXhs: currentXhs, getBrowser: currentBrowser, getRuntimeEpoch: () => activeRuntime?.identity.runtimeEpoch ?? null, stopPi: async () => { await activeRuntime?.stopWorker(); }, browserProfileOwner });
  protocol.handle('wmb-asset', async (request) => {
    try {
      const dataRoot = await loadSelectedDataRoot();
      if (!dataRoot) return new Response('No data root', { status: 404 });
      const raw = request.url.replace(/^wmb-asset:\/\//i, '').replace(/\/$/, '');
      const assetId = decodeURIComponent(raw.split(/[?#]/)[0] || '');
      if (!assetId) return new Response('Missing asset id', { status: 400 });
      const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
      try {
        const asset = getAsset(database, assetId);
        if (!asset) return new Response('Asset not found', { status: 404 });
        const absolute = path.join(dataRoot.path, ...asset.relativePath.split('/'));
        const bytes = await readFile(absolute);
        return new Response(bytes, {
          headers: {
            'Content-Type': asset.mimeType || guessImageMime(absolute),
            'Cache-Control': 'no-cache'
          }
        });
      } finally {
        database.close();
      }
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  });
  ipcMain.handle('pi-runtime:get', async () => {
    const dataRoot = await loadSelectedDataRoot();
    return getPiRuntimeInfo(dataRoot?.path ?? null);
  });
  ipcMain.handle('pi-runtime:update', async (_event, sourceRuntimeRoot: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    return updatePiRuntime(dataRoot.path, sourceRuntimeRoot);
  });
  ipcMain.handle('pi-runtime:rollback', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    return rollbackPiRuntime(dataRoot.path);
  });
  ipcMain.handle('pi:conversation-get', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) {
      return {
        id: '',
        title: '新会话',
        sessionFile: '',
        sessionId: null,
        messages: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      };
    }
    return readPiConversation(dataRoot.path);
  });
  ipcMain.handle('pi:conversation-list', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    return listPiConversations(dataRoot.path);
  });
  ipcMain.handle('pi:conversation-new', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const worker = currentPi();
    if (worker) { try { if (worker.isActive) await worker.abort(); } catch {} await activeRuntime?.stopWorker().catch(() => {}); }
    const created = await startNewPiConversation(dataRoot.path);
    activeRuntime?.setPiSessionFile(created.sessionFile);
    return created;
  });
  ipcMain.handle('pi:conversation-switch', async (_event, conversationId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    if (!conversationId) throw new Error('请选择会话。');
    const worker = currentPi();
    if (worker) { try { if (worker.isActive) await worker.abort(); } catch {} await activeRuntime?.stopWorker().catch(() => {}); }
    const switched = await switchPiConversation(dataRoot.path, conversationId);
    activeRuntime?.setPiSessionFile(switched.sessionFile);
    return switched;
  });
  ipcMain.handle('pi:conversation-archive', async (_event, conversationId: string, archived: boolean) => { const dataRoot = await loadSelectedDataRoot(); if (!dataRoot) throw new Error('请先选择数据根目录。'); if (!conversationId) throw new Error('请选择会话。'); const worker = currentPi(); if (archived && worker?.isActive) throw new Error('Pi 正在回复，完成或停止后再归档。'); const current = await readPiConversation(dataRoot.path); if (archived && current.id === conversationId && worker) await activeRuntime?.stopWorker().catch(() => {}); const selected = await setPiConversationArchived(dataRoot.path, conversationId, archived); activeRuntime?.setPiSessionFile(selected.sessionFile); return selected; });
  registerPiDockIpc({
    loadSelectedDataRoot,
    ensurePi,
    getPi: currentPi,
    getPiSessionFile: () => activeRuntime?.getPiSessionFile() ?? null,
    setPiSessionFile: (sessionFile) => { activeRuntime?.setPiSessionFile(sessionFile); }
  });
  ipcMain.handle('agent:start', async (_event, input: { intent: AgentIntent; businessDate: string; contextRefs?: Record<string, unknown> }) => {
    const dataRoot = await loadSelectedDataRoot();
    const runtime = activeRuntime;
    if (!dataRoot || !runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) throw new Error('当前工作空间运行时不可用。');
    const conversation = await readPiConversation(dataRoot.path);
    const result = await uiCommandResult(() => dispatchStartAgentTask(runtime, {
      intent: input.intent, businessDate: input.businessDate, contextRefs: input.contextRefs, piSessionId: conversation.sessionId
    }, { actor: ownerUiActor, requestId: randomUUID() }));
    if (!result.ok) return result;
    broadcastPiEvent({ type: 'agent_task', task: result.data.task });
    return { ok: true, data: result.data.task, error: null, reused: result.data.reused };
  });
  ipcMain.handle('agent:get', async (_event, input: { id?: string; intent?: AgentIntent; businessDate?: string } = {}) => {
    const dataRoot = await loadSelectedDataRoot();
    const runtime = activeRuntime;
    if (!dataRoot || !runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) return null;
    const database = runtime.database;
    if (input.id) return getAgentTask(database, input.id);
    if (input.intent && input.businessDate) return getActiveAgentTask(database, input.intent, input.businessDate) ?? getLatestAgentTask(database, input.intent, input.businessDate);
    return getLatestAgentTask(database);
  });
  ipcMain.handle('agent:request-id', (_event, input: { taskId: string; logicalStep: string }) => agentRequestId(input.taskId, input.logicalStep));
  ipcMain.handle('agent:update-phase', async (_event, input: { id: string; phase: string; piSessionId?: string | null }) => {
    const runtime = activeRuntime;
    if (!runtime) throw new Error('当前工作空间运行时不可用。');
    const result = await uiCommandResult(() => dispatchUpdateAgentTaskPhase(runtime, input.id, input.phase, { piSessionId: input.piSessionId }, { actor: ownerUiActor, requestId: randomUUID(), taskId: input.id }));
    if (result.ok) broadcastPiEvent({ type: 'agent_task', task: result.data });
    return result;
  });
  ipcMain.handle('agent:complete', async (_event, id: string) => {
    const runtime = activeRuntime;
    if (!runtime) throw new Error('当前工作空间运行时不可用。');
    const result = await uiCommandResult(() => dispatchCompleteAgentTask(runtime, id, { actor: ownerUiActor, requestId: randomUUID(), taskId: id }));
    if (result.ok) broadcastPiEvent({ type: 'agent_task', task: result.data });
    return result;
  });
  ipcMain.handle('agent:fail', async (_event, input: { id: string; errorCode: string; errorMessage: string }) => {
    const runtime = activeRuntime;
    if (!runtime) throw new Error('当前工作空间运行时不可用。');
    const result = await uiCommandResult(() => dispatchFailAgentTask(runtime, input.id, input.errorCode, input.errorMessage, { actor: ownerUiActor, requestId: randomUUID(), taskId: input.id }));
    if (result.ok) broadcastPiEvent({ type: 'agent_task', task: result.data });
    return result;
  });
  ipcMain.handle('agent:cancel', async (_event, id: string) => {
    const runtime = activeRuntime;
    if (!runtime) throw new Error('当前工作空间运行时不可用。');
    if (currentPi()?.isActive) await currentPi()?.abortTurn().catch(() => {});
    const result = await uiCommandResult(() => dispatchCancelAgentTask(runtime, id, { actor: ownerUiActor, requestId: randomUUID(), taskId: id }));
    if (result.ok) broadcastPiEvent({ type: 'agent_task', task: result.data });
    return result;
  });
  ipcMain.handle('agent:control-daily', async (_event, input: { id: string; action: 'skip_source' | 'save_partial' | 'cancel' }) => {
    const runtime = activeRuntime;
    if (!runtime) throw new Error('当前工作空间运行时不可用。');
    const result = await uiCommandResult(() => dispatchRequestAgentTaskControl(runtime, input.id, input.action, { actor: ownerUiActor, requestId: randomUUID(), taskId: input.id }));
    if (result.ok) {
      broadcastPiEvent({ type: 'agent_task', task: result.data });
      await abortDailyIntelligence(input.id);
    }
    return result;
  });
  ipcMain.handle('agent:start-daily-intelligence', async (_event, input: { businessDate: string; modules?: Array<'official_web' | 'x_lists'> }) => {
    const businessDate = input?.businessDate?.trim();
    if (!businessDate) throw new Error('请选择今日情报日期。');
    const dataRoot = await loadSelectedDataRoot();
    const runtime = activeRuntime;
    if (!dataRoot || !runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) throw new Error('当前工作空间运行时不可用。');
    const mcp = currentMcp();
    if (!mcp) throw new Error('WMB MCP 尚未就绪。');
    const active = getActiveAgentTask(runtime.database, 'daily_intelligence', businessDate);
    const previous = getLatestAgentTask(runtime.database, 'daily_intelligence', businessDate);
    const runKey = `${dataRoot.path}\u0000${businessDate}`;
    if (active && (dailyRuns.has(runKey) || active.phase !== 'resume_pending')) { broadcastPiEvent({ type: 'agent_task', task: active }); return { ok: true, data: { task: active, reused: true }, error: null }; }
    let coordinatorError: unknown = null;
    const run = withRuntimeWorker(active?.id ?? null, (event) => {
      broadcastPiRuntimeProgress(event);
      if (event.type === 'agent_task') broadcastPiEvent(event);
    }, (hooks) => startWorkspaceDailyIntelligence({
      dataRootPath: dataRoot.path, businessDate, modules: input.modules, mcpUrl: mcp.url, xhsMcpUrl: currentXhs()?.getUrl() || '', activeRuntime: runtime, ...hooks
    })).then((result) => { broadcastPiEvent({ type: 'agent_task', task: result.task }); return result; }).catch((error) => {
      coordinatorError = error; broadcastPiEvent({ type: 'failed', error: error instanceof Error ? error.message : String(error) }); return null;
    }).finally(() => dailyRuns.delete(runKey));
    // Task is created early in the channel run. Poll briefly instead of awaiting full scan.
    let task = getActiveAgentTask(runtime.database, 'daily_intelligence', businessDate) ?? getLatestAgentTask(runtime.database, 'daily_intelligence', businessDate);
    const startedAt = Date.now();
    while ((!task || (task.id === previous?.id && !active && task.status !== 'running')) && Date.now() - startedAt < 2_500) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 40); });
      task = getActiveAgentTask(runtime.database, 'daily_intelligence', businessDate) ?? getLatestAgentTask(runtime.database, 'daily_intelligence', businessDate);
    }
    if (!task || (task.id === previous?.id && !active && task.status !== 'running')) {
      const result = await run;
      if (result) return { ok: true, data: result, error: null };
      const message = coordinatorError instanceof Error ? coordinatorError.message : coordinatorError ? String(coordinatorError) : '每日情报任务未创建。';
      return { ok: false, data: null, error: { code: 'DAILY_INTELLIGENCE_FAILED', message } };
    }
    dailyRuns.set(runKey, run);
    broadcastPiEvent({ type: 'agent_task', task });
    return { ok: true, data: { task, reused: Boolean(active) }, error: null };
  });
  ipcMain.handle('agent:start-studio-draft', async (_event, input: { businessDate: string; projectId: string }) => {
    const dataRoot = await loadSelectedDataRoot();
    const runtime = activeRuntime;
    if (!dataRoot || !runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) throw new Error('当前工作空间运行时不可用。');
    const mcp = currentMcp();
    if (!mcp) throw new Error('WMB MCP 尚未就绪。');
    if (!input.projectId) throw new Error('请先选择内容项目。');
    broadcastPiEvent({ type: 'starting' });
    try {
      const result = await withRuntimeWorker(null, broadcastPiRuntimeProgress, (hooks) => startStudioDraft({
        dataRootPath: dataRoot.path,
        businessDate: input.businessDate,
        projectId: input.projectId,
        mcpUrl: mcp.url,
        xhsMcpUrl: currentXhs()?.getUrl() || '',
        activeRuntime: runtime,
        ...hooks
      }));
      broadcastPiEvent({ type: 'agent_task', task: result.task });
      broadcastPiEvent({ type: result.task.status === 'failed' ? 'failed' : 'idle', text: result.task.status });
      return { ok: true, data: result, error: null };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      broadcastPiEvent({ type: 'failed', error: messageText });
      return { ok: false, data: null, error: { code: 'STUDIO_DRAFT_FAILED', message: messageText } };
    }
  });
  ipcMain.handle('agent:start-results-review', async (_event, input: { businessDate: string; publicationId: string }) => {
    const dataRoot = await loadSelectedDataRoot();
    const runtime = activeRuntime;
    if (!dataRoot || !runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) throw new Error('当前工作空间运行时不可用。');
    const mcp = currentMcp();
    if (!mcp) throw new Error('WMB MCP 尚未就绪。');
    if (!input.publicationId) throw new Error('请先选择已发布内容。');
    broadcastPiEvent({ type: 'starting' });
    try {
      const result = await withRuntimeWorker(null, broadcastPiRuntimeProgress, (hooks) => startResultsReview({
        dataRootPath: dataRoot.path,
        businessDate: input.businessDate,
        publicationId: input.publicationId,
        mcpUrl: mcp.url,
        xhsMcpUrl: currentXhs()?.getUrl() || '',
        activeRuntime: runtime,
        ...hooks
      }));
      broadcastPiEvent({ type: 'agent_task', task: result.task });
      broadcastPiEvent({ type: result.task.status === 'failed' ? 'failed' : 'idle', text: result.task.status });
      return { ok: true, data: result, error: null };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      broadcastPiEvent({ type: 'failed', error: messageText });
      return { ok: false, data: null, error: { code: 'RESULTS_REVIEW_FAILED', message: messageText } };
    }
  });
  ipcMain.handle('settings:open-logs', async () => { const dataRoot = await loadSelectedDataRoot(); if (!dataRoot) throw new Error('请先选择数据根目录。'); const error = await shell.openPath(path.join(dataRoot.path, 'logs')); if (error) throw new Error(error); });
  ipcMain.handle('link:open', async (_event, value: string) => { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许打开网页链接。'); await shell.openExternal(url.toString()); });
  registerKnowledgeContentIpc({ loadSelectedDataRoot, migrate, getActiveRuntime: () => activeRuntime });
  registerExecutionGrantIpc(ipcMain, () => activeRuntime);
  registerPublishingResultsIpc({ getActiveRuntime: () => activeRuntime, setBrowser: (runtime): WorkspaceRuntimeLease => { if (!runtime) { activeRuntime?.releaseBrowser(); throw new Error('发布浏览器运行时不可为空。'); } if (!activeRuntime?.isActive) throw new Error('当前工作空间运行时不可用。'); return activeRuntime.bindBrowser(runtime, { stop: async () => { await disposeXListSessions(); await stopManagedBrowsers(); } }); } });
 registerIntelligenceChannelsIpc({ loadSelectedDataRoot, channelProposals, getActiveRuntime: () => activeRuntime }); registerXListIpc({ loadSelectedDataRoot, getActiveRuntime: () => activeRuntime, setBrowser: (runtime): WorkspaceRuntimeLease => { if (!runtime) { activeRuntime?.releaseBrowser(); throw new Error('X 浏览器运行时不可为空。'); } if (!activeRuntime?.isActive) throw new Error('当前工作空间运行时不可用。'); return activeRuntime.bindBrowser(runtime, { stop: async () => { await disposeXListSessions(); await stopManagedBrowsers(); } }); }, wakeObservationScheduler: () => activeRuntime?.getScheduler<XObservationScheduler>()?.wake() }); registerXhsIpc({ loadSelectedDataRoot, getXhs: currentXhs, setXhs: (runtime) => { activeRuntime?.setXhs(runtime); }, refreshXhs: (dataRoot) => refreshXhsRuntime(dataRoot, currentXhs()) });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void (async () => {
    const runtime = activeRuntime;
    try {
      if (currentPi()?.isActive) await currentPi()?.abortTurn().catch(() => {});
      await runtime?.closeClaimsAndDrain().catch(() => {});
      await runtime?.stop({ drain: false }).catch(() => {});
    } finally {
      if (activeRuntime === runtime) activeRuntime = null;
      app.exit(0);
    }
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
