import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDataRoot, validateDataRoot, type DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { readSettings } from './settings';
import { getToday } from './workbench';
import { createProjectFromPlanItem, getStudio, saveCoreVersion, updateProjectTitle } from './content';
import { startMcp, type McpRuntime } from './mcp';
import { discoverBrowserProfiles, readBrowserConfig, saveBrowserConfig, startBrowser, type BrowserRuntime } from './browser';
import { createPublication, getPublicationDetail, listPublicationDetails, preparePublication, reconcileAsNotPublished, recoverInterruptedPublications, transitionPublication } from './publishing';
import { saveAccount, verifyAccount } from './accounts';
import { collectXAccountMetrics, collectXMetrics, identifyXAccount, prepareXImage, prepareXText, prepareXVideo } from './platforms/x';
import { identifyWechatAccount, prepareWechatArticle, readBackWechatArticle } from './platforms/wechat';
import {
  claimDueMetricJobs,
  completeMetricJob,
  failMetricJob,
  listAccountMetricSnapshots,
  listMetricJobs,
  listPublicationMetricSnapshots,
  processDueMetricJobs,
  recoverRunningMetricJobs,
  saveAccountMetricSnapshot,
  savePublicationMetricSnapshot,
  scheduleJobsForPublishedPublications,
  schedulePublicationMetricJobs
} from './metrics';
import { getReview, listReviewBacklinks, listReviews, saveReview } from './reviews';
import { readPiConfig, resolvePiConfig, savePiConfig } from './pi-config';
import { ensurePiConversationLayout, listPiConversations, readPiConversation, startNewPiConversation, switchPiConversation, writePiConversation, type PiChatMessage } from './pi-conversation';
import { PiRpcSupervisor } from './pi-runtime';
import { getPiRuntimeInfo, resolvePiRuntimeRoot, piCliFromRuntimeRoot, updatePiRuntime, rollbackPiRuntime, stagePiRuntimeFromSource } from './pi-runtime-manager';
import {
  agentRequestId,
  cancelAgentTask,
  completeAgentTask,
  failAgentTask,
  getActiveAgentTask,
  getAgentTask,
  getLatestAgentTask,
  recoverInterruptedAgentTasks,
  startAgentTask,
  updateAgentTaskPhase,
  type AgentIntent
} from './agent-tasks';
import { startDailyIntelligence, startResultsReview, startStudioDraft } from './agent-runner';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    icon: path.join(app.getAppPath(), 'images', 'logo.png'),
    backgroundColor: '#090c11',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

const dataRootConfigPath = (): string => path.join(app.getPath('userData'), 'data-root.json');
let mcp: McpRuntime | null = null;
let browser: BrowserRuntime | null = null;
let pi: PiRpcSupervisor | null = null;
let piSessionFile: string | null = null;
let shuttingDown = false;
let recoveredAgentTasks = false;

function broadcastPiEvent(event: Record<string, unknown>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pi:event', event);
  }
}

async function persistPiTurn(dataRootPath: string, userText: string, assistant: PiChatMessage): Promise<void> {
  const current = await readPiConversation(dataRootPath);
  const sessionFile = piSessionFile ?? current.sessionFile;
  const stamped = new Date().toISOString();
  const messages = [
    ...current.messages,
    { role: 'user', text: userText, createdAt: stamped } satisfies PiChatMessage,
    { ...assistant, createdAt: assistant.createdAt ?? stamped }
  ];
  let sessionId = current.sessionId;
  if (pi) {
    try {
      const state = await pi.getState();
      const data = state.data;
      if (data && typeof data === 'object' && 'sessionId' in data && typeof (data as { sessionId?: unknown }).sessionId === 'string') {
        sessionId = (data as { sessionId: string }).sessionId;
      }
    } catch { /* keep previous session id */ }
  }
  await writePiConversation(dataRootPath, {
    id: current.id,
    title: current.title,
    sessionFile,
    sessionId,
    messages,
    createdAt: current.createdAt
  });
}

