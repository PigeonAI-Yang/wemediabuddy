import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDataRoot, type DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { readSettings } from './settings';
import { startMcp, type McpRuntime } from './mcp';
import type { XhsMcpRuntime } from './xiaohongshu-mcp';
import { refreshXhsRuntime, registerXhsIpc } from './ipc-xhs';
import { stopManagedBrowsers, type BrowserRuntime } from './browser'; import { configureBrowserProfileRegistryPath, openBrowserProfileRegistry } from './browser-config';
import { migratePiConfigToInstallation, readPiConfig, resolvePiConfigChain, savePiConfig } from './pi-config';
import { ensurePiConversationLayout, listPiConversations, readPiConversation, setPiConversationArchived, startNewPiConversation, switchPiConversation, writePiConversation } from './pi-conversation'; import { PI_AUTHORITY_SYSTEM_PROMPT } from './pi-operator-skill'; import { syncPiSkillsForDataRoots } from './pi-skill-library';
import { humanizePiProviderError, isPiProviderFallbackError, PiRpcSupervisor } from './pi-runtime';
import { piModelsJson, WMB_VISION_MODEL } from './pi-model';
import { getPiRuntimeInfo, resolvePiRuntimeRoot, piCliFromRuntimeRoot, piVisionExtensionFromRuntimeRoot, updatePiRuntime, rollbackPiRuntime } from './pi-runtime-manager';
import {
  agentRequestId,
  getActiveAgentTask,
  getAgentTask,
  getLatestAgentTask,
  getActiveDailyIntelligenceTask,
  getLatestDailyIntelligenceTask,
  isDailyIntelligenceFamily,
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
  dispatchRecoverInterruptedAgentTasks,
  dispatchStartAgentTask,
  dispatchUpdateAgentTaskPhase
} from './agent-task-commands.ts';
import { dispatchManagerDailyIntelligence, readManagerProjection, syncManagerTaskFromLegacyChild } from './manager-dispatch.ts';
import { createDataRootSelection } from './data-root-selection';
import { ActiveWorkspaceRuntime, assertWorkspaceSwitchable, installActiveWorkspaceIpcGate, RUNTIME_MANAGING_IPC_CHANNELS, type WorkspaceRuntimeLease } from './workspace-runtime';
import { abortDailyIntelligence, startResultsReview, startStudioDraft } from './agent-runner';
import { controlAuditMessage, dailyControlAuditEnabled, isOrphanChannelScannedTask, isOrphanStartingDailyTask } from './daily-control-policy.ts';
import { decideDailyStartGate } from './daily-start-gate.ts';
import { releaseDailyStageLock, tryAcquireDailyStageLock } from './daily-stage-lock.ts';
import { readWorkspaceIntelligenceProfile, startWorkspaceDailyIntelligence } from './workspace-intelligence';
import { DailyScanScheduler } from './daily-scan-scheduler';
import { hasEnabledDailySources } from './daily-intelligence-channels';
import { shanghaiDate } from './ferment';
import { registerKnowledgeContentIpc } from './ipc-knowledge-content';
import { ensureJobsSpawner, registerJobsIpc, resetJobsIpcSpawner } from './ipc-jobs.ts'; import { startTopicReproposalScheduler } from './topic-maintenance-reproposal.ts';
import { setActiveJobSpawner } from './job-spawner.ts';
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
import { getAsset, guessImageMime } from './assets';
import { preparePiExtension } from './pi-extension';
import { WorkspaceProposalStore } from './workspace-proposals'; import { IntelligenceChannelProposalStore } from './intelligence-channel-proposals'; import { createWorkspaceConfirmation } from './workspace-confirmation';
import { XObservationScheduler } from './x-observation-scheduler'; import { disposeXListSessions } from './platforms/x-list-session'; import { createBrowserProfileOwner } from './browser-profile-owner';
import { KnowledgeLintScheduler, registerKnowledgeChangeSetLintTrigger } from './knowledge-health';
import { runLegacyKnowledgeInitAtStartup } from './legacy-knowledge-init';
import { handleSquirrelLifecycle } from './squirrel-lifecycle';
import { createDesktopLifecycle } from './desktop-lifecycle';
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
function dailyRunKey(rootPath: string, businessDate: string): string {
  return `${rootPath}\u0000${businessDate}`;
}
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
async function ensurePi(dataRoot: DataRoot, options: { skipProfileIds?: Iterable<string> } = {}): Promise<PiRpcSupervisor> {
  const runtime = activeRuntime;
  if (!runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) throw new Error('当前工作空间运行时不可用。');
  const running = currentPi();
  if (running?.isRunning && !options.skipProfileIds) return running;
  if (running?.isRunning && options.skipProfileIds) await runtime.stopWorker().catch(() => {});
  const lease = runtime.acquireWorkerLease(null, null, 'desk');
  const chain = resolvePiConfigChain(undefined, { skipProfileIds: options.skipProfileIds });
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
        await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...config, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
        worker = new PiRpcSupervisor(process.execPath, [piCliFromRuntimeRoot(runtimeRoot), '--mode', 'rpc', '--session', runtime.getPiSessionFile() || layout.sessionFile, '-e', extensionPath, '-e', piVisionExtensionFromRuntimeRoot(runtimeRoot), '--provider', 'wmb-api', '--model', config.model, ...(config.thinking ? ['--thinking', config.thinking] : []), '--append-system-prompt', PI_AUTHORITY_SYSTEM_PROMPT], {
          ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: layout.agentDir, WMB_PI_API_KEY: config.apiKey, PI_VISION_PROVIDER: 'wmb-api', PI_VISION_MODEL: WMB_VISION_MODEL, PI_VISION_REASONING_EFFORT: 'off', WMB_MCP_URL: mcp.url, WMB_XHS_MCP_URL: currentXhs()?.getUrl() || ''
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
            failures
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
          error: message
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(failures.at(-1) || 'Pi 模型服务不可用。');
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
    stopTopicReproposalScheduler?.(); stopTopicReproposalScheduler = await startTopicReproposalScheduler(runtime, ensureJobsSpawner({ getActiveRuntime: () => activeRuntime }));
    const xhs = await refreshXhsRuntime(readWorkspaceIntelligenceProfile(dataRoot.path, runtime).platforms.includes('xiaohongshu') ? dataRoot : null, null);
    runtime.setXhs(xhs);
    // MCP 就绪后再接力：扫完 channel_scanned 且无协调器时优先 judgeOnly。
    try {
      const today = shanghaiDate();
      const orphanKey = dailyRunKey(dataRoot.path, today);
      const orphan = getActiveDailyIntelligenceTask(runtime.database, today);
      if (orphan && orphan.status === 'running' && !dailyRuns.has(orphanKey) && (orphan.phase === 'channel_scanned' || isOrphanStartingDailyTask(orphan) || isOrphanChannelScannedTask(orphan))) {
        const mcpReady = currentMcp();
        // starting 僵尸：无进度可接力，直接 partial 收尸，避免 UI 假运行数十分钟
        if (isOrphanStartingDailyTask(orphan) && orphan.phase !== 'channel_scanned') {
          try {
            const finished = await dispatchPartialAgentTask(runtime, orphan.id, {
              actor: { type: 'scheduler', id: 'daily-handoff-sweeper', label: 'daily-handoff-sweeper' },
              requestId: `handoff-sweep-starting:${orphan.id}:${Date.now()}`,
              taskId: orphan.id
            });
            broadcastPiEvent({ type: 'agent_task', task: finished });
          } catch (sweepError) {
            console.error('[daily-handoff-sweeper-starting]', sweepError);
          }
        } else if (mcpReady && orphan.phase === 'channel_scanned') {
          const run = withRuntimeWorker(orphan.id, (event) => {
            broadcastPiRuntimeProgress(event);
            if (event.type === 'agent_task' || event.type === 'fallback-try' || event.type === 'fallback') broadcastPiEvent(event);
          }, (hooks) => startWorkspaceDailyIntelligence({
            dataRootPath: dataRoot.path,
            businessDate: today,
            judgeOnly: true,
            mcpUrl: mcpReady.url,
            xhsMcpUrl: currentXhs()?.getUrl() || '',
            activeRuntime: runtime,
            ...hooks
          })).then((result) => { broadcastPiEvent({ type: 'agent_task', task: result.task }); return result; })
            .catch(async (error) => {
              console.error('[daily-handoff-judge]', error);
              if (isOrphanChannelScannedTask(orphan)) {
                try {
                  const finished = await dispatchPartialAgentTask(runtime, orphan.id, {
                    actor: { type: 'scheduler', id: 'daily-handoff-sweeper', label: 'daily-handoff-sweeper' },
                    requestId: `handoff-sweep:${orphan.id}:${Date.now()}`,
                    taskId: orphan.id
                  });
                  broadcastPiEvent({ type: 'agent_task', task: finished });
                } catch (sweepError) {
                  console.error('[daily-handoff-sweeper]', sweepError);
                }
              }
              return null;
            })
            .finally(() => dailyRuns.delete(orphanKey));
          dailyRuns.set(orphanKey, run);
        } else if (isOrphanChannelScannedTask(orphan)) {
          const finished = await dispatchPartialAgentTask(runtime, orphan.id, {
            actor: { type: 'scheduler', id: 'daily-handoff-sweeper', label: 'daily-handoff-sweeper' },
            requestId: `handoff-sweep:${orphan.id}`,
            taskId: orphan.id
          });
          broadcastPiEvent({ type: 'agent_task', task: finished });
        }
      }
    } catch (error) {
      console.error('[daily-handoff-sweeper]', error);
    }

    const scheduler = new XObservationScheduler({ runtime, loadSelectedDataRoot, isCurrent: () => activeRuntime === runtime && runtime.isActive });
    runtime.setScheduler(scheduler);
    scheduler.start();
    const scanScheduler = new DailyScanScheduler({
      isCurrent: () => activeRuntime === runtime && runtime.isActive,
      run: (modules) => {
        // 该模块没有启用来源时直接跳过，不落任何任务/回执（防假 needs_user 任务污染今日页）。
        if (!hasEnabledDailySources(runtime.database, modules)) return Promise.resolve({ savedCount: 0 });
        const businessDate = shanghaiDate();
        const runKey = dailyRunKey(dataRoot.path, businessDate);
        const run = withRuntimeWorker(null, broadcastPiRuntimeProgress, (hooks) => startWorkspaceDailyIntelligence({
          dataRootPath: dataRoot.path,
          businessDate,
          modules,
          scanOnly: true,
          mcpUrl: currentMcp()?.url ?? '',
          xhsMcpUrl: currentXhs()?.getUrl() || '',
          activeRuntime: runtime,
          ...hooks
        }), { roleId: 'reporter' }).finally(() => {
          if (dailyRuns.get(runKey) === run) dailyRuns.delete(runKey);
        });
        dailyRuns.set(runKey, run);
        return run;
      },
      onNewSources: (modules) => {
        const businessDate = shanghaiDate();
        const owner = `scan-scheduler-judge:${businessDate}`;
        const lock = tryAcquireDailyStageLock({ businessDate, kind: 'judge', owner });
        if (!lock.ok) return Promise.resolve(null);
        const runKey = dailyRunKey(dataRoot.path, businessDate);
        const run = withRuntimeWorker(null, broadcastPiRuntimeProgress, (hooks) => startWorkspaceDailyIntelligence({
          dataRootPath: dataRoot.path,
          businessDate,
          modules,
          judgeOnly: true,
          mcpUrl: currentMcp()?.url ?? '',
          xhsMcpUrl: currentXhs()?.getUrl() || '',
          activeRuntime: runtime,
          ...hooks
        }), { roleId: 'planner' }).then((result) => {
          broadcastPiEvent({ type: 'agent_task', task: result.task });
          return result;
        }).finally(() => {
          releaseDailyStageLock({ businessDate, kind: 'judge', owner });
          if (dailyRuns.get(runKey) === run) dailyRuns.delete(runKey);
        });
        dailyRuns.set(runKey, run);
        return run;
      },
      onError: (error) => console.error('[daily-scan-scheduler]', error)
    });
    scanSchedulerRef?.stop();
    scanSchedulerRef = scanScheduler;
    scanScheduler.start();
    // WMB-5216：统一 ChangeSet 提交后局部 Lint 触发注册 + 周期 Lint 走既有 jobs 表驱动。
    registerKnowledgeChangeSetLintTrigger();
    // WMB-5217：历史初始化（经 CommandDispatcher 授权写；幂等续跑；失败不阻断启动）。
    void runLegacyKnowledgeInitAtStartup(runtime).catch((error) => {
      console.error('[knowledge-init] startup legacy init failed', error);
    });
    lintSchedulerRef?.stop();
    lintSchedulerRef = new KnowledgeLintScheduler({ runtime, isCurrent: () => activeRuntime === runtime && runtime.isActive });
    lintSchedulerRef.start();
    if (orphanSweepTimer) clearInterval(orphanSweepTimer);
    orphanSweepTimer = setInterval(() => { void sweepOrphanDailyTasks('interval'); }, 60_000);
  } catch (error) {
    scanSchedulerRef?.stop();
    scanSchedulerRef = null;
    lintSchedulerRef?.stop();
    lintSchedulerRef = null;
    if (activeRuntime === runtime) activeRuntime = null;
    await runtime.stop({ drain: false }).catch(() => {});
    throw error;
  }
}
type TimerHandle = ReturnType<typeof setInterval>;
let scanSchedulerRef: DailyScanScheduler | null = null; let orphanSweepTimer: TimerHandle | null = null, stopTopicReproposalScheduler: (() => void) | null = null; let lintSchedulerRef: KnowledgeLintScheduler | null = null;
async function sweepOrphanDailyTasks(reason = 'interval'): Promise<void> {
  const runtime = activeRuntime;
  const dataRootPath = runtime?.identity.rootPath;
  if (!runtime || !dataRootPath) return;
  try {
    await dispatchReapOrphanedPageTasks(runtime, (taskId) => runtime.getWorkerSnapshots().some((worker) => worker.taskId === taskId));
  } catch (error) {
    console.error('[page-orphan-sweeper]', reason, error);
  }
  try {
    const today = shanghaiDate();
    const orphanKey = dailyRunKey(dataRootPath, today);
    if (dailyRuns.has(orphanKey)) return;
    const orphan = getActiveDailyIntelligenceTask(runtime.database, today);
    if (!orphan || orphan.status !== 'running') return;
    if (orphan.phase === 'channel_scanned') {
      const mcpReady = currentMcp();
      if (mcpReady) {
        const run = withRuntimeWorker(orphan.id, (event) => {
          broadcastPiRuntimeProgress(event);
          if (event.type === 'agent_task' || event.type === 'fallback-try' || event.type === 'fallback') broadcastPiEvent(event);
        }, (hooks) => startWorkspaceDailyIntelligence({
          dataRootPath,
          businessDate: today,
          judgeOnly: true,
          mcpUrl: mcpReady.url,
          xhsMcpUrl: currentXhs()?.getUrl() || '',
          activeRuntime: runtime,
          ...hooks
        }), { roleId: 'planner' }).then((result) => {
          broadcastPiEvent({ type: 'agent_task', task: result.task });
          return result;
        }).catch(async (error) => {
          console.error('[daily-orphan-sweeper-judge]', reason, error);
          try {
            const finished = await dispatchPartialAgentTask(runtime, orphan.id, {
              actor: { type: 'scheduler', id: 'daily-orphan-sweeper', label: 'daily-orphan-sweeper' },
              requestId: `orphan-sweep:${orphan.id}:${Date.now()}`,
              taskId: orphan.id
            });
            broadcastPiEvent({ type: 'agent_task', task: finished });
          } catch {}
          return null;
        }).finally(() => {
          if (dailyRuns.get(orphanKey) === run) dailyRuns.delete(orphanKey);
        });
        dailyRuns.set(orphanKey, run);
        return;
      }
    }
    if (isOrphanStartingDailyTask(orphan) || isOrphanChannelScannedTask(orphan)) {
      const finished = await dispatchPartialAgentTask(runtime, orphan.id, {
        actor: { type: 'scheduler', id: 'daily-orphan-sweeper', label: 'daily-orphan-sweeper' },
        requestId: `orphan-sweep:${orphan.id}:${Date.now()}`,
        taskId: orphan.id
      });
      broadcastPiEvent({ type: 'agent_task', task: finished });
      // starting/scanning 孤儿收尸后自动重开完整扫描，避免 UI 假运行后无人接力。
      const mcpReady = currentMcp();
      if (mcpReady && (isOrphanStartingDailyTask(orphan) || String(orphan.phase || '').startsWith('scanning') || orphan.phase === 'starting')) {
        const run = withRuntimeWorker(null, (event) => {
          broadcastPiRuntimeProgress(event);
          if (event.type === 'agent_task' || event.type === 'fallback-try' || event.type === 'fallback') broadcastPiEvent(event);
        }, (hooks) => startWorkspaceDailyIntelligence({
          dataRootPath,
          businessDate: today,
          mcpUrl: mcpReady.url,
          xhsMcpUrl: currentXhs()?.getUrl() || '',
          activeRuntime: runtime,
          ...hooks
        }), { roleId: 'reporter' }).then((result) => {
          broadcastPiEvent({ type: 'agent_task', task: result.task });
          return result;
        }).catch((error) => {
          console.error('[daily-orphan-sweeper-restart]', reason, error);
          return null;
        }).finally(() => {
          if (dailyRuns.get(orphanKey) === run) dailyRuns.delete(orphanKey);
        });
        dailyRuns.set(orphanKey, run);
      }
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
  canSwitch: async (dataRoot) => assertWorkspaceSwitchable(dataRoot.path, { piActive: Boolean(currentPi()?.isActive), dailyRunCount: dailyRuns.size }),
  closeMutationGate: async () => { if (activeRuntime) await activeRuntime.closeClaimsAndDrain(); },
  openMutationGate: () => activeRuntime?.reopenClaims(),
  stopRuntime: async () => { scanSchedulerRef?.stop(); scanSchedulerRef = null; lintSchedulerRef?.stop(); lintSchedulerRef = null; if (orphanSweepTimer) { clearInterval(orphanSweepTimer); orphanSweepTimer = null; } stopTopicReproposalScheduler?.(); stopTopicReproposalScheduler = null; const runtime = activeRuntime; try { await runtime?.stop({ drain: false }); } finally { if (activeRuntime === runtime) activeRuntime = null; } },
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
  stopBackgroundWork: () => { scanSchedulerRef?.stop(); scanSchedulerRef = null; lintSchedulerRef?.stop(); lintSchedulerRef = null; if (orphanSweepTimer) { clearInterval(orphanSweepTimer); orphanSweepTimer = null; } stopTopicReproposalScheduler?.(); stopTopicReproposalScheduler = null; },
  abortPi: async () => { if (currentPi()?.isActive) await currentPi()?.abortTurn().catch(() => {}); },
  setShuttingDown: (value) => { shuttingDown = value; },
  restoreWindow: () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }, isShuttingDown: () => shuttingDown,
});
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const dataRoot = await loadSelectedDataRoot(); const registry = await listWorkspaces(); await syncPiSkillsForDataRoots(app.getPath('userData'), app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.resolve('skills'), registry.workspaces.map((workspace) => workspace.rootPath));
  migratePiConfigToInstallation(path.join(app.getPath('userData'), 'pi-api-config.json'), registry.workspaces.map((workspace) => workspace.rootPath));
  if (dataRoot) await refreshRuntime(dataRoot);
  const startupMcp = currentMcp(); const startupXhs = currentXhs();
  if (dataRoot && startupMcp && activeRuntime) {
    const startupRuntime = activeRuntime;
    const pending = getLatestDailyIntelligenceTask(startupRuntime.database);
    const shouldResume = Boolean(
      pending
      && isDailyIntelligenceFamily(pending.intent)
      && pending.status === 'running'
      && (pending.phase === 'resume_pending' || pending.phase === 'channel_scanned')
    );
    if (shouldResume && pending) {
      const runKey = dailyRunKey(dataRoot.path, pending.businessDate);
      if (!dailyRuns.has(runKey)) {
        const run = withRuntimeWorker(pending.id, (event) => {
          broadcastPiRuntimeProgress(event);
          if (event.type === 'agent_task' || event.type === 'fallback-try' || event.type === 'fallback') broadcastPiEvent(event);
        }, (hooks) => startWorkspaceDailyIntelligence({
          dataRootPath: dataRoot.path,
          businessDate: pending.businessDate,
          mcpUrl: startupMcp.url,
          xhsMcpUrl: startupXhs?.getUrl() || '',
          activeRuntime: startupRuntime,
          ...(pending.phase === 'channel_scanned' ? { judgeOnly: true as const } : {}),
          ...hooks
        }), { roleId: 'planner' }).then((result) => { broadcastPiEvent({ type: 'agent_task', task: result.task }); return result; })
          .finally(() => dailyRuns.delete(runKey));
        dailyRuns.set(runKey, run);
      }
    }
  }
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
    getLastPiProfileId: () => lastEnsuredPiProfileId,
    getPiSessionFile: () => activeRuntime?.getPiSessionFile() ?? null,
    setPiSessionFile: (sessionFile) => { activeRuntime?.setPiSessionFile(sessionFile); },
    getActiveRuntime: () => activeRuntime
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
    if (input.intent && input.businessDate) {
      if (input.intent === 'daily_intelligence' || input.intent === 'daily_scan' || input.intent === 'daily_judge') {
        return getActiveDailyIntelligenceTask(database, input.businessDate) ?? getLatestDailyIntelligenceTask(database, input.businessDate);
      }
      return getActiveAgentTask(database, input.intent, input.businessDate) ?? getLatestAgentTask(database, input.intent, input.businessDate);
    }
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
  
  ipcMain.handle('agent:get-manager-task', (_event, input: { businessDate?: string } = {}) => {
    const runtime = activeRuntime;
    if (!runtime) return null;
    const businessDate = input?.businessDate?.trim() || shanghaiDate();
    return readManagerProjection(runtime, businessDate);
  });

  ipcMain.handle('agent:sync-manager-task', async (_event, input: { businessDate?: string } = {}) => {
    const runtime = activeRuntime;
    if (!runtime) return null;
    const businessDate = input?.businessDate?.trim() || shanghaiDate();
    const legacyChild = readManagerProjection(runtime, businessDate).legacyChild;
    const synced = await syncManagerTaskFromLegacyChild(runtime, businessDate, legacyChild);
    if (legacyChild) broadcastPiEvent({ type: 'agent_task', task: legacyChild });
    if (synced) broadcastPiEvent({ type: 'manager_task', action: 'sync', focusDialog: false, task: synced });
    return synced;
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
        const cancelled = await uiCommandResult(() => dispatchCancelAgentTask(runtime, taskId, { actor: ownerUiActor, requestId: randomUUID(), taskId }));
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
  ipcMain.handle('agent:start-daily-intelligence', async (_event, input: { businessDate: string; modules?: Array<'official_web' | 'x_lists'>; legacyPipeline?: boolean }) => {
    const businessDate = input?.businessDate?.trim();
    if (!businessDate) throw new Error('请选择今日情报日期。');
    const dataRoot = await loadSelectedDataRoot();
    const runtime = activeRuntime;
    if (!dataRoot || !runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) throw new Error('当前工作空间运行时不可用。');
    const mcp = currentMcp();
    if (!mcp) throw new Error('WMB MCP 尚未就绪。');

    // Owner lock 2026-08-08: button dispatches to manager dialog first (serial one ManagerTask).
    if (input?.legacyPipeline !== true) {
      try {
        const managed = await dispatchManagerDailyIntelligence(runtime, dataRoot.path, {
          businessDate,
          modules: input.modules,
          legacyPipeline: true
        });
        broadcastPiEvent({
          type: 'manager_task',
          action: managed.action,
          focusDialog: true,
          task: managed.managerTask
        });
        if (managed.action === 'focus_existing') {
          // Serial lock: do not start a second run; UI should focus dock.
          const child = getActiveDailyIntelligenceTask(runtime.database, businessDate);
          return {
            ok: true,
            data: {
              task: child ?? null,
              managerTask: managed.managerTask,
              focusDialog: true,
              reused: true,
              action: 'focus_existing'
            },
            error: null
          };
        }
        // 主管真 Pi 回合已启动；员工由主管 wmb_spawn_job 派出，不再自动 fallthrough legacy。
        return {
          ok: true,
          data: {
            task: null,
            managerTask: managed.managerTask,
            focusDialog: true,
            reused: false,
            action: managed.action,
            managerOwned: true
          },
          error: null
        };
      } catch (managerError) {
        console.error('[manager-dispatch]', managerError);
        // Fail closed to manager path only if serial focus; otherwise continue legacy with warning.
      }
    }

    const active = getActiveDailyIntelligenceTask(runtime.database, businessDate);
    const previous = getLatestDailyIntelligenceTask(runtime.database, businessDate);
    const runKey = dailyRunKey(dataRoot.path, businessDate);
    const gate = decideDailyStartGate({
      active: active ? {
        status: active.status,
        phase: active.phase,
        intent: active.intent,
        savedCount: Number(active.progress?.saved ?? 0)
      } : null,
      latest: previous ? {
        status: previous.status,
        phase: previous.phase,
        intent: previous.intent,
        savedCount: Number(previous.progress?.saved ?? 0)
      } : null,
      hasLiveCoordinator: dailyRuns.has(runKey)
    });
    if (gate.action === 'return_active' && active) {
      broadcastPiEvent({ type: 'agent_task', task: active });
      return { ok: true, data: { task: active, reused: true }, error: null };
    }
    // 无协调器的 running 孤儿先 partial 收尸，再允许 start_full / start_judge_only 开新任务。
    if (active && active.status === 'running' && !dailyRuns.has(runKey) && (gate.action === 'start_full' || gate.action === 'start_judge_only')) {
      try {
        const finished = await dispatchPartialAgentTask(runtime, active.id, {
          actor: { type: 'scheduler', id: 'daily-start-orphan-clear', label: 'daily-start-orphan-clear' },
          requestId: `start-orphan-clear:${active.id}:${Date.now()}`,
          taskId: active.id
        });
        broadcastPiEvent({ type: 'agent_task', task: finished });
      } catch (clearError) {
        console.error('[daily-start-orphan-clear]', clearError);
      }
    }
    const needsJudgeHandoff = gate.action === 'start_judge_only';
    let coordinatorError: unknown = null;
    const buttonLockOwner = `today-button:${businessDate}:${needsJudgeHandoff ? 'judge' : 'scan'}`;
    const buttonLock = tryAcquireDailyStageLock({
      businessDate,
      kind: needsJudgeHandoff ? 'judge' : 'scan',
      owner: buttonLockOwner
    });
    if (!buttonLock.ok) {
      return {
        ok: false,
        data: null,
        error: { code: 'STAGE_LOCK_BUSY', message: `扫/判阶段锁占用中（${buttonLock.heldBy.kind}）。请稍后再试。` }
      };
    }
    const run = withRuntimeWorker(active?.id ?? null, (event) => {
      broadcastPiRuntimeProgress(event);
      if (event.type === 'agent_task' || event.type === 'fallback-try' || event.type === 'fallback') broadcastPiEvent(event);
    }, (hooks) => startWorkspaceDailyIntelligence({
      dataRootPath: dataRoot.path,
      businessDate,
      modules: input.modules,
      mcpUrl: mcp.url,
      xhsMcpUrl: currentXhs()?.getUrl() || '',
      activeRuntime: runtime,
      ...(needsJudgeHandoff ? { judgeOnly: true as const } : {}),
      ...hooks
    }), { roleId: needsJudgeHandoff ? 'planner' : 'reporter' }).then((result) => { broadcastPiEvent({ type: 'agent_task', task: result.task }); return result; }).catch((error) => {
      coordinatorError = error; broadcastPiEvent({ type: 'failed', error: error instanceof Error ? error.message : String(error) }); return null;
    }).finally(() => {
      releaseDailyStageLock({
        businessDate,
        kind: needsJudgeHandoff ? 'judge' : 'scan',
        owner: buttonLockOwner
      });
      dailyRuns.delete(runKey);
    });
    // Task is created early in the channel run. Poll briefly instead of awaiting full scan.
    let task = getActiveDailyIntelligenceTask(runtime.database, businessDate) ?? getLatestDailyIntelligenceTask(runtime.database, businessDate);
    const startedAt = Date.now();
    while ((!task || (task.id === previous?.id && !active && task.status !== 'running')) && Date.now() - startedAt < 2_500) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 40); });
      task = getActiveDailyIntelligenceTask(runtime.database, businessDate) ?? getLatestDailyIntelligenceTask(runtime.database, businessDate);
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
  registerJobsIpc({ getActiveRuntime: () => activeRuntime });
  setDeskJobNotifyBridges({ getPi: currentPi, getRuntime: () => activeRuntime });
  registerExecutionGrantIpc(ipcMain, () => activeRuntime);
  registerPublishingResultsIpc({ getActiveRuntime: () => activeRuntime, setBrowser: (runtime): WorkspaceRuntimeLease => { if (!runtime) { activeRuntime?.releaseBrowser(); throw new Error('发布浏览器运行时不可为空。'); } if (!activeRuntime?.isActive) throw new Error('当前工作空间运行时不可用。'); return activeRuntime.bindBrowser(runtime, { stop: async () => { await disposeXListSessions(); await stopManagedBrowsers(); } }); } });
 registerIntelligenceChannelsIpc({ loadSelectedDataRoot, channelProposals, getActiveRuntime: () => activeRuntime }); registerXListIpc({ loadSelectedDataRoot, getActiveRuntime: () => activeRuntime, setBrowser: (runtime): WorkspaceRuntimeLease => { if (!runtime) { activeRuntime?.releaseBrowser(); throw new Error('X 浏览器运行时不可为空。'); } if (!activeRuntime?.isActive) throw new Error('当前工作空间运行时不可用。'); return activeRuntime.bindBrowser(runtime, { stop: async () => { await disposeXListSessions(); await stopManagedBrowsers(); } }); }, wakeObservationScheduler: () => activeRuntime?.getScheduler<XObservationScheduler>()?.wake() }); registerXhsIpc({ loadSelectedDataRoot, getXhs: currentXhs, setXhs: (runtime) => { activeRuntime?.setXhs(runtime); }, refreshXhs: (dataRoot) => refreshXhsRuntime(dataRoot, currentXhs()) });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => desktopLifecycle.handleBeforeQuit(event));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
