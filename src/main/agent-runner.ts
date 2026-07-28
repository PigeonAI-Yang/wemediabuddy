import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { migrateDatabase } from './db/migrations.ts';
import {
  agentRequestId,
  completeAgentTask,
  failAgentTask,
  getAgentTask,
  startAgentTask,
  updateAgentTaskPhase,
  type AgentTask
} from './agent-tasks.ts';
import { ensurePiConversationLayout, readPiConversation } from './pi-conversation.ts';
import { resolvePiConfig } from './pi-config.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';

export type DailyIntelligenceRun = {
  task: AgentTask;
  reused: boolean;
};

function skillSourcePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills', 'wemedia-intelligence-engine')
    : path.join(app.getAppPath(), 'skills', 'wemedia-intelligence-engine');
}

async function piCliPath(dataRootPath: string): Promise<string> {
  return piCliFromRuntimeRoot(await resolvePiRuntimeRoot(dataRootPath));
}

function extensionSourcePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extensions', 'wmb-mcp.ts')
    : path.join(app.getAppPath(), '.pi', 'extensions', 'wmb-mcp.ts');
}

async function prepareSkillDir(agentDir: string): Promise<void> {
  const target = path.join(agentDir, 'skills', 'wemedia-intelligence-engine');
  await mkdir(path.dirname(target), { recursive: true });
  await cp(skillSourcePath(), target, { recursive: true, force: true });
}

