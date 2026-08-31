import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getScoringSettings } from './zhihu-hot-scoring.ts';

function nowIso(): string { return new Date().toISOString(); }
function isValidDate(d: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)); }

function ensureCycleForDate(database: DatabaseSync, businessDate: string): { id: string; business_date: string } {
  let row = database.prepare('SELECT id, business_date FROM daily_content_cycles WHERE business_date=?').get(businessDate) as { id: string; business_date: string } | undefined;
  if (row) return row;
  const settings = getScoringSettings(database);
  const targetCount = settings.targetCount;
  const id = randomUUID();
  const ts = nowIso();
  database.prepare(`INSERT INTO daily_content_cycles (id, business_date, timezone, target_count, status, started_at, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,1)`).run(id, businessDate, 'Asia/Shanghai', targetCount, 'running', ts, ts, ts);
  return { id, business_date: businessDate };
}

function collectIterationContext(database: DatabaseSync, publicationId?: string | null): Record<string, unknown> {
  let reviews: unknown[] = [];
  let snapshots: unknown[] = [];
  try {
    if (publicationId) {
      reviews = database.prepare("SELECT id, keep_json as keepJson, stop_json as stopJson, change_json as changeJson, status, summary FROM reviews WHERE publication_id=? ORDER BY finalized_at DESC, created_at DESC").all(publicationId) as unknown[];
      snapshots = database.prepare('SELECT id, normalized_json as normalizedJson, captured_at as capturedAt FROM publication_metric_snapshots WHERE publication_id=? ORDER BY captured_at DESC LIMIT 10').all(publicationId) as unknown[];
    }
  } catch {}
  // new evidence placeholder: latest zhihu observations for project's sources if available
  let evidence: unknown[] = [];
  try {
    if (publicationId) {
      const proj = database.prepare(`SELECT pv.project_id as pid FROM publications p JOIN platform_versions pv ON pv.id=p.platform_version_id WHERE p.id=?`).get(publicationId) as { pid: string } | undefined;
      if (proj) {
        evidence = database.prepare(`SELECT si.id, si.title, si.canonical_url as url FROM content_project_sources cps JOIN source_items si ON si.id=cps.source_id WHERE cps.project_id=? LIMIT 5`).all(proj.pid) as unknown[];
      }
    }
  } catch {}
  return { reviews, snapshots, evidence, collectedAt: nowIso() };
}

export function getIterationContextForPublished(database: DatabaseSync, publicationId: string): Record<string, unknown> {
  return collectIterationContext(database, publicationId);
}
export function getIterationContextForDraft(database: DatabaseSync, projectId: string): Record<string, unknown> {
  let reviews: unknown[] = [];
  try {
    // draft has no publication; surface project notes/decisions as evidence
    reviews = database.prepare('SELECT id, body FROM content_notes WHERE project_id=? ORDER BY created_at DESC LIMIT 5').all(projectId) as unknown[];
  } catch {}
  return { reviews, snapshots: [] as unknown[], evidence: reviews, collectedAt: nowIso() };
}

