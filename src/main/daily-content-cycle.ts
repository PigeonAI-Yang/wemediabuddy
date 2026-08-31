import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getScoringSettings, scoreCandidates, scoreSnapshotJsonFor, selectWithQuota } from './zhihu-hot-scoring.ts';
import { createPlanningDraftFromTarget } from './planning-stage.ts';
import type { ContentCycleNextAction } from './daily-content-article.ts';

export type DailyCycleStatus = 'pending' | 'running' | 'needs_user' | 'completed' | 'partial' | 'paused' | 'failed';
export type DailyTargetStatus =
  | 'proposed'
  | 'selected'
  | 'researching'
  | 'drafting'
  | 'article_ready'
  | 'scripting'
  | 'completed'
  | 'blocked'
  | 'skipped'
  | 'carried';

const LEGAL_TRANSITIONS: Record<DailyTargetStatus, DailyTargetStatus[]> = {
  proposed: ['selected', 'skipped'],
  selected: ['researching', 'drafting', 'blocked', 'skipped'],
  researching: ['drafting', 'blocked', 'skipped'],
  drafting: ['article_ready', 'blocked', 'skipped'],
  article_ready: ['scripting', 'blocked', 'skipped'],
  scripting: ['completed', 'blocked', 'skipped'],
  completed: [],
  blocked: ['researching', 'drafting', 'selected', 'skipped'],
  skipped: [],
  carried: [],
};

function isValidDate(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
}
function nowIso(): string {
  return new Date().toISOString();
}

export function getDailyCycleProjection(
  database: DatabaseSync,
  businessDate: string
): {
  cycle: Record<string, unknown> | null;
  targets: Record<string, unknown>[];
  shortage: { targetCount: number; selectedCount: number; remainingGap: number };
  settlementNote: string;
} {
  const cycle = database.prepare('SELECT * FROM daily_content_cycles WHERE business_date=?').get(businessDate) as
    | Record<string, unknown>
    | undefined;
  if (!cycle) {
    const s = getScoringSettings(database);
    return {
      cycle: null,
      targets: [],
      shortage: { targetCount: s.targetCount, selectedCount: 0, remainingGap: s.targetCount },
      settlementNote: '尚未建立',
    };
  }
  const targets = database.prepare('SELECT * FROM daily_content_targets WHERE cycle_id=? ORDER BY created_at ASC').all(
    (cycle as { id: string }).id
  ) as Record<string, unknown>[];
  const effective = targets.filter(
    (t) =>
      (t as { target_kind: string; counts_toward_goal: number; status: string }).target_kind === 'new_content' &&
      (t as { counts_toward_goal: number }).counts_toward_goal === 1 &&
      (t as { status: string }).status !== 'skipped' &&
      (t as { status: string }).status !== 'carried'
  ).length;
  const gap = Math.max(0, Number((cycle as { target_count: number }).target_count) - effective);
  return {
    cycle,
    targets,
    shortage: {
      targetCount: Number((cycle as { target_count: number }).target_count),
      selectedCount: effective,
      remainingGap: gap,
    },
    settlementNote: gap > 0 ? `缺口 ${gap} 条` : '已配齐',
  };
}

function isArticleReady(database: DatabaseSync, projectId: string): { ready: boolean; latestVersionId: string | null } {
  const proj = database.prepare('SELECT status FROM content_projects WHERE id=?').get(projectId) as
    | { status: string }
    | undefined;
  if (!proj) return { ready: false, latestVersionId: null };
  if (proj.status !== 'ready' && proj.status !== 'completed') return { ready: false, latestVersionId: null };
  const ver = database.prepare('SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1').get(projectId) as
    | { id: string }
    | undefined;
  if (!ver) return { ready: false, latestVersionId: null };
  return { ready: true, latestVersionId: ver.id };
}
function hasExactReadyScript(database: DatabaseSync, projectId: string, exactVersionId: string): boolean {
  const der = database.prepare("SELECT id FROM content_derivatives WHERE project_id=? AND kind='video_script'").get(projectId) as
    | { id: string }
    | undefined;
  if (!der) return false;
  const v = database.prepare('SELECT status, source_content_version_id FROM content_derivative_versions WHERE derivative_id=? ORDER BY version_number DESC LIMIT 1').get(der.id) as
    | { status: string; source_content_version_id: string }
    | undefined;
  if (!v) return false;
  return v.status === 'ready' && v.source_content_version_id === exactVersionId;
}
function isExactCompletion(database: DatabaseSync, projectId: string | null): boolean {
  if (!projectId) return false;
  const a = isArticleReady(database, projectId);
  if (!a.ready || !a.latestVersionId) return false;
  return hasExactReadyScript(database, projectId, a.latestVersionId);
}

