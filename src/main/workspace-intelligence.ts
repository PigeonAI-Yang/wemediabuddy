import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { agentRequestId, completeAgentTask, finishDailyIntelligenceFromReceipts, getAgentTask, reportAgentTaskProgress, startAgentTask, updateAgentTaskPhase } from './agent-tasks.ts';
import { resolveAgentPiPrerequisite } from './agent-prerequisites.ts';
import { startDailyIntelligence, type DailyIntelligenceRun } from './agent-runner.ts';
import { startDailyChannelRun, type DailyChannelInput } from './daily-intelligence-channels.ts';
import { migrateDatabase } from './db/migrations.ts';
import { preparePiExtension } from './pi-extension.ts';
import { ensurePiConversationLayout } from './pi-conversation.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';
import { requireWorkspaceProfile, type WorkspaceProfileV1 } from './workspace-profiles.ts';
import type { IntelligenceModule } from './intelligence-channels.ts';

type IntelligenceInput = {
  dataRootPath: string; piConfigPath?: string;
  businessDate: string;
  mcpUrl: string;
  xhsMcpUrl?: string | null;
  onEvent?: (event: Record<string, unknown>) => void;
  modules?: IntelligenceModule[];
};

export function readWorkspaceIntelligenceProfile(dataRootPath: string): WorkspaceProfileV1 {
  const database = migrateDatabase(path.join(dataRootPath, 'wmb.db'));
  try { return requireWorkspaceProfile(database); } finally { database.close(); }
}

export async function startWorkspaceDailyIntelligence(
  input: IntelligenceInput,
  runners: {
    ai?: (input: IntelligenceInput) => Promise<DailyIntelligenceRun>;
    uk?: (input: IntelligenceInput, profile: WorkspaceProfileV1) => Promise<DailyIntelligenceRun>;
    game?: (input: IntelligenceInput, profile: WorkspaceProfileV1) => Promise<DailyIntelligenceRun>;
  } = {}
): Promise<DailyIntelligenceRun> {
  const profile = readWorkspaceIntelligenceProfile(input.dataRootPath);
  const hasInjected = profile.intelligencePackId === 'wemedia-intelligence-engine' ? Boolean(runners.ai)
    : profile.intelligencePackId === 'uk-life-content-radar' ? Boolean(runners.uk) : Boolean(runners.game);
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  try {
    const workspace = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
    if (!workspace?.value) throw new Error('WORKSPACE_ID_REQUIRED');
    const contextRefs = { planDate: input.businessDate, workspaceProfileId: profile.profileId, workspaceProfileRevision: profile.revision };
    if (!hasInjected) {
      const prerequisite = resolveAgentPiPrerequisite(database, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs, piSessionId: `daily-${input.businessDate}`, piConfigPath: input.piConfigPath });
      if (prerequisite.waiting) return prerequisite.waiting;
    }
    const channels = await startDailyChannelRun(database, {
      businessDate: input.businessDate, workspaceId: workspace.value, profileRevision: profile.revision, modules: input.modules
    } satisfies DailyChannelInput);
    if (!channels.shouldRunJudgment) return { task: channels.task, reused: channels.reused };
  } finally { database.close(); }
  if (profile.intelligencePackId === 'wemedia-intelligence-engine') return runners.ai ? runners.ai(input) : startDailyIntelligence(input);
  if (profile.intelligencePackId === 'uk-life-content-radar') return runners.uk ? runners.uk(input, profile) : startLaneDailyIntelligence(input, profile);
  return runners.game ? runners.game(input, profile) : startLaneDailyIntelligence(input, profile);
}

async function startLaneDailyIntelligence(input: IntelligenceInput, profile: WorkspaceProfileV1): Promise<DailyIntelligenceRun> {
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  try {
    const contextRefs = { planDate: input.businessDate, workspaceProfileId: profile.profileId, workspaceProfileRevision: profile.revision };
    const prerequisite = resolveAgentPiPrerequisite(database, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs, piSessionId: `daily-${input.businessDate}`, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting;
    const config = prerequisite.config;
    const started = startAgentTask(database, {
      intent: 'daily_intelligence', businessDate: input.businessDate,
      contextRefs,
      piSessionId: `daily-${input.businessDate}`
    });
    if (!started.ok) throw new Error(started.error.message);
    if (started.reused && !['resume_pending', 'starting', 'channel_scanned'].includes(started.data.phase)) return { task: started.data, reused: true };
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    const skillRoot = workspaceSkillSourcePath(profile.intelligencePackId);
    const installedSkill = path.join(layout.agentDir, 'skills', profile.intelligencePackId);
    await mkdir(path.dirname(installedSkill), { recursive: true });
    await cp(skillRoot, installedSkill, { recursive: true, force: true });
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify({ providers: { 'wmb-api': {
      baseUrl: config.baseUrl, api: config.api, apiKey: '$WMB_PI_API_KEY',
      models: [{ id: config.model, name: config.model, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 16000 }]
    } } }), 'utf8');
    const extensionPath = await preparePiExtension(layout.agentDir);
    const workDir = await mkdtemp(path.join(os.tmpdir(), `wmb-${profile.intelligencePackId}-daily-`));
    const runtime = new PiRpcSupervisor(process.execPath, [
      piCliFromRuntimeRoot(await resolvePiRuntimeRoot(input.dataRootPath)), '--mode', 'rpc',
      '--session', path.join(layout.agentDir, 'sessions', `daily-${input.businessDate}.jsonl`),
      '--skill', installedSkill, '-e', extensionPath, '--provider', 'wmb-api', '--model', config.model,
      '--append-system-prompt', `你是 WeMediaBuddy 内置 Pi。当前工作空间是${profile.displayName}。只使用 ${profile.intelligencePackId} 和 wmb_* MCP；禁止 AI 榜单、AI source-index、固定 AI List/wire 与最终发布。通用 X List 只能读取、准备或采集当前根已启用绑定，不能确认。`
    ], {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: layout.agentDir,
      WMB_PI_API_KEY: config.apiKey, WMB_MCP_URL: input.mcpUrl, WMB_XHS_MCP_URL: input.xhsMcpUrl || ''
    }, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
    const heartbeat = setInterval(() => {
      const current = getAgentTask(database, started.data.id);
      if (current?.status === 'running') reportAgentTaskProgress(database, current.id, {});
    }, 15_000);
    try {
      reportAgentTaskProgress(database, started.data.id, {
        phase: 'judging_opportunities',
        message: '渠道扫描已完成，正在判断内容机会并生成今日运营方案。'
      });
      await runtime.start();
      await runtime.promptUntilSettled(lanePrompt(profile, started.data.id, input.businessDate), { timeoutMs: 10 * 60_000 });
      updateAgentTaskPhase(database, started.data.id, 'validating');
      const completed = completeAgentTask(database, started.data.id);
      if (!completed.ok) throw new Error(completed.error.message);
      return { task: completed.data, reused: false };
    } catch (error) {
      const current = getAgentTask(database, started.data.id);
      if (current?.status === 'running') finishDailyIntelligenceFromReceipts(database, current.id, {
        forcePartial: true,
        errorCode: profile.intelligencePackId === 'game-news-radar' ? 'GAME_INTELLIGENCE_FAILED' : 'UK_INTELLIGENCE_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      await runtime.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { database.close(); }
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
