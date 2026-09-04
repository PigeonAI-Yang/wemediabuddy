import { dailyControlWatchdogDecision } from './daily-control-policy.ts';
import { createHash, randomUUID } from 'node:crypto';
import { getSource } from './sources.ts';
import { wakePersistentKnowledgeJobs } from './knowledge-compile-trigger.ts';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { proxyEnvForChildren } from './proxy-config.ts';
import type { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './db/migrations.ts';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import { assembleEditorialBrief, renderEditorialBrief } from './editorial-brief.ts';
import { refreshWorkCarry } from './ferment.ts';
import {
  applyLaneGateBatch,
  getLatestLaneJudgment,
  isTier0AutoRelevantSource,
  LANE_REASON_CODES,
  LANE_TIER0_REASON_CODE,
  listLaneGateCandidates,
  shouldSkipJudgment,
  type LaneGateCandidate,
  type LaneReasonCode
} from './lane-gate.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { readWorkspaceProfile } from './workspace-profiles.ts';
import type { TaskReadyGrantHook } from './task-grants.ts';
import type { RoleJobRequest, WriterTask } from './role-job-registry.ts';
import {
  agentRequestId,
  cancelAgentTask,
  dailyAgentSessionId,
  getActiveDailyIntelligenceTask,
  getAgentTask,
  readLatestJudgeWatermark,
  type AgentTask
} from './agent-tasks.ts';
import {
  dispatchCancelAgentTask,
  dispatchCompleteAgentTask,
  dispatchFailAgentTask,
  dispatchNeedsUserAgentTask,
  dispatchFinishDailyIntelligence,
  dispatchPartialAgentTask,
  dispatchReportAgentTaskProgress,
  dispatchStartAgentTask,
  dispatchUpdateAgentTaskPhase,
  type AgentTaskCommandContext,
  type AgentTaskMutationDependency
} from './agent-task-commands.ts';
import { readTaskModelPolicySnapshot, resolveAgentPiPrerequisite, roleModelNeedsUserFailure } from './agent-prerequisites.ts';
import { ensurePiConversationLayout, readPiConversation } from './pi-conversation.ts';
import { buildOrchestrationEnvelope } from '../shared/orchestration-envelope.ts';
import { PiRpcSupervisor } from './pi-runtime.ts';
import { piModelsJson } from './pi-model.ts';
import { piCliFromRuntimeRoot, resolvePiRuntimeRoot } from './pi-runtime-manager.ts';
import { runPiPromptWithFallback, startPiRuntimeWithFallback } from './pi-config-fallback.ts';
import { preparePiExtension } from './pi-extension.ts';
import { piTaskAuthorityPrompt } from './pi-operator-skill.ts';
import type { ResolvedPiConfig } from './pi-config.ts';
import { saveCurrentPlan, type PlanSourceDecision } from './planning.ts';
import { submitPlanItemForReview } from './planning-stage.ts';
import { getToday } from './workbench.ts';
import { buildJobContextRefs, buildJobObjectBoundary, readJobContractFromRefs } from './job-object-boundary.ts';
import { PROPAGATION_V2_CRITERIA } from '../shared/propagation.ts';

const SCORE_CRITERIA_RECORD: Record<string, number> = PROPAGATION_V2_CRITERIA;
const scoreReasonsSchema = z.object({
  status: z.literal('scored'),
  version: z.literal('propagation_v2'),
  score: z.number().min(0).max(100),
  truthGate: z.object({
    status: z.literal('passed'),
    reason: z.string().min(1),
    claims: z.array(z.object({
      text: z.string().min(1),
      type: z.enum(['fact', 'inference', 'opinion']),
      status: z.literal('supported'),
      sourceIds: z.array(z.string().min(1))
    })).min(1)
  }),
  reasons: z.array(z.object({
    criterion: z.string(),
    weight: z.number(),
    score: z.number(),
    reason: z.string().optional()
  })).length(6)
}).superRefine((val, ctx) => {
  const seen = new Set<string>();
  let total = 0;
  for (const r of val.reasons) {
    const exp = SCORE_CRITERIA_RECORD[r.criterion];
    if (exp === undefined || seen.has(r.criterion)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'score_reasons_criteria_invalid', path: ['reasons'] });
      continue;
    }
    seen.add(r.criterion);
    if (r.weight !== exp || r.score < 0 || r.score > exp) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'score_reason_value_invalid', path: ['reasons'] });
    } else total += r.score;
  }
  if (seen.size !== 6) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'score_reasons_six_required' });
  if (total !== val.score) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'score_total_mismatch' });
});
const editorialDecisionSchema = z.object({
  version: z.literal('editorial_thesis_v1'),
  candidates: z.array(z.object({
    level: z.enum(['event', 'user', 'industry_or_society']),
    thesis: z.string().min(1),
    claimType: z.enum(['fact', 'inference', 'opinion']),
    evidenceStatus: z.enum(['supported', 'research_required']),
    evidenceBoundary: z.string().min(1),
    score: z.number().min(0).max(100),
    reason: z.string().min(1),
  })).min(3),
  winnerLevel: z.enum(['event', 'user', 'industry_or_society']),
  winnerThesis: z.string().min(1),
  winnerReason: z.string().min(1),
  knowledgeContext: z.object({
    status: z.enum(['used', 'no_relevant_context']),
    contextRefs: z.array(z.string().min(1)),
    queryDimensions: z.array(z.string().min(1)).min(2),
    reason: z.string().min(1),
  }),
});
const planOutputItemSchema = z.object({
  title: z.string().min(1),
  priority: z.number().int().min(0).default(0),
  whyNow: z.string().default(''),
  timeliness: z.string().default('今日'),
  targetAudience: z.string().default(''),
  angle: z.string().default(''),
  pointOfView: z.string().min(1),
  platforms: z.array(z.string()).default(['wechat']),
  formats: z.array(z.string()).default(['article']),
  titleGuidance: z.string().default(''),
  openingGuidance: z.string().default(''),
  structureGuidance: z.string().default(''),
  effortEstimate: z.string().default(''),
  sourceIds: z.array(z.string().min(1)).min(1),
  availableMaterials: z.array(z.string()).optional(),
  missingMaterials: z.array(z.string()).optional(),
  topicId: z.preprocess((value) => value === null ? undefined : value, z.string().optional()),
  reviewIds: z.array(z.string()).optional(),
  methodFindingIds: z.array(z.string()).optional(),
  editorialDecision: editorialDecisionSchema.optional(),
  scoreReasons: scoreReasonsSchema.optional()
});
const planSourceDecisionSchema = z.object({
  sourceId: z.string().min(1),
  sourceRevision: z.number().int().min(1).optional(),
  decision: z.enum(['selected', 'excluded', 'unresolved', 'blocked']),
  reasonCode: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
}).superRefine((value, ctx) => {
  if (value.decision === 'selected') return;
  if (!value.reasonCode) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reasonCode_required', path: ['reasonCode'] });
  if (!value.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reason_required', path: ['reason'] });
});
const planOutputSchema = z.object({
  planDate: z.string().optional(),
  summary: z.string().min(1),
  items: z.array(planOutputItemSchema).max(24),
  sourceDecisions: z.array(planSourceDecisionSchema).optional()
});

export type DailyPlanOutput = z.infer<typeof planOutputSchema>;

/** Tier 1 赛道判定条目：模型只输出 sourceId + relevant，irrelevant 必带 reasonCode + 一句话 reason。 */
export type LaneGateOutputEntry = Readonly<{
  sourceId: string;
  relevant: boolean;
  reasonCode?: string;
  reason?: string;
}>;

export type LaneGateOutput = Readonly<{ gate: readonly LaneGateOutputEntry[] }>;

const laneGateEntrySchema = z.object({
  sourceId: z.string().min(1),
  relevant: z.boolean(),
  reasonCode: z.string().optional(),
  reason: z.string().optional()
});
const laneGateOutputSchema = z.object({
  gate: z.array(laneGateEntrySchema)
});

/**
 * 第一关（赛道相关性）严格解析：取会话里**第一个** ```json 块（方案块在它之后、由
 * `parseDailyPlanOutput` 取最后一个块）。解析失败或语义非法 → 抛错，编排层整轮失败：
 * 零归档、水印不推进（fail-closed，设计 §3.2/§5）。
 */
export function parseLaneGateOutput(sessionText: string): LaneGateOutput {
  const fences = [...sessionText.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!fences.length) throw new Error('模型未输出有效的 ```json 赛道判定块。');
  const first = fences[0][1];
  let value: unknown;
  try {
    value = JSON.parse(first);
  } catch {
    throw new Error('模型输出的赛道判定块不是合法 JSON。');
  }
  const parsed = laneGateOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`模型赛道判定结构不完整：${parsed.error.issues.slice(0, 3).map((issue) => issue.path.join('.') || issue.message).join('；')}`);
  }
  const seen = new Set<string>();
  for (const entry of parsed.data.gate) {
    if (seen.has(entry.sourceId)) throw new Error(`模型赛道判定重复出现：${entry.sourceId}`);
    seen.add(entry.sourceId);
    if (!entry.relevant) {
      if (!entry.reasonCode) throw new Error(`模型赛道判定缺 reasonCode：${entry.sourceId}`);
      if (!(LANE_REASON_CODES as readonly string[]).includes(entry.reasonCode)) throw new Error(`模型赛道判定 reasonCode 不在词典内：${entry.reasonCode}`);
      if (entry.reasonCode === 'official_source' || entry.reasonCode === 'editor_override' || entry.reasonCode === 'lane_relevant') throw new Error(`模型赛道判定不可使用系统 reasonCode：${entry.reasonCode}`);
      if (!entry.reason?.trim()) throw new Error(`模型赛道判定 irrelevant 缺一句话 reason：${entry.sourceId}`);
    }
  }
  return parsed.data;
}

