/**
 * WMB-5229：Source 保存后的生产知识编译触发（shared post-save trigger）。
 * Design: docs/spark/2026-08-12-wmb-ai-knowledge-compilation-protocol-design.md
 *         WMB-5228 candidate plan service（计划生成）→ WMB-5211 compiler（写库）的触发接点。
 *
 * 职责：Source 保存事务成功并返回后，异步（fire-and-forget）把该 sourceId+revision 的
 * 已关联 Topic（topic_source_links）逐个有界编译进知识库：
 *   schedule →（下一微任务）冻结 revision → 解析 topic_source_links → 每个 Topic：
 *     generateKnowledgeCandidatePlan（WMB-5228，注入 modelCall）→ compileSourceKnowledge
 *     （compiler 文档明确的「已冻结在旧 revision 的计划」入口：断言 sourceRevision + requestId）。
 *
 * 不变式：
 * - 保存先返回：schedule* 只注册并立即返回，编译在微任务后执行；失败不回滚 Source；
 * - 冻结：编译前重读 source_items 当前 revision；与触发 revision 不一致 → SOURCE_REVISION_STALE
 *   结构化失败证据（零写），绝不把旧 revision 计划编译进新 revision；
 * - 幂等/去重：并发去重键 (sourceId, revision)；每个 (source, revision, topic) 使用稳定
 *   requestId（knowledgeCompileTopicRequestId）→ store (workspace_id, request_id, inputHash)
 *   重放零增量。compiler 的 store 对 (workspace_id, request_id) 有唯一约束，故多 Topic 必须
 *   按 topic 派生 requestId，不能共享 sourceCompileRequestId（否则第二个 Topic 触发
 *   REQUEST_REPLAY_CONFLICT）；
 * - 有界：每 Source 最多编译前 N（maxTopicsPerSource，默认 5）个已关联 Topic；候选上下文
 *   本身已有 KNOWLEDGE_CANDIDATES_CONTEXT_LIMIT 上限；
 * - 失败隔离：单个 Topic 计划/编译失败只落结构化 operation（entityType=knowledge_compile，
 *   error_code=STAGE:CODE），不阻断其余 Topic；compiler 校验与事务保证失败零写（无半写知识）；
 * - 证据：成功/失败均写 operation_log（可读证据，禁止静默）；成功另由 compiler 持久化
 *   knowledge_update_receipts（trigger_type=ingest）；
 * - 成功广播：至少一个 Topic 编译成功 → dataChanged { knowledge, topics, receipt }。
 *
 * 编译连接：异步编译使用独立 DatabaseSync（deps.openDatabase 注入；默认 DatabaseSync(databasePath)），
 * 与运行时连接隔离（写护栏 / runtime 关闭不影响后台编译）。
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { broadcastDataChanged } from './data-changed.ts';
import { recordOperation } from './operations.ts';
import { generateKnowledgeCandidatePlan, type KnowledgeCandidatesModelCall } from './knowledge-candidates.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from './knowledge-compiler.ts';
import { getSource } from './sources.ts';
import { linkTopicSource } from './knowledge.ts';
import { applyKnowledgeChangeSet } from './knowledge-flywheel.ts';
import { findHistoricalKnowledgeSources, reactivationJobDedupeKey, type KnowledgeReactivationJobInput } from './knowledge-reactivation.ts';
import { resolveKnowledgeRoute, type KnowledgeRouteResult } from './knowledge-routing.ts';

export const KNOWLEDGE_COMPILE_COMMAND = 'knowledge.compile_source';
export const KNOWLEDGE_ROUTE_JOB_KIND = 'knowledge_route';
export const KNOWLEDGE_COMPILE_JOB_KIND = 'knowledge_compile';
export const KNOWLEDGE_REACTIVATION_JOB_KIND = 'knowledge_reactivate_sources';
export const KNOWLEDGE_COMPILE_ACTOR_LABEL = 'knowledge-compile';
export const DEFAULT_MAX_TOPICS_PER_SOURCE = 5;
export const DEFAULT_PERSISTENT_JOB_STALE_AFTER_MS = 5 * 60_000;
const GLOBAL_KEY = '__wmb_source_knowledge_compile_trigger__';

export type SourceKnowledgeCompileDeps = Readonly<{
  /** 工作空间 wmb.db 绝对路径（异步编译连接用）。 */
  databasePath: string;
  /** WMB-5228 候选计划模型调用注入：输入冻结 prompt，返回原始文本（含 ```json 围栏块）。 */
  modelCall: KnowledgeCandidatesModelCall;
  /** 每 Source 最多编译前 N 个已关联 Topic（有界；默认 5，上限 20）。 */
  maxTopicsPerSource?: number;
  /** 只有运行超过该时长的任务才会在启动恢复时被回收。 */
  runningJobStaleAfterMs?: number;
  /** 异步连接工厂覆盖（测试注入 migrateDatabase 等）；默认 DatabaseSync(databasePath)。 */
  openDatabase?: (databasePath: string) => DatabaseSync;
}>;