async function ensurePi(dataRoot: DataRoot): Promise<PiRpcSupervisor> {
  if (pi?.isRunning) return pi;
  pi = null;
  const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
  const config = resolvePiConfig(database);
  database.close();
  const layout = await ensurePiConversationLayout(dataRoot.path);
  const conversationForSession = await readPiConversation(dataRoot.path);
  piSessionFile = conversationForSession.sessionFile || layout.sessionFile;
  await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify({
    providers: {
      'wmb-api': {
        baseUrl: config.baseUrl,
        api: 'openai-responses',
        apiKey: '$WMB_PI_API_KEY',
        models: [{ id: config.model, name: config.model, reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 16000 }]
      }
    }
  }), 'utf8');
  const cli = piCliFromRuntimeRoot(await resolvePiRuntimeRoot(dataRoot.path));
  const conversation = await readPiConversation(dataRoot.path);
  if (!mcp) await refreshMcp(dataRoot);
  if (!mcp) throw new Error('WMB MCP 尚未就绪。');
  const extensionSource = app.isPackaged
    ? path.join(process.resourcesPath, 'extensions', 'wmb-mcp.ts')
    : path.join(app.getAppPath(), '.pi', 'extensions', 'wmb-mcp.ts');
  const extensionPath = path.join(layout.agentDir, 'extensions', 'wmb-mcp.ts');
  await mkdir(path.dirname(extensionPath), { recursive: true });
  await writeFile(extensionPath, await readFile(extensionSource));
  pi = new PiRpcSupervisor(process.execPath, [
    cli,
    '--mode', 'rpc',
    '--session', piSessionFile || layout.sessionFile,
    '--no-builtin-tools',
    '-e', extensionPath,
    '--provider', 'wmb-api',
    '--model', config.model,
    '--append-system-prompt', '你是 WeMediaBuddy 内置的创作助手 Pi。业务读写只能通过 wmb_* MCP 工具完成，禁止直接写文件或数据库，禁止最终发布。回答简洁中文。'
  ], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PI_CODING_AGENT_DIR: layout.agentDir,
    WMB_PI_API_KEY: config.apiKey,
    WMB_MCP_URL: mcp.url
  }, (event) => {
    if (event.type === 'wmb_text_delta') {
      broadcastPiEvent({ type: 'delta', text: String(event.text ?? '') });
      return;
    }
    if (event.type === 'agent_start') broadcastPiEvent({ type: 'running' });
    if (event.type === 'wmb_process_crashed') {
      const error = String(event.error ?? 'Pi 进程已退出，可重新发送。');
      broadcastPiEvent({ type: 'failed', error });
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
  mcp = dataRoot ? await startMcp(dataRoot.path) : null;
}

async function loadSelectedDataRoot(): Promise<DataRoot | null> {
  try {
    const { path: rootPath } = JSON.parse(await readFile(dataRootConfigPath(), 'utf8')) as { path: string };
    const shouldRecover = !recoveredAgentTasks;
    recoveredAgentTasks = true;
    return migrate(await validateDataRoot(rootPath), { recoverAgentTasks: shouldRecover });
  } catch { return null; }
}

async function chooseDataRoot(): Promise<DataRoot | null> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const dataRoot = await openDataRoot(result.filePaths[0]);
  await writeFile(dataRootConfigPath(), JSON.stringify({ path: dataRoot.path }), 'utf8');
  const migrated = migrate(dataRoot);
  await refreshMcp(migrated);
  return migrated;
}
function migrate(dataRoot: DataRoot, options: { recoverAgentTasks?: boolean } = {}): DataRoot {
  const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
  recoverInterruptedPublications(database);
  if (options.recoverAgentTasks) {
    recoverInterruptedAgentTasks(database);
    recoverRunningMetricJobs(database);
    scheduleJobsForPublishedPublications(database);
  }
  database.close();
  return dataRoot;
}

