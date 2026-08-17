import { broadcastDataChanged } from './data-changed.ts';
import { recordOperation } from './operations.ts';
import { readResearchGap, type ResearchEvidencePack } from './research-task-state.ts';
import { enqueueResearchSuccessor } from './research-successor.ts';
import type { ResearchGap, ResearchRequiredClaim } from './role-job-registry.ts';
import { roleReadTools } from '../shared/agent-capabilities.ts';
import { readWebPage, RESEARCH_READ_TIMEOUT_MS } from './research-web-read.ts';
import { dispatchSourceUpsertBatch } from './source-commands.ts';
import type { SourceInput } from './sources.ts';
import { listResearchClaims, upsertResearchClaim, type ResearchClaimStatus } from './db/research-claims-store.ts';
import {
  parseClaimProposals,
  parseResearchCandidates,
  runResearchJob,
  type ResearchRunnerDeps
} from './research-job-runner.ts';
import type { ResearchEvidenceItem } from './research-claim-validation.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './db/migrations.ts';
import { requireReceiptData, dispatchBusinessCommand } from './business-command.ts';
import { ensurePiConversationLayout } from './pi-conversation.ts';
import { preparePiExtension } from './pi-extension.ts';
import { piTaskAuthorityPrompt, skillSourcePath } from './pi-operator-skill.ts';
import { buildOrchestrationEnvelope } from '../shared/orchestration-envelope.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piModelsJson } from './pi-model.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';
import { runPiPromptWithFallback, startPiRuntimeWithFallback } from './pi-config-fallback.ts';
import type { ResolvedPiConfig } from './pi-config.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import type { TaskReadyGrantHook } from './task-grants.ts';
import { getAgentTask, type AgentTask } from './agent-tasks.ts';
import {
  dispatchCancelAgentTask,
  dispatchFailAgentTask,
  dispatchReportAgentTaskProgress,
  dispatchStartAgentTask,
  dispatchUpdateAgentTaskPhase,
  type AgentTaskCommandContext,
  type AgentTaskMutationDependency
} from './agent-task-commands.ts';
import { resolveAgentPiPrerequisite } from './agent-prerequisites.ts';
import { readAssistantTexts, type DailyIntelligenceRun } from './agent-runner.ts';

// ---------- WMB-5172 提取：agent-runner 私有窄助手仅复刻窄行为（公共底层归属见 import；大逻辑不复制） ----------
function schedulerActor(lane: string) {
  return { type: 'scheduler' as const, id: lane, label: lane };
}

function taskCommandContext(lane: string, requestId: string, taskId?: string, workerLeaseId?: string, causation?: Readonly<Record<string, unknown>>): AgentTaskCommandContext {
  return { actor: schedulerActor(lane), requestId, taskId, workerLeaseId, causation };
}

/**
 * 研究记者会话需要完成多轮检索和正文读取；默认 10 分钟，为 12 分钟研究硬预算
 * 留出至少 2 分钟给机器抓取、claim 判定与终态持久化。显式环境配置仍可下调。
 */
export function resolveResearchPromptTimeoutMs(raw: unknown = process.env.WMB_PI_PROMPT_TIMEOUT_MS): number {
  const value = Number(raw ?? 600_000);
  return Number.isFinite(value) && value >= 30_000 ? Math.floor(value) : 600_000;
}

function mutationDependency(input: { activeRuntime?: ActiveWorkspaceRuntime; dataRootPath: string }): { dependency: AgentTaskMutationDependency; database: DatabaseSync; close: () => void } {
  if (input.activeRuntime) return { dependency: input.activeRuntime, database: input.activeRuntime.database, close: () => {} };
  const database = migrateDatabase(path.join(input.dataRootPath, 'wmb.db'));
  return { dependency: database, database, close: () => database.close() };
}

async function piCliPath(dataRootPath: string): Promise<string> {
  return piCliFromRuntimeRoot(await resolvePiRuntimeRoot(dataRootPath));
}

export function researchSkillSourcePath(): string {
  return skillSourcePath('deep-research');
}

