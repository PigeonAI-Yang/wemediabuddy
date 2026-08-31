import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type ContentCycleNextAction = Readonly<{
  kind: 'submitWorkspaceOrchestratorIntent';
  producerId: 'content-cycle.successor';
  action: 'stage_d';
  businessDate: string;
  requestId: string;
  rootMode: 'scheduler';
  role: 'planner' | 'reporter' | 'writer';
  logicalInput: Readonly<Record<string, unknown>>;
  payload: Readonly<Record<string, unknown>>;
}>;

export type AdvanceApprovedResult = {
  projectId: string;
  role: 'reporter' | 'writer';
  jobId: string | null;
  taskId: string | null;
  reusedProject: boolean;
  reusedJob: boolean;
  nextAction: ContentCycleNextAction;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isValidTitle(title: string): boolean {
  return typeof title === 'string' && title.trim().length > 0;
}

export function ensureTargetArticleLinkInternal(
  database: DatabaseSync,
  targetId: string
): { planItemId: string; projectId: string; created: boolean } {
  const target = database
    .prepare('SELECT * FROM daily_content_targets WHERE id=?')
    .get(targetId) as
    | {
        id: string;
        cycle_id: string;
        source_item_id: string | null;
        plan_item_id: string | null;
        project_id: string | null;
      }
    | undefined;
  if (!target) throw Object.assign(new Error('目标不存在'), { code: 'NOT_FOUND' });
  if (target.plan_item_id && target.project_id) {
    return { planItemId: target.plan_item_id, projectId: target.project_id, created: false };
  }

  const cycle = database
    .prepare('SELECT id, business_date, plan_id FROM daily_content_cycles WHERE id=?')
    .get(target.cycle_id) as { id: string; business_date: string; plan_id: string | null } | undefined;
  if (!cycle) throw Object.assign(new Error('周期不存在'), { code: 'NOT_FOUND' });

  const freshTarget = database
    .prepare('SELECT plan_item_id, project_id FROM daily_content_targets WHERE id=?')
    .get(targetId) as { plan_item_id: string | null; project_id: string | null } | undefined;
  if (freshTarget?.plan_item_id && freshTarget?.project_id) {
    return { planItemId: freshTarget.plan_item_id, projectId: freshTarget.project_id, created: false };
  }

  // Legacy direct creation removed: require existing approved plan_item
  const planItemId = target.plan_item_id ?? freshTarget?.plan_item_id ?? null;
  if (!planItemId) {
    throw Object.assign(new Error('target has no approved plan item; legacy direct creation denied'), { code: 'conflict' });
  }
  const item = database
    .prepare('SELECT id, planning_status FROM plan_items WHERE id=?')
    .get(planItemId) as { id: string; planning_status: string } | undefined;
  if (!item) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
  if (item.planning_status !== 'approved') {
    throw Object.assign(new Error(`plan_item_not_approved: ${item.planning_status}`), { code: 'conflict' });
  }

  // Reuse/create project via approved advance path only
  const adv = advanceApprovedPlanItem(database, planItemId);
  const projectId = adv.projectId;
  const ts = nowIso();
  database
    .prepare('UPDATE daily_content_targets SET plan_item_id=?, project_id=?, updated_at=?, revision=revision+1 WHERE id=?')
    .run(planItemId, projectId, ts, targetId);

  return { planItemId, projectId, created: true };
}

export function isResearchGateSatisfied(database: DatabaseSync, targetId: string): boolean {
  const target = database
    .prepare('SELECT project_id, plan_item_id FROM daily_content_targets WHERE id=?')
    .get(targetId) as { project_id: string | null; plan_item_id: string | null } | undefined;
  if (!target?.project_id) return false;
  const projectId = target.project_id;
  const planItemId = target.plan_item_id;
  try {
    const row = database
      .prepare(
        `SELECT COUNT(*) as c FROM research_claims rc
         JOIN agent_tasks at ON at.id = rc.task_id
         WHERE rc.status='supported' AND (
           json_extract(at.context_refs_json, '$.planItemId') = ?
           OR json_extract(at.context_refs_json, '$.plan_item_id') = ?
           OR json_extract(at.context_refs_json, '$.projectId') = ?
           OR json_extract(at.context_refs_json, '$.project_id') = ?
         )`
      )
      .get(planItemId ?? projectId, planItemId ?? projectId, projectId, projectId) as { c: number } | undefined;
    if (row && Number(row.c) > 0) return true;
  } catch {}
  return false;
}

export function saveTargetArticleDraftInternal(
  database: DatabaseSync,
  input: { targetId: string; body: string; title?: string; expectedRevision: number; author?: 'ai' | 'user' }
): { versionId: string; versionNumber: number; projectId: string } {
  const target = database
    .prepare('SELECT * FROM daily_content_targets WHERE id=?')
    .get(input.targetId) as
    | {
        id: string;
        project_id: string | null;
        revision: number;
        status: string;
        blocked_reason_code: string | null;
      }
    | undefined;
  if (!target) throw Object.assign(new Error('目标不存在'), { code: 'NOT_FOUND' });
  if (Number(target.revision) !== Number(input.expectedRevision))
    throw Object.assign(new Error('revision 冲突'), { code: 'REVISION_CONFLICT' });
  // Ensure link exists
  let projectId = target.project_id;
  if (!projectId) {
    const linked = ensureTargetArticleLinkInternal(database, input.targetId);
    projectId = linked.projectId;
  }
  const body = (input.body ?? '').trim();
  if (!body) throw Object.assign(new Error('正文不能为空'), { code: 'VALIDATION_ERROR' });

  // Gate check
  if (!isResearchGateSatisfied(database, input.targetId)) {
    const ts = nowIso();
    database
      .prepare('UPDATE daily_content_targets SET status=?, blocked_reason_code=?, updated_at=?, revision=revision+1 WHERE id=?')
      .run('blocked', 'RESEARCH_GATE_UNMET', ts, input.targetId);
    throw Object.assign(new Error('研究门未通过，禁止生成正文'), { code: 'RESEARCH_GATE_UNMET', details: { targetId: input.targetId } });
  }

  // Gate satisfied: create version append-only
  const projectRow = database
    .prepare('SELECT id, revision, title FROM content_projects WHERE id=?')
    .get(projectId) as { id: string; revision: number; title: string } | undefined;
  if (!projectRow) throw Object.assign(new Error('内容项目不存在'), { code: 'NOT_FOUND' });

  const versionNumber = Number(
    (
      database
        .prepare('SELECT COALESCE(MAX(version_number),0)+1 as n FROM content_versions WHERE project_id=?')
        .get(projectId) as { n: number }
    ).n
  );
  const versionId = randomUUID();
  const ts = nowIso();
  database
    .prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at, author) VALUES (?,?,?,?,?,?)')
    .run(versionId, projectId, body, versionNumber, ts, input.author ?? 'ai');
  database
    .prepare('UPDATE content_projects SET title=?, updated_at=?, revision=revision+1 WHERE id=?')
    .run(input.title?.trim() || projectRow.title, ts, projectId);

  // Update target status to drafting if was selected/researching/blocked
  const ts2 = nowIso();
  const allowedFrom = ['selected', 'researching', 'drafting', 'blocked'];
  if (allowedFrom.includes(target.status)) {
    database
      .prepare('UPDATE daily_content_targets SET status=?, blocked_reason_code=NULL, updated_at=?, revision=revision+1 WHERE id=?')
      .run('drafting', ts2, input.targetId);
  }

  return { versionId, versionNumber, projectId: projectId as string };
}

