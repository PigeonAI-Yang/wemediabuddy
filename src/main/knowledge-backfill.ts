/**
 * WMB-5230：存量高价值 Raw Source 分批回溯编译（backfill scheduler）。
 * Design: docs/spark/2026-08-12-wmb-ai-knowledge-compilation-protocol-design.md
 *         WMB-5228 candidate plan service（计划）→ WMB-5211 compiler（写库）→ WMB-5229
 *         触发接点（ingest）的存量补齐：把「已落库但尚未编译」的存量高价值 Source 分批回溯。
 *
 * 职责：
 *   select（活跃 Topic 关联 + 明确价值信号）→ 冻结当前 revision → 逐 Topic 编译（注入
 *   compile callback；生产接线为 WMB-5228 候选管线 + WMB-5211 编译器 + WMB-5229 同款
 *   requestId）→ checkpoint（app_meta KV：sourceId 稳定游标 + 失败重试队列 + 计数）→
 *   每轮有界（batchLimit 硬上限）、可中断恢复、幂等重跑。
 *
 * 入选不变式（弱资料与无 Topic 的 Source 继续保持 Raw，本模块从不改 source_items）：
 * - 仍在资料库（management_status != 'archived'）；
 * - 至少关联一个非 archived Topic（topic_source_links ⋈ topics.status != 'archived'）；
 * - 至少命中一个明确价值信号（三者之一即可入选）：
 *   - verified：verification_status = 'verified'；
 *   - published_content：Source 被已发布内容使用（content_project_sources → 该项目存在
 *     status='published' 的 publication）；
 *   - high_value：显式高价值状态（priority <= 2 或 value_judgment 非空——与
 *     listRediscovery「高价值但尚未创作」及 legacy-init 候选 1 的 priority<=2 口径一致）；
 * - 非弱资料：有可编译正文（source_body_cache ready 非空 或 summary 非空；与 WMB-5228
 *   freezeKnowledgeSource 的 bodyKind 兜底口径一致）；verification_status='rejected'
 *   （用户已否决可信度）视为弱资料不入选。
 *
 * 幂等与去重：
 * - 每 (source, revision, topic) 使用 WMB-5229 同款稳定 requestId（knowledgeCompileTopicRequestId
 *   = compile:source:{sourceId}:r{revision}:topic:{topicId}），与 ingest 触发共享同一回执面；
 *   编译前按 (workspace_id, request_id) 查已存在回执去重 → 已编译 Topic 跳过，重跑零新增；
 * - 游标按稳定 sourceId 排序推进；中断后 resume 从游标继续（游标前的少量重扫由回执去重兜底，
 *   不重不漏）；
 * - 正式知识写只经 compile callback 内的 compileSourceKnowledge → applyKnowledgeChangeSet。
 *
 * 失败语义：单个 Topic 编译失败 → operation_log 结构化错误证据（command=knowledge.backfill，
 * errorCode=BACKFILL:*），Source 进入 checkpoint.pendingRetry（下次运行优先重试，成功即移出）；
 * 失败不阻断本轮其余 Source，不阻断启动（schedule 与 runKnowledgeBackfillBatch 均为
 * fire-and-forget 有界批次，绝不抛错到调用方之外）。
 *
 * 唯一正式接线点（src/main/index.ts refreshRuntime）：
 *   setKnowledgeBackfillDeps({ databasePath, compileSource: createKnowledgeBackfillCompile(createKnowledgeCompileDeps(root)) })
 *   void runKnowledgeBackfillBatch().catch((error) => console.error('[knowledge-backfill]', error))
 *   teardown：setKnowledgeBackfillDeps(null)
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { broadcastDataChanged } from './data-changed.ts';
import { recordOperation } from './operations.ts';
import { getSource, type SourceRecord } from './sources.ts';
import { getSourceBodyCache } from './source-body-cache.ts';
import { compileSourceKnowledge } from './knowledge-compiler.ts';
import { generateKnowledgeCandidatePlan, type KnowledgeCandidatesModelCall } from './knowledge-candidates.ts';
import { enqueueKnowledgeRouteJob, knowledgeCompileTopicRequestId, wakePersistentKnowledgeJobs } from './knowledge-compile-trigger.ts';

export const KNOWLEDGE_BACKFILL_COMMAND = 'knowledge.backfill';
export const KNOWLEDGE_BACKFILL_ACTOR_LABEL = 'knowledge-backfill';
export const BACKFILL_CHECKPOINT_META_KEY = 'wmb_knowledge_backfill_checkpoint_v1';
export const DEFAULT_BACKFILL_BATCH_LIMIT = 10;
export const MAX_BACKFILL_BATCH_LIMIT = 50;
export const DEFAULT_MAX_TOPICS_PER_SOURCE = 5;
export const MAX_MAX_TOPICS_PER_SOURCE = 20;
const GLOBAL_KEY = '__wmb_knowledge_backfill__';

// ============================================================
// 入选信号 / 评估（纯函数）
// ============================================================

export type BackfillSourceSignal = 'verified' | 'published_content' | 'high_value';
export type BackfillBodyKind = 'body_cache' | 'summary' | 'none';
export type BackfillSkipReason = 'rejected' | 'no_active_topic' | 'weak_material' | 'no_value_signal';

export type BackfillSourceRow = Readonly<{
  sourceId: string;
  revision: number;
  summary: string | null;
  verificationStatus: string;
  priority: number | null;
  valueJudgment: string | null;
  managementStatus: string;
  bodyCacheStatus: string | null;
  extractedText: string | null;
  hasActiveTopic: number;
  usedInPublishedContent: number;
}>;

export type BackfillSourceEvaluation = Readonly<{
  eligible: boolean;
  signals: readonly BackfillSourceSignal[];
  bodyKind: BackfillBodyKind;
  skipReason: BackfillSkipReason | null;
}>;

/** 纯评估：入选 = 非 rejected + 关联活跃 Topic + 非弱资料 + 至少一个明确价值信号。 */
export function evaluateBackfillSource(row: BackfillSourceRow): BackfillSourceEvaluation {
  const signals: BackfillSourceSignal[] = [];
  if (row.verificationStatus === 'verified') signals.push('verified');
  if (row.usedInPublishedContent === 1) signals.push('published_content');
  if ((typeof row.priority === 'number' && row.priority <= 2) || (row.valueJudgment?.trim() ?? '') !== '') signals.push('high_value');
  let bodyKind: BackfillBodyKind = 'none';
  if (row.bodyCacheStatus === 'ready' && (row.extractedText?.trim() ?? '') !== '') bodyKind = 'body_cache';
  else if ((row.summary?.trim() ?? '') !== '') bodyKind = 'summary';
  if (row.verificationStatus === 'rejected') {
    return Object.freeze({ eligible: false, signals: Object.freeze(signals), bodyKind, skipReason: 'rejected' as const });
  }
  if (bodyKind === 'none') {
    return Object.freeze({ eligible: false, signals: Object.freeze(signals), bodyKind, skipReason: 'weak_material' as const });
  }
  if (signals.length === 0) {
    return Object.freeze({ eligible: false, signals: Object.freeze(signals), bodyKind, skipReason: 'no_value_signal' as const });
  }
  if (row.hasActiveTopic !== 1) {
    return Object.freeze({ eligible: false, signals: Object.freeze(signals), bodyKind, skipReason: 'no_active_topic' as const });
  }
  return Object.freeze({ eligible: true, signals: Object.freeze(signals), bodyKind, skipReason: null });
}