export function researchPiRuntimeArgs(input: {
  piCliPath: string;
  sessionFile: string;
  extensionPath: string;
  model: string;
  authorityPrompt: string;
}): string[] {
  return [
    input.piCliPath, '--mode', 'rpc', '--session', input.sessionFile, '-e', input.extensionPath,
    '--skill', researchSkillSourcePath(),
    '--provider', 'wmb-api', '--model', input.model,
    '--append-system-prompt', input.authorityPrompt
  ];
}

// ============================================================================
// WMB-5172 research intent 执行路径接线（设计 §5.3–§5.6 / §6.2–§6.4 / §8.3）
// 核心执行逻辑在 research-job-runner.ts（纯执行器 + 注入缝）；本文件提供生产接线：
// Pi 会话两阶段（候选发现 / claim 建议）驱动，真实时钟/抓取/写回/持久化注入。
// ============================================================================

export type ResearchJobRun = DailyIntelligenceRun;

/** WMB-5172 §6.2：research 会话工具集纪律文本——复用注册表真源白名单（roleReadTools），不重复定义。 */
export function researchToolDisciplineText(): string {
  const reads = [...roleReadTools('reporter')].sort();
  return [
    '本会话工具集 fail-closed 固定为（白名单外工具一律被系统拒绝 READ_PROFILE_BLOCKED）：',
    `基础设施：wmb_get_agent_task / wmb_report_agent_progress；`,
    `读：${reads.join(' / ')}；`,
    '唯一写回：wmb_save_source（originalUrl 去重入库；禁止 feedId——研究证据禁止挂渠道 feed）。',
    '禁止 wmb_get_workbench（上下文纪律，防上下文挤爆）。'
  ].join('\n');
}

function researchBriefHeader(task: AgentTask, gap: ResearchGap): string[] {
  const claims = gap.requiredClaims.map((claim) => `- ${claim.key}（${claim.type}）：${claim.text}`).join('\n');
  const budget = gap.budget;
  return [
    '执行 WeMediaBuddy 研究补料任务（reporter / research，记者实例）。',
    `task_id=${task.id}`,
    'intent=research（系统按角色自动派生，不接受手动指定）',
    `父工单=${gap.parentRoleId} / ${gap.parentJobId}（边界继承：businessDate=${task.businessDate}）`,
    `预算（机器硬执行，不靠 prompt）：${budget.timeMinutes} 分钟 / ${budget.maxCandidates} 候选上限 / ${budget.maxParallelFetches} 并行抓取 / 仅一轮。`,
    '要求核查的声明：',
    claims
  ];
}

/** 发现阶段 prompt：记者经白名单读工具收集候选，输出结构化候选清单。 */
export function researchDiscoveryPrompt(task: AgentTask, gap: ResearchGap): string {
  const budget = gap.budget;
  return [
    ...researchBriefHeader(task, gap),
    '任务：',
    '1. 必须先主动调用 wmb_search_web 检索公网；对每条入选 web 候选再调用 wmb_read_web_page 实际打开正文。X/XHS 候选必须用对应只读工具读取正文。禁止用模型记忆、搜索摘要、标题或 URL 代替已读证据。',
    researchToolDisciplineText(),
    '2. 围绕每个声明分别执行支持性查询与反证/限制性查询；优先寻找官方/一手资料，同时补充独立真实案例、失败案例或不适用边界。',
    '3. 只输出实际打开并读过的候选；每条给出可核验字段 title/originalUrl/author/summary。price/policy 类声明每条候选必须同时带 publishedAt（时间）与 excerpt（原文关键句 verbatim 摘录）。',
    '4. 官方/一手来源 sourceKind 填 official，其余填 secondary（机器按 1 官方 或 2 独立域二手 门槛校验，不达标不采信）。',
    `5. 候选总数不得超过 ${budget.maxCandidates} 条；达到 ${budget.minValidSources} 条有效候选，或发现阶段已用约 8 分钟时，立即停止继续扩展并输出当前结果。X/XHS 已读正文放 inlineText，web 候选不填 inlineText（由系统再次抓取、校验并写入 Source SSOT）。`,
    '6. 本阶段只负责读取与返回候选：禁止调用 wmb_save_source，禁止调用 wmb_report_agent_progress；来源写入与进度持久化由系统在结构化回复后执行。',
    '7. 如果联网检索或正文读取不可用，返回空候选或仅返回已实际读到的候选；不得用未经核验的产品结论补齐数量。',
    '8. 末条回复必须输出一个 ```json 代码块：{ "candidates": [{ "key": "<唯一键>", "claimKey": "<声明键>", "url": "...", "title": "...", "author": "...", "summary": "...", "publishedAt": "...", "excerpt": "...", "sourceKind": "official|secondary", "inlineText": "..." }] }。',
    '不得编造来源 URL 或字段；无法核验的候选不要列入。系统只会为成功抓取并写入资料库的候选签发 sourceId。'
  ].join('\n');
}