/**
 * 结构化输出路径：模型只需读简报并输出一个 ```json 代码块，由系统校验后代为保存。
 * 弱模型无法稳定构造多字段工具调用（四次实机空转证据），但读+判+写 JSON 文本是可靠的。
 */
export function parseDailyPlanOutput(sessionText: string): DailyPlanOutput {
  const fences = [...sessionText.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!fences.length) throw new Error('模型未输出有效的 ```json 方案块。');
  const last = fences[fences.length - 1][1];
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    throw new Error('模型输出的 ```json 方案块不是合法 JSON。');
  }
  const parsed = planOutputSchema.safeParse(value);
  if (!parsed.success) throw new Error(`模型方案结构不完整：${parsed.error.issues.slice(0, 3).map((issue) => {
    const field = issue.path.join('.');
    return field ? `${field}: ${issue.message}` : issue.message;
  }).join('；')}`);
  return parsed.data;
}

/**
 * 从会话 JSONL 解码 assistant 文本段。baseline 之后的行才算本轮输出：
 * resume 复用同一会话文件时，防止把上一轮的围栏当成本轮方案（评审 N1）。
 */
export function readAssistantTexts(raw: string, baseline = 0): string[] {
  const texts: string[] = [];
  const lines = raw.split(/\r?\n/).slice(baseline);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      const content = entry.message?.content;
      if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !Array.isArray(content)) continue;
      for (const segment of content) {
        if (segment && typeof segment === 'object' && (segment as { type?: unknown }).type === 'text') {
          const text = (segment as { text?: unknown }).text;
          if (typeof text === 'string' && text.trim()) texts.push(text);
        }
      }
    } catch {
      // 跳过无法解析的行
    }
  }
  return texts;
}

function stableJsonForPlan(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonForPlan).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJsonForPlan(record[k])}`).join(',')}}`;
}
function planDispatchRequestId(baseRequestId: string, input: unknown): string {
  const hash = createHash('sha256').update(stableJsonForPlan(input)).digest('hex').slice(0, 12);
  return `${baseRequestId}:${hash}`;
}
function readPersistedTaskPlanCount(
  database: Parameters<typeof assembleEditorialBrief>[0],
  taskId: string,
  planDate: string
): number | null {
  const receipt = database.prepare(`SELECT result_json
    FROM command_receipts
    WHERE task_id=? AND command='plans.save' AND status='ok' AND result_json IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1`).get(taskId) as { result_json: string } | undefined;
  if (!receipt) return null;
  try {
    const result = JSON.parse(receipt.result_json) as { id?: unknown };
    if (typeof result.id !== 'string' || !result.id) return null;
    const row = database.prepare(`SELECT COUNT(pi.id) AS itemCount
      FROM plans p
      LEFT JOIN plan_items pi ON pi.plan_id=p.id
      WHERE p.id=? AND p.plan_date=?
      GROUP BY p.id`).get(result.id, planDate) as { itemCount: number } | undefined;
    return row ? Number(row.itemCount) : null;
  } catch {
    return null;
  }
}


export async function savePlanFromSynthesisOutput(
  dependency: AgentTaskMutationDependency,
  task: AgentTask,
  sessionFile: string,
  _planRequestId: string,
  _workerLeaseId?: string,
  _grantId?: string | null,
  sessionBaseline = 0,
  _allowedSourceIds?: ReadonlySet<string>,
  _candidateSourceIds?: ReadonlySet<string>
): Promise<{ itemCount: number; filteredCount: number }> {
  const plan = parseDailyPlanOutput(readAssistantTexts(await readFile(sessionFile, 'utf8'), sessionBaseline).join('\n'));
  const database = 'database' in dependency ? dependency.database : dependency;
  if (plan.items.length === 0) {
    const existing = getToday(database, task.businessDate).plan;
    if (existing?.items.length) return { itemCount: existing.items.length, filteredCount: 0 };
  }
  const persist = () => saveCurrentPlan(database, {
    planDate: task.businessDate,
    timezone: 'Asia/Shanghai',
    summary: plan.summary,
    items: plan.items
  });
  if ('database' in dependency) await dependency.runActorControlPlane(persist);
  else persist();
  return { itemCount: plan.items.length, filteredCount: 0 };
}

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
  try {
    if (runtime.isActive) await runtime.abortTurn().catch(() => {});
  } catch { /* ignore */ }
  await runtime.stop().catch(() => {});
  activeDailyRuntimes.delete(taskId);
  return true;
}

export type DailyIntelligenceRun = {
  task: AgentTask;
  reused: boolean;
  savedCount?: number;
};