export function finalizeTargetArticleInternal(
  database: DatabaseSync,
  input: { targetId: string; expectedRevision: number }
): { projectId: string; target: Record<string, unknown> } {
  const target = database
    .prepare('SELECT * FROM daily_content_targets WHERE id=?')
    .get(input.targetId) as
    | { id: string; project_id: string | null; revision: number; status: string }
    | undefined;
  if (!target) throw Object.assign(new Error('目标不存在'), { code: 'NOT_FOUND' });
  if (Number(target.revision) !== Number(input.expectedRevision))
    throw Object.assign(new Error('revision 冲突'), { code: 'REVISION_CONFLICT' });
  const projectId = target.project_id;
  if (!projectId) throw Object.assign(new Error('目标未绑定项目'), { code: 'NOT_FOUND' });

  // Must have at least one version
  const ver = database
    .prepare('SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1')
    .get(projectId) as { id: string } | undefined;
  if (!ver) throw Object.assign(new Error('项目无正文版本，无法定稿'), { code: 'VALIDATION_ERROR' });

  // Ensure research gate still satisfied before finalizing
  if (!isResearchGateSatisfied(database, input.targetId)) {
    throw Object.assign(new Error('研究门未通过，禁止定稿'), { code: 'RESEARCH_GATE_UNMET' });
  }

  const ts = nowIso();
  // Set project to ready
  database.prepare('UPDATE content_projects SET status=?, updated_at=?, revision=revision+1 WHERE id=?').run('ready', ts, projectId);

  // Move target to article_ready if currently drafting/selected/researching/blocked or handle stale regression
  // If target was completed but now article has new version making script stale, regress truthfully
  const current = database
    .prepare('SELECT status, revision FROM daily_content_targets WHERE id=?')
    .get(input.targetId) as { status: string; revision: number } | undefined;
  if (current && ['drafting', 'selected', 'researching', 'blocked'].includes(current.status)) {
    database
      .prepare('UPDATE daily_content_targets SET status=?, blocked_reason_code=NULL, updated_at=?, revision=revision+1 WHERE id=?')
      .run('article_ready', nowIso(), input.targetId);
  } else if (current && current.status === 'article_ready') {
    // already article_ready, idempotent noop unless stale regression needed below
  } else if (current && current.status === 'scripting') {
    // remain scripting — new article version will make script stale, target stays scripting until new script
  } else if (current && current.status === 'completed') {
    // New finalized article makes previous ready script stale — regress truthfully to scripting
    // Check if existing ready script still aligned; if not, regress
    const der = database.prepare("SELECT id FROM content_derivatives WHERE project_id=? AND kind='video_script'").get(projectId) as { id: string } | undefined;
    let needsRegress = false;
    if (der) {
      const latestScript = database.prepare('SELECT status, source_content_version_id FROM content_derivative_versions WHERE derivative_id=? ORDER BY version_number DESC LIMIT 1').get(der.id) as { status: string; source_content_version_id: string } | undefined;
      if (latestScript && latestScript.status === 'ready' && latestScript.source_content_version_id !== ver.id) needsRegress = true;
      if (!latestScript) needsRegress = true;
      if (latestScript && latestScript.status !== 'ready') needsRegress = true;
    } else {
      needsRegress = true;
    }
    if (needsRegress) {
      database.prepare("UPDATE daily_content_targets SET status='scripting', updated_at=?, revision=revision+1 WHERE id=?").run(nowIso(), input.targetId);
      const trow = database.prepare('SELECT cycle_id FROM daily_content_targets WHERE id=?').get(input.targetId) as { cycle_id: string } | undefined;
      if (trow) {
        const cycle = database.prepare('SELECT status FROM daily_content_cycles WHERE id=?').get(trow.cycle_id) as { status: string } | undefined;
        if (cycle && cycle.status === 'completed') {
          database.prepare("UPDATE daily_content_cycles SET status='running', completed_at=NULL, updated_at=?, revision=revision+1 WHERE id=?").run(nowIso(), trow.cycle_id);
        }
      }
    }
  } else if (current && current.status !== 'article_ready') {
    throw Object.assign(new Error(`非法定稿流转 ${current.status} -> article_ready`), { code: 'ILLEGAL_TRANSITION' });
  }

  // Also regress any OTHER completed targets sharing same project (edge: multiple targets referencing same project)
  const latestId = ver.id;
  const otherCompleted = database.prepare("SELECT id, cycle_id FROM daily_content_targets WHERE project_id=? AND id!=? AND status='completed'").all(projectId, input.targetId) as Array<{ id: string; cycle_id: string }>;
  for (const o of otherCompleted) {
    const d = database.prepare("SELECT id FROM content_derivatives WHERE project_id=? AND kind='video_script'").get(projectId) as { id: string } | undefined;
    if (!d) {
      const ts2 = nowIso();
      database.prepare("UPDATE daily_content_targets SET status='scripting', updated_at=?, revision=revision+1 WHERE id=?").run(ts2, o.id);
      const cyc2 = database.prepare('SELECT status FROM daily_content_cycles WHERE id=?').get(o.cycle_id) as { status: string } | undefined;
      if (cyc2 && cyc2.status === 'completed') database.prepare("UPDATE daily_content_cycles SET status='running', completed_at=NULL, updated_at=?, revision=revision+1 WHERE id=?").run(ts2, o.cycle_id);
      continue;
    }
    const ls = database.prepare('SELECT status, source_content_version_id FROM content_derivative_versions WHERE derivative_id=? ORDER BY version_number DESC LIMIT 1').get(d.id) as { status: string; source_content_version_id: string } | undefined;
    if (!ls || ls.status !== 'ready' || ls.source_content_version_id !== latestId) {
      const ts2 = nowIso();
      database.prepare("UPDATE daily_content_targets SET status='scripting', updated_at=?, revision=revision+1 WHERE id=?").run(ts2, o.id);
      const cyc2 = database.prepare('SELECT status FROM daily_content_cycles WHERE id=?').get(o.cycle_id) as { status: string } | undefined;
      if (cyc2 && cyc2.status === 'completed') database.prepare("UPDATE daily_content_cycles SET status='running', completed_at=NULL, updated_at=?, revision=revision+1 WHERE id=?").run(ts2, o.cycle_id);
    }
  }

  const updated = database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(input.targetId) as Record<string, unknown>;
  return { projectId, target: updated };
}