/** 建议阶段 prompt：记者基于已核验证据提出 claim 判定建议（机器校验为准）。 */
export function researchProposalPrompt(task: AgentTask, gap: ResearchGap, evidenceSummary: string): string {
  return [
    ...researchBriefHeader(task, gap),
    '已核验证据（sourceId 索引，系统已抓取并入库）：',
    evidenceSummary,
    '本阶段只依据上方已入库证据输出判定；禁止继续检索、读取、写入来源或上报进度。',
    '判定规则（机器为准，建议仅作参考，伪造不达标建议会被降级）：',
    '- supported = ≥1 官方/一手源，或 ≥2 独立可靠二手源（域名互异、字段完整）；price/policy 每条支撑证据必须带时间+摘录。',
    '- contradicted = 反向证据达同门槛，或官方来源直接推翻原命题。',
    '- unresolved = 一轮内已核查但无法判定（证据不足/冲突未达门槛）。',
    '末条回复必须直接输出一个 ```json 代码块：{ "claims": [{ "claimKey": "...", "status": "supported|contradicted|unresolved|source_unavailable", "evidenceSourceIds": ["<sourceId>"], "verdictReason": "..." }] }。',
    '不得编造无出处数字；证据不足时如实标 unresolved。'
  ].join('\n');
}

function researchEvidenceSummary(evidenceByClaim: Readonly<Record<string, readonly ResearchEvidenceItem[]>>): string {
  const lines: string[] = [];
  for (const [claimKey, items] of Object.entries(evidenceByClaim)) {
    lines.push(`## ${claimKey}`);
    for (const item of items) {
      lines.push(`- sourceId=${item.sourceId} | title=${item.title} | url=${item.url} | author=${item.author} | publishedAt=${item.publishedAt ?? 'N/A'} | sourceKind=${item.sourceKind}${item.excerpt ? ` | excerpt=${item.excerpt}` : ''}`);
      lines.push(`  summary=${item.summary}`);
    }
  }
  return lines.length ? lines.join('\n') : '（无）';
}

/**
 * WMB-5172 §5.6：research 任务终态落盘（succeeded/partial + EvidencePack）。
 * 既有命令面无 research resultRefs 写面（complete/partial 为 daily 专用），本地写 + operation_log
 * 审计 + data-changed 广播，语义与 completeAgentTask 对齐；failed/cancelled 走 dispatchFail/Cancel。
 * 工作空间写守卫下必须由 startResearchJob 终态段包在 agent_tasks.research_terminal 命令 execute 中调用
 * （writeAuthorizationDepth>0）；裸库路径直接调用（生产路径测试同构验证）。
 */
