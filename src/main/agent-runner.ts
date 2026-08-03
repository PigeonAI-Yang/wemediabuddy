import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { migrateDatabase } from './db/migrations.ts';
import { refreshWorkCarry } from './ferment.ts';
import { listWatchingSources } from './knowledge.ts';
import {
  agentRequestId,
  cancelAgentTask,
  completeAgentTask,
  failAgentTask,
  finishDailyIntelligenceFromReceipts,
  getAgentTask,
  partialAgentTask,
  reportAgentTaskProgress,
  startAgentTask,
  updateAgentTaskPhase,
  type AgentTask
} from './agent-tasks.ts';
import { resolveAgentPiPrerequisite } from './agent-prerequisites.ts';
import { ensurePiConversationLayout, readPiConversation } from './pi-conversation.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';
import { listXPostTrends } from './x-post-metrics.ts';

const activeDailyRuntimes = new Map<string, PiRpcSupervisor>();
export async function abortDailyIntelligence(taskId: string): Promise<boolean> {
  const runtime = activeDailyRuntimes.get(taskId);
  if (!runtime) return false;
  await runtime.stop().catch(() => {});
  return true;
}

export type DailyIntelligenceRun = {
  task: AgentTask;
  reused: boolean;
};

function skillSourcePath(): string {
  // Prefer the repo/runtime copy next to this module. Electron getAppPath() can point at
  // ad-hoc runner directories (e.g. .ai/) and is unreliable for headless launches.
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/wemedia-intelligence-engine');
  try {
    const require = createRequire(import.meta.url);
    const electron = require('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged) {
      return path.join(process.resourcesPath, 'skills', 'wemedia-intelligence-engine');
    }
  } catch {
    // ignore
  }
  return local;
}

async function piCliPath(dataRootPath: string): Promise<string> {
  return piCliFromRuntimeRoot(await resolvePiRuntimeRoot(dataRootPath));
}

async function prepareSkillDir(agentDir: string): Promise<void> {
  const target = path.join(agentDir, 'skills', 'wemedia-intelligence-engine');
  await mkdir(path.dirname(target), { recursive: true });
  await cp(skillSourcePath(), target, { recursive: true, force: true });
}

function dailyPrompt(task: AgentTask, planRequestId: string, context: { watchingSummary: string; fermentingSummary: string; trendSummary: string }): string {
  return [
    '执行 WeMediaBuddy 今日情报任务。',
    `task_id=${task.id}`,
    `intent=${task.intent}`,
    `plan_date=${task.businessDate}`,
    'skill=wemedia-intelligence-engine',
    `plan_request_id=${planRequestId}`,
    `checkpoint=${JSON.stringify(task.checkpoint)}`,
    '要求：',
    '1. 只通过 wmb_* MCP 工具读写业务数据，禁止直接写文件或数据库，禁止最终发布。',
    '2. 官网和 X List 已由共享渠道模块完成真实扫描。只基于当前根已入库资料、受众和编辑目标做机会判断；不得再次调用固定 AI source-index、固定 AI List/wire、扫描其他未选来源，或写入未选渠道的新资料。',
    '3. 先调用 wmb_get_workbench 与 wmb_get_agent_task；若没有值得做的机会，仍必须用空 items 调用 wmb_save_plan 保存空方案。',
    `4. 方案使用 request_id=${planRequestId}。非空方案的每个机会必须引用真实 sourceIds。`,
    '5. 机会 priority：0=SSS，1=S，2=A，3=B，4=C，5=D，6=E，7=F。未达到机会标准的线索不凑成方案。',
    '6. 综合时同时参考以下已有的观察与发酵差集；它们只用于判断，禁止为此另行浏览或扫描新来源。',
    `当前观察中：${context.watchingSummary}`,
    `当前发酵差集：${context.fermentingSummary}`,
    `当前 X 趋势证据：${context.trendSummary}`,
    '7. 趋势只引用给出的真实 sourceItemId、snapshotIds、流速和采集时间；不得补齐缺失指标或制造热度分。写回后调用 wmb_get_workbench 读回资料和方案。'
  ].join('\n');
}

