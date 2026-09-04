import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDataRoot, type DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { readSettings } from './settings';
import { startMcp, type McpRuntime } from './mcp';
import type { XhsMcpRuntime } from './xiaohongshu-mcp';
import { refreshXhsRuntime, registerXhsIpc } from './ipc-xhs';
import { stopManagedBrowsers, type BrowserRuntime } from './browser';
import { configureBrowserProfileRegistryPath, openBrowserProfileRegistry } from './browser-config';
import { migratePiConfigToInstallation, readPiConfig, resolveRoleModelPolicySnapshot, resolveRolePiConfigChain, roleModelCandidateKey, savePiConfig, type ResolvedPiConfig } from './pi-config';
import { registerDailyContentCycleIpc } from './ipc-daily-content-cycle.ts';
import { registerDailyContentArticleIpc } from './ipc-daily-content-article.ts';
import { registerContentDerivativeIpc } from './ipc-content-derivative.ts';
import { registerDailyIterationIpc } from './ipc-daily-iteration.ts';
import { startPiRuntimeWithFallback } from './pi-config-fallback';
import { setSourceKnowledgeCompileDeps, stopPersistentKnowledgeJobs, type SourceKnowledgeCompileDeps } from './knowledge-compile-trigger';
import { createKnowledgeBackfillCompile, setKnowledgeBackfillDeps, stopKnowledgeBackfillJobs, type KnowledgeBackfillDeps } from './knowledge-backfill';
import { KnowledgeMaintenanceScheduler, type KnowledgeMaintenanceDeps } from './knowledge-maintenance';
import { ensurePiConversationLayout, listPiConversations, readPiConversation, setPiConversationArchived, startNewPiConversation, switchPiConversation, writePiConversation } from './pi-conversation'; import { PI_AUTHORITY_SYSTEM_PROMPT, skillSourcePath } from './pi-operator-skill'; import { syncPiSkillsForDataRoots } from './pi-skill-library';
import { humanizePiProviderError, isPiProviderFallbackError, PiRpcSupervisor } from './pi-runtime';
import { piModelsJson } from './pi-model';
import { getPiRuntimeInfo, resolvePiRuntimeRoot, piCliFromRuntimeRoot, piVisionExtensionFromRuntimeRoot, updatePiRuntime, rollbackPiRuntime } from './pi-runtime-manager';
import {
  agentRequestId,
  getActiveAgentTask,
  getAgentTask,
  type AgentIntent
} from './agent-tasks';
import { dispatchReapOrphanedPageTasks } from './page-task-orphan.ts';
import {
  dispatchCancelAgentTask,
  dispatchCompleteAgentTask,
  dispatchFailAgentTask,
  dispatchPartialAgentTask,
  dispatchReportAgentTaskProgress,
  dispatchRequestAgentTaskControl,
  dispatchStartAgentTask,
  dispatchUpdateAgentTaskPhase
} from './agent-task-commands.ts';
import { cancelManagerDailyIntelligence, readManagerProjection } from './manager-dispatch.ts';
import { createDataRootSelection } from './data-root-selection';
import { ActiveWorkspaceRuntime, assertWorkspaceSwitchable, installActiveWorkspaceIpcGate, RUNTIME_MANAGING_IPC_CHANNELS, type WorkspaceRuntimeLease } from './workspace-runtime';
import { initializeWorkspaceOrchestratorRuntime, submitWorkspaceOrchestratorIntent } from './workspace-orchestrator-runtime.ts';
import { wakeWorkspaceOrchestratorExecutor } from './workspace-orchestrator-executor.ts';
import { abortDailyIntelligence, startResultsReview, startStudioDraft } from './agent-runner';
import { readProjectInvestigation } from './project-investigation.ts';
import { controlAuditMessage, dailyControlAuditEnabled } from './daily-control-policy.ts';
import { readWorkspaceIntelligenceProfile } from './workspace-intelligence';
import { DailyScanScheduler } from './daily-scan-scheduler';
import { DailyOrchestrationScheduler } from './daily-orchestration-scheduler.ts';
import { shanghaiDate } from './ferment';
import { hasEnabledDailySources } from './daily-intelligence-channels';
import { syncOfficialWebsiteSources } from './intelligence-channels.ts';
import { requireWorkspaceProfile } from './workspace-profiles.ts';
import { registerKnowledgeContentIpc } from './ipc-knowledge-content';
import { ensureJobsSpawner, registerJobsIpc, resetJobsIpcSpawner, resumePendingInvestigationSupervisorReviews } from './ipc-jobs.ts'; import { startTopicReproposalScheduler } from './topic-maintenance-reproposal.ts'; import { startResearchSuccessorScheduler } from './research-successor.ts';
import { setActiveJobSpawner } from './job-spawner.ts';
import { startMediaGovernanceScheduler } from './media-governance-lifecycle.ts';
import { setDeskJobNotifyBridges } from './manager-job-notify.ts';
import { registerPublishingResultsIpc } from './ipc-publishing-results';
import { dispatchRecoverInterruptedPublications } from './publication-commands.ts';
import { dispatchRecoverRunningMetricJobs, dispatchSchedulePublishedPublicationMetricJobs } from './metric-commands.ts';
import { ensureAutomaticTaskGrant } from './task-grants.ts';
import { registerExecutionGrantIpc } from './ipc-execution-grants';
import { broadcastPiEvent, broadcastPiRuntimeProgress, createWindow } from './app-window';
import { registerSettingsConfigIpc } from './ipc-settings-config';
import { registerPiDockIpc } from './ipc-pi-dock';
import { registerXListIpc } from './ipc-x-lists'; import { dispatchRecoverOrphanedXListOperations } from './x-list-business-command'; import { activeXListOperationIds } from './x-list-execution'; import { registerIntelligenceChannelsIpc } from './ipc-intelligence-channels';
import { registerIllustrationWorkflowIpc, resumePendingIllustrationRuns } from './illustration-workflow.ts';
import { getAsset, guessImageMime } from './assets';
import { preparePiExtension } from './pi-extension';
import { WorkspaceProposalStore } from './workspace-proposals'; import { IntelligenceChannelProposalStore } from './intelligence-channel-proposals'; import { createWorkspaceConfirmation } from './workspace-confirmation';
import { XObservationScheduler } from './x-observation-scheduler'; import { disposeXListSessions } from './platforms/x-list-session'; import { createBrowserProfileOwner } from './browser-profile-owner';
import { KnowledgeLintScheduler, registerKnowledgeChangeSetLintTrigger } from './knowledge-health';
import { MediaArchiveScheduler } from './media-archive-worker';
import { SourceBodyArchiveScheduler } from './source-body-archive';
import { installProductionWikiIndexProjection } from './wiki-index-triggers';
import { runLegacyKnowledgeInitAtStartup } from './legacy-knowledge-init';
import { handleSquirrelLifecycle } from './squirrel-lifecycle';
import { createDesktopLifecycle } from './desktop-lifecycle';
import { initSystemProxy, proxyEnvForChildren } from './proxy-config';
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
const dailyControlInflight = new Map<string, Promise<{ ok: boolean; data: unknown; error: { code: string; message: string; details?: Readonly<Record<string, unknown>> } | null }>>(); let activeRuntime: ActiveWorkspaceRuntime | null = null;
installActiveWorkspaceIpcGate(ipcMain, () => activeRuntime, [...RUNTIME_MANAGING_IPC_CHANNELS]);
const workspaceProposals = new WorkspaceProposalStore(); const channelProposals = new IntelligenceChannelProposalStore();
const currentMcp = () => activeRuntime?.getMcp<McpRuntime>() ?? null; const currentXhs = () => activeRuntime?.getXhs<XhsMcpRuntime>() ?? null;
const currentBrowser = () => activeRuntime?.getBrowser<BrowserRuntime>() ?? null; const currentPi = () => activeRuntime?.getWorker<PiRpcSupervisor>() ?? null;
let lastEnsuredPiProfileId: string | null = null; const ownerUiActor = { type: 'owner_ui' as const, id: 'renderer', label: 'Owner UI' };
async function uiCommandResult<T>(work: () => Promise<T>): Promise<{ ok: true; data: T; error: null } | { ok: false; data: null; error: { code: string; message: string; details?: Readonly<Record<string, unknown>> } }> {
  try { return { ok: true, data: await work(), error: null }; }
  catch (error) {
    const value = error as { code?: unknown; message?: unknown; details?: Readonly<Record<string, unknown>> };
    return { ok: false, data: null, error: { code: typeof value?.code === 'string' ? value.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error), ...(value?.details ? { details: value.details } : {}) } };
  }
}

