import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  canonicalJsonV1,
  hashV1,
  readWorkspaceOrchestratorActor,
  sha256Hex,
  type WorkspaceOrchestratorActor
} from './workspace-orchestrator-actor.ts';

/**
 * Durable acceptance execution for the workspace orchestrator.
 *
 * This module owns the acceptance boundary only. Scenario executors still
 * call the production Actor/Root/Resource/Snapshot/Manager stores; the runner
 * freezes the run identity, supplies acceptance provenance, and independently
 * judges resulting persistent rows/events. It never seeds a business row or
 * synthesizes a successful child.
 */

type Row = Record<string, unknown>;
type Scalar = string | number | bigint | null;
type HashMap = Readonly<Record<string, string>>;
type CountMap = Readonly<Record<string, number>>;

export const ACCEPTANCE_SCHEMA_VERSION = 81;

export const ACCEPTANCE_PROVENANCE_COLUMNS = Object.freeze([
  'acceptance_run_id',
  'baseline_event_sequence',
  'baseline_checkpoint_revision',
  'created_after_event_sequence',
  'created_after_checkpoint_revision',
  'created_after_mono'
] as const);

export const ACCEPTANCE_SCENARIO_IDS = Object.freeze(
  Array.from({ length: 57 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`)
);

/** Workspace-scoped persistent state participating in a run hash. */
export const ACCEPTANCE_HASH_TABLES = Object.freeze([
  'identity_hash_registry',
  'workspace_orchestrator_actors',
  'orchestrator_mailbox',
  'command_receipts',
  'orchestrator_intents',
  'channel_preflight_snapshots',
  'daily_orchestration_roots',
  'daily_stage_claims',
  'source_snapshots',
  'daily_repair_snapshot_bindings',
  'daily_plan_scopes',
  'managed_job_dispatches',
  'managed_effect_consumptions',
  'orchestrator_events',
  'orchestrator_outbox',
  'daily_reconcile_gates',
  'workspace_active_root_index',
  'workspace_migration_state',
  'workspace_rollback_state',
  'workspace_migration_journal',
  'producer_registry'
] as const);

const TERMINAL_VALUES = new Set([
  'succeeded', 'success', 'passed', 'partial', 'failed', 'needs_user', 'cancelled',
  'canceled', 'orphaned', 'skipped', 'terminal', 'consumed', 'authorization_rejected',
  'closed', 'cleaned', 'exited'
]);

const SCENARIO_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  A01: 'required 与 optional preflight 混合，required ready、optional 缺登录',
  A02: 'required channel 缺登录，阻断 root/child 并要求修复后新 root',
  A03: '所有选定渠道 preflight 失败，不得伪造 clean-empty',
  A04: '首次 full，F scan 与 J judge 拥有独立 stage/request/operation identity',
  A05: 'scan 冻结后自动 judge，重启与重复 event 不新增 J',
  A06: 'Actor/应用在 handoff 前崩溃后按 predecessor/snapshot identity 受限接管',
  A07: 'scan 没有 trusted material，终结 partial 且禁止 judge/Reporter',
  A08: 'Judge 开始后 source revision/hash 变化，拒绝 stale snapshot',
  A09: 'Planner 输出完整 eligible candidate，Projection 与审批入口一致',
  A10: 'Planner 输出合法零候选，持久化 clean-empty projection',
  A11: 'pending、invalid 与 eligible 组合按固定优先级读回',
  A12: 'evidence gap 有进展时 successor 有界运行且 parent identity 可追溯',
  A13: 'Reporter 资源竞争受同 workspace 五个 active 上限约束',
  A14: 'Judge 资源竞争受同 workspace 一个 active 上限约束',
  A15: 'root 达到 80 sources，snapshot 上限与超额证据可读',
  A16: 'root/stage 时间预算终结且 heartbeat 不延长 deadline',
  A17: 'Manager accept 前/后异常分别保留失败边界且禁止 fallback',
  A18: '同日 Owner 与 scheduler 并发而 Actor 串行、root/orchestration 不串单',
  A19: 'Stage D 无 target/有 target 只处理 frozen target triples',
  A20: 'Stage D effect 成功跨 orchestration 复用且 source 不变',
  A21: 'Reporter/Judge/consumption 中途 cancel 后 cascade orphan/lease cleanup',
  A22: 'Actor/应用崩溃后新 runtime epoch 接管 active bundle',
  A23: 'research cwd 失效、requestId 冲突、父级 supersede 均可读失败',
  A24: 'Today、Manager、DB 使用同一 eligible ID set/hash',
  A25: 'clean cutover 静态与动态检查无 direct/legacy 写入',
  A26: '新 runtime epoch 接管后旧 epoch mutation 为 audit-only',
  A27: 'old root retry 产生新 generation/ordinal/identity 且旧 root 不回 running',
  A28: '安装版真实透明闭环，包/app.asar/data-root/runtime identity 可交叉校验',
  A29: 'logical invocation/replay 与 repaired binding hash DAG 稳定',
  A30: 'spawn crash 各边界仅 adopt-or-kill 一个真实进程',
  A31: '三种 effect delivery 语义、token 幂等与冲突拒绝',
  A32: 'T1-T8 bundle、registry、index、event/outbox 原子恢复',
  A33: 'stall/lease/watchdog takeover 唯一 authority winner',
  A34: '旧 epoch late result 与跨表 terminal first-writer 不可覆盖',
  A35: 'cancel 与 F-to-J handoff 同锁序线性化',
  A36: 'capability/config/auth drift 旧 fence fail closed',
  A37: 'channel requiredness 与 policy 伪造在 root 前拒绝',
  A38: 'absent/not_applicable/frozen projection 与 index rebuild 诚实',
  A39: 'migration journal crash replay 与 global zero-write fence',
  A40: '旧 renderer/MCP/scheduler/binary 在 cutover 后零业务写',
  A41: 'producer census/attestation 与取消后动态 writer 拒绝',
  A42: 'rollback barrier 先 deny/drain 再兼容切换',
  A43: '百请求 mailbox coalescing/backpressure 跨重启单调',
  A44: 'Judge 单实例与 interactive aging/preemption 公平',
  A45: '80-source cap 后仍完成唯一 F-to-J handoff',
  A46: 'strict progressMeasure 拒绝 no-op 并限制 descendant',
  A47: 'hung probe deadline/recovery 不阻塞 unrelated mailbox',
  A48: 'DB monotonic deadline 与每次启动新 gate epoch',
  A49: 'initial/repaired scope FK/hash/replay/archive 闭包',
  A50: 'source/receipt provenance 与 channel partition hash 完整',
  A51: 'all-optional failure 不建 root 且给出显式 nextAction',
  A52: 'mixed Projection 不等待 Owner，旧/非法 approval 零写',
  A53: 'outbox/inbox ordinal、cursor resync、index rebuild 与 stale CTA',
  A54: 'legacy late delivery 在 tombstone 后 audit-only',
  A55: 'loaded-build identity 与 fresh causal delta/nested provenance',
  A56: 'live-channel failure matrix 与 trusted receipt proof',
  A57: 'event redaction、metrics、grant/authorizer 与 publish denial'
});

export class AcceptanceRunError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(code: string, message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'AcceptanceRunError';
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : null;
  }
}

export type AcceptanceRunStatus = 'running' | 'passed' | 'failed' | 'not_executed';

export type AcceptanceProvenance = Readonly<{
  acceptanceRunId: string;
  baselineEventSequence: number;
  baselineCheckpointRevision: number;
  createdAfterEventSequence: number;
  createdAfterCheckpointRevision: number;
  createdAfterMono: number;
}>;

export type AcceptanceRun = Readonly<{
  acceptanceRunId: string;
  workspaceId: string;
  scenarioId: string;
  scenarioInputHash: string;
  buildId: string;
  manifestHash: string;
  acceptanceNamespace: string;
  startedAtUtc: string;
  startedAtMono: number;
  baselineEventSequence: number;
  baselineCheckpointRevision: number;
  baselineTableHashes: HashMap;
  baselineCounts: CountMap;
  baselineDataRootHash: string;
  freshAfterMono: number;
  status: AcceptanceRunStatus;
  resultHash: string | null;
  evidencePointer: string | null;
  createdAt: string;
  finishedAtUtc: string | null;
  finishedAtMono: number | null;
}>;

export type AcceptanceChildSelector = Readonly<{
  table: string;
  where?: Readonly<Record<string, Scalar>>;
  /** exact count, or use minCount/maxCount for a range */
  count?: number;
  minCount?: number;
  maxCount?: number;
  terminal?: boolean;
  label?: string;
}>;

export type AcceptanceForbiddenChild = Readonly<{
  table: string;
  where?: Readonly<Record<string, Scalar>>;
  reasonCode: string;
  eventType?: string;
  label?: string;
}>;

export type AcceptanceExpectedChildren = Readonly<{
  required?: readonly AcceptanceChildSelector[];
  forbidden?: readonly AcceptanceForbiddenChild[];
}>;

export type AcceptanceScenarioObservation = Readonly<{
  status?: 'passed' | 'failed' | 'not_executed';
  passed?: boolean;
  proof?: unknown;
  readbacks?: readonly unknown[];
  producedRows?: readonly AcceptanceChildSelector[];
  expectedChildren?: AcceptanceExpectedChildren;
  evidencePointer?: string;
  reason?: string | null;
  blocker?: string | null;
}>;

export type AcceptanceScenarioDefinition = Readonly<{
  scenarioId: string;
  description: string;
  expectedChildren: AcceptanceExpectedChildren;
}>;

export type AcceptanceRunnerOptions = Readonly<{
  nowUtc?: () => string;
  nowMono?: () => number;
  dataRootPath?: string;
  defaultEvidenceRoot?: string;
}>;

export type StartAcceptanceRunInput = Readonly<{
  workspaceId: string;
  scenarioId: string;
  acceptanceRunId?: string;
  acceptanceNamespace?: string;
  scenarioInput?: unknown;
  buildId?: string;
  manifestHash?: string;
  dataRootPath?: string;
  dataRoot?: string;
  startedAtUtc?: string;
  startedAtMono?: number;
  freshAfterMono?: number;
}>;

export type AcceptanceScenarioContext = Readonly<{
  run: AcceptanceRun;
  scenario: AcceptanceScenarioDefinition;
  actor: WorkspaceOrchestratorActor;
  provenance: AcceptanceProvenance;
  acceptance: Readonly<{
    acceptanceRunId: string;
    baselineEventSequence: number;
    baselineCheckpointRevision: number;
    createdAfterEventSequence: number;
    createdAfterCheckpointRevision: number;
    createdAfterMono: number;
  }>;
  withAcceptance<T extends Record<string, unknown>>(input: T): T & { acceptance: AcceptanceProvenance } & AcceptanceProvenance;
  readTable(table: string, where?: Readonly<Record<string, Scalar>>): readonly Row[];
  readEventProof(eventType?: string): readonly Row[];
}>;

export type AcceptanceStartResult = Readonly<{
  ok: true;
  replayed: boolean;
  run: AcceptanceRun;
  context: AcceptanceScenarioContext;
}>;

export type AcceptanceFinishInput = Readonly<{
  acceptanceRunId: string;
  status?: 'passed' | 'failed' | 'not_executed';
  passed?: boolean;
  proof?: unknown;
  readbacks?: readonly unknown[];
  producedRows?: readonly AcceptanceChildSelector[];
  expectedChildren?: AcceptanceExpectedChildren;
  evidencePointer?: string;
  reason?: string | null;
  blocker?: string | null;
  finishedAtUtc?: string;
  finishedAtMono?: number;
}>;

export type AcceptanceFinishResult = Readonly<{
  ok: true;
  replayed: boolean;
  run: AcceptanceRun;
  freshTableHashes: HashMap;
  freshCounts: CountMap;
  resultHash: string;
  evidencePointer: string;
  proof: Readonly<Record<string, unknown>>;
}>;

export type AcceptanceRunInput = StartAcceptanceRunInput & Readonly<{
  execute?: AcceptanceScenarioExecutor;
  evidencePointer?: string;
}>;

export type AcceptanceScenarioExecutor = (context: AcceptanceScenarioContext) => AcceptanceScenarioObservation | Promise<AcceptanceScenarioObservation>;
export type AcceptanceRunResult = AcceptanceFinishResult;

function asFiniteNumber(value: unknown, field: string, minimum = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new AcceptanceRunError('ACCEPTANCE_INPUT_INVALID', `${field} 必须是 >= ${minimum} 的有限数字。`, { field, value });
  return number;
}

function requiredString(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new AcceptanceRunError('ACCEPTANCE_INPUT_INVALID', `${field} 不得为空。`, { field });
  return text;
}

function normalizedUtc(value: unknown, fallback: string): string {
  const candidate = value === undefined || value === null ? fallback : String(value);
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new AcceptanceRunError('ACCEPTANCE_INPUT_INVALID', `无效 UTC instant: ${candidate}`);
  return date.toISOString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new AcceptanceRunError('ACCEPTANCE_INPUT_INVALID', `不安全的 SQL identifier: ${identifier}`);
  return `"${identifier}"`;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableColumns(database: DatabaseSync, table: string): readonly string[] {
  if (!tableExists(database, table)) return [];
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => String((row as Row).name));
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return tableColumns(database, table).includes(column);
}

function whereSql(database: DatabaseSync, table: string, workspaceId: string, where: Readonly<Record<string, Scalar>> | undefined): { sql: string; values: Scalar[] } {
  const columns = new Set(tableColumns(database, table));
  if (!columns.size) throw new AcceptanceRunError('ACCEPTANCE_TABLE_MISSING', `验收目标表不存在: ${table}`, { table });
  const clauses: string[] = [];
  const values: Scalar[] = [];
  if (columns.has('workspace_id')) {
    clauses.push(`${quoteIdentifier('workspace_id')} = ?`);
    values.push(workspaceId);
  }
  for (const [key, value] of Object.entries(where ?? {})) {
    if (!columns.has(key)) throw new AcceptanceRunError('ACCEPTANCE_SELECTOR_INVALID', `验收 selector 字段不存在: ${table}.${key}`, { table, key });
    clauses.push(value === null ? `${quoteIdentifier(key)} IS NULL` : `${quoteIdentifier(key)} = ?`);
    if (value !== null) values.push(value);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
}

function readSelectedRows(database: DatabaseSync, table: string, workspaceId: string, where?: Readonly<Record<string, Scalar>>): readonly Row[] {
  const selected = whereSql(database, table, workspaceId, where);
  return database.prepare(`SELECT * FROM ${quoteIdentifier(table)}${selected.sql}`).all(...selected.values) as Row[];
}

function readRowsForWorkspace(database: DatabaseSync, table: string, workspaceId: string): readonly Row[] {
  if (!tableExists(database, table) || !hasColumn(database, table, 'workspace_id')) return [];
  const columns = tableColumns(database, table);
  const order = columns.length ? columns.map(quoteIdentifier).join(',') : 'rowid';
  return database.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE workspace_id=? ORDER BY ${order}`).all(workspaceId) as Row[];
}

function hashRows(table: string, rows: readonly Row[]): string {
  return hashV1({ r: 'acceptance-table/v1', table, rows });
}

function baselineSnapshot(database: DatabaseSync, workspaceId: string): { tableHashes: HashMap; counts: CountMap } {
  const tableHashes: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const table of ACCEPTANCE_HASH_TABLES) {
    const rows = readRowsForWorkspace(database, table, workspaceId);
    tableHashes[table] = hashRows(table, rows);
    counts[table] = rows.length;
  }
  return Object.freeze({ tableHashes: Object.freeze(tableHashes), counts: Object.freeze(counts) });
}