const BACKFILL_SCAN_SELECT = `
  SELECT s.id AS sourceId, s.revision AS revision, s.summary AS summary,
    s.verification_status AS verificationStatus, s.priority AS priority,
    s.value_judgment AS valueJudgment, s.management_status AS managementStatus,
    (SELECT c.status FROM source_body_cache c WHERE c.source_id = s.id) AS bodyCacheStatus,
    (SELECT c.extracted_text FROM source_body_cache c WHERE c.source_id = s.id) AS extractedText,
    EXISTS(SELECT 1 FROM topic_source_links l JOIN topics t ON t.id = l.topic_id
      WHERE l.source_id = s.id AND t.status != 'archived') AS hasActiveTopic,
    EXISTS(SELECT 1 FROM content_project_sources cps
      JOIN platform_versions pv ON pv.project_id = cps.project_id
      JOIN publications pub ON pub.platform_version_id = pv.id
      WHERE cps.source_id = s.id AND pub.status = 'published') AS usedInPublishedContent
  FROM source_items s
  WHERE s.management_status != 'archived' AND (? IS NULL OR s.id > ?)
  ORDER BY s.id ASC LIMIT ?`;

function mapSourceRow(row: Record<string, unknown>): BackfillSourceRow {
  return Object.freeze({
    sourceId: String(row.sourceId),
    revision: Number(row.revision),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    verificationStatus: String(row.verificationStatus ?? 'pending'),
    priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
    valueJudgment: row.valueJudgment === null || row.valueJudgment === undefined ? null : String(row.valueJudgment),
    managementStatus: String(row.managementStatus ?? 'active'),
    bodyCacheStatus: row.bodyCacheStatus === null || row.bodyCacheStatus === undefined ? null : String(row.bodyCacheStatus),
    extractedText: row.extractedText === null || row.extractedText === undefined ? null : String(row.extractedText),
    hasActiveTopic: Number(row.hasActiveTopic ?? 0),
    usedInPublishedContent: Number(row.usedInPublishedContent ?? 0)
  });
}