async function withRuntimeWorker<T>(
  taskId: string | null,
  onEvent: (event: Record<string, unknown>) => void,
  work: (hooks: { workerLeaseId: string; onTaskReady: (taskId: string) => Promise<string>; onRuntime: (worker: PiRpcSupervisor) => void; onEvent: (event: Record<string, unknown>) => void }) => Promise<T>,
  options: { roleId?: string | null } = {}
): Promise<T> {
  const runtime = activeRuntime;
  if (!runtime) throw new Error('当前工作空间运行时不可用。');
  // Background runners (daily/studio/results) must NOT take the desk lease — that seat is reserved
  // for the Owner↔Desk dock conversation. Occupying desk here surfaces as「Pi worker lease 尚未释放」
  // while 今日 is scanning and the user tries to chat.
  const lease = runtime.acquireWorkerLease(taskId, options.roleId ?? null, 'employee');
  let worker: PiRpcSupervisor | null = null;
  runtime.bindWorker(lease, { stop: async () => { await worker?.stop(); } });
  try {
    return await work({
      workerLeaseId: lease.leaseId,
      onTaskReady: async (value) => {
        runtime.bindWorkerTask(lease, value);
        const role = options.roleId;
        const roleId = role === 'desk' || role === 'reporter' || role === 'planner' || role === 'writer' || role === 'librarian' ? role : null;
        return ensureAutomaticTaskGrant(runtime, value, new Date(), roleId);
      },
      onRuntime: (value) => { worker = value; },
      onEvent: (event) => {
        runtime.guardLease(lease, () => {
          onEvent(event);
          if (event.type === 'fallback-try' || event.type === 'fallback') {
            broadcastPiEvent({
              ...event,
              scope: typeof event.scope === 'string' ? event.scope : 'task'
            });
          }
        });
      }
    });
  } finally { runtime.releaseWorker(lease); }
}
let shuttingDown = false;
app.setAppUserModelId('com.pigeonyang.wemediabuddy');
const handlingSquirrelLifecycle = handleSquirrelLifecycle({ quit: () => app.quit() });
const hasSingleInstanceLock = handlingSquirrelLifecycle ? false : app.requestSingleInstanceLock();
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
/**
 * 在飞的 desk 启动承诺：同一时刻只启动一次 Pi worker，并发的 ensurePi 调用复用同一
 * 启动过程（否则 pi:chat 内 authorize→ensurePageAuthority 与主路径两次 ensurePi 会竞争
 * desk 独占 lease，第二次拿到「当前 Pi worker lease 尚未释放」）。
 */