function findExistingDraftForSource(database: DatabaseSync, sourceId: string): { id: string } | null {
  try {
    const row = database
      .prepare(
        "SELECT id FROM plan_items WHERE EXISTS (SELECT 1 FROM json_each(source_ids_json) WHERE value = ?) ORDER BY created_at DESC LIMIT 1"
      )
      .get(sourceId) as { id: string } | undefined;
    if (row) return row;
  } catch {}
  try {
    const row = database
      .prepare('SELECT id FROM plan_items WHERE source_ids_json LIKE ? ORDER BY created_at DESC LIMIT 1')
      .get(`%"${sourceId}"%`) as { id: string } | undefined;
    if (row) return row;
  } catch {}
  return null;
}

function makePlannerNextAction(input: {
  businessDate: string;
  planItemId: string;
  sourceItemId: string;
}): ContentCycleNextAction {
  const logicalInput = Object.freeze({
    source: 'content_cycle',
    businessDate: input.businessDate,
    planItemId: input.planItemId,
    sourceItemId: input.sourceItemId,
    role: 'planner',
  });
  const requestId = `stage_c:${input.businessDate}:${input.sourceItemId}`;
  return Object.freeze({
    kind: 'submitWorkspaceOrchestratorIntent',
    producerId: 'content-cycle.successor',
    action: 'stage_d',
    businessDate: input.businessDate,
    requestId,
    rootMode: 'scheduler',
    role: 'planner',
    logicalInput,
    payload: logicalInput,
  });
}

function persistPlannerNextAction(database: DatabaseSync, planItemId: string, nextAction: ContentCycleNextAction): void {
  const row = database
    .prepare('SELECT planning_provenance_json FROM plan_items WHERE id=?')
    .get(planItemId) as { planning_provenance_json: string | null } | undefined;
  if (!row) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
  let provenance: Record<string, unknown> = {};
  try {
    const parsed = row.planning_provenance_json ? JSON.parse(row.planning_provenance_json) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) provenance = { ...(parsed as Record<string, unknown>) };
  } catch {}
  provenance.planner_next_action = nextAction;
  provenance.content_cycle_next_action = nextAction;
  provenance.next_action = nextAction;
  database
    .prepare('UPDATE plan_items SET planning_provenance_json=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(provenance), nowIso(), planItemId);
}

function ensureMinimalDraftAndPlanner(
  database: DatabaseSync,
  businessDate: string,
  sourceItemId: string,
  titleSnapshot: string
): ContentCycleNextAction | null {
  const existing = findExistingDraftForSource(database, sourceItemId);
  let planItemId: string;
  if (existing) {
    planItemId = existing.id;
  } else {
    const title = String(titleSnapshot ?? '').trim().slice(0, 80);
    if (!title) return null;
    try {
      const draft = createPlanningDraftFromTarget(database, {
        title,
        sourceIds: [sourceItemId],
        planDate: businessDate,
        origin: 'zhihu_hot',
        availableMaterials: [],
        missingMaterials: ['补齐来源正文与可核验证据'],
      });
      planItemId = draft.planItemId;
    } catch {
      return null;
    }
  }
  const nextAction = makePlannerNextAction({ businessDate, planItemId, sourceItemId });
  persistPlannerNextAction(database, planItemId, nextAction);
  return nextAction;
}