export function writeResearchTerminal(database: DatabaseSync, taskId: string, input: { status: 'succeeded' | 'partial'; pack: ResearchEvidencePack }): void {
  const now = new Date().toISOString();
  const phase = input.status === 'succeeded' ? 'completed' : 'partial';
  database.prepare(`UPDATE agent_tasks SET status = ?, phase = ?, result_refs_json = ?, error_code = NULL, error_message = NULL,
    control_action = NULL, updated_at = ?, finished_at = ? WHERE id = ?`).run(input.status, phase, JSON.stringify(input.pack), now, now, taskId);
  recordOperation(database, {
    actorType: 'scheduler',
    clientLabel: 'research-runner',
    command: 'agent_tasks.complete',
    entityType: 'agent_task',
    entityId: taskId,
    result: input.status === 'succeeded' ? 'ok' : 'error',
    errorCode: input.status === 'partial' ? 'PARTIAL' : undefined
  });
  broadcastDataChanged({ scopes: ['agent', 'today'], reason: `agent.research.${input.status}` });
}

// ============================================================================
// WMB-5173 写守卫合规：research_claims 批量持久化（单命令原子 + 稳定重放键）
// ============================================================================

/** runner persistClaims 单条声明（与 ResearchRunnerDeps.persistClaims 元素同构）。 */
export type ResearchClaimPersistInput = Readonly<{
  claimKey: string;
  claimText: string;
  claimType: ResearchRequiredClaim['type'];
  status: ResearchClaimStatus;
  verdictReason: string;
  evidenceSourceIds: readonly string[];
  verifiedAt: string;
}>;

/**
 * 整批声明在单个事务内 upsert：任一 claim 失败即抛错 → 调用方（dispatcher 或裸库调用点）
 * 回滚整批，零部分写；按 (task_id, claim_key) 幂等 upsert（重放不产生第二行、不覆盖冻结字段）。
 */
function persistClaimsBatch(database: DatabaseSync, taskId: string, claims: readonly ResearchClaimPersistInput[]): void {
  for (const claim of claims) {
    const result = upsertResearchClaim(database, {
      taskId,
      claimKey: claim.claimKey,
      claimText: claim.claimText,
      claimType: claim.claimType,
      status: claim.status,
      verdictReason: claim.verdictReason,
      evidenceSourceIds: [...claim.evidenceSourceIds],
      verifiedAt: claim.verifiedAt
    });
    if (!result.ok) throw new Error(`claim 写入失败：${result.error.message}`);
  }
}

/**
 * 稳定 requestId：同一任务同一逻辑批恒同键（dispatcher 按 (workspace,requestId) 重放去重，
 * 同键同输入返回原收据不重执行），不同内容批互异（绝不 REQUEST_REPLAY_CONFLICT）；
 * 内容哈希派生（非 randomUUID/时间戳），跨重启/乱序确定性。
 */
function researchClaimsRequestId(taskId: string, claims: readonly ResearchClaimPersistInput[]): string {
  const digest = createHash('sha256').update(JSON.stringify(claims.map((claim) => ({
    claimKey: claim.claimKey,
    claimText: claim.claimText,
    claimType: claim.claimType,
    status: claim.status,
    verdictReason: claim.verdictReason,
    evidenceSourceIds: [...claim.evidenceSourceIds],
    verifiedAt: claim.verifiedAt
  })))).digest('hex');
  return `${taskId}:claims:${digest.slice(0, 24)}`;
}

/**
 * WMB-5173：research_claims 批量持久化生产接线（startResearchJob deps.persistClaims 同构）。
 * - 裸库（无 dispatchCommand）：直写（既有测试分支语义，无写守卫）。
 * - 活动运行时（写守卫）：整批原子包在 dispatchBusinessCommand 单事务中；
 *   requestId 内容稳定 → 同批重放返回原收据；失败收据经 requireReceiptData 抛错（fail-closed）。
 */