export function ensureDraftRevisionTargetInternal(database: DatabaseSync, input: { businessDate: string; projectId: string; predecessorContentVersionId: string; predecessorTargetId?: string | null; iterationContextJson?: string | null }): Record<string, unknown> {
  if (!isValidDate(input.businessDate)) throw Object.assign(new Error('businessDate 格式必须为 YYYY-MM-DD'), { code: 'VALIDATION_ERROR' });
  const proj = database.prepare('SELECT id, status FROM content_projects WHERE id=?').get(input.projectId) as { id: string; status: string } | undefined;
  if (!proj) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' });
  const cv = database.prepare('SELECT id, project_id FROM content_versions WHERE id=?').get(input.predecessorContentVersionId) as { id: string; project_id: string } | undefined;
  if (!cv) throw Object.assign(new Error('前置内容版本不存在'), { code: 'NOT_FOUND' });
  if (cv.project_id !== input.projectId) throw Object.assign(new Error('版本与项目不匹配'), { code: 'VALIDATION_ERROR' });
  const cycle = ensureCycleForDate(database, input.businessDate);
  // idempotent: same predecessor version in same cycle returns existing
  const existing = database.prepare('SELECT * FROM daily_content_targets WHERE cycle_id=? AND predecessor_content_version_id=? AND target_kind=?').get(cycle.id, input.predecessorContentVersionId, 'draft_revision') as Record<string, unknown> | undefined;
  if (existing) return existing;
  if (input.predecessorTargetId) {
    const dupTarget = database.prepare('SELECT * FROM daily_content_targets WHERE cycle_id=? AND predecessor_target_id=? AND target_kind=?').get(cycle.id, input.predecessorTargetId, 'draft_revision') as unknown | undefined;
    if (dupTarget) return dupTarget as Record<string, unknown>;
  }
  const ctx = input.iterationContextJson ?? JSON.stringify(getIterationContextForDraft(database, input.projectId));
  const id = randomUUID();
  const ts = nowIso();
  const target = {
    id, cycle_id: cycle.id, target_kind: 'draft_revision', counts_toward_goal: 0, source_item_id: null, plan_item_id: null, project_id: input.projectId,
    predecessor_content_version_id: input.predecessorContentVersionId, predecessor_publication_id: null, predecessor_target_id: input.predecessorTargetId ?? null,
    carry_depth: 0, selection_mode: 'owner_approved', score_snapshot_json: ctx, status: 'selected', created_at: ts, updated_at: ts, revision: 1
  };
  database.prepare(`INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, plan_item_id, project_id, predecessor_content_version_id, predecessor_publication_id, predecessor_target_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    target.id, target.cycle_id, target.target_kind, target.counts_toward_goal, target.source_item_id, target.plan_item_id, target.project_id, target.predecessor_content_version_id, target.predecessor_publication_id, target.predecessor_target_id, target.carry_depth, target.selection_mode, target.score_snapshot_json, target.status, target.created_at, target.updated_at, target.revision
  );
  return database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(id) as Record<string, unknown>;
}

export function ensurePublishedRevisionTargetInternal(database: DatabaseSync, input: { businessDate: string; projectId: string; predecessorPublicationId: string; predecessorContentVersionId: string; iterationContextJson?: string | null }): Record<string, unknown> {
  if (!isValidDate(input.businessDate)) throw Object.assign(new Error('businessDate 格式必须为 YYYY-MM-DD'), { code: 'VALIDATION_ERROR' });
  const proj = database.prepare('SELECT id FROM content_projects WHERE id=?').get(input.projectId) as { id: string } | undefined;
  if (!proj) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' });
  const pub = database.prepare('SELECT id, platform_version_id FROM publications WHERE id=?').get(input.predecessorPublicationId) as { id: string; platform_version_id: string } | undefined;
  if (!pub) throw Object.assign(new Error('发布记录不存在'), { code: 'NOT_FOUND' });
  const pv = database.prepare('SELECT content_version_id FROM platform_versions WHERE id=?').get(pub.platform_version_id) as { content_version_id: string } | undefined;
  if (!pv) throw Object.assign(new Error('平台版本不存在'), { code: 'NOT_FOUND' });
  const cv = database.prepare('SELECT id FROM content_versions WHERE id=?').get(input.predecessorContentVersionId) as { id: string } | undefined;
  if (!cv) throw Object.assign(new Error('前置内容版本不存在'), { code: 'NOT_FOUND' });
  const cycle = ensureCycleForDate(database, input.businessDate);
  const existingByPub = database.prepare('SELECT * FROM daily_content_targets WHERE cycle_id=? AND predecessor_publication_id=? AND target_kind=?').get(cycle.id, input.predecessorPublicationId, 'published_revision') as Record<string, unknown> | undefined;
  if (existingByPub) return existingByPub;
  const existingByCv = database.prepare('SELECT * FROM daily_content_targets WHERE cycle_id=? AND predecessor_content_version_id=? AND target_kind=?').get(cycle.id, input.predecessorContentVersionId, 'published_revision') as Record<string, unknown> | undefined;
  if (existingByCv) return existingByCv;
  const ctx = input.iterationContextJson ?? JSON.stringify(getIterationContextForPublished(database, input.predecessorPublicationId));
  const id = randomUUID();
  const ts = nowIso();
  database.prepare(`INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, plan_item_id, project_id, predecessor_content_version_id, predecessor_publication_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    id, cycle.id, 'published_revision', 0, null, null, input.projectId, input.predecessorContentVersionId, input.predecessorPublicationId, 0, 'owner_approved', ctx, 'selected', ts, ts
  );
  return database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(id) as Record<string, unknown>;
}

export function createIterationContentVersionInternal(database: DatabaseSync, input: { projectId: string; predecessorContentVersionId: string; body?: string | null; title?: string | null }): Record<string, unknown> {
  const proj = database.prepare('SELECT id FROM content_projects WHERE id=?').get(input.projectId) as { id: string } | undefined;
  if (!proj) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' });
  const actualPred = database.prepare('SELECT id, body FROM content_versions WHERE id=? AND project_id=?').get(input.predecessorContentVersionId, input.projectId) as { id: string; body: string } | undefined;
  if (!actualPred) throw Object.assign(new Error('前置版本不存在'), { code: 'NOT_FOUND' });
  const max = database.prepare('SELECT COALESCE(MAX(version_number),0) as m FROM content_versions WHERE project_id=?').get(input.projectId) as { m: number };
  const next = Number(max.m) + 1;
  const id = randomUUID();
  const ts = nowIso();
  const body = typeof input.body === 'string' && input.body.trim().length ? input.body : `${actualPred.body}\n\n[iteration ${ts}]`;
  database.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?,?,?,?,?)').run(id, input.projectId, body, next, ts);
  database.prepare('UPDATE content_projects SET updated_at=?, revision=revision+1 WHERE id=?').run(ts, input.projectId);
  return database.prepare('SELECT * FROM content_versions WHERE id=?').get(id) as Record<string, unknown>;
}

// Backwards compat alias for test calling with predecessorContentVersionId
export function createIterationVersion(database: DatabaseSync, input: { projectId: string; predecessorContentVersionId: string; body?: string }): Record<string, unknown> {
  return createIterationContentVersionInternal(database, input);
}

export function getYesterdayIterationProjection(database: DatabaseSync, businessDate: string): { cycle: Record<string, unknown> | null; draftIterations: Record<string, unknown>[]; publishedIterations: Record<string, unknown>[] } {
  const cycle = database.prepare('SELECT * FROM daily_content_cycles WHERE business_date=?').get(businessDate) as Record<string, unknown> | undefined;
  if (!cycle) return { cycle: null, draftIterations: [], publishedIterations: [] };
  const all = database.prepare("SELECT * FROM daily_content_targets WHERE cycle_id=? AND target_kind IN ('draft_revision','published_revision') ORDER BY created_at ASC").all((cycle as { id: string }).id) as Record<string, unknown>[];
  return {
    cycle: cycle as Record<string, unknown>,
    draftIterations: all.filter(r => (r as { target_kind: string }).target_kind === 'draft_revision'),
    publishedIterations: all.filter(r => (r as { target_kind: string }).target_kind === 'published_revision'),
  };
}