let deskStartup: Promise<PiRpcSupervisor> | null = null;
async function ensurePi(dataRoot: DataRoot, options: { skipCandidateKeys?: Iterable<string> } = {}): Promise<PiRpcSupervisor> {
  const runtime = activeRuntime;
  if (!runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) throw new Error('当前工作空间运行时不可用。');
  const running = currentPi();
  if (running?.isRunning && !options.skipCandidateKeys) return running;
  if (deskStartup) return deskStartup;
  const startup = (async () => {
    if (running?.isRunning && options.skipCandidateKeys) await runtime.stopWorker().catch(() => {});
    const lease = runtime.acquireWorkerLease(null, null, 'desk');
    const deskPolicySnapshot = resolveRoleModelPolicySnapshot('desk');
    const skipCandidateKeys = new Set(options.skipCandidateKeys ?? []);
    const chain = resolveRolePiConfigChain('desk', deskPolicySnapshot).filter((config) => !skipCandidateKeys.has(roleModelCandidateKey(config.id, config.model)));
    const failures: string[] = [];
    let lastError: unknown;
    try {
      const layout = await ensurePiConversationLayout(dataRoot.path);
      const conversation = await readPiConversation(dataRoot.path, { recoverInterrupted: true });
      runtime.setPiSessionFile(conversation.sessionFile || layout.sessionFile);
      const runtimeRoot = await resolvePiRuntimeRoot(dataRoot.path);
      const mcp = currentMcp();
      if (!mcp) throw new Error('WMB MCP 尚未就绪。');
      const extensionPath = await preparePiExtension(layout.agentDir);
      for (let index = 0; index < chain.length; index += 1) {
        const config = chain[index]!;
        let worker: PiRpcSupervisor | null = null;
        try {
          await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(await piModelsJson({ ...config, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
          worker = new PiRpcSupervisor(process.execPath, [piCliFromRuntimeRoot(runtimeRoot), '--mode', 'rpc', '--session', runtime.getPiSessionFile() || layout.sessionFile, '-e', extensionPath, '-e', piVisionExtensionFromRuntimeRoot(runtimeRoot), '--provider', 'wmb-api', '--model', config.model, ...(config.thinking ? ['--thinking', config.thinking] : []), '--append-system-prompt', PI_AUTHORITY_SYSTEM_PROMPT], {
            ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: layout.agentDir, WMB_PI_API_KEY: config.apiKey, PI_VISION_PROVIDER: 'wmb-api', PI_VISION_MODEL: config.model, PI_VISION_REASONING_EFFORT: 'off', WMB_MCP_URL: mcp.url, WMB_XHS_MCP_URL: currentXhs()?.getUrl() || '', ...proxyEnvForChildren()
          }, (event) => {
            runtime.guardLease(lease, () => {
              broadcastPiRuntimeProgress(event, 'dock');
              if (event.type === 'wmb_process_crashed') {
                broadcastPiEvent({ type: 'failed', error: String(event.error ?? 'Pi 进程已退出，可重新发送。'), scope: 'dock' });
                runtime.releaseWorker(lease);
              }
            });
          }, layout.workspace);
          await worker.start();
          runtime.bindWorker(lease, worker);
          const state = await worker.getState();
          const stateData = state.data;
          let sessionId = '';
          if (stateData && typeof stateData === 'object' && 'sessionId' in stateData) {
            const value = (stateData as { sessionId?: unknown }).sessionId;
            if (typeof value === 'string') sessionId = value;
          }
          await writePiConversation(dataRoot.path, { id: conversation.id, title: conversation.title, sessionFile: conversation.sessionFile || layout.sessionFile, sessionId: sessionId || conversation.sessionId, messages: conversation.messages, createdAt: conversation.createdAt });
          runtime.setPiSessionFile(conversation.sessionFile || layout.sessionFile);
          lastEnsuredPiProfileId = config.id;
          if (failures.length) {
            broadcastPiEvent({
              type: 'fallback',
              scope: 'dock',
              profileId: config.id,
              profileName: config.name,
              model: config.model,
              text: `主服务不可用，已降级到 ${config.name}（${config.model}）`,
              failures,
              roleId: 'desk',
              policyRevision: deskPolicySnapshot.revision
            });
          }
          return worker;
        } catch (error) {
          lastError = error;
          const message = humanizePiProviderError(error instanceof Error ? error.message : String(error));
          failures.push(`${config.name}: ${message}`);
          await worker?.stop().catch(() => {});
          const hasNext = index < chain.length - 1 && isPiProviderFallbackError(error);
          if (!hasNext) break;
          broadcastPiEvent({
            type: 'fallback-try',
            scope: 'dock',
            profileId: config.id,
            profileName: config.name,
            text: `${config.name} 失败，正在尝试下一个 AI 服务…`,
            error: message,
            roleId: 'desk',
            policyRevision: deskPolicySnapshot.revision
          });
        }
      }
      if (lastError && isPiProviderFallbackError(lastError) && failures.length) {
        throw Object.assign(new Error(`角色模型链已耗尽：${failures.join('；')}`), {
          code: 'ROLE_MODEL_CHAIN_EXHAUSTED',
          details: { state: 'needs_user', roleId: 'desk', policyRevision: deskPolicySnapshot.revision, failures: [...failures] },
          failures: [...failures]
        });
      }
      throw lastError instanceof Error ? lastError : new Error(failures.at(-1) || 'Pi 模型服务不可用。');
    } catch (error) {
      runtime.releaseWorker(lease);
      throw error;
    }
  })();
  deskStartup = startup;
  try {
    return await startup;
  } finally {
    if (deskStartup === startup) deskStartup = null;
  }
}

// ---------- WMB-5229：Source 保存后知识编译的后台模型调用（独立 Pi RPC，不占 desk 席） ----------
let knowledgeCompilePi: PiRpcSupervisor | null = null;
let knowledgeCompilePiLock: Promise<void> = Promise.resolve();
let knowledgeCompilePiWorkDir: string | null = null;
const KNOWLEDGE_COMPILE_PROMPT_TIMEOUT_MS = 10 * 60_000;

async function withKnowledgeCompilePi<T>(dataRootPath: string, run: (runtime: PiRpcSupervisor) => Promise<T>): Promise<T> {
  const previous = knowledgeCompilePiLock;
  let release!: () => void;
  knowledgeCompilePiLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    if (!knowledgeCompilePi?.isRunning) {
      const layout = await ensurePiConversationLayout(dataRootPath);
      const extensionPath = await preparePiExtension(layout.agentDir);
      const runtimeRoot = await resolvePiRuntimeRoot(dataRootPath);
      const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-knowledge-compile-'));
      const sessionFile = path.join(layout.agentDir, 'sessions', `knowledge-compile-${randomUUID()}.jsonl`);
      await mkdir(path.dirname(sessionFile), { recursive: true });
      const createRuntime = async (config: ResolvedPiConfig) => {
        await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(await piModelsJson({ ...config, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
        return new PiRpcSupervisor(process.execPath, [
          piCliFromRuntimeRoot(runtimeRoot), '--mode', 'rpc', '--session', sessionFile, '-e', extensionPath,
          '--provider', 'wmb-api', '--model', config.model, ...(config.thinking ? ['--thinking', config.thinking] : []),
          '--append-system-prompt', PI_AUTHORITY_SYSTEM_PROMPT
        ], {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          PI_CODING_AGENT_DIR: layout.agentDir,
          WMB_PI_API_KEY: config.apiKey,
          WMB_XHS_MCP_URL: currentXhs()?.getUrl() ?? '',
          ...proxyEnvForChildren()
        }, (event) => {
          if (event.type === 'wmb_process_crashed') {
            broadcastPiEvent({ type: 'failed', error: String(event.error ?? '知识编译 Pi 进程已退出。'), scope: 'task' });
          }
        }, workDir);
      };
      const started = await startPiRuntimeWithFallback({ roleId: 'desk', createRuntime });
      knowledgeCompilePi = started.runtime;
      knowledgeCompilePiWorkDir = workDir;
    }
    return await run(knowledgeCompilePi!);
  } finally {
    release();
  }
}

async function stopKnowledgeCompileModel(): Promise<void> {
  const pi = knowledgeCompilePi;
  knowledgeCompilePi = null;
  await pi?.stop().catch(() => {});
  if (knowledgeCompilePiWorkDir) await rm(knowledgeCompilePiWorkDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  knowledgeCompilePiWorkDir = null;
}

function createKnowledgeCompileDeps(dataRootPath: string): SourceKnowledgeCompileDeps {
  return {
    databasePath: path.join(dataRootPath, 'wmb.db'),
    modelCall: async (prompt) => {
      const result = await withKnowledgeCompilePi(dataRootPath, async (runtime) =>
        runtime.promptUntilSettled(prompt, { timeoutMs: KNOWLEDGE_COMPILE_PROMPT_TIMEOUT_MS }));
      const text = result.text?.trim();
      if (!text) throw new Error(result.error || 'Pi 没有返回文字。');
      return text;
    }
  };
}

// WMB-5230：回溯编译复用 WMB-5229 同款候选/编译管线（同 requestId 方案，回执去重共享）。
function createKnowledgeBackfillDeps(dataRootPath: string): KnowledgeBackfillDeps {
  return {
    databasePath: path.join(dataRootPath, 'wmb.db'),
    compileSource: createKnowledgeBackfillCompile(createKnowledgeCompileDeps(dataRootPath))
  };
}

// WMB-5236：全库维护 run 依赖（scan_compile 阶段复用上述回溯编译 deps）。
function createMaintenanceDeps(dataRootPath: string): KnowledgeMaintenanceDeps {
  return { backfill: createKnowledgeBackfillDeps(dataRootPath) };
}

async function refreshRuntime(dataRoot: DataRoot): Promise<void> {
  if (activeRuntime?.isActive && activeRuntime.identity.rootPath === path.resolve(dataRoot.path)) return;
  const runtime = ActiveWorkspaceRuntime.open(dataRoot.path, {
    openDatabase: (databasePath) => {
      const database = migrateDatabase(databasePath);
      const profile = requireWorkspaceProfile(database);
      if (profile.intelligencePackId === 'wemedia-intelligence-engine') {
        syncOfficialWebsiteSources(database, skillSourcePath(profile.intelligencePackId));
      }
      return database;
    }
  });
  activeRuntime = runtime;
  // WMB-5229：注册 Source 保存后的知识编译触发依赖（后台独立 Pi RPC，懒启动）。
  setSourceKnowledgeCompileDeps(createKnowledgeCompileDeps(dataRoot.path));
  // WMB-5230：注册存量高价值 Source 分批回溯编译依赖（同款编译管线；checkpoint 可恢复）。
  setKnowledgeBackfillDeps(createKnowledgeBackfillDeps(dataRoot.path));
  try {
    await initializeWorkspaceOrchestratorRuntime(runtime);
    await dispatchRecoverInterruptedPublications(runtime);
    await dispatchRecoverOrphanedXListOperations(runtime, activeXListOperationIds);
    await submitWorkspaceOrchestratorIntent(runtime, {
      producerId: 'reconcile.agent-tasks-recover',
      businessDate: shanghaiDate(),
      requestId: `reconcile.agent-tasks-recover:${runtime.identity.workspaceId}:${runtime.identity.runtimeEpoch}`,
      action: 'stage_d',
      logicalInput: { runtimeEpoch: runtime.identity.runtimeEpoch, reason: 'runtime-refresh' },
      payload: { runtimeEpoch: runtime.identity.runtimeEpoch, reason: 'runtime-refresh' },
      rootMode: 'scheduler'
    });
    await dispatchRecoverRunningMetricJobs(runtime);
    await dispatchSchedulePublishedPublicationMetricJobs(runtime);
    const mcp = await startMcp(dataRoot.path, runtime.gate, { listWorkspaces, proposals: workspaceProposals, channelProposals, runtimeEpoch: runtime.identity.runtimeEpoch }, runtime);
    runtime.setMcp(mcp);
    wakeWorkspaceOrchestratorExecutor(runtime);
    stopTopicReproposalScheduler?.(); stopTopicReproposalScheduler = await startTopicReproposalScheduler(runtime, (input) => submitWorkspaceOrchestratorIntent(runtime, input));
    stopResearchSuccessorScheduler?.(); stopResearchSuccessorScheduler = await startResearchSuccessorScheduler(runtime, ensureJobsSpawner({ getActiveRuntime: () => activeRuntime }), (input) => submitWorkspaceOrchestratorIntent(runtime, input));
    // WMB-5247：媒体治理自动调度（启动立即一轮 + 每 6h 一轮：staging 清理 + 30 天无引用派生缓存 GC）。
    stopMediaGovernanceScheduler?.(); stopMediaGovernanceScheduler = startMediaGovernanceScheduler(runtime);
    const startupHandoffRows = runtime.database.prepare(`
      SELECT id, business_date, phase
      FROM agent_tasks
      WHERE intent IN ('daily_intelligence', 'daily_scan', 'daily_judge')
        AND status='running'
        AND phase IN ('starting', 'channel_scanned', 'scanning')
    `).all() as Array<{ id: string; business_date: string; phase: string }>;
    for (const task of startupHandoffRows) {
      await submitWorkspaceOrchestratorIntent(runtime, {
        producerId: 'startup.refresh-runtime-daily-handoff',
        businessDate: task.business_date,
        requestId: `startup.refresh-runtime-daily-handoff:${runtime.identity.workspaceId}:${task.id}`,
        action: 'stage_d',
        logicalInput: { taskId: task.id, phase: task.phase, businessDate: task.business_date, reason: 'runtime-refresh' },
        payload: { taskId: task.id, phase: task.phase, businessDate: task.business_date, reason: 'runtime-refresh' },
        rootMode: 'scheduler'
      });
    }

    const scheduler = new XObservationScheduler({ runtime, loadSelectedDataRoot, isCurrent: () => activeRuntime === runtime && runtime.isActive });
    runtime.setScheduler(scheduler);
    scheduler.start();
    // WMB-5244：媒体归档调度（渠道媒体冻结异步下载；启动恢复孤儿 running → DOWNLOAD_INTERRUPTED）。
    mediaArchiveSchedulerRef?.stop();
    mediaArchiveSchedulerRef = new MediaArchiveScheduler({
      runtime,
      isCurrent: () => activeRuntime === runtime && runtime.isActive
    });
    mediaArchiveSchedulerRef.start();
    // WMB-5269：Source 正文归档调度（结构化文本已同事务固化；URL-only 排队异步安全抓取；
    // 启动恢复孤儿 running + 历史缺失正文补抓，new_source 优先、历史至多 1 claim/分钟）。
    sourceBodyArchiveSchedulerRef?.stop();
    sourceBodyArchiveSchedulerRef = new SourceBodyArchiveScheduler({
      runtime,
      isCurrent: () => activeRuntime === runtime && runtime.isActive
    });
    sourceBodyArchiveSchedulerRef.start();
    const scanScheduler = new DailyScanScheduler({
      isCurrent: () => activeRuntime === runtime && runtime.isActive,
      run: async (modules) => {
        if (!hasEnabledDailySources(runtime.database, modules)) return { savedCount: 0 };
        const module = modules[0];
        const producerId = module === 'official_web' ? 'scheduler.rolling-official-web' : 'scheduler.rolling-x-lists';
        const businessDate = shanghaiDate();
        const receipt = await submitWorkspaceOrchestratorIntent(runtime, {
          producerId,
          businessDate,
          requestId: `${producerId}:${runtime.identity.workspaceId}:${businessDate}`,
          action: 'scan',
          logicalInput: { businessDate, modules },
          payload: { businessDate, modules },
          rootMode: 'scheduler'
        });
        return { savedCount: receipt.ok ? 1 : 0 };
      },
      onError: (error) => console.error('[daily-scan-scheduler]', error)
    });
    scanSchedulerRef?.stop();
    scanSchedulerRef = scanScheduler;
    scanScheduler.start();
    // WMB-5238：ChangeSet 提交后索引增量投影生产接线（动态导入 IndexStore；模块未就绪不阻断启动）。
    void installProductionWikiIndexProjection().catch((error) => {
      console.error('[wiki-index] production projection wiring failed', error);
    });
    // WMB-5217：历史初始化（经 CommandDispatcher 授权写；幂等续跑；失败不阻断启动）。
    orchestrationSchedulerRef?.stop();
    orchestrationSchedulerRef = new DailyOrchestrationScheduler({
      getDatabase: () => activeRuntime === runtime && runtime.isActive ? runtime.database : null,
      getWorkspaceId: () => runtime.identity.workspaceId,
      submitIntent: (input) => submitWorkspaceOrchestratorIntent(runtime, input),
      onError: (e) => console.error('[daily-orchestration-scheduler]', e)
    });
    orchestrationSchedulerRef.start();
    await lintSchedulerRef?.stop();
    lintSchedulerRef = null;
    lintSchedulerRef = new KnowledgeLintScheduler({ runtime, isCurrent: () => activeRuntime === runtime && runtime.isActive });
    lintSchedulerRef.start();
    // WMB-5236：全库维护调度器（单飞；重启后自动恢复 persisted running run 并继续；
    // 执行期间挂起滚动周期 Lint，避免双驱动同一 lint checkpoint；paused/completed/failed 恢复滚动 Lint）。
    await maintenanceSchedulerRef?.stop();
    maintenanceSchedulerRef = null;
    maintenanceSchedulerRef = new KnowledgeMaintenanceScheduler({
      runtime,
      deps: () => createMaintenanceDeps(dataRoot.path),
      isCurrent: () => activeRuntime === runtime && runtime.isActive,
      onExecutionChange: (executing) => {
        if (executing) {
          lintSchedulerRef?.stop();
        } else if (maintenanceSchedulerRef && !maintenanceSchedulerRef.isExecuting()) {
          lintSchedulerRef?.start();
        }
      }
    });
    maintenanceSchedulerRef.start();
    if (orphanSweepTimer) clearInterval(orphanSweepTimer);
    orphanSweepTimer = setInterval(() => { void reconcileOrphanDailyTasks('interval'); }, 60_000);
  } catch (error) {
    scanSchedulerRef?.stop();
    scanSchedulerRef = null;
    orchestrationSchedulerRef?.stop();
    orchestrationSchedulerRef = null;
    await stopPersistentKnowledgeJobs();
    await stopKnowledgeBackfillJobs();
    await stopKnowledgeCompileModel().catch(() => {});
    await runtime.stop({ drain: false }).catch(() => {});
    throw error;
  }
}
type TimerHandle = ReturnType<typeof setInterval>;
let scanSchedulerRef: DailyScanScheduler | null = null; let orchestrationSchedulerRef: DailyOrchestrationScheduler | null = null; let orphanSweepTimer: TimerHandle | null = null, stopTopicReproposalScheduler: (() => void) | null = null, stopResearchSuccessorScheduler: (() => void) | null = null, stopMediaGovernanceScheduler: (() => void) | null = null; let lintSchedulerRef: KnowledgeLintScheduler | null = null; let maintenanceSchedulerRef: KnowledgeMaintenanceScheduler | null = null; let mediaArchiveSchedulerRef: MediaArchiveScheduler | null = null; let sourceBodyArchiveSchedulerRef: SourceBodyArchiveScheduler | null = null;
async function reconcileOrphanDailyTasks(reason = 'interval'): Promise<void> {
  const runtime = activeRuntime;
  if (!runtime) return;
  try {
    await dispatchReapOrphanedPageTasks(runtime, (taskId) => runtime.getWorkerSnapshots().some((worker) => worker.taskId === taskId));
  } catch (error) {
    console.error('[page-orphan-sweeper]', reason, error);
  }
  try {
    const rows = runtime.database.prepare(`
      SELECT id, business_date, phase
      FROM agent_tasks
      WHERE intent IN ('daily_intelligence', 'daily_scan', 'daily_judge')
        AND status='running'
        AND phase IN ('starting', 'channel_scanned', 'scanning')
    `).all() as Array<{ id: string; business_date: string; phase: string }>;
    for (const task of rows) {
      await submitWorkspaceOrchestratorIntent(runtime, {
        producerId: 'reconcile.daily-handoff-sweeper',
        businessDate: task.business_date,
        requestId: `reconcile.daily-handoff-sweeper:${runtime.identity.workspaceId}:${task.id}`,
        action: 'stage_d',
        logicalInput: { taskId: task.id, phase: task.phase, businessDate: task.business_date },
        payload: { taskId: task.id, phase: task.phase, businessDate: task.business_date },
        rootMode: 'scheduler'
      });
    }
  } catch (error) {
    console.error('[daily-orphan-sweeper]', reason, error);
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
  canSwitch: async (dataRoot) => assertWorkspaceSwitchable(dataRoot.path, { piActive: Boolean(currentPi()?.isActive), dailyRunCount: 0 }),
  closeMutationGate: async () => { if (activeRuntime) await activeRuntime.closeClaimsAndDrain(); },
  openMutationGate: () => activeRuntime?.reopenClaims(),
  stopRuntime: async () => {
    scanSchedulerRef?.stop(); scanSchedulerRef = null;
    orchestrationSchedulerRef?.stop(); orchestrationSchedulerRef = null;
    lintSchedulerRef?.stop(); lintSchedulerRef = null;
    await maintenanceSchedulerRef?.stop(); maintenanceSchedulerRef = null;
    mediaArchiveSchedulerRef?.stop(); mediaArchiveSchedulerRef = null;
    sourceBodyArchiveSchedulerRef?.stop(); sourceBodyArchiveSchedulerRef = null;
    if (orphanSweepTimer) { clearInterval(orphanSweepTimer); orphanSweepTimer = null; }
    stopTopicReproposalScheduler?.(); stopTopicReproposalScheduler = null;
    stopResearchSuccessorScheduler?.(); stopResearchSuccessorScheduler = null;
    stopMediaGovernanceScheduler?.(); stopMediaGovernanceScheduler = null;
    await stopPersistentKnowledgeJobs();
    await stopKnowledgeBackfillJobs();
    await stopKnowledgeCompileModel().catch(() => {});
    const runtime = activeRuntime;
    try { await runtime?.stop({ drain: false }); } finally { if (activeRuntime === runtime) activeRuntime = null; }
  },
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
const desktopLifecycle = createDesktopLifecycle({
  refreshRuntime,
  defaultBrowserProfileId,
  getActiveRuntime: () => activeRuntime,
  clearActiveRuntime: (runtime) => { if (activeRuntime === runtime) activeRuntime = null; },
  stopBackgroundWork: async () => {
    scanSchedulerRef?.stop(); scanSchedulerRef = null;
    orchestrationSchedulerRef?.stop(); orchestrationSchedulerRef = null;
    lintSchedulerRef?.stop(); lintSchedulerRef = null;
    await maintenanceSchedulerRef?.stop(); maintenanceSchedulerRef = null;
    mediaArchiveSchedulerRef?.stop(); mediaArchiveSchedulerRef = null;
    sourceBodyArchiveSchedulerRef?.stop(); sourceBodyArchiveSchedulerRef = null;
    if (orphanSweepTimer) { clearInterval(orphanSweepTimer); orphanSweepTimer = null; }
    stopTopicReproposalScheduler?.(); stopTopicReproposalScheduler = null;
    stopResearchSuccessorScheduler?.(); stopResearchSuccessorScheduler = null;
    stopMediaGovernanceScheduler?.(); stopMediaGovernanceScheduler = null;
    await stopPersistentKnowledgeJobs();
    await stopKnowledgeBackfillJobs();
  },
  abortPi: async () => { if (currentPi()?.isActive) await currentPi()?.abortTurn().catch(() => {}); },
  setShuttingDown: (value) => { shuttingDown = value; },
  restoreWindow: () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }, isShuttingDown: () => shuttingDown,
});
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  await initSystemProxy();
  const dataRoot = await loadSelectedDataRoot(); const registry = await listWorkspaces(); await syncPiSkillsForDataRoots(app.getPath('userData'), app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.resolve('skills'), registry.workspaces.map((workspace) => workspace.rootPath));
  migratePiConfigToInstallation(path.join(app.getPath('userData'), 'pi-api-config.json'), registry.workspaces.map((workspace) => workspace.rootPath));
  if (dataRoot) await refreshRuntime(dataRoot);
  registerSettingsConfigIpc({ loadSelectedDataRoot, chooseDataRoot, listWorkspaces, switchWorkspace, createUkWorkspace, listWorkspaceProposals: workspaceConfirmation.list, selectWorkspaceProposalRoot: workspaceConfirmation.selectRoot, confirmWorkspaceProposal: workspaceConfirmation.confirm, getMcp: currentMcp, getXhs: currentXhs, getBrowser: currentBrowser, getRuntimeEpoch: () => activeRuntime?.identity.runtimeEpoch ?? null, stopPi: async () => { await activeRuntime?.stopWorker(); }, browserProfileOwner });
  desktopLifecycle.registerIpcAndStartUpdater();
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
        // WMB-5246：视频播放/定位需要 HTTP Range（206 部分内容）。媒体元素 seek 时 Chromium
        // 发 `Range: bytes=start-end`；这里按请求切片返回，并始终声明 Accept-Ranges。
        const mimeType = asset.mimeType || guessImageMime(absolute);
        const size = (await stat(absolute)).size;
        const range = request.headers.get('Range');
        const rangeMatch = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
        if (rangeMatch) {
          const requestedStart = rangeMatch[1] === '' ? null : Number(rangeMatch[1]);
          const requestedEnd = rangeMatch[2] === '' ? null : Number(rangeMatch[2]);
          const start = Number.isFinite(requestedStart as number) && (requestedStart as number) >= 0 ? (requestedStart as number) : 0;
          const end = Number.isFinite(requestedEnd as number) && (requestedEnd as number) >= start && (requestedEnd as number) < size
            ? (requestedEnd as number)
            : size - 1;
          if (start >= size) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
          }
          const length = end - start + 1;
          const handle = await open(absolute, 'r');
          try {
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, start);
            return new Response(buffer, {
              status: 206,
              headers: {
                'Content-Type': mimeType,
                'Content-Length': String(length),
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
              }
            });
          } finally {
            await handle.close();
          }
        }
        const bytes = await readFile(absolute);
        return new Response(bytes, {
          headers: { 'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
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
    getLastPiProfileId: () => lastEnsuredPiProfileId,
    getPiSessionFile: () => activeRuntime?.getPiSessionFile() ?? null,
    setPiSessionFile: (sessionFile) => { activeRuntime?.setPiSessionFile(sessionFile); },
    getActiveRuntime: () => activeRuntime
  });
  queueMicrotask(() => { if (activeRuntime) resumePendingInvestigationSupervisorReviews(activeRuntime); });
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
    if (input.intent && input.businessDate) return getActiveAgentTask(database, input.intent, input.businessDate);
    return null;
  });
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
  
  ipcMain.handle('agent:get-manager-task', (_event, input: { businessDate?: string } = {}) => {
    const runtime = activeRuntime;
    if (!runtime) return null;
    const businessDate = input?.businessDate?.trim() || shanghaiDate();
    return readManagerProjection(runtime, { businessDate });
  });

  ipcMain.handle('agent:sync-manager-task', async (_event, input: { businessDate?: string } = {}) => {
    const runtime = activeRuntime;
    if (!runtime) return null;
    const businessDate = input?.businessDate?.trim() || shanghaiDate();
    return readManagerProjection(runtime, { businessDate });
  });

ipcMain.handle('agent:control-daily', async (_event, input: { id: string; action: 'skip_source' | 'save_partial' | 'cancel' }) => {
    const runtime = activeRuntime;
    if (!runtime) throw new Error('当前工作空间运行时不可用。');
    const taskId = String(input?.id || '').trim();
    const action = input?.action;
    if (!taskId) throw new Error('缺少任务 id。');
    if (action !== 'skip_source' && action !== 'save_partial' && action !== 'cancel') throw new Error('无效的控制动作。');
    const flightKey = `${taskId}:${action}`;
    const existing = dailyControlInflight.get(flightKey);
    if (existing) return existing;
    const work = (async () => {
      const result = await uiCommandResult(() => dispatchRequestAgentTaskControl(runtime, taskId, action, { actor: ownerUiActor, requestId: randomUUID(), taskId }));
      if (!result.ok) return result;
      if (dailyControlAuditEnabled() && result.data && typeof result.data === 'object' && (result.data as { status?: string }).status === 'running') {
        await uiCommandResult(() => dispatchReportAgentTaskProgress(runtime, taskId, {
          message: controlAuditMessage(action, 'owner_ui'),
          level: 'info'
        }, { actor: ownerUiActor, requestId: randomUUID(), taskId })).catch(() => result);
      }
      broadcastPiEvent({ type: 'agent_task', task: result.data });
      // 中断进行中的 plan-synthesis Pi：否则 control_action 只会躺到超时。
      await abortDailyIntelligence(taskId);
      // 取消 / 保存并停止 都必须立即可靠收尾，不能只等 runner 轮询。
      if (action === 'cancel') {
        const isManagerTask = result.data?.intent === 'page_agents';
        const cancelled = isManagerTask
          ? await uiCommandResult(() => cancelManagerDailyIntelligence(runtime, taskId, { actor: ownerUiActor, requestId: randomUUID(), taskId }))
          : await uiCommandResult(() => dispatchCancelAgentTask(runtime, taskId, { actor: ownerUiActor, requestId: randomUUID(), taskId }));
        if (cancelled.ok) broadcastPiEvent({ type: 'agent_task', task: cancelled.data });
        return cancelled.ok ? cancelled : result;
      }
      if (action === 'save_partial') {
        const partial = await uiCommandResult(() => dispatchPartialAgentTask(runtime, taskId, { actor: ownerUiActor, requestId: randomUUID(), taskId }));
        if (partial.ok) broadcastPiEvent({ type: 'agent_task', task: partial.data });
        return partial.ok ? partial : result;
      }
      return result;
    })();
    dailyControlInflight.set(flightKey, work);
    try {
      return await work;
    } finally {
      dailyControlInflight.delete(flightKey);
    }
  });
  ipcMain.handle('agent:start-daily-intelligence', async () => ({
    ok: false,
    data: null,
    error: {
      code: 'DAILY_FULL_PIPELINE_PAUSED',
      message: '一键完整链路已暂停。请从资料、选题或创作入口分步处理。'
    }
  }));
  ipcMain.handle('agent:start-studio-draft', async (_event, input: { businessDate: string; projectId: string; brief?: string; researchMode?: string; research_mode?: string }) => {
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
        brief: input.brief,
        mcpUrl: mcp.url,
        xhsMcpUrl: currentXhs()?.getUrl() || '',
        researchReady: true,
        researchMode: 'prohibited',
        activeRuntime: runtime,
        ...hooks
      }), { roleId: 'writer' });
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
  registerIllustrationWorkflowIpc({ loadSelectedDataRoot, migrate, getActiveRuntime: () => activeRuntime });
  if (activeRuntime) void resumePendingIllustrationRuns({ loadSelectedDataRoot, migrate, getActiveRuntime: () => activeRuntime });
  registerJobsIpc({ getActiveRuntime: () => activeRuntime });
  setDeskJobNotifyBridges({ getPi: currentPi, getRuntime: () => activeRuntime });
  registerExecutionGrantIpc(ipcMain, () => activeRuntime);
  registerPublishingResultsIpc({ getActiveRuntime: () => activeRuntime, setBrowser: (runtime): WorkspaceRuntimeLease => { if (!runtime) { activeRuntime?.releaseBrowser(); throw new Error('发布浏览器运行时不可为空。'); } if (!activeRuntime?.isActive) throw new Error('当前工作空间运行时不可用。'); return activeRuntime.bindBrowser(runtime, { stop: async () => { await disposeXListSessions(); await stopManagedBrowsers(); } }); } });
  registerDailyContentCycleIpc({ loadSelectedDataRoot, migrate, getActiveRuntime: () => activeRuntime });
  registerDailyContentArticleIpc({ loadSelectedDataRoot, migrate, getActiveRuntime: () => activeRuntime });
  registerDailyIterationIpc({ loadSelectedDataRoot, migrate, getActiveRuntime: () => activeRuntime });
  registerContentDerivativeIpc({ loadSelectedDataRoot, migrate, getActiveRuntime: () => activeRuntime });
  registerIntelligenceChannelsIpc({ loadSelectedDataRoot, channelProposals, getActiveRuntime: () => activeRuntime });
  registerXListIpc({ loadSelectedDataRoot, getActiveRuntime: () => activeRuntime, setBrowser: (runtime): WorkspaceRuntimeLease => { if (!runtime) { activeRuntime?.releaseBrowser(); throw new Error('X 浏览器运行时不可为空。'); } if (!activeRuntime?.isActive) throw new Error('当前工作空间运行时不可用。'); return activeRuntime.bindBrowser(runtime, { stop: async () => { await disposeXListSessions(); await stopManagedBrowsers(); } }); }, wakeObservationScheduler: () => activeRuntime?.getScheduler<XObservationScheduler>()?.wake() });
  registerXhsIpc({ loadSelectedDataRoot, getXhs: currentXhs, setXhs: (runtime) => { activeRuntime?.setXhs(runtime); }, refreshXhs: (dataRoot) => refreshXhsRuntime(dataRoot, currentXhs()) });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => desktopLifecycle.handleBeforeQuit(event));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
