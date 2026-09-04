import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AI_FRONTIER_LIST_ID } from './intelligence-wire.ts';
import { getSource, type SourceRecord } from './sources.ts';

/**
 * 赛道资料门（WMB-4941 数据契约 + WMB-4942 Tier 0/1 编排地基）。
 *
 * - 判定流水的事实写入与读取（4941）。
 * - Tier 0 确定性规则：官方信源（registry feed）/ 赛道精选信源（AI-only route 的 AI 前沿 List）
 *   直判相关、零模型（4942）。
 * - 归档写路径：`applyLaneGateBatch` 把「不相关 → management_status='archived'」与判定流水行
 *   放在同一事务内写入（4942），供 `sources.lane_gate` 命令与判定编排（agent-runner 裸库路径）复用。
 * - 主编覆写恢复 + 7 日冷却（4941/4944）。
 * 「已移出」视图 UI（WMB-4944）不在此模块。
 */

/** 主编覆写/判定后的冷却窗口：7 日内同 source_id 不再重判（泊车语义，与 dismiss 一致）。 */
export const LANE_JUDGMENT_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

/**
 * §3.2 reason_code 词典（MVP + 4942 补充）。
 * `lane_relevant` 为 Tier 1 编辑判定「相关」的默认记录码（设计 §3.2 输出示例中 relevant 条目
 * 不携带 reasonCode，但流水表 reason_code NOT NULL，故补充该码）。
 */
export const LANE_REASON_CODES = Object.freeze([
  'off_lane_content',
  'lifestyle_noise',
  'ad_promotion',
  'out_of_scope_region',
  'duplicate_series',
  'edge_ai_adjacent',
  'official_source',
  'editor_override',
  'lane_relevant'
] as const);

/** 模型（Tier 1）不得使用的系统/主编专属 reason_code（official_source / editor_override / lane_relevant）。 */

/** Tier 0 判定轮快照：官方/赛道精选信源自动相关，judged_by=system、reason_code=official_source。 */
export const LANE_TIER0_REASON_CODE = 'official_source' as const;

export type LaneReasonCode = (typeof LANE_REASON_CODES)[number];
export type LaneDecision = 'relevant' | 'irrelevant';
export type LaneJudgedBy = 'system' | 'agent' | 'editor';

export type LaneJudgmentRecord = Readonly<{
  id: string;
  sourceId: string;
  workspaceLane: string;
  decision: LaneDecision;
  reasonCode: LaneReasonCode;
  reason: string | null;
  judgedBy: LaneJudgedBy;
  confidence: number | null;
  sourceRevision: number;
  judgedAt: string;
}>;

export type LaneJudgmentWriteInput = Readonly<{
  sourceId: string;
  workspaceLane: string;
  decision: LaneDecision;
  reasonCode: LaneReasonCode;
  reason?: string;
  judgedBy: LaneJudgedBy;
  confidence?: number;
  /** 判定时读取的 source_items.revision（乐观并发）；不匹配则整批零写。 */
  expectedRevision: number;
  /** 判定轮时间戳快照；同 (source_id, judged_at) 重放零写。 */
  judgedAt?: string;
}>;

export type LaneJudgmentWriteResult = Readonly<{
  judgment: LaneJudgmentRecord;
  written: boolean;
}>;

export type LaneRestoreInput = Readonly<{
  sourceId: string;
  workspaceLane: string;
  expectedRevision: number;
  reason?: string;
  judgedAt?: string;
}>;

export type LaneRestoreResult = Readonly<{
  source: SourceRecord;
  judgment: LaneJudgmentRecord | null;
  restored: boolean;
}>;

/** 一轮判定门的候选资料（与编辑简报增量同窗口，已排除 archived）。 */
export type LaneGateCandidate = Readonly<{
  sourceId: string;
  revision: number;
  feedId: string | null;
  collectedAt: string;
  title: string;
  canonicalUrl: string | null;
  summary: string | null;
}>;

export type LaneGateBatchJudgment = Readonly<{
  sourceId: string;
  decision: LaneDecision;
  reasonCode: LaneReasonCode;
  reason?: string;
  expectedRevision: number;
  confidence?: number;
}>;

export type LaneGateBatchInput = Readonly<{
  workspaceLane: string;
  judgedBy: Extract<LaneJudgedBy, 'system' | 'agent'>;
  judgedAt?: string;
  judgments: readonly LaneGateBatchJudgment[];
}>;

