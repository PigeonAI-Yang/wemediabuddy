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
import { DatabaseSync } from 'node:sqlite';
import { broadcastDataChanged } from './data-changed.ts';
import { recordOperation } from './operations.ts';
import { generateKnowledgeCandidatePlan, type KnowledgeCandidatesModelCall } from './knowledge-candidates.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from './knowledge-compiler.ts';
import { getSource } from './sources.ts';

export const KNOWLEDGE_COMPILE_COMMAND = 'knowledge.compile_source';
export const KNOWLEDGE_COMPILE_ACTOR_LABEL = 'knowledge-compile';
export const DEFAULT_MAX_TOPICS_PER_SOURCE = 5;
const GLOBAL_KEY = '__wmb_source_knowledge_compile_trigger__';

export type SourceKnowledgeCompileDeps = Readonly<{
  /** 工作空间 wmb.db 绝对路径（异步编译连接用）。 */
  databasePath: string;
  /** WMB-5228 候选计划模型调用注入：输入冻结 prompt，返回原始文本（含 ```json 围栏块）。 */
  modelCall: KnowledgeCandidatesModelCall;
  /** 每 Source 最多编译前 N 个已关联 Topic（有界；默认 5，上限 20）。 */
  maxTopicsPerSource?: number;
  /** 异步连接工厂覆盖（测试注入 migrateDatabase 等）；默认 DatabaseSync(databasePath)。 */
  openDatabase?: (databasePath: string) => DatabaseSync;
}>;

export type SourceKnowledgeCompileInput = Readonly<{
  sourceId: string;
  revision: number;
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
};

function state(): TriggerState {
  const globalRef = globalThis as typeof globalThis & { [GLOBAL_KEY]?: TriggerState };
  if (!globalRef[GLOBAL_KEY]) {
    globalRef[GLOBAL_KEY] = { deps: null, inflight: new Map() };
  }
  return globalRef[GLOBAL_KEY]!;
}

/** 同 (source, revision, topic) 稳定幂等键；多 Topic 必须派生（store 对 (workspace_id, request_id) 唯一）。 */
export function knowledgeCompileTopicRequestId(sourceId: string, sourceRevision: number, topicId: string): string {
  return `${sourceCompileRequestId(sourceId, sourceRevision)}:topic:${topicId}`;
}

export function setSourceKnowledgeCompileDeps(deps: SourceKnowledgeCompileDeps | null): void {
  state().deps = deps;
}

export function getSourceKnowledgeCompileDeps(): SourceKnowledgeCompileDeps | null {
  return state().deps;
}

export function sourceKnowledgeCompileInFlight(): number {
  return state().inflight.size;
}

/** 等待全部在飞编译结束（测试 / 关闭）。 */
export async function drainSourceKnowledgeCompileQueue(): Promise<void> {
  for (;;) {
    const inflight = [...state().inflight.values()];
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

/** 显式 deps 调度（测试 / 绕过全局注册）。并发同键去重：已注册在飞 → false。 */
export function scheduleSourceKnowledgeCompileWith(deps: SourceKnowledgeCompileDeps, input: SourceKnowledgeCompileInput): boolean {
  const key = `${input.sourceId}@r${input.revision}`;
  const inflight = state().inflight;
  if (inflight.has(key)) return false;
  const started = Promise.resolve().then(() => runSourceKnowledgeCompile(deps, input));
  inflight.set(key, started);
  void started.finally(() => {
    if (inflight.get(key) === started) inflight.delete(key);
  });
  return true;
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
      return Object.freeze({ sourceId: input.sourceId, sourceRevision: input.revision, workspaceId: null, topics: [], failed: null, broadcast: false });
    }
    const workspaceId = workspaceIdentity(database);
    if (!workspaceId) {
      recordCompileOperation(database, { sourceId: input.sourceId, topicId: null, revision: source.revision, result: 'error', code: 'WORKSPACE_ID_MISSING' });
      return Object.freeze({ sourceId: input.sourceId, sourceRevision: source.revision, workspaceId: null, topics: [], failed: null, broadcast: false });
    }
    // ---- 冻结：触发 revision 必须与当前一致；不一致 → 结构化陈旧证据（零写） ----
    if (source.revision !== input.revision) {
      recordCompileOperation(database, { sourceId: input.sourceId, topicId: null, revision: source.revision, result: 'error', code: 'SOURCE_REVISION_STALE' });
      return Object.freeze({ sourceId: input.sourceId, sourceRevision: source.revision, workspaceId, topics: [], failed: null, broadcast: false });
    }
    // ---- 解析现有 topic_source_links（不创建链接）；有界：只取前 N 个活跃 Topic ----
    const maxTopics = Math.max(1, Math.min(deps.maxTopicsPerSource ?? DEFAULT_MAX_TOPICS_PER_SOURCE, 20));
    const topicRows = database.prepare(
      `SELECT l.topic_id AS topicId FROM topic_source_links l
       JOIN topics t ON t.id = l.topic_id
       WHERE l.source_id = ? AND t.status != 'archived'
       ORDER BY t.last_seen_at DESC, t.id DESC LIMIT ?`
    ).all(input.sourceId, maxTopics) as Array<{ topicId: string }>;

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