export type SourceKnowledgeCompileInput = Readonly<{
  sourceId: string;
  revision: number;
  topicId?: string;
}>;

export type TopicCompileOutcome = Readonly<{
  topicId: string;
  requestId: string;
  result: 'ok' | 'error';
  /** 重放：true = store 幂等重放（零新增行）。 */
  replay?: boolean;
  code?: string;
  message?: string;
}>;

export type SourceKnowledgeCompileRun = Readonly<{
  sourceId: string;
  sourceRevision: number;
  workspaceId: string | null;
  topics: readonly TopicCompileOutcome[];
  failed: Readonly<{ code: string; message: string }> | null;
  broadcast: boolean;
}>;

type TriggerState = {
  deps: SourceKnowledgeCompileDeps | null;
  inflight: Map<string, Promise<unknown>>;
  persistentDrain: { deps: SourceKnowledgeCompileDeps; promise: Promise<void>; rerun: boolean; recover: boolean } | null;
  persistentError: { code: string; message: string } | null;
};

function state(): TriggerState {
  const globalRef = globalThis as typeof globalThis & { [GLOBAL_KEY]?: TriggerState };
  if (!globalRef[GLOBAL_KEY]) {
    globalRef[GLOBAL_KEY] = { deps: null, inflight: new Map(), persistentDrain: null, persistentError: null };
  }
  return globalRef[GLOBAL_KEY]!;
}

/** 同 (source, revision, topic) 稳定幂等键；多 Topic 必须派生（store 对 (workspace_id, request_id) 唯一）。 */
export function knowledgeCompileTopicRequestId(sourceId: string, sourceRevision: number, topicId: string): string {
  return `${sourceCompileRequestId(sourceId, sourceRevision)}:topic:${topicId}`;
}

export function setSourceKnowledgeCompileDeps(deps: SourceKnowledgeCompileDeps | null): void {
  state().deps = deps;
  if (deps) startPersistentDrain(deps, true);
}

export function getSourceKnowledgeCompileDeps(): SourceKnowledgeCompileDeps | null {
  return state().deps;
}

export function getPersistentKnowledgeJobError(): Readonly<{ code: string; message: string }> | null {
  return state().persistentError;
}

export function wakePersistentKnowledgeJobs(): boolean {
  const deps = state().deps;
  if (!deps) return false;
  startPersistentDrain(deps, false);
  return true;
}

/** 停止接收新唤醒，并等待当前数据根的持久任务安全收口后再允许 runtime 关闭/切根。 */
export async function stopPersistentKnowledgeJobs(): Promise<void> {
  const currentState = state();
  const current = currentState.persistentDrain;
  if (current) {
    current.rerun = false;
    current.recover = false;
  }
  currentState.deps = null;
  if (current) await current.promise;
}

export function sourceKnowledgeCompileInFlight(): number {
  return state().inflight.size;
}

/** 等待全部在飞编译结束（测试 / 关闭）。 */
export async function drainSourceKnowledgeCompileQueue(): Promise<void> {
  for (;;) {
    const inflight = [...state().inflight.values()];
    const persistent = state().persistentDrain?.promise;
    if (persistent) inflight.push(persistent);
    if (!inflight.length) return;
    await Promise.allSettled(inflight);
  }
}

/** 使用全局注册 deps 调度（生产接点统一入口）；未配置 deps 时不调度（返回 false）。 */
export function scheduleSourceKnowledgeCompile(input: SourceKnowledgeCompileInput): boolean {
  const deps = state().deps;
  if (!deps) return false;
  return scheduleSourceKnowledgeCompileWith(deps, input);
}

/** Enqueue on the caller's transaction; kickSourceKnowledgeCompileQueue starts the post-commit drain. */
export function enqueueSourceKnowledgeCompile(database: DatabaseSync, input: SourceKnowledgeCompileInput): boolean {
  if (!state().deps) return false;
  return enqueueKnowledgeRouteJob(database, input);
}

/** Start draining jobs already committed by a caller-owned transaction. */
export function kickSourceKnowledgeCompileQueue(): boolean {
  const deps = state().deps;
  if (!deps) return false;
  void startPersistentDrain(deps, false);
  return true;
}