export async function dispatchPersistResearchClaims(
  dependency: AgentTaskMutationDependency,
  input: { taskId: string; claims: readonly ResearchClaimPersistInput[]; workerLeaseId?: string; causation?: Readonly<Record<string, unknown>> }
): Promise<void> {
  if (!('dispatchCommand' in dependency)) {
    persistClaimsBatch(dependency, input.taskId, input.claims);
    return;
  }
  const receipt = await dispatchBusinessCommand(dependency, {
    command: 'research_claims.upsert_batch',
    requestId: researchClaimsRequestId(input.taskId, input.claims),
    actor: schedulerActor('research-runner'),
    input: { taskId: input.taskId, claims: input.claims },
    boundIdentity: { entityType: 'research_claim', taskId: input.taskId },
    entityType: 'research_claim',
    taskId: input.taskId,
    workerLeaseId: input.workerLeaseId,
    causation: input.causation,
    execute: (db, normalizedInput) => {
      persistClaimsBatch(db, input.taskId, normalizedInput.claims);
      return { data: { taskId: input.taskId, written: normalizedInput.claims.length }, entityId: input.taskId, readback: null };
    }
  });
  requireReceiptData(receipt);
}

/**
 * WMB-5172：research intent 执行入口（startStudioDraft 同构依赖模式；WMB-5173 派单消费接线）。
 * 从 context_refs 读 ResearchGap（fail-closed）；预算硬执行（核心在 runResearchJob）；
 * Pi 会话 env 闭合 WMB-5170 身份接缝（WMB_AGENT_TASK_ID / WMB_WORKER_LEASE_ID）；
 * 重启复用 resume_pending 任务并从 checkpoint 续跑（剩余预算内，绝不开始第 2 轮）。
 */