/** 稳定有序扫描页（只读；cursor 为最后一个已扫描 sourceId，'' 表示从头）。 */
export function scanBackfillSourceRows(database: DatabaseSync, cursor: string | null, limit: number): BackfillSourceRow[] {
  const rows = database.prepare(BACKFILL_SCAN_SELECT).all(cursor, cursor, limit) as Array<Record<string, unknown>>;
  return rows.map(mapSourceRow);
}

/** 单 Source 行（失败重试路径复用；与扫描行同构）。 */
function buildSourceRow(database: DatabaseSync, source: SourceRecord): BackfillSourceRow {
  const body = getSourceBodyCache(database, source.id);
  const flags = database.prepare(`
    SELECT
      EXISTS(SELECT 1 FROM topic_source_links l JOIN topics t ON t.id = l.topic_id
        WHERE l.source_id = ? AND t.status != 'archived') AS hasActiveTopic,
      EXISTS(SELECT 1 FROM content_project_sources cps
        JOIN platform_versions pv ON pv.project_id = cps.project_id
        JOIN publications pub ON pub.platform_version_id = pv.id
        WHERE cps.source_id = ? AND pub.status = 'published') AS usedInPublishedContent
  `).get(source.id, source.id) as { hasActiveTopic: number; usedInPublishedContent: number };
  return Object.freeze({
    sourceId: source.id,
    revision: source.revision,
    summary: source.summary,
    verificationStatus: source.verificationStatus,
    priority: source.priority,
    valueJudgment: source.valueJudgment,
    managementStatus: source.managementStatus,
    bodyCacheStatus: body?.status ?? null,
    extractedText: body?.extractedText ?? null,
    hasActiveTopic: Number(flags.hasActiveTopic),
    usedInPublishedContent: Number(flags.usedInPublishedContent)
  });
}

// ============================================================
// checkpoint（app_meta KV；schemaVersion=1；可中断恢复）
// ============================================================

export type BackfillCheckpointCounts = Readonly<{
  scanned: number;
  processed: number;
  compiled: number;
  skippedExistingReceipt: number;
  skippedWeak: number;
  skippedNoTopic: number;
  skippedNoSignal: number;
  failed: number;
}>;

export type BackfillCheckpoint = Readonly<{
  schemaVersion: 1;
  runId: string;
  workspaceId: string;
  /** 稳定 sourceId 游标：最后一个已扫描的 Source（'' = 从头）。 */
  cursor: string;
  /** 编译失败待重试的 Source id（有序；下次运行优先重试）。 */
  pendingRetry: readonly string[];
  status: 'running' | 'completed';
  step: number;
  counts: BackfillCheckpointCounts;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

function emptyCounts(): BackfillCheckpointCounts {
  return Object.freeze({ scanned: 0, processed: 0, compiled: 0, skippedExistingReceipt: 0, skippedWeak: 0, skippedNoTopic: 0, skippedNoSignal: 0, failed: 0 });
}

function freshCheckpoint(workspaceId: string): BackfillCheckpoint {
  const nowIso = new Date().toISOString();
  return Object.freeze({
    schemaVersion: 1,
    runId: `backfill-${Date.now()}-${randomUUID().slice(0, 8)}`,
    workspaceId,
    cursor: '',
    pendingRetry: Object.freeze([]),
    status: 'running',
    step: 0,
    counts: emptyCounts(),
    startedAt: nowIso,
    updatedAt: nowIso,
    completedAt: null
  });
}

export function getKnowledgeBackfillCheckpoint(database: DatabaseSync): BackfillCheckpoint | null {
  let row: { value: string } | undefined;
  try {
    row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(BACKFILL_CHECKPOINT_META_KEY) as { value: string } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as BackfillCheckpoint;
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.runId || !parsed.workspaceId || !parsed.counts) return null;
    return Object.freeze({
      ...parsed,
      pendingRetry: Object.freeze([...(parsed.pendingRetry ?? [])]),
      counts: Object.freeze({ ...emptyCounts(), ...parsed.counts })
    });
  } catch {
    return null;
  }
}

function saveCheckpoint(database: DatabaseSync, checkpoint: BackfillCheckpoint): void {
  const value = JSON.stringify(checkpoint);
  const nowIso = new Date().toISOString();
  const existing = database.prepare('SELECT revision FROM app_meta WHERE key = ?').get(BACKFILL_CHECKPOINT_META_KEY) as { revision: number } | undefined;
  if (existing) {
    database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?')
      .run(value, nowIso, BACKFILL_CHECKPOINT_META_KEY);
  } else {
    database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
      .run(BACKFILL_CHECKPOINT_META_KEY, value, nowIso, nowIso);
  }
}

