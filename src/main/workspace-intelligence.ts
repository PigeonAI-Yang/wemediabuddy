import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { agentRequestId, completeAgentTask, failAgentTask, getAgentTask, startAgentTask, updateAgentTaskPhase } from './agent-tasks.ts';
import { startDailyIntelligence, type DailyIntelligenceRun } from './agent-runner.ts';
import { migrateDatabase } from './db/migrations.ts';
import { preparePiExtension } from './pi-extension.ts';
import { ensurePiConversationLayout } from './pi-conversation.ts';
import { resolvePiConfig } from './pi-config.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';
import { requireWorkspaceProfile, type WorkspaceProfileV1 } from './workspace-profiles.ts';

type IntelligenceInput = {
  dataRootPath: string;
  businessDate: string;
  mcpUrl: string;
  xhsMcpUrl?: string | null;
  onEvent?: (event: Record<string, unknown>) => void;
};

export function readWorkspaceIntelligenceProfile(dataRootPath: string): WorkspaceProfileV1 {
  const database = migrateDatabase(path.join(dataRootPath, 'wmb.db'));
  try { return requireWorkspaceProfile(database); } finally { database.close(); }
}

export async function startWorkspaceDailyIntelligence(
  input: IntelligenceInput,
  runners: { ai?: (input: IntelligenceInput) => Promise<DailyIntelligenceRun>; uk?: (input: IntelligenceInput, profile: WorkspaceProfileV1) => Promise<DailyIntelligenceRun> } = {}
): Promise<DailyIntelligenceRun> {
  const profile = readWorkspaceIntelligenceProfile(input.dataRootPath);
  return profile.officialTemplateId === 'official.ai'
    ? (runners.ai ?? startDailyIntelligence)(input)
    : (runners.uk ?? startUkDailyIntelligence)(input, profile);
}

async function startUkDailyIntelligence(input: IntelligenceInput, profile: WorkspaceProfileV1): Promise<DailyIntelligenceRun> {
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  try {
    const started = startAgentTask(database, {
      intent: 'daily_intelligence', businessDate: input.businessDate,
      contextRefs: { planDate: input.businessDate, workspaceProfileId: profile.profileId, workspaceProfileRevision: profile.revision },
      piSessionId: `daily-${input.businessDate}`
    });
    if (!started.ok) throw new Error(started.error.message);
    if (started.reused) return { task: started.data, reused: true };
    const config = resolvePiConfig(database);
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
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-uk-daily-'));
    const runtime = new PiRpcSupervisor(process.execPath, [
      piCliFromRuntimeRoot(await resolvePiRuntimeRoot(input.dataRootPath)), '--mode', 'rpc',
      '--session', path.join(layout.agentDir, 'sessions', `daily-${input.businessDate}.jsonl`),
      '--skill', installedSkill, '-e', extensionPath, '--provider', 'wmb-api', '--model', config.model,
      '--append-system-prompt', `你是 WeMediaBuddy 内置 Pi。当前工作空间是${profile.displayName}。只使用 ${profile.intelligencePackId} 和 wmb_* MCP；禁止 AI 榜单、AI source-index、X List 与最终发布。`
    ], {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: layout.agentDir,
      WMB_PI_API_KEY: config.apiKey, WMB_MCP_URL: input.mcpUrl, WMB_XHS_MCP_URL: input.xhsMcpUrl || ''
    }, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
    try {
      updateAgentTaskPhase(database, started.data.id, 'running_pi');
      await runtime.start();
      await runtime.promptUntilSettled(ukPrompt(started.data.id, input.businessDate), { timeoutMs: 10 * 60_000 });
      updateAgentTaskPhase(database, started.data.id, 'validating');
      const completed = completeAgentTask(database, started.data.id);
      if (!completed.ok) throw new Error(completed.error.message);
      return { task: completed.data, reused: false };
    } catch (error) {
      const current = getAgentTask(database, started.data.id);
      if (current?.status === 'running') failAgentTask(database, current.id, 'UK_INTELLIGENCE_FAILED', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await runtime.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { database.close(); }
}

function ukPrompt(taskId: string, businessDate: string): string {
  return [
    '执行英国生活工作空间的今日情报任务。', `task_id=${taskId}`, `plan_date=${businessDate}`, 'skill=uk-life-content-radar',
    '只通过 wmb_* MCP 读取和写入当前工作空间。禁止调用 AI 榜单、AI source-index、X List 或任何 AI 专属路线。',
    `资料使用稳定 request_id=${agentRequestId(taskId, 'uk-sources')}:<序号>；方案使用 request_id=${agentRequestId(taskId, 'uk-plan')}。`,
    '先保存有当前来源的英国生活资料，再保存引用真实 sourceIds 的完整方案；保留全部达到机会标准的结果。',
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
