import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import type { TaskReadyGrantHook } from './task-grants.ts';
import type { AgentTask } from './agent-tasks.ts';
import { getAgentTask } from './agent-tasks.ts';
import {
  dispatchCancelAgentTask,
  dispatchFailAgentTask,
  dispatchStartAgentTask,
  type AgentTaskCommandContext
} from './agent-task-commands.ts';
import type { DeferredSignal, RoleJobPolicy, RoleJobReadbackV1, RoleJobSpec } from './role-job-registry.ts';
import { JOB_ERROR_CODES, snapshotScanReadback } from './role-job-registry.ts';
import { resolveAgentPiPrerequisite } from './agent-prerequisites.ts';
import { startWorkspaceDailyIntelligence } from './workspace-intelligence.ts';
import { startStudioDraft } from './agent-runner.ts';
import { preparePiExtension } from './pi-extension.ts';
import { piTaskAuthorityPrompt } from './pi-operator-skill.ts';
import { ensurePiConversationLayout } from './pi-conversation.ts';
import { buildOrchestrationEnvelope } from '../shared/orchestration-envelope.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piModelsJson } from './pi-model.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';
import { runPiPromptWithFallback, startPiRuntimeWithFallback } from './pi-config-fallback.ts';
import type { ResolvedPiConfig } from './pi-config.ts';
import type { Stoppable } from './job-control.ts';

/**
 * WMB-5116 角色策略回调（§7）：包装现有 daily/studio 领域原语（零改动），
 * librarian 提供真实 Pi 整理会话（修复 E1）。业务阶段函数只被策略回调引用，
 * 不再作为第二条员工入口暴露。
 */

export type EmployeePolicyContext = {
  runtime: ActiveWorkspaceRuntime;
  spec: RoleJobSpec;
  businessDate: string;
  mcpUrl: string;
  xhsMcpUrl: string;
  workerLeaseId: string;
  sessionFile: string;
  signal: AbortSignal;
  jobId: string;
  brief: string;
  onTaskReady: TaskReadyGrantHook;
  onEvent: (event: Record<string, unknown>) => void;
  /** WMB-5119 §6.3：单一 stoppable 注册协议——Pi runtime 就绪时注册 stop（last wins；abort 后注册立即停）。 */
  registerStoppable: (stop: Stoppable) => void;
};

export type EmployeePolicyRun = {
  task: AgentTask;
  reused: boolean;
  savedCount?: number;
  /** WMB-5118 §5.2 半 1：守卫命中 running judge 的瞬时让路信号（不写终态、不进五态）。 */
  deferred?: DeferredSignal | null;
  /** WMB-5118 §5.2 半 2：scan resolve 返回瞬间捕获的不可变读回快照（judge rebind 后仍有效）。 */
  readback?: RoleJobReadbackV1 | null;
  /** WMB-5121 §8.3：librarian 会话 `promptUntilSettled` 的末条 assistant 文本（内存路径，免读文件）。 */
  finalAssistantText?: string | null;
};

export async function runRolePolicy(policy: RoleJobPolicy, ctx: EmployeePolicyContext): Promise<EmployeePolicyRun> {
  if (policy === 'scan') return runScanPolicy(ctx);
  if (policy === 'judge') return runJudgePolicy(ctx);
  if (policy === 'draft') return runDraftPolicy(ctx);
  return runOrganizePolicy(ctx);
}

/** reporter：扫描/采集（scanOnly 领域原语）；resolve 返回瞬间捕获不可变读回快照（§5.2 半 2）。 */
export async function runScanPolicy(ctx: EmployeePolicyContext): Promise<EmployeePolicyRun> {
  const run = await startWorkspaceDailyIntelligence({
    dataRootPath: ctx.runtime.identity.rootPath,
    businessDate: ctx.businessDate,
    mcpUrl: ctx.mcpUrl,
    xhsMcpUrl: ctx.xhsMcpUrl,
    activeRuntime: ctx.runtime,
    workerLeaseId: ctx.workerLeaseId,
    onTaskReady: ctx.onTaskReady,
    onEvent: ctx.onEvent,
    onRuntime: (rt) => ctx.registerStoppable(() => rt.stop()),
    scanOnly: true
  });
  // 快照 = 返回瞬间的任务状态（channel_scanned / succeeded+completed），Object.freeze 不可变；
  // judge 后续 rebind 无法改写；runner 读回优先使用它（`run.readback ?? readbackScanPhase`）。
  return { task: run.task, reused: run.reused, savedCount: run.savedCount, deferred: run.deferred ?? null, readback: snapshotScanReadback(run.task) };
}