type ScoringRecoveryItem = { id: string; revision: number; title: string; sourceIds: string[] };
type ScoringRecovery = { planId: string; items: ScoringRecoveryItem[] };

export function getCurrentScoringRecovery(database: DatabaseSync, businessDate: string): ScoringRecovery | null {
  const plan = database.prepare('SELECT id FROM plans WHERE plan_date = ? AND is_current = 1 ORDER BY created_at DESC LIMIT 1').get(businessDate) as { id: string } | undefined;
  if (!plan) return null;
  const rows = database.prepare(`SELECT id, revision, title, source_ids_json AS sourceIdsJson, score_reasons_json AS scoreReasonsJson
    FROM plan_items WHERE plan_id = ? AND planning_status IN ('draft','rejected') ORDER BY sort_order`).all(plan.id) as Array<{ id: string; revision: number; title: string; sourceIdsJson: string; scoreReasonsJson: string }>;
  const items = rows.filter((row) => {
    try { const score = JSON.parse(row.scoreReasonsJson || '{}'); return score.status !== 'scored' || !Array.isArray(score.reasons) || score.reasons.length !== 6; } catch { return true; }
  }).map((row) => ({ id: row.id, revision: row.revision, title: row.title, sourceIds: JSON.parse(row.sourceIdsJson || '[]') as string[] }));
  return items.length ? { planId: plan.id, items } : null;
}

function scoringRecoveryPrompt(base: string, recovery: ScoringRecovery): string {
  return `${base}\n\n【评分恢复硬约束】当前计划 ${recovery.planId} 已存在，禁止创建或替换计划，禁止扫描/记者。只为以下冻结条目补齐六维传播评分；输出 items 必须与清单一一对应，title 与 sourceIds 原样保留，不得增删或换源：\n${JSON.stringify(recovery.items)}\n每项 scoreReasons 必须通过总分等于六项之和的校验。`;
}

async function applyScoringRecovery(dependency: AgentTaskMutationDependency, task: AgentTask, sessionFile: string, baseline: number, recovery: ScoringRecovery, workerLeaseId?: string, grantId?: string | null): Promise<number> {
  const output = parseDailyPlanOutput(readAssistantTexts(await readFile(sessionFile, 'utf8'), baseline).join('\n'));
  if (output.items.length !== recovery.items.length) throw new Error(`scoring_recovery_item_count_mismatch: expected ${recovery.items.length}, got ${output.items.length}`);
  for (const frozen of recovery.items) {
    const candidate = output.items.find((item) => item.title === frozen.title && stableJsonForPlan([...item.sourceIds].sort()) === stableJsonForPlan([...frozen.sourceIds].sort()));
    if (!candidate) throw new Error(`scoring_recovery_item_mismatch: ${frozen.id}`);
    if ('database' in dependency) {
      requireReceiptData(await dispatchBusinessCommand(dependency, {
        command: 'plan_item.submit', requestId: `${task.id}:scoring-recovery:${frozen.id}:${frozen.revision}`,
        actor: { type: 'pi', id: 'pi', label: 'Pi worker' }, taskId: task.id, workerLeaseId, grantId: grantId ?? undefined,
        input: { planItemId: frozen.id, expectedRevision: frozen.revision, item: candidate, by: 'planner', reason: 'scoring_recovery' },
        boundIdentity: { entityType: 'plan_item', entityId: frozen.id }, entityType: 'plan_item',
        execute: (db, value) => ({ data: submitPlanItemForReview(db, value), entityId: frozen.id })
      }));
    } else {
      submitPlanItemForReview(dependency, { planItemId: frozen.id, expectedRevision: frozen.revision, item: candidate, by: 'planner', reason: 'scoring_recovery' });
    }
  }
  return recovery.items.length;
}

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
    '你是内容主编。阅读下面今天采集到的资讯，直接提出一批值得创作的选题。',
    `plan_date=${task.businessDate}`,
    `plan_request_id=${planRequestId}`,
    '',
    briefText,
    '',
    '要求：',
    '1. 合并重复报道，但不要把不同事件或不同观点合成一个题。',
    '2. 尽量给出 10 到 20 个有明显差异的选题；资讯确实不足时可以少于 10 个，但不要因为格式、评分或资料不完整而丢掉有价值的方向。',
    '3. 每个选题说清楚：标题、现在为什么值得写、核心观点，以及它来自哪些 sourceId。',
    '4. 标题要具体、自然、可直接用于创作，不要写成新闻摘要，不要重复同一个角度。',
    '5. 不调用工具，不输出分析过程，只输出一个 JSON 代码块。',
    '',
    '```json',
    JSON.stringify({
      planDate: task.businessDate,
      summary: '今天值得创作的方向',
      items: [{
        title: '具体选题标题',
        whyNow: '现在为什么值得写',
        pointOfView: '这篇内容要表达的核心观点',
        angle: '切入角度',
        targetAudience: '最关心这个问题的人',
        sourceIds: ['简报中的真实 sourceId']
      }]
    }),
    '```'
  ].join('\n');
}

export type DailyGateRun = Readonly<{
  /** 赛道身份（intelligencePackId）；无配方时 null → 本轮资料门整体 no-op。 */
  lane: string | null;
  /** Tier 0 自动相关（官方/赛道精选信源，零模型）。 */
  autoRelevant: readonly LaneGateCandidate[];
  /** 待 Tier 1（模型）逐条判定。 */
  pending: readonly LaneGateCandidate[];
}>;

function resolveJudgeWatermark(database: Parameters<typeof assembleEditorialBrief>[0], task: AgentTask): string | null {
  return typeof task.checkpoint?.judgeWatermark === 'string' && task.checkpoint.judgeWatermark
    ? task.checkpoint.judgeWatermark
    : readLatestJudgeWatermark(database);
}

/**
 * 一轮判定门的候选清单：与简报增量同一窗口（watermark 或 24h 回看），
 * Tier 0 规则分流；7 日冷却（shouldSkipJudgment）命中者跳过不重判（含主编恢复后、以及失败重跑轮）。
 */
export function buildDailyGateRun(database: Parameters<typeof assembleEditorialBrief>[0], task: AgentTask): DailyGateRun {
  const profile = readWorkspaceProfile(database);
  if (!profile) return { lane: null, autoRelevant: [], pending: [] };
  const watermark = resolveJudgeWatermark(database, task);
  const since = watermark ?? new Date(Date.now() - 24 * 3_600_000).toISOString();
  const candidates = listLaneGateCandidates(database, { since });
  const autoRelevant: LaneGateCandidate[] = [];
  const pending: LaneGateCandidate[] = [];
  for (const candidate of candidates) {
    if (shouldSkipJudgment(database, candidate.sourceId)) continue;
    if (isTier0AutoRelevantSource(database, candidate, profile.intelligencePackId)) autoRelevant.push(candidate);
    else pending.push(candidate);
  }
  return { lane: profile.intelligencePackId, autoRelevant, pending };
}