export function getTargetArticleProjection(database: DatabaseSync, targetId: string): Record<string, unknown> | null {
  const target = database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(targetId) as Record<string, unknown> | undefined;
  if (!target) return null;
  const projectId = (target as { project_id: string | null }).project_id as string | null;
  if (!projectId) return { target, project: null, versions: [] };
  const project = database.prepare('SELECT * FROM content_projects WHERE id=?').get(projectId) as Record<string, unknown> | undefined;
  const versions = database
    .prepare('SELECT id, version_number, created_at, author FROM content_versions WHERE project_id=? ORDER BY version_number ASC')
    .all(projectId) as Record<string, unknown>[];
  return { target, project, versions };
}

/** WMB-5351: unified production advance — persist project state and an Actor intent descriptor. */
function parseProvenance(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
  } catch {
    return {};
  }
}

function makeContentCycleNextAction(input: {
  businessDate: string;
  planItemId: string;
  projectId: string;
  role: 'planner' | 'reporter' | 'writer';
}): ContentCycleNextAction {
  const logicalInput = Object.freeze({
    source: 'content_cycle',
    businessDate: input.businessDate,
    planItemId: input.planItemId,
    projectId: input.projectId,
    role: input.role,
  });
  const requestId = `content-cycle:stage_d:${input.businessDate}:${input.planItemId}:${input.projectId}:${input.role}`;
  return Object.freeze({
    kind: 'submitWorkspaceOrchestratorIntent',
    producerId: 'content-cycle.successor',
    action: 'stage_d',
    businessDate: input.businessDate,
    requestId,
    rootMode: 'scheduler',
    role: input.role,
    logicalInput,
    payload: logicalInput,
  });
}