/** planner：判定/方案（judgeOnly 领域原语，水印/赛道门保留）。 */
export function runJudgePolicy(ctx: EmployeePolicyContext): Promise<EmployeePolicyRun> {
  return startWorkspaceDailyIntelligence({
    dataRootPath: ctx.runtime.identity.rootPath,
    businessDate: ctx.businessDate,
    mcpUrl: ctx.mcpUrl,
    xhsMcpUrl: ctx.xhsMcpUrl,
    activeRuntime: ctx.runtime,
    workerLeaseId: ctx.workerLeaseId,
    onTaskReady: ctx.onTaskReady,
    onEvent: ctx.onEvent,
    onRuntime: (rt) => ctx.registerStoppable(() => rt.stop()),
    judgeOnly: true
  });
}

/** writer：创作草稿（startStudioDraft 领域原语，草稿保存逻辑零改动）。 */
export function runDraftPolicy(ctx: EmployeePolicyContext): Promise<EmployeePolicyRun> {
  return startStudioDraft({
    dataRootPath: ctx.runtime.identity.rootPath,
    businessDate: ctx.businessDate,
    projectId: ctx.spec.projectId ?? '',
    writerTask: ctx.spec.writerTask ?? 'core_draft',
    brief: ctx.brief,
    // WMB-5116：每 job 唯一 start request identity——同 date/project 新工单不再复用确定性
    // `studio_draft:<date>:<project>:start`，避免在 dispatchStart 处 REQUEST_REPLAY_CONFLICT。
    startRequestId: `${ctx.jobId}:studio-draft:start`,
    mcpUrl: ctx.mcpUrl,
    xhsMcpUrl: ctx.xhsMcpUrl,
    activeRuntime: ctx.runtime,
    workerLeaseId: ctx.workerLeaseId,
    sessionFile: ctx.sessionFile,
    onTaskReady: ctx.onTaskReady,
    onEvent: ctx.onEvent,
    onRuntime: (rt) => ctx.registerStoppable(() => rt.stop())
  });
}

function taskCommandContext(lane: string, requestId: string, taskId?: string, workerLeaseId?: string): AgentTaskCommandContext {
  return { actor: { type: 'scheduler' as const, id: lane, label: lane }, requestId, taskId, workerLeaseId };
}

function promptTimeoutMs(): number {
  const raw = Number(process.env.WMB_PI_PROMPT_TIMEOUT_MS ?? 300_000);
  return Number.isFinite(raw) && raw >= 30_000 ? Math.floor(raw) : 300_000;
}

async function piCliPath(dataRootPath: string): Promise<string> {
  return piCliFromRuntimeRoot(await resolvePiRuntimeRoot(dataRootPath));
}

export function libraryOrganizePrompt(task: AgentTask, ctx: EmployeePolicyContext): string {
  return [
    '执行 WeMediaBuddy 资料库整理任务（librarian / page_library）。',
    `task_id=${task.id}`,
    `job_id=${ctx.jobId}`,
    'intent=page_library（intent 由系统按角色自动派生，无需也不接受手动指定）',
    `brief=${ctx.brief}`,
    '要求：',
    '0. 禁止旁路探索：禁止调用 read、bash、grep、find、ls 等文件/命令工具；禁止读写文件系统、SQLite、data-root、会话文件或项目源码；禁止加载或阅读任何 Skill 文件（不得先阅读 Skill 再开始）。业务事实只能通过 wmb_* MCP 工具获取：task 用 wmb_get_agent_task，grant 用 wmb_get_task_grant / wmb_list_task_grants，workbench 用 wmb_get_workbench，资料用 wmb_get_source / wmb_search_sources / wmb_get_knowledge_context。',
    '1. 写操作只允许使用已授权工具：wmb_judge_sources（reasonCode 仅限九值：off_lane_content、lifestyle_noise、ad_promotion、out_of_scope_region、duplicate_series、edge_ai_adjacent、official_source、editor_override、lane_relevant；其中 official_source、editor_override、lane_relevant 为系统/主编保留码，本会话不得使用；irrelevant 判定必须带一句话 reason 与真实 expectedRevision）、wmb_restore_source、wmb_update_source_status、wmb_record_knowledge（知识挂接）、wmb_propose_topic_maintenance（创建主题整理提案，绝不直接改主题）。发现重复主题时必须用提案列出保留主题、迁移对象和归档对象；若 brief 指明 supersedesProposalId，必须读取旧提案与最新现场后提交一份带该 supersedesProposalId 的新版建议，不得复制旧快照或自动批准。完成后向主管呈报待批，不得要求用户手工整理。不得调用任何未授权写工具；不得新增资料入库、创建内容项目、写方案（plans）/复盘（reviews）、发布、硬删资料；禁止直接写文件或数据库。',
    `2. 每次写调用必须携带 taskId=${task.id}、grantId、workerLeaseId（本次自动授权已签发，见系统提示）。requestId 直接用 job 派生稳定 ID（如 ${ctx.jobId}:library:judge、${ctx.jobId}:library:restore、${ctx.jobId}:library:status、${ctx.jobId}:library:knowledge），禁止调用 shell 生成。`,
    '3. 固定短路径：读 task/grant/workbench 与必要 source → 判断是否需要变更：需要则执行上述授权写工具并用 wmb_get_source / wmb_get_workbench 读回核验；无需变更则立即结束，明确回复「本次无变更」，并在末条回复附 ```json {"wmb_noop": true} ``` 确认块，不得伪造写入动作。',
    '4. 完成后用简洁中文总结做了什么（或说明无变更）。末条回复必须附 ```json {"wmb_noop": true} ``` 确认块（无可整理内容时必须用它回报 no-op 确认）；声明 wmb_noop 后不得执行任何写操作。'
  ].join('\n');
}