function dataRootHash(dataRootPath: string | undefined): string {
  if (!dataRootPath) return hashV1({ r: 'data-root/v1', state: 'unspecified' });
  const root = resolve(dataRootPath);
  if (!existsSync(root)) return hashV1({ r: 'data-root/v1', root, state: 'missing' });
  const entries: Array<Record<string, unknown>> = [];
  const visit = (absolute: string): void => {
    let stat;
    try { stat = lstatSync(absolute); } catch { return; }
    const rel = relative(root, absolute).split(sep).join('/');
    if (stat.isDirectory()) {
      if (rel) entries.push({ path: rel, kind: 'directory' });
      let children: string[];
      try { children = readdirSync(absolute); } catch { return; }
      children.sort();
      for (const child of children) visit(resolve(absolute, child));
      return;
    }
    if (stat.isFile()) {
      let contentHash: string | null = null;
      try { contentHash = sha256Hex(readFileSync(absolute)); } catch { contentHash = null; }
      entries.push({ path: rel, kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, contentHash });
      return;
    }
    entries.push({ path: rel, kind: 'other', size: stat.size, mtimeMs: stat.mtimeMs });
  };
  visit(root);
  return hashV1({ r: 'data-root/v1', root, entries });
}

function parseJsonObject(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return { ...fallback };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { ...fallback };
  } catch { return { ...fallback }; }
}

