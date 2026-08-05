import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { recordOperation } from './operations.ts';
import { dispatchBusinessCommand, requireCommandResultData } from './business-command.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export type ReviewStatus = 'draft' | 'final';

export type MethodFinding = {
  id: string;
  reviewId: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type SaveReviewInput = {
  id?: string;
  publicationId: string;
  metricSnapshotIds: string[];
  keep?: string[];
  stop?: string[];
  change?: string[];
  summary?: string;
  status?: ReviewStatus;
  expectedRevision?: number;
  findings?: Array<{ id?: string; title: string; body: string }>;
};

export type ReviewRecord = {
  id: string;
  publicationId: string;
  contentVersionId: string;
  metricSnapshotIds: string[];
  status: ReviewStatus;
  keep: string[];
  stop: string[];
  change: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  revision: number;
  findings: MethodFinding[];
};

export type ReviewBacklink = {
  planId: string;
  planDate: string;
  planItemId: string;
  planItemTitle: string;
  reviewIds: string[];
  methodFindingIds: string[];
};

type ReviewRow = {
  id: string;
  publication_id: string;
  content_version_id: string;
  metric_snapshot_ids_json: string;
  status: ReviewStatus;
  keep_json: string;
  stop_json: string;
  change_json: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
  revision: number;
};

function parseActions(raw: string): string[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function parseReview(database: DatabaseSync, row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    publicationId: row.publication_id,
    contentVersionId: row.content_version_id,
    metricSnapshotIds: JSON.parse(row.metric_snapshot_ids_json) as string[],
    status: row.status,
    keep: parseActions(row.keep_json),
    stop: parseActions(row.stop_json),
    change: parseActions(row.change_json),
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
    revision: row.revision,
    findings: listMethodFindings(database, row.id)
  };
}

export function listMethodFindings(database: DatabaseSync, reviewId?: string): MethodFinding[] {
  const rows = reviewId
    ? database.prepare(`SELECT id, review_id AS reviewId, title, body, created_at AS createdAt, updated_at AS updatedAt, revision
        FROM method_findings WHERE review_id = ? ORDER BY created_at`).all(reviewId) as MethodFinding[]
    : database.prepare(`SELECT id, review_id AS reviewId, title, body, created_at AS createdAt, updated_at AS updatedAt, revision
        FROM method_findings ORDER BY created_at DESC`).all() as MethodFinding[];
  return rows;
}

export function getReview(database: DatabaseSync, id: string): ReviewRecord | null {
  const row = database.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined;
  return row ? parseReview(database, row) : null;
}

export function listReviews(database: DatabaseSync, publicationId?: string): ReviewRecord[] {
  const rows = publicationId
    ? database.prepare('SELECT * FROM reviews WHERE publication_id = ? ORDER BY updated_at DESC').all(publicationId) as ReviewRow[]
    : database.prepare('SELECT * FROM reviews ORDER BY updated_at DESC').all() as ReviewRow[];
  return rows.map((row) => parseReview(database, row));
}

export function listFinalReviewsAndFindings(database: DatabaseSync): {
  reviews: ReviewRecord[];
  findings: MethodFinding[];
} {
  const reviews = listReviews(database).filter((review) => review.status === 'final');
  const findings = reviews.flatMap((review) => review.findings);
  return { reviews, findings };
}

export function listReviewBacklinks(database: DatabaseSync, reviewIds: string[] = [], findingIds: string[] = []): ReviewBacklink[] {
  if (!reviewIds.length && !findingIds.length) return [];
  const rows = database.prepare(`
    SELECT p.id AS planId, p.plan_date AS planDate, pi.id AS planItemId, pi.title AS planItemTitle,
      pi.review_ids_json AS reviewIdsJson, pi.method_finding_ids_json AS methodFindingIdsJson
    FROM plan_items pi
    JOIN plans p ON p.id = pi.plan_id
    ORDER BY p.plan_date DESC, pi.sort_order ASC
  `).all() as Array<{
    planId: string;
    planDate: string;
    planItemId: string;
    planItemTitle: string;
    reviewIdsJson: string;
    methodFindingIdsJson: string;
  }>;
  const wantedReviews = new Set(reviewIds);
  const wantedFindings = new Set(findingIds);
  return rows.flatMap((row) => {
    const linkedReviews = parseActions(row.reviewIdsJson || '[]');
    const linkedFindings = parseActions(row.methodFindingIdsJson || '[]');
    const hit = linkedReviews.some((id) => wantedReviews.has(id)) || linkedFindings.some((id) => wantedFindings.has(id));
    if (!hit) return [];
    return [{
      planId: row.planId,
      planDate: row.planDate,
      planItemId: row.planItemId,
      planItemTitle: row.planItemTitle,
      reviewIds: linkedReviews,
      methodFindingIds: linkedFindings
    }];
  });
}

function resolveContentVersionId(database: DatabaseSync, publicationId: string): string | null {
  const row = database.prepare(`
    SELECT pv.content_version_id AS contentVersionId
    FROM publications p
    JOIN platform_versions pv ON pv.id = p.platform_version_id
    WHERE p.id = ?
  `).get(publicationId) as { contentVersionId: string } | undefined;
  return row?.contentVersionId ?? null;
}

function validateSnapshotIds(database: DatabaseSync, publicationId: string, snapshotIds: string[]): CommandResult<true> {
  if (!snapshotIds.length) return failure('VALIDATION_ERROR', '复盘必须引用至少一个指标快照。');
  for (const snapshotId of snapshotIds) {
    const snap = database.prepare(`SELECT id FROM publication_metric_snapshots WHERE id = ? AND publication_id = ?`)
      .get(snapshotId, publicationId) as { id: string } | undefined;
    if (!snap) return failure('VALIDATION_ERROR', `指标快照不存在或不属于该发布：${snapshotId}`);
  }
  return success(true);
}

export function saveReview(
  database: DatabaseSync,
  input: SaveReviewInput,
  transaction = true
): CommandResult<ReviewRecord> {
  const publication = database.prepare(`SELECT id, status FROM publications WHERE id = ?`)
    .get(input.publicationId) as { id: string; status: string } | undefined;
  if (!publication) return failure('NOT_FOUND', '发布记录不存在。');
  if (publication.status !== 'published') return failure('INVALID_STATE', '只有已发布内容可以复盘。');

  const contentVersionId = resolveContentVersionId(database, input.publicationId);
  if (!contentVersionId) return failure('VALIDATION_ERROR', '找不到对应的内容版本。');

  const keep = (input.keep ?? []).map((item) => item.trim()).filter(Boolean);
  const stop = (input.stop ?? []).map((item) => item.trim()).filter(Boolean);
  const change = (input.change ?? []).map((item) => item.trim()).filter(Boolean);
  const snapshotIds = [...new Set(input.metricSnapshotIds.filter(Boolean))];
  const status: ReviewStatus = input.status ?? 'draft';

  if (status === 'final') {
    const snapshots = validateSnapshotIds(database, input.publicationId, snapshotIds);
    if (!snapshots.ok) return snapshots;
    if (!keep.length || !stop.length || !change.length) {
      return failure('VALIDATION_ERROR', '最终复盘必须各包含至少一条 Keep / Stop / Change。');
    }
  } else if (snapshotIds.length) {
    const snapshots = validateSnapshotIds(database, input.publicationId, snapshotIds);
    if (!snapshots.ok) return snapshots;
  }

  const now = new Date().toISOString();
  const existing = input.id
    ? database.prepare('SELECT * FROM reviews WHERE id = ?').get(input.id) as ReviewRow | undefined
    : undefined;
  if (input.id && !existing) return failure('NOT_FOUND', '复盘不存在。');
  if (existing && existing.status === 'final') return failure('INVALID_STATE', '最终复盘不可再改。');
  if (existing && input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
    return failure('REVISION_CONFLICT', '复盘已被更新，请重新加载。', { current: existing.revision });
  }

  const id = existing?.id ?? input.id ?? randomUUID();
  const revision = existing ? existing.revision + 1 : 1;
  const finalizedAt = status === 'final' ? now : null;

  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    if (existing) {
      database.prepare(`UPDATE reviews SET
        metric_snapshot_ids_json = ?, status = ?, keep_json = ?, stop_json = ?, change_json = ?,
        summary = ?, updated_at = ?, finalized_at = ?, revision = ?
        WHERE id = ?`).run(
        JSON.stringify(snapshotIds),
        status,
        JSON.stringify(keep),
        JSON.stringify(stop),
        JSON.stringify(change),
        input.summary?.trim() || null,
        now,
        finalizedAt,
        revision,
        id
      );
      database.prepare('DELETE FROM method_findings WHERE review_id = ?').run(id);
    } else {
      database.prepare(`INSERT INTO reviews (
        id, publication_id, content_version_id, metric_snapshot_ids_json, status,
        keep_json, stop_json, change_json, summary, created_at, updated_at, finalized_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        input.publicationId,
        contentVersionId,
        JSON.stringify(snapshotIds),
        status,
        JSON.stringify(keep),
        JSON.stringify(stop),
        JSON.stringify(change),
        input.summary?.trim() || null,
        now,
        now,
        finalizedAt,
        revision
      );
    }

    for (const finding of input.findings ?? []) {
      const title = finding.title.trim();
      const body = finding.body.trim();
      if (!title || !body) continue;
      database.prepare(`INSERT INTO method_findings (
        id, review_id, title, body, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, 1)`).run(finding.id ?? randomUUID(), id, title, body, now, now);
    }

    if(status==='final'){
      const origin=database.prepare(`SELECT b.canvas_id AS canvasId,b.context_node_ids_json AS contextNodeIdsJson
        FROM creative_brief_projects link JOIN creative_briefs b ON b.id=link.brief_id
        JOIN platform_versions pv ON pv.project_id=link.project_id JOIN publications p ON p.platform_version_id=pv.id
        WHERE p.id=? LIMIT 1`).get(input.publicationId) as {canvasId:string;contextNodeIdsJson:string}|undefined;
      if(origin?.canvasId){
        const contextNodeIds=JSON.parse(origin.contextNodeIdsJson) as string[];
        const topicNodes=contextNodeIds.length?database.prepare(`SELECT id FROM knowledge_canvas_nodes
          WHERE canvas_id=? AND object_type='topic' AND id IN (${contextNodeIds.map(()=>'?').join(',')})`).all(origin.canvasId,...contextNodeIds).map((item:any)=>item.id):[];
        const suggestions=[{key:'review',objectType:'review',objectId:id,returnRelationType:'derived_from'},
          ...database.prepare('SELECT id FROM method_findings WHERE review_id=? ORDER BY created_at,id').all(id).map((item:any)=>({key:`finding:${item.id}`,objectType:'method_finding',objectId:item.id,returnRelationType:'uses_method'}))];
        const insert=database.prepare(`INSERT OR IGNORE INTO knowledge_suggestions(id,request_id,canvas_id,kind,payload_json,created_at,updated_at)
          VALUES(?,?,?,'node',?,?,?)`);
        suggestions.forEach((item,index)=>insert.run(randomUUID(),`review-return:${id}:${item.key}`,origin.canvasId,JSON.stringify({
          objectType:item.objectType,objectId:item.objectId,x:120+index*280,y:680,
          returnFromNodeIds:topicNodes,returnRelationType:item.returnRelationType
        }),now,now));
      }
    }

    if (transaction) database.exec('COMMIT');
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }

  if (transaction) recordOperation(database, {
    actorType: 'ui',
    command: status === 'final' ? 'reviews.finalize' : 'reviews.save',
    entityType: 'review',
    entityId: id,
    result: 'ok'
  });

  const saved = getReview(database, id);
  if (!saved) return failure('NOT_FOUND', '复盘保存后读取失败。');
  return success(saved);
}

export function dispatchSaveReview(runtime: ActiveWorkspaceRuntime, requestId: string, input: SaveReviewInput) {
  return dispatchBusinessCommand(runtime, {
    command: 'reviews.save',
    requestId,
    actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' },
    input,
    boundIdentity: {
      publicationId: input.publicationId,
      reviewId: input.id ?? null,
      expectedRevision: input.expectedRevision ?? null
    },
    entityType: 'review',
    execute: (database, normalizedInput) => {
      const before = normalizedInput.id ? getReview(database, normalizedInput.id) : null;
      const saved = requireCommandResultData(saveReview(database, normalizedInput, false));
      return {
        data: saved,
        entityId: saved.id,
        beforeRevision: before?.revision,
        afterRevision: saved.revision,
        readback: saved
      };
    }
  });
}