/** 尽力取消仍 running 的任务（取消优先；已终态则忽略）。 */
async function bestEffortCancelTask(runtime: ActiveWorkspaceRuntime, taskId: string, lane: string, workerLeaseId: string): Promise<void> {
  const current = getAgentTask(runtime.database, taskId);
  if (current?.status !== 'running') return;
  try {
    await dispatchCancelAgentTask(runtime, taskId, taskCommandContext(lane, `${taskId}:cancel:abort`, taskId, workerLeaseId));
  } catch { /* 已终态则忽略 */ }
}

/**
 * librarian 真实 Pi 会话（E1 修复）：page_library 任务 + 既有自动 grant + 员工会话文件。
 * 任务终态由 GenericEmployeeRunner 统一写入；本策略只负责跑会话并返回最新 task。
 * 评审 MAJOR 2：abort 监听**最先**挂载——任务创建/授权窗口内的取消也能停 Pi/取消任务，
 * 不留 running 孤儿（不能只依赖 stale grant 兜底）。
 */
export async function runOrganizePolicy(ctx: EmployeePolicyContext): Promise<EmployeePolicyRun> {
  const runtime = ctx.runtime;
  const lane = 'librarian-organize';
  let pi: PiRpcSupervisor | null = null;
  // 语义边界归一：workDir 是可选的（undefined），非 nullable——PiRpcSupervisor cwd 参数为 string|undefined。
  let workDir: string | undefined;
  let createdTask: AgentTask | null = null;
  const onAbort = () => {
    if (pi?.isActive) void pi.abortTurn().catch(() => {});
    void pi?.stop().catch(() => {});
  };
  if (!ctx.signal.aborted) ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const contextRefs = {
      roleId: 'librarian',
      jobId: ctx.jobId,
      brief: ctx.brief,
      manager: 'desk',
      workspaceId: runtime.identity.workspaceId
    };
    // 与 daily/studio 原语同构：Pi 配置缺失 → 复用 needs_user 任务（主管补配置后重派）。
    const prerequisite = await resolveAgentPiPrerequisite(runtime, {
      intent: 'page_library',
      businessDate: ctx.businessDate,
      contextRefs
    });
    if (prerequisite.waiting) return { task: prerequisite.waiting.task, reused: true };
    const startRequestId = `page_library:${ctx.jobId}:start:${randomUUID()}`;
    const started = await dispatchStartAgentTask(runtime, {
      intent: 'page_library',
      businessDate: ctx.businessDate,
      contextRefs
    }, taskCommandContext(lane, startRequestId, undefined, ctx.workerLeaseId));
    const task = started.task;
    createdTask = task;
    if (started.reused && !['resume_pending', 'starting'].includes(task.phase)) return { task, reused: true };
    // 任务已建但取消信号已到：直接取消任务，不再启动 Pi。
    if (ctx.signal.aborted) {
      await bestEffortCancelTask(runtime, task.id, lane, ctx.workerLeaseId);
      return { task: getAgentTask(runtime.database, task.id) ?? task, reused: started.reused };
    }
    let grantId: string | null = null;
    try {
      grantId = await ctx.onTaskReady(task.id);
    } catch (error) {
      // 授权失败（可能因窗口内取消已终态化任务）：尽力取消，避免 running 孤儿。
      await bestEffortCancelTask(runtime, task.id, lane, ctx.workerLeaseId);
      throw error;
    }

    const layout = await ensurePiConversationLayout(runtime.identity.rootPath);
    const extensionPath = await preparePiExtension(layout.agentDir);
    workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-library-'));
    const createRuntime = async (nextConfig: ResolvedPiConfig) => {
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
      return new PiRpcSupervisor(process.execPath, [
        await piCliPath(runtime.identity.rootPath), '--mode', 'rpc', '--session', ctx.sessionFile, '-e', extensionPath,
        '--provider', 'wmb-api', '--model', nextConfig.model,
        '--append-system-prompt', piTaskAuthorityPrompt({ taskId: task.id, grantId, workerLeaseId: ctx.workerLeaseId })
      ], {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PI_CODING_AGENT_DIR: layout.agentDir,
        WMB_PI_API_KEY: nextConfig.apiKey,
        WMB_MCP_URL: ctx.mcpUrl,
        WMB_XHS_MCP_URL: ctx.xhsMcpUrl
      }, (event) => ctx.onEvent(event as Record<string, unknown>), workDir);
    };
    // WMB-5119 §6.3：Pi runtime 就绪即注册 stop（abortTurn+stop 同 onAbort 语义；闭包读可变 pi 变量，
    // 换实例经 onRuntimeChanged 重注册覆盖旧槽——single slot last wins）；onAbort 监听保留（活跃 turn 优雅退出）。
    const registerPiStop = () => ctx.registerStoppable(async () => {
      if (pi?.isActive) await pi.abortTurn().catch(() => {});
      await pi?.stop().catch(() => {});
    });
    const startedRuntime = await startPiRuntimeWithFallback({
      createRuntime,
      onEvent: (event) => ctx.onEvent(event as unknown as Record<string, unknown>)
    });
    pi = startedRuntime.runtime;
    registerPiStop();
    // WMB-5121 §8.3：捕获会话末条 assistant 文本（内存路径，免读文件；readback 优先于收据外的围栏声明）。
    let finalAssistantText: string | null = null;
    await runPiPromptWithFallback({
      initial: startedRuntime,
      createRuntime,
      onEvent: (event) => ctx.onEvent(event as unknown as Record<string, unknown>),
      onRuntimeChanged: (nextRuntime) => {
        pi = nextRuntime;
        registerPiStop();
      },
      run: async (activeRuntime) => {
        // WMB-5178 §5：员工接收会话盖章（librarian 整理，target=employee，Dock 永不镜像）。
        const result = await activeRuntime.promptUntilSettled(buildOrchestrationEnvelope({ dispatchId: `page_library:${task.id}`, target: 'employee', delivery: 'direct', safe: { originLabel: '资料库整理', title: '资料整理', goal: '判断与整理资料，产出待批提案', acceptance: '整理读回或 no-op 确认' }, prompt: libraryOrganizePrompt(task, ctx) }), { timeoutMs: promptTimeoutMs() });
        finalAssistantText = result.text;
      }
    });
    const current = getAgentTask(runtime.database, task.id);
    if (current && current.status === 'running' && current.controlAction === 'cancel') {
      const cancelled = await dispatchCancelAgentTask(runtime, task.id, taskCommandContext(lane, `${task.id}:cancel:control`, task.id, ctx.workerLeaseId));
      return { task: cancelled, reused: started.reused, finalAssistantText };
    }
    return { task: current ?? task, reused: started.reused, finalAssistantText };
  } catch (error) {
    // 与 startStudioDraft 同构：Pi 会话失败时先落任务终态，再抛出交由 runner 映射 outcome。
    if (createdTask) {
      const latest = getAgentTask(runtime.database, createdTask.id);
      if (latest?.status === 'running') {
        if (ctx.signal.aborted) {
          // WMB-5119 §6.4 取消优先：abort 引发的会话异常走 bestEffortCancelTask（cancelled），
          // 不落 failed 双终态（runner abort 门已尽量抢先，此处兜底）。
          await bestEffortCancelTask(runtime, createdTask.id, lane, ctx.workerLeaseId);
        } else {
          try {
            await dispatchFailAgentTask(runtime, createdTask.id, JOB_ERROR_CODES.LIBRARY_ORGANIZE_FAILED, error instanceof Error ? error.message : String(error), taskCommandContext(lane, `${createdTask.id}:fail`, createdTask.id, ctx.workerLeaseId));
          } catch { /* 控制路径已写终态则忽略 */ }
        }
      }
    }
    throw error;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    await pi?.stop().catch(() => {});
    if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
}
