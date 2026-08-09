import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { agentRequestId, dailyAgentSessionId, getAgentTask } from './agent-tasks.ts';
import {
  dispatchCompleteAgentTask,
  dispatchFinishDailyIntelligence,
  dispatchReportAgentTaskProgress,
  dispatchStartAgentTask,
  dispatchUpdateAgentTaskPhase,
  type AgentTaskMutationDependency
} from './agent-task-commands.ts';
import { resolveAgentPiPrerequisite } from './agent-prerequisites.ts';
import { startDailyIntelligence, type DailyIntelligenceRun } from './agent-runner.ts';
import { startDailyChannelRun, type DailyChannelInput } from './daily-intelligence-channels.ts';
import type { DeferredSignal } from './role-job-registry.ts';
import { migrateDatabase } from './db/migrations.ts';
import { preparePiExtension } from './pi-extension.ts';
import { piTaskAuthorityPrompt } from './pi-operator-skill.ts';
import { ensurePiConversationLayout } from './pi-conversation.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piModelsJson } from './pi-model.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';
import { runPiPromptWithFallback, startPiRuntimeWithFallback } from './pi-config-fallback.ts';
import type { ResolvedPiConfig } from './pi-config.ts';
import { requireWorkspaceProfile, type WorkspaceProfileV1 } from './workspace-profiles.ts';
import type { IntelligenceModule } from './intelligence-channels.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import type { TaskReadyGrantHook } from './task-grants.ts';

type IntelligenceInput = {
  dataRootPath: string; piConfigPath?: string;
  businessDate: string;
  mcpUrl: string;
  xhsMcpUrl?: string | null;
  onEvent?: (event: Record<string, unknown>) => void;
  onRuntime?: (runtime: PiRpcSupervisor) => void;
  workerLeaseId?: string;
  onTaskReady?: TaskReadyGrantHook;
  modules?: IntelligenceModule[];
  scanOnly?: boolean;
  judgeOnly?: boolean;
  activeRuntime?: ActiveWorkspaceRuntime;
};

export function readWorkspaceIntelligenceProfile(dataRootPath: string, activeRuntime?: ActiveWorkspaceRuntime): WorkspaceProfileV1 {
  if (activeRuntime) return requireWorkspaceProfile(activeRuntime.database);
  const database = migrateDatabase(path.join(dataRootPath, 'wmb.db'));
  try { return requireWorkspaceProfile(database); } finally { database.close(); }
}

/** WMB-5118 §5.2：scanOnly 入口返回 = 领域原语结果 + 瞬时 deferred 让路信号（透传守卫命中）。 */
export type WorkspaceDailyIntelligenceRun = DailyIntelligenceRun & {
  deferred?: DeferredSignal | null;
};
function schedulerContext(lane: string, requestId: string, taskId?: string, workerLeaseId?: string) {
  return { actor: { type: 'scheduler' as const, id: lane, label: lane }, requestId, taskId, workerLeaseId };
}

function workspaceDependency(input: IntelligenceInput): { dependency: AgentTaskMutationDependency; database: DatabaseSync; close: () => void } {
  if (input.activeRuntime) return { dependency: input.activeRuntime, database: input.activeRuntime.database, close: () => {} };
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  return { dependency: database, database, close: () => database.close() };
}

