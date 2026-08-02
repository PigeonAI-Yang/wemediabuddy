import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { readSettings } from './settings';
import { startMcp, type McpRuntime } from './mcp';
import type { XhsMcpRuntime } from './xiaohongshu-mcp';
import { refreshXhsRuntime, registerXhsIpc } from './ipc-xhs';
import { discoverBrowserProfiles, readBrowserConfig, saveBrowserConfig, startBrowser, stopManagedBrowsers, type BrowserRuntime } from './browser';
import { migratePiConfigToInstallation, resolvePiConfig } from './pi-config';
import { ensurePiConversationLayout, listPiConversations, readPiConversation, startNewPiConversation, switchPiConversation, writePiConversation } from './pi-conversation';
import { PiRpcSupervisor } from './pi-runtime';
import { getPiRuntimeInfo, resolvePiRuntimeRoot, piCliFromRuntimeRoot, updatePiRuntime, rollbackPiRuntime } from './pi-runtime-manager';
import {
  agentRequestId,
  cancelAgentTask,
  completeAgentTask,
  failAgentTask,
  getActiveAgentTask,
  getAgentTask,
  getLatestAgentTask,
  requestAgentTaskControl,
  startAgentTask,
  updateAgentTaskPhase,
  type AgentIntent
} from './agent-tasks';
import { createDataRootSelection } from './data-root-selection';
import { assertWorkspaceSwitchable, installWorkspaceIpcGate, WorkspaceRuntimeGate } from './workspace-runtime';
import { abortDailyIntelligence, startResultsReview, startStudioDraft } from './agent-runner'; import { resolveAgentPiPrerequisite } from './agent-prerequisites';
import { readWorkspaceIntelligenceProfile, startWorkspaceDailyIntelligence } from './workspace-intelligence';
import { registerKnowledgeContentIpc } from './ipc-knowledge-content';
import { registerPublishingResultsIpc } from './ipc-publishing-results';
import { broadcastPiEvent, broadcastPiRuntimeProgress, createWindow } from './app-window';
import { visiblePiPrompt } from './pi-persistence';
import { registerSettingsConfigIpc } from './ipc-settings-config';
import { registerPiDockIpc } from './ipc-pi-dock';
import { registerXListIpc } from './ipc-x-lists';
import { getAsset, guessImageMime } from './assets';
import { preparePiExtension } from './pi-extension';
import { WorkspaceProposalStore } from './workspace-proposals';
import { createWorkspaceConfirmation } from './workspace-confirmation';
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
const workspaceGate = new WorkspaceRuntimeGate(); installWorkspaceIpcGate(ipcMain, workspaceGate, ['workspaces:switch', 'workspaces:proposal-confirm']);
const workspaceProposals = new WorkspaceProposalStore();
let mcp: McpRuntime | null = null;
let xhs: XhsMcpRuntime | null = null;
let browser: BrowserRuntime | null = null;
let pi: PiRpcSupervisor | null = null;
let piSessionFile: string | null = null;
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
  if (pi?.isRunning) return pi;
  pi = null;
  const config = resolvePiConfig();
  const layout = await ensurePiConversationLayout(dataRoot.path);
  const conversationForSession = await readPiConversation(dataRoot.path);
  piSessionFile = conversationForSession.sessionFile || layout.sessionFile;
  await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify({
    providers: {
      'wmb-api': {
        baseUrl: config.baseUrl,
        api: config.api,
        apiKey: '$WMB_PI_API_KEY',
        models: [{ id: config.model, name: config.model, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 16000 }]
      }
    }
  }), 'utf8');
  const cli = piCliFromRuntimeRoot(await resolvePiRuntimeRoot(dataRoot.path));
  const conversation = await readPiConversation(dataRoot.path);
  if (!mcp) await refreshMcp(dataRoot);
  if (!mcp) throw new Error('WMB MCP 尚未就绪。');
  const extensionPath = await preparePiExtension(layout.agentDir);
  pi = new PiRpcSupervisor(process.execPath, [
    cli,
    '--mode', 'rpc',
    '--session', piSessionFile || layout.sessionFile,
    '-e', extensionPath,
    '--provider', 'wmb-api',
    '--model', config.model,
    ...(config.thinking ? ['--thinking', config.thinking] : []),
    '--append-system-prompt', '你是 WeMediaBuddy 内置的创作助手 Pi。业务读写只能通过 wmb_* MCP 工具完成，禁止直接写文件或数据库，禁止最终发布。涉及 X List 时只可读取、准备或采集当前根已绑定 List；最终确认只能由用户在 WMB UI 完成。禁止直接写文件或绕过工具操作 X。新主题、新榜单或新文章必须调用 wmb_create_content_project 创建独立项目和首版正文；只有用户明确要求继续修改指定稿件时，才调用 wmb_save_core_version 追加版本。保存后必须按项目 ID 用 wmb_get_content 回读标题、版本号和正文。不得按标题相似度猜测项目归属。回答简洁中文。'
  ], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PI_CODING_AGENT_DIR: layout.agentDir,
    WMB_PI_API_KEY: config.apiKey,
    WMB_MCP_URL: mcp.url,
    WMB_XHS_MCP_URL: xhs?.getUrl() || ''
  }, (event) => {
    const dockEvent = event.type === 'queue_update'
      ? {
        ...event,
        steering: Array.isArray(event.steering) ? event.steering.map((text) => visiblePiPrompt(String(text))) : [],
        followUp: Array.isArray(event.followUp) ? event.followUp.map((text) => visiblePiPrompt(String(text))) : []
      }
      : event;
    broadcastPiRuntimeProgress(dockEvent, 'dock');
    if (event.type === 'wmb_process_crashed') {
      const error = String(event.error ?? 'Pi 进程已退出，可重新发送。');
      broadcastPiEvent({ type: 'failed', error, scope: 'dock' });
      pi = null;
    }
  }, layout.workspace);
  const state = await pi.start();
  const stateData = state.data;
  const sessionId = stateData && typeof stateData === 'object' && 'sessionId' in stateData
    ? String((stateData as { sessionId?: string }).sessionId ?? '')
    : '';
  await writePiConversation(dataRoot.path, {
    id: conversation.id,
    title: conversation.title,
    sessionFile: conversation.sessionFile || layout.sessionFile,
    sessionId: sessionId || conversation.sessionId,
    messages: conversation.messages,
    createdAt: conversation.createdAt
  });
  piSessionFile = conversation.sessionFile || layout.sessionFile;
  return pi;
}

