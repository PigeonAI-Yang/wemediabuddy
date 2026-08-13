/**
 * WMB-5174：research_successor 只读投影（记者卡研究摘要 + Today「研究缺口 · 等你批」）。
 *
 * 纯读模块——不触碰 research 状态机/schema/命令面（decide/enqueue/kick 全部留在
 * research-successor.ts）。规则：
 * - 数据缺失 → 字段为 null / 省略，绝不伪造百分比、计数或声明原文。
 * - Today 只投影 status='needs_user' 且携带 unresolved required claims 的续派行；
 *   候选、进度、裸资料永不进入该投影。
 * - claim 原文从 research_claims 冻结行读回（缺失时不编造，仅给 key）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AgentTask, AgentTaskProgress } from './agent-tasks.ts';
import type { ResearchClaimType } from './db/research-claims-store.ts';
import type { ResearchSuccessorDecision } from './research-successor.ts';

/** 记者卡研究摘要（research 任务专属；非 research 任务恒 null）。 */
export type CrewResearchSummary = Readonly<{
  /** research 预算进度（progress_json：planned/processed/verified/saved；缺字段为 null）。 */
  planned: number | null;
  processed: number | null;
  verified: number | null;
  saved: number | null;
  /** research_claims 判定计数（任务已落 claim 行时非 null；无行 = null，不伪造）。 */
  claims: Readonly<{
    total: number;
    supported: number;
    contradicted: number;
    unresolved: number;
    sourceUnavailable: number;
    pending: number;
  }> | null;
}>;

/** Today「研究缺口 · 等你批」单行投影：只含 unresolved required needs_user 的语义载荷。 */
export type ResearchSuccessorNeedsUserItem = Readonly<{
  /** 续派行 jobId（decideResearchSuccessor 的第一参数）。 */
  id: string;
  parentJobId: string;
  parentTaskId: string;
  researchTaskId: string;
  parentRoleId: 'writer' | 'planner' | 'librarian';
  /** 未解决 required claims：key + 冻结原文（原文缺失时 text=null，不编造）。 */
  unresolvedClaims: ReadonlyArray<Readonly<{ key: string; text: string | null; type: ResearchClaimType | null }>>;
  /** 尚未决策（needs_user 行恒 null）。 */
  decision: ResearchSuccessorDecision | null;
  createdAt: string;
  updatedAt: string;
}>;

type NeedsUserRow = {
  id: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

type ParsedNeedsUserPayload = {
  parentJobId: string;
  parentTaskId: string;
  researchTaskId: string;
  parentRoleId: ResearchSuccessorNeedsUserItem['parentRoleId'];
  unresolvedClaimKeys: string[];
};

/** 损坏 payload fail-closed：不投递不可信行（与状态机 parseRow 同源约束）。 */
function parseNeedsUserPayload(json: string): ParsedNeedsUserPayload | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const researchTaskId = typeof record.researchTaskId === 'string' ? record.researchTaskId : '';
  const parentJobId = typeof record.parentJobId === 'string' ? record.parentJobId : '';
  const parentTaskId = typeof record.parentTaskId === 'string' ? record.parentTaskId : '';
  const parentRoleId = record.parentRoleId === 'planner' || record.parentRoleId === 'librarian' ? record.parentRoleId : 'writer';
  if (!researchTaskId || !parentJobId) return null;
  const unresolvedClaimKeys = Array.isArray(record.unresolvedRequiredClaims)
    ? (record.unresolvedRequiredClaims as unknown[]).filter((key): key is string => typeof key === 'string' && key.length > 0)
    : [];
  if (unresolvedClaimKeys.length === 0) return null;
  return { parentJobId, parentTaskId, researchTaskId, parentRoleId, unresolvedClaimKeys };
}