/** 显式 deps 调度（测试 / 绕过全局注册）。并发同键去重：已注册在飞 → false。 */
export function scheduleSourceKnowledgeCompileWith(deps: SourceKnowledgeCompileDeps, input: SourceKnowledgeCompileInput): boolean {
  const open = deps.openDatabase ?? ((databasePath: string) => new DatabaseSync(databasePath));
  const database = open(deps.databasePath);
  let inserted = false;
  try { inserted = enqueueKnowledgeRouteJob(database, input); } finally { database.close(); }
  if (!inserted) return false;
  const key = `${input.sourceId}@r${input.revision}`;
  const inflight = state().inflight;
  if (inflight.has(key)) return false;
  const started = startPersistentDrain(deps, false);
  inflight.set(key, started);
  void started.then(() => {
    if (inflight.get(key) === started) inflight.delete(key);
  }, () => {
    if (inflight.get(key) === started) inflight.delete(key);
  });
  return true;
}

function jobDedupe(kind: string, input: SourceKnowledgeCompileInput): string {
  return `${kind}:${input.sourceId}:r${input.revision}${input.topicId ? `:topic:${input.topicId}` : ''}`;
}

function enqueueJob(database: DatabaseSync, kind: string, input: SourceKnowledgeCompileInput): boolean {
  const now = new Date().toISOString();
  const result = database.prepare(`INSERT OR IGNORE INTO jobs
    (id,kind,status,due_at,attempts,dedupe_key,payload_json,last_error,created_at,updated_at,started_at,finished_at)
    VALUES(?,?,'pending',?,0,?,?,NULL,?,?,NULL,NULL)`)
    .run(randomUUID(), kind, now, jobDedupe(kind, input), JSON.stringify(input), now, now);
  return Number(result.changes ?? 0) === 1;
}

export function enqueueKnowledgeRouteJob(database: DatabaseSync, input: SourceKnowledgeCompileInput): boolean {
  return enqueueJob(database, KNOWLEDGE_ROUTE_JOB_KIND, { sourceId: input.sourceId, revision: input.revision });
}

export function enqueueKnowledgeCompileJob(database: DatabaseSync, input: SourceKnowledgeCompileInput & { topicId: string }): boolean {
  return enqueueJob(database, KNOWLEDGE_COMPILE_JOB_KIND, input);
}

export function enqueueKnowledgeReactivationJob(database: DatabaseSync, input: KnowledgeReactivationJobInput): boolean {
  const now = new Date().toISOString();
  const result = database.prepare(`INSERT OR IGNORE INTO jobs
    (id,kind,status,due_at,attempts,dedupe_key,payload_json,last_error,created_at,updated_at,started_at,finished_at)
    VALUES(?,?,'pending',?,0,?,?,NULL,?,?,NULL,NULL)`)
    .run(randomUUID(), KNOWLEDGE_REACTIVATION_JOB_KIND, now, reactivationJobDedupeKey(input), JSON.stringify(input), now, now);
  return Number(result.changes ?? 0) === 1;
}

type PersistentJobRow = { id: string; kind: string; attempts: number; payloadJson: string };

function claimJob(database: DatabaseSync): PersistentJobRow | null {
  const now = new Date().toISOString();
  const row = database.prepare(`SELECT id,kind,attempts,payload_json AS payloadJson FROM jobs
    WHERE kind IN (?,?,?) AND status='pending' AND due_at<=? ORDER BY due_at,id LIMIT 1`)
    .get(KNOWLEDGE_ROUTE_JOB_KIND, KNOWLEDGE_COMPILE_JOB_KIND, KNOWLEDGE_REACTIVATION_JOB_KIND, now) as PersistentJobRow | undefined;
  if (!row) return null;
  const claimed = database.prepare(`UPDATE jobs SET status='running',attempts=attempts+1,started_at=?,updated_at=?
    WHERE id=? AND status='pending' AND attempts=?`).run(now, now, row.id, row.attempts);
  return Number(claimed.changes ?? 0) === 1 ? row : null;
}

function settleJob(database: DatabaseSync, id: string, status: 'succeeded' | 'failed' | 'needs_user', payload: unknown, error: string | null): void {
  const now = new Date().toISOString();
  database.prepare(`UPDATE jobs SET status=?,payload_json=?,last_error=?,finished_at=?,updated_at=? WHERE id=? AND status='running'`)
    .run(status, JSON.stringify(payload), error, now, now, id);
}

