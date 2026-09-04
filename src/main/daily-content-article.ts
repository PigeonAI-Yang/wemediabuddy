import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';


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
  const item = database.prepare(`SELECT pi.id, pi.planning_status, cp.id AS projectId
    FROM plan_items pi
    LEFT JOIN content_projects cp ON cp.plan_item_id = pi.id
    WHERE pi.id=?`).get(planItemId) as { id: string; planning_status: string; projectId: string | null } | undefined;
  if (!item) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
  if (item.planning_status !== 'approved') {
    throw Object.assign(new Error(`plan_item_not_approved: ${item.planning_status}`), { code: 'conflict' });
  }
  if (!item.projectId) {
    throw Object.assign(new Error('approved plan item has no project; approval transaction must create it'), { code: 'conflict' });
  }
  const projectId = item.projectId;
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