function numberOr(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function runFromRow(row: Row): AcceptanceRun {
  return Object.freeze({
    acceptanceRunId: String(row.acceptance_run_id),
    workspaceId: String(row.workspace_id),
    scenarioId: String(row.scenario_id),
    scenarioInputHash: String(row.scenario_input_hash),
    buildId: String(row.build_id),
    manifestHash: String(row.manifest_hash),
    acceptanceNamespace: String(row.acceptance_namespace),
    startedAtUtc: String(row.started_at_utc),
    startedAtMono: numberOr(row.started_at_mono),
    baselineEventSequence: numberOr(row.baseline_event_sequence),
    baselineCheckpointRevision: numberOr(row.baseline_checkpoint_revision),
    baselineTableHashes: Object.freeze(parseJsonObject(row.baseline_table_hashes) as HashMap),
    baselineCounts: Object.freeze(parseJsonObject(row.baseline_counts) as CountMap),
    baselineDataRootHash: String(row.baseline_data_root_hash),
    freshAfterMono: numberOr(row.fresh_after_mono),
    status: String(row.status) as AcceptanceRunStatus,
    resultHash: nullableString(row.result_hash),
    evidencePointer: nullableString(row.evidence_pointer),
    createdAt: String(row.created_at),
    finishedAtUtc: nullableString(row.finished_at_utc),
    finishedAtMono: nullableNumber(row.finished_at_mono)
  });
}

function readRunRow(database: DatabaseSync, acceptanceRunId: string): Row | undefined {
  return database.prepare('SELECT * FROM acceptance_runs WHERE acceptance_run_id=?').get(acceptanceRunId) as Row | undefined;
}

export function readAcceptanceRun(database: DatabaseSync, acceptanceRunId: string): AcceptanceRun | null {
  const row = readRunRow(database, requiredString(acceptanceRunId, 'acceptanceRunId'));
  return row ? runFromRow(row) : null;
}

export function listAcceptanceRuns(database: DatabaseSync, workspaceId: string): readonly AcceptanceRun[] {
  const workspace = requiredString(workspaceId, 'workspaceId');
  return (database.prepare('SELECT * FROM acceptance_runs WHERE workspace_id=? ORDER BY started_at_mono, acceptance_run_id').all(workspace) as Row[]).map(runFromRow);
}

function getScenarioDefinition(scenarioId: string): AcceptanceScenarioDefinition {
  const id = requiredString(scenarioId, 'scenarioId').toUpperCase();
  if (!ACCEPTANCE_SCENARIO_IDS.includes(id)) throw new AcceptanceRunError('ACCEPTANCE_SCENARIO_UNKNOWN', `未知 acceptance scenario: ${id}`, { scenarioId: id });
  return Object.freeze({
    scenarioId: id,
    description: SCENARIO_DESCRIPTIONS[id],
    expectedChildren: Object.freeze({ required: Object.freeze([]), forbidden: Object.freeze([]) })
  });
}

export function acceptanceScenarioRegistry(): readonly AcceptanceScenarioDefinition[] {
  return ACCEPTANCE_SCENARIO_IDS.map((scenarioId) => getScenarioDefinition(scenarioId));
}

export function getAcceptanceScenario(scenarioId: string): AcceptanceScenarioDefinition {
  return getScenarioDefinition(scenarioId);
}

function ensureAcceptanceSchema(database: DatabaseSync): void {
  if (!tableExists(database, 'acceptance_runs')) throw new AcceptanceRunError('ACCEPTANCE_SCHEMA_REQUIRED', 'acceptance_runs 表不存在，请先运行 workspace migration。');
  const columns = new Set(tableColumns(database, 'acceptance_runs'));
  const required = ['scenario_id', 'scenario_input_hash', 'manifest_hash', 'started_at_utc', 'started_at_mono', 'result_hash', 'evidence_pointer', 'finished_at_mono'];
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length) throw new AcceptanceRunError('ACCEPTANCE_SCHEMA_REQUIRED', `acceptance_runs schema v81 字段缺失: ${missing.join(', ')}`, { missing, schemaVersion: ACCEPTANCE_SCHEMA_VERSION });
}