export function clearKnowledgeBackfillCheckpoint(database: DatabaseSync): boolean {
  const existing = database.prepare('SELECT 1 AS one FROM app_meta WHERE key = ?').get(BACKFILL_CHECKPOINT_META_KEY);
  if (!existing) return false;
  database.prepare('DELETE FROM app_meta WHERE key = ?').run(BACKFILL_CHECKPOINT_META_KEY);
  return true;
}

// ============================================================
// compile callback（依赖注入；接口是实际可执行依赖，不是 stub）
// ============================================================

export type BackfillTopicCompile = Readonly<{ topicId: string; requestId: string }>;

export type BackfillCompileInput = Readonly<{
  workspaceId: string;
  sourceId: string;
  revision: number;
  /** 只包含「尚无回执」的 Topic（模块已按 (workspace_id, request_id) 去重）。 */
  topics: readonly BackfillTopicCompile[];
}>;

export type BackfillTopicOutcome = Readonly<{
  topicId: string;
  requestId: string;
  result: 'ok' | 'error';
  replay?: boolean;
  code?: string;
  message?: string;
}>;

export type BackfillCompileOutcome = Readonly<{
  topics: readonly BackfillTopicOutcome[];
  /** 回调级失败（连接/整体异常）：逐 Topic 视为失败。 */
  error?: Readonly<{ code: string; message: string }>;
}>;

export type BackfillCompileCall = (input: BackfillCompileInput) => Promise<BackfillCompileOutcome>;

export type KnowledgeBackfillDeps = Readonly<{
  databasePath: string;
  compileSource: BackfillCompileCall;
  openDatabase?: (databasePath: string) => DatabaseSync;
}>;

// ============================================================
// 步骤结果类型
// ============================================================

export type BackfillSourceStatus =
  | 'compiled'
  | 'partial'
  | 'failed'
  | 'skipped_existing_receipt'
  | 'skipped_weak'
  | 'skipped_no_topic'
  | 'skipped_no_signal';

export type BackfillSourceOutcome = Readonly<{
  sourceId: string;
  revision: number;
  status: BackfillSourceStatus;
  signals: readonly BackfillSourceSignal[];
  topics: readonly BackfillTopicOutcome[];
  error?: Readonly<{ code: string; message: string }>;
}>;

export type BackfillStepInput = Readonly<{
  workspaceId?: string;
  /** 每轮处理的 Source 硬上限（默认 10；上限 50）。 */
  batchLimit?: number;
  /** 每 Source 最多编译的活跃 Topic 数（默认 5；上限 20，与 WMB-5229 一致）。 */
  maxTopicsPerSource?: number;
  /** true（默认）：已有 running checkpoint 则续跑；false：强制新一轮。 */
  resume?: boolean;
}>;

export type BackfillStepResult = Readonly<{
  runId: string;
  workspaceId: string | null;
  /** true = 本轮扫描耗尽且无待重试（本 run 完成）。 */
  done: boolean;
  processed: number;
  outcomes: readonly BackfillSourceOutcome[];
  checkpoint: BackfillCheckpoint;
  broadcast: boolean;
}>;

// ============================================================
// 工具
// ============================================================

function readBoundWorkspaceId(database: DatabaseSync): string | null {
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function errorInfo(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error ?? '');
  let code = 'BACKFILL_UNEXPECTED';
  if (error && typeof error === 'object' && 'code' in error) {
    const raw = (error as { code: unknown }).code;
    if (typeof raw === 'string' && raw.trim()) code = raw;
  }
  return { code, message };
}

function recordBackfillOperation(database: DatabaseSync, input: {
  sourceId: string;
  topicId: string | null;
  revision: number;
  result: 'ok' | 'error';
  code?: string;
}): void {
  recordOperation(database, {
    actorType: 'scheduler',
    clientLabel: KNOWLEDGE_BACKFILL_ACTOR_LABEL,
    command: KNOWLEDGE_BACKFILL_COMMAND,
    entityType: 'knowledge_compile',
    entityId: input.topicId ? `${input.sourceId}:${input.topicId}` : input.sourceId,
    beforeRevision: input.revision,
    afterRevision: input.revision,
    result: input.result,
    errorCode: input.code
  });
}