export async function startResearchJob(input: {
  dataRootPath: string; businessDate: string; piConfigPath?: string; mcpUrl: string;
  xhsMcpUrl?: string | null; onEvent?: (event: Record<string, unknown>) => void; onRuntime?: (runtime: PiRpcSupervisor) => void;
  workerLeaseId?: string; activeRuntime?: ActiveWorkspaceRuntime; sessionFile?: string;
  onTaskReady?: TaskReadyGrantHook; jobId?: string; signal?: AbortSignal;
}): Promise<ResearchJobRun> {
  const { dependency, database, close } = mutationDependency(input);
  const lane = 'research-runner';
  const startRequestId = `research:${input.businessDate}:start:${randomUUID()}`;
  let createdTask: AgentTask | null = null;
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  let activeRuntime: PiRpcSupervisor | null = null;
  let activeConfig: ResolvedPiConfig | null = null;
  let workDir: string | undefined;
  try {
    const contextRefs = { roleId: 'reporter' as const };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, { intent: 'research', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting;
    const started = await dispatchStartAgentTask(dependency, { intent: 'research', businessDate: input.businessDate, contextRefs }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    const task = started.task;
    createdTask = task;
    if (started.reused && !['resume_pending', 'starting'].includes(task.phase)) return { task, reused: true };
    // 复用撞车防护：同业务日存在其他父工单的活动 research 任务时 fail-closed（绝不跑错任务）。
    if (input.jobId && typeof task.contextRefs.jobId === 'string' && task.contextRefs.jobId !== input.jobId) {
      throw Object.assign(new Error(`RESEARCH_TASK_REUSE_CONFLICT：活动 research 任务（${task.id}）不属于当前工单 ${input.jobId}。`), { code: 'RESEARCH_FAILED' });
    }
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    // onTaskReady 之后合同 refs 已写入：读回 ResearchGap（fail-closed，损坏 refs 拒绝降级）。
    const latest = getAgentTask(database, task.id) ?? task;
    const gap = readResearchGap(latest.contextRefs);
    if (!gap) {
      await dispatchFailAgentTask(dependency, task.id, 'RESEARCH_FAILED', '研究缺口合同缺失或损坏（context_refs fail-closed，拒绝降级为普通 reporter）。', taskCommandContext(lane, `${task.id}:fail:gap`, task.id, input.workerLeaseId));
      return { task: getAgentTask(database, task.id) ?? task, reused: started.reused };
    }

    const piSessionId = `research-${task.id}`;
    await dispatchUpdateAgentTaskPhase(dependency, task.id, task.phase, { piSessionId }, taskCommandContext(lane, `${task.id}:phase:session:${piSessionId}`, task.id, input.workerLeaseId, { requestId: startRequestId }));
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    const extensionPath = await preparePiExtension(layout.agentDir);
    const sessionFile = input.sessionFile || path.join(layout.agentDir, 'sessions', `${piSessionId}.jsonl`);
    await mkdir(path.dirname(sessionFile), { recursive: true });
    workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-research-'));
    if (input.signal?.aborted) abortController.abort();
    else input.signal?.addEventListener('abort', onAbort, { once: true });

    const createRuntime = async (nextConfig: ResolvedPiConfig) => {
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
      const runtime = new PiRpcSupervisor(process.execPath, researchPiRuntimeArgs({
        piCliPath: await piCliPath(input.dataRootPath),
        sessionFile,
        extensionPath,
        model: nextConfig.model,
        authorityPrompt: piTaskAuthorityPrompt({ taskId: task.id, grantId, workerLeaseId: input.workerLeaseId })
      }), {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PI_CODING_AGENT_DIR: layout.agentDir,
        WMB_PI_API_KEY: nextConfig.apiKey,
        WMB_MCP_URL: input.mcpUrl,
        WMB_XHS_MCP_URL: input.xhsMcpUrl || '',
        // WMB-5170 客户端身份接缝：env 派生 _meta 注入 + 服务端 lease 校验，闭合运行时路径。
        WMB_AGENT_TASK_ID: task.id,
        WMB_WORKER_LEASE_ID: input.workerLeaseId || ''
      }, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
      input.onRuntime?.(runtime);
      return runtime;
    };

    const promptOnce = async (prompt: string, timeoutMs: number): Promise<string> => {
      const baseline = await readFile(sessionFile, 'utf8').then((text) => text.split(/\r?\n/).length).catch(() => 0);
      if (!activeRuntime || !activeConfig) {
        const started = await startPiRuntimeWithFallback({
          piConfigPath: input.piConfigPath,
          createRuntime,
          onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>)
        });
        activeRuntime = started.runtime;
        activeConfig = started.config;
      }
      const runtime = activeRuntime;
      const config = activeConfig;
      if (!runtime || !config) throw new Error('PI_RUNTIME_UNREACHABLE：研究会话运行时未就绪。');
      const completed = await runPiPromptWithFallback({
        piConfigPath: input.piConfigPath,
        initial: { runtime, config },
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>),
        onRuntimeChanged: (nextRuntime, nextConfig) => {
          activeRuntime = nextRuntime;
          activeConfig = nextConfig;
          input.onRuntime?.(nextRuntime);
        },
        run: async (active) => {
          // WMB-5178 §5：员工接收会话盖章（research，target=employee，Dock 永不镜像）。
          await active.promptUntilSettled(buildOrchestrationEnvelope({ dispatchId: `research:${task.id}`, target: 'employee', delivery: 'direct', safe: { originLabel: '研究补料', title: '证据研究', goal: '核查 required claims 并产出可校验证据与判定建议', acceptance: '结构化候选与 claim 建议' }, prompt }), { timeoutMs });
        }
      });
      activeRuntime = completed.runtime;
      activeConfig = completed.config;
      return readAssistantTexts(await readFile(sessionFile, 'utf8'), baseline).join('\n');
    };

    const deps: ResearchRunnerDeps = {
      now: () => new Date(),
      discoverCandidates: async (researchGap, options) => {
        if (abortController.signal.aborted) return [];
        const output = await promptOnce(researchDiscoveryPrompt(task, researchGap), Math.max(30_000, Math.min(resolveResearchPromptTimeoutMs(), options.timeLeftMs)));
        const parsed = parseResearchCandidates(output);
        if (!parsed) throw new Error('DISCOVERY_PARSE_FAILED：研究候选结构化输出缺失或非法（fail-closed）。');
        return parsed;
      },
      fetchCandidate: async (candidate, options) => {
        if (candidate.inlineText) return { ok: true, text: candidate.inlineText, title: candidate.title ?? null, publishedAt: candidate.publishedAt ?? null };
        const result = await readWebPage({ url: candidate.url, timeoutMs: Math.max(1_000, Math.min(RESEARCH_READ_TIMEOUT_MS, options.deadlineMs)) });
        if (!result.ok) return { ok: false, reason: result.error?.reason ?? 'read_failed' };
        const data = result.data ?? {};
        const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
        const bodyText = typeof data.bodyText === 'string' ? data.bodyText : '';
        return { ok: true, text: bodyText, title };
      },
      writeSource: async (writeInput) => {
        const item: SourceInput = {
          title: writeInput.title,
          originalUrl: writeInput.url,
          author: writeInput.author,
          summary: writeInput.summary,
          publishedAt: writeInput.publishedAt ?? undefined,
          evidence: writeInput.excerpt ? JSON.stringify({ excerpt: writeInput.excerpt }) : undefined,
          categories: ['研究补料'],
          keywords: ['research'],
          priority: 1,
          clientLabel: 'WMB research'
        };
        if (!('dispatchCommand' in dependency)) return null; // 裸库路径无信封机制：写回拒绝（fail-closed），候选计为失败。
        const receipt = await dispatchSourceUpsertBatch(dependency, {
          requestId: writeInput.requestId,
          actor: { type: 'scheduler' as const, id: 'research-runner', label: 'research-runner' },
          items: [item],
          taskId: task.id,
          workerLeaseId: input.workerLeaseId,
          grantId: grantId ?? undefined
        });
        const data = requireReceiptData(receipt);
        const first = data.items[0];
        return first ? { sourceId: first.id, created: first.created } : null;
      },
      listSourceWriteReceipts: async () => {
        const rows = database.prepare(`SELECT result_json AS resultJson FROM command_receipts
          WHERE task_id = ? AND command = 'sources.upsert_batch' AND status = 'ok' AND request_id LIKE ?`)
          .all(task.id, `${task.id}:source:%`) as Array<{ resultJson: string | null }>;
        const receipts: Array<{ sourceId: string; created: boolean }> = [];
        for (const row of rows) {
          if (!row.resultJson) continue;
          const data = JSON.parse(row.resultJson) as { items?: Array<{ id?: unknown; created?: unknown }> };
          for (const item of data.items ?? []) {
            if (typeof item.id === 'string') receipts.push({ sourceId: item.id, created: item.created === true });
          }
        }
        return receipts;
      },
      proposeClaims: async (proposalInput) => {
        if (abortController.signal.aborted) return [];
        const output = await promptOnce(researchProposalPrompt(task, gap, researchEvidenceSummary(proposalInput.evidenceByClaim)), Math.max(30_000, Math.min(resolveResearchPromptTimeoutMs(), proposalInput.timeLeftMs)));
        const parsed = parseClaimProposals(output);
        if (!parsed) throw new Error('PROPOSAL_PARSE_FAILED：claim 建议结构化输出缺失或非法（fail-closed）。');
        return parsed;
      },
      persistProgress: async (progressInput) => {
        const current = getAgentTask(database, task.id);
        if (current?.controlAction === 'cancel') abortController.abort();
        await dispatchReportAgentTaskProgress(dependency, task.id, {
          phase: 'researching',
          progress: { planned: progressInput.planned, processed: progressInput.processed, verified: progressInput.verified, saved: progressInput.saved, message: progressInput.message },
          checkpoint: { ...progressInput.checkpoint }
        }, taskCommandContext(lane, `${task.id}:progress:${randomUUID()}`, task.id, input.workerLeaseId, { requestId: startRequestId }));
      },
      persistClaims: async (claims) => {
        // WMB-5173：写守卫下必须经命令派发（dispatchPersistResearchClaims 内部按依赖选路）。
        await dispatchPersistResearchClaims(dependency, {
          taskId: task.id,
          claims,
          workerLeaseId: input.workerLeaseId,
          causation: { requestId: startRequestId }
        });
      },
      listClaims: () => Promise.resolve(listResearchClaims(database, task.id).map((claim) => ({
        id: claim.id,
        claimKey: claim.claimKey,
        status: claim.status,
        verdictReason: claim.verdictReason,
        evidenceSourceIds: claim.evidenceSourceIds,
        needsTimeExcerpt: claim.needsTimeExcerpt === 1
      })))
    };

    const run = await runResearchJob({
      task: { id: task.id, businessDate: task.businessDate, contextRefs: latest.contextRefs, checkpoint: latest.checkpoint, progress: latest.progress },
      gap,
      signal: abortController.signal
    }, deps);

    const finalTask = getAgentTask(database, task.id) ?? task;
    if (finalTask.status !== 'running') return { task: finalTask, reused: started.reused };
    if (run.terminal === 'cancelled' || finalTask.controlAction === 'cancel') {
      const cancelled = await dispatchCancelAgentTask(dependency, task.id, taskCommandContext(lane, `${task.id}:cancel:terminal`, task.id, input.workerLeaseId));
      return { task: cancelled, reused: started.reused };
    }
    if (run.terminal === 'failed') {
      await dispatchFailAgentTask(dependency, task.id, run.failure?.code ?? 'RESEARCH_FAILED', run.failure?.message ?? '研究执行失败。', taskCommandContext(lane, `${task.id}:fail:terminal`, task.id, input.workerLeaseId));
      return { task: getAgentTask(database, task.id) ?? task, reused: started.reused };
    }
    if (run.pack) {
      // 机器不变量：EvidencePack 仅在 succeeded/partial 终态产出（runner 保证）；防御性 fail-closed。
      if (run.terminal !== 'succeeded' && run.terminal !== 'partial') {
        throw Object.assign(new Error(`RESEARCH_TERMINAL_STATUS_MISMATCH: EvidencePack 必须伴随 succeeded/partial（实际 ${run.terminal}）。`), { code: 'RESEARCH_FAILED' });
      }
      const terminalStatus = run.terminal;
      const evidencePack = run.pack;
      await dispatchReportAgentTaskProgress(dependency, task.id, {
        phase: terminalStatus === 'succeeded' ? 'completed' : 'partial',
        progress: { ...run.progress, message: terminalStatus === 'succeeded' ? '研究完成：全部 required claim 已判定。' : '研究一轮耗尽：存在未解决声明。' },
        checkpoint: { ...run.checkpoint }
      }, taskCommandContext(lane, `${task.id}:progress:terminal`, task.id, input.workerLeaseId, { requestId: startRequestId }));
      // 工作空间写守卫要求经命令派发（writeAuthorizationDepth>0）；裸库路径直接本地写。
      if ('dispatchCommand' in dependency) {
        await dispatchBusinessCommand(dependency, {
          command: 'agent_tasks.research_terminal',
          requestId: `${task.id}:terminal:${terminalStatus}:${randomUUID()}`,
          actor: schedulerActor(lane),
          input: { taskId: task.id, status: terminalStatus },
          boundIdentity: { entityType: 'agent_task', entityId: task.id },
          entityType: 'agent_task',
          execute: (db) => {
            writeResearchTerminal(db, task.id, { status: terminalStatus, pack: evidencePack });
            enqueueResearchSuccessor(db, { researchTaskId: task.id, autoDecision: 'narrow' });
            return { data: { taskId: task.id, status: terminalStatus }, entityId: task.id, readback: null };
          }
        });
      } else {
        writeResearchTerminal(database, task.id, { status: terminalStatus, pack: evidencePack });
        enqueueResearchSuccessor(database, { researchTaskId: task.id, autoDecision: 'narrow' });
      }
    }
    return { task: getAgentTask(database, task.id) ?? task, reused: started.reused };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (createdTask) {
      const current = getAgentTask(database, createdTask.id);
      if (current?.status === 'running' && current.controlAction !== 'cancel') {
        await dispatchFailAgentTask(dependency, createdTask.id, 'RESEARCH_FAILED', message, taskCommandContext(lane, `${createdTask.id}:fail`, createdTask.id, input.workerLeaseId));
      }
    }
    throw error;
  } finally {
    if (input.signal && !input.signal.aborted) input.signal.removeEventListener('abort', onAbort);
    await (activeRuntime as PiRpcSupervisor | null)?.stop().catch(() => {});
    if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    close();
  }
}