export type LaneGateBatchResult = Readonly<{
  written: ReadonlyArray<Readonly<{ sourceId: string; judgmentId: string; decision: LaneDecision }>>;
  archived: ReadonlyArray<Readonly<{ sourceId: string; revision: number }>>;
  skipped: ReadonlyArray<Readonly<{ sourceId: string; reason: string }>>;
  judgments: ReadonlyArray<LaneJudgmentRecord>;
}>;

type JudgmentRow = {
  id: string;
  source_id: string;
  workspace_lane: string;
  decision: LaneDecision;
  reason_code: string;
  reason: string | null;
  judged_by: LaneJudgedBy;
  confidence: number | null;
  source_revision: number;
  judged_at: string;
};

function laneError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function assertJudgmentShape(input: LaneJudgmentWriteInput): void {
  if (input.decision !== 'relevant' && input.decision !== 'irrelevant') {
    throw laneError('LANE_JUDGMENT_INVALID', 'decision 必须是 relevant 或 irrelevant。');
  }
  if (!(LANE_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
    throw laneError('LANE_JUDGMENT_INVALID', `reason_code 不在 MVP 词典内：${input.reasonCode}`);
  }
  if (input.judgedBy !== 'system' && input.judgedBy !== 'agent' && input.judgedBy !== 'editor') {
    throw laneError('LANE_JUDGMENT_INVALID', 'judged_by 必须是 system、agent 或 editor。');
  }
  if (input.decision === 'irrelevant' && !input.reason?.trim()) {
    throw laneError('LANE_JUDGMENT_INVALID', 'irrelevant 判定必须携带一句话 reason。');
  }
  if (input.confidence !== undefined && (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence))) {
    throw laneError('LANE_JUDGMENT_INVALID', 'confidence 必须是有限数字。');
  }
}

function parseJudgment(row: JudgmentRow): LaneJudgmentRecord {
  return Object.freeze({
    id: row.id,
    sourceId: row.source_id,
    workspaceLane: row.workspace_lane,
    decision: row.decision,
    reasonCode: row.reason_code as LaneReasonCode,
    reason: row.reason,
    judgedBy: row.judged_by,
    confidence: row.confidence,
    sourceRevision: row.source_revision,
    judgedAt: row.judged_at
  });
}

/**
 * 追加一条判定流水（纯追加，覆写不删旧行；当前判定 = 该 source_id 最新一行）。
 * 同 (source_id, judged_at) 的重复执行零写（判定轮幂等）。
 */