function activeLinkedTopics(database: DatabaseSync, sourceId: string, limit: number): string[] {
  const rows = database.prepare(
    `SELECT l.topic_id AS topicId FROM topic_source_links l
     JOIN topics t ON t.id = l.topic_id
     WHERE l.source_id = ? AND t.status != 'archived'
     ORDER BY t.last_seen_at DESC, t.id DESC LIMIT ?`
  ).all(sourceId, limit) as Array<{ topicId: string }>;
  return rows.map((row) => String(row.topicId));
}

/** 内部可变计数（checkpoint counts 的累积器；最终 Object.freeze 返回只读类型）。 */
type MutableBackfillCounts = {
  scanned: number;
  processed: number;
  compiled: number;
  skippedExistingReceipt: number;
  skippedWeak: number;
  skippedNoTopic: number;
  skippedNoSignal: number;
  failed: number;
};

/** 按 outcome 累加 checkpoint 计数（scanned/processed + 状态分类）。 */
function accumulateCounts(counts: BackfillCheckpointCounts, outcome: BackfillSourceOutcome, processedFlag: boolean): BackfillCheckpointCounts {
  const next: MutableBackfillCounts = { ...counts, scanned: counts.scanned + 1 };
  if (processedFlag) next.processed += 1;
  switch (outcome.status) {
    case 'compiled':
    case 'partial':
      next.compiled += 1;
      break;
    case 'failed':
      next.failed += 1;
      break;
    case 'skipped_existing_receipt':
      next.skippedExistingReceipt += 1;
      break;
    case 'skipped_weak':
      next.skippedWeak += 1;
      break;
    case 'skipped_no_topic':
      next.skippedNoTopic += 1;
      break;
    case 'skipped_no_signal':
      next.skippedNoSignal += 1;
      break;
  }
  return Object.freeze(next);
}

/** 与已存在 receipt 去重：(workspace_id, request_id) 唯一（compiler store 幂等键同源）。 */
function topicReceiptExists(database: DatabaseSync, workspaceId: string, requestId: string): boolean {
  const row = database.prepare(
    'SELECT 1 AS one FROM knowledge_update_receipts WHERE workspace_id = ? AND request_id = ? LIMIT 1'
  ).get(workspaceId, requestId) as { one: number } | undefined;
  return Boolean(row);
}

// ============================================================
// 单 Source 处理（扫描与失败重试共用）
// ============================================================

async function processSource(
  database: DatabaseSync,
  deps: KnowledgeBackfillDeps,
  ctx: { workspaceId: string; row: BackfillSourceRow; maxTopics: number }
): Promise<{ outcome: BackfillSourceOutcome; broadcast: boolean; retry: boolean; processed: boolean }> {
  const { workspaceId, row, maxTopics } = ctx;
  const { sourceId, revision } = row;
  const evaluation = evaluateBackfillSource(row);
  if (!evaluation.eligible) {
    const skipStatus: BackfillSourceStatus = evaluation.skipReason === 'no_active_topic'
      ? 'skipped_no_topic'
      : (evaluation.skipReason === 'weak_material' || evaluation.skipReason === 'rejected') ? 'skipped_weak' : 'skipped_no_signal';
    if (evaluation.skipReason === 'no_active_topic') {
      enqueueKnowledgeRouteJob(database, { sourceId, revision });
      wakePersistentKnowledgeJobs();
    }
    return Object.freeze({
      outcome: Object.freeze({ sourceId, revision, status: skipStatus, signals: evaluation.signals, topics: Object.freeze([]) }),
      broadcast: false,
      retry: false,
      processed: evaluation.skipReason === 'no_active_topic'
    });
  }

  // 有界 Topic 列表 + 回执去重：只编译尚无回执的 (source, revision, topic)。
  const topicIds = activeLinkedTopics(database, sourceId, maxTopics);
  const topicsToCompile: BackfillTopicCompile[] = [];
  for (const topicId of topicIds) {
    const requestId = knowledgeCompileTopicRequestId(sourceId, revision, topicId);
    if (!topicReceiptExists(database, workspaceId, requestId)) topicsToCompile.push({ topicId, requestId });
  }
  if (topicsToCompile.length === 0) {
    return Object.freeze({
      outcome: Object.freeze({ sourceId, revision, status: 'skipped_existing_receipt', signals: evaluation.signals, topics: Object.freeze([]) }),
      broadcast: false,
      retry: false,
      processed: true
    });
  }

  const compileOutcome = await deps.compileSource({ workspaceId, sourceId, revision, topics: topicsToCompile });
  const byTopic = new Map<string, BackfillTopicOutcome>(compileOutcome.topics.map((topic) => [topic.topicId, topic]));
  const topicOutcomes: BackfillTopicOutcome[] = [];
  let okCount = 0;
  let failCount = 0;
  for (const topic of topicsToCompile) {
    let result = byTopic.get(topic.topicId);
    if (!result) {
      // 回调未返回该 Topic 结果 → 视为失败（fail-closed，证据可见）。
      result = Object.freeze({
        topicId: topic.topicId,
        requestId: topic.requestId,
        result: 'error' as const,
        code: 'BACKFILL:INCOMPLETE_TOPIC_RESULTS',
        message: 'compile callback 未返回该 Topic 的编译结果。'
      });
    }
    topicOutcomes.push(result);
    if (result.result === 'ok') okCount += 1;
    else failCount += 1;
    recordBackfillOperation(database, {
      sourceId,
      topicId: topic.topicId,
      revision,
      result: result.result,
      code: result.result === 'error' ? result.code : undefined
    });
  }
  if (compileOutcome.error && okCount === 0) {
    // 回调级失败且无任何 Topic 成功：把缺失 Topic 一并落失败证据。
    for (const topic of topicsToCompile) {
      if (!byTopic.has(topic.topicId)) {
        recordBackfillOperation(database, { sourceId, topicId: topic.topicId, revision, result: 'error', code: compileOutcome.error.code });
      }
    }
    failCount = topicsToCompile.length;
    okCount = 0;
  }
  const status: BackfillSourceStatus = okCount === 0 ? 'failed' : failCount === 0 ? 'compiled' : 'partial';
  const outcome: BackfillSourceOutcome = Object.freeze({
    sourceId,
    revision,
    status,
    signals: evaluation.signals,
    topics: Object.freeze(topicOutcomes),
    ...(status === 'failed' && compileOutcome.error ? { error: compileOutcome.error } : {})
  });
  return Object.freeze({ outcome, broadcast: okCount > 0, retry: failCount > 0, processed: true });
}