app.whenReady().then(() => {
  void loadSelectedDataRoot().then(refreshMcp);
  ipcMain.handle('data-root:get', loadSelectedDataRoot);
  ipcMain.handle('data-root:choose', chooseDataRoot);
  ipcMain.handle('settings:get', async () => {
    const dataRoot = await loadSelectedDataRoot();
    const settings = dataRoot ? await readSettings(dataRoot.path) : null;
    if (!settings || !dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    const selectedBrowser = readBrowserConfig(database);
    const pi = readPiConfig(database);
    database.close();
    return {
      ...settings,
      mcp: mcp ? { status: 'ready', url: mcp.url } : { status: 'not_started', url: null },
      browser: browser
        ? { status: 'ready', pid: browser.pid, cdpUrl: browser.cdpUrl, profilePath: browser.profilePath }
        : { status: 'not_started' },
      browserOptions: await discoverBrowserProfiles(),
      selectedBrowser,
      pi
    };
  });
  ipcMain.handle('browser:configure', async (_event, id: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const config = (await discoverBrowserProfiles()).find((candidate) => candidate.id === id);
    if (!config) throw new Error('浏览器 profile 不存在。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return saveBrowserConfig(database, config); } finally { database.close(); }
  });
  ipcMain.handle('pi-config:save', async (_event, input: { baseUrl: string; model: string; apiKey?: string }) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密暂不可用。');
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const saved = savePiConfig(database, input);
      await pi?.stop();
      pi = null;
      return saved;
    } finally { database.close(); }
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
  ipcMain.handle('pi:chat', async (_event, message: string) => {
    const raw = message.trim();
    if (!raw) throw new Error('请输入内容。');
    if (pi?.isActive) throw new Error('Pi 正在回复，请稍候。');
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const visibleText = raw.includes('[USER_MESSAGE]\n')
      ? raw.slice(raw.indexOf('[USER_MESSAGE]\n') + '[USER_MESSAGE]\n'.length).trim()
      : raw;
    broadcastPiEvent({ type: 'starting' });
    try {
      const runtime = await ensurePi(dataRoot);
      const result = await runtime.promptUntilSettled(raw, {
        onDelta: (partial) => broadcastPiEvent({ type: 'delta', text: partial })
      });
      const assistant: PiChatMessage = {
        role: 'assistant',
        text: result.text || (result.stopped ? '已停止生成。' : ''),
        ...(result.stopped ? { status: 'stopped' as const } : {})
      };
      await persistPiTurn(dataRoot.path, visibleText || raw, assistant);
      broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: assistant.text });
      return result;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await persistPiTurn(dataRoot.path, visibleText || raw, { role: 'assistant', text: messageText, status: 'failed' }).catch(() => {});
      if (!pi?.isRunning) pi = null;
      broadcastPiEvent({ type: 'failed', error: messageText });
      throw error;
    }
  });
  ipcMain.handle('pi:stop', async () => {
    if (!pi?.isActive) return { stopped: false };
    await pi.abortTurn();
    return { stopped: true };
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
  ipcMain.handle('agent:start-daily-intelligence', async (_event, businessDate: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    if (!mcp) await refreshMcp(dataRoot);
    if (!mcp) throw new Error('WMB MCP 尚未就绪。');
    broadcastPiEvent({ type: 'starting' });
    try {
      const result = await startDailyIntelligence({
        dataRootPath: dataRoot.path,
        businessDate,
        mcpUrl: mcp.url,
        onEvent: (event) => {
          if (event.type === 'wmb_text_delta') broadcastPiEvent({ type: 'delta', text: String(event.text ?? '') });
          if (event.type === 'agent_start') broadcastPiEvent({ type: 'running' });
          if (event.type === 'agent_task') broadcastPiEvent(event);
        }
      });
      broadcastPiEvent({ type: 'agent_task', task: result.task });
      broadcastPiEvent({ type: result.task.status === 'succeeded' ? 'idle' : 'failed', text: result.task.status });
      return { ok: true, data: result, error: null };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      broadcastPiEvent({ type: 'failed', error: messageText });
      return { ok: false, data: null, error: { code: 'DAILY_INTELLIGENCE_FAILED', message: messageText } };
    }
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
        onEvent: (event) => {
          if (event.type === 'wmb_text_delta') broadcastPiEvent({ type: 'delta', text: String(event.text ?? '') });
          if (event.type === 'agent_start') broadcastPiEvent({ type: 'running' });
        }
      });
      broadcastPiEvent({ type: 'agent_task', task: result.task });
      broadcastPiEvent({ type: result.task.status === 'succeeded' ? 'idle' : 'failed', text: result.task.status });
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
        onEvent: (event) => {
          if (event.type === 'wmb_text_delta') broadcastPiEvent({ type: 'delta', text: String(event.text ?? '') });
          if (event.type === 'agent_start') broadcastPiEvent({ type: 'running' });
        }
      });
      broadcastPiEvent({ type: 'agent_task', task: result.task });
      broadcastPiEvent({ type: result.task.status === 'succeeded' ? 'idle' : 'failed', text: result.task.status });
      return { ok: true, data: result, error: null };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      broadcastPiEvent({ type: 'failed', error: messageText });
      return { ok: false, data: null, error: { code: 'RESULTS_REVIEW_FAILED', message: messageText } };
    }
  });
  ipcMain.handle('browser:start', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    const config = readBrowserConfig(database);
    database.close();
    if (!config) throw new Error('请先在设置中选择浏览器 profile。');
    browser ??= await startBrowser(config);
    return { pid: browser.pid, cdpUrl: browser.cdpUrl, profilePath: browser.profilePath };
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
  ipcMain.handle('window:control', (event, action: 'minimize' | 'maximize' | 'close') => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') window.close();
    return window.isMaximized();
  });
  ipcMain.handle('today:get', async (_event, planDate: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return getToday(database, planDate); } finally { database.close(); }
  });
  ipcMain.handle('today:create-project', async (_event, planItemId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return createProjectFromPlanItem(database, planItemId); } finally { database.close(); }
  });
  ipcMain.handle('studio:get', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return getStudio(database); } finally { database.close(); }
  });
  ipcMain.handle('studio:save-core', async (_event, input: { projectId: string; title: string; body: string }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    if (!input?.projectId) throw new Error('请先选择内容项目。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const titled = updateProjectTitle(database, input.projectId, input.title ?? '');
      if (!titled.ok) return titled;
      const body = String(input.body ?? '');
      if (!body.trim()) return { ok: false, data: null, error: { code: 'VALIDATION_ERROR', message: '正文不能为空。' } };
      const version = saveCoreVersion(database, input.projectId, body, 'user');
      return { ok: true, data: { project: titled.data, version }, error: null };
    } finally { database.close(); }
  });
  ipcMain.handle('publish:list', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listPublicationDetails(database); } finally { database.close(); }
  });
  ipcMain.handle('metrics:collect-x', async (_event, publicationId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const publication = getPublicationDetail(database, publicationId)?.publication;
      if (!publication || publication.platform !== 'x' || publication.status !== 'published' || !publication.externalUrl || !publication.publishedAt) {
        throw new Error('只有已发布的 X 内容可以采集指标。');
      }
      schedulePublicationMetricJobs(database, {
        publicationId: publication.id,
        publishedAt: publication.publishedAt,
        sourceUrl: publication.externalUrl,
        platform: publication.platform
      });
      if (!browser) {
        const config = readBrowserConfig(database);
        if (!config) throw new Error('请先在设置中选择浏览器 profile。');
        browser = await startBrowser(config);
      }
      const capture = await collectXMetrics(browser.cdpUrl, publication.externalUrl);
      const now = capture.capturedAt || new Date().toISOString();
      const due = claimDueMetricJobs(database, now);
      const snapshots = [];
      for (const job of due) {
        const payload = job.payload as { publicationId?: string; scheduledFor?: string; sourceUrl?: string };
        if (payload.publicationId !== publication.id) continue;
        const saved = completeMetricJob(database, {
          jobId: job.id,
          publicationId: publication.id,
          scheduledFor: String(payload.scheduledFor || job.dueAt),
          sourceUrl: capture.sourceUrl,
          capturedAt: capture.capturedAt,
          normalized: capture.normalized,
          raw: capture.raw
        });
        if (saved.ok) snapshots.push(saved.data);
        else failMetricJob(database, job.id, saved.error.message);
      }
      const manual = savePublicationMetricSnapshot(database, {
        publicationId: publication.id,
        scheduledFor: now,
        sourceUrl: capture.sourceUrl,
        capturedAt: capture.capturedAt,
        normalized: capture.normalized,
        raw: capture.raw
      });
      if (!manual.ok) throw new Error(manual.error.message);
      return { ...capture, snapshot: manual.data, dueSnapshots: snapshots };
    } finally { database.close(); }
  });
  ipcMain.handle('metrics:schedule', async (_event, publicationId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const publication = getPublicationDetail(database, publicationId)?.publication;
      if (!publication?.externalUrl || !publication.publishedAt || publication.status !== 'published') {
        throw new Error('只有已发布且有 URL 的内容可以创建指标任务。');
      }
      return schedulePublicationMetricJobs(database, {
        publicationId: publication.id,
        publishedAt: publication.publishedAt,
        sourceUrl: publication.externalUrl,
        platform: publication.platform
      });
    } finally { database.close(); }
  });
  ipcMain.handle('metrics:list-jobs', async (_event, publicationId?: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listMetricJobs(database, publicationId); } finally { database.close(); }
  });
  ipcMain.handle('metrics:list-snapshots', async (_event, publicationId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listPublicationMetricSnapshots(database, publicationId); } finally { database.close(); }
  });
  ipcMain.handle('metrics:process-due', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      return await processDueMetricJobs(database, async (platform, sourceUrl) => {
        if (platform !== 'x') throw new Error(`暂不支持平台指标采集：${platform}`);
        if (!browser) {
          const config = readBrowserConfig(database);
          if (!config) throw new Error('请先在设置中选择浏览器 profile。');
          browser = await startBrowser(config);
        }
        return collectXMetrics(browser.cdpUrl, sourceUrl);
      });
    } finally { database.close(); }
  });
  ipcMain.handle('metrics:collect-account-x', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const account = database.prepare(`SELECT id, account_key AS accountKey FROM platform_accounts WHERE platform = 'x'`).get() as { id: string; accountKey: string } | undefined;
      if (!account) throw new Error('请先识别并保存 X 账号。');
      if (!browser) {
        const config = readBrowserConfig(database);
        if (!config) throw new Error('请先在设置中选择浏览器 profile。');
        browser = await startBrowser(config);
      }
      const capture = await collectXAccountMetrics(browser.cdpUrl, account.accountKey);
      return saveAccountMetricSnapshot(database, {
        accountId: account.id,
        platform: 'x',
        sourceUrl: capture.sourceUrl,
        capturedAt: capture.capturedAt,
        normalized: capture.normalized,
        raw: capture.raw
      });
    } finally { database.close(); }
  });
  ipcMain.handle('metrics:list-account-snapshots', async (_event, accountId?: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listAccountMetricSnapshots(database, accountId); } finally { database.close(); }
  });
  ipcMain.handle('reviews:list', async (_event, publicationId?: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listReviews(database, publicationId); } finally { database.close(); }
  });
  ipcMain.handle('reviews:get', async (_event, id: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return getReview(database, id); } finally { database.close(); }
  });
  ipcMain.handle('reviews:save', async (_event, input: {
    id?: string;
    publicationId: string;
    metricSnapshotIds: string[];
    keep?: string[];
    stop?: string[];
    change?: string[];
    summary?: string;
    status?: 'draft' | 'final';
    expectedRevision?: number;
    findings?: Array<{ id?: string; title: string; body: string }>;
  }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return saveReview(database, input); } finally { database.close(); }
  });
  ipcMain.handle('reviews:backlinks', async (_event, input?: { reviewIds?: string[]; findingIds?: string[] }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      return listReviewBacklinks(database, input?.reviewIds ?? [], input?.findingIds ?? []);
    } finally { database.close(); }
  });
  ipcMain.handle('publish:prepare-x', async (_event, platformVersionId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    if (!browser) {
      const configDatabase = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
      const config = readBrowserConfig(configDatabase);
      configDatabase.close();
      if (!config) throw new Error('请先在设置中选择浏览器 profile。');
      browser = await startBrowser(config);
    }
    const identity = await identifyXAccount(browser.cdpUrl);
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const existing = database.prepare("SELECT id FROM platform_accounts WHERE platform = 'x'").get() as { id: string } | undefined;
      if (existing) {
        const verified = verifyAccount(database, identity);
        if (!verified.ok) return verified;
      }
      const account = existing ?? saveAccount(database, identity);
      const version = database.prepare("SELECT body, format, asset_ids_json AS assets FROM platform_versions WHERE id = ? AND platform = 'x'").get(platformVersionId) as { body: string; format: string; assets: string } | undefined;
      const assetIds = version ? JSON.parse(version.assets) as string[] : [];
      if (!version || !((version.format === 'text' && !assetIds.length) || (['image', 'video'].includes(version.format) && assetIds.length === 1))) throw new Error('X 版本必须是纯文字、正文加一张图片或正文加一个视频。');
      const reusable = database.prepare(`SELECT id FROM publications
        WHERE platform_version_id = ? AND account_id = ? AND status IN ('draft', 'failed', 'needs_user')
        ORDER BY updated_at DESC LIMIT 1`).get(platformVersionId, account.id) as { id: string } | undefined;
      const created = reusable ? { ok: true as const, data: getPublicationDetail(database, reusable.id)!.publication, error: null } : createPublication(database, { platformVersionId, accountId: account.id });
      if (!created.ok) return created;
      const asset = assetIds.length ? database.prepare('SELECT id, relative_path AS relativePath, mime_type AS mimeType FROM assets WHERE id = ?').get(assetIds[0]) as { id: string; relativePath: string; mimeType: string } | undefined : undefined;
      if (assetIds.length && !asset) throw new Error('绑定图片不存在。');
      const readback = asset
        ? version.format === 'video'
          ? await prepareXVideo(browser.cdpUrl, version.body, path.join(dataRoot.path, asset.relativePath), asset.id)
          : await prepareXImage(browser.cdpUrl, version.body, path.join(dataRoot.path, asset.relativePath), asset.id)
        : await prepareXText(browser.cdpUrl, version.body);
      return preparePublication(database, { publicationId: created.data.id, expectedRevision: created.data.revision, editorTitle: null, editorBody: readback.body, editorAssetIds: readback.assetIds, editorEvidenceUrl: readback.evidenceUrl });
    } finally { database.close(); }
  });
  ipcMain.handle('publish:prepare-wechat-article', async (_event, platformVersionId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      if (!browser) {
        const config = readBrowserConfig(database);
        if (!config) throw new Error('请先在设置中选择浏览器 profile。');
        browser = await startBrowser(config);
      }
      const identity = await identifyWechatAccount(browser.cdpUrl);
      const existing = database.prepare("SELECT id FROM platform_accounts WHERE platform = 'wechat'").get() as { id: string } | undefined;
      if (existing) {
        const verified = verifyAccount(database, identity);
        if (!verified.ok) return verified;
      }
      const account = existing ?? saveAccount(database, identity);
      const version = database.prepare("SELECT title, body, format, asset_ids_json AS assets FROM platform_versions WHERE id = ? AND platform = 'wechat'").get(platformVersionId) as { title: string | null; body: string; format: string; assets: string } | undefined;
      if (!version?.title || !version.body.trim() || version.format !== 'article') throw new Error('微信公众号版本必须包含非空标题和正文。');
      const reusable = database.prepare(`SELECT id FROM publications
        WHERE platform_version_id = ? AND account_id = ? AND status IN ('draft', 'failed', 'needs_user')
        ORDER BY updated_at DESC LIMIT 1`).get(platformVersionId, account.id) as { id: string } | undefined;
      const created = reusable ? { ok: true as const, data: getPublicationDetail(database, reusable.id)!.publication, error: null } : createPublication(database, { platformVersionId, accountId: account.id });
      if (!created.ok) return created;
      const readback = await prepareWechatArticle(browser.cdpUrl, version.title, version.body);
      return preparePublication(database, { publicationId: created.data.id, expectedRevision: created.data.revision, editorTitle: readback.title, editorBody: readback.body, editorAssetIds: readback.assetIds, editorEvidenceUrl: readback.evidenceUrl });
    } finally { database.close(); }
  });
  ipcMain.handle('publish:readback-wechat', async (_event, publicationId: string, expectedRevision: number, articleUrl: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const detail = getPublicationDetail(database, publicationId);
      if (!detail || detail.publication.platform !== 'wechat' || !detail.payload?.title) throw new Error('微信公众号发布记录或标题不存在。');
      if (!browser) {
        const config = readBrowserConfig(database);
        if (!config) throw new Error('请先在设置中选择浏览器 profile。');
        browser = await startBrowser(config);
      }
      const readback = await readBackWechatArticle(browser.cdpUrl, articleUrl, detail.payload.title);
      return transitionPublication(database, publicationId, 'published', {
        expectedRevision,
        externalUrl: readback.externalUrl,
        externalId: readback.externalId,
        reason: 'manual publication URL readback matched'
      });
    } finally { database.close(); }
  });
  ipcMain.handle('publish:reconcile-not-published', async (_event, publicationId: string, expectedRevision: number) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return reconcileAsNotPublished(database, { publicationId, expectedRevision, evidence: { actor: 'ui', decision: 'not_published' } }); } finally { database.close(); }
  });
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
      browser?.stop();
      await mcp?.close();
    } finally {
      pi = null;
      app.exit(0);
    }
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