async function refreshMcp(dataRoot: DataRoot | null): Promise<void> {
  await mcp?.close();
  mcp = dataRoot ? await startMcp(dataRoot.path, workspaceGate, { listWorkspaces, proposals: workspaceProposals }) : null;
}
async function refreshXhs(dataRoot: DataRoot | null): Promise<void> {
  xhs = await refreshXhsRuntime(dataRoot && readWorkspaceIntelligenceProfile(dataRoot.path).platforms.includes('xiaohongshu') ? dataRoot : null, xhs);
}
const { loadSelectedDataRoot, chooseDataRoot, migrate, listWorkspaces, switchWorkspace, relaunchCurrentWorkspace, createUkWorkspace } = createDataRootSelection({
  userDataPath: () => app.getPath('userData'),
  chooseDirectory: async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0] ?? null; },
  refreshRuntime: async (dataRoot) => { await refreshMcp(dataRoot); await refreshXhs(dataRoot); },
  canSwitch: async (dataRoot) => assertWorkspaceSwitchable(dataRoot.path, { piActive: Boolean(pi?.isActive), dailyRunCount: dailyRuns.size }),
  closeMutationGate: () => workspaceGate.closeAndDrain(), openMutationGate: () => workspaceGate.reopen(),
  stopRuntime: async () => { const results = await Promise.allSettled([pi?.stop(), stopManagedBrowsers(), mcp?.close(), xhs?.stop()]); pi = null; browser = null; mcp = null; xhs = null; const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected'); if (failed) throw failed.reason; },
  relaunch: () => { app.relaunch(); app.quit(); }
});
const workspaceConfirmation = createWorkspaceConfirmation({ userDataPath: () => app.getPath('userData'), chooseDirectory: async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0] ?? null; }, loadSelectedDataRoot, relaunchCurrentWorkspace, proposals: workspaceProposals });
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const dataRoot = await loadSelectedDataRoot(); const registry = await listWorkspaces();
  migratePiConfigToInstallation(path.join(app.getPath('userData'), 'pi-api-config.json'), registry.workspaces.map((workspace) => workspace.rootPath));
  await refreshMcp(dataRoot);
  await refreshXhs(dataRoot);
  if (dataRoot && mcp) {
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    const pending = getLatestAgentTask(database);
    database.close();
    if (pending?.intent === 'daily_intelligence' && pending.status === 'running' && pending.phase === 'resume_pending') {
      const run = startWorkspaceDailyIntelligence({
        dataRootPath: dataRoot.path,
        businessDate: pending.businessDate,
        mcpUrl: mcp.url,
        xhsMcpUrl: xhs?.getUrl() || '',
        onEvent: (event) => {
          broadcastPiRuntimeProgress(event);
          if (event.type === 'agent_task') broadcastPiEvent(event);
        }
      }).finally(() => dailyRuns.delete(pending.id));
      dailyRuns.set(pending.id, run);
    }
  }
  registerSettingsConfigIpc({ loadSelectedDataRoot, chooseDataRoot, listWorkspaces, switchWorkspace, createUkWorkspace, listWorkspaceProposals: workspaceConfirmation.list, selectWorkspaceProposalRoot: workspaceConfirmation.selectRoot, confirmWorkspaceProposal: workspaceConfirmation.confirm, getMcp: () => mcp, getXhs: () => xhs, getBrowser: () => browser, stopPi: async () => { await pi?.stop(); pi = null; } });
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
    if (pi) {
      try { if (pi.isActive) await pi.abort(); } catch {}
      await pi.stop().catch(() => {});
      pi = null;
    }
    const created = await startNewPiConversation(dataRoot.path);
    piSessionFile = created.sessionFile;
    return created;
  });
  ipcMain.handle('pi:conversation-switch', async (_event, conversationId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    if (!conversationId) throw new Error('请选择会话。');
    if (pi) {
      try { if (pi.isActive) await pi.abort(); } catch {}
      await pi.stop().catch(() => {});
      pi = null;
    }
    const switched = await switchPiConversation(dataRoot.path, conversationId);
    piSessionFile = switched.sessionFile;
    return switched;
  });
  registerPiDockIpc({
    loadSelectedDataRoot,
    ensurePi,
    getPi: () => pi,
    getPiSessionFile: () => piSessionFile,
    setPiSessionFile: (sessionFile) => { piSessionFile = sessionFile; }
  });
  ipcMain.handle('agent:start', async (_event, input: { intent: AgentIntent; businessDate: string; contextRefs?: Record<string, unknown> }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const started = startAgentTask(database, {
        intent: input.intent,
        businessDate: input.businessDate,
        contextRefs: input.contextRefs,
        piSessionId: (await readPiConversation(dataRoot.path)).sessionId
      });
      if (started.ok) {
        broadcastPiEvent({ type: 'agent_task', task: started.data });
      }
      return started;
    } finally { database.close(); }
  });
  ipcMain.handle('agent:get', async (_event, input: { id?: string; intent?: AgentIntent; businessDate?: string } = {}) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      if (input.id) return getAgentTask(database, input.id);
      if (input.intent && input.businessDate) {
        return getActiveAgentTask(database, input.intent, input.businessDate)
          ?? getLatestAgentTask(database, input.intent, input.businessDate);
      }
      return getLatestAgentTask(database);
    } finally { database.close(); }
  });
  ipcMain.handle('agent:request-id', (_event, input: { taskId: string; logicalStep: string }) => agentRequestId(input.taskId, input.logicalStep));
  ipcMain.handle('agent:update-phase', async (_event, input: { id: string; phase: string; piSessionId?: string | null }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const updated = updateAgentTaskPhase(database, input.id, input.phase, { piSessionId: input.piSessionId });
      if (updated.ok) broadcastPiEvent({ type: 'agent_task', task: updated.data });
      return updated;
    } finally { database.close(); }
  });
  ipcMain.handle('agent:complete', async (_event, id: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const completed = completeAgentTask(database, id);
      if (completed.ok) broadcastPiEvent({ type: 'agent_task', task: completed.data });
      return completed;
    } finally { database.close(); }
  });
  ipcMain.handle('agent:fail', async (_event, input: { id: string; errorCode: string; errorMessage: string }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const failed = failAgentTask(database, input.id, input.errorCode, input.errorMessage);
      if (failed.ok) broadcastPiEvent({ type: 'agent_task', task: failed.data });
      return failed;
    } finally { database.close(); }
  });
  ipcMain.handle('agent:cancel', async (_event, id: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      if (pi?.isActive) await pi.abortTurn().catch(() => {});
      const cancelled = cancelAgentTask(database, id);
      if (cancelled.ok) broadcastPiEvent({ type: 'agent_task', task: cancelled.data });
      return cancelled;
    } finally { database.close(); }
  });
  ipcMain.handle('agent:control-daily', async (_event, input: { id: string; action: 'skip_source' | 'save_partial' | 'cancel' }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const requested = requestAgentTaskControl(database, input.id, input.action);
      if (requested.ok) {
        broadcastPiEvent({ type: 'agent_task', task: requested.data });
        await abortDailyIntelligence(input.id);
      }
      return requested;
    } finally { database.close(); }
  });
  ipcMain.handle('agent:start-daily-intelligence', async (_event, businessDate: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    if (!mcp) await refreshMcp(dataRoot);
    if (!mcp) throw new Error('WMB MCP 尚未就绪。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    const prerequisite = resolveAgentPiPrerequisite(database, { intent: 'daily_intelligence', businessDate, contextRefs: { planDate: businessDate } }); if (prerequisite.waiting) { database.close(); return { ok: true, data: prerequisite.waiting, error: null }; }
    const started = startAgentTask(database, { intent: 'daily_intelligence', businessDate, contextRefs: { planDate: businessDate } });
    database.close();
    if (!started.ok) return started;
    if (!dailyRuns.has(started.data.id)) {
      const run = startWorkspaceDailyIntelligence({
        dataRootPath: dataRoot.path,
        businessDate,
        mcpUrl: mcp.url,
      xhsMcpUrl: xhs?.getUrl() || '',
        onEvent: (event) => {
          broadcastPiRuntimeProgress(event);
          if (event.type === 'agent_task') broadcastPiEvent(event);
        }
      }).then((result) => {
        broadcastPiEvent({ type: 'agent_task', task: result.task });
        return result;
      }).catch((error) => {
        broadcastPiEvent({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
      }).finally(() => dailyRuns.delete(started.data.id));
      dailyRuns.set(started.data.id, run);
    }
    broadcastPiEvent({ type: 'agent_task', task: started.data });
    return { ok: true, data: { task: started.data, reused: started.reused === true }, error: null };
  });
  ipcMain.handle('agent:start-studio-draft', async (_event, input: { businessDate: string; projectId: string }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    if (!mcp) await refreshMcp(dataRoot);
    if (!mcp) throw new Error('WMB MCP 尚未就绪。');
    if (!input.projectId) throw new Error('请先选择内容项目。');
    broadcastPiEvent({ type: 'starting' });
    try {
      const result = await startStudioDraft({
        dataRootPath: dataRoot.path,
        businessDate: input.businessDate,
        projectId: input.projectId,
        mcpUrl: mcp.url,
      xhsMcpUrl: xhs?.getUrl() || '',
        onEvent: broadcastPiRuntimeProgress
      });
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
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    if (!mcp) await refreshMcp(dataRoot);
    if (!mcp) throw new Error('WMB MCP 尚未就绪。');
    if (!input.publicationId) throw new Error('请先选择已发布内容。');
    broadcastPiEvent({ type: 'starting' });
    try {
      const result = await startResultsReview({
        dataRootPath: dataRoot.path,
        businessDate: input.businessDate,
        publicationId: input.publicationId,
        mcpUrl: mcp.url,
      xhsMcpUrl: xhs?.getUrl() || '',
        onEvent: broadcastPiRuntimeProgress
      });
      broadcastPiEvent({ type: 'agent_task', task: result.task });
      broadcastPiEvent({ type: result.task.status === 'failed' ? 'failed' : 'idle', text: result.task.status });
      return { ok: true, data: result, error: null };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      broadcastPiEvent({ type: 'failed', error: messageText });
      return { ok: false, data: null, error: { code: 'RESULTS_REVIEW_FAILED', message: messageText } };
    }
  });
  ipcMain.handle('browser:start', async (_event, input: { mode?: 'quiet' | 'visible' | 'headless' } = {}) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    const config = readBrowserConfig(database); const legacyBrowserAllowed = (database.prepare("SELECT intelligence_pack_id AS id FROM workspace_profiles WHERE id='effective'").get() as { id?: string } | undefined)?.id === 'wemedia-intelligence-engine'; database.close();
    if (!config) throw new Error('请先在设置中选择浏览器 profile。');
    if (config.id === 'edge:pyaireader-default' && !legacyBrowserAllowed) throw new Error('此根尚未配置独立浏览器登录态。');
    // Takeover/login should force a fresh visible launch preference even if a quiet runtime is cached.
    browser = await startBrowser(config, { mode: input.mode });
    return { pid: browser.pid, cdpUrl: browser.cdpUrl, profilePath: browser.profilePath, mode: browser.mode };
  });
  ipcMain.handle('settings:open-logs', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const error = await shell.openPath(path.join(dataRoot.path, 'logs'));
    if (error) throw new Error(error);
  });
  ipcMain.handle('link:open', async (_event, value: string) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许打开网页链接。');
    await shell.openExternal(url.toString());
  });
  registerKnowledgeContentIpc({ loadSelectedDataRoot, migrate });
  registerPublishingResultsIpc({ loadSelectedDataRoot, getBrowser: () => browser, setBrowser: (runtime) => { browser = runtime; } });
  registerXListIpc({ loadSelectedDataRoot }); registerXhsIpc({ loadSelectedDataRoot, getXhs: () => xhs, setXhs: (runtime) => { xhs = runtime; }, refreshXhs: (dataRoot) => refreshXhsRuntime(dataRoot, xhs) });
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
    try {
      if (pi?.isActive) await pi.abortTurn().catch(() => {});
      await pi?.stop();
      await stopManagedBrowsers();
      await mcp?.close();
      await xhs?.stop().catch(() => {});
      xhs = null;
    } finally {
      pi = null;
      app.exit(0);
    }
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
