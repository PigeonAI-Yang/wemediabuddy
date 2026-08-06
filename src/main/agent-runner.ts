import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './db/migrations.ts';
import { assembleEditorialBrief, renderEditorialBrief } from './editorial-brief.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import type { TaskReadyGrantHook } from './task-grants.ts';
import {
  agentRequestId,
  cancelAgentTask,
  dailyAgentSessionId,
  getAgentTask,
  type AgentTask
} from './agent-tasks.ts';
import {
  dispatchCancelAgentTask,
  dispatchCompleteAgentTask,
  dispatchFailAgentTask,
  dispatchFinishDailyIntelligence,
  dispatchPartialAgentTask,
  dispatchReportAgentTaskProgress,
  dispatchStartAgentTask,
  dispatchUpdateAgentTaskPhase,
  type AgentTaskCommandContext,
  type AgentTaskMutationDependency
} from './agent-task-commands.ts';
import { resolveAgentPiPrerequisite } from './agent-prerequisites.ts';
import { ensurePiConversationLayout, readPiConversation } from './pi-conversation.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piModelsJson } from './pi-model.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';

function schedulerActor(lane: string) {
  return { type: 'scheduler' as const, id: lane, label: lane };
}

function taskCommandContext(lane: string, requestId: string, taskId?: string, workerLeaseId?: string, causation?: Readonly<Record<string, unknown>>): AgentTaskCommandContext {
  return { actor: schedulerActor(lane), requestId, taskId, workerLeaseId, causation };
}

function piPromptTimeoutMs(): number {
  const raw = Number(process.env.WMB_PI_PROMPT_TIMEOUT_MS ?? 300_000);
  return Number.isFinite(raw) && raw >= 30_000 ? Math.floor(raw) : 300_000;
}

function mutationDependency(input: { activeRuntime?: ActiveWorkspaceRuntime; dataRootPath: string }): { dependency: AgentTaskMutationDependency; database: DatabaseSync; close: () => void } {
  if (input.activeRuntime) return { dependency: input.activeRuntime, database: input.activeRuntime.database, close: () => {} };
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  return { dependency: database, database, close: () => database.close() };
}
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

function dailyPrompt(task: AgentTask, planRequestId: string, briefText: string): string {
  return [
    '执行 WeMediaBuddy 今日情报判断任务。',
    `task_id=${task.id}`,
    `intent=${task.intent}`,
    `plan_date=${task.businessDate}`,
    'skill=wemedia-intelligence-engine',
    `plan_request_id=${planRequestId}`,
    `checkpoint=${JSON.stringify(task.checkpoint)}`,
    '',
    briefText,
    '',
    '判断要求：',
    '1. 只通过 wmb_* MCP 工具读写业务数据，禁止直接写文件或数据库，禁止最终发布。',
    '2. 判断任何机会前，先对齐简报「身份」块的受众、内容目标与编辑简报；脱离身份的泛泛线索直接丢弃。',
    '3. 每个候选写入方案前，必须调用 wmb_get_knowledge_context 查询同主题历史，写清它与你的库存资料、历史发布或复盘的具体关系；毫无关联的线索不得进入方案。',
    '4. 每个机会必须回答四问：为什么是现在（具体事实+时效分类：爆点/热点/长青）、为什么是你（与身份/历史发布/库存资料的具体关系）、你的独特说法是什么、证据在哪（真实 sourceIds+具体事实点）。答不出四问的线索不得写入方案。',
    `5. 先调用 wmb_get_workbench 与 wmb_get_agent_task；若没有答得出四问的机会，仍必须用空 items 调用 wmb_save_plan 保存空方案。方案使用 request_id=${planRequestId}。`,
    '6. 机会 priority：0=SSS，1=S，2=A，3=B，4=C，5=D，6=E，7=F。未达到机会标准的线索不凑成方案。',
    '7. 趋势只引用简报「存量」块给出的真实 sourceItemId、snapshotIds、流速和采集时间；不得补齐缺失指标或制造热度分。写回后调用 wmb_get_workbench 读回资料和方案。'
  ].join('\n');
}