function assembleDailyPlannerBrief(database: Parameters<typeof assembleEditorialBrief>[0], task: AgentTask) {
  const dayStartMs = Date.parse(`${task.businessDate}T00:00:00.000+08:00`);
  const since = new Date(dayStartMs - 1).toISOString();
  const until = new Date(Date.parse(`${task.businessDate}T23:59:59.999+08:00`)).toISOString();
  const row = database.prepare(`SELECT COUNT(*) AS count FROM source_items
    WHERE julianday(collected_at) > julianday(?) AND julianday(collected_at) <= julianday(?) AND management_status != 'archived'`).get(since, until) as { count: number };
  return assembleEditorialBrief(database, {
    now: new Date(),
    businessDate: task.businessDate,
    watermark: since,
    until,
    sourceLimit: Math.max(1, Number(row.count))
  });
}


export function buildPlannerSourceBoundary(
  database: Parameters<typeof assembleEditorialBrief>[0],
  task: AgentTask,
  relevantIds?: ReadonlySet<string>
): Readonly<{ candidateIds: ReadonlySet<string>; allowedIds: ReadonlySet<string> }> {
  const brief = assembleDailyPlannerBrief(database, task);
  const dailyIds = brief.increment.sources.map((source) => source.id);
  const reactivatedIds = brief.continuity.reactivated.flatMap((pack) => pack.sources.map((source) => source.id));
  const candidateIds = new Set([...dailyIds, ...reactivatedIds]);
  const previouslyRelevantIds = dailyIds.filter((sourceId) => {
    const source = getSource(database, sourceId);
    const judgment = getLatestLaneJudgment(database, sourceId);
    return Boolean(source && judgment?.decision === 'relevant' && judgment.sourceRevision === source.revision);
  });
  const eligibleReactivatedIds = reactivatedIds.filter((sourceId) => getLatestLaneJudgment(database, sourceId)?.decision !== 'irrelevant');
  const allowedIds = relevantIds
    ? new Set([...previouslyRelevantIds, ...relevantIds, ...eligibleReactivatedIds])
    : new Set(candidateIds);
  return Object.freeze({ candidateIds, allowedIds });
}

export function buildDailyOpportunityPrompt(
  database: Parameters<typeof assembleEditorialBrief>[0],
  task: AgentTask,
  planRequestId: string,
  _options: { nativeSearch?: boolean; gateRun?: DailyGateRun } = {}
): string {
  return dailyPrompt(task, planRequestId, renderEditorialBrief(assembleDailyPlannerBrief(database, task)));
}

export function cancelDailyIntelligenceIfRequested(database: Parameters<typeof cancelAgentTask>[0], task: AgentTask | null | undefined): AgentTask | null {
  if (task?.status !== 'running' || task.controlAction !== 'cancel') return null;
  const cancelled = cancelAgentTask(database, task.id);
  if (!cancelled.ok) throw new Error(cancelled.error.message);
  return cancelled.data;
}
export type DailyLaneGateApplied = Readonly<{
  relevantIds: ReadonlySet<string>;
  archivedCount: number;
  unresolved: boolean;
  unresolvedIds: ReadonlySet<string>;
}>;

function judgingFingerprint(source: { title?: unknown; canonicalUrl?: unknown; canonical_url?: unknown; feedId?: unknown; feed_id?: unknown; summary?: unknown }): string {
  const title = String((source as Record<string, unknown>).title ?? '');
  const url = String((source as Record<string, unknown>).canonicalUrl ?? (source as Record<string, unknown>).canonical_url ?? '');
  const feed = String((source as Record<string, unknown>).feedId ?? (source as Record<string, unknown>).feed_id ?? '');
  const summary = String((source as Record<string, unknown>).summary ?? '');
  return createHash('sha256').update(`${title}|${url}|${feed}|${summary}`).digest('hex').slice(0, 12);
}

function gateJudgmentInput(
  database: Parameters<typeof assembleEditorialBrief>[0],
  candidate: LaneGateCandidate,
  decision: 'relevant' | 'irrelevant',
  reasonCode: LaneReasonCode,
  reason?: string
) {
  const current = getSource(database, candidate.sourceId);
  const expectedRevision = current && judgingFingerprint(current) === judgingFingerprint(candidate)
    ? current.revision
    : candidate.revision;
  return { sourceId: candidate.sourceId, decision, reasonCode, reason, expectedRevision };
}
async function writeLaneGateBatch(
  dependency: AgentTaskMutationDependency,
  task: AgentTask,
  input: { workspaceLane: string; judgedBy: 'system' | 'agent'; judgedAt: string; judgments: Array<ReturnType<typeof gateJudgmentInput>> },
  requestId: string,
  workerLeaseId?: string
): Promise<{ unresolved: boolean; unresolvedIds: string[] }> {
  if (input.judgments.length === 0) return { unresolved: false, unresolvedIds: [] };
  const doDispatch = async (value: typeof input, rid: string) => {
    if ('database' in dependency) {
      requireReceiptData(await dispatchBusinessCommand(dependency, {
        command: 'sources.lane_gate',
        requestId: rid,
        actor: schedulerActor('daily-intelligence'),
        taskId: task.id,
        workerLeaseId,
        input: value,
        boundIdentity: { entityType: 'lane_judgment', workspaceLane: value.workspaceLane },
        entityType: 'lane_judgment',
        execute: (commandDatabase, v) => ({ data: applyLaneGateBatch(commandDatabase, v, { transaction: false }) })
      }));
    } else {
      applyLaneGateBatch(dependency, value);
    }
  };
  try {
    await doDispatch(input, requestId);
    return { unresolved: false, unresolvedIds: [] };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 'REVISION_CONFLICT') throw error;
    return { unresolved: true, unresolvedIds: input.judgments.map((j) => j.sourceId) };
  }
}

/**
 * 应用一轮判定门（设计 §3.1/§5）：
 * 1. Tier 1：解析模型赛道判定块（第一个 ```json 块）；待判清单缺失/重复/非法 → 抛错 → 整轮 fail-closed。
 * 2. 先写 Tier 0 系统行（judged_by=system / official_source），再写 Tier 1 编辑行
 *    （irrelevant → archived + 流水行，同一 dispatcher 事务，任一失败整批回滚零写）。
 * 3. 返回有效资料 id 集合（Tier 0 自动相关 + Tier 1 判相关），供四问方案引用过滤。
 * 解析失败发生在任何写入之前 → 零归档、水印不推进（由调用方 catch 处理）。
 */