export function buildDailyOpportunityPrompt(database: Parameters<typeof refreshWorkCarry>[0], task: AgentTask, planRequestId: string): string {
  const fermenting = refreshWorkCarry(database, task.businessDate);
  const watchingSummary = JSON.stringify(listWatchingSources(database, 20).map((item) => ({ id: item.id, title: item.title, topics: item.topics, priority: item.priority })));
  const fermentingSummary = JSON.stringify({
    items: fermenting.items.slice(0, 5).map((item) => ({ title: item.title, state: item.state, priority: item.priority, fermentedDays: item.fermentedDays, reason: item.reason, aftershocks: item.aftershocks.slice(0, 2).map((shock) => shock.title) })),
    topics: fermenting.topics.slice(0, 5)
  });
  const trendSummary = JSON.stringify(listXPostTrends(database, { limit: 20 }).map((trend) => ({
    sourceItemId: trend.sourceItemId, status: trend.status, reason: trend.reason,
    viewsPerHour: trend.viewsPerHour, velocityChange: trend.velocityChange,
    capturedAt: trend.snapshots.at(-1)?.capturedAt ?? null
  })));
  return dailyPrompt(task, planRequestId, { watchingSummary, fermentingSummary, trendSummary });
}

export function cancelDailyIntelligenceIfRequested(database: Parameters<typeof cancelAgentTask>[0], task: AgentTask | null | undefined): AgentTask | null {
  if (task?.status !== 'running' || task.controlAction !== 'cancel') return null;
  const cancelled = cancelAgentTask(database, task.id);
  if (!cancelled.ok) throw new Error(cancelled.error.message);
  return cancelled.data;
}
export async function startDailyIntelligence(input: {
  dataRootPath: string; businessDate: string; piConfigPath?: string;
  mcpUrl: string;
  xhsMcpUrl?: string | null;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<DailyIntelligenceRun> {
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  try {
    const contextRefs = { planDate: input.businessDate }; const prerequisite = resolveAgentPiPrerequisite(database, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs, piSessionId: `daily-${input.businessDate}`, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting; const config = prerequisite.config;
    const conversation = await readPiConversation(input.dataRootPath);
    const started = startAgentTask(database, {
      intent: 'daily_intelligence',
      businessDate: input.businessDate,
      contextRefs,
      // Keep dock chat session separate; daily wire must not inherit image-bearing chat history.
      piSessionId: `daily-${input.businessDate}`
    });
    if (!started.ok) throw new Error(started.error.message);
    if (started.reused && !['resume_pending', 'starting', 'channel_scanned'].includes(started.data.phase)) return { task: started.data, reused: true };

    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await prepareSkillDir(layout.agentDir);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify({
      providers: {
        'wmb-api': {
          baseUrl: config.baseUrl,
          api: config.api,
          apiKey: '$WMB_PI_API_KEY',
          models: [{
            id: config.model,
            name: config.model,
            reasoning: true,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 16000
          }]
        }
      }
    }), 'utf8');
    const extensionPath = await preparePiExtension(layout.agentDir);

    reportAgentTaskProgress(database, started.data.id, {
      phase: started.data.phase === 'resume_pending' ? 'resuming' : 'judging_opportunities',
      message: started.data.phase === 'resume_pending' ? '已从持久检查点恢复任务。' : '正在根据已扫描来源判断内容机会。'
    });

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-daily-'));
    const cliPath = await piCliPath(input.dataRootPath);
    const dailySessionFile = path.join(layout.agentDir, 'sessions', `daily-${input.businessDate}.jsonl`);
    await mkdir(path.dirname(dailySessionFile), { recursive: true });
    const runtimeArgs = [
      cliPath,
      '--mode', 'rpc',
      '--session', dailySessionFile,
      '--skill', path.join(layout.agentDir, 'skills', 'wemedia-intelligence-engine'),
      '-e', extensionPath,
      '--provider', 'wmb-api',
      '--model', config.model,
      '--append-system-prompt', PI_AUTHORITY_SYSTEM_PROMPT
    ];
    const runtimeEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PI_CODING_AGENT_DIR: layout.agentDir,
      WMB_PI_API_KEY: config.apiKey,
      WMB_MCP_URL: input.mcpUrl,
      WMB_XHS_MCP_URL: input.xhsMcpUrl || ''
    };
    const makeRuntime = () => new PiRpcSupervisor(process.execPath, runtimeArgs, runtimeEnv, (event) => {
      input.onEvent?.(event as Record<string, unknown>);
    }, workDir);

    try {
      const heartbeat = setInterval(() => {
        const current = getAgentTask(database, started.data.id);
        if (current?.status === 'running') {
          const updated = reportAgentTaskProgress(database, current.id, {});
          if (updated.ok) input.onEvent?.({ type: 'agent_task', task: updated.data });
        }
      }, 15_000);
      try {
        const beforePlan = getAgentTask(database, started.data.id);
        if (beforePlan?.status !== 'running') return { task: beforePlan!, reused: started.reused === true };
        const cancelledBeforePlan = cancelDailyIntelligenceIfRequested(database, beforePlan);
        if (cancelledBeforePlan) return { task: cancelledBeforePlan, reused: started.reused === true };
        if (beforePlan.controlAction === 'save_partial') {
          const partial = partialAgentTask(database, beforePlan.id);
          if (!partial.ok) throw new Error(partial.error.message);
          return { task: partial.data, reused: started.reused === true };
        }
        reportAgentTaskProgress(database, beforePlan.id, { phase: 'synthesizing', message: '共享来源扫描结束，正在整理内容机会。' });
        const synthesis = makeRuntime();
        activeDailyRuntimes.set(beforePlan.id, synthesis);
        try {
          await synthesis.start();
          await synthesis.promptUntilSettled(buildDailyOpportunityPrompt(database, getAgentTask(database, beforePlan.id) ?? beforePlan, agentRequestId(beforePlan.id, 'plan')), { timeoutMs: 6 * 60_000 });
        } catch (error) {
          // Shared channel scans already persisted sources and receipts. Don't discard the day
          // just because final synthesis provider call failed (e.g. model modality mismatch).
          const latest = getAgentTask(database, beforePlan.id) ?? beforePlan;
          const cancelled = cancelDailyIntelligenceIfRequested(database, latest);
          if (cancelled) return { task: cancelled, reused: started.reused === true };
          const message = error instanceof Error ? error.message : String(error);
          reportAgentTaskProgress(database, latest.id, {
            phase: 'synthesis_failed',
            message: `综合整理失败，保留已扫描结果：${message.slice(0, 180)}`,
            level: 'warning'
          });
          const partial = finishDailyIntelligenceFromReceipts(database, latest.id, {
            forcePartial: true,
            errorCode: 'DAILY_INTELLIGENCE_FAILED',
            errorMessage: message
          });
          if (partial.ok) return { task: partial.data, reused: started.reused === true };
          throw error;
        } finally {
          activeDailyRuntimes.delete(beforePlan.id);
          await synthesis.stop().catch(() => {});
        }
      } finally {
        clearInterval(heartbeat);
      }
      const afterRun = getAgentTask(database, started.data.id);
      const cancelledAfterRun = cancelDailyIntelligenceIfRequested(database, afterRun);
      if (cancelledAfterRun) return { task: cancelledAfterRun, reused: started.reused === true };
      if (afterRun?.controlAction === 'save_partial') {
        const partial = finishDailyIntelligenceFromReceipts(database, started.data.id, { forcePartial: true });
        if (!partial.ok) throw new Error(partial.error.message);
        return { task: partial.data, reused: started.reused === true };
      }
      if (afterRun?.status === 'cancelled') return { task: afterRun, reused: started.reused === true };
      updateAgentTaskPhase(database, started.data.id, 'validating');
      const completed = completeAgentTask(database, started.data.id);
      if (!completed.ok) {
        // Prefer keeping a useful day over hard-failing on residual validation edge cases.
        reportAgentTaskProgress(database, started.data.id, {
          phase: 'validating',
          message: `完成校验未完全通过，尝试保留结果：${completed.error.message}`,
          level: 'warning'
        });
        const partial = finishDailyIntelligenceFromReceipts(database, started.data.id, {
          forcePartial: true,
          errorCode: completed.error.code,
          errorMessage: completed.error.message
        });
        if (partial.ok) return { task: partial.data, reused: started.reused === true };
        failAgentTask(database, started.data.id, completed.error.code, completed.error.message);
        throw new Error(completed.error.message);
      }
      return { task: completed.data, reused: started.reused === true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, started.data.id);
      const cancelled = cancelDailyIntelligenceIfRequested(database, current);
      if (cancelled) return { task: cancelled, reused: started.reused === true };
      if (current?.status === 'running') finishDailyIntelligenceFromReceipts(database, started.data.id, {
        forcePartial: true,
        errorCode: 'DAILY_INTELLIGENCE_FAILED',
        errorMessage: message
      });
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { database.close(); }
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
    `2. 先调用 wmb_get_content({ projectId: "${projectId}" }) 与 wmb_get_workbench，定位指定 project。`,
    '3. 基于项目标题和关联资料，写一篇完整中文核心初稿正文。',
    `4. 调用 wmb_save_core_version，requestId 必须是 ${requestId}，projectId 必须是 ${projectId}，expectedRevision 使用步骤2读到的当前项目 revision，body 为完整正文。`,
    `5. 再调用 wmb_get_content({ projectId: "${projectId}" }) 确认该项目已有核心版本正文。`,
    '6. 最后用简洁中文回复：已保存核心版本，并给出正文前两句。'
  ].join('\n');
}

export async function startStudioDraft(input: {
  dataRootPath: string; businessDate: string; piConfigPath?: string;
  projectId: string;
  mcpUrl: string;
  xhsMcpUrl?: string | null;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<DailyIntelligenceRun> {
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  try {
    const contextRefs = { projectId: input.projectId }; const prerequisite = resolveAgentPiPrerequisite(database, { intent: 'studio_draft', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting; const config = prerequisite.config;
    const conversation = await readPiConversation(input.dataRootPath);
    const started = startAgentTask(database, {
      intent: 'studio_draft',
      businessDate: input.businessDate,
      contextRefs,
      piSessionId: conversation.sessionId
    });
    if (!started.ok) throw new Error(started.error.message);
    if (started.reused) return { task: started.data, reused: true };

    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify({
      providers: {
        'wmb-api': {
          baseUrl: config.baseUrl,
          api: config.api,
          apiKey: '$WMB_PI_API_KEY',
          models: [{
            id: config.model,
            name: config.model,
            reasoning: true,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 16000
          }]
        }
      }
    }), 'utf8');
    const extensionPath = await preparePiExtension(layout.agentDir);
    const requestId = agentRequestId(started.data.id, 'core_version');
    updateAgentTaskPhase(database, started.data.id, 'running_pi', { piSessionId: conversation.sessionId });

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-draft-'));
    const runtime = new PiRpcSupervisor(process.execPath, [
      await piCliPath(input.dataRootPath),
      '--mode', 'rpc',
      '--session', layout.sessionFile,
      '-e', extensionPath,
      '--provider', 'wmb-api',
      '--model', config.model,
      '--append-system-prompt', PI_AUTHORITY_SYSTEM_PROMPT
    ], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PI_CODING_AGENT_DIR: layout.agentDir,
      WMB_PI_API_KEY: config.apiKey,
      WMB_MCP_URL: input.mcpUrl,
      WMB_XHS_MCP_URL: input.xhsMcpUrl || ''
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
  dataRootPath: string; businessDate: string; piConfigPath?: string;
  publicationId: string;
  mcpUrl: string;
  xhsMcpUrl?: string | null;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<DailyIntelligenceRun> {
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  try {
    const contextRefs = { publicationId: input.publicationId }; const prerequisite = resolveAgentPiPrerequisite(database, { intent: 'results_review', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting; const config = prerequisite.config;
    const conversation = await readPiConversation(input.dataRootPath);
    const started = startAgentTask(database, {
      intent: 'results_review',
      businessDate: input.businessDate,
      contextRefs,
      piSessionId: conversation.sessionId
    });
    if (!started.ok) throw new Error(started.error.message);
    if (started.reused) return { task: started.data, reused: true };

    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify({
      providers: {
        'wmb-api': {
          baseUrl: config.baseUrl,
          api: config.api,
          apiKey: '$WMB_PI_API_KEY',
          models: [{
            id: config.model,
            name: config.model,
            reasoning: true,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 16000
          }]
        }
      }
    }), 'utf8');
    const extensionPath = await preparePiExtension(layout.agentDir);
    const requestId = agentRequestId(started.data.id, 'review');
    updateAgentTaskPhase(database, started.data.id, 'running_pi', { piSessionId: conversation.sessionId });

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-review-'));
    const runtime = new PiRpcSupervisor(process.execPath, [
      await piCliPath(input.dataRootPath),
      '--mode', 'rpc',
      '--session', layout.sessionFile,
      '-e', extensionPath,
      '--provider', 'wmb-api',
      '--model', config.model,
      '--append-system-prompt', PI_AUTHORITY_SYSTEM_PROMPT
    ], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PI_CODING_AGENT_DIR: layout.agentDir,
      WMB_PI_API_KEY: config.apiKey,
      WMB_MCP_URL: input.mcpUrl,
      WMB_XHS_MCP_URL: input.xhsMcpUrl || ''
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
import { preparePiExtension } from './pi-extension.ts';
import { PI_AUTHORITY_SYSTEM_PROMPT } from './pi-operator-skill.ts';