function currentBuild(database: DatabaseSync, input: StartAcceptanceRunInput): { buildId: string; manifestHash: string } {
  if (!tableExists(database, 'build_manifests')) throw new AcceptanceRunError('ACCEPTANCE_BUILD_MISSING', 'build_manifests 表不存在。');
  const requestedBuildId = input.buildId ? String(input.buildId) : null;
  const row = requestedBuildId
    ? database.prepare('SELECT * FROM build_manifests WHERE build_id=?').get(requestedBuildId) as Row | undefined
    : database.prepare('SELECT * FROM build_manifests ORDER BY rowid DESC LIMIT 1').get() as Row | undefined;
  if (!row) throw new AcceptanceRunError('ACCEPTANCE_BUILD_MISSING', '没有可冻结的 build manifest。', { buildId: requestedBuildId });
  const buildId = String(row.build_id);
  const manifestHash = requiredString(row.manifest_hash, 'build_manifests.manifest_hash');
  if (input.manifestHash !== undefined && String(input.manifestHash) !== manifestHash) throw new AcceptanceRunError('ACCEPTANCE_BUILD_CONFLICT', '传入 manifestHash 与持久 build manifest 不一致。', { buildId, expected: manifestHash, supplied: input.manifestHash });
  return { buildId, manifestHash };
}

function eventSequence(database: DatabaseSync, workspaceId: string): number {
  if (!tableExists(database, 'orchestrator_events')) return 0;
  const row = database.prepare('SELECT COALESCE(MAX(event_sequence),0) AS value FROM orchestrator_events WHERE workspace_id=?').get(workspaceId) as Row;
  return numberOr(row.value, 0);
}

function actorFor(database: DatabaseSync, workspaceId: string): WorkspaceOrchestratorActor {
  const actor = readWorkspaceOrchestratorActor(database, workspaceId);
  if (!actor) throw new AcceptanceRunError('ACCEPTANCE_ACTOR_MISSING', `workspace Actor 不存在: ${workspaceId}`, { workspaceId });
  return actor;
}

function defaultNowUtc(): string { return new Date().toISOString(); }
function defaultNowMono(): number { return Date.now(); }