export async function startWorkspaceDailyIntelligence(
  input: IntelligenceInput,
  runners: {
    ai?: (input: IntelligenceInput) => Promise<DailyIntelligenceRun>;
    uk?: (input: IntelligenceInput, profile: WorkspaceProfileV1) => Promise<DailyIntelligenceRun>;
    game?: (input: IntelligenceInput, profile: WorkspaceProfileV1) => Promise<DailyIntelligenceRun>;
  } = {}
): Promise<WorkspaceDailyIntelligenceRun> {
  const profile = readWorkspaceIntelligenceProfile(input.dataRootPath, input.activeRuntime);
  const hasInjected = profile.intelligencePackId === 'wemedia-intelligence-engine' ? Boolean(runners.ai)
    : profile.intelligencePackId === 'uk-life-content-radar' ? Boolean(runners.uk) : Boolean(runners.game);
  const { dependency, database, close } = workspaceDependency(input);
  try {
    const workspace = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
    if (!workspace?.value) throw new Error('WORKSPACE_ID_REQUIRED');
    const contextRefs = { planDate: input.businessDate, workspaceProfileId: profile.profileId, workspaceProfileRevision: profile.revision };
    if (input.judgeOnly) {
      // 增量判断入口：复用采集后处于 channel_scanned 的当日任务直接进入判断。
      if (profile.intelligencePackId === 'wemedia-intelligence-engine') return runners.ai ? runners.ai(input) : startDailyIntelligence(input);
      if (profile.intelligencePackId === 'uk-life-content-radar') return runners.uk ? runners.uk(input, profile) : startLaneDailyIntelligence(input, profile);
      return runners.game ? runners.game(input, profile) : startLaneDailyIntelligence(input, profile);
    }
    if (!hasInjected && !input.scanOnly) {
      const prerequisite = await resolveAgentPiPrerequisite(dependency, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
      if (prerequisite.waiting) return prerequisite.waiting;
    }
    const channels = await startDailyChannelRun(dependency, {
      businessDate: input.businessDate, workspaceId: workspace.value, profileRevision: profile.revision, modules: input.modules,
      workerLeaseId: input.workerLeaseId, onTaskReady: input.onTaskReady
    } satisfies DailyChannelInput);
    if (input.scanOnly) {
      const savedCount = channels.aggregation?.receipts.reduce((total, receipt) => total + receipt.savedCount, 0) ?? 0;
      if (channels.shouldRunJudgment && savedCount === 0 && channels.task.status === 'running') {
        // 本轮无新入库：直接收尾，避免留下常驻 running 任务；有新入库时保持 channel_scanned 等待 judgeOnly。
        const finished = await dispatchFinishDailyIntelligence(dependency, channels.task.id, {}, schedulerContext('daily-scan', `${channels.task.id}:scan-only:finish`, channels.task.id, input.workerLeaseId));
        return { task: finished, reused: channels.reused, savedCount, deferred: channels.deferred ?? null };
      }
      return { task: channels.task, reused: channels.reused, savedCount, deferred: channels.deferred ?? null };
    }
    if (!channels.shouldRunJudgment) return { task: channels.task, reused: channels.reused };
  } finally { close(); }
  if (profile.intelligencePackId === 'wemedia-intelligence-engine') return runners.ai ? runners.ai(input) : startDailyIntelligence(input);
  if (profile.intelligencePackId === 'uk-life-content-radar') return runners.uk ? runners.uk(input, profile) : startLaneDailyIntelligence(input, profile);
  return runners.game ? runners.game(input, profile) : startLaneDailyIntelligence(input, profile);
}

async function startLaneDailyIntelligence(input: IntelligenceInput, profile: WorkspaceProfileV1): Promise<DailyIntelligenceRun> {
  const { dependency, database, close } = workspaceDependency(input);
  const lane = profile.intelligencePackId;
  const startRequestId = `daily_intelligence:${input.businessDate}:${profile.profileId}:start:${randomUUID()}`;
  try {
    const contextRefs = { planDate: input.businessDate, workspaceProfileId: profile.profileId, workspaceProfileRevision: profile.revision };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting;
    const started = await dispatchStartAgentTask(dependency, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs }, schedulerContext(lane, startRequestId, undefined, input.workerLeaseId));
    const task = started.task;
    if (started.reused && !['resume_pending', 'starting', 'channel_scanned'].includes(task.phase)) return { task, reused: true };
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    const piSessionId = dailyAgentSessionId(input.businessDate, task.id);
    await dispatchUpdateAgentTaskPhase(dependency, task.id, task.phase, { piSessionId }, schedulerContext(lane, `${task.id}:phase:session:${piSessionId}`, task.id, input.workerLeaseId));
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    const skillRoot = workspaceSkillSourcePath(profile.intelligencePackId);
    const installedSkill = path.join(layout.agentDir, 'skills', profile.intelligencePackId);
    await mkdir(path.dirname(installedSkill), { recursive: true });
    await cp(skillRoot, installedSkill, { recursive: true, force: true });
    const extensionPath = await preparePiExtension(layout.agentDir);
    const workDir = await mkdtemp(path.join(os.tmpdir(), `wmb-${profile.intelligencePackId}-daily-`));
    const sessionFile = path.join(layout.agentDir, 'sessions', `${piSessionId}.jsonl`);
    const createRuntime = async (nextConfig: ResolvedPiConfig) => {
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
      const runtime = new PiRpcSupervisor(process.execPath, [
        piCliFromRuntimeRoot(await resolvePiRuntimeRoot(input.dataRootPath)), '--mode', 'rpc',
        '--session', sessionFile,
        '--skill', installedSkill, '-e', extensionPath, '--provider', 'wmb-api', '--model', nextConfig.model,
        '--append-system-prompt', piTaskAuthorityPrompt({
          taskId: task.id,
          grantId,
          workerLeaseId: input.workerLeaseId,
          context: `当前工作空间是${profile.displayName}；赛道判断只使用 ${profile.intelligencePackId}。`
        })
      ], {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PI_CODING_AGENT_DIR: layout.agentDir,
        WMB_PI_API_KEY: nextConfig.apiKey,
        WMB_MCP_URL: input.mcpUrl,
        WMB_XHS_MCP_URL: input.xhsMcpUrl || ''
      }, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
      input.onRuntime?.(runtime);
      return runtime;
    };
    let runtime: PiRpcSupervisor | null = null;
    const heartbeat = setInterval(() => {
      const current = getAgentTask(database, task.id);
      if (current?.status === 'running') void dispatchReportAgentTaskProgress(dependency, current.id, {}, schedulerContext(lane, `${current.id}:progress:heartbeat:${current.updatedAt}`, current.id, input.workerLeaseId)).catch(() => {});
    }, 15_000);
    try {
      await dispatchReportAgentTaskProgress(dependency, task.id, { phase: 'judging_opportunities', message: '渠道扫描已完成，正在评估新资料并更新选题池。' }, schedulerContext(lane, `${task.id}:progress:judging`, task.id, input.workerLeaseId));
      const startedRuntime = await startPiRuntimeWithFallback({
        piConfigPath: input.piConfigPath,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>)
      });
      runtime = startedRuntime.runtime;
      await runPiPromptWithFallback({
        piConfigPath: input.piConfigPath,
        initial: startedRuntime,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>),
        onRuntimeChanged: (nextRuntime) => {
          runtime = nextRuntime;
          input.onRuntime?.(nextRuntime);
        },
        run: async (activeRuntime) => {
          await activeRuntime.promptUntilSettled(lanePrompt(profile, task.id, input.businessDate), { timeoutMs: 10 * 60_000 });
        }
      });
      await dispatchUpdateAgentTaskPhase(dependency, task.id, 'validating', {}, schedulerContext(lane, `${task.id}:phase:validating`, task.id, input.workerLeaseId));
      const completed = await dispatchCompleteAgentTask(dependency, task.id, schedulerContext(lane, `${task.id}:complete`, task.id, input.workerLeaseId));
      return { task: completed, reused: false };
    } catch (error) {
      const current = getAgentTask(database, task.id);
      if (current?.status === 'running') {
        const partial = await dispatchFinishDailyIntelligence(dependency, current.id, {
          forcePartial: true,
          errorCode: profile.intelligencePackId === 'game-news-radar' ? 'GAME_INTELLIGENCE_FAILED' : 'UK_INTELLIGENCE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error)
        }, schedulerContext(lane, `${current.id}:finish:failed`, current.id, input.workerLeaseId));
        return { task: partial, reused: started.reused };
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      await runtime?.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { close(); }
}

function lanePrompt(profile: WorkspaceProfileV1, taskId: string, businessDate: string): string {
  return [
    `执行${profile.displayName}工作空间的今日情报任务。`, `task_id=${taskId}`, `plan_date=${businessDate}`, `skill=${profile.intelligencePackId}`,
    '只通过 wmb_* MCP 读取和写入当前工作空间。官网和 X List 已由共享渠道模块扫描完成；只判断当前根已有资料，不得写入未选渠道的新资料，也不得调用 AI 榜单、AI source-index、固定 AI List/wire、UK 路线或其他工作空间专属路线。',
    `方案使用 request_id=${agentRequestId(taskId, 'plan')}。非空方案必须引用真实 sourceIds；没有值得做的机会时保存空 items 方案。`,
    '最后调用 wmb_get_workbench 读回资料和方案；禁止直接写文件/数据库，禁止最终发布。'
  ].join('\n');
}

function workspaceSkillSourcePath(skillId: WorkspaceProfileV1['intelligencePackId']): string {
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../skills/${skillId}`);
  try {
    const electron = createRequire(import.meta.url)('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged) return path.join(process.resourcesPath, 'skills', skillId);
  } catch {}
  return local;
}