function persistContentCycleNextAction(database: DatabaseSync, planItemId: string, nextAction: ContentCycleNextAction): void {
  const row = database
    .prepare('SELECT planning_provenance_json FROM plan_items WHERE id=?')
    .get(planItemId) as { planning_provenance_json: string | null } | undefined;
  if (!row) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
  const provenance = parseProvenance(row.planning_provenance_json);
  provenance.content_cycle_next_action = nextAction;
  provenance.next_action = nextAction;
  database
    .prepare('UPDATE plan_items SET planning_provenance_json=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(provenance), nowIso(), planItemId);
}

export function countSupportedClaimsForProject(database: DatabaseSync, projectId: string, planItemId: string): number {
  try {
    const row = database.prepare(
      `SELECT COUNT(*) as c FROM research_claims rc
       JOIN agent_tasks at ON at.id = rc.task_id
       WHERE rc.status='supported' AND (
         json_extract(at.context_refs_json, '$.planItemId') = ?
         OR json_extract(at.context_refs_json, '$.plan_item_id') = ?
         OR json_extract(at.context_refs_json, '$.projectId') = ?
         OR json_extract(at.context_refs_json, '$.project_id') = ?
       )`
    ).get(planItemId, planItemId, projectId, projectId) as { c: number } | undefined;
    if (row) return Number(row.c);
  } catch {}
  return 0;
}

function getOrCreateProjectForPlanItem(database: DatabaseSync, planItemId: string): { projectId: string; reused: boolean } {
  let started=false;
  try { database.exec('BEGIN IMMEDIATE'); started=true; } catch { started=false; }
  try {
    const existing = database.prepare('SELECT id FROM content_projects WHERE plan_item_id = ?').get(planItemId) as { id: string } | undefined;
    if (existing) {
      if(started) database.exec('COMMIT');
      return { projectId: existing.id, reused: true };
    }
    const item = database.prepare('SELECT topic_id, title, source_ids_json FROM plan_items WHERE id=?').get(planItemId) as { topic_id: string | null; title: string; source_ids_json: string } | undefined;
    if (!item) {
      if(started) try{ database.exec('ROLLBACK'); }catch{}
      throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
    }
    const projectId = randomUUID();
    const ts = nowIso();
    const title = item.title || '未命名项目';
    database.prepare('INSERT INTO content_projects (id, topic_id, plan_item_id, title, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,1)').run(projectId, item.topic_id ?? null, planItemId, title, 'idea', ts, ts);
    try {
      const sourceIds = JSON.parse(item.source_ids_json || '[]') as string[];
      for (const sid of sourceIds) {
        if(!sid) continue;
        try { database.prepare('INSERT OR IGNORE INTO content_project_sources (project_id, source_id) VALUES (?,?)').run(projectId, sid); } catch {}
      }
    } catch {}
    if(started) database.exec('COMMIT');
    return { projectId, reused: false };
  } catch (e) {
    if(started) try{ database.exec('ROLLBACK'); }catch{}
    throw e;
  }
}

export function advanceApprovedPlanItem(database: DatabaseSync, planItemId: string): AdvanceApprovedResult {
  if (!planItemId) throw Object.assign(new Error('planItemId_required'), { code: 'validation_failed' });
  const item = database.prepare(`
    SELECT pi.id, pi.planning_status, pi.title, p.plan_date AS planDate
    FROM plan_items pi JOIN plans p ON p.id=pi.plan_id
    WHERE pi.id=?
  `).get(planItemId) as { id:string; planning_status:string; title:string; planDate:string } | undefined;
  if (!item) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
  if (item.planning_status !== 'approved') throw Object.assign(new Error(`conflict: planning_status must be approved, got ${item.planning_status}`), { code: 'conflict' });
  const businessDate = String(item.planDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw Object.assign(new Error('plan_date_required'), { code: 'PLAN_DATE_REQUIRED' });
  const { projectId, reused: reusedProject } = getOrCreateProjectForPlanItem(database, planItemId);
  const claims = countSupportedClaimsForProject(database, projectId, planItemId);
  const role: 'reporter'|'writer' = claims === 0 ? 'reporter' : 'writer';
  const nextAction = makeContentCycleNextAction({ businessDate, planItemId, projectId, role });
  persistContentCycleNextAction(database, planItemId, nextAction);
  return { projectId, role, jobId: null, taskId: null, reusedProject, reusedJob: false, nextAction };
}

/** Called when a Reporter reaches a completed or partial terminal state; persist a Writer successor descriptor without spawning. */
export function handleReporterSuccessAndAdvance(database: DatabaseSync, reporterTaskId: string): { advanced: boolean; result?: AdvanceApprovedResult } {
  try {
    const task = database.prepare('SELECT intent, context_refs_json FROM agent_tasks WHERE id=?').get(reporterTaskId) as { intent:string; context_refs_json:string } | undefined;
    if (!task || task.intent !== 'research') return { advanced: false };
    let ctx: Record<string, unknown> = {};
    try { ctx = JSON.parse(task.context_refs_json); } catch {}
    const planItemId = (ctx as Record<string, unknown>).planItemId as string | undefined || (ctx as Record<string, unknown>).plan_item_id as string | undefined || null;
    const projectId = (ctx as Record<string, unknown>).projectId as string | undefined || (ctx as Record<string, unknown>).project_id as string | undefined || null;
    let targetPlanItemId: string | null = planItemId as string | null;
    if (!targetPlanItemId && projectId) {
      const row = database.prepare('SELECT plan_item_id FROM content_projects WHERE id=?').get(projectId) as { plan_item_id:string|null }|undefined;
      targetPlanItemId = row?.plan_item_id ?? null;
    }
    if (!targetPlanItemId) return { advanced: false };
    const item = database.prepare('SELECT planning_status FROM plan_items WHERE id=?').get(targetPlanItemId) as { planning_status:string }|undefined;
    if (!item || item.planning_status !== 'approved') return { advanced: false };
    const prow = database.prepare('SELECT id FROM content_projects WHERE plan_item_id=?').get(targetPlanItemId) as { id:string }|undefined;
    const pid = prow?.id ?? projectId;
    if (!pid) return { advanced: false };
    const claims = countSupportedClaimsForProject(database, pid, targetPlanItemId);
    if (claims === 0) return { advanced: false };
    const result = advanceApprovedPlanItem(database, targetPlanItemId);
    return { advanced: true, result };
  } catch { return { advanced: false }; }
}