function makeContext(database: DatabaseSync, run: AcceptanceRun, actor: WorkspaceOrchestratorActor, scenario: AcceptanceScenarioDefinition): AcceptanceScenarioContext {
  const provenance: AcceptanceProvenance = Object.freeze({
    acceptanceRunId: run.acceptanceRunId,
    baselineEventSequence: run.baselineEventSequence,
    baselineCheckpointRevision: run.baselineCheckpointRevision,
    createdAfterEventSequence: run.baselineEventSequence + 1,
    createdAfterCheckpointRevision: run.baselineCheckpointRevision + 1,
    createdAfterMono: run.freshAfterMono
  });
  const acceptance = Object.freeze({ ...provenance });
  return Object.freeze({
    run,
    scenario,
    actor,
    provenance,
    acceptance,
    withAcceptance<T extends Record<string, unknown>>(input: T): T & { acceptance: AcceptanceProvenance } & AcceptanceProvenance {
      return {
        ...input,
        acceptance,
        acceptanceRunId: acceptance.acceptanceRunId,
        baselineEventSequence: acceptance.baselineEventSequence,
        baselineCheckpointRevision: acceptance.baselineCheckpointRevision,
        createdAfterEventSequence: acceptance.createdAfterEventSequence,
        createdAfterCheckpointRevision: acceptance.createdAfterCheckpointRevision,
        createdAfterMono: acceptance.createdAfterMono
      };
    },
    readTable(table: string, where?: Readonly<Record<string, Scalar>>): readonly Row[] {
      return readSelectedRows(database, table, run.workspaceId, where);
    },
    readEventProof(eventType?: string): readonly Row[] {
      const rows = readSelectedRows(database, 'orchestrator_events', run.workspaceId);
      return rows.filter((row) => numberOr(row.event_sequence, 0) > run.baselineEventSequence
        && String(row.acceptance_run_id ?? '') === run.acceptanceRunId
        && (!eventType || String(row.event_type) === eventType));
    }
  });
}

export function acceptanceFields(context: AcceptanceScenarioContext): AcceptanceProvenance {
  return context.provenance;
}

export function startAcceptanceRun(database: DatabaseSync, input: StartAcceptanceRunInput, options: AcceptanceRunnerOptions = {}): AcceptanceStartResult {
  ensureAcceptanceSchema(database);
  const workspaceId = requiredString(input.workspaceId, 'workspaceId');
  const scenario = getScenarioDefinition(input.scenarioId);
  const nowUtc = options.nowUtc ?? defaultNowUtc;
  const nowMono = options.nowMono ?? defaultNowMono;
  const startedAtUtc = normalizedUtc(input.startedAtUtc, normalizedUtc(nowUtc(), defaultNowUtc()));
  const startedAtMono = input.startedAtMono === undefined ? asFiniteNumber(nowMono(), 'startedAtMono') : asFiniteNumber(input.startedAtMono, 'startedAtMono');
  const freshAfterMono = input.freshAfterMono === undefined ? startedAtMono : asFiniteNumber(input.freshAfterMono, 'freshAfterMono');
  const acceptanceRunId = String(input.acceptanceRunId ?? hashV1({ r: 'acceptance-run-id/v1', workspaceId, scenarioId: scenario.scenarioId, scenarioInput: input.scenarioInput ?? null }));
  const acceptanceNamespace = String(input.acceptanceNamespace ?? `acceptance/${workspaceId}/${scenario.scenarioId}/${acceptanceRunId}`);
  const scenarioInputHash = hashV1({ r: 'acceptance-input/v1', workspaceId, scenarioId: scenario.scenarioId, input: input.scenarioInput ?? null });
  let result: AcceptanceStartResult | null = null;
  try {
    database.exec('BEGIN IMMEDIATE');
    const actor = actorFor(database, workspaceId);
    const existing = readRunRow(database, acceptanceRunId);
    if (existing) {
      const prior = runFromRow(existing);
      if (prior.workspaceId !== workspaceId || prior.scenarioId !== scenario.scenarioId || prior.scenarioInputHash !== scenarioInputHash || (input.buildId !== undefined && prior.buildId !== String(input.buildId)) || (input.manifestHash !== undefined && prior.manifestHash !== String(input.manifestHash)) || prior.acceptanceNamespace !== acceptanceNamespace) {
        throw new AcceptanceRunError('ACCEPTANCE_RUN_CONFLICT', '同一 acceptanceRunId 绑定了不同 scenario/input/build/namespace。', { acceptanceRunId, existing: prior, requested: { workspaceId, scenarioId: scenario.scenarioId, scenarioInputHash, buildId: input.buildId ?? null, manifestHash: input.manifestHash ?? null, acceptanceNamespace } });
      }
      database.exec('COMMIT');
      return { ok: true, replayed: true, run: prior, context: makeContext(database, prior, actor, scenario) };
    }
    const build = currentBuild(database, input);
    const baseline = baselineSnapshot(database, workspaceId);
    const baselineEventSequence = eventSequence(database, workspaceId);
    const baselineCheckpointRevision = actor.checkpointRevision;
    const baselineDataRootHash = dataRootHash(input.dataRootPath ?? input.dataRoot ?? options.dataRootPath);
    database.prepare(`INSERT INTO acceptance_runs (
      acceptance_run_id,workspace_id,scenario_id,scenario_input_hash,build_id,manifest_hash,acceptance_namespace,
      started_at_utc,started_at_mono,baseline_event_sequence,baseline_checkpoint_revision,baseline_table_hashes,
      baseline_counts,baseline_data_root_hash,fresh_after_mono,status,result_hash,evidence_pointer,created_at,
      finished_at_utc,finished_at_mono
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'running',NULL,NULL,?,NULL,NULL)`).run(
      acceptanceRunId, workspaceId, scenario.scenarioId, scenarioInputHash, build.buildId, build.manifestHash,
      acceptanceNamespace, startedAtUtc, startedAtMono, baselineEventSequence, baselineCheckpointRevision,
      canonicalJsonV1(baseline.tableHashes), canonicalJsonV1(baseline.counts), baselineDataRootHash, freshAfterMono, startedAtUtc
    );
    const row = readRunRow(database, acceptanceRunId);
    if (!row) throw new AcceptanceRunError('ACCEPTANCE_RUN_WRITE_FAILED', 'acceptance_runs 插入后无法读回。', { acceptanceRunId });
    const run = runFromRow(row);
    database.exec('COMMIT');
    result = { ok: true, replayed: false, run, context: makeContext(database, run, actor, scenario) };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve insertion error */ }
    if (error instanceof AcceptanceRunError) throw error;
    const replay = readRunRow(database, acceptanceRunId);
    if (!replay) throw error;
    const actor = actorFor(database, workspaceId);
    const prior = runFromRow(replay);
    if (prior.workspaceId !== workspaceId || prior.scenarioId !== scenario.scenarioId || prior.scenarioInputHash !== scenarioInputHash || prior.acceptanceNamespace !== acceptanceNamespace) throw new AcceptanceRunError('ACCEPTANCE_RUN_CONFLICT', '并发 acceptance run identity 冲突。', { acceptanceRunId });
    result = { ok: true, replayed: true, run: prior, context: makeContext(database, prior, actor, scenario) };
  }
  if (!result) throw new AcceptanceRunError('ACCEPTANCE_RUN_WRITE_FAILED', 'acceptance run start 未返回结果。', { acceptanceRunId });
  return result;
}

