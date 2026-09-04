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
  dispatchNeedsUserAgentTask,
  dispatchStartAgentTask,
  type AgentTaskCommandContext
} from './agent-task-commands.ts';
import type { DeferredSignal, RoleJobPolicy, RoleJobReadbackV1, RoleJobSpec } from './role-job-registry.ts';
import { JOB_ERROR_CODES, snapshotScanReadback } from './role-job-registry.ts';
import { readTaskModelPolicySnapshot, resolveAgentPiPrerequisite, roleModelNeedsUserFailure } from './agent-prerequisites.ts';
import { startWorkspaceDailyIntelligence } from './workspace-intelligence.ts';
import { startStudioDraft } from './agent-runner.ts';
import { startResearchJob } from './research-job-runtime.ts';
import { isResearchSuccessorRow } from './research-successor.ts';
import { readProjectInvestigation } from './project-investigation.ts';
import { preparePiExtension } from './pi-extension.ts';
import { piTaskAuthorityPrompt } from './pi-operator-skill.ts';
import { ensurePiConversationLayout } from './pi-conversation.ts';
import { buildOrchestrationEnvelope } from '../shared/orchestration-envelope.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piModelsJson } from './pi-model.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';
import { proxyEnvForChildren } from './proxy-config.ts';
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
  if (policy === 'research') return runResearchPolicy(ctx);
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
  const targeted = typeof ctx.spec.planItemId === 'string' ? ctx.spec.planItemId.trim() : '';
  if (targeted) {
    return runTargetedPlannerPolicy(ctx);
  }
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

export function targetedPlannerPrompt(task: AgentTask, ctx: EmployeePolicyContext): string {
  const pid = ctx.spec.planItemId ?? '';
  return [
    '执行 WeMediaBuddy 定向策划任务（planner / plan_item targeting，bounded）。',
    `task_id=${task.id}`,
    `job_id=${ctx.jobId}`,
    `plan_item_id=${pid}`,
    `business_date=${ctx.businessDate}`,
    `brief=${ctx.brief}`,
    '约束（有界契约，必须严格遵守，违规即失败）：',
    '0. 禁止旁路：禁止调用 read、bash、grep、find、ls、cat、sqlite3、fs、node:fs、node:sqlite 等文件/命令/SQLite 工具；禁止直接读写文件系统、SQLite、data-root、会话文件或源码；禁止直接 UPDATE/INSERT plan_items。业务事实只通过 WMB MCP 工具获取与提交。',
    '1. 读：必须通过 WMB MCP 读取任务授权（wmb_get_agent_task / wmb_get_task_grant / wmb_list_task_grants），通过 wmb_get_plan_item 以 task_id + plan_item_id 两个精确键读取冻结项（经 assertPlannerScoped 校验），并至少两次调用 wmb_get_knowledge_context：一次查事件实体，一次查产业/社会关联。只接受工具实际返回的知识引用；无相关知识时如实记录 no_relevant_context，禁止伪造引用。',
    '2. 写：必须且只能调用 wmb_submit_plan_item（plan_item.submit）恰好一次，使用 exact planItemId 与读回的 expectedRevision；携带 taskId、grantId、workerLeaseId，requestId 使用 ' + ctx.jobId + ':plan_item:submit。遵循 SSOT `skills/evidence-grounded-writer/SKILL.md` §5。提交前先对同一事实组生成事件层、用户层、产业/社会层三个语义不同的中心主张候选，以“真实性为硬门、传播价值为主目标”比较：真实性不计传播分，但任何核心事实/推断/观点未被资料支持即不得成为 winner；最强候选缺关键证据时保留为 research_required 并走既有受控补料链，不得自动换成安全小题。editorialDecision 必须是 editorial_thesis_v1，包含三层 candidates（thesis/claimType/evidenceStatus/evidenceBoundary/score/reason）、最高分且 supported 的 winner、淘汰理由，以及 knowledgeContext（used+真实 contextRefs 或 no_relevant_context，queryDimensions 至少含实体和产业关联）。pointOfView 必须等于 winnerThesis，并作为全文唯一的一个中心主张。scoreReasons 必须是 propagation_v2：reality_change_significance(25)、tension_curiosity_gap(20)、audience_stakes(20)、why_now_window(15)、one_sentence_relayability(15)、account_fit(5)，并含 truthGate（supported；claims 明确 fact/inference/opinion 及证据边界），总分等于六项和。认知价值与实用价值是并行入口；重大产业/社会意义不因缺少“今天就能操作”的动作而降级，账号适配只有 5 分，不能压过现实变化。其余 title/whyNow/targetAudience/angle/openingGuidance/structureGuidance 仍须完整、具体、可被 sourceIds 兑现；一个处在具体情境中的读者和一个期望读者动作必须服务 winner，不能反过来改写 winner；标题必兑现，首段立刻兑现标题钩子，抽象主张配人/场景/利害/后果，证据服务主张；保留可防守的张力，禁止软化成“需要综合考虑”等空话，有用边界与怯懦的各打五十大板不同；平台适配重写钩子/节奏/收藏/分享/评论动机而不是缩短，禁止编造。自检四项：读者收益是否具体、是否有具体利害、为何现在、是否有收藏/分享/评论动机。不得保留模板或沿用旧课程大纲体，不得先用不合格 payload 试错。',
    '2.0 反降级硬门：可执行性、容易实验、容易拿到回执不是 propagation_v2 的独立加分项。多来源已支持模型能力边界、长任务可靠性、成本结构、分发入口或竞争格局变化时，优先回答“这次发布改变了什么旧判断、谁会重新决策”；不得仅因个人测试更容易落地，就让“先测三个任务/别开最高档/先试一次”等战术小题击败传播价值更高的认知主张。个人实测只能作为正文证据、行动建议或后续选题。',
    '2.1 提交字段必须严格使用公开工具 schema 的 canonical camelCase：editorialDecision.version=editorial_thesis_v1；candidates 每项只能使用 level/claimType/evidenceStatus/evidenceBoundary；winner 使用 winnerLevel/winnerThesis/winnerReason；knowledgeContext 使用 status/contextRefs/queryDimensions/reason。sourceIds 只能来自 wmb_get_plan_item 读回的冻结 sourceIds；wmb_get_knowledge_context 返回的 sources/evidence ID 不得混入 sourceIds。contextRefs 必须把 wmb_get_knowledge_context 返回的父级 ID 与版本 ID 组合成完整 canonical ref：wiki_page:<pageId>:<currentVersionId> 或 knowledge_note:<noteId>:<versionId>；严禁只提交 wver-* / ver-* 裸版本 ID。scoreReasons 必须使用 status=scored、version=propagation_v2、score、truthGate.status=passed、truthGate.reason、truthGate.claims[].status=supported/sourceIds，以及恰好六条 reasons。禁止旧别名 type/layer/industry_social/winner 对象/used/secondaryContext/boundary/total 或把六项分数平铺在 scoreReasons 根节点；工具 schema 校验失败不得改写字段重试。',
    '3. 校验：提交后必须通过 WMB MCP 读回（wmb_get_plan_item / plan_item.get）验证 planning_status=ready_for_review；未达到 ready_for_review 不得谎报成功。',
    '4. 禁止：不得调用 plans.save，不得直接操作数据库或文件，不得并发提交其他 plan_item，不得伪造读回。',
    '5. 完成后用简洁中文总结做了什么；若提交被模板或校验拒绝，必须说明 reason，不得伪造成功。'
  ].join('\n');
}