export function ensureDailyCycleInternal(database: DatabaseSync, businessDate: string): Record<string, unknown> {
  if (!isValidDate(businessDate)) throw Object.assign(new Error('businessDate 格式必须为 YYYY-MM-DD'), { code: 'VALIDATION_ERROR' });
  const settings = getScoringSettings(database);
  const targetCount = settings.targetCount;
  const existing = database.prepare('SELECT * FROM daily_content_cycles WHERE business_date=?').get(businessDate) as
    | Record<string, unknown>
    | undefined;
  if (existing) {
    const before = getDailyCycleProjection(database, businessDate);
    const remainingGap = before.shortage.remainingGap;
    if (remainingGap <= 0) return before as unknown as Record<string, unknown>;
    const usedSourceIds = new Set(
      (before.targets as Array<{ source_item_id: string | null }>)
        .map((target) => target.source_item_id)
        .filter((id): id is string => Boolean(id))
    );
    const availableRows = database
      .prepare(
        'SELECT o.rank, o.question_title_snapshot, o.question_url_snapshot, o.source_item_id, si.canonical_url FROM zhihu_hot_observations o JOIN source_items si ON si.id=o.source_item_id WHERE o.business_date=? ORDER BY o.rank ASC'
      )
      .all(businessDate) as Array<{
      rank: number;
      question_title_snapshot: string;
      question_url_snapshot: string;
      source_item_id: string;
      canonical_url: string | null;
    }>;
    const candidateSourceIds = new Set(usedSourceIds);
    const filteredRows = availableRows.filter((row) => {
      if (candidateSourceIds.has(row.source_item_id)) return false;
      candidateSourceIds.add(row.source_item_id);
      return true;
    });
    if (!filteredRows.length) return before as unknown as Record<string, unknown>;
    const inputs = filteredRows.map((row) => ({
      id: row.source_item_id,
      title: row.question_title_snapshot,
      canonicalUrl: row.canonical_url ?? row.question_url_snapshot,
      rank: row.rank,
      audienceFit: 0,
      viewpointRoom: 0,
      evidenceAvailability: 0,
      timelinessLifecycle: 0,
      articleVideoTransfer: 0,
      executionCost: 0,
      hardRisks: [] as readonly string[],
      dimensionEvidence: {} as Record<string, { evidence?: string; reason?: string }>,
    }));
    if (!inputs.length) return before as unknown as Record<string, unknown>;
    const scored = scoreCandidates(database, inputs, nowIso());
    for (const cand of scored) {
      const row = filteredRows.find((r) => r.source_item_id === cand.id);
      if (!row) continue;
      const isPending = cand.total === 0 || cand.dims.evidenceAvailability === 0;
      if (isPending) {
        ensureMinimalDraftAndPlanner(database, businessDate, cand.id, row.question_title_snapshot);
      }
    }
    const selection = selectWithQuota(scored as never, remainingGap) as unknown as { selected: Array<{ id: string; route: string }> };
    if (!selection.selected.length) return before as unknown as Record<string, unknown>;
    const cycleId = String((existing as { id: string }).id);
    const ts = nowIso();
    for (const candidate of selection.selected) {
      const scoredCandidate = (scored as unknown as Array<{ id: string }>).find((item) => item.id === candidate.id) as unknown as never;
      database
        .prepare(
          'INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,1)'
        )
        .run(
          randomUUID(),
          cycleId,
          'new_content',
          1,
          candidate.id,
          candidate.route === 'automatic' ? 'automatic' : 'owner_approved',
          scoredCandidate ? scoreSnapshotJsonFor(scoredCandidate) : '{}',
          'selected',
          ts,
          ts
        );
    }
    const after = getDailyCycleProjection(database, businessDate);
    database
      .prepare('UPDATE daily_content_cycles SET status=?, last_error_code=?, updated_at=?, revision=revision+1 WHERE id=?')
      .run(after.shortage.remainingGap > 0 ? 'partial' : 'running', after.shortage.remainingGap > 0 ? 'CANDIDATE_SHORTAGE' : null, ts, cycleId);
    return getDailyCycleProjection(database, businessDate) as unknown as Record<string, unknown>;
  }
  const rows = database
    .prepare(
      'SELECT o.rank, o.question_title_snapshot, o.question_url_snapshot, o.source_item_id, si.canonical_url FROM zhihu_hot_observations o JOIN source_items si ON si.id=o.source_item_id WHERE o.business_date=? ORDER BY o.rank ASC'
    )
    .all(businessDate) as Array<{
    rank: number;
    question_title_snapshot: string;
    question_url_snapshot: string;
    source_item_id: string;
    canonical_url: string | null;
  }>;
  let scored: Array<{ id: string; route: string; total: number; dims: { evidenceAvailability: number } } & Record<string, unknown>> = [];
  let selection: { selected: Array<{ id: string; route: string }> } = { selected: [] };
  if (rows.length > 0) {
    const candidateSourceIds = new Set<string>();
    const filtered = rows.filter((row) => {
      if (candidateSourceIds.has(row.source_item_id)) return false;
      candidateSourceIds.add(row.source_item_id);
      return true;
    });
    const inputs = filtered.map((r) => ({
      id: r.source_item_id,
      title: r.question_title_snapshot,
      canonicalUrl: r.canonical_url ?? r.question_url_snapshot,
      rank: r.rank,
      audienceFit: 0,
      viewpointRoom: 0,
      evidenceAvailability: 0,
      timelinessLifecycle: 0,
      articleVideoTransfer: 0,
      executionCost: 0,
      hardRisks: [] as readonly string[],
      dimensionEvidence: {} as Record<string, { evidence?: string; reason?: string }>,
    }));
    const iso = nowIso();
    scored = scoreCandidates(database, inputs, iso) as unknown as typeof scored;
    for (const cand of scored) {
      const row = filtered.find((r) => r.source_item_id === (cand as { id: string }).id);
      if (!row) continue;
      const isPending = (cand as { total: number }).total === 0 || (cand as { dims: { evidenceAvailability: number } }).dims.evidenceAvailability === 0;
      if (isPending) {
        ensureMinimalDraftAndPlanner(database, businessDate, (cand as { id: string }).id, row.question_title_snapshot);
      }
    }
    selection = selectWithQuota(scored as never, targetCount) as unknown as { selected: Array<{ id: string; route: string }> };
  }
  const selected = selection.selected as unknown as Array<{ id: string; route: string }>;
  const gap = Math.max(0, targetCount - selected.length);
  const status: DailyCycleStatus = gap > 0 ? 'partial' : 'running';
  const lastError = gap > 0 ? 'CANDIDATE_SHORTAGE' : null;
  const cycleId = randomUUID();
  const ts = nowIso();
  database
    .prepare(
      'INSERT INTO daily_content_cycles (id, business_date, timezone, target_count, status, started_at, last_error_code, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,1)'
    )
    .run(cycleId, businessDate, 'Asia/Shanghai', targetCount, status, ts, lastError, ts, ts);
  for (const c of selected) {
    const targetId = randomUUID();
    const cand = (scored as unknown as Array<{ id: string }>).find((s) => s.id === c.id) as unknown as never;
    const snapshot = cand ? scoreSnapshotJsonFor(cand as never) : '{}';
    const selMode = c.route === 'automatic' ? 'automatic' : 'owner_approved';
    database
      .prepare(
        'INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,1)'
      )
      .run(targetId, cycleId, 'new_content', 1, c.id, selMode, snapshot, 'selected', ts, ts);
  }
  return getDailyCycleProjection(database, businessDate) as unknown as Record<string, unknown>;
}