// ============================================================
// 主入口：单步有界回溯（checkpoint 读改写）
// ============================================================

export async function runKnowledgeBackfillStep(
  database: DatabaseSync,
  deps: KnowledgeBackfillDeps,
  rawInput: BackfillStepInput = {}
): Promise<BackfillStepResult> {
  const workspaceId = rawInput.workspaceId ?? readBoundWorkspaceId(database);
  if (!workspaceId) {
    // 无工作空间身份（未激活的精简 fixture）→ 零扫描零写；不视为失败。
    const nowIso = new Date().toISOString();
    const synthetic: BackfillCheckpoint = Object.freeze({
      schemaVersion: 1,
      runId: 'no-workspace',
      workspaceId: '',
      cursor: '',
      pendingRetry: Object.freeze([]),
      status: 'completed',
      step: 0,
      counts: emptyCounts(),
      startedAt: nowIso,
      updatedAt: nowIso,
      completedAt: nowIso
    });
    return Object.freeze({ runId: synthetic.runId, workspaceId: null, done: true, processed: 0, outcomes: Object.freeze([]), checkpoint: synthetic, broadcast: false });
  }
  const batchLimit = Math.min(Math.max(rawInput.batchLimit ?? DEFAULT_BACKFILL_BATCH_LIMIT, 1), MAX_BACKFILL_BATCH_LIMIT);
  const maxTopics = Math.min(Math.max(rawInput.maxTopicsPerSource ?? DEFAULT_MAX_TOPICS_PER_SOURCE, 1), MAX_MAX_TOPICS_PER_SOURCE);
  const resume = rawInput.resume !== false;

  let checkpoint = getKnowledgeBackfillCheckpoint(database);
  if (checkpoint && checkpoint.workspaceId !== workspaceId) {
    throw Object.assign(new Error(`回溯编译 checkpoint 属于工作空间 ${checkpoint.workspaceId}，与当前 ${workspaceId} 不一致。`), {
      code: 'BACKFILL_WORKSPACE_MISMATCH',
      details: { checkpointWorkspaceId: checkpoint.workspaceId, workspaceId }
    });
  }
  // 无 checkpoint（首跑）或已完成（新一轮）：从头开始。已完成的旧游标对「游标之前新增的
  // UUID 排序 Source」不构成覆盖保证，新一轮以空游标 + 回执去重保证零新增。
  if (!checkpoint || checkpoint.status === 'completed') {
    checkpoint = freshCheckpoint(workspaceId);
  }

  let counts: BackfillCheckpointCounts = { ...checkpoint.counts };
  let cursor = checkpoint.cursor;
  let nextPendingRetry: string[] = [...checkpoint.pendingRetry];
  const outcomes: BackfillSourceOutcome[] = [];
  let broadcast = false;
  let processed = 0;
  let scanExhausted = false;

  // ---- 1) 失败重试优先（cap = max(1, floor(batch/2))，保证新扫描总能推进，重试不饿死扫描） ----
  const retryCap = Math.max(1, Math.floor(batchLimit / 2));
  const retryIds = nextPendingRetry.slice(0, retryCap);
  nextPendingRetry = nextPendingRetry.slice(retryCap);
  for (const sourceId of retryIds) {
    if (processed >= batchLimit) { nextPendingRetry.push(sourceId); continue; }
    const source = getSource(database, sourceId);
    if (!source || source.managementStatus === 'archived') continue; // 已不存在/已移出 → 移出重试队列
    const result = await processSource(database, deps, { workspaceId, row: buildSourceRow(database, source), maxTopics });
    outcomes.push(result.outcome);
    counts = accumulateCounts(counts, result.outcome, result.processed);
    if (result.processed) processed += 1;
    if (result.broadcast) broadcast = true;
    if (result.retry) nextPendingRetry.push(sourceId);
  }

  // ---- 2) 有序扫描：稳定 sourceId 游标推进；每轮只处理 batchLimit 个 Source（硬上限） ----
  if (processed < batchLimit) {
    const scanLimit = batchLimit - processed;
    let pageCursor: string | null = cursor === '' ? null : cursor;
    let processedThisStep = 0;
    while (processedThisStep < scanLimit) {
      const pageSize = Math.max(scanLimit * 2, 8);
      const rows = scanBackfillSourceRows(database, pageCursor, pageSize);
      if (!rows.length) { scanExhausted = true; break; }
      for (const row of rows) {
        pageCursor = row.sourceId;
        const result = await processSource(database, deps, { workspaceId, row, maxTopics });
        outcomes.push(result.outcome);
        counts = accumulateCounts(counts, result.outcome, result.processed);
        if (result.processed) { processed += 1; processedThisStep += 1; }
        if (result.broadcast) broadcast = true;
        if (result.retry) nextPendingRetry.push(row.sourceId);
        if (processedThisStep >= scanLimit) break;
      }
      if (rows.length < pageSize && processedThisStep < scanLimit) { scanExhausted = true; break; }
    }
    if (pageCursor !== null) cursor = pageCursor;
  }

  // ---- done：无待重试 且 扫描耗尽（未扫描时以单行探针判定，避免 completed run 悬空） ----
  const done = nextPendingRetry.length === 0 && (scanExhausted || scanBackfillSourceRows(database, cursor === '' ? null : cursor, 1).length === 0);
  const nowIso = new Date().toISOString();
  const updatedCheckpoint: BackfillCheckpoint = Object.freeze({
    schemaVersion: 1,
    runId: checkpoint.runId,
    workspaceId,
    cursor,
    pendingRetry: Object.freeze(nextPendingRetry),
    status: done ? 'completed' : 'running',
    step: checkpoint.step + 1,
    counts: Object.freeze(counts),
    startedAt: checkpoint.startedAt,
    updatedAt: nowIso,
    completedAt: done ? nowIso : null
  });
  saveCheckpoint(database, updatedCheckpoint);
  if (broadcast) broadcastDataChanged({ scopes: ['knowledge', 'topics', 'receipt'], reason: 'knowledge.backfill' });
  return Object.freeze({
    runId: updatedCheckpoint.runId,
    workspaceId,
    done,
    processed,
    outcomes: Object.freeze(outcomes),
    checkpoint: updatedCheckpoint,
    broadcast
  });
}

