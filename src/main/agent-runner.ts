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
import { saveCurrentPlan } from './planning.ts';
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
  title: z.string().min(1).refine((title) => !title.includes('普通人'), {
    message: '标题不得把受众身份词「普通人」写进发布标题；请改用题材的具体对象、问题、动作或证据'
  }),
  priority: z.number().int().min(0).max(7),
  whyNow: z.string().min(1),
  timeliness: z.string().min(1),
  targetAudience: z.string().min(1),
  angle: z.string().min(1),
  pointOfView: z.string().min(1),
  platforms: z.array(z.string()).min(1),
  formats: z.array(z.string()).min(1),
  titleGuidance: z.string(),
  openingGuidance: z.string(),
  structureGuidance: z.string(),
  effortEstimate: z.string(),
  sourceIds: z.array(z.string().min(1)).min(1),
  availableMaterials: z.array(z.string()).optional(),
  missingMaterials: z.array(z.string()).optional(),
  topicId: z.preprocess((value) => value === null ? undefined : value, z.string().optional()),
  reviewIds: z.array(z.string()).optional(),
  methodFindingIds: z.array(z.string()).optional(),
  editorialDecision: editorialDecisionSchema,
  scoreReasons: scoreReasonsSchema
});
const planSourceDecisionSchema = z.object({
  sourceId: z.string().min(1),
  sourceRevision: z.number().int().min(1).optional(),
  decision: z.enum(['selected', 'excluded', 'unresolved', 'blocked']),
  reasonCode: z.string().min(1),
  reason: z.string().min(1)
});
const planOutputSchema = z.object({
  planDate: z.string().optional(),
  summary: z.string().min(1),
  items: z.array(planOutputItemSchema).max(12),
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
  return {
    ...parsed.data,
    items: parsed.data.items.map((item) => ({
      ...item,
      pointOfView: item.editorialDecision.winnerThesis,
    })),
  };
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
export async function savePlanFromSynthesisOutput(
  dependency: AgentTaskMutationDependency,
  task: AgentTask,
  sessionFile: string,
  planRequestId: string,
  workerLeaseId?: string,
  grantId?: string | null,
  sessionBaseline = 0,
  /** 有效资料 id 白名单（赛道门通过后）：引用白名单外 sourceId 的方案项被丢弃（四问只跑在有效资料上）。 */
  allowedSourceIds?: ReadonlySet<string>,
  /** 本轮必须逐条留下编辑决策的冻结候选（增量 + reactivated evidence）。 */
  candidateSourceIds?: ReadonlySet<string>
): Promise<{ itemCount: number; filteredCount: number }> {
  const plan = parseDailyPlanOutput(readAssistantTexts(await readFile(sessionFile, 'utf8'), sessionBaseline).join('\n'));
  const items = allowedSourceIds
    ? plan.items.filter((item) => item.sourceIds.every((id) => allowedSourceIds.has(id)))
    : plan.items;
  // 空方案不得覆盖同日已有非空 current plan（弱模型漏输出 / 全被赛道门过滤时保底）。
  if (items.length === 0) {
    const db = 'database' in dependency ? dependency.database : dependency;
    const existing = getToday(db, task.businessDate).plan;
    if (existing && existing.items.length > 0) {
      return { itemCount: existing.items.length, filteredCount: plan.items.length };
    }
  }
  let candidateSources: Array<{ sourceId: string; sourceRevision: number }> | undefined;
  let sourceDecisions = plan.sourceDecisions ?? [];
  if (candidateSourceIds) {
    const ids = [...candidateSourceIds].sort();
    const db = 'database' in dependency ? dependency.database : dependency;
    const rows = ids.length ? db.prepare(`SELECT id,revision FROM source_items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; revision: number }> : [];
    const revisions = new Map(rows.map((row) => [row.id, row.revision]));
    candidateSources = ids.map((sourceId) => {
      const sourceRevision = revisions.get(sourceId);
      if (!sourceRevision) throw new Error(`PLAN_SOURCE_CANDIDATE_NOT_FOUND:${sourceId}`);
      return { sourceId, sourceRevision };
    });
    const selectedIds = new Set(items.flatMap((item) => item.sourceIds));
    const modelDecisions = new Map(sourceDecisions.map((decision) => [decision.sourceId, decision]));
    sourceDecisions = candidateSources.map(({ sourceId, sourceRevision }) => {
      const modelDecision = modelDecisions.get(sourceId);
      if (selectedIds.has(sourceId)) {
        return {
          sourceId, sourceRevision, decision: 'selected' as const,
          reasonCode: modelDecision?.decision === 'selected' ? modelDecision.reasonCode : 'selected_by_plan_item',
          reason: modelDecision?.decision === 'selected' ? modelDecision.reason : '该资料被保留方案项直接引用。',
        };
      }
      if (modelDecision && modelDecision.decision !== 'selected') return { ...modelDecision, sourceRevision };
      return {
        sourceId, sourceRevision, decision: 'excluded' as const,
        reasonCode: modelDecision ? 'filtered_by_lane_gate' : 'not_selected',
        reason: modelDecision ? '该资料对应的方案项未通过本轮赛道白名单。' : '本轮方案未引用该冻结候选资料。',
      };
    });
  }
  const input = {
    planDate: task.businessDate, timezone: 'Asia/Shanghai', summary: plan.summary, items,
    ...(candidateSources ? { candidateSources, sourceDecisions } : {})
  };
  const derivedRequestId = planDispatchRequestId(planRequestId, input);
  if ('database' in dependency) {
    requireReceiptData(await dispatchBusinessCommand(dependency, {
      command: 'plans.save',
      requestId: derivedRequestId,
      actor: { type: 'pi', id: 'pi', label: 'Pi worker' },
      taskId: task.id,
      workerLeaseId,
      grantId: grantId ?? undefined,
      input,
      boundIdentity: { planDate: task.businessDate },
      entityType: 'plan',
      execute: (commandDatabase, value) => {
        const data = saveCurrentPlan(commandDatabase, value, false);
        return { data, entityId: data.id, afterRevision: data.revision, readback: data };
      }
    }));
    wakePersistentKnowledgeJobs();
  } else {
    const saved = saveCurrentPlan(dependency, input);
    dependency.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)')
      .run('plans.save', derivedRequestId, JSON.stringify(saved), new Date().toISOString());
  }
  return { itemCount: items.length, filteredCount: plan.items.length - items.length };
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

function dailyPrompt(task: AgentTask, planRequestId: string, briefText: string, options: { nativeSearch?: boolean; gate?: { autoRelevantIds: string[]; pendingIds: string[] } | null } = {}): string {
  const deepDiveRule = options.nativeSearch
    ? '5. 对四问证据不足的候选，可用模型自带的联网搜索补充证据；搜索发现的材料必须先用 wmb_save_source 带原始 URL 入库，之后才能作为 sourceIds 写入方案。'
    : '5. 当前模型未开启自带搜索：证据不足的候选降权或丢弃，不得臆造来源。';
  const modelReasonCodes = (LANE_REASON_CODES as readonly string[]).filter((code) => code !== 'official_source' && code !== 'editor_override' && code !== 'lane_relevant');
  const gateSection = options.gate
    ? [
        '',
        '■ 第一关：赛道相关性判定（资料门，必须先做这一关）',
        `以下 ${options.gate.autoRelevantIds.length} 条增量资料已由系统按官方信源规则判定为赛道相关（Tier 0，无需你判定，四问可直接使用）：${options.gate.autoRelevantIds.join('、')}`,
        `其余 ${options.gate.pendingIds.length} 条增量资料必须逐条判定赛道相关性：是当前赛道（「身份」块：服务「正在寻找 AI 商业化方向、愿意完成真实项目并获取反馈的人」的方向与真实项目素材，五维=时代认知/个人方向/AI 实践/公开验证/产品化）的有效素材 → relevant:true；不是 → relevant:false + reasonCode + 一句话 reason。纯模型公告、对目标读者没有可执行意义的参数/价格新闻、泛泛的书籍摘抄、励志口号、无法验证的收入承诺 → irrelevant。reasonCode 只能从以下选择：${modelReasonCodes.join(' / ')}。`,
        '先输出赛道判定 JSON 块（每条待判资料都必须出现且只出现一次，缺失或重复任何一条整轮失败）：',
        '```json',
        '{ "gate": [{ "sourceId": "简报「增量」块中的真实 id", "relevant": true }, { "sourceId": "…", "relevant": false, "reasonCode": "lifestyle_noise", "reason": "一句话原因" }] }',
        '```'
      ]
    : [];
  const closingLine = options.gate
    ? '6. 输出顺序：先输出上面的赛道判定 ```json 块，再输出方案 ```json 块。方案块结构必须严格如下（sourceIds 只能从简报「增量」块选择真实 id，且只能引用你判 relevant 或系统已判相关的 id；不要输出其它任何文字）：'
    : '6. 收尾只输出一个 ```json 代码块，结构必须严格如下（sourceIds 只能从简报「增量」块选择真实 id；不要输出其它任何文字）：';
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
    ...gateSection,
    '',
    '判断要求：',
    '1. 先读简报「身份」块对齐受众、内容目标与编辑简报；身份默认对齐「AI × 商业化成长」。目标读者=正在寻找 AI 商业化方向、愿意完成真实项目并获取反馈的人：内容帮他们从迷茫走向明确方向、完成第一个真实项目并拿到真实反馈，绝不承诺收入。受众描述只用于内部判断，不是标题素材。脱离身份的泛 AI 资讯、纯模型公告、对目标读者没有可执行意义的参数/价格新闻、泛泛的书籍摘抄、励志口号、无法验证的收入承诺直接丢弃。简报「历史」块已给出你的已发布与复盘结论，用它避免撞题、吸收教训。',
    '2. 每个机会必须回答四问：为什么是现在（具体事实+时效分类：爆点/热点/长青）、为什么是你（与身份/历史发布/库存资料的具体关系）、你的独特说法是什么、证据在哪（简报「增量」块的真实 id+具体事实点）。另须点明命中五维哪一环（时代认知/个人方向/AI 实践/公开验证/产品化）；说不出环节则降权或丢弃。值得尝试要有可动手动作（真实来源+本人实践/案例+具体动作）；无实验/无观点的公告搬运不进方案。需求信号仅当有重复问题信号时轻点一句，禁止硬造变现故事；区分流量与合格线索。答不出四问的线索不得写入方案。',
    '2.1 产品最高目标：在真实性边界内最大化传播价值。真实性仅作门槛，是准入硬门，不计入传播分；认知价值与实用价值都可入选，账号适配不得压过重大产业/社会意义。传播评分使用 propagation_v2（总分100）：reality_change_significance 25（现实发生了多大变化、旧认知是否失效）、tension_curiosity_gap 20（冲突/反差/认知缺口）、audience_stakes 20（对具体读者的利益、身份或判断影响）、why_now_window 15（窗口与错过成本）、one_sentence_relayability 15（一句话是否值得转述）、account_fit 5（账号适配）。每项必须给 criterion/weight/score/reason，总分严格等于六项和。',
    '2.2 中心主张竞争（硬门）：每个机会必须先生成 event（表面事件）、user（用户影响）、industry_or_society（产业/社会二阶意义）三个语义不同的候选主张，不得只换标题措辞；逐条记录 claimType=fact|inference|opinion、evidenceStatus=supported|research_required、可写证据边界、传播分与比较理由。winner 必须是传播分最高且 evidenceStatus=supported 的候选，pointOfView 必须与 winnerThesis 一致。若最高价值候选仍需研究，保留它并将本项保持未就绪/进入补料，不得退而选择安全小题。',
    '2.3 真实性硬门与知识回执：scoreReasons.version 必须为 propagation_v2，truthGate.status 必须 passed；每个核心 claim 明确 fact/inference/opinion、supported 状态与真实 sourceIds（纯观点可空）。必须先用 wmb_get_knowledge_context 查询实体及至少两个关联维度（例如模型实体+国产芯片/推理集群/商业部署/服务规模），并在 editorialDecision.knowledgeContext 记录 used+真实 contextRefs，或 no_relevant_context+明确原因。未经支持的产业推断不得伪装成事实。',
    '2.5 structureGuidance 必须点名六栏目之一并套骨架：迷茫诊断（典型困境→原因拆解→判断→第一个动作）/ 经典方法（方法出处→原理解读→边界/反例→今天怎么用）/ AI 实战（目标→我做了什么→AI 插手点→卡点→回执→无效步骤→下一步）/ 项目日志（今日一刀→回执→余味）/ 方向判断（为何现在→强观点→标题开头→来源）/ 商业化实验（仅真实成交或失败：场景→报价→过程→结果→教训）。',
    '2.7 写 title 前先在内部生成至少三个不同切口的候选：具体问题型、关键动作/方法型、对象/证据冲突型；再选择最能被 sourceIds 真实证据兑现的一条，只输出最终标题。title 必须直接点破该题材独有的问题、动作、对象或证据，能单独读懂并可直接发布；标题必须包含一个可被正文兑现的利益/冲突钩子（数字/对比/反转/代价四选一），不得复制简报「身份」块的受众描述，不得使用「普通人」等万能受众标签，不得把来源没有支持的数字、结果或因果写成钩子。对照简报「历史」块，避免复用近期标题的固定前缀与句式骨架。张力/好奇缺口必须在标题或 openingGuidance 中显式兑现，禁止把“夸张反常识只放 titleGuidance”的旧禁令当作不写钩子的理由。',
    '2.8 传播型写作契约（SSOT：skills/evidence-grounded-writer/SKILL.md §5 — 与选题到成稿全链一致）：每个机会必须冻结「一个处在具体情境中的读者（人+场景+卡住瞬间）+ 一个期望读者动作（今天就能做的一句话动作）」与「一个中心主张」，并在 title/angle/pointOfView/openingGuidance 中体现；openingGuidance 必须要求“首段立刻兑现标题钩子对应的冲突/利益点，不从背景/定义铺垫”；抽象主张必须在 angle/pointOfView 阶段即配人/场景/利害/后果；证据服务主张，不让证据罗列成为选题主体；保留可防守的张力，禁止软化为 `需要综合考虑/值得关注/未来可期` 等空话，有用细微差别须写明具体边界并与怯懦的各打五十大板区分开；平台适配（小红书/视频等）是重写钩子/节奏/转藏评动机，不是缩短；标题必兑现且标题主张必须可被正文兑现，禁止编造数字/个人经历/引语/结果/紧迫感/争议；每个候选自检四项（读者收益是否具体/是否有具体利害场景/为何现在窗口与错过成本是否写清/是否有明确的收藏/分享/评论动机）缺一不进方案。',
    '3. 机会 priority：0=最优先内部排程，1=次优先，…7=最低，仅作为内部排程顺序，不决定对外可见的传播等级；可见传播等级 SSS/S/A/B/C/D/E/F 仅由上述传播总分经共享阈值映射（90→SSS 80→S 70→A 60→B 50→C 40→D 30→E 其余 F）由系统计算，你不得直接指定或输出等级字段；priority 数值不得用于伪装传播推荐。未达到机会标准的线索不凑数。若候选与简报「存量」持续关注中的条目是同一故事的新进展，沿用同一故事主线表达并引用其来源，不要换措辞另起一个新机会。',
    '3.5 多日/持续/余波跟进项（timeliness 含 持续/多日/本周/一周/长期/余波/跟踪/跟进 等）必须绑定 topicId：只可从简报「存量」主题列表或 wmb_get_knowledge_context 输出中复制真实主题 id（同一故事跨日必须复用同一主题，禁止臆造 id）；无法确定既有主题时可省略 topicId，系统会为多日项自动建主题绑定。',
    '4. 不需要也不许调用任何工具（尤其禁止 wmb_get_workbench——它返回几十万字的全量工作台，会直接挤爆你的上下文；也禁止 bash）。如需查更早的同主题历史，仅可调用 wmb_get_knowledge_context。全部判断直接基于上方简报完成。',
    deepDiveRule,
    closingLine,
    '```json',
    '{',
    `  "planDate": "${task.businessDate}",`,
    '  "summary": "一句话概括今日判断",',
    '  "items": [{',
    '    "title": "直白可发布的标题（必须含数字/对比/反转/代价钩子且可被正文兑现）",',
    '    "priority": 1,',
    '    "whyNow": "为什么是现在（具体事实+时效）",',
    '    "timeliness": "热点 2-3 天",',
    '    "targetAudience": "目标读者",',
    '    "angle": "表达角度",',
    '    "pointOfView": "核心观点",',
    '    "platforms": ["x"],',
    '    "formats": ["text"],',
    '    "titleGuidance": "标题建议",',
    '    "openingGuidance": "开头建议",',
    '    "structureGuidance": "点名六栏目之一并套对应骨架",',
    '    "effortEstimate": "约 40 分钟",',
    '    "topicId": "多日/持续/余波跟进项填简报「存量」中的真实主题 id，其余省略",',
    '    "sourceIds": ["简报「增量」块中的真实 id"],',
    '    "editorialDecision": {"version":"editorial_thesis_v1","candidates":[{"level":"event","thesis":"表面事件主张","claimType":"fact","evidenceStatus":"supported","evidenceBoundary":"来源支持边界","score":55,"reason":"比较理由"},{"level":"user","thesis":"用户影响主张","claimType":"inference","evidenceStatus":"supported","evidenceBoundary":"推断边界","score":72,"reason":"比较理由"},{"level":"industry_or_society","thesis":"产业或社会意义主张","claimType":"inference","evidenceStatus":"supported","evidenceBoundary":"推断边界","score":86,"reason":"比较理由"}],"winnerLevel":"industry_or_society","winnerThesis":"必须与 pointOfView 相同","winnerReason":"为什么它比另外两层更值得传播","knowledgeContext":{"status":"used","contextRefs":["真实知识包或版本 id"],"queryDimensions":["实体","产业关联维度"],"reason":"知识如何改变判断"}},',
    '    "scoreReasons": {"status":"scored","version":"propagation_v2","score":86,"truthGate":{"status":"passed","reason":"事实与推断边界已核对","claims":[{"text":"核心事实或推断","type":"fact","status":"supported","sourceIds":["真实 source id"]}]},"reasons":[{"criterion":"reality_change_significance","weight":25,"score":22,"reason":"现实变化重要性"},{"criterion":"tension_curiosity_gap","weight":20,"score":18,"reason":"冲突与认知缺口"},{"criterion":"audience_stakes","weight":20,"score":17,"reason":"读者利害"},{"criterion":"why_now_window","weight":15,"score":13,"reason":"当前窗口"},{"criterion":"one_sentence_relayability","weight":15,"score":12,"reason":"一句话可转述"},{"criterion":"account_fit","weight":5,"score":4,"reason":"账号适配"}]},',
    '    "availableMaterials": [],',
    '    "missingMaterials": []',
    '  }],',
    '  "sourceDecisions": [{"sourceId":"本轮增量或重新激活证据中的真实 id","decision":"selected|excluded|unresolved|blocked","reasonCode":"稳定原因码","reason":"具体原因"}]',
    '}',
    '```',
    'sourceDecisions 必须逐条覆盖简报「增量」与「本轮重新激活的跨日证据」里的每个 Source，且每条只能出现一次：进入任一 item 的为 selected；不入选必须明确 excluded/unresolved/blocked 与具体原因。没有答得出四问的机会时 items 输出 []，但 sourceDecisions 仍须完整。通过 propagation_v2 总分决定传播等级（90 SSS/80 S/70 A/60 B/50 C/40 D/30 E；其余 F），不得自定等级；真实性只作硬门，不因证据多而获得传播加分。'
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

export function buildPlannerSourceBoundary(
  database: Parameters<typeof assembleEditorialBrief>[0],
  task: AgentTask,
  relevantIds?: ReadonlySet<string>
): Readonly<{ candidateIds: ReadonlySet<string>; allowedIds: ReadonlySet<string> }> {
  const brief = assembleEditorialBrief(database, {
    now: new Date(), businessDate: task.businessDate, watermark: resolveJudgeWatermark(database, task)
  });
  const incrementIds = brief.increment.sources.map((source) => source.id);
  const reactivatedIds = brief.continuity.reactivated.flatMap((pack) => pack.sources.map((source) => source.id));
  const candidateIds = new Set([...incrementIds, ...reactivatedIds]);
  const allowedIds = relevantIds
    ? new Set([...relevantIds, ...reactivatedIds])
    : new Set(candidateIds);
  return Object.freeze({ candidateIds, allowedIds });
}

export function buildDailyOpportunityPrompt(database: Parameters<typeof assembleEditorialBrief>[0], task: AgentTask, planRequestId: string, options: { nativeSearch?: boolean; gateRun?: DailyGateRun } = {}): string {
  const watermark = resolveJudgeWatermark(database, task);
  const brief = assembleEditorialBrief(database, {
    now: new Date(),
    businessDate: task.businessDate,
    watermark
  });
  const gateRun = options.gateRun ?? buildDailyGateRun(database, task);
  const gate = gateRun.lane
    ? {
        autoRelevantIds: gateRun.autoRelevant.map((candidate) => candidate.sourceId),
        pendingIds: gateRun.pending.map((candidate) => candidate.sourceId)
      }
    : null;
  return dailyPrompt(task, planRequestId, renderEditorialBrief(brief), { nativeSearch: options.nativeSearch, gate });
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

function gateJudgmentInput(candidate: LaneGateCandidate, decision: 'relevant' | 'irrelevant', reasonCode: LaneReasonCode, reason?: string) {
  return {
    sourceId: candidate.sourceId,
    decision,
    reasonCode,
    reason,
    expectedRevision: candidate.revision
  };
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
  const autoRelevantIds = gateRun.autoRelevant.map((candidate) => candidate.sourceId);
  if (gateRun.pending.length === 0) {
    const tier0 = await writeLaneGateBatch(dependency, task, {
      workspaceLane: gateRun.lane, judgedBy: 'system', judgedAt,
      judgments: gateRun.autoRelevant.map((candidate) => gateJudgmentInput(candidate, 'relevant', LANE_TIER0_REASON_CODE))
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
    return gateJudgmentInput(candidate, relevant ? 'relevant' : 'irrelevant', (entry.reasonCode ?? 'lane_relevant') as LaneReasonCode, entry.reason);
  });
  const tier0 = await writeLaneGateBatch(dependency, task, {
    workspaceLane: gateRun.lane, judgedBy: 'system', judgedAt,
    judgments: gateRun.autoRelevant.map((candidate) => gateJudgmentInput(candidate, 'relevant', LANE_TIER0_REASON_CODE))
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
    const scoringRecovery = getCurrentScoringRecovery(database, input.businessDate);
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
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
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
          const promptBuiltAt = new Date().toISOString();
          const planRequestId = agentRequestId(beforePlan.id, 'plan');
          const sessionBaseline = await readFile(dailySessionFile, 'utf8').then((text) => text.split(/\r?\n/).length).catch(() => 0);
          const gateTask = getAgentTask(database, beforePlan.id) ?? beforePlan;
          const gateRun = buildDailyGateRun(database, gateTask);
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
            run: async (runtime, nextConfig) => {
              const basePrompt = buildDailyOpportunityPrompt(database, gateTask, planRequestId, {
                nativeSearch: nextConfig.nativeSearch === true,
                gateRun
              });
              const opportunityPrompt = scoringRecovery ? scoringRecoveryPrompt(basePrompt, scoringRecovery) : basePrompt;
              // WMB-5178 §5：员工接收会话盖章（target=employee，行只进该员工会话文件，Dock 永不镜像）。
              await runtime.promptUntilSettled(buildOrchestrationEnvelope({ dispatchId: `daily_judge:${gateTask.id}`, target: 'employee', delivery: 'direct', safe: { originLabel: '今日情报', title: '今日情报判读', goal: '判断当日增量资料，产出可批机会方案', acceptance: '渠道回执与当日可批方案' }, prompt: opportunityPrompt }), { timeoutMs: 10 * 60_000 });
            }
          });
          synthesis = prompted.runtime;
          activeConfig = prompted.config;
          const sessionText = readAssistantTexts(await readFile(dailySessionFile, 'utf8'), sessionBaseline).join('\n');
          const gateApplied = scoringRecovery ? { relevantIds: new Set<string>(), archivedCount: 0, unresolved: false, unresolvedIds: new Set<string>() } : await applyDailyLaneGate(dependency, gateTask, gateRun, sessionText, planRequestId, promptBuiltAt, input.workerLeaseId);
          const sourceBoundary = scoringRecovery ? null : buildPlannerSourceBoundary(database, gateTask, gateRun.lane ? gateApplied.relevantIds : undefined);
          const allowedSourceIds = sourceBoundary?.allowedIds;
          let savedCount = scoringRecovery
            ? await applyScoringRecovery(dependency, gateTask, dailySessionFile, sessionBaseline, scoringRecovery, input.workerLeaseId, grantId)
            : (await savePlanFromSynthesisOutput(dependency, gateTask, dailySessionFile, planRequestId, input.workerLeaseId, grantId, sessionBaseline, allowedSourceIds, sourceBoundary?.candidateIds)).itemCount;
          // A newly generated plan may contain pending/invalid score payloads. Recover once
          // in the same task so the normal path does not require an Owner click. If this
          // single retry fails or remains incomplete, the outer failure path preserves the
          // plan and Today exposes the existing manual "继续评分" action.
          if (!scoringRecovery) {
            const automaticRecovery = getCurrentScoringRecovery(database, input.businessDate);
            if (automaticRecovery) {
              await dispatchReportAgentTaskProgress(dependency, beforePlan.id, {
                phase: 'validating',
                message: `检测到 ${automaticRecovery.items.length} 条评分未完成，正在自动补齐（仅一次）。`
              }, taskCommandContext(lane, `${beforePlan.id}:progress:auto-scoring-recovery`, beforePlan.id, input.workerLeaseId));
              const recoveryBaseline = await readFile(dailySessionFile, 'utf8').then((text) => text.split(/\r?\n/).length).catch(() => 0);
              const recovered = await runPiPromptWithFallback({
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
                run: async (runtime, nextConfig) => {
                  const basePrompt = buildDailyOpportunityPrompt(database, gateTask, planRequestId, {
                    nativeSearch: nextConfig.nativeSearch === true,
                    gateRun
                  });
                  await runtime.promptUntilSettled(buildOrchestrationEnvelope({
                    dispatchId: `daily_judge:${gateTask.id}:auto-scoring-recovery`,
                    target: 'employee',
                    delivery: 'direct',
                    safe: { originLabel: '今日情报', title: '自动续评分', goal: '补齐当前计划的传播评分', acceptance: '原计划条目全部获得有效六维评分' },
                    prompt: scoringRecoveryPrompt(basePrompt, automaticRecovery)
                  }), { timeoutMs: 10 * 60_000 });
                }
              });
              synthesis = recovered.runtime;
              activeConfig = recovered.config;
              savedCount = await applyScoringRecovery(dependency, gateTask, dailySessionFile, recoveryBaseline, automaticRecovery, input.workerLeaseId, grantId);
              const remaining = getCurrentScoringRecovery(database, input.businessDate);
              if (remaining) throw new Error(`scoring_recovery_incomplete: ${remaining.items.length} item(s)`);
            }
          }
          const saved = { itemCount: savedCount };
          const gateNote = gateApplied.archivedCount > 0 ? `，另判 ${gateApplied.archivedCount} 条与本赛道无关已移出` : '';
          const unresolvedNote = gateApplied.unresolved ? `，${gateApplied.unresolvedIds.size} 条因内容变更待重评` : '';
          await dispatchReportAgentTaskProgress(dependency, beforePlan.id, {
            message: saved.itemCount > 0 ? `方案已保存：${saved.itemCount} 个机会${gateNote}${unresolvedNote}。` : `方案已保存：今日没有合格机会${gateNote}${unresolvedNote}。`
          }, taskCommandContext(lane, `${beforePlan.id}:progress:plan-saved`, beforePlan.id, input.workerLeaseId));
          if (gateApplied.unresolved) {
            await dispatchReportAgentTaskProgress(dependency, beforePlan.id, { checkpoint: { laneUnresolved: true, unresolvedIds: [...gateApplied.unresolvedIds] } }, taskCommandContext(lane, `${beforePlan.id}:progress:lane-unresolved`, beforePlan.id, input.workerLeaseId));
          } else {
            const isQualifiedEmpty = saved.itemCount === 0;
            const checkpoint: Record<string, unknown> = { judgeWatermark: promptBuiltAt };
            if (isQualifiedEmpty) {
              checkpoint.emptyQualified = true;
              checkpoint.qualifiedEmpty = true;
              checkpoint.dailyEmptyQualified = true;
            }
            await dispatchReportAgentTaskProgress(dependency, beforePlan.id, { checkpoint }, taskCommandContext(lane, `${beforePlan.id}:progress:judge-watermark`, beforePlan.id, input.workerLeaseId));
          }
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

export function draftPrompt(task: AgentTask, projectId: string, requestId: string, writerTask: WriterTask = 'core_draft', brief = '', researchReady = false, researchMode: 'auto' | 'required' | 'prohibited' = 'auto'): string {
  if (writerTask === 'xiaohongshu_platform_version') {
    return [
      '执行 WeMediaBuddy Studio 小红书平台版本任务。',
      `task_id=${task.id}`,
      'intent=studio_draft',
      `project_id=${projectId}`,
      `brief=${brief}`,
      `version_request_id=${requestId}`,
      '要求：',
      '1. 只通过 wmb_* MCP 工具读写业务数据，禁止直接写文件或数据库，禁止最终发布。',
      `2. 先调用 wmb_get_content({ projectId: "${projectId}" }) 与 wmb_get_workbench，定位指定 project，并读取最新核心版本。`,
      '3. 如果项目没有核心版本，明确失败并停止；本任务禁止调用 wmb_save_core_version，禁止生成或改写核心稿。',
      '4. 基于最新核心稿改写一份适合小红书发布的完整中文版本：保留一个中心主张与证据不变，并严格遵守“已批准中心主张”及其事实/推断边界，不得把产业/社会意义软化成产品测评或使用建议；标题围绕该题材独有的对象、问题、动作或证据，标题必须包含可被正文兑现的利益/冲突钩子（数字/对比/反转/代价四选一）且可兑现，重写开头钩子、信息节奏与收藏/分享/评论动机（平台适配是重写钩子/节奏/动机，不是缩短），不自动添加「普通人」等万能受众标签，不复用固定前缀，不虚构核心稿没有的事实，正文自然可读。若现有证据迫使中心主张改变，停止保存并要求退回 Planner 重新批准。标题必兑现，禁止编造数字、个人经历、引语、结果、紧迫感或争议。',
      `5. 调用 wmb_save_platform_version，requestId 必须是 ${requestId}，projectId 必须是 ${projectId}，contentVersionId 必须是步骤2读到的最新核心版本 id，platform 必须是 xiaohongshu，format 必须是 text，title/body 为完整小红书版本。`,
      `6. 再调用 wmb_get_content({ projectId: "${projectId}" })，确认 xiaohongshu 平台版本已保存且关联正确的核心版本。`,
      '7. 最后用简洁中文回复：已保存小红书平台版本，并给出标题和正文前两句。'
    ].join('\n');
  }
  if (writerTask === 'video_script') {
    return [
      '执行 WeMediaBuddy Studio 视频文案衍生任务。',
      `task_id=${task.id}`,
      'intent=studio_draft',
      `project_id=${projectId}`,
      `brief=${brief}`,
      `version_request_id=${requestId}`,
      '要求：',
      '1. 只通过 wmb_* MCP 工具读写业务数据，禁止直接写文件或数据库，禁止最终发布。',
      `2. 先调用 wmb_get_content({ projectId: "${projectId}" }) 与 wmb_get_workbench，读取最新定稿文章；没有定稿文章时明确失败并停止。`,
      '3. 先判断内容最适合的真实视频形态，再据此设计结构、节奏和镜头表达；不得套固定模板，不得虚构文章没有的事实。',
      `4. 调用 wmb_save_video_script，requestId 必须是 ${requestId}，projectId 必须是 ${projectId}，sourceContentVersionId 必须是步骤2读到的最新文章版本 id，并保存标题、完整文案与格式决策。`,
      `5. 再调用 wmb_get_content({ projectId: "${projectId}" })，确认视频文案已保存并准确绑定最新文章版本。`,
      '6. 最后用简洁中文回复已保存的视频形态、标题与文案开头。'
    ].join('\n');
  }
  if (!researchReady && researchMode !== 'prohibited') {
    return [
      '执行 WeMediaBuddy Studio 核心初稿的外部研究前置交接。当前轮次禁止写作。',
      `task_id=${task.id}`,
      'intent=studio_draft',
      `project_id=${projectId}`,
      `brief=${brief}`,
      '要求：',
      '1. 只通过 wmb_* MCP 工具读业务数据；禁止直接写文件或数据库，禁止生成图片，禁止保存任何正文或平台版本。',
      `2. 先调用 wmb_get_content({ projectId: "${projectId}" }) 与 wmb_get_workbench，读取项目标题、现有资料和写作要求。`,
      '3. 不得把模型内置知识、项目标题中的说法或搜索摘要当作已核查证据。围绕文章对象与版本、工作机制与适用边界、关键事实或数字、现实使用案例、失败案例/反证与风险，整理 4—8 条可由外部来源核查的 requiredClaims；每条使用稳定英文 key、清晰中文 text，type 仅用 fact/price/policy。',
      `4. 必须调用 wmb_dispatch_research({ parentTaskId: "${task.id}", requiredClaims, channels: ["web", "x", "xhs"], brief })。即使项目已有少量关联资料，也必须派单做外部独立核查；不得改用普通 reporter/daily_scan，不得在当前写手会话临时联网。`,
      '5. 派单成功后立即结束当前交付。不得继续起草、导图、调用 wmb_import_project_image、wmb_save_core_version 或 wmb_save_platform_version；研究终态会通过 EvidencePack 与项目来源关联后单跳续派新 writer 工单。',
      '6. 最后只简洁回复：已派外部研究，等待研究完成后续写。'
    ].join('\n');
  }
  if (researchMode === 'prohibited') {
    return [
      '执行 WeMediaBuddy Studio 核心初稿任务（受限写作·已豁免外部研究）。',
      `task_id=${task.id}`,
      'intent=studio_draft',
      `project_id=${projectId}`,
      `version_request_id=${requestId}`,
      `brief=${brief}`,
      '要求：',
      '1. 严禁调用 wmb_dispatch_research；只通过 wmb_* MCP 工具读取项目资料并保存正文，禁止直接写文件或数据库，禁止最终发布。',
      `2. 先调用 wmb_get_content({ projectId: "${projectId}" }) 与 wmb_get_workbench，定位指定 project。`,
      '3. 仅依据项目已关联来源写作；无法由现有来源支持的事实、数字、因果和案例必须删除或明确标为作者观点，不得用模型内置知识补证据。',
       '4. 写出围绕项目中“已批准中心主张”的中文核心初稿；该主张、传播承诺和事实/推断边界均已由 Owner 锁定，不得改成更安全但更弱的产品测评或使用建议。若现有来源迫使主线变化，停止保存并要求退回 Planner 重新批准。标题必须兑现，正文自然完整；禁止编造数字、个人经历、引语、结果、紧迫感或争议。',
      `5. 调用 wmb_save_core_version，requestId 必须是 ${requestId}，projectId 必须是 ${projectId}，expectedRevision 使用步骤2读到的当前项目 revision。`,
      `6. 再调用 wmb_get_content({ projectId: "${projectId}" })，确认核心版本正文已保存。`,
      '7. 最后用简洁中文回复：已保存受限写作核心正文，并给出标题和正文前两句。'
    ].join('\n');
  }
  return [
    '执行 WeMediaBuddy Studio 核心初稿任务。',
    `task_id=${task.id}`,
    'intent=studio_draft',
    `project_id=${projectId}`,
    `version_request_id=${requestId}`,
    '要求：',
    `brief=${brief}`,
    '1. 只通过 wmb_* MCP 工具读写业务数据，禁止直接写文件或数据库，禁止最终发布。',
    `2. 先调用 wmb_get_content({ projectId: "${projectId}" }) 与 wmb_get_workbench，定位指定 project。`,
    '3. 仅依据项目已关联来源、已批准专项调查资料包或本次 research successor 的 EvidencePack 写一篇完整中文核心初稿正文；项目初始版本中的“已批准中心主张”、传播承诺、事实/推断边界是 Owner 锁，不得自行替换或软化。若新证据迫使主线改变，停止保存并要求退回 Planner 重新批准。遵循 SSOT `skills/evidence-grounded-writer/SKILL.md` §5 传播型写作契约：(a)一个处在具体情境中的读者与一个期望读者动作必须服务已批准的一个中心主张，不得反过来把产业/社会意义降成工具测评；受众只用于内部锚定，不自动添加「普通人」等万能受众标签；(b)标题必兑现：标题围绕该题材独有的对象、问题、动作或证据，包含可被正文兑现的利益/冲突钩子，不写来源未支持的数字、结果或因果；(c)首段立刻兑现钩子；(d)抽象主张配人/场景/利害/后果至少两件；(e)证据服务主张；(f)保留可防守的张力，禁止软化为 `需要综合考虑/值得关注/未来可期`，具体边界与怯懦的各打五十大板不同；(g)禁止编造。研究续派任务禁止再次派研究。',
    '4. 正文阶段不自动生成、导入或插入图片；如需配图，必须在正文保存后由 Owner 显式启动定稿配图流程。',
    '5. 完成初稿后执行编辑自检（四项缺一即打回重写再保存）：(1)读者收益是否具体（今天就能用的一句话动作） (2)是否有具体利害/代价场景 (3)为何现在窗口与错过成本是否写清 (4)是否有明确的收藏/分享/评论动机；未通过不得调用 wmb_save_core_version。',
    `6. 调用 wmb_save_core_version，requestId 必须是 ${requestId}，projectId 必须是 ${projectId}，expectedRevision 使用步骤2读到的当前项目 revision，body 为不含自动配图的完整正文。`,
    `7. 再调用 wmb_get_content({ projectId: "${projectId}" })，确认核心版本正文已保存；配图由定稿流程单独处理。`,
    '8. 最后用简洁中文回复：已保存核心正文，并给出标题和正文前两句。'
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
  const startRequestId = input.startRequestId ?? `studio_draft:${input.businessDate}:${input.projectId}:start`;
  try {
    const contextRefs = {
      roleId: 'writer' as const,
      projectId: input.projectId,
      writerTask,
      researchGate: writerTask === 'core_draft' ? (input.researchMode === 'prohibited' ? 'exempt' : (input.researchReady === true ? 'satisfied' : 'required')) : 'not_applicable',
      researchMode: input.researchMode ?? 'auto'
    };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, {
      intent: 'studio_draft', roleId: 'writer', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath
    });
    if (prerequisite.waiting) return prerequisite.waiting;
    const policySnapshot = prerequisite.policySnapshot;
    const taskContextRefs = { ...contextRefs, modelPolicySnapshot: policySnapshot };
    const conversation = await readPiConversation(input.dataRootPath);
    const started = await dispatchStartAgentTask(dependency, { intent: 'studio_draft', businessDate: input.businessDate, contextRefs: taskContextRefs, piSessionId: conversation.sessionId }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    if (started.reused) return { task: started.task, reused: true };
    const task = started.task;
    const taskPolicySnapshot = readTaskModelPolicySnapshot(task, 'writer') ?? policySnapshot;
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    const extensionPath = await preparePiExtension(layout.agentDir);
    const requestId = agentRequestId(task.id, writerTask === 'core_draft' ? 'core_version' : 'xiaohongshu_platform_version');
    // 旧 Studio 直接 IPC 不经过 JobPool；为研究续派补一份同型持久合同。
    // JobPool 路径已由 onTaskReady 写入真实 jobId，此处只在缺失时补，不覆盖。
    let researchContractRefs: Record<string, unknown> | undefined;
    const taskAfterReady = getAgentTask(database, task.id);
    if (writerTask === 'core_draft' && input.researchReady !== true && input.researchMode !== 'prohibited' && !readJobContractFromRefs(taskAfterReady?.contextRefs ?? {})) {
      const directRequest: RoleJobRequest = Object.freeze({
        roleId: 'writer',
        brief: input.brief?.trim() || 'Studio 直接核心初稿',
        businessDate: input.businessDate,
        projectId: input.projectId,
        writerTask: 'core_draft'
      });
      researchContractRefs = {
        ...(taskAfterReady?.contextRefs ?? {}),
        ...buildJobContextRefs({
          jobId: `direct-writer:${task.id}`,
          request: directRequest,
          boundary: buildJobObjectBoundary(directRequest, input.businessDate)
        })
      };
    }
    await dispatchUpdateAgentTaskPhase(dependency, task.id, 'running_pi', { piSessionId: conversation.sessionId, contextRefs: researchContractRefs }, taskCommandContext(lane, `${task.id}:phase:running-pi`, task.id, input.workerLeaseId, { requestId: startRequestId }));
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-draft-'));
    const createRuntime = async (nextConfig: ResolvedPiConfig) => {
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
      const runtime = new PiRpcSupervisor(process.execPath, [
        await piCliPath(input.dataRootPath), '--mode', 'rpc', '--session', (input.sessionFile || path.join(path.dirname(layout.sessionFile), `studio-${task.id}.jsonl`)), '-e', extensionPath,
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
          const platformTask = writerTask === 'xiaohongshu_platform_version';
          const researchPreflight = writerTask === 'core_draft' && input.researchReady !== true && input.researchMode !== 'prohibited';
          await activeRuntime.promptUntilSettled(buildOrchestrationEnvelope({
            dispatchId: `studio_draft:${task.id}`,
            target: 'employee',
            delivery: 'direct',
            safe: platformTask
              ? { originLabel: 'Studio 小红书版本', title: '小红书平台版本', goal: '基于最新核心稿生成并保存小红书平台版本', acceptance: '小红书平台版本读回' }
              : researchPreflight
                ? { originLabel: 'Studio 核心初稿', title: '外部研究前置', goal: '派出受控外部研究并停止当前写作', acceptance: '研究派单回执与父任务交接' }
                : { originLabel: 'Studio 核心初稿', title: '内容核心初稿', goal: '基于项目资料撰写完整核心初稿并保存', acceptance: '核心版本读回' },
            prompt: draftPrompt(task, input.projectId, requestId, writerTask, input.brief ?? '', input.researchReady === true, input.researchMode ?? 'auto')
          }), { timeoutMs: piPromptTimeoutMs() });
        }
      });
      const afterPrompt = getAgentTask(database, task.id);
      // research.dispatch 成功会把当前父任务置为 partial；禁止继续 validating/complete 覆盖交接真相。
      if (afterPrompt && afterPrompt.status !== 'running') return { task: afterPrompt, reused: false };
      if (writerTask === 'core_draft' && input.researchReady !== true && input.researchMode !== 'prohibited') {
        const failed = await dispatchFailAgentTask(
          dependency,
          task.id,
          'RESEARCH_DISPATCH_MISSING',
          '外部研究未成功派出；本轮未写作，也未保存正文。',
          taskCommandContext(lane, `${task.id}:fail:research-dispatch-missing`, task.id, input.workerLeaseId)
        );
        return { task: failed, reused: false };
      }
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
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
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
