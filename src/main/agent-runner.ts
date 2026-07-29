import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { migrateDatabase } from './db/migrations.ts';
import {
  agentRequestId,
  cancelAgentTask,
  clearAgentTaskControl,
  completeAgentTask,
  failAgentTask,
  getAgentTask,
  partialAgentTask,
  reportAgentTaskProgress,
  startAgentTask,
  updateAgentTaskPhase,
  type AgentTask
} from './agent-tasks.ts';
import { ensurePiConversationLayout, readPiConversation } from './pi-conversation.ts';
import { resolvePiConfig } from './pi-config.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';

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
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills', 'wemedia-intelligence-engine')
    : path.join(app.getAppPath(), 'skills', 'wemedia-intelligence-engine');
}

async function piCliPath(dataRootPath: string): Promise<string> {
  return piCliFromRuntimeRoot(await resolvePiRuntimeRoot(dataRootPath));
}

async function prepareSkillDir(agentDir: string): Promise<void> {
  const target = path.join(agentDir, 'skills', 'wemedia-intelligence-engine');
  await mkdir(path.dirname(target), { recursive: true });
  await cp(skillSourcePath(), target, { recursive: true, force: true });
}

function dailyPrompt(task: AgentTask, requestIds: { sources: string; plan: string }, route?: string): string {
  return [
    '执行 WeMediaBuddy 今日情报任务。',
    `task_id=${task.id}`,
    `intent=${task.intent}`,
    `plan_date=${task.businessDate}`,
    'skill=wemedia-intelligence-engine',
    `sources_request_id=${requestIds.sources}`,
    `plan_request_id=${requestIds.plan}`,
    `checkpoint=${JSON.stringify(task.checkpoint)}`,
    '要求：',
    '1. 只通过 wmb_* MCP 工具读写业务数据，禁止直接写文件或数据库，禁止最终发布。',
    '2. 先调用 wmb_get_workbench 与 wmb_get_agent_task。按检查点跳过已处理来源，重启不得重复劳动。',
    route ? `3. 本轮只研究来源路线“${route}”；在本轮 4 分钟边界内，保存所有完成核验且达到资料标准的结果，不设条数上限；不要生成方案。开始和结束都调用 wmb_report_agent_progress。` : '3. 来源研究已结束。本轮只基于已保存资料形成最终方案，不再浏览新来源。',
    '4. 每个来源开始前读取任务控制：skip_source=记录跳过并清除控制；save_partial=停止研究并进入读回；cancel=立即停止。已核验资料应逐步保存。',
    `5. 每条资料使用稳定子 requestId：${requestIds.sources}:<本路线内序号>，重启必须复用同一 ID。`,
    route ? '6. 本轮禁止调用 wmb_save_plan。' : `6. 每条资料保存后调用 wmb_get_knowledge_context 查历史，再用 wmb_record_knowledge 归入稳定主题并记录核验状态；最后用 wmb_save_plan 保存全部满足机会标准的去重结果，不得限制数量；request_id=${requestIds.plan}，每个机会必须引用真实 sourceIds 和对应 topicId。`,
    '7. 机会 priority：0=SSS，1=S，2=A，3=B，4=C，5=D，6=E，7=F。按等级从高到低提交；未达到机会标准的线索只保留为资料，不得凑数。',
    '8. 写回后调用 wmb_get_workbench 读回，并汇报最终计数。',
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
    if (started.reused && !['resume_pending', 'starting'].includes(started.data.phase)) return { task: started.data, reused: true };

    const config = resolvePiConfig(database);
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
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 16000
          }]
        }
      }
    }), 'utf8');
    const extensionPath = await preparePiExtension(layout.agentDir);

    const requestIds = {
      sources: agentRequestId(started.data.id, 'sources'),
      plan: agentRequestId(started.data.id, 'plan')
    };
    reportAgentTaskProgress(database, started.data.id, {
      phase: started.data.phase === 'resume_pending' ? 'resuming' : 'planning_sources',
      message: started.data.phase === 'resume_pending' ? '已从持久检查点恢复任务。' : '正在规划今日来源。'
    });

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-daily-'));
    const cliPath = await piCliPath(input.dataRootPath);
    const runtimeArgs = [
      cliPath,
      '--mode', 'rpc',
      '--session', layout.sessionFile,
      '--skill', path.join(layout.agentDir, 'skills', 'wemedia-intelligence-engine'),
      '-e', extensionPath,
      '--provider', 'wmb-api',
      '--model', config.model,
      '--append-system-prompt', '你是 WeMediaBuddy 内置 Pi。只通过 wmb_* MCP 工具完成今日情报写入。禁止直接写文件/数据库，禁止最终发布。'
    ];
    const runtimeEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PI_CODING_AGENT_DIR: layout.agentDir,
      WMB_PI_API_KEY: config.apiKey,
      WMB_MCP_URL: input.mcpUrl
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
        const routes = ['官方产品与模型发布', '开源项目与开发者工具', 'AI Skill 与 MCP 生态', '研究与模型评测', '社区真实问题与争议', '创作者与商业案例'];
        const done = new Set(Array.isArray(started.data.checkpoint.completedRoutes) ? started.data.checkpoint.completedRoutes as string[] : []);
        for (let index = 0; index < routes.length; index += 1) {
          const route = routes[index];
          if (done.has(route)) continue;
          const current = getAgentTask(database, started.data.id);
          if (!current || current.status !== 'running') break;
          if (current.controlAction === 'cancel') {
            const cancelled = cancelAgentTask(database, current.id);
            if (cancelled.ok) return { task: cancelled.data, reused: started.reused === true };
          }
          if (current.controlAction === 'save_partial') {
            const partial = partialAgentTask(database, current.id);
            if (!partial.ok) throw new Error(partial.error.message);
            return { task: partial.data, reused: started.reused === true };
          }
          if (current.controlAction === 'skip_source') {
            clearAgentTaskControl(database, current.id);
            reportAgentTaskProgress(database, current.id, {
              progress: { planned: routes.length, processed: done.size + 1, currentSource: route },
              checkpoint: { completedRoutes: [...done, route] },
              message: `已按用户要求跳过：${route}`,
              level: 'warning'
            });
            done.add(route);
            continue;
          }
          reportAgentTaskProgress(database, current.id, {
            phase: 'scanning_sources',
            progress: { planned: routes.length, processed: done.size, currentSource: route },
            message: `开始扫描：${route}`
          });
          const runtime = makeRuntime();
          activeDailyRuntimes.set(current.id, runtime);
          try {
            await runtime.start();
            await runtime.promptUntilSettled(dailyPrompt(getAgentTask(database, current.id) ?? current, {
              sources: agentRequestId(current.id, `source:${index}`),
              plan: requestIds.plan
            }, route), { timeoutMs: 4 * 60_000 });
            done.add(route);
            reportAgentTaskProgress(database, current.id, {
              progress: { processed: done.size, currentSource: route },
              checkpoint: { completedRoutes: [...done] },
              message: `完成扫描：${route}`
            });
          } catch (error) {
            const latest = getAgentTask(database, current.id);
            if (latest?.controlAction) { index -= 1; continue; }
            done.add(route);
            reportAgentTaskProgress(database, current.id, {
              progress: { processed: done.size, failed: (latest?.progress.failed ?? 0) + 1, currentSource: route },
              checkpoint: { completedRoutes: [...done] },
              message: `来源路线失败，已隔离并继续：${route}`,
              level: 'warning'
            });
          } finally {
            activeDailyRuntimes.delete(current.id);
            await runtime.stop().catch(() => {});
          }
        }
        const beforePlan = getAgentTask(database, started.data.id);
        if (beforePlan?.status !== 'running') return { task: beforePlan!, reused: started.reused === true };
        if (beforePlan.controlAction === 'save_partial') {
          const partial = partialAgentTask(database, beforePlan.id);
          if (!partial.ok) throw new Error(partial.error.message);
          return { task: partial.data, reused: started.reused === true };
        }
        reportAgentTaskProgress(database, beforePlan.id, { phase: 'synthesizing', message: '来源扫描结束，正在整理全部合格内容机会。' });
        const synthesis = makeRuntime();
        activeDailyRuntimes.set(beforePlan.id, synthesis);
        try {
          await synthesis.start();
          await synthesis.promptUntilSettled(dailyPrompt(getAgentTask(database, beforePlan.id) ?? beforePlan, requestIds), { timeoutMs: 6 * 60_000 });
        } finally {
          activeDailyRuntimes.delete(beforePlan.id);
          await synthesis.stop().catch(() => {});
        }
      } finally {
        clearInterval(heartbeat);
      }
      const afterRun = getAgentTask(database, started.data.id);
      if (afterRun?.controlAction === 'save_partial') {
        const partial = partialAgentTask(database, started.data.id);
        if (!partial.ok) throw new Error(partial.error.message);
        return { task: partial.data, reused: started.reused === true };
      }
      if (afterRun?.status === 'cancelled') return { task: afterRun, reused: started.reused === true };
      updateAgentTaskPhase(database, started.data.id, 'validating');
      const completed = completeAgentTask(database, started.data.id);
      if (!completed.ok) {
        failAgentTask(database, started.data.id, completed.error.code, completed.error.message);
        throw new Error(completed.error.message);
      }
      return { task: completed.data, reused: started.reused === true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, started.data.id);
      if (current?.status === 'running') failAgentTask(database, started.data.id, 'DAILY_INTELLIGENCE_FAILED', message);
      throw error;
    } finally {
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
    `2. 先调用 wmb_get_content({ projectId: "${projectId}" }) 与 wmb_get_workbench，定位指定 project。`,
    '3. 基于项目标题和关联资料，写一篇完整中文核心初稿正文。',
    `4. 调用 wmb_save_core_version，requestId 必须是 ${requestId}，projectId 必须是 ${projectId}，expectedRevision 使用步骤2读到的当前项目 revision，body 为完整正文。`,
    `5. 再调用 wmb_get_content({ projectId: "${projectId}" }) 确认该项目已有核心版本正文。`,
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
          api: config.api,
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
          api: config.api,
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
import { preparePiExtension } from './pi-extension';