function startPersistentDrain(deps: SourceKnowledgeCompileDeps, recover: boolean): Promise<void> {
  const current = state().persistentDrain;
  if (current?.deps.databasePath === deps.databasePath) {
    current.rerun = true;
    current.recover ||= recover;
    return current.promise;
  }
  let promise!: Promise<void>;
  const entry = { deps, promise: undefined as unknown as Promise<void>, rerun: false, recover };
  promise = Promise.resolve().then(async () => {
    for (;;) {
      const shouldRecover = entry.recover;
      entry.recover = false;
      if (shouldRecover) await recoverStalePersistentKnowledgeJobs(deps);
      await drainPersistentKnowledgeJobsInternal(deps);
      if (!entry.rerun && !entry.recover) return;
      entry.rerun = false;
    }
  });
  entry.promise = promise;
  state().persistentDrain = entry;
  void promise.then(() => {
    const currentState = state();
    if (currentState.persistentDrain?.promise === promise) {
      currentState.persistentDrain = null;
      currentState.persistentError = null;
    }
  }, (error) => {
    const currentState = state();
    if (currentState.persistentDrain?.promise === promise) currentState.persistentDrain = null;
    currentState.persistentError = compileErrorInfo(error);
  });
  return promise;
}

function staleRecoveryCutoff(deps: SourceKnowledgeCompileDeps): string {
  const configured = deps.runningJobStaleAfterMs ?? DEFAULT_PERSISTENT_JOB_STALE_AFTER_MS;
  const staleAfter = Number.isFinite(configured) ? Math.max(0, configured) : DEFAULT_PERSISTENT_JOB_STALE_AFTER_MS;
  return new Date(Date.now() - staleAfter).toISOString();
}

async function recoverStalePersistentKnowledgeJobs(deps: SourceKnowledgeCompileDeps): Promise<void> {
  const open = deps.openDatabase ?? ((databasePath: string) => new DatabaseSync(databasePath));
  const database = open(deps.databasePath);
  try {
    const now = new Date().toISOString();
    const cutoff = staleRecoveryCutoff(deps);
    database.prepare(`UPDATE jobs SET status='pending',started_at=NULL,updated_at=?
      WHERE kind IN (?,?,?) AND status='running' AND COALESCE(started_at, updated_at) <= ?`)
      .run(now, KNOWLEDGE_ROUTE_JOB_KIND, KNOWLEDGE_COMPILE_JOB_KIND, KNOWLEDGE_REACTIVATION_JOB_KIND, cutoff);
  } finally { database.close(); }
}

export function recoverAndDrainPersistentKnowledgeJobs(deps: SourceKnowledgeCompileDeps): Promise<void> {
  return startPersistentDrain(deps, true);
}

export function drainPersistentKnowledgeJobs(deps: SourceKnowledgeCompileDeps): Promise<void> {
  return startPersistentDrain(deps, false);
}