export function buildDailyOpportunityPrompt(database: Parameters<typeof assembleEditorialBrief>[0], task: AgentTask, planRequestId: string): string {
  const brief = assembleEditorialBrief(database, {
    now: new Date(),
    businessDate: task.businessDate,
    watermark: typeof task.checkpoint?.judgeWatermark === 'string' ? task.checkpoint.judgeWatermark : null
  });
  return dailyPrompt(task, planRequestId, renderEditorialBrief(brief));
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
  onRuntime?: (runtime: PiRpcSupervisor) => void;
  onTaskReady?: TaskReadyGrantHook;
  workerLeaseId?: string;
  activeRuntime?: ActiveWorkspaceRuntime;
}): Promise<DailyIntelligenceRun> {
  const { dependency, database, close } = mutationDependency(input);
  const lane = 'daily-intelligence';
  const startRequestId = `daily_intelligence:${input.businessDate}:start:${randomUUID()}`;
  try {
    const contextRefs = { planDate: input.businessDate };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting;
    const config = prerequisite.config;
    const started = await dispatchStartAgentTask(dependency, { intent: 'daily_intelligence', businessDate: input.businessDate, contextRefs }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    const task = started.task;
    if (started.reused && !['resume_pending', 'starting', 'channel_scanned'].includes(task.phase)) return { task, reused: true };
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    const piSessionId = dailyAgentSessionId(input.businessDate, task.id);
    await dispatchUpdateAgentTaskPhase(dependency, task.id, task.phase, { piSessionId }, taskCommandContext(lane, `${task.id}:phase:session:${piSessionId}`, task.id, input.workerLeaseId, { requestId: startRequestId }));

    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await prepareSkillDir(layout.agentDir);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...config, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
    const extensionPath = await preparePiExtension(layout.agentDir);
    await dispatchReportAgentTaskProgress(dependency, task.id, {
      phase: task.phase === 'resume_pending' ? 'resuming' : 'judging_opportunities',
      message: task.phase === 'resume_pending' ? '已从持久检查点恢复任务。' : '正在根据已扫描来源判断内容机会。'
    }, taskCommandContext(lane, `${task.id}:progress:judging`, task.id, input.workerLeaseId, { requestId: startRequestId }));

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-daily-'));
    const dailySessionFile = path.join(layout.agentDir, 'sessions', `${piSessionId}.jsonl`);
    await mkdir(path.dirname(dailySessionFile), { recursive: true });
    const runtimeArgs = [
      await piCliPath(input.dataRootPath), '--mode', 'rpc', '--session', dailySessionFile,
      '--skill', path.join(layout.agentDir, 'skills', 'wemedia-intelligence-engine'), '-e', extensionPath,
      '--provider', 'wmb-api', '--model', config.model,
      '--append-system-prompt', piTaskAuthorityPrompt({ taskId: task.id, grantId, workerLeaseId: input.workerLeaseId })
    ];
    const runtimeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: layout.agentDir, WMB_PI_API_KEY: config.apiKey, WMB_MCP_URL: input.mcpUrl, WMB_XHS_MCP_URL: input.xhsMcpUrl || '' };
    const makeRuntime = () => {
      const runtime = new PiRpcSupervisor(process.execPath, runtimeArgs, runtimeEnv, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
      input.onRuntime?.(runtime);
      return runtime;
    };
    const cancelIfRequested = async (current: AgentTask | null | undefined) => {
      if (current?.status !== 'running' || current.controlAction !== 'cancel') return null;
      return dispatchCancelAgentTask(dependency, current.id, taskCommandContext(lane, `${current.id}:cancel:requested`, current.id, input.workerLeaseId));
    };

    try {
      const heartbeat = setInterval(() => {
        const current = getAgentTask(database, task.id);
        if (current?.status === 'running') void dispatchReportAgentTaskProgress(dependency, current.id, {}, taskCommandContext(lane, `${current.id}:progress:heartbeat:${current.updatedAt}`, current.id, input.workerLeaseId))
          .then((updated) => input.onEvent?.({ type: 'agent_task', task: updated })).catch(() => {});
      }, 15_000);
      try {
        const beforePlan = getAgentTask(database, task.id);
        if (beforePlan?.status !== 'running') return { task: beforePlan!, reused: started.reused };
        const cancelledBeforePlan = await cancelIfRequested(beforePlan);
        if (cancelledBeforePlan) return { task: cancelledBeforePlan, reused: started.reused };
        if (beforePlan.controlAction === 'save_partial') {
          const partial = await dispatchPartialAgentTask(dependency, beforePlan.id, taskCommandContext(lane, `${beforePlan.id}:partial:requested`, beforePlan.id, input.workerLeaseId));
          return { task: partial, reused: started.reused };
        }
        await dispatchReportAgentTaskProgress(dependency, beforePlan.id, { phase: 'synthesizing', message: '共享来源扫描结束，正在整理内容机会。' }, taskCommandContext(lane, `${beforePlan.id}:progress:synthesizing`, beforePlan.id, input.workerLeaseId));
        const synthesis = makeRuntime();
        activeDailyRuntimes.set(beforePlan.id, synthesis);
        try {
          await synthesis.start();
          await synthesis.promptUntilSettled(buildDailyOpportunityPrompt(database, getAgentTask(database, beforePlan.id) ?? beforePlan, agentRequestId(beforePlan.id, 'plan')), { timeoutMs: 6 * 60_000 });
        } catch (error) {
          const latest = getAgentTask(database, beforePlan.id) ?? beforePlan;
          const cancelled = await cancelIfRequested(latest);
          if (cancelled) return { task: cancelled, reused: started.reused };
          const message = error instanceof Error ? error.message : String(error);
          await dispatchReportAgentTaskProgress(dependency, latest.id, { phase: 'synthesis_failed', message: `综合整理失败，保留已扫描结果：${message.slice(0, 180)}`, level: 'warning' }, taskCommandContext(lane, `${latest.id}:progress:synthesis-failed`, latest.id, input.workerLeaseId));
          const partial = await dispatchFinishDailyIntelligence(dependency, latest.id, { forcePartial: true, errorCode: 'DAILY_INTELLIGENCE_FAILED', errorMessage: message }, taskCommandContext(lane, `${latest.id}:finish:synthesis-failed`, latest.id, input.workerLeaseId));
          return { task: partial, reused: started.reused };
        } finally {
          activeDailyRuntimes.delete(beforePlan.id);
          await synthesis.stop().catch(() => {});
        }
      } finally { clearInterval(heartbeat); }

      const afterRun = getAgentTask(database, task.id);
      const cancelledAfterRun = await cancelIfRequested(afterRun);
      if (cancelledAfterRun) return { task: cancelledAfterRun, reused: started.reused };
      if (afterRun?.controlAction === 'save_partial') {
        const partial = await dispatchFinishDailyIntelligence(dependency, task.id, { forcePartial: true }, taskCommandContext(lane, `${task.id}:finish:save-partial`, task.id, input.workerLeaseId));
        return { task: partial, reused: started.reused };
      }
      if (afterRun?.status === 'cancelled') return { task: afterRun, reused: started.reused };
      await dispatchUpdateAgentTaskPhase(dependency, task.id, 'validating', {}, taskCommandContext(lane, `${task.id}:phase:validating`, task.id, input.workerLeaseId));
      try {
        const completed = await dispatchCompleteAgentTask(dependency, task.id, taskCommandContext(lane, `${task.id}:complete`, task.id, input.workerLeaseId));
        return { task: completed, reused: started.reused };
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'VALIDATION_ERROR';
        const message = error instanceof Error ? error.message : String(error);
        await dispatchReportAgentTaskProgress(dependency, task.id, { phase: 'validating', message: `完成校验未完全通过，尝试保留结果：${message}`, level: 'warning' }, taskCommandContext(lane, `${task.id}:progress:validation-failed`, task.id, input.workerLeaseId));
        const partial = await dispatchFinishDailyIntelligence(dependency, task.id, { forcePartial: true, errorCode: code, errorMessage: message }, taskCommandContext(lane, `${task.id}:finish:validation-failed`, task.id, input.workerLeaseId));
        return { task: partial, reused: started.reused };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, task.id);
      const cancelled = await cancelIfRequested(current);
      if (cancelled) return { task: cancelled, reused: started.reused };
      if (current?.status === 'running') {
        const partial = await dispatchFinishDailyIntelligence(dependency, task.id, { forcePartial: true, errorCode: 'DAILY_INTELLIGENCE_FAILED', errorMessage: message }, taskCommandContext(lane, `${task.id}:finish:failed`, task.id, input.workerLeaseId));
        return { task: partial, reused: started.reused };
      }
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { close(); }
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
  dataRootPath: string; businessDate: string; piConfigPath?: string; projectId: string; mcpUrl: string;
  xhsMcpUrl?: string | null; onEvent?: (event: Record<string, unknown>) => void; onRuntime?: (runtime: PiRpcSupervisor) => void;
  workerLeaseId?: string; activeRuntime?: ActiveWorkspaceRuntime;
  onTaskReady?: TaskReadyGrantHook;
}): Promise<DailyIntelligenceRun> {
  const { dependency, database, close } = mutationDependency(input);
  const lane = 'studio-draft';
  const startRequestId = `studio_draft:${input.businessDate}:${input.projectId}:start`;
  try {
    const contextRefs = { projectId: input.projectId };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, { intent: 'studio_draft', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting;
    const config = prerequisite.config;
    const conversation = await readPiConversation(input.dataRootPath);
    const started = await dispatchStartAgentTask(dependency, { intent: 'studio_draft', businessDate: input.businessDate, contextRefs, piSessionId: conversation.sessionId }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    if (started.reused) return { task: started.task, reused: true };
    const task = started.task;
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...config, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
    const extensionPath = await preparePiExtension(layout.agentDir);
    const requestId = agentRequestId(task.id, 'core_version');
    await dispatchUpdateAgentTaskPhase(dependency, task.id, 'running_pi', { piSessionId: conversation.sessionId }, taskCommandContext(lane, `${task.id}:phase:running-pi`, task.id, input.workerLeaseId, { requestId: startRequestId }));
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-draft-'));
    const runtime = new PiRpcSupervisor(process.execPath, [
      await piCliPath(input.dataRootPath), '--mode', 'rpc', '--session', layout.sessionFile, '-e', extensionPath,
      '--provider', 'wmb-api', '--model', config.model, '--append-system-prompt', piTaskAuthorityPrompt({ taskId: task.id, grantId, workerLeaseId: input.workerLeaseId })
    ], { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: layout.agentDir, WMB_PI_API_KEY: config.apiKey, WMB_MCP_URL: input.mcpUrl, WMB_XHS_MCP_URL: input.xhsMcpUrl || '' },
    (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
    input.onRuntime?.(runtime);
    try {
      await runtime.start();
      await runtime.promptUntilSettled(draftPrompt(task, input.projectId, requestId), { timeoutMs: piPromptTimeoutMs() });
      await dispatchUpdateAgentTaskPhase(dependency, task.id, 'validating', {}, taskCommandContext(lane, `${task.id}:phase:validating`, task.id, input.workerLeaseId));
      const completed = await dispatchCompleteAgentTask(dependency, task.id, taskCommandContext(lane, `${task.id}:complete`, task.id, input.workerLeaseId));
      return { task: completed, reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, task.id);
      if (current?.status === 'running') await dispatchFailAgentTask(dependency, task.id, 'STUDIO_DRAFT_FAILED', message, taskCommandContext(lane, `${task.id}:fail`, task.id, input.workerLeaseId));
      throw error;
    } finally {
      await runtime.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { close(); }
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
  dataRootPath: string; businessDate: string; piConfigPath?: string; publicationId: string; mcpUrl: string;
  xhsMcpUrl?: string | null; onEvent?: (event: Record<string, unknown>) => void; onRuntime?: (runtime: PiRpcSupervisor) => void;
  workerLeaseId?: string; activeRuntime?: ActiveWorkspaceRuntime;
  onTaskReady?: TaskReadyGrantHook;
}): Promise<DailyIntelligenceRun> {
  const { dependency, database, close } = mutationDependency(input);
  const lane = 'results-review';
  const startRequestId = `results_review:${input.businessDate}:${input.publicationId}:start`;
  try {
    const contextRefs = { publicationId: input.publicationId };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, { intent: 'results_review', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting;
    const config = prerequisite.config;
    const conversation = await readPiConversation(input.dataRootPath);
    const started = await dispatchStartAgentTask(dependency, { intent: 'results_review', businessDate: input.businessDate, contextRefs, piSessionId: conversation.sessionId }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    if (started.reused) return { task: started.task, reused: true };
    const task = started.task;
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...config, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
    const extensionPath = await preparePiExtension(layout.agentDir);
    const requestId = agentRequestId(task.id, 'review');
    await dispatchUpdateAgentTaskPhase(dependency, task.id, 'running_pi', { piSessionId: conversation.sessionId }, taskCommandContext(lane, `${task.id}:phase:running-pi`, task.id, input.workerLeaseId, { requestId: startRequestId }));
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-review-'));
    const runtime = new PiRpcSupervisor(process.execPath, [
      await piCliPath(input.dataRootPath), '--mode', 'rpc', '--session', layout.sessionFile, '-e', extensionPath,
      '--provider', 'wmb-api', '--model', config.model, '--append-system-prompt', piTaskAuthorityPrompt({ taskId: task.id, grantId, workerLeaseId: input.workerLeaseId })
    ], { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: layout.agentDir, WMB_PI_API_KEY: config.apiKey, WMB_MCP_URL: input.mcpUrl, WMB_XHS_MCP_URL: input.xhsMcpUrl || '' },
    (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
    input.onRuntime?.(runtime);
    try {
      await runtime.start();
      await runtime.promptUntilSettled(reviewPrompt(task, input.publicationId, requestId), { timeoutMs: piPromptTimeoutMs() });
      await dispatchUpdateAgentTaskPhase(dependency, task.id, 'validating', {}, taskCommandContext(lane, `${task.id}:phase:validating`, task.id, input.workerLeaseId));
      const completed = await dispatchCompleteAgentTask(dependency, task.id, taskCommandContext(lane, `${task.id}:complete`, task.id, input.workerLeaseId));
      return { task: completed, reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, task.id);
      if (current?.status === 'running') await dispatchFailAgentTask(dependency, task.id, 'RESULTS_REVIEW_FAILED', message, taskCommandContext(lane, `${task.id}:fail`, task.id, input.workerLeaseId));
      throw error;
    } finally {
      await runtime.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { close(); }
}
import { preparePiExtension } from './pi-extension.ts';
import { piTaskAuthorityPrompt } from './pi-operator-skill.ts';
