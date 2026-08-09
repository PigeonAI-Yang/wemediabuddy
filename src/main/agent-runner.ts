import { dailyControlWatchdogDecision } from './daily-control-policy.ts';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
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
import { runPiPromptWithFallback, startPiRuntimeWithFallback } from './pi-config-fallback.ts';
import type { ResolvedPiConfig } from './pi-config.ts';
import { saveCurrentPlan } from './planning.ts';
import { getToday } from './workbench.ts';

const planOutputItemSchema = z.object({
  title: z.string().min(1),
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
  topicId: z.string().optional(),
  reviewIds: z.array(z.string()).optional(),
  methodFindingIds: z.array(z.string()).optional()
});
const planOutputSchema = z.object({
  planDate: z.string().optional(),
  summary: z.string().min(1),
  items: z.array(planOutputItemSchema).max(12)
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
      if (!(LANE_REASON_CODES as readonly string[]).includes(entry.reasonCode)) {
        throw new Error(`模型赛道判定 reasonCode 不在词典内：${entry.reasonCode}`);
      }
      if (entry.reasonCode === 'official_source' || entry.reasonCode === 'editor_override' || entry.reasonCode === 'lane_relevant') {
        throw new Error(`模型赛道判定不可使用系统 reasonCode：${entry.reasonCode}`);
      }
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
  if (!parsed.success) throw new Error(`模型方案结构不完整：${parsed.error.issues.slice(0, 3).map((issue) => issue.path.join('.') || issue.message).join('；')}`);
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

export async function savePlanFromSynthesisOutput(
  dependency: AgentTaskMutationDependency,
  task: AgentTask,
  sessionFile: string,
  planRequestId: string,
  workerLeaseId?: string,
  grantId?: string | null,
  sessionBaseline = 0,
  /** 有效资料 id 白名单（赛道门通过后）：引用白名单外 sourceId 的方案项被丢弃（四问只跑在有效资料上）。 */
  allowedSourceIds?: ReadonlySet<string>
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
  const input = { planDate: task.businessDate, timezone: 'Asia/Shanghai', summary: plan.summary, items };
  if ('database' in dependency) {
    requireReceiptData(await dispatchBusinessCommand(dependency, {
      command: 'plans.save',
      requestId: planRequestId,
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
  } else {
    const saved = saveCurrentPlan(dependency, input);
    dependency.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)')
      .run('plans.save', planRequestId, JSON.stringify(saved), new Date().toISOString());
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
        `其余 ${options.gate.pendingIds.length} 条增量资料必须逐条判定赛道相关性：是当前赛道（「身份」块：服务「一个人 + AI 靠内容与产品活下去」的商业化成长素材，五维=认知/技能/表达/获客/产品化）的有效素材 → relevant:true；不是 → relevant:false + reasonCode + 一句话 reason。纯公告搬运、宏大行业综述、躺赚毒鸡汤、与五维无关的生活噪音 → irrelevant。reasonCode 只能从以下选择：${modelReasonCodes.join(' / ')}。`,
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
    '1. 先读简报「身份」块对齐受众、内容目标与编辑简报；身份默认对齐「AI × 个人商业化成长」。脱离身份的泛 AI 资讯、纯复述公告、无法验证的赚钱承诺直接丢弃。简报「历史」块已给出你的已发布与复盘结论，用它避免撞题、吸收教训。',
    '2. 每个机会必须回答四问：为什么是现在（具体事实+时效分类：爆点/热点/长青）、为什么是你（与身份/历史发布/库存资料的具体关系）、你的独特说法是什么、证据在哪（简报「增量」块的真实 id+具体事实点）。另须点明命中五维哪一环（认知/技能/表达/获客/产品化）；说不出环节则降权或丢弃。值得尝试要有可动手动作；无实验/无观点的公告搬运不进方案。需求信号仅当有重复问题信号时轻点一句，禁止硬造变现故事。答不出四问的线索不得写入方案。',
    '2.5 structureGuidance 必须点名六栏目之一并套骨架：实验日志（目标→动作→AI插手→卡点→回执→无效步骤→下一步）/ 开发日志（今日一刀→回执→余味）/ 原则卡（判断→物证→边界→反例）/ 机会判断（为何现在→强观点→标题开头→来源）/ 周复盘（兑现→图景→追问→重复问题→需求信号→K/S/C）/ 变现实验（仅真实成交或失败：场景→报价→过程→结果→教训）。',
    '3. 机会 priority：0=SSS，1=S，2=A，3=B，4=C，5=D，6=E，7=F。未达到机会标准的线索不凑数。若候选与简报「存量」持续关注中的条目是同一故事的新进展，沿用同一故事主线表达并引用其来源，不要换措辞另起一个新机会。',
    '3.5 多日/持续/余波跟进项（timeliness 含 持续/多日/本周/一周/长期/余波/跟踪/跟进 等）必须绑定 topicId：只可从简报「存量」主题列表或 wmb_get_knowledge_context 输出中复制真实主题 id（同一故事跨日必须复用同一主题，禁止臆造 id）；无法确定既有主题时可省略 topicId，系统会为多日项自动建主题绑定。',
    '4. 不需要也不许调用任何工具（尤其禁止 wmb_get_workbench——它返回几十万字的全量工作台，会直接挤爆你的上下文；也禁止 bash）。如需查更早的同主题历史，仅可调用 wmb_get_knowledge_context。全部判断直接基于上方简报完成。',
    deepDiveRule,
    closingLine,
    '```json',
    '{',
    `  "planDate": "${task.businessDate}",`,
    '  "summary": "一句话概括今日判断",',
    '  "items": [{',
    '    "title": "机会标题",',
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
    '    "availableMaterials": [],',
    '    "missingMaterials": []',
    '  }]',
    '}',
    '```',
    '没有答得出四问的机会时 items 输出 []。'
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
}>;

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
): Promise<void> {
  if (input.judgments.length === 0) return;
  const withLiveRevisions = (database: Parameters<typeof applyLaneGateBatch>[0], value: typeof input) => {
    // 扫/判并行时 source revision 可能已前进：写前刷新，避免整轮 REVISION_CONFLICT。
    const judgments = value.judgments.map((item) => {
      const row = database.prepare('SELECT revision AS revision FROM source_items WHERE id=?').get(item.sourceId) as { revision: number } | undefined;
      return row ? { ...item, expectedRevision: row.revision } : item;
    });
    return { ...value, judgments };
  };
  if ('database' in dependency) {
    requireReceiptData(await dispatchBusinessCommand(dependency, {
      command: 'sources.lane_gate',
      requestId,
      actor: schedulerActor('daily-intelligence'),
      taskId: task.id,
      workerLeaseId,
      input,
      boundIdentity: { entityType: 'lane_judgment', workspaceLane: input.workspaceLane },
      entityType: 'lane_judgment',
      execute: (commandDatabase, value) => ({ data: applyLaneGateBatch(commandDatabase, withLiveRevisions(commandDatabase, value), { transaction: false }) })
    }));
  } else {
    // 裸数据库（测试）路径：domain helper 自带事务。
    applyLaneGateBatch(dependency, withLiveRevisions(dependency, input));
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
  if (gateRun.lane === null) return { relevantIds: new Set<string>(), archivedCount: 0 };
  const autoRelevantIds = gateRun.autoRelevant.map((candidate) => candidate.sourceId);
  if (gateRun.pending.length === 0) {
    // 本轮无待判资料：资料门 no-op，仅记录 Tier 0 确定性行（零模型）。
    await writeLaneGateBatch(dependency, task, {
      workspaceLane: gateRun.lane, judgedBy: 'system', judgedAt,
      judgments: gateRun.autoRelevant.map((candidate) => gateJudgmentInput(candidate, 'relevant', LANE_TIER0_REASON_CODE))
    }, `${planRequestId}:gate-tier0`, workerLeaseId);
    return { relevantIds: new Set(autoRelevantIds), archivedCount: 0 };
  }
  const gate = parseLaneGateOutput(sessionText);
  const pendingById = new Map<string, LaneGateCandidate>(gateRun.pending.map((candidate) => [candidate.sourceId, candidate]));
  const judgedIds = new Set<string>();
  // 模型偶发编造 id / 重复 id：忽略脏项，只接受待判清单内首次判定。
  const accepted: LaneGateOutputEntry[] = [];
  for (const entry of gate.gate) {
    if (!pendingById.has(entry.sourceId)) continue;
    if (judgedIds.has(entry.sourceId)) continue;
    judgedIds.add(entry.sourceId);
    accepted.push(entry);
  }
  // 漏判：默认 relevant，避免整轮假失败打断主路径（模型偶发漏 id）。
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
  await writeLaneGateBatch(dependency, task, {
    workspaceLane: gateRun.lane, judgedBy: 'system', judgedAt,
    judgments: gateRun.autoRelevant.map((candidate) => gateJudgmentInput(candidate, 'relevant', LANE_TIER0_REASON_CODE))
  }, `${planRequestId}:gate-tier0`, workerLeaseId);
  await writeLaneGateBatch(dependency, task, {
    workspaceLane: gateRun.lane, judgedBy: 'agent', judgedAt,
    judgments: agentJudgments
  }, `${planRequestId}:gate-tier1`, workerLeaseId);
  return { relevantIds, archivedCount };
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
    const prerequisite = await resolveAgentPiPrerequisite(dependency, { intent: 'daily_judge', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting;
    const existing = getActiveDailyIntelligenceTask(database, input.businessDate);
    let started: { task: AgentTask; reused: boolean };
    if (existing && (existing.phase === 'channel_scanned' || existing.phase === 'resume_pending' || existing.intent === 'daily_judge')) {
      const rebound = await dispatchUpdateAgentTaskPhase(
        dependency,
        existing.id,
        existing.phase,
        {
          intent: existing.intent === 'daily_judge' ? undefined : 'daily_judge',
          contextRefs: { ...existing.contextRefs, ...contextRefs, roleId: 'planner' }
        },
        taskCommandContext(lane, `${existing.id}:rebind-judge:${randomUUID()}`, existing.id, input.workerLeaseId, { requestId: startRequestId })
      );
      started = { task: rebound, reused: true };
    } else {
      started = await dispatchStartAgentTask(dependency, { intent: 'daily_judge', businessDate: input.businessDate, contextRefs }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    }
    const task = started.task;
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
        WMB_XHS_MCP_URL: input.xhsMcpUrl || ''
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
              await runtime.promptUntilSettled(buildDailyOpportunityPrompt(database, gateTask, planRequestId, {
                nativeSearch: nextConfig.nativeSearch === true,
                gateRun
              }), { timeoutMs: 10 * 60_000 });
            }
          });
          synthesis = prompted.runtime;
          activeConfig = prompted.config;
          // 第一关（赛道相关性）先于四问：解析判定块 → 应用归档写路径（fail-closed：解析失败抛错，
          // 零归档、水印不推进、下轮整批重判）；只有判相关/自动相关的资料进入四问方案。
          const sessionText = readAssistantTexts(await readFile(dailySessionFile, 'utf8'), sessionBaseline).join('\n');
          const gateApplied = await applyDailyLaneGate(dependency, gateTask, gateRun, sessionText, planRequestId, promptBuiltAt, input.workerLeaseId);
          const allowedSourceIds = gateRun.lane ? gateApplied.relevantIds : undefined;
          // 结构化输出路径：从本轮会话增量读出 ```json 方案块（最后一个），校验后由系统经 dispatcher 保存（弱模型不必构造工具调用）。
          const saved = await savePlanFromSynthesisOutput(dependency, gateTask, dailySessionFile, planRequestId, input.workerLeaseId, grantId, sessionBaseline, allowedSourceIds);
          const gateNote = gateApplied.archivedCount > 0 ? `，另判 ${gateApplied.archivedCount} 条与本赛道无关已移出` : '';
          await dispatchReportAgentTaskProgress(dependency, beforePlan.id, {
            message: saved.itemCount > 0 ? `方案已保存：${saved.itemCount} 个机会${gateNote}。` : `方案已保存：今日没有合格机会${gateNote}。`
          }, taskCommandContext(lane, `${beforePlan.id}:progress:plan-saved`, beforePlan.id, input.workerLeaseId));
          // 增量判断水印：两关（赛道判定 + 四问方案）都成功才推进；任一失败不写入，下轮重评（判定幂等）。
          await dispatchReportAgentTaskProgress(dependency, beforePlan.id, { checkpoint: { judgeWatermark: promptBuiltAt } }, taskCommandContext(lane, `${beforePlan.id}:progress:judge-watermark`, beforePlan.id, input.workerLeaseId));
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
  /** 员工会话隔离：不传则回退 dock session（不推荐） */
  sessionFile?: string;
  /** WMB-5116：JobPool 新工单传入每 job 唯一 start request identity（如 `${jobId}:studio-draft:start`），
   *  避免同 date/project 新工单与既有工单共享确定性 identity 触发 REQUEST_REPLAY_CONFLICT。
   *  direct Studio 调用不传，保持确定性默认值以幂等重放同请求。 */
  startRequestId?: string;
}): Promise<DailyIntelligenceRun> {
  const { dependency, database, close } = mutationDependency(input);
  const lane = 'studio-draft';
  const startRequestId = input.startRequestId ?? `studio_draft:${input.businessDate}:${input.projectId}:start`;
  try {
    const contextRefs = { projectId: input.projectId };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, { intent: 'studio_draft', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting;
    const conversation = await readPiConversation(input.dataRootPath);
    const started = await dispatchStartAgentTask(dependency, { intent: 'studio_draft', businessDate: input.businessDate, contextRefs, piSessionId: conversation.sessionId }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    if (started.reused) return { task: started.task, reused: true };
    const task = started.task;
    const grantId = await input.onTaskReady?.(task.id) ?? null;
    const layout = await ensurePiConversationLayout(input.dataRootPath);
    const extensionPath = await preparePiExtension(layout.agentDir);
    const requestId = agentRequestId(task.id, 'core_version');
    await dispatchUpdateAgentTaskPhase(dependency, task.id, 'running_pi', { piSessionId: conversation.sessionId }, taskCommandContext(lane, `${task.id}:phase:running-pi`, task.id, input.workerLeaseId, { requestId: startRequestId }));
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-draft-'));
    const createRuntime = async (nextConfig: ResolvedPiConfig) => {
      await writeFile(path.join(layout.agentDir, 'models.json'), JSON.stringify(piModelsJson({ ...nextConfig, apiKey: '$WMB_PI_API_KEY' })), 'utf8');
      const runtime = new PiRpcSupervisor(process.execPath, [
        await piCliPath(input.dataRootPath), '--mode', 'rpc', '--session', (input.sessionFile || layout.sessionFile), '-e', extensionPath,
        '--provider', 'wmb-api', '--model', nextConfig.model, '--append-system-prompt', piTaskAuthorityPrompt({ taskId: task.id, grantId, workerLeaseId: input.workerLeaseId })
      ], {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PI_CODING_AGENT_DIR: layout.agentDir,
        WMB_PI_API_KEY: nextConfig.apiKey,
        WMB_MCP_URL: input.mcpUrl,
        WMB_XHS_MCP_URL: input.xhsMcpUrl || ''
      }, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
      input.onRuntime?.(runtime);
      return runtime;
    };
    let runtime: PiRpcSupervisor | null = null;
    try {
      const startedRuntime = await startPiRuntimeWithFallback({
        piConfigPath: input.piConfigPath,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>)
      });
      runtime = startedRuntime.runtime;
      await runPiPromptWithFallback({
        piConfigPath: input.piConfigPath,
        initial: startedRuntime,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>),
        onRuntimeChanged: (nextRuntime) => {
          runtime = nextRuntime;
          input.onRuntime?.(nextRuntime);
        },
        run: async (activeRuntime) => {
          await activeRuntime.promptUntilSettled(draftPrompt(task, input.projectId, requestId), { timeoutMs: piPromptTimeoutMs() });
        }
      });
      await dispatchUpdateAgentTaskPhase(dependency, task.id, 'validating', {}, taskCommandContext(lane, `${task.id}:phase:validating`, task.id, input.workerLeaseId));
      const completed = await dispatchCompleteAgentTask(dependency, task.id, taskCommandContext(lane, `${task.id}:complete`, task.id, input.workerLeaseId));
      return { task: completed, reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, task.id);
      if (current?.status === 'running') await dispatchFailAgentTask(dependency, task.id, 'STUDIO_DRAFT_FAILED', message, taskCommandContext(lane, `${task.id}:fail`, task.id, input.workerLeaseId));
      throw error;
    } finally {
      await runtime?.stop().catch(() => {});
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
  /** 员工会话隔离：不传则回退 dock session（不推荐） */
  sessionFile?: string;
  onTaskReady?: TaskReadyGrantHook;
}): Promise<DailyIntelligenceRun> {
  const { dependency, database, close } = mutationDependency(input);
  const lane = 'results-review';
  const startRequestId = `results_review:${input.businessDate}:${input.publicationId}:start`;
  try {
    const contextRefs = { publicationId: input.publicationId };
    const prerequisite = await resolveAgentPiPrerequisite(dependency, { intent: 'results_review', businessDate: input.businessDate, contextRefs, piConfigPath: input.piConfigPath });
    if (prerequisite.waiting) return prerequisite.waiting;
    const conversation = await readPiConversation(input.dataRootPath);
    const started = await dispatchStartAgentTask(dependency, { intent: 'results_review', businessDate: input.businessDate, contextRefs, piSessionId: conversation.sessionId }, taskCommandContext(lane, startRequestId, undefined, input.workerLeaseId));
    if (started.reused) return { task: started.task, reused: true };
    const task = started.task;
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
        WMB_MCP_URL: input.mcpUrl,
        WMB_XHS_MCP_URL: input.xhsMcpUrl || ''
      }, (event) => input.onEvent?.(event as Record<string, unknown>), workDir);
      input.onRuntime?.(runtime);
      return runtime;
    };
    let runtime: PiRpcSupervisor | null = null;
    try {
      const startedRuntime = await startPiRuntimeWithFallback({
        piConfigPath: input.piConfigPath,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>)
      });
      runtime = startedRuntime.runtime;
      await runPiPromptWithFallback({
        piConfigPath: input.piConfigPath,
        initial: startedRuntime,
        createRuntime,
        onEvent: (event) => input.onEvent?.(event as unknown as Record<string, unknown>),
        onRuntimeChanged: (nextRuntime) => {
          runtime = nextRuntime;
          input.onRuntime?.(nextRuntime);
        },
        run: async (activeRuntime) => {
          await activeRuntime.promptUntilSettled(reviewPrompt(task, input.publicationId, requestId), { timeoutMs: piPromptTimeoutMs() });
        }
      });
      await dispatchUpdateAgentTaskPhase(dependency, task.id, 'validating', {}, taskCommandContext(lane, `${task.id}:phase:validating`, task.id, input.workerLeaseId));
      const completed = await dispatchCompleteAgentTask(dependency, task.id, taskCommandContext(lane, `${task.id}:complete`, task.id, input.workerLeaseId));
      return { task: completed, reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getAgentTask(database, task.id);
      if (current?.status === 'running') await dispatchFailAgentTask(dependency, task.id, 'RESULTS_REVIEW_FAILED', message, taskCommandContext(lane, `${task.id}:fail`, task.id, input.workerLeaseId));
      throw error;
    } finally {
      await runtime?.stop().catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  } finally { close(); }
}
import { preparePiExtension } from './pi-extension.ts';
import { piTaskAuthorityPrompt } from './pi-operator-skill.ts';