export function writeLaneJudgment(database: DatabaseSync, input: LaneJudgmentWriteInput): LaneJudgmentWriteResult {
  assertJudgmentShape(input);
  const source = database.prepare('SELECT revision FROM source_items WHERE id=?')
    .get(input.sourceId) as { revision: number } | undefined;
  if (!source) throw laneError('SOURCE_NOT_FOUND', 'source_id 不存在。');
  if (source.revision !== input.expectedRevision) {
    throw laneError('REVISION_CONFLICT', '判定基于的 source revision 已过期。');
  }
  const judgedAt = input.judgedAt ?? new Date().toISOString();
  const existing = database.prepare(
    'SELECT id, source_id, workspace_lane, decision, reason_code, reason, judged_by, confidence, source_revision, judged_at FROM source_lane_judgments WHERE source_id=? AND judged_at=? ORDER BY id DESC LIMIT 1'
  ).get(input.sourceId, judgedAt) as JudgmentRow | undefined;
  if (existing) return { judgment: parseJudgment(existing), written: false };

  const id = randomUUID();
  database.prepare(`INSERT INTO source_lane_judgments (
    id, source_id, workspace_lane, decision, reason_code, reason, judged_by, confidence, source_revision, judged_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.sourceId, input.workspaceLane, input.decision, input.reasonCode,
    input.reason?.trim() || null, input.judgedBy, input.confidence ?? null, source.revision, judgedAt
  );
  const row = database.prepare(
    'SELECT id, source_id, workspace_lane, decision, reason_code, reason, judged_by, confidence, source_revision, judged_at FROM source_lane_judgments WHERE id=?'
  ).get(id) as JudgmentRow;
  return { judgment: parseJudgment(row), written: true };
}

export function readLaneJudgments(
  database: DatabaseSync,
  input: { sourceId?: string; workspaceLane?: string; limit?: number; offset?: number } = {}
): LaneJudgmentRecord[] {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (input.sourceId) { clauses.push('source_id = ?'); params.push(input.sourceId); }
  if (input.workspaceLane) { clauses.push('workspace_lane = ?'); params.push(input.workspaceLane); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const rows = database.prepare(`SELECT id, source_id, workspace_lane, decision, reason_code, reason, judged_by, confidence, source_revision, judged_at
    FROM source_lane_judgments ${where}
    ORDER BY judged_at DESC, id DESC
    LIMIT ? OFFSET ?`).all(...params) as JudgmentRow[];
  return rows.map(parseJudgment);
}

/** 当前判定 = 该 source_id 最新一行（追加型的读取语义）。 */
export function getLatestLaneJudgment(database: DatabaseSync, sourceId: string): LaneJudgmentRecord | null {
  const row = database.prepare(`SELECT id, source_id, workspace_lane, decision, reason_code, reason, judged_by, confidence, source_revision, judged_at
    FROM source_lane_judgments WHERE source_id = ?
    ORDER BY judged_at DESC, id DESC LIMIT 1`).get(sourceId) as JudgmentRow | undefined;
  return row ? parseJudgment(row) : null;
}

/**
 * 冷却助手：最近一次判定距今 < cooldownMs 时跳过重判。
 * 主编覆写（restore）写入 editor 行后，Tier 0/1 在 7 日内不得再判同 source_id。
 * 完整版（WMB-4944）在 UI 层做显式提示；判定编排层（4942/4945）调用本函数。
 */
export function shouldSkipJudgment(
  database: DatabaseSync,
  sourceId: string,
  now = new Date(),
  cooldownMs = LANE_JUDGMENT_COOLDOWN_MS
): boolean {
  const latest = getLatestLaneJudgment(database, sourceId);
  if (!latest) return false;
  return now.getTime() - Date.parse(latest.judgedAt) < cooldownMs;
}

/**
 * Tier 0 确定性规则（零模型）：官方/赛道精选信源直判相关。
 *
 * - 官方信源：source_items.feed_id → source_feeds.registry_id 非空（W1 主发清单官方 web 巡检渠道
 *   是唯一写 registry_id 的入口，且按工作空间 intelligencePackId 各自挂载，天然赛道映射）。
 * - 赛道精选信源：AI 工作空间（wemedia-intelligence-engine）的 AI 前沿 List
 *   （AI-only route 索引中的 x_lists 主线，`AI_FRONTIER_LIST_ID`）绑定 feed。
 *
 * 其余渠道（含其它 X List、用户渠道）内容一律交 Tier 1 逐条判定——混发噪音恰在此层被过滤。
 */
export function isTier0AutoRelevantSource(database: DatabaseSync, source: { feedId: string | null }, lane: string): boolean {
  if (!source.feedId) return false;
  const feed = database.prepare('SELECT registry_id AS registryId FROM source_feeds WHERE id=?')
    .get(source.feedId) as { registryId: string | null } | undefined;
  if (feed?.registryId) return true;
  if (lane === 'wemedia-intelligence-engine') {
    const binding = database.prepare('SELECT 1 AS hit FROM x_list_bindings WHERE source_feed_id=? AND enabled=1 AND list_id=?')
      .get(source.feedId, AI_FRONTIER_LIST_ID) as { hit: number } | undefined;
    if (binding) return true;
  }
  return false;
}

/**
 * 一轮判定门的候选资料：与编辑简报增量同一窗口（collected_at > since，最新优先，默认上限 60），
 * 排除已移出（archived）条目——已移出条目直接命中既有状态，不进入判定轮。
 */
export function listLaneGateCandidates(database: DatabaseSync, input: { since: string; limit?: number }): LaneGateCandidate[] {
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200);
  return database.prepare(`SELECT id AS sourceId, revision, feed_id AS feedId, collected_at AS collectedAt,
      title, canonical_url AS canonicalUrl, summary
    FROM source_items
    WHERE collected_at > ? AND management_status != 'archived'
    ORDER BY collected_at DESC
    LIMIT ?`).all(input.since, limit) as LaneGateCandidate[];
}

/**
 * 归档写路径：不相关判定把 management_status 置 archived（revision+1）并追加判定流水行，
 * 相关判定仅追加流水行——整批在同一事务内（dispatcher 事务或本函数自带事务），
 * 任一判定失败（SOURCE_NOT_FOUND / REVISION_CONFLICT / 形状非法）→ 整批零写回滚。
 *
 * 幂等语义（设计 §5）：
 * - 已 archived 条目：irrelevant 直接命中既有状态 → skipped(already_archived) 零写；
 *   relevant 仅覆盖判定记录（最新行胜出），不反复翻转状态。
 * - 同 (source_id, judged_at) 重放 → skipped(already_judged) 零写。
 */
export function applyLaneGateBatch(database: DatabaseSync, input: LaneGateBatchInput, options: { transaction?: boolean } = {}): LaneGateBatchResult {
  if (options.transaction === false) return applyLaneGateBatchInner(database, input);
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = applyLaneGateBatchInner(database, input);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyLaneGateBatchInner(database: DatabaseSync, input: LaneGateBatchInput): LaneGateBatchResult {
  const written: Array<{ sourceId: string; judgmentId: string; decision: LaneDecision }> = [];
  const archived: Array<{ sourceId: string; revision: number }> = [];
  const skipped: Array<{ sourceId: string; reason: string }> = [];
  const judgments: LaneJudgmentRecord[] = [];
  for (const judgment of input.judgments) {
    const source = getSource(database, judgment.sourceId);
    if (!source) throw laneError('SOURCE_NOT_FOUND', 'source_id 不存在。');
    if (source.revision !== judgment.expectedRevision) {
      throw laneError('REVISION_CONFLICT', '判定基于的 source revision 已过期。');
    }
    if (source.managementStatus === 'archived') {
      if (judgment.decision === 'irrelevant') {
        skipped.push({ sourceId: judgment.sourceId, reason: 'already_archived' });
        continue;
      }
      // relevant × archived：仅覆盖判定记录（最新行胜出），状态不翻转（可恢复语义由 lane_restore 负责）。
    }
    let expectedRevision = judgment.expectedRevision;
    if (judgment.decision === 'irrelevant') {
      const now = new Date().toISOString();
      const updated = database.prepare(
        "UPDATE source_items SET management_status='archived', updated_at=?, revision=revision+1 WHERE id=? AND revision=?"
      ).run(now, judgment.sourceId, judgment.expectedRevision);
      if (updated.changes !== 1) throw laneError('REVISION_CONFLICT', '归档时 source revision 已被并发修改。');
      expectedRevision += 1;
      archived.push({ sourceId: judgment.sourceId, revision: expectedRevision });
    }
    const result = writeLaneJudgment(database, {
      sourceId: judgment.sourceId,
      workspaceLane: input.workspaceLane,
      decision: judgment.decision,
      reasonCode: judgment.reasonCode,
      reason: judgment.reason,
      judgedBy: input.judgedBy,
      confidence: judgment.confidence,
      expectedRevision,
      judgedAt: input.judgedAt
    });
    if (result.written) {
      written.push({ sourceId: judgment.sourceId, judgmentId: result.judgment.id, decision: result.judgment.decision });
      judgments.push(result.judgment);
    } else {
      skipped.push({ sourceId: judgment.sourceId, reason: 'already_judged' });
    }
  }
  return { written, archived, skipped, judgments };
}

/**
 * 主编覆写恢复：把已移出（archived）的资料置回 active，并追加 judged_by=editor 流水行。
 * 幂等：资料已是 active（非 archived）时零写返回 restored=false。
 */
export function restoreFilteredSource(database: DatabaseSync, input: LaneRestoreInput): LaneRestoreResult {
  const source = getSource(database, input.sourceId);
  if (!source) throw laneError('SOURCE_NOT_FOUND', 'source_id 不存在。');
  if (source.revision !== input.expectedRevision) {
    throw laneError('REVISION_CONFLICT', '恢复基于的 source revision 已过期。');
  }
  if (source.managementStatus !== 'archived') {
    return { source, judgment: null, restored: false };
  }
  const now = new Date().toISOString();
  const updated = database.prepare(
    "UPDATE source_items SET management_status='active', updated_at=?, revision=revision+1 WHERE id=? AND revision=?"
  ).run(now, input.sourceId, input.expectedRevision);
  if (updated.changes !== 1) throw laneError('REVISION_CONFLICT', '恢复时 source revision 已被并发修改。');
  const judgment = writeLaneJudgment(database, {
    sourceId: input.sourceId,
    workspaceLane: input.workspaceLane,
    decision: 'relevant',
    reasonCode: 'editor_override',
    reason: input.reason?.trim() || '主编恢复',
    judgedBy: 'editor',
    expectedRevision: input.expectedRevision + 1,
    judgedAt: input.judgedAt ?? now
  });
  const restored = getSource(database, input.sourceId);
  if (!restored) throw laneError('SOURCE_NOT_FOUND', '恢复后无法读回 source。');
  return { source: restored, judgment: judgment.judgment, restored: true };
}