export async function runTargetedPlannerPolicy(ctx: EmployeePolicyContext): Promise<EmployeePolicyRun> {
  const runtime = ctx.runtime;
  const lane = 'planner-targeted';
  const planItemId = ctx.spec.planItemId ?? '';
  if (!planItemId.trim()) throw Object.assign(new Error('planItemId_required'), { code: 'validation_failed' });
  let pi: PiRpcSupervisor | null = null;
  let workDir: string | undefined;
  let createdTask: AgentTask | null = null;
  const onAbort = () => {
    if (pi?.isActive) void pi.abortTurn().catch(() => {});
    void pi?.stop().catch(() => {});
  };
  if (!ctx.signal.aborted) ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const contextRefs = {
      roleId: 'planner' as const,
      jobId: ctx.jobId,
      brief: ctx.brief,
      manager: 'desk',
      workspaceId: runtime.identity.workspaceId,
      planItemId
    };
    const prerequisite = await resolveAgentPiPrerequisite(runtime, {
      intent: 'daily_judge',
      roleId: 'planner',
      businessDate: ctx.businessDate,
      contextRefs
    });
    if (prerequisite.waiting) return { task: prerequisite.waiting.task, reused: true };
    const policySnapshot = prerequisite.policySnapshot;
    const taskContextRefs = { ...contextRefs, modelPolicySnapshot: policySnapshot };
    const startRequestId = `daily_judge:${ctx.jobId}:targeted:${planItemId}:${randomUUID()}`;
    const started = await dispatchStartAgentTask(runtime, {
      intent: 'daily_judge',
      businessDate: ctx.businessDate,
      contextRefs: taskContextRefs
    }, taskCommandContext(lane, startRequestId, undefined, ctx.workerLeaseId));
    const task = started.task;
    createdTask = task;
    const taskPolicySnapshot = readTaskModelPolicySnapshot(task, 'planner') ?? policySnapshot;
    if (started.reused && !['resume_pending', 'starting'].includes(task.phase)) return { task, reused: true };
    if (ctx.signal.aborted) {
      await bestEffortCancelTask(runtime, task.id, lane, ctx.workerLeaseId);
      return { task: getAgentTask(runtime.database, task.id) ?? task, reused: started.reused };
    }
    let grantId: string | null = null;
    try {
      grantId = await ctx.onTaskReady(task.id);
    } catch (error) {
      await bestEffortCancelTask(runtime, task.id, lane, ctx.workerLeaseId);
      throw error;
    }
    const layout = await ensurePiConversationLayout(runtime.identity.rootPath);
    const extensionPath = await preparePiExtension(layout.agentDir);
    workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-planner-targeted-'));
    const createRuntime = async (nextConfig: ResolvedPiConfig) => {
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(await piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
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
        WMB_XHS_MCP_URL: ctx.xhsMcpUrl,
        ...proxyEnvForChildren()
      }, (event) => ctx.onEvent(event as Record<string, unknown>), workDir);
    };
    const registerPiStop = () => ctx.registerStoppable(async () => {
      if (pi?.isActive) await pi.abortTurn().catch(() => {});
      await pi?.stop().catch(() => {});
    });
    const startedRuntime = await startPiRuntimeWithFallback({
      roleId: 'planner',
      policySnapshot: taskPolicySnapshot,
      taskId: task.id,
      createRuntime,
      onEvent: (event) => ctx.onEvent(event as unknown as Record<string, unknown>)
    });
    pi = startedRuntime.runtime;
    registerPiStop();
    let finalAssistantText: string | null = null;
    await runPiPromptWithFallback({
      roleId: 'planner',
      policySnapshot: taskPolicySnapshot,
      taskId: task.id,
      initial: startedRuntime,
      createRuntime,
      onEvent: (event) => ctx.onEvent(event as unknown as Record<string, unknown>),
      onRuntimeChanged: (nextRuntime) => {
        pi = nextRuntime;
        registerPiStop();
      },
      run: async (activeRuntime) => {
        const result = await activeRuntime.promptUntilSettled(buildOrchestrationEnvelope({ dispatchId: `daily_judge:${task.id}`, target: 'employee', delivery: 'direct', safe: { originLabel: '定向策划', title: '定向策划', goal: '精确提交单一策划项至 ready_for_review', acceptance: 'plan_item_ready 读回 ready_for_review' }, prompt: targetedPlannerPrompt(task, ctx) }), { timeoutMs: promptTimeoutMs() });
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
    if (createdTask) {
      const latest = getAgentTask(runtime.database, createdTask.id);
      if (latest?.status === 'running') {
        if (ctx.signal.aborted) {
          await bestEffortCancelTask(runtime, createdTask.id, lane, ctx.workerLeaseId);
        } else {
          const modelFailure = roleModelNeedsUserFailure(error);
          if (modelFailure) {
            const waiting = await dispatchNeedsUserAgentTask(runtime, createdTask.id, modelFailure.code, modelFailure.message, taskCommandContext(lane, `${createdTask.id}:needs-user:model`, createdTask.id, ctx.workerLeaseId));
            return { task: waiting, reused: false, finalAssistantText: null };
          }
          try {
            await dispatchFailAgentTask(runtime, createdTask.id, JOB_ERROR_CODES.PLANNER_JUDGE_FAILED, error instanceof Error ? error.message : String(error), taskCommandContext(lane, `${createdTask.id}:fail`, createdTask.id, ctx.workerLeaseId));
          } catch {}
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

/** writer：普通核心初稿先派外部研究；研究续派或已批准专项调查资料包才可直接写作。prohibited 显式豁免进受限写作。 */
export function runDraftPolicy(ctx: EmployeePolicyContext): Promise<EmployeePolicyRun> {
  const projectId = ctx.spec.projectId ?? '';
  const investigation = projectId ? readProjectInvestigation(ctx.runtime.database, projectId) : null;
  const approvedInvestigation = Boolean(
    investigation?.package
    && investigation.direction
    && ['ready_to_write', 'writing', 'completed'].includes(investigation.status)
  );
  const evidenceReady = isResearchSuccessorRow(ctx.runtime.database, ctx.jobId) || approvedInvestigation;
  const researchMode = ctx.spec.researchMode ?? 'auto';
  return startStudioDraft({
    dataRootPath: ctx.runtime.identity.rootPath,
    businessDate: ctx.businessDate,
    projectId,
    writerTask: ctx.spec.writerTask ?? 'core_draft',
    brief: ctx.brief,
    researchReady: evidenceReady,
    // @ts-ignore researchMode passthrough pending type update
    researchMode: researchMode as 'auto' | 'required' | 'prohibited',
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
/**
 * WMB-5173：research 策略（WMB-5172 执行器接线）。研究工单 = reporter + research 块，
 * 由角色注册表派生 intent='research'；执行入口 startResearchJob 读 context_refs 的
 * ResearchGap（fail-closed）、硬预算执行、终态落 EvidencePack 并 enqueue research_successor。
 */
export async function runResearchPolicy(ctx: EmployeePolicyContext): Promise<EmployeePolicyRun> {
  const run = await startResearchJob({
    dataRootPath: ctx.runtime.identity.rootPath,
    businessDate: ctx.businessDate,
    mcpUrl: ctx.mcpUrl,
    xhsMcpUrl: ctx.xhsMcpUrl,
    activeRuntime: ctx.runtime,
    workerLeaseId: ctx.workerLeaseId,
    sessionFile: ctx.sessionFile,
    onTaskReady: ctx.onTaskReady,
    onEvent: ctx.onEvent,
    onRuntime: (rt) => ctx.registerStoppable(() => rt.stop()),
    jobId: ctx.jobId,
    signal: ctx.signal
  });
  return { task: run.task, reused: run.reused };
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
      roleId: 'librarian' as const,
      jobId: ctx.jobId,
      brief: ctx.brief,
      manager: 'desk',
      workspaceId: runtime.identity.workspaceId
    };
    // 与 daily/studio 原语同构：角色模型策略缺失或无效 → 复用 needs_user 任务。
    const prerequisite = await resolveAgentPiPrerequisite(runtime, {
      intent: 'page_library', roleId: 'librarian', businessDate: ctx.businessDate, contextRefs
    });
    if (prerequisite.waiting) return { task: prerequisite.waiting.task, reused: true };
    const policySnapshot = prerequisite.policySnapshot;
    const taskContextRefs = { ...contextRefs, modelPolicySnapshot: policySnapshot };
    const startRequestId = `page_library:${ctx.jobId}:start:${randomUUID()}`;
    const started = await dispatchStartAgentTask(runtime, {
      intent: 'page_library',
      businessDate: ctx.businessDate,
      contextRefs: taskContextRefs
    }, taskCommandContext(lane, startRequestId, undefined, ctx.workerLeaseId));
    const task = started.task;
    createdTask = task;
    const taskPolicySnapshot = readTaskModelPolicySnapshot(task, 'librarian') ?? policySnapshot;
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
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(await piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
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
        WMB_XHS_MCP_URL: ctx.xhsMcpUrl,
        ...proxyEnvForChildren()
      }, (event) => ctx.onEvent(event as Record<string, unknown>), workDir);
    };
    // WMB-5119 §6.3：Pi runtime 就绪即注册 stop（abortTurn+stop 同 onAbort 语义；闭包读可变 pi 变量，
    // 换实例经 onRuntimeChanged 重注册覆盖旧槽——single slot last wins）；onAbort 监听保留（活跃 turn 优雅退出）。
    const registerPiStop = () => ctx.registerStoppable(async () => {
      if (pi?.isActive) await pi.abortTurn().catch(() => {});
      await pi?.stop().catch(() => {});
    });
    const startedRuntime = await startPiRuntimeWithFallback({
      roleId: 'librarian',
      policySnapshot: taskPolicySnapshot,
      taskId: task.id,
      createRuntime,
      onEvent: (event) => ctx.onEvent(event as unknown as Record<string, unknown>)
    });
    pi = startedRuntime.runtime;
    registerPiStop();
    // WMB-5121 §8.3：捕获会话末条 assistant 文本（内存路径，免读文件；readback 优先于收据外的围栏声明）。
    let finalAssistantText: string | null = null;
    await runPiPromptWithFallback({
      roleId: 'librarian',
      policySnapshot: taskPolicySnapshot,
      taskId: task.id,
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
          const modelFailure = roleModelNeedsUserFailure(error);
          if (modelFailure) {
            const waiting = await dispatchNeedsUserAgentTask(runtime, createdTask.id, modelFailure.code, modelFailure.message, taskCommandContext(lane, `${createdTask.id}:needs-user:model`, createdTask.id, ctx.workerLeaseId));
            return { task: waiting, reused: false, finalAssistantText: null };
          }
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