function dailyPrompt(task: AgentTask, requestIds: { sources: string; plan: string }): string {
  return [
    '执行 WeMediaBuddy 今日情报任务。',
    `task_id=${task.id}`,
    `intent=${task.intent}`,
    `plan_date=${task.businessDate}`,
    'skill=wemedia-intelligence-engine',
    `sources_request_id=${requestIds.sources}`,
    `plan_request_id=${requestIds.plan}`,
    '要求：',
    '1. 只通过 wmb_* MCP 工具读写业务数据，禁止直接写文件或数据库，禁止最终发布。',
    '2. 先调用 wmb_get_workbench。',
    '3. 按 skill 选择当前真实可核验来源，至少保存 1 条资料；优先官方/开源一手来源。',
    `4. 保存资料时 requestId 必须使用 ${requestIds.sources}。`,
    `5. 用 wmb_save_plan 或 plans.save 保存 1-3 个今日机会，request_id 必须使用 ${requestIds.plan}；每个机会必须引用真实 sourceIds。`,
    '6. 机会 priority 不要用 1/2/3 给人看；按等级写整数：0=SSS（仅突发特别重大事件），1=S，2=A，3=B，>=4=C。默认用 1/2/3，只有真正黑天鹅级事件才写 0。',
    '7. 写回后调用 wmb_get_workbench 读回，确认资料和 plan 都存在。',
    '8. 最后用简洁中文回复：保存了几条资料、几个机会、首选机会标题及其等级（SSS/S/A/B/C）。',
    '如果外部读取失败，仍可用已核验的公开官方 URL 完成最小可用写入，但不得伪造不存在的业务对象。'
  ].join('\n');
}
export async function startDailyIntelligence(input: {
  dataRootPath: string;
  businessDate: string;
  mcpUrl: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<DailyIntelligenceRun> {
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  let taskId: string | null = null;
  try {
    const conversation = await readPiConversation(input.dataRootPath);
    const started = startAgentTask(database, {
      intent: 'daily_intelligence',
      businessDate: input.businessDate,
      contextRefs: { planDate: input.businessDate },
      piSessionId: conversation.sessionId
    });
    if (!started.ok) throw new Error(started.error.message);
    taskId = started.data.id;
    if (started.reused) return { task: started.data, reused: true };

    const config = resolvePiConfig(database);
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await prepareSkillDir(layout.agentDir);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify({
      providers: {
        'wmb-api': {
          baseUrl: config.baseUrl,
          api: 'openai-responses',
          apiKey: '$WMB_PI_API_KEY',
          models: [{
            id: config.model,
            name: config.model,
            reasoning: true,
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 16000
          }]
        }
      }
    }), 'utf8');
    const extensionPath = path.join(layout.agentDir, 'extensions', 'wmb-mcp.ts');
    await mkdir(path.dirname(extensionPath), { recursive: true });
    await writeFile(extensionPath, await readFile(extensionSourcePath()));

    const requestIds = {
      sources: agentRequestId(started.data.id, 'sources'),
      plan: agentRequestId(started.data.id, 'plan')
    };
    updateAgentTaskPhase(database, started.data.id, 'running_pi', { piSessionId: conversation.sessionId });

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-daily-'));
    const runtime = new PiRpcSupervisor(process.execPath, [
      await piCliPath(input.dataRootPath),
      '--mode', 'rpc',
      '--session', layout.sessionFile,
      '--no-builtin-tools',
      '--skill', path.join(layout.agentDir, 'skills', 'wemedia-intelligence-engine'),
      '-e', extensionPath,
      '--provider', 'wmb-api',
      '--model', config.model,
      '--append-system-prompt', '你是 WeMediaBuddy 内置 Pi。只通过 wmb_* MCP 工具完成今日情报写入。禁止直接写文件/数据库，禁止最终发布。'
    ], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PI_CODING_AGENT_DIR: layout.agentDir,
      WMB_PI_API_KEY: config.apiKey,
      WMB_MCP_URL: input.mcpUrl
    }, (event) => {
      input.onEvent?.(event as Record<string, unknown>);
    }, workDir);

    try {
      await runtime.start();
      await runtime.promptUntilSettled(dailyPrompt(started.data, requestIds), { timeoutMs: 300000 });
      updateAgentTaskPhase(database, started.data.id, 'validating');
      const completed = completeAgentTask(database, started.data.id);
      if (!completed.ok) {
        failAgentTask(database, started.data.id, completed.error.code, completed.error.message);
        throw new Error(completed.error.message);
      }
      return { task: completed.data, reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, started.data.id);
      if (current?.status === 'running') failAgentTask(database, started.data.id, 'DAILY_INTELLIGENCE_FAILED', message);
      throw error;
    } finally {
      await runtime.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally {
    if (taskId) {
      // no-op placeholder for future tracing
    }
    database.close();
  }
}

function draftPrompt(task: AgentTask, projectId: string, requestId: string): string {
  return [
    '执行 WeMediaBuddy Studio 初稿任务。',
    `task_id=${task.id}`,
    'intent=studio_draft',
    `project_id=${projectId}`,
    `version_request_id=${requestId}`,
    '要求：',
    '1. 只通过 wmb_* MCP 工具读写业务数据，禁止直接写文件或数据库，禁止最终发布。',
    '2. 先调用 wmb_get_content 与 wmb_get_workbench，定位指定 project。',
    '3. 基于项目标题和关联资料，写一篇完整中文核心初稿正文。',
    `4. 调用 wmb_save_core_version，requestId 必须是 ${requestId}，projectId 必须是 ${projectId}，body 为完整正文。`,
    '5. 再调用 wmb_get_content 确认该项目已有核心版本正文。',
    '6. 最后用简洁中文回复：已保存核心版本，并给出正文前两句。'
  ].join('\n');
}

export async function startStudioDraft(input: {
  dataRootPath: string;
  businessDate: string;
  projectId: string;
  mcpUrl: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<DailyIntelligenceRun> {
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  try {
    const conversation = await readPiConversation(input.dataRootPath);
    const started = startAgentTask(database, {
      intent: 'studio_draft',
      businessDate: input.businessDate,
      contextRefs: { projectId: input.projectId },
      piSessionId: conversation.sessionId
    });
    if (!started.ok) throw new Error(started.error.message);
    if (started.reused) return { task: started.data, reused: true };

    const config = resolvePiConfig(database);
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify({
      providers: {
        'wmb-api': {
          baseUrl: config.baseUrl,
          api: 'openai-responses',
          apiKey: '$WMB_PI_API_KEY',
          models: [{
            id: config.model,
            name: config.model,
            reasoning: true,
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 16000
          }]
        }
      }
    }), 'utf8');
    const extensionPath = path.join(layout.agentDir, 'extensions', 'wmb-mcp.ts');
    await mkdir(path.dirname(extensionPath), { recursive: true });
    await writeFile(extensionPath, await readFile(extensionSourcePath()));
    const requestId = agentRequestId(started.data.id, 'core_version');
    updateAgentTaskPhase(database, started.data.id, 'running_pi', { piSessionId: conversation.sessionId });

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-draft-'));
    const runtime = new PiRpcSupervisor(process.execPath, [
      await piCliPath(input.dataRootPath),
      '--mode', 'rpc',
      '--session', layout.sessionFile,
      '--no-builtin-tools',
      '-e', extensionPath,
      '--provider', 'wmb-api',
      '--model', config.model,
      '--append-system-prompt', '你是 WeMediaBuddy 内置 Pi。只通过 wmb_* MCP 工具保存 Studio 核心初稿。禁止直接写文件/数据库，禁止最终发布。'
    ], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PI_CODING_AGENT_DIR: layout.agentDir,
      WMB_PI_API_KEY: config.apiKey,
      WMB_MCP_URL: input.mcpUrl
    }, (event) => {
      input.onEvent?.(event as Record<string, unknown>);
    }, workDir);

    try {
      await runtime.start();
      await runtime.promptUntilSettled(draftPrompt(started.data, input.projectId, requestId), { timeoutMs: 300000 });
      updateAgentTaskPhase(database, started.data.id, 'validating');
      const completed = completeAgentTask(database, started.data.id);
      if (!completed.ok) {
        failAgentTask(database, started.data.id, completed.error.code, completed.error.message);
        throw new Error(completed.error.message);
      }
      return { task: completed.data, reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, started.data.id);
      if (current?.status === 'running') failAgentTask(database, started.data.id, 'STUDIO_DRAFT_FAILED', message);
      throw error;
    } finally {
      await runtime.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally {
    database.close();
  }
}

function reviewPrompt(task: AgentTask, publicationId: string, requestId: string): string {
  return [
    '执行 WeMediaBuddy Results 复盘任务。',
    `task_id=${task.id}`,
    'intent=results_review',
    `publication_id=${publicationId}`,
    `review_request_id=${requestId}`,
    '要求：',
    '1. 只通过 wmb_* MCP 工具读写业务数据，禁止直接写文件或数据库，禁止最终发布。',
    `2. 先调用 wmb_get_metrics({ publicationId: "${publicationId}" }) 读取真实指标快照。`,
    `3. 再调用 wmb_get_reviews({ publicationId: "${publicationId}" }) 了解是否已有复盘。`,
    '4. 基于真实指标写具体 Keep/Stop/Change，每项至少 1 条，禁止空话。',
    '5. 写 1 条方法结论（title + body）。',
    `6. 调用 wmb_save_review：requestId 必须是 ${requestId}，publicationId 必须是 ${publicationId}，metricSnapshotIds 使用步骤2读到的真实快照 ID，status 必须是 final，并附 findings。`,
    '7. 再调用 wmb_get_reviews 读回，确认 final 复盘存在。',
    '8. 最后用简洁中文回复：复盘 ID、Keep/Stop/Change 各一句摘要、方法结论标题。'
  ].join('\n');
}

export async function startResultsReview(input: {
  dataRootPath: string;
  businessDate: string;
  publicationId: string;
  mcpUrl: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<DailyIntelligenceRun> {
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  try {
    const conversation = await readPiConversation(input.dataRootPath);
    const started = startAgentTask(database, {
      intent: 'results_review',
      businessDate: input.businessDate,
      contextRefs: { publicationId: input.publicationId },
      piSessionId: conversation.sessionId
    });
    if (!started.ok) throw new Error(started.error.message);
    if (started.reused) return { task: started.data, reused: true };

    const config = resolvePiConfig(database);
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify({
      providers: {
        'wmb-api': {
          baseUrl: config.baseUrl,
          api: 'openai-responses',
          apiKey: '$WMB_PI_API_KEY',
          models: [{
            id: config.model,
            name: config.model,
            reasoning: true,
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 16000
          }]
        }
      }
    }), 'utf8');
    const extensionPath = path.join(layout.agentDir, 'extensions', 'wmb-mcp.ts');
    await mkdir(path.dirname(extensionPath), { recursive: true });
    await writeFile(extensionPath, await readFile(extensionSourcePath()));
    const requestId = agentRequestId(started.data.id, 'review');
    updateAgentTaskPhase(database, started.data.id, 'running_pi', { piSessionId: conversation.sessionId });

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-review-'));
    const runtime = new PiRpcSupervisor(process.execPath, [
      await piCliPath(input.dataRootPath),
      '--mode', 'rpc',
      '--session', layout.sessionFile,
      '--no-builtin-tools',
      '-e', extensionPath,
      '--provider', 'wmb-api',
      '--model', config.model,
      '--append-system-prompt', '你是 WeMediaBuddy 内置 Pi。只通过 wmb_* MCP 工具基于真实指标完成 Results 复盘。禁止直接写文件/数据库，禁止最终发布。'
    ], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PI_CODING_AGENT_DIR: layout.agentDir,
      WMB_PI_API_KEY: config.apiKey,
      WMB_MCP_URL: input.mcpUrl
    }, (event) => {
      input.onEvent?.(event as Record<string, unknown>);
    }, workDir);

    try {
      await runtime.start();
      await runtime.promptUntilSettled(reviewPrompt(started.data, input.publicationId, requestId), { timeoutMs: 300000 });
      updateAgentTaskPhase(database, started.data.id, 'validating');
      const completed = completeAgentTask(database, started.data.id);
      if (!completed.ok) {
        failAgentTask(database, started.data.id, completed.error.code, completed.error.message);
        throw new Error(completed.error.message);
      }
      return { task: completed.data, reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, started.data.id);
      if (current?.status === 'running') failAgentTask(database, started.data.id, 'RESULTS_REVIEW_FAILED', message);
      throw error;
    } finally {
      await runtime.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally {
    database.close();
  }
}