// ============================================================
// 生产 compile adapter（真实管线：WMB-5228 候选 → WMB-5211 编译器）
// 与 WMB-5229 compileTopic 同构：同 requestId、同 trigger/createdBy、同错误码前缀。
// 独立连接（deps.openDatabase；默认 DatabaseSync），与运行时连接隔离。
// ============================================================

export type KnowledgeBackfillCompileDeps = Readonly<{
  databasePath: string;
  modelCall: KnowledgeCandidatesModelCall;
  openDatabase?: (databasePath: string) => DatabaseSync;
}>;

export function createKnowledgeBackfillCompile(deps: KnowledgeBackfillCompileDeps): BackfillCompileCall {
  const open = deps.openDatabase ?? ((databasePath: string) => new DatabaseSync(databasePath));
  return async (input: BackfillCompileInput): Promise<BackfillCompileOutcome> => {
    let database: DatabaseSync | null = null;
    try {
      database = open(deps.databasePath);
      const topics: BackfillTopicOutcome[] = [];
      for (const { topicId, requestId } of input.topics) {
        try {
          const planResult = await generateKnowledgeCandidatePlan(database, {
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            topicId,
            createdBy: 'background_agent',
            triggerSource: 'ingest',
            sourceNature: 'primary_source',
            modelCall: deps.modelCall
          });
          if (!planResult.ok) {
            topics.push(Object.freeze({
              topicId, requestId, result: 'error' as const,
              code: `BACKFILL:PLAN:${planResult.error.code}`, message: planResult.error.message
            }));
            continue;
          }
          const compiled = compileSourceKnowledge(database, { ...planResult.plan, requestId });
          topics.push(Object.freeze({ topicId, requestId, result: 'ok' as const, replay: compiled.replay }));
        } catch (error) {
          const info = errorInfo(error);
          topics.push(Object.freeze({
            topicId, requestId, result: 'error' as const,
            code: `BACKFILL:COMPILE:${info.code}`, message: info.message
          }));
        }
      }
      return Object.freeze({ topics: Object.freeze(topics) });
    } catch (error) {
      const info = errorInfo(error);
      return Object.freeze({ topics: Object.freeze([]), error: Object.freeze({ code: `BACKFILL:ABORTED:${info.code}`, message: info.message }) });
    } finally {
      try { database?.close(); } catch { /* 关闭失败不影响结果 */ }
    }
  };
}