function provenanceColumnsPresent(database: DatabaseSync, table: string): boolean {
  const columns = new Set(tableColumns(database, table));
  return ACCEPTANCE_PROVENANCE_COLUMNS.every((column) => columns.has(column));
}

function collectFreshRows(database: DatabaseSync, run: AcceptanceRun): { rows: Row[]; errors: string[] } {
  const rows: Row[] = [];
  const errors: string[] = [];
  for (const table of ACCEPTANCE_HASH_TABLES) {
    if (!provenanceColumnsPresent(database, table)) continue;
    const selected = database.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE workspace_id=? AND acceptance_run_id=?`).all(run.workspaceId, run.acceptanceRunId) as Row[];
    for (const row of selected) {
      rows.push(row);
      const values = [row.acceptance_run_id, row.baseline_event_sequence, row.baseline_checkpoint_revision, row.created_after_event_sequence, row.created_after_checkpoint_revision, row.created_after_mono];
      if (values.some((value) => value === null || value === undefined)) errors.push(`${table}: acceptance provenance incomplete`);
      if (String(row.acceptance_run_id) !== run.acceptanceRunId) errors.push(`${table}: acceptance_run_id mismatch`);
      if (numberOr(row.baseline_event_sequence, -1) !== run.baselineEventSequence) errors.push(`${table}: baseline_event_sequence mismatch`);
      if (numberOr(row.baseline_checkpoint_revision, -1) !== run.baselineCheckpointRevision) errors.push(`${table}: baseline_checkpoint_revision mismatch`);
      if (numberOr(row.created_after_event_sequence, -1) <= run.baselineEventSequence) errors.push(`${table}: created_after_event_sequence is not fresh`);
      if (numberOr(row.created_after_checkpoint_revision, -1) <= run.baselineCheckpointRevision) errors.push(`${table}: created_after_checkpoint_revision is not fresh`);
      if (numberOr(row.created_after_mono, -1) < run.freshAfterMono) errors.push(`${table}: created_after_mono precedes fresh watermark`);
    }
  }
  return { rows, errors };
}

function freshSnapshot(database: DatabaseSync, workspaceId: string): { tableHashes: HashMap; counts: CountMap } {
  return baselineSnapshot(database, workspaceId);
}

function selectorRows(database: DatabaseSync, run: AcceptanceRun, selector: AcceptanceChildSelector): readonly Row[] {
  return readSelectedRows(database, selector.table, run.workspaceId, selector.where);
}

function isTerminalRow(row: Row): boolean {
  for (const key of ['status', 'state', 'result_status', 'terminal_status', 'scope_status']) {
    if (row[key] !== null && row[key] !== undefined && TERMINAL_VALUES.has(String(row[key]))) return true;
  }
  return ['finished_at', 'finished_at_utc', 'finished_at_mono', 'frozen_at', 'closed_at', 'cleanup_at_utc'].some((key) => row[key] !== null && row[key] !== undefined);
}

function eventProofRows(database: DatabaseSync, run: AcceptanceRun, eventType?: string): readonly Row[] {
  if (!tableExists(database, 'orchestrator_events')) return [];
  const rows = database.prepare('SELECT * FROM orchestrator_events WHERE workspace_id=? AND event_sequence>? ORDER BY event_sequence').all(run.workspaceId, run.baselineEventSequence) as Row[];
  return rows.filter((row) => String(row.acceptance_run_id ?? '') === run.acceptanceRunId && (!eventType || String(row.event_type) === eventType));
}

function eventContainsReason(row: Row, reasonCode: string): boolean {
  const payload = String(row.payload_json ?? row.payload_bytes ?? '');
  return payload.includes(reasonCode) || payload.includes('creation_forbidden_reason') || payload.includes('creationForbiddenReason');
}

function validateExpectedChildren(database: DatabaseSync, run: AcceptanceRun, expected: AcceptanceExpectedChildren): { errors: string[]; proof: Row[] } {
  const errors: string[] = [];
  const proof: Row[] = [];
  for (const selector of expected.required ?? []) {
    const rows = selectorRows(database, run, selector);
    const count = rows.length;
    const lower = selector.minCount ?? selector.count ?? 1;
    const upper = selector.maxCount ?? selector.count;
    if (count < lower || (upper !== undefined && count > upper)) errors.push(`${selector.label ?? selector.table}: expected ${selector.count ?? `${lower}..${upper ?? '∞'}`}, got ${count}`);
    for (const row of rows) {
      if (String(row.acceptance_run_id ?? '') !== run.acceptanceRunId) errors.push(`${selector.label ?? selector.table}: child is not tagged with this acceptance run`);
      if (numberOr(row.created_after_event_sequence, -1) <= run.baselineEventSequence) errors.push(`${selector.label ?? selector.table}: child event is not fresh`);
      if (numberOr(row.created_after_checkpoint_revision, -1) <= run.baselineCheckpointRevision) errors.push(`${selector.label ?? selector.table}: child checkpoint is not fresh`);
      if (numberOr(row.created_after_mono, -1) < run.freshAfterMono) errors.push(`${selector.label ?? selector.table}: child monotonic watermark is stale`);
      if (selector.terminal && !isTerminalRow(row)) errors.push(`${selector.label ?? selector.table}: required child is not terminal`);
      proof.push(row);
    }
  }
  for (const forbidden of expected.forbidden ?? []) {
    const rows = selectorRows(database, run, forbidden);
    if (rows.length !== 0) errors.push(`${forbidden.label ?? forbidden.table}: forbidden child count is ${rows.length}, expected zero`);
    const events = eventProofRows(database, run, forbidden.eventType).filter((row) => eventContainsReason(row, forbidden.reasonCode));
    if (!events.length) errors.push(`${forbidden.label ?? forbidden.table}: missing durable creation_forbidden_reason ${forbidden.reasonCode}`);
    proof.push(...events);
  }
  return { errors, proof };
}

function normalizeExpectedChildren(observation: AcceptanceScenarioObservation, scenario: AcceptanceScenarioDefinition): AcceptanceExpectedChildren {
  const expected = observation.expectedChildren ?? scenario.expectedChildren;
  return Object.freeze({ required: Object.freeze([...(expected.required ?? [])]), forbidden: Object.freeze([...(expected.forbidden ?? [])]) });
}

function terminalObservation(input: AcceptanceFinishInput): 'passed' | 'failed' | 'not_executed' {
  if (input.status) return input.status;
  if (input.passed === true) return 'passed';
  return 'failed';
}

function evidencePointerFor(run: AcceptanceRun, input: AcceptanceFinishInput, options: AcceptanceRunnerOptions): string {
  if (input.evidencePointer !== undefined) return requiredString(input.evidencePointer, 'evidencePointer');
  const root = options.defaultEvidenceRoot ?? 'acceptance-evidence';
  return `${root}/${run.workspaceId}/${run.scenarioId}/${run.acceptanceRunId}`;
}

function resultPreimage(run: AcceptanceRun, status: AcceptanceRunStatus, freshTableHashes: HashMap, freshCounts: CountMap, input: AcceptanceFinishInput, expected: AcceptanceExpectedChildren, proofRows: readonly Row[], freshRows: readonly Row[]): Record<string, unknown> {
  return {
    r: 'acceptance-result/v1', acceptanceRunId: run.acceptanceRunId, workspaceId: run.workspaceId,
    scenarioId: run.scenarioId, scenarioInputHash: run.scenarioInputHash, buildId: run.buildId,
    manifestHash: run.manifestHash, acceptanceNamespace: run.acceptanceNamespace,
    baseline: {
      eventSequence: run.baselineEventSequence, checkpointRevision: run.baselineCheckpointRevision,
      tableHashes: run.baselineTableHashes, counts: run.baselineCounts,
      dataRootHash: run.baselineDataRootHash, freshAfterMono: run.freshAfterMono
    },
    status, expectedChildren: expected, reason: input.reason ?? null, blocker: input.blocker ?? null,
    proof: input.proof ?? null, readbacks: input.readbacks ?? [], proofRows, freshRows,
    freshTableHashes, freshCounts
  };
}

function finishExisting(database: DatabaseSync, row: Row, input: AcceptanceFinishInput, options: AcceptanceRunnerOptions): AcceptanceFinishResult {
  const run = runFromRow(row);
  const status = terminalObservation(input);
  const evidencePointer = evidencePointerFor(run, input, options);
  if (status !== run.status || evidencePointer !== run.evidencePointer) throw new AcceptanceRunError('ACCEPTANCE_RUN_TERMINAL_CONFLICT', 'terminal acceptance run 只能按同一 canonical result replay。', { acceptanceRunId: run.acceptanceRunId, existing: run, requestedStatus: status, requestedEvidencePointer: evidencePointer });
  const fresh = freshSnapshot(database, run.workspaceId);
  return Object.freeze({
    ok: true,
    replayed: true,
    run,
    freshTableHashes: fresh.tableHashes,
    freshCounts: fresh.counts,
    resultHash: String(run.resultHash),
    evidencePointer: String(run.evidencePointer),
    proof: Object.freeze({ replay: true, acceptanceRunId: run.acceptanceRunId, resultHash: run.resultHash })
  });
}

export function finishAcceptanceRun(database: DatabaseSync, input: AcceptanceFinishInput, options: AcceptanceRunnerOptions = {}): AcceptanceFinishResult {
  ensureAcceptanceSchema(database);
  const acceptanceRunId = requiredString(input.acceptanceRunId, 'acceptanceRunId');
  const existing = readRunRow(database, acceptanceRunId);
  if (!existing) throw new AcceptanceRunError('ACCEPTANCE_RUN_NOT_FOUND', `acceptance run 不存在: ${acceptanceRunId}`, { acceptanceRunId });
  const current = runFromRow(existing);
  if (current.status !== 'running') return finishExisting(database, existing, input, options);
  const scenario = getScenarioDefinition(current.scenarioId);
  const status = terminalObservation(input);
  const expected = normalizeExpectedChildren(input, scenario);
  const childValidation = validateExpectedChildren(database, current, expected);
  const freshValidation = collectFreshRows(database, current);
  const hasForbiddenProof = (expected.forbidden ?? []).length > 0 && childValidation.proof.length > 0;
  const proofRows = childValidation.proof;
  if (status === 'passed') {
    if (childValidation.errors.length) throw new AcceptanceRunError('ACCEPTANCE_EXPECTED_CHILD_FAILED', 'expected-child contract 未满足。', { acceptanceRunId, errors: childValidation.errors });
    if (freshValidation.errors.length) throw new AcceptanceRunError('ACCEPTANCE_PROVENANCE_INCOMPLETE', '参与本轮的持久行 provenance 不完整或不是 fresh causal delta。', { acceptanceRunId, errors: freshValidation.errors });
    if (!freshValidation.rows.length && !hasForbiddenProof) throw new AcceptanceRunError('ACCEPTANCE_NO_DURABLE_DELTA', 'passed acceptance 必须有本轮真实持久行或 forbidden-child durable proof。', { acceptanceRunId });
    if (!(input.readbacks?.length ?? 0) && !proofRows.length) throw new AcceptanceRunError('ACCEPTANCE_READBACK_REQUIRED', 'passed acceptance 必须提供持久 readback proof。', { acceptanceRunId });
  }
  if (status === 'not_executed' && !requiredString(input.blocker ?? input.reason ?? '', 'blocker')) throw new AcceptanceRunError('ACCEPTANCE_BLOCKER_REQUIRED', 'not_executed acceptance 必须明确 blocker。', { acceptanceRunId });
  const fresh = freshSnapshot(database, current.workspaceId);
  const evidencePointer = evidencePointerFor(current, input, options);
  const preimage = resultPreimage(current, status, fresh.tableHashes, fresh.counts, input, expected, proofRows, freshValidation.rows);
  const resultHash = hashV1(preimage);
  const nowUtc = options.nowUtc ?? defaultNowUtc;
  const nowMono = options.nowMono ?? defaultNowMono;
  const finishedAtUtc = normalizedUtc(input.finishedAtUtc, normalizedUtc(nowUtc(), defaultNowUtc()));
  const finishedAtMono = input.finishedAtMono === undefined ? asFiniteNumber(nowMono(), 'finishedAtMono') : asFiniteNumber(input.finishedAtMono, 'finishedAtMono');
  try {
    database.exec('BEGIN IMMEDIATE');
    const update = database.prepare(`UPDATE acceptance_runs SET status=?, result_hash=?, evidence_pointer=?, finished_at_utc=?, finished_at_mono=? WHERE acceptance_run_id=? AND status='running'`).run(status, resultHash, evidencePointer, finishedAtUtc, finishedAtMono, current.acceptanceRunId);
    if (Number(update.changes ?? 0) !== 1) {
      database.exec('ROLLBACK');
      const raced = readRunRow(database, current.acceptanceRunId);
      if (!raced) throw new AcceptanceRunError('ACCEPTANCE_RUN_WRITE_FAILED', 'terminal acceptance row disappeared。', { acceptanceRunId });
      return finishExisting(database, raced, input, options);
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve original error */ }
    if (error instanceof AcceptanceRunError) throw error;
    const raced = readRunRow(database, current.acceptanceRunId);
    if (raced && runFromRow(raced).status !== 'running') return finishExisting(database, raced, input, options);
    throw error;
  }
  const row = readRunRow(database, current.acceptanceRunId);
  if (!row) throw new AcceptanceRunError('ACCEPTANCE_RUN_WRITE_FAILED', 'terminal acceptance row 无法读回。', { acceptanceRunId });
  const run = runFromRow(row);
  return Object.freeze({ ok: true, replayed: false, run, freshTableHashes: fresh.tableHashes, freshCounts: fresh.counts, resultHash, evidencePointer, proof: Object.freeze(preimage) });
}

export class DurableAcceptanceRunner {
  readonly database: DatabaseSync;
  readonly options: AcceptanceRunnerOptions;

  constructor(database: DatabaseSync, options: AcceptanceRunnerOptions = {}) {
    this.database = database;
    this.options = Object.freeze({ ...options });
  }

  read(acceptanceRunId: string): AcceptanceRun | null { return readAcceptanceRun(this.database, acceptanceRunId); }
  list(workspaceId: string): readonly AcceptanceRun[] { return listAcceptanceRuns(this.database, workspaceId); }
  scenarios(): readonly AcceptanceScenarioDefinition[] { return acceptanceScenarioRegistry(); }
  start(input: StartAcceptanceRunInput): AcceptanceStartResult { return startAcceptanceRun(this.database, input, this.options); }
  finish(input: AcceptanceFinishInput): AcceptanceFinishResult { return finishAcceptanceRun(this.database, input, this.options); }
  run(input: AcceptanceRunInput): Promise<AcceptanceRunResult> { return runAcceptanceScenario(this.database, input, this.options); }
}

export function createDurableAcceptanceRunner(database: DatabaseSync, options: AcceptanceRunnerOptions = {}): DurableAcceptanceRunner {
  return new DurableAcceptanceRunner(database, options);
}

export async function runAcceptanceScenario(database: DatabaseSync, input: AcceptanceRunInput, options: AcceptanceRunnerOptions = {}): Promise<AcceptanceRunResult> {
  const started = startAcceptanceRun(database, input, options);
  if (started.replayed && started.run.status !== 'running') {
    const previous = started.run.status;
    return finishExisting(database, readRunRow(database, started.run.acceptanceRunId) as Row, {
      acceptanceRunId: started.run.acceptanceRunId,
      status: previous,
      passed: previous === 'passed',
      reason: previous === 'not_executed' ? 'replayed not_executed run' : null,
      blocker: previous === 'not_executed' ? 'replayed not_executed run' : null,
      evidencePointer: started.run.evidencePointer ?? undefined,
      proof: { replay: true }
    }, options);
  }
  const executor = input.execute;
  if (typeof executor !== 'function') {
    return finishAcceptanceRun(database, {
      acceptanceRunId: started.run.acceptanceRunId,
      status: 'failed',
      reason: 'ACCEPTANCE_EXECUTOR_REQUIRED',
      proof: { scenarioId: started.run.scenarioId, description: started.context.scenario.description },
      evidencePointer: input.evidencePointer
    }, options);
  }
  try {
    const observation = await executor(started.context);
    return finishAcceptanceRun(database, {
      acceptanceRunId: started.run.acceptanceRunId,
      status: observation.status ?? (observation.passed === true ? 'passed' : 'failed'),
      passed: observation.passed,
      proof: observation.proof,
      readbacks: observation.readbacks,
      producedRows: observation.producedRows,
      expectedChildren: observation.expectedChildren,
      evidencePointer: observation.evidencePointer ?? input.evidencePointer,
      reason: observation.reason,
      blocker: observation.blocker
    }, options);
  } catch (error) {
    const reason = error instanceof AcceptanceRunError ? `${error.code}: ${error.message}` : String(error instanceof Error ? error.message : error);
    return finishAcceptanceRun(database, {
      acceptanceRunId: started.run.acceptanceRunId,
      status: 'failed',
      reason,
      proof: { error: reason },
      evidencePointer: input.evidencePointer
    }, options);
  }
}

export const runAcceptance = runAcceptanceScenario;