/** research_claims 冻结原文索引：(taskId, claimKey) → {text, type}。 */
function claimTextIndex(database: DatabaseSync, taskIds: string[]): Map<string, { text: string; type: ResearchClaimType }> {
  const index = new Map<string, { text: string; type: ResearchClaimType }>();
  for (const taskId of taskIds) {
    const rows = database.prepare(
      'SELECT claim_key AS claimKey, claim_text AS claimText, claim_type AS claimType FROM research_claims WHERE task_id = ?'
    ).all(taskId) as Array<{ claimKey: string; claimText: string; claimType: string }>;
    for (const row of rows) {
      const type = row.claimType === 'fact' || row.claimType === 'price' || row.claimType === 'policy' ? row.claimType : null;
      if (type) index.set(`${taskId}\u0000${row.claimKey}`, { text: row.claimText, type });
    }
  }
  return index;
}

/** research 任务预算计数（缺字段 → null；数据缺失不伪造）。 */
function researchCounts(progress: AgentTaskProgress | undefined): Pick<CrewResearchSummary, 'planned' | 'processed' | 'verified' | 'saved'> {
  const planned = typeof progress?.planned === 'number' && Number.isFinite(progress.planned) ? progress.planned : null;
  const processed = typeof progress?.processed === 'number' && Number.isFinite(progress.processed) ? progress.processed : null;
  const verified = typeof progress?.verified === 'number' && Number.isFinite(progress.verified) ? progress.verified : null;
  const saved = typeof progress?.saved === 'number' && Number.isFinite(progress.saved) ? progress.saved : null;
  return { planned, processed, verified, saved };
}

/** research_claims 判定计数（无行 → null，不伪造）。 */
function claimCounts(database: DatabaseSync, taskId: string): CrewResearchSummary['claims'] {
  const rows = database.prepare('SELECT status status FROM research_claims WHERE task_id = ?').all(taskId) as Array<{ status: string }>;
  if (rows.length === 0) return null;
  const counts = { total: rows.length, supported: 0, contradicted: 0, unresolved: 0, sourceUnavailable: 0, pending: 0 };
  for (const row of rows) {
    if (row.status === 'supported') counts.supported += 1;
    else if (row.status === 'contradicted') counts.contradicted += 1;
    else if (row.status === 'unresolved') counts.unresolved += 1;
    else if (row.status === 'source_unavailable') counts.sourceUnavailable += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** 记者卡研究摘要：仅 research 任务非 null；非 research 或数据缺失 → 无伪造字段。 */
export function readCrewResearchSummary(database: DatabaseSync, task: Pick<AgentTask, 'id' | 'intent' | 'progress'> | null): CrewResearchSummary | null {
  if (!task || task.intent !== 'research') return null;
  return {
    ...researchCounts(task.progress),
    claims: claimCounts(database, task.id)
  };
}

/** Today 投影：status='needs_user' 的研究续派行（含未解决声明原文；无候选/进度/裸资料）。 */
export function listResearchSuccessorNeedsUser(database: DatabaseSync): ResearchSuccessorNeedsUserItem[] {
  const rows = database.prepare(
    `SELECT id, payload_json, created_at, updated_at FROM jobs
     WHERE kind = 'research_successor' AND status = 'needs_user'
     ORDER BY created_at, id`
  ).all() as NeedsUserRow[];
  const parsedRows: Array<{ row: NeedsUserRow; payload: ParsedNeedsUserPayload }> = [];
  for (const row of rows) {
    const payload = parseNeedsUserPayload(row.payload_json);
    if (payload) parsedRows.push({ row, payload });
  }
  const texts = claimTextIndex(database, [...new Set(parsedRows.map((entry) => entry.payload.researchTaskId))]);
  const items: ResearchSuccessorNeedsUserItem[] = [];
  for (const { row, payload } of parsedRows) {
    items.push({
      id: row.id,
      parentJobId: payload.parentJobId,
      parentTaskId: payload.parentTaskId,
      researchTaskId: payload.researchTaskId,
      parentRoleId: payload.parentRoleId,
      unresolvedClaims: payload.unresolvedClaimKeys.map((key) => {
        const frozen = texts.get(`${payload.researchTaskId}\u0000${key}`);
        return { key, text: frozen?.text ?? null, type: frozen?.type ?? null };
      }),
      decision: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
  return items;
}