// ============================================================
// 调度面（与 WMB-5229 同构：全局 deps 注册 + 单飞有界批次；不阻断启动）
// ============================================================

type BackfillState = {
  deps: KnowledgeBackfillDeps | null;
  inflight: Map<string, Promise<unknown>>;
};

function state(): BackfillState {
  const globalRef = globalThis as typeof globalThis & { [GLOBAL_KEY]?: BackfillState };
  if (!globalRef[GLOBAL_KEY]) globalRef[GLOBAL_KEY] = { deps: null, inflight: new Map() };
  return globalRef[GLOBAL_KEY]!;
}

export function setKnowledgeBackfillDeps(deps: KnowledgeBackfillDeps | null): void {
  state().deps = deps;
}

/** 停止接收新的全局回溯调度，并等待当前批次完成后再允许关闭/切换数据根。 */
export async function stopKnowledgeBackfillJobs(): Promise<void> {
  state().deps = null;
  await drainKnowledgeBackfillQueue();
}

export function getKnowledgeBackfillDeps(): KnowledgeBackfillDeps | null {
  return state().deps;
}

export function knowledgeBackfillInFlight(): number {
  return state().inflight.size;
}

/** 等待全部在飞回溯批次结束（测试 / 关闭）。 */
export async function drainKnowledgeBackfillQueue(): Promise<void> {
  for (;;) {
    const inflight = [...state().inflight.values()];
    if (!inflight.length) return;
    await Promise.allSettled(inflight);
  }
}

/** 显式 deps 调度（测试 / 绕过全局注册）：有界单批，单飞去重；后台失败吞掉并打日志。 */
export function scheduleKnowledgeBackfillWith(deps: KnowledgeBackfillDeps): boolean {
  const inflight = state().inflight;
  const key = '__backfill_step__';
  if (inflight.has(key)) return false;
  const started = Promise.resolve().then(() => runKnowledgeBackfillBatchWith(deps))
    .catch((error) => { console.error('[knowledge-backfill] background step failed', error); });
  inflight.set(key, started);
  void started.finally(() => {
    if (inflight.get(key) === started) inflight.delete(key);
  });
  return true;
}

/** 使用全局注册 deps 调度（生产接点统一入口）；未配置 deps 时不调度（返回 false）。 */
export function scheduleKnowledgeBackfill(): boolean {
  const deps = state().deps;
  if (!deps) return false;
  return scheduleKnowledgeBackfillWith(deps);
}

/** 独立连接跑一步有界回溯（启动接线：fire-and-forget 单批，失败由调用方记录）。 */
export async function runKnowledgeBackfillBatchWith(deps: KnowledgeBackfillDeps): Promise<BackfillStepResult> {
  const open = deps.openDatabase ?? ((databasePath: string) => new DatabaseSync(databasePath));
  let database: DatabaseSync | null = null;
  try {
    database = open(deps.databasePath);
    return await runKnowledgeBackfillStep(database, deps, {});
  } finally {
    try { database?.close(); } catch { /* 关闭失败不影响结果 */ }
  }
}

/** 启动/恢复入口（要求已 setKnowledgeBackfillDeps；单批有界，checkpoint 续跑）。 */
export async function runKnowledgeBackfillBatch(): Promise<BackfillStepResult> {
  const deps = state().deps;
  if (!deps) throw Object.assign(new Error('回溯编译依赖未注册（setKnowledgeBackfillDeps）。'), { code: 'BACKFILL_DEPS_NOT_REGISTERED' });
  return runKnowledgeBackfillBatchWith(deps);
}
