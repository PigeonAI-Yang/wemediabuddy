/**
 * WMB-5171 / CAP-028 §9 / 设计 §7.2：research_claims 存取模块。
 * 只读写 research_claims 表，不触碰其他表；不做 claim 阈值/判定推导（WMB-5172 runner 负责）。
 *
 * 约定：
 * - 按 (task_id, claim_key) 幂等 upsert（UNIQUE 语义；重放同内容不产生第二行、不覆盖冻结字段）。
 * - 冻结字段：claim_text / claim_type / needs_time_excerpt（spawn 时复制；price|policy ⇒ needs_time_excerpt=1，存储边界强制）。
 * - 可更新判定字段：status / verdict_reason / evidence_source_ids_json / verified_at / updated_at。
 * - evidence_source_ids_json 用确定性归一化 JSON（对象键排序、数组保序去重）落库。
 */

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from '../result.ts';

export type ResearchClaimType = 'fact' | 'price' | 'policy';
export type ResearchClaimStatus = 'pending' | 'supported' | 'contradicted' | 'unresolved' | 'source_unavailable';

export type ResearchClaim = {
  id: string;
  taskId: string;
  claimKey: string;
  claimText: string;
  claimType: ResearchClaimType;
  status: ResearchClaimStatus;
  verdictReason: string | null;
  evidenceSourceIds: string[];
  needsTimeExcerpt: 0 | 1;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertResearchClaimInput = {
  taskId: string;
  claimKey: string;
  claimText: string;
  claimType: ResearchClaimType;
  status: ResearchClaimStatus;
  verdictReason?: string | null;
  evidenceSourceIds?: string[];
  needsTimeExcerpt?: 0 | 1;
  verifiedAt?: string | null;
};

export type ResearchClaimsSnapshot = {
  taskId: string;
  claims: ResearchClaim[];
};

const CLAIM_TYPES = new Set<ResearchClaimType>(['fact', 'price', 'policy']);
const CLAIM_STATUSES = new Set<ResearchClaimStatus>(['pending', 'supported', 'contradicted', 'unresolved', 'source_unavailable']);

type ResearchClaimRow = {
  id: string;
  task_id: string;
  claim_key: string;
  claim_text: string;
  claim_type: ResearchClaimType;
  status: ResearchClaimStatus;
  verdict_reason: string | null;
  evidence_source_ids_json: string;
  needs_time_excerpt: number;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

const CLAIM_COLUMNS = `id, task_id, claim_key, claim_text, claim_type, status, verdict_reason,
  evidence_source_ids_json, needs_time_excerpt, verified_at, created_at, updated_at`;

function parseClaim(row: ResearchClaimRow): ResearchClaim {
  return {
    id: row.id,
    taskId: row.task_id,
    claimKey: row.claim_key,
    claimText: row.claim_text,
    claimType: row.claim_type,
    status: row.status,
    verdictReason: row.verdict_reason,
    evidenceSourceIds: JSON.parse(row.evidence_source_ids_json) as string[],
    needsTimeExcerpt: row.needs_time_excerpt === 1 ? 1 : 0,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * 幂等 upsert：(task_id, claim_key) 已存在则只更新判定字段（status/verdict_reason/
 * evidence/verified_at/updated_at），id/claim_text/claim_type/needs_time_excerpt/created_at 冻结不变。
 */
export function upsertResearchClaim(database: DatabaseSync, input: UpsertResearchClaimInput): CommandResult<ResearchClaim> {
  const taskId = input.taskId?.trim();
  if (!taskId) return failure('VALIDATION_ERROR', '研究任务 ID 不能为空。');
  const claimKey = input.claimKey?.trim();
  if (!claimKey) return failure('VALIDATION_ERROR', '声明键不能为空。');
  const claimText = input.claimText?.trim();
  if (!claimText) return failure('VALIDATION_ERROR', '声明原文不能为空。');
  if (!CLAIM_TYPES.has(input.claimType)) return failure('VALIDATION_ERROR', '声明类型必须是 fact/price/policy。');
  if (!CLAIM_STATUSES.has(input.status)) return failure('VALIDATION_ERROR', '声明状态无效。');
  const verdictReason = normalizeNullableString(input.verdictReason);
  const verifiedAt = normalizeNullableString(input.verifiedAt);
  if (input.evidenceSourceIds !== undefined && !Array.isArray(input.evidenceSourceIds)) return failure('VALIDATION_ERROR', '证据来源必须是字符串数组。');
  const evidenceSourceIds: string[] = [];
  for (const sourceId of input.evidenceSourceIds ?? []) {
    if (typeof sourceId !== 'string' || !sourceId.trim()) return failure('VALIDATION_ERROR', '证据来源 ID 必须是非空字符串。');
    const trimmed = sourceId.trim();
    if (!evidenceSourceIds.includes(trimmed)) evidenceSourceIds.push(trimmed);
  }
  const derivedExcerpt: 0 | 1 = input.claimType === 'price' || input.claimType === 'policy' ? 1 : 0;
  if (input.needsTimeExcerpt !== undefined && input.needsTimeExcerpt !== 0 && input.needsTimeExcerpt !== 1) {
    return failure('VALIDATION_ERROR', 'needs_time_excerpt 必须是 0 或 1。');
  }
  const needsTimeExcerpt: 0 | 1 = input.needsTimeExcerpt ?? derivedExcerpt;
  if (needsTimeExcerpt !== derivedExcerpt) {
    return failure('VALIDATION_ERROR', `声明类型 ${input.claimType} 要求 needs_time_excerpt=${derivedExcerpt}。`);
  }
  const now = new Date().toISOString();
  try {
    const row = database.prepare(`
      INSERT INTO research_claims (
        id, task_id, claim_key, claim_text, claim_type, status, verdict_reason,
        evidence_source_ids_json, needs_time_excerpt, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, claim_key) DO UPDATE SET
        status = excluded.status,
        verdict_reason = excluded.verdict_reason,
        evidence_source_ids_json = excluded.evidence_source_ids_json,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
      RETURNING ${CLAIM_COLUMNS}
    `).get(
      randomUUID(), taskId, claimKey, claimText, input.claimType, input.status, verdictReason,
      canonicalJson(evidenceSourceIds), needsTimeExcerpt, verifiedAt, now, now
    ) as ResearchClaimRow;
    return success(parseClaim(row));
  } catch (error) {
    return failure('VALIDATION_ERROR', error instanceof Error ? error.message : String(error));
  }
}

export function getResearchClaim(database: DatabaseSync, taskId: string, claimKey: string): ResearchClaim | null {
  const row = database.prepare(`SELECT ${CLAIM_COLUMNS} FROM research_claims WHERE task_id = ? AND claim_key = ?`)
    .get(taskId, claimKey) as ResearchClaimRow | undefined;
  return row ? parseClaim(row) : null;
}

/** 任务内有序查询：按写入顺序（created_at, id）确定性排序。 */
export function listResearchClaims(database: DatabaseSync, taskId: string): ResearchClaim[] {
  const rows = database.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM research_claims WHERE task_id = ? ORDER BY created_at, id`
  ).all(taskId) as ResearchClaimRow[];
  return rows.map(parseClaim);
}

/** 不可变快照：深度拷贝，调用方修改返回值不影响后续读取。 */
export function getResearchClaimsSnapshot(database: DatabaseSync, taskId: string): ResearchClaimsSnapshot {
  return { taskId, claims: structuredClone(listResearchClaims(database, taskId)) };
}

/** 状态投影：{ [claimKey]: status }，只透传已存状态，不推导判定。 */
export function projectResearchClaimStatuses(database: DatabaseSync, taskId: string): Record<string, ResearchClaimStatus> {
  const rows = database.prepare('SELECT claim_key, status FROM research_claims WHERE task_id = ?')
    .all(taskId) as Array<{ claim_key: string; status: ResearchClaimStatus }>;
  const projection: Record<string, ResearchClaimStatus> = {};
  for (const row of rows) projection[row.claim_key] = row.status;
  return projection;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** 确定性归一化 JSON（对齐 publication-operations.ts canonicalJson 约定）。 */
function canonicalJson(value: unknown): string { return stableJson(value, false); }
function stableJson(value: unknown, inArray: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_JSON_NUMBER'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? 'null' : stableJson(item, true)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], false)}`).join(',')}}`;
  }
  if (inArray) return 'null';
  throw new TypeError('UNSUPPORTED_JSON_VALUE');
}