export async function applyDailyLaneGate(
  dependency: AgentTaskMutationDependency,
  task: AgentTask,
  gateRun: DailyGateRun,
  sessionText: string,
  planRequestId: string,
  judgedAt: string,
  workerLeaseId?: string
): Promise<DailyLaneGateApplied> {
  if (gateRun.lane === null) return { relevantIds: new Set<string>(), archivedCount: 0, unresolved: false, unresolvedIds: new Set<string>() };
  const database = 'database' in dependency ? dependency.database : dependency;
  const autoRelevantIds = gateRun.autoRelevant.map((candidate) => candidate.sourceId);
  if (gateRun.pending.length === 0) {
    const tier0 = await writeLaneGateBatch(dependency, task, {
      workspaceLane: gateRun.lane, judgedBy: 'system', judgedAt,
      judgments: gateRun.autoRelevant.map((candidate) => gateJudgmentInput(database, candidate, 'relevant', LANE_TIER0_REASON_CODE))
    }, `${planRequestId}:gate-tier0`, workerLeaseId);
    return { relevantIds: new Set(autoRelevantIds), archivedCount: 0, unresolved: tier0.unresolved, unresolvedIds: new Set(tier0.unresolvedIds) };
  }
  const gate = parseLaneGateOutput(sessionText);
  const pendingById = new Map<string, LaneGateCandidate>(gateRun.pending.map((candidate) => [candidate.sourceId, candidate]));
  const judgedIds = new Set<string>();
  const accepted: LaneGateOutputEntry[] = [];
  for (const entry of gate.gate) {
    if (!pendingById.has(entry.sourceId)) continue;
    if (judgedIds.has(entry.sourceId)) continue;
    judgedIds.add(entry.sourceId);
    accepted.push(entry);
  }
  for (const candidate of gateRun.pending) {
    if (judgedIds.has(candidate.sourceId)) continue;
    accepted.push({ sourceId: candidate.sourceId, relevant: true, reasonCode: 'lane_relevant', reason: '模型未显式判定，系统默认保留为相关' });
    judgedIds.add(candidate.sourceId);
  }
  const relevantIds = new Set<string>(autoRelevantIds);
  let archivedCount = 0;
  const agentJudgments = accepted.map((entry) => {
    const candidate = pendingById.get(entry.sourceId)!;
    const relevant = entry.relevant;
    if (relevant) relevantIds.add(entry.sourceId);
    else archivedCount += 1;
    return gateJudgmentInput(database, candidate, relevant ? 'relevant' : 'irrelevant', (entry.reasonCode ?? 'lane_relevant') as LaneReasonCode, entry.reason);
  });
  const tier0 = await writeLaneGateBatch(dependency, task, {
    workspaceLane: gateRun.lane, judgedBy: 'system', judgedAt,
    judgments: gateRun.autoRelevant.map((candidate) => gateJudgmentInput(database, candidate, 'relevant', LANE_TIER0_REASON_CODE))
  }, `${planRequestId}:gate-tier0`, workerLeaseId);
  const tier1 = await writeLaneGateBatch(dependency, task, {
    workspaceLane: gateRun.lane, judgedBy: 'agent', judgedAt,
    judgments: agentJudgments
  }, `${planRequestId}:gate-tier1`, workerLeaseId);
  const unresolved = tier0.unresolved || tier1.unresolved;
  const unresolvedIds = new Set<string>([...tier0.unresolvedIds, ...tier1.unresolvedIds]);
  if (unresolved) {
    for (const id of unresolvedIds) relevantIds.delete(id);
  }
  return { relevantIds, archivedCount: unresolved ? 0 : archivedCount, unresolved, unresolvedIds };
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
    const contextRefs = { planDate: input.businessDate, roleId: 'planner' as const };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, {
      intent: 'daily_judge', roleId: 'planner', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath
    });
    if (prerequisite.waiting) return prerequisite.waiting;
    const policySnapshot = prerequisite.policySnapshot;
    const taskContextRefs = { ...contextRefs, modelPolicySnapshot: policySnapshot };
    const existing = getActiveDailyIntelligenceTask(database, input.businessDate);
    let started: { task: AgentTask; reused: boolean };
    if (existing && (existing.phase === 'channel_scanned' || existing.phase === 'resume_pending' || existing.intent === 'daily_judge')) {
      const rebound = await dispatchUpdateAgentTaskPhase(
        dependency,
        existing.id,
        existing.phase,
        {
          intent: existing.intent === 'daily_judge' ? undefined : 'daily_judge',
          contextRefs: { ...existing.contextRefs, ...taskContextRefs, modelPolicySnapshot: readTaskModelPolicySnapshot(existing, 'planner') ?? policySnapshot }
        },
        taskCommandContext(lane, `${existing.id}:rebind-judge:${randomUUID()}`, existing.id, input.workerLeaseId, { requestId: startRequestId })
      );
      started = { task: rebound, reused: true };
    } else {
      started = await dispatchStartAgentTask(dependency, { intent: 'daily_judge', businessDate: input.businessDate, contextRefs: taskContextRefs }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    }
    const task = started.task;
    const taskPolicySnapshot = readTaskModelPolicySnapshot(task, 'planner') ?? policySnapshot;
    if (started.reused && !['resume_pending', 'starting', 'channel_scanned'].includes(task.phase)) return { task, reused: true };
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    const piSessionId = dailyAgentSessionId(input.businessDate, task.id);
    await dispatchUpdateAgentTaskPhase(dependency, task.id, task.phase, { piSessionId }, taskCommandContext(lane, `${task.id}:phase:session:${piSessionId}`, task.id, input.workerLeaseId, { requestId: startRequestId }));

    const layout = await ensurePiConversationLayout(input.dataRootPath);
    await prepareSkillDir(layout.agentDir);
    const extensionPath = await preparePiExtension(layout.agentDir);
    await dispatchReportAgentTaskProgress(dependency, task.id, {
      phase: task.phase === 'resume_pending' ? 'resuming' : 'judging_opportunities',
      message: task.phase === 'resume_pending' ? '已从持久检查点恢复任务。' : '正在根据已扫描来源判断内容机会。'
    }, taskCommandContext(lane, `${task.id}:progress:judging:${randomUUID()}`, task.id, input.workerLeaseId, { requestId: startRequestId }));

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-daily-'));
    const dailySessionFile = path.join(layout.agentDir, 'sessions', `${piSessionId}.jsonl`);
    await mkdir(path.dirname(dailySessionFile), { recursive: true });
    const createRuntime = async (nextConfig: ResolvedPiConfig) => {
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(await piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
      const runtime = new PiRpcSupervisor(process.execPath, [
        await piCliPath(input.dataRootPath), '--mode', 'rpc', '--session', dailySessionFile,
        '--skill', path.join(layout.agentDir, 'skills', 'wemedia-intelligence-engine'), '-e', extensionPath,
        '--provider', 'wmb-api', '--model', nextConfig.model,
        '--append-system-prompt', piTaskAuthorityPrompt({ taskId: task.id, grantId, workerLeaseId: input.workerLeaseId })
      ], {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PI_CODING_AGENT_DIR: layout.agentDir,
        WMB_PI_API_KEY: nextConfig.apiKey,
        WMB_MCP_URL: input.mcpUrl,
        WMB_XHS_MCP_URL: input.xhsMcpUrl || '',
        ...proxyEnvForChildren()
      }, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
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
        if (!current || current.status !== 'running') return;
        const decision = dailyControlWatchdogDecision(current);
        if (decision) {
          void abortDailyIntelligence(current.id);
          void dispatchFinishDailyIntelligence(dependency, current.id, {
            forcePartial: true,
            errorCode: decision.code,
            errorMessage: decision.message
          }, taskCommandContext(lane, `${current.id}:finish:${decision.reason}`, current.id, input.workerLeaseId))
            .then((updated) => input.onEvent?.({ type: 'agent_task', task: updated }))
            .catch(() => {});
          return;
        }
        void dispatchReportAgentTaskProgress(dependency, current.id, {}, taskCommandContext(lane, `${current.id}:progress:heartbeat:${current.updatedAt}`, current.id, input.workerLeaseId))
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
        await dispatchReportAgentTaskProgress(dependency, beforePlan.id, { phase: 'synthesizing', message: '共享来源扫描结束，正在整理内容机会。' }, taskCommandContext(lane, `${beforePlan.id}:progress:synthesizing:${randomUUID()}`, beforePlan.id, input.workerLeaseId));
        // 发酵池刷新是写操作：生产运行时走 dispatcher（判断简报本身只读）；裸数据库（测试）直写。
        if ('database' in dependency) {
          requireReceiptData(await dispatchBusinessCommand(dependency, {
            command: 'daily.refresh_carry',
            requestId: `${beforePlan.id}:refresh-carry`,
            actor: schedulerActor(lane),
            taskId: beforePlan.id,
            workerLeaseId: input.workerLeaseId,
            input: { planDate: beforePlan.businessDate },
            boundIdentity: { entityType: 'work_carry' },
            entityType: 'work_carry',
            execute: (commandDatabase, value) => ({ data: refreshWorkCarry(commandDatabase, value.planDate) })
          }));
        } else {
          refreshWorkCarry(dependency, beforePlan.businessDate);
        }
        const startedRuntime = await startPiRuntimeWithFallback({
          roleId: 'planner',
          policySnapshot: taskPolicySnapshot,
          taskId: beforePlan.id,
          piConfigPath: input.piConfigPath,
          createRuntime,
          onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>)
        });
        let synthesis = startedRuntime.runtime;
        let activeConfig = startedRuntime.config;
        activeDailyRuntimes.set(beforePlan.id, synthesis);
        try {
          const planRequestId = agentRequestId(beforePlan.id, 'plan');
          const sessionBaseline = await readFile(dailySessionFile, 'utf8').then((text) => text.split(/\r?\n/).length).catch(() => 0);
          const planningTask = getAgentTask(database, beforePlan.id) ?? beforePlan;
          const prompted = await runPiPromptWithFallback({
            roleId: 'planner',
            policySnapshot: taskPolicySnapshot,
            taskId: beforePlan.id,
            piConfigPath: input.piConfigPath,
            initial: { runtime: synthesis, config: activeConfig },
            createRuntime,
            onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>),
            onRuntimeChanged: (runtime, nextConfig) => {
              synthesis = runtime;
              activeConfig = nextConfig;
              activeDailyRuntimes.set(beforePlan.id, runtime);
              input.onRuntime?.(runtime);
            },
            run: async (runtime) => {
              await runtime.promptUntilSettled(
                buildDailyOpportunityPrompt(database, planningTask, planRequestId),
                { timeoutMs: 10 * 60_000 }
              );
            }
          });
          synthesis = prompted.runtime;
          activeConfig = prompted.config;
          const saved = await savePlanFromSynthesisOutput(
            dependency,
            planningTask,
            dailySessionFile,
            planRequestId,
            input.workerLeaseId,
            grantId,
            sessionBaseline
          );
          await dispatchReportAgentTaskProgress(dependency, beforePlan.id, {
            message: saved.itemCount > 0 ? `已生成 ${saved.itemCount} 个选题。` : '今天没有生成选题。',
            checkpoint: { judgeWatermark: new Date().toISOString() }
          }, taskCommandContext(lane, `${beforePlan.id}:progress:plan-saved`, beforePlan.id, input.workerLeaseId));
        } catch (error) {
          const latest = getAgentTask(database, beforePlan.id) ?? beforePlan;
          const cancelled = await cancelIfRequested(latest);
          if (cancelled) return { task: cancelled, reused: started.reused };
          if (latest.controlAction === 'save_partial' || latest.status !== 'running') {
            if (latest.status === 'running' && latest.controlAction === 'save_partial') {
              const partial = await dispatchPartialAgentTask(dependency, latest.id, taskCommandContext(lane, `${latest.id}:partial:after-abort`, latest.id, input.workerLeaseId));
              return { task: partial, reused: started.reused };
            }
            return { task: latest, reused: started.reused };
          }
          const message = error instanceof Error ? error.message : String(error);
          await dispatchReportAgentTaskProgress(dependency, latest.id, { phase: 'synthesis_failed', message: `综合整理失败，保留已扫描结果：${message.slice(0, 180)}`, level: 'warning' }, taskCommandContext(lane, `${latest.id}:progress:synthesis-failed:${randomUUID()}`, latest.id, input.workerLeaseId));
          const partial = await dispatchFinishDailyIntelligence(dependency, latest.id, { forcePartial: true, errorCode: 'DAILY_INTELLIGENCE_FAILED', errorMessage: message }, taskCommandContext(lane, `${latest.id}:finish:synthesis-failed`, latest.id, input.workerLeaseId));
          return { task: partial, reused: started.reused };
        } finally {
          activeDailyRuntimes.delete(beforePlan.id);
          await synthesis.stop().catch(() => {});
        }
      } finally { clearInterval(heartbeat); }

      const afterRun = getAgentTask(database, task.id);
      // 控制路径可能已同步写终态；禁止 runner 再覆盖。
      if (afterRun && afterRun.status !== 'running') return { task: afterRun, reused: started.reused };
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
        await dispatchReportAgentTaskProgress(dependency, task.id, { phase: 'validating', message: `完成校验未完全通过，尝试保留结果：${message}`, level: 'warning' }, taskCommandContext(lane, `${task.id}:progress:validation-failed:${randomUUID()}`, task.id, input.workerLeaseId));
        const partial = await dispatchFinishDailyIntelligence(dependency, task.id, { forcePartial: true, errorCode: code, errorMessage: message }, taskCommandContext(lane, `${task.id}:finish:validation-failed`, task.id, input.workerLeaseId));
        return { task: partial, reused: started.reused };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, task.id);
      const cancelled = await cancelIfRequested(current);
      if (cancelled) return { task: cancelled, reused: started.reused };
      const modelFailure = roleModelNeedsUserFailure(error);
      if (current?.status === 'running' && modelFailure) {
        const waiting = await dispatchNeedsUserAgentTask(dependency, task.id, modelFailure.code, modelFailure.message, taskCommandContext(lane, `${task.id}:needs-user:model`, task.id, input.workerLeaseId));
        return { task: waiting, reused: started.reused };
      }
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