async function drainPersistentKnowledgeJobsInternal(deps: SourceKnowledgeCompileDeps): Promise<void> {
  const open = deps.openDatabase ?? ((databasePath: string) => new DatabaseSync(databasePath));
  for (;;) {
    let database = open(deps.databasePath);
    const job = claimJob(database);
    if (!job) { database.close(); return; }
    try {
      const input = JSON.parse(job.payloadJson) as SourceKnowledgeCompileInput;
      if (job.kind === KNOWLEDGE_ROUTE_JOB_KIND) {
        const source = getSource(database, input.sourceId);
        if (!source) throw Object.assign(new Error('SOURCE_NOT_FOUND'), { code: 'SOURCE_NOT_FOUND' });
        if (source.revision !== input.revision) {
          recordCompileOperation(database, { sourceId: input.sourceId, topicId: null, revision: source.revision, result: 'error', code: 'SOURCE_REVISION_STALE' });
          settleJob(database, job.id, 'failed', { ...input, outcome: 'stale', currentRevision: source.revision }, 'SOURCE_REVISION_STALE');
          continue;
        }
        const maxTopics = Math.max(1, Math.min(deps.maxTopicsPerSource ?? DEFAULT_MAX_TOPICS_PER_SOURCE, 20));
        const existingTopics = database.prepare(`SELECT DISTINCT l.topic_id AS topicId FROM topic_source_links l
          JOIN topics t ON t.id=l.topic_id WHERE l.source_id=? AND t.status!='archived'
          ORDER BY t.last_seen_at DESC,t.id DESC LIMIT ?`).all(input.sourceId, maxTopics) as Array<{ topicId: string }>;
        if (existingTopics.length) {
          for (const row of existingTopics) enqueueKnowledgeCompileJob(database, { ...input, topicId: row.topicId });
          settleJob(database, job.id, 'succeeded', {
            ...input, outcome: 'routed_existing', topicIds: existingTopics.map((row) => row.topicId),
            reason: '复用 Source 已有正式 Topic 关系。'
          }, null);
          continue;
        }
        const route = await resolveKnowledgeRoute(database, {
          workspaceId: workspaceIdentity(database) ?? '', sourceId: input.sourceId, revision: input.revision,
          modelCall: deps.modelCall
        });
        if (route.status === 'resolved') {
          const applied = applyKnowledgeRoute(database, job.id, input, route);
          settleJob(database, job.id, 'succeeded', {
            ...input, outcome: 'routed', topicIds: [route.topicId], entityId: applied.entityId,
            reactivationJobIds: applied.reactivationJobIds, reason: route.reason,
            evidenceGaps: route.evidenceGaps
          }, null);
        } else if (route.status === 'unresolved') {
          recordCompileOperation(database, { sourceId: input.sourceId, topicId: null, revision: input.revision, result: 'error', code: route.reasonCode });
          settleJob(database, job.id, 'needs_user', {
            ...input, outcome: 'unresolved', reasonCode: route.reasonCode, reason: route.reason,
            evidenceGaps: route.evidenceGaps
          }, `${route.reasonCode}:${route.reason}`);
        } else {
          recordCompileOperation(database, { sourceId: input.sourceId, topicId: null, revision: input.revision, result: 'error', code: route.reasonCode });
          settleJob(database, job.id, 'failed', {
            ...input, outcome: route.status, reasonCode: route.reasonCode, reason: route.reason
          }, `${route.reasonCode}:${route.reason}`);
        }
      } else if (job.kind === KNOWLEDGE_REACTIVATION_JOB_KIND) {
        const result = applyKnowledgeReactivation(database, job.id, JSON.parse(job.payloadJson) as KnowledgeReactivationJobInput);
        settleJob(database, job.id, 'succeeded', {
          ...JSON.parse(job.payloadJson), outcome: 'reactivated', compileJobId: result.compileJobId,
          evidencePack: result.evidencePack
        }, null);
      } else {
        database.close();
        const result = await runSourceKnowledgeCompile(deps, input);
        database = open(deps.databasePath);
        const failed = result.failed ?? result.topics.find((topic) => topic.result === 'error');
        settleJob(database, job.id, failed ? 'failed' : 'succeeded', { ...input, outcome: failed ? 'failed' : 'compiled', result }, failed ? `${failed.code}:${failed.message}` : null);
      }
    } catch (error) {
      const info = compileErrorInfo(error);
      settleJob(database, job.id, 'failed', JSON.parse(job.payloadJson), `${info.code}:${info.message}`);
    } finally { try { database.close(); } catch { /* already closed/reopened */ } }
  }
}

function routeRequestId(sourceId: string, revision: number): string {
  return `knowledge-route:${sourceId}:r${revision}`;
}