export function pauseDailyCycleInternal(database: DatabaseSync, businessDate: string, expectedRevision: number): Record<string, unknown> {
  const row = database.prepare('SELECT * FROM daily_content_cycles WHERE business_date=?').get(businessDate) as
    | { revision: number; status: string }
    | undefined;
  if (!row) throw Object.assign(new Error('周期不存在'), { code: 'NOT_FOUND' });
  if (Number(row.revision) !== Number(expectedRevision)) throw Object.assign(new Error('revision 冲突'), { code: 'REVISION_CONFLICT' });
  if (row.status === 'paused') return getDailyCycleProjection(database, businessDate) as unknown as Record<string, unknown>;
  if (row.status !== 'running' && row.status !== 'pending' && row.status !== 'needs_user' && row.status !== 'partial')
    throw Object.assign(new Error(`非法暂停: ${row.status}`), { code: 'ILLEGAL_TRANSITION' });
  database.prepare('UPDATE daily_content_cycles SET status=?, updated_at=?, revision=revision+1 WHERE business_date=?').run('paused', nowIso(), businessDate);
  return getDailyCycleProjection(database, businessDate) as unknown as Record<string, unknown>;
}
export function resumeDailyCycleInternal(database: DatabaseSync, businessDate: string, expectedRevision: number): Record<string, unknown> {
  const row = database.prepare('SELECT * FROM daily_content_cycles WHERE business_date=?').get(businessDate) as
    | { revision: number; status: string }
    | undefined;
  if (!row) throw Object.assign(new Error('周期不存在'), { code: 'NOT_FOUND' });
  if (Number(row.revision) !== Number(expectedRevision)) throw Object.assign(new Error('revision 冲突'), { code: 'REVISION_CONFLICT' });
  if (row.status !== 'paused') throw Object.assign(new Error('只有已暂停可恢复'), { code: 'ILLEGAL_TRANSITION' });
  database.prepare('UPDATE daily_content_cycles SET status=?, updated_at=?, revision=revision+1 WHERE business_date=?').run('running', nowIso(), businessDate);
  return getDailyCycleProjection(database, businessDate) as unknown as Record<string, unknown>;
}
export function transitionTargetInternal(
  database: DatabaseSync,
  input: { targetId: string; expectedRevision: number; toStatus: DailyTargetStatus; blockedReasonCode?: string | null }
): Record<string, unknown> {
  const row = database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(input.targetId) as
    | { revision: number; status: DailyTargetStatus; project_id: string | null; cycle_id: string; blocked_reason_code: string | null }
    | undefined;
  if (!row) throw Object.assign(new Error('目标不存在'), { code: 'NOT_FOUND' });
  if (Number(row.revision) !== Number(input.expectedRevision)) throw Object.assign(new Error('revision 冲突'), { code: 'REVISION_CONFLICT' });
  const from = row.status;
  const to = input.toStatus;
  const allowed = LEGAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) throw Object.assign(new Error(`非法流转 ${from} -> ${to}`), { code: 'ILLEGAL_TRANSITION' });
  if (to === 'completed' && !isExactCompletion(database, row.project_id)) throw Object.assign(new Error('完成前必须文章定稿且视频文案 ready 并指向同一版本'), { code: 'COMPLETION_PRECONDITION' });
  const ts = nowIso();
  if (to === 'blocked')
    database
      .prepare('UPDATE daily_content_targets SET status=?, blocked_reason_code=?, updated_at=?, revision=revision+1 WHERE id=?')
      .run(to, input.blockedReasonCode ?? row.blocked_reason_code ?? null, ts, input.targetId);
  else
    database
      .prepare('UPDATE daily_content_targets SET status=?, blocked_reason_code=NULL, updated_at=?, revision=revision+1 WHERE id=?')
      .run(to, ts, input.targetId);
  recomputeCycleSettlement(database, row.cycle_id);
  return database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(input.targetId) as Record<string, unknown>;
}
export function skipTargetInternal(
  database: DatabaseSync,
  input: { targetId: string; expectedRevision: number; reasonCode?: string | null }
): Record<string, unknown> {
  const row = database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(input.targetId) as
    | { revision: number; status: string; cycle_id: string }
    | undefined;
  if (!row) throw Object.assign(new Error('目标不存在'), { code: 'NOT_FOUND' });
  if (Number(row.revision) !== Number(input.expectedRevision)) throw Object.assign(new Error('revision 冲突'), { code: 'REVISION_CONFLICT' });
  if (row.status === 'completed' || row.status === 'skipped' || row.status === 'carried')
    throw Object.assign(new Error('已终态不可跳过'), { code: 'ILLEGAL_TRANSITION' });
  const ts = nowIso();
  database.prepare('UPDATE daily_content_targets SET status=?, blocked_reason_code=?, updated_at=?, revision=revision+1 WHERE id=?').run('skipped', input.reasonCode ?? null, ts, input.targetId);
  recomputeCycleSettlement(database, row.cycle_id);
  return database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(input.targetId) as Record<string, unknown>;
}
export function replaceTargetInternal(
  database: DatabaseSync,
  input: { targetId: string; expectedRevision: number; replacementSourceItemId: string }
): { replaced: Record<string, unknown>; created: Record<string, unknown> } {
  const row = database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(input.targetId) as
    | { revision: number; status: string; cycle_id: string; target_kind: string; counts_toward_goal: number; score_snapshot_json: string }
    | undefined;
  if (!row) throw Object.assign(new Error('目标不存在'), { code: 'NOT_FOUND' });
  if (Number(row.revision) !== Number(input.expectedRevision)) throw Object.assign(new Error('revision 冲突'), { code: 'REVISION_CONFLICT' });
  if (row.status === 'completed' || row.status === 'skipped' || row.status === 'carried')
    throw Object.assign(new Error('已终态不可替换'), { code: 'ILLEGAL_TRANSITION' });
  const dup = database
    .prepare('SELECT id FROM daily_content_targets WHERE cycle_id=? AND source_item_id=? AND id!=? AND status NOT IN (\'skipped\',\'carried\')')
    .get(row.cycle_id, input.replacementSourceItemId, input.targetId) as { id: string } | undefined;
  if (dup) throw Object.assign(new Error('替换来源已在同一周期占用'), { code: 'DUPLICATE_SOURCE' });
  const cycle = database.prepare('SELECT target_count FROM daily_content_cycles WHERE id=?').get(row.cycle_id) as
    | { target_count: number }
    | undefined;
  if (!cycle) throw Object.assign(new Error('周期不存在'), { code: 'NOT_FOUND' });
  const ts = nowIso();
  database
    .prepare('UPDATE daily_content_targets SET status=?, blocked_reason_code=?, updated_at=?, revision=revision+1 WHERE id=?')
    .run('skipped', 'replaced', ts, input.targetId);
  const newId = randomUUID();
  const snapshot = row.score_snapshot_json ?? '{}';
  database
    .prepare(
      'INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,1)'
    )
    .run(newId, row.cycle_id, row.target_kind, row.counts_toward_goal, input.replacementSourceItemId, 'owner_approved', snapshot, 'selected', ts, ts);
  recomputeCycleSettlement(database, row.cycle_id);
  return {
    replaced: database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(input.targetId) as Record<string, unknown>,
    created: database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(newId) as Record<string, unknown>,
  };
}
export function carryTargetInternal(
  database: DatabaseSync,
  input: { targetId: string; expectedRevision: number; nextBusinessDate: string }
): { carriedFrom: Record<string, unknown>; carriedTo: Record<string, unknown> } {
  if (!isValidDate(input.nextBusinessDate)) throw Object.assign(new Error('nextBusinessDate 格式必须为 YYYY-MM-DD'), { code: 'VALIDATION_ERROR' });
  const row = database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(input.targetId) as
    | {
        revision: number;
        status: string;
        carry_depth: number;
        predecessor_target_id: string | null;
        cycle_id: string;
        source_item_id: string | null;
        plan_item_id: string | null;
        project_id: string | null;
        target_kind: string;
        score_snapshot_json: string;
      }
    | undefined;
  if (!row) throw Object.assign(new Error('目标不存在'), { code: 'NOT_FOUND' });
  if (Number(row.revision) !== Number(input.expectedRevision)) throw Object.assign(new Error('revision 冲突'), { code: 'REVISION_CONFLICT' });
  if (row.status === 'completed' || row.status === 'skipped' || row.status === 'carried')
    throw Object.assign(new Error('已终态不可顺延'), { code: 'ILLEGAL_TRANSITION' });
  if (Number(row.carry_depth) >= 1) throw Object.assign(new Error('最多顺延一次'), { code: 'CARRY_LIMIT' });
  if (row.predecessor_target_id) throw Object.assign(new Error('已顺延过的目标不可再次顺延'), { code: 'CARRY_LIMIT' });
  const exists = database.prepare('SELECT id FROM daily_content_targets WHERE predecessor_target_id=?').get(input.targetId) as
    | { id: string }
    | undefined;
  if (exists) throw Object.assign(new Error('已存在顺延目标'), { code: 'CARRY_LIMIT' });
  let nextCycle = database.prepare('SELECT * FROM daily_content_cycles WHERE business_date=?').get(input.nextBusinessDate) as
    | { id: string }
    | undefined;
  if (!nextCycle) {
    const settings = getScoringSettings(database);
    const ts2 = nowIso();
    const nid = randomUUID();
    database
      .prepare('INSERT INTO daily_content_cycles (id, business_date, timezone, target_count, status, started_at, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,1)')
      .run(nid, input.nextBusinessDate, 'Asia/Shanghai', settings.targetCount, 'running', ts2, ts2, ts2);
    nextCycle = database.prepare('SELECT * FROM daily_content_cycles WHERE id=?').get(nid) as { id: string };
  }
  const ts = nowIso();
  database.prepare('UPDATE daily_content_targets SET status=?, updated_at=?, revision=revision+1 WHERE id=?').run('carried', ts, input.targetId);
  const newId = randomUUID();
  database
    .prepare(
      'INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, plan_item_id, project_id, predecessor_target_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)'
    )
    .run(
      newId,
      (nextCycle as { id: string }).id,
      row.target_kind,
      1,
      row.source_item_id,
      row.plan_item_id,
      row.project_id,
      input.targetId,
      1,
      'carried',
      row.score_snapshot_json,
      'selected',
      ts,
      ts
    );
  recomputeCycleSettlement(database, row.cycle_id);
  recomputeCycleSettlement(database, (nextCycle as { id: string }).id);
  return {
    carriedFrom: database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(input.targetId) as Record<string, unknown>,
    carriedTo: database.prepare('SELECT * FROM daily_content_targets WHERE id=?').get(newId) as Record<string, unknown>,
  };
}
function recomputeCycleSettlement(database: DatabaseSync, cycleId: string): void {
  const cycle = database.prepare('SELECT * FROM daily_content_cycles WHERE id=?').get(cycleId) as
    | { status: string; target_count: number; last_error_code: string | null }
    | undefined;
  if (!cycle) return;
  if (cycle.status === 'paused') return;
  const targets = database.prepare("SELECT * FROM daily_content_targets WHERE cycle_id=? AND target_kind='new_content' AND counts_toward_goal=1 AND status!='skipped' AND status!='carried'").all(cycleId) as Array<{
    status: string;
  }>;
  const completed = targets.filter((t) => t.status === 'completed').length;
  const effectiveCount = targets.length;
  const gap = Math.max(0, Number(cycle.target_count) - effectiveCount);
  let nextStatus: DailyCycleStatus = cycle.status as DailyCycleStatus;
  if (gap > 0) nextStatus = 'partial';
  else if (effectiveCount === Number(cycle.target_count) && completed === Number(cycle.target_count)) nextStatus = 'completed';
  else if (completed > 0 || effectiveCount > 0) nextStatus = 'running';
  if (nextStatus !== cycle.status) {
    const lastError = gap > 0 ? 'CANDIDATE_SHORTAGE' : null;
    const ts = nowIso();
    if (nextStatus === 'completed')
      database
        .prepare('UPDATE daily_content_cycles SET status=?, last_error_code=?, completed_at=?, updated_at=?, revision=revision+1 WHERE id=?')
        .run(nextStatus, lastError, ts, ts, cycleId);
    else
      database
        .prepare('UPDATE daily_content_cycles SET status=?, last_error_code=?, updated_at=?, revision=revision+1 WHERE id=?')
        .run(nextStatus, lastError, ts, cycleId);
  } else if (gap > 0 && cycle.last_error_code !== 'CANDIDATE_SHORTAGE') {
    database.prepare('UPDATE daily_content_cycles SET last_error_code=?, updated_at=?, revision=revision+1 WHERE id=?').run('CANDIDATE_SHORTAGE', nowIso(), cycleId);
  }
}
export function readDailyCycleForToday(database: DatabaseSync, businessDate: string): Record<string, unknown> {
  const proj = getDailyCycleProjection(database, businessDate);
  const statusLabel: Record<string, string> = {
    proposed: '待确认',
    selected: '待开始',
    researching: '研究中',
    drafting: '撰写中',
    article_ready: '文章已定稿',
    scripting: '视频文案撰写中',
    completed: '已完成',
    blocked: '受阻',
    skipped: '已跳过',
    carried: '已顺延',
  };
  const cycleStatusLabel: Record<string, string> = {
    pending: '等待开始',
    running: '进行中',
    needs_user: '需你处理',
    completed: '已完成',
    partial: '部分完成',
    paused: '已暂停',
    failed: '失败',
  };
  return {
    ...proj,
    ui: {
      cycleStatusLabel: proj.cycle ? (cycleStatusLabel[(proj.cycle as { status: string }).status] ?? (proj.cycle as { status: string }).status) : '未开始',
      targets: (proj.targets as Array<{ status: string }>).map((t) => ({ ...t, statusLabel: statusLabel[(t as { status: string }).status] ?? (t as { status: string }).status })),
    },
  };
}