export function shouldRunCreationExperiment(database: DatabaseSync): boolean {
  const existing = database.prepare(`SELECT 1 FROM agent_tasks
    WHERE intent = 'studio_draft' AND json_extract(context_refs_json, '$.creationExperiment') = 1 LIMIT 1`).get();
  return !existing;
}

export function claimCreationExperiment(database: DatabaseSync, taskId: string): boolean {
  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = database.prepare(`SELECT 1 FROM agent_tasks
      WHERE intent = 'studio_draft' AND id != ? AND json_extract(context_refs_json, '$.creationExperiment') = 1 LIMIT 1`).get(taskId);
    if (existing) {
      database.exec('COMMIT');
      return false;
    }
    const updated = database.prepare(`UPDATE agent_tasks
      SET context_refs_json = json_set(context_refs_json, '$.creationExperiment', json('true'))
      WHERE id = ? AND intent = 'studio_draft' AND json_extract(context_refs_json, '$.writerTask') = 'core_draft'`).run(taskId);
    database.exec('COMMIT');
    return Number(updated.changes) === 1;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function draftPrompt(
  task: AgentTask,
  projectId: string,
  requestId: string,
  writerTask: WriterTask = 'core_draft',
  brief = '',
  _researchReady = false,
  _researchMode: 'auto' | 'required' | 'prohibited' = 'auto',
  creationExperiment = false
): string {
  if (writerTask === 'xiaohongshu_platform_version') {
    return [
      '把这个内容项目改写成完整的小红书版本。',
      `task_id=${task.id}`,
      `project_id=${projectId}`,
      `request_id=${requestId}`,
      `brief=${brief}`,
      `先调用 wmb_get_content({ projectId: "${projectId}" }) 读取最新正文，再调用 wmb_save_platform_version 保存小红书版本。不要发布。`
    ].join('\n');
  }
  if (writerTask === 'video_script') {
    return [
      '把这个内容项目改写成完整的视频口播稿。',
      `task_id=${task.id}`,
      `project_id=${projectId}`,
      `request_id=${requestId}`,
      `brief=${brief}`,
      `先调用 wmb_get_content({ projectId: "${projectId}" }) 读取最新正文，再调用 wmb_save_video_script 保存口播稿。不要发布。`
    ].join('\n');
  }
  if (!creationExperiment) {
    return [
      '根据这个选题直接写一篇完整、自然、可编辑的中文文章。',
      `task_id=${task.id}`,
      `project_id=${projectId}`,
      `request_id=${requestId}`,
      `brief=${brief}`,
      `先调用 wmb_get_content({ projectId: "${projectId}" }) 读取选题、调查结论和关联资讯。`,
      '围绕选题的核心观点完成标题和正文；不要再派任务，不要启动其他流程。',
      `完成后调用 wmb_save_core_version，requestId 使用 ${requestId}，projectId 使用 ${projectId}，expectedRevision 使用读取到的项目 revision。`,
      '保存后结束。不要发布。'
    ].join('\n');
  }
  return [
    '根据这个选题写一篇完整、自然、可编辑的中文文章。正文前必须先完成一次语义方向实验。',
    `task_id=${task.id}`,
    `project_id=${projectId}`,
    `request_id=${requestId}`,
    `brief=${brief}`,
    `先调用 wmb_get_content({ projectId: "${projectId}" }) 读取选题、调查结论和关联资讯。`,
    '基于同一份证据提出 2-4 个有实质差异的语义方向；每个方向给出 id、至少 10 字的 semanticDirection，以及 0-100 整数分 evidenceFit、insightNovelty、audienceValue。',
    '按证据贴合 45%、洞察新意 30%、读者价值 25% 选择加权分最高的方向；不要选择较低分方向。',
    `写正文前先调用 wmb_report_agent_progress，requestId 使用 ${requestId}:experiment，phase 使用 experiment_complete，checkpoint 只需包含 {"creationExperiment":{"version":"v1","projectId":"${projectId}","variants":[...],"selectedVariantId":"..."}}。系统会计算加权分、领先分和定量结论并持久化。`,
    '只有实验写入成功后，才围绕胜出方向完成标题和正文；不要再派任务，不要启动其他流程。',
    `完成后调用 wmb_save_core_version，requestId 使用 ${requestId}，projectId 使用 ${projectId}，expectedRevision 使用读取到的项目 revision。`,
    '保存后结束。不要发布。'
  ].join('\n');
}

export async function startStudioDraft(input: {
  dataRootPath: string; businessDate: string; piConfigPath?: string; projectId: string; mcpUrl: string;
  writerTask?: WriterTask;
  brief?: string;
  researchReady?: boolean;
  researchMode?: 'auto' | 'required' | 'prohibited';
  xhsMcpUrl?: string | null; onEvent?: (event: Record<string, unknown>) => void; onRuntime?: (runtime: PiRpcSupervisor) => void;
  workerLeaseId?: string; activeRuntime?: ActiveWorkspaceRuntime;
  onTaskReady?: TaskReadyGrantHook;
  /** 员工会话隔离：不传则用确定性 per-task 员工会话（studio-<taskId>.jsonl，与 Dock 会话同目录）；显式传入始终优先 */
  sessionFile?: string;
  /** WMB-5116：JobPool 新工单传入每 job 唯一 start request identity（如 `${jobId}:studio-draft:start`），
   *  避免同 date/project 新工单与既有工单共享确定性 identity 触发 REQUEST_REPLAY_CONFLICT。
   *  direct Studio 调用不传，保持确定性默认值以幂等重放同请求。 */
  startRequestId?: string;
}): Promise<DailyIntelligenceRun> {
  const writerTask = input.writerTask ?? 'core_draft';
  const { dependency, database, close } = mutationDependency(input);
  const lane = 'studio-draft';
  const startRequestId = input.startRequestId ?? `studio_draft:${input.businessDate}:${input.projectId}:${randomUUID()}`;
  try {
    const contextRefs = {
      roleId: 'writer' as const,
      projectId: input.projectId,
      writerTask,
      researchMode: 'prohibited' as const,
      creationExperiment: false
    };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, {
      intent: 'studio_draft', roleId: 'writer', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath
    });
    if (prerequisite.waiting) return prerequisite.waiting;
    const policySnapshot = prerequisite.policySnapshot;
    const taskContextRefs = { ...contextRefs, modelPolicySnapshot: policySnapshot };
    const started = await dispatchStartAgentTask(dependency, { intent: 'studio_draft', businessDate: input.businessDate, contextRefs: taskContextRefs }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    if (started.reused) return { task: started.task, reused: true };
    const task = started.task;
    const creationExperiment = writerTask === 'core_draft' && claimCreationExperiment(database, task.id);
    const taskPolicySnapshot = readTaskModelPolicySnapshot(task, 'writer') ?? policySnapshot;
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    const extensionPath = await preparePiExtension(layout.agentDir);
    const requestId = agentRequestId(task.id, writerTask === 'core_draft' ? 'core_version' : 'xiaohongshu_platform_version');
    const piSessionId = `studio-${task.id}`;
    await dispatchUpdateAgentTaskPhase(dependency, task.id, 'running_pi', { piSessionId }, taskCommandContext(lane, `${task.id}:phase:running-pi`, task.id, input.workerLeaseId, { requestId: startRequestId }));
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-draft-'));
    const createRuntime = async (nextConfig: ResolvedPiConfig) => {
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(await piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
      const runtime = new PiRpcSupervisor(process.execPath, [
        await piCliPath(input.dataRootPath), '--mode', 'rpc', '--session', (input.sessionFile || path.join(path.dirname(layout.sessionFile), `${piSessionId}.jsonl`)), '-e', extensionPath,
        '--provider', 'wmb-api', '--model', nextConfig.model, '--append-system-prompt', piTaskAuthorityPrompt({ taskId: task.id, grantId, workerLeaseId: input.workerLeaseId })
      ], {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PI_CODING_AGENT_DIR: layout.agentDir,
        WMB_PI_API_KEY: nextConfig.apiKey,
        WMB_MCP_URL: input.mcpUrl,
        WMB_XHS_MCP_URL: input.xhsMcpUrl || '',
        ...proxyEnvForChildren()
      }, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
      input.onRuntime?.(runtime);
      return runtime;
    };
    let runtime: PiRpcSupervisor | null = null;
    try {
      const startedRuntime = await startPiRuntimeWithFallback({
        roleId: 'writer',
        policySnapshot: taskPolicySnapshot,
        taskId: task.id,
        piConfigPath: input.piConfigPath,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>)
      });
      runtime = startedRuntime.runtime;
      await runPiPromptWithFallback({
        roleId: 'writer',
        policySnapshot: taskPolicySnapshot,
        taskId: task.id,
        piConfigPath: input.piConfigPath,
        initial: startedRuntime,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>),
        onRuntimeChanged: (nextRuntime) => {
          runtime = nextRuntime;
          input.onRuntime?.(nextRuntime);
        },
        run: async (activeRuntime) => {
          await activeRuntime.promptUntilSettled(
            draftPrompt(task, input.projectId, requestId, writerTask, input.brief ?? '', true, 'prohibited', creationExperiment),
            { timeoutMs: piPromptTimeoutMs() }
          );
        }
      });
      const afterPrompt = getAgentTask(database, task.id);
      // research.dispatch 成功会把当前父任务置为 partial；禁止继续 validating/complete 覆盖交接真相。
      if (afterPrompt && afterPrompt.status !== 'running') return { task: afterPrompt, reused: false };
      await dispatchUpdateAgentTaskPhase(dependency, task.id, 'validating', {}, taskCommandContext(lane, `${task.id}:phase:validating`, task.id, input.workerLeaseId));
      const completed = await dispatchCompleteAgentTask(dependency, task.id, taskCommandContext(lane, `${task.id}:complete`, task.id, input.workerLeaseId));
      return { task: completed, reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, task.id);
      const modelFailure = roleModelNeedsUserFailure(error);
      if (current?.status === 'running' && modelFailure) {
        const waiting = await dispatchNeedsUserAgentTask(dependency, task.id, modelFailure.code, modelFailure.message, taskCommandContext(lane, `${task.id}:needs-user:model`, task.id, input.workerLeaseId));
        return { task: waiting, reused: false };
      }
      if (current?.status === 'running') await dispatchFailAgentTask(dependency, task.id, 'STUDIO_DRAFT_FAILED', message, taskCommandContext(lane, `${task.id}:fail`, task.id, input.workerLeaseId));
      throw error;
    } finally {
      await runtime?.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { close(); }
}

export function reviewPrompt(task: AgentTask, publicationId: string, requestId: string): string {
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
  /** 员工会话隔离：不传则回退 dock session（不推荐） */
  sessionFile?: string;
  onTaskReady?: TaskReadyGrantHook;
}): Promise<DailyIntelligenceRun> {
  const { dependency, database, close } = mutationDependency(input);
  const lane = 'results-review';
  const startRequestId = `results_review:${input.businessDate}:${input.publicationId}:start`;
  try {
    const contextRefs = { roleId: 'planner' as const, publicationId: input.publicationId };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, {
      intent: 'results_review', roleId: 'planner', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath
    });
    if (prerequisite.waiting) return prerequisite.waiting;
    const policySnapshot = prerequisite.policySnapshot;
    const taskContextRefs = { ...contextRefs, modelPolicySnapshot: policySnapshot };
    const conversation = await readPiConversation(input.dataRootPath);
    const started = await dispatchStartAgentTask(dependency, { intent: 'results_review', businessDate: input.businessDate, contextRefs: taskContextRefs, piSessionId: conversation.sessionId }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    if (started.reused) return { task: started.task, reused: true };
    const task = started.task;
    const taskPolicySnapshot = readTaskModelPolicySnapshot(task, 'planner') ?? policySnapshot;
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    const extensionPath = await preparePiExtension(layout.agentDir);
    const requestId = agentRequestId(task.id, 'review');
    await dispatchUpdateAgentTaskPhase(dependency, task.id, 'running_pi', { piSessionId: conversation.sessionId }, taskCommandContext(lane, `${task.id}:phase:running-pi`, task.id, input.workerLeaseId, { requestId: startRequestId }));
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-review-'));
    const createRuntime = async (nextConfig: ResolvedPiConfig) => {
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(await piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
      const runtime = new PiRpcSupervisor(process.execPath, [
        await piCliPath(input.dataRootPath), '--mode', 'rpc', '--session', (input.sessionFile || path.join(path.dirname(layout.sessionFile), `results-${task.id}.jsonl`)), '-e', extensionPath,
        '--provider', 'wmb-api', '--model', nextConfig.model, '--append-system-prompt', piTaskAuthorityPrompt({ taskId: task.id, grantId, workerLeaseId: input.workerLeaseId })
      ], {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PI_CODING_AGENT_DIR: layout.agentDir,
        WMB_PI_API_KEY: nextConfig.apiKey,
        WMB_XHS_MCP_URL: input.xhsMcpUrl || '',
        ...proxyEnvForChildren()
      }, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
      input.onRuntime?.(runtime);
      return runtime;
    };
    let runtime: PiRpcSupervisor | null = null;
    try {
      const startedRuntime = await startPiRuntimeWithFallback({
        roleId: 'planner',
        policySnapshot: taskPolicySnapshot,
        taskId: task.id,
        piConfigPath: input.piConfigPath,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>)
      });
      runtime = startedRuntime.runtime;
      await runPiPromptWithFallback({
        roleId: 'planner',
        policySnapshot: taskPolicySnapshot,
        taskId: task.id,
        piConfigPath: input.piConfigPath,
        initial: startedRuntime,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>),
        onRuntimeChanged: (nextRuntime) => {
          runtime = nextRuntime;
          input.onRuntime?.(nextRuntime);
        },
        run: async (activeRuntime) => {
          // WMB-5178 §5：员工接收会话盖章（Results 复盘，target=employee，Dock 永不镜像）。
          await activeRuntime.promptUntilSettled(buildOrchestrationEnvelope({ dispatchId: `results_review:${task.id}`, target: 'employee', delivery: 'direct', safe: { originLabel: 'Results 复盘', title: '周期复盘', goal: '基于真实指标给出 Keep/Stop/Change 与方法结论', acceptance: 'final 复盘读回' }, prompt: reviewPrompt(task, input.publicationId, requestId) }), { timeoutMs: piPromptTimeoutMs() });
        }
      });
      await dispatchUpdateAgentTaskPhase(dependency, task.id, 'validating', {}, taskCommandContext(lane, `${task.id}:phase:validating`, task.id, input.workerLeaseId));
      const completed = await dispatchCompleteAgentTask(dependency, task.id, taskCommandContext(lane, `${task.id}:complete`, task.id, input.workerLeaseId));
      return { task: completed, reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, task.id);
      const modelFailure = roleModelNeedsUserFailure(error);
      if (current?.status === 'running' && modelFailure) {
        const waiting = await dispatchNeedsUserAgentTask(dependency, task.id, modelFailure.code, modelFailure.message, taskCommandContext(lane, `${task.id}:needs-user:model`, task.id, input.workerLeaseId));
        return { task: waiting, reused: false };
      }
      if (current?.status === 'running') await dispatchFailAgentTask(dependency, task.id, 'RESULTS_REVIEW_FAILED', message, taskCommandContext(lane, `${task.id}:fail`, task.id, input.workerLeaseId));
      throw error;
    } finally {
      await runtime?.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { close(); }
}