function applyKnowledgeRoute(
  database: DatabaseSync,
  jobId: string,
  input: SourceKnowledgeCompileInput,
  route: KnowledgeRouteResult
): { entityId: string | null; reactivationJobIds: readonly string[] } {
  if (route.status !== 'resolved' || !route.topicId || !route.source) throw new Error('ROUTE_RESULT_NOT_RESOLVED');
  const source = getSource(database, input.sourceId);
  if (!source) throw Object.assign(new Error('SOURCE_NOT_FOUND'), { code: 'SOURCE_NOT_FOUND' });
  if (source.revision !== input.revision) throw Object.assign(new Error('SOURCE_REVISION_STALE'), { code: 'SOURCE_REVISION_STALE' });
  const now = new Date().toISOString();
  const reactivationJobIds: string[] = [];
  let entityId: string | null = null;
  database.exec('BEGIN IMMEDIATE');
  try {
    if (route.entity) {
      const aliases = route.entity.aliasesToAdd.filter((alias) => alias.trim().toLocaleLowerCase('zh-CN') !== route.entity!.canonicalName.trim().toLocaleLowerCase('zh-CN'));
      const entityWrite = {
        scope: 'global' as const,
        entityType: route.entity.entityType,
        canonicalKey: route.entity.canonicalKey,
        canonicalName: route.entity.canonicalName,
        aliases,
        externalIdentity: route.entity.externalIdentity,
        ...(route.entity.action === 'match' ? { id: route.entity.entityId!, beforeRevision: route.entity.beforeRevision! } : {})
      };
      const change = applyKnowledgeChangeSet(database, {
        workspaceId: workspaceIdentity(database) ?? '',
        requestId: routeRequestId(input.sourceId, input.revision),
        reason: `Source 路由：${route.reason}`,
        triggerSource: 'ingest',
        resolutionMode: 'none',
        createdBy: 'background_agent'
      }, {
        entities: [entityWrite],
        receipts: [{
          triggerType: 'ingest', requestId: routeRequestId(input.sourceId, input.revision),
          summary: `Source ${input.sourceId} 已完成 Entity/Topic 路由；证据缺口保留为待核实。`,
          counts: { entitiesCreated: route.entity.action === 'create' ? 1 : 0, entitiesMatched: route.entity.action === 'match' ? 1 : 0, evidenceGaps: route.evidenceGaps.length },
          affectedTopics: [route.topicId],
          affectedEntities: route.entity.entityId ? [route.entity.entityId] : [],
          impact: { sourceId: input.sourceId, sourceRevision: input.revision, routeReason: route.reason, evidenceGaps: route.evidenceGaps },
          failures: route.evidenceGaps.map((gap) => gap.statement)
        }]
      }, false);
      entityId = route.entity.entityId ?? Object.keys(change.revisions).find((id) => id.startsWith('ent-')) ?? null;
      if (!entityId) {
        const created = database.prepare('SELECT id FROM knowledge_entities WHERE scope=? AND canonical_key=?').get('global', route.entity.canonicalKey) as { id: string } | undefined;
        entityId = created?.id ?? null;
      }
    }
    linkTopicSource(database, { topicId: route.topicId, sourceId: input.sourceId, relation: route.topicRelation, now });
    if (entityId) {
      const entityRow = database.prepare(`SELECT id,revision,canonical_name AS canonicalName,aliases_json AS aliasesJson
        FROM knowledge_entities WHERE id=?`).get(entityId) as { id: string; revision: number; canonicalName: string; aliasesJson: string } | undefined;
      if (entityRow) {
        const history = findHistoricalKnowledgeSources(database, {
          entityId: entityRow.id, entityRevision: entityRow.revision,
          aliases: [entityRow.canonicalName, ...JSON.parse(entityRow.aliasesJson) as string[]],
          currentSourceId: source.id, currentCollectedAt: source.collectedAt
        });
        for (const candidate of history.candidates) {
          const reactInput: KnowledgeReactivationJobInput = {
            sourceId: candidate.sourceId, sourceRevision: candidate.revision,
            currentSourceId: source.id, currentSourceRevision: source.revision,
            entityId: entityRow.id, entityRevision: entityRow.revision,
            topicId: route.topicId, reason: `身份确认后重激活：${route.reason}`,
            matchedAliases: candidate.matchedAliases,
            evidenceGaps: route.evidenceGaps
          };
          if (enqueueKnowledgeReactivationJob(database, reactInput)) {
            const row = database.prepare('SELECT id FROM jobs WHERE dedupe_key=?').get(reactivationJobDedupeKey(reactInput)) as { id: string } | undefined;
            if (row) reactivationJobIds.push(row.id);
          }
        }
      }
    }
    database.prepare(`UPDATE jobs SET payload_json=?,updated_at=? WHERE id=? AND status='running'`)
      .run(JSON.stringify({ ...input, outcome: 'routed', routeReason: route.reason }), now, jobId);
    database.exec('COMMIT');
    return { entityId, reactivationJobIds: Object.freeze(reactivationJobIds) };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyKnowledgeReactivation(
  database: DatabaseSync,
  jobId: string,
  input: KnowledgeReactivationJobInput
): { compileJobId: string | null; evidencePack: Readonly<Record<string, unknown>> } {
  const source = getSource(database, input.sourceId);
  if (!source) throw Object.assign(new Error('SOURCE_NOT_FOUND'), { code: 'SOURCE_NOT_FOUND' });
  if (source.revision !== input.sourceRevision) throw Object.assign(new Error('SOURCE_REVISION_STALE'), { code: 'SOURCE_REVISION_STALE' });
  const currentSource = getSource(database, input.currentSourceId);
  if (!currentSource) throw Object.assign(new Error('CURRENT_SOURCE_NOT_FOUND'), { code: 'CURRENT_SOURCE_NOT_FOUND' });
  if (currentSource.revision !== input.currentSourceRevision) {
    throw Object.assign(new Error('CURRENT_SOURCE_REVISION_STALE'), { code: 'CURRENT_SOURCE_REVISION_STALE' });
  }
  const entity = database.prepare('SELECT id,revision FROM knowledge_entities WHERE id=? AND lifecycle=\'active\'').get(input.entityId) as { id: string; revision: number } | undefined;
  if (!entity) throw Object.assign(new Error('ENTITY_NOT_FOUND'), { code: 'ENTITY_NOT_FOUND' });
  if (entity.revision !== input.entityRevision) throw Object.assign(new Error('ENTITY_REVISION_STALE'), { code: 'ENTITY_REVISION_STALE' });
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    linkTopicSource(database, { topicId: input.topicId, sourceId: input.sourceId, relation: 'supporting', now });
    enqueueKnowledgeCompileJob(database, { sourceId: input.sourceId, revision: input.sourceRevision, topicId: input.topicId });
    const compile = database.prepare('SELECT id FROM jobs WHERE dedupe_key=?').get(jobDedupe(KNOWLEDGE_COMPILE_JOB_KIND, { sourceId: input.sourceId, revision: input.sourceRevision, topicId: input.topicId })) as { id: string } | undefined;
    database.exec('COMMIT');
    return {
      compileJobId: compile?.id ?? null,
      evidencePack: Object.freeze({
        reactivationJobId: jobId, reactivationReason: input.reason,
        entityId: input.entityId, entityRevision: input.entityRevision,
        topicId: input.topicId, sourceId: input.sourceId, sourceRevision: input.sourceRevision,
        currentSourceId: input.currentSourceId, currentSourceRevision: input.currentSourceRevision,
        matchedAliases: input.matchedAliases, evidenceGaps: input.evidenceGaps
      })
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function workspaceIdentity(database: DatabaseSync): string | null {
  const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
  return row?.value ?? null;
}

function compileErrorInfo(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error ?? '');
  let code = 'COMPILE_UNEXPECTED';
  if (error && typeof error === 'object' && 'code' in error) {
    const raw = (error as { code: unknown }).code;
    if (typeof raw === 'string' && raw.trim()) code = raw;
  }
  return { code, message };
}

function recordCompileOperation(database: DatabaseSync, input: {
  sourceId: string;
  topicId: string | null;
  revision: number;
  result: 'ok' | 'error';
  code?: string;
}): void {
  recordOperation(database, {
    actorType: 'scheduler',
    clientLabel: KNOWLEDGE_COMPILE_ACTOR_LABEL,
    command: KNOWLEDGE_COMPILE_COMMAND,
    entityType: 'knowledge_compile',
    entityId: input.topicId ? `${input.sourceId}:${input.topicId}` : input.sourceId,
    beforeRevision: input.revision,
    afterRevision: input.revision,
    result: input.result,
    errorCode: input.code
  });
}

export async function runSourceKnowledgeCompile(
  deps: SourceKnowledgeCompileDeps,
  input: SourceKnowledgeCompileInput
): Promise<SourceKnowledgeCompileRun> {
  const open = deps.openDatabase ?? ((databasePath: string) => new DatabaseSync(databasePath));
  let database: DatabaseSync | null = null;
  try {
    database = open(deps.databasePath);
    const source = getSource(database, input.sourceId);
        if (!source) {
          recordCompileOperation(database, { sourceId: input.sourceId, topicId: null, revision: input.revision, result: 'error', code: 'SOURCE_NOT_FOUND' });
      return Object.freeze({ sourceId: input.sourceId, sourceRevision: input.revision, workspaceId: null, topics: [], failed: { code: 'SOURCE_NOT_FOUND', message: 'Source 不存在。' }, broadcast: false });
    }
    const workspaceId = workspaceIdentity(database);
    if (!workspaceId) {
      recordCompileOperation(database, { sourceId: input.sourceId, topicId: null, revision: source.revision, result: 'error', code: 'WORKSPACE_ID_MISSING' });
      return Object.freeze({ sourceId: input.sourceId, sourceRevision: source.revision, workspaceId: null, topics: [], failed: { code: 'WORKSPACE_ID_MISSING', message: '工作空间身份缺失。' }, broadcast: false });
    }
    // ---- 冻结：触发 revision 必须与当前一致；不一致 → 结构化陈旧证据（零写） ----
    if (source.revision !== input.revision) {
      recordCompileOperation(database, { sourceId: input.sourceId, topicId: null, revision: source.revision, result: 'error', code: 'SOURCE_REVISION_STALE' });
      return Object.freeze({ sourceId: input.sourceId, sourceRevision: source.revision, workspaceId, topics: [], failed: { code: 'SOURCE_REVISION_STALE', message: `Source revision 已从 ${input.revision} 更新到 ${source.revision}。` }, broadcast: false });
    }
    // ---- 解析现有 topic_source_links（不创建链接）；有界：只取前 N 个活跃 Topic ----
    const maxTopics = Math.max(1, Math.min(deps.maxTopicsPerSource ?? DEFAULT_MAX_TOPICS_PER_SOURCE, 20));
    const topicRows = database.prepare(
      `SELECT l.topic_id AS topicId FROM topic_source_links l
       JOIN topics t ON t.id = l.topic_id
       WHERE l.source_id = ? AND t.status != 'archived'${input.topicId ? ' AND l.topic_id = ?' : ''}
       ORDER BY t.last_seen_at DESC, t.id DESC LIMIT ?`
    ).all(...(input.topicId ? [input.sourceId, input.topicId, maxTopics] : [input.sourceId, maxTopics])) as Array<{ topicId: string }>;

    if (input.topicId && topicRows.length === 0) {
      const code = 'TOPIC_SOURCE_LINK_STALE';
      recordCompileOperation(database, { sourceId: input.sourceId, topicId: input.topicId, revision: source.revision, result: 'error', code });
      return Object.freeze({
        sourceId: input.sourceId,
        sourceRevision: source.revision,
        workspaceId,
        topics: [],
        failed: Object.freeze({ code, message: '指定的 Source→Topic 关系已不存在。' }),
        broadcast: false
      });
    }

    const topics: TopicCompileOutcome[] = [];
    let broadcast = false;
    for (const { topicId } of topicRows) {
      const outcome = await compileTopic(database, deps, {
        sourceId: input.sourceId,
        sourceRevision: source.revision,
        workspaceId,
        topicId
      });
      topics.push(outcome);
      if (outcome.result === 'ok') broadcast = true;
    }
    if (broadcast) broadcastDataChanged({ scopes: ['knowledge', 'topics', 'receipt'], reason: 'source.compile' });
    return Object.freeze({ sourceId: input.sourceId, sourceRevision: source.revision, workspaceId, topics: Object.freeze(topics), failed: null, broadcast });
  } catch (error) {
    const info = compileErrorInfo(error);
    return Object.freeze({
      sourceId: input.sourceId,
      sourceRevision: input.revision,
      workspaceId: null,
      topics: [],
      failed: Object.freeze({ code: info.code, message: info.message }),
      broadcast: false
    });
  } finally {
    try { database?.close(); } catch { /* 关闭失败不影响结果 */ }
  }
}

async function compileTopic(
  database: DatabaseSync,
  deps: SourceKnowledgeCompileDeps,
  input: { sourceId: string; sourceRevision: number; workspaceId: string; topicId: string }
): Promise<TopicCompileOutcome> {
  const requestId = knowledgeCompileTopicRequestId(input.sourceId, input.sourceRevision, input.topicId);
  try {
    const planResult = await generateKnowledgeCandidatePlan(database, {
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      topicId: input.topicId,
      createdBy: 'background_agent',
      triggerSource: 'ingest',
      sourceNature: 'primary_source',
      modelCall: deps.modelCall
    });
    if (!planResult.ok) {
      const code = `PLAN:${planResult.error.code}`;
      recordCompileOperation(database, { sourceId: input.sourceId, topicId: input.topicId, revision: input.sourceRevision, result: 'error', code });
      return Object.freeze({ topicId: input.topicId, requestId, result: 'error', code, message: planResult.error.message });
    }
    // 冻结计划入口（compiler 文档：「对已冻结在旧 revision 的计划调用 compileSourceKnowledge
    // （含 sourceRevision + requestId）」）；requestId 按 (source, revision, topic) 派生，
    // 覆盖 WMB-5228 计划自带的 sourceCompileRequestId（多 Topic 共享会触发 store 冲突）。
    const compileResult = compileSourceKnowledge(database, { ...planResult.plan, requestId });
    recordCompileOperation(database, { sourceId: input.sourceId, topicId: input.topicId, revision: input.sourceRevision, result: 'ok' });
    return Object.freeze({ topicId: input.topicId, requestId, result: 'ok', replay: compileResult.replay });
  } catch (error) {
    const info = compileErrorInfo(error);
    const code = `COMPILE:${info.code}`;
    recordCompileOperation(database, { sourceId: input.sourceId, topicId: input.topicId, revision: input.sourceRevision, result: 'error', code });
    return Object.freeze({ topicId: input.topicId, requestId, result: 'error', code, message: info.message });
  }
}
